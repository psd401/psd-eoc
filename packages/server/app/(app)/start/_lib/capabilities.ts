import { randomUUID } from 'node:crypto';

import {
  ActivationPreviewSchema,
  AudienceConfigSchema,
  ChannelConfigurationSchema,
  DeliveryTestPreviewSchema,
  DeliveryTestTargetSetVersionSchema,
  EndpointSchema,
  FacilityPageSchema,
  FacilitySchema,
  IntegrationStatusSchema,
  NeighborhoodSchema,
  RecipientSchema,
  RosterGroupSourceRefSchema,
  RosterSnapshotSchema,
  type ActivationPreview,
  type Actor,
  type AudienceConfig,
  type CapabilityInput,
  type CapabilityOutput,
  type CapabilityScope,
  type ChannelConfiguration,
  type DeliveryTestNotificationMetadata,
  type DeliveryTestPreview,
  type DeliveryTestTargetSetVersion,
  type FacilityPage,
  type Neighborhood,
  type NotificationChannel,
  type RegisteredCapabilityId,
  type RosterGroupSourceRef,
  type RosterPopulation,
  type RosterSnapshot,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../../../db/client';
import {
  activationPreviews,
  agents,
  audienceConfigurations,
  audienceTargets,
  channelConfigurations,
  deliveryTestCanaryEligibilityFacts,
  deliveryTestTargetEndpoints,
  deliveryTestTargetSetVersions,
  events,
  facilities,
  groupSources,
  integrationStatuses,
  neighborhoodFacilities,
  neighborhoodVersions,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshotSources,
  rosterSnapshots,
  securityAuditEntries,
  users,
} from '../../../../db/schema';
import {
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  toSecurityAuditInsertValues,
} from '../../../../lib/audit/drizzle-repository';
import { buildSecurityAuditEntry } from '../../../../lib/audit/entry';
import { parseSecurityAuditFact } from '../../../../lib/audit/model';
import {
  CapabilityEngineError,
  executeCapability,
  readCapabilityTime,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  DrizzleEventTypeStore,
  EventTypeCapabilityError,
} from '../../../../lib/capabilities/event-types';
import {
  AudienceResolutionError,
  resolveAudience,
} from '../../../../lib/roster/resolve';
import {
  DELIVERY_TEST_TARGET_LOCK_NAMESPACE,
  deliveryTestEndpointReferenceDigest,
  deliveryTestTargetLockIdentity,
  isDeliveryTestEndpointReferenceSubset,
} from '../../../../lib/testing/e2e-delivery';
import {
  FanoutControlDeniedError,
  assertCurrentNotificationFanoutEnabled,
} from '../../../../lib/notify/fanout-control';
import {
  BoundedDatabaseQueryError,
  START_FLOW_DATABASE_PAGE_SIZE,
  collectBoundedDatabaseRows,
  START_FLOW_ENDPOINT_PAGE_SIZE,
} from './bounded-query';
import { ActivationPreviewBuildError, buildActivationPreview } from './preview';

type StartFlowCapabilityId = Extract<
  RegisteredCapabilityId,
  | 'create-activation-preview'
  | 'create-delivery-test-preview'
  | 'list-facilities'
>;

type StartFlowQueryDatabase = DatabaseQuery;

// Defensive query ceilings mirror the canonical roster contract. The Zod
// schemas remain the source of truth and validate every assembled row.
const ROSTER_QUERY_LIMITS = Object.freeze({
  endpoints: 1_200 * 10,
  facilities: 200,
  provenance: 1_200 * 50,
  recipients: 1_200,
  sources: 500 * 2,
});

// These read ceilings mirror the canonical administrator mutation inputs:
// at most 500 audience targets and 200 facilities in one neighborhood.
const AUDIENCE_QUERY_LIMITS = Object.freeze({
  neighborhoodFacilities: 200,
  otherSources: 500,
  targets: 500,
});

export const DELIVERY_TEST_CREDENTIAL_VERIFICATION_REFERENCE_ENV =
  Object.freeze({
    push: 'PSD_EOC_EXPO_CREDENTIAL_VERIFICATION_REFERENCE',
    email: 'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE',
    sms: 'PSD_EOC_SMS_CREDENTIAL_VERIFICATION_REFERENCE',
  } as const satisfies Readonly<Record<NotificationChannel, string>>);

export type DeliveryTestCredentialVerificationReferences = Readonly<
  Record<NotificationChannel, string | null>
>;

/**
 * Loads non-secret, deploy-time credential verification references. A live
 * truth label alone is deliberately insufficient; the reference must bind the
 * running deployment to the exact append-only integration verification row.
 */
export function readDeliveryTestCredentialVerificationReferences(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeliveryTestCredentialVerificationReferences {
  const read = (channel: NotificationChannel): string | null => {
    const value =
      environment[DELIVERY_TEST_CREDENTIAL_VERIFICATION_REFERENCE_ENV[channel]];
    return value !== undefined &&
      value === value.trim() &&
      value.length >= 16 &&
      value.length <= 255 &&
      /^[A-Za-z0-9._:-]+$/u.test(value)
      ? value
      : null;
  };
  return Object.freeze({
    push: read('push'),
    email: read('email'),
    sms: read('sms'),
  });
}

export function deliveryTestCredentialIsVerified(
  status: Readonly<{
    label: string;
    verifiedAt: string | null;
    authorizationReference: string | null;
  }>,
  verificationReference: string | null,
): boolean {
  return (
    status.label === 'live-verified' &&
    status.verifiedAt !== null &&
    verificationReference !== null &&
    status.authorizationReference === verificationReference
  );
}

/** Persistence boundary for the two query capabilities owned by start flow. */
export interface StartFlowCapabilityTransaction
  extends CapabilityEngineTransaction {
  listFacilities(
    input: CapabilityInput<'list-facilities'>,
    scope: CapabilityScope,
  ): Promise<FacilityPage>;
  createActivationPreview(
    input: CapabilityInput<'create-activation-preview'>,
    actor: Actor,
    now: Date,
  ): Promise<ActivationPreview>;
  resolveDeliveryTestFacilityId?(
    input: CapabilityInput<'create-delivery-test-preview'>,
  ): Promise<string | null>;
  createDeliveryTestPreview?(
    input: CapabilityInput<'create-delivery-test-preview'>,
    actor: Actor,
    now: Date,
  ): Promise<DeliveryTestPreview>;
}

export type StartFlowCapabilityStore =
  CapabilityEngineStore<StartFlowCapabilityTransaction>;

interface RosterSnapshotHydrationCache {
  snapshot: RosterSnapshot | null;
}

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function unavailable(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'LIVE_ACTION_UNAVAILABLE',
    'PERSISTENCE_CONFLICT',
    message,
    503,
    true,
  );
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function decodeOffsetCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/u.test(decoded)) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'PERSISTENCE_CONFLICT',
      'The pagination cursor is invalid.',
      400,
    );
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'PERSISTENCE_CONFLICT',
      'The pagination cursor is invalid.',
      400,
    );
  }
  return offset;
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function startFlowQueryDatabase(database: unknown): StartFlowQueryDatabase {
  // Both configured Drizzle transports expose this schema-aware query API;
  // raw execute results are normalized at the consumers that read rows.
  return database as StartFlowQueryDatabase;
}

function eventTypeStoreDatabase(database: StartFlowQueryDatabase): Database {
  // DrizzleEventTypeStore consumes only transport-normalized query builders.
  // Keep it on this transaction while adapting its existing Database input.
  return database as unknown as Database;
}

async function readDatabaseTime(
  database: StartFlowQueryDatabase,
): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw unavailable('The authoritative database clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

async function appendCapabilityAuditEntry(
  database: StartFlowQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  await database.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
  const [previous] = await database
    .select({
      sequence: securityAuditEntries.sequence,
      entryHash: securityAuditEntries.entryHash,
    })
    .from(securityAuditEntries)
    .orderBy(desc(securityAuditEntries.sequence))
    .limit(1);
  const fact = parseSecurityAuditFact({
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability', id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  });
  const entry = buildSecurityAuditEntry(fact, previous ?? null);
  await database
    .insert(securityAuditEntries)
    .values(toSecurityAuditInsertValues(entry));
}

function unsupportedQueryMutationMethod(): never {
  throw new CapabilityEngineError(
    'INTERNAL_ERROR',
    'MUTATION_METADATA_INVALID',
    'A query-only start-flow capability reached mutation persistence.',
    500,
  );
}

function facilityFromRow(row: typeof facilities.$inferSelect) {
  return FacilitySchema.parse({
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    createdAt: dateIso(row.createdAt),
  });
}

async function listFacilitiesFromDatabase(
  database: StartFlowQueryDatabase,
  input: CapabilityInput<'list-facilities'>,
  scope: CapabilityScope,
): Promise<FacilityPage> {
  const offset = decodeOffsetCursor(input.cursor);
  const scopeCondition =
    scope.facilityScope.kind === 'district'
      ? undefined
      : inArray(facilities.id, [...scope.facilityScope.facilityIds]);
  const activityCondition = input.includeInactive
    ? undefined
    : eq(facilities.active, true);
  const rows = await database
    .select()
    .from(facilities)
    .where(
      scopeCondition === undefined
        ? activityCondition
        : activityCondition === undefined
          ? scopeCondition
          : and(scopeCondition, activityCondition),
    )
    .orderBy(asc(facilities.name), asc(facilities.code), asc(facilities.id))
    .offset(offset)
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = hasMore ? rows.slice(0, input.limit) : rows;
  return FacilityPageSchema.parse({
    items: selected.map(facilityFromRow),
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeOffsetCursor(offset + selected.length) : null,
    },
  });
}

function rosterGroupSourceRef(
  value: Readonly<{
    id: string;
    kind: 'google-group' | 'synthetic';
    purpose: 'building' | 'others';
    facilityId: string | null;
  }>,
): RosterGroupSourceRef {
  return RosterGroupSourceRefSchema.parse(value);
}

/**
 * Resolves one facility's current audience without trusting timestamps as a
 * version order. PostgreSQL transaction-start timestamps are not monotonic by
 * commit order, and more than one lineage is ambiguous operational truth.
 */
export async function loadLatestAudienceConfigurationHeader(
  databaseValue: unknown,
  facilityId: string,
) {
  const database = startFlowQueryDatabase(databaseValue);
  const lineages = await database
    .select({ id: audienceConfigurations.id })
    .from(audienceConfigurations)
    .where(eq(audienceConfigurations.facilityId, facilityId))
    .groupBy(audienceConfigurations.id)
    .orderBy(asc(audienceConfigurations.id))
    .limit(2);
  if (lineages.length > 1) {
    throw conflict('The facility has conflicting audience lineages.');
  }
  const lineage = lineages[0];
  if (lineage === undefined) {
    return null;
  }
  const [configuration] = await database
    .select()
    .from(audienceConfigurations)
    .where(
      and(
        eq(audienceConfigurations.id, lineage.id),
        eq(audienceConfigurations.facilityId, facilityId),
      ),
    )
    .orderBy(desc(audienceConfigurations.version))
    .limit(1);
  return configuration ?? null;
}

export async function loadAudienceConfiguration(
  database: StartFlowQueryDatabase,
  facilityId: string,
): Promise<Readonly<{
  audienceConfig: AudienceConfig;
  neighborhoodVersions: readonly Neighborhood[];
}> | null> {
  const configuration = await loadLatestAudienceConfigurationHeader(
    database,
    facilityId,
  );
  if (configuration === null) {
    return null;
  }
  const targets = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select()
        .from(audienceTargets)
        .where(
          and(
            eq(audienceTargets.audienceConfigId, configuration.id),
            eq(audienceTargets.audienceConfigVersion, configuration.version),
          ),
        )
        .orderBy(asc(audienceTargets.ordinal))
        .offset(offset)
        .limit(limit),
    { maxRows: AUDIENCE_QUERY_LIMITS.targets },
  );

  const othersIds = targets.flatMap((target) =>
    target.targetKind === 'others' && target.groupSourceId !== null
      ? [target.groupSourceId]
      : [],
  );
  const uniqueOthersIds = [...new Set(othersIds)].sort();
  const otherSources =
    uniqueOthersIds.length === 0
      ? []
      : await collectBoundedDatabaseRows(
          (offset, limit) =>
            database
              .select()
              .from(groupSources)
              .where(inArray(groupSources.id, uniqueOthersIds))
              .orderBy(asc(groupSources.id))
              .offset(offset)
              .limit(limit),
          { maxRows: AUDIENCE_QUERY_LIMITS.otherSources },
        );
  const otherById = new Map(otherSources.map((source) => [source.id, source]));

  const neighborhoodRefs = targets.flatMap((target) =>
    target.targetKind === 'neighborhood' &&
    target.neighborhoodId !== null &&
    target.neighborhoodVersion !== null
      ? [
          {
            id: target.neighborhoodId,
            version: target.neighborhoodVersion,
          },
        ]
      : [],
  );
  const resolvedNeighborhoods: Neighborhood[] = [];
  for (const reference of neighborhoodRefs) {
    const [version] = await database
      .select()
      .from(neighborhoodVersions)
      .where(
        and(
          eq(neighborhoodVersions.id, reference.id),
          eq(neighborhoodVersions.version, reference.version),
        ),
      )
      .limit(1);
    if (version === undefined) {
      return null;
    }
    const members = await collectBoundedDatabaseRows(
      (offset, limit) =>
        database
          .select({ facilityId: neighborhoodFacilities.facilityId })
          .from(neighborhoodFacilities)
          .where(
            and(
              eq(neighborhoodFacilities.neighborhoodId, reference.id),
              eq(neighborhoodFacilities.neighborhoodVersion, reference.version),
            ),
          )
          .orderBy(asc(neighborhoodFacilities.facilityId))
          .offset(offset)
          .limit(limit),
      { maxRows: AUDIENCE_QUERY_LIMITS.neighborhoodFacilities },
    );
    resolvedNeighborhoods.push(
      NeighborhoodSchema.parse({
        id: version.id,
        version: version.version,
        name: version.name,
        facilityIds: members.map((member) => member.facilityId),
        createdAt: dateIso(version.createdAt),
      }),
    );
  }

  const parsedTargets = targets.map((target) => {
    switch (target.targetKind) {
      case 'building':
        if (target.targetFacilityId === null) {
          throw conflict('The audience building target is incomplete.');
        }
        return {
          kind: 'building' as const,
          facilityId: target.targetFacilityId,
        };
      case 'neighborhood':
        if (
          target.neighborhoodId === null ||
          target.neighborhoodVersion === null
        ) {
          throw conflict('The audience neighborhood target is incomplete.');
        }
        return {
          kind: 'neighborhood' as const,
          neighborhood: {
            id: target.neighborhoodId,
            version: target.neighborhoodVersion,
          },
        };
      case 'others': {
        const source =
          target.groupSourceId === null
            ? undefined
            : otherById.get(target.groupSourceId);
        if (
          source === undefined ||
          source.purpose !== 'others' ||
          source.facilityId !== null
        ) {
          throw conflict('The audience others target is unavailable.');
        }
        return {
          kind: 'others' as const,
          groupSourceRef: rosterGroupSourceRef({
            id: source.id,
            kind: source.kind,
            purpose: source.purpose,
            facilityId: source.facilityId,
          }),
        };
      }
    }
  });

  return Object.freeze({
    audienceConfig: AudienceConfigSchema.parse({
      id: configuration.id,
      facilityId: configuration.facilityId,
      version: configuration.version,
      targets: parsedTargets,
      createdAt: dateIso(configuration.createdAt),
    }),
    neighborhoodVersions: Object.freeze(resolvedNeighborhoods),
  });
}

export async function loadRosterSnapshot(
  database: StartFlowQueryDatabase,
  population: RosterPopulation,
  facilityId: string,
  exactSnapshotId?: string,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<RosterSnapshot | null> {
  const [snapshot] = await database
    .select({ snapshot: rosterSnapshots })
    .from(rosterSnapshots)
    .innerJoin(
      rosterSnapshotFacilities,
      eq(rosterSnapshotFacilities.rosterSnapshotId, rosterSnapshots.id),
    )
    .where(
      and(
        eq(rosterSnapshots.population, population),
        eq(rosterSnapshots.complete, true),
        eq(rosterSnapshotFacilities.facilityId, facilityId),
        exactSnapshotId === undefined
          ? undefined
          : eq(rosterSnapshots.id, exactSnapshotId),
      ),
    )
    .orderBy(
      desc(rosterSnapshots.version),
      desc(rosterSnapshots.capturedAt),
      asc(rosterSnapshots.id),
    )
    .limit(1);
  if (snapshot === undefined) {
    return null;
  }
  const snapshotId = snapshot.snapshot.id;
  const cached = hydrationCache?.snapshot;
  if (
    cached !== null &&
    cached !== undefined &&
    cached.id === snapshotId &&
    cached.population === population &&
    cached.facilityIds.includes(facilityId)
  ) {
    return cached;
  }
  const facilityRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select({ facilityId: rosterSnapshotFacilities.facilityId })
        .from(rosterSnapshotFacilities)
        .where(eq(rosterSnapshotFacilities.rosterSnapshotId, snapshotId))
        .orderBy(asc(rosterSnapshotFacilities.facilityId))
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.facilities },
  );
  const sourceRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select({
          completionKind: rosterSnapshotSources.completionKind,
          id: groupSources.id,
          kind: groupSources.kind,
          purpose: groupSources.purpose,
          facilityId: groupSources.facilityId,
        })
        .from(rosterSnapshotSources)
        .innerJoin(
          groupSources,
          eq(groupSources.id, rosterSnapshotSources.groupSourceId),
        )
        .where(eq(rosterSnapshotSources.rosterSnapshotId, snapshotId))
        .orderBy(
          asc(rosterSnapshotSources.completionKind),
          asc(rosterSnapshotSources.groupSourceId),
        )
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.sources },
  );
  const recipientRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select()
        .from(rosterRecipients)
        .where(eq(rosterRecipients.rosterSnapshotId, snapshotId))
        .orderBy(asc(rosterRecipients.id))
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.recipients },
  );
  const provenanceRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select({
          recipientId: rosterRecipientGroupSources.recipientId,
          id: groupSources.id,
          kind: groupSources.kind,
          purpose: groupSources.purpose,
          facilityId: groupSources.facilityId,
        })
        .from(rosterRecipientGroupSources)
        .innerJoin(
          groupSources,
          eq(groupSources.id, rosterRecipientGroupSources.groupSourceId),
        )
        .where(eq(rosterRecipientGroupSources.rosterSnapshotId, snapshotId))
        .orderBy(
          asc(rosterRecipientGroupSources.recipientId),
          asc(rosterRecipientGroupSources.groupSourceId),
        )
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.provenance },
  );
  const endpointRows: Array<typeof rosterEndpoints.$inferSelect> = [];
  // Push tokens have a much larger contract ceiling than email addresses or
  // phone numbers. Keep push pages at the conservative Data API bound while
  // reading the two compact channel shapes in normal bounded pages. This
  // preserves the aggregate endpoint ceiling without forcing every compact
  // row through worst-case push-token pagination.
  for (const channel of ['push', 'email', 'sms'] as const) {
    const channelRows = await collectBoundedDatabaseRows(
      (offset, limit) =>
        database
          .select()
          .from(rosterEndpoints)
          .where(
            and(
              eq(rosterEndpoints.rosterSnapshotId, snapshotId),
              eq(rosterEndpoints.channel, channel),
            ),
          )
          .orderBy(asc(rosterEndpoints.recipientId), asc(rosterEndpoints.id))
          .offset(offset)
          .limit(limit),
      {
        maxRows: ROSTER_QUERY_LIMITS.endpoints - endpointRows.length,
        pageSize:
          channel === 'push'
            ? START_FLOW_ENDPOINT_PAGE_SIZE
            : START_FLOW_DATABASE_PAGE_SIZE,
      },
    );
    endpointRows.push(...channelRows);
  }
  endpointRows.sort(
    (left, right) =>
      left.recipientId.localeCompare(right.recipientId) ||
      left.id.localeCompare(right.id),
  );

  const groupRefsForRecipient = new Map<string, RosterGroupSourceRef[]>();
  for (const row of provenanceRows) {
    if (row.purpose === 'access') {
      throw conflict('The roster contains an invalid access-group source.');
    }
    const references = groupRefsForRecipient.get(row.recipientId) ?? [];
    references.push(
      rosterGroupSourceRef({
        id: row.id,
        kind: row.kind,
        purpose: row.purpose,
        facilityId: row.facilityId,
      }),
    );
    groupRefsForRecipient.set(row.recipientId, references);
  }

  const endpointsForRecipient = new Map<
    string,
    Array<ReturnType<typeof EndpointSchema.parse>>
  >();
  for (const row of endpointRows) {
    const common = {
      id: row.id,
      status: row.status,
      capturedAt: dateIso(row.capturedAt),
    };
    const endpoint = EndpointSchema.parse(
      row.channel === 'push'
        ? {
            ...common,
            channel: row.channel,
            platform: row.platform,
            token: row.token,
          }
        : row.channel === 'email'
          ? { ...common, channel: row.channel, email: row.email }
          : { ...common, channel: row.channel, phoneNumber: row.phoneNumber },
    );
    const endpoints = endpointsForRecipient.get(row.recipientId) ?? [];
    endpoints.push(endpoint);
    endpointsForRecipient.set(row.recipientId, endpoints);
  }

  const recipients = recipientRows.map((row) =>
    RecipientSchema.parse({
      id: row.id,
      population: row.population,
      googleSubject: row.googleSubject,
      displayName: row.displayName,
      groupSourceRefs: groupRefsForRecipient.get(row.id) ?? [],
      endpoints: endpointsForRecipient.get(row.id) ?? [],
    }),
  );
  const parsedSources = sourceRows.map((row) => {
    if (row.purpose === 'access') {
      throw conflict('The roster contains an invalid access-group source.');
    }
    return {
      completionKind: row.completionKind,
      reference: rosterGroupSourceRef({
        id: row.id,
        kind: row.kind,
        purpose: row.purpose,
        facilityId: row.facilityId,
      }),
    };
  });

  const parsed = RosterSnapshotSchema.parse({
    id: snapshot.snapshot.id,
    version: snapshot.snapshot.version,
    population: snapshot.snapshot.population,
    complete: true,
    sourceConfiguration: {
      id: snapshot.snapshot.sourceConfigurationId,
      version: snapshot.snapshot.sourceConfigurationVersion,
    },
    facilityIds: facilityRows.map((row) => row.facilityId),
    expectedSourceGroupRefs: parsedSources
      .filter((source) => source.completionKind === 'expected')
      .map((source) => source.reference),
    sourceGroupRefs: parsedSources
      .filter((source) => source.completionKind === 'completed')
      .map((source) => source.reference),
    recipients,
    syncStartedAt: dateIso(snapshot.snapshot.syncStartedAt),
    capturedAt: dateIso(snapshot.snapshot.capturedAt),
  });
  if (hydrationCache !== undefined) {
    hydrationCache.snapshot = parsed;
  }
  return parsed;
}

async function loadChannelConfigurations(
  database: StartFlowQueryDatabase,
): Promise<readonly ChannelConfiguration[]> {
  const rows = await database
    .select({
      configuration: channelConfigurations,
      status: integrationStatuses,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      eq(channelConfigurations.statusId, integrationStatuses.id),
    )
    .where(
      inArray(channelConfigurations.integrationId, [
        'expo-push',
        'ses-email',
        'aws-eum-sms',
      ]),
    )
    .orderBy(asc(channelConfigurations.integrationId));
  return rows.map(({ configuration, status }) =>
    ChannelConfigurationSchema.parse({
      integrationId: configuration.integrationId,
      enabled: configuration.enabled,
      status: IntegrationStatusSchema.parse({
        integrationId: status.integrationId,
        label: status.label,
        verifiedAt:
          status.verifiedAt === null ? null : dateIso(status.verifiedAt),
        verifiedByUserId: status.verifiedByUserId,
        authorizationReference: status.authorizationReference,
        reasonCode: status.reasonCode,
        observedAt: dateIso(status.observedAt),
      }),
      changedAt: dateIso(configuration.changedAt),
    }),
  );
}

async function loadInitiatorDisplayName(
  database: StartFlowQueryDatabase,
  actor: Actor,
): Promise<string | null> {
  switch (actor.kind) {
    case 'human': {
      const [row] = await database
        .select({ displayName: users.displayName })
        .from(users)
        .where(
          and(eq(users.id, actor.userId), sql`${users.disabledAt} is null`),
        )
        .limit(1);
      return row?.displayName ?? null;
    }
    case 'agent': {
      const [row] = await database
        .select({ displayName: agents.displayName })
        .from(agents)
        .where(eq(agents.id, actor.agentId))
        .limit(1);
      return row?.displayName ?? null;
    }
    case 'system':
      return null;
  }
}

function mapPreviewConstructionError(error: unknown): never {
  if (error instanceof CapabilityEngineError) {
    throw error;
  }
  if (error instanceof FanoutControlDeniedError) {
    throw unavailable(
      'Notification fan-out is emergency-disabled or unavailable. No activation preview was created.',
    );
  }
  if (error instanceof EventTypeCapabilityError) {
    if (error.code === 'NOT_FOUND') {
      throw unavailable('The selected event type is unavailable.');
    }
    throw conflict('The selected event type is inconsistent.');
  }
  if (error instanceof BoundedDatabaseQueryError) {
    throw conflict(
      'The activation consequence data exceeds its supported query bounds.',
    );
  }
  if (error instanceof ActivationPreviewBuildError) {
    switch (error.code) {
      case 'FACILITY_UNAVAILABLE':
      case 'EVENT_TYPE_UNAVAILABLE':
      case 'AUDIENCE_UNAVAILABLE':
      case 'CHANNEL_CONFIGURATION_UNAVAILABLE':
      case 'INITIATOR_UNAVAILABLE':
        throw unavailable(error.message);
      case 'PREVIEW_TIME_INVALID':
        throw conflict(error.message);
    }
  }
  if (error instanceof AudienceResolutionError) {
    throw unavailable(error.message);
  }
  throw error;
}

export type DeliveryTestEndpointReference = Readonly<{
  recipientId: string;
  endpointId: string;
  channel: 'push' | 'email' | 'sms';
}>;

interface DeliveryTestPreviewContext {
  readonly targetSet: DeliveryTestTargetSetVersion;
  readonly metadata: DeliveryTestNotificationMetadata;
  readonly credentialVerificationReferences: DeliveryTestCredentialVerificationReferences;
}

const DELIVERY_TEST_CHANNEL_BY_INTEGRATION_ID = Object.freeze({
  'expo-push': 'push',
  'ses-email': 'email',
  'aws-eum-sms': 'sms',
} as const);

function deliveryTestCredentialBlockingReasonCodes(
  configurations: readonly ChannelConfiguration[],
  targetSet: DeliveryTestTargetSetVersion,
  references: DeliveryTestCredentialVerificationReferences,
): readonly string[] {
  const targetedChannels = new Set(
    targetSet.endpoints.map((endpoint) => endpoint.channel),
  );
  const statusByChannel = new Map(
    configurations.flatMap((configuration) => {
      const channel =
        DELIVERY_TEST_CHANNEL_BY_INTEGRATION_ID[
          configuration.integrationId as keyof typeof DELIVERY_TEST_CHANNEL_BY_INTEGRATION_ID
        ];
      return channel === undefined
        ? []
        : ([[channel, configuration.status]] as const);
    }),
  );
  return Object.freeze(
    [...targetedChannels]
      .filter(
        (channel) =>
          !deliveryTestCredentialIsVerified(
            statusByChannel.get(channel) ?? {
              label: 'configured-unverified',
              verifiedAt: null,
              authorizationReference: null,
            },
            references[channel],
          ),
      )
      .map((channel) => `${channel.toUpperCase()}_CREDENTIAL_UNVERIFIED`)
      .sort(),
  );
}

function endpointReferenceKey(
  reference: DeliveryTestEndpointReference,
): string {
  return `${reference.channel}:${reference.recipientId}:${reference.endpointId}`;
}

export async function loadDeliveryTestTargetSet(
  database: StartFlowQueryDatabase,
  reference: Readonly<{ id: string; version: number }>,
): Promise<DeliveryTestTargetSetVersion | null> {
  const [row] = await database
    .select()
    .from(deliveryTestTargetSetVersions)
    .where(
      and(
        eq(deliveryTestTargetSetVersions.id, reference.id),
        eq(deliveryTestTargetSetVersions.version, reference.version),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  const endpoints = await database
    .select()
    .from(deliveryTestTargetEndpoints)
    .where(eq(deliveryTestTargetEndpoints.targetSetVersionId, row.id))
    .orderBy(
      asc(deliveryTestTargetEndpoints.channel),
      asc(deliveryTestTargetEndpoints.recipientId),
      asc(deliveryTestTargetEndpoints.endpointId),
    );
  return DeliveryTestTargetSetVersionSchema.parse({
    id: row.id,
    version: row.version,
    facilityId: row.facilityId,
    rosterSnapshotId: row.rosterSnapshotId,
    supersedesVersionId: row.supersedesVersionId,
    endpoints: endpoints.map((endpoint) => ({
      eligibilityFactId: endpoint.eligibilityFactId,
      recipientId: endpoint.recipientId,
      endpointId: endpoint.endpointId,
      channel: endpoint.channel,
      attestation: endpoint.attestation,
      optedInAt: dateIso(endpoint.optedInAt),
      attestedAt: dateIso(endpoint.attestedAt),
      attestedByUserId: endpoint.attestedByUserId,
      authorizationReference: endpoint.authorizationReference,
    })),
    endpointReferenceDigest: row.endpointReferenceDigest,
    approvedByUserId: row.approvedByUserId,
    approvedWithSessionId: row.approvedWithSessionId,
    approvedAt: dateIso(row.approvedAt),
    createdAt: dateIso(row.createdAt),
  });
}

export async function currentActiveAudienceEndpointReferences(
  database: StartFlowQueryDatabase,
  rosterSnapshot: RosterSnapshot,
  audience: Awaited<ReturnType<typeof loadAudienceConfiguration>>,
): Promise<readonly DeliveryTestEndpointReference[]> {
  const references = allAudienceEndpointReferences(rosterSnapshot, audience);
  const endpointIds = references.map((endpoint) => endpoint.endpointId);
  if (endpointIds.length === 0) return [];
  const rows = await database
    .select({
      endpointId: rosterEndpoints.id,
      recipientId: rosterEndpoints.recipientId,
      channel: rosterEndpoints.channel,
      baseStatus: rosterEndpoints.status,
      latestStatus: sql<'active' | 'invalid' | 'disabled' | null>`(
        select esr.status
        from endpoint_status_records esr
        where esr.roster_snapshot_id = ${rosterEndpoints.rosterSnapshotId}
          and esr.endpoint_id = ${rosterEndpoints.id}
        order by esr.recorded_at desc, esr.sequence desc
        limit 1
      )`,
    })
    .from(rosterEndpoints)
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, rosterSnapshot.id),
        inArray(rosterEndpoints.id, endpointIds),
      ),
    );
  if (rows.length !== endpointIds.length) {
    throw unavailable('The configured canary audience is unavailable.');
  }
  const referenceKeys = new Set(references.map(endpointReferenceKey));
  if (
    rows.some(
      (row) =>
        !referenceKeys.has(
          endpointReferenceKey({
            endpointId: row.endpointId,
            recipientId: row.recipientId,
            channel: row.channel,
          }),
        ),
    )
  ) {
    throw conflict('The configured canary audience is inconsistent.');
  }
  return Object.freeze(
    rows
      .filter((row) => (row.latestStatus ?? row.baseStatus) === 'active')
      .map((row) =>
        Object.freeze({
          recipientId: row.recipientId,
          endpointId: row.endpointId,
          channel: row.channel,
        }),
      ),
  );
}

/**
 * Revalidates the independently authored, append-only eligibility facts and
 * current active audience for a pinned delivery-test target. Callers hold the
 * facility target-set advisory lock so a concurrent revocation cannot race a
 * preview or event start.
 */
export async function requireCurrentDeliveryTestTargetEligibility(
  database: StartFlowQueryDatabase,
  targetSet: DeliveryTestTargetSetVersion,
  now: Date,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<void> {
  const factIds = targetSet.endpoints.map(
    (endpoint) => endpoint.eligibilityFactId,
  );
  const [facility] = await database
    .select({ active: facilities.active })
    .from(facilities)
    .where(eq(facilities.id, targetSet.facilityId))
    .limit(1);
  const roster = await loadRosterSnapshot(
    database,
    'staff',
    targetSet.facilityId,
    undefined,
    hydrationCache,
  );
  const audience = await loadAudienceConfiguration(
    database,
    targetSet.facilityId,
  );
  if (
    facility === undefined ||
    !facility.active ||
    roster === null ||
    roster.id !== targetSet.rosterSnapshotId ||
    audience === null
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'The pinned canary target no longer belongs to the current active staff audience.',
      403,
    );
  }

  const facts = await database
    .select()
    .from(deliveryTestCanaryEligibilityFacts)
    .where(inArray(deliveryTestCanaryEligibilityFacts.id, factIds));
  const successors = await database
    .select({
      supersedesFactId: deliveryTestCanaryEligibilityFacts.supersedesFactId,
    })
    .from(deliveryTestCanaryEligibilityFacts)
    .where(
      inArray(deliveryTestCanaryEligibilityFacts.supersedesFactId, factIds),
    );
  const activeReferences = await currentActiveAudienceEndpointReferences(
    database,
    roster,
    audience,
  );
  const activeKeys = new Set(activeReferences.map(endpointReferenceKey));
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const valid =
    facts.length === factIds.length &&
    new Set(factIds).size === factIds.length &&
    successors.length === 0 &&
    targetSet.endpoints.every((endpoint) => {
      const fact = factsById.get(endpoint.eligibilityFactId);
      return (
        fact !== undefined &&
        fact.facilityId === targetSet.facilityId &&
        fact.rosterSnapshotId === targetSet.rosterSnapshotId &&
        fact.rosterPopulation === 'staff' &&
        fact.recipientId === endpoint.recipientId &&
        fact.endpointId === endpoint.endpointId &&
        fact.channel === endpoint.channel &&
        fact.decision === 'approved-synthetic-canary' &&
        dateIso(fact.optedInAt) === endpoint.optedInAt &&
        dateIso(fact.decidedAt) === endpoint.attestedAt &&
        fact.decidedAt.getTime() <= now.getTime() &&
        fact.decidedByUserId === endpoint.attestedByUserId &&
        fact.authorizationReference === endpoint.authorizationReference &&
        activeKeys.has(endpointReferenceKey(endpoint))
      );
    });
  if (!valid) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'The pinned canary target no longer has exact current eligibility and active-audience evidence.',
      403,
    );
  }
}

function allAudienceEndpointReferences(
  rosterSnapshot: RosterSnapshot,
  audience: Awaited<ReturnType<typeof loadAudienceConfiguration>>,
): readonly DeliveryTestEndpointReference[] {
  if (audience === null) return [];
  // Resolve audience membership independently from mutable endpoint health;
  // the caller applies the latest status overlay before comparing exact sets.
  const allEndpointsActive = {
    ...rosterSnapshot,
    recipients: rosterSnapshot.recipients.map((recipient) => ({
      ...recipient,
      endpoints: recipient.endpoints.map((endpoint) => ({
        ...endpoint,
        status: 'active' as const,
      })),
    })),
  };
  const resolved = resolveAudience({
    audienceConfig: audience.audienceConfig,
    neighborhoodVersions: audience.neighborhoodVersions,
    rosterSnapshot: allEndpointsActive,
  });
  return resolved.recipients.flatMap((recipient) =>
    recipient.endpoints.map((endpoint) => ({
      recipientId: recipient.recipientId,
      endpointId: endpoint.id,
      channel: endpoint.channel,
    })),
  );
}

async function createActivationPreviewFromDatabase(
  database: StartFlowQueryDatabase,
  input: CapabilityInput<'create-activation-preview'>,
  actor: Actor,
  now: Date,
  deliveryTestContext?: DeliveryTestPreviewContext,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<ActivationPreview> {
  try {
    await assertCurrentNotificationFanoutEnabled(database);
    // The Data API permits only one in-flight statement for a transaction ID.
    // Keep every independent consequence read explicitly sequential.
    const facilityRows = await database
      .select()
      .from(facilities)
      .where(eq(facilities.id, input.facilityId))
      .limit(1);
    const facilityRow = facilityRows[0] ?? null;
    const audience = await loadAudienceConfiguration(
      database,
      input.facilityId,
    );
    const rosterSnapshot = await loadRosterSnapshot(
      database,
      input.rosterPopulation,
      input.facilityId,
      deliveryTestContext?.targetSet.rosterSnapshotId,
      hydrationCache,
    );
    const channelConfigurationsValue =
      await loadChannelConfigurations(database);
    if (facilityRow === null || !facilityRow.active) {
      throw unavailable('The selected facility is unavailable.');
    }
    if (audience === null) {
      throw unavailable('The configured notification audience is unavailable.');
    }
    if (rosterSnapshot === null) {
      throw unavailable('A complete roster snapshot is unavailable.');
    }
    if (deliveryTestContext !== undefined) {
      const targetReferences = deliveryTestContext.targetSet.endpoints.map(
        (endpoint) => ({
          recipientId: endpoint.recipientId,
          endpointId: endpoint.endpointId,
          channel: endpoint.channel,
        }),
      );
      const activeReferences = await currentActiveAudienceEndpointReferences(
        database,
        rosterSnapshot,
        audience,
      );
      if (
        targetReferences.length === 0 ||
        !isDeliveryTestEndpointReferenceSubset(
          targetReferences,
          activeReferences,
        ) ||
        deliveryTestEndpointReferenceDigest(targetReferences) !==
          deliveryTestContext.targetSet.endpointReferenceDigest
      ) {
        throw conflict(
          'An approved canary endpoint is no longer active in the configured audience.',
        );
      }
    }
    const eventTypeVersion = await new DrizzleEventTypeStore(
      eventTypeStoreDatabase(database),
    ).getVersion({
      eventTypeVersionId: input.eventTypeVersion.id,
    });
    const initiatorDisplayName = await loadInitiatorDisplayName(
      database,
      actor,
    );
    const activeEventRows = await database
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.facilityId, input.facilityId),
          eq(events.status, 'active'),
        ),
      )
      .orderBy(asc(events.id))
      .limit(101);
    if (initiatorDisplayName === null) {
      throw unavailable('The initiating identity is unavailable.');
    }
    const preview = buildActivationPreview({
      id: randomUUID(),
      selection: input,
      facility: facilityFromRow(facilityRow),
      eventTypeVersion,
      audienceConfig: audience.audienceConfig,
      neighborhoodVersions: audience.neighborhoodVersions,
      rosterSnapshot,
      channelConfigurations: channelConfigurationsValue,
      activeEventIds: activeEventRows.map((row) => row.id),
      initiator: actor,
      initiatorDisplayName,
      createdAt: now,
      ...(deliveryTestContext === undefined
        ? {}
        : {
            deliveryTest: deliveryTestContext.metadata,
            deliveryTestEndpointReferences:
              deliveryTestContext.targetSet.endpoints,
            additionalBlockingReasonCodes:
              deliveryTestCredentialBlockingReasonCodes(
                channelConfigurationsValue,
                deliveryTestContext.targetSet,
                deliveryTestContext.credentialVerificationReferences,
              ),
          }),
    });
    await database.insert(activationPreviews).values({
      id: preview.id,
      facilityId: preview.facilityId,
      kind: preview.kind,
      templateMode: preview.templateMode,
      eventTypeVersionId: preview.eventTypeVersion.id,
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: preview.rosterPopulation,
      audienceConfigId: preview.audienceConfig.id,
      audienceConfigVersion: preview.audienceConfig.version,
      recipientCount: preview.recipientCount,
      channels: preview.channels,
      sendReadiness: preview.sendReadiness,
      blockingReasonCodes: preview.blockingReasonCodes,
      activeEventIds: preview.activeEventIds,
      consequenceDigest: preview.consequenceDigest,
      deliveryTestTargetSetId: preview.deliveryTest?.targetSet.id ?? null,
      deliveryTestTargetSetVersion:
        preview.deliveryTest?.targetSet.version ?? null,
      deliveryTestEndpointReferenceDigest:
        preview.deliveryTest?.endpointReferenceDigest ?? null,
      createdAt: new Date(preview.createdAt),
      expiresAt: new Date(preview.expiresAt),
    });
    return preview;
  } catch (error) {
    mapPreviewConstructionError(error);
  }
}

async function createDeliveryTestPreviewFromDatabase(
  database: StartFlowQueryDatabase,
  input: CapabilityInput<'create-delivery-test-preview'>,
  actor: Actor,
  now: Date,
  credentialVerificationReferences: DeliveryTestCredentialVerificationReferences,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<DeliveryTestPreview> {
  if (actor.kind !== 'human') {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'A monthly live delivery-test preview requires an authenticated human.',
      403,
    );
  }
  const targetSet = await loadDeliveryTestTargetSet(database, input.targetSet);
  if (targetSet === null) {
    throw unavailable('The approved canary target-set version is unavailable.');
  }
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${deliveryTestTargetLockIdentity(targetSet.facilityId)}, ${DELIVERY_TEST_TARGET_LOCK_NAMESPACE}))`,
  );
  const [successor] = await database
    .select({ id: deliveryTestTargetSetVersions.id })
    .from(deliveryTestTargetSetVersions)
    .where(eq(deliveryTestTargetSetVersions.supersedesVersionId, targetSet.id))
    .limit(1);
  if (successor !== undefined) {
    throw conflict(
      'The approved canary target-set version has been superseded.',
    );
  }
  await requireCurrentDeliveryTestTargetEligibility(
    database,
    targetSet,
    now,
    hydrationCache,
  );
  const metadata: DeliveryTestNotificationMetadata = Object.freeze({
    purpose: 'monthly-live-delivery-test',
    targetSet: input.targetSet,
    endpointReferenceDigest: targetSet.endpointReferenceDigest,
  });
  const activationPreview = await createActivationPreviewFromDatabase(
    database,
    {
      facilityId: targetSet.facilityId,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: input.eventTypeVersion,
      rosterPopulation: 'staff',
    },
    actor,
    now,
    { targetSet, metadata, credentialVerificationReferences },
    hydrationCache,
  );
  return DeliveryTestPreviewSchema.parse({
    purpose: 'monthly-live-delivery-test',
    activationPreview,
    targetSet: input.targetSet,
    endpointReferenceDigest: targetSet.endpointReferenceDigest,
    channels: activationPreview.channels.map((channel) => ({
      channel: channel.channel,
      endpointCount: channel.endpointCount,
      integrationStatus: channel.integrationStatus,
      credentialVerified: deliveryTestCredentialIsVerified(
        channel.integrationStatus,
        credentialVerificationReferences[channel.channel],
      ),
    })),
    consequenceDigest: activationPreview.consequenceDigest,
    createdAt: activationPreview.createdAt,
    expiresAt: activationPreview.expiresAt,
  });
}

export interface ActivationPreviewLoadOptions {
  /** Retains the immutable preview row under a shared transaction lock. */
  readonly lock?: 'share';
}

/**
 * Loads the canonical persisted consequence preview without roster details.
 * The structural database seam accepts either a configured database or the
 * transaction supplied by Drizzle's `database.transaction` callback.
 */
export async function loadActivationPreview(
  databaseValue: unknown,
  previewId: string,
  options: ActivationPreviewLoadOptions = {},
): Promise<ActivationPreview | null> {
  const database = startFlowQueryDatabase(databaseValue);
  const rows =
    options.lock === 'share'
      ? await database
          .select()
          .from(activationPreviews)
          .where(eq(activationPreviews.id, previewId))
          .for('share')
          .limit(1)
      : await database
          .select()
          .from(activationPreviews)
          .where(eq(activationPreviews.id, previewId))
          .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const [audience] = await database
    .select({ facilityId: audienceConfigurations.facilityId })
    .from(audienceConfigurations)
    .where(
      and(
        eq(audienceConfigurations.id, row.audienceConfigId),
        eq(audienceConfigurations.version, row.audienceConfigVersion),
      ),
    )
    .limit(1);
  if (audience?.facilityId !== row.facilityId) {
    throw conflict('The activation audience is not owned by the facility.');
  }
  return ActivationPreviewSchema.parse({
    id: row.id,
    facilityId: row.facilityId,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    recipientCount: row.recipientCount,
    channels: row.channels,
    sendReadiness: row.sendReadiness,
    blockingReasonCodes: row.blockingReasonCodes,
    activeEventIds: row.activeEventIds,
    deliveryTest:
      row.deliveryTestTargetSetId === null ||
      row.deliveryTestTargetSetVersion === null ||
      row.deliveryTestEndpointReferenceDigest === null
        ? null
        : {
            purpose: 'monthly-live-delivery-test',
            targetSet: {
              id: row.deliveryTestTargetSetId,
              version: row.deliveryTestTargetSetVersion,
            },
            endpointReferenceDigest: row.deliveryTestEndpointReferenceDigest,
          },
    consequenceDigest: row.consequenceDigest,
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

function createDrizzleStartFlowTransaction(
  database: StartFlowQueryDatabase,
  credentialVerificationReferences: DeliveryTestCredentialVerificationReferences,
  hydrationCache: RosterSnapshotHydrationCache,
): StartFlowCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: () => unsupportedQueryMutationMethod(),
    completeIdempotency: () => unsupportedQueryMutationMethod(),
    getHumanConfirmation: () => unsupportedQueryMutationMethod(),
    consumeHumanConfirmation: () => unsupportedQueryMutationMethod(),
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
    listFacilities: (input, scope) =>
      listFacilitiesFromDatabase(database, input, scope),
    createActivationPreview: (input, actor, now) =>
      createActivationPreviewFromDatabase(
        database,
        input,
        actor,
        now,
        undefined,
        hydrationCache,
      ),
    async resolveDeliveryTestFacilityId(input) {
      const [row] = await database
        .select({ facilityId: deliveryTestTargetSetVersions.facilityId })
        .from(deliveryTestTargetSetVersions)
        .where(
          and(
            eq(deliveryTestTargetSetVersions.id, input.targetSet.id),
            eq(deliveryTestTargetSetVersions.version, input.targetSet.version),
          ),
        )
        .limit(1);
      return row?.facilityId ?? null;
    },
    createDeliveryTestPreview: (input, actor, now) =>
      createDeliveryTestPreviewFromDatabase(
        database,
        input,
        actor,
        now,
        credentialVerificationReferences,
        hydrationCache,
      ),
  };
}

/** Production Drizzle store; preview persistence and success audit are atomic. */
export function createDrizzleStartFlowCapabilityStore(
  database: Database,
  options: Readonly<{
    credentialVerificationReferences?: DeliveryTestCredentialVerificationReferences;
  }> = {},
): StartFlowCapabilityStore {
  const credentialVerificationReferences =
    options.credentialVerificationReferences ??
    readDeliveryTestCredentialVerificationReferences();
  const hydrationCache: RosterSnapshotHydrationCache = { snapshot: null };
  return {
    transaction<Result>(
      operation: (
        transaction: StartFlowCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) =>
        operation(
          createDrizzleStartFlowTransaction(
            startFlowQueryDatabase(transaction),
            credentialVerificationReferences,
            hydrationCache,
          ),
        ),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction(async (transaction) =>
        appendCapabilityAuditEntry(startFlowQueryDatabase(transaction), event),
      );
    },
  };
}

export const listFacilitiesRegistration: ServerCapabilityRegistration<
  'list-facilities',
  StartFlowCapabilityTransaction
> = {
  id: 'list-facilities',
  resolveFacilityId: () => null,
  async handler(input, context): Promise<FacilityPage> {
    return FacilityPageSchema.parse(
      await context.transaction.listFacilities(input, context.invocation.scope),
    );
  },
};

export const createActivationPreviewRegistration: ServerCapabilityRegistration<
  'create-activation-preview',
  StartFlowCapabilityTransaction
> = {
  id: 'create-activation-preview',
  resolveFacilityId: (input) => input.facilityId,
  async handler(input, context): Promise<ActivationPreview> {
    return ActivationPreviewSchema.parse(
      await context.transaction.createActivationPreview(
        input,
        context.invocation.actor,
        await readCapabilityTime(context),
      ),
    );
  },
};

export const createDeliveryTestPreviewRegistration: ServerCapabilityRegistration<
  'create-delivery-test-preview',
  StartFlowCapabilityTransaction
> = {
  id: 'create-delivery-test-preview',
  resolveFacilityId(input, context) {
    const resolveFacilityId = context.transaction.resolveDeliveryTestFacilityId;
    if (resolveFacilityId === undefined) {
      throw unavailable('The monthly delivery-test preview is unavailable.');
    }
    return resolveFacilityId(input);
  },
  async handler(input, context): Promise<DeliveryTestPreview> {
    const createPreview = context.transaction.createDeliveryTestPreview;
    if (createPreview === undefined) {
      throw unavailable('The monthly delivery-test preview is unavailable.');
    }
    return DeliveryTestPreviewSchema.parse(
      await createPreview(
        input,
        context.invocation.actor,
        await readCapabilityTime(context),
      ),
    );
  },
};

const registrations = Object.freeze({
  'list-facilities': listFacilitiesRegistration,
  'create-activation-preview': createActivationPreviewRegistration,
  'create-delivery-test-preview': createDeliveryTestPreviewRegistration,
});

/** Executes one start-flow query through the canonical capability engine. */
export async function executeStartFlowCapability<
  Id extends StartFlowCapabilityId,
>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: StartFlowCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, StartFlowCapabilityTransaction>;
  return executeCapability(registration, input, invocation, store);
}

export interface StartFlowCapabilityRuntime {
  readonly store: StartFlowCapabilityStore;
  execute<Id extends StartFlowCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  close(): Promise<void>;
}

/** Builds a start-flow runtime around an explicitly managed connection. */
export function createStartFlowCapabilityRuntime(
  connection: DatabaseConnection,
): StartFlowCapabilityRuntime {
  const store = createDrizzleStartFlowCapabilityStore(connection.db);
  return {
    store,
    execute: (capabilityId, input, invocation) =>
      executeStartFlowCapability(capabilityId, input, invocation, store),
    close: () => connection.close(),
  };
}

let defaultStartFlowCapabilityRuntime: StartFlowCapabilityRuntime | undefined;

/** Lazily creates the database-backed runtime used by the web start flow. */
export function getDefaultStartFlowCapabilityRuntime(): StartFlowCapabilityRuntime {
  defaultStartFlowCapabilityRuntime ??= createStartFlowCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultStartFlowCapabilityRuntime;
}

/** Lifecycle hook for tests and scripts; Next.js retains the normal pool. */
export async function closeDefaultStartFlowCapabilityRuntime(): Promise<void> {
  const runtime = defaultStartFlowCapabilityRuntime;
  defaultStartFlowCapabilityRuntime = undefined;
  await runtime?.close();
}
