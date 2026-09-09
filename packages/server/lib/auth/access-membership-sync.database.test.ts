import { createHash, randomUUID } from 'node:crypto';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  facilities,
  groupMembers,
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
} from '../testing/owned-database-lifecycle';
import { decideAccess } from './trusted-group-access';
import {
  createDrizzleAccessMembershipSyncStore,
  type AccessMembershipSyncReservation,
  type AccessMembershipSyncScope,
} from './access-membership-sync';
import {} from './session-cookie';
import {
  type DesignatedAccessGroup,
  type EvaluatedAccessMembershipSet,
} from './google-access-membership';

const DESIGNATED_ACCESS_GROUP_EMAIL = 'tsd-engineering@example.invalid';

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
const RECOVERY_EMAIL = 'recovery.admin@example.invalid';
const TRANSITION_EMAIL = 'initial.mobile@example.invalid';
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
      email: 'retained-recovery@example.invalid',
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
      googleGroupId: string | null;
      grantedRole: 'staff' | 'admin' | null;
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
    scope: AccessMembershipSyncScope = 'access',
  ): Promise<AccessMembershipSyncReservation> {
    return store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: key,
      requestDigest: textDigest(key),
      startedAt: SYNC_TIME,
      scope,
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
          groupEmail: 'retained-recovery@example.invalid',
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
        .select({ email: groupMembers.email })
        .from(groupMembers)
        .where(eq(groupMembers.groupSourceId, BASELINE_SOURCE_ID)),
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
      [
        'retained-recovery@example.invalid',
        DESIGNATED_ACCESS_GROUP_EMAIL,
      ].sort(),
    );

    const reservation = await reserve(store, 'access-sync:publish-0002');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');
    const result = await store.publish(
      reservation.id,
      evaluationFor([
        {
          groupSourceId: BASELINE_SOURCE_ID,
          groupEmail: 'retained-recovery@example.invalid',
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
        email: groupMembers.email,
        groupSourceId: groupMembers.groupSourceId,
      })
      .from(groupMembers)
      .orderBy(asc(groupMembers.email));
    expect(members).toEqual(
      [
        { email: TRANSITION_EMAIL, groupSourceId: secondSourceId },
        { email: RECOVERY_EMAIL, groupSourceId: BASELINE_SOURCE_ID },
      ].sort((left, right) => left.email.localeCompare(right.email)),
    );
  });

  test('records the Google Group ID for a waiting building source once Google holds it', async () => {
    // A school's group registered before Google held it: no ID, nobody in
    // it. The roster-scope sync keeps publishing around it, and the first run
    // that finds the group records its ID; from then on it syncs normally.
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const [facility] = await database
      .insert(facilities)
      .values({
        id: '00000000-0000-4000-8000-000000000560',
        code: 'HHE',
        name: 'Harbor Heights Elementary School',
        active: true,
      })
      .returning({ id: facilities.id });
    if (facility === undefined)
      throw new Error('The facility was not created.');
    const waitingSourceId = '00000000-0000-4000-8000-000000000561';
    await database.insert(groupSources).values({
      id: waitingSourceId,
      kind: 'google-group',
      purpose: 'building',
      facilityId: facility.id,
      displayName: 'Harbor Heights staff (waiting)',
      grantedRole: null,
      active: true,
      googleGroupId: null,
      email: 'hhe-eoc@example.invalid',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });
    const configured = await store.readConfiguredAccessGroups('roster');
    expect(configured).toEqual([
      {
        groupSourceId: waitingSourceId,
        email: 'hhe-eoc@example.invalid',
        grantedRole: null,
        waiting: true,
      },
    ]);
    const stillWaiting = await reserve(
      store,
      'roster-sync:waiting-0001',
      'roster',
    );
    if (stillWaiting.kind !== 'reserved') throw new Error('expected reserved');
    await store.publish(
      stillWaiting.id,
      evaluationFor([
        {
          groupSourceId: waitingSourceId,
          groupEmail: 'hhe-eoc@example.invalid',
          googleGroupId: null,
          grantedRole: null,
          memberEmails: [],
        },
      ]),
      'roster',
    );
    const [afterWaiting] = await database
      .select({ googleGroupId: groupSources.googleGroupId })
      .from(groupSources)
      .where(eq(groupSources.id, waitingSourceId));
    expect(afterWaiting?.googleGroupId).toBeNull();

    const nowHeld = await reserve(store, 'roster-sync:waiting-0002', 'roster');
    if (nowHeld.kind !== 'reserved') throw new Error('expected reserved');
    await store.publish(
      nowHeld.id,
      evaluationFor([
        {
          groupSourceId: waitingSourceId,
          groupEmail: 'hhe-eoc@example.invalid',
          googleGroupId: 'hhe_eoc_now_held',
          grantedRole: null,
          memberEmails: [TRANSITION_EMAIL],
        },
      ]),
      'roster',
    );
    const [afterHeld] = await database
      .select({ googleGroupId: groupSources.googleGroupId })
      .from(groupSources)
      .where(eq(groupSources.id, waitingSourceId));
    expect(afterHeld?.googleGroupId).toBe('hhe_eoc_now_held');
    expect(await store.readConfiguredAccessGroups('roster')).toMatchObject([
      { groupSourceId: waitingSourceId, waiting: false },
    ]);
    const members = await database
      .select({ email: groupMembers.email })
      .from(groupMembers)
      .where(eq(groupMembers.groupSourceId, waitingSourceId));
    expect(members).toEqual([{ email: TRANSITION_EMAIL }]);

    // A recorded ID is then held to: Google answering another ID for the
    // same address is a changed configuration, not a quiet re-point.
    const changed = await reserve(store, 'roster-sync:waiting-0003', 'roster');
    if (changed.kind !== 'reserved') throw new Error('expected reserved');
    await expect(
      store.publish(
        changed.id,
        evaluationFor([
          {
            groupSourceId: waitingSourceId,
            groupEmail: 'hhe-eoc@example.invalid',
            googleGroupId: 'some_other_group',
            grantedRole: null,
            memberEmails: [TRANSITION_EMAIL],
          },
        ]),
        'roster',
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_CONFIGURATION_CHANGED' });
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
      email: 'retiring@example.invalid',
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
          groupEmail: 'retained-recovery@example.invalid',
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
        .select({ email: groupMembers.email })
        .from(groupMembers)
        .where(eq(groupMembers.groupSourceId, secondSourceId)),
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
            groupEmail: 'retained-recovery@example.invalid',
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
    expect(await database.select().from(groupMembers)).toEqual([]);
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
            groupEmail: 'retained-recovery@example.invalid',
            googleGroupId: 'retained_recovery_access',
            grantedRole: 'staff',
            memberEmails: [RECOVERY_EMAIL],
          },
        ]),
      ),
    ).rejects.toThrow();

    // Refused whole: no later run was recorded.
    expect(
      (
        await database
          .select({ version: accessMembershipSnapshots.version })
          .from(accessMembershipSnapshots)
          .orderBy(desc(accessMembershipSnapshots.version))
          .limit(1)
      )[0]?.version,
    ).toBe(1);
  });
  test('reads and publishes a building group alongside the access groups', async () => {
    // The generalization: one sync fills membership for every active group,
    // whatever its purpose. A school's staff group grants no role, so it can
    // never widen who may sign in — only who an event at that school reaches.
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const facilityId = randomUUID();
    const buildingSourceId = randomUUID();
    await database.insert(facilities).values({
      id: facilityId,
      code: 'SYNCTEST',
      name: 'Sync Test School',
    });
    await database.insert(groupSources).values({
      id: buildingSourceId,
      kind: 'google-group',
      purpose: 'building',
      facilityId,
      displayName: 'Sync Test School staff',
      active: true,
      grantedRole: null,
      membersCapturedAt: null,
      googleGroupId: 'sync_test_school_staff',
      email: 'synctest-staff@example.invalid',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });

    const configured = await store.readConfiguredAccessGroups('roster');
    const building = configured.find(
      ({ groupSourceId }) => groupSourceId === buildingSourceId,
    );
    expect(building).toBeDefined();
    expect(building?.grantedRole).toBeNull();

    // Publication revalidates each group against its stored provider id, so
    // read them rather than assuming.
    const providerIds = new Map(
      (
        await database
          .select({
            id: groupSources.id,
            googleGroupId: groupSources.googleGroupId,
          })
          .from(groupSources)
      ).map(({ id, googleGroupId }) => [id, googleGroupId ?? '']),
    );
    const reservation = await reserve(store, 'access-sync:building-0001');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');
    await store.publish(
      reservation.id,
      evaluationFor(
        configured.map((group) => ({
          groupSourceId: group.groupSourceId,
          groupEmail: group.email,
          googleGroupId: providerIds.get(group.groupSourceId) ?? '',
          grantedRole: group.grantedRole,
          memberEmails:
            group.groupSourceId === buildingSourceId
              ? ['schoolstaff@example.invalid']
              : [RECOVERY_EMAIL],
        })),
      ),
      'roster',
    );

    // The building group's members landed, and its read was stamped.
    const members = await database
      .select({ email: groupMembers.email })
      .from(groupMembers)
      .where(eq(groupMembers.groupSourceId, buildingSourceId));
    expect(members.map(({ email }) => email)).toEqual([
      'schoolstaff@example.invalid',
    ]);
    const [source] = await database
      .select({ capturedAt: groupSources.membersCapturedAt })
      .from(groupSources)
      .where(eq(groupSources.id, buildingSourceId));
    expect(source?.capturedAt).not.toBeNull();

    // And it grants nobody sign-in, which is the property that lets one
    // membership table serve both purposes.
    expect(
      await decideAccess(database, {
        email: 'schoolstaff@example.invalid',
        checkedAt: new Date(SYNC_TIME),
      }),
    ).toMatchObject({ granted: false });
  });

  test('reads and publishes a Google others group so a district list has members', async () => {
    // An others source is the district-level list an event at any school
    // reaches. Its Google membership was never read: the sync evaluated
    // access and building groups only, so a Google others source stayed
    // empty forever and reached nobody. It grants no role, exactly like a
    // building group, so reading it cannot widen who may sign in.
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const othersSourceId = randomUUID();
    await database.insert(groupSources).values({
      id: othersSourceId,
      kind: 'google-group',
      purpose: 'others',
      facilityId: null,
      displayName: 'Sync Test district responders',
      active: true,
      grantedRole: null,
      membersCapturedAt: null,
      googleGroupId: 'sync_test_district_responders',
      email: 'synctest-responders@example.invalid',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });

    const configured = await store.readConfiguredAccessGroups('roster');
    const others = configured.find(
      ({ groupSourceId }) => groupSourceId === othersSourceId,
    );
    expect(others).toBeDefined();
    expect(others?.grantedRole).toBeNull();
    // The scopes partition the groups: the sign-in run never sees a roster
    // group, and the roster run never sees a sign-in group, so a failure in
    // one cannot be raised inside the other.
    const accessScope = await store.readConfiguredAccessGroups('access');
    expect(
      accessScope.some(({ groupSourceId }) => groupSourceId === othersSourceId),
    ).toBe(false);
    expect(
      configured.some(
        ({ groupSourceId }) => groupSourceId === BASELINE_SOURCE_ID,
      ),
    ).toBe(false);

    const providerIds = new Map(
      (
        await database
          .select({
            id: groupSources.id,
            googleGroupId: groupSources.googleGroupId,
          })
          .from(groupSources)
      ).map(({ id, googleGroupId }) => [id, googleGroupId ?? '']),
    );
    const reservation = await reserve(store, 'access-sync:others-0001');
    if (reservation.kind !== 'reserved') throw new Error('expected reserved');
    await store.publish(
      reservation.id,
      evaluationFor(
        configured.map((group) => ({
          groupSourceId: group.groupSourceId,
          groupEmail: group.email,
          googleGroupId: providerIds.get(group.groupSourceId) ?? '',
          grantedRole: group.grantedRole,
          memberEmails:
            group.groupSourceId === othersSourceId
              ? ['responder@example.invalid']
              : [RECOVERY_EMAIL],
        })),
      ),
      'roster',
    );

    const members = await database
      .select({ email: groupMembers.email })
      .from(groupMembers)
      .where(eq(groupMembers.groupSourceId, othersSourceId));
    expect(members.map(({ email }) => email)).toEqual([
      'responder@example.invalid',
    ]);
    const [source] = await database
      .select({ capturedAt: groupSources.membersCapturedAt })
      .from(groupSources)
      .where(eq(groupSources.id, othersSourceId));
    expect(source?.capturedAt).not.toBeNull();

    expect(
      await decideAccess(database, {
        email: 'responder@example.invalid',
        checkedAt: new Date(SYNC_TIME),
      }),
    ).toMatchObject({ granted: false });
  });

  test('a replayed sign-in run stays current after the roster run of the same tick', async () => {
    // One scheduled tick runs the sign-in groups and then the roster groups,
    // and the two runs share the snapshot version sequence. EventBridge
    // delivers at least once, so the sign-in run's key can be replayed after
    // the roster run has already published a newer version. That replay must
    // still describe the sign-in run as current: only a later run of the same
    // scope supersedes it, or every redelivered tick would fail the job that
    // keeps administrators signed in.
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const othersSourceId = randomUUID();
    await database.insert(groupSources).values({
      id: othersSourceId,
      kind: 'google-group',
      purpose: 'others',
      facilityId: null,
      displayName: 'Sync Test district responders',
      active: true,
      grantedRole: null,
      membersCapturedAt: null,
      googleGroupId: 'sync_test_district_responders',
      email: 'synctest-responders@example.invalid',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });
    const providerIds = new Map(
      (
        await database
          .select({
            id: groupSources.id,
            googleGroupId: groupSources.googleGroupId,
          })
          .from(groupSources)
      ).map(({ id, googleGroupId }) => [id, googleGroupId ?? '']),
    );
    const evaluationOf = (groups: readonly DesignatedAccessGroup[]) =>
      evaluationFor(
        groups.map((group) => ({
          groupSourceId: group.groupSourceId,
          groupEmail: group.email,
          googleGroupId: providerIds.get(group.groupSourceId) ?? '',
          grantedRole: group.grantedRole,
          memberEmails:
            group.groupSourceId === othersSourceId
              ? ['responder@example.invalid']
              : [RECOVERY_EMAIL],
        })),
      );

    const accessRun = await reserve(store, 'access-sync:tick-0001', 'access');
    if (accessRun.kind !== 'reserved') throw new Error('expected reserved');
    const accessResult = await store.publish(
      accessRun.id,
      evaluationOf(await store.readConfiguredAccessGroups('access')),
      'access',
    );

    const rosterRun = await reserve(
      store,
      'access-sync:tick-0001:roster',
      'roster',
    );
    if (rosterRun.kind !== 'reserved') throw new Error('expected reserved');
    const rosterResult = await store.publish(
      rosterRun.id,
      evaluationOf(await store.readConfiguredAccessGroups('roster')),
      'roster',
    );
    expect(rosterResult.snapshotVersion).toBeGreaterThan(
      accessResult.snapshotVersion,
    );

    // The redelivered sign-in run: the newest snapshot overall is now the
    // roster run's, and that must not count against it.
    const replay = await reserve(store, 'access-sync:tick-0001', 'access');
    if (replay.kind !== 'replay') throw new Error('expected replay');
    expect(replay.result.snapshotId).toBe(accessResult.snapshotId);

    const rosterReplay = await reserve(
      store,
      'access-sync:tick-0001:roster',
      'roster',
    );
    if (rosterReplay.kind !== 'replay') throw new Error('expected replay');
    expect(rosterReplay.result.snapshotId).toBe(rosterResult.snapshotId);

    // Each run record names the scope it covered.
    const recorded = await database
      .select({
        id: accessMembershipSnapshots.id,
        scope: accessMembershipSnapshots.scope,
      })
      .from(accessMembershipSnapshots)
      .where(
        inArray(accessMembershipSnapshots.id, [
          accessResult.snapshotId,
          rosterResult.snapshotId,
        ]),
      );
    expect(new Map(recorded.map(({ id, scope }) => [id, scope]))).toEqual(
      new Map([
        [accessResult.snapshotId, 'access'],
        [rosterResult.snapshotId, 'roster'],
      ]),
    );
  });

  test('the database refuses a group whose role does not match its purpose', async () => {
    // A building group granting a role would silently widen who may sign in;
    // an access group granting none would admit people to nothing. Both are
    // refused by `group_sources_access_role_present`, which is why the sync
    // does not check it again — the invariant has one home.
    const database = databaseConnection().db;
    const facilityId = randomUUID();
    await database.insert(facilities).values({
      id: facilityId,
      code: 'BADROLE',
      name: 'Bad Role School',
    });

    async function refusedBy(row: Record<string, unknown>): Promise<string> {
      try {
        await database.insert(groupSources).values(row as never);
      } catch (error) {
        // The constraint name is on the driver error, not the wrapper message.
        return String(
          Reflect.get(Object(error), 'constraint_name') ??
            Reflect.get(
              Object(Reflect.get(Object(error), 'cause')),
              'constraint_name',
            ) ??
            Reflect.get(Object(error), 'message'),
        );
      }
      throw new Error('the insert was accepted');
    }

    expect(
      await refusedBy({
        id: randomUUID(),
        kind: 'google-group',
        purpose: 'building',
        facilityId,
        displayName: 'Bad Role School staff',
        active: true,
        grantedRole: 'admin',
        membersCapturedAt: null,
        googleGroupId: 'bad_role_school_staff',
        email: 'badrole-staff@example.invalid',
        fixtureKey: null,
        createdAt: BASELINE_TIME,
      }),
    ).toBe('group_sources_access_role_present');

    expect(
      await refusedBy({
        id: randomUUID(),
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Roleless access group',
        active: true,
        grantedRole: null,
        membersCapturedAt: null,
        googleGroupId: 'roleless_access_group',
        email: 'roleless@example.invalid',
        fixtureKey: null,
        createdAt: BASELINE_TIME,
      }),
    ).toBe('group_sources_access_role_present');
  });

  test('a building group stays immutable in every column but the read stamp', async () => {
    // 0028 released exactly one column. If it released the guard instead, a
    // building group could be repointed at a different provider group or a
    // different school after schools had been notified from it.
    const database = databaseConnection().db;
    const facilityId = randomUUID();
    const sourceId = randomUUID();
    await database
      .insert(facilities)
      .values({ id: facilityId, code: 'IMMUT', name: 'Immutable School' });
    await database.insert(groupSources).values({
      id: sourceId,
      kind: 'google-group',
      purpose: 'building',
      facilityId,
      displayName: 'Immutable School staff',
      active: true,
      grantedRole: null,
      membersCapturedAt: null,
      googleGroupId: 'immutable_school_staff',
      email: 'immutable-staff@example.invalid',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });

    // Allowed: the one column the sync has to write.
    await database
      .update(groupSources)
      .set({ membersCapturedAt: new Date(SYNC_TIME) })
      .where(eq(groupSources.id, sourceId));
    expect(
      (
        await database
          .select({ capturedAt: groupSources.membersCapturedAt })
          .from(groupSources)
          .where(eq(groupSources.id, sourceId))
      )[0]?.capturedAt,
    ).not.toBeNull();

    // Refused: everything else, still.
    for (const change of [
      { googleGroupId: 'a_different_google_group' },
      { email: 'somewhere-else@example.invalid' },
      { displayName: 'Renamed' },
      { active: false },
    ]) {
      await expect(
        (async () =>
          database
            .update(groupSources)
            .set(change)
            .where(eq(groupSources.id, sourceId)))(),
      ).rejects.toThrow();
    }
  });
});
