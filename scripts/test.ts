/**
 * Runs the repository test suite in parallel shards.
 *
 * `bun test` executes one file at a time in one process. With most of the
 * suite waiting on PostgreSQL rather than burning CPU, that leaves the machine
 * almost idle and the gate measured in minutes. This splits the files across
 * several `bun test` processes instead.
 *
 * Each shard gets its own freshly created database. That is not only for
 * isolation between shards: suites that assert what a fresh migration and seed
 * produce were reading a database every other suite had already written to, so
 * the gate passed once and then failed on the next run against the same
 * server. A database per shard, created and dropped by this script, makes a
 * run mean the same thing every time.
 *
 * Usage: bun scripts/test.ts [--shards N] [extra bun test args]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import postgres from 'postgres';

import { requireSyntheticTestDatabaseUrl } from '../packages/server/lib/testing/database';

export const ROOT = new URL('..', import.meta.url).pathname;
// `scripts` is here because leaving it out meant a colocated test could be
// written, committed, and never run. `scripts/ops/appstore/asc.test.ts` had
// been in that state: 171 assertions the gate had never once executed.
export const SEARCH_ROOTS = ['packages', 'workers', 'infra', 'scripts'];
const TEST_PATTERN = /\.(test|spec)\.tsx?$/u;
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'ios',
  'android',
  'cdk.out',
]);

export function discoverTestFiles(
  directory: string,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      discoverTestFiles(join(directory, entry.name), found);
    } else if (TEST_PATTERN.test(entry.name)) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

/**
 * Longest-processing-time first: the slowest files start earliest, so the
 * shards finish within one file of each other instead of one shard trailing
 * with a large suite nobody else is waiting on. File size stands in for
 * duration, which is imperfect but needs no bookkeeping to stay accurate.
 */
export function balanceShards(files: string[], shardCount: number): string[][] {
  const weighted = files
    .map((file) => ({ file, weight: statSync(file).size }))
    .sort((left, right) => right.weight - left.weight);
  const shards = Array.from({ length: shardCount }, () => ({
    files: [] as string[],
    weight: 0,
  }));
  for (const { file, weight } of weighted) {
    const lightest = shards.reduce((min, shard) =>
      shard.weight < min.weight ? shard : min,
    );
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return shards.map((shard) => shard.files);
}

export type TestMode = 'full' | 'unit';

export function parseTestArguments(argv: string[]): {
  shardCount: number;
  mode: TestMode;
  passthrough: string[];
} {
  const unitOnly = argv.includes('--unit-only');
  const withoutMode = argv.filter((argument) => argument !== '--unit-only');
  const index = withoutMode.indexOf('--shards');
  if (index === -1) {
    return {
      shardCount: Math.max(1, Math.min(6, navigator.hardwareConcurrency - 2)),
      mode: unitOnly ? 'unit' : 'full',
      passthrough: withoutMode,
    };
  }
  const value = Number(withoutMode[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error('--shards must be an integer between 1 and 16.');
  }
  return {
    shardCount: value,
    mode: unitOnly ? 'unit' : 'full',
    passthrough: [
      ...withoutMode.slice(0, index),
      ...withoutMode.slice(index + 2),
    ],
  };
}

export function isDatabaseDependentTest(file: string): boolean {
  return /process\.env(?:\.TEST_DATABASE_URL|\[['"]TEST_DATABASE_URL['"]\])/u.test(
    readFileSync(join(ROOT, file), 'utf8'),
  );
}

export function selectTestFiles(
  files: string[],
  mode: TestMode,
): { excluded: string[]; selected: string[] } {
  if (mode === 'full') return { excluded: [], selected: files };
  const excluded = files.filter(isDatabaseDependentTest);
  const excludedSet = new Set(excluded);
  return {
    excluded,
    selected: files.filter((file) => !excludedSet.has(file)),
  };
}

export function requireFullGateDatabase(
  mode: TestMode,
  testDatabaseUrl: string | undefined,
): void {
  if (mode === 'unit') return;
  try {
    requireSyntheticTestDatabaseUrl(testDatabaseUrl);
  } catch (error) {
    const cause = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(
      `The full repository test gate requires a safe TEST_DATABASE_URL. Start the synthetic PostgreSQL service with \`bun run test:db:start\`, export the URL it prints, then rerun \`bun run check\`. Use \`bun run test:unit\` only when intentionally excluding the database suites.${cause}`,
    );
  }
}

export function countSkippedTests(output: string): number {
  return [...output.matchAll(/^\s*(\d+) skip\s*$/gmu)].reduce(
    (total, match) => total + Number(match[1] ?? 0),
    0,
  );
}

async function withMaintenance<T>(
  baseUrl: string,
  run: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const url = new URL(baseUrl);
  url.pathname = '/postgres';
  const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Creates the cluster-wide roles once, before any shard starts.
 *
 * Migration 0000 creates its roles with
 * `IF NOT EXISTS (SELECT 1 FROM pg_roles ...) THEN CREATE ROLE`. `pg_roles` is
 * cluster-wide rather than per-database, so six shards migrating their own
 * databases at the same time all read "not there" and all try to create it;
 * every one but the winner fails with a duplicate object, and the shard dies
 * partway through migrating.
 *
 * It only bites on a cluster that has never run the suite, because afterwards
 * the roles already exist and the guard is satisfied. That is precisely the
 * case in CI, which starts a fresh PostgreSQL service for every run, and it
 * produced a failure in a different arbitrary test on each attempt.
 *
 * Creating them here serialises that one step. Migrations remain the source of
 * truth for what the roles are; applied migration files are history and are not
 * edited to work around this.
 *
 * @param baseUrl connection string for the PostgreSQL server under test
 */
async function createClusterRoles(baseUrl: string): Promise<void> {
  const roles = new Set<string>();
  const migrations = join(ROOT, 'packages/server/drizzle/migrations');
  for (const entry of readdirSync(migrations)) {
    if (!entry.endsWith('.sql')) continue;
    const contents = await Bun.file(join(migrations, entry)).text();
    for (const match of contents.matchAll(
      /CREATE ROLE\s+"([A-Za-z0-9_]+)"([^;]*);/gu,
    )) {
      const name = match[1];
      if (name !== undefined) roles.add(`${name}\u0000${match[2] ?? ''}`);
    }
  }
  if (roles.size === 0) return;
  await withMaintenance(baseUrl, async (sql) => {
    for (const role of roles) {
      const [name, options] = role.split('\u0000');
      await sql.unsafe(`do $$
        begin
          if not exists (select 1 from pg_catalog.pg_roles where rolname = '${String(name)}') then
            create role "${String(name)}" ${String(options ?? '').trim()};
          end if;
        end;
      $$;`);
    }
  });
}

export async function runTestSuite(arguments_: string[]): Promise<number> {
  const { mode, passthrough, shardCount } = parseTestArguments(arguments_);
  const discovered = SEARCH_ROOTS.flatMap((root) =>
    discoverTestFiles(join(ROOT, root)),
  ).map((file) => relative(ROOT, file));
  const baseDatabaseUrl =
    mode === 'full' ? process.env.TEST_DATABASE_URL : undefined;
  requireFullGateDatabase(mode, baseDatabaseUrl);
  if (mode === 'full' && Bun.which('pdftotext') === null) {
    throw new Error(
      'The full repository test gate requires pdftotext so PDF assertions cannot skip. Install Poppler, then rerun `bun run check`.',
    );
  }

  const { excluded, selected: files } = selectTestFiles(discovered, mode);
  if (mode === 'unit' && excluded.length > 0) {
    console.info(
      `Unit-only mode excludes ${String(excluded.length)} database-dependent test files:\n${excluded
        .map((file) => `- ${file}`)
        .join('\n')}`,
    );
  }
  if (files.length === 0) {
    console.info('No tests have been added yet.');
    return 0;
  }

  const shards = balanceShards(files, shardCount).filter(
    (shard) => shard.length > 0,
  );
  console.info(
    `Running ${String(files.length)} ${mode} test files across ${String(shards.length)} shard(s).`,
  );

  const shardDatabases: string[] = [];
  if (baseDatabaseUrl !== undefined) {
    await withMaintenance(baseDatabaseUrl, async (sql) => {
      for (let index = 0; index < shards.length; index += 1) {
        const name = `psd_eoc_shard${String(index)}_test`;
        await sql.unsafe(`drop database if exists "${name}" (force)`);
        await sql.unsafe(`create database "${name}"`);
        shardDatabases.push(name);
      }
    });
    await createClusterRoles(baseDatabaseUrl);
  }

  const started = Date.now();
  const results = await Promise.all(
    shards.map(async (shardFiles, index) => {
      const environment: Record<string, string> = {
        ...process.env,
      } as Record<string, string>;
      if (baseDatabaseUrl !== undefined) {
        const url = new URL(baseDatabaseUrl);
        url.pathname = `/${shardDatabases[index] ?? ''}`;
        environment.TEST_DATABASE_URL = url.toString();
        environment.DATABASE_URL = url.toString();
      }
      const child = Bun.spawn({
        cmd: [process.execPath, 'test', ...passthrough, ...shardFiles],
        cwd: ROOT,
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { index, stdout, stderr, exitCode };
    }),
  );

  let unexpectedSkipCount = 0;
  for (const { index, stdout, stderr, exitCode } of results) {
    const summary = stderr
      .split('\n')
      .filter(
        (line) =>
          /^\s*\d+ (pass|fail|skip|todo)/u.test(line) ||
          line.startsWith('(fail)'),
      )
      .join('\n');
    console.info(
      `\n──── shard ${String(index)} (exit ${String(exitCode)}) ────\n${summary}`,
    );
    unexpectedSkipCount += countSkippedTests(stderr);
    if (exitCode !== 0) {
      console.error(stdout);
      console.error(stderr);
    }
  }

  if (baseDatabaseUrl !== undefined) {
    await withMaintenance(baseDatabaseUrl, async (sql) => {
      for (const name of shardDatabases) {
        await sql.unsafe(`drop database if exists "${name}" (force)`);
      }
      // Databases individual suites created and failed to remove. They are
      // named by this repository's helpers and nothing else on a developer's
      // server uses the prefix, so a sweep here keeps a crashed run from
      // leaving a server full of them.
      const leaked = await sql<{ datname: string }[]>`
        select datname from pg_database
        where datname like 'psd\\_eoc\\_%\\_test' and datname <> 'psd_eoc_test'
      `;
      for (const { datname } of leaked) {
        await sql.unsafe(`drop database if exists "${datname}" (force)`);
      }
    });
  }

  if (unexpectedSkipCount > 0) {
    console.error(
      `The ${mode} test gate encountered ${String(unexpectedSkipCount)} unexpected skipped test(s). Exclude intentional database suites through unit-only discovery instead of runtime skips.`,
    );
  }
  const seconds = ((Date.now() - started) / 1_000).toFixed(1);
  const failed = results.filter((result) => result.exitCode !== 0);
  console.info(
    `\nSuite finished in ${seconds}s — ${String(shards.length - failed.length)}/${String(shards.length)} shards green.`,
  );
  return failed.length === 0 && unexpectedSkipCount === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runTestSuite(Bun.argv.slice(2));
}
