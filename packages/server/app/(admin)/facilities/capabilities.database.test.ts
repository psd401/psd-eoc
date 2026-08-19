import { createHash, randomUUID } from 'node:crypto';

import { IntegrationChannelChangeAuthorizationSchema } from '@psd-eoc/contracts';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  audienceConfigurations,
  channelConfigurations,
  deviceEnrollments,
  groupSources,
  integrationChannelChangeAuthorizations,
  integrationStatuses,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  rosterSnapshots,
  rosterSyncResults,
  securityAuditChainAnchors,
  securityAuditEntries,
  sessions,
  userRoleChanges,
  userRoles,
  userFacilityScopes,
  users,
} from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import { decideAccess } from '../../../lib/auth/trusted-group-access';
import { SECURITY_AUDIT_APPEND_LOCK_SQL } from '../../../lib/audit/drizzle-repository';
import {
  loadAccessConfigurationSnapshotState,
  loadEffectiveAdministratorUserIds,
  loadEffectiveRoles,
} from '../../../lib/auth/role-state';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  createDrizzleInitialWebSessionStore,
  type PersistInitialWebSessionRequest,
} from '../../../lib/auth/session-cookie';
import { executeCapability } from '../../../lib/capabilities/engine';
import { requireSyntheticTestDatabaseUrl } from '../event-types/test-database';
import {
  executeListUsersCapability,
  executeSetUserRolesCapability,
} from '../access/capabilities';
import {
  executeIntegrationHealthProjection,
  executeSetChannelEnabledCapability,
  liveChannelChangeAuthorizationCommitment,
  liveChannelChangeConsequenceDigest,
  liveChannelChangeRequestDigest,
  setChannelEnabledRegistration,
} from '../integrations/capabilities';
import { executeRosterHealthProjection } from '../integrations/roster-health';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
} from './admin-core';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from './owned-database-lifecycle';
import {
  executeCreateAudienceConfigVersionCapability,
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeCreateNeighborhoodVersionCapability,
  executeFacilitiesAdminProjection,
  executeGetAudienceConfigCapability,
  executeGetAudienceConfigVersionCapability,
  executeGetNeighborhoodVersionCapability,
  executeListFacilitiesCapability,
  executeListGroupSourcesCapability,
  executeListNeighborhoodsCapability,
  executeListNeighborhoodVersionsCapability,
  executeUpdateFacilityCapability,
  executeUpdateGroupSourceCapability,
} from './capabilities';

const DESIGNATED_ACCESS_GROUP_EMAIL = 'tsd-engineering@psd401.net';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface FacilitiesTestContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i26_fac_[a-f0-9]{32}_test$/u;
let context: FacilitiesTestContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
let databaseCreated = false;

function buildContext(baseDatabaseUrl: string): FacilitiesTestContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i26_fac_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable facilities database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-26:facilities-capabilities-test:${runId}`,
  });
}

function openPostgresConnection(
  url: string,
  maxConnections: number,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Facilities integration tests require PostgreSQL.');
  }
  return opened;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readDatabaseMarker(
  admin: PostgresDatabaseConnection,
  databaseName: string,
): Promise<string | null | undefined> {
  const rows = databaseExecuteRows<MarkerRow>(
    await admin.db.execute<MarkerRow>(sql`
      select shobj_description(oid, 'pg_database') as marker
      from pg_database
      where datname = ${databaseName}
    `),
  );
  if (rows.length > 1) {
    throw new Error(
      'The disposable facilities database identity is ambiguous.',
    );
  }
  return rows[0]?.marker;
}

async function createOwnedDatabase(
  createdContext: FacilitiesTestContext,
  closeAdmin: (connection: PostgresDatabaseConnection) => Promise<void> = (
    connection,
  ) => connection.close(),
  readMarker: typeof readDatabaseMarker = readDatabaseMarker,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${createdContext.databaseName}"`),
      );
      recordCreated();
      await admin.db.execute(
        sql.raw(
          `comment on database "${createdContext.databaseName}" is ${quotedLiteral(createdContext.marker)}`,
        ),
      );
      expect(await readMarker(admin, createdContext.databaseName)).toBe(
        createdContext.marker,
      );
    },
    closeCreator: () => closeAdmin(admin),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(createdContext),
    failureMessage:
      'Disposable facilities database operation, creator close, or marker-owned rollback failed.',
  });
}

async function dropOwnedDatabase(
  createdContext: FacilitiesTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(
        admin,
        createdContext.databaseName,
      );
      if (marker !== undefined && marker !== createdContext.marker) {
        throw new Error(
          'Refusing to drop a database without the exact issue #26 facilities ownership marker.',
        );
      }
      if (marker === createdContext.marker) {
        await admin.db.execute(
          sql.raw(
            `drop database "${createdContext.databaseName}" with (force)`,
          ),
        );
        expect(
          await readDatabaseMarker(admin, createdContext.databaseName),
        ).toBeUndefined();
      }
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Disposable facilities database cleanup and connection close both failed.',
  });
}

async function cleanupResources(): Promise<void> {
  const errors: unknown[] = [];
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      errors.push(error);
    } finally {
      connection = undefined;
    }
  }
  if (databaseCreated && context !== undefined) {
    try {
      await dropOwnedDatabase(context);
      databaseCreated = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #26 facilities integration test cleanup failed.',
    );
  }
}

async function withIsolatedFacilitiesDatabase<Result>(
  baseDatabaseUrl: string,
  operation: (
    isolatedContext: FacilitiesTestContext,
    isolatedConnection: PostgresDatabaseConnection,
  ) => Promise<Result>,
): Promise<Result> {
  const isolatedContext = buildContext(baseDatabaseUrl);
  let isolatedConnection: PostgresDatabaseConnection | undefined;
  let isolatedDatabaseCreated = false;
  let result: Result | undefined;
  const operationErrors: unknown[] = [];
  try {
    await createOwnedDatabase(isolatedContext);
    isolatedDatabaseCreated = true;
    isolatedConnection = openPostgresConnection(isolatedContext.databaseUrl, 6);
    await migrateDatabase(isolatedConnection);
    await seedDatabase(isolatedConnection.db);
    result = await operation(isolatedContext, isolatedConnection);
  } catch (error) {
    operationErrors.push(error);
  }

  const cleanupErrors: unknown[] = [];
  if (isolatedConnection !== undefined) {
    try {
      await isolatedConnection.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (isolatedDatabaseCreated) {
    try {
      await dropOwnedDatabase(isolatedContext);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationErrors.length > 0 || cleanupErrors.length > 0) {
    if (operationErrors.length === 1 && cleanupErrors.length === 0) {
      throw operationErrors[0];
    }
    throw new AggregateError(
      [...operationErrors, ...cleanupErrors],
      'The isolated issue #26 application-role proof or its cleanup failed.',
    );
  }
  return result as Result;
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The facilities integration database is not open.');
  }
  return connection;
}

function authenticatedAdministrator(): AuthenticatedSession {
  const userId = randomUUID();
  const sessionId = randomUUID();
  return {
    actor: { kind: 'human', userId, sessionId },
    source: 'web',
    roles: ['admin'],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: randomUUID() } },
  } as unknown as AuthenticatedSession;
}

function metadata(label: string, requestIds: string[]) {
  const requestId = randomUUID();
  requestIds.push(requestId);
  return {
    idempotencyKey: `issue-26-${label}-${randomUUID()}`,
    requestId,
    now: new Date(),
  };
}

function replayMetadata(
  original: Readonly<ReturnType<typeof metadata>>,
  requestIds?: string[],
) {
  const requestId = randomUUID();
  requestIds?.push(requestId);
  return {
    ...original,
    requestId,
    now: new Date(),
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function liveAuthorizationFor(input: {
  readonly authenticated: AuthenticatedSession;
  readonly integrationId: string;
  readonly integrationStatusId: string;
  readonly previousConfiguration: Readonly<{
    enabled: boolean;
    statusId: string;
  }> | null;
  readonly issuedAt: Date;
  readonly desiredEnabled?: boolean;
}) {
  if (input.authenticated.actor.kind !== 'human') {
    throw new Error('A live authorization requires a synthetic human actor.');
  }
  const desiredEnabled = input.desiredEnabled ?? true;
  const base = {
    reference: `issue-26-live-race-${randomUUID()}`,
    integrationStatusId: input.integrationStatusId,
    integrationId: input.integrationId,
    desiredEnabled,
    requestDigest: '0'.repeat(64),
    consequenceDigest: '0'.repeat(64),
    authorizedByUserId: input.authenticated.actor.userId,
    authorizedWithSessionId: input.authenticated.actor.sessionId,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: new Date(
      input.issuedAt.getTime() + 15 * 60 * 1_000,
    ).toISOString(),
  } as const;
  return IntegrationChannelChangeAuthorizationSchema.parse({
    ...base,
    requestDigest: liveChannelChangeRequestDigest(base),
    consequenceDigest: liveChannelChangeConsequenceDigest({
      integrationId: input.integrationId,
      previousConfiguration: input.previousConfiguration,
      desiredEnabled,
      integrationStatusId: input.integrationStatusId,
    }),
  });
}

function bootstrapSessionRequest(input: {
  readonly label: string;
  readonly user: PersistInitialWebSessionRequest['user'];
  readonly membership: PersistInitialWebSessionRequest['membership'];
  readonly createdAt: Date;
}): PersistInitialWebSessionRequest {
  const responseDigest = digest(`response:${input.label}`);
  const principal = {
    kind: 'oidc-callback' as const,
    subjectDigest: digest(input.user.googleSubject),
    responseDigest,
  };
  return Object.freeze({
    user: input.user,
    membership: input.membership,
    device: Object.freeze({
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `issue-26-bootstrap-${input.label}`,
    } as const),
    credentialDigest: digest(`credential:${input.label}`),
    createdAt: input.createdAt,
    expiresAt: new Date(input.createdAt.getTime() + 72 * 60 * 60 * 1_000),
    membershipValidUntil: new Date(
      input.createdAt.getTime() + 24 * 60 * 60 * 1_000,
    ),
    membershipGraceUntil: new Date(
      input.createdAt.getTime() + 48 * 60 * 60 * 1_000,
    ),
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digest(JSON.stringify(principal)),
      requestDigest: digest(`request:${input.label}`),
    },
  });
}

interface AccessSnapshotGroupFixture {
  readonly id: string;
  readonly kind: 'google-group';
  readonly purpose: 'access';
}

interface AccessSnapshotMemberFixture {
  readonly userId: string;
  readonly googleSubject: string;
  readonly facilityScopeKind: 'district' | 'facilities';
  readonly accessGroupIds: readonly string[];
  readonly facilityIds?: readonly string[];
}

interface PersistAccessSnapshotFixtureInput {
  readonly groups: readonly AccessSnapshotGroupFixture[];
  readonly members: readonly AccessSnapshotMemberFixture[];
  readonly capturedAt?: Date;
}

interface PersistedAccessSnapshotFixture {
  readonly id: string;
  readonly version: number;
  readonly capturedAt: Date;
}

async function persistCompleteAccessSnapshotGeneration(
  database: PostgresDatabaseConnection['db'],
  input: PersistAccessSnapshotFixtureInput,
): Promise<PersistedAccessSnapshotFixture> {
  if (input.groups.length === 0) {
    throw new Error('A complete access fixture requires an expected group.');
  }
  const groupIds = new Set(input.groups.map(({ id }) => id));
  if (groupIds.size !== input.groups.length) {
    throw new Error('A complete access fixture cannot repeat a group.');
  }
  for (const member of input.members) {
    if (member.accessGroupIds.some((id) => !groupIds.has(id))) {
      throw new Error(
        'An access member fixture references a group outside its snapshot.',
      );
    }
  }

  return database.transaction(async (transaction) => {
    const [latestSnapshot] = await transaction
      .select({
        version: sql<number>`coalesce(max(${accessMembershipSnapshots.version}), 0)::integer`,
      })
      .from(accessMembershipSnapshots);
    const snapshot = Object.freeze({
      id: randomUUID(),
      version: (latestSnapshot?.version ?? 0) + 1,
      capturedAt: input.capturedAt ?? new Date(),
    });
    await transaction.insert(accessMembershipSnapshots).values({
      id: snapshot.id,
      version: snapshot.version,
      complete: true,
      syncStartedAt: snapshot.capturedAt,
      capturedAt: snapshot.capturedAt,
    });
    await transaction.insert(accessMembershipSnapshotGroups).values(
      input.groups.flatMap((group) => [
        {
          snapshotId: snapshot.id,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
          completionKind: 'expected' as const,
        },
        {
          snapshotId: snapshot.id,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
          completionKind: 'completed' as const,
        },
      ]),
    );
    if (input.members.length > 0) {
      await transaction.insert(accessMembershipMembers).values(
        input.members.map((member) => ({
          snapshotId: snapshot.id,
          userId: member.userId,
          googleSubject: member.googleSubject,
          facilityScopeKind: member.facilityScopeKind,
        })),
      );
    }
    const memberGroups = input.members.flatMap((member) =>
      member.accessGroupIds.map((groupSourceId) => ({
        snapshotId: snapshot.id,
        userId: member.userId,
        groupSourceId,
        groupSourceKind: 'google-group' as const,
        groupPurpose: 'access' as const,
      })),
    );
    if (memberGroups.length > 0) {
      await transaction
        .insert(accessMembershipMemberGroups)
        .values(memberGroups);
    }
    const memberFacilities = input.members.flatMap((member) =>
      (member.facilityIds ?? []).map((facilityId) => ({
        snapshotId: snapshot.id,
        userId: member.userId,
        facilityId,
      })),
    );
    if (memberFacilities.length > 0) {
      await transaction
        .insert(accessMembershipMemberFacilities)
        .values(memberFacilities);
    }
    return snapshot;
  });
}

async function nextFreshAccessSnapshotTime(
  database: PostgresDatabaseConnection['db'],
): Promise<Date> {
  const [latest] = await database
    .select({ capturedAt: accessMembershipSnapshots.capturedAt })
    .from(accessMembershipSnapshots)
    .orderBy(
      desc(accessMembershipSnapshots.version),
      desc(accessMembershipSnapshots.capturedAt),
      desc(accessMembershipSnapshots.id),
    )
    .limit(1);
  return new Date(
    Math.max(Date.now(), (latest?.capturedAt.getTime() ?? 0) + 1_000),
  );
}

async function copyLatestAccessSnapshotWithMember(
  database: PostgresDatabaseConnection['db'],
  addedMember: AccessSnapshotMemberFixture,
): Promise<PersistedAccessSnapshotFixture> {
  const [latestSnapshot] = await database
    .select({ id: accessMembershipSnapshots.id })
    .from(accessMembershipSnapshots)
    .where(eq(accessMembershipSnapshots.complete, true))
    .orderBy(
      desc(accessMembershipSnapshots.version),
      desc(accessMembershipSnapshots.capturedAt),
      desc(accessMembershipSnapshots.id),
    )
    .limit(1);
  if (latestSnapshot === undefined) {
    throw new Error('A complete access snapshot is required to copy members.');
  }
  const groupRows = await database
    .select({
      id: accessMembershipSnapshotGroups.groupSourceId,
      kind: accessMembershipSnapshotGroups.groupSourceKind,
      purpose: accessMembershipSnapshotGroups.groupPurpose,
      completionKind: accessMembershipSnapshotGroups.completionKind,
    })
    .from(accessMembershipSnapshotGroups)
    .where(eq(accessMembershipSnapshotGroups.snapshotId, latestSnapshot.id));
  const expectedGroups = groupRows
    .filter(({ completionKind }) => completionKind === 'expected')
    .map(({ id, kind, purpose }) => ({ id, kind, purpose }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const completedIds = groupRows
    .filter(({ completionKind }) => completionKind === 'completed')
    .map(({ id }) => id)
    .sort();
  if (
    expectedGroups.length === 0 ||
    expectedGroups.some(
      ({ kind, purpose }) => kind !== 'google-group' || purpose !== 'access',
    ) ||
    expectedGroups.map(({ id }) => id).join('\n') !== completedIds.join('\n')
  ) {
    throw new Error('The latest access snapshot is not strict and complete.');
  }
  const members = await database
    .select({
      userId: accessMembershipMembers.userId,
      googleSubject: accessMembershipMembers.googleSubject,
      facilityScopeKind: accessMembershipMembers.facilityScopeKind,
    })
    .from(accessMembershipMembers)
    .where(eq(accessMembershipMembers.snapshotId, latestSnapshot.id));
  if (members.some(({ userId }) => userId === addedMember.userId)) {
    throw new Error('The copied access snapshot already contains that member.');
  }
  const memberGroups = await database
    .select({
      userId: accessMembershipMemberGroups.userId,
      groupSourceId: accessMembershipMemberGroups.groupSourceId,
    })
    .from(accessMembershipMemberGroups)
    .where(eq(accessMembershipMemberGroups.snapshotId, latestSnapshot.id));
  const memberFacilities = await database
    .select({
      userId: accessMembershipMemberFacilities.userId,
      facilityId: accessMembershipMemberFacilities.facilityId,
    })
    .from(accessMembershipMemberFacilities)
    .where(eq(accessMembershipMemberFacilities.snapshotId, latestSnapshot.id));

  return persistCompleteAccessSnapshotGeneration(database, {
    groups: expectedGroups.map(({ id }) => ({
      id,
      kind: 'google-group' as const,
      purpose: 'access' as const,
    })),
    members: [
      ...members.map((member) => ({
        ...member,
        accessGroupIds: memberGroups
          .filter(({ userId }) => userId === member.userId)
          .map(({ groupSourceId }) => groupSourceId),
        facilityIds: memberFacilities
          .filter(({ userId }) => userId === member.userId)
          .map(({ facilityId }) => facilityId),
      })),
      addedMember,
    ],
  });
}

async function persistAuthenticatedAdministrator(
  database: PostgresDatabaseConnection['db'],
  authenticated: AuthenticatedSession,
  accessGroupIdsValue: string | readonly string[],
  suffix: string,
): Promise<void> {
  if (authenticated.actor.kind !== 'human') {
    throw new Error('The synthetic administrator must be human.');
  }
  const now = new Date();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  const graceUntil = new Date(now.getTime() + 48 * 60 * 60 * 1_000);
  const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1_000);
  const deviceId = randomUUID();
  const accessGroupIds = Array.isArray(accessGroupIdsValue)
    ? accessGroupIdsValue
    : [accessGroupIdsValue];

  await persistAdministratorIdentity(database, authenticated, suffix, now);
  const activeAccessGroups = await database
    .select({
      id: groupSources.id,
      kind: groupSources.kind,
      purpose: groupSources.purpose,
    })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.kind, 'google-group'),
        eq(groupSources.purpose, 'access'),
        eq(groupSources.active, true),
      ),
    );
  const activeAccessGroupIds = new Set(activeAccessGroups.map(({ id }) => id));
  if (accessGroupIds.some((id) => !activeAccessGroupIds.has(id))) {
    throw new Error(
      'The synthetic administrator must belong to an active access group.',
    );
  }
  const snapshot = await persistCompleteAccessSnapshotGeneration(database, {
    groups: activeAccessGroups.map(({ id }) => ({
      id,
      kind: 'google-group' as const,
      purpose: 'access' as const,
    })),
    members: [
      {
        userId: authenticated.actor.userId,
        googleSubject: `issue-26-admin-subject-${suffix}`,
        facilityScopeKind: 'district',
        accessGroupIds,
      },
    ],
    capturedAt: now,
  });
  await database.insert(deviceEnrollments).values({
    id: deviceId,
    userId: authenticated.actor.userId,
    platform: 'web',
    unlockMethod: 'secure-session-cookie',
    installationId: `issue-26-admin-device-${suffix}`,
    enrolledAt: now,
    lastSeenAt: now,
  });
  await database.insert(sessions).values({
    id: authenticated.actor.sessionId,
    userId: authenticated.actor.userId,
    deviceEnrollmentId: deviceId,
    membershipSnapshotId: snapshot.id,
    membershipValidUntil: validUntil,
    membershipGraceUntil: graceUntil,
    createdAt: now,
    expiresAt,
  });
}

async function persistAdministratorIdentity(
  database: PostgresDatabaseConnection['db'],
  authenticated: AuthenticatedSession,
  suffix: string,
  createdAt = new Date(),
): Promise<void> {
  await database
    .insert(users)
    .values({
      id: authenticated.actor.userId,
      googleSubject: `issue-26-admin-subject-${suffix}`,
      email: `issue-26-admin-${suffix}@psd401.net`,
      displayName: `Issue 26 synthetic administrator ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt,
    })
    .onConflictDoNothing();
  await database
    .insert(userRoles)
    .values({
      userId: authenticated.actor.userId,
      role: 'admin',
    })
    .onConflictDoNothing();
}

async function persistLiveAuthorizationActor(
  database: PostgresDatabaseConnection['db'],
  authenticated: AuthenticatedSession,
  label: string,
): Promise<void> {
  if (authenticated.actor.kind !== 'human') {
    throw new Error('A live authorization actor must be human.');
  }
  let [membershipSnapshot] = await database
    .select({ id: accessMembershipSnapshots.id })
    .from(accessMembershipSnapshots)
    .orderBy(desc(accessMembershipSnapshots.version))
    .limit(1);
  if (membershipSnapshot === undefined) {
    throw new Error('A membership snapshot is required for a live session.');
  }
  const [existingUser] = await database
    .select({ id: users.id, googleSubject: users.googleSubject })
    .from(users)
    .where(eq(users.id, authenticated.actor.userId))
    .limit(1);
  if (existingUser === undefined) {
    const googleSubject = `issue-26-live-${label}-${authenticated.actor.userId}`;
    await database.insert(users).values({
      id: authenticated.actor.userId,
      googleSubject,
      email: `issue-26-live-${label}-${authenticated.actor.userId}@psd401.net`,
      displayName: `Issue 26 live authorization ${label}`,
      facilityScopeKind: 'district',
    });
    await database.insert(userRoles).values({
      userId: authenticated.actor.userId,
      role: 'admin',
    });
    const expectedGroups = await database
      .select({ id: accessMembershipSnapshotGroups.groupSourceId })
      .from(accessMembershipSnapshotGroups)
      .where(
        and(
          eq(accessMembershipSnapshotGroups.snapshotId, membershipSnapshot.id),
          eq(accessMembershipSnapshotGroups.completionKind, 'expected'),
        ),
      );
    const copiedSnapshot = await copyLatestAccessSnapshotWithMember(database, {
      userId: authenticated.actor.userId,
      googleSubject,
      facilityScopeKind: 'district',
      accessGroupIds: expectedGroups.map(({ id }) => id),
    });
    membershipSnapshot = { id: copiedSnapshot.id };
  }
  const now = new Date();
  const deviceId = randomUUID();
  await database.insert(deviceEnrollments).values({
    id: deviceId,
    userId: authenticated.actor.userId,
    platform: 'web',
    unlockMethod: 'secure-session-cookie',
    installationId: `issue-26-live-${label}-${randomUUID()}`,
    enrolledAt: now,
    lastSeenAt: now,
  });
  await database.insert(sessions).values({
    id: authenticated.actor.sessionId,
    userId: authenticated.actor.userId,
    deviceEnrollmentId: deviceId,
    membershipSnapshotId: membershipSnapshot.id,
    membershipValidUntil: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    membershipGraceUntil: new Date(now.getTime() + 48 * 60 * 60 * 1_000),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1_000),
  });
}

function withDeadline<Result>(
  operation: Promise<Result>,
  milliseconds = 10_000,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('The PostgreSQL regression timed out.')),
      milliseconds,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function assumeApplicationRole(
  connectionToScope: PostgresDatabaseConnection,
): Promise<void> {
  await connectionToScope.db.execute(sql`set role psd_eoc_app`);
  const rows = databaseExecuteRows<{
    current_user: string;
    can_update_integration_statuses: boolean;
  }>(
    await connectionToScope.db.execute<{
      current_user: string;
      can_update_integration_statuses: boolean;
    }>(sql`
      select
        current_user::text as current_user,
        has_table_privilege(
          current_user,
          'public.integration_statuses',
          'UPDATE'
        ) as can_update_integration_statuses
    `),
  );
  expect(rows).toEqual([
    {
      current_user: 'psd_eoc_app',
      can_update_integration_statuses: false,
    },
  ]);
}

async function waitForAdvisoryWaiters(
  database: PostgresDatabaseConnection['db'],
  minimum: number,
  blockerPid?: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await database.execute<{ waiting: number }>(
      blockerPid === undefined
        ? sql`
            select count(*)::int as waiting
            from pg_locks
            where locktype = 'advisory'
              and granted = false
          `
        : sql`
            select count(distinct waiter.pid)::int as waiting
            from pg_locks as blocker
            inner join pg_locks as waiter
              on waiter.locktype = blocker.locktype
              and waiter.database is not distinct from blocker.database
              and waiter.classid is not distinct from blocker.classid
              and waiter.objid is not distinct from blocker.objid
              and waiter.objsubid is not distinct from blocker.objsubid
            where blocker.pid = ${blockerPid}
              and blocker.locktype = 'advisory'
              and blocker.granted = true
              and waiter.granted = false
          `,
    );
    if ((row?.waiting ?? 0) >= minimum) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${minimum} queued advisory-lock operations.`,
  );
}

async function waitForBackendBlockedBy(
  database: PostgresDatabaseConnection['db'],
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = databaseExecuteRows<{ waiting: number }>(
      await database.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where ${blockerPid} = any(pg_blocking_pids(pid))
      `),
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the roster projection table lock.');
}

describeWithDatabase('facilities administrator database flow', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      databaseCreated = true;
      connection = openPostgresConnection(context.databaseUrl, 6);
      await migrateDatabase(connection);
      await seedDatabase(connection.db);
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Facilities setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
  });

  test('removes the marker-owned database when the creator connection close rejects', async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const rejectedContext = buildContext(baseTestDatabaseUrl);
    const closeError = new Error(
      'Synthetic facilities database creator close rejection.',
    );
    let rejectedAdmin: PostgresDatabaseConnection | undefined;
    let proofError: unknown;
    let proofFailed = false;
    try {
      let observedError: unknown;
      try {
        await createOwnedDatabase(rejectedContext, (admin) => {
          rejectedAdmin = admin;
          return Promise.reject(closeError);
        });
      } catch (error) {
        observedError = error;
      }
      expect(observedError).toBe(closeError);

      const verifier = openPostgresConnection(
        rejectedContext.baseDatabaseUrl,
        1,
      );
      const verifierErrors: unknown[] = [];
      try {
        expect(
          await readDatabaseMarker(verifier, rejectedContext.databaseName),
        ).toBeUndefined();
      } catch (error) {
        verifierErrors.push(error);
      }
      try {
        await verifier.close();
      } catch (error) {
        verifierErrors.push(error);
      }
      if (verifierErrors.length === 1) throw verifierErrors[0];
      if (verifierErrors.length > 1) {
        throw new AggregateError(
          verifierErrors,
          'Facilities close-rejection verification and observer close both failed.',
        );
      }
    } catch (error) {
      proofFailed = true;
      proofError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (rejectedAdmin !== undefined) {
      try {
        await rejectedAdmin.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await dropOwnedDatabase(rejectedContext);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (proofFailed && cleanupErrors.length > 0) {
      throw new AggregateError(
        [proofError, ...cleanupErrors],
        'Synthetic facilities close-rejection proof and cleanup both failed.',
      );
    }
    if (proofFailed) throw proofError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Synthetic facilities close-rejection proof cleanup failed.',
      );
    }
  });

  test('retries exact marker proof before rolling back after the initial marker read fails', async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const rejectedContext = buildContext(baseTestDatabaseUrl);
    const markerReadError = new Error(
      'Synthetic facilities initial marker read failure.',
    );
    const errors: unknown[] = [];
    try {
      await expect(
        createOwnedDatabase(rejectedContext, undefined, () =>
          Promise.reject(markerReadError),
        ),
      ).rejects.toBe(markerReadError);

      const verifier = openPostgresConnection(
        rejectedContext.baseDatabaseUrl,
        1,
      );
      await executeOperationWithCleanup({
        operation: async () => {
          expect(
            await readDatabaseMarker(verifier, rejectedContext.databaseName),
          ).toBeUndefined();
        },
        cleanup: () => verifier.close(),
        failureMessage:
          'Facilities transient-marker verification and observer close both failed.',
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      await dropOwnedDatabase(rejectedContext);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Facilities transient-marker proof and cleanup both failed.',
      );
    }
  });

  test('completes integration health with one app-role PostgreSQL connection and no added status-update privilege', async () => {
    const currentContext = context;
    if (currentContext === undefined) {
      throw new Error('The facilities test context is not available.');
    }
    const dedicated = openPostgresConnection(currentContext.databaseUrl, 1);
    try {
      await assumeApplicationRole(dedicated);
      const authenticated = authenticatedAdministrator();
      const store = createDrizzleAdminCapabilityStore(
        dedicated.db,
        authenticated,
      );
      const requestId = randomUUID();
      const projection = await withDeadline(
        executeIntegrationHealthProjection({
          authenticated,
          store,
          query: { integrationId: 'expo-push' },
          metadata: { requestId, now: new Date() },
        }),
      );

      expect(projection.health.statuses).toHaveLength(1);
      expect(projection.health.statuses[0]?.integrationId).toBe('expo-push');
      expect(
        await dedicated.db
          .select({ requestId: securityAuditEntries.requestId })
          .from(securityAuditEntries)
          .where(eq(securityAuditEntries.requestId, requestId)),
      ).toEqual([{ requestId }]);
    } finally {
      await dedicated.close();
    }
  });

  test('completes roster health with one app-role PostgreSQL connection and no nested transaction', async () => {
    const currentContext = context;
    if (currentContext === undefined) {
      throw new Error('The facilities test context is not available.');
    }
    const dedicated = openPostgresConnection(currentContext.databaseUrl, 1);
    try {
      await assumeApplicationRole(dedicated);
      const authenticated = authenticatedAdministrator();
      const requestId = randomUUID();
      const projection = await withDeadline(
        executeRosterHealthProjection({
          authenticated,
          store: createDrizzleAdminCapabilityStore(dedicated.db, authenticated),
          query: {
            population: 'staff',
            facilityId: null,
            cursor: null,
            limit: 25,
          },
          metadata: { requestId, now: new Date() },
        }),
      );

      expect(projection.report.generatedAt).toBeString();
      expect(
        await dedicated.db
          .select({
            requestId: securityAuditEntries.requestId,
            category: securityAuditEntries.category,
            outcome: securityAuditEntries.outcome,
          })
          .from(securityAuditEntries)
          .where(eq(securityAuditEntries.requestId, requestId)),
      ).toEqual([
        { requestId, category: 'capability-execution', outcome: 'success' },
      ]);
    } finally {
      await dedicated.close();
    }
  });

  test('keeps roster evidence and last-sync truth on one repeatable-read snapshot', async () => {
    const currentContext = context;
    if (currentContext === undefined) {
      throw new Error('The facilities test context is not available.');
    }
    const writer = openPostgresConnection(currentContext.databaseUrl, 1);
    const observer = openPostgresConnection(currentContext.databaseUrl, 1);
    const projectionConnection = openPostgresConnection(
      currentContext.databaseUrl,
      2,
    );
    const configurationId = randomUUID();
    const syncResultId = randomUUID();
    const requestId = randomUUID();
    let releaseWriter: (() => void) | undefined;
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let reportWriterReady: (() => void) | undefined;
    const writerReady = new Promise<void>((resolve) => {
      reportWriterReady = resolve;
    });
    let writerExecution: Promise<void> | undefined;
    let projectionExecution:
      | ReturnType<typeof executeRosterHealthProjection>
      | undefined;

    try {
      const [baseline] = await observer.db
        .select({
          id: rosterSyncResults.id,
          population: rosterSyncResults.population,
          outcome: rosterSyncResults.outcome,
          completedAt: rosterSyncResults.completedAt,
        })
        .from(rosterSyncResults)
        .where(eq(rosterSyncResults.population, 'staff'))
        .orderBy(
          desc(rosterSyncResults.completedAt),
          desc(rosterSyncResults.id),
        )
        .limit(1);
      const baselineProjection =
        baseline === undefined
          ? null
          : {
              population: baseline.population,
              outcome: baseline.outcome,
              completedAt: baseline.completedAt.toISOString(),
            };
      const completedAt = new Date(
        Math.max(
          Date.now(),
          (baseline?.completedAt.getTime() ?? Date.now()) + 60_000,
        ),
      );
      const startedAt = new Date(completedAt.getTime() - 1_000);
      await writer.db.insert(rosterSourceConfigurations).values({
        id: configurationId,
        version: 1,
        population: 'staff',
        createdAt: startedAt,
      });

      let blockerPid: number | undefined;
      writerExecution = Promise.resolve(
        writer.db.transaction(async (transaction) => {
          const rows = databaseExecuteRows<{ pid: number }>(
            await transaction.execute<{ pid: number }>(
              sql`select pg_backend_pid()::int as pid`,
            ),
          );
          blockerPid = rows[0]?.pid;
          if (blockerPid === undefined) {
            throw new Error('The roster-sync writer has no backend PID.');
          }
          await transaction.execute(sql`
            lock table public.roster_sync_results in access exclusive mode
          `);
          await transaction.insert(rosterSyncResults).values({
            id: syncResultId,
            sourceConfigurationId: configurationId,
            sourceConfigurationVersion: 1,
            population: 'staff',
            outcome: 'failed',
            startedAt,
            completedAt,
            expectedSourceCount: 1,
            completedSourceCount: 0,
            groupFailureCount: 0,
            publishedSnapshotId: null,
          });
          reportWriterReady?.();
          await writerRelease;
        }),
      );
      await withDeadline(writerReady);
      if (blockerPid === undefined) {
        throw new Error('The roster-sync writer PID was not captured.');
      }

      await assumeApplicationRole(projectionConnection);
      const authenticated = authenticatedAdministrator();
      projectionExecution = executeRosterHealthProjection({
        authenticated,
        store: createDrizzleAdminCapabilityStore(
          projectionConnection.db,
          authenticated,
        ),
        query: {
          population: 'staff',
          facilityId: null,
          cursor: null,
          limit: 25,
        },
        metadata: { requestId, now: new Date() },
      });
      await waitForBackendBlockedBy(observer.db, blockerPid);
      releaseWriter?.();

      const [, projection] = await withDeadline(
        Promise.all([writerExecution, projectionExecution]),
      );
      expect(projection.lastSync).toEqual(baselineProjection);
      const [newest] = await observer.db
        .select({ id: rosterSyncResults.id })
        .from(rosterSyncResults)
        .where(eq(rosterSyncResults.population, 'staff'))
        .orderBy(
          desc(rosterSyncResults.completedAt),
          desc(rosterSyncResults.id),
        )
        .limit(1);
      expect(newest?.id).toBe(syncResultId);
      expect(
        await observer.db
          .select({ requestId: securityAuditEntries.requestId })
          .from(securityAuditEntries)
          .where(eq(securityAuditEntries.requestId, requestId)),
      ).toEqual([{ requestId }]);
    } finally {
      releaseWriter?.();
      const pending: Promise<unknown>[] = [];
      if (writerExecution !== undefined) pending.push(writerExecution);
      if (projectionExecution !== undefined) pending.push(projectionExecution);
      try {
        if (pending.length > 0) {
          await withDeadline(Promise.allSettled(pending));
        }
      } finally {
        await Promise.all([
          writer.close(),
          observer.close(),
          projectionConnection.close(),
        ]);
      }
    }
  });

  test('appends health audit from a fresh transaction after a concurrent writer advances the chain', async () => {
    const currentContext = context;
    if (currentContext === undefined) {
      throw new Error('The facilities test context is not available.');
    }
    const blocker = openPostgresConnection(currentContext.databaseUrl, 1);
    const observer = openPostgresConnection(currentContext.databaseUrl, 1);
    const writer = openPostgresConnection(currentContext.databaseUrl, 1);
    const health = openPostgresConnection(currentContext.databaseUrl, 1);
    let releaseAuditLock: (() => void) | undefined;
    const auditLockReleased = new Promise<void>((resolve) => {
      releaseAuditLock = resolve;
    });
    let confirmAuditLock: (() => void) | undefined;
    const auditLockHeld = new Promise<void>((resolve) => {
      confirmAuditLock = resolve;
    });
    let blockerPid: number | undefined;
    const blockerExecution = blocker.db.transaction(async (transaction) => {
      const rows = databaseExecuteRows<{ pid: number }>(
        await transaction.execute<{ pid: number }>(
          sql`select pg_backend_pid()::int as pid`,
        ),
      );
      blockerPid = rows[0]?.pid;
      if (blockerPid === undefined) {
        throw new Error('The audit-lock blocker has no backend PID.');
      }
      await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
      confirmAuditLock?.();
      await auditLockReleased;
    });
    let writerExecution: Promise<unknown> | undefined;
    let healthExecution: Promise<unknown> | undefined;

    try {
      await withDeadline(auditLockHeld);
      await Promise.all([
        assumeApplicationRole(writer),
        assumeApplicationRole(health),
      ]);
      const writerAuthenticated = authenticatedAdministrator();
      const healthAuthenticated = authenticatedAdministrator();
      const writerRequestId = randomUUID();
      const healthRequestId = randomUUID();
      writerExecution = executeListFacilitiesCapability({
        authenticated: writerAuthenticated,
        store: createDrizzleAdminCapabilityStore(
          writer.db,
          writerAuthenticated,
        ),
        query: { includeInactive: true, cursor: null, limit: 1 },
        metadata: { requestId: writerRequestId, now: new Date() },
      });
      await waitForAdvisoryWaiters(observer.db, 1, blockerPid);

      healthExecution = executeIntegrationHealthProjection({
        authenticated: healthAuthenticated,
        store: createDrizzleAdminCapabilityStore(
          health.db,
          healthAuthenticated,
        ),
        query: { integrationId: 'expo-push' },
        metadata: { requestId: healthRequestId, now: new Date() },
      });
      // Two queued writers proves health's read-only snapshot has committed;
      // the unrelated writer remains ahead of its separate audit transaction.
      await waitForAdvisoryWaiters(observer.db, 2, blockerPid);
      releaseAuditLock?.();
      const [, writerResult, healthResult] = await withDeadline(
        Promise.all([blockerExecution, writerExecution, healthExecution]),
      );
      expect(writerResult).toBeDefined();
      expect(healthResult).toBeDefined();

      const audits = await observer.db
        .select({
          requestId: securityAuditEntries.requestId,
          sequence: securityAuditEntries.sequence,
        })
        .from(securityAuditEntries)
        .where(
          inArray(securityAuditEntries.requestId, [
            writerRequestId,
            healthRequestId,
          ]),
        )
        .orderBy(securityAuditEntries.sequence);
      expect(audits.map(({ requestId }) => requestId)).toEqual([
        writerRequestId,
        healthRequestId,
      ]);
      const [head] = await observer.db
        .select({
          sequence: securityAuditEntries.sequence,
          entryHash: securityAuditEntries.entryHash,
        })
        .from(securityAuditEntries)
        .orderBy(desc(securityAuditEntries.sequence))
        .limit(1);
      const [anchor] = await observer.db
        .select({
          sequence: securityAuditChainAnchors.sequence,
          entryHash: securityAuditChainAnchors.entryHash,
        })
        .from(securityAuditChainAnchors)
        .orderBy(desc(securityAuditChainAnchors.sequence))
        .limit(1);
      expect(anchor).toEqual(head);
    } finally {
      releaseAuditLock?.();
      try {
        await withDeadline(
          Promise.allSettled(
            [blockerExecution, writerExecution, healthExecution].filter(
              (operation): operation is Promise<unknown> =>
                operation !== undefined,
            ),
          ),
        );
      } finally {
        await Promise.all([
          blocker.close(),
          observer.close(),
          writer.close(),
          health.close(),
        ]);
      }
    }
  });

  test('executes every owned row-lock capability through the production application role', async () => {
    const currentContext = context;
    if (currentContext === undefined) {
      throw new Error('The facilities test context is not available.');
    }
    await withIsolatedFacilitiesDatabase(
      currentContext.baseDatabaseUrl,
      async (isolatedContext, ownerConnection) => {
        const ownerDatabase = ownerConnection.db;
        const authenticated = authenticatedAdministrator();
        const suffix = randomUUID();
        const requestIds: string[] = [];
        const accessGroupId = randomUUID();
        await ownerDatabase.insert(groupSources).values({
          id: accessGroupId,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: 'admin',
          displayName: `Application role access ${suffix.slice(0, 8)}`,
          active: true,
          googleGroupId: `app-role-access-${suffix}`,
          email: `app-role-access-${suffix}@example.invalid`,
          fixtureKey: null,
        });
        await persistAuthenticatedAdministrator(
          ownerDatabase,
          authenticated,
          accessGroupId,
          suffix,
        );
        if (authenticated.actor.kind !== 'human') {
          throw new Error('The app-role lock proof requires a human actor.');
        }
        const integrationId = `synthetic-app-role-${suffix}`;
        const integrationStatusId = randomUUID();
        const issuedAt = new Date(Date.now() - 1_000);
        const authorization = liveAuthorizationFor({
          authenticated,
          integrationId,
          integrationStatusId,
          previousConfiguration: null,
          issuedAt,
        });
        await ownerDatabase.insert(integrationStatuses).values({
          id: integrationStatusId,
          integrationId,
          label: 'live-verified',
          verifiedAt: issuedAt,
          verifiedByUserId: authenticated.actor.userId,
          authorizationReference:
            liveChannelChangeAuthorizationCommitment(authorization),
          reasonCode: null,
          observedAt: issuedAt,
        });

        const dedicated = openPostgresConnection(
          isolatedContext.databaseUrl,
          1,
        );
        try {
          await assumeApplicationRole(dedicated);
          const store = createDrizzleAdminCapabilityStore(
            dedicated.db,
            authenticated,
          );
          const facility = await executeCreateFacilityCapability({
            authenticated,
            store,
            command: {
              code: `ROLE-${suffix.slice(0, 8).toUpperCase()}`,
              name: `Application role facility ${suffix.slice(0, 8)}`,
            },
            metadata: metadata('app-role-facility-create', requestIds),
          });
          const googleBuilding = await executeCreateGroupSourceCapability({
            authenticated,
            store,
            command: {
              kind: 'google-group',
              purpose: 'building',
              facilityId: facility.id,
              displayName: `Application role staff ${suffix.slice(0, 8)}`,
              active: true,
              googleGroupId: `app-role-building-${suffix}`,
              email: `app-role-building-${suffix}@example.invalid`,
            },
            metadata: metadata('app-role-google-building', requestIds),
          });
          const syntheticBuilding = await executeCreateGroupSourceCapability({
            authenticated,
            store,
            command: {
              kind: 'synthetic',
              purpose: 'building',
              facilityId: facility.id,
              displayName: `Application role test staff ${suffix.slice(0, 8)}`,
              active: true,
              fixtureKey: `app-role-building-${suffix}`,
            },
            metadata: metadata('app-role-synthetic-building', requestIds),
          });
          const googleOthers = await executeCreateGroupSourceCapability({
            authenticated,
            store,
            command: {
              kind: 'google-group',
              purpose: 'others',
              facilityId: null,
              displayName: `Application role responders ${suffix.slice(0, 8)}`,
              active: true,
              googleGroupId: `app-role-others-${suffix}`,
              email: `app-role-others-${suffix}@example.invalid`,
            },
            metadata: metadata('app-role-google-others', requestIds),
          });
          const syntheticOthers = await executeCreateGroupSourceCapability({
            authenticated,
            store,
            command: {
              kind: 'synthetic',
              purpose: 'others',
              facilityId: null,
              displayName: `Application role test responders ${suffix.slice(0, 8)}`,
              active: true,
              fixtureKey: `app-role-others-${suffix}`,
            },
            metadata: metadata('app-role-synthetic-others', requestIds),
          });

          expect(
            await executeUpdateFacilityCapability({
              authenticated,
              store,
              command: {
                facilityId: facility.id,
                code: facility.code,
                name: `${facility.name} revised`,
                active: true,
              },
              metadata: metadata('app-role-facility-update', requestIds),
            }),
          ).toMatchObject({ id: facility.id, active: true });

          for (const replacement of [
            {
              source: googleBuilding,
              command: {
                id: googleBuilding.id,
                kind: 'google-group' as const,
                purpose: 'building' as const,
                facilityId: facility.id,
                displayName: `${googleBuilding.displayName} replacement`,
                active: true,
                googleGroupId: `app-role-building-replacement-${suffix}`,
                email: `app-role-building-replacement-${suffix}@example.invalid`,
              },
              label: 'app-role-google-building-replacement',
            },
            {
              source: syntheticBuilding,
              command: {
                id: syntheticBuilding.id,
                kind: 'synthetic' as const,
                purpose: 'building' as const,
                facilityId: facility.id,
                displayName: `${syntheticBuilding.displayName} replacement`,
                active: true,
                fixtureKey: `app-role-building-replacement-${suffix}`,
              },
              label: 'app-role-synthetic-building-replacement',
            },
            {
              source: googleOthers,
              command: {
                id: googleOthers.id,
                kind: 'google-group' as const,
                purpose: 'others' as const,
                facilityId: null,
                displayName: `${googleOthers.displayName} replacement`,
                active: true,
                googleGroupId: `app-role-others-replacement-${suffix}`,
                email: `app-role-others-replacement-${suffix}@example.invalid`,
              },
              label: 'app-role-google-others-replacement',
            },
            {
              source: syntheticOthers,
              command: {
                id: syntheticOthers.id,
                kind: 'synthetic' as const,
                purpose: 'others' as const,
                facilityId: null,
                displayName: `${syntheticOthers.displayName} replacement`,
                active: true,
                fixtureKey: `app-role-others-replacement-${suffix}`,
              },
              label: 'app-role-synthetic-others-replacement',
            },
          ] as const) {
            const replaced = await executeUpdateGroupSourceCapability({
              authenticated,
              store,
              command: replacement.command,
              metadata: metadata(replacement.label, requestIds),
            });
            expect(replaced.id).not.toBe(replacement.source.id);
            expect(replaced.active).toBe(true);
          }

          const neighborhood = await executeCreateNeighborhoodVersionCapability(
            {
              authenticated,
              store,
              command: {
                neighborhoodId: null,
                name: `Application role neighborhood ${suffix.slice(0, 8)}`,
                facilityIds: [facility.id],
              },
              metadata: metadata('app-role-neighborhood-first', requestIds),
            },
          );
          expect(
            await executeCreateNeighborhoodVersionCapability({
              authenticated,
              store,
              command: {
                neighborhoodId: neighborhood.id,
                name: `${neighborhood.name} revised`,
                facilityIds: [facility.id],
              },
              metadata: metadata('app-role-neighborhood-next', requestIds),
            }),
          ).toMatchObject({ id: neighborhood.id, version: 2 });

          const audience = await executeCreateAudienceConfigVersionCapability({
            authenticated,
            store,
            command: {
              audienceConfigId: null,
              facilityId: facility.id,
              targets: [{ kind: 'building', facilityId: facility.id }],
            },
            metadata: metadata('app-role-audience-first', requestIds),
          });
          expect(
            await executeCreateAudienceConfigVersionCapability({
              authenticated,
              store,
              command: {
                audienceConfigId: audience.id,
                facilityId: facility.id,
                targets: [{ kind: 'building', facilityId: facility.id }],
              },
              metadata: metadata('app-role-audience-next', requestIds),
            }),
          ).toMatchObject({ id: audience.id, version: 2 });

          expect(
            await executeSetChannelEnabledCapability({
              authenticated,
              store,
              command: {
                integrationId,
                enabled: true,
                authorization,
              },
              metadata: metadata('app-role-live-channel', requestIds),
            }),
          ).toMatchObject({
            integrationId,
            enabled: true,
            status: { integrationId, label: 'live-verified' },
          });

          const audits = await dedicated.db
            .select({
              outcome: securityAuditEntries.outcome,
              requestId: securityAuditEntries.requestId,
            })
            .from(securityAuditEntries)
            .where(inArray(securityAuditEntries.requestId, requestIds));
          expect(audits).toHaveLength(requestIds.length);
          expect(audits.map(({ requestId }) => requestId).sort()).toEqual(
            [...requestIds].sort(),
          );
          expect(audits.every(({ outcome }) => outcome === 'success')).toBe(
            true,
          );
        } finally {
          await dedicated.close();
        }
      },
    );
  });

  test('configures access groups freely before the first snapshot exists', async () => {
    // First-run setup. With no published generation there is no access to
    // lose, so an administrator can add, rename, add again, and withdraw
    // without proving anything. Every one of these steps used to be a 409:
    // the old rules required the published snapshot to already agree with the
    // active set, which is impossible before a snapshot exists.
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    await persistAdministratorIdentity(database, authenticated, suffix);

    const firstGroup = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `First access group ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-first-access-${suffix}`,
        email: `issue-26-first-access-${suffix}@example.invalid`,
      },
      metadata: metadata('first-access-create', requestIds),
    });
    if (firstGroup.kind !== 'google-group' || firstGroup.purpose !== 'access') {
      throw new Error('The first access-group fixture lost its variant.');
    }
    expect(firstGroup.grantedRole).toBe('admin');

    const renamed = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: firstGroup.id,
        kind: firstGroup.kind,
        purpose: firstGroup.purpose,
        facilityId: firstGroup.facilityId,
        grantedRole: 'admin',
        displayName: `${firstGroup.displayName} changed`,
        active: firstGroup.active,
        googleGroupId: firstGroup.googleGroupId,
        email: firstGroup.email,
      },
      metadata: metadata('first-access-display-change', requestIds),
    });
    expect(renamed.displayName).toBe(`${firstGroup.displayName} changed`);

    const secondGroup = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'staff',
        displayName: `Second access group ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-second-access-${suffix}`,
        email: `issue-26-second-access-${suffix}@example.invalid`,
      },
      metadata: metadata('second-access-create', requestIds),
    });
    expect(secondGroup.purpose).toBe('access');

    // Withdrawing one of two is allowed. Withdrawing the last one is too,
    // because nothing has ever been published for it to end.
    for (const [index, group] of [firstGroup, secondGroup].entries()) {
      if (group.kind !== 'google-group' || group.purpose !== 'access') {
        throw new Error('An access-group fixture lost its variant.');
      }
      const withdrawn = await executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: group.id,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: index === 0 ? 'admin' : 'staff',
          displayName:
            group.id === firstGroup.id
              ? renamed.displayName
              : group.displayName,
          active: false,
          googleGroupId: group.googleGroupId,
          email: group.email,
        },
        metadata: metadata(`access-withdraw-${index}`, requestIds),
      });
      expect(withdrawn.active).toBe(false);
    }

    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(
          and(
            eq(groupSources.kind, 'google-group'),
            eq(groupSources.purpose, 'access'),
            eq(groupSources.active, true),
          ),
        ),
    ).toEqual([]);
  });

  test('serializes concurrent access-group deactivation without a row-lock deadlock', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    const accessFixtures = [
      {
        id: randomUUID(),
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `Concurrent access A ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-race-a-${suffix}`,
        email: `issue-26-access-race-a-${suffix}@example.invalid`,
        fixtureKey: null,
      },
      {
        id: randomUUID(),
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `Concurrent access B ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-race-b-${suffix}`,
        email: `issue-26-access-race-b-${suffix}@example.invalid`,
        fixtureKey: null,
      },
    ] as const;
    await database.insert(groupSources).values([...accessFixtures]);
    await persistAuthenticatedAdministrator(
      database,
      authenticated,
      accessFixtures[0].id,
      suffix,
    );

    let releaseActiveSetLock: (() => void) | undefined;
    const activeSetLockReleased = new Promise<void>((resolve) => {
      releaseActiveSetLock = resolve;
    });
    let confirmActiveSetLock: (() => void) | undefined;
    const activeSetLockHeld = new Promise<void>((resolve) => {
      confirmActiveSetLock = resolve;
    });
    const activeSetBlocker = database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-admin-availability', 0))`,
      );
      confirmActiveSetLock?.();
      await activeSetLockReleased;
    });
    await activeSetLockHeld;

    const deactivations = accessFixtures.map((source, index) => {
      return executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: source.id,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: 'admin',
          displayName: source.displayName,
          active: false,
          googleGroupId: source.googleGroupId,
          email: source.email,
        },
        metadata: metadata(`access-race-disable-${index}`, requestIds),
      });
    });
    try {
      await waitForAdvisoryWaiters(database, 2);
    } finally {
      releaseActiveSetLock?.();
      await activeSetBlocker;
    }

    const results = await Promise.allSettled(deactivations);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.filter(({ status }) => status === 'rejected');
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status !== 'rejected') {
      throw new Error('The concurrent access-group loser is missing.');
    }
    expect(rejected[0].reason).toBeInstanceOf(AdminCapabilityError);
    expect((rejected[0].reason as AdminCapabilityError).status).toBe(409);

    const sourceRows = await database
      .select()
      .from(groupSources)
      .where(
        inArray(
          groupSources.id,
          accessFixtures.map(({ id }) => id),
        ),
      );
    expect(sourceRows.filter(({ active }) => active)).toHaveLength(1);
    const inactiveSource = sourceRows.find(({ active }) => !active);
    if (inactiveSource === undefined) {
      throw new Error('The deactivated concurrent source is missing.');
    }
    const inactiveFixture = accessFixtures.find(
      ({ id }) => id === inactiveSource.id,
    );
    if (inactiveFixture === undefined) {
      throw new Error('The deactivated access fixture is missing.');
    }
    const restored = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: inactiveFixture.id,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: inactiveFixture.displayName,
        active: true,
        googleGroupId: inactiveFixture.googleGroupId,
        email: inactiveFixture.email,
      },
      metadata: metadata('access-race-restore', requestIds),
    });
    expect(restored.active).toBe(true);
    expect(
      (await loadAccessConfigurationSnapshotState(database))
        ?.activeAccessGroupSourceIds,
    ).toEqual(accessFixtures.map(({ id }) => id).sort());
  });

  test('reserves staged recovery deactivation for the protected mobile-session finalizer', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    const recoverySource = {
      id: randomUUID(),
      kind: 'google-group' as const,
      purpose: 'access' as const,
      facilityId: null,
      grantedRole: 'admin' as const,
      displayName: `Protected recovery ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-236-protected-recovery-${suffix}`,
      email: `issue-236-protected-recovery-${suffix}@example.invalid`,
      fixtureKey: null,
    };
    const designatedSource = {
      id: randomUUID(),
      kind: 'google-group' as const,
      purpose: 'access' as const,
      facilityId: null,
      grantedRole: 'admin' as const,
      displayName: `Protected designated ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-236-protected-designated-${suffix}`,
      email: DESIGNATED_ACCESS_GROUP_EMAIL,
      fixtureKey: null,
    };
    await database
      .update(groupSources)
      .set({ active: false })
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      );
    await database
      .insert(groupSources)
      .values([recoverySource, designatedSource]);
    await persistAuthenticatedAdministrator(
      database,
      authenticated,
      recoverySource.id,
      suffix,
    );

    const designatedUserId = randomUUID();
    const designatedSubject = `issue-236-designated-subject-${suffix}`;
    await database.insert(users).values({
      id: designatedUserId,
      googleSubject: designatedSubject,
      email: `issue-236-designated-${suffix}@example.invalid`,
      displayName: 'Issue 236 designated administrator',
      facilityScopeKind: 'district',
    });
    await database.insert(userRoles).values({
      userId: designatedUserId,
      role: 'admin',
    });
    const transitionSnapshot = await copyLatestAccessSnapshotWithMember(
      database,
      {
        userId: designatedUserId,
        googleSubject: designatedSubject,
        facilityScopeKind: 'district',
        accessGroupIds: [designatedSource.id],
      },
    );
    const accessState = await loadAccessConfigurationSnapshotState(database);
    if (accessState === null) {
      throw new Error('The protected two-source fixture is not strict.');
    }
    expect(accessState.snapshotId).toBe(transitionSnapshot.id);
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState,
        eligibleAccessGroupSourceIds: [designatedSource.id],
      }),
    ).toEqual([designatedUserId]);

    const recoveryDeactivationCommand = {
      id: recoverySource.id,
      kind: recoverySource.kind,
      purpose: recoverySource.purpose,
      facilityId: recoverySource.facilityId,
      grantedRole: 'admin',
      displayName: recoverySource.displayName,
      active: false,
      googleGroupId: recoverySource.googleGroupId,
      email: recoverySource.email,
    } as const;
    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: recoveryDeactivationCommand,
        metadata: metadata('protected-recovery-deactivation', requestIds),
      }),
    ).resolves.toMatchObject({ active: false });
    // Deactivating an access group is an ordinary administrative change now.
    // The only rule is that an administrator must stay reachable through a
    // group that remains active, which the other source here satisfies.
    expect(
      await database
        .select({ id: groupSources.id, active: groupSources.active })
        .from(groupSources)
        .where(
          inArray(groupSources.id, [recoverySource.id, designatedSource.id]),
        )
        .orderBy(asc(groupSources.id)),
    ).toEqual(
      [recoverySource.id, designatedSource.id]
        .sort()
        .map((id) => ({ id, active: id !== recoverySource.id })),
    );

    const throwawaySource = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `Throwaway access ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-236-throwaway-${suffix}`,
        email: `issue-236-throwaway-${suffix}@example.invalid`,
      },
      metadata: metadata('protected-recovery-add-third', requestIds),
    });
    if (
      throwawaySource.kind !== 'google-group' ||
      throwawaySource.purpose !== 'access'
    ) {
      throw new Error('The throwaway access source lost its variant.');
    }
    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();

    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: recoveryDeactivationCommand,
        metadata: metadata(
          'protected-recovery-deactivation-after-third',
          requestIds,
        ),
      }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'Recovery access can be deactivated only by the protected mobile-session finalizer.',
    });
    expect(
      await database
        .select({ id: groupSources.id, active: groupSources.active })
        .from(groupSources)
        .where(
          inArray(groupSources.id, [
            recoverySource.id,
            designatedSource.id,
            throwawaySource.id,
          ]),
        )
        .orderBy(asc(groupSources.id)),
    ).toEqual(
      [recoverySource.id, designatedSource.id, throwawaySource.id]
        .sort()
        .map((id) => ({ id, active: true })),
    );

    const rolledBackThrowaway = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: throwawaySource.id,
        kind: throwawaySource.kind,
        purpose: throwawaySource.purpose,
        facilityId: throwawaySource.facilityId,
        grantedRole: 'admin',
        displayName: throwawaySource.displayName,
        active: false,
        googleGroupId: throwawaySource.googleGroupId,
        email: throwawaySource.email,
      },
      metadata: metadata('protected-recovery-third-rollback', requestIds),
    });
    expect(rolledBackThrowaway.active).toBe(false);
    expect(await loadAccessConfigurationSnapshotState(database)).toEqual(
      accessState,
    );
  });

  test('allows only exact rollback of an unproven added access group', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    const provenGroups = await database
      .select({
        id: groupSources.id,
        displayName: groupSources.displayName,
        googleGroupId: groupSources.googleGroupId,
        email: groupSources.email,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      );
    const provenAccessGroups = provenGroups.map((group) => {
      if (group.googleGroupId === null || group.email === null) {
        throw new Error('A proven access group is missing its locator.');
      }
      return Object.freeze({
        ...group,
        googleGroupId: group.googleGroupId,
        email: group.email,
      });
    });
    if (provenAccessGroups.length < 2) {
      throw new Error(
        'The access rollback fixture requires two proven groups.',
      );
    }
    await persistAuthenticatedAdministrator(
      database,
      authenticated,
      provenAccessGroups.map(({ id }) => id),
      suffix,
    );
    const addedGroup = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `Unproven added access ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-added-access-${suffix}`,
        email: `issue-26-added-access-${suffix}@example.invalid`,
      },
      metadata: metadata('added-access-create', requestIds),
    });
    if (addedGroup.kind !== 'google-group' || addedGroup.purpose !== 'access') {
      throw new Error('The added access-group fixture lost its variant.');
    }
    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();

    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: addedGroup.id,
          kind: addedGroup.kind,
          purpose: addedGroup.purpose,
          facilityId: addedGroup.facilityId,
          grantedRole: 'admin',
          displayName: `${addedGroup.displayName} changed`,
          active: addedGroup.active,
          googleGroupId: addedGroup.googleGroupId,
          email: addedGroup.email,
        },
        metadata: metadata('added-access-display-change', requestIds),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: addedGroup.id,
          kind: addedGroup.kind,
          purpose: addedGroup.purpose,
          facilityId: addedGroup.facilityId,
          grantedRole: 'admin',
          displayName: addedGroup.displayName,
          active: addedGroup.active,
          googleGroupId: `${addedGroup.googleGroupId}-replacement`,
          email: `issue-26-added-access-replacement-${suffix}@example.invalid`,
        },
        metadata: metadata('added-access-locator-change', requestIds),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const nonRestorativeSource = provenAccessGroups[0];
    if (nonRestorativeSource === undefined) {
      throw new Error('A non-restorative source is required.');
    }
    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: nonRestorativeSource.id,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: 'admin',
          displayName: nonRestorativeSource.displayName,
          active: false,
          googleGroupId: nonRestorativeSource.googleGroupId,
          email: nonRestorativeSource.email,
        },
        metadata: metadata('added-access-wrong-rollback', requestIds),
      }),
    ).rejects.toMatchObject({ status: 409 });

    const rolledBack = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: addedGroup.id,
        kind: addedGroup.kind,
        purpose: addedGroup.purpose,
        facilityId: addedGroup.facilityId,
        grantedRole: 'admin',
        displayName: addedGroup.displayName,
        active: false,
        googleGroupId: addedGroup.googleGroupId,
        email: addedGroup.email,
      },
      metadata: metadata('added-access-exact-rollback', requestIds),
    });
    expect(rolledBack.active).toBe(false);
    const restoredState = await loadAccessConfigurationSnapshotState(database);
    if (restoredState === null) {
      throw new Error('The exact access-group rollback did not restore state.');
    }
    expect(restoredState.activeAccessGroupSourceIds).toEqual(
      provenAccessGroups.map(({ id }) => id).sort(),
    );
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: restoredState,
      }),
    ).toContain(authenticated.actor.userId);
  });

  test('rolls back exact restoration when the current human is absent from the proven snapshot', async () => {
    const database = databaseConnection().db;
    const reachableAdministrator = authenticatedAdministrator();
    const unreachableAdministrator = authenticatedAdministrator();
    const reachableStore = createDrizzleAdminCapabilityStore(
      database,
      reachableAdministrator,
    );
    const unreachableStore = createDrizzleAdminCapabilityStore(
      database,
      unreachableAdministrator,
    );
    const suffix = randomUUID();
    const requestIds: string[] = [];
    const provenGroupRows = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      );
    if (provenGroupRows.length === 0) {
      throw new Error('The unreachable rollback fixture needs a proven group.');
    }
    await persistAuthenticatedAdministrator(
      database,
      reachableAdministrator,
      provenGroupRows.map(({ id }) => id),
      `reachable-${suffix}`,
    );
    await persistAdministratorIdentity(
      database,
      unreachableAdministrator,
      `unreachable-${suffix}`,
    );

    const addedGroup = await executeCreateGroupSourceCapability({
      authenticated: reachableAdministrator,
      store: reachableStore,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `Unreachable rollback ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-unreachable-rollback-${suffix}`,
        email: `issue-26-unreachable-rollback-${suffix}@example.invalid`,
      },
      metadata: metadata('unreachable-rollback-create', requestIds),
    });
    if (addedGroup.kind !== 'google-group' || addedGroup.purpose !== 'access') {
      throw new Error('The unreachable rollback fixture lost its variant.');
    }
    const rollbackCommand = {
      id: addedGroup.id,
      kind: addedGroup.kind,
      purpose: addedGroup.purpose,
      facilityId: addedGroup.facilityId,
      grantedRole: 'admin',
      displayName: addedGroup.displayName,
      active: false,
      googleGroupId: addedGroup.googleGroupId,
      email: addedGroup.email,
    } as const;

    await expect(
      executeUpdateGroupSourceCapability({
        authenticated: unreachableAdministrator,
        store: unreachableStore,
        command: rollbackCommand,
        metadata: metadata('unreachable-exact-rollback', requestIds),
      }),
    ).rejects.toMatchObject({ status: 403 });
    const [stillActive] = await database
      .select({ active: groupSources.active })
      .from(groupSources)
      .where(eq(groupSources.id, addedGroup.id))
      .limit(1);
    expect(stillActive).toEqual({ active: true });
    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();

    const restored = await executeUpdateGroupSourceCapability({
      authenticated: reachableAdministrator,
      store: reachableStore,
      command: rollbackCommand,
      metadata: metadata('reachable-exact-rollback', requestIds),
    });
    expect(restored.active).toBe(false);
    expect(
      (await loadAccessConfigurationSnapshotState(database))
        ?.activeAccessGroupSourceIds,
    ).toEqual(provenGroupRows.map(({ id }) => id).sort());
  });

  test('stages access locator correction so the replacement can be rolled back', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    const provenGroupRows = await database
      .select({
        id: groupSources.id,
        displayName: groupSources.displayName,
        googleGroupId: groupSources.googleGroupId,
        email: groupSources.email,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      )
      .orderBy(groupSources.id);
    const original = provenGroupRows[0];
    if (
      original === undefined ||
      original.googleGroupId === null ||
      original.email === null
    ) {
      throw new Error('The locator rotation fixture needs a proven source.');
    }
    await persistAuthenticatedAdministrator(
      database,
      authenticated,
      original.id,
      `locator-rotation-${suffix}`,
    );

    const inactiveSourceId = randomUUID();
    const inactiveGoogleGroupId = `issue-26-retired-access-${suffix}`;
    const inactiveEmail = `issue-26-retired-access-${suffix}@example.invalid`;
    await database.insert(groupSources).values({
      id: inactiveSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      grantedRole: 'admin',
      displayName: `Retired access source ${suffix.slice(0, 8)}`,
      active: false,
      googleGroupId: inactiveGoogleGroupId,
      email: inactiveEmail,
      fixtureKey: null,
    });
    const inactiveReplacementGoogleGroupId = `issue-26-retired-access-replacement-${suffix}`;
    const inactiveReplacementMetadata = metadata(
      'locator-rotation-retired-origin',
      requestIds,
    );
    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: inactiveSourceId,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: 'admin',
          displayName: `Invalid retired access replacement ${suffix.slice(0, 8)}`,
          active: true,
          googleGroupId: inactiveReplacementGoogleGroupId,
          email: `${inactiveReplacementGoogleGroupId}@example.invalid`,
        },
        metadata: inactiveReplacementMetadata,
      }),
    ).rejects.toMatchObject({
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 409,
    });
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(
          eq(groupSources.googleGroupId, inactiveReplacementGoogleGroupId),
        ),
    ).toEqual([]);
    const [retainedInactiveSource] = await database
      .select({
        active: groupSources.active,
        email: groupSources.email,
        googleGroupId: groupSources.googleGroupId,
      })
      .from(groupSources)
      .where(eq(groupSources.id, inactiveSourceId))
      .limit(1);
    expect(retainedInactiveSource).toEqual({
      active: false,
      email: inactiveEmail,
      googleGroupId: inactiveGoogleGroupId,
    });
    const inactiveReplacementAudits = await database
      .select({
        outcome: securityAuditEntries.outcome,
        reasonCode: securityAuditEntries.reasonCode,
      })
      .from(securityAuditEntries)
      .where(
        eq(
          securityAuditEntries.requestId,
          inactiveReplacementMetadata.requestId,
        ),
      );
    expect(inactiveReplacementAudits).toEqual([
      {
        outcome: 'failure',
        reasonCode: 'PERSISTENCE_CONFLICT',
      },
    ]);

    const rejectedGoogleGroupId = `issue-26-inactive-locator-${suffix}`;
    const rejectedEmail = `issue-26-inactive-locator-${suffix}@example.invalid`;
    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: original.id,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: 'admin',
          displayName: `${original.displayName} rejected inactive correction`,
          active: false,
          googleGroupId: rejectedGoogleGroupId,
          email: rejectedEmail,
        },
        metadata: metadata('locator-rotation-inactive-rejected', requestIds),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(eq(groupSources.googleGroupId, rejectedGoogleGroupId)),
    ).toEqual([]);
    const [unchangedOriginal] = await database
      .select({
        active: groupSources.active,
        googleGroupId: groupSources.googleGroupId,
        email: groupSources.email,
      })
      .from(groupSources)
      .where(eq(groupSources.id, original.id))
      .limit(1);
    expect(unchangedOriginal).toEqual({
      active: true,
      googleGroupId: original.googleGroupId,
      email: original.email,
    });

    const replacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: original.id,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `${original.displayName} corrected`,
        active: true,
        googleGroupId: `issue-26-locator-rotation-${suffix}`,
        email: `issue-26-locator-rotation-${suffix}@example.invalid`,
      },
      metadata: metadata('locator-rotation-stage', requestIds),
    });
    if (
      replacement.kind !== 'google-group' ||
      replacement.purpose !== 'access'
    ) {
      throw new Error('The access locator replacement lost its variant.');
    }
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.active).toBe(true);
    const stagedRows = await database
      .select({ id: groupSources.id, active: groupSources.active })
      .from(groupSources)
      .where(inArray(groupSources.id, [original.id, replacement.id]))
      .orderBy(groupSources.id);
    expect(stagedRows).toEqual(
      [original.id, replacement.id].sort().map((id) => ({ id, active: true })),
    );
    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();

    await expect(
      executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: original.id,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: 'admin',
          displayName: original.displayName,
          active: false,
          googleGroupId: original.googleGroupId,
          email: original.email,
        },
        metadata: metadata('locator-rotation-retire-unproven', requestIds),
      }),
    ).rejects.toMatchObject({ status: 409 });

    const rolledBack = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: replacement.id,
        kind: replacement.kind,
        purpose: replacement.purpose,
        facilityId: replacement.facilityId,
        grantedRole: 'admin',
        displayName: replacement.displayName,
        active: false,
        googleGroupId: replacement.googleGroupId,
        email: replacement.email,
      },
      metadata: metadata('locator-rotation-rollback', requestIds),
    });
    expect(rolledBack.active).toBe(false);
    const [originalAfterRollback] = await database
      .select({ active: groupSources.active })
      .from(groupSources)
      .where(eq(groupSources.id, original.id))
      .limit(1);
    expect(originalAfterRollback).toEqual({ active: true });
    expect(
      (await loadAccessConfigurationSnapshotState(database))
        ?.activeAccessGroupSourceIds,
    ).toEqual(provenGroupRows.map(({ id }) => id).sort());
  });

  test('completes a locator rotation after fresh replacement evidence and restores strict reachability', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    const [original] = await database
      .select({
        id: groupSources.id,
        displayName: groupSources.displayName,
        googleGroupId: groupSources.googleGroupId,
        email: groupSources.email,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.active, true),
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
        ),
      )
      .orderBy(groupSources.id)
      .limit(1);
    if (
      original === undefined ||
      original.googleGroupId === null ||
      original.email === null
    ) {
      throw new Error('The completed locator rotation needs an active source.');
    }
    const googleSubject = `issue-26-admin-subject-locator-complete-${suffix}`;
    await persistAuthenticatedAdministrator(
      database,
      authenticated,
      original.id,
      `locator-complete-${suffix}`,
    );

    const replacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: original.id,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `${original.displayName} verified replacement`,
        active: true,
        googleGroupId: `issue-26-locator-complete-${suffix}`,
        email: `issue-26-locator-complete-${suffix}@example.invalid`,
      },
      metadata: metadata('locator-complete-stage', requestIds),
    });
    if (
      replacement.kind !== 'google-group' ||
      replacement.purpose !== 'access'
    ) {
      throw new Error('The completed locator replacement lost its variant.');
    }

    const stagedActiveGroups = await database
      .select({
        id: groupSources.id,
        kind: groupSources.kind,
        purpose: groupSources.purpose,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.active, true),
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
        ),
      )
      .orderBy(groupSources.id);
    const stagedSnapshot = await persistCompleteAccessSnapshotGeneration(
      database,
      {
        groups: stagedActiveGroups.map(({ id }) => ({
          id,
          kind: 'google-group' as const,
          purpose: 'access' as const,
        })),
        members: [
          {
            userId: authenticated.actor.userId,
            googleSubject,
            facilityScopeKind: 'district',
            accessGroupIds: [replacement.id],
          },
        ],
        capturedAt: await nextFreshAccessSnapshotTime(database),
      },
    );
    const stagedState = await loadAccessConfigurationSnapshotState(database);
    expect(stagedState).toEqual({
      snapshotId: stagedSnapshot.id,
      snapshotVersion: stagedSnapshot.version,
      activeAccessGroupSourceIds: stagedActiveGroups.map(({ id }) => id).sort(),
    });
    if (stagedState === null) {
      throw new Error(
        'The staged locator snapshot is not strict and complete.',
      );
    }
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: stagedState,
        eligibleAccessGroupSourceIds: stagedActiveGroups
          .map(({ id }) => id)
          .filter((id) => id !== original.id),
      }),
    ).toContain(authenticated.actor.userId);

    const retired = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: original.id,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: original.displayName,
        active: false,
        googleGroupId: original.googleGroupId,
        email: original.email,
      },
      metadata: metadata('locator-complete-retire', requestIds),
    });
    expect(retired.active).toBe(false);
    const [retiredRow, replacementRow] = await Promise.all([
      database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, original.id))
        .limit(1),
      database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, replacement.id))
        .limit(1),
    ]);
    expect(retiredRow[0]).toEqual({ active: false });
    expect(replacementRow[0]).toEqual({ active: true });
    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();

    const finalActiveGroups = stagedActiveGroups.filter(
      ({ id }) => id !== original.id,
    );
    const finalSnapshot = await persistCompleteAccessSnapshotGeneration(
      database,
      {
        groups: finalActiveGroups.map(({ id }) => ({
          id,
          kind: 'google-group' as const,
          purpose: 'access' as const,
        })),
        members: [
          {
            userId: authenticated.actor.userId,
            googleSubject,
            facilityScopeKind: 'district',
            accessGroupIds: [replacement.id],
          },
        ],
        capturedAt: await nextFreshAccessSnapshotTime(database),
      },
    );
    const finalState = await loadAccessConfigurationSnapshotState(database);
    expect(finalState).toEqual({
      snapshotId: finalSnapshot.id,
      snapshotVersion: finalSnapshot.version,
      activeAccessGroupSourceIds: finalActiveGroups.map(({ id }) => id).sort(),
    });
    if (finalState === null) {
      throw new Error('The final locator snapshot is not strict and complete.');
    }
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: finalState,
      }),
    ).toContain(authenticated.actor.userId);
  });

  test('configures a complete new site and records every mutation', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    await persistAdministratorIdentity(database, authenticated, suffix);

    const facilityMetadata = metadata('facility', requestIds);
    const facility = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: {
        code: `I26-${suffix.slice(0, 8).toUpperCase()}`,
        name: `Issue 26 synthetic site ${suffix.slice(0, 8)}`,
      },
      metadata: facilityMetadata,
    });
    const facilityReplay = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: { code: facility.code, name: facility.name },
      metadata: replayMetadata(facilityMetadata, requestIds),
    });
    expect(facilityReplay).toEqual(facility);

    const staffBuildingCommand = {
      kind: 'google-group' as const,
      purpose: 'building' as const,
      facilityId: facility.id,
      displayName: `${facility.name} staff`,
      active: true,
      googleGroupId: `issue-26-staff-${suffix}`,
      email: `issue-26-staff-${suffix}@example.invalid`,
    };
    const staffBuildingMetadata = metadata('staff-building', requestIds);
    const staffBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: staffBuildingCommand,
      metadata: staffBuildingMetadata,
    });
    const staffBuildingReplayMetadata = replayMetadata(
      staffBuildingMetadata,
      requestIds,
    );
    expect(
      await executeCreateGroupSourceCapability({
        authenticated,
        store,
        command: staffBuildingCommand,
        metadata: staffBuildingReplayMetadata,
      }),
    ).toEqual(staffBuilding);
    for (const requestId of [
      staffBuildingMetadata.requestId,
      staffBuildingReplayMetadata.requestId,
    ]) {
      const [audit] = await database
        .select({
          targetKind: securityAuditEntries.targetKind,
          targetId: securityAuditEntries.targetId,
        })
        .from(securityAuditEntries)
        .where(eq(securityAuditEntries.requestId, requestId))
        .limit(1);
      expect(audit).toEqual({
        targetKind: 'configuration',
        targetId: staffBuilding.id,
      });
    }
    const syntheticBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'synthetic',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} synthetic staff`,
        active: true,
        fixtureKey: `issue-26-building-${suffix}`,
      },
      metadata: metadata('synthetic-building', requestIds),
    });
    let previouslyProvenAccessGroups = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      );
    if (previouslyProvenAccessGroups.length === 0) {
      const [preCutoverRecoverySource] = await database
        .insert(groupSources)
        .values({
          id: randomUUID(),
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          grantedRole: 'admin',
          displayName: `Synthetic pre-cutover recovery ${suffix.slice(0, 8)}`,
          active: true,
          googleGroupId: `issue-26-precutover-recovery-${suffix}`,
          email: `issue-26-precutover-recovery-${suffix}@example.invalid`,
          fixtureKey: null,
        })
        .returning({ id: groupSources.id });
      if (preCutoverRecoverySource === undefined) {
        throw new Error('The pre-cutover recovery source was not created.');
      }
      previouslyProvenAccessGroups = [preCutoverRecoverySource];
    }
    await persistCompleteAccessSnapshotGeneration(database, {
      groups: previouslyProvenAccessGroups.map(({ id }) => ({
        id,
        kind: 'google-group' as const,
        purpose: 'access' as const,
      })),
      members: [
        {
          userId: authenticated.actor.userId,
          googleSubject: `issue-26-admin-subject-${suffix}`,
          facilityScopeKind: 'district',
          accessGroupIds: previouslyProvenAccessGroups.map(({ id }) => id),
        },
      ],
    });
    const accessGroup = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        grantedRole: 'admin',
        displayName: `Issue 26 access ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-${suffix}`,
        email: DESIGNATED_ACCESS_GROUP_EMAIL,
      },
      metadata: metadata('access-group', requestIds),
    });
    await database
      .update(groupSources)
      .set({ active: false })
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
          ne(groupSources.id, accessGroup.id),
        ),
      );
    expect(
      await database
        .select({ id: groupSources.id, email: groupSources.email })
        .from(groupSources)
        .where(
          and(
            eq(groupSources.kind, 'google-group'),
            eq(groupSources.purpose, 'access'),
            eq(groupSources.active, true),
          ),
        ),
    ).toEqual([{ id: accessGroup.id, email: DESIGNATED_ACCESS_GROUP_EMAIL }]);
    await persistAuthenticatedAdministrator(
      database,
      authenticated,
      accessGroup.id,
      suffix,
    );
    const others = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: `Issue 26 district others ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-others-${suffix}`,
        email: `issue-26-others-${suffix}@example.invalid`,
      },
      metadata: metadata('others', requestIds),
    });
    const syntheticOthers = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
        displayName: `Issue 26 synthetic others ${suffix.slice(0, 8)}`,
        active: true,
        fixtureKey: `issue-26-others-${suffix}`,
      },
      metadata: metadata('synthetic-others', requestIds),
    });
    if (
      others.kind !== 'google-group' ||
      others.purpose !== 'others' ||
      others.facilityId !== null
    ) {
      throw new Error('The configured audience extension lost its purpose.');
    }
    if (
      syntheticOthers.kind !== 'synthetic' ||
      syntheticOthers.purpose !== 'others' ||
      syntheticOthers.facilityId !== null
    ) {
      throw new Error(
        'The configured synthetic audience extension lost its purpose.',
      );
    }
    const neighborhood = await executeCreateNeighborhoodVersionCapability({
      authenticated,
      store,
      command: {
        neighborhoodId: null,
        name: `Issue 26 neighborhood ${suffix.slice(0, 8)}`,
        facilityIds: [facility.id],
      },
      metadata: metadata('neighborhood', requestIds),
    });
    const audience = await executeCreateAudienceConfigVersionCapability({
      authenticated,
      store,
      command: {
        audienceConfigId: null,
        facilityId: facility.id,
        targets: [
          { kind: 'building', facilityId: facility.id },
          {
            kind: 'neighborhood',
            neighborhood: {
              id: neighborhood.id,
              version: neighborhood.version,
            },
          },
          {
            kind: 'others',
            groupSourceRef: {
              id: others.id,
              kind: others.kind,
              purpose: others.purpose,
              facilityId: others.facilityId,
            },
          },
        ],
      },
      metadata: metadata('audience', requestIds),
    });

    expect(
      await executeGetAudienceConfigCapability({
        authenticated,
        store,
        query: { facilityId: facility.id },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(audience);
    try {
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: audience.id,
          facilityId: facility.id,
          targets: [
            {
              kind: 'neighborhood',
              neighborhood: {
                id: neighborhood.id,
                version: neighborhood.version,
              },
            },
          ],
        },
        metadata: {
          idempotencyKey: `issue-26-missing-building-${randomUUID()}`,
          requestId: randomUUID(),
          now: new Date(),
        },
      });
      throw new Error('Expected an audience without its building to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    const mixedAudienceRequestId = randomUUID();
    try {
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: audience.id,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: others.id,
                kind: others.kind,
                purpose: others.purpose,
                facilityId: others.facilityId,
              },
            },
            {
              kind: 'others',
              groupSourceRef: {
                id: syntheticOthers.id,
                kind: syntheticOthers.kind,
                purpose: syntheticOthers.purpose,
                facilityId: syntheticOthers.facilityId,
              },
            },
          ],
        },
        metadata: {
          idempotencyKey: `issue-26-mixed-audience-${randomUUID()}`,
          requestId: mixedAudienceRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected a mixed-population audience to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }

    const neighborhoodV2 = await executeCreateNeighborhoodVersionCapability({
      authenticated,
      store,
      command: {
        neighborhoodId: neighborhood.id,
        name: `${neighborhood.name} corrected`,
        facilityIds: [facility.id],
      },
      metadata: metadata('neighborhood-v2', requestIds),
    });
    expect(neighborhoodV2).toMatchObject({
      id: neighborhood.id,
      version: neighborhood.version + 1,
      name: `${neighborhood.name} corrected`,
      facilityIds: [facility.id],
    });
    expect(
      await executeGetNeighborhoodVersionCapability({
        authenticated,
        store,
        query: {
          neighborhood: {
            id: neighborhood.id,
            version: neighborhood.version,
          },
        },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(neighborhood);
    const currentNeighborhoods = await executeListNeighborhoodsCapability({
      authenticated,
      store,
      query: { cursor: null, limit: 200 },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(
      currentNeighborhoods.items.find(({ id }) => id === neighborhood.id),
    ).toEqual(neighborhoodV2);

    const audienceV2 = await executeCreateAudienceConfigVersionCapability({
      authenticated,
      store,
      command: {
        audienceConfigId: audience.id,
        facilityId: facility.id,
        targets: [
          { kind: 'building', facilityId: facility.id },
          {
            kind: 'neighborhood',
            neighborhood: {
              id: neighborhoodV2.id,
              version: neighborhoodV2.version,
            },
          },
        ],
      },
      metadata: metadata('audience-v2', requestIds),
    });
    expect(audienceV2).toMatchObject({
      id: audience.id,
      facilityId: facility.id,
      version: audience.version + 1,
    });
    expect(
      await executeGetAudienceConfigVersionCapability({
        authenticated,
        store,
        query: {
          audienceConfig: { id: audience.id, version: audience.version },
        },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(audience);
    expect(
      await executeGetAudienceConfigCapability({
        authenticated,
        store,
        query: { facilityId: facility.id },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(audienceV2);

    const roleTargetId = randomUUID();
    await database.insert(users).values({
      id: roleTargetId,
      googleSubject: `issue-26-subject-${suffix}`,
      email: `issue-26-role-${suffix}@psd401.net`,
      displayName: `Issue 26 synthetic staff ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
    });
    await database.insert(userRoles).values({
      userId: roleTargetId,
      role: 'staff',
    });
    const rolelessContactId = randomUUID();
    await database.insert(users).values({
      id: rolelessContactId,
      googleSubject: `issue-26-contact-${suffix}`,
      email: `issue-26-contact-${suffix}@psd401.net`,
      displayName: `Issue 26 synthetic contact ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
    });
    const inaccessibleAdministratorId = randomUUID();
    const inaccessibleAdministratorSubject = `issue-26-inaccessible-admin-${suffix}`;
    await database.insert(users).values({
      id: inaccessibleAdministratorId,
      googleSubject: inaccessibleAdministratorSubject,
      email: `issue-26-inaccessible-admin-${suffix}@psd401.net`,
      displayName: `Issue 26 inaccessible administrator ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
    });
    await database.insert(userRoles).values({
      userId: inaccessibleAdministratorId,
      role: 'staff',
    });
    const [roleTargetRow] = await database
      .select()
      .from(users)
      .where(eq(users.id, roleTargetId))
      .limit(1);
    if (roleTargetRow === undefined) {
      throw new Error('The bootstrap-role target could not be reloaded.');
    }
    const [primaryAdministratorRow] = await database
      .select({ googleSubject: users.googleSubject })
      .from(users)
      .where(eq(users.id, authenticated.actor.userId))
      .limit(1);
    if (primaryAdministratorRow === undefined) {
      throw new Error('The primary administrator could not be reloaded.');
    }
    const activeAccessGroups = await database
      .select({
        id: groupSources.id,
        kind: groupSources.kind,
        purpose: groupSources.purpose,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      );
    const previousCompleteAccessSnapshot =
      await copyLatestAccessSnapshotWithMember(database, {
        userId: inaccessibleAdministratorId,
        googleSubject: inaccessibleAdministratorSubject,
        facilityScopeKind: 'district',
        accessGroupIds: [accessGroup.id],
      });
    const bootstrapSnapshotAt = new Date(Date.now() + 60_000);
    const bootstrapUser = {
      id: roleTargetRow.id,
      googleSubject: roleTargetRow.googleSubject,
      email: roleTargetRow.email,
      displayName: roleTargetRow.displayName,
      roles: ['staff'] as const,
      facilityScope: { kind: 'district' as const },
      createdAt: roleTargetRow.createdAt.toISOString(),
      disabledAt: null,
    };
    const initialSessionStore = createDrizzleInitialWebSessionStore(database);
    const firstBootstrapSession = await initialSessionStore.persist(
      bootstrapSessionRequest({
        label: `first-${suffix}`,
        user: bootstrapUser,
        membership: {
          groupSourceIds: [accessGroup.id],
          capturedAt: bootstrapSnapshotAt,
        },
        createdAt: new Date(bootstrapSnapshotAt.getTime() + 1_000),
      }),
    );
    expect(firstBootstrapSession.user.roles).toEqual(['staff', 'admin']);

    const accessAccounts = await executeListUsersCapability({
      authenticated,
      store,
      query: {
        facilityId: null,
        includeDisabled: true,
        cursor: null,
        limit: 200,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(
      accessAccounts.items.some(({ id }) => id === rolelessContactId),
    ).toBe(false);
    expect(await loadEffectiveAdministratorUserIds(database)).toEqual(
      [authenticated.actor.userId, roleTargetId].sort(),
    );
    const roleAssignmentMetadata = metadata('role-assignment', requestIds);
    const roleResult = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: roleTargetId, roles: ['staff', 'admin'] },
      metadata: roleAssignmentMetadata,
    });
    expect(roleResult.roles).toEqual(['staff', 'admin']);
    expect(
      await executeSetUserRolesCapability({
        authenticated,
        store,
        command: { userId: roleTargetId, roles: ['staff', 'admin'] },
        metadata: replayMetadata(roleAssignmentMetadata, requestIds),
      }),
    ).toEqual(roleResult);
    const selfDemotion = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: authenticated.actor.userId, roles: ['staff'] },
      metadata: metadata('self-demotion-with-backup', requestIds),
    });
    expect(selfDemotion.roles).toEqual(['staff']);
    const backupAdministrator = {
      ...authenticated,
      actor: {
        kind: 'human' as const,
        userId: roleTargetId,
        sessionId: firstBootstrapSession.session.id,
      },
      roles: ['admin'] as const,
    } as unknown as AuthenticatedSession;
    const backupStore = createDrizzleAdminCapabilityStore(
      database,
      backupAdministrator,
    );
    const restoredAdministrator = await executeSetUserRolesCapability({
      authenticated: backupAdministrator,
      store: backupStore,
      command: { userId: authenticated.actor.userId, roles: ['admin'] },
      metadata: metadata('restore-primary-admin', requestIds),
    });
    expect(restoredAdministrator.roles).toEqual(['admin']);
    const roleRemovalMetadata = metadata('role-removal', requestIds);
    const roleRemoval = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: roleTargetId, roles: ['staff'] },
      metadata: roleRemovalMetadata,
    });
    expect(roleRemoval.roles).toEqual(['staff']);
    const secondBootstrapSession = await initialSessionStore.persist(
      bootstrapSessionRequest({
        label: `after-revocation-${suffix}`,
        user: bootstrapUser,
        membership: {
          groupSourceIds: [accessGroup.id],
          capturedAt: bootstrapSnapshotAt,
        },
        createdAt: new Date(bootstrapSnapshotAt.getTime() + 2_000),
      }),
    );
    expect(secondBootstrapSession.user.roles).toEqual(['staff', 'admin']);
    const roleChanges = await database
      .select({
        role: userRoleChanges.role,
        granted: userRoleChanges.granted,
      })
      .from(userRoleChanges)
      .where(eq(userRoleChanges.userId, roleTargetId))
      .orderBy(userRoleChanges.sequence);
    expect(roleChanges).toEqual([
      { role: 'admin', granted: true },
      { role: 'admin', granted: false },
      { role: 'admin', granted: true },
    ]);
    const baseRoleRows = await database
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, roleTargetId));
    expect(baseRoleRows).toEqual([{ role: 'staff' }]);

    const inaccessibleAdministrator = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: {
        userId: inaccessibleAdministratorId,
        roles: ['staff', 'admin'],
      },
      metadata: metadata('inaccessible-admin-role', requestIds),
    });
    expect(inaccessibleAdministrator.roles).toEqual(['staff', 'admin']);
    expect(
      await database
        .select({ snapshotId: accessMembershipMembers.snapshotId })
        .from(accessMembershipMembers)
        .where(eq(accessMembershipMembers.userId, inaccessibleAdministratorId)),
    ).toEqual([{ snapshotId: previousCompleteAccessSnapshot.id }]);
    expect(await loadEffectiveAdministratorUserIds(database)).toEqual(
      [authenticated.actor.userId, roleTargetId].sort(),
    );
    // The administrator holds the role but is not a member of any trusted
    // group, so access is refused while the role row survives.
    expect(
      await decideAccess(database, {
        email: `issue-26-inaccessible-admin-${suffix}@psd401.net`,
        checkedAt: new Date(),
      }),
    ).toMatchObject({ granted: false });

    const contradictoryAdministratorId = randomUUID();
    const contradictoryAdministratorSubject = `issue-26-contradictory-admin-${suffix}`;
    await database.insert(users).values({
      id: contradictoryAdministratorId,
      googleSubject: contradictoryAdministratorSubject,
      email: `issue-26-contradictory-admin-${suffix}@psd401.net`,
      displayName: `Issue 26 contradictory administrator ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
    });
    await database.insert(userRoles).values({
      userId: contradictoryAdministratorId,
      role: 'admin',
    });
    await database.insert(userFacilityScopes).values({
      userId: contradictoryAdministratorId,
      facilityId: facility.id,
    });
    const contradictorySnapshot = await persistCompleteAccessSnapshotGeneration(
      database,
      {
        groups: activeAccessGroups.map(({ id }) => ({
          id,
          kind: 'google-group' as const,
          purpose: 'access' as const,
        })),
        members: [
          {
            userId: authenticated.actor.userId,
            googleSubject: primaryAdministratorRow.googleSubject,
            facilityScopeKind: 'district',
            accessGroupIds: [accessGroup.id],
          },
          {
            userId: contradictoryAdministratorId,
            googleSubject: contradictoryAdministratorSubject,
            facilityScopeKind: 'district',
            accessGroupIds: [accessGroup.id],
            facilityIds: [facility.id],
          },
        ],
        capturedAt: new Date(bootstrapSnapshotAt.getTime() + 3_000),
      },
    );
    expect(
      await database
        .select({ facilityId: accessMembershipMemberFacilities.facilityId })
        .from(accessMembershipMemberFacilities)
        .where(
          and(
            eq(
              accessMembershipMemberFacilities.snapshotId,
              contradictorySnapshot.id,
            ),
            eq(
              accessMembershipMemberFacilities.userId,
              contradictoryAdministratorId,
            ),
          ),
        ),
    ).toEqual([{ facilityId: facility.id }]);
    expect(await loadEffectiveAdministratorUserIds(database)).toEqual([
      authenticated.actor.userId,
    ]);

    const selfRemovalRequestId = randomUUID();
    try {
      await executeSetUserRolesCapability({
        authenticated,
        store,
        command: { userId: authenticated.actor.userId, roles: ['staff'] },
        metadata: {
          idempotencyKey: `issue-26-self-role-removal-${randomUUID()}`,
          requestId: selfRemovalRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected self-admin removal to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    const [selfRemovalAudit] = await database
      .select({
        action: securityAuditEntries.action,
        outcome: securityAuditEntries.outcome,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, selfRemovalRequestId))
      .limit(1);
    expect(selfRemovalAudit).toEqual({
      action: 'set-user-roles',
      outcome: 'failure',
    });
    expect(
      await loadEffectiveRoles(database, authenticated.actor.userId),
    ).toEqual(['admin']);

    const channelResult = await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: 'expo-push',
        enabled: false,
        authorization: null,
      },
      metadata: metadata('channel-state', requestIds),
    });
    expect(channelResult).toMatchObject({
      integrationId: 'expo-push',
      enabled: false,
      status: { label: 'mocked' },
    });
    if (authenticated.actor.kind !== 'human') {
      throw new Error('The synthetic administrator must be human.');
    }

    const transitioningIntegrationId = `synthetic-transition-${suffix}`;
    const mockedTransitionStatusId = randomUUID();
    const mockedTransitionObservedAt = new Date();
    await database.insert(integrationStatuses).values({
      id: mockedTransitionStatusId,
      integrationId: transitioningIntegrationId,
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: mockedTransitionObservedAt,
    });
    await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: transitioningIntegrationId,
        enabled: true,
        authorization: null,
      },
      metadata: metadata('mocked-transition-enable', requestIds),
    });
    const transitionLiveStatusId = randomUUID();
    const transitionIssuedAt = new Date(
      mockedTransitionObservedAt.getTime() + 1_000,
    );
    const transitionBase = {
      reference: `issue-26-transition-${randomUUID()}`,
      integrationStatusId: transitionLiveStatusId,
      integrationId: transitioningIntegrationId,
      desiredEnabled: true,
      requestDigest: '0'.repeat(64),
      consequenceDigest: '0'.repeat(64),
      authorizedByUserId: authenticated.actor.userId,
      authorizedWithSessionId: authenticated.actor.sessionId,
      issuedAt: transitionIssuedAt.toISOString(),
      expiresAt: new Date(
        transitionIssuedAt.getTime() + 15 * 60 * 1_000,
      ).toISOString(),
    } as const;
    const transitionAuthorization =
      IntegrationChannelChangeAuthorizationSchema.parse({
        ...transitionBase,
        requestDigest: liveChannelChangeRequestDigest(transitionBase),
        consequenceDigest: liveChannelChangeConsequenceDigest({
          integrationId: transitioningIntegrationId,
          previousConfiguration: {
            enabled: true,
            statusId: mockedTransitionStatusId,
          },
          desiredEnabled: true,
          integrationStatusId: transitionLiveStatusId,
        }),
      });
    await database.insert(integrationStatuses).values({
      id: transitionLiveStatusId,
      integrationId: transitioningIntegrationId,
      label: 'live-verified',
      verifiedAt: transitionIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: liveChannelChangeAuthorizationCommitment(
        transitionAuthorization,
      ),
      reasonCode: null,
      observedAt: transitionIssuedAt,
    });
    const [transitionedConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
        statusLabel: channelConfigurations.statusLabel,
      })
      .from(channelConfigurations)
      .where(
        eq(channelConfigurations.integrationId, transitioningIntegrationId),
      )
      .limit(1);
    expect(transitionedConfiguration).toEqual({
      enabled: false,
      statusId: transitionLiveStatusId,
      statusLabel: 'live-verified',
    });

    const oneTimeRaceIntegrationId = `synthetic-live-once-${suffix}`;
    const oneTimeRaceStatusId = randomUUID();
    const oneTimeRaceIssuedAt = new Date(Date.now() - 1_000);
    const oneTimeRaceAuthorization = liveAuthorizationFor({
      authenticated,
      integrationId: oneTimeRaceIntegrationId,
      integrationStatusId: oneTimeRaceStatusId,
      previousConfiguration: null,
      issuedAt: oneTimeRaceIssuedAt,
    });
    await database.insert(integrationStatuses).values({
      id: oneTimeRaceStatusId,
      integrationId: oneTimeRaceIntegrationId,
      label: 'live-verified',
      verifiedAt: oneTimeRaceIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: liveChannelChangeAuthorizationCommitment(
        oneTimeRaceAuthorization,
      ),
      reasonCode: null,
      observedAt: oneTimeRaceIssuedAt,
    });

    let releaseOneTimeRaceLock: (() => void) | undefined;
    const oneTimeRaceLockReleased = new Promise<void>((resolve) => {
      releaseOneTimeRaceLock = resolve;
    });
    let confirmOneTimeRaceLock: ((pid: number) => void) | undefined;
    const oneTimeRaceLockHeld = new Promise<number>((resolve) => {
      confirmOneTimeRaceLock = resolve;
    });
    const oneTimeRaceBlocker = database.transaction(async (transaction) => {
      const [lock] = await transaction.execute<{ pid: number }>(
        sql`
          select
            pg_backend_pid()::int as pid,
            pg_advisory_xact_lock(hashtextextended(${oneTimeRaceIntegrationId}, 0))
        `,
      );
      if (lock === undefined) {
        throw new Error('The one-time race advisory lock was not acquired.');
      }
      confirmOneTimeRaceLock?.(lock.pid);
      await oneTimeRaceLockReleased;
    });
    const oneTimeRaceBlockerPid = await oneTimeRaceLockHeld;

    const oneTimeRaceRequestIds: string[] = [];
    const oneTimeRaceMetadata = [
      metadata('live-one-time-race-a', oneTimeRaceRequestIds),
      metadata('live-one-time-race-b', oneTimeRaceRequestIds),
    ] as const;
    const oneTimeRaceResultsPromise = Promise.allSettled(
      oneTimeRaceMetadata.map((raceMetadata) =>
        executeSetChannelEnabledCapability({
          authenticated,
          store,
          command: {
            integrationId: oneTimeRaceIntegrationId,
            enabled: true,
            authorization: oneTimeRaceAuthorization,
          },
          metadata: raceMetadata,
        }),
      ),
    );
    await waitForAdvisoryWaiters(database, 2, oneTimeRaceBlockerPid);
    releaseOneTimeRaceLock?.();
    await oneTimeRaceBlocker;

    const oneTimeRaceResults = await oneTimeRaceResultsPromise;
    const oneTimeRaceSuccesses = oneTimeRaceResults.filter(
      (result) => result.status === 'fulfilled',
    );
    const oneTimeRaceFailures = oneTimeRaceResults.filter(
      (result) => result.status === 'rejected',
    );
    expect(oneTimeRaceSuccesses).toHaveLength(1);
    expect(oneTimeRaceFailures).toHaveLength(1);
    expect(oneTimeRaceFailures[0]?.reason).toBeInstanceOf(AdminCapabilityError);
    expect(
      (oneTimeRaceFailures[0]?.reason as AdminCapabilityError).status,
    ).toBe(403);
    const oneTimeRaceAuthorizationRows = await database
      .select({
        reference: integrationChannelChangeAuthorizations.reference,
        requestId: integrationChannelChangeAuthorizations.consumedRequestId,
      })
      .from(integrationChannelChangeAuthorizations)
      .where(
        eq(
          integrationChannelChangeAuthorizations.integrationStatusId,
          oneTimeRaceStatusId,
        ),
      );
    expect(oneTimeRaceAuthorizationRows).toHaveLength(1);
    const [oneTimeRaceAuthorizationRow] = oneTimeRaceAuthorizationRows;
    if (oneTimeRaceAuthorizationRow === undefined) {
      throw new Error('The one-time authorization evidence row is missing.');
    }
    expect(oneTimeRaceAuthorizationRow.reference).toBe(
      oneTimeRaceAuthorization.reference,
    );
    const oneTimeRaceWinnerIndex = oneTimeRaceResults.findIndex(
      (result) => result.status === 'fulfilled',
    );
    const oneTimeRaceWinnerMetadata =
      oneTimeRaceMetadata[oneTimeRaceWinnerIndex];
    if (oneTimeRaceWinnerMetadata === undefined) {
      throw new Error('The one-time authorization race has no winner.');
    }
    expect(oneTimeRaceAuthorizationRow.requestId).toBe(
      oneTimeRaceWinnerMetadata.requestId,
    );
    requestIds.push(oneTimeRaceWinnerMetadata.requestId);
    const oneTimeRaceLoserIndex = oneTimeRaceResults.findIndex(
      (result) => result.status === 'rejected',
    );
    const oneTimeRaceLoserMetadata = oneTimeRaceMetadata[oneTimeRaceLoserIndex];
    if (oneTimeRaceLoserMetadata === undefined) {
      throw new Error('The one-time authorization race has no loser.');
    }
    const [oneTimeRaceFailureAudit] = await database
      .select({
        action: securityAuditEntries.action,
        category: securityAuditEntries.category,
        outcome: securityAuditEntries.outcome,
        reasonCode: securityAuditEntries.reasonCode,
      })
      .from(securityAuditEntries)
      .where(
        eq(securityAuditEntries.requestId, oneTimeRaceLoserMetadata.requestId),
      )
      .limit(1);
    expect(oneTimeRaceFailureAudit).toEqual({
      action: 'set-channel-enabled',
      category: 'access-denial',
      outcome: 'denied',
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
    });

    const statusRaceIntegrationId = `synthetic-live-status-race-${suffix}`;
    const statusRaceLiveStatusId = randomUUID();
    const statusRaceIssuedAt = new Date(Date.now() - 1_000);
    const statusRaceAuthorization = liveAuthorizationFor({
      authenticated,
      integrationId: statusRaceIntegrationId,
      integrationStatusId: statusRaceLiveStatusId,
      previousConfiguration: null,
      issuedAt: statusRaceIssuedAt,
    });
    await database.insert(integrationStatuses).values({
      id: statusRaceLiveStatusId,
      integrationId: statusRaceIntegrationId,
      label: 'live-verified',
      verifiedAt: statusRaceIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: liveChannelChangeAuthorizationCommitment(
        statusRaceAuthorization,
      ),
      reasonCode: null,
      observedAt: statusRaceIssuedAt,
    });

    let releaseStatusRaceLock: (() => void) | undefined;
    const statusRaceLockReleased = new Promise<void>((resolve) => {
      releaseStatusRaceLock = resolve;
    });
    let confirmStatusRaceLock: ((pid: number) => void) | undefined;
    const statusRaceLockHeld = new Promise<number>((resolve) => {
      confirmStatusRaceLock = resolve;
    });
    const statusRaceBlocker = database.transaction(async (transaction) => {
      const [lock] = await transaction.execute<{ pid: number }>(
        sql`
          select
            pg_backend_pid()::int as pid,
            pg_advisory_xact_lock(hashtextextended(${statusRaceIntegrationId}, 0))
        `,
      );
      if (lock === undefined) {
        throw new Error('The status race advisory lock was not acquired.');
      }
      confirmStatusRaceLock?.(lock.pid);
      await statusRaceLockReleased;
    });
    const statusRaceBlockerPid = await statusRaceLockHeld;

    const statusRaceMutation = executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: statusRaceIntegrationId,
        enabled: true,
        authorization: statusRaceAuthorization,
      },
      metadata: metadata('live-status-race-enable', requestIds),
    });
    await waitForAdvisoryWaiters(database, 1, statusRaceBlockerPid);
    const statusRaceBlockedStatusId = randomUUID();
    const statusRaceBlockedObservedAt = new Date(
      Math.max(Date.now(), statusRaceIssuedAt.getTime() + 1),
    );
    const statusRaceStatusInsert = (async () => {
      await database.insert(integrationStatuses).values({
        id: statusRaceBlockedStatusId,
        integrationId: statusRaceIntegrationId,
        label: 'blocked',
        verifiedAt: null,
        verifiedByUserId: null,
        authorizationReference: null,
        reasonCode: 'PREREQUISITE_PENDING',
        observedAt: statusRaceBlockedObservedAt,
      });
    })();
    await waitForAdvisoryWaiters(database, 2, statusRaceBlockerPid);
    releaseStatusRaceLock?.();
    await statusRaceBlocker;

    const [statusRaceMutationResult, statusRaceInsertResult] =
      await Promise.allSettled([statusRaceMutation, statusRaceStatusInsert]);
    expect(statusRaceMutationResult.status).toBe('fulfilled');
    expect(statusRaceInsertResult.status).toBe('fulfilled');
    const [statusRaceConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
        statusLabel: channelConfigurations.statusLabel,
      })
      .from(channelConfigurations)
      .where(eq(channelConfigurations.integrationId, statusRaceIntegrationId))
      .limit(1);
    expect(statusRaceConfiguration).toEqual({
      enabled: false,
      statusId: statusRaceBlockedStatusId,
      statusLabel: 'blocked',
    });
    const statusRaceAuthorizationRows = await database
      .select({ id: integrationChannelChangeAuthorizations.id })
      .from(integrationChannelChangeAuthorizations)
      .where(
        eq(
          integrationChannelChangeAuthorizations.integrationStatusId,
          statusRaceLiveStatusId,
        ),
      );
    expect(statusRaceAuthorizationRows).toHaveLength(1);

    const liveIntegrationId = `synthetic-live-${suffix}`;
    const liveStatusId = randomUUID();
    const issuedAt = new Date(Date.now() - 1_000);
    const expiresAt = new Date(issuedAt.getTime() + 15 * 60 * 1_000);
    const issuedAtWithOffset = `${new Date(
      issuedAt.getTime() - 7 * 60 * 60 * 1_000,
    )
      .toISOString()
      .slice(0, -1)}-07:00`;
    const reference = `issue-26-live-${randomUUID()}`;
    const authorizationBase = {
      reference,
      integrationStatusId: liveStatusId,
      integrationId: liveIntegrationId,
      desiredEnabled: true,
      requestDigest: '0'.repeat(64),
      consequenceDigest: '0'.repeat(64),
      authorizedByUserId: authenticated.actor.userId,
      authorizedWithSessionId: authenticated.actor.sessionId,
      issuedAt: issuedAtWithOffset,
      expiresAt: expiresAt.toISOString(),
    } as const;
    const liveAuthorization = IntegrationChannelChangeAuthorizationSchema.parse(
      {
        ...authorizationBase,
        requestDigest: liveChannelChangeRequestDigest(authorizationBase),
        consequenceDigest: liveChannelChangeConsequenceDigest({
          integrationId: liveIntegrationId,
          previousConfiguration: null,
          desiredEnabled: true,
          integrationStatusId: liveStatusId,
        }),
      },
    );
    const authorizationCommitment =
      liveChannelChangeAuthorizationCommitment(liveAuthorization);
    await database.insert(integrationStatuses).values({
      id: liveStatusId,
      integrationId: liveIntegrationId,
      label: 'live-verified',
      verifiedAt: issuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: authorizationCommitment,
      reasonCode: null,
      observedAt: issuedAt,
    });
    const liveMetadata = metadata('live-channel-state', requestIds);
    const liveChannelResult = await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: liveIntegrationId,
        enabled: true,
        authorization: liveAuthorization,
      },
      metadata: liveMetadata,
    });
    expect(liveChannelResult).toMatchObject({
      integrationId: liveIntegrationId,
      enabled: true,
      status: { label: 'live-verified' },
    });
    expect(
      await executeSetChannelEnabledCapability({
        authenticated,
        store,
        command: {
          integrationId: liveIntegrationId,
          enabled: true,
          authorization: liveAuthorization,
        },
        metadata: replayMetadata(liveMetadata, requestIds),
      }),
    ).toEqual(liveChannelResult);
    const authorizationRows = await database
      .select({
        reference: integrationChannelChangeAuthorizations.reference,
        requestId: integrationChannelChangeAuthorizations.consumedRequestId,
      })
      .from(integrationChannelChangeAuthorizations)
      .where(
        eq(
          integrationChannelChangeAuthorizations.integrationStatusId,
          liveStatusId,
        ),
      );
    expect(authorizationRows).toEqual([
      { reference, requestId: liveMetadata.requestId },
    ]);

    const copiedReferenceRequestId = randomUUID();
    try {
      await executeSetChannelEnabledCapability({
        authenticated,
        store,
        command: {
          integrationId: liveIntegrationId,
          enabled: true,
          authorization: liveAuthorization,
        },
        metadata: {
          idempotencyKey: `issue-26-live-reuse-${randomUUID()}`,
          requestId: copiedReferenceRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected live authorization reuse to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(403);
    }
    const [persistedLiveConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
      })
      .from(channelConfigurations)
      .where(eq(channelConfigurations.integrationId, liveIntegrationId))
      .limit(1);
    expect(persistedLiveConfiguration).toEqual({
      enabled: true,
      statusId: liveStatusId,
    });
    const blockedStatusId = randomUUID();
    const blockedObservedAt = new Date(
      Math.max(Date.now(), issuedAt.getTime() + 1),
    );
    await database.insert(integrationStatuses).values({
      id: blockedStatusId,
      integrationId: liveIntegrationId,
      label: 'blocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: 'PREREQUISITE_PENDING',
      observedAt: blockedObservedAt,
    });
    const [blockedConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
        statusLabel: channelConfigurations.statusLabel,
      })
      .from(channelConfigurations)
      .where(eq(channelConfigurations.integrationId, liveIntegrationId))
      .limit(1);
    expect(blockedConfiguration).toEqual({
      enabled: false,
      statusId: blockedStatusId,
      statusLabel: 'blocked',
    });
    await expect(
      database
        .insert(integrationStatuses)
        .values({
          id: randomUUID(),
          integrationId: liveIntegrationId,
          label: 'configured-unverified',
          verifiedAt: null,
          verifiedByUserId: null,
          authorizationReference: null,
          reasonCode: null,
          observedAt: blockedObservedAt,
        })
        .execute(),
    ).rejects.toThrow();

    const agentActor = {
      kind: 'agent' as const,
      agentId: randomUUID(),
      apiKeyId: randomUUID(),
    };
    try {
      await executeCapability(
        setChannelEnabledRegistration,
        {
          integrationId: liveIntegrationId,
          enabled: true,
          authorization: liveAuthorization,
        },
        {
          actor: agentActor,
          source: 'agent-rest',
          scope: { facilityScope: { kind: 'district' } },
          requestId: randomUUID(),
          serverTime: new Date(),
          connectivityEpochId: null,
          mutation: {
            idempotencyKey: `issue-26-agent-live-${randomUUID()}`,
            transport: { kind: 'agent-rest-command', method: 'POST' },
            humanConfirmationId: null,
          },
        },
        store,
      );
      throw new Error('Expected an agent live change to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(403);
    }

    const expiredIntegrationId = `synthetic-expired-${suffix}`;
    const expiredStatusId = randomUUID();
    const expiredIssuedAt = new Date(Date.now() - 20 * 60 * 1_000);
    const expiredExpiresAt = new Date(
      expiredIssuedAt.getTime() + 15 * 60 * 1_000,
    );
    const expiredBase = {
      reference: `issue-26-expired-${randomUUID()}`,
      integrationStatusId: expiredStatusId,
      integrationId: expiredIntegrationId,
      desiredEnabled: true,
      requestDigest: '0'.repeat(64),
      consequenceDigest: '0'.repeat(64),
      authorizedByUserId: authenticated.actor.userId,
      authorizedWithSessionId: authenticated.actor.sessionId,
      issuedAt: expiredIssuedAt.toISOString(),
      expiresAt: expiredExpiresAt.toISOString(),
    } as const;
    const expiredAuthorization =
      IntegrationChannelChangeAuthorizationSchema.parse({
        ...expiredBase,
        requestDigest: liveChannelChangeRequestDigest(expiredBase),
        consequenceDigest: liveChannelChangeConsequenceDigest({
          integrationId: expiredIntegrationId,
          previousConfiguration: null,
          desiredEnabled: true,
          integrationStatusId: expiredStatusId,
        }),
      });
    await database.insert(integrationStatuses).values({
      id: expiredStatusId,
      integrationId: expiredIntegrationId,
      label: 'live-verified',
      verifiedAt: expiredIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference:
        liveChannelChangeAuthorizationCommitment(expiredAuthorization),
      reasonCode: null,
      observedAt: expiredIssuedAt,
    });
    for (const authorization of [null, expiredAuthorization]) {
      try {
        await executeSetChannelEnabledCapability({
          authenticated,
          store,
          command: {
            integrationId: expiredIntegrationId,
            enabled: true,
            authorization,
          },
          metadata: {
            idempotencyKey: `issue-26-expired-live-${randomUUID()}`,
            requestId: randomUUID(),
            now: new Date(),
          },
        });
        throw new Error(
          'Expected missing or expired live authorization to fail closed.',
        );
      } catch (error) {
        expect(error).toBeInstanceOf(AdminCapabilityError);
        expect((error as AdminCapabilityError).status).toBe(403);
      }
    }
    expect(
      await database
        .select({ id: channelConfigurations.integrationId })
        .from(channelConfigurations)
        .where(eq(channelConfigurations.integrationId, expiredIntegrationId)),
    ).toEqual([]);

    await executeUpdateFacilityCapability({
      authenticated,
      store,
      command: {
        facilityId: facility.id,
        code: facility.code,
        name: `${facility.name} revised`,
        active: true,
      },
      metadata: metadata('facility-update', requestIds),
    });
    try {
      await executeCreateFacilityCapability({
        authenticated,
        store,
        command: { code: facility.code, name: facility.name },
        metadata: replayMetadata(facilityMetadata),
      });
      throw new Error('Expected stale mutable replay to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }

    for (const source of [staffBuilding, syntheticBuilding]) {
      const population = source.kind === 'google-group' ? 'staff' : 'synthetic';
      const [configuration] = await database
        .select({
          id: rosterSourceConfigurations.id,
          version: rosterSourceConfigurations.version,
        })
        .from(rosterSourceConfigurations)
        .where(eq(rosterSourceConfigurations.population, population))
        .orderBy(desc(rosterSourceConfigurations.version))
        .limit(1);
      expect(configuration).toBeDefined();
      if (configuration === undefined) continue;
      const [facilityEvidence] = await database
        .select({ facilityId: rosterSourceConfigurationFacilities.facilityId })
        .from(rosterSourceConfigurationFacilities)
        .where(
          and(
            eq(
              rosterSourceConfigurationFacilities.configurationId,
              configuration.id,
            ),
            eq(
              rosterSourceConfigurationFacilities.configurationVersion,
              configuration.version,
            ),
            eq(rosterSourceConfigurationFacilities.facilityId, facility.id),
          ),
        )
        .limit(1);
      const [sourceEvidence] = await database
        .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
        .from(rosterSourceConfigurationGroups)
        .where(
          and(
            eq(
              rosterSourceConfigurationGroups.configurationId,
              configuration.id,
            ),
            eq(
              rosterSourceConfigurationGroups.configurationVersion,
              configuration.version,
            ),
            eq(rosterSourceConfigurationGroups.groupSourceId, source.id),
          ),
        )
        .limit(1);
      expect(facilityEvidence?.facilityId).toBe(facility.id);
      expect(sourceEvidence?.sourceId).toBe(source.id);
    }

    const auditRows = await database
      .select({
        requestId: securityAuditEntries.requestId,
        category: securityAuditEntries.category,
        outcome: securityAuditEntries.outcome,
      })
      .from(securityAuditEntries)
      .where(inArray(securityAuditEntries.requestId, requestIds));
    expect(auditRows).toHaveLength(requestIds.length);
    expect(
      auditRows.every(
        ({ category, outcome }) =>
          category === 'admin-change' && outcome === 'success',
      ),
    ).toBe(true);

    const missingFacilityRequestId = randomUUID();
    try {
      await executeRosterHealthProjection({
        authenticated,
        store,
        query: {
          population: 'staff',
          facilityId: randomUUID(),
          cursor: null,
          limit: 25,
        },
        metadata: { requestId: missingFacilityRequestId, now: new Date() },
      });
      throw new Error('Expected an unknown roster-health facility to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(404);
    }
    const [missingFacilityAudit] = await database
      .select({ requestId: securityAuditEntries.requestId })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, missingFacilityRequestId))
      .limit(1);
    expect(missingFacilityAudit?.requestId).toBe(missingFacilityRequestId);
  });

  test('rejects mismatched live authorization and enforces exact single use', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    await persistLiveAuthorizationActor(database, authenticated, 'primary');
    if (authenticated.actor.kind !== 'human') {
      throw new Error('The primary live authorization actor must be human.');
    }
    const differentHuman = authenticatedAdministrator();
    await persistLiveAuthorizationActor(database, differentHuman, 'other');
    const differentSession = {
      ...authenticated,
      actor: {
        kind: 'human' as const,
        userId: authenticated.actor.userId,
        sessionId: randomUUID(),
      },
    } as unknown as AuthenticatedSession;
    await persistLiveAuthorizationActor(
      database,
      differentSession,
      'different-session',
    );

    const mismatchIntegrationId = `synthetic-live-mismatch-${randomUUID()}`;
    const mismatchStatusId = randomUUID();
    const mismatchIssuedAt = new Date(Date.now() - 1_000);
    const validAuthorization = liveAuthorizationFor({
      authenticated,
      integrationId: mismatchIntegrationId,
      integrationStatusId: mismatchStatusId,
      previousConfiguration: null,
      issuedAt: mismatchIssuedAt,
    });
    await database.insert(integrationStatuses).values({
      id: mismatchStatusId,
      integrationId: mismatchIntegrationId,
      label: 'live-verified',
      verifiedAt: mismatchIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference:
        liveChannelChangeAuthorizationCommitment(validAuthorization),
      reasonCode: null,
      observedAt: mismatchIssuedAt,
    });

    const mismatchCases = [
      {
        label: 'different-human',
        caller: differentHuman,
        authorization: validAuthorization,
      },
      {
        label: 'different-session',
        caller: differentSession,
        authorization: validAuthorization,
      },
      {
        label: 'different-status',
        caller: authenticated,
        authorization: {
          ...validAuthorization,
          integrationStatusId: randomUUID(),
        },
      },
      {
        label: 'bad-request-digest',
        caller: authenticated,
        authorization: {
          ...validAuthorization,
          requestDigest: 'f'.repeat(64),
        },
      },
      {
        label: 'bad-consequence-digest',
        caller: authenticated,
        authorization: {
          ...validAuthorization,
          consequenceDigest: 'e'.repeat(64),
        },
      },
      {
        label: 'different-issued-at',
        caller: authenticated,
        authorization: {
          ...validAuthorization,
          issuedAt: new Date(mismatchIssuedAt.getTime() + 1).toISOString(),
        },
      },
    ] as const;
    for (const mismatch of mismatchCases) {
      const callerStore = createDrizzleAdminCapabilityStore(
        database,
        mismatch.caller,
      );
      try {
        await executeSetChannelEnabledCapability({
          authenticated: mismatch.caller,
          store: callerStore,
          command: {
            integrationId: mismatchIntegrationId,
            enabled: true,
            authorization: mismatch.authorization,
          },
          metadata: {
            idempotencyKey: `issue-26-live-mismatch-${mismatch.label}-${randomUUID()}`,
            requestId: randomUUID(),
            now: new Date(),
          },
        });
        throw new Error(
          `Expected ${mismatch.label} live authorization to fail closed.`,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(AdminCapabilityError);
        expect((error as AdminCapabilityError).status).toBe(403);
      }
    }
    expect(
      await database
        .select({ id: integrationChannelChangeAuthorizations.id })
        .from(integrationChannelChangeAuthorizations)
        .where(
          eq(
            integrationChannelChangeAuthorizations.integrationStatusId,
            mismatchStatusId,
          ),
        ),
    ).toEqual([]);
    expect(
      await database
        .select({ id: channelConfigurations.integrationId })
        .from(channelConfigurations)
        .where(eq(channelConfigurations.integrationId, mismatchIntegrationId)),
    ).toEqual([]);

    const singleUseIntegrationId = `synthetic-live-single-use-${randomUUID()}`;
    const singleUseStatusId = randomUUID();
    const singleUseIssuedAt = new Date(Date.now() - 1_000);
    const singleUseAuthorization = liveAuthorizationFor({
      authenticated,
      integrationId: singleUseIntegrationId,
      integrationStatusId: singleUseStatusId,
      previousConfiguration: {
        enabled: false,
        statusId: singleUseStatusId,
      },
      issuedAt: singleUseIssuedAt,
      desiredEnabled: false,
    });
    await database.insert(integrationStatuses).values({
      id: singleUseStatusId,
      integrationId: singleUseIntegrationId,
      label: 'live-verified',
      verifiedAt: singleUseIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: liveChannelChangeAuthorizationCommitment(
        singleUseAuthorization,
      ),
      reasonCode: null,
      observedAt: singleUseIssuedAt,
    });
    await database.insert(channelConfigurations).values({
      integrationId: singleUseIntegrationId,
      enabled: false,
      statusId: singleUseStatusId,
      statusLabel: 'live-verified',
      changedAt: singleUseIssuedAt,
    });
    const primaryStore = createDrizzleAdminCapabilityStore(
      database,
      authenticated,
    );
    const firstMetadata = {
      idempotencyKey: `issue-26-live-single-use-${randomUUID()}`,
      requestId: randomUUID(),
      now: new Date(),
    };
    const firstResult = await executeSetChannelEnabledCapability({
      authenticated,
      store: primaryStore,
      command: {
        integrationId: singleUseIntegrationId,
        enabled: false,
        authorization: singleUseAuthorization,
      },
      metadata: firstMetadata,
    });
    expect(firstResult).toMatchObject({
      integrationId: singleUseIntegrationId,
      enabled: false,
      status: { label: 'live-verified' },
    });
    expect(
      await executeSetChannelEnabledCapability({
        authenticated,
        store: primaryStore,
        command: {
          integrationId: singleUseIntegrationId,
          enabled: false,
          authorization: singleUseAuthorization,
        },
        metadata: {
          ...firstMetadata,
          requestId: randomUUID(),
          now: new Date(),
        },
      }),
    ).toEqual(firstResult);

    const reusedRequestId = randomUUID();
    try {
      await executeSetChannelEnabledCapability({
        authenticated,
        store: primaryStore,
        command: {
          integrationId: singleUseIntegrationId,
          enabled: false,
          authorization: singleUseAuthorization,
        },
        metadata: {
          idempotencyKey: `issue-26-live-single-use-reuse-${randomUUID()}`,
          requestId: reusedRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected a consumed live authorization to be refused.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(403);
    }
    const singleUseRows = await database
      .select({
        reference: integrationChannelChangeAuthorizations.reference,
        requestId: integrationChannelChangeAuthorizations.consumedRequestId,
      })
      .from(integrationChannelChangeAuthorizations)
      .where(
        eq(
          integrationChannelChangeAuthorizations.integrationStatusId,
          singleUseStatusId,
        ),
      );
    expect(singleUseRows).toEqual([
      {
        reference: singleUseAuthorization.reference,
        requestId: firstMetadata.requestId,
      },
    ]);
    const [reuseAudit] = await database
      .select({
        action: securityAuditEntries.action,
        category: securityAuditEntries.category,
        outcome: securityAuditEntries.outcome,
        reasonCode: securityAuditEntries.reasonCode,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, reusedRequestId))
      .limit(1);
    expect(reuseAudit).toEqual({
      action: 'set-channel-enabled',
      category: 'access-denial',
      outcome: 'denied',
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
    });
  });

  test('replaces immutable roster sources with derived versions and rejects stale concurrent replacements', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];

    const facility = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: {
        code: `RPL-${suffix.slice(0, 8).toUpperCase()}`,
        name: `Replacement test site ${suffix.slice(0, 8)}`,
      },
      metadata: metadata('replacement-facility', requestIds),
    });
    const originalBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} original staff`,
        active: true,
        googleGroupId: `replacement-original-${suffix}`,
        email: `replacement-original-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-building', requestIds),
    });
    const originalOthers = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: `Replacement others ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `replacement-others-${suffix}`,
        email: `replacement-others-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-others', requestIds),
    });
    const historicalAudience =
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: null,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: originalOthers.id,
                kind: 'google-group',
                purpose: 'others',
                facilityId: null,
              },
            },
          ],
        },
        metadata: metadata('replacement-audience', requestIds),
      });

    async function latestStaffConfiguration() {
      const [header] = await database
        .select({
          id: rosterSourceConfigurations.id,
          version: rosterSourceConfigurations.version,
        })
        .from(rosterSourceConfigurations)
        .where(eq(rosterSourceConfigurations.population, 'staff'))
        .orderBy(desc(rosterSourceConfigurations.version))
        .limit(1);
      if (header === undefined) {
        throw new Error('The staff roster configuration is missing.');
      }
      const groups = await database
        .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
        .from(rosterSourceConfigurationGroups)
        .where(
          and(
            eq(rosterSourceConfigurationGroups.configurationId, header.id),
            eq(
              rosterSourceConfigurationGroups.configurationVersion,
              header.version,
            ),
          ),
        )
        .orderBy(rosterSourceConfigurationGroups.groupSourceId);
      return { ...header, sourceIds: groups.map(({ sourceId }) => sourceId) };
    }

    const before = await latestStaffConfiguration();
    expect(before.sourceIds).toContain(originalBuilding.id);
    expect(before.sourceIds).toContain(originalOthers.id);
    const [latestStaffSnapshotBeforeReplacement] = await database
      .select({ version: rosterSnapshots.version })
      .from(rosterSnapshots)
      .where(eq(rosterSnapshots.population, 'staff'))
      .orderBy(desc(rosterSnapshots.version))
      .limit(1);
    const snapshotVersionBeforeReplacement =
      (latestStaffSnapshotBeforeReplacement?.version ?? 0) + 1;
    const snapshotBeforeReplacementAt = new Date();
    await database.insert(rosterSnapshots).values({
      id: randomUUID(),
      version: snapshotVersionBeforeReplacement,
      population: 'staff',
      complete: true,
      sourceConfigurationId: before.id,
      sourceConfigurationVersion: before.version,
      syncStartedAt: snapshotBeforeReplacementAt,
      capturedAt: snapshotBeforeReplacementAt,
    });
    const [originalRowBefore] = await database
      .select()
      .from(groupSources)
      .where(eq(groupSources.id, originalBuilding.id))
      .limit(1);

    try {
      await executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: originalBuilding.id,
          kind: 'google-group',
          purpose: 'building',
          facilityId: facility.id,
          displayName: 'Inactive replacement must fail closed',
          active: false,
          googleGroupId: `replacement-inactive-${suffix}`,
          email: `replacement-inactive-${suffix}@example.invalid`,
        },
        metadata: metadata('replacement-inactive', requestIds),
      });
      throw new Error('Expected an inactive replacement source to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    expect(await latestStaffConfiguration()).toEqual(before);
    const [inactiveReplacementRow] = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(eq(groupSources.googleGroupId, `replacement-inactive-${suffix}`))
      .limit(1);
    expect(inactiveReplacementRow).toBeUndefined();

    const replacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: originalBuilding.id,
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} replacement staff`,
        active: true,
        googleGroupId: `replacement-next-${suffix}`,
        email: `replacement-next-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-first', requestIds),
    });
    expect(replacement.id).not.toBe(originalBuilding.id);

    const after = await latestStaffConfiguration();
    expect(after.id).toBe(before.id);
    expect(after.version).toBe(before.version + 1);
    expect(after.sourceIds).toEqual(
      before.sourceIds
        .filter((sourceId) => sourceId !== originalBuilding.id)
        .concat(replacement.id)
        .sort(),
    );
    const snapshotAfterReplacementAt = new Date();
    await expect(
      database
        .insert(rosterSnapshots)
        .values({
          id: randomUUID(),
          version: snapshotVersionBeforeReplacement + 1,
          population: 'staff',
          complete: true,
          sourceConfigurationId: before.id,
          sourceConfigurationVersion: before.version,
          syncStartedAt: snapshotAfterReplacementAt,
          capturedAt: snapshotAfterReplacementAt,
        })
        .execute(),
    ).rejects.toThrow();
    await database.insert(rosterSnapshots).values({
      id: randomUUID(),
      version: snapshotVersionBeforeReplacement + 1,
      population: 'staff',
      complete: true,
      sourceConfigurationId: after.id,
      sourceConfigurationVersion: after.version,
      syncStartedAt: snapshotAfterReplacementAt,
      capturedAt: snapshotAfterReplacementAt,
    });
    const historicalGroups = await database
      .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
      .from(rosterSourceConfigurationGroups)
      .where(
        and(
          eq(rosterSourceConfigurationGroups.configurationId, before.id),
          eq(
            rosterSourceConfigurationGroups.configurationVersion,
            before.version,
          ),
        ),
      )
      .orderBy(rosterSourceConfigurationGroups.groupSourceId);
    expect(historicalGroups.map(({ sourceId }) => sourceId)).toEqual(
      before.sourceIds,
    );
    const [originalRowAfter] = await database
      .select()
      .from(groupSources)
      .where(eq(groupSources.id, originalBuilding.id))
      .limit(1);
    expect(originalRowAfter).toEqual(originalRowBefore);

    const activeBuildingSources = await executeListGroupSourcesCapability({
      authenticated,
      store,
      query: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        active: true,
        cursor: null,
        limit: 500,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    const inactiveBuildingSources = await executeListGroupSourcesCapability({
      authenticated,
      store,
      query: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        active: false,
        cursor: null,
        limit: 500,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(activeBuildingSources.items.map(({ id }) => id)).toContain(
      replacement.id,
    );
    expect(activeBuildingSources.items.map(({ id }) => id)).not.toContain(
      originalBuilding.id,
    );
    expect(inactiveBuildingSources.items.map(({ id }) => id)).toContain(
      originalBuilding.id,
    );
    expect(
      inactiveBuildingSources.items.find(({ id }) => id === originalBuilding.id)
        ?.active,
    ).toBe(false);

    try {
      await executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: originalBuilding.id,
          kind: 'google-group',
          purpose: 'building',
          facilityId: facility.id,
          displayName: 'Stale replacement must roll back',
          active: true,
          googleGroupId: `replacement-stale-${suffix}`,
          email: `replacement-stale-${suffix}@example.invalid`,
        },
        metadata: metadata('replacement-stale', requestIds),
      });
      throw new Error('Expected a stale source replacement to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    const [staleRow] = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(eq(groupSources.googleGroupId, `replacement-stale-${suffix}`))
      .limit(1);
    expect(staleRow).toBeUndefined();

    const concurrentCommands = [
      {
        id: replacement.id,
        kind: 'google-group' as const,
        purpose: 'building' as const,
        facilityId: facility.id,
        displayName: 'Concurrent replacement A',
        active: true,
        googleGroupId: `replacement-concurrent-a-${suffix}`,
        email: `replacement-concurrent-a-${suffix}@example.invalid`,
      },
      {
        id: replacement.id,
        kind: 'google-group' as const,
        purpose: 'building' as const,
        facilityId: facility.id,
        displayName: 'Concurrent replacement B',
        active: true,
        googleGroupId: `replacement-concurrent-b-${suffix}`,
        email: `replacement-concurrent-b-${suffix}@example.invalid`,
      },
    ];
    const concurrentResults = await Promise.allSettled(
      concurrentCommands.map((command, index) =>
        executeUpdateGroupSourceCapability({
          authenticated,
          store,
          command,
          metadata: metadata(`replacement-concurrent-${index}`, requestIds),
        }),
      ),
    );
    const fulfilled = concurrentResults.filter(
      (result) => result.status === 'fulfilled',
    );
    const rejected = concurrentResults.filter(
      (result) => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (fulfilled[0]?.status !== 'fulfilled') {
      throw new Error('The concurrent replacement winner is missing.');
    }
    expect(rejected[0]?.reason).toBeInstanceOf(AdminCapabilityError);
    expect((rejected[0]?.reason as AdminCapabilityError).status).toBe(409);
    const winner = fulfilled[0].value;
    const afterConcurrent = await latestStaffConfiguration();
    expect(afterConcurrent.version).toBe(after.version + 1);
    expect(afterConcurrent.sourceIds).toContain(winner.id);
    expect(afterConcurrent.sourceIds).not.toContain(replacement.id);
    const concurrentRows = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        inArray(
          groupSources.googleGroupId,
          concurrentCommands.map(({ googleGroupId }) => googleGroupId),
        ),
      );
    expect(concurrentRows).toEqual([{ id: winner.id }]);

    const othersReplacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: originalOthers.id,
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: 'Replacement others next',
        active: true,
        googleGroupId: `replacement-others-next-${suffix}`,
        email: `replacement-others-next-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-others-next', requestIds),
    });
    const afterOthers = await latestStaffConfiguration();
    expect(afterOthers.version).toBe(afterConcurrent.version + 1);
    expect(afterOthers.sourceIds).toContain(othersReplacement.id);
    expect(afterOthers.sourceIds).not.toContain(originalOthers.id);
    expect(afterOthers.sourceIds).toContain(winner.id);
    expect(afterOthers.sourceIds).not.toContain(originalBuilding.id);
    expect(afterOthers.sourceIds).not.toContain(replacement.id);

    const [audienceVersionCountBeforeRace] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(audienceConfigurations)
      .where(eq(audienceConfigurations.id, historicalAudience.id));
    let releaseRosterLock: (() => void) | undefined;
    const rosterLockReleased = new Promise<void>((resolve) => {
      releaseRosterLock = resolve;
    });
    let confirmRosterLock: (() => void) | undefined;
    const rosterLockHeld = new Promise<void>((resolve) => {
      confirmRosterLock = resolve;
    });
    const rosterLockBlocker = database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-roster-staff', 0))`,
      );
      confirmRosterLock?.();
      await rosterLockReleased;
    });
    await rosterLockHeld;

    const racingReplacement = executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: othersReplacement.id,
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: 'Replacement others race winner',
        active: true,
        googleGroupId: `replacement-others-race-${suffix}`,
        email: `replacement-others-race-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-others-race', requestIds),
    });
    await waitForAdvisoryWaiters(database, 1);
    const racingAudience = executeCreateAudienceConfigVersionCapability({
      authenticated,
      store,
      command: {
        audienceConfigId: historicalAudience.id,
        facilityId: facility.id,
        targets: [
          { kind: 'building', facilityId: facility.id },
          {
            kind: 'others',
            groupSourceRef: {
              id: othersReplacement.id,
              kind: 'google-group',
              purpose: 'others',
              facilityId: null,
            },
          },
        ],
      },
      metadata: metadata('replacement-audience-race', requestIds),
    });
    await waitForAdvisoryWaiters(database, 2);
    releaseRosterLock?.();
    await rosterLockBlocker;

    const [replacementRaceResult, audienceRaceResult] =
      await Promise.allSettled([racingReplacement, racingAudience]);
    expect(replacementRaceResult.status).toBe('fulfilled');
    expect(audienceRaceResult.status).toBe('rejected');
    if (audienceRaceResult.status !== 'rejected') {
      throw new Error('The stale racing audience unexpectedly committed.');
    }
    expect(audienceRaceResult.reason).toBeInstanceOf(AdminCapabilityError);
    expect((audienceRaceResult.reason as AdminCapabilityError).status).toBe(
      409,
    );
    const [audienceVersionCountAfterRace] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(audienceConfigurations)
      .where(eq(audienceConfigurations.id, historicalAudience.id));
    expect(audienceVersionCountAfterRace).toEqual(
      audienceVersionCountBeforeRace,
    );

    expect(
      await executeGetAudienceConfigCapability({
        authenticated,
        store,
        query: { facilityId: facility.id },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(historicalAudience);
    try {
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: historicalAudience.id,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: originalOthers.id,
                kind: 'google-group',
                purpose: 'others',
                facilityId: null,
              },
            },
          ],
        },
        metadata: metadata('replacement-stale-audience', requestIds),
      });
      throw new Error(
        'Expected a superseded others source to be refused in a new audience version.',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
  });

  test('replaces synthetic building and others sources without rewriting history', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];

    const facility = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: {
        code: `SYN-${suffix.slice(0, 8).toUpperCase()}`,
        name: `Synthetic replacement site ${suffix.slice(0, 8)}`,
      },
      metadata: metadata('synthetic-replacement-facility', requestIds),
    });
    const originalBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'synthetic',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} original synthetic building`,
        active: true,
        fixtureKey: `synthetic-building-${suffix}`,
      },
      metadata: metadata('synthetic-replacement-building', requestIds),
    });
    const originalOthers = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
        displayName: 'Original synthetic others',
        active: true,
        fixtureKey: `synthetic-others-${suffix}`,
      },
      metadata: metadata('synthetic-replacement-others', requestIds),
    });
    const historicalAudience =
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: null,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: originalOthers.id,
                kind: 'synthetic',
                purpose: 'others',
                facilityId: null,
              },
            },
          ],
        },
        metadata: metadata('synthetic-replacement-audience', requestIds),
      });

    async function latestSyntheticConfiguration() {
      const [header] = await database
        .select({
          id: rosterSourceConfigurations.id,
          version: rosterSourceConfigurations.version,
        })
        .from(rosterSourceConfigurations)
        .where(eq(rosterSourceConfigurations.population, 'synthetic'))
        .orderBy(desc(rosterSourceConfigurations.version))
        .limit(1);
      if (header === undefined) {
        throw new Error('The synthetic roster configuration is missing.');
      }
      const groups = await database
        .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
        .from(rosterSourceConfigurationGroups)
        .where(
          and(
            eq(rosterSourceConfigurationGroups.configurationId, header.id),
            eq(
              rosterSourceConfigurationGroups.configurationVersion,
              header.version,
            ),
          ),
        )
        .orderBy(rosterSourceConfigurationGroups.groupSourceId);
      return { ...header, sourceIds: groups.map(({ sourceId }) => sourceId) };
    }

    const before = await latestSyntheticConfiguration();
    expect(before.sourceIds).toContain(originalBuilding.id);
    expect(before.sourceIds).toContain(originalOthers.id);
    const originalRowsBefore = await database
      .select()
      .from(groupSources)
      .where(inArray(groupSources.id, [originalBuilding.id, originalOthers.id]))
      .orderBy(groupSources.id);

    const replacementBuilding = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: originalBuilding.id,
        kind: 'synthetic',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} corrected synthetic building`,
        active: true,
        fixtureKey: `synthetic-building-corrected-${suffix}`,
      },
      metadata: metadata('synthetic-building-corrected', requestIds),
    });
    const replacementOthers = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: originalOthers.id,
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
        displayName: 'Corrected synthetic others',
        active: true,
        fixtureKey: `synthetic-others-corrected-${suffix}`,
      },
      metadata: metadata('synthetic-others-corrected', requestIds),
    });

    const current = await latestSyntheticConfiguration();
    expect(current.id).toBe(before.id);
    expect(current.version).toBe(before.version + 2);
    expect(current.sourceIds).toContain(replacementBuilding.id);
    expect(current.sourceIds).toContain(replacementOthers.id);
    expect(current.sourceIds).not.toContain(originalBuilding.id);
    expect(current.sourceIds).not.toContain(originalOthers.id);
    const historicalSourceIds = await database
      .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
      .from(rosterSourceConfigurationGroups)
      .where(
        and(
          eq(rosterSourceConfigurationGroups.configurationId, before.id),
          eq(
            rosterSourceConfigurationGroups.configurationVersion,
            before.version,
          ),
        ),
      )
      .orderBy(rosterSourceConfigurationGroups.groupSourceId);
    expect(historicalSourceIds.map(({ sourceId }) => sourceId)).toEqual(
      before.sourceIds,
    );
    expect(
      await database
        .select()
        .from(groupSources)
        .where(
          inArray(groupSources.id, [originalBuilding.id, originalOthers.id]),
        )
        .orderBy(groupSources.id),
    ).toEqual(originalRowsBefore);

    const correctedAudience =
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: historicalAudience.id,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: replacementOthers.id,
                kind: 'synthetic',
                purpose: 'others',
                facilityId: null,
              },
            },
          ],
        },
        metadata: metadata('synthetic-audience-corrected', requestIds),
      });
    expect(correctedAudience).toMatchObject({
      id: historicalAudience.id,
      version: historicalAudience.version + 1,
    });
    expect(
      await executeGetAudienceConfigVersionCapability({
        authenticated,
        store,
        query: {
          audienceConfig: {
            id: historicalAudience.id,
            version: historicalAudience.version,
          },
        },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(historicalAudience);
    expect(
      await executeGetAudienceConfigCapability({
        authenticated,
        store,
        query: { facilityId: facility.id },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(correctedAudience);

    try {
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: historicalAudience.id,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: originalOthers.id,
                kind: 'synthetic',
                purpose: 'others',
                facilityId: null,
              },
            },
          ],
        },
        metadata: metadata('synthetic-stale-audience', requestIds),
      });
      throw new Error('Expected a superseded synthetic source to be refused.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
  });

  test('uses immutable filter-bound keysets and one audited complete facilities projection', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);

    const firstFacilitiesPage = await executeListFacilitiesCapability({
      authenticated,
      store,
      query: { includeInactive: true, cursor: null, limit: 1 },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    const facilityCursor = firstFacilitiesPage.pageInfo.nextCursor;
    const firstFacility = firstFacilitiesPage.items[0];
    if (facilityCursor === null || firstFacility === undefined) {
      throw new Error('The facility keyset fixture requires two facilities.');
    }
    await database.execute(sql`
      update facilities
      set code = ${`KEYSET-${randomUUID().slice(0, 8).toUpperCase()}`}
      where id = ${firstFacility.id}::uuid
    `);
    const secondFacilitiesPage = await executeListFacilitiesCapability({
      authenticated,
      store,
      query: {
        includeInactive: true,
        cursor: facilityCursor,
        limit: 1,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(secondFacilitiesPage.items.map(({ id }) => id)).not.toContain(
      firstFacility.id,
    );

    for (const query of [
      {
        includeInactive: false,
        cursor: facilityCursor,
        limit: 1,
      },
      {
        includeInactive: true,
        cursor: `${facilityCursor}A`,
        limit: 1,
      },
    ] as const) {
      try {
        await executeListFacilitiesCapability({
          authenticated,
          store,
          query,
          metadata: { requestId: randomUUID(), now: new Date() },
        });
        throw new Error('Expected the facility cursor to fail closed.');
      } catch (error) {
        expect(error).toBeInstanceOf(AdminCapabilityError);
        expect((error as AdminCapabilityError).status).toBe(400);
      }
    }
    try {
      await executeListNeighborhoodsCapability({
        authenticated,
        store,
        query: { cursor: facilityCursor, limit: 1 },
        metadata: { requestId: randomUUID(), now: new Date() },
      });
      throw new Error('Expected a cross-collection cursor to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(400);
    }

    const firstGroupsPage = await executeListGroupSourcesCapability({
      authenticated,
      store,
      query: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        active: null,
        cursor: null,
        limit: 1,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    const groupCursor = firstGroupsPage.pageInfo.nextCursor;
    const firstGroup = firstGroupsPage.items[0];
    if (groupCursor === null || firstGroup === undefined) {
      throw new Error('The group-source keyset fixture requires two groups.');
    }
    await database
      .update(groupSources)
      .set({ displayName: `Renamed cursor source ${randomUUID()}` })
      .where(eq(groupSources.id, firstGroup.id));
    const secondGroupsPage = await executeListGroupSourcesCapability({
      authenticated,
      store,
      query: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        active: null,
        cursor: groupCursor,
        limit: 1,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(secondGroupsPage.items.map(({ id }) => id)).not.toContain(
      firstGroup.id,
    );
    try {
      await executeListGroupSourcesCapability({
        authenticated,
        store,
        query: {
          kind: 'google-group',
          purpose: 'others',
          facilityId: null,
          active: null,
          cursor: groupCursor,
          limit: 1,
        },
        metadata: { requestId: randomUUID(), now: new Date() },
      });
      throw new Error('Expected a cross-filter group cursor to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(400);
    }

    const neighborhoodOne = await executeCreateNeighborhoodVersionCapability({
      authenticated,
      store,
      command: {
        neighborhoodId: null,
        name: `Keyset neighborhood ${randomUUID()}`,
        facilityIds: [firstFacility.id],
      },
      metadata: metadata('keyset-neighborhood-one', []),
    });
    await executeCreateNeighborhoodVersionCapability({
      authenticated,
      store,
      command: {
        neighborhoodId: neighborhoodOne.id,
        name: `${neighborhoodOne.name} v2`,
        facilityIds: [firstFacility.id],
      },
      metadata: metadata('keyset-neighborhood-two', []),
    });
    const firstVersionsPage = await executeListNeighborhoodVersionsCapability({
      authenticated,
      store,
      query: {
        neighborhoodId: neighborhoodOne.id,
        cursor: null,
        limit: 1,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    const versionCursor = firstVersionsPage.pageInfo.nextCursor;
    if (versionCursor === null) {
      throw new Error('The version keyset fixture requires a continuation.');
    }
    await executeCreateNeighborhoodVersionCapability({
      authenticated,
      store,
      command: {
        neighborhoodId: neighborhoodOne.id,
        name: `${neighborhoodOne.name} v3`,
        facilityIds: [firstFacility.id],
      },
      metadata: metadata('keyset-neighborhood-three', []),
    });
    const secondVersionsPage = await executeListNeighborhoodVersionsCapability({
      authenticated,
      store,
      query: {
        neighborhoodId: neighborhoodOne.id,
        cursor: versionCursor,
        limit: 1,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(firstVersionsPage.items.map(({ version }) => version)).toEqual([2]);
    expect(secondVersionsPage.items.map(({ version }) => version)).toEqual([1]);

    const projectionQueries = Object.freeze({
      facilities: { includeInactive: true, cursor: null, limit: 1 },
      neighborhoods: { cursor: null, limit: 1 },
      buildingGroups: {
        kind: null,
        purpose: 'building' as const,
        facilityId: null,
        active: null,
        cursor: null,
        limit: 1,
      },
      othersGroups: {
        kind: null,
        purpose: 'others' as const,
        facilityId: null,
        active: null,
        cursor: null,
        limit: 1,
      },
    });
    for (const invalidProjection of [
      {
        label: 'malformed-neighborhood',
        queries: {
          ...projectionQueries,
          neighborhoods: {
            ...projectionQueries.neighborhoods,
            cursor: '*',
          },
        },
      },
      {
        label: 'repeated-building',
        queries: {
          ...projectionQueries,
          buildingGroups: {
            ...projectionQueries.buildingGroups,
            cursor: ['first', 'second'] as unknown as string,
          },
        },
      },
    ] as const) {
      const requestId = randomUUID();
      await expect(
        executeFacilitiesAdminProjection({
          authenticated,
          store,
          queries: invalidProjection.queries,
          metadata: { requestId, now: new Date() },
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        reasonCode: 'CAPABILITY_INPUT_INVALID',
        status: 400,
      });
      const audits = await database
        .select({
          action: securityAuditEntries.action,
          outcome: securityAuditEntries.outcome,
          reasonCode: securityAuditEntries.reasonCode,
        })
        .from(securityAuditEntries)
        .where(eq(securityAuditEntries.requestId, requestId));
      expect(audits, invalidProjection.label).toEqual([
        {
          action: 'list-facilities',
          outcome: 'failure',
          reasonCode: 'CAPABILITY_INPUT_INVALID',
        },
      ]);
    }

    const projectionRequestId = randomUUID();
    const projection = await executeFacilitiesAdminProjection({
      authenticated,
      store,
      queries: projectionQueries,
      metadata: { requestId: projectionRequestId, now: new Date() },
    });
    expect(projection.facilities.items).toHaveLength(1);
    expect(projection.facilityOptions.length).toBeGreaterThan(1);
    expect(projection.neighborhoodOptions.length).toBeGreaterThan(1);
    expect(projection.buildingGroupOptions.length).toBeGreaterThanOrEqual(
      projection.buildingGroups.items.length,
    );
    expect(projection.othersGroupOptions.length).toBeGreaterThanOrEqual(
      projection.othersGroups.items.length,
    );
    const projectionAudits = await database
      .select({ requestId: securityAuditEntries.requestId })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, projectionRequestId));
    expect(projectionAudits).toEqual([{ requestId: projectionRequestId }]);
  });

  test('returns a byte-equivalent default projection when exact catalogs are reused', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const optimizedRequestId = randomUUID();
    const independentRequestId = randomUUID();
    const defaultRouteQueries = Object.freeze({
      facilities: { includeInactive: true, cursor: null, limit: 200 },
      neighborhoods: { cursor: null, limit: 200 },
      buildingGroups: {
        kind: null,
        purpose: 'building' as const,
        facilityId: null,
        active: null,
        cursor: null,
        limit: 500,
      },
      othersGroups: {
        kind: null,
        purpose: 'others' as const,
        facilityId: null,
        active: null,
        cursor: null,
        limit: 500,
      },
    });
    const independentCatalogQueries = Object.freeze({
      facilities: { ...defaultRouteQueries.facilities, limit: 199 },
      neighborhoods: { ...defaultRouteQueries.neighborhoods, limit: 199 },
      buildingGroups: { ...defaultRouteQueries.buildingGroups, limit: 499 },
      othersGroups: { ...defaultRouteQueries.othersGroups, limit: 499 },
    });

    const independentlyLoaded = await executeFacilitiesAdminProjection({
      authenticated,
      store,
      queries: independentCatalogQueries,
      metadata: { requestId: independentRequestId, now: new Date() },
    });
    const optimized = await executeFacilitiesAdminProjection({
      authenticated,
      store,
      queries: defaultRouteQueries,
      metadata: { requestId: optimizedRequestId, now: new Date() },
    });

    expect(independentlyLoaded.facilities.pageInfo.hasMore).toBe(false);
    expect(independentlyLoaded.neighborhoods.pageInfo.hasMore).toBe(false);
    expect(independentlyLoaded.buildingGroups.pageInfo.hasMore).toBe(false);
    expect(independentlyLoaded.othersGroups.pageInfo.hasMore).toBe(false);
    expect(
      optimized.neighborhoodOptions.some(
        ({ facilityIds }) => facilityIds.length > 0,
      ),
    ).toBe(true);
    expect(optimized.audienceConfigs.length).toBeGreaterThan(0);
    expect(optimized).toEqual(independentlyLoaded);
    expect(JSON.stringify(optimized)).toBe(JSON.stringify(independentlyLoaded));

    const projectionAudits = await database
      .select({
        action: securityAuditEntries.action,
        outcome: securityAuditEntries.outcome,
        requestId: securityAuditEntries.requestId,
      })
      .from(securityAuditEntries)
      .where(
        inArray(securityAuditEntries.requestId, [
          independentRequestId,
          optimizedRequestId,
        ]),
      )
      .orderBy(securityAuditEntries.requestId);
    expect(projectionAudits).toEqual(
      [independentRequestId, optimizedRequestId].sort().map((requestId) => ({
        action: 'list-facilities',
        outcome: 'success',
        requestId,
      })),
    );
  });
});
