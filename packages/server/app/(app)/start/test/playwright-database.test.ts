import { describe, expect, test } from 'bun:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import postgres from 'postgres';

import {
  dropStartFlowPlaywrightDatabase,
  recreateStartFlowPlaywrightDatabase,
  requireStartFlowPlaywrightDatabaseOwnership,
  startFlowPlaywrightDatabaseMarker,
  startFlowPlaywrightDatabaseName,
  startFlowPlaywrightDatabaseUrl,
} from './playwright-database';
import {
  acquireStartFlowPlaywrightArtifacts,
  assertStartFlowPlaywrightArtifactsOwned,
  createStartFlowPlaywrightRunId,
  removeStartFlowPlaywrightArtifacts,
  requireStartFlowPlaywrightRunId,
  startFlowPlaywrightPaths,
} from './playwright-run';

const BASE_URL =
  'postgresql://synthetic:synthetic-only@127.0.0.1:55415/shared_test';
const RUN_A = 'a'.repeat(32);
const RUN_B = 'b'.repeat(32);
const testWithDatabase =
  process.env.TEST_DATABASE_URL === undefined ? test.skip : test;

interface DatabaseMarkerRow {
  readonly marker: string | null;
}

function testMaintenanceConnection(): postgres.Sql {
  const configured = process.env.TEST_DATABASE_URL;
  if (configured === undefined) {
    throw new Error('TEST_DATABASE_URL is required for database regressions.');
  }
  // Reuse the production helper's loopback and synthetic-base validation
  // before this test harness receives database-level mutation authority.
  const maintenanceUrl = new URL(
    startFlowPlaywrightDatabaseUrl(configured, RUN_A),
  );
  maintenanceUrl.pathname = '/postgres';
  return postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readDatabaseMarker(
  sql: postgres.Sql,
  databaseName: string,
): Promise<string | null | undefined> {
  const rows = await sql<DatabaseMarkerRow[]>`
    select shobj_description(oid, 'pg_database') as marker
    from pg_database
    where datname = ${databaseName}
  `;
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0]?.marker;
}

async function executeTestWithCleanup(
  operation: () => Promise<void>,
  cleanup: readonly (() => Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanupOperation of cleanup) {
    try {
      await cleanupOperation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'Start-flow database regression and exact cleanup both failed.',
    );
  }
}

async function expectDatabasesAbsent(runIds: readonly string[]): Promise<void> {
  const admin = testMaintenanceConnection();
  await executeTestWithCleanup(async () => {
    for (const runId of runIds) {
      expect(
        await readDatabaseMarker(admin, startFlowPlaywrightDatabaseName(runId)),
      ).toBeUndefined();
    }
  }, [async () => admin.end()]);
}

describe('start-flow Playwright database isolation', () => {
  test('derives distinct synthetic databases and artifacts per run', () => {
    expect(startFlowPlaywrightDatabaseName(RUN_A)).toBe(
      `psd_eoc_i15_pw_${RUN_A}_test`,
    );
    expect(startFlowPlaywrightDatabaseUrl(BASE_URL, RUN_A)).not.toBe(
      startFlowPlaywrightDatabaseUrl(BASE_URL, RUN_B),
    );
    expect(startFlowPlaywrightDatabaseUrl(BASE_URL, RUN_A)).toBe(
      `postgresql://synthetic:synthetic-only@127.0.0.1:55415/psd_eoc_i15_pw_${RUN_A}_test`,
    );
    expect(startFlowPlaywrightPaths(RUN_A)).not.toEqual(
      startFlowPlaywrightPaths(RUN_B),
    );
  });

  test('requires an exact lowercase hexadecimal run identifier', () => {
    expect(() => requireStartFlowPlaywrightRunId(undefined)).toThrow(
      'must be exactly 32 lowercase hexadecimal characters',
    );
    expect(() => requireStartFlowPlaywrightRunId('A'.repeat(32))).toThrow();
    expect(() => requireStartFlowPlaywrightRunId('a'.repeat(31))).toThrow();
    expect(requireStartFlowPlaywrightRunId(RUN_A)).toBe(RUN_A);
  });

  test('binds database deletion authority to the exact immutable run marker', () => {
    const marker = startFlowPlaywrightDatabaseMarker(RUN_A);
    expect(JSON.parse(marker)).toEqual({
      kind: 'psd-eoc-start-flow-playwright-database',
      version: 1,
      runId: RUN_A,
      databaseName: startFlowPlaywrightDatabaseName(RUN_A),
    });
    expect(() =>
      requireStartFlowPlaywrightDatabaseOwnership(RUN_A, marker),
    ).not.toThrow();
    expect(() =>
      requireStartFlowPlaywrightDatabaseOwnership(RUN_A, null),
    ).toThrow('ownership marker');
    expect(() =>
      requireStartFlowPlaywrightDatabaseOwnership(
        RUN_A,
        startFlowPlaywrightDatabaseMarker(RUN_B),
      ),
    ).toThrow('ownership marker');
  });

  test('rejects a production-named base before deriving a database', () => {
    expect(() =>
      startFlowPlaywrightDatabaseUrl(
        'postgresql://synthetic:synthetic-only@127.0.0.1:5432/psd_eoc',
        RUN_A,
      ),
    ).toThrow('whose name ends in _test');
  });

  test('rejects a remote database host', () => {
    expect(() =>
      startFlowPlaywrightDatabaseUrl(
        'postgresql://synthetic:synthetic-only@db.example.invalid:5432/shared_test',
        RUN_A,
      ),
    ).toThrow();
  });

  test('accepts bracketed IPv6 loopback without weakening host validation', () => {
    expect(
      startFlowPlaywrightDatabaseUrl(
        'postgresql://synthetic:synthetic-only@[::1]:5432/shared_test',
        RUN_A,
      ),
    ).toBe(
      `postgresql://synthetic:synthetic-only@[::1]:5432/psd_eoc_i15_pw_${RUN_A}_test`,
    );
  });

  test('artifact cleanup removes only the exact run-owned directory', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const paths = startFlowPlaywrightPaths(runId);
    await acquireStartFlowPlaywrightArtifacts(runId);
    try {
      await writeFile(paths.fixture, '{"synthetic":true}', { mode: 0o600 });
      await removeStartFlowPlaywrightArtifacts(runId);
      await expect(access(paths.root)).rejects.toThrow();
    } finally {
      await removeStartFlowPlaywrightArtifacts(runId);
    }
  });

  test('artifact acquisition refuses to claim a pre-existing directory', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const paths = startFlowPlaywrightPaths(runId);
    await mkdir(paths.root, { mode: 0o700 });
    await writeFile(paths.fixture, '{"belongsTo":"another-process"}', {
      mode: 0o600,
    });
    try {
      await expect(
        acquireStartFlowPlaywrightArtifacts(runId),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      await access(paths.fixture);
      await expect(access(paths.owner)).rejects.toThrow();
    } finally {
      await writeFile(paths.owner, `${runId}\n`, { mode: 0o600 });
      await removeStartFlowPlaywrightArtifacts(runId);
    }
  });

  test('artifact ownership assertion validates without changing contents', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const paths = startFlowPlaywrightPaths(runId);
    await acquireStartFlowPlaywrightArtifacts(runId);
    await writeFile(paths.fixture, '{"synthetic":true}', { mode: 0o600 });
    try {
      await assertStartFlowPlaywrightArtifactsOwned(runId);
      await access(paths.fixture);

      const mismatchedRunId = runId === RUN_A ? RUN_B : RUN_A;
      await writeFile(paths.owner, `${mismatchedRunId}\n`, { mode: 0o600 });
      await expect(
        assertStartFlowPlaywrightArtifactsOwned(runId),
      ).rejects.toThrow('mismatched ownership marker');
      await access(paths.fixture);
    } finally {
      await writeFile(paths.owner, `${runId}\n`, { mode: 0o600 });
      await removeStartFlowPlaywrightArtifacts(runId);
    }
  });

  test('artifact cleanup retains an unowned or mismatched directory', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const paths = startFlowPlaywrightPaths(runId);
    await mkdir(paths.root, { mode: 0o700 });
    try {
      await writeFile(paths.fixture, '{"synthetic":true}', { mode: 0o600 });
      await expect(removeStartFlowPlaywrightArtifacts(runId)).rejects.toThrow(
        'without an ownership marker',
      );
      await access(paths.fixture);

      const mismatchedRunId = runId === RUN_A ? RUN_B : RUN_A;
      await writeFile(paths.owner, `${mismatchedRunId}\n`, { mode: 0o600 });
      await expect(removeStartFlowPlaywrightArtifacts(runId)).rejects.toThrow(
        'mismatched ownership marker',
      );
      await access(paths.fixture);

      await writeFile(paths.owner, `${runId}\n`);
      await removeStartFlowPlaywrightArtifacts(runId);
      await expect(access(paths.root)).rejects.toThrow();
    } finally {
      try {
        await writeFile(paths.owner, `${runId}\n`);
      } catch {
        // The correctly owned directory was already removed.
      }
      await removeStartFlowPlaywrightArtifacts(runId);
    }
  });

  testWithDatabase(
    'refuses to replace or drop a pre-existing database with another marker',
    async () => {
      const runId = createStartFlowPlaywrightRunId();
      const databaseName = startFlowPlaywrightDatabaseName(runId);
      const mismatchedMarker = JSON.stringify({
        kind: 'psd-eoc-start-flow-refusal-regression',
        runId,
        databaseName,
      });
      const admin = testMaintenanceConnection();
      let created = false;

      await executeTestWithCleanup(async () => {
        await admin.unsafe(`create database "${databaseName}"`);
        created = true;
        await admin.unsafe(
          `comment on database "${databaseName}" is ${quotedLiteral(mismatchedMarker)}`,
        );

        await expect(
          recreateStartFlowPlaywrightDatabase(
            process.env.TEST_DATABASE_URL,
            runId,
          ),
        ).rejects.toThrow();
        expect(await readDatabaseMarker(admin, databaseName)).toBe(
          mismatchedMarker,
        );

        await expect(
          dropStartFlowPlaywrightDatabase(process.env.TEST_DATABASE_URL, runId),
        ).rejects.toThrow('ownership marker');
        expect(await readDatabaseMarker(admin, databaseName)).toBe(
          mismatchedMarker,
        );
      }, [
        async () => {
          if (!created) return;
          const marker = await readDatabaseMarker(admin, databaseName);
          if (marker !== mismatchedMarker) {
            throw new Error(
              'Refusing regression cleanup without its exact test marker.',
            );
          }
          await admin.unsafe(`drop database "${databaseName}" with (force)`);
          expect(await readDatabaseMarker(admin, databaseName)).toBeUndefined();
        },
        async () => admin.end(),
      ]);
      await expectDatabasesAbsent([runId]);
    },
    30_000,
  );

  testWithDatabase(
    'tearing down one concurrent run leaves the other database intact',
    async () => {
      const runA = createStartFlowPlaywrightRunId();
      const runB = createStartFlowPlaywrightRunId();
      let sqlA: postgres.Sql | undefined;
      let sqlB: postgres.Sql | undefined;
      await executeTestWithCleanup(async () => {
        const urlA = await recreateStartFlowPlaywrightDatabase(
          process.env.TEST_DATABASE_URL,
          runA,
        );
        const urlB = await recreateStartFlowPlaywrightDatabase(
          process.env.TEST_DATABASE_URL,
          runB,
        );
        sqlA = postgres(urlA, { max: 1 });
        sqlB = postgres(urlB, { max: 1 });
        await Promise.all([
          sqlA`create table run_marker (value text not null)`,
          sqlB`create table run_marker (value text not null)`,
        ]);
        await Promise.all([
          sqlA`insert into run_marker (value) values ('run-a')`,
          sqlB`insert into run_marker (value) values ('run-b')`,
        ]);
        await sqlA.end();
        sqlA = undefined;
        expect(
          await dropStartFlowPlaywrightDatabase(
            process.env.TEST_DATABASE_URL,
            runA,
          ),
        ).toBe(true);
        const [marker] = await sqlB<{ value: string }[]>`
            select value from run_marker
          `;
        expect(marker?.value).toBe('run-b');
      }, [
        async () => {
          await sqlA?.end();
        },
        async () => {
          await sqlB?.end();
        },
        async () => {
          await dropStartFlowPlaywrightDatabase(
            process.env.TEST_DATABASE_URL,
            runA,
          );
        },
        async () => {
          await dropStartFlowPlaywrightDatabase(
            process.env.TEST_DATABASE_URL,
            runB,
          );
        },
      ]);
      await expectDatabasesAbsent([runA, runB]);
    },
    30_000,
  );
});
