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

import { requireSyntheticTestDatabaseUrl } from '../lib/testing/database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../lib/testing/owned-database-lifecycle';
import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../db/client';
import {
  seedDatabase,
  seedReferenceData,
  type SeedDatabaseOptions,
} from '../db/seed';
import { migrateDatabase, migrationsFolder } from './migrate';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(120_000);

const ids = {
  north: '00000000-0000-4000-8000-000000000001',
  south: '00000000-0000-4000-8000-000000000002',
  neighborhood: '00000000-0000-4000-8000-000000000010',
  configuration: '00000000-0000-4000-8000-000000000040',
  snapshot: '00000000-0000-4000-8000-000000000041',
  auditNorth: '30000000-0000-4000-8000-000000000056',
  auditSouth: '30000000-0000-4000-8000-000000000058',
  idempotency: '81ec2daa-83e7-4ded-a914-b72bdda54e8e',
  blockingEvent: '40000000-0000-4000-8000-000000000001',
} as const;

const DATABASE_NAME_PATTERN = /^psd_eoc_issue199_removal_[a-f0-9]{32}_test$/u;
const MIGRATION_DIRECTORY_PATTERN =
  /^psd-eoc-issue199-removal-[A-Za-z0-9_-]+$/u;

interface TestContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

interface CountRow extends Record<string, unknown> {
  readonly count: number;
}

interface SnapshotRow extends Record<string, unknown> {
  readonly snapshot: string;
}

interface NullableSnapshotRow extends Record<string, unknown> {
  readonly snapshot: string | null;
}

interface RemovalReadbackRow extends Record<string, unknown> {
  readonly anchor_count: number;
  readonly audit_count: number;
  readonly guard_count: number;
  readonly idempotency_count: number;
  readonly operational_count: number;
  readonly real_facility_count: number;
  readonly real_neighborhood_count: number;
}

interface MigrationJournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface MigrationJournal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly MigrationJournalEntry[];
}

let partialMigrationsDirectory: string | undefined;

function openPostgresConnection(
  url: string,
  maxConnections = 1,
): PostgresDatabaseConnection {
  const connection = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Issue #199 removal proofs require PostgreSQL.');
  }
  return connection;
}

function createTestContext(baseDatabaseUrl: string): TestContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_issue199_removal_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The issue #199 disposable database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-199:synthetic-removal:${runId}`,
  });
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
    throw new Error('The issue #199 database marker is ambiguous.');
  }
  return rows[0]?.marker;
}

async function createOwnedDatabase(context: TestContext): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl, 1);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${context.databaseName}"`),
      );
      recordCreated();
      await admin.db.execute(
        sql.raw(
          `comment on database "${context.databaseName}" is ${quotedLiteral(context.marker)}`,
        ),
      );
      expect(await readDatabaseMarker(admin, context.databaseName)).toBe(
        context.marker,
      );
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(context),
    failureMessage: 'Issue #199 disposable database creation failed.',
  });
}

async function dropOwnedDatabase(context: TestContext): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, context.databaseName);
      if (marker !== undefined && marker !== context.marker) {
        throw new Error(
          'Refusing to drop a database without the issue #199 marker.',
        );
      }
      if (marker === context.marker) {
        await admin.db.execute(
          sql.raw(`drop database "${context.databaseName}" with (force)`),
        );
        expect(await readDatabaseMarker(admin, context.databaseName)).toBe(
          undefined,
        );
      }
    },
    cleanup: () => admin.close(),
    failureMessage: 'Issue #199 disposable database cleanup failed.',
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
    throw new Error('The migration journal is malformed.');
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
    throw new Error('The migration journal entries are malformed.');
  }
  return parsed as MigrationJournal;
}

async function prepareMigrationsThrough0011(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-issue199-removal-'));
  try {
    const journal = parseMigrationJournal(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    );
    const entries = journal.entries.filter((entry) => entry.idx <= 11);
    if (
      entries.length !== 12 ||
      entries.some((entry, index) => entry.idx !== index) ||
      entries[11]?.tag !== '0011_cloud_identity_roster_email'
    ) {
      throw new Error('Expected the exact contiguous 0000-0011 migrations.');
    }
    await mkdir(join(directory, 'meta'));
    await writeFile(
      join(directory, 'meta', '_journal.json'),
      `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
      'utf8',
    );
    await Promise.all(
      entries.map((entry) =>
        copyFile(
          join(migrationsFolder, `${entry.tag}.sql`),
          join(directory, `${entry.tag}.sql`),
        ),
      ),
    );
    return directory;
  } catch (error) {
    await removePartialMigrationsDirectory(directory);
    throw error;
  }
}

async function removePartialMigrationsDirectory(
  directory: string,
): Promise<void> {
  if (
    !directory.startsWith(`${tmpdir()}/`) ||
    !MIGRATION_DIRECTORY_PATTERN.test(basename(directory))
  ) {
    throw new Error('Refusing to remove an unrecognized migration directory.');
  }
  await rm(directory, { recursive: true, force: true });
}

async function insertLegacyRosterEndpoints(
  transaction: Parameters<
    NonNullable<SeedDatabaseOptions['insertRosterEndpoints']>
  >[0],
): Promise<void> {
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
}

async function stageReviewedLiveShape(
  database: PostgresDatabase,
  configurationVersionTwoCreatedAt = '2026-08-16T20:49:06.444626Z',
): Promise<void> {
  await seedDatabase(database, {
    insertRosterEndpoints: insertLegacyRosterEndpoints,
    // Threats arrived in migration 0046; this schema is held before it, so
    // the seed must not touch a relation that does not exist yet.
    insertThreats: () => Promise.resolve(),
    // Written here with the columns this schema actually has: Drizzle emits
    // every column of a table it inserts into, so seeding group sources
    // through the current schema fails against a database held at an earlier
    // migration. Runs after facilities and before the roster source
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
  // The audience layer is retired (#292), so the seed no longer writes these
  // and `db/schema.ts` no longer models them. Migration 0012 is applied history
  // and still counts them among the 57 rows it purges, so the reviewed live
  // shape it replays against has to include them. Raw SQL against the historical
  // column set, for the same reason the group sources above are: this database
  // is held at an earlier migration than the current schema describes.
  //
  // Parent and children go in one transaction because
  // `psd_eoc_guard_admin_version_child_insert` admits a target only while its
  // configuration's xmin is the current transaction's.
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into audience_configurations (id, facility_id, version, created_at)
      values
        ('00000000-0000-4000-8000-000000000020'::uuid, ${ids.north}::uuid, 1,
         '2026-08-06T12:00:00.000Z'::timestamptz),
        ('00000000-0000-4000-8000-000000000021'::uuid, ${ids.south}::uuid, 1,
         '2026-08-06T12:00:00.000Z'::timestamptz)
    `);
    await transaction.execute(sql`
      insert into audience_targets (
        audience_config_id, audience_config_version, ordinal, target_kind,
        target_facility_id, neighborhood_id, neighborhood_version,
        group_source_id
      ) values
        ('00000000-0000-4000-8000-000000000020'::uuid, 1, 1,
         'building'::audience_target_kind, ${ids.north}::uuid, null, null, null),
        ('00000000-0000-4000-8000-000000000020'::uuid, 1, 2,
         'neighborhood'::audience_target_kind, null,
         ${ids.neighborhood}::uuid, 1, null),
        ('00000000-0000-4000-8000-000000000020'::uuid, 1, 3,
         'others'::audience_target_kind, null, null, null,
         '00000000-0000-4000-8000-000000000032'::uuid),
        ('00000000-0000-4000-8000-000000000021'::uuid, 1, 1,
         'building'::audience_target_kind, ${ids.south}::uuid, null, null, null),
        ('00000000-0000-4000-8000-000000000021'::uuid, 1, 2,
         'neighborhood'::audience_target_kind, null,
         ${ids.neighborhood}::uuid, 1, null),
        ('00000000-0000-4000-8000-000000000021'::uuid, 1, 3,
         'others'::audience_target_kind, null, null, null,
         '00000000-0000-4000-8000-000000000032'::uuid)
    `);
  });

  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      update facilities set active = false where id = ${ids.north}::uuid
    `);
    await transaction.execute(sql`
      insert into roster_source_configurations (
        id, version, population, created_at
      ) values (
        ${ids.configuration}::uuid, 2, 'synthetic',
        ${configurationVersionTwoCreatedAt}::timestamptz
      )
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_facilities (
        configuration_id, configuration_version, facility_id
      ) values (${ids.configuration}::uuid, 2, ${ids.south}::uuid)
    `);
    await transaction.execute(sql`
      insert into roster_source_configuration_groups (
        configuration_id, configuration_version, population,
        group_source_id, group_source_kind, group_purpose
      ) values
        (${ids.configuration}::uuid, 2, 'synthetic',
         '00000000-0000-4000-8000-000000000031'::uuid,
         'synthetic', 'building'),
        (${ids.configuration}::uuid, 2, 'synthetic',
         '00000000-0000-4000-8000-000000000032'::uuid,
         'synthetic', 'others')
    `);
    await transaction.execute(sql`
      insert into facilities (id, code, name, active, created_at)
      select
        ('10000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        'REAL-' || lpad(value::text, 2, '0'),
        'Real Facility ' || value,
        true,
        '2026-08-16T19:00:00Z'::timestamptz
      from generate_series(1, 20) as series(value)
    `);
    await transaction.execute(sql`
      insert into neighborhood_versions (id, version, name, created_at)
      select
        ('20000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        1,
        'Real Neighborhood ' || value,
        '2026-08-16T19:00:00Z'::timestamptz
      from generate_series(1, 4) as series(value)
    `);
    await transaction.execute(sql`
      insert into neighborhood_facilities (
        neighborhood_id, neighborhood_version, facility_id
      )
      select
        ('20000000-0000-4000-8000-' ||
          lpad((((value - 1) / 5) + 1)::text, 12, '0'))::uuid,
        1,
        ('10000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid
      from generate_series(1, 20) as series(value)
    `);
  });

  await database.execute(
    sql.raw('alter table security_audit_entries disable trigger user'),
  );
  try {
    await database.execute(sql`
      insert into security_audit_entries (
        id, sequence, previous_hash, entry_hash, category, action, action_ids,
        confirmation_id, outcome, principal_kind, principal, source,
        facility_id, target_kind, target_id, request_id, reason_code, occurred_at
      ) values
      (
        ${ids.auditNorth}::uuid, 56,
        '84e1a8da4b36b17991f640e16aefba018aac2ed6d8af7c390895cb133a4dd26f',
        '8e7cd227e4b9b725834acdb718866e0156b47fbdd6184136c83eec7f4077b2da',
        'admin-change', 'update-facility', '{}'::jsonb, null, 'success',
        'system', '{"kind":"system"}'::jsonb, 'web', ${ids.north}::uuid,
        null, null, 'b240eb97-75a4-4051-8cc6-fc4b6d332fb1'::uuid, null,
        '2026-08-16T20:49:06.445Z'::timestamptz
      ),
      (
        ${ids.auditSouth}::uuid, 58,
        '58cc600f619a9368e945c88ac5c9f9032e576ddd5649361c0ec96b95e1d43758',
        '8e91c4c142960f5149d6a5375c4dc7d1546d7fd94fa4325dc2535b2fab4393ff',
        'admin-change', 'update-facility', '{}'::jsonb, null, 'failure',
        'system', '{"kind":"system"}'::jsonb, 'web', ${ids.south}::uuid,
        null, null, 'e95abdfc-26f6-44aa-b3fb-3fac41eeadb8'::uuid,
        'PERSISTENCE_CONFLICT', '2026-08-16T20:49:22.839Z'::timestamptz
      )
    `);
  } finally {
    await database.execute(
      sql.raw('alter table security_audit_entries enable trigger user'),
    );
  }

  await database.execute(sql`
    insert into security_audit_chain_anchors (sequence, entry_hash) values
      (56, '8e7cd227e4b9b725834acdb718866e0156b47fbdd6184136c83eec7f4077b2da'),
      (58, '8e91c4c142960f5149d6a5375c4dc7d1546d7fd94fa4325dc2535b2fab4393ff')
  `);
  await database.execute(sql`
    insert into idempotency_records (
      id, key, capability_id, principal, principal_digest, request_digest,
      status, created_at, completed_at, result_reference
    ) values (
      ${ids.idempotency}::uuid, 'issue199-live-idempotency',
      'update-facility', '{"kind":"system"}'::jsonb,
      repeat('1', 64), repeat('2', 64), 'completed',
      '2026-08-16T20:49:06.445Z'::timestamptz,
      '2026-08-16T20:49:06.445Z'::timestamptz,
      'synthetic-test-reference'
    )
  `);
}

async function retainedTruthSnapshot(
  database: PostgresDatabase,
): Promise<string> {
  const rows = databaseExecuteRows<SnapshotRow>(
    await database.execute<SnapshotRow>(sql`
      select jsonb_build_object(
        'realFacilities', (
          select md5(jsonb_agg(to_jsonb(row_value) order by id)::text)
          from facilities as row_value
          where id not in (${ids.north}::uuid, ${ids.south}::uuid)
        ),
        'realNeighborhoods', md5(jsonb_build_object(
          'versions', (
            select jsonb_agg(to_jsonb(row_value) order by id, version)
            from neighborhood_versions as row_value
            where id <> ${ids.neighborhood}::uuid
          ),
          'facilities', (
            select jsonb_agg(
              to_jsonb(row_value)
              order by neighborhood_id, neighborhood_version, facility_id
            )
            from neighborhood_facilities as row_value
            where neighborhood_id <> ${ids.neighborhood}::uuid
          )
        )::text),
        'audit', (
          select md5(jsonb_agg(to_jsonb(row_value) order by sequence)::text)
          from security_audit_entries as row_value
        ),
        'auditAnchors', (
          select md5(jsonb_agg(to_jsonb(row_value) order by sequence)::text)
          from security_audit_chain_anchors as row_value
        ),
        'idempotency', (
          select md5(jsonb_agg(to_jsonb(row_value) order by id)::text)
          from idempotency_records as row_value
        )
      )::text as snapshot
    `),
  );
  if (rows.length !== 1) {
    throw new Error('Retained-truth snapshot was not singular.');
  }
  return rows[0]?.snapshot ?? '';
}

/**
 * Counts the reviewed live graph 0012 purges.
 *
 * `includeAudience` is false only where the caller has already run the whole
 * migration folder: 0030 drops `audience_configurations` and `audience_targets`
 * with the audience layer (#292), and PostgreSQL resolves a relation at parse
 * time, so naming a dropped table fails even inside a branch that never runs.
 * 0012 is applied history and still counts those eight rows among its 57, so
 * every call made before it runs keeps them.
 */
async function canonicalOperationalCount(
  database: PostgresDatabase,
  includeAudience = true,
): Promise<number> {
  const audienceRows = includeAudience
    ? sql`
        (select count(*) from audience_configurations where id in ('00000000-0000-4000-8000-000000000020'::uuid, '00000000-0000-4000-8000-000000000021'::uuid)) +
        (select count(*) from audience_targets where audience_config_id in ('00000000-0000-4000-8000-000000000020'::uuid, '00000000-0000-4000-8000-000000000021'::uuid)) +`
    : sql``;
  const rows = databaseExecuteRows<CountRow>(
    await database.execute<CountRow>(sql`
      select (
        (select count(*) from facilities where id in (${ids.north}::uuid, ${ids.south}::uuid)) +
        (select count(*) from neighborhood_versions where id = ${ids.neighborhood}::uuid) +
        (select count(*) from neighborhood_facilities where neighborhood_id = ${ids.neighborhood}::uuid) +
        (select count(*) from group_sources where id between '00000000-0000-4000-8000-000000000030'::uuid and '00000000-0000-4000-8000-000000000032'::uuid) +
        ${audienceRows}
        (select count(*) from roster_source_configurations where id = ${ids.configuration}::uuid) +
        (select count(*) from roster_source_configuration_facilities where configuration_id = ${ids.configuration}::uuid) +
        (select count(*) from roster_source_configuration_groups where configuration_id = ${ids.configuration}::uuid) +
        (select count(*) from roster_snapshots where id = ${ids.snapshot}::uuid) +
        (select count(*) from roster_snapshot_facilities where roster_snapshot_id = ${ids.snapshot}::uuid) +
        (select count(*) from roster_snapshot_sources where roster_snapshot_id = ${ids.snapshot}::uuid) +
        (select count(*) from roster_recipients where roster_snapshot_id = ${ids.snapshot}::uuid) +
        (select count(*) from roster_recipient_group_sources where roster_snapshot_id = ${ids.snapshot}::uuid) +
        (select count(*) from roster_endpoints where roster_snapshot_id = ${ids.snapshot}::uuid)
      )::integer as count
    `),
  );
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error('Canonical operational count was not singular.');
  }
  return rows[0].count;
}

function postgresErrorFacts(
  error: unknown,
  field: 'code' | 'message',
): string[] {
  const facts: string[] = [];
  const visited = new Set<unknown>();
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

async function migrateReviewedFixture(
  connection: PostgresDatabaseConnection,
): Promise<void> {
  try {
    await migrateDatabase(connection);
  } catch (error) {
    const codes = postgresErrorFacts(error, 'code');
    const messages = postgresErrorFacts(error, 'message');
    const code = codes.at(-1) ?? 'unknown';
    const message = (messages.at(-1) ?? 'unknown database rejection').slice(
      0,
      1_024,
    );
    throw new Error(
      `Issue #199 reviewed migration failed with PostgreSQL ${code}: ${message}`,
    );
  }
}

async function expectPostgresRejection(
  operation: () => Promise<unknown>,
  expectedMessage: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(postgresErrorFacts(error, 'code')).toContain('55000');
    expect(postgresErrorFacts(error, 'message').join('\n')).toMatch(
      expectedMessage,
    );
    return;
  }
  throw new Error('Expected PostgreSQL to reject the issue #199 operation.');
}

async function expectMigrationRejection(
  connection: PostgresDatabaseConnection,
  expectedMessage: RegExp,
): Promise<void> {
  await expectPostgresRejection(
    async () => migrateDatabase(connection),
    expectedMessage,
  );
}

async function cleanupReviewedDatabase(
  connection: PostgresDatabaseConnection | undefined,
  databaseCreated: boolean,
  context: TestContext,
): Promise<void> {
  await executeOperationWithCleanup({
    operation: async () => {
      if (connection !== undefined) await connection.close();
    },
    cleanup: async () => {
      if (databaseCreated) await dropOwnedDatabase(context);
    },
    failureMessage: 'Issue #199 disposable database cleanup failed.',
  });
}

async function withDisposableDatabase(
  operation: (connection: PostgresDatabaseConnection) => Promise<void>,
): Promise<void> {
  if (baseTestDatabaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required for issue #199 tests.');
  }
  const context = createTestContext(baseTestDatabaseUrl);
  let connection: PostgresDatabaseConnection | undefined;
  let databaseCreated = false;
  await executeOperationWithCleanup({
    operation: async () => {
      await createOwnedDatabase(context);
      databaseCreated = true;
      const opened = openPostgresConnection(context.databaseUrl);
      connection = opened;
      await opened.db.execute(sql.raw('set client_min_messages = warning'));
      await operation(opened);
    },
    cleanup: () =>
      cleanupReviewedDatabase(connection, databaseCreated, context),
    failureMessage: 'Issue #199 removal proof failed.',
  });
}

async function withReviewedDatabase(
  operation: (connection: PostgresDatabaseConnection) => Promise<void>,
  configurationVersionTwoCreatedAt?: string,
): Promise<void> {
  if (partialMigrationsDirectory === undefined) {
    throw new Error('The partial migration directory was not prepared.');
  }
  const reviewedMigrationsDirectory = partialMigrationsDirectory;
  await withDisposableDatabase(async (connection) => {
    await migrateWithPostgres(connection.db, {
      migrationsFolder: reviewedMigrationsDirectory,
    });
    await stageReviewedLiveShape(
      connection.db,
      configurationVersionTwoCreatedAt,
    );
    expect(await canonicalOperationalCount(connection.db)).toBe(57);
    await operation(connection);
  });
}

async function expectMigrationArtifactsAbsent(
  database: PostgresDatabase,
): Promise<void> {
  const rows = databaseExecuteRows<NullableSnapshotRow>(
    await database.execute<NullableSnapshotRow>(sql`
      select to_regclass('public.security_audit_facility_anchors')::text
        as snapshot
    `),
  );
  expect(rows).toEqual([{ snapshot: null }]);
}

describeWithDatabase('canonical synthetic facility physical removal', () => {
  beforeAll(async () => {
    partialMigrationsDirectory = await prepareMigrationsThrough0011();
  });

  afterAll(async () => {
    if (partialMigrationsDirectory !== undefined) {
      await removePartialMigrationsDirectory(partialMigrationsDirectory);
      partialMigrationsDirectory = undefined;
    }
  });

  test('deletes exactly 57 operational rows while preserving retained truth', async () => {
    await withReviewedDatabase(async (connection) => {
      const before = await retainedTruthSnapshot(connection.db);
      await migrateReviewedFixture(connection);
      await seedReferenceData(connection.db);
      await seedReferenceData(connection.db);

      expect(await canonicalOperationalCount(connection.db, false)).toBe(0);
      expect(await retainedTruthSnapshot(connection.db)).toBe(before);
      const rows = databaseExecuteRows<RemovalReadbackRow>(
        await connection.db.execute<RemovalReadbackRow>(sql`
          select
            (select count(*)::integer from security_audit_facility_anchors
              where facility_id in (${ids.north}::uuid, ${ids.south}::uuid))
              as anchor_count,
            (select count(*)::integer from security_audit_entries
              where facility_id in (${ids.north}::uuid, ${ids.south}::uuid))
              as audit_count,
            (select count(*)::integer from idempotency_records
              where id = ${ids.idempotency}::uuid) as idempotency_count,
            (select count(*)::integer from facilities) as real_facility_count,
            (select count(distinct id)::integer from neighborhood_versions)
              as real_neighborhood_count,
            (select count(*)::integer from pg_trigger as trigger
              join pg_class as relation on relation.oid = trigger.tgrelid
              where trigger.tgname = relation.relname || '_retain_guard'
                and relation.relname in (
                  'roster_endpoints', 'roster_recipient_group_sources',
                  'roster_recipients', 'roster_snapshot_sources',
                  'roster_snapshot_facilities', 'roster_snapshots',
                  'roster_source_configuration_groups',
                  'roster_source_configuration_facilities',
                  'roster_source_configurations', 'audience_targets',
                  'audience_configurations', 'neighborhood_facilities',
                  'neighborhood_versions', 'group_sources', 'facilities'
                ) and trigger.tgenabled = 'O' and trigger.tgtype = 11
                and not trigger.tgisinternal) as guard_count,
            0::integer as operational_count
        `),
      );
      expect(rows).toEqual([
        {
          anchor_count: 2,
          audit_count: 2,
          // Zero, not 15. Migration 0012 restores every retain guard it lifts,
          // and 0029 then removes all of them from the schema deliberately.
          // The counts either side of this are what the test is really for:
          // the purge removed exactly the operational rows and left the
          // district's own facilities, campuses, anchors and audit trail.
          guard_count: 0,
          idempotency_count: 1,
          operational_count: 0,
          real_facility_count: 20,
          real_neighborhood_count: 4,
        },
      ]);

      await expectPostgresRejection(async () => {
        await connection.db.execute(sql`
            insert into facilities (id, code, name, active, created_at)
            values (
              ${ids.north}::uuid, 'SYN-NORTH', 'Synthetic North Campus', true,
              '2026-08-06T12:00:00Z'::timestamptz
            )
          `);
      }, /retained facility identity cannot be reused/iu);
      expect(await canonicalOperationalCount(connection.db, false)).toBe(0);
    });
  });

  for (const [description, configurationVersionTwoCreatedAt] of [
    ['the previously rounded live timestamp', '2026-08-16T20:49:06.444Z'],
    ['a one-microsecond near miss', '2026-08-16T20:49:06.444627Z'],
  ] as const) {
    test(`rolls back the entire migration for ${description}`, async () => {
      await withReviewedDatabase(async (connection) => {
        const before = await retainedTruthSnapshot(connection.db);
        await expectMigrationRejection(
          connection,
          /graph fingerprint does not match the approved 57 rows/iu,
        );
        expect(await canonicalOperationalCount(connection.db)).toBe(57);
        expect(await retainedTruthSnapshot(connection.db)).toBe(before);
        await expectMigrationArtifactsAbsent(connection.db);
      }, configurationVersionTwoCreatedAt);
    });
  }

  test('rolls back every DDL and row change when a real neighborhood is mixed in', async () => {
    await withReviewedDatabase(async (connection) => {
      await connection.db.transaction(async (transaction) => {
        await transaction.execute(sql`
          insert into neighborhood_versions (id, version, name, created_at)
          values (
            '20000000-0000-4000-8000-000000000099'::uuid,
            1,
            'Mixed Real Neighborhood',
            '2026-08-16T21:00:00Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into neighborhood_facilities (
            neighborhood_id, neighborhood_version, facility_id
          ) values (
            '20000000-0000-4000-8000-000000000099'::uuid, 1,
            ${ids.north}::uuid
          )
        `);
      });
      const before = await retainedTruthSnapshot(connection.db);
      await expectMigrationRejection(
        connection,
        /operational, event, delivery, access, or mixed dependencies/iu,
      );
      expect(await canonicalOperationalCount(connection.db)).toBe(57);
      expect(await retainedTruthSnapshot(connection.db)).toBe(before);
      await expectMigrationArtifactsAbsent(connection.db);
    });
  });

  test('preserves the entire graph and event when any event history exists', async () => {
    await withReviewedDatabase(async (connection) => {
      await connection.db.execute(sql`
        insert into events (
          id, facility_id, kind, template_mode, event_type_version_id,
          status, roster_snapshot_id, roster_population, created_by, created_at
        ) values (
          ${ids.blockingEvent}::uuid, ${ids.north}::uuid, 'drill', 'drill',
          '00000000-0000-4000-8000-000000000201'::uuid, 'draft', null, null,
          '{"kind":"human","userId":"synthetic-test"}'::jsonb,
          '2026-08-16T21:00:00Z'::timestamptz
        )
      `);
      const before = await retainedTruthSnapshot(connection.db);
      await expectMigrationRejection(
        connection,
        /operational, event, delivery, access, or mixed dependencies/iu,
      );
      expect(await canonicalOperationalCount(connection.db)).toBe(57);
      expect(await retainedTruthSnapshot(connection.db)).toBe(before);
      const eventRows = databaseExecuteRows<CountRow>(
        await connection.db.execute<CountRow>(sql`
          select count(*)::integer as count from events
          where id = ${ids.blockingEvent}::uuid
        `),
      );
      expect(eventRows).toEqual([{ count: 1 }]);
      await expectMigrationArtifactsAbsent(connection.db);
    });
  });
});
