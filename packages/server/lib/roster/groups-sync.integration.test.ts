import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import type { GroupSource, RosterPopulation } from '@psd-eoc/contracts';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../app/(admin)/facilities/owned-database-lifecycle';
import {
  createDrizzleRosterSyncStore,
  createMockGoogleGroupsAdapter,
  RosterSyncError,
  syncRoster,
  type RosterGroupMember,
  type RosterGroupPage,
  type RosterGroupsAdapter,
  type RosterSyncAlert,
  type RosterSyncAlertSink,
  type RosterSyncCapabilityContext,
  type RosterSyncDependencies,
  type RosterSyncStore,
} from './groups-sync';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface RosterSyncTestDatabaseContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

interface DatabaseCleanupLatch {
  created: boolean;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i88_roster_[a-f0-9]{32}_test$/u;

const SYNC_TIME = '2026-08-08T16:00:00.000Z';
const CONFIGURATION = Object.freeze({
  id: '00000000-0000-4000-8000-000000000040',
  version: 1,
});
const SOURCE_IDS = Object.freeze({
  north: '00000000-0000-4000-8000-000000000030',
  south: '00000000-0000-4000-8000-000000000031',
  others: '00000000-0000-4000-8000-000000000032',
});
const STAFF_CONFIGURATION = Object.freeze({
  id: '80000000-0000-4000-8000-000000000040',
  version: 1,
});
const STAFF_SOURCE_IDS = Object.freeze({
  north: '80000000-0000-4000-8000-000000000030',
  south: '80000000-0000-4000-8000-000000000031',
  others: '80000000-0000-4000-8000-000000000032',
});

const COMPLETE_FIXTURES = Object.freeze({
  [SOURCE_IDS.north]: Object.freeze([
    Object.freeze({
      memberKey: 'database-north',
      googleSubject: null,
      displayName: 'Synthetic Database North',
      email: 'database-north@example.invalid',
    }),
    Object.freeze({
      memberKey: 'database-shared',
      googleSubject: null,
      displayName: 'Synthetic Database Shared',
      email: 'database-shared@example.invalid',
    }),
  ]),
  [SOURCE_IDS.south]: Object.freeze([
    Object.freeze({
      memberKey: 'database-south',
      googleSubject: null,
      displayName: 'Synthetic Database South',
      email: 'database-south@example.invalid',
    }),
  ]),
  [SOURCE_IDS.others]: Object.freeze([
    Object.freeze({
      memberKey: 'database-shared',
      googleSubject: null,
      displayName: 'Synthetic Database Shared',
      email: 'database-shared@example.invalid',
    }),
  ]),
}) satisfies Readonly<Record<string, readonly RosterGroupMember[]>>;

let context: RosterSyncTestDatabaseContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
const databaseCleanupLatch: DatabaseCleanupLatch = { created: false };

function buildContext(baseDatabaseUrl: string): RosterSyncTestDatabaseContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i88_roster_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable roster-sync database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-88:roster-sync-test:${runId}`,
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
    throw new Error('Roster-sync integration tests require PostgreSQL.');
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
      'The disposable roster-sync database identity is ambiguous.',
    );
  }
  return rows[0]?.marker;
}

function requireDatabaseOwnership(
  createdContext: RosterSyncTestDatabaseContext,
  marker: string | null | undefined,
): void {
  if (marker !== createdContext.marker) {
    throw new Error(
      'Refusing to drop a database without the exact issue #88 roster-sync ownership marker.',
    );
  }
}

function armCleanupAfterVerifiedDatabaseCreation(
  createdContext: RosterSyncTestDatabaseContext,
  marker: string | null | undefined,
  latch: DatabaseCleanupLatch = databaseCleanupLatch,
): void {
  requireDatabaseOwnership(createdContext, marker);
  latch.created = true;
}

async function createOwnedDatabase(
  createdContext: RosterSyncTestDatabaseContext,
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
      const marker = await readDatabaseMarker(
        admin,
        createdContext.databaseName,
      );
      armCleanupAfterVerifiedDatabaseCreation(createdContext, marker);
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(createdContext),
    failureMessage:
      'Disposable roster-sync database operation, creator close, or marker-owned rollback failed.',
  });
}

async function dropOwnedDatabase(
  createdContext: RosterSyncTestDatabaseContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(
        admin,
        createdContext.databaseName,
      );
      if (marker === undefined) return;
      requireDatabaseOwnership(createdContext, marker);
      await admin.db.execute(
        sql.raw(`drop database "${createdContext.databaseName}" with (force)`),
      );
      expect(
        await readDatabaseMarker(admin, createdContext.databaseName),
      ).toBeUndefined();
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Disposable roster-sync database cleanup and connection close both failed.',
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
  if (databaseCleanupLatch.created && context !== undefined) {
    try {
      await dropOwnedDatabase(context);
      databaseCleanupLatch.created = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #88 roster-sync integration test cleanup failed.',
    );
  }
}

function databaseTestContext(): RosterSyncTestDatabaseContext {
  if (context === undefined) {
    throw new Error('The roster-sync test database context is not available.');
  }
  return context;
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The roster-sync PostgreSQL connection is not open.');
  }
  return connection;
}

function createCompleteAdapter(): RosterGroupsAdapter {
  return createMockGoogleGroupsAdapter(COMPLETE_FIXTURES, 1, {
    runtimeMode: 'test',
  });
}

function alertCollector(): Readonly<{
  alerts: RosterSyncAlert[];
  sink: RosterSyncAlertSink;
}> {
  const alerts: RosterSyncAlert[] = [];
  return Object.freeze({
    alerts,
    sink: Object.freeze({
      notify(alert: RosterSyncAlert): void {
        alerts.push(alert);
      },
    }),
  });
}

function syncContext(label: string): RosterSyncCapabilityContext {
  return Object.freeze({
    actor: Object.freeze({
      kind: 'system' as const,
      serviceId: 'roster-sync-job',
    }),
    source: 'scheduled-job' as const,
    transport: 'scheduled-execution' as const,
    schedulerAuthenticated: true as const,
    requestId: randomUUID(),
    idempotencyKey: `db-roster-sync-${label}-${randomUUID()}`,
  });
}

function dependencies(
  database: PostgresDatabase,
  adapter: RosterGroupsAdapter,
  alerts: RosterSyncAlertSink,
  store: RosterSyncStore = createDrizzleRosterSyncStore(database),
): RosterSyncDependencies {
  return Object.freeze({
    store,
    adapter,
    alerts,
    now: () => new Date(SYNC_TIME),
    fetchConcurrency: 3,
  });
}

async function latestSyntheticSnapshot(
  database: PostgresDatabase,
): Promise<Readonly<{ id: string; version: number }>> {
  const rows = await database.execute<{ id: string; version: number }>(sql`
    select id::text as id, version
    from roster_snapshots
    where population = 'synthetic'::roster_population
    order by version desc
    limit 1
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('The seeded synthetic roster snapshot is missing.');
  }
  return Object.freeze(row);
}

async function syntheticSnapshotCount(
  database: PostgresDatabase,
): Promise<number> {
  const rows = await database.execute<{ count: number }>(sql`
    select count(*)::integer as count
    from roster_snapshots
    where population = 'synthetic'::roster_population
  `);
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error('The synthetic snapshot count was unavailable.');
  }
  return count;
}

async function ensureSyntheticConfigurationVersionTwo(
  database: PostgresDatabase,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into roster_source_configurations (
        id, version, population, created_at
      ) values (
        ${CONFIGURATION.id}::uuid,
        2,
        'synthetic'::roster_population,
        ${SYNC_TIME}::timestamptz
      )
      on conflict do nothing
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_facilities (
        configuration_id, configuration_version, facility_id
      )
      select configuration_id, 2, facility_id
      from roster_source_configuration_facilities
      where configuration_id = ${CONFIGURATION.id}::uuid
        and configuration_version = 1
      on conflict do nothing
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_groups (
        configuration_id, configuration_version, population,
        group_source_id, group_source_kind, group_purpose
      )
      select
        configuration_id, 2, population,
        group_source_id, group_source_kind, group_purpose
      from roster_source_configuration_groups
      where configuration_id = ${CONFIGURATION.id}::uuid
        and configuration_version = 1
      on conflict do nothing
    `);
  });
}

async function ensureStaffConfiguration(
  database: PostgresDatabase,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into group_sources (
        id, kind, purpose, facility_id, display_name, active,
        google_group_id, email, fixture_key, created_at
      ) values
        (
          ${STAFF_SOURCE_IDS.north}::uuid,
          'google-group'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000001'::uuid,
          'Synthetic report North staff',
          true,
          'synthetic-stale-report-north',
          'stale-report-north-group@example.invalid',
          null,
          '2026-08-04T12:00:00.000Z'::timestamptz
        ),
        (
          ${STAFF_SOURCE_IDS.south}::uuid,
          'google-group'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000002'::uuid,
          'Synthetic report South staff',
          true,
          'synthetic-stale-report-south',
          'stale-report-south-group@example.invalid',
          null,
          '2026-08-04T12:00:00.000Z'::timestamptz
        ),
        (
          ${STAFF_SOURCE_IDS.others}::uuid,
          'google-group'::group_source_kind,
          'others'::group_purpose,
          null,
          'Synthetic report district staff',
          true,
          'synthetic-stale-report-others',
          'stale-report-others-group@example.invalid',
          null,
          '2026-08-04T12:00:00.000Z'::timestamptz
        )
      on conflict do nothing
    `);
    await transaction.execute(sql`
      insert into roster_source_configurations (
        id, version, population, created_at
      ) values (
        ${STAFF_CONFIGURATION.id}::uuid,
        ${STAFF_CONFIGURATION.version},
        'staff'::roster_population,
        '2026-08-04T12:00:00.000Z'::timestamptz
      )
      on conflict do nothing
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_facilities (
        configuration_id, configuration_version, facility_id
      ) values
        (
          ${STAFF_CONFIGURATION.id}::uuid,
          ${STAFF_CONFIGURATION.version},
          '00000000-0000-4000-8000-000000000001'::uuid
        ),
        (
          ${STAFF_CONFIGURATION.id}::uuid,
          ${STAFF_CONFIGURATION.version},
          '00000000-0000-4000-8000-000000000002'::uuid
        )
      on conflict do nothing
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_groups (
        configuration_id, configuration_version, population,
        group_source_id, group_source_kind, group_purpose
      ) values
        (
          ${STAFF_CONFIGURATION.id}::uuid,
          ${STAFF_CONFIGURATION.version},
          'staff'::roster_population,
          ${STAFF_SOURCE_IDS.north}::uuid,
          'google-group'::group_source_kind,
          'building'::group_purpose
        ),
        (
          ${STAFF_CONFIGURATION.id}::uuid,
          ${STAFF_CONFIGURATION.version},
          'staff'::roster_population,
          ${STAFF_SOURCE_IDS.south}::uuid,
          'google-group'::group_source_kind,
          'building'::group_purpose
        ),
        (
          ${STAFF_CONFIGURATION.id}::uuid,
          ${STAFF_CONFIGURATION.version},
          'staff'::roster_population,
          ${STAFF_SOURCE_IDS.others}::uuid,
          'google-group'::group_source_kind,
          'others'::group_purpose
        )
      on conflict do nothing
    `);
  });
}

function requirePublishedSnapshotId(
  result: Awaited<ReturnType<typeof syncRoster>>,
): string {
  if (result.outcome !== 'complete' || result.publishedSnapshotId === null) {
    throw new Error('Expected a complete roster sync with a snapshot.');
  }
  return result.publishedSnapshotId;
}

describe('roster-sync database cleanup latch', () => {
  test('arms only after exact ownership verification', () => {
    const syntheticContext = buildContext(
      'postgres://synthetic:synthetic@127.0.0.1:5432/psd_eoc_cleanup_test',
    );
    expect(DATABASE_NAME_PATTERN.test(syntheticContext.databaseName)).toBe(
      true,
    );
    const latch: DatabaseCleanupLatch = { created: false };
    armCleanupAfterVerifiedDatabaseCreation(
      syntheticContext,
      syntheticContext.marker,
      latch,
    );
    expect(latch.created).toBe(true);

    const unverifiedLatch: DatabaseCleanupLatch = { created: false };
    expect(() =>
      armCleanupAfterVerifiedDatabaseCreation(
        syntheticContext,
        'wrong-marker',
        unverifiedLatch,
      ),
    ).toThrow(
      'Refusing to drop a database without the exact issue #88 roster-sync ownership marker.',
    );
    expect(unverifiedLatch.created).toBe(false);
  });
});

describeWithDatabase('PostgreSQL roster synchronization', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }

    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      connection = openPostgresConnection(context.databaseUrl, 4);
      await migrateDatabase(connection);
      await seedDatabase(connection.db);
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Roster-sync database setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
  });

  test('requires the exact run marker before disposable database cleanup', () => {
    const currentContext = databaseTestContext();
    expect(() => requireDatabaseOwnership(currentContext, null)).toThrow(
      'Refusing to drop a database without the exact issue #88 roster-sync ownership marker.',
    );
    expect(() =>
      requireDatabaseOwnership(currentContext, 'wrong-marker'),
    ).toThrow(
      'Refusing to drop a database without the exact issue #88 roster-sync ownership marker.',
    );
    expect(() =>
      requireDatabaseOwnership(currentContext, currentContext.marker),
    ).not.toThrow();
  });

  test('atomically publishes a complete snapshot and all relational evidence', async () => {
    const database = databaseConnection().db;
    const previous = await latestSyntheticSnapshot(database);
    const collector = alertCollector();
    const context = syncContext('atomic');

    const result = await syncRoster(
      { sourceConfiguration: CONFIGURATION },
      context,
      dependencies(database, createCompleteAdapter(), collector.sink),
    );
    const snapshotId = requirePublishedSnapshotId(result);

    expect(result.outcome).toBe('complete');
    expect(result.completedSourceGroupRefs).toHaveLength(3);
    expect(result.groupFailures).toEqual([]);
    expect(collector.alerts).toEqual([]);

    const rows = await database.execute<{
      complete: boolean;
      completed_snapshot_sources: number;
      completed_sync_sources: number;
      endpoint_count: number;
      expected_snapshot_sources: number;
      expected_sync_sources: number;
      facility_count: number;
      failure_count: number;
      idempotency_result_reference: string;
      idempotency_status: string;
      provenance_count: number;
      recipient_count: number;
      snapshot_version: number;
      sync_result_count: number;
    }>(sql`
      select
        snapshot.complete,
        snapshot.version as snapshot_version,
        (select count(*)::integer from roster_snapshot_facilities where roster_snapshot_id = snapshot.id) as facility_count,
        (select count(*)::integer from roster_snapshot_sources where roster_snapshot_id = snapshot.id and completion_kind = 'expected') as expected_snapshot_sources,
        (select count(*)::integer from roster_snapshot_sources where roster_snapshot_id = snapshot.id and completion_kind = 'completed') as completed_snapshot_sources,
        (select count(*)::integer from roster_recipients where roster_snapshot_id = snapshot.id) as recipient_count,
        (select count(*)::integer from roster_recipient_group_sources where roster_snapshot_id = snapshot.id) as provenance_count,
        (select count(*)::integer from roster_endpoints where roster_snapshot_id = snapshot.id) as endpoint_count,
        (select count(*)::integer from roster_sync_results where id = ${result.id}::uuid and published_snapshot_id = snapshot.id and outcome = 'complete') as sync_result_count,
        (select count(*)::integer from roster_sync_result_sources where sync_result_id = ${result.id}::uuid and set_kind = 'expected') as expected_sync_sources,
        (select count(*)::integer from roster_sync_result_sources where sync_result_id = ${result.id}::uuid and set_kind = 'completed') as completed_sync_sources,
        (select count(*)::integer from roster_sync_group_failures where sync_result_id = ${result.id}::uuid) as failure_count,
        reservation.status as idempotency_status,
        reservation.result_reference as idempotency_result_reference
      from roster_snapshots as snapshot
      join idempotency_records as reservation
        on reservation.capability_id = 'sync-roster'
       and reservation.key = ${context.idempotencyKey}
      where snapshot.id = ${snapshotId}::uuid
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      complete: true,
      snapshot_version: previous.version + 1,
      facility_count: 2,
      expected_snapshot_sources: 3,
      completed_snapshot_sources: 3,
      recipient_count: 3,
      provenance_count: 4,
      endpoint_count: 3,
      sync_result_count: 1,
      expected_sync_sources: 3,
      completed_sync_sources: 3,
      failure_count: 0,
      idempotency_status: 'completed',
      idempotency_result_reference: `roster-sync-result:${result.id}`,
    });
  });

  test('replays an idempotent completion without refetching or republishing', async () => {
    const database = databaseConnection().db;
    const context = syncContext('replay');
    const firstCollector = alertCollector();
    let initialFetches = 0;
    const completeAdapter = createCompleteAdapter();
    const countedAdapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked' as const,
      fetchPage(
        source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        initialFetches += 1;
        return completeAdapter.fetchPage(source, pageToken);
      },
    });

    const first = await syncRoster(
      { sourceConfiguration: CONFIGURATION },
      context,
      dependencies(database, countedAdapter, firstCollector.sink),
    );
    const snapshotId = requirePublishedSnapshotId(first);
    const snapshotCountAfterFirst = await syntheticSnapshotCount(database);

    let replayFetches = 0;
    const replayAdapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked' as const,
      fetchPage(): Promise<RosterGroupPage> {
        replayFetches += 1;
        return Promise.reject(
          new RosterSyncError(
            'REPLAY_REFETCHED',
            'An idempotent replay unexpectedly reached its provider.',
          ),
        );
      },
    });
    const replayCollector = alertCollector();
    const replay = await syncRoster(
      { sourceConfiguration: CONFIGURATION },
      context,
      dependencies(database, replayAdapter, replayCollector.sink),
    );

    expect(initialFetches).toBe(4);
    expect(replayFetches).toBe(0);
    expect(replay.id).toBe(first.id);
    expect(replay.outcome).toBe('complete');
    expect(replay.publishedSnapshotId).toBe(snapshotId);
    expect(await syntheticSnapshotCount(database)).toBe(
      snapshotCountAfterFirst,
    );
    expect(firstCollector.alerts).toEqual([]);
    expect(replayCollector.alerts).toEqual([]);
  });

  test('fails an abandoned in-progress idempotency reservation without rerunning it', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleRosterSyncStore(database);
    const request = Object.freeze({
      idempotencyKey: `db-roster-abandoned-${randomUUID()}`,
      principal: Object.freeze({
        kind: 'system' as const,
        serviceId: 'roster-sync-job',
      }),
      requestDigest: 'a'.repeat(64),
      startedAt: '2026-08-08T15:00:00.000Z',
    });
    const reserved = await store.reserve(request);
    if (reserved.kind !== 'reserved') {
      throw new Error('Expected a new idempotency reservation.');
    }

    await expect(
      store.reserve({
        ...request,
        startedAt: '2026-08-08T16:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'ROSTER_SYNC_REPLAY_FAILED' });

    const rows = await database.execute<{
      result_reference: string;
      status: string;
    }>(sql`
      select status, result_reference
      from idempotency_records
      where id = ${reserved.id}::uuid
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      status: 'failed',
      result_reference: 'error:ROSTER_SYNC_ABANDONED',
    });
  });

  test('records a partial provider failure without replacing the latest snapshot', async () => {
    const database = databaseConnection().db;
    const latestBefore = await latestSyntheticSnapshot(database);
    const snapshotCountBefore = await syntheticSnapshotCount(database);
    const completeAdapter = createCompleteAdapter();
    const partialAdapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked' as const,
      async fetchPage(
        source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        if (source.id === SOURCE_IDS.others) {
          throw new RosterSyncError(
            'TEST_PROVIDER_PARTIAL_FAILURE',
            'The synthetic provider failed safely for this source.',
          );
        }
        return completeAdapter.fetchPage(source, pageToken);
      },
    });
    const collector = alertCollector();

    const result = await syncRoster(
      { sourceConfiguration: CONFIGURATION },
      syncContext('partial'),
      dependencies(database, partialAdapter, collector.sink),
    );

    expect(result.outcome).toBe('partial-rejected');
    expect(result.publishedSnapshotId).toBeNull();
    expect(result.completedSourceGroupRefs).toHaveLength(2);
    expect(result.groupFailures).toEqual([
      {
        groupSourceRef: {
          id: SOURCE_IDS.others,
          kind: 'synthetic',
          purpose: 'others',
          facilityId: null,
        },
        errorCode: 'TEST_PROVIDER_PARTIAL_FAILURE',
        attemptedAt: SYNC_TIME,
      },
    ]);
    expect(await latestSyntheticSnapshot(database)).toEqual(latestBefore);
    expect(await syntheticSnapshotCount(database)).toBe(snapshotCountBefore);

    const persisted = await database.execute<{
      completed_source_count: number;
      completed_source_rows: number;
      expected_source_count: number;
      expected_source_rows: number;
      failure_count: number;
      failure_rows: number;
      outcome: string;
      published_snapshot_id: string | null;
    }>(sql`
      select
        result.outcome,
        result.published_snapshot_id::text as published_snapshot_id,
        result.expected_source_count,
        result.completed_source_count,
        result.group_failure_count as failure_count,
        (select count(*)::integer from roster_sync_result_sources where sync_result_id = result.id and set_kind = 'expected') as expected_source_rows,
        (select count(*)::integer from roster_sync_result_sources where sync_result_id = result.id and set_kind = 'completed') as completed_source_rows,
        (select count(*)::integer from roster_sync_group_failures where sync_result_id = result.id and error_code = 'TEST_PROVIDER_PARTIAL_FAILURE') as failure_rows
      from roster_sync_results as result
      where result.id = ${result.id}::uuid
    `);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual({
      outcome: 'partial-rejected',
      published_snapshot_id: null,
      expected_source_count: 3,
      completed_source_count: 2,
      failure_count: 1,
      expected_source_rows: 3,
      completed_source_rows: 2,
      failure_rows: 1,
    });
    expect(collector.alerts).toEqual([
      {
        sourceConfiguration: CONFIGURATION,
        population: 'synthetic',
        syncResultId: result.id,
        outcome: 'partial-rejected',
        errorCodes: ['TEST_PROVIDER_PARTIAL_FAILURE'],
        occurredAt: SYNC_TIME,
      },
    ]);
  });

  test('rejects a delayed older source configuration after a newer version publishes', async () => {
    const database = databaseConnection().db;
    await ensureSyntheticConfigurationVersionTwo(database);

    const forwardResult = await syncRoster(
      { sourceConfiguration: { id: CONFIGURATION.id, version: 2 } },
      syncContext('configuration-forward'),
      dependencies(database, createCompleteAdapter(), alertCollector().sink),
    );
    const latestAfterForward = await latestSyntheticSnapshot(database);
    const snapshotCountAfterForward = await syntheticSnapshotCount(database);
    const delayedContext = syncContext('configuration-rollback');
    const collector = alertCollector();
    let providerCalls = 0;
    const baseAdapter = createCompleteAdapter();
    const countedAdapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: baseAdapter.truthLabel,
      fetchPage(source: GroupSource, pageToken: string | null) {
        providerCalls += 1;
        return baseAdapter.fetchPage(source, pageToken);
      },
    });

    await expect(
      syncRoster(
        { sourceConfiguration: CONFIGURATION },
        delayedContext,
        dependencies(database, countedAdapter, collector.sink),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_ROLLBACK' });

    expect(forwardResult.sourceConfiguration).toEqual({
      id: CONFIGURATION.id,
      version: 2,
    });
    expect(providerCalls).toBe(0);
    expect(await latestSyntheticSnapshot(database)).toEqual(latestAfterForward);
    expect(await syntheticSnapshotCount(database)).toBe(
      snapshotCountAfterForward,
    );
    expect(collector.alerts).toEqual([
      expect.objectContaining({
        sourceConfiguration: CONFIGURATION,
        population: 'synthetic',
        outcome: 'execution-failed',
        errorCodes: ['SOURCE_CONFIGURATION_ROLLBACK'],
      }),
    ]);
    const reservationRows = await database.execute<{
      result_reference: string | null;
      status: string;
    }>(sql`
      select status::text as status, result_reference
      from idempotency_records
      where key = ${delayedContext.idempotencyKey}
    `);
    expect(
      reservationRows.map((row) => ({
        status: row.status,
        result_reference: row.result_reference,
      })),
    ).toEqual([
      {
        status: 'failed',
        result_reference: 'error:SOURCE_CONFIGURATION_ROLLBACK',
      },
    ]);
  });

  test('aborts publication when a captured push registration is unregistered before commit', async () => {
    const database = databaseConnection().db;
    const fixture = Object.freeze({
      deviceId: randomUUID(),
      pushRegistrationId: randomUUID(),
      pushUnregistrationId: randomUUID(),
      userId: randomUUID(),
      googleSubject: `synthetic-push-race-${randomUUID()}`,
      token: `synthetic-unroutable:${randomUUID()}`,
    });
    const staffEmail = `synthetic-push-race-${fixture.userId}@psd401.net`;
    await ensureStaffConfiguration(database);
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into users (
          id, google_subject, email, display_name, facility_scope_kind, created_at
        ) values (
          ${fixture.userId}::uuid,
          ${fixture.googleSubject},
          ${staffEmail},
          'Synthetic Push Race Staff',
          'district'::facility_scope_kind,
          ${SYNC_TIME}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into device_enrollments (
          id, user_id, platform, unlock_method, installation_id,
          enrolled_at, last_seen_at, revoked_at
        ) values (
          ${fixture.deviceId}::uuid,
          ${fixture.userId}::uuid,
          'ios'::device_platform,
          'biometric'::device_unlock_method,
          ${`synthetic-push-race-${fixture.deviceId}`},
          ${SYNC_TIME}::timestamptz,
          ${SYNC_TIME}::timestamptz,
          null
        )
      `);
      await transaction.execute(sql`
        insert into device_push_token_registrations (
          id, device_enrollment_id, platform, token, registered_at
        ) values (
          ${fixture.pushRegistrationId}::uuid,
          ${fixture.deviceId}::uuid,
          'ios'::device_platform,
          ${fixture.token},
          ${SYNC_TIME}::timestamptz
        )
      `);
    });

    const baseStore = createDrizzleRosterSyncStore(database);
    let capturedPushEndpoints = 0;
    const racingStore: RosterSyncStore = Object.freeze({
      ...baseStore,
      async loadLocalContacts(googleSubjects: readonly string[]) {
        const contacts = await baseStore.loadLocalContacts(googleSubjects);
        capturedPushEndpoints = contacts.reduce(
          (count, contact) => count + contact.pushEndpoints.length,
          0,
        );
        await database.execute(sql`
          insert into device_push_token_unregistrations (
            id, registration_id, device_enrollment_id, unregistered_at
          ) values (
            ${fixture.pushUnregistrationId}::uuid,
            ${fixture.pushRegistrationId}::uuid,
            ${fixture.deviceId}::uuid,
            ${SYNC_TIME}::timestamptz
          )
        `);
        return contacts;
      },
    });
    const adapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'configured-unverified' as const,
      fetchPage(): Promise<RosterGroupPage> {
        return Promise.resolve({
          members: [
            {
              memberKey: staffEmail,
              googleSubject: null,
              displayName: 'Synthetic Push Race Staff',
              email: staffEmail,
            },
          ],
          nextPageToken: null,
        });
      },
    });
    const collector = alertCollector();
    const snapshotsBefore = await database.execute<{ count: number }>(sql`
      select count(*)::integer as count
      from roster_snapshots
      where population = 'staff'::roster_population
    `);

    await expect(
      syncRoster(
        { sourceConfiguration: STAFF_CONFIGURATION },
        syncContext('push-unregistration-race'),
        dependencies(database, adapter, collector.sink, racingStore),
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_CONTACT_CAPTURE_CHANGED' });

    const snapshotsAfter = await database.execute<{ count: number }>(sql`
      select count(*)::integer as count
      from roster_snapshots
      where population = 'staff'::roster_population
    `);
    expect(capturedPushEndpoints).toBe(1);
    expect(snapshotsAfter[0]?.count).toBe(snapshotsBefore[0]?.count);
    expect(collector.alerts).toEqual([
      expect.objectContaining({
        outcome: 'execution-failed',
        errorCodes: ['LOCAL_CONTACT_CAPTURE_CHANGED'],
      }),
    ]);
  });

  test('serializes concurrent unregistration and enrollment revocation after revalidation', async () => {
    const currentContext = databaseTestContext();
    const database = databaseConnection().db;
    const fixture = Object.freeze({
      deviceId: randomUUID(),
      pushRegistrationId: randomUUID(),
      pushUnregistrationId: randomUUID(),
      userId: randomUUID(),
      googleSubject: `synthetic-locked-push-${randomUUID()}`,
      token: `synthetic-unroutable:${randomUUID()}`,
    });
    const staffEmail = `synthetic-locked-push-${fixture.userId}@psd401.net`;
    await ensureStaffConfiguration(database);
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into users (
          id, google_subject, email, display_name, facility_scope_kind, created_at
        ) values (
          ${fixture.userId}::uuid,
          ${fixture.googleSubject},
          ${staffEmail},
          'Synthetic Locked Push Staff',
          'district'::facility_scope_kind,
          ${SYNC_TIME}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into device_enrollments (
          id, user_id, platform, unlock_method, installation_id,
          enrolled_at, last_seen_at, revoked_at
        ) values (
          ${fixture.deviceId}::uuid,
          ${fixture.userId}::uuid,
          'ios'::device_platform,
          'biometric'::device_unlock_method,
          ${`synthetic-locked-push-${fixture.deviceId}`},
          ${SYNC_TIME}::timestamptz,
          ${SYNC_TIME}::timestamptz,
          null
        )
      `);
      await transaction.execute(sql`
        insert into device_push_token_registrations (
          id, device_enrollment_id, platform, token, registered_at
        ) values (
          ${fixture.pushRegistrationId}::uuid,
          ${fixture.deviceId}::uuid,
          'ios'::device_platform,
          ${fixture.token},
          ${SYNC_TIME}::timestamptz
        )
      `);
    });

    const publisher = openPostgresConnection(currentContext.databaseUrl, 1);
    const unregistrationWriter = openPostgresConnection(
      currentContext.databaseUrl,
      1,
    );
    const revocationWriter = openPostgresConnection(
      currentContext.databaseUrl,
      1,
    );
    let syncPromise: Promise<Awaited<ReturnType<typeof syncRoster>>> | null =
      null;
    let unregistrationPromise: Promise<unknown> | null = null;
    let revocationPromise: Promise<unknown> | null = null;
    try {
      await database.execute(
        sql.raw(
          'drop trigger if exists zz_psd_eoc_test_contact_race_guard on roster_snapshots',
        ),
      );
      await database.execute(
        sql.raw('drop function if exists psd_eoc_test_contact_race_guard()'),
      );
      await database.execute(
        sql.raw('drop sequence if exists psd_eoc_test_contact_race_signal'),
      );
      await database.execute(
        sql.raw('create sequence psd_eoc_test_contact_race_signal'),
      );
      await database.execute(
        sql.raw(`
        create function psd_eoc_test_contact_race_guard()
        returns trigger
        language plpgsql
        as $$
        declare
          deadline timestamptz;
          expected_mutator_pids integer[];
          blocked_mutator_count integer;
        begin
          if current_setting('psd_eoc.test_contact_race', true) is distinct from 'on' then
            return new;
          end if;
          perform nextval('psd_eoc_test_contact_race_signal');
          expected_mutator_pids := string_to_array(
            current_setting('psd_eoc.test_contact_race_mutator_pids', true),
            ','
          )::integer[];
          deadline := clock_timestamp() + interval '5 seconds';
          loop
            select count(*)::integer
            into blocked_mutator_count
            from unnest(expected_mutator_pids) as mutator(pid)
            where pg_backend_pid() = any(pg_blocking_pids(mutator.pid));
            if blocked_mutator_count = cardinality(expected_mutator_pids) then
              return new;
            end if;
            if clock_timestamp() >= deadline then
              raise exception 'Concurrent contact mutations did not block behind roster publication';
            end if;
            perform pg_sleep(0.01);
          end loop;
        end;
        $$
      `),
      );
      await database.execute(
        sql.raw(`
        create trigger zz_psd_eoc_test_contact_race_guard
        before insert on roster_snapshots
        for each row execute function psd_eoc_test_contact_race_guard()
      `),
      );

      const [unregistrationBackend, revocationBackend] = await Promise.all([
        unregistrationWriter.db.execute<{ pid: number }>(sql`
          select pg_backend_pid()::integer as pid
        `),
        revocationWriter.db.execute<{ pid: number }>(sql`
          select pg_backend_pid()::integer as pid
        `),
      ]);
      const unregistrationBackendPid = unregistrationBackend[0]?.pid;
      const revocationBackendPid = revocationBackend[0]?.pid;
      if (
        unregistrationBackendPid === undefined ||
        revocationBackendPid === undefined
      ) {
        throw new Error('Contact mutation backend IDs were unavailable.');
      }
      await publisher.db.execute(sql`
        select
          set_config('psd_eoc.test_contact_race', 'on', false),
          set_config(
            'psd_eoc.test_contact_race_mutator_pids',
            ${`${unregistrationBackendPid},${revocationBackendPid}`},
            false
          )
      `);
      const adapter: RosterGroupsAdapter = Object.freeze({
        truthLabel: 'configured-unverified' as const,
        fetchPage(): Promise<RosterGroupPage> {
          return Promise.resolve({
            members: [
              {
                memberKey: staffEmail,
                googleSubject: null,
                displayName: 'Synthetic Locked Push Staff',
                email: staffEmail,
              },
            ],
            nextPageToken: null,
          });
        },
      });
      syncPromise = syncRoster(
        { sourceConfiguration: STAFF_CONFIGURATION },
        syncContext('locked-contact-race'),
        dependencies(publisher.db, adapter, alertCollector().sink),
      );

      const signalDeadline = Date.now() + 5_000;
      while (true) {
        const signalRows = await database.execute<{ is_called: boolean }>(sql`
          select is_called from psd_eoc_test_contact_race_signal
        `);
        if (signalRows[0]?.is_called === true) {
          break;
        }
        if (Date.now() >= signalDeadline) {
          throw new Error('Roster publication did not reach the race guard.');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      unregistrationPromise = unregistrationWriter.db.execute(sql`
        insert into device_push_token_unregistrations (
          id, registration_id, device_enrollment_id, unregistered_at
        ) values (
          ${fixture.pushUnregistrationId}::uuid,
          ${fixture.pushRegistrationId}::uuid,
          ${fixture.deviceId}::uuid,
          ${SYNC_TIME}::timestamptz
        )
      `);
      revocationPromise = revocationWriter.db.execute(sql`
        update device_enrollments
        set revoked_at = ${SYNC_TIME}::timestamptz
        where id = ${fixture.deviceId}::uuid
      `);

      const [result] = await Promise.all([
        syncPromise,
        unregistrationPromise,
        revocationPromise,
      ]);
      const publishedSnapshotId = requirePublishedSnapshotId(result);
      const committedRows = await database.execute<{
        endpoint_count: number;
        revoked_at: Date | null;
        unregistration_count: number;
      }>(sql`
        select
          (
            select count(*)::integer
            from roster_endpoints
            where roster_snapshot_id = ${publishedSnapshotId}::uuid
              and id = ${fixture.pushRegistrationId}::uuid
          ) as endpoint_count,
          (
            select revoked_at
            from device_enrollments
            where id = ${fixture.deviceId}::uuid
          ) as revoked_at,
          (
            select count(*)::integer
            from device_push_token_unregistrations
            where registration_id = ${fixture.pushRegistrationId}::uuid
          ) as unregistration_count
      `);
      expect(committedRows[0]?.endpoint_count).toBe(1);
      expect(committedRows[0]?.revoked_at).not.toBeNull();
      expect(committedRows[0]?.unregistration_count).toBe(1);
    } finally {
      await Promise.allSettled(
        [syncPromise, unregistrationPromise, revocationPromise].filter(
          (promise): promise is Promise<unknown> => promise !== null,
        ),
      );
      await Promise.all([
        publisher.close(),
        unregistrationWriter.close(),
        revocationWriter.close(),
      ]);
      await database.execute(
        sql.raw(
          'drop trigger if exists zz_psd_eoc_test_contact_race_guard on roster_snapshots',
        ),
      );
      await database.execute(
        sql.raw('drop function if exists psd_eoc_test_contact_race_guard()'),
      );
      await database.execute(
        sql.raw('drop sequence if exists psd_eoc_test_contact_race_signal'),
      );
    }
  });

  test('prevents a delayed concurrent sync from overwriting a newer snapshot', async () => {
    const database = databaseConnection().db;
    await ensureSyntheticConfigurationVersionTwo(database);
    const sourceConfiguration = Object.freeze({
      id: CONFIGURATION.id,
      version: 2,
    });
    const latestBefore = await latestSyntheticSnapshot(database);
    const snapshotCountBefore = await syntheticSnapshotCount(database);
    const completeAdapter = createCompleteAdapter();
    let northArrivals = 0;
    let totalFetches = 0;
    let releaseNorthGate: (() => void) | undefined;
    const northGate = new Promise<void>((resolve) => {
      releaseNorthGate = resolve;
    });
    const concurrentAdapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked' as const,
      async fetchPage(
        source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        totalFetches += 1;
        if (source.id === SOURCE_IDS.north && pageToken === null) {
          northArrivals += 1;
          if (northArrivals === 2) {
            releaseNorthGate?.();
          }
          await northGate;
        }
        return completeAdapter.fetchPage(source, pageToken);
      },
    });
    const collector = alertCollector();
    const baseStore = createDrizzleRosterSyncStore(database);
    let baselineArrivals = 0;
    let releaseBaselineGate: (() => void) | undefined;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaselineGate = resolve;
    });
    const synchronizedBaselineStore: RosterSyncStore = Object.freeze({
      ...baseStore,
      async loadLatestCompleteBaseline(population: RosterPopulation) {
        const baseline = await baseStore.loadLatestCompleteBaseline(population);
        baselineArrivals += 1;
        if (baselineArrivals === 2) {
          releaseBaselineGate?.();
        }
        await baselineGate;
        return baseline;
      },
    });
    const syncDependencies = dependencies(
      database,
      concurrentAdapter,
      collector.sink,
      synchronizedBaselineStore,
    );

    const settled = await Promise.allSettled([
      syncRoster(
        { sourceConfiguration },
        syncContext('concurrent-a'),
        syncDependencies,
      ),
      syncRoster(
        { sourceConfiguration },
        syncContext('concurrent-b'),
        syncDependencies,
      ),
    ]);
    const completed = settled.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof syncRoster>>
      > => result.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(completed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = completed[0]?.value;
    if (winner === undefined) {
      throw new Error('Concurrent roster publication had no winner.');
    }
    const snapshotId = requirePublishedSnapshotId(winner);

    const publishedRows = await database.execute<{
      id: string;
      version: number;
    }>(sql`
      select id::text as id, version
      from roster_snapshots
      where id = ${snapshotId}::uuid
      order by version
    `);

    expect(northArrivals).toBe(2);
    expect(baselineArrivals).toBe(2);
    expect(totalFetches).toBe(8);
    expect(rejected[0]?.reason).toMatchObject({
      code: 'ROSTER_BASELINE_CHANGED',
    });
    expect(publishedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: snapshotId,
          version: latestBefore.version + 1,
        }),
      ]),
    );
    expect(await syntheticSnapshotCount(database)).toBe(
      snapshotCountBefore + 1,
    );
    expect((await latestSyntheticSnapshot(database)).version).toBe(
      latestBefore.version + 1,
    );
    expect(collector.alerts).toEqual([
      expect.objectContaining({
        outcome: 'execution-failed',
        errorCodes: ['ROSTER_BASELINE_CHANGED'],
      }),
    ]);
  });
});
