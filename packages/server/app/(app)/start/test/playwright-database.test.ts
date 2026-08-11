import { describe, expect, test } from 'bun:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import postgres from 'postgres';

import {
  dropStartFlowPlaywrightDatabase,
  recreateStartFlowPlaywrightDatabase,
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
    'tearing down one concurrent run leaves the other database intact',
    async () => {
      const runA = createStartFlowPlaywrightRunId();
      const runB = createStartFlowPlaywrightRunId();
      let sqlA: postgres.Sql | undefined;
      let sqlB: postgres.Sql | undefined;
      try {
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
        await dropStartFlowPlaywrightDatabase(
          process.env.TEST_DATABASE_URL,
          runA,
        );
        const [marker] = await sqlB<{ value: string }[]>`
          select value from run_marker
        `;
        expect(marker?.value).toBe('run-b');
      } finally {
        await Promise.allSettled([sqlA?.end(), sqlB?.end()]);
        await Promise.allSettled([
          dropStartFlowPlaywrightDatabase(process.env.TEST_DATABASE_URL, runA),
          dropStartFlowPlaywrightDatabase(process.env.TEST_DATABASE_URL, runB),
        ]);
      }
    },
    30_000,
  );
});
