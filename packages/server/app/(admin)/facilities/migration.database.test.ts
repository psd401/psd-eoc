import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { sql } from 'drizzle-orm';
import { migrate as migrateWithPostgres } from 'drizzle-orm/postgres-js/migrator';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase, migrationsFolder } from '../../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../event-types/test-database';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(120_000);

const ids = {
  seedFacilityNorth: '00000000-0000-4000-8000-000000000001',
  seedFacilitySouth: '00000000-0000-4000-8000-000000000002',
  upgradeStatusOld: '26050000-0000-4000-8000-000000000001',
  upgradeStatusLatest: '26050000-0000-4000-8000-000000000002',
  statusInitial: '26050000-0000-4000-8000-000000000010',
  statusLatest: '26050000-0000-4000-8000-000000000011',
  statusOlder: '26050000-0000-4000-8000-000000000012',
  statusEqual: '26050000-0000-4000-8000-000000000013',
  statusRaceFirst: '26050000-0000-4000-8000-000000000014',
  statusRaceSecond: '26050000-0000-4000-8000-000000000015',
  roleUser: '26050000-0000-4000-8000-000000000016',
  rosterConfiguration: '26050000-0000-4000-8000-000000000020',
  otherRosterConfiguration: '26050000-0000-4000-8000-000000000021',
  rosterSnapshotOne: '26050000-0000-4000-8000-000000000022',
  rosterSnapshotSkip: '26050000-0000-4000-8000-000000000023',
  rosterSnapshotTwo: '26050000-0000-4000-8000-000000000024',
  neighborhood: '26050000-0000-4000-8000-000000000030',
  audience: '26050000-0000-4000-8000-000000000031',
  adminFacility: '26050000-0000-4000-8000-000000000032',
  staffGroup: '26050000-0000-4000-8000-000000000033',
  movedAudience: '26050000-0000-4000-8000-000000000034',
} as const;

const times = {
  upgradeOld: '2026-08-08T10:00:00.000Z',
  upgradeLatest: '2026-08-08T10:01:00.000Z',
  statusInitial: '2026-08-09T10:00:00.000Z',
  statusLatest: '2026-08-09T10:01:00.000Z',
  statusOlder: '2026-08-09T09:59:00.000Z',
  statusRace: '2026-08-09T11:00:00.000Z',
  rosterOne: '2026-08-09T12:00:00.000Z',
  rosterTwo: '2026-08-09T12:01:00.000Z',
  rosterThree: '2026-08-09T12:02:00.000Z',
  snapshotOne: '2026-08-09T13:00:00.000Z',
  snapshotTwo: '2026-08-09T13:01:00.000Z',
  adminOne: '2026-08-09T14:00:00.000Z',
  adminTwo: '2026-08-09T14:01:00.000Z',
} as const;

interface MigrationTestContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface TextSnapshotRow extends Record<string, unknown> {
  readonly snapshot: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

interface CountRow extends Record<string, unknown> {
  readonly count: number;
}

interface ChannelProjectionRow extends Record<string, unknown> {
  readonly integration_id: string;
  readonly enabled: boolean;
  readonly status_id: string;
  readonly latest_status_id: string;
  readonly status_label: string;
  readonly latest_status_label: string;
}

interface ChannelStateRow extends Record<string, unknown> {
  readonly enabled: boolean;
  readonly status_id: string;
  readonly status_label: string;
}

interface ProcessRow extends Record<string, unknown> {
  readonly pid: number;
}

interface PrivilegeRow extends Record<string, unknown> {
  readonly can_delete: boolean;
  readonly can_insert: boolean;
  readonly can_update: boolean;
}

interface NullableSnapshotRow extends Record<string, unknown> {
  readonly snapshot: string | null;
}

interface LineageCountRow extends Record<string, unknown> {
  readonly facility_count: number;
  readonly row_count: number;
}

interface MigrationArtifactRow extends Record<string, unknown> {
  readonly authorization_table: string | null;
  readonly role_change_table: string | null;
}

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface MigrationJournal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly JournalEntry[];
}

const DATABASE_NAME_PATTERN = /^psd_eoc_issue26_migration_[a-f0-9]{32}_test$/u;
const PARTIAL_MIGRATION_DIRECTORY_PATTERN =
  /^psd-eoc-issue26-migration-[A-Za-z0-9_-]+$/u;

let context: MigrationTestContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
let partialMigrationsDirectory: string | undefined;
let databaseCreated = false;
let statusRowsBeforeUpgrade: readonly string[] = [];
let statusRowsAfterFirstMigration: readonly string[] = [];
let statusRowsAfterSecondMigration: readonly string[] = [];
let channelRowsAfterFirstMigration: readonly string[] = [];
let channelRowsAfterSecondMigration: readonly string[] = [];

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The issue #26 migration test database is not open.');
  }
  return connection;
}

function buildContext(baseDatabaseUrl: string): MigrationTestContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_issue26_migration_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable migration database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-26:migration-test:${runId}`,
  });
}

function openPostgresConnection(
  url: string,
  maxConnections = 2,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Issue #26 migration proofs require PostgreSQL.');
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
    throw new Error('The disposable migration database identity is ambiguous.');
  }
  return rows[0]?.marker;
}

async function createOwnedDatabase(
  createdContext: MigrationTestContext,
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
          'Disposable migration database creation and rollback both failed.',
        );
      }
    }
    throw error;
  } finally {
    await admin.close();
  }
}

async function dropOwnedDatabase(
  createdContext: MigrationTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  try {
    const marker = await readDatabaseMarker(admin, createdContext.databaseName);
    if (marker === undefined) return;
    if (marker !== createdContext.marker) {
      throw new Error(
        'Refusing to drop a database without the exact issue #26 ownership marker.',
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

function parseMigrationJournal(value: string): MigrationJournal {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(Reflect.get(parsed, 'entries')) ||
    typeof Reflect.get(parsed, 'version') !== 'string' ||
    typeof Reflect.get(parsed, 'dialect') !== 'string'
  ) {
    throw new Error('The Drizzle migration journal is malformed.');
  }
  const entries = Reflect.get(parsed, 'entries') as readonly unknown[];
  if (
    !entries.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        Number.isInteger(Reflect.get(entry, 'idx')) &&
        typeof Reflect.get(entry, 'version') === 'string' &&
        typeof Reflect.get(entry, 'when') === 'number' &&
        typeof Reflect.get(entry, 'tag') === 'string' &&
        typeof Reflect.get(entry, 'breakpoints') === 'boolean',
    )
  ) {
    throw new Error('The Drizzle migration journal entries are malformed.');
  }
  return parsed as MigrationJournal;
}

async function prepareMigrationsThrough0004(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-issue26-migration-'));
  try {
    const journal = parseMigrationJournal(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    );
    const entries = journal.entries.filter((entry) => entry.idx <= 4);
    if (
      entries.length !== 5 ||
      entries.some((entry, index) => entry.idx !== index) ||
      entries[4]?.tag !== '0004_volatile_purple_man'
    ) {
      throw new Error('Expected the exact contiguous 0000-0004 migration set.');
    }

    await mkdir(join(directory, 'meta'));
    await writeFile(
      join(directory, 'meta', '_journal.json'),
      `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
      'utf8',
    );
    await Promise.all(
      entries.map(async (entry) => {
        await copyFile(
          join(migrationsFolder, `${entry.tag}.sql`),
          join(directory, `${entry.tag}.sql`),
        );
      }),
    );
    return directory;
  } catch (error) {
    try {
      await removePartialMigrationsDirectory(directory);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Partial migration preparation and cleanup both failed.',
      );
    }
    throw error;
  }
}

async function removePartialMigrationsDirectory(
  directory: string,
): Promise<void> {
  if (
    !directory.startsWith(`${tmpdir()}/`) ||
    !PARTIAL_MIGRATION_DIRECTORY_PATTERN.test(basename(directory))
  ) {
    throw new Error('Refusing to remove an unrecognized migration directory.');
  }
  await rm(directory, { recursive: true, force: true });
}

async function statusSnapshot(
  database: PostgresDatabase,
): Promise<readonly string[]> {
  return databaseExecuteRows<TextSnapshotRow>(
    await database.execute<TextSnapshotRow>(sql`
      select jsonb_build_object(
        'id', id::text,
        'integrationId', integration_id,
        'label', label::text,
        'verifiedAt', verified_at,
        'verifiedByUserId', verified_by_user_id::text,
        'authorizationReference', authorization_reference,
        'reasonCode', reason_code,
        'observedAt', observed_at
      )::text as snapshot
      from integration_statuses
      order by id
    `),
  ).map((row) => row.snapshot);
}

async function channelSnapshot(
  database: PostgresDatabase,
): Promise<readonly string[]> {
  return databaseExecuteRows<TextSnapshotRow>(
    await database.execute<TextSnapshotRow>(sql`
      select jsonb_build_object(
        'integrationId', integration_id,
        'enabled', enabled,
        'statusId', status_id::text,
        'statusLabel', status_label::text,
        'changedAt', changed_at
      )::text as snapshot
      from channel_configurations
      order by integration_id
    `),
  ).map((row) => row.snapshot);
}

async function seedUpgradeFixture(database: PostgresDatabase): Promise<void> {
  await seedDatabase(database);
  await database.execute(sql`
    insert into integration_statuses (
      id,
      integration_id,
      label,
      verified_at,
      verified_by_user_id,
      authorization_reference,
      reason_code,
      observed_at
    )
    values
      (
        ${ids.upgradeStatusOld}::uuid,
        'upgrade-channel',
        'configured-unverified'::integration_truth_label,
        null,
        null,
        null,
        null,
        ${times.upgradeOld}::timestamptz
      ),
      (
        ${ids.upgradeStatusLatest}::uuid,
        'upgrade-channel',
        'mocked'::integration_truth_label,
        null,
        null,
        null,
        null,
        ${times.upgradeLatest}::timestamptz
      )
  `);
  await database.execute(sql`
    insert into channel_configurations (
      integration_id,
      enabled,
      status_id,
      status_label,
      changed_at
    )
    values (
      'upgrade-channel',
      true,
      ${ids.upgradeStatusOld}::uuid,
      'configured-unverified'::integration_truth_label,
      ${times.upgradeOld}::timestamptz
    )
  `);
}

function postgresErrorFacts(
  error: unknown,
  field: 'code' | 'message',
): readonly string[] {
  const visited = new Set<unknown>();
  const facts: string[] = [];
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const value = Reflect.get(current, field);
    if (typeof value === 'string') facts.push(value);
    current = Reflect.get(current, 'cause');
  }
  return facts;
}

function expectOperationalError(error: unknown): void {
  expect(postgresErrorFacts(error, 'code')).toContain('55000');
  expect(postgresErrorFacts(error, 'message').join('\n')).not.toHaveLength(0);
}

async function expectOperationalRejection(
  operation: () => Promise<unknown>,
  expectedMessage?: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expectOperationalError(error);
    if (expectedMessage !== undefined) {
      expect(postgresErrorFacts(error, 'message').join('\n')).toMatch(
        expectedMessage,
      );
    }
    return;
  }
  throw new Error('Expected PostgreSQL to reject an invalid history insert.');
}

async function insertMockedStatus(
  database: PostgresDatabase,
  input: Readonly<{
    id: string;
    integrationId: string;
    observedAt: string;
    label?: 'mocked' | 'configured-unverified';
  }>,
): Promise<void> {
  await database.execute(sql`
    insert into integration_statuses (
      id,
      integration_id,
      label,
      verified_at,
      verified_by_user_id,
      authorization_reference,
      reason_code,
      observed_at
    )
    values (
      ${input.id}::uuid,
      ${input.integrationId},
      ${input.label ?? 'mocked'}::integration_truth_label,
      null,
      null,
      null,
      null,
      ${input.observedAt}::timestamptz
    )
    on conflict do nothing
  `);
}

async function insertRosterConfiguration(
  database: PostgresDatabase,
  input: Readonly<{
    id: string;
    version: number;
    createdAt: string;
  }>,
): Promise<void> {
  await database.execute(sql`
    insert into roster_source_configurations (
      id,
      version,
      population,
      created_at
    )
    values (
      ${input.id}::uuid,
      ${input.version},
      'staff'::roster_population,
      ${input.createdAt}::timestamptz
    )
    on conflict do nothing
  `);
}

async function insertRosterSnapshot(
  database: PostgresDatabase,
  input: Readonly<{
    id: string;
    version: number;
    configurationVersion: number;
    capturedAt: string;
  }>,
): Promise<void> {
  await database.execute(sql`
    insert into roster_snapshots (
      id,
      version,
      population,
      complete,
      source_configuration_id,
      source_configuration_version,
      sync_started_at,
      captured_at
    )
    values (
      ${input.id}::uuid,
      ${input.version},
      'staff'::roster_population,
      true,
      ${ids.rosterConfiguration}::uuid,
      ${input.configurationVersion},
      ${input.capturedAt}::timestamptz,
      ${input.capturedAt}::timestamptz
    )
    on conflict do nothing
  `);
}

async function waitForAdvisoryLock(
  database: PostgresDatabase,
  pid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = databaseExecuteRows<CountRow>(
      await database.execute<CountRow>(sql`
        select count(*)::integer as count
        from pg_stat_activity
        where pid = ${pid}
          and wait_event_type = 'Lock'
          and lower(coalesce(wait_event, '')) = 'advisory'
      `),
    );
    if (rows[0]?.count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    'The competing status insert never waited on its advisory lock.',
  );
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
  if (partialMigrationsDirectory !== undefined) {
    try {
      await removePartialMigrationsDirectory(partialMigrationsDirectory);
      partialMigrationsDirectory = undefined;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #26 migration test cleanup failed.',
    );
  }
}

async function cleanupIsolatedUpgradeProof(input: {
  readonly context: MigrationTestContext;
  readonly connections: readonly PostgresDatabaseConnection[];
  readonly databaseCreated: boolean;
  readonly partialMigrationsDirectory: string | undefined;
}): Promise<void> {
  const errors: unknown[] = [];
  for (const isolatedConnection of input.connections) {
    try {
      await isolatedConnection.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.databaseCreated) {
    try {
      await dropOwnedDatabase(input.context);
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.partialMigrationsDirectory !== undefined) {
    try {
      await removePartialMigrationsDirectory(input.partialMigrationsDirectory);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Isolated negative-upgrade proof cleanup failed.',
    );
  }
}

describeWithDatabase('issue #26 PostgreSQL migration safety', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for migration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      databaseCreated = true;
      connection = openPostgresConnection(context.databaseUrl, 4);
      partialMigrationsDirectory = await prepareMigrationsThrough0004();
      await migrateWithPostgres(connection.db, {
        migrationsFolder: partialMigrationsDirectory,
      });
      await seedUpgradeFixture(connection.db);
      statusRowsBeforeUpgrade = await statusSnapshot(connection.db);

      await migrateDatabase(connection);
      statusRowsAfterFirstMigration = await statusSnapshot(connection.db);
      channelRowsAfterFirstMigration = await channelSnapshot(connection.db);

      await migrateDatabase(connection);
      statusRowsAfterSecondMigration = await statusSnapshot(connection.db);
      channelRowsAfterSecondMigration = await channelSnapshot(connection.db);
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Migration setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
  });

  test('upgrades 0000-0004 without rewriting truth and reconciles stale channels idempotently', async () => {
    const db = databaseConnection().db;
    expect(statusRowsAfterFirstMigration).toEqual(statusRowsBeforeUpgrade);
    expect(statusRowsAfterSecondMigration).toEqual(statusRowsBeforeUpgrade);
    expect(channelRowsAfterSecondMigration).toEqual(
      channelRowsAfterFirstMigration,
    );

    const projections = databaseExecuteRows<ChannelProjectionRow>(
      await db.execute<ChannelProjectionRow>(sql`
        select
          configuration.integration_id,
          configuration.enabled,
          configuration.status_id::text as status_id,
          latest.id::text as latest_status_id,
          configuration.status_label::text as status_label,
          latest.label::text as latest_status_label
        from channel_configurations as configuration
        cross join lateral (
          select status.id, status.label
          from integration_statuses as status
          where status.integration_id = configuration.integration_id
          order by status.observed_at desc, status.id desc
          limit 1
        ) as latest
        order by configuration.integration_id
      `),
    );
    expect(projections.length).toBeGreaterThan(0);
    expect(
      projections.every(
        (row) =>
          !row.enabled &&
          row.status_id === row.latest_status_id &&
          row.status_label === row.latest_status_label,
      ),
    ).toBe(true);
    expect(
      projections.find((row) => row.integration_id === 'upgrade-channel'),
    ).toMatchObject({
      enabled: false,
      status_id: ids.upgradeStatusLatest,
      latest_status_id: ids.upgradeStatusLatest,
      status_label: 'mocked',
      latest_status_label: 'mocked',
    });
  });

  test('rejects a legacy audience lineage moved across facilities before applying 0005', async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for migration tests.');
    }
    const isolatedContext = buildContext(baseTestDatabaseUrl);
    let isolatedConnection: PostgresDatabaseConnection | undefined;
    let isolatedDirectory: string | undefined;
    let isolatedDatabaseCreated = false;
    try {
      await createOwnedDatabase(isolatedContext);
      isolatedDatabaseCreated = true;
      const createdConnection = openPostgresConnection(
        isolatedContext.databaseUrl,
        2,
      );
      isolatedConnection = createdConnection;
      isolatedDirectory = await prepareMigrationsThrough0004();
      await migrateWithPostgres(createdConnection.db, {
        migrationsFolder: isolatedDirectory,
      });
      await createdConnection.db.execute(sql`
        insert into facilities (id, code, name, active, created_at)
        values
          (
            ${ids.seedFacilityNorth}::uuid,
            'SYN-MOVED-A',
            'Synthetic moved-lineage campus A',
            true,
            ${times.adminOne}::timestamptz
          ),
          (
            ${ids.seedFacilitySouth}::uuid,
            'SYN-MOVED-B',
            'Synthetic moved-lineage campus B',
            true,
            ${times.adminOne}::timestamptz
          )
      `);
      await createdConnection.db.execute(sql`
        insert into audience_configurations (
          id,
          facility_id,
          version,
          created_at
        )
        values
          (
            ${ids.movedAudience}::uuid,
            ${ids.seedFacilityNorth}::uuid,
            1,
            ${times.adminOne}::timestamptz
          ),
          (
            ${ids.movedAudience}::uuid,
            ${ids.seedFacilitySouth}::uuid,
            2,
            ${times.adminTwo}::timestamptz
          )
      `);

      await expectOperationalRejection(
        () => migrateDatabase(createdConnection),
        /audience configuration lineage.+facilities/iu,
      );

      const lineageRows = databaseExecuteRows<LineageCountRow>(
        await createdConnection.db.execute<LineageCountRow>(sql`
          select
            count(*)::integer as row_count,
            count(distinct facility_id)::integer as facility_count
          from audience_configurations
          where id = ${ids.movedAudience}::uuid
        `),
      );
      expect(lineageRows).toEqual([{ row_count: 2, facility_count: 2 }]);
      const newTable = databaseExecuteRows<NullableSnapshotRow>(
        await createdConnection.db.execute<NullableSnapshotRow>(sql`
          select to_regclass(
            'public.integration_channel_change_authorizations'
          )::text as snapshot
        `),
      );
      expect(newTable).toEqual([{ snapshot: null }]);
    } finally {
      await cleanupIsolatedUpgradeProof({
        context: isolatedContext,
        connections:
          isolatedConnection === undefined ? [] : [isolatedConnection],
        databaseCreated: isolatedDatabaseCreated,
        partialMigrationsDirectory: isolatedDirectory,
      });
    }
  });

  test('fails a contended 0004 upgrade immediately and retries after the reader releases', async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for migration tests.');
    }
    const isolatedContext = buildContext(baseTestDatabaseUrl);
    let migrationConnection: PostgresDatabaseConnection | undefined;
    let lockHolderConnection: PostgresDatabaseConnection | undefined;
    let isolatedDirectory: string | undefined;
    let isolatedDatabaseCreated = false;
    let releaseLock: (() => void) | undefined;
    let lockHolderTransaction: Promise<unknown> | undefined;
    let migrationOutcome:
      | Promise<
          | { readonly kind: 'error'; readonly error: unknown }
          | { readonly kind: 'success' }
        >
      | undefined;
    try {
      await createOwnedDatabase(isolatedContext);
      isolatedDatabaseCreated = true;
      const createdMigrationConnection = openPostgresConnection(
        isolatedContext.databaseUrl,
        1,
      );
      migrationConnection = createdMigrationConnection;
      isolatedDirectory = await prepareMigrationsThrough0004();
      await migrateWithPostgres(createdMigrationConnection.db, {
        migrationsFolder: isolatedDirectory,
      });

      const createdLockHolderConnection = openPostgresConnection(
        isolatedContext.databaseUrl,
        1,
      );
      lockHolderConnection = createdLockHolderConnection;
      let reportLockHeld: (() => void) | undefined;
      const lockHeld = new Promise<void>((resolve) => {
        reportLockHeld = resolve;
      });
      const releaseGate = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      lockHolderTransaction = Promise.resolve(
        createdLockHolderConnection.db.transaction(async (transaction) => {
          await transaction.execute(sql`
            lock table public.integration_statuses in access share mode
          `);
          reportLockHeld?.();
          await releaseGate;
        }),
      );
      await lockHeld;

      migrationOutcome = migrateDatabase(createdMigrationConnection).then(
        () => ({ kind: 'success' as const }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutOutcome = new Promise<{ readonly kind: 'timeout' }>(
        (resolve) => {
          timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), 2_000);
        },
      );
      const firstOutcome = await Promise.race([
        migrationOutcome,
        timeoutOutcome,
      ]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (firstOutcome.kind === 'timeout') {
        throw new Error(
          'The contended 0005 migration waited instead of failing NOWAIT.',
        );
      }
      if (firstOutcome.kind === 'success') {
        throw new Error(
          'The contended 0005 migration succeeded while ACCESS SHARE was held.',
        );
      }
      expect(postgresErrorFacts(firstOutcome.error, 'code')).toContain('55P03');

      const rolledBackArtifacts = databaseExecuteRows<MigrationArtifactRow>(
        await createdMigrationConnection.db.execute<MigrationArtifactRow>(
          sql`
              select
                to_regclass(
                  'public.integration_channel_change_authorizations'
                )::text as authorization_table,
                to_regclass(
                  'public.user_role_changes'
                )::text as role_change_table
            `,
        ),
      );
      expect(rolledBackArtifacts).toEqual([
        { authorization_table: null, role_change_table: null },
      ]);
      const migrationCountBeforeRetry = databaseExecuteRows<CountRow>(
        await createdMigrationConnection.db.execute<CountRow>(sql`
          select count(*)::integer as count
          from drizzle.__drizzle_migrations
        `),
      );
      expect(migrationCountBeforeRetry).toEqual([{ count: 5 }]);

      releaseLock?.();
      await lockHolderTransaction;
      lockHolderTransaction = undefined;
      await migrateDatabase(createdMigrationConnection);

      const appliedArtifacts = databaseExecuteRows<MigrationArtifactRow>(
        await createdMigrationConnection.db.execute<MigrationArtifactRow>(sql`
          select
            to_regclass(
              'public.integration_channel_change_authorizations'
            )::text as authorization_table,
            to_regclass('public.user_role_changes')::text as role_change_table
        `),
      );
      expect(appliedArtifacts).toEqual([
        {
          authorization_table: 'integration_channel_change_authorizations',
          role_change_table: 'user_role_changes',
        },
      ]);
      const migrationCountAfterRetry = databaseExecuteRows<CountRow>(
        await createdMigrationConnection.db.execute<CountRow>(sql`
          select count(*)::integer as count
          from drizzle.__drizzle_migrations
        `),
      );
      expect(migrationCountAfterRetry).toEqual([{ count: 6 }]);
    } finally {
      releaseLock?.();
      if (lockHolderTransaction !== undefined) {
        await Promise.allSettled([lockHolderTransaction]);
      }
      if (migrationOutcome !== undefined) {
        await migrationOutcome;
      }
      await cleanupIsolatedUpgradeProof({
        context: isolatedContext,
        connections: [migrationConnection, lockHolderConnection].filter(
          (candidate): candidate is PostgresDatabaseConnection =>
            candidate !== undefined,
        ),
        databaseCreated: isolatedDatabaseCreated,
        partialMigrationsDirectory: isolatedDirectory,
      });
    }
  });

  test('installs the exact monotonic and construction guards', async () => {
    const db = databaseConnection().db;
    const triggers = databaseExecuteRows<TextSnapshotRow>(
      await db.execute<TextSnapshotRow>(sql`
        select trigger_name as snapshot
        from information_schema.triggers
        where trigger_schema = 'public'
          and trigger_name in (
            'integration_statuses_monotonic_insert_guard',
            'integration_statuses_channel_configuration_sync',
            'roster_source_configurations_monotonic_insert_guard',
            'roster_snapshots_monotonic_insert_guard',
            'neighborhood_versions_monotonic_insert_guard',
            'audience_configurations_monotonic_insert_guard',
            'audience_targets_construction_guard',
            'neighborhood_facilities_construction_guard',
            'user_roles_immutable_guard'
          )
        order by trigger_name
      `),
    ).map((row) => row.snapshot);
    expect(triggers).toEqual([
      'audience_configurations_monotonic_insert_guard',
      'audience_targets_construction_guard',
      'integration_statuses_channel_configuration_sync',
      'integration_statuses_monotonic_insert_guard',
      'neighborhood_facilities_construction_guard',
      'neighborhood_versions_monotonic_insert_guard',
      'roster_snapshots_monotonic_insert_guard',
      'roster_source_configurations_monotonic_insert_guard',
      'user_roles_immutable_guard',
    ]);

    const privileges = databaseExecuteRows<PrivilegeRow>(
      await db.execute<PrivilegeRow>(sql`
        select
          has_table_privilege(
            'psd_eoc_app',
            'public.user_roles',
            'INSERT'
          ) as can_insert,
          has_table_privilege(
            'psd_eoc_app',
            'public.user_roles',
            'UPDATE'
          ) as can_update,
          has_table_privilege(
            'psd_eoc_app',
            'public.user_roles',
            'DELETE'
          ) as can_delete
      `),
    );
    expect(privileges).toEqual([
      { can_insert: false, can_update: false, can_delete: false },
    ]);

    await db.execute(sql`
      insert into users (
        id,
        google_subject,
        email,
        display_name,
        facility_scope_kind,
        created_at
      )
      values (
        ${ids.roleUser}::uuid,
        'issue-26-migration-role-user',
        'issue-26-migration-role-user@psd401.net',
        'Issue 26 synthetic role user',
        'district'::facility_scope_kind,
        ${times.adminOne}::timestamptz
      )
    `);
    await db.execute(sql`
      insert into user_roles (user_id, role)
      values (${ids.roleUser}::uuid, 'staff'::role)
    `);
    await expectOperationalRejection(() =>
      db.execute(sql`
        update user_roles
        set role = 'admin'::role
        where user_id = ${ids.roleUser}::uuid
          and role = 'staff'::role
      `),
    );
  });

  test('accepts exact status retries but rejects older, equal, and mismatched observations', async () => {
    const db = databaseConnection().db;
    const integrationId = 'guarded-status';
    const initial = {
      id: ids.statusInitial,
      integrationId,
      observedAt: times.statusInitial,
    } as const;
    await insertMockedStatus(db, initial);
    await insertMockedStatus(db, initial);
    await db.execute(sql`
      insert into channel_configurations (
        integration_id,
        enabled,
        status_id,
        status_label,
        changed_at
      )
      values (
        ${integrationId},
        true,
        ${ids.statusInitial}::uuid,
        'mocked'::integration_truth_label,
        ${times.statusInitial}::timestamptz
      )
    `);
    await insertMockedStatus(db, {
      id: ids.statusLatest,
      integrationId,
      observedAt: times.statusLatest,
    });
    await insertMockedStatus(db, initial);

    await expectOperationalRejection(() =>
      insertMockedStatus(db, {
        id: ids.statusOlder,
        integrationId,
        observedAt: times.statusOlder,
      }),
    );
    await expectOperationalRejection(() =>
      insertMockedStatus(db, {
        id: ids.statusEqual,
        integrationId,
        observedAt: times.statusLatest,
      }),
    );
    await expectOperationalRejection(() =>
      insertMockedStatus(db, {
        ...initial,
        label: 'configured-unverified',
      }),
    );

    const rows = databaseExecuteRows<CountRow>(
      await db.execute<CountRow>(sql`
        select count(*)::integer as count
        from integration_statuses
        where integration_id = ${integrationId}
      `),
    );
    expect(rows[0]?.count).toBe(2);
    const channel = databaseExecuteRows<ChannelStateRow>(
      await db.execute<ChannelStateRow>(sql`
        select
          configuration.enabled,
          configuration.status_id::text as status_id,
          configuration.status_label::text as status_label
        from channel_configurations as configuration
        where configuration.integration_id = ${integrationId}
      `),
    );
    expect(channel).toHaveLength(1);
    expect(channel[0]).toMatchObject({
      enabled: false,
      status_id: ids.statusLatest,
      status_label: 'mocked',
    });
  });

  test('serializes racing equal-time status observations by integration', async () => {
    if (context === undefined) throw new Error('Migration context is absent.');
    const observer = databaseConnection().db;
    const firstWriter = openPostgresConnection(context.databaseUrl, 1);
    const secondWriter = openPostgresConnection(context.databaseUrl, 1);
    let releaseFirst: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstInserted: (() => void) | undefined;
    const firstInsertGate = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    const integrationId = 'racing-status';

    const firstWrite = firstWriter.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into integration_statuses (
          id,
          integration_id,
          label,
          observed_at
        )
        values (
          ${ids.statusRaceFirst}::uuid,
          ${integrationId},
          'mocked'::integration_truth_label,
          ${times.statusRace}::timestamptz
        )
      `);
      firstInserted?.();
      await releaseGate;
    });

    try {
      await firstInsertGate;
      const processRows = databaseExecuteRows<ProcessRow>(
        await secondWriter.db.execute<ProcessRow>(sql`
          select pg_backend_pid()::integer as pid
        `),
      );
      const pid = processRows[0]?.pid;
      if (pid === undefined)
        throw new Error('The second writer PID is absent.');

      const secondOutcome = Promise.resolve(
        secondWriter.db.execute(sql`
          insert into integration_statuses (
            id,
            integration_id,
            label,
            observed_at
          )
          values (
            ${ids.statusRaceSecond}::uuid,
            ${integrationId},
            'mocked'::integration_truth_label,
            ${times.statusRace}::timestamptz
          )
        `),
      ).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );

      await waitForAdvisoryLock(observer, pid);
      releaseFirst?.();
      await firstWrite;
      const outcome = await secondOutcome;
      expectOperationalError(outcome.error);
    } finally {
      releaseFirst?.();
      await Promise.allSettled([firstWrite]);
      await Promise.all([firstWriter.close(), secondWriter.close()]);
    }

    const rows = databaseExecuteRows<CountRow>(
      await observer.execute<CountRow>(sql`
        select count(*)::integer as count
        from integration_statuses
        where integration_id = ${integrationId}
      `),
    );
    expect(rows[0]?.count).toBe(1);
  });

  test('enforces one strict roster lineage and current configuration even for the first snapshot', async () => {
    const db = databaseConnection().db;
    await db.execute(sql`
      insert into group_sources (
        id,
        kind,
        purpose,
        facility_id,
        display_name,
        active,
        google_group_id,
        email,
        fixture_key,
        created_at
      )
      values (
        ${ids.staffGroup}::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose,
        ${ids.seedFacilityNorth}::uuid,
        'Synthetic migration staff group',
        true,
        'issue-26-migration-staff-group',
        'issue-26-migration-staff-group@psd401.net',
        null,
        ${times.rosterOne}::timestamptz
      )
    `);

    await expectOperationalRejection(() =>
      insertRosterConfiguration(db, {
        id: ids.rosterConfiguration,
        version: 2,
        createdAt: times.rosterTwo,
      }),
    );
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into roster_source_configurations (
          id,
          version,
          population,
          created_at
        )
        values (
          ${ids.rosterConfiguration}::uuid,
          1,
          'staff'::roster_population,
          ${times.rosterOne}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into roster_source_configuration_facilities (
          configuration_id,
          configuration_version,
          facility_id
        )
        values (
          ${ids.rosterConfiguration}::uuid,
          1,
          ${ids.seedFacilityNorth}::uuid
        )
      `);
      await transaction.execute(sql`
        insert into roster_source_configuration_groups (
          configuration_id,
          configuration_version,
          population,
          group_source_id,
          group_source_kind,
          group_purpose
        )
        values (
          ${ids.rosterConfiguration}::uuid,
          1,
          'staff'::roster_population,
          ${ids.staffGroup}::uuid,
          'google-group'::group_source_kind,
          'building'::group_purpose
        )
      `);
    });

    await insertRosterConfiguration(db, {
      id: ids.rosterConfiguration,
      version: 1,
      createdAt: times.rosterOne,
    });
    await expectOperationalRejection(() =>
      insertRosterConfiguration(db, {
        id: ids.rosterConfiguration,
        version: 1,
        createdAt: times.rosterTwo,
      }),
    );
    await expectOperationalRejection(() =>
      insertRosterConfiguration(db, {
        id: ids.otherRosterConfiguration,
        version: 1,
        createdAt: times.rosterOne,
      }),
    );
    await expectOperationalRejection(() =>
      insertRosterConfiguration(db, {
        id: ids.rosterConfiguration,
        version: 3,
        createdAt: times.rosterThree,
      }),
    );
    await insertRosterConfiguration(db, {
      id: ids.rosterConfiguration,
      version: 2,
      createdAt: times.rosterTwo,
    });
    await insertRosterConfiguration(db, {
      id: ids.rosterConfiguration,
      version: 1,
      createdAt: times.rosterOne,
    });

    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into roster_source_configuration_facilities (
          configuration_id,
          configuration_version,
          facility_id
        )
        values (
          ${ids.rosterConfiguration}::uuid,
          1,
          ${ids.seedFacilitySouth}::uuid
        )
        on conflict do nothing
      `),
    );
    await db.execute(sql`
      insert into roster_source_configuration_facilities (
        configuration_id,
        configuration_version,
        facility_id
      )
      values (
        ${ids.rosterConfiguration}::uuid,
        1,
        ${ids.seedFacilityNorth}::uuid
      )
      on conflict do nothing
    `);
    await db.execute(sql`
      insert into roster_source_configuration_groups (
        configuration_id,
        configuration_version,
        population,
        group_source_id,
        group_source_kind,
        group_purpose
      )
      values (
        ${ids.rosterConfiguration}::uuid,
        1,
        'staff'::roster_population,
        ${ids.staffGroup}::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose
      )
      on conflict do nothing
    `);
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into roster_source_configuration_groups (
          configuration_id,
          configuration_version,
          population,
          group_source_id,
          group_source_kind,
          group_purpose
        )
        values (
          ${ids.rosterConfiguration}::uuid,
          1,
          'staff'::roster_population,
          ${ids.staffGroup}::uuid,
          'google-group'::group_source_kind,
          'others'::group_purpose
        )
        on conflict do nothing
      `),
    );

    await expectOperationalRejection(() =>
      insertRosterSnapshot(db, {
        id: ids.rosterSnapshotOne,
        version: 1,
        configurationVersion: 1,
        capturedAt: times.snapshotOne,
      }),
    );
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into roster_snapshots (
          id,
          version,
          population,
          complete,
          source_configuration_id,
          source_configuration_version,
          sync_started_at,
          captured_at
        )
        values (
          ${ids.rosterSnapshotOne}::uuid,
          1,
          'staff'::roster_population,
          true,
          ${ids.rosterConfiguration}::uuid,
          2,
          ${times.snapshotOne}::timestamptz,
          ${times.snapshotOne}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into roster_snapshot_facilities (
          roster_snapshot_id,
          facility_id
        )
        values (
          ${ids.rosterSnapshotOne}::uuid,
          ${ids.seedFacilityNorth}::uuid
        )
      `);
      await transaction.execute(sql`
        insert into roster_snapshot_sources (
          roster_snapshot_id,
          population,
          group_source_id,
          group_source_kind,
          group_purpose,
          completion_kind
        )
        values (
          ${ids.rosterSnapshotOne}::uuid,
          'staff'::roster_population,
          ${ids.staffGroup}::uuid,
          'google-group'::group_source_kind,
          'building'::group_purpose,
          'expected'::group_completion_kind
        )
      `);
    });
    await db.execute(sql`
      insert into roster_snapshot_sources (
        roster_snapshot_id,
        population,
        group_source_id,
        group_source_kind,
        group_purpose,
        completion_kind
      )
      values (
        ${ids.rosterSnapshotOne}::uuid,
        'staff'::roster_population,
        ${ids.staffGroup}::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose,
        'expected'::group_completion_kind
      )
      on conflict do nothing
    `);
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into roster_snapshot_sources (
          roster_snapshot_id,
          population,
          group_source_id,
          group_source_kind,
          group_purpose,
          completion_kind
        )
        values (
          ${ids.rosterSnapshotOne}::uuid,
          'staff'::roster_population,
          ${ids.staffGroup}::uuid,
          'google-group'::group_source_kind,
          'others'::group_purpose,
          'expected'::group_completion_kind
        )
        on conflict do nothing
      `),
    );
    await expectOperationalRejection(() =>
      insertRosterSnapshot(db, {
        id: ids.rosterSnapshotSkip,
        version: 3,
        configurationVersion: 2,
        capturedAt: times.snapshotTwo,
      }),
    );
    await insertRosterSnapshot(db, {
      id: ids.rosterSnapshotOne,
      version: 1,
      configurationVersion: 2,
      capturedAt: times.snapshotOne,
    });
    await expectOperationalRejection(() =>
      insertRosterSnapshot(db, {
        id: ids.rosterSnapshotOne,
        version: 1,
        configurationVersion: 2,
        capturedAt: times.snapshotTwo,
      }),
    );
    await db.execute(sql`
      insert into roster_snapshot_facilities (
        roster_snapshot_id,
        facility_id
      )
      values (
        ${ids.rosterSnapshotOne}::uuid,
        ${ids.seedFacilityNorth}::uuid
      )
      on conflict do nothing
    `);
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into roster_snapshot_facilities (
          roster_snapshot_id,
          facility_id
        )
        values (
          ${ids.rosterSnapshotOne}::uuid,
          ${ids.seedFacilitySouth}::uuid
        )
        on conflict do nothing
      `),
    );

    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into roster_source_configurations (
          id,
          version,
          population,
          created_at
        )
        values (
          ${ids.rosterConfiguration}::uuid,
          3,
          'staff'::roster_population,
          ${times.rosterThree}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into roster_source_configuration_facilities (
          configuration_id,
          configuration_version,
          facility_id
        )
        values (
          ${ids.rosterConfiguration}::uuid,
          3,
          ${ids.seedFacilityNorth}::uuid
        )
      `);
      await transaction.execute(sql`
        insert into roster_snapshots (
          id,
          version,
          population,
          complete,
          source_configuration_id,
          source_configuration_version,
          sync_started_at,
          captured_at
        )
        values (
          ${ids.rosterSnapshotTwo}::uuid,
          2,
          'staff'::roster_population,
          true,
          ${ids.rosterConfiguration}::uuid,
          3,
          ${times.snapshotTwo}::timestamptz,
          ${times.snapshotTwo}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into roster_snapshot_facilities (
          roster_snapshot_id,
          facility_id
        )
        values (
          ${ids.rosterSnapshotTwo}::uuid,
          ${ids.seedFacilityNorth}::uuid
        )
      `);
    });

    const currentRows = databaseExecuteRows<CountRow>(
      await db.execute<CountRow>(sql`
        select count(*)::integer as count
        from roster_snapshots
        where population = 'staff'
          and source_configuration_id = ${ids.rosterConfiguration}::uuid
          and source_configuration_version in (2, 3)
      `),
    );
    expect(currentRows[0]?.count).toBe(2);
  });

  test('allows only atomic or exact-retry audience and neighborhood children', async () => {
    const db = databaseConnection().db;
    await db.execute(sql`
      insert into facilities (id, code, name, active, created_at)
      values (
        ${ids.adminFacility}::uuid,
        'SYN-MIGRATION',
        'Synthetic Migration Campus',
        true,
        ${times.adminOne}::timestamptz
      )
    `);
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into neighborhood_versions (id, version, name, created_at)
        values (
          ${ids.neighborhood}::uuid,
          1,
          'Synthetic migration neighborhood',
          ${times.adminOne}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into neighborhood_facilities (
          neighborhood_id,
          neighborhood_version,
          facility_id
        )
        values (
          ${ids.neighborhood}::uuid,
          1,
          ${ids.seedFacilityNorth}::uuid
        )
      `);
    });
    await db.execute(sql`
      insert into neighborhood_facilities (
        neighborhood_id,
        neighborhood_version,
        facility_id
      )
      values (
        ${ids.neighborhood}::uuid,
        1,
        ${ids.seedFacilityNorth}::uuid
      )
      on conflict do nothing
    `);
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into neighborhood_facilities (
          neighborhood_id,
          neighborhood_version,
          facility_id
        )
        values (
          ${ids.neighborhood}::uuid,
          1,
          ${ids.seedFacilitySouth}::uuid
        )
        on conflict do nothing
      `),
    );
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into neighborhood_versions (id, version, name, created_at)
        values (
          ${ids.neighborhood}::uuid,
          1,
          'Mismatched retry',
          ${times.adminOne}::timestamptz
        )
        on conflict do nothing
      `),
    );
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into neighborhood_versions (id, version, name, created_at)
        values (
          ${ids.neighborhood}::uuid,
          3,
          'Skipped neighborhood version',
          ${times.adminTwo}::timestamptz
        )
        on conflict do nothing
      `),
    );
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into neighborhood_versions (id, version, name, created_at)
        values (
          ${ids.neighborhood}::uuid,
          2,
          'Synthetic migration neighborhood corrected',
          ${times.adminTwo}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into neighborhood_facilities (
          neighborhood_id,
          neighborhood_version,
          facility_id
        )
        values (
          ${ids.neighborhood}::uuid,
          2,
          ${ids.seedFacilitySouth}::uuid
        )
      `);
    });
    await db.execute(sql`
      insert into neighborhood_versions (id, version, name, created_at)
      values (
        ${ids.neighborhood}::uuid,
        1,
        'Synthetic migration neighborhood',
        ${times.adminOne}::timestamptz
      )
      on conflict do nothing
    `);

    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into audience_configurations (
          id,
          facility_id,
          version,
          created_at
        )
        values (
          ${ids.audience}::uuid,
          ${ids.adminFacility}::uuid,
          1,
          ${times.adminOne}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into audience_targets (
          audience_config_id,
          audience_config_version,
          ordinal,
          target_kind,
          target_facility_id
        )
        values (
          ${ids.audience}::uuid,
          1,
          1,
          'building'::audience_target_kind,
          ${ids.seedFacilityNorth}::uuid
        )
      `);
    });
    await db.execute(sql`
      insert into audience_targets (
        audience_config_id,
        audience_config_version,
        ordinal,
        target_kind,
        target_facility_id
      )
      values (
        ${ids.audience}::uuid,
        1,
        1,
        'building'::audience_target_kind,
        ${ids.seedFacilityNorth}::uuid
      )
      on conflict do nothing
    `);
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into audience_targets (
          audience_config_id,
          audience_config_version,
          ordinal,
          target_kind,
          target_facility_id
        )
        values (
          ${ids.audience}::uuid,
          1,
          1,
          'building'::audience_target_kind,
          ${ids.seedFacilitySouth}::uuid
        )
        on conflict do nothing
      `),
    );
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into audience_targets (
          audience_config_id,
          audience_config_version,
          ordinal,
          target_kind,
          target_facility_id
        )
        values (
          ${ids.audience}::uuid,
          1,
          2,
          'building'::audience_target_kind,
          ${ids.seedFacilityNorth}::uuid
        )
        on conflict do nothing
      `),
    );
    await expectOperationalRejection(() =>
      db.execute(sql`
        insert into audience_configurations (
          id,
          facility_id,
          version,
          created_at
        )
        values (
          ${ids.audience}::uuid,
          ${ids.adminFacility}::uuid,
          3,
          ${times.adminTwo}::timestamptz
        )
        on conflict do nothing
      `),
    );
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into audience_configurations (
          id,
          facility_id,
          version,
          created_at
        )
        values (
          ${ids.audience}::uuid,
          ${ids.adminFacility}::uuid,
          2,
          ${times.adminTwo}::timestamptz
        )
      `);
      await transaction.execute(sql`
        insert into audience_targets (
          audience_config_id,
          audience_config_version,
          ordinal,
          target_kind,
          target_facility_id
        )
        values (
          ${ids.audience}::uuid,
          2,
          1,
          'building'::audience_target_kind,
          ${ids.seedFacilitySouth}::uuid
        )
      `);
    });

    const rows = databaseExecuteRows<CountRow>(
      await db.execute<CountRow>(sql`
        select count(*)::integer as count
        from audience_configurations
        where id = ${ids.audience}::uuid
      `),
    );
    expect(rows[0]?.count).toBe(2);
  });
});
