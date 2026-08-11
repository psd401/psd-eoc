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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
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
  securityAuditEntries,
  sessions,
  userRoleChanges,
  userRoles,
  users,
} from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import { createDrizzleAccessGateStore } from '../../../lib/auth/access-gate';
import {
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
  executeCreateAudienceConfigVersionCapability,
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeCreateNeighborhoodVersionCapability,
  executeGetAudienceConfigCapability,
  executeGetAudienceConfigVersionCapability,
  executeGetNeighborhoodVersionCapability,
  executeListGroupSourcesCapability,
  executeListNeighborhoodsCapability,
  executeUpdateFacilityCapability,
  executeUpdateGroupSourceCapability,
} from './capabilities';

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
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  let created = false;
  try {
    await admin.db.execute(
      sql.raw(`create database "${createdContext.databaseName}"`),
    );
    created = true;
    await admin.db.execute(
      sql.raw(
        `comment on database "${createdContext.databaseName}" is ${quotedLiteral(createdContext.marker)}`,
      ),
    );
    expect(await readDatabaseMarker(admin, createdContext.databaseName)).toBe(
      createdContext.marker,
    );
  } catch (error) {
    if (created) {
      try {
        await admin.db.execute(
          sql.raw(
            `drop database "${createdContext.databaseName}" with (force)`,
          ),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Disposable facilities database creation and rollback both failed.',
        );
      }
    }
    throw error;
  } finally {
    await admin.close();
  }
}

async function dropOwnedDatabase(
  createdContext: FacilitiesTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  try {
    const marker = await readDatabaseMarker(admin, createdContext.databaseName);
    if (marker === undefined) return;
    if (marker !== createdContext.marker) {
      throw new Error(
        'Refusing to drop a database without the exact issue #26 facilities ownership marker.',
      );
    }
    await admin.db.execute(
      sql.raw(`drop database "${createdContext.databaseName}" with (force)`),
    );
    expect(
      await readDatabaseMarker(admin, createdContext.databaseName),
    ).toBeUndefined();
  } finally {
    await admin.close();
  }
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
  readonly membershipSnapshot: PersistInitialWebSessionRequest['membershipSnapshot'];
  readonly membershipMember: PersistInitialWebSessionRequest['membershipMember'];
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
    membershipSnapshot: input.membershipSnapshot,
    membershipMember: input.membershipMember,
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
    grantBootstrapAdmin: true,
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digest(JSON.stringify(principal)),
      requestDigest: digest(`request:${input.label}`),
    },
  });
}

async function persistAuthenticatedAdministrator(
  database: PostgresDatabaseConnection['db'],
  authenticated: AuthenticatedSession,
  accessGroupId: string,
  suffix: string,
): Promise<void> {
  if (authenticated.actor.kind !== 'human') {
    throw new Error('The synthetic administrator must be human.');
  }
  const now = new Date();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  const graceUntil = new Date(now.getTime() + 48 * 60 * 60 * 1_000);
  const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1_000);
  const snapshotId = randomUUID();
  const deviceId = randomUUID();
  const snapshotVersion = Number.parseInt(suffix.slice(0, 7), 16) + 1;

  await database.insert(users).values({
    id: authenticated.actor.userId,
    googleSubject: `issue-26-admin-subject-${suffix}`,
    email: `issue-26-admin-${suffix}@psd401.net`,
    displayName: `Issue 26 synthetic administrator ${suffix.slice(0, 8)}`,
    facilityScopeKind: 'district',
    createdAt: now,
  });
  await database.insert(userRoles).values({
    userId: authenticated.actor.userId,
    role: 'admin',
  });
  await database.insert(accessMembershipSnapshots).values({
    id: snapshotId,
    version: snapshotVersion,
    complete: true,
    syncStartedAt: now,
    capturedAt: now,
  });
  await database.insert(accessMembershipSnapshotGroups).values([
    {
      snapshotId,
      groupSourceId: accessGroupId,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
      completionKind: 'expected',
    },
    {
      snapshotId,
      groupSourceId: accessGroupId,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
      completionKind: 'completed',
    },
  ]);
  await database.insert(accessMembershipMembers).values({
    snapshotId,
    userId: authenticated.actor.userId,
    googleSubject: `issue-26-admin-subject-${suffix}`,
    facilityScopeKind: 'district',
  });
  await database.insert(accessMembershipMemberGroups).values({
    snapshotId,
    userId: authenticated.actor.userId,
    groupSourceId: accessGroupId,
    groupSourceKind: 'google-group',
    groupPurpose: 'access',
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
    membershipSnapshotId: snapshotId,
    membershipValidUntil: validUntil,
    membershipGraceUntil: graceUntil,
    createdAt: now,
    expiresAt,
  });
}

async function persistLiveAuthorizationActor(
  database: PostgresDatabaseConnection['db'],
  authenticated: AuthenticatedSession,
  label: string,
): Promise<void> {
  if (authenticated.actor.kind !== 'human') {
    throw new Error('A live authorization actor must be human.');
  }
  const [membershipSnapshot] = await database
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
    await database.insert(accessMembershipMembers).values({
      snapshotId: membershipSnapshot.id,
      userId: authenticated.actor.userId,
      googleSubject,
      facilityScopeKind: 'district',
    });
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

  test('serializes concurrent access-group deactivation without a row-lock deadlock', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];
    const first = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: `Concurrent access A ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-race-a-${suffix}`,
        email: `issue-26-access-race-a-${suffix}@example.invalid`,
      },
      metadata: metadata('access-race-a', requestIds),
    });
    const second = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: `Concurrent access B ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-race-b-${suffix}`,
        email: `issue-26-access-race-b-${suffix}@example.invalid`,
      },
      metadata: metadata('access-race-b', requestIds),
    });

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
        sql`select pg_advisory_xact_lock(hashtextextended('admin-access-group-active-set', 0))`,
      );
      confirmActiveSetLock?.();
      await activeSetLockReleased;
    });
    await activeSetLockHeld;

    const deactivations = [first, second].map((source, index) => {
      if (source.kind !== 'google-group' || source.purpose !== 'access') {
        throw new Error('The access-group race fixture is invalid.');
      }
      return executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: source.id,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
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

    const activeRows = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        and(
          inArray(groupSources.id, [first.id, second.id]),
          eq(groupSources.active, true),
        ),
      );
    expect(activeRows).toHaveLength(1);
  });

  test('configures a complete new site and records every mutation', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];

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

    const staffBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} staff`,
        active: true,
        googleGroupId: `issue-26-staff-${suffix}`,
        email: `issue-26-staff-${suffix}@example.invalid`,
      },
      metadata: metadata('staff-building', requestIds),
    });
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
    const accessGroup = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: `Issue 26 access ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-${suffix}`,
        email: `issue-26-access-${suffix}@example.invalid`,
      },
      metadata: metadata('access-group', requestIds),
    });
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
    await database.insert(users).values({
      id: inaccessibleAdministratorId,
      googleSubject: `issue-26-inaccessible-admin-${suffix}`,
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
    const [latestAccessSnapshot] = await database
      .select({ version: accessMembershipSnapshots.version })
      .from(accessMembershipSnapshots)
      .orderBy(desc(accessMembershipSnapshots.version))
      .limit(1);
    const bootstrapSnapshotId = randomUUID();
    const bootstrapSnapshotAt = new Date(Date.now() + 60_000);
    const bootstrapSnapshotVersion = (latestAccessSnapshot?.version ?? 0) + 1;
    await database.insert(accessMembershipSnapshots).values({
      id: bootstrapSnapshotId,
      version: bootstrapSnapshotVersion,
      complete: true,
      syncStartedAt: bootstrapSnapshotAt,
      capturedAt: bootstrapSnapshotAt,
    });
    await database.insert(accessMembershipSnapshotGroups).values(
      activeAccessGroups.flatMap((group) => [
        {
          snapshotId: bootstrapSnapshotId,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
          completionKind: 'expected' as const,
        },
        {
          snapshotId: bootstrapSnapshotId,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
          completionKind: 'completed' as const,
        },
      ]),
    );
    await database.insert(accessMembershipMembers).values([
      {
        snapshotId: bootstrapSnapshotId,
        userId: authenticated.actor.userId,
        googleSubject: primaryAdministratorRow.googleSubject,
        facilityScopeKind: 'district',
      },
      {
        snapshotId: bootstrapSnapshotId,
        userId: roleTargetId,
        googleSubject: roleTargetRow.googleSubject,
        facilityScopeKind: 'district',
      },
    ]);
    await database.insert(accessMembershipMemberGroups).values([
      {
        snapshotId: bootstrapSnapshotId,
        userId: authenticated.actor.userId,
        groupSourceId: accessGroup.id,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
      },
      {
        snapshotId: bootstrapSnapshotId,
        userId: roleTargetId,
        groupSourceId: accessGroup.id,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
      },
    ]);
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
    const bootstrapMembershipSnapshot = {
      id: bootstrapSnapshotId,
      version: bootstrapSnapshotVersion,
      complete: true as const,
      syncStartedAt: bootstrapSnapshotAt.toISOString(),
      capturedAt: bootstrapSnapshotAt.toISOString(),
    };
    const bootstrapMembershipMember = {
      userId: roleTargetId,
      googleSubject: roleTargetRow.googleSubject,
      accessGroupSourceRefs: [
        {
          id: accessGroup.id,
          kind: 'google-group' as const,
          purpose: 'access' as const,
          facilityId: null,
        },
      ],
      facilityScope: { kind: 'district' as const },
    };
    const initialSessionStore = createDrizzleInitialWebSessionStore(database);
    const firstBootstrapSession = await initialSessionStore.persist(
      bootstrapSessionRequest({
        label: `first-${suffix}`,
        user: bootstrapUser,
        membershipSnapshot: bootstrapMembershipSnapshot,
        membershipMember: bootstrapMembershipMember,
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
        membershipSnapshot: bootstrapMembershipSnapshot,
        membershipMember: bootstrapMembershipMember,
        createdAt: new Date(bootstrapSnapshotAt.getTime() + 2_000),
      }),
    );
    expect(secondBootstrapSession.user.roles).toEqual(['staff']);
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
    const inaccessibleEvidence = await createDrizzleAccessGateStore(
      database,
    ).loadEvidence(`issue-26-inaccessible-admin-${suffix}`);
    expect(inaccessibleEvidence.user?.roles).toEqual(['staff', 'admin']);
    expect(inaccessibleEvidence.snapshot?.member).toBeNull();

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
});
