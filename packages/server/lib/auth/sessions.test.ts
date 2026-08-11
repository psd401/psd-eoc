import { createHash, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';

import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../app/(admin)/facilities/owned-database-lifecycle';
import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  connectivityEpochs,
  deviceEnrollments,
  groupSources,
  sessions,
  sessionTokenIssuances,
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
import { DrizzleSessionStore } from './sessions';

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

  test('reloads a retained session with the latest grant and revocation facts', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const groupSourceId = randomUUID();
    const snapshotId = randomUUID();
    const deviceEnrollmentId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const googleSubject = `issue-26-session-${suffix}`;

    await database.insert(groupSources).values({
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: `Issue 26 session group ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-26-session-${suffix}`,
      email: `issue-26-session-${suffix}@example.invalid`,
      fixtureKey: null,
      createdAt: now,
    });
    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-session-${suffix}@psd401.net`,
      displayName: `Issue 26 session user ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: now,
    });
    await database.insert(userRoles).values({ userId, role: 'staff' });
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: 2_100_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
        complete: true,
        syncStartedAt: now,
        capturedAt: now,
      });
      await transaction.insert(accessMembershipSnapshotGroups).values([
        {
          snapshotId,
          groupSourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
          completionKind: 'expected',
        },
        {
          snapshotId,
          groupSourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
          completionKind: 'completed',
        },
      ]);
      await transaction.insert(accessMembershipMembers).values({
        snapshotId,
        userId,
        googleSubject,
        facilityScopeKind: 'district',
      });
      await transaction.insert(accessMembershipMemberGroups).values({
        snapshotId,
        userId,
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
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
    expect(context?.result.user.roles).toEqual(['admin']);
  });

  test('issues a session as the production role with only immutable snapshot lock-column privileges', async () => {
    const testContext = context;
    if (testContext === undefined) {
      throw new Error('The session integration test context is unavailable.');
    }
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const groupSourceId = randomUUID();
    const snapshotId = randomUUID();
    const snapshotVersion =
      2_117_000_000 + Number.parseInt(suffix.slice(0, 3), 16);
    const googleSubject = `issue-26-app-role-session-${suffix}`;
    const snapshotAt = new Date(Date.now() + 30_000);
    const createdAt = new Date(snapshotAt.getTime() + 1_000);

    await database.insert(groupSources).values({
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: `Issue 26 app role session ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-26-app-role-session-${suffix}`,
      email: `issue-26-app-role-session-${suffix}@example.invalid`,
      fixtureKey: null,
      createdAt: snapshotAt,
    });
    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-app-role-session-${suffix}@psd401.net`,
      displayName: `Issue 26 app role user ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: snapshotAt,
    });
    await database.insert(userRoles).values({ userId, role: 'staff' });

    const activeAccessGroups = await database
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
      );
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: snapshotVersion,
        complete: true,
        syncStartedAt: snapshotAt,
        capturedAt: snapshotAt,
      });
      await transaction.insert(accessMembershipSnapshotGroups).values(
        activeAccessGroups.flatMap((source) => [
          {
            snapshotId,
            groupSourceId: source.id,
            groupSourceKind: source.kind,
            groupPurpose: source.purpose,
            completionKind: 'expected' as const,
          },
          {
            snapshotId,
            groupSourceId: source.id,
            groupSourceKind: source.kind,
            groupPurpose: source.purpose,
            completionKind: 'completed' as const,
          },
        ]),
      );
      await transaction.insert(accessMembershipMembers).values({
        snapshotId,
        userId,
        googleSubject,
        facilityScopeKind: 'district',
      });
      await transaction.insert(accessMembershipMemberGroups).values({
        snapshotId,
        userId,
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
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
        email: `issue-26-app-role-session-${suffix}@psd401.net`,
        displayName: `Issue 26 app role user ${suffix.slice(0, 8)}`,
        roles: Object.freeze(['staff'] as const),
        facilityScope: Object.freeze({ kind: 'district' as const }),
        createdAt: snapshotAt.toISOString(),
        disabledAt: null,
      }),
      membershipSnapshot: Object.freeze({
        id: snapshotId,
        version: snapshotVersion,
        complete: true as const,
        syncStartedAt: snapshotAt.toISOString(),
        capturedAt: snapshotAt.toISOString(),
      }),
      membershipMember: Object.freeze({
        userId,
        googleSubject,
        accessGroupSourceRefs: Object.freeze([
          Object.freeze({
            id: groupSourceId,
            kind: 'google-group' as const,
            purpose: 'access' as const,
            facilityId: null,
          }),
        ]),
        facilityScope: Object.freeze({ kind: 'district' as const }),
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
      grantBootstrapAdmin: false,
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
      expect(result.user.roles).toEqual(['staff']);
      expect(result.session.authorization.membershipSnapshotId).toBe(
        snapshotId,
      );

      const updatePrivileges = databaseExecuteRows<SnapshotUpdatePrivilegeRow>(
        await roleConnection.db.execute<SnapshotUpdatePrivilegeRow>(sql`
            with snapshot_tables(table_name) as (
              values
                ('access_membership_snapshots'::text),
                ('access_membership_snapshot_groups'::text),
                ('access_membership_members'::text),
                ('access_membership_member_groups'::text),
                ('access_membership_member_facilities'::text)
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
          table_name: 'access_membership_member_facilities',
          table_update: false,
          update_columns: ['snapshot_id'],
        },
        {
          table_name: 'access_membership_member_groups',
          table_update: false,
          update_columns: ['snapshot_id'],
        },
        {
          table_name: 'access_membership_members',
          table_update: false,
          update_columns: ['snapshot_id'],
        },
        {
          table_name: 'access_membership_snapshot_groups',
          table_update: false,
          update_columns: ['snapshot_id'],
        },
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
        membershipSnapshotId: snapshotId,
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
    const groupSourceId = randomUUID();
    const snapshotId = randomUUID();
    const googleSubject = `issue-26-bootstrap-lock-${suffix}`;
    const snapshotAt = new Date(Date.now() + 60_000);
    const createdAt = new Date(snapshotAt.getTime() + 1_000);

    await database.insert(groupSources).values({
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: `Issue 26 bootstrap lock ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-26-bootstrap-lock-${suffix}`,
      email: `issue-26-bootstrap-lock-${suffix}@example.invalid`,
      fixtureKey: null,
      createdAt: snapshotAt,
    });
    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-bootstrap-lock-${suffix}@psd401.net`,
      displayName: `Issue 26 bootstrap candidate ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: snapshotAt,
    });
    await database.insert(userRoles).values({ userId, role: 'staff' });

    const activeAccessGroups = await database
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
      );
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: 2_120_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
        complete: true,
        syncStartedAt: snapshotAt,
        capturedAt: snapshotAt,
      });
      await transaction.insert(accessMembershipSnapshotGroups).values(
        activeAccessGroups.flatMap((source) => [
          {
            snapshotId,
            groupSourceId: source.id,
            groupSourceKind: source.kind,
            groupPurpose: source.purpose,
            completionKind: 'expected' as const,
          },
          {
            snapshotId,
            groupSourceId: source.id,
            groupSourceKind: source.kind,
            groupPurpose: source.purpose,
            completionKind: 'completed' as const,
          },
        ]),
      );
      await transaction.insert(accessMembershipMembers).values({
        snapshotId,
        userId,
        googleSubject,
        facilityScopeKind: 'district',
      });
      await transaction.insert(accessMembershipMemberGroups).values({
        snapshotId,
        userId,
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
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
        email: `issue-26-bootstrap-lock-${suffix}@psd401.net`,
        displayName: `Issue 26 bootstrap candidate ${suffix.slice(0, 8)}`,
        roles: Object.freeze(['staff'] as const),
        facilityScope: Object.freeze({ kind: 'district' as const }),
        createdAt: snapshotAt.toISOString(),
        disabledAt: null,
      }),
      membershipSnapshot: Object.freeze({
        id: snapshotId,
        version: 2_120_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
        complete: true as const,
        syncStartedAt: snapshotAt.toISOString(),
        capturedAt: snapshotAt.toISOString(),
      }),
      membershipMember: Object.freeze({
        userId,
        googleSubject,
        accessGroupSourceRefs: Object.freeze([
          Object.freeze({
            id: groupSourceId,
            kind: 'google-group' as const,
            purpose: 'access' as const,
            facilityId: null,
          }),
        ]),
        facilityScope: Object.freeze({ kind: 'district' as const }),
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
      grantBootstrapAdmin: true,
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
    expect(issuanceOutcome.value.user.roles).toContain('admin');
  });
});
