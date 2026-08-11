import { describe, expect, test } from 'bun:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV,
  START_FLOW_PLAYWRIGHT_RUN_ID_ENV,
  createStartFlowPlaywrightRunId,
  removeStartFlowPlaywrightArtifacts,
  startFlowPlaywrightPaths,
} from './playwright-run';

const playwrightConfig = fileURLToPath(
  new URL('../playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);
const testWithDatabase =
  process.env.TEST_DATABASE_URL === undefined ? test.skip : test;
const SYNTHETIC_CONFIG_ONLY_DATABASE_URL =
  'postgresql://synthetic:synthetic-only@127.0.0.1:5432/shared_test';

function coordinatorEnvironment(runId: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_DATABASE_URL: SYNTHETIC_CONFIG_ONLY_DATABASE_URL,
    [START_FLOW_PLAYWRIGHT_RUN_ID_ENV]: runId,
  };
  delete environment[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV];
  delete environment.TEST_PARALLEL_INDEX;
  delete environment.TEST_WORKER_INDEX;
  return environment;
}

describe('start-flow Playwright gate', () => {
  test('CI cannot silently skip browser and axe coverage', () => {
    if (process.env.CI === 'true') {
      expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    }
  });

  test('config refuses an unowned run root before Playwright can clear output', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const runPaths = startFlowPlaywrightPaths(runId);
    const sentinel = `${runPaths.output}/unowned.txt`;
    await mkdir(runPaths.output, { recursive: true, mode: 0o700 });
    await writeFile(sentinel, 'retain\n', { mode: 0o600 });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          'x',
          'playwright',
          'test',
          '--list',
          '--config',
          playwrightConfig,
        ],
        {
          cwd: workspaceRoot,
          env: coordinatorEnvironment(runId),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('EEXIST');
      await access(sentinel);
    } finally {
      await writeFile(runPaths.owner, `${runId}\n`, { mode: 0o600 });
      await removeStartFlowPlaywrightArtifacts(runId);
    }
  });

  test('config rejects a spoofed worker without a coordinator artifact claim', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const runPaths = startFlowPlaywrightPaths(runId);
    const environment = coordinatorEnvironment(runId);
    environment.TEST_WORKER_INDEX = '0';
    environment.TEST_PARALLEL_INDEX = '0';
    const child = Bun.spawn(
      [
        process.execPath,
        'x',
        'playwright',
        'test',
        '--list',
        '--config',
        playwrightConfig,
      ],
      {
        cwd: workspaceRoot,
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('no matching artifact claim');
    await expect(access(runPaths.root)).rejects.toThrow();
  });

  test('config rejects reporter overrides that could suppress cleanup', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const runPaths = startFlowPlaywrightPaths(runId);
    const child = Bun.spawn(
      [
        process.execPath,
        'x',
        'playwright',
        'test',
        '--list',
        '--reporter=line',
        '--config',
        playwrightConfig,
      ],
      {
        cwd: workspaceRoot,
        env: coordinatorEnvironment(runId),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('does not permit reporter');
    await expect(access(runPaths.root)).rejects.toThrow();
  });

  test('list discovery needs no generated fixture and leaves no run artifacts', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const runPaths = startFlowPlaywrightPaths(runId);
    const child = Bun.spawn(
      [
        process.execPath,
        'x',
        'playwright',
        'test',
        '--list',
        '--config',
        playwrightConfig,
      ],
      {
        cwd: workspaceRoot,
        env: coordinatorEnvironment(runId),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Start-flow Playwright discovery failed.\n${stdout}\n${stderr}`,
      );
    }
    expect(stdout).toContain('19 tests in 1 file');
    await expect(access(runPaths.root)).rejects.toThrow();
  });

  testWithDatabase(
    'runs the owned browser suite against a synthetic database',
    async () => {
      const runId = createStartFlowPlaywrightRunId();
      const runPaths = startFlowPlaywrightPaths(runId);
      const child = Bun.spawn(
        [
          process.execPath,
          'x',
          'playwright',
          'test',
          '--config',
          playwrightConfig,
        ],
        {
          cwd: workspaceRoot,
          env: {
            ...coordinatorEnvironment(runId),
            TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `Start-flow Playwright gate failed.\n${stdout}\n${stderr}`,
        );
      }
      expect(exitCode).toBe(0);
      await expect(access(runPaths.root)).rejects.toThrow();
    },
    300_000,
  );
});
