import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';

import { createDatabaseClient } from '../db/client';

const PROBE_MODE_VARIABLE = 'PSD_EOC_ISSUE_129_RECONNECT_PROBE';
const PROBE_DATABASE_VARIABLE = 'PSD_EOC_ISSUE_129_DATABASE_URL';
const PROBE_RUN_VARIABLE = 'PSD_EOC_ISSUE_129_RUN_ID';
const PROBE_MODE_VALUE = 'isolated-loopback-probe';
const CHILD_TIMEOUT_MS = 15_000;
const AUDIT_OPERATION_TIMEOUT_MS = 4_000;
const AUDIT_CLOSE_TIMEOUT_MS = 1_000;
const isIsolatedProbe = process.env[PROBE_MODE_VARIABLE] === PROBE_MODE_VALUE;
let isolatedProbeStage = 'initializing';
const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  configuredTestDatabaseUrl === undefined ? describe.skip : describe;

const ProbeEvidenceSchema = z
  .object({
    rawReconnectDurations: z.array(z.number().finite()).min(1),
    rawRecoveredValue: z.literal(129),
    wrapperBackendCountsAfterClose: z.array(z.number().int()).length(3),
    wrapperClosePromiseReused: z.boolean(),
    wrapperConnectCallbacksAfterWait: z.number().int().nonnegative(),
    wrapperConnectCallbacksAtInvocation: z.number().int().nonnegative(),
    wrapperPendingQueryOutcome: z.enum([
      'CONNECTION_DESTROYED',
      'CONNECTION_ENDED',
    ]),
    wrapperPostCloseCode: z.literal('CONNECTION_ENDED'),
    wrapperReconnectDurations: z.array(z.number().finite()).min(1),
  })
  .strict();

type ProbeEvidence = z.infer<typeof ProbeEvidenceSchema>;

setDefaultTimeout(30_000);

function syntheticLoopbackDatabaseUrl(value: string | undefined): URL {
  if (value === undefined) {
    throw new Error('A test database URL is required for integration tests.');
  }

  const databaseUrl = new URL(value);
  const databaseName = databaseUrl.pathname.slice(1);
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
      databaseUrl.hostname,
    ) ||
    !/^[A-Za-z0-9_-]+_test$/u.test(databaseName) ||
    databaseUrl.username !== 'psd_eoc_test' ||
    databaseUrl.password.length === 0 ||
    databaseUrl.search.length > 0 ||
    databaseUrl.hash.length > 0
  ) {
    throw new Error(
      'The reconnect integration test requires a loopback synthetic test database.',
    );
  }

  return databaseUrl;
}

function validatedRunId(value: string | undefined): string {
  if (
    value === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error('The reconnect probe run identifier is invalid.');
  }
  return value.toLowerCase();
}

function safeErrorCode(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  let current = error;

  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const code = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
    current = Reflect.get(current, 'cause');
  }

  return undefined;
}

function waitMilliseconds(
  setTimeoutImplementation: typeof setTimeout,
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeoutImplementation(resolve, milliseconds);
  });
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  setTimeoutImplementation: typeof setTimeout,
  description: string,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await waitMilliseconds(setTimeoutImplementation, 5);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function connectionCount(
  control: Sql,
  applicationName: string,
): Promise<number> {
  const [row] = await control<{ count: number }[]>`
    select count(*)::integer as count
    from pg_stat_activity
    where application_name = ${applicationName}
  `;
  return row?.count ?? -1;
}

async function backendPid(
  control: Sql,
  applicationName: string,
): Promise<number> {
  const rows = await control<{ pid: number }[]>`
    select pid::integer as pid
    from pg_stat_activity
    where application_name = ${applicationName}
    order by pid
  `;
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error('The synthetic PostgreSQL backend PID was unavailable.');
  }
  return rows[0].pid;
}

function checkedCleanupError(
  primaryError: unknown,
  cleanupResults: readonly PromiseSettledResult<unknown>[],
  description: string,
): AggregateError | undefined {
  const errors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (primaryError !== undefined) errors.unshift(primaryError);
  return errors.length === 0
    ? undefined
    : new AggregateError(errors, description);
}

async function rawReconnectProbe(
  databaseUrl: URL,
  runId: string,
): Promise<{
  readonly durations: readonly number[];
  readonly recoveredValue: 129;
}> {
  const control = postgres(databaseUrl.toString(), {
    connect_timeout: 2,
    connection: { application_name: `issue-129-${runId}-raw-control` },
    max: 1,
  });
  const originalSetTimeout = globalThis.setTimeout;
  let blockNextClose = true;
  let startReconnectAfterClose: (() => void) | undefined;
  const subject = postgres(databaseUrl.toString(), {
    backoff: () => 0.001,
    connect_timeout: 2,
    connection: { application_name: `issue-129-${runId}-raw-subject` },
    max: 1,
    onclose() {
      if (!blockNextClose) return;
      blockNextClose = false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      startReconnectAfterClose?.();
    },
  });
  const reconnectDurations: number[] = [];
  let evidence:
    | {
        readonly durations: readonly number[];
        readonly recoveredValue: 129;
      }
    | undefined;
  let primaryError: unknown;

  try {
    const [backend] = await subject<{ backendPid: number }[]>`
      select pg_backend_pid()::integer as "backendPid"
    `;
    if (backend === undefined) {
      throw new Error('The synthetic reconnect backend PID was unavailable.');
    }
    isolatedProbeStage = 'raw-backend-open';

    const reconnectQuery = subject<{ value: number }[]>`
      select 129::integer as value
    `;
    let reconnectResultPromise:
      | Promise<
          | { readonly status: 'fulfilled' }
          | { readonly code: string | undefined; status: 'rejected' }
        >
      | undefined;
    startReconnectAfterClose = () => {
      reconnectResultPromise = reconnectQuery.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({
          code: safeErrorCode(error),
          status: 'rejected' as const,
        }),
      );
    };

    globalThis.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      if (
        typeof handler === 'function' &&
        handler.name === 'connect' &&
        typeof timeout === 'number'
      ) {
        reconnectDurations.push(timeout);
      }
      return originalSetTimeout(handler, timeout, ...arguments_);
    }) as typeof setTimeout;
    isolatedProbeStage = 'raw-timer-instrumented';

    const [termination] = await control<{ terminated: boolean }[]>`
      select pg_terminate_backend(${backend.backendPid}) as terminated
    `;
    if (termination?.terminated !== true) {
      throw new Error('The synthetic reconnect backend was not terminated.');
    }
    isolatedProbeStage = 'raw-backend-terminated';

    await waitForCondition(
      () => reconnectResultPromise !== undefined,
      originalSetTimeout,
      'the post-close reconnect query to start',
    );
    if (reconnectResultPromise === undefined) {
      throw new Error('The post-close reconnect query was unavailable.');
    }
    isolatedProbeStage = 'raw-reconnect-started';

    const reconnectResult = await reconnectResultPromise;
    if (reconnectResult.status !== 'fulfilled') {
      throw new Error('The reconnect query had unexpected truth.');
    }
    isolatedProbeStage = 'raw-reconnect-settled';

    const recoveryRows = await subject<{ value: number }[]>`
      select 129::integer as value
    `;
    if (recoveryRows.length !== 1 || recoveryRows[0]?.value !== 129) {
      throw new Error('The synthetic reconnect recovery query failed.');
    }
    if (reconnectDurations.length === 0) {
      throw new Error('The reconnect scheduler was not observed.');
    }
    isolatedProbeStage = 'raw-recovery-complete';

    evidence = {
      durations: [...reconnectDurations],
      recoveredValue: 129,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  const cleanupResults = await Promise.allSettled([
    subject.end({ timeout: 1 }),
    control.end({ timeout: 1 }),
  ]);
  isolatedProbeStage = `${isolatedProbeStage}-cleanup-${cleanupResults[0]?.status ?? 'missing'}-${cleanupResults[1]?.status ?? 'missing'}-${primaryError === undefined ? 'clean' : 'primary'}`;
  const cleanupError = checkedCleanupError(
    primaryError,
    cleanupResults,
    'The isolated raw reconnect probe or its cleanup failed.',
  );
  if (cleanupError !== undefined) throw cleanupError;
  if (evidence === undefined) {
    throw new Error('The isolated raw reconnect evidence was unavailable.');
  }
  return evidence;
}

async function wrapperCloseProbe(
  databaseUrl: URL,
  runId: string,
): Promise<{
  readonly backendCountsAfterClose: readonly number[];
  readonly closePromiseReused: boolean;
  readonly connectCallbacksAfterWait: number;
  readonly connectCallbacksAtInvocation: number;
  readonly pendingQueryOutcome: 'CONNECTION_DESTROYED' | 'CONNECTION_ENDED';
  readonly postCloseCode: 'CONNECTION_ENDED';
  readonly reconnectDurations: readonly number[];
}> {
  const applicationName = `issue-129-${runId}-wrapper-subject`;
  const wrapperUrl = new URL(databaseUrl);
  wrapperUrl.searchParams.set('application_name', applicationName);
  const control = postgres(databaseUrl.toString(), {
    connect_timeout: 2,
    connection: { application_name: `issue-129-${runId}-wrapper-control` },
    max: 1,
  });
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: wrapperUrl.toString(),
    maxConnections: 1,
    connectTimeoutSeconds: 2,
    idleTimeoutSeconds: 20,
  });
  const originalSetTimeout = globalThis.setTimeout;
  const reconnectDurations: number[] = [];
  let connectCallbacks = 0;
  let evidence:
    | {
        readonly backendCountsAfterClose: readonly number[];
        readonly closePromiseReused: boolean;
        readonly connectCallbacksAfterWait: number;
        readonly connectCallbacksAtInvocation: number;
        readonly pendingQueryOutcome:
          | 'CONNECTION_DESTROYED'
          | 'CONNECTION_ENDED';
        readonly postCloseCode: 'CONNECTION_ENDED';
        readonly reconnectDurations: readonly number[];
      }
    | undefined;
  let primaryError: unknown;

  try {
    await connection.db.execute(sql`select 1::integer as value`);
    const wrapperBackendPid = await backendPid(control, applicationName);

    globalThis.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      if (
        typeof handler === 'function' &&
        handler.name === 'connect' &&
        typeof timeout === 'number'
      ) {
        reconnectDurations.push(timeout);
        return originalSetTimeout(
          (...callbackArguments: unknown[]) => {
            connectCallbacks += 1;
            Reflect.apply(handler, undefined, callbackArguments);
          },
          250,
          ...arguments_,
        );
      }
      return originalSetTimeout(handler, timeout, ...arguments_);
    }) as typeof setTimeout;

    const [termination] = await control<{ terminated: boolean }[]>`
      select pg_terminate_backend(${wrapperBackendPid}) as terminated
    `;
    if (termination?.terminated !== true) {
      throw new Error('The wrapper backend was not terminated.');
    }
    await waitForCondition(
      () =>
        connectionCount(control, applicationName).then((count) => count === 0),
      originalSetTimeout,
      'the terminated wrapper backend to leave PostgreSQL',
    );
    await waitMilliseconds(originalSetTimeout, 20);

    const pendingQuery = Promise.resolve(
      connection.db.execute(sql`select 129::integer as value`),
    ).then(
      () => 'fulfilled' as const,
      (error: unknown) => safeErrorCode(error),
    );
    await waitForCondition(
      () => reconnectDurations.length > 0,
      originalSetTimeout,
      'the wrapper reconnect timer to be scheduled',
    );

    const firstClose = connection.close();
    const connectCallbacksAtInvocation = connectCallbacks;
    const secondClose = connection.close();
    const closePromiseReused = firstClose === secondClose;
    const [pendingQueryOutcome] = await Promise.all([
      pendingQuery,
      firstClose,
      secondClose,
    ]);
    if (
      pendingQueryOutcome !== 'CONNECTION_DESTROYED' &&
      pendingQueryOutcome !== 'CONNECTION_ENDED'
    ) {
      throw new Error('The wrapper pending query had unexpected truth.');
    }

    let postCloseCode: string | undefined;
    try {
      await connection.db.execute(sql`select 1::integer as value`);
    } catch (error) {
      postCloseCode = safeErrorCode(error);
    }
    if (postCloseCode !== 'CONNECTION_ENDED') {
      throw new Error('The wrapper accepted work after close.');
    }

    const backendCountsAfterClose = [
      await connectionCount(control, applicationName),
    ];
    await waitMilliseconds(originalSetTimeout, 300);
    backendCountsAfterClose.push(
      await connectionCount(control, applicationName),
    );
    await waitMilliseconds(originalSetTimeout, 300);
    backendCountsAfterClose.push(
      await connectionCount(control, applicationName),
    );

    evidence = {
      backendCountsAfterClose,
      closePromiseReused,
      connectCallbacksAfterWait: connectCallbacks,
      connectCallbacksAtInvocation,
      pendingQueryOutcome,
      postCloseCode: 'CONNECTION_ENDED',
      reconnectDurations: [...reconnectDurations],
    };
  } catch (error) {
    primaryError = error;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  const cleanupResults = await Promise.allSettled([
    connection.close(),
    control.end({ timeout: 1 }),
  ]);
  const cleanupError = checkedCleanupError(
    primaryError,
    cleanupResults,
    'The isolated wrapper-close probe or its cleanup failed.',
  );
  if (cleanupError !== undefined) throw cleanupError;
  if (evidence === undefined) {
    throw new Error('The isolated wrapper-close evidence was unavailable.');
  }
  return evidence;
}

async function runIsolatedProbe(): Promise<ProbeEvidence> {
  const databaseUrl = syntheticLoopbackDatabaseUrl(
    process.env[PROBE_DATABASE_VARIABLE],
  );
  const runId = validatedRunId(process.env[PROBE_RUN_VARIABLE]);
  isolatedProbeStage = 'raw-reconnect';
  const rawEvidence = await rawReconnectProbe(databaseUrl, runId);
  isolatedProbeStage = 'wrapper-close';
  const wrapperEvidence = await wrapperCloseProbe(databaseUrl, runId);
  return {
    rawReconnectDurations: [...rawEvidence.durations],
    rawRecoveredValue: rawEvidence.recoveredValue,
    wrapperBackendCountsAfterClose: [
      ...wrapperEvidence.backendCountsAfterClose,
    ],
    wrapperClosePromiseReused: wrapperEvidence.closePromiseReused,
    wrapperConnectCallbacksAfterWait: wrapperEvidence.connectCallbacksAfterWait,
    wrapperConnectCallbacksAtInvocation:
      wrapperEvidence.connectCallbacksAtInvocation,
    wrapperPendingQueryOutcome: wrapperEvidence.pendingQueryOutcome,
    wrapperPostCloseCode: wrapperEvidence.postCloseCode,
    wrapperReconnectDurations: [...wrapperEvidence.reconnectDurations],
  };
}

interface BoundedDrain {
  readonly bytes: Uint8Array;
  readonly overflow: boolean;
  readonly totalBytes: number;
}

async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abortSignal: AbortSignal,
  onOverflow: () => void,
): Promise<BoundedDrain> {
  const reader = stream.getReader();
  const cancelPendingRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  abortSignal.addEventListener('abort', cancelPendingRead, { once: true });
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  let overflow = false;
  try {
    while (true) {
      if (abortSignal.aborted) {
        await reader.cancel();
        throw new Error('The child output drain exceeded its deadline.');
      }
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      const remaining = Math.max(0, limit - retainedBytes);
      if (remaining > 0) {
        const retained = result.value.slice(0, remaining);
        chunks.push(retained);
        retainedBytes += retained.byteLength;
      }
      if (!overflow && totalBytes > limit) {
        overflow = true;
        onOverflow();
      }
    }
  } finally {
    abortSignal.removeEventListener('abort', cancelPendingRead);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow, totalBytes };
}

async function exitsWithin(
  exited: Promise<number>,
  milliseconds: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(false), milliseconds);
    void exited.then(
      () => finish(true),
      () => finish(false),
    );
  });
}

async function auditChildSessions(
  databaseUrl: URL,
  runId: string,
): Promise<void> {
  const audit = postgres(databaseUrl.toString(), {
    connect_timeout: 2,
    connection: {
      application_name: `issue-129-${runId}-parent-audit`,
      statement_timeout: AUDIT_OPERATION_TIMEOUT_MS / 2,
    },
    max: 1,
  });
  let closePromise: Promise<void> | undefined;
  const closeImmediately = (): Promise<void> => {
    closePromise ??= Promise.resolve(audit.end({ timeout: 0 }));
    return closePromise;
  };
  const withDeadline = async <Result>(
    operation: Promise<Result>,
    milliseconds: number,
    onDeadline: () => void,
  ): Promise<Result> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onDeadline();
            reject(new Error('The reconnect residue audit timed out.'));
          }, milliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let primaryError: unknown;
  try {
    await withDeadline(
      (async () => {
        const prefix = `issue-129-${runId}-%`;
        const survivingBackends = await audit<{ pid: number }[]>`
          select pid::integer as pid
          from pg_stat_activity
          where application_name like ${prefix}
            and pid <> pg_backend_pid()
          order by pid
        `;
        for (const backend of survivingBackends) {
          const [termination] = await audit<{ terminated: boolean }[]>`
            select pg_terminate_backend(${backend.pid}) as terminated
          `;
          if (termination?.terminated !== true) {
            throw new Error(
              'An exact reconnect-probe backend could not be terminated.',
            );
          }
        }
        await waitForCondition(
          async () => {
            const [row] = await audit<{ count: number }[]>`
              select count(*)::integer as count
              from pg_stat_activity
              where application_name like ${prefix}
                and pid <> pg_backend_pid()
            `;
            return row?.count === 0;
          },
          globalThis.setTimeout,
          'the reconnect-probe PostgreSQL sessions to close',
        );
      })(),
      AUDIT_OPERATION_TIMEOUT_MS,
      () => {
        void closeImmediately().catch(() => undefined);
      },
    );
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown;
  try {
    await withDeadline(
      closeImmediately(),
      AUDIT_CLOSE_TIMEOUT_MS,
      () => undefined,
    );
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined || closeError !== undefined) {
    throw new Error('The reconnect-probe PostgreSQL residue audit failed.');
  }
}

async function runProbeChild(databaseUrl: URL): Promise<{
  readonly evidence: ProbeEvidence;
  readonly stderrByteLength: number;
}> {
  const runId = randomUUID();
  const probe = Bun.spawn({
    cmd: [process.execPath, fileURLToPath(import.meta.url)],
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      [PROBE_DATABASE_VARIABLE]: databaseUrl.toString(),
      [PROBE_MODE_VARIABLE]: PROBE_MODE_VALUE,
      [PROBE_RUN_VARIABLE]: runId,
      TMPDIR: tmpdir(),
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  let exited = false;
  const exitedPromise = probe.exited.then((exitCode) => {
    exited = true;
    return exitCode;
  });
  const drainAbort = new AbortController();
  let outputOverflow = false;
  const stopForOverflow = () => {
    outputOverflow = true;
    if (!exited) probe.kill('SIGTERM');
  };
  const stdoutPromise = drainBounded(
    probe.stdout,
    8_192,
    drainAbort.signal,
    stopForOverflow,
  );
  const stderrPromise = drainBounded(
    probe.stderr,
    1_024,
    drainAbort.signal,
    stopForOverflow,
  );
  let childTimedOut = false;
  let exitCode: number | undefined;
  let terminationError: unknown;
  let stdout: BoundedDrain | undefined;
  let stderr: BoundedDrain | undefined;
  let childTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    try {
      const raced = await Promise.race([
        exitedPromise.then((code) => ({ code, kind: 'exit' as const })),
        new Promise<{ readonly kind: 'timeout' }>((resolve) => {
          childTimeout = setTimeout(
            () => resolve({ kind: 'timeout' as const }),
            CHILD_TIMEOUT_MS,
          );
        }),
      ]);
      if (raced.kind === 'timeout') {
        childTimedOut = true;
      } else {
        exitCode = raced.code;
      }
    } catch {
      terminationError = new Error(
        'The isolated reconnect-probe exit could not be observed.',
      );
    }
  } finally {
    if (childTimeout !== undefined) clearTimeout(childTimeout);
    if (!exited) {
      probe.kill('SIGTERM');
      if (!(await exitsWithin(exitedPromise, 750))) {
        probe.kill('SIGKILL');
        if (!(await exitsWithin(exitedPromise, 2_000))) {
          terminationError = new Error(
            'The isolated reconnect probe did not terminate.',
          );
        }
      }
    }
    if (exited) {
      try {
        exitCode = await exitedPromise;
      } catch {
        terminationError ??= new Error(
          'The isolated reconnect-probe exit could not be awaited.',
        );
      }
    }

    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    let drains:
      | {
          readonly kind: 'drained';
          readonly values: readonly [BoundedDrain, BoundedDrain];
        }
      | { readonly kind: 'timeout' }
      | undefined;
    try {
      drains = await Promise.race([
        Promise.all([stdoutPromise, stderrPromise]).then(
          ([stdoutResult, stderrResult]) => ({
            kind: 'drained' as const,
            values: [stdoutResult, stderrResult] as const,
          }),
        ),
        new Promise<{ readonly kind: 'timeout' }>((resolve) => {
          drainTimeout = setTimeout(
            () => resolve({ kind: 'timeout' as const }),
            1_000,
          );
        }),
      ]);
    } catch {
      terminationError ??= new Error(
        'The isolated reconnect-probe output drain failed.',
      );
    } finally {
      if (drainTimeout !== undefined) clearTimeout(drainTimeout);
    }
    if (drains?.kind === 'drained') {
      [stdout, stderr] = drains.values;
    } else {
      drainAbort.abort();
      await Promise.allSettled([stdoutPromise, stderrPromise]);
      if (drains?.kind === 'timeout') {
        terminationError ??= new Error(
          'The isolated reconnect-probe output did not drain.',
        );
      }
    }

    try {
      await auditChildSessions(databaseUrl, runId);
    } catch {
      terminationError ??= new Error(
        'The isolated reconnect-probe residue audit failed.',
      );
    }
  }

  if (
    terminationError !== undefined ||
    childTimedOut ||
    outputOverflow ||
    exitCode !== 0 ||
    stdout === undefined ||
    stderr === undefined ||
    stdout.overflow ||
    stderr.overflow ||
    stderr.totalBytes !== 0
  ) {
    throw new Error('The isolated reconnect probe failed closed.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(stdout.bytes));
  } catch {
    throw new Error('The isolated reconnect probe returned invalid evidence.');
  }
  const evidence = ProbeEvidenceSchema.safeParse(parsed);
  if (!evidence.success) {
    throw new Error('The isolated reconnect probe returned invalid evidence.');
  }

  return {
    evidence: evidence.data,
    stderrByteLength: stderr.totalBytes,
  };
}

if (isIsolatedProbe) {
  try {
    const evidence = await runIsolatedProbe();
    process.stdout.write(JSON.stringify(evidence));
  } catch {
    process.stderr.write(isolatedProbeStage);
    process.exitCode = 1;
  }
} else {
  describe('reconnect integration database guard', () => {
    test('accepts only exact synthetic loopback database inputs', () => {
      for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
        const databaseUrl = syntheticLoopbackDatabaseUrl(
          `postgresql://psd_eoc_test:synthetic-only@${hostname}:5432/psd_eoc_test`,
        );
        expect(databaseUrl.hostname).toBe(hostname);
      }
    });

    test('rejects remote and production-shaped database inputs generically', () => {
      for (const value of [
        'postgresql://psd_eoc_test:synthetic-only@database.internal:5432/psd_eoc_test',
        'postgresql://psd_eoc_test:synthetic-only@localhost:5432/psd_eoc',
        'postgresql://other:synthetic-only@localhost:5432/psd_eoc_test',
        'postgresql://psd_eoc_test:@localhost:5432/psd_eoc_test',
        'postgresql://psd_eoc_test:synthetic-only@localhost:5432/psd_eoc_test?sslmode=require',
      ]) {
        expect(() => syntheticLoopbackDatabaseUrl(value)).toThrow(
          'The reconnect integration test requires a loopback synthetic test database.',
        );
      }
    });
  });

  describeWithDatabase('postgres reconnect scheduling and lifecycle', () => {
    test('binds nonnegative reconnect scheduling and post-close truth in an isolated process', async () => {
      const databaseUrl = syntheticLoopbackDatabaseUrl(
        configuredTestDatabaseUrl,
      );
      const { evidence, stderrByteLength } = await runProbeChild(databaseUrl);

      expect(evidence.rawReconnectDurations.length).toBeGreaterThanOrEqual(1);
      expect(
        evidence.rawReconnectDurations.every((duration) => duration >= 0),
      ).toBe(true);
      expect(evidence.rawRecoveredValue).toBe(129);

      expect(evidence.wrapperReconnectDurations.length).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        evidence.wrapperReconnectDurations.every((duration) => duration >= 0),
      ).toBe(true);
      expect(evidence.wrapperClosePromiseReused).toBe(true);
      expect(evidence.wrapperPostCloseCode).toBe('CONNECTION_ENDED');
      expect(evidence.wrapperBackendCountsAfterClose).toEqual([0, 0, 0]);
      expect(evidence.wrapperConnectCallbacksAtInvocation).toBe(0);
      expect(evidence.wrapperConnectCallbacksAfterWait).toBe(0);
      expect(['CONNECTION_DESTROYED', 'CONNECTION_ENDED']).toContain(
        evidence.wrapperPendingQueryOutcome,
      );
      expect(stderrByteLength).toBe(0);
    });
  });
}
