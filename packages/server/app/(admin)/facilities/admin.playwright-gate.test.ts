import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { dropOwnedAdminPlaywrightDatabase } from './playwright-database';
import { executeOperationWithCleanup } from './owned-database-lifecycle';
import {
  cleanupAdminPlaywrightRunArtifacts,
  requireAdminPlaywrightRunContext,
  resolveAdminPlaywrightRunContext,
  waitForAdminPlaywrightPortToClose,
  type AdminPlaywrightRunContext,
} from './playwright-run';
import { requireSyntheticTestDatabaseUrl } from '../event-types/test-database';

const playwrightConfig = fileURLToPath(
  new URL('./playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
const PLAYWRIGHT_TIMEOUT_MS = 5 * 60_000;
const TERMINATION_GRACE_MS = 15_000;
const OUTPUT_DRAIN_TIMEOUT_MS = 15_000;
const GATE_TIMEOUT_MS =
  PLAYWRIGHT_TIMEOUT_MS +
  TERMINATION_GRACE_MS +
  OUTPUT_DRAIN_TIMEOUT_MS +
  60_000;
const testWithDatabase =
  process.env.TEST_DATABASE_URL === undefined ? test.skip : test;

interface ChildOutputCapture {
  readonly completion: Promise<string>;
  cancel(reason: string): Promise<void>;
}

function captureChildOutput(
  stream: ReadableStream<Uint8Array>,
): ChildOutputCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const completion = (async () => {
    let output = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      return output + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    completion,
    async cancel(reason) {
      await reader.cancel(reason);
    },
  };
}

async function drainChildOutput(
  captures: readonly [ChildOutputCapture, ChildOutputCapture],
): Promise<readonly [string, string]> {
  const completion = Promise.all([
    captures[0].completion,
    captures[1].completion,
  ]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    completion.then((output) => ({ kind: 'complete' as const, output })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => {
      deadline = setTimeout(
        () => resolve({ kind: 'timeout' }),
        OUTPUT_DRAIN_TIMEOUT_MS,
      );
    }),
  ]);
  if (deadline !== undefined) clearTimeout(deadline);
  if (result.kind === 'complete') return result.output;
  await Promise.allSettled(
    captures.map((capture) =>
      capture.cancel('Playwright child output remained open after exit.'),
    ),
  );
  throw new Error(
    'Issue #26 Playwright output remained open after the child exited.',
  );
}

async function runPlaywright(
  childEnvironment: NodeJS.ProcessEnv,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn(
    [process.execPath, 'x', 'playwright', 'test', '--config', playwrightConfig],
    {
      cwd: workspaceRoot,
      env: childEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const captures = [
    captureChildOutput(child.stdout),
    captureChildOutput(child.stderr),
  ] as const;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ kind: 'exit' as const, exitCode })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => {
      timeout = setTimeout(
        () => resolve({ kind: 'timeout' }),
        PLAYWRIGHT_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  let exitCode: number;
  if (outcome.kind === 'exit') {
    exitCode = outcome.exitCode;
  } else {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
    try {
      exitCode = await child.exited;
    } finally {
      clearTimeout(force);
    }
  }
  const [stdout, stderr] = await drainChildOutput(captures);
  if (outcome.kind === 'timeout') {
    throw new Error(
      `Issue #26 Playwright child timed out and exited ${exitCode}.\n${stdout}\n${stderr}`,
    );
  }
  return { exitCode, stdout, stderr };
}

async function cleanupExactRun(
  context: AdminPlaywrightRunContext,
): Promise<void> {
  const validated = requireAdminPlaywrightRunContext(context);
  await waitForAdminPlaywrightPortToClose(validated.appPort);
  await dropOwnedAdminPlaywrightDatabase(validated);
  cleanupAdminPlaywrightRunArtifacts(validated);
}

describe('issue #26 administration Playwright gate', () => {
  test('CI cannot silently skip the owned browser coverage', () => {
    if (process.env.CI === 'true') {
      expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    }
  });

  testWithDatabase(
    'runs keyboard, semantic, safety, and axe checks in an isolated synthetic database',
    async () => {
      const baseDatabaseUrl = requireSyntheticTestDatabaseUrl(
        process.env.TEST_DATABASE_URL,
      );
      const childEnvironment = { ...process.env };
      const context = resolveAdminPlaywrightRunContext(
        baseDatabaseUrl,
        childEnvironment,
      );
      await executeOperationWithCleanup({
        operation: async () => {
          await waitForAdminPlaywrightPortToClose(context.appPort);
          const { exitCode, stdout, stderr } =
            await runPlaywright(childEnvironment);
          if (exitCode !== 0) {
            throw new Error(
              `Issue #26 Playwright gate failed.\n${stdout}\n${stderr}`,
            );
          }
          expect(exitCode).toBe(0);
        },
        cleanup: () => cleanupExactRun(context),
        failureMessage:
          'Issue #26 Playwright run and exact cleanup both failed.',
      });
    },
    GATE_TIMEOUT_MS,
  );
});
