import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const playwrightConfig = fileURLToPath(
  new URL('./playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
const testWithDatabase =
  process.env.TEST_DATABASE_URL === undefined ? test.skip : test;

describe('issue #26 administration Playwright gate', () => {
  test('CI cannot silently skip the owned browser coverage', () => {
    if (process.env.CI === 'true') {
      expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    }
  });

  testWithDatabase(
    'runs keyboard, semantic, safety, and axe checks with a synthetic database',
    async () => {
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
          env: process.env,
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
          `Issue #26 Playwright gate failed.\n${stdout}\n${stderr}`,
        );
      }
      expect(exitCode).toBe(0);
    },
    300_000,
  );
});
