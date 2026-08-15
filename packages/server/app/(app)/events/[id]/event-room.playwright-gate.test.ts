import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  createOwnedEventRoomPlaywrightDatabase,
  dropOwnedEventRoomPlaywrightDatabase,
} from './playwright-database';
import {
  createEventRoomPlaywrightSupervisorEnvironment,
  EVENT_ROOM_PLAYWRIGHT_CWD_ENV,
  EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PAUSE_HEARTBEAT_ENV,
  EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_MODE_ENV,
  EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_NONCE_ENV,
} from './playwright.web-server';
import {
  cleanupEventRoomPlaywrightRunAfterChildExit,
  detectPriorEventRoomPlaywrightResidue,
  hasEventRoomPlaywrightSupervisorStoppingMarker,
  inspectEventRoomPlaywrightPortLease,
  releaseEventRoomPlaywrightPortLeaseIfOwned,
  requireSyntheticEventRoomTestDatabaseUrl,
  resolveEventRoomPlaywrightRunContext,
  writeEventRoomPlaywrightGateHeartbeat,
  type EventRoomPlaywrightRunContext,
} from './test-database';

const playwrightConfig = fileURLToPath(
  new URL('./playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);
const supervisorScript = fileURLToPath(
  new URL('./playwright.web-server.ts', import.meta.url),
);
const PLAYWRIGHT_CHILD_TIMEOUT_MS = 30 * 60_000;
const PLAYWRIGHT_CHILD_TERMINATION_GRACE_MS = 35_000;
const PLAYWRIGHT_OUTPUT_DRAIN_TIMEOUT_MS = 15_000;
const BROWSER_GATE_CLEANUP_BACKSTOP_MS = 2 * 60_000;
const BROWSER_GATE_TIMEOUT_MS =
  PLAYWRIGHT_CHILD_TIMEOUT_MS +
  PLAYWRIGHT_CHILD_TERMINATION_GRACE_MS +
  PLAYWRIGHT_CHILD_TERMINATION_GRACE_MS +
  PLAYWRIGHT_OUTPUT_DRAIN_TIMEOUT_MS +
  BROWSER_GATE_CLEANUP_BACKSTOP_MS;
const INTERRUPTED_PARENT_CLEANUP_TIMEOUT_MS = 30_000;

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

interface SupervisedPlaywrightChild {
  readonly child: PlaywrightChildControl;
  stopHeartbeat(): void;
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
  cancel(reason: string): ChildOutputResult;
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

function spawnSupervisedPlaywrightChild(
  context: EventRoomPlaywrightRunContext,
  childEnvironment: NodeJS.ProcessEnv,
  options: Readonly<{ synthetic?: boolean }> = {},
): SupervisedPlaywrightChild {
  const priorResidue = detectPriorEventRoomPlaywrightResidue(context);
  if (priorResidue.length > 0) {
    throw new Error(
      'A prior event-room Playwright run left marked supervision residue; refusing to adopt or clean it automatically: ' +
        priorResidue
          .map(({ runId, reason }) => `${runId} (${reason})`)
          .join(', '),
    );
  }
  const nonce = randomBytes(32).toString('hex');
  writeEventRoomPlaywrightGateHeartbeat(context, process.pid, nonce);
  const environment = createEventRoomPlaywrightSupervisorEnvironment(
    context,
    childEnvironment,
    nonce,
    process.pid,
    playwrightConfig,
    workspaceRoot,
  );
  if (options.synthetic === true) {
    environment.PSD_EOC_EVENT_ROOM_SYNTHETIC_COMMAND = 'true';
  }
  const child = Bun.spawn([process.execPath, supervisorScript], {
    cwd: workspaceRoot,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const heartbeat = setInterval(() => {
    if (
      hasEventRoomPlaywrightSupervisorStoppingMarker(context, child.pid, nonce)
    ) {
      clearInterval(heartbeat);
      return;
    }
    writeEventRoomPlaywrightGateHeartbeat(context, process.pid, nonce);
  }, 250);
  void child.exited.finally(() => clearInterval(heartbeat));
  const control: PlaywrightChildControl = {
    get exitCode() {
      return child.exitCode;
    },
    exited: child.exited,
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    kill(signal) {
      child.kill(signal);
    },
  };
  return {
    child: control,
    stopHeartbeat() {
      clearInterval(heartbeat);
    },
  };
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number = INTERRUPTED_PARENT_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await delay(25);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function processGroupMembers(
  processGroupId: number,
): Promise<readonly number[]> {
  const child = Bun.spawn(['/bin/ps', '-ww', '-axo', 'pid=,pgid=,stat='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Process-group inspection failed: ${stderr.trim()}`);
  }
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u))
    .filter(
      (match): match is RegExpMatchArray =>
        match !== null &&
        Number.parseInt(match[2]!, 10) === processGroupId &&
        !match[3]!.startsWith('Z'),
    )
    .map((match) => Number.parseInt(match[1]!, 10));
}

function loopbackPortIsOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const settle = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(250, () => settle(false));
  });
}

function captureChildOutput(
  stream: ReadableStream<Uint8Array>,
  label: 'stdout' | 'stderr',
): ChildOutputCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let cancellationError: string | null = null;
  let completedResult: ChildOutputResult | undefined;
  const completion = (async (): Promise<ChildOutputResult> => {
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
  })().then((result) => {
    // The resolved snapshot lets a mixed complete/stuck pair report only the
    // pipe that actually exceeded the drain deadline.
    completedResult = result;
    return result;
  });
  return {
    completion,
    cancel(reason) {
      if (completedResult !== undefined) return completedResult;
      cancellationError = `${label} capture canceled: ${reason}`;
      // A hostile or descendant-held stream may never settle cancellation.
      // Request it for resource release, but return the bounded evidence now
      // so exact run/database cleanup cannot be held behind that promise.
      try {
        void reader.cancel(reason).catch(() => undefined);
      } catch {
        // The bounded cancellation fact below remains the truthful outcome.
      }
      return { text, error: cancellationError };
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
  return [captures[0].cancel(reason), captures[1].cancel(reason)];
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
    let forcedTerminationDeadline: ReturnType<typeof setTimeout> | undefined;
    let forcedTerminationSent = false;
    if (child.exitCode === null) {
      forcedTermination = setTimeout(() => {
        if (child.exitCode === null) {
          forcedTerminationSent = true;
          child.kill('SIGKILL');
        }
      }, limits.terminationGraceMs);
    }
    let terminationOutcome:
      | Readonly<{ kind: 'exit'; exitCode: number }>
      | Readonly<{ kind: 'timeout' }>
      | undefined;
    let terminationFailure: unknown;
    try {
      terminationOutcome = await Promise.race([
        child.exited.then((code) => ({
          kind: 'exit' as const,
          exitCode: code,
        })),
        new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => {
          forcedTerminationDeadline = setTimeout(
            () => resolve({ kind: 'timeout' }),
            limits.terminationGraceMs * 2,
          );
        }),
      ]);
    } catch (terminationError) {
      terminationFailure = terminationError;
    } finally {
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
      if (forcedTerminationDeadline !== undefined) {
        clearTimeout(forcedTerminationDeadline);
      }
    }
    if (terminationFailure !== undefined) {
      throw new AggregateError(
        [childWaitError, terminationFailure],
        childWaitError.message,
      );
    }
    if (terminationOutcome?.kind !== 'exit') {
      if (child.exitCode === null && !forcedTerminationSent) {
        child.kill('SIGKILL');
      }
      throw new AggregateError(
        [
          childWaitError,
          new Error(
            `Event-room Playwright child exit remained unsettled ${limits.terminationGraceMs} ms after forced termination.`,
          ),
        ],
        childWaitError.message,
      );
    }
    exitCode = terminationOutcome.exitCode;
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

async function waitForPlaywrightChildAndClean(
  context: EventRoomPlaywrightRunContext,
  startChild: () => PlaywrightChildControl,
  limits: ChildWaitLimits = DEFAULT_CHILD_WAIT_LIMITS,
  cleanupOperations?: ExactGateCleanupOperations,
): Promise<PlaywrightChildCompletion> {
  let completion: PlaywrightChildCompletion | undefined;
  let primaryError: Error | null = null;
  try {
    completion = await waitForPlaywrightChild(startChild(), limits);
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  }

  let cleanupError: Error | null = null;
  try {
    await cleanExactGateRun(context, cleanupOperations);
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }
  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      primaryError.message,
    );
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
  if (completion === undefined) {
    throw new Error('The Playwright child completed without an outcome.');
  }
  return completion;
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

  test('a never-settling output cancellation cannot block exact cleanup', async () => {
    const context = resolveEventRoomPlaywrightRunContext(
      'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test',
      { NODE_ENV: 'test' },
    );
    let cancellationRequested = false;
    const signals: NodeJS.Signals[] = [];
    const child: PlaywrightChildControl = {
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial output'));
        },
        cancel() {
          cancellationRequested = true;
          return new Promise<void>(() => undefined);
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
    const cleanupOrder: string[] = [];

    try {
      const result = await Promise.race([
        waitForPlaywrightChildAndClean(
          context,
          () => child,
          {
            childTimeoutMs: 1_000,
            terminationGraceMs: 100,
            outputDrainTimeoutMs: 20,
          },
          {
            async stopServerAndRemoveRun() {
              cleanupOrder.push('run-cleaned');
            },
            async dropDatabase() {
              cleanupOrder.push('database-cleaned');
            },
          },
        ),
        delay(500).then(() => {
          throw new Error(
            'Never-settling output cancellation blocked cleanup.',
          );
        }),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.outputErrors).toEqual([
        'stdout capture canceled: pipe remained open 20 ms after child exit',
      ]);
      expect(cancellationRequested).toBe(true);
      expect(signals).toEqual([]);
      expect(cleanupOrder).toEqual(['run-cleaned', 'database-cleaned']);
    } finally {
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('a descendant-held output pipe is bounded and canceled only after child exit', async () => {
    const context = resolveEventRoomPlaywrightRunContext(
      'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test',
      { NODE_ENV: 'test' },
    );
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

    const cleanupOrder: string[] = [];
    try {
      await expect(
        waitForPlaywrightChildAndClean(
          context,
          () => child,
          {
            childTimeoutMs: 20,
            terminationGraceMs: 100,
            outputDrainTimeoutMs: 20,
          },
          {
            async stopServerAndRemoveRun() {
              cleanupOrder.push('run-cleaned');
            },
            async dropDatabase() {
              cleanupOrder.push('database-cleaned');
            },
          },
        ),
      ).rejects.toThrow(
        'stdout capture canceled: pipe remained open 20 ms after child exit',
      );
      expect(exitedBeforeCancel).toBe(true);
      expect(signals).toEqual(['SIGTERM']);
      expect(cleanupOrder).toEqual(['run-cleaned', 'database-cleaned']);
    } finally {
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('a never-settling child exit is bounded after forced termination and still cleans', async () => {
    const context = resolveEventRoomPlaywrightRunContext(
      'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test',
      { NODE_ENV: 'test' },
    );
    const signals: NodeJS.Signals[] = [];
    const child: PlaywrightChildControl = {
      exitCode: null,
      exited: new Promise<number>(() => undefined),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
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
    const cleanupOrder: string[] = [];
    let received: unknown;

    try {
      await Promise.race([
        waitForPlaywrightChildAndClean(
          context,
          () => child,
          {
            childTimeoutMs: 20,
            terminationGraceMs: 20,
            outputDrainTimeoutMs: 20,
          },
          {
            async stopServerAndRemoveRun() {
              cleanupOrder.push('run-cleaned');
            },
            async dropDatabase() {
              cleanupOrder.push('database-cleaned');
            },
          },
        ).catch((error) => {
          received = error;
        }),
        delay(500).then(() => {
          throw new Error('Never-settling child exit blocked cleanup.');
        }),
      ]);

      expect(received).toBeInstanceOf(AggregateError);
      const aggregate = received as AggregateError;
      expect(aggregate.message).toBe(
        'Event-room Playwright child exceeded 20 ms.',
      );
      expect((aggregate.errors[0] as Error).message).toBe(
        'Event-room Playwright child exceeded 20 ms.',
      );
      expect((aggregate.errors[1] as Error).message).toBe(
        'Event-room Playwright child exit remained unsettled 20 ms after forced termination.',
      );
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(cleanupOrder).toEqual(['run-cleaned', 'database-cleaned']);
    } finally {
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('spawn cleanup failure retains the original error first', async () => {
    const context = resolveEventRoomPlaywrightRunContext(
      'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test',
      { NODE_ENV: 'test' },
    );
    try {
      let received: unknown;
      try {
        await waitForPlaywrightChildAndClean(
          context,
          () => {
            throw new Error('synthetic primary spawn failure');
          },
          DEFAULT_CHILD_WAIT_LIMITS,
          {
            async stopServerAndRemoveRun() {
              throw new Error('synthetic secondary cleanup failure');
            },
            async dropDatabase() {
              throw new Error('must not run');
            },
          },
        );
      } catch (error) {
        received = error;
      }
      expect(received).toBeInstanceOf(AggregateError);
      const aggregate = received as AggregateError;
      expect(aggregate.message).toBe('synthetic primary spawn failure');
      expect((aggregate.errors[0] as Error).message).toBe(
        'synthetic primary spawn failure',
      );
      expect((aggregate.errors[1] as Error).message).toContain(
        'refused database cleanup',
      );
    } finally {
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  const interruptedParentGateName =
    'reaps the exact process tree and residue after parent SIGINT, SIGTERM, and SIGKILL';
  const runInterruptedParentGate = async (): Promise<void> => {
    const baseDatabaseUrl = requireSyntheticEventRoomTestDatabaseUrl(
      process.env.TEST_DATABASE_URL,
    );
    const expectedExitCodes = new Map<NodeJS.Signals, number>([
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGKILL', 137],
    ]);
    for (const signal of expectedExitCodes.keys()) {
      const childEnvironment = { ...process.env };
      const context = resolveEventRoomPlaywrightRunContext(
        baseDatabaseUrl,
        childEnvironment,
      );
      const nonce = randomBytes(32).toString('hex');
      let parent: ReturnType<typeof Bun.spawn> | undefined;
      let observedProcessIds: readonly number[] = [];
      try {
        await createOwnedEventRoomPlaywrightDatabase(context);
        childEnvironment[EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_MODE_ENV] =
          'true';
        childEnvironment[EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_NONCE_ENV] =
          nonce;
        childEnvironment[EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PAUSE_HEARTBEAT_ENV] =
          'true';
        childEnvironment[EVENT_ROOM_PLAYWRIGHT_CWD_ENV] = workspaceRoot;
        parent = Bun.spawn([process.execPath, supervisorScript], {
          cwd: workspaceRoot,
          env: childEnvironment,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const stdout = new Response(
          parent.stdout as ReadableStream<Uint8Array>,
        ).text();
        const stderr = new Response(
          parent.stderr as ReadableStream<Uint8Array>,
        ).text();
        const artifactPath = `${context.outputDirectory}/synthetic-browser-artifact`;
        const webServerReadyPath = `${context.outputDirectory}/synthetic-web-server-ready.json`;
        const heartbeatPausedPath = `${context.supervisionDirectory}/synthetic-parent-heartbeat-paused.json`;
        try {
          await waitUntil('the synthetic process tree to launch', async () => {
            return (
              existsSync(context.supervisorReadyPath) &&
              existsSync(artifactPath) &&
              existsSync(webServerReadyPath) &&
              (await loopbackPortIsOpen(context.appPort))
            );
          });
        } catch (error) {
          if (parent.exitCode === null) parent.kill('SIGKILL');
          await Promise.race([parent.exited, delay(5_000)]);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
              `${await Promise.race([stdout, delay(5_000).then(() => 'stdout drain timed out')])}\n` +
              `${await Promise.race([stderr, delay(5_000).then(() => 'stderr drain timed out')])}`,
            { cause: error },
          );
        }
        const ready = JSON.parse(
          readFileSync(context.supervisorReadyPath, 'utf8'),
        ) as {
          supervisorPid: number;
          coordinatorPid: number;
          processGroupId: number;
        };
        expect(ready.coordinatorPid).toBe(ready.processGroupId);
        const groupMembers = await processGroupMembers(ready.processGroupId);
        expect(groupMembers).toContain(ready.coordinatorPid);
        expect(groupMembers.length).toBeGreaterThanOrEqual(3);
        expect(groupMembers).toContain(
          Number.parseInt(readFileSync(artifactPath, 'utf8'), 10),
        );
        const webServerReady = JSON.parse(
          readFileSync(webServerReadyPath, 'utf8'),
        ) as {
          webServerPid: number;
          processGroupId: number;
          nextPid: number;
        };
        expect(webServerReady.webServerPid).toBe(webServerReady.processGroupId);
        const webServerGroupMembers = await processGroupMembers(
          webServerReady.processGroupId,
        );
        expect(webServerGroupMembers).toEqual(
          expect.arrayContaining([
            webServerReady.webServerPid,
            webServerReady.nextPid,
          ]),
        );
        observedProcessIds = [
          ready.supervisorPid,
          ...groupMembers,
          ...webServerGroupMembers,
        ];

        await waitUntil('the synthetic parent heartbeat to pause', () =>
          existsSync(heartbeatPausedPath),
        );
        await delay(2_500);
        expect(processExists(parent.pid)).toBe(true);
        expect(observedProcessIds.every((pid) => processExists(pid))).toBe(
          true,
        );
        expect(await loopbackPortIsOpen(context.appPort)).toBe(true);

        parent.kill(signal);
        const parentExit = await Promise.race([
          parent.exited,
          delay(5_000).then(() => {
            throw new Error(
              `Synthetic gate parent did not exit after ${signal}.`,
            );
          }),
        ]);
        expect(parentExit).toBe(expectedExitCodes.get(signal)!);

        await waitUntil('the exact interrupted process tree to exit', () =>
          observedProcessIds.every((pid) => !processExists(pid)),
        );
        await waitUntil(
          'the interrupted loopback port to close',
          async () => !(await loopbackPortIsOpen(context.appPort)),
        );
        expect(existsSync(context.runDirectory)).toBe(false);
        expect(existsSync(context.supervisionDirectory)).toBe(false);
        expect(existsSync(artifactPath)).toBe(false);
        expect(inspectEventRoomPlaywrightPortLease(context)).toBe('absent');
        expect(await dropOwnedEventRoomPlaywrightDatabase(context)).toBe(false);
        expect(await stdout).toBe('');
        expect(await stderr).toContain(
          'The event-room Playwright gate heartbeat stopped.',
        );
      } finally {
        if (parent !== undefined && parent.exitCode === null) {
          parent.kill('SIGKILL');
          await Promise.race([parent.exited, delay(5_000)]);
        }
        if (observedProcessIds.length > 0) {
          await waitUntil(
            'the interrupted test cleanup process tree to exit',
            () => observedProcessIds.every((pid) => !processExists(pid)),
          );
        }
        await cleanExactGateRun(context);
      }
    }
  };
  if (process.env.TEST_DATABASE_URL === undefined) {
    test.skip(interruptedParentGateName, runInterruptedParentGate, 2 * 60_000);
  } else {
    test(interruptedParentGateName, runInterruptedParentGate, 2 * 60_000);
  }

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
    const { exitCode, stdout, stderr, outputErrors } =
      await waitForPlaywrightChildAndClean(
        context,
        () => spawnSupervisedPlaywrightChild(context, childEnvironment).child,
      );
    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain(
      'Synthetic event-room Playwright setup failure after database creation.',
    );
    expect(outputErrors).toEqual([]);
    expect(existsSync(context.runDirectory)).toBe(false);
    expect(inspectEventRoomPlaywrightPortLease(context)).toBe('absent');
    expect(await dropOwnedEventRoomPlaywrightDatabase(context)).toBe(false);
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
    const childEnvironment = { ...process.env };
    const context = resolveEventRoomPlaywrightRunContext(
      baseDatabaseUrl,
      childEnvironment,
    );
    const { exitCode, stdout, stderr, outputErrors } =
      await waitForPlaywrightChildAndClean(
        context,
        () => spawnSupervisedPlaywrightChild(context, childEnvironment).child,
      );
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
      failures.push(`browser suite exited ${exitCode}.\n${stdout}\n${stderr}`);
    }
    failures.push(...outputErrors);
    if (failures.length > 0) {
      throw new Error(
        `Event-room Playwright gate failed.\n${failures.join('\n')}`,
      );
    }
    expect(exitCode).toBe(0);
  };
  if (process.env.TEST_DATABASE_URL === undefined) {
    test.skip(browserGateName, runBrowserGate, BROWSER_GATE_TIMEOUT_MS);
  } else {
    test(browserGateName, runBrowserGate, BROWSER_GATE_TIMEOUT_MS);
  }
});
