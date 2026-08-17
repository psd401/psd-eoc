import { createHash, randomUUID } from 'node:crypto';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, asc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  accessMembershipEvaluatedMembers,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  idempotencyRecords,
  userRoles,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../app/(admin)/facilities/owned-database-lifecycle';
import {
  createDrizzleAccessMembershipSyncStore,
  type AccessMembershipSyncReservation,
} from './access-membership-sync';
import { checkAccessGate, createDrizzleAccessGateStore } from './access-gate';
import {
  DESIGNATED_ACCESS_GROUP_EMAIL,
  type EvaluatedAccessMembershipSet,
} from './google-access-membership';
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
      active: true,
      googleGroupId: 'retained_recovery_access',
      email: 'retained-recovery@psd401.net',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });
    await transaction.insert(users).values({
      id: USER_ID,
      googleSubject: 'synthetic-test-google-subject',
      email: 'hagelk@psd401.net',
      displayName: 'Synthetic Integration Administrator',
      facilityScopeKind: 'district',
      createdAt: BASELINE_TIME,
      disabledAt: null,
    });
    await transaction.insert(userRoles).values({
      userId: USER_ID,
      role: 'staff',
    });
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
      email: 'hagelk@psd401.net',
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

  test('activates the exact provider source and publishes one strict append-only successor', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database);
    const idempotencyKey = 'access-sync:database-integration-0001';
    const requestDigest = 'd'.repeat(64);
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey,
      requestDigest,
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected a new access-sync reservation.');
    }
    const memberEmails = Object.freeze([
      'hagelk@psd401.net',
      'other.staff@psd401.net',
    ]);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });
    const result = await store.publish(reservation.id, evaluation);
    expect(result).toMatchObject({
      snapshotVersion: 2,
      activeAccessGroupCount: 1,
      evaluatedMembershipCount: 2,
      membershipDigest: evaluation.membershipDigest,
      providerGroupIdDigest: evaluation.providerGroupIdDigest,
      publication: 'created',
    });

    const accessState = await loadAccessConfigurationSnapshotState(database);
    expect(accessState).toEqual({
      snapshotId: result.snapshotId,
      snapshotVersion: 2,
      activeAccessGroupSourceIds: expect.any(Array),
    });
    expect(accessState?.activeAccessGroupSourceIds).toEqual([
      result.designatedSourceId,
    ]);

    const [designatedSource] = await database
      .select()
      .from(groupSources)
      .where(eq(groupSources.id, result.designatedSourceId));
    expect(designatedSource).toMatchObject({
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      active: true,
      googleGroupId: PROVIDER_GROUP_ID,
      email: DESIGNATED_ACCESS_GROUP_EMAIL,
      fixtureKey: null,
    });
    const [recoverySource] = await database
      .select({ active: groupSources.active })
      .from(groupSources)
      .where(eq(groupSources.id, BASELINE_SOURCE_ID));
    expect(recoverySource).toEqual({ active: false });
    const generationRows = await database
      .select()
      .from(accessMembershipSnapshotGroups)
      .where(eq(accessMembershipSnapshotGroups.snapshotId, result.snapshotId));
    expect(generationRows).toHaveLength(2);
    expect(
      generationRows
        .filter(({ completionKind }) => completionKind === 'expected')
        .map(({ groupSourceId }) => groupSourceId)
        .sort(),
    ).toEqual(
      generationRows
        .filter(({ completionKind }) => completionKind === 'completed')
        .map(({ groupSourceId }) => groupSourceId)
        .sort(),
    );
    expect(
      new Set(generationRows.map(({ groupSourceId }) => groupSourceId)),
    ).toEqual(new Set([result.designatedSourceId]));
    const evaluatedRows = await database
      .select({
        email: accessMembershipEvaluatedMembers.email,
        groupSourceId: accessMembershipEvaluatedMembers.groupSourceId,
      })
      .from(accessMembershipEvaluatedMembers)
      .where(eq(accessMembershipEvaluatedMembers.snapshotId, result.snapshotId))
      .orderBy(
        asc(accessMembershipEvaluatedMembers.groupSourceId),
        asc(accessMembershipEvaluatedMembers.email),
      );
    expect(evaluatedRows).toEqual(
      [
        {
          email: 'hagelk@psd401.net',
          groupSourceId: result.designatedSourceId,
        },
        {
          email: 'other.staff@psd401.net',
          groupSourceId: result.designatedSourceId,
        },
      ].sort((left, right) =>
        `${left.groupSourceId}:${left.email}`.localeCompare(
          `${right.groupSourceId}:${right.email}`,
        ),
      ),
    );
    expect(
      await database
        .select()
        .from(accessMembershipMembers)
        .where(eq(accessMembershipMembers.snapshotId, result.snapshotId)),
    ).toEqual([]);
    expect(
      await database
        .select({
          userId: accessMembershipMemberGroups.userId,
          groupSourceId: accessMembershipMemberGroups.groupSourceId,
        })
        .from(accessMembershipMemberGroups)
        .where(eq(accessMembershipMemberGroups.snapshotId, result.snapshotId)),
    ).toEqual([]);
    const accessDecision = await checkAccessGate(
      {
        googleSubject: 'synthetic-test-google-subject',
        email: 'hagelk@psd401.net',
        displayName: 'Current Google profile label',
        subjectDigest: 'a'.repeat(64),
        requestId: randomUUID(),
        checkedAt: SYNC_TIME,
        source: 'web',
      },
      {
        store: createDrizzleAccessGateStore(database),
        audit: {
          async append(): Promise<never> {
            throw new Error('A granted access check must not append a denial.');
          },
        },
      },
    );
    expect(accessDecision).toMatchObject({
      granted: true,
      firstLoginBinding: {
        userDisposition: 'existing',
        sourceSnapshotId: result.snapshotId,
        sourceSnapshotVersion: 2,
        normalizedEmail: 'hagelk@psd401.net',
      },
    });
    if (accessDecision.granted) {
      expect(accessDecision.membership.accessGroupSourceRefs).toEqual([
        {
          id: result.designatedSourceId,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
        },
      ]);
    }
    expect(
      await database
        .select()
        .from(accessMembershipSnapshots)
        .where(eq(accessMembershipSnapshots.id, BASELINE_SNAPSHOT_ID)),
    ).toHaveLength(1);
    const [idempotency] = await database
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.capabilityId, 'sync-access-membership'),
          eq(idempotencyRecords.key, idempotencyKey),
        ),
      );
    expect(idempotency).toMatchObject({
      status: 'completed',
      resultReference: `access-membership-snapshot:${result.snapshotId}`,
    });

    const replay: AccessMembershipSyncReservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey,
      requestDigest,
      startedAt: '2026-08-17T12:01:00.000Z',
    });
    expect(replay).toEqual({ kind: 'replay', result });
  });

  test('rolls source rotation back when the successor inventory cannot be published', async () => {
    const database = databaseConnection().db;
    const historicalSources = Array.from({ length: 99 }, (_, index) => ({
      id: randomUUID(),
      kind: 'google-group' as const,
      purpose: 'access' as const,
      facilityId: null,
      displayName: `Synthetic inactive history ${index}`,
      active: false,
      googleGroupId: `synthetic_inactive_history_${index}`,
      email: `synthetic.inactive.${index}@psd401.net`,
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    }));
    await database.insert(groupSources).values(historicalSources);
    const store = createDrizzleAccessMembershipSyncStore(database);
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-rollback-0001',
      requestDigest: 'c'.repeat(64),
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected a rollback-test reservation.');
    }
    const memberEmails = Object.freeze(['hagelk@psd401.net']);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });

    await expect(
      store.publish(reservation.id, evaluation),
    ).rejects.toMatchObject({
      code: 'ACTIVE_ACCESS_SOURCES_INVALID',
    });
    expect(
      await database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, BASELINE_SOURCE_ID)),
    ).toEqual([{ active: true }]);
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(eq(groupSources.googleGroupId, PROVIDER_GROUP_ID)),
    ).toEqual([]);

    await store.failReservation(
      reservation.id,
      'ACTIVE_ACCESS_SOURCES_INVALID',
      SYNC_TIME,
    );
  });
});
