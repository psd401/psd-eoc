import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { dropOwnedEventRoomPlaywrightDatabase } from './playwright-database';
import {
  cleanupEventRoomPlaywrightRunAfterChildExit,
  inspectEventRoomPlaywrightPortLease,
  releaseEventRoomPlaywrightPortLeaseIfOwned,
  requireSyntheticEventRoomTestDatabaseUrl,
  resolveEventRoomPlaywrightRunContext,
  type EventRoomPlaywrightRunContext,
} from './test-database';

const playwrightConfig = fileURLToPath(
  new URL('./playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);
const PLAYWRIGHT_CHILD_TIMEOUT_MS = 30 * 60_000;
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

interface PlaywrightChildControl {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal: NodeJS.Signals): void;
}

interface ChildWaitLimits {
  readonly childTimeoutMs: number;
  readonly terminationGraceMs: number;
  readonly outputDrainTimeoutMs: number;
}

interface ChildOutputResult {
  readonly text: string;
  readonly error: string | null;
}

interface ChildOutputCapture {
  readonly completion: Promise<ChildOutputResult>;
  cancel(reason: string): Promise<void>;
}

interface BrowserShard {
  readonly label: string;
  readonly cliArguments: readonly string[];
  readonly startDelayMs: number;
}

interface ExactGateCleanupOperations {
  stopServerAndRemoveRun(context: EventRoomPlaywrightRunContext): Promise<void>;
  dropDatabase(context: EventRoomPlaywrightRunContext): Promise<unknown>;
}

const DEFAULT_CHILD_WAIT_LIMITS: ChildWaitLimits = Object.freeze({
  childTimeoutMs: PLAYWRIGHT_CHILD_TIMEOUT_MS,
  terminationGraceMs: PLAYWRIGHT_CHILD_TERMINATION_GRACE_MS,
  outputDrainTimeoutMs: PLAYWRIGHT_OUTPUT_DRAIN_TIMEOUT_MS,
});
const BROWSER_SHARDS: readonly BrowserShard[] = Object.freeze([
  Object.freeze({
    label: 'shard 1/2',
    cliArguments: Object.freeze(['--fully-parallel', '--shard=1/2']),
    startDelayMs: 0,
  }),
  Object.freeze({
    label: 'shard 2/2',
    cliArguments: Object.freeze(['--fully-parallel', '--shard=2/2']),
    startDelayMs: 60_000,
  }),
]);

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
  timeoutMs: number,
): Promise<readonly [ChildOutputResult, ChildOutputResult]> {
  const completion = Promise.all([
    captures[0].completion,
    captures[1].completion,
  ]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    completion.then((results) => ({ kind: 'complete' as const, results })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => {
      deadline = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    }),
  ]);
  if (deadline !== undefined) clearTimeout(deadline);
  if (outcome.kind === 'complete') return outcome.results;

  const reason = `pipe remained open ${timeoutMs} ms after child exit`;
  await Promise.allSettled(captures.map((capture) => capture.cancel(reason)));
  return completion;
}

async function waitForPlaywrightChild(
  child: PlaywrightChildControl,
  limits: ChildWaitLimits = DEFAULT_CHILD_WAIT_LIMITS,
): Promise<PlaywrightChildCompletion> {
  const captures = [
    captureChildOutput(child.stdout, 'stdout'),
    captureChildOutput(child.stderr, 'stderr'),
  ] as const;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number;
  let childWaitError: Error | null = null;
  try {
    exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(
            new Error(
              `Event-room Playwright child exceeded ${limits.childTimeoutMs} ms.`,
            ),
          );
        }, limits.childTimeoutMs);
      }),
    ]);
  } catch (error) {
    childWaitError = error instanceof Error ? error : new Error(String(error));
    if (child.exitCode === null) child.kill('SIGTERM');
    let forcedTermination: ReturnType<typeof setTimeout> | undefined;
    if (child.exitCode === null) {
      forcedTermination = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, limits.terminationGraceMs);
    }
    try {
      // Keep forced termination armed until the exact owned child exits. Pipe
      // capture is deliberately non-rejecting and cannot cancel this wait.
      exitCode = await child.exited;
    } catch (terminationError) {
      throw new AggregateError(
        [childWaitError, terminationError],
        'Event-room Playwright child failed and could not be cleanly awaited.',
      );
    } finally {
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
    }
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
  const [stdout, stderr] = await drainChildOutput(
    captures,
    limits.outputDrainTimeoutMs,
  );
  const outputErrors = [stdout.error, stderr.error].filter(
    (outputError): outputError is string => outputError !== null,
  );
  if (childWaitError !== null) {
    throw new Error(
      `${childWaitError.message}\n` +
        `Playwright child exited ${exitCode} after termination.\n` +
        `${stdout.text}\n${stderr.text}\n${outputErrors.join('\n')}`,
      { cause: childWaitError },
    );
  }
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    outputErrors,
  };
}

async function cleanExactGateRun(
  context: EventRoomPlaywrightRunContext,
  operations: ExactGateCleanupOperations = {
    stopServerAndRemoveRun: cleanupEventRoomPlaywrightRunAfterChildExit,
    dropDatabase: dropOwnedEventRoomPlaywrightDatabase,
  },
): Promise<void> {
  try {
    await operations.stopServerAndRemoveRun(context);
  } catch (error) {
    throw new Error(
      'Event-room Playwright gate refused database cleanup before proving its server stopped.',
      { cause: error },
    );
  }
  try {
    await operations.dropDatabase(context);
  } catch (error) {
    throw new Error('Event-room Playwright gate database cleanup failed.', {
      cause: error,
    });
  }
}

async function runBrowserShard(
  baseDatabaseUrl: string,
  shard: BrowserShard,
): Promise<void> {
  if (shard.startDelayMs > 0) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, shard.startDelayMs),
    );
  }
  const childEnvironment = { ...process.env };
  const context = resolveEventRoomPlaywrightRunContext(
    baseDatabaseUrl,
    childEnvironment,
  );
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        'x',
        'playwright',
        'test',
        '--config',
        playwrightConfig,
        ...shard.cliArguments,
      ],
      {
        cwd: workspaceRoot,
        env: childEnvironment,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const { exitCode, stdout, stderr, outputErrors } =
      await waitForPlaywrightChild(child);
    const failures: string[] = [];
    if (existsSync(context.runDirectory)) {
      failures.push(
        `validated run directory remained after child exit: ${context.runDirectory}`,
      );
    }
    if (inspectEventRoomPlaywrightPortLease(context) === 'owned') {
      failures.push(
        `validated port lease remained after child exit: ${context.portLeasePath}`,
      );
    }
    if (exitCode !== 0) {
      failures.push(
        `${shard.label} browser suite exited ${exitCode}.\n${stdout}\n${stderr}`,
      );
    }
    failures.push(...outputErrors);
    if (failures.length > 0) {
      throw new Error(
        `Event-room Playwright ${shard.label} failed.\n${failures.join('\n')}`,
      );
    }
  } finally {
    await cleanExactGateRun(context);
  }
}

describe('event-room Playwright gate', () => {
  test('pins a licensed repository-local axe asset with no network loader', async () => {
    const [storedBytes, license, suite] = await Promise.all([
      readFile(new URL('./axe-core-4.10.3.min.js.txt', import.meta.url)),
      readFile(new URL('./axe-core-4.10.3.LICENSE', import.meta.url), 'utf8'),
      readFile(new URL('./event-room.playwright.ts', import.meta.url), 'utf8'),
    ]);
    const bytes =
      storedBytes.at(-1) === 0x0a
        ? storedBytes.subarray(0, storedBytes.length - 1)
        : storedBytes;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb',
    );
    expect(license).toContain('Mozilla Public License, version 2.0');
    expect(suite).not.toContain('cdn.jsdelivr.net');
    expect(suite).not.toContain('unpkg.com');
  });

  test('CI cannot silently skip event-room browser accessibility and safety coverage', () => {
    if (process.env.CI === 'true') {
      expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    }
    expect(BROWSER_SHARDS.map((shard) => shard.cliArguments)).toEqual([
      ['--fully-parallel', '--shard=1/2'],
      ['--fully-parallel', '--shard=2/2'],
    ]);
    expect(BROWSER_SHARDS.map((shard) => shard.startDelayMs)).toEqual([
      0, 60_000,
    ]);
  });

  test('cleanup proves server stop before database removal and fails closed on stop-proof failure', async () => {
    const context = resolveEventRoomPlaywrightRunContext(
      'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test',
      { NODE_ENV: 'test' },
    );
    try {
      const order: string[] = [];
      await cleanExactGateRun(context, {
        async stopServerAndRemoveRun(received) {
          expect(received).toBe(context);
          order.push('server-stopped');
        },
        async dropDatabase(received) {
          expect(received).toBe(context);
          order.push('database-dropped');
        },
      });
      expect(order).toEqual(['server-stopped', 'database-dropped']);

      order.length = 0;
      await expect(
        cleanExactGateRun(context, {
          async stopServerAndRemoveRun() {
            order.push('stop-proof-failed');
            throw new Error('synthetic server still running');
          },
          async dropDatabase() {
            order.push('database-dropped');
          },
        }),
      ).rejects.toThrow(
        'refused database cleanup before proving its server stopped',
      );
      expect(order).toEqual(['stop-proof-failed']);
    } finally {
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('output capture failure cannot resolve before the exact child exits', async () => {
    let resolveExit: (exitCode: number) => void = () => undefined;
    let exitCode: number | null = null;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals: NodeJS.Signals[] = [];
    const child: PlaywrightChildControl = {
      get exitCode() {
        return exitCode;
      },
      exited,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('synthetic stdout read failure'));
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      kill(signal) {
        signals.push(signal);
      },
    };
    let settled = false;
    const completion = waitForPlaywrightChild(child).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    exitCode = 0;
    resolveExit(0);

    const result = await completion;
    expect(result.exitCode).toBe(0);
    expect(result.outputErrors).toEqual([
      'stdout capture failed: synthetic stdout read failure',
    ]);
    expect(signals).toEqual([]);
  });

  test('an already-exited child starts the bounded output drain immediately', async () => {
    let canceled = false;
    const signals: NodeJS.Signals[] = [];
    const child: PlaywrightChildControl = {
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      kill(signal) {
        signals.push(signal);
      },
    };

    const result = await waitForPlaywrightChild(child, {
      childTimeoutMs: 1_000,
      terminationGraceMs: 100,
      outputDrainTimeoutMs: 20,
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputErrors).toEqual([
      'stdout capture canceled: pipe remained open 20 ms after child exit',
    ]);
    expect(canceled).toBe(true);
    expect(signals).toEqual([]);
  });

  test('a descendant-held output pipe is bounded and canceled only after child exit', async () => {
    let resolveExit: (exitCode: number) => void = () => undefined;
    let exitCode: number | null = null;
    let exitedBeforeCancel = false;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals: NodeJS.Signals[] = [];
    const child: PlaywrightChildControl = {
      get exitCode() {
        return exitCode;
      },
      exited,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial output'));
        },
        cancel() {
          exitedBeforeCancel = exitCode !== null;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      kill(signal) {
        signals.push(signal);
        if (signal === 'SIGTERM') {
          exitCode = 143;
          resolveExit(143);
        }
      },
    };

    await expect(
      waitForPlaywrightChild(child, {
        childTimeoutMs: 20,
        terminationGraceMs: 100,
        outputDrainTimeoutMs: 20,
      }),
    ).rejects.toThrow(
      'stdout capture canceled: pipe remained open 20 ms after child exit',
    );
    expect(exitedBeforeCancel).toBe(true);
    expect(signals).toEqual(['SIGTERM']);
  });

  const setupFailureGateName =
    'drops the owned database only after setup-failure server shutdown';
  const runSetupFailureGate = async (): Promise<void> => {
    const baseDatabaseUrl = requireSyntheticEventRoomTestDatabaseUrl(
      process.env.TEST_DATABASE_URL,
    );
    const childEnvironment = { ...process.env };
    const context = resolveEventRoomPlaywrightRunContext(
      baseDatabaseUrl,
      childEnvironment,
    );
    childEnvironment.PSD_EOC_EVENT_ROOM_PLAYWRIGHT_SETUP_FAILURE_RUN_ID =
      context.runId;
    try {
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
          env: childEnvironment,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const { exitCode, stdout, stderr, outputErrors } =
        await waitForPlaywrightChild(child);
      expect(exitCode).not.toBe(0);
      expect(`${stdout}\n${stderr}`).toContain(
        'Synthetic event-room Playwright setup failure after database creation.',
      );
      expect(outputErrors).toEqual([]);
      expect(existsSync(context.runDirectory)).toBe(false);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('absent');
      expect(await dropOwnedEventRoomPlaywrightDatabase(context)).toBe(false);
    } finally {
      await cleanExactGateRun(context);
    }
  };
  if (process.env.TEST_DATABASE_URL === undefined) {
    test.skip(
      setupFailureGateName,
      runSetupFailureGate,
      BROWSER_GATE_TIMEOUT_MS,
    );
  } else {
    test(setupFailureGateName, runSetupFailureGate, BROWSER_GATE_TIMEOUT_MS);
  }

  const browserGateName =
    'runs the owned browser suite when the synthetic database is configured';
  const runBrowserGate = async (): Promise<void> => {
    const baseDatabaseUrl = requireSyntheticEventRoomTestDatabaseUrl(
      process.env.TEST_DATABASE_URL,
    );
    const results = await Promise.allSettled(
      BROWSER_SHARDS.map((shard) => runBrowserShard(baseDatabaseUrl, shard)),
    );
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            `${BROWSER_SHARDS[index]?.label ?? `shard ${index + 1}`}: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }`,
          ]
        : [],
    );
    if (failures.length > 0) {
      throw new Error(
        `Event-room Playwright gate failed after both isolated shards completed.\n${failures.join('\n')}`,
      );
    }
    expect(results).toHaveLength(2);
  };
  if (process.env.TEST_DATABASE_URL === undefined) {
    test.skip(browserGateName, runBrowserGate, BROWSER_GATE_TIMEOUT_MS);
  } else {
    test(browserGateName, runBrowserGate, BROWSER_GATE_TIMEOUT_MS);
  }
});
