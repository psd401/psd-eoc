import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dropOwnedEventTypePlaywrightDatabase } from './playwright-database';
import {
  cleanupEventTypePlaywrightRunAfterChildExit,
  inspectEventTypePlaywrightPortLease,
  requireEventTypePlaywrightRunContext,
  resolveEventTypePlaywrightRunContext,
} from './playwright-run';
import { requireSyntheticTestDatabaseUrl } from './test-database';

const playwrightConfig = fileURLToPath(
  new URL('./playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
const PLAYWRIGHT_CHILD_TIMEOUT_MS = 10 * 60_000;
const PLAYWRIGHT_CHILD_TERMINATION_GRACE_MS = 15_000;
const PLAYWRIGHT_OUTPUT_DRAIN_TIMEOUT_MS = 15_000;
const BROWSER_GATE_CLEANUP_BACKSTOP_MS = 2 * 60_000;
const BROWSER_GATE_TIMEOUT_MS =
  PLAYWRIGHT_CHILD_TIMEOUT_MS +
  PLAYWRIGHT_CHILD_TERMINATION_GRACE_MS +
  PLAYWRIGHT_OUTPUT_DRAIN_TIMEOUT_MS +
  BROWSER_GATE_CLEANUP_BACKSTOP_MS;

interface PlaywrightChildCompletion {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputErrors: readonly string[];
}

interface ChildOutputResult {
  readonly text: string;
  readonly error: string | null;
}

interface ChildOutputCapture {
  readonly completion: Promise<ChildOutputResult>;
  cancel(reason: string): Promise<void>;
}

function captureChildOutput(
  stream: ReadableStream<Uint8Array>,
  label: 'stdout' | 'stderr',
): ChildOutputCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cancellationError: string | null = null;
  const completion = (async (): Promise<ChildOutputResult> => {
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return { text, error: cancellationError };
    } catch (error) {
      return {
        text,
        error: `${label} capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    completion,
    async cancel(reason) {
      cancellationError = `${label} capture canceled: ${reason}`;
      await reader.cancel(reason);
    },
  };
}

async function drainChildOutput(
  captures: readonly [ChildOutputCapture, ChildOutputCapture],
): Promise<readonly [ChildOutputResult, ChildOutputResult]> {
  const completion = Promise.all([
    captures[0].completion,
    captures[1].completion,
  ]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    completion.then((results) => ({ kind: 'complete' as const, results })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => {
      deadline = setTimeout(
        () => resolve({ kind: 'timeout' }),
        PLAYWRIGHT_OUTPUT_DRAIN_TIMEOUT_MS,
      );
    }),
  ]);
  if (deadline !== undefined) clearTimeout(deadline);
  if (outcome.kind === 'complete') return outcome.results;

  const reason = `pipe remained open ${PLAYWRIGHT_OUTPUT_DRAIN_TIMEOUT_MS} ms after child exit`;
  await Promise.allSettled(captures.map((capture) => capture.cancel(reason)));
  return completion;
}

async function runPlaywright(
  childEnvironment: NodeJS.ProcessEnv,
): Promise<PlaywrightChildCompletion> {
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
    captureChildOutput(child.stdout, 'stdout'),
    captureChildOutput(child.stderr, 'stderr'),
  ] as const;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number;
  let waitError: Error | null = null;
  try {
    exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(
            new Error(
              `Event-type Playwright child exceeded ${PLAYWRIGHT_CHILD_TIMEOUT_MS} ms.`,
            ),
          );
        }, PLAYWRIGHT_CHILD_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    waitError = error instanceof Error ? error : new Error(String(error));
    if (child.exitCode === null) child.kill('SIGTERM');
    let forcedTermination: ReturnType<typeof setTimeout> | undefined;
    if (child.exitCode === null) {
      forcedTermination = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, PLAYWRIGHT_CHILD_TERMINATION_GRACE_MS);
    }
    try {
      exitCode = await child.exited;
    } finally {
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
    }
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }

  const [stdout, stderr] = await drainChildOutput(captures);
  const outputErrors = [stdout.error, stderr.error].filter(
    (error): error is string => error !== null,
  );
  if (waitError !== null) {
    throw new Error(
      `${waitError.message}\n` +
        `Playwright child exited ${exitCode} after termination.\n` +
        `${stdout.text}\n${stderr.text}\n${outputErrors.join('\n')}`,
      { cause: waitError },
    );
  }
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    outputErrors,
  };
}

async function cleanExactGateRun(contextValue: unknown): Promise<void> {
  const context = requireEventTypePlaywrightRunContext(contextValue);
  try {
    await cleanupEventTypePlaywrightRunAfterChildExit(context);
  } catch (error) {
    throw new Error(
      'Event-type Playwright gate refused database cleanup before proving its server stopped.',
      { cause: error },
    );
  }
  try {
    await dropOwnedEventTypePlaywrightDatabase(context);
  } catch (error) {
    throw new Error('Event-type Playwright gate database cleanup failed.', {
      cause: error,
    });
  }
}

describe('event-type Playwright gate', () => {
  test('CI cannot silently skip browser accessibility and recovery coverage', () => {
    if (process.env.CI === 'true') {
      expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    }
  });

  const setupFailureName =
    'cleans the exact database and artifacts after global setup fails';
  const runSetupFailure = async (): Promise<void> => {
    const baseDatabaseUrl = requireSyntheticTestDatabaseUrl(
      process.env.TEST_DATABASE_URL,
    );
    const childEnvironment = { ...process.env };
    const context = resolveEventTypePlaywrightRunContext(
      baseDatabaseUrl,
      childEnvironment,
    );
    childEnvironment.PSD_EOC_EVENT_TYPE_PLAYWRIGHT_SETUP_FAILURE_RUN_ID =
      context.runId;
    try {
      const { exitCode, stdout, stderr, outputErrors } =
        await runPlaywright(childEnvironment);
      expect(exitCode).not.toBe(0);
      expect(`${stdout}\n${stderr}`).toContain(
        'Synthetic event-type Playwright setup failure after database creation.',
      );
      expect(outputErrors).toEqual([]);
      expect(existsSync(context.runDirectory)).toBe(false);
      expect(inspectEventTypePlaywrightPortLease(context)).toBe('absent');
      expect(await dropOwnedEventTypePlaywrightDatabase(context)).toBe(false);
    } finally {
      await cleanExactGateRun(context);
    }
  };
  if (process.env.TEST_DATABASE_URL === undefined) {
    test.skip(setupFailureName, runSetupFailure, BROWSER_GATE_TIMEOUT_MS);
  } else {
    test(setupFailureName, runSetupFailure, BROWSER_GATE_TIMEOUT_MS);
  }

  const browserGateName =
    'runs the owned browser suite in an isolated synthetic database';
  const runBrowserGate = async (): Promise<void> => {
    const baseDatabaseUrl = requireSyntheticTestDatabaseUrl(
      process.env.TEST_DATABASE_URL,
    );
    const childEnvironment = { ...process.env };
    const context = resolveEventTypePlaywrightRunContext(
      baseDatabaseUrl,
      childEnvironment,
    );
    try {
      const { exitCode, stdout, stderr, outputErrors } =
        await runPlaywright(childEnvironment);
      const failures: string[] = [];
      if (existsSync(context.runDirectory)) {
        failures.push(
          `validated run directory remained after child exit: ${context.runDirectory}`,
        );
      }
      if (inspectEventTypePlaywrightPortLease(context) === 'owned') {
        failures.push(
          `validated port lease remained after child exit: ${context.portLeasePath}`,
        );
      }
      if (exitCode !== 0) {
        failures.push(
          `browser suite exited ${exitCode}.\n${stdout}\n${stderr}`,
        );
      }
      failures.push(...outputErrors);
      if (failures.length > 0) {
        throw new Error(
          `Event-type Playwright gate failed.\n${failures.join('\n')}`,
        );
      }
      expect(exitCode).toBe(0);
    } finally {
      await cleanExactGateRun(context);
    }
  };
  if (process.env.TEST_DATABASE_URL === undefined) {
    test.skip(browserGateName, runBrowserGate, BROWSER_GATE_TIMEOUT_MS);
  } else {
    test(browserGateName, runBrowserGate, BROWSER_GATE_TIMEOUT_MS);
  }
});
