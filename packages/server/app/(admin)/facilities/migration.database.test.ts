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
import migrationJournal from '../../../drizzle/migrations/meta/_journal.json';
import { createDrizzleSecurityAuditRepository } from '../../../lib/audit/drizzle-repository';
import type { TrustedCapabilityInvocation } from '../../../lib/capabilities/engine';
import {
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
} from '../../../lib/capabilities/journal';
import { requireSyntheticTestDatabaseUrl } from '../../../lib/testing/database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../../lib/testing/owned-database-lifecycle';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(120_000);

const ids = {
  seedFacilityNorth: '26050000-0000-4000-8000-000000000035',
  seedFacilitySouth: '26050000-0000-4000-8000-000000000036',
  seedNeighborhood: '26050000-0000-4000-8000-000000000037',
  seedGroup: '26050000-0000-4000-8000-000000000039',
  seedRosterConfiguration: '26050000-0000-4000-8000-000000000040',
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

interface CanonicalRemovalRow extends Record<string, unknown> {
  readonly anchor_count: number;
  readonly facility_count: number;
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

interface LockCompatibilityPrivilegeRow extends Record<string, unknown> {
  readonly can_update_column: boolean;
  readonly can_update_table: boolean;
  readonly column_name: string;
  readonly table_name: string;
}

interface ImmutableTargetPresenceRow extends Record<string, unknown> {
  readonly row_present: boolean;
  readonly table_name: string;
}

interface AuditCompatibilityRow extends Record<string, unknown> {
  readonly action: string;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly request_id: string;
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
let canonicalRemovalRows: readonly CanonicalRemovalRow[] = [];

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
  closeAdmin: (admin: PostgresDatabaseConnection) => Promise<void> = async (
    admin,
  ) => admin.close(),
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
      'Disposable migration database operation, creator close, or marker-owned rollback failed.',
  });
}

async function dropOwnedDatabase(
  createdContext: MigrationTestContext,
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
          'Refusing to drop a database without the exact issue #26 ownership marker.',
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
      'Disposable migration database cleanup and connection close both failed.',
  });
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
  await seedDatabase(database, {
    async insertRosterEndpoints(transaction) {
      await transaction.execute(sql`
        insert into roster_endpoints (
          id, roster_snapshot_id, recipient_id, population, channel, status,
          captured_at, platform, token, email, phone_number
        ) values
          ('00000000-0000-4000-8000-000000000060'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000050'::uuid,
           'synthetic', 'push', 'active', '2026-08-06T12:00:00.000Z',
           'ios', 'synthetic-unroutable:north-one', null, null),
          ('00000000-0000-4000-8000-000000000061'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000050'::uuid,
           'synthetic', 'email', 'active', '2026-08-06T12:00:00.000Z',
           null, null, 'north-one@example.invalid', null),
          ('00000000-0000-4000-8000-000000000062'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000050'::uuid,
           'synthetic', 'sms', 'active', '2026-08-06T12:00:00.000Z',
           null, null, null, '+12025550101'),
          ('00000000-0000-4000-8000-000000000063'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000051'::uuid,
           'synthetic', 'push', 'active', '2026-08-06T12:00:00.000Z',
           'android', 'synthetic-unroutable:north-two', null, null),
          ('00000000-0000-4000-8000-000000000064'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000051'::uuid,
           'synthetic', 'email', 'active', '2026-08-06T12:00:00.000Z',
           null, null, 'north-two@example.invalid', null),
          ('00000000-0000-4000-8000-000000000065'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000051'::uuid,
           'synthetic', 'sms', 'active', '2026-08-06T12:00:00.000Z',
           null, null, null, '+12025550102'),
          ('00000000-0000-4000-8000-000000000066'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000052'::uuid,
           'synthetic', 'push', 'active', '2026-08-06T12:00:00.000Z',
           'ios', 'synthetic-unroutable:south-one', null, null),
          ('00000000-0000-4000-8000-000000000067'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000052'::uuid,
           'synthetic', 'email', 'active', '2026-08-06T12:00:00.000Z',
           null, null, 'south-one@example.invalid', null),
          ('00000000-0000-4000-8000-000000000068'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000052'::uuid,
           'synthetic', 'sms', 'active', '2026-08-06T12:00:00.000Z',
           null, null, null, '+12025550103'),
          ('00000000-0000-4000-8000-000000000069'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000053'::uuid,
           'synthetic', 'push', 'active', '2026-08-06T12:00:00.000Z',
           'android', 'synthetic-unroutable:south-two', null, null),
          ('00000000-0000-4000-8000-000000000070'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000053'::uuid,
           'synthetic', 'email', 'active', '2026-08-06T12:00:00.000Z',
           null, null, 'south-two@example.invalid', null),
          ('00000000-0000-4000-8000-000000000071'::uuid,
           '00000000-0000-4000-8000-000000000041'::uuid,
           '00000000-0000-4000-8000-000000000053'::uuid,
           'synthetic', 'sms', 'active', '2026-08-06T12:00:00.000Z',
           null, null, null, '+12025550104')
        on conflict do nothing
      `);
    },
    // The group sources the seed would write, with the columns this schema
    // actually has. Drizzle emits every column of a table it inserts into, so
    // seeding them through the current schema fails against a database held at
    // migration 0004 the moment that table gains a column — as it did when
    // access groups started carrying the role they grant. This runs at the same
    // point in the transaction, after facilities and before the roster source
    // configuration that references them.
    async insertGroupSources(transaction) {
      await transaction.execute(sql`
    insert into group_sources (
      id, kind, purpose, facility_id, display_name, active,
      google_group_id, email, fixture_key, created_at
    ) values
      (
        '00000000-0000-4000-8000-000000000030'::uuid,
        'synthetic'::group_source_kind,
        'building'::group_purpose,
        '00000000-0000-4000-8000-000000000001'::uuid,
        'Synthetic North Staff',
        true, null, null, 'synthetic-north-staff',
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        '00000000-0000-4000-8000-000000000031'::uuid,
        'synthetic'::group_source_kind,
        'building'::group_purpose,
        '00000000-0000-4000-8000-000000000002'::uuid,
        'Synthetic South Staff',
        true, null, null, 'synthetic-south-staff',
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        '00000000-0000-4000-8000-000000000032'::uuid,
        'synthetic'::group_source_kind,
        'others'::group_purpose,
        null,
        'Synthetic District Support Staff',
        true, null, null, 'synthetic-district-support-staff',
        '2026-08-06T12:00:00.000Z'::timestamptz
      )
    on conflict do nothing
      `);
    },
  });
  // The audience layer is retired (#292), so the seed no longer writes these and
  // `db/schema.ts` no longer models them. This fixture is held at migration 0004,
  // where they still exist and the historical migration under test counts them
  // in its approved graph, so it stages them here in raw SQL — the same reason
  // the group sources above are written this way.
  //
  // Parent and children in one transaction:
  // `psd_eoc_guard_admin_version_child_insert` admits a target only while its
  // configuration's xmin is the current transaction's.
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into audience_configurations (id, facility_id, version, created_at)
      values
        ('00000000-0000-4000-8000-000000000020'::uuid,
         '00000000-0000-4000-8000-000000000001'::uuid, 1,
         '2026-08-06T12:00:00.000Z'::timestamptz),
        ('00000000-0000-4000-8000-000000000021'::uuid,
         '00000000-0000-4000-8000-000000000002'::uuid, 1,
         '2026-08-06T12:00:00.000Z'::timestamptz)
    `);
    await transaction.execute(sql`
      insert into audience_targets (
        audience_config_id, audience_config_version, ordinal, target_kind,
        target_facility_id, neighborhood_id, neighborhood_version,
        group_source_id
      ) values
        ('00000000-0000-4000-8000-000000000020'::uuid, 1, 1,
         'building'::audience_target_kind,
         '00000000-0000-4000-8000-000000000001'::uuid, null, null, null),
        ('00000000-0000-4000-8000-000000000020'::uuid, 1, 2,
         'neighborhood'::audience_target_kind, null,
         '00000000-0000-4000-8000-000000000010'::uuid, 1, null),
        ('00000000-0000-4000-8000-000000000020'::uuid, 1, 3,
         'others'::audience_target_kind, null, null, null,
         '00000000-0000-4000-8000-000000000032'::uuid),
        ('00000000-0000-4000-8000-000000000021'::uuid, 1, 1,
         'building'::audience_target_kind,
         '00000000-0000-4000-8000-000000000002'::uuid, null, null, null),
        ('00000000-0000-4000-8000-000000000021'::uuid, 1, 2,
         'neighborhood'::audience_target_kind, null,
         '00000000-0000-4000-8000-000000000010'::uuid, 1, null),
        ('00000000-0000-4000-8000-000000000021'::uuid, 1, 3,
         'others'::audience_target_kind, null, null, null,
         '00000000-0000-4000-8000-000000000032'::uuid)
    `);
  });
  await database.execute(sql`
    insert into facilities (id, code, name, active, created_at)
    values
      (
        '00000000-0000-4000-8000-000000000001'::uuid,
        'SYN-NORTH',
        'Synthetic North Campus',
        true,
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        '00000000-0000-4000-8000-000000000002'::uuid,
        'SYN-SOUTH',
        'Synthetic South Campus',
        true,
        '2026-08-06T12:00:00.000Z'::timestamptz
      )
    on conflict do nothing
  `);
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

async function migrateHistoricalFixture(
  migrationConnection: PostgresDatabaseConnection,
): Promise<void> {
  try {
    await migrateDatabase(migrationConnection);
  } catch (error) {
    const code = postgresErrorFacts(error, 'code').at(-1) ?? 'unknown';
    const message =
      postgresErrorFacts(error, 'message').at(-1) ??
      'unknown database rejection';
    throw new Error(
      `Issue #26 historical migration failed with PostgreSQL ${code}: ${message.slice(0, 1_024)}`,
    );
  }
}

async function seedPostRemovalFacilityFixture(
  database: PostgresDatabase,
): Promise<void> {
  canonicalRemovalRows = databaseExecuteRows<CanonicalRemovalRow>(
    await database.execute<CanonicalRemovalRow>(sql`
      select
        (select count(*)::integer
          from facilities
          where id in (
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid
          ) or code in ('SYN-NORTH', 'SYN-SOUTH')) as facility_count,
        (select count(*)::integer
          from security_audit_facility_anchors
          where facility_id in (
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid
          )) as anchor_count
    `),
  );
  await database.execute(sql`
    insert into facilities (id, code, name, active, created_at)
    values
      (
        ${ids.seedFacilityNorth}::uuid,
        'MIG-NORTH',
        'Migration proof north facility',
        true,
        ${times.adminOne}::timestamptz
      ),
      (
        ${ids.seedFacilitySouth}::uuid,
        'MIG-SOUTH',
        'Migration proof south facility',
        true,
        ${times.adminOne}::timestamptz
      )
  `);
  await database.execute(sql`
    insert into group_sources (
      id, kind, purpose, facility_id, display_name, active,
      google_group_id, email, fixture_key, created_at
    ) values (
      ${ids.seedGroup}::uuid,
      'synthetic'::group_source_kind,
      'building'::group_purpose,
      ${ids.seedFacilityNorth}::uuid,
      'Migration proof synthetic group',
      true,
      null,
      null,
      'issue-26-post-removal-group',
      ${times.adminOne}::timestamptz
    )
  `);
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into neighborhood_versions (id, version, name, created_at)
      values (
        ${ids.seedNeighborhood}::uuid,
        1,
        'Migration proof neighborhood',
        ${times.adminOne}::timestamptz
      )
    `);
    await transaction.execute(sql`
      insert into neighborhood_facilities (
        neighborhood_id, neighborhood_version, facility_id
      ) values (
        ${ids.seedNeighborhood}::uuid,
        1,
        ${ids.seedFacilityNorth}::uuid
      )
    `);
  });
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into roster_source_configurations (
        id, version, population, created_at
      ) values (
        ${ids.seedRosterConfiguration}::uuid,
        1,
        'synthetic'::roster_population,
        ${times.adminOne}::timestamptz
      )
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_facilities (
        configuration_id, configuration_version, facility_id
      ) values (
        ${ids.seedRosterConfiguration}::uuid,
        1,
        ${ids.seedFacilityNorth}::uuid
      )
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_groups (
        configuration_id, configuration_version, population,
        group_source_id, group_source_kind, group_purpose
      ) values (
        ${ids.seedRosterConfiguration}::uuid,
        1,
        'synthetic'::roster_population,
        ${ids.seedGroup}::uuid,
        'synthetic'::group_source_kind,
        'building'::group_purpose
      )
    `);
  });
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

async function expectPostgresCodeRejection(
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedMessage?: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(postgresErrorFacts(error, 'code')).toContain(expectedCode);
    if (expectedMessage !== undefined) {
      expect(postgresErrorFacts(error, 'message').join('\n')).toMatch(
        expectedMessage,
      );
    }
    return;
  }
  throw new Error(`Expected PostgreSQL to reject with ${expectedCode}.`);
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

      await migrateHistoricalFixture(connection);
      await seedPostRemovalFacilityFixture(connection.db);
      statusRowsAfterFirstMigration = await statusSnapshot(connection.db);
      channelRowsAfterFirstMigration = await channelSnapshot(connection.db);

      await migrateHistoricalFixture(connection);
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

  test('removes a marker-owned child database when the creating connection close fails', async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for migration tests.');
    }
    const isolatedContext = buildContext(baseTestDatabaseUrl);
    const closeFailure = new Error(
      'Synthetic post-marker database connection close failure.',
    );
    let markerAtClose: string | null | undefined;
    const proofErrors: unknown[] = [];
    try {
      await expect(
        createOwnedDatabase(isolatedContext, async (admin) => {
          markerAtClose = await readDatabaseMarker(
            admin,
            isolatedContext.databaseName,
          );
          await admin.close();
          throw closeFailure;
        }),
      ).rejects.toBe(closeFailure);
      expect(markerAtClose).toBe(isolatedContext.marker);

      const observer = openPostgresConnection(baseTestDatabaseUrl, 1);
      const observerErrors: unknown[] = [];
      try {
        expect(
          await readDatabaseMarker(observer, isolatedContext.databaseName),
        ).toBeUndefined();
      } catch (error) {
        observerErrors.push(error);
      }
      try {
        await observer.close();
      } catch (error) {
        observerErrors.push(error);
      }
      if (observerErrors.length === 1) throw observerErrors[0];
      if (observerErrors.length > 1) {
        throw new AggregateError(
          observerErrors,
          'Migration close-rejection verification and observer close both failed.',
        );
      }
    } catch (error) {
      proofErrors.push(error);
    }

    try {
      await dropOwnedDatabase(isolatedContext);
    } catch (cleanupError) {
      proofErrors.push(cleanupError);
    }
    if (proofErrors.length === 1) throw proofErrors[0];
    if (proofErrors.length > 1) {
      throw new AggregateError(
        proofErrors,
        'Post-marker close-failure proof and cleanup both failed.',
      );
    }
  });

  test('retries exact marker proof before rolling back after the initial marker read fails', async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for migration tests.');
    }
    const isolatedContext = buildContext(baseTestDatabaseUrl);
    const markerReadError = new Error(
      'Synthetic migration initial marker read failure.',
    );
    const errors: unknown[] = [];
    try {
      await expect(
        createOwnedDatabase(isolatedContext, undefined, () =>
          Promise.reject(markerReadError),
        ),
      ).rejects.toBe(markerReadError);

      const observer = openPostgresConnection(baseTestDatabaseUrl, 1);
      await executeOperationWithCleanup({
        operation: async () => {
          expect(
            await readDatabaseMarker(observer, isolatedContext.databaseName),
          ).toBeUndefined();
        },
        cleanup: () => observer.close(),
        failureMessage:
          'Migration transient-marker verification and observer close both failed.',
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      await dropOwnedDatabase(isolatedContext);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Migration transient-marker proof and cleanup both failed.',
      );
    }
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

  test('physically removes the canonical synthetic facilities during the historical upgrade', () => {
    expect(canonicalRemovalRows).toEqual([
      { anchor_count: 2, facility_count: 0 },
    ]);
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
      expect(migrationCountAfterRetry).toEqual([
        { count: migrationJournal.entries.length },
      ]);
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
        select distinct trigger_name as snapshot
        from information_schema.triggers
        where trigger_schema = 'public'
          and trigger_name in (
            'access_membership_snapshots_admin_availability_lock',
            'access_membership_snapshots_immutable_guard',
            'group_sources_identity_guard',
            'group_sources_admin_availability_lock',
            'integration_statuses_monotonic_insert_guard',
            'integration_statuses_channel_configuration_sync',
            'roster_source_configurations_monotonic_insert_guard',
            'roster_snapshots_monotonic_insert_guard',
            'neighborhood_versions_monotonic_insert_guard',
            'neighborhood_facilities_construction_guard',
            'user_roles_immutable_guard',
            'user_facility_scopes_admin_availability_lock',
            'users_admin_availability_lock'
          )
        order by trigger_name
      `),
    ).map((row) => row.snapshot);
    expect(triggers).toEqual([
      'access_membership_snapshots_admin_availability_lock',
      'access_membership_snapshots_immutable_guard',
      'group_sources_admin_availability_lock',
      'group_sources_identity_guard',
      'integration_statuses_channel_configuration_sync',
      'integration_statuses_monotonic_insert_guard',
      'neighborhood_facilities_construction_guard',
      'neighborhood_versions_monotonic_insert_guard',
      'roster_snapshots_monotonic_insert_guard',
      'roster_source_configurations_monotonic_insert_guard',
      'user_facility_scopes_admin_availability_lock',
      'user_roles_immutable_guard',
      'users_admin_availability_lock',
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
        'issue-26-migration-role-user@example.invalid',
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

  test('requires access locator corrections to create a replacement identity', async () => {
    const db = databaseConnection().db;
    const sourceId = randomUUID();
    const originalGoogleGroupId = `issue-26-access-${sourceId}`;
    const originalEmail = `${sourceId}@example.invalid`;
    await db.execute(sql`
      insert into group_sources (
        id,
        kind,
        purpose,
        facility_id,
        display_name,
        active,
        granted_role,
        google_group_id,
        email,
        fixture_key
      )
      values (
        ${sourceId}::uuid,
        'google-group'::group_source_kind,
        'access'::group_purpose,
        null,
        'Synthetic access source',
        true,
        'admin'::role,
        ${originalGoogleGroupId},
        ${originalEmail},
        null
      )
    `);

    await db.transaction(async (transaction) => {
      await transaction.execute(sql`set local role "psd_eoc_app"`);
      await transaction.execute(sql`
        update group_sources
        set display_name = 'Synthetic access source renamed', active = false
        where id = ${sourceId}::uuid
      `);
    });
    const rows = databaseExecuteRows<TextSnapshotRow>(
      await db.execute<TextSnapshotRow>(sql`
        select display_name || ':' || active::text as snapshot
        from group_sources
        where id = ${sourceId}::uuid
      `),
    );
    expect(rows).toEqual([
      { snapshot: 'Synthetic access source renamed:false' },
    ]);

    await expectPostgresCodeRejection(
      () =>
        db.transaction(async (transaction) => {
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(sql`
            update group_sources
            set google_group_id = ${`${originalGoogleGroupId}-changed`}
            where id = ${sourceId}::uuid
          `);
        }),
      '55000',
      /Access group provider locators are immutable/u,
    );
    await expectPostgresCodeRejection(
      () =>
        db.transaction(async (transaction) => {
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(sql`
            update group_sources
            set email = ${`changed-${originalEmail}`}
            where id = ${sourceId}::uuid
          `);
        }),
      '55000',
      /Access group provider locators are immutable/u,
    );
  });

  test('serializes access snapshot publication with admin availability changes', async () => {
    if (context === undefined) {
      throw new Error('The issue #26 migration test context is unavailable.');
    }
    const observer = databaseConnection().db;
    const firstWriter = openPostgresConnection(context.databaseUrl, 1);
    const secondWriter = openPostgresConnection(context.databaseUrl, 1);
    const [versionRow] = databaseExecuteRows<CountRow>(
      await observer.execute<CountRow>(sql`
        select coalesce(max(version), 0)::integer as count
        from access_membership_snapshots
      `),
    );
    const secondVersion = (versionRow?.count ?? 0) + 1;
    const secondSnapshotId = randomUUID();
    let firstInserted: (() => void) | undefined;
    const firstInsertGate = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstWrite = firstWriter.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended('psd-eoc-admin-availability', 0)
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
      if (pid === undefined) {
        throw new Error('The competing access-snapshot writer PID is absent.');
      }
      const secondOutcome = Promise.resolve(
        secondWriter.db.execute(sql`
          insert into access_membership_snapshots (
            id,
            version,
            complete,
            sync_started_at,
            captured_at
          )
          values (
            ${secondSnapshotId}::uuid,
            ${secondVersion},
            true,
            ${times.adminTwo}::timestamptz,
            ${times.adminTwo}::timestamptz
          )
        `),
      ).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await waitForAdvisoryLock(observer, pid);
      releaseFirst?.();
      await firstWrite;
      expect((await secondOutcome).error).toBeUndefined();
    } finally {
      releaseFirst?.();
      await Promise.allSettled([firstWrite]);
      await Promise.all([firstWriter.close(), secondWriter.close()]);
    }
  });

  test('serializes direct active access-group writes on the shared availability lock', async () => {
    if (context === undefined) {
      throw new Error('The issue #26 migration test context is unavailable.');
    }
    const observer = databaseConnection().db;
    const sourceId = randomUUID();
    await observer.execute(sql`
      insert into group_sources (
        id,
        kind,
        purpose,
        facility_id,
        display_name,
        active,
        granted_role,
        google_group_id,
        email,
        fixture_key
      )
      values (
        ${sourceId}::uuid,
        'google-group'::group_source_kind,
        'access'::group_purpose,
        null,
        'Synthetic serialized access source',
        false,
        'admin'::role,
        ${`issue-26-serialized-${sourceId}`},
        ${`${sourceId}@example.invalid`},
        null
      )
    `);
    const rowBlocker = openPostgresConnection(context.databaseUrl, 1);
    const blocker = openPostgresConnection(context.databaseUrl, 1);
    const writer = openPostgresConnection(context.databaseUrl, 1);
    let releaseRowBlocker: (() => void) | undefined;
    const releaseRowGate = new Promise<void>((resolve) => {
      releaseRowBlocker = resolve;
    });
    let rowLockHeld: (() => void) | undefined;
    const rowLockGate = new Promise<void>((resolve) => {
      rowLockHeld = resolve;
    });
    const rowBlockingTransaction = rowBlocker.db.transaction(
      async (transaction) => {
        await transaction.execute(sql`
          select id
          from group_sources
          where id = ${sourceId}::uuid
          for update
        `);
        rowLockHeld?.();
        await releaseRowGate;
      },
    );
    let releaseBlocker: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let lockHeld: (() => void) | undefined;
    const lockGate = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const blockingTransaction = blocker.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended('psd-eoc-admin-availability', 0)
        )
      `);
      lockHeld?.();
      await releaseGate;
    });
    try {
      await rowLockGate;
      await lockGate;
      const processRows = databaseExecuteRows<ProcessRow>(
        await writer.db.execute<ProcessRow>(sql`
          select pg_backend_pid()::integer as pid
        `),
      );
      const pid = processRows[0]?.pid;
      if (pid === undefined) {
        throw new Error('The competing access-group writer PID is absent.');
      }
      const update = Promise.resolve(
        writer.db.execute(sql`
          update group_sources
          set active = true
          where id = ${sourceId}::uuid
        `),
      );
      await waitForAdvisoryLock(observer, pid);
      releaseBlocker?.();
      await blockingTransaction;
      releaseRowBlocker?.();
      await rowBlockingTransaction;
      await update;
      const rows = databaseExecuteRows<TextSnapshotRow>(
        await observer.execute<TextSnapshotRow>(sql`
          select active::text as snapshot
          from group_sources
          where id = ${sourceId}::uuid
        `),
      );
      expect(rows).toEqual([{ snapshot: 'true' }]);
    } finally {
      releaseBlocker?.();
      releaseRowBlocker?.();
      await Promise.allSettled([blockingTransaction, rowBlockingTransaction]);
      await Promise.all([rowBlocker.close(), blocker.close(), writer.close()]);
    }
  });

  test('serializes user updates on the shared administrator-availability lock', async () => {
    if (context === undefined) {
      throw new Error('The issue #26 migration test context is unavailable.');
    }
    const observer = databaseConnection().db;
    const userId = randomUUID();
    await observer.execute(sql`
      insert into users (
        id,
        google_subject,
        email,
        display_name,
        facility_scope_kind
      ) values (
        ${userId}::uuid,
        ${`issue-26-user-lock-${userId}`},
        ${`${userId}@example.invalid`},
        'Synthetic serialized administrator',
        'district'::facility_scope_kind
      )
    `);
    const blocker = openPostgresConnection(context.databaseUrl, 1);
    const writer = openPostgresConnection(context.databaseUrl, 1);
    let lockHeld: (() => void) | undefined;
    const lockGate = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    let releaseBlocker: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockingTransaction = blocker.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended('psd-eoc-admin-availability', 0)
        )
      `);
      lockHeld?.();
      await releaseGate;
    });

    try {
      await lockGate;
      const processRows = databaseExecuteRows<ProcessRow>(
        await writer.db.execute<ProcessRow>(sql`
          select pg_backend_pid()::integer as pid
        `),
      );
      const pid = processRows[0]?.pid;
      if (pid === undefined) {
        throw new Error('The competing user writer PID is absent.');
      }
      const update = Promise.resolve(
        writer.db.execute(sql`
          update users
          set display_name = 'Synthetic serialized administrator updated'
          where id = ${userId}::uuid
        `),
      );
      await waitForAdvisoryLock(observer, pid);
      releaseBlocker?.();
      await blockingTransaction;
      await update;
      const rows = databaseExecuteRows<TextSnapshotRow>(
        await observer.execute<TextSnapshotRow>(sql`
          select display_name as snapshot
          from users
          where id = ${userId}::uuid
        `),
      );
      expect(rows).toEqual([
        { snapshot: 'Synthetic serialized administrator updated' },
      ]);
    } finally {
      releaseBlocker?.();
      await Promise.allSettled([blockingTransaction]);
      await Promise.all([blocker.close(), writer.close()]);
    }
  });

  test('serializes an uncommitted scope contradiction before administrator-role removal', async () => {
    if (context === undefined) {
      throw new Error('The issue #26 migration test context is unavailable.');
    }
    const observer = databaseConnection().db;
    const userId = randomUUID();
    const deviceEnrollmentId = randomUUID();
    const sessionId = randomUUID();
    const requestId = randomUUID();
    const snapshotId = randomUUID();
    const [snapshotVersionRow] = databaseExecuteRows<CountRow>(
      await observer.execute<CountRow>(sql`
        select coalesce(max(version), 0)::integer + 1 as count
        from access_membership_snapshots
      `),
    );
    const snapshotVersion = snapshotVersionRow?.count;
    if (snapshotVersion === undefined) {
      throw new Error(
        'The role-removal access snapshot version is unavailable.',
      );
    }
    await observer.execute(sql`
      insert into users (
        id,
        google_subject,
        email,
        display_name,
        facility_scope_kind
      ) values (
        ${userId}::uuid,
        ${`issue-26-scope-role-${userId}`},
        ${`${userId}@example.invalid`},
        'Synthetic scope-race administrator',
        'district'::facility_scope_kind
      )
    `);
    await observer.execute(sql`
      insert into user_roles (user_id, role)
      values (${userId}::uuid, 'admin'::role)
    `);
    await observer.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into access_membership_snapshots (
          id,
          version,
          complete,
          sync_started_at,
          captured_at
        ) values (
          ${snapshotId}::uuid,
          ${snapshotVersion},
          true,
          ${times.adminOne}::timestamptz,
          ${times.adminOne}::timestamptz
        )
      `);
    });
    await observer.execute(sql`
      insert into device_enrollments (
        id,
        user_id,
        platform,
        unlock_method,
        installation_id,
        enrolled_at,
        last_seen_at
      ) values (
        ${deviceEnrollmentId}::uuid,
        ${userId}::uuid,
        'web'::device_platform,
        'secure-session-cookie'::device_unlock_method,
        ${`issue-26-scope-role-${deviceEnrollmentId}`},
        ${times.adminOne}::timestamptz,
        ${times.adminOne}::timestamptz
      )
    `);
    await observer.execute(sql`
      insert into sessions (
        id,
        user_id,
        device_enrollment_id,
        membership_snapshot_id,
        membership_valid_until,
        membership_grace_until,
        created_at,
        expires_at
      ) values (
        ${sessionId}::uuid,
        ${userId}::uuid,
        ${deviceEnrollmentId}::uuid,
        ${snapshotId}::uuid,
        (${times.adminOne}::timestamptz + interval '1 hour'),
        (${times.adminOne}::timestamptz + interval '2 hours'),
        ${times.adminOne}::timestamptz,
        (${times.adminOne}::timestamptz + interval '3 hours')
      )
    `);

    const scopeWriter = openPostgresConnection(context.databaseUrl, 1);
    const roleWriter = openPostgresConnection(context.databaseUrl, 1);
    let scopeInserted: (() => void) | undefined;
    const scopeInsertedGate = new Promise<void>((resolve) => {
      scopeInserted = resolve;
    });
    let releaseScope: (() => void) | undefined;
    const releaseScopeGate = new Promise<void>((resolve) => {
      releaseScope = resolve;
    });
    const scopeWrite = scopeWriter.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into user_facility_scopes (user_id, facility_id)
        values (${userId}::uuid, ${ids.seedFacilityNorth}::uuid)
      `);
      scopeInserted?.();
      await releaseScopeGate;
    });

    try {
      await scopeInsertedGate;
      const processRows = databaseExecuteRows<ProcessRow>(
        await roleWriter.db.execute<ProcessRow>(sql`
          select pg_backend_pid()::integer as pid
        `),
      );
      const pid = processRows[0]?.pid;
      if (pid === undefined) {
        throw new Error(
          'The competing administrator-role writer PID is absent.',
        );
      }
      const roleRemoval = Promise.resolve(
        roleWriter.db.execute(sql`
          insert into user_role_changes (
            user_id,
            role,
            granted,
            changed_by_user_id,
            changed_with_session_id,
            request_id,
            occurred_at
          ) values (
            ${userId}::uuid,
            'admin'::role,
            false,
            ${userId}::uuid,
            ${sessionId}::uuid,
            ${requestId}::uuid,
            ${times.adminTwo}::timestamptz
          )
        `),
      ).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await waitForAdvisoryLock(observer, pid);
      const hiddenScopeCount = databaseExecuteRows<CountRow>(
        await observer.execute<CountRow>(sql`
          select count(*)::integer as count
          from user_facility_scopes
          where user_id = ${userId}::uuid
        `),
      );
      expect(hiddenScopeCount).toEqual([{ count: 0 }]);

      releaseScope?.();
      await scopeWrite;
      expect((await roleRemoval).error).toBeUndefined();
      const serializedFacts = databaseExecuteRows<TextSnapshotRow>(
        await observer.execute<TextSnapshotRow>(sql`
          select concat_ws(
            ':',
            (select count(*) from user_facility_scopes
              where user_id = ${userId}::uuid),
            (select granted::text from user_role_changes
              where user_id = ${userId}::uuid and role = 'admin'::role
              order by sequence desc limit 1)
          ) as snapshot
        `),
      );
      expect(serializedFacts).toEqual([{ snapshot: '1:false' }]);
    } finally {
      releaseScope?.();
      await Promise.allSettled([scopeWrite]);
      await Promise.all([scopeWriter.close(), roleWriter.close()]);
    }
  });

  test('preserves app-role row locks with narrow immutable-column privileges', async () => {
    const db = databaseConnection().db;
    const expectedPrivileges = [
      ['access_membership_snapshots', 'id'],
      ['integration_statuses', 'id'],
      ['neighborhood_versions', 'id'],
      ['roster_source_configuration_facilities', 'configuration_id'],
      ['roster_source_configuration_groups', 'configuration_id'],
      ['roster_source_configurations', 'id'],
      ['security_audit_chain_anchors', 'sequence'],
    ] as const;
    const privileges = databaseExecuteRows<LockCompatibilityPrivilegeRow>(
      await db.execute<LockCompatibilityPrivilegeRow>(sql`
        select
          intended.table_name,
          intended.column_name,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || intended.table_name,
            'UPDATE'
          ) as can_update_table,
          has_column_privilege(
            'psd_eoc_app',
            'public.' || intended.table_name,
            intended.column_name,
            'UPDATE'
          ) as can_update_column
        from (values
          ('integration_statuses', 'id'),
          ('access_membership_snapshots', 'id'),
          ('roster_source_configurations', 'id'),
          ('roster_source_configuration_facilities', 'configuration_id'),
          ('roster_source_configuration_groups', 'configuration_id'),
          ('neighborhood_versions', 'id'),
          ('security_audit_chain_anchors', 'sequence')
        ) as intended(table_name, column_name)
        order by intended.table_name
      `),
    );
    expect(privileges).toEqual(
      expectedPrivileges.map(([tableName, columnName]) => ({
        table_name: tableName,
        column_name: columnName,
        can_update_table: false,
        can_update_column: true,
      })),
    );

    await db.transaction(async (transaction) => {
      await transaction.execute(sql`set local role "psd_eoc_app"`);

      // Initial-session access evidence uses these exact unqualified row-lock
      // shapes, including the member-to-snapshot join.
      await transaction.execute(sql`
        select snapshot.id
        from access_membership_snapshots as snapshot
        order by snapshot.version desc
        limit 1
        for share
      `);

      // Activation and lifecycle checks lock both the mutable channel row and
      // its exact immutable truth observation with one unqualified FOR SHARE.
      await transaction.execute(sql`
        select configuration.integration_id
        from channel_configurations as configuration
        inner join integration_statuses as status
          on status.id = configuration.status_id
          and status.integration_id = configuration.integration_id
          and status.label = configuration.status_label
        limit 1
        for share
      `);

      // Both audit writers read the append-only chain head with this lock.
      await transaction.execute(sql`
        select anchor.sequence
        from security_audit_chain_anchors as anchor
        order by anchor.sequence desc
        limit 1
        for share
      `);

      // Facility administration and roster publication use these parent and
      // child lock shapes under the shared population advisory boundary.
      await transaction.execute(sql`
        select configuration.id
        from roster_source_configurations as configuration
        limit 1
        for update
      `);
      await transaction.execute(sql`
        select configured_facility.facility_id
        from roster_source_configuration_facilities as configured_facility
        limit 1
        for share
      `);
      await transaction.execute(sql`
        select configured_group.group_source_id
        from roster_source_configuration_groups as configured_group
        inner join group_sources as source
          on source.id = configured_group.group_source_id
        limit 1
        for share
      `);
      await transaction.execute(sql`
        select neighborhood.id
        from neighborhood_versions as neighborhood
        limit 1
        for update
      `);
    });

    const activeContext = context;
    if (activeContext === undefined) {
      throw new Error('The issue #26 migration test context is unavailable.');
    }
    const directAuditRequestId = randomUUID();
    const previewRequestId = randomUUID();
    const previewInvocation = {
      actor: {
        kind: 'human',
        userId: randomUUID(),
        sessionId: randomUUID(),
      },
      source: 'web',
      scope: { facilityScope: { kind: 'district' } },
      requestId: previewRequestId,
      serverTime: new Date(),
      connectivityEpochId: randomUUID(),
      mutation: {
        idempotencyKey: `issue-26-app-role-preview-${randomUUID()}`,
        transport: {
          kind: 'web-interactive',
          method: 'POST',
          interaction: 'explicit-user-submit',
          csrfVerified: true,
        },
        humanConfirmationId: null,
      },
    } satisfies TrustedCapabilityInvocation;
    const appRoleConnection = openPostgresConnection(
      activeContext.databaseUrl,
      1,
    );
    try {
      await appRoleConnection.db.execute(sql`set role "psd_eoc_app"`);
      const directAuditEntry = await createDrizzleSecurityAuditRepository(
        appRoleConnection.db,
      ).append({
        category: 'agent-access',
        action: 'list-facilities',
        actionIds: [],
        confirmationId: null,
        outcome: 'success',
        principal: {
          kind: 'system',
          serviceId: 'issue-26-app-role-audit-proof',
        },
        source: 'scheduled-job',
        facilityId: null,
        target: { kind: 'capability', id: 'list-facilities' },
        requestId: directAuditRequestId,
        reasonCode: null,
        occurredAt: new Date().toISOString(),
      });
      expect(directAuditEntry.requestId).toBe(directAuditRequestId);

      await expect(
        executeJournalCapability(
          'create-lifecycle-consequence-preview',
          { eventId: randomUUID(), purpose: 'all-clear' },
          previewInvocation,
          createDrizzleJournalCapabilityStore(appRoleConnection.db),
        ),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        reasonCode: 'PERSISTENCE_CONFLICT',
        status: 404,
      });
    } finally {
      await appRoleConnection.close();
    }

    const compatibilityAuditRows = databaseExecuteRows<AuditCompatibilityRow>(
      await db.execute<AuditCompatibilityRow>(sql`
          select request_id, action, outcome, reason_code
          from security_audit_entries
          where request_id in (
            ${directAuditRequestId}::uuid,
            ${previewRequestId}::uuid
          )
        `),
    );
    expect(compatibilityAuditRows).toHaveLength(2);
    expect(
      compatibilityAuditRows.find(
        (row) => row.request_id === directAuditRequestId,
      ),
    ).toMatchObject({
      action: 'list-facilities',
      outcome: 'success',
      reason_code: null,
    });
    expect(
      compatibilityAuditRows.find((row) => row.request_id === previewRequestId),
    ).toMatchObject({
      action: 'create-lifecycle-consequence-preview',
      outcome: 'failure',
      reason_code: 'PERSISTENCE_CONFLICT',
    });

    // Every immutable target must hold a row, or a zero-row UPDATE would
    // masquerade as trigger coverage. The seed constructs all of them except
    // the sync-run record, which this writes for itself rather than depending
    // on another test having run first.
    await db.execute(sql`
      insert into access_membership_snapshots (
        id, version, complete, sync_started_at, captured_at
      ) values (
        gen_random_uuid(),
        260027,
        true,
        '2026-08-10T15:59:00.000Z'::timestamptz,
        '2026-08-10T16:00:00.000Z'::timestamptz
      )
      on conflict do nothing
    `);
    const immutableTargetPresence =
      databaseExecuteRows<ImmutableTargetPresenceRow>(
        await db.execute<ImmutableTargetPresenceRow>(sql`
          select target.table_name, target.row_present
          from (values
            ('integration_statuses', exists(select 1 from integration_statuses)),
            ('access_membership_snapshots', exists(select 1 from access_membership_snapshots)),
            ('roster_source_configurations', exists(select 1 from roster_source_configurations)),
            ('roster_source_configuration_facilities', exists(select 1 from roster_source_configuration_facilities)),
            ('roster_source_configuration_groups', exists(select 1 from roster_source_configuration_groups)),
            ('neighborhood_versions', exists(select 1 from neighborhood_versions)),
            ('security_audit_chain_anchors', exists(select 1 from security_audit_chain_anchors))
          ) as target(table_name, row_present)
          order by target.table_name
        `),
      );
    expect(immutableTargetPresence).toEqual(
      expectedPrivileges.map(([tableName]) => ({
        table_name: tableName,
        row_present: true,
      })),
    );

    const immutableColumnUpdates = [
      sql`update integration_statuses set id = id`,
      sql`update access_membership_snapshots set id = id`,
      sql`update roster_source_configurations set id = id`,
      sql`update roster_source_configuration_facilities set configuration_id = configuration_id`,
      sql`update roster_source_configuration_groups set configuration_id = configuration_id`,
      sql`update neighborhood_versions set id = id`,
      sql`update security_audit_chain_anchors set sequence = sequence`,
    ] as const;
    for (const immutableUpdate of immutableColumnUpdates) {
      await expectPostgresCodeRejection(
        () =>
          db.transaction(async (transaction) => {
            await transaction.execute(sql`set local role "psd_eoc_app"`);
            await transaction.execute(immutableUpdate);
          }),
        '55000',
        /immutable/u,
      );
    }
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
        'issue-26-migration-staff-group@example.invalid',
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

  // The audience half of this went with the layer itself (#292). Both guards it
  // exercised are shared: `psd_eoc_guard_admin_version_parent_insert` and
  // `psd_eoc_guard_admin_version_child_insert` still carry their neighborhood
  // branches, and those are what remains to prove.
  test('allows only atomic or exact-retry neighborhood children', async () => {
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

    const rows = databaseExecuteRows<CountRow>(
      await db.execute<CountRow>(sql`
        select count(*)::integer as count
        from neighborhood_versions
        where id = ${ids.neighborhood}::uuid
      `),
    );
    expect(rows[0]?.count).toBe(2);
  });
});
