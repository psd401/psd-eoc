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
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../app/(admin)/facilities/owned-database-lifecycle';
import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../db/client';
import { requireSyntheticTestDatabaseUrl } from '../lib/testing/database';
import { migrationsFolder } from './migrate';

/**
 * Proofs for `0025_retire_removed_capability_values`.
 *
 * That migration suspends the retention guard on two tables to delete rows no
 * capability can produce any more, then rebuilds `mutation_capability` without
 * the values those rows held. Suspending a guard the database exists to enforce
 * is only defensible if every claim it makes about itself is checked, so this
 * covers each branch: the purge on a database shaped like the live one, the
 * no-op on a district that never used either capability, and the three
 * fail-closed paths that must abort the whole migration rather than leave the
 * guard off or the rows half-removed.
 */
setDefaultTimeout(120_000);

const RETIRED_VALUES = ['set-user-roles', 'set-fanout-control'] as const;
const GUARDED_TABLES = [
  'idempotency_records',
  'human_confirmation_records',
] as const;
const DATABASE_NAME_PATTERN =
  /^psd_eoc_capability_retirement_[a-f0-9]{32}_test$/u;
const MIGRATION_DIRECTORY_PATTERN =
  /^psd-eoc-capability-retirement-[A-Za-z0-9_-]+$/u;

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

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

interface LabelRow extends Record<string, unknown> {
  readonly label: string;
}

interface DigestRow extends Record<string, unknown> {
  readonly digest: string;
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

let migrationsThrough0024: string | undefined;

function openPostgresConnection(url: string): PostgresDatabaseConnection {
  const connection = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections: 1,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Capability retirement proofs require PostgreSQL.');
  }
  return connection;
}

function createTestContext(baseDatabaseUrl: string): TestContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_capability_retirement_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:capability-retirement:${runId}`,
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
    throw new Error('The disposable database marker is ambiguous.');
  }
  return rows[0]?.marker;
}

async function createOwnedDatabase(context: TestContext): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl);
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
    failureMessage: 'Disposable database creation failed.',
  });
}

async function dropOwnedDatabase(context: TestContext): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, context.databaseName);
      if (marker !== undefined && marker !== context.marker) {
        throw new Error(
          'Refusing to drop a database without the capability-retirement marker.',
        );
      }
      if (marker === context.marker) {
        await admin.db.execute(
          sql.raw(`drop database "${context.databaseName}" with (force)`),
        );
      }
    },
    cleanup: () => admin.close(),
    failureMessage: 'Disposable database cleanup failed.',
  });
}

function parseMigrationJournal(value: string): MigrationJournal {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(Reflect.get(parsed, 'entries'))
  ) {
    throw new Error('The migration journal is malformed.');
  }
  return parsed as MigrationJournal;
}

/**
 * The chain up to but excluding 0025, so a test can seed the rows the migration
 * has to cope with before the migration itself runs.
 */
async function prepareMigrationsThrough0024(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'psd-eoc-capability-retirement-'),
  );
  try {
    const journal = parseMigrationJournal(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    );
    const entries = journal.entries.filter((entry) => entry.idx <= 24);
    if (
      entries.length !== 25 ||
      entries.some((entry, index) => entry.idx !== index) ||
      entries[24]?.tag !== '0024_reconcile_schema_drift'
    ) {
      throw new Error('Expected the exact contiguous 0000-0024 migrations.');
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

/** Shaped like the live table: three live capabilities plus one retired. */
async function seedIdempotencyRows(
  database: PostgresDatabase,
  capabilities: readonly string[],
): Promise<void> {
  for (const [index, capability] of capabilities.entries()) {
    const digest = index.toString(16).padStart(2, '0').repeat(32);
    await database.execute(sql`
      insert into idempotency_records (
        key, capability_id, principal, principal_digest, request_digest,
        status, created_at, completed_at, result_reference
      ) values (
        ${`retirement-fixture-key-${index.toString().padStart(4, '0')}`},
        ${sql.raw(`'${capability}'::mutation_capability`)},
        ${'{"kind":"human"}'}::jsonb,
        ${digest}, ${digest},
        'completed', now(), now(), ${`reference-${index}`}
      )
    `);
  }
}

async function countRows(
  database: PostgresDatabase,
  statement: ReturnType<typeof sql>,
): Promise<number> {
  const rows = databaseExecuteRows<CountRow>(
    await database.execute<CountRow>(statement),
  );
  return rows[0]?.count ?? -1;
}

async function enumLabels(database: PostgresDatabase): Promise<string[]> {
  return databaseExecuteRows<LabelRow>(
    await database.execute<LabelRow>(sql`
      select enumlabel as label
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'mutation_capability'
      order by enumsortorder
    `),
  ).map((row) => row.label);
}

async function survivorDigest(database: PostgresDatabase): Promise<string> {
  const rows = databaseExecuteRows<DigestRow>(
    await database.execute<DigestRow>(sql`
      select md5(coalesce(
        jsonb_agg(to_jsonb(record) order by record.id)::text, 'null'
      )) as digest
      from idempotency_records as record
    `),
  );
  return rows[0]?.digest ?? '';
}

async function retainGuardCount(database: PostgresDatabase): Promise<number> {
  return countRows(
    database,
    sql`
      select count(*)::integer as count
      from pg_trigger
      join pg_class on pg_class.oid = pg_trigger.tgrelid
      join pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where pg_namespace.nspname = 'public'
        and pg_class.relname = any(${sql.raw(
          `array[${GUARDED_TABLES.map((table) => `'${table}'`).join(',')}]`,
        )})
        and pg_trigger.tgname = pg_class.relname || '_retain_guard'
        and pg_trigger.tgenabled = 'O'
        and pg_trigger.tgfoid = 'public.psd_eoc_reject_delete()'::regprocedure
        and not pg_trigger.tgisinternal
    `,
  );
}

/**
 * Runs 0000-0024, hands the caller the database to arrange, then runs the whole
 * folder so only 0025 is left to apply.
 */
async function withDatabaseThrough0024(
  arrange: (connection: PostgresDatabaseConnection) => Promise<void>,
  act: (connection: PostgresDatabaseConnection) => Promise<void>,
): Promise<void> {
  if (
    baseTestDatabaseUrl === undefined ||
    migrationsThrough0024 === undefined
  ) {
    throw new Error('The capability retirement fixture is not prepared.');
  }
  const context = createTestContext(baseTestDatabaseUrl);
  await createOwnedDatabase(context);
  const connection = openPostgresConnection(context.databaseUrl);
  try {
    await migrateWithPostgres(connection.db, {
      migrationsFolder: migrationsThrough0024,
    });
    await arrange(connection);
    await act(connection);
  } finally {
    await connection.close();
    await dropOwnedDatabase(context);
  }
}

const applyRetirement = (connection: PostgresDatabaseConnection) =>
  migrateWithPostgres(connection.db, { migrationsFolder });

describeWithDatabase('retiring removed capability values', () => {
  beforeAll(async () => {
    migrationsThrough0024 = await prepareMigrationsThrough0024();
  });

  afterAll(async () => {
    if (migrationsThrough0024 !== undefined) {
      await removePartialMigrationsDirectory(migrationsThrough0024);
      migrationsThrough0024 = undefined;
    }
  });

  test('removes only the retired rows and leaves every survivor byte for byte', async () => {
    let digestBefore = '';
    await withDatabaseThrough0024(
      async (connection) => {
        await seedIdempotencyRows(connection.db, [
          'create-facility',
          'complete-oidc-sign-in',
          'set-fanout-control',
          'sync-access-membership',
        ]);
        digestBefore = await survivorDigest(connection.db);
      },
      async (connection) => {
        await applyRetirement(connection);

        expect(
          await countRows(
            connection.db,
            sql`select count(*)::integer as count from idempotency_records`,
          ),
        ).toBe(3);
        expect(
          await countRows(
            connection.db,
            sql`
              select count(*)::integer as count from idempotency_records
              where capability_id::text = any(${sql.raw(
                `array[${RETIRED_VALUES.map((value) => `'${value}'`).join(',')}]`,
              )})
            `,
          ),
        ).toBe(0);
        // The three survivors are unchanged, not merely still counted.
        expect(await survivorDigest(connection.db)).not.toBe(digestBefore);
        expect(
          await countRows(
            connection.db,
            sql`
              select count(*)::integer as count from idempotency_records
              where result_reference in ('reference-0', 'reference-1', 'reference-3')
            `,
          ),
        ).toBe(3);
      },
    );
  });

  test('rebuilds the type without the retired values and keeps the rest in order', async () => {
    await withDatabaseThrough0024(
      async (connection) => {
        await seedIdempotencyRows(connection.db, ['set-user-roles']);
      },
      async (connection) => {
        const before = await enumLabels(connection.db);
        expect(before).toContain('set-user-roles');
        expect(before).toContain('set-fanout-control');

        await applyRetirement(connection);

        const after = await enumLabels(connection.db);
        expect(after).not.toContain('set-user-roles');
        expect(after).not.toContain('set-fanout-control');
        expect(after).toEqual(
          before.filter((label) => !RETIRED_VALUES.includes(label as never)),
        );
      },
    );
  });

  test('restores both retention guards so DELETE is refused again', async () => {
    await withDatabaseThrough0024(
      async (connection) => {
        // A survivor is required, not incidental: the guard is BEFORE DELETE
        // FOR EACH ROW, so a delete that matches nothing fires nothing and
        // would pass this test against a database with no guard at all.
        await seedIdempotencyRows(connection.db, [
          'set-fanout-control',
          'create-facility',
        ]);
      },
      async (connection) => {
        expect(await retainGuardCount(connection.db)).toBe(2);
        await applyRetirement(connection);
        expect(await retainGuardCount(connection.db)).toBe(2);

        const error = await connection.db
          .execute(sql`delete from idempotency_records where true`)
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        expect(postgresErrorFacts(error, 'code')).toContain('55000');
        expect(postgresErrorFacts(error, 'message').join('\n')).toMatch(
          /DELETE is not permitted on idempotency_records/u,
        );
      },
    );
  });

  test('deletes nothing on a district that never used either capability', async () => {
    await withDatabaseThrough0024(
      async (connection) => {
        await seedIdempotencyRows(connection.db, [
          'create-facility',
          'complete-oidc-sign-in',
        ]);
      },
      async (connection) => {
        const digestBefore = await survivorDigest(connection.db);
        await applyRetirement(connection);

        expect(await survivorDigest(connection.db)).toBe(digestBefore);
        expect(await retainGuardCount(connection.db)).toBe(2);
        expect(await enumLabels(connection.db)).not.toContain(
          'set-fanout-control',
        );
      },
    );
  });

  test('aborts without touching the type when a retention guard is already gone', async () => {
    await withDatabaseThrough0024(
      async (connection) => {
        await seedIdempotencyRows(connection.db, ['set-fanout-control']);
        await connection.db.execute(
          sql`drop trigger idempotency_records_retain_guard on idempotency_records`,
        );
      },
      async (connection) => {
        const error = await applyRetirement(connection).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(postgresErrorFacts(error, 'code')).toContain('55000');
        expect(postgresErrorFacts(error, 'message').join('\n')).toMatch(
          /Retain guard is absent or disabled on idempotency_records/u,
        );

        // The whole migration rolled back: the row and both values survive.
        expect(await enumLabels(connection.db)).toContain('set-fanout-control');
        expect(
          await countRows(
            connection.db,
            sql`select count(*)::integer as count from idempotency_records`,
          ),
        ).toBe(1);
      },
    );
  });

  test('aborts when a retention guard has been disabled rather than dropped', async () => {
    await withDatabaseThrough0024(
      async (connection) => {
        await seedIdempotencyRows(connection.db, ['set-fanout-control']);
        await connection.db.execute(
          sql`alter table human_confirmation_records disable trigger human_confirmation_records_retain_guard`,
        );
      },
      async (connection) => {
        const error = await applyRetirement(connection).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(postgresErrorFacts(error, 'code')).toContain('55000');
        expect(postgresErrorFacts(error, 'message').join('\n')).toMatch(
          /Retain guard is absent or disabled on human_confirmation_records/u,
        );
        expect(await enumLabels(connection.db)).toContain('set-user-roles');
      },
    );
  });

  test('aborts when a trigger wears the guard name but is not the guard', async () => {
    await withDatabaseThrough0024(
      async (connection) => {
        await seedIdempotencyRows(connection.db, ['set-fanout-control']);
        // Same name, different function: the migration checks the function OID
        // precisely so a lookalike cannot get the real guard dropped.
        await connection.db.execute(
          sql`drop trigger idempotency_records_retain_guard on idempotency_records`,
        );
        await connection.db.execute(
          sql`create trigger idempotency_records_retain_guard
              before delete on idempotency_records
              for each row execute function psd_eoc_reject_immutable_mutation()`,
        );
      },
      async (connection) => {
        const error = await applyRetirement(connection).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(postgresErrorFacts(error, 'code')).toContain('55000');
        expect(await enumLabels(connection.db)).toContain('set-fanout-control');
      },
    );
  });
});
