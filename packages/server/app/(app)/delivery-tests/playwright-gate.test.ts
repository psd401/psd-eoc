import { describe, expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV,
  START_FLOW_PLAYWRIGHT_RUN_ID_ENV,
  createStartFlowPlaywrightRunId,
  startFlowPlaywrightPaths,
} from '../start/test/playwright-run';

const playwrightConfig = fileURLToPath(
  new URL('./playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
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

describe('delivery-test Playwright and axe gate', () => {
  test('CI cannot silently skip the protected browser path', () => {
    if (process.env.CI === 'true') {
      expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    }
  });

  test('discovers both protected browser states and cleans run artifacts', async () => {
    const runId = createStartFlowPlaywrightRunId();
    const paths = startFlowPlaywrightPaths(runId);
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
        `Delivery-test Playwright discovery failed.\n${stdout}\n${stderr}`,
      );
    }
    expect(stdout).toContain('2 tests in 1 file');
    await expect(access(paths.root)).rejects.toThrow();
  });

  testWithDatabase(
    'runs keyboard and axe checks against an isolated synthetic database',
    async () => {
      const runId = createStartFlowPlaywrightRunId();
      const paths = startFlowPlaywrightPaths(runId);
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
          `Delivery-test Playwright gate failed.\n${stdout}\n${stderr}`,
        );
      }
      expect(exitCode).toBe(0);
      await expect(access(paths.root)).rejects.toThrow();
    },
    300_000,
  );
});
