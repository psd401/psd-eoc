import {
  ADMIN_READINESS_FRESHNESS_WINDOW_SECONDS,
  AdminReadinessSchema,
  type AdminReadiness,
  type CapabilityInput,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';

import {
  facilities,
  groupSources,
  neighborhoodFacilities,
  neighborhoodVersions,
  rosterSnapshots,
  rosterSyncResults,
} from '../../../db/schema';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { MEMBERSHIP_FRESHNESS_MS } from '../../../lib/auth/trusted-group-access';
import {
  readCapabilityTime,
  type ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  createRepeatableReadAdminQueryStoreFromStore,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  preflightAdminQueryCapability,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminQueryDatabase,
  type AdminQueryMetadata,
} from '../../../lib/capabilities/admin';
import { readAlarmTopicReadiness } from './alarm-subscriptions';

export const ACCESS_MEMBERSHIP_FRESHNESS_SECONDS =
  MEMBERSHIP_FRESHNESS_MS / 1_000;
export const ROSTER_FRESHNESS_SECONDS =
  ADMIN_READINESS_FRESHNESS_WINDOW_SECONDS;

interface ReadinessProjectionEvidence {
  readonly accessGroups: readonly Readonly<{
    id: string;
    displayName: string;
    grantedRole: 'staff' | 'admin';
    membersCapturedAt: Date | null;
  }>[];
  readonly activeFacilityIds: readonly string[];
  readonly neighborhoodFacilityIds: readonly string[];
  readonly buildingGroupFacilityIds: readonly string[];
  readonly latestRosterAttempt: Readonly<{
    completedAt: Date;
    outcome: 'complete' | 'failed' | 'partial-rejected';
  }> | null;
  readonly latestCompleteRosterSnapshot: Readonly<{
    capturedAt: Date;
  }> | null;
  readonly alarmTopics: AdminReadiness['alarmTopics'];
}

function iso(value: Date): string {
  return value.toISOString();
}

/** Converts bounded database/provider evidence into the strict public projection. */
export function projectAdminReadiness(
  evidence: ReadinessProjectionEvidence,
  observedAt: Date,
): AdminReadiness {
  const observationTime = observedAt.getTime();
  const accessGroups = evidence.accessGroups.map((group) => {
    const age =
      group.membersCapturedAt === null
        ? null
        : observationTime - group.membersCapturedAt.getTime();
    return {
      id: group.id,
      displayName: group.displayName,
      grantedRole: group.grantedRole,
      membersCapturedAt:
        group.membersCapturedAt === null ? null : iso(group.membersCapturedAt),
      status:
        age === null
          ? ('never-read' as const)
          : age <= ACCESS_MEMBERSHIP_FRESHNESS_SECONDS * 1_000
            ? ('fresh' as const)
            : ('stale' as const),
    };
  });
  const accessStatus =
    accessGroups.length > 0 &&
    accessGroups.every(({ status }) => status === 'fresh')
      ? 'ready'
      : 'action-required';

  const neighborhoodFacilityIds = new Set(evidence.neighborhoodFacilityIds);
  const buildingGroupFacilityIds = new Set(evidence.buildingGroupFacilityIds);
  const facilitiesWithoutNeighborhoodCount = evidence.activeFacilityIds.filter(
    (facilityId) => !neighborhoodFacilityIds.has(facilityId),
  ).length;
  const facilitiesWithoutBuildingGroupCount = evidence.activeFacilityIds.filter(
    (facilityId) => !buildingGroupFacilityIds.has(facilityId),
  ).length;
  const facilityStatus =
    evidence.activeFacilityIds.length > 0 &&
    facilitiesWithoutNeighborhoodCount === 0 &&
    facilitiesWithoutBuildingGroupCount === 0
      ? 'ready'
      : 'action-required';

  const latestAttempt = evidence.latestRosterAttempt;
  const latestComplete = evidence.latestCompleteRosterSnapshot;
  const rosterFresh =
    latestAttempt?.outcome === 'complete' &&
    observationTime - latestAttempt.completedAt.getTime() <=
      ROSTER_FRESHNESS_SECONDS * 1_000 &&
    latestComplete !== null &&
    observationTime - latestComplete.capturedAt.getTime() <=
      ROSTER_FRESHNESS_SECONDS * 1_000;
  const rosterStatus = rosterFresh ? 'ready' : 'action-required';

  const statuses = [
    accessStatus,
    facilityStatus,
    rosterStatus,
    ...evidence.alarmTopics.map(({ status }) => status),
  ];
  const overallStatus = statuses.includes('action-required')
    ? 'action-required'
    : statuses.includes('unavailable')
      ? 'unavailable'
      : 'ready';

  return AdminReadinessSchema.parse({
    observedAt: iso(observedAt),
    overallStatus,
    accessMembership: {
      status: accessStatus,
      freshnessWindowSeconds: ACCESS_MEMBERSHIP_FRESHNESS_SECONDS,
      groups: accessGroups,
    },
    facilityConfiguration: {
      status: facilityStatus,
      activeFacilityCount: evidence.activeFacilityIds.length,
      facilitiesWithoutNeighborhoodCount,
      facilitiesWithoutBuildingGroupCount,
    },
    roster: {
      status: rosterStatus,
      freshnessWindowSeconds: ROSTER_FRESHNESS_SECONDS,
      latestAttemptCompletedAt:
        latestAttempt === null ? null : iso(latestAttempt.completedAt),
      latestAttemptOutcome: latestAttempt?.outcome ?? null,
      latestCompleteSnapshotCapturedAt:
        latestComplete === null ? null : iso(latestComplete.capturedAt),
    },
    alarmTopics: evidence.alarmTopics,
  });
}

async function readDatabaseEvidence(database: AdminQueryDatabase) {
  const accessGroups = await database
    .select({
      id: groupSources.id,
      displayName: groupSources.displayName,
      grantedRole: groupSources.grantedRole,
      membersCapturedAt: groupSources.membersCapturedAt,
    })
    .from(groupSources)
    .where(
      and(eq(groupSources.purpose, 'access'), eq(groupSources.active, true)),
    )
    .orderBy(asc(groupSources.id))
    .limit(101);
  if (
    accessGroups.length > 100 ||
    accessGroups.some(({ grantedRole }) => grantedRole === null)
  ) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'Access-group readiness evidence is outside the supported bounds.',
      500,
    );
  }

  const activeFacilities = await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.active, true))
    .orderBy(asc(facilities.id))
    .limit(501);
  if (activeFacilities.length > 500) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'Facility readiness evidence is outside the supported bounds.',
      500,
    );
  }

  const activeFacilityIds = activeFacilities.map(({ id }) => id);
  const candidateNeighborhoods =
    activeFacilityIds.length === 0
      ? []
      : await database
          .selectDistinct({ id: neighborhoodFacilities.neighborhoodId })
          .from(neighborhoodFacilities)
          .where(inArray(neighborhoodFacilities.facilityId, activeFacilityIds))
          .limit(501);
  if (candidateNeighborhoods.length > 500) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'Active-facility neighborhood evidence is outside the supported bounds.',
      500,
    );
  }
  const latestNeighborhoods =
    candidateNeighborhoods.length === 0
      ? []
      : await database
          .selectDistinctOn([neighborhoodVersions.id], {
            id: neighborhoodVersions.id,
            version: neighborhoodVersions.version,
          })
          .from(neighborhoodVersions)
          .where(
            inArray(
              neighborhoodVersions.id,
              candidateNeighborhoods.map(({ id }) => id),
            ),
          )
          .orderBy(
            asc(neighborhoodVersions.id),
            desc(neighborhoodVersions.version),
          );
  const neighborhoodFilter = or(
    ...latestNeighborhoods.map((neighborhood) =>
      and(
        eq(neighborhoodFacilities.neighborhoodId, neighborhood.id),
        eq(neighborhoodFacilities.neighborhoodVersion, neighborhood.version),
      ),
    ),
  );
  const neighborhoodRows =
    neighborhoodFilter === undefined
      ? []
      : await database
          .selectDistinct({ facilityId: neighborhoodFacilities.facilityId })
          .from(neighborhoodFacilities)
          .where(
            and(
              neighborhoodFilter,
              inArray(neighborhoodFacilities.facilityId, activeFacilityIds),
            ),
          )
          .limit(501);
  // The same three conditions `resolveEventRecipients` applies when it reads a
  // school's staff, so a facility this reports as covered is one an activation
  // can actually reach.
  const buildingGroupRows =
    activeFacilityIds.length === 0
      ? []
      : await database
          .selectDistinct({ facilityId: groupSources.facilityId })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.purpose, 'building'),
              eq(groupSources.kind, 'google-group'),
              eq(groupSources.active, true),
              inArray(groupSources.facilityId, activeFacilityIds),
            ),
          )
          .limit(501);
  if (neighborhoodRows.length > 500 || buildingGroupRows.length > 500) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'Facility coverage readiness evidence is outside the supported bounds.',
      500,
    );
  }

  const [latestRosterAttempt] = await database
    .select({
      completedAt: rosterSyncResults.completedAt,
      outcome: rosterSyncResults.outcome,
    })
    .from(rosterSyncResults)
    .where(eq(rosterSyncResults.population, 'staff'))
    .orderBy(desc(rosterSyncResults.completedAt), desc(rosterSyncResults.id))
    .limit(1);
  const [latestCompleteRosterSnapshot] = await database
    .select({ capturedAt: rosterSnapshots.capturedAt })
    .from(rosterSnapshots)
    .where(
      and(
        eq(rosterSnapshots.population, 'staff'),
        eq(rosterSnapshots.complete, true),
      ),
    )
    .orderBy(desc(rosterSnapshots.version))
    .limit(1);

  return Object.freeze({
    accessGroups: accessGroups as readonly Readonly<{
      id: string;
      displayName: string;
      grantedRole: 'staff' | 'admin';
      membersCapturedAt: Date | null;
    }>[],
    activeFacilityIds,
    neighborhoodFacilityIds: neighborhoodRows.map(
      ({ facilityId }) => facilityId,
    ),
    buildingGroupFacilityIds: buildingGroupRows.flatMap(({ facilityId }) =>
      facilityId === null ? [] : [facilityId],
    ),
    latestRosterAttempt: latestRosterAttempt ?? null,
    latestCompleteRosterSnapshot: latestCompleteRosterSnapshot ?? null,
  });
}

export function createGetAdminReadinessRegistration(
  alarmTopics: AdminReadiness['alarmTopics'],
): ServerCapabilityRegistration<
  'get-admin-readiness',
  AdminCapabilityTransaction
> {
  return {
    id: 'get-admin-readiness',
    resolveFacilityId(_input, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      return null;
    },
    async handler(_input, context) {
      const databaseEvidence = await readDatabaseEvidence(
        context.transaction.database,
      );
      const observedAt = await readCapabilityTime(context);
      return projectAdminReadiness(
        { ...databaseEvidence, alarmTopics },
        observedAt,
      );
    },
  };
}

const unavailableAlarmTopics = Object.freeze([
  {
    kind: 'operations',
    status: 'unavailable',
    confirmedSubscriberCount: null,
  },
  {
    kind: 'critical',
    status: 'unavailable',
    confirmedSubscriberCount: null,
  },
]) satisfies AdminReadiness['alarmTopics'];

function canPreflightAdminProviderRead(
  authenticated: AuthenticatedSession,
): boolean {
  return (
    authenticated.source === 'web' &&
    authenticated.roles.includes('admin') &&
    authenticated.scope.facilityScope.kind === 'district'
  );
}

/** Provider reads occur only after a side-effect-free canonical preflight. */
export async function readAlarmTopicsForAdminReadiness(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: unknown;
  readonly store: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
  readonly reader?: () => Promise<AdminReadiness['alarmTopics']>;
}): Promise<AdminReadiness['alarmTopics']> {
  try {
    preflightAdminQueryCapability(
      'get-admin-readiness',
      input.query,
      input.authenticated,
      input.store,
      input.metadata,
    );
  } catch {
    return unavailableAlarmTopics;
  }
  if (!canPreflightAdminProviderRead(input.authenticated)) {
    return unavailableAlarmTopics;
  }
  return (input.reader ?? readAlarmTopicReadiness)();
}

/** Executes the bounded readiness projection through the canonical capability layer. */
export async function executeGetAdminReadinessCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query?: CapabilityInput<'get-admin-readiness'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<AdminReadiness> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  // Provider latency must not hold the repeatable-read database snapshot.
  // A non-admin still enters the canonical capability so its denial is
  // authorized and audited, but it never reaches SNS.
  const query = input.query ?? {};
  const alarmTopics = await readAlarmTopicsForAdminReadiness({
    authenticated: input.authenticated,
    query,
    store,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
  const snapshotStore = createRepeatableReadAdminQueryStoreFromStore(store);
  return executeAdminQueryCapability(
    createGetAdminReadinessRegistration(alarmTopics),
    query,
    input.authenticated,
    snapshotStore,
    input.metadata,
  );
}
