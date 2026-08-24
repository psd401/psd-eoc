import { createHash, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';

import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../testing/owned-database-lifecycle';
import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  groupMembers,
  accessMembershipSnapshots,
  connectivityEpochs,
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  groupSources,
  idempotencyRecords,
  sessionRevocations,
  securityAuditEntries,
  sessions,
  sessionTokenIssuances,
  sessionTokenRotations,
  userRoleChanges,
  userRoles,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { ADMIN_AVAILABILITY_LOCK_SQL } from './role-state';
import {
  createDrizzleInitialWebSessionStore,
  type PersistInitialWebSessionRequest,
} from './session-cookie';
import {
  DrizzleSessionStore,
  SessionService,
  createDrizzleSessionCapabilityStore,
  executeRefreshSessionCapability,
  executeRevokeSessionCapability,
  hashRefreshToken,
  type SessionCapabilityStore,
} from './sessions';

function sessionCapabilityStore(
  service: SessionService,
): SessionCapabilityStore {
  return {
    transaction: (operation) =>
      operation({
        sessions: service,
        readCurrentTime: (receivedAt) => Promise.resolve(receivedAt),
        claimIdempotency: () =>
          Promise.reject(new Error('Unexpected engine idempotency claim.')),
        completeIdempotency: () =>
          Promise.reject(
            new Error('Unexpected engine idempotency completion.'),
          ),
        getHumanConfirmation: () => Promise.resolve(null),
        consumeHumanConfirmation: () => Promise.resolve(false),
        appendCapabilityAudit: () => Promise.resolve(),
      }),
    appendCapabilityAudit: () => Promise.resolve(),
  };
}

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;
let context: SessionTestContext | undefined;
let databaseCreated = false;

interface SessionTestContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

interface AdvisoryWaitRow extends Record<string, unknown> {
  readonly waiting_count: number;
}

interface ApplicationRoleRow extends Record<string, unknown> {
  readonly application_role: string;
}

interface SnapshotUpdatePrivilegeRow extends Record<string, unknown> {
  readonly table_name: string;
  readonly table_update: boolean;
  readonly update_columns: readonly string[];
}

interface DeferredSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i26_session_[a-f0-9]{32}_test$/u;
const DESIGNATED_ACCESS_GROUP_ID = '25200000-0000-4000-8000-000000000001';
const DESIGNATED_ACCESS_GROUP_EMAIL = 'tsd-engineering@example.invalid';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createDeferredSignal(): DeferredSignal {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The session integration database is not open.');
  }
  return connection;
}

/**
 * Seeds the trusted group and, when an address is given, that person's
 * membership in it. Sign-in reads membership, so a fixture that creates only
 * the group authorizes nobody.
 */
async function ensureDesignatedAccessGroup(
  database: PostgresDatabaseConnection['db'],
  createdAt: Date,
  memberEmail?: string,
): Promise<void> {
  await database
    .insert(groupSources)
    .values({
      id: DESIGNATED_ACCESS_GROUP_ID,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'Synthetic exact designated access group',
      active: true,
      // Staff, matching the accounts these fixtures create. Roles come from the
      // group, so a group granting admin would make every fixture user one.
      grantedRole: 'staff',
      googleGroupId: 'synthetic-exact-designated-access-group',
      email: DESIGNATED_ACCESS_GROUP_EMAIL,
      fixtureKey: null,
      createdAt,
      membersCapturedAt: createdAt,
    })
    .onConflictDoNothing();
  if (memberEmail !== undefined) {
    await database
      .insert(groupMembers)
      .values({
        groupSourceId: DESIGNATED_ACCESS_GROUP_ID,
        email: memberEmail.toLowerCase(),
        capturedAt: createdAt,
      })
      .onConflictDoNothing();
  }
}

function buildContext(baseDatabaseUrl: string): SessionTestContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i26_session_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable session database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-26:session-test:${runId}`,
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
    throw new Error('Session integration tests require PostgreSQL.');
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
    throw new Error('The disposable session database identity is ambiguous.');
  }
  return rows[0]?.marker;
}

async function createOwnedDatabase(
  createdContext: SessionTestContext,
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
      expect(await readDatabaseMarker(admin, createdContext.databaseName)).toBe(
        createdContext.marker,
      );
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(createdContext),
    failureMessage:
      'Disposable session database operation, creator close, or marker-owned rollback failed.',
  });
}

async function dropOwnedDatabase(
  createdContext: SessionTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(
        admin,
        createdContext.databaseName,
      );
      if (marker === undefined) return;
      if (marker !== createdContext.marker) {
        throw new Error(
          'Refusing to drop a database without the exact issue #26 session-test ownership marker.',
        );
      }
      await admin.db.execute(
        sql.raw(`drop database "${createdContext.databaseName}" with (force)`),
      );
      expect(
        await readDatabaseMarker(admin, createdContext.databaseName),
      ).toBeUndefined();
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Disposable session database cleanup and connection close both failed.',
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
      'Issue #26 session integration test cleanup failed.',
    );
  }
}

describeWithDatabase('PostgreSQL session effective-role projection', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      databaseCreated = true;
      await createOwnedDatabase(context);
      connection = openPostgresConnection(context.databaseUrl, 2);
      await migrateDatabase(connection);
      await ensureDesignatedAccessGroup(connection.db, new Date());
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Issue #26 session integration setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
  });

  test('reloads a retained session with the roles its trusted groups grant', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const snapshotId = randomUUID();
    const deviceEnrollmentId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const googleSubject = `issue-26-session-${suffix}`;

    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-session-${suffix}@example.invalid`,
      displayName: `Issue 26 session user ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: now,
    });
    await ensureDesignatedAccessGroup(
      database,
      now,
      `issue-26-session-${suffix}@example.invalid`,
    );
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: 2_100_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
        complete: true,
        syncStartedAt: now,
        capturedAt: now,
      });
    });
    await database.insert(deviceEnrollments).values({
      id: deviceEnrollmentId,
      userId,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `issue-26-session-${suffix}`,
      enrolledAt: now,
      lastSeenAt: now,
    });
    await database.insert(sessions).values({
      id: sessionId,
      userId,
      deviceEnrollmentId,
      membershipSnapshotId: snapshotId,
      membershipValidUntil: new Date(now.getTime() + 60 * 60 * 1_000),
      membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
    });
    await database.insert(connectivityEpochs).values({
      id: randomUUID(),
      sessionId,
      establishedAt: now,
    });
    await database.insert(userRoleChanges).values([
      {
        userId,
        role: 'admin',
        granted: true,
        changedByUserId: userId,
        changedWithSessionId: sessionId,
        requestId: randomUUID(),
        occurredAt: now,
      },
      {
        userId,
        role: 'staff',
        granted: false,
        changedByUserId: userId,
        changedWithSessionId: sessionId,
        requestId: randomUUID(),
        occurredAt: now,
      },
    ]);

    const context = await new DrizzleSessionStore(database).getSession(
      sessionId,
    );
    // The append-only grant and revocation facts above are deliberately
    // ignored. Roles are what the holder's trusted groups grant, decided on
    // every read, so a stored grant cannot outlive the group that justified it
    // and a stored revocation cannot take away what the group still gives.
    expect(context?.result.user.roles).toEqual(['staff']);
  });

  test('revocation append-unregisters only the target device push registrations idempotently', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const snapshotId = randomUUID();
    const targetDeviceId = randomUUID();
    const otherDeviceId = randomUUID();
    const targetSessionId = randomUUID();
    const otherSessionId = randomUUID();
    const targetRegistrationIds = [randomUUID(), randomUUID()] as const;
    const otherRegistrationId = randomUUID();
    const laterRegistrationId = randomUUID();
    const now = new Date();
    const revokedAt = new Date(now.getTime() + 1_000);
    const googleSubject = `issue-23-push-revoke-${suffix}`;

    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-23-push-revoke-${suffix}@example.invalid`,
      displayName: `Issue 23 push revoke ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: now,
    });
    await ensureDesignatedAccessGroup(
      database,
      now,
      `issue-23-push-revoke-${suffix}@example.invalid`,
    );
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: 2_116_800_000 + Number.parseInt(suffix.slice(0, 3), 16),
        complete: true,
        syncStartedAt: now,
        capturedAt: now,
      });
    });
    await database.insert(deviceEnrollments).values([
      {
        id: targetDeviceId,
        userId,
        platform: 'ios',
        unlockMethod: 'biometric',
        installationId: `issue-23-target-${suffix}`,
        enrolledAt: now,
        lastSeenAt: now,
      },
      {
        id: otherDeviceId,
        userId,
        platform: 'android',
        unlockMethod: 'biometric',
        installationId: `issue-23-other-${suffix}`,
        enrolledAt: now,
        lastSeenAt: now,
      },
    ]);
    await database.insert(sessions).values([
      {
        id: targetSessionId,
        userId,
        deviceEnrollmentId: targetDeviceId,
        membershipSnapshotId: snapshotId,
        membershipValidUntil: new Date(now.getTime() + 60 * 60 * 1_000),
        membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
      },
      {
        id: otherSessionId,
        userId,
        deviceEnrollmentId: otherDeviceId,
        membershipSnapshotId: snapshotId,
        membershipValidUntil: new Date(now.getTime() + 60 * 60 * 1_000),
        membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
      },
    ]);
    await database.insert(connectivityEpochs).values([
      {
        id: randomUUID(),
        sessionId: targetSessionId,
        establishedAt: now,
      },
      {
        id: randomUUID(),
        sessionId: otherSessionId,
        establishedAt: now,
      },
    ]);
    await database.insert(devicePushTokenRegistrations).values([
      {
        id: targetRegistrationIds[0],
        deviceEnrollmentId: targetDeviceId,
        platform: 'ios',
        token: `ExponentPushToken[issue-23-target-a-${suffix}]`,
        registeredAt: now,
      },
      {
        id: targetRegistrationIds[1],
        deviceEnrollmentId: targetDeviceId,
        platform: 'ios',
        token: `ExponentPushToken[issue-23-target-b-${suffix}]`,
        registeredAt: now,
      },
      {
        id: otherRegistrationId,
        deviceEnrollmentId: otherDeviceId,
        platform: 'android',
        token: `ExponentPushToken[issue-23-other-${suffix}]`,
        registeredAt: now,
      },
    ]);

    const store = new DrizzleSessionStore(database);
    const revocationInput = {
      actor: { kind: 'human' as const, userId, sessionId: targetSessionId },
      sessionId: targetSessionId,
      reasonCode: 'USER_REQUESTED_REVOCATION',
      idempotencyKey: `issue-23-push-revoke-${suffix}`,
      requestDigest: digest(`issue-23-push-revoke-request-${suffix}`),
      revokedAt,
    };
    const first = await store.revoke(revocationInput);
    const replay = await store.revoke(revocationInput);

    expect(replay).toEqual(first);
    const laterRegisteredAt = new Date(revokedAt.getTime() + 1_000);
    await database.insert(devicePushTokenRegistrations).values({
      id: laterRegistrationId,
      deviceEnrollmentId: targetDeviceId,
      platform: 'ios',
      token: `ExponentPushToken[issue-23-target-later-${suffix}]`,
      registeredAt: laterRegisteredAt,
    });
    await expect(
      store.revoke({
        ...revocationInput,
        idempotencyKey: `issue-23-push-revoke-second-${suffix}`,
        requestDigest: digest(`issue-23-push-revoke-second-${suffix}`),
        revokedAt: new Date(laterRegisteredAt.getTime() + 1_000),
      }),
    ).resolves.toEqual(first);

    const rotationId = randomUUID();
    const retiredDigest = digest(`issue-23-retired-${suffix}`);
    await database.insert(sessionTokenRotations).values({
      id: rotationId,
      sessionId: targetSessionId,
      previousTokenDigest: retiredDigest,
      nextTokenDigest: digest(`issue-23-successor-${suffix}`),
      rotatedAt: revokedAt,
    });
    await store.recordReplayAndRevoke({
      retired: {
        kind: 'retired',
        userId,
        sessionId: targetSessionId,
        deviceEnrollmentId: targetDeviceId,
        rotationId,
        tokenDigest: retiredDigest,
      },
      detectedAt: new Date(laterRegisteredAt.getTime() + 2_000),
    });

    const unregistrations = await database
      .select({
        registrationId: devicePushTokenUnregistrations.registrationId,
        deviceEnrollmentId: devicePushTokenUnregistrations.deviceEnrollmentId,
        unregisteredAt: devicePushTokenUnregistrations.unregisteredAt,
      })
      .from(devicePushTokenUnregistrations)
      .where(
        inArray(devicePushTokenUnregistrations.registrationId, [
          ...targetRegistrationIds,
          otherRegistrationId,
          laterRegistrationId,
        ]),
      );
    expect(
      unregistrations
        .map(({ registrationId }) => registrationId)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(
      [...targetRegistrationIds].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(
      unregistrations.every(
        ({ deviceEnrollmentId, unregisteredAt }) =>
          deviceEnrollmentId === targetDeviceId &&
          unregisteredAt.getTime() === revokedAt.getTime(),
      ),
    ).toBe(true);
    expect(
      await database
        .select({ id: devicePushTokenRegistrations.id })
        .from(devicePushTokenRegistrations)
        .where(
          inArray(devicePushTokenRegistrations.id, [
            ...targetRegistrationIds,
            otherRegistrationId,
            laterRegistrationId,
          ]),
        ),
    ).toHaveLength(4);
    expect(
      await database
        .select({ id: sessionRevocations.id })
        .from(sessionRevocations)
        .where(eq(sessionRevocations.sessionId, targetSessionId)),
    ).toHaveLength(1);
  });

  test('issues a session as the production role with only immutable snapshot lock-column privileges', async () => {
    const testContext = context;
    if (testContext === undefined) {
      throw new Error('The session integration test context is unavailable.');
    }
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const groupSourceId = DESIGNATED_ACCESS_GROUP_ID;
    const snapshotId = randomUUID();
    const snapshotVersion =
      2_117_000_000 + Number.parseInt(suffix.slice(0, 3), 16);
    const googleSubject = `issue-26-app-role-session-${suffix}`;
    const snapshotAt = new Date(Date.now() + 30_000);
    const createdAt = new Date(snapshotAt.getTime() + 1_000);

    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-app-role-session-${suffix}@example.invalid`,
      displayName: `Issue 26 app role user ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: snapshotAt,
    });
    await database.insert(userRoles).values({ userId, role: 'staff' });
    await database.insert(groupMembers).values({
      groupSourceId,
      email: `issue-26-app-role-session-${suffix}@example.invalid`,
      capturedAt: snapshotAt,
    });

    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: snapshotVersion,
        complete: true,
        syncStartedAt: snapshotAt,
        capturedAt: snapshotAt,
      });
    });

    const responseDigest = digest(`issue-26-app-role-response:${suffix}`);
    const principal = {
      kind: 'oidc-callback' as const,
      subjectDigest: digest(googleSubject),
      responseDigest,
    };
    const credentialDigest = digest(`issue-26-app-role-credential:${suffix}`);
    const request: PersistInitialWebSessionRequest = Object.freeze({
      user: Object.freeze({
        id: userId,
        googleSubject,
        email: `issue-26-app-role-session-${suffix}@example.invalid`,
        displayName: `Issue 26 app role user ${suffix.slice(0, 8)}`,
        roles: Object.freeze(['staff'] as const),
        facilityScope: Object.freeze({ kind: 'district' as const }),
        createdAt: snapshotAt.toISOString(),
        disabledAt: null,
      }),
      membership: Object.freeze({
        groupSourceIds: Object.freeze([groupSourceId]),
        capturedAt: snapshotAt,
      }),
      device: Object.freeze({
        platform: 'web' as const,
        unlockMethod: 'secure-session-cookie' as const,
        installationId: `issue-26-app-role-session-${suffix}`,
      }),
      credentialDigest,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1_000),
      membershipValidUntil: new Date(createdAt.getTime() + 60 * 60 * 1_000),
      membershipGraceUntil: new Date(createdAt.getTime() + 2 * 60 * 60 * 1_000),
      requestId: randomUUID(),
      idempotency: Object.freeze({
        key: `oidc:${responseDigest}`,
        principal,
        principalDigest: digest(JSON.stringify(principal)),
        requestDigest: digest(`issue-26-app-role-request:${suffix}`),
      }),
    });

    const roleConnection = openPostgresConnection(testContext.databaseUrl, 1);
    let roleSet = false;
    try {
      await roleConnection.db.execute(sql`set role psd_eoc_app`);
      roleSet = true;
      const [applicationRole] = databaseExecuteRows<ApplicationRoleRow>(
        await roleConnection.db.execute<ApplicationRoleRow>(sql`
          select current_user::text as application_role
        `),
      );
      expect(applicationRole).toEqual({ application_role: 'psd_eoc_app' });

      const result = await createDrizzleInitialWebSessionStore(
        roleConnection.db,
      ).persist(request);
      // Roles are what the trusted group grants; there is no bootstrap
      // administrator added at issuance any more.
      expect(result.user.roles).toEqual(['staff']);
      // A session is pinned to nothing. Authorization asks the trusted groups
      // about the present on every request, so there is no generation to
      // record and nothing to stamp.
      expect(result.session.authorization.membershipSnapshotId).toBeNull();

      const updatePrivileges = databaseExecuteRows<SnapshotUpdatePrivilegeRow>(
        await roleConnection.db.execute<SnapshotUpdatePrivilegeRow>(sql`
            with snapshot_tables(table_name) as (
              values
                ('access_membership_snapshots'::text)
            )
            select
              snapshot_tables.table_name,
              has_table_privilege(
                'psd_eoc_app',
                relations.oid,
                'UPDATE'
              ) as table_update,
              coalesce(
                jsonb_agg(attributes.attname order by attributes.attnum)
                  filter (
                    where has_column_privilege(
                      'psd_eoc_app',
                      relations.oid,
                      attributes.attnum,
                      'UPDATE'
                    )
                  ),
                '[]'::jsonb
              ) as update_columns
            from snapshot_tables
            inner join pg_catalog.pg_namespace namespaces
              on namespaces.nspname = 'public'
            inner join pg_catalog.pg_class relations
              on relations.relnamespace = namespaces.oid
              and relations.relname = snapshot_tables.table_name
            inner join pg_catalog.pg_attribute attributes
              on attributes.attrelid = relations.oid
              and attributes.attnum > 0
              and not attributes.attisdropped
            group by snapshot_tables.table_name, relations.oid
            order by snapshot_tables.table_name
        `),
      );
      expect(updatePrivileges).toEqual([
        {
          table_name: 'access_membership_snapshots',
          table_update: false,
          update_columns: ['id'],
        },
      ]);

      const [persistedSession] = await database
        .select({
          id: sessions.id,
          userId: sessions.userId,
          membershipSnapshotId: sessions.membershipSnapshotId,
        })
        .from(sessions)
        .where(eq(sessions.id, result.session.id));
      expect(persistedSession).toEqual({
        id: result.session.id,
        userId,
        membershipSnapshotId: null,
      });
      const [tokenIssuance] = await database
        .select({
          sessionId: sessionTokenIssuances.sessionId,
          tokenDigest: sessionTokenIssuances.tokenDigest,
        })
        .from(sessionTokenIssuances)
        .where(eq(sessionTokenIssuances.sessionId, result.session.id));
      expect(tokenIssuance).toEqual({
        sessionId: result.session.id,
        tokenDigest: credentialDigest,
      });
    } finally {
      if (roleSet) {
        await roleConnection.db.execute(sql`reset role`);
      }
      await roleConnection.close();
    }
  });

  test('takes the administrator lock before bootstrap issuance row locks', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const groupSourceId = DESIGNATED_ACCESS_GROUP_ID;
    const snapshotId = randomUUID();
    const googleSubject = `issue-26-bootstrap-lock-${suffix}`;
    const snapshotAt = new Date(Date.now() + 60_000);
    const createdAt = new Date(snapshotAt.getTime() + 1_000);

    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-bootstrap-lock-${suffix}@example.invalid`,
      displayName: `Issue 26 bootstrap candidate ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: snapshotAt,
    });
    await database.insert(userRoles).values({ userId, role: 'staff' });
    await database.insert(groupMembers).values({
      groupSourceId,
      email: `issue-26-bootstrap-lock-${suffix}@example.invalid`,
      capturedAt: snapshotAt,
    });

    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: 2_120_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
        complete: true,
        syncStartedAt: snapshotAt,
        capturedAt: snapshotAt,
      });
    });

    const responseDigest = digest(`issue-26-bootstrap-response:${suffix}`);
    const principal = {
      kind: 'oidc-callback' as const,
      subjectDigest: digest(googleSubject),
      responseDigest,
    };
    const request: PersistInitialWebSessionRequest = Object.freeze({
      user: Object.freeze({
        id: userId,
        googleSubject,
        email: `issue-26-bootstrap-lock-${suffix}@example.invalid`,
        displayName: `Issue 26 bootstrap candidate ${suffix.slice(0, 8)}`,
        roles: Object.freeze(['staff'] as const),
        facilityScope: Object.freeze({ kind: 'district' as const }),
        createdAt: snapshotAt.toISOString(),
        disabledAt: null,
      }),
      membership: Object.freeze({
        groupSourceIds: Object.freeze([groupSourceId]),
        capturedAt: snapshotAt,
      }),
      device: Object.freeze({
        platform: 'web' as const,
        unlockMethod: 'secure-session-cookie' as const,
        installationId: `issue-26-bootstrap-lock-${suffix}`,
      }),
      credentialDigest: digest(`issue-26-bootstrap-credential:${suffix}`),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1_000),
      membershipValidUntil: new Date(createdAt.getTime() + 60 * 60 * 1_000),
      membershipGraceUntil: new Date(createdAt.getTime() + 2 * 60 * 60 * 1_000),
      requestId: randomUUID(),
      idempotency: Object.freeze({
        key: `oidc:${responseDigest}`,
        principal,
        principalDigest: digest(JSON.stringify(principal)),
        requestDigest: digest(`issue-26-bootstrap-request:${suffix}`),
      }),
    });

    const holderReady = createDeferredSignal();
    const issuanceStarted = createDeferredSignal();
    const holderPromise = database.transaction(async (transaction) => {
      try {
        await transaction.execute(ADMIN_AVAILABILITY_LOCK_SQL);
        holderReady.resolve();
        await issuanceStarted.promise;

        let observedWaiter = false;
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const [row] = databaseExecuteRows<AdvisoryWaitRow>(
            await transaction.execute<AdvisoryWaitRow>(sql`
              select count(*)::integer as waiting_count
              from pg_locks held
              inner join pg_locks waiting
                on waiting.locktype = held.locktype
                and waiting.database is not distinct from held.database
                and waiting.classid is not distinct from held.classid
                and waiting.objid is not distinct from held.objid
                and waiting.objsubid is not distinct from held.objsubid
              where held.pid = pg_backend_pid()
                and held.locktype = 'advisory'
                and held.granted
                and waiting.pid <> held.pid
                and not waiting.granted
            `),
          );
          if (Number(row?.waiting_count ?? 0) > 0) {
            observedWaiter = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(observedWaiter).toBe(true);

        await transaction.execute(sql`set local lock_timeout = '1s'`);
        const lockedSnapshots = databaseExecuteRows<{ id: string }>(
          await transaction.execute<{ id: string }>(sql`
            select id
            from access_membership_snapshots
            where id = ${snapshotId}
            for update
          `),
        );
        expect(lockedSnapshots).toEqual([{ id: snapshotId }]);
      } catch (error) {
        holderReady.reject(error);
        throw error;
      }
    });
    void holderPromise.catch(() => undefined);

    await holderReady.promise;
    const issuancePromise =
      createDrizzleInitialWebSessionStore(database).persist(request);
    issuanceStarted.resolve();
    const [holderOutcome, issuanceOutcome] = await Promise.allSettled([
      holderPromise,
      issuancePromise,
    ]);
    if (holderOutcome.status === 'rejected') {
      throw holderOutcome.reason;
    }
    if (issuanceOutcome.status === 'rejected') {
      throw issuanceOutcome.reason;
    }
    // The point of this test is lock ordering, not the roles: issuance takes
    // the administrator-availability lock before its row locks, so it completes
    // rather than deadlocking against the holder. Roles are whatever the
    // trusted group grants.
    expect(issuanceOutcome.value.user.roles).toEqual(['staff']);
  });

  test('a refresh that loses the rotation race unregisters the revoked device push token', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const snapshotId = randomUUID();
    const deviceEnrollmentId = randomUUID();
    const sessionId = randomUUID();
    const issuanceId = randomUUID();
    const winningRotationId = randomUUID();
    const registrationId = randomUUID();
    const snapshotAt = new Date();
    const verifiedAt = new Date(snapshotAt.getTime() + 1_000);
    const rotatedAt = new Date(snapshotAt.getTime() + 2_000);
    const expiresAt = new Date(snapshotAt.getTime() + 3 * 60 * 60 * 1_000);
    const presentedToken = `issue-23-concurrent-refresh-presented-${suffix}`;
    const presentedTokenDigest = digest(presentedToken);
    const googleSubject = `issue-23-concurrent-refresh-${suffix}`;

    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-23-concurrent-refresh-${suffix}@example.invalid`,
      displayName: `Issue 23 concurrent refresh ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: snapshotAt,
    });
    await ensureDesignatedAccessGroup(
      database,
      snapshotAt,
      `issue-23-concurrent-refresh-${suffix}@example.invalid`,
    );
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: 2_146_000_000 + Number.parseInt(suffix.slice(0, 3), 16),
        complete: true,
        syncStartedAt: snapshotAt,
        capturedAt: snapshotAt,
      });
    });
    await database.insert(deviceEnrollments).values({
      id: deviceEnrollmentId,
      userId,
      platform: 'ios',
      unlockMethod: 'biometric',
      installationId: `issue-23-concurrent-refresh-${suffix}`,
      enrolledAt: snapshotAt,
      lastSeenAt: snapshotAt,
    });
    await database.insert(sessions).values({
      id: sessionId,
      userId,
      deviceEnrollmentId,
      membershipSnapshotId: snapshotId,
      membershipValidUntil: new Date(snapshotAt.getTime() + 60 * 60 * 1_000),
      membershipGraceUntil: new Date(
        snapshotAt.getTime() + 2 * 60 * 60 * 1_000,
      ),
      createdAt: snapshotAt,
      expiresAt,
    });
    await database.insert(sessionTokenIssuances).values({
      id: issuanceId,
      sessionId,
      tokenDigest: presentedTokenDigest,
      issuedAt: snapshotAt,
    });
    await database.insert(connectivityEpochs).values({
      id: randomUUID(),
      sessionId,
      establishedAt: snapshotAt,
    });
    await database.insert(devicePushTokenRegistrations).values({
      id: registrationId,
      deviceEnrollmentId,
      platform: 'ios',
      token: `ExponentPushToken[issue-23-concurrent-refresh-${suffix}]`,
      registeredAt: snapshotAt,
    });

    let raceInjected = false;
    class RaceInjectingSessionStore extends DrizzleSessionStore {
      public override async inspectCredential(tokenDigest: string, now?: Date) {
        const credential = await super.inspectCredential(tokenDigest, now);
        if (!raceInjected) {
          raceInjected = true;
          await database.insert(sessionTokenRotations).values({
            id: winningRotationId,
            sessionId,
            previousTokenDigest: presentedTokenDigest,
            nextTokenDigest: digest(
              `issue-23-concurrent-refresh-winner-${suffix}`,
            ),
            rotatedAt: verifiedAt,
          });
        }
        return credential;
      }
    }
    const service = new SessionService(new RaceInjectingSessionStore(database));
    const requestId = randomUUID();
    await expect(
      executeRefreshSessionCapability({
        service,
        capabilityStore: createDrizzleSessionCapabilityStore(database),
        token: presentedToken,
        source: 'mobile',
        idempotencyKey: `issue-23-concurrent-refresh-${suffix}`,
        csrfVerified: false,
        requestId,
        now: rotatedAt,
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_REPLAY' });
    expect(raceInjected).toBe(true);

    expect(
      await database
        .select({
          registrationId: devicePushTokenUnregistrations.registrationId,
          deviceEnrollmentId: devicePushTokenUnregistrations.deviceEnrollmentId,
          unregisteredAt: devicePushTokenUnregistrations.unregisteredAt,
        })
        .from(devicePushTokenUnregistrations)
        .where(
          eq(devicePushTokenUnregistrations.registrationId, registrationId),
        ),
    ).toEqual([
      {
        registrationId,
        deviceEnrollmentId,
        unregisteredAt: rotatedAt,
      },
    ]);
    expect(
      await database
        .select({ id: devicePushTokenRegistrations.id })
        .from(devicePushTokenRegistrations)
        .where(eq(devicePushTokenRegistrations.id, registrationId)),
    ).toHaveLength(1);
    expect(
      await database
        .select({ id: sessionRevocations.id })
        .from(sessionRevocations)
        .where(eq(sessionRevocations.sessionId, sessionId)),
    ).toHaveLength(1);
    expect(
      await database
        .select({
          action: securityAuditEntries.action,
          outcome: securityAuditEntries.outcome,
          requestId: securityAuditEntries.requestId,
        })
        .from(securityAuditEntries)
        .where(eq(securityAuditEntries.requestId, requestId)),
    ).toEqual([{ action: 'refresh-session', outcome: 'denied', requestId }]);
  });

  test('recovers only the exact completed self-revocation receipt after a service restart', async () => {
    const sharedContext = context;
    if (sharedContext === undefined) {
      throw new Error('The session integration test context is unavailable.');
    }
    const recoveryContext = buildContext(sharedContext.baseDatabaseUrl);
    await createOwnedDatabase(recoveryContext);
    const recoveryConnection = openPostgresConnection(
      recoveryContext.databaseUrl,
      2,
    );
    try {
      await migrateDatabase(recoveryConnection);
      const database = recoveryConnection.db;
      const suffix = randomUUID();
      const userId = randomUUID();
      const snapshotId = randomUUID();
      const snapshotAt = new Date();
      const issuedAt = new Date(snapshotAt.getTime() + 1_000);
      const googleSubject = `issue-23-revoke-recovery-${suffix}`;

      await ensureDesignatedAccessGroup(
        database,
        snapshotAt,
        `issue-23-revoke-recovery-${suffix}@example.invalid`,
      );
      await database.insert(users).values({
        id: userId,
        googleSubject,
        email: `issue-23-revoke-recovery-${suffix}@example.invalid`,
        displayName: `Issue 23 revoke recovery ${suffix.slice(0, 8)}`,
        facilityScopeKind: 'district',
        createdAt: snapshotAt,
      });
      await database.insert(userRoles).values({ userId, role: 'staff' });
      await database.transaction(async (transaction) => {
        await transaction.insert(accessMembershipSnapshots).values({
          id: snapshotId,
          version: 2_130_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
          complete: true,
          syncStartedAt: snapshotAt,
          capturedAt: snapshotAt,
        });
      });

      const firstService = new SessionService(
        new DrizzleSessionStore(database),
      );
      const issued = await firstService.establish(
        {
          userId,
          membershipSnapshotId: snapshotId,
          device: {
            platform: 'ios',
            unlockMethod: 'biometric',
            installationId: `issue-23-revoke-recovery-${suffix}`,
          },
        },
        issuedAt,
      );
      const authenticated = await firstService.authenticate(
        issued.refreshToken,
        'mobile',
        new Date(issuedAt.getTime() + 1_000),
      );
      const revokeInput = {
        sessionId: issued.result.session.id,
        reasonCode: 'USER_REQUESTED_REVOCATION',
      } as const;
      const idempotencyKey = `issue-23-revoke-recovery-${suffix}`;
      const canonical = await executeRevokeSessionCapability({
        service: firstService,
        capabilityStore: sessionCapabilityStore(firstService),
        authenticated,
        ...revokeInput,
        idempotencyKey,
        csrfVerified: false,
        now: new Date(issuedAt.getTime() + 2_000),
      });
      await expect(
        firstService.authenticate(
          issued.refreshToken,
          'mobile',
          new Date(issuedAt.getTime() + 3_000),
        ),
      ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });

      const restartedService = new SessionService(
        new DrizzleSessionStore(database),
      );
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          issued.refreshToken,
          'mobile',
          revokeInput,
          idempotencyKey,
        ),
      ).resolves.toEqual(canonical);
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          issued.refreshToken,
          'web',
          revokeInput,
          idempotencyKey,
        ),
      ).resolves.toBeNull();
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          issued.refreshToken,
          'mobile',
          { ...revokeInput, sessionId: randomUUID() },
          idempotencyKey,
        ),
      ).resolves.toBeNull();
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          issued.refreshToken,
          'mobile',
          { ...revokeInput, reasonCode: 'DIFFERENT_REASON' },
          idempotencyKey,
        ),
      ).resolves.toBeNull();
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          issued.refreshToken,
          'mobile',
          revokeInput,
          `issue-23-wrong-revoke-key-${suffix}`,
        ),
      ).resolves.toBeNull();
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          'Z'.repeat(43),
          'mobile',
          revokeInput,
          idempotencyKey,
        ),
      ).resolves.toBeNull();

      const rotatedIssued = await firstService.establish(
        {
          userId,
          membershipSnapshotId: snapshotId,
          device: {
            platform: 'android',
            unlockMethod: 'biometric',
            installationId: `issue-23-revoke-retired-${suffix}`,
          },
        },
        new Date(issuedAt.getTime() + 4_000),
      );
      const refreshed = await executeRefreshSessionCapability({
        service: firstService,
        capabilityStore: sessionCapabilityStore(firstService),
        token: rotatedIssued.refreshToken,
        source: 'mobile',
        idempotencyKey: `issue-23-revoke-rotate-${suffix}`,
        csrfVerified: false,
        now: new Date(issuedAt.getTime() + 5_000),
      });
      const refreshedAuthentication = await firstService.authenticate(
        refreshed.refreshToken,
        'mobile',
        new Date(issuedAt.getTime() + 6_000),
      );
      const rotatedRevokeInput = {
        sessionId: refreshed.result.session.id,
        reasonCode: 'USER_REQUESTED_REVOCATION',
      } as const;
      const rotatedRevokeKey = `issue-23-revoke-retired-key-${suffix}`;
      await executeRevokeSessionCapability({
        service: firstService,
        capabilityStore: sessionCapabilityStore(firstService),
        authenticated: refreshedAuthentication,
        ...rotatedRevokeInput,
        idempotencyKey: rotatedRevokeKey,
        csrfVerified: false,
        now: new Date(issuedAt.getTime() + 7_000),
      });
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          rotatedIssued.refreshToken,
          'mobile',
          rotatedRevokeInput,
          rotatedRevokeKey,
        ),
      ).resolves.toBeNull();

      const incompleteIssued = await firstService.establish(
        {
          userId,
          membershipSnapshotId: snapshotId,
          device: {
            platform: 'ios',
            unlockMethod: 'biometric',
            installationId: `issue-23-revoke-incomplete-${suffix}`,
          },
        },
        new Date(issuedAt.getTime() + 8_000),
      );
      const incompleteInput = {
        sessionId: incompleteIssued.result.session.id,
        reasonCode: 'USER_REQUESTED_REVOCATION',
      } as const;
      const incompletePrincipal = {
        kind: 'human' as const,
        userId,
        sessionId: incompleteIssued.result.session.id,
      };
      const incompleteKey = `issue-23-revoke-incomplete-${suffix}`;
      const incompleteAt = new Date(issuedAt.getTime() + 9_000);
      await database.insert(sessionRevocations).values({
        id: randomUUID(),
        sessionId: incompleteInput.sessionId,
        revokedBy: incompletePrincipal,
        reasonCode: incompleteInput.reasonCode,
        revokedAt: incompleteAt,
      });
      await database.insert(idempotencyRecords).values({
        id: randomUUID(),
        key: incompleteKey,
        capabilityId: 'revoke-session',
        principal: incompletePrincipal,
        principalDigest: digest(JSON.stringify(incompletePrincipal)),
        requestDigest: digest(
          JSON.stringify({
            capabilityId: 'revoke-session',
            input: incompleteInput,
            source: 'mobile',
            presentedTokenDigest: hashRefreshToken(
              incompleteIssued.refreshToken,
            ),
          }),
        ),
        status: 'in-progress',
        createdAt: incompleteAt,
        completedAt: null,
        resultReference: null,
      });
      await expect(
        restartedService.recoverCompletedSelfRevocation(
          incompleteIssued.refreshToken,
          'mobile',
          incompleteInput,
          incompleteKey,
        ),
      ).resolves.toBeNull();
    } finally {
      await recoveryConnection.close();
      await dropOwnedDatabase(recoveryContext);
    }
  });
});
