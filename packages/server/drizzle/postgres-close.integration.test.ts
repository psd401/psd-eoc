import { randomUUID } from 'node:crypto';
import { createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';

import { createDatabaseClient } from '../db/client';

const PROBE_MODE_VARIABLE = 'PSD_EOC_ISSUE_130_CLOSE_PROBE';
const PROBE_DATABASE_VARIABLE = 'PSD_EOC_ISSUE_130_DATABASE_URL';
const PROBE_RUN_VARIABLE = 'PSD_EOC_ISSUE_130_RUN_ID';
const PROBE_MODE_VALUE = 'isolated-loopback-close-probe';
const RECONNECT_DELAY_MS = 250;
const OBSERVATION_MS = 600;
const CHILD_TIMEOUT_MS = 15_000;
const AUDIT_OPERATION_TIMEOUT_MS = 4_000;
const AUDIT_CLOSE_TIMEOUT_MS = 1_000;
const CANCEL_FAILURE_TIMEOUT_SECONDS = 0.4;
const CANCEL_FAILURE_OBSERVATION_MS = 550;
const CANCEL_FAILURE_SUBJECT_SLEEP_SECONDS = 2;
const DEFERRED_SOCKET_OBSERVATION_MS = 50;
const TLS_SUBJECT_SLEEP_SECONDS = 1;
const isIsolatedProbe = process.env[PROBE_MODE_VARIABLE] === PROBE_MODE_VALUE;
const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  configuredTestDatabaseUrl === undefined ? describe.skip : describe;
let isolatedProbeStage = 'initializing';

const QueryOutcomeSchema = z.enum([
  'fulfilled',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'unexpected',
]);

const ProbeEvidenceSchema = z
  .object({
    activeBackendCountsAfterClose: z.array(z.number().int()).length(2),
    activeCloseElapsedMs: z.number().finite().nonnegative(),
    activeClosePromiseReused: z.boolean(),
    activeQueryOutcome: QueryOutcomeSchema,
    activePostCloseOutcome: QueryOutcomeSchema,
    cancelFailureBackendCountsAfterClose: z.array(z.number().int()).length(2),
    cancelFailureBackendCountAfterCancelTimeout: z.number().int(),
    cancelFailureBackendCountAtCloseRejection: z.number().int(),
    cancelFailureCloseCode: z.enum(['CONNECT_TIMEOUT', 'unexpected']),
    cancelFailureCloseSettledAfterCancelTimeout: z.boolean(),
    cancelFailureCloseSettledWhileBackendActive: z.boolean(),
    cancelFailureQueuedOutcome: QueryOutcomeSchema,
    cancelFailureQueuedSettledAtCloseRejection: z.boolean(),
    idleBackendCountsAfterClose: z.array(z.number().int()).length(2),
    idleClosePromiseReused: z.boolean(),
    idlePostCloseOutcome: QueryOutcomeSchema,
    openingCloseSettledBeforeSocketCreation: z.boolean(),
    openingCloseResolvedAfterSocketClose: z.boolean(),
    openingQueryOutcome: QueryOutcomeSchema,
    queuedBackendCountsAfterClose: z.array(z.number().int()).length(3),
    queuedClosePromiseReused: z.boolean(),
    queuedConnectCallbacksAfterObservation: z.number().int().nonnegative(),
    queuedConnectCallbacksAtInvocation: z.number().int().nonnegative(),
    queuedPendingFulfillmentsAfterObservation: z.number().int().nonnegative(),
    queuedPendingFulfillmentsAtInvocation: z.number().int().nonnegative(),
    queuedPendingOutcome: QueryOutcomeSchema,
    queuedPostCloseOutcome: QueryOutcomeSchema,
    queuedReconnectTimerClearedAtInvocation: z.boolean(),
    queuedReconnectDurations: z.array(z.number().finite()).min(1),
    tlsCancelFrameWritten: z.boolean(),
    tlsActiveQueryOutcome: QueryOutcomeSchema,
    tlsCloseSettledBeforeFinalTransportClose: z.boolean(),
    tlsFinalTransportClosed: z.boolean(),
    tlsPostCloseOutcome: QueryOutcomeSchema,
    tlsSubjectBackendCountBeforeFinalTransportClose: z.number().int(),
    tlsTransportErrorActiveQueryOutcome: QueryOutcomeSchema,
    tlsTransportErrorBackendCountsAfterClose: z
      .array(z.number().int())
      .length(2),
    tlsTransportErrorCloseCode: z.enum([
      'SYNTHETIC_CANCEL_TRANSPORT_ERROR',
      'unexpected',
    ]),
    tlsTransportErrorCloseSettledBeforeTransportClose: z.boolean(),
    tlsTransportErrorPostCloseOutcome: QueryOutcomeSchema,
    tlsTransportErrorSubjectBackendCountBeforeTransportClose: z.number().int(),
    tlsTransportErrorTransportClosed: z.boolean(),
    tlsWrapFailureActiveQueryOutcome: QueryOutcomeSchema,
    tlsWrapFailureBackendCountsAfterClose: z.array(z.number().int()).length(2),
    tlsWrapFailureCloseCode: z.enum([
      'SYNTHETIC_TLS_WRAP_FAILURE',
      'unexpected',
    ]),
    tlsWrapFailureCloseSettledBeforeRawTransportClose: z.boolean(),
    tlsWrapFailurePostCloseOutcome: QueryOutcomeSchema,
    tlsWrapFailureRawTransportClosed: z.boolean(),
    tlsWrapFailureSubjectBackendCountBeforeRawTransportClose: z.number().int(),
  })
  .strict();

type ProbeEvidence = z.infer<typeof ProbeEvidenceSchema>;
type QueryOutcome = z.infer<typeof QueryOutcomeSchema>;
type ProbePath = 'active' | 'cancel-failure' | 'idle' | 'queued' | 'tls';

setDefaultTimeout(30_000);

function syntheticLoopbackDatabaseUrl(value: string | undefined): URL {
  if (value === undefined) {
    throw new Error('A synthetic test database URL is required.');
  }

  const databaseUrl = new URL(value);
  const databaseName = databaseUrl.pathname.slice(1);
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(
      databaseUrl.hostname,
    ) ||
    !/^[A-Za-z0-9_-]+_test$/u.test(databaseName) ||
    databaseUrl.username !== 'psd_eoc_test' ||
    databaseUrl.password.length === 0 ||
    databaseUrl.search.length > 0 ||
    databaseUrl.hash.length > 0
  ) {
    throw new Error('The close probe requires a loopback synthetic database.');
  }
  if (databaseUrl.hostname === 'localhost') {
    databaseUrl.hostname = '127.0.0.1';
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
    throw new Error('The close probe run identifier is invalid.');
  }
  return value.toLowerCase();
}

function applicationName(runId: string, path: ProbePath, role: string): string {
  const pathLabel = path === 'cancel-failure' ? 'cancel' : path;
  return `issue-130-${runId}-${pathLabel}-${role}`;
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

async function queryOutcome(
  operation: PromiseLike<unknown>,
): Promise<QueryOutcome> {
  try {
    await operation;
    return 'fulfilled';
  } catch (error) {
    const code = safeErrorCode(error);
    return code === 'CONNECTION_DESTROYED' || code === 'CONNECTION_ENDED'
      ? code
      : 'unexpected';
  }
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
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await waitMilliseconds(setTimeoutImplementation, 5);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

interface LoopbackBlackhole {
  readonly port: number;
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

async function openLoopbackBlackhole(): Promise<LoopbackBlackhole> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The loopback cancellation endpoint was unavailable.');
  }
  return { port: address.port, server, sockets };
}

async function closeLoopbackBlackhole(
  blackhole: LoopbackBlackhole,
): Promise<void> {
  for (const socket of blackhole.sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    blackhole.server.close((error) =>
      error === undefined ? resolve() : reject(error),
    );
  });
}

async function connectionCount(
  control: Sql,
  subjectApplicationName: string,
): Promise<number> {
  const [row] = await control<{ count: number }[]>`
    select count(*)::integer as count
    from pg_stat_activity
    where application_name = ${subjectApplicationName}
  `;
  return row?.count ?? -1;
}

async function cleanupDirectSubject(
  subject: Sql,
  control: Sql,
  subjectApplicationName: string,
): Promise<void> {
  await Promise.race([
    Promise.resolve(subject.end({ timeout: 0 })).catch(() => undefined),
    waitMilliseconds(globalThis.setTimeout, 500),
  ]);
  const survivingBackends = await control<{ pid: number }[]>`
    select pid::integer as pid
    from pg_stat_activity
    where application_name = ${subjectApplicationName}
    order by pid
  `;
  for (const backend of survivingBackends) {
    const [termination] = await control<{ terminated: boolean }[]>`
      select pg_terminate_backend(${backend.pid}) as terminated
    `;
    if (termination?.terminated !== true) {
      throw new Error(
        'An exact direct close-probe backend could not be terminated.',
      );
    }
  }
  await waitForCondition(
    () =>
      connectionCount(control, subjectApplicationName).then(
        (count) => count === 0,
      ),
    globalThis.setTimeout,
    'the direct close-probe PostgreSQL session to leave',
    2_000,
  );
  await control.end({ timeout: 1 });
}

async function backendPid(
  control: Sql,
  subjectApplicationName: string,
): Promise<number> {
  const rows = await control<{ pid: number }[]>`
    select pid::integer as pid
    from pg_stat_activity
    where application_name = ${subjectApplicationName}
    order by pid
  `;
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error('The synthetic PostgreSQL backend PID was unavailable.');
  }
  return rows[0].pid;
}

async function waitForActiveBackend(
  control: Sql,
  subjectApplicationName: string,
): Promise<void> {
  await waitForCondition(
    async () => {
      const [row] = await control<{ active: boolean }[]>`
        select exists (
          select 1
          from pg_stat_activity
          where application_name = ${subjectApplicationName}
            and state = 'active'
            and wait_event = 'PgSleep'
        ) as active
      `;
      return row?.active === true;
    },
    globalThis.setTimeout,
    'the active synthetic backend',
  );
}

function openControl(databaseUrl: URL, name: string): Sql {
  return postgres(databaseUrl.toString(), {
    connect_timeout: 2,
    connection: { application_name: name },
    max: 1,
  });
}

function openSubject(databaseUrl: URL, name: string) {
  const subjectUrl = new URL(databaseUrl);
  subjectUrl.searchParams.set('application_name', name);
  return createDatabaseClient({
    driver: 'postgres',
    url: subjectUrl.toString(),
    maxConnections: 1,
    connectTimeoutSeconds: 2,
    idleTimeoutSeconds: 20,
  });
}

async function checkedSubjectCleanup(
  primaryError: unknown,
  subject: ReturnType<typeof openSubject>,
  control: Sql,
  subjectApplicationName: string,
  stagePrefix: ProbePath,
): Promise<void> {
  const errors: unknown[] = [];
  if (primaryError !== undefined) errors.push(primaryError);

  try {
    isolatedProbeStage = `${stagePrefix}-cleanup-subject`;
    await subject.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    isolatedProbeStage = `${stagePrefix}-cleanup-audit`;
    const survivingBackends = await control<{ pid: number }[]>`
      select pid::integer as pid
      from pg_stat_activity
      where application_name = ${subjectApplicationName}
      order by pid
    `;
    for (const backend of survivingBackends) {
      isolatedProbeStage = `${stagePrefix}-cleanup-terminate`;
      const [termination] = await control<{ terminated: boolean }[]>`
        select pg_terminate_backend(${backend.pid}) as terminated
      `;
      if (termination?.terminated !== true) {
        throw new Error(
          'An exact close-probe backend could not be terminated during cleanup.',
        );
      }
    }
    isolatedProbeStage = `${stagePrefix}-cleanup-readback`;
    await waitForCondition(
      () =>
        connectionCount(control, subjectApplicationName).then(
          (count) => count === 0,
        ),
      globalThis.setTimeout,
      'the close-probe PostgreSQL session to leave after cleanup',
      2_000,
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    isolatedProbeStage = `${stagePrefix}-cleanup-control`;
    await control.end({ timeout: 1 });
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0) {
    isolatedProbeStage =
      primaryError === undefined
        ? `${stagePrefix}-cleanup-failed`
        : `${stagePrefix}-primary-failed`;
    throw new AggregateError(errors, 'The close probe or its cleanup failed.');
  }
  isolatedProbeStage = `${stagePrefix}-clean`;
}

async function idleCloseProbe(
  databaseUrl: URL,
  runId: string,
): Promise<
  Pick<
    ProbeEvidence,
    | 'idleBackendCountsAfterClose'
    | 'idleClosePromiseReused'
    | 'idlePostCloseOutcome'
  >
> {
  const subjectName = applicationName(runId, 'idle', 'subject');
  const control = openControl(
    databaseUrl,
    applicationName(runId, 'idle', 'control'),
  );
  const subject = openSubject(databaseUrl, subjectName);
  let evidence:
    | Pick<
        ProbeEvidence,
        | 'idleBackendCountsAfterClose'
        | 'idleClosePromiseReused'
        | 'idlePostCloseOutcome'
      >
    | undefined;
  let primaryError: unknown;

  try {
    isolatedProbeStage = 'idle-opening';
    await subject.db.execute(sql`select 1::integer as value`);
    if ((await connectionCount(control, subjectName)) !== 1) {
      throw new Error('The idle close-probe backend was not open.');
    }
    isolatedProbeStage = 'idle-closing';
    const firstClose = subject.close();
    const secondClose = subject.close();
    const postCloseOutcomePromise = queryOutcome(
      subject.db.execute(sql`select 130::integer as value`),
    );
    const [postCloseOutcome] = await Promise.all([
      postCloseOutcomePromise,
      firstClose,
      secondClose,
    ]);
    isolatedProbeStage = 'idle-observing';
    await waitForCondition(
      () => connectionCount(control, subjectName).then((count) => count === 0),
      globalThis.setTimeout,
      'the idle close-probe backend to leave after close',
      2_000,
    );
    const backendCountsAfterClose = [
      await connectionCount(control, subjectName),
    ];
    await waitMilliseconds(globalThis.setTimeout, 100);
    backendCountsAfterClose.push(await connectionCount(control, subjectName));
    evidence = {
      idleBackendCountsAfterClose: backendCountsAfterClose,
      idleClosePromiseReused: firstClose === secondClose,
      idlePostCloseOutcome: postCloseOutcome,
    };
  } catch (error) {
    primaryError = error;
  }

  await checkedSubjectCleanup(
    primaryError,
    subject,
    control,
    subjectName,
    'idle',
  );
  if (evidence === undefined) {
    throw new Error('The idle close-probe evidence was unavailable.');
  }
  return evidence;
}

async function openingSocketCloseProbe(): Promise<
  Pick<
    ProbeEvidence,
    | 'openingCloseResolvedAfterSocketClose'
    | 'openingCloseSettledBeforeSocketCreation'
    | 'openingQueryOutcome'
  >
> {
  let factoryStartedResolve: (() => void) | undefined;
  const factoryStarted = new Promise<void>((resolve) => {
    factoryStartedResolve = resolve;
  });
  let releaseSocketFactory: (() => void) | undefined;
  const socketFactoryGate = new Promise<void>((resolve) => {
    releaseSocketFactory = resolve;
  });
  let openedSocket: Socket | undefined;
  let socketClosed = false;
  const openingOptions = {
    connect_timeout: 1,
    max: 1,
    socket: async () => {
      factoryStartedResolve?.();
      await socketFactoryGate;
      openedSocket = new Socket();
      openedSocket.once('close', () => {
        socketClosed = true;
      });
      return openedSocket;
    },
  };
  const subject = postgres(
    'postgres://psd_eoc_test:synthetic@127.0.0.1:1/psd_eoc_test',
    openingOptions,
  );
  const openingQueryOutcomePromise = queryOutcome(
    subject`select 130::integer as value`,
  );
  let closeSettled = false;
  let closeResolvedAfterSocketClose = false;

  try {
    isolatedProbeStage = 'opening-waiting-for-socket-factory';
    await factoryStarted;
    isolatedProbeStage = 'opening-closing';
    const closePromise = Promise.resolve(subject.end({ timeout: 0 })).then(
      () => {
        closeResolvedAfterSocketClose = socketClosed;
        closeSettled = true;
      },
    );
    await waitMilliseconds(
      globalThis.setTimeout,
      DEFERRED_SOCKET_OBSERVATION_MS,
    );
    const closeSettledBeforeSocketCreation = closeSettled;
    releaseSocketFactory?.();
    const [openingQueryOutcome] = await Promise.all([
      openingQueryOutcomePromise,
      closePromise,
    ]);
    await waitForCondition(
      () => socketClosed,
      globalThis.setTimeout,
      'the deferred synthetic socket to close',
      1_000,
    );
    return {
      openingCloseResolvedAfterSocketClose: closeResolvedAfterSocketClose,
      openingCloseSettledBeforeSocketCreation: closeSettledBeforeSocketCreation,
      openingQueryOutcome,
    };
  } finally {
    releaseSocketFactory?.();
    openedSocket?.destroy();
    await Promise.resolve(subject.end({ timeout: 0 })).catch(() => undefined);
  }
}

async function activeCloseProbe(
  databaseUrl: URL,
  runId: string,
): Promise<
  Pick<
    ProbeEvidence,
    | 'activeBackendCountsAfterClose'
    | 'activeCloseElapsedMs'
    | 'activeClosePromiseReused'
    | 'activePostCloseOutcome'
    | 'activeQueryOutcome'
  >
> {
  const subjectName = applicationName(runId, 'active', 'subject');
  const control = openControl(
    databaseUrl,
    applicationName(runId, 'active', 'control'),
  );
  const subject = openSubject(databaseUrl, subjectName);
  let evidence:
    | Pick<
        ProbeEvidence,
        | 'activeBackendCountsAfterClose'
        | 'activeCloseElapsedMs'
        | 'activeClosePromiseReused'
        | 'activePostCloseOutcome'
        | 'activeQueryOutcome'
      >
    | undefined;
  let primaryError: unknown;

  try {
    isolatedProbeStage = 'active-starting';
    const activeQueryOutcomePromise = queryOutcome(
      subject.db.execute(sql`select pg_sleep(10)`),
    );
    isolatedProbeStage = 'active-waiting';
    await waitForActiveBackend(control, subjectName);
    isolatedProbeStage = 'active-closing';
    const closeStartedAt = performance.now();
    const firstClose = subject.close();
    const secondClose = subject.close();
    const postCloseOutcomePromise = queryOutcome(
      subject.db.execute(sql`select 130::integer as value`),
    );
    const [activeQueryOutcome, postCloseOutcome] = await Promise.all([
      activeQueryOutcomePromise,
      postCloseOutcomePromise,
      firstClose,
      secondClose,
    ]);
    isolatedProbeStage = 'active-observing';
    const activeCloseElapsedMs = performance.now() - closeStartedAt;
    const backendCountsAfterClose = [
      await connectionCount(control, subjectName),
    ];
    await waitMilliseconds(globalThis.setTimeout, 100);
    backendCountsAfterClose.push(await connectionCount(control, subjectName));
    evidence = {
      activeBackendCountsAfterClose: backendCountsAfterClose,
      activeCloseElapsedMs,
      activeClosePromiseReused: firstClose === secondClose,
      activePostCloseOutcome: postCloseOutcome,
      activeQueryOutcome,
    };
  } catch (error) {
    primaryError = error;
  }

  await checkedSubjectCleanup(
    primaryError,
    subject,
    control,
    subjectName,
    'active',
  );
  if (evidence === undefined) {
    throw new Error('The active close-probe evidence was unavailable.');
  }
  return evidence;
}

async function cancelFailureCloseProbe(
  databaseUrl: URL,
  runId: string,
): Promise<
  Pick<
    ProbeEvidence,
    | 'cancelFailureBackendCountAfterCancelTimeout'
    | 'cancelFailureBackendCountAtCloseRejection'
    | 'cancelFailureBackendCountsAfterClose'
    | 'cancelFailureCloseCode'
    | 'cancelFailureCloseSettledAfterCancelTimeout'
    | 'cancelFailureCloseSettledWhileBackendActive'
    | 'cancelFailureQueuedOutcome'
    | 'cancelFailureQueuedSettledAtCloseRejection'
  >
> {
  const subjectName = applicationName(runId, 'cancel-failure', 'subject');
  const control = openControl(
    databaseUrl,
    applicationName(runId, 'cancel-failure', 'control'),
  );
  const subjectUrl = new URL(databaseUrl);
  subjectUrl.searchParams.set('application_name', subjectName);
  const subject = postgres(subjectUrl.toString(), {
    connect_timeout: 2,
    max: 1,
  });
  let blackhole: LoopbackBlackhole | undefined;

  try {
    isolatedProbeStage = 'cancel-failure-starting';
    await subject`select 1::integer as value`;
    const cancellationBlackhole = await openLoopbackBlackhole();
    blackhole = cancellationBlackhole;
    const activeQueryOutcomePromise = queryOutcome(
      subject`select pg_sleep(${CANCEL_FAILURE_SUBJECT_SLEEP_SECONDS})`,
    );
    await waitForActiveBackend(control, subjectName);

    let queuedSettled = false;
    const queuedOutcomePromise = queryOutcome(
      subject`select 130::integer as value`,
    ).then((outcome) => {
      queuedSettled = true;
      return outcome;
    });
    await waitMilliseconds(globalThis.setTimeout, 5);
    Reflect.set(
      subject.options,
      'connect_timeout',
      CANCEL_FAILURE_TIMEOUT_SECONDS,
    );
    Reflect.set(subject.options, 'host', ['127.0.0.1']);
    Reflect.set(subject.options, 'port', [cancellationBlackhole.port]);

    isolatedProbeStage = 'cancel-failure-closing';
    let closeSettled = false;
    let queuedSettledAtCloseRejection = false;
    const closeOutcomePromise = Promise.resolve(
      subject.end({ timeout: 0 }),
    ).then(
      () => {
        closeSettled = true;
        return 'unexpected' as const;
      },
      (error: unknown) => {
        queuedSettledAtCloseRejection = queuedSettled;
        closeSettled = true;
        return safeErrorCode(error) === 'CONNECT_TIMEOUT'
          ? ('CONNECT_TIMEOUT' as const)
          : ('unexpected' as const);
      },
    );

    await waitForCondition(
      () => cancellationBlackhole.sockets.size > 0,
      globalThis.setTimeout,
      'the failed-cancel transport to reach the loopback blackhole',
      1_000,
    );
    await waitMilliseconds(
      globalThis.setTimeout,
      CANCEL_FAILURE_OBSERVATION_MS,
    );
    const cancelFailureBackendCountAfterCancelTimeout = await connectionCount(
      control,
      subjectName,
    );
    const cancelFailureCloseSettledAfterCancelTimeout = closeSettled;

    await waitForCondition(
      () => closeSettled,
      globalThis.setTimeout,
      'the failed-cancel close promise to reject',
      3_000,
    );
    const cancelFailureBackendCountAtCloseRejection = await connectionCount(
      control,
      subjectName,
    );
    const cancelFailureCloseSettledWhileBackendActive =
      closeSettled && cancelFailureBackendCountAtCloseRejection > 0;

    const cancelFailureQueuedOutcome = await queuedOutcomePromise;
    const cancelFailureCloseCode = await closeOutcomePromise;
    await activeQueryOutcomePromise;
    await waitForCondition(
      () => connectionCount(control, subjectName).then((count) => count === 0),
      globalThis.setTimeout,
      'the failed-cancel subject backend to leave',
      2_000,
    );
    const cancelFailureBackendCountsAfterClose = [
      await connectionCount(control, subjectName),
    ];
    await waitMilliseconds(globalThis.setTimeout, 100);
    cancelFailureBackendCountsAfterClose.push(
      await connectionCount(control, subjectName),
    );

    return {
      cancelFailureBackendCountAfterCancelTimeout,
      cancelFailureBackendCountAtCloseRejection,
      cancelFailureBackendCountsAfterClose,
      cancelFailureCloseCode,
      cancelFailureCloseSettledAfterCancelTimeout,
      cancelFailureCloseSettledWhileBackendActive,
      cancelFailureQueuedOutcome,
      cancelFailureQueuedSettledAtCloseRejection: queuedSettledAtCloseRejection,
    };
  } finally {
    if (blackhole !== undefined) await closeLoopbackBlackhole(blackhole);
    await cleanupDirectSubject(subject, control, subjectName);
  }
}

async function tlsCancelTransportProbe(
  databaseUrl: URL,
  runId: string,
): Promise<
  Pick<
    ProbeEvidence,
    | 'tlsActiveQueryOutcome'
    | 'tlsCancelFrameWritten'
    | 'tlsCloseSettledBeforeFinalTransportClose'
    | 'tlsFinalTransportClosed'
    | 'tlsPostCloseOutcome'
    | 'tlsSubjectBackendCountBeforeFinalTransportClose'
  >
> {
  const subjectName = applicationName(runId, 'tls', 'subject');
  const control = openControl(
    databaseUrl,
    applicationName(runId, 'tls', 'control'),
  );
  const subjectUrl = new URL(databaseUrl);
  subjectUrl.searchParams.set('application_name', subjectName);
  const subject = postgres(subjectUrl.toString(), {
    connect_timeout: 2,
    max: 1,
  });
  const originalTlsConnect = tls.connect;
  let rawResponseSent = false;
  const rawTransport = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
      if (!rawResponseSent) {
        rawResponseSent = true;
        setTimeout(() => rawTransport.emit('data', Buffer.from([83])), 0);
      }
    },
  });
  let cancelFrameWritten = false;
  let finalTransportClosed = false;
  const finalTransport = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      cancelFrameWritten =
        bytes.length === 16 && bytes.readInt32BE(4) === 80_877_102;
      callback();
    },
  });
  const closeFinalTransport = () => {
    if (finalTransportClosed) return;
    finalTransportClosed = true;
    finalTransport.emit('close', false);
  };

  try {
    isolatedProbeStage = 'tls-starting';
    await subject`select 1::integer as value`;
    const activeQueryOutcomePromise = queryOutcome(
      subject`select pg_sleep(${TLS_SUBJECT_SLEEP_SECONDS})`,
    );
    await waitForActiveBackend(control, subjectName);

    Reflect.set(subject.options, 'ssl', 'require');
    Reflect.set(subject.options, 'socket', async () => rawTransport);
    Reflect.set(tls, 'connect', () => {
      setTimeout(() => finalTransport.emit('secureConnect'), 0);
      return finalTransport;
    });

    isolatedProbeStage = 'tls-closing';
    let closeSettled = false;
    const closePromise = Promise.resolve(subject.end({ timeout: 0 })).then(
      () => {
        closeSettled = true;
      },
      (error: unknown) => {
        closeSettled = true;
        throw error;
      },
    );
    const postCloseOutcomePromise = queryOutcome(
      subject`select 130::integer as value`,
    );
    isolatedProbeStage = 'tls-wrap-failure-waiting-raw-destroy';
    await waitForCondition(
      () => cancelFrameWritten,
      globalThis.setTimeout,
      'the TLS synthetic CancelRequest frame',
      1_000,
    );
    isolatedProbeStage = 'tls-wrap-failure-waiting-subject-close';
    await waitForCondition(
      () => connectionCount(control, subjectName).then((count) => count === 0),
      globalThis.setTimeout,
      'the TLS close-probe subject backend to leave',
      2_000,
    );
    const tlsSubjectBackendCountBeforeFinalTransportClose =
      await connectionCount(control, subjectName);
    const tlsCloseSettledBeforeFinalTransportClose = closeSettled;
    closeFinalTransport();
    await waitForCondition(
      () => closeSettled,
      globalThis.setTimeout,
      'the TLS close promise to settle after final transport close',
      1_000,
    );
    const [tlsActiveQueryOutcome, tlsPostCloseOutcome] = await Promise.all([
      activeQueryOutcomePromise,
      postCloseOutcomePromise,
      closePromise,
    ]);

    return {
      tlsActiveQueryOutcome,
      tlsCancelFrameWritten: cancelFrameWritten,
      tlsCloseSettledBeforeFinalTransportClose,
      tlsFinalTransportClosed: finalTransportClosed,
      tlsPostCloseOutcome,
      tlsSubjectBackendCountBeforeFinalTransportClose,
    };
  } finally {
    closeFinalTransport();
    Reflect.set(tls, 'connect', originalTlsConnect);
    await cleanupDirectSubject(subject, control, subjectName);
  }
}

async function tlsCancelWrapFailureProbe(
  databaseUrl: URL,
  runId: string,
): Promise<
  Pick<
    ProbeEvidence,
    | 'tlsWrapFailureActiveQueryOutcome'
    | 'tlsWrapFailureBackendCountsAfterClose'
    | 'tlsWrapFailureCloseCode'
    | 'tlsWrapFailureCloseSettledBeforeRawTransportClose'
    | 'tlsWrapFailurePostCloseOutcome'
    | 'tlsWrapFailureRawTransportClosed'
    | 'tlsWrapFailureSubjectBackendCountBeforeRawTransportClose'
  >
> {
  const subjectName = applicationName(runId, 'tls', 'fail-subject');
  const control = openControl(
    databaseUrl,
    applicationName(runId, 'tls', 'fail-control'),
  );
  const subjectUrl = new URL(databaseUrl);
  subjectUrl.searchParams.set('application_name', subjectName);
  const subject = postgres(subjectUrl.toString(), {
    connect_timeout: 2,
    max: 1,
  });
  const originalTlsConnect = tls.connect;
  let finishRawDestroy: (() => void) | undefined;
  let rawDestroyRequested = false;
  let rawResponseSent = false;
  let rawTransportClosed = false;
  const rawTransport = new Duplex({
    destroy(_error, callback) {
      rawDestroyRequested = true;
      finishRawDestroy = () => {
        callback();
        rawTransportClosed = true;
      };
    },
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
      if (!rawResponseSent) {
        rawResponseSent = true;
        setTimeout(() => rawTransport.emit('data', Buffer.from([83])), 0);
      }
    },
  });
  const releaseRawTransport = () => {
    const finish = finishRawDestroy;
    if (finish === undefined) return;
    finishRawDestroy = undefined;
    finish();
  };

  try {
    isolatedProbeStage = 'tls-wrap-failure-starting';
    await subject`select 1::integer as value`;
    const activeQueryOutcomePromise = queryOutcome(
      subject`select pg_sleep(${TLS_SUBJECT_SLEEP_SECONDS})`,
    );
    await waitForActiveBackend(control, subjectName);

    Reflect.set(subject.options, 'ssl', 'require');
    Reflect.set(subject.options, 'socket', async () => rawTransport);
    Reflect.set(tls, 'connect', () => {
      const error = new Error('Synthetic TLS wrap failure.');
      Reflect.set(error, 'code', 'SYNTHETIC_TLS_WRAP_FAILURE');
      throw error;
    });

    isolatedProbeStage = 'tls-wrap-failure-closing';
    let closeSettled = false;
    const closeOutcomePromise = Promise.resolve(
      subject.end({ timeout: 0 }),
    ).then(
      () => {
        closeSettled = true;
        return 'unexpected' as const;
      },
      (error: unknown) => {
        closeSettled = true;
        return safeErrorCode(error) === 'SYNTHETIC_TLS_WRAP_FAILURE'
          ? ('SYNTHETIC_TLS_WRAP_FAILURE' as const)
          : ('unexpected' as const);
      },
    );
    const postCloseOutcomePromise = queryOutcome(
      subject`select 130::integer as value`,
    );
    await waitForCondition(
      () => rawDestroyRequested,
      globalThis.setTimeout,
      'the failed TLS raw transport teardown to start',
      1_000,
    );
    await waitForCondition(
      () => connectionCount(control, subjectName).then((count) => count === 0),
      globalThis.setTimeout,
      'the failed TLS close-probe subject backend to leave',
      2_500,
    );
    const tlsWrapFailureSubjectBackendCountBeforeRawTransportClose =
      await connectionCount(control, subjectName);
    const tlsWrapFailureCloseSettledBeforeRawTransportClose = closeSettled;
    releaseRawTransport();
    await waitForCondition(
      () => rawTransportClosed && closeSettled,
      globalThis.setTimeout,
      'the failed TLS close promise to settle after raw transport close',
      1_000,
    );
    const [
      tlsWrapFailureActiveQueryOutcome,
      tlsWrapFailurePostCloseOutcome,
      tlsWrapFailureCloseCode,
    ] = await Promise.all([
      activeQueryOutcomePromise,
      postCloseOutcomePromise,
      closeOutcomePromise,
    ]);
    const tlsWrapFailureBackendCountsAfterClose = [
      await connectionCount(control, subjectName),
    ];
    await waitMilliseconds(globalThis.setTimeout, 100);
    tlsWrapFailureBackendCountsAfterClose.push(
      await connectionCount(control, subjectName),
    );

    return {
      tlsWrapFailureActiveQueryOutcome,
      tlsWrapFailureBackendCountsAfterClose,
      tlsWrapFailureCloseCode,
      tlsWrapFailureCloseSettledBeforeRawTransportClose,
      tlsWrapFailurePostCloseOutcome,
      tlsWrapFailureRawTransportClosed: rawTransportClosed,
      tlsWrapFailureSubjectBackendCountBeforeRawTransportClose,
    };
  } finally {
    if (!rawTransport.destroyed) rawTransport.destroy();
    releaseRawTransport();
    Reflect.set(tls, 'connect', originalTlsConnect);
    await cleanupDirectSubject(subject, control, subjectName);
  }
}

async function tlsCancelTransportErrorProbe(
  databaseUrl: URL,
  runId: string,
): Promise<
  Pick<
    ProbeEvidence,
    | 'tlsTransportErrorActiveQueryOutcome'
    | 'tlsTransportErrorBackendCountsAfterClose'
    | 'tlsTransportErrorCloseCode'
    | 'tlsTransportErrorCloseSettledBeforeTransportClose'
    | 'tlsTransportErrorPostCloseOutcome'
    | 'tlsTransportErrorSubjectBackendCountBeforeTransportClose'
    | 'tlsTransportErrorTransportClosed'
  >
> {
  const subjectName = applicationName(runId, 'tls', 'err-subject');
  const control = openControl(
    databaseUrl,
    applicationName(runId, 'tls', 'err-control'),
  );
  const subjectUrl = new URL(databaseUrl);
  subjectUrl.searchParams.set('application_name', subjectName);
  const subject = postgres(subjectUrl.toString(), {
    connect_timeout: 2,
    max: 1,
  });
  const originalTlsConnect = tls.connect;
  let rawResponseSent = false;
  const rawTransport = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
      if (!rawResponseSent) {
        rawResponseSent = true;
        setTimeout(() => rawTransport.emit('data', Buffer.from([83])), 0);
      }
    },
  });
  let transportErrorEmitted = false;
  let transportClosed = false;
  const errorTransport = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  Reflect.defineProperty(errorTransport, 'destroyed', {
    configurable: true,
    get: () => transportErrorEmitted,
  });
  Reflect.defineProperty(errorTransport, 'readyState', {
    configurable: true,
    get: () => (transportErrorEmitted ? 'closed' : 'open'),
  });
  const closeErrorTransport = () => {
    if (transportClosed) return;
    transportClosed = true;
    errorTransport.emit('close', true);
  };

  try {
    isolatedProbeStage = 'tls-transport-error-starting';
    await subject`select 1::integer as value`;
    const activeQueryOutcomePromise = queryOutcome(
      subject`select pg_sleep(${TLS_SUBJECT_SLEEP_SECONDS})`,
    );
    await waitForActiveBackend(control, subjectName);

    Reflect.set(subject.options, 'ssl', 'require');
    Reflect.set(subject.options, 'socket', async () => rawTransport);
    Reflect.set(tls, 'connect', () => {
      setTimeout(() => {
        transportErrorEmitted = true;
        const error = new Error('Synthetic cancellation transport error.');
        Reflect.set(error, 'code', 'SYNTHETIC_CANCEL_TRANSPORT_ERROR');
        errorTransport.emit('error', error);
      }, 0);
      return errorTransport;
    });

    isolatedProbeStage = 'tls-transport-error-closing';
    let closeSettled = false;
    const closeOutcomePromise = Promise.resolve(
      subject.end({ timeout: 0 }),
    ).then(
      () => {
        closeSettled = true;
        return 'unexpected' as const;
      },
      (error: unknown) => {
        closeSettled = true;
        return safeErrorCode(error) === 'SYNTHETIC_CANCEL_TRANSPORT_ERROR'
          ? ('SYNTHETIC_CANCEL_TRANSPORT_ERROR' as const)
          : ('unexpected' as const);
      },
    );
    const postCloseOutcomePromise = queryOutcome(
      subject`select 130::integer as value`,
    );
    await waitForCondition(
      () => transportErrorEmitted,
      globalThis.setTimeout,
      'the synthetic cancellation transport error',
      1_000,
    );
    await waitForCondition(
      () => connectionCount(control, subjectName).then((count) => count === 0),
      globalThis.setTimeout,
      'the errored TLS close-probe subject backend to leave',
      2_500,
    );
    const tlsTransportErrorSubjectBackendCountBeforeTransportClose =
      await connectionCount(control, subjectName);
    const tlsTransportErrorCloseSettledBeforeTransportClose = closeSettled;
    closeErrorTransport();
    await waitForCondition(
      () => closeSettled,
      globalThis.setTimeout,
      'the errored TLS close promise to settle after transport close',
      1_000,
    );
    const [
      tlsTransportErrorActiveQueryOutcome,
      tlsTransportErrorPostCloseOutcome,
      tlsTransportErrorCloseCode,
    ] = await Promise.all([
      activeQueryOutcomePromise,
      postCloseOutcomePromise,
      closeOutcomePromise,
    ]);
    const tlsTransportErrorBackendCountsAfterClose = [
      await connectionCount(control, subjectName),
    ];
    await waitMilliseconds(globalThis.setTimeout, 100);
    tlsTransportErrorBackendCountsAfterClose.push(
      await connectionCount(control, subjectName),
    );

    return {
      tlsTransportErrorActiveQueryOutcome,
      tlsTransportErrorBackendCountsAfterClose,
      tlsTransportErrorCloseCode,
      tlsTransportErrorCloseSettledBeforeTransportClose,
      tlsTransportErrorPostCloseOutcome,
      tlsTransportErrorSubjectBackendCountBeforeTransportClose,
      tlsTransportErrorTransportClosed: transportClosed,
    };
  } finally {
    closeErrorTransport();
    Reflect.set(tls, 'connect', originalTlsConnect);
    await cleanupDirectSubject(subject, control, subjectName);
  }
}

async function queuedReconnectProbe(
  databaseUrl: URL,
  runId: string,
): Promise<
  Pick<
    ProbeEvidence,
    | 'queuedBackendCountsAfterClose'
    | 'queuedClosePromiseReused'
    | 'queuedConnectCallbacksAfterObservation'
    | 'queuedConnectCallbacksAtInvocation'
    | 'queuedPendingFulfillmentsAfterObservation'
    | 'queuedPendingFulfillmentsAtInvocation'
    | 'queuedPendingOutcome'
    | 'queuedPostCloseOutcome'
    | 'queuedReconnectTimerClearedAtInvocation'
    | 'queuedReconnectDurations'
  >
> {
  const subjectName = applicationName(runId, 'queued', 'subject');
  const control = openControl(
    databaseUrl,
    applicationName(runId, 'queued', 'control'),
  );
  const subject = openSubject(databaseUrl, subjectName);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const reconnectDurations: number[] = [];
  let connectCallbacks = 0;
  let pendingFulfillments = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimerCleared = false;
  let timerInstrumented = false;
  let evidence:
    | Pick<
        ProbeEvidence,
        | 'queuedBackendCountsAfterClose'
        | 'queuedClosePromiseReused'
        | 'queuedConnectCallbacksAfterObservation'
        | 'queuedConnectCallbacksAtInvocation'
        | 'queuedPendingFulfillmentsAfterObservation'
        | 'queuedPendingFulfillmentsAtInvocation'
        | 'queuedPendingOutcome'
        | 'queuedPostCloseOutcome'
        | 'queuedReconnectTimerClearedAtInvocation'
        | 'queuedReconnectDurations'
      >
    | undefined;
  let primaryError: unknown;

  try {
    await subject.db.execute(sql`select 1::integer as value`);
    const subjectBackendPid = await backendPid(control, subjectName);

    const [termination] = await control<{ terminated: boolean }[]>`
      select pg_terminate_backend(${subjectBackendPid}) as terminated
    `;
    if (termination?.terminated !== true) {
      throw new Error('The queued close-probe backend was not terminated.');
    }
    await waitForCondition(
      () => connectionCount(control, subjectName).then((count) => count === 0),
      originalSetTimeout,
      'the terminated queued close-probe backend to disappear',
    );
    await waitMilliseconds(originalSetTimeout, 20);

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
        reconnectTimer = originalSetTimeout(
          (...callbackArguments: unknown[]) => {
            connectCallbacks += 1;
            Reflect.apply(handler, undefined, callbackArguments);
          },
          RECONNECT_DELAY_MS,
          ...arguments_,
        );
        return reconnectTimer;
      }
      return originalSetTimeout(handler, timeout, ...arguments_);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer) => {
      if (timer === reconnectTimer) reconnectTimerCleared = true;
      Reflect.apply(originalClearTimeout, globalThis, [timer]);
    }) as typeof clearTimeout;
    timerInstrumented = true;

    const pendingOutcomePromise = queryOutcome(
      subject.db.execute(sql`select 130::integer as value`),
    ).then((outcome) => {
      if (outcome === 'fulfilled') pendingFulfillments += 1;
      return outcome;
    });
    await waitForCondition(
      () => reconnectDurations.length > 0,
      originalSetTimeout,
      'the queued reconnect timer to be scheduled',
    );
    if (connectCallbacks !== 0 || pendingFulfillments !== 0) {
      throw new Error(
        'The queued reconnect boundary was not observed in time.',
      );
    }

    const firstClose = subject.close();
    const queuedReconnectTimerClearedAtInvocation = reconnectTimerCleared;
    const queuedConnectCallbacksAtInvocation = connectCallbacks;
    const queuedPendingFulfillmentsAtInvocation = pendingFulfillments;
    const secondClose = subject.close();
    const postCloseOutcomePromise = queryOutcome(
      subject.db.execute(sql`select 131::integer as value`),
    );

    const backendCountsAfterClose = [
      await connectionCount(control, subjectName),
    ];
    await waitMilliseconds(originalSetTimeout, OBSERVATION_MS / 2);
    backendCountsAfterClose.push(await connectionCount(control, subjectName));
    await waitMilliseconds(originalSetTimeout, OBSERVATION_MS / 2);
    backendCountsAfterClose.push(await connectionCount(control, subjectName));

    const [queuedPendingOutcome, queuedPostCloseOutcome] = await Promise.all([
      pendingOutcomePromise,
      postCloseOutcomePromise,
      firstClose,
      secondClose,
    ]);
    evidence = {
      queuedBackendCountsAfterClose: backendCountsAfterClose,
      queuedClosePromiseReused: firstClose === secondClose,
      queuedConnectCallbacksAfterObservation: connectCallbacks,
      queuedConnectCallbacksAtInvocation,
      queuedPendingFulfillmentsAfterObservation: pendingFulfillments,
      queuedPendingFulfillmentsAtInvocation,
      queuedPendingOutcome,
      queuedPostCloseOutcome,
      queuedReconnectTimerClearedAtInvocation,
      queuedReconnectDurations: [...reconnectDurations],
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (timerInstrumented) {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  }

  await checkedSubjectCleanup(
    primaryError,
    subject,
    control,
    subjectName,
    'queued',
  );
  if (evidence === undefined) {
    throw new Error('The queued close-probe evidence was unavailable.');
  }
  return evidence;
}

async function runIsolatedProbe(): Promise<ProbeEvidence> {
  const databaseUrl = syntheticLoopbackDatabaseUrl(
    process.env[PROBE_DATABASE_VARIABLE],
  );
  const runId = validatedRunId(process.env[PROBE_RUN_VARIABLE]);
  isolatedProbeStage = 'opening';
  const opening = await openingSocketCloseProbe();
  isolatedProbeStage = 'idle';
  const idle = await idleCloseProbe(databaseUrl, runId);
  isolatedProbeStage = 'active';
  const active = await activeCloseProbe(databaseUrl, runId);
  isolatedProbeStage = 'cancel-failure';
  const cancelFailure = await cancelFailureCloseProbe(databaseUrl, runId);
  isolatedProbeStage = 'tls';
  const tlsEvidence = await tlsCancelTransportProbe(databaseUrl, runId);
  isolatedProbeStage = 'tls-transport-error';
  const tlsTransportErrorEvidence = await tlsCancelTransportErrorProbe(
    databaseUrl,
    runId,
  );
  isolatedProbeStage = 'tls-wrap-failure';
  const tlsWrapFailureEvidence = await tlsCancelWrapFailureProbe(
    databaseUrl,
    runId,
  );
  isolatedProbeStage = 'queued';
  const queued = await queuedReconnectProbe(databaseUrl, runId);
  isolatedProbeStage = 'complete';
  return {
    ...active,
    ...cancelFailure,
    ...idle,
    ...opening,
    ...queued,
    ...tlsEvidence,
    ...tlsTransportErrorEvidence,
    ...tlsWrapFailureEvidence,
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
      application_name: `issue-130-${runId}-parent-audit`,
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
            reject(new Error('The isolated child residue audit timed out.'));
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
        const prefix = `issue-130-${runId}-%`;
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
              'An exact child backend could not be terminated during audit cleanup.',
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
          'the isolated child PostgreSQL sessions to close',
          2_000,
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
    throw new Error('The isolated child PostgreSQL residue audit failed.');
  }
}

async function runProbeChild(databaseUrl: URL): Promise<ProbeEvidence> {
  const runId = randomUUID();
  const probe = Bun.spawn({
    cmd: [process.execPath, fileURLToPath(import.meta.url)],
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      TMPDIR: tmpdir(),
      [PROBE_DATABASE_VARIABLE]: databaseUrl.toString(),
      [PROBE_MODE_VARIABLE]: PROBE_MODE_VALUE,
      [PROBE_RUN_VARIABLE]: runId,
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
        'The isolated close-probe exit could not be observed.',
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
            'The isolated close probe did not terminate.',
          );
        }
      }
    }
    if (exited) {
      try {
        exitCode = await exitedPromise;
      } catch {
        terminationError ??= new Error(
          'The isolated close-probe exit could not be awaited.',
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
        'The isolated close-probe output drain failed.',
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
          'The isolated close-probe output did not drain.',
        );
      }
    }

    try {
      await auditChildSessions(databaseUrl, runId);
    } catch {
      terminationError ??= new Error(
        'The isolated close-probe residue audit failed.',
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
    throw new Error('The isolated PostgreSQL close probe failed closed.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(stdout.bytes));
  } catch {
    throw new Error('The isolated close probe returned invalid evidence.');
  }
  const evidence = ProbeEvidenceSchema.safeParse(parsed);
  if (!evidence.success) {
    throw new Error('The isolated close probe returned invalid evidence.');
  }
  return evidence.data;
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
  describeWithDatabase('PostgreSQL close invocation boundary', () => {
    test('prevents idle, active, and queued reconnect work after close begins', async () => {
      const databaseUrl = syntheticLoopbackDatabaseUrl(
        configuredTestDatabaseUrl,
      );
      expect(databaseUrl.hostname).not.toBe('localhost');
      const evidence = await runProbeChild(databaseUrl);

      expect(evidence.openingCloseSettledBeforeSocketCreation).toBe(false);
      expect(evidence.openingCloseResolvedAfterSocketClose).toBe(true);
      expect(evidence.openingQueryOutcome).toBe('CONNECTION_DESTROYED');

      expect(evidence.idleClosePromiseReused).toBe(true);
      expect(evidence.idlePostCloseOutcome).toBe('CONNECTION_ENDED');
      expect(evidence.idleBackendCountsAfterClose).toEqual([0, 0]);

      expect(evidence.queuedReconnectDurations.length).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        evidence.queuedReconnectDurations.every((duration) => duration >= 0),
      ).toBe(true);
      expect(evidence.queuedConnectCallbacksAtInvocation).toBe(0);
      expect(evidence.queuedPendingFulfillmentsAtInvocation).toBe(0);
      expect(evidence.queuedClosePromiseReused).toBe(true);
      expect(evidence.queuedReconnectTimerClearedAtInvocation).toBe(true);
      expect(evidence.queuedConnectCallbacksAfterObservation).toBe(0);
      expect(evidence.queuedPendingFulfillmentsAfterObservation).toBe(0);
      expect(['CONNECTION_DESTROYED', 'CONNECTION_ENDED']).toContain(
        evidence.queuedPendingOutcome,
      );
      expect(evidence.queuedPostCloseOutcome).toBe('CONNECTION_ENDED');
      expect(evidence.queuedBackendCountsAfterClose).toEqual([0, 0, 0]);

      expect(evidence.activeClosePromiseReused).toBe(true);
      expect(evidence.activeQueryOutcome).toBe('CONNECTION_DESTROYED');
      expect(evidence.activePostCloseOutcome).toBe('CONNECTION_ENDED');
      expect(evidence.activeCloseElapsedMs).toBeLessThan(1_000);
      expect(evidence.activeBackendCountsAfterClose).toEqual([0, 0]);

      expect(evidence.cancelFailureBackendCountAtCloseRejection).toBe(0);
      expect(evidence.cancelFailureBackendCountAfterCancelTimeout).toBe(1);
      expect(evidence.cancelFailureCloseSettledAfterCancelTimeout).toBe(false);
      expect(evidence.cancelFailureCloseSettledWhileBackendActive).toBe(false);
      expect(evidence.cancelFailureCloseCode).toBe('CONNECT_TIMEOUT');
      expect(evidence.cancelFailureQueuedOutcome).toBe('CONNECTION_DESTROYED');
      expect(evidence.cancelFailureQueuedSettledAtCloseRejection).toBe(true);
      expect(evidence.cancelFailureBackendCountsAfterClose).toEqual([0, 0]);

      expect(evidence.tlsCancelFrameWritten).toBe(true);
      expect(evidence.tlsActiveQueryOutcome).toBe('CONNECTION_DESTROYED');
      expect(evidence.tlsPostCloseOutcome).toBe('CONNECTION_ENDED');
      expect(evidence.tlsSubjectBackendCountBeforeFinalTransportClose).toBe(0);
      expect(evidence.tlsCloseSettledBeforeFinalTransportClose).toBe(false);
      expect(evidence.tlsFinalTransportClosed).toBe(true);

      expect(evidence.tlsTransportErrorActiveQueryOutcome).toBe(
        'CONNECTION_DESTROYED',
      );
      expect(evidence.tlsTransportErrorPostCloseOutcome).toBe(
        'CONNECTION_ENDED',
      );
      expect(evidence.tlsTransportErrorCloseCode).toBe(
        'SYNTHETIC_CANCEL_TRANSPORT_ERROR',
      );
      expect(
        evidence.tlsTransportErrorSubjectBackendCountBeforeTransportClose,
      ).toBe(0);
      expect(evidence.tlsTransportErrorCloseSettledBeforeTransportClose).toBe(
        false,
      );
      expect(evidence.tlsTransportErrorTransportClosed).toBe(true);
      expect(evidence.tlsTransportErrorBackendCountsAfterClose).toEqual([0, 0]);

      expect(evidence.tlsWrapFailureActiveQueryOutcome).toBe(
        'CONNECTION_DESTROYED',
      );
      expect(evidence.tlsWrapFailurePostCloseOutcome).toBe('CONNECTION_ENDED');
      expect(evidence.tlsWrapFailureCloseCode).toBe(
        'SYNTHETIC_TLS_WRAP_FAILURE',
      );
      expect(
        evidence.tlsWrapFailureSubjectBackendCountBeforeRawTransportClose,
      ).toBe(0);
      expect(evidence.tlsWrapFailureCloseSettledBeforeRawTransportClose).toBe(
        false,
      );
      expect(evidence.tlsWrapFailureRawTransportClosed).toBe(true);
      expect(evidence.tlsWrapFailureBackendCountsAfterClose).toEqual([0, 0]);
    });
  });
}
