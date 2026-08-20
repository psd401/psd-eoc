import { createHash, randomUUID } from 'node:crypto';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  accessGroupMembers,
  accessMembershipEvaluatedMembers,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  userRoles,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../app/(admin)/facilities/owned-database-lifecycle';
import { decideAccess } from './trusted-group-access';
import {
  createDrizzleAccessMembershipSyncStore,
  type AccessMembershipSyncReservation,
} from './access-membership-sync';
import {} from './session-cookie';
import { type EvaluatedAccessMembershipSet } from './google-access-membership';

const DESIGNATED_ACCESS_GROUP_EMAIL = 'tsd-engineering@psd401.net';
import { loadAccessConfigurationSnapshotState } from './role-state';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface TestDatabaseContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i234_access_[a-f0-9]{32}_test$/u;
const BASELINE_SOURCE_ID = '00000000-0000-4000-8000-000000000521';
const BASELINE_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000522';
const USER_ID = '00000000-0000-4000-8000-000000000523';
const RECOVERY_EMAIL = 'recovery.admin@psd401.net';
const TRANSITION_EMAIL = 'initial.mobile@psd401.net';
const BASELINE_TIME = new Date('2026-08-17T11:00:00.000Z');
const SYNC_TIME = '2026-08-17T12:00:00.000Z';
const PROVIDER_GROUP_ID = '01exactEngineering';

let context: TestDatabaseContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
let databaseCreated = false;

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function textDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildContext(baseUrl: string): TestDatabaseContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i234_access_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable access-sync database name is invalid.');
  }
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl: baseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-234:access-sync-test:${runId}`,
  });
}

function openConnection(
  url: string,
  maxConnections: number,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Access-sync integration tests require PostgreSQL.');
  }
  return opened;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readMarker(
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
    throw new Error('The disposable access-sync database is ambiguous.');
  }
  return rows[0]?.marker;
}

async function dropOwnedDatabase(target: TestDatabaseContext): Promise<void> {
  const admin = openConnection(target.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readMarker(admin, target.databaseName);
      if (marker !== undefined && marker !== target.marker) {
        throw new Error(
          'Refusing to drop an access-sync database without its exact ownership marker.',
        );
      }
      if (marker === target.marker) {
        await admin.db.execute(
          sql.raw(`drop database "${target.databaseName}" with (force)`),
        );
        expect(await readMarker(admin, target.databaseName)).toBeUndefined();
      }
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Access-sync database cleanup and connection close both failed.',
  });
}

async function createOwnedDatabase(target: TestDatabaseContext): Promise<void> {
  const admin = openConnection(target.baseDatabaseUrl, 1);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${target.databaseName}"`),
      );
      recordCreated();
      await admin.db.execute(
        sql.raw(
          `comment on database "${target.databaseName}" is ${quotedLiteral(target.marker)}`,
        ),
      );
      expect(await readMarker(admin, target.databaseName)).toBe(target.marker);
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(target),
    failureMessage:
      'Access-sync database creation, verification, or cleanup failed.',
  });
}

async function cleanup(): Promise<void> {
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
    throw new AggregateError(errors, 'Access-sync integration cleanup failed.');
  }
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The access-sync integration database is not open.');
  }
  return connection;
}

async function seedStrictBaseline(
  database: PostgresDatabaseConnection['db'],
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.insert(groupSources).values({
      id: BASELINE_SOURCE_ID,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'Retained recovery access',
      grantedRole: 'admin',
      active: true,
      googleGroupId: 'retained_recovery_access',
      email: 'retained-recovery@psd401.net',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });
    await transaction.insert(users).values({
      id: USER_ID,
      googleSubject: 'synthetic-test-google-subject',
      email: RECOVERY_EMAIL,
      displayName: 'Synthetic Integration Administrator',
      facilityScopeKind: 'district',
      createdAt: BASELINE_TIME,
      disabledAt: null,
    });
    await transaction
      .insert(userRoles)
      .values({ userId: USER_ID, role: 'admin' });
    await transaction.insert(accessMembershipSnapshots).values({
      id: BASELINE_SNAPSHOT_ID,
      version: 1,
      complete: true,
      syncStartedAt: BASELINE_TIME,
      capturedAt: BASELINE_TIME,
    });
    await transaction.insert(accessMembershipSnapshotGroups).values([
      {
        snapshotId: BASELINE_SNAPSHOT_ID,
        groupSourceId: BASELINE_SOURCE_ID,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'expected',
      },
      {
        snapshotId: BASELINE_SNAPSHOT_ID,
        groupSourceId: BASELINE_SOURCE_ID,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(accessMembershipMembers).values({
      snapshotId: BASELINE_SNAPSHOT_ID,
      userId: USER_ID,
      googleSubject: 'synthetic-test-google-subject',
      facilityScopeKind: 'district',
    });
    await transaction.insert(accessMembershipMemberGroups).values({
      snapshotId: BASELINE_SNAPSHOT_ID,
      userId: USER_ID,
      groupSourceId: BASELINE_SOURCE_ID,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
    await transaction.insert(accessMembershipEvaluatedMembers).values({
      snapshotId: BASELINE_SNAPSHOT_ID,
      email: RECOVERY_EMAIL,
      groupSourceId: BASELINE_SOURCE_ID,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
  });
}

describeWithDatabase('access-membership atomic database publication', () => {
  beforeEach(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      databaseCreated = true;
      connection = openConnection(context.databaseUrl, 3);
      await migrateDatabase(connection);
      await seedStrictBaseline(connection.db);
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Access-sync integration setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterEach(async () => cleanup());

  /** Builds a self-consistent evaluation for the given configured groups. */
  function evaluationFor(
    groups: readonly Readonly<{
      groupSourceId: string;
      groupEmail: string;
      googleGroupId: string;
      grantedRole: 'staff' | 'admin';
      memberEmails: readonly string[];
    }>[],
  ): EvaluatedAccessMembershipSet {
    const ordered = [...groups].sort((left, right) =>
      left.groupSourceId.localeCompare(right.groupSourceId),
    );
    return Object.freeze({
      groups: Object.freeze(
        ordered.map((group) =>
          Object.freeze({
            ...group,
            memberEmails: Object.freeze([...group.memberEmails].sort()),
          }),
        ),
      ),
      membershipDigest: digest(
        ordered.flatMap((group) => [
          group.groupSourceId,
          group.groupEmail,
          group.googleGroupId,
          group.grantedRole,
          ...[...group.memberEmails].sort(),
        ]),
      ),
      providerGroupIdDigest: digest(
        ordered.map(({ googleGroupId }) => googleGroupId),
      ),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    }) as EvaluatedAccessMembershipSet;
  }

  async function reserve(
    store: ReturnType<typeof createDrizzleAccessMembershipSyncStore>,
    key: string,
  ): Promise<AccessMembershipSyncReservation> {
    return store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: key,
      requestDigest: textDigest(key),
      startedAt: SYNC_TIME,
    });
  }

  test('publishes a baseline covering every active group and keeps sign-in valid', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const reservation = await reserve(store, 'access-sync:publish-0001');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');

    const result = await store.publish(
      reservation.id,
      evaluationFor([
        {
          groupSourceId: BASELINE_SOURCE_ID,
          groupEmail: 'retained-recovery@psd401.net',
          googleGroupId: 'retained_recovery_access',
          grantedRole: 'admin',
          memberEmails: [RECOVERY_EMAIL],
        },
      ]),
    );

    expect(result).toMatchObject({
      snapshotVersion: 2,
      activeAccessGroupCount: 1,
      evaluatedMembershipCount: 1,
      publication: 'created',
    });

    // Membership is what sign-in reads. The group now holds its member and
    // carries the instant it was read.
    expect(
      await database
        .select({ email: accessGroupMembers.email })
        .from(accessGroupMembers)
        .where(eq(accessGroupMembers.groupSourceId, BASELINE_SOURCE_ID)),
    ).toEqual([{ email: RECOVERY_EMAIL }]);
    expect(
      await decideAccess(database, {
        email: RECOVERY_EMAIL,
        checkedAt: new Date(SYNC_TIME),
      }),
    ).toMatchObject({ granted: true, roles: ['admin'] });
  });

  test('a group added after the first snapshot becomes a valid baseline', async () => {
    // The behaviour the old design made impossible. Activating a second group
    // left the snapshot disagreeing with the active set, and publication was
    // refused for exactly that disagreement, so the two could never reconcile.
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const secondSourceId = '00000000-0000-4000-8000-000000000531';
    await database.insert(groupSources).values({
      id: secondSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'District staff access',
      grantedRole: 'staff',
      active: true,
      googleGroupId: PROVIDER_GROUP_ID,
      email: DESIGNATED_ACCESS_GROUP_EMAIL,
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });

    // The second group has no membership yet, so nobody in it has access.
    expect(
      await decideAccess(database, {
        email: TRANSITION_EMAIL,
        checkedAt: new Date(SYNC_TIME),
      }),
    ).toMatchObject({ granted: false });

    const configured = await store.readConfiguredAccessGroups();
    expect(configured.map(({ email }) => email).sort()).toEqual(
      ['retained-recovery@psd401.net', DESIGNATED_ACCESS_GROUP_EMAIL].sort(),
    );

    const reservation = await reserve(store, 'access-sync:publish-0002');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');
    const result = await store.publish(
      reservation.id,
      evaluationFor([
        {
          groupSourceId: BASELINE_SOURCE_ID,
          groupEmail: 'retained-recovery@psd401.net',
          googleGroupId: 'retained_recovery_access',
          grantedRole: 'admin',
          memberEmails: [RECOVERY_EMAIL],
        },
        {
          groupSourceId: secondSourceId,
          groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
          googleGroupId: PROVIDER_GROUP_ID,
          grantedRole: 'staff',
          memberEmails: [TRANSITION_EMAIL],
        },
      ]),
    );
    expect(result.activeAccessGroupCount).toBe(2);
    expect(result.evaluatedMembershipCount).toBe(2);

    // Reconciled: the snapshot now covers both groups.
    // Both groups now carry membership, and a person in only the second one
    // has access. Requiring membership in every group is what denied them.
    expect(
      await decideAccess(database, {
        email: TRANSITION_EMAIL,
        checkedAt: new Date(SYNC_TIME),
      }),
    ).toMatchObject({ granted: true, roles: ['staff'] });
    expect(
      await decideAccess(database, {
        email: RECOVERY_EMAIL,
        checkedAt: new Date(SYNC_TIME),
      }),
    ).toMatchObject({ granted: true, roles: ['admin'] });

    // A person in only the second group is evaluated for it. Requiring
    // membership in every group is what previously denied them.
    const members = await database
      .select({
        email: accessGroupMembers.email,
        groupSourceId: accessGroupMembers.groupSourceId,
      })
      .from(accessGroupMembers)
      .orderBy(asc(accessGroupMembers.email));
    expect(members).toEqual(
      [
        { email: TRANSITION_EMAIL, groupSourceId: secondSourceId },
        { email: RECOVERY_EMAIL, groupSourceId: BASELINE_SOURCE_ID },
      ].sort((left, right) => left.email.localeCompare(right.email)),
    );
  });

  test('a group removed after the first snapshot becomes a valid baseline', async () => {
    // The other half, and the one this deployment actually needed: retiring a
    // group had no implementation at all.
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const secondSourceId = '00000000-0000-4000-8000-000000000532';
    await database.insert(groupSources).values({
      id: secondSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'Retiring fixture access',
      grantedRole: 'admin',
      active: false,
      googleGroupId: 'retiring_fixture',
      email: 'retiring@psd401.net',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });

    const configured = await store.readConfiguredAccessGroups();
    expect(configured).toHaveLength(1);
    expect(configured[0]?.groupSourceId).toBe(BASELINE_SOURCE_ID);

    const reservation = await reserve(store, 'access-sync:publish-0003');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');
    const result = await store.publish(
      reservation.id,
      evaluationFor([
        {
          groupSourceId: BASELINE_SOURCE_ID,
          groupEmail: 'retained-recovery@psd401.net',
          googleGroupId: 'retained_recovery_access',
          grantedRole: 'admin',
          memberEmails: [RECOVERY_EMAIL],
        },
      ]),
    );
    expect(result.activeAccessGroupCount).toBe(1);
    // The retired group's membership is gone with it, and the remaining group
    // still grants access.
    expect(
      await database
        .select({ email: accessGroupMembers.email })
        .from(accessGroupMembers)
        .where(eq(accessGroupMembers.groupSourceId, secondSourceId)),
    ).toEqual([]);
    expect(
      await decideAccess(database, {
        email: RECOVERY_EMAIL,
        checkedAt: new Date(SYNC_TIME),
      }),
    ).toMatchObject({ granted: true });
  });

  test('refuses a publication that would leave no reachable administrator', async () => {
    // The guard that makes reconfiguration safe. A staff group keeps the
    // evaluation non-empty, so this reaches the guard rather than failing
    // schema validation: people would still have access, but nobody could
    // administer, and a deployment must not be able to publish itself out of
    // its own administration.
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const staffSourceId = '00000000-0000-4000-8000-000000000533';
    await database.insert(groupSources).values({
      id: staffSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'District staff access',
      grantedRole: 'staff',
      active: true,
      googleGroupId: PROVIDER_GROUP_ID,
      email: DESIGNATED_ACCESS_GROUP_EMAIL,
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });

    const reservation = await reserve(store, 'access-sync:publish-0004');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');

    await expect(
      store.publish(
        reservation.id,
        evaluationFor([
          {
            groupSourceId: BASELINE_SOURCE_ID,
            groupEmail: 'retained-recovery@psd401.net',
            googleGroupId: 'retained_recovery_access',
            grantedRole: 'admin',
            memberEmails: [],
          },
          {
            groupSourceId: staffSourceId,
            groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
            googleGroupId: PROVIDER_GROUP_ID,
            grantedRole: 'staff',
            memberEmails: [TRANSITION_EMAIL],
          },
        ]),
      ),
    ).rejects.toThrow('reachable administrator');

    // Refused whole: neither group's membership was written.
    expect(await database.select().from(accessGroupMembers)).toEqual([]);
  });

  test('refuses evidence that no longer describes the active configuration', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const reservation = await reserve(store, 'access-sync:publish-0005');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');

    // Evidence for a group that is not active — the shape a race produces when
    // a source is retired while the provider is being read.
    await expect(
      store.publish(
        reservation.id,
        evaluationFor([
          {
            groupSourceId: '00000000-0000-4000-8000-0000000005ff',
            groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
            googleGroupId: PROVIDER_GROUP_ID,
            grantedRole: 'admin',
            memberEmails: [RECOVERY_EMAIL],
          },
        ]),
      ),
    ).rejects.toThrow();

    // Evidence whose role disagrees with the source row is refused too: the
    // published membership would grant authority the configuration did not.
    const second = await reserve(store, 'access-sync:publish-0006');
    if (second.kind !== 'reserved') throw new Error('expected reserved');
    await expect(
      store.publish(
        second.id,
        evaluationFor([
          {
            groupSourceId: BASELINE_SOURCE_ID,
            groupEmail: 'retained-recovery@psd401.net',
            googleGroupId: 'retained_recovery_access',
            grantedRole: 'staff',
            memberEmails: [RECOVERY_EMAIL],
          },
        ]),
      ),
    ).rejects.toThrow();

    expect(
      (await loadAccessConfigurationSnapshotState(database))?.snapshotVersion,
    ).toBe(1);
  });
});
