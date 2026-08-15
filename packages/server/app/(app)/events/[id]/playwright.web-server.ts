import { spawn } from 'node:child_process';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dropOwnedEventRoomPlaywrightDatabase } from './playwright-database';
import {
  cleanupEventRoomPlaywrightRunAfterChildExit,
  cleanupInterruptedEventRoomPlaywrightCoordinator,
  EVENT_ROOM_PLAYWRIGHT_MINIMUM_CHALLENGE_PORT,
  EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV,
  finalizeEventRoomPlaywrightWebServer,
  hasEventRoomPlaywrightSupervisorStoppingMarker,
  readEventRoomPlaywrightWebServerIdentity,
  requireCurrentEventRoomPlaywrightGateHeartbeat,
  requireEventRoomPlaywrightRunContext,
  requireInheritedEventRoomPlaywrightRunContext,
  terminateInterruptedEventRoomPlaywrightWebServer,
  waitForEventRoomPlaywrightPortToClose,
  writeEventRoomPlaywrightCoordinatorIdentity,
  writeEventRoomPlaywrightGateHeartbeat,
  writeEventRoomPlaywrightSupervisorStopping,
  writeEventRoomPlaywrightWebServerIdentity,
  type EventRoomPlaywrightCoordinatorIdentity,
  type EventRoomPlaywrightRunContext,
  type EventRoomPlaywrightWebServerIdentity,
} from './test-database';

const NEXT_SHUTDOWN_TIMEOUT_MS = 5_000;
const SUPERVISOR_POLL_MS = 100;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const WEB_SERVER_CHALLENGE_TIMEOUT_MS = 750;
const WEB_SERVER_CHALLENGE_BYTES = 32;
const WEB_SERVER_CHALLENGE_LINE_LENGTH = WEB_SERVER_CHALLENGE_BYTES * 2 + 1;
const WEB_SERVER_CHALLENGE_PORT_ATTEMPTS = 20;
const scriptPath = fileURLToPath(import.meta.url);
export const EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_MODE_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_MODE';
export const EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_NONCE_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_NONCE';
export const EVENT_ROOM_PLAYWRIGHT_GATE_PID_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_GATE_PID';
export const EVENT_ROOM_PLAYWRIGHT_CONFIG_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_CONFIG';
export const EVENT_ROOM_PLAYWRIGHT_CWD_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_CWD';
export const EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_MODE_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_MODE';
export const EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_NONCE_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_NONCE';
export const EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PAUSE_HEARTBEAT_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PAUSE_HEARTBEAT';

interface DarwinProcessIdentity {
  readonly processGroupId: number;
  readonly startedAt: string;
  readonly command: string;
}

function exactProcessIdentityMatches(
  actual: DarwinProcessIdentity | null,
  expected: DarwinProcessIdentity,
): boolean {
  return (
    actual !== null &&
    actual.processGroupId === expected.processGroupId &&
    actual.startedAt === expected.startedAt &&
    sha256(actual.command) === sha256(expected.command)
  );
}

function isStaleGateHeartbeatError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message === 'The event-room Playwright gate heartbeat is stale.'
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface WebServerChallengeIdentity {
  readonly webServerPid: number;
  readonly processGroupId: number;
  readonly processStartedAt: string;
  readonly commandHash: string;
  readonly challengePort: number;
}

function webServerChallengeResponse(
  context: EventRoomPlaywrightRunContext,
  identity: WebServerChallengeIdentity,
  supervisorNonce: string,
  challenge: string,
): string {
  return createHmac('sha256', supervisorNonce)
    .update(
      JSON.stringify({
        kind: 'psd-eoc-event-room-playwright-web-server-challenge',
        version: 1,
        runId: context.runId,
        leaseOwnerPid: context.leaseOwnerPid,
        webServerPid: identity.webServerPid,
        processGroupId: identity.processGroupId,
        processStartedAt: identity.processStartedAt,
        commandHash: identity.commandHash,
        challengePort: identity.challengePort,
        supervisorNonceHash: sha256(supervisorNonce),
        challenge,
      }),
      'utf8',
    )
    .digest('hex');
}

function exactTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

async function startWebServerRunChallenge(
  context: EventRoomPlaywrightRunContext,
  identity: Omit<WebServerChallengeIdentity, 'challengePort'>,
  supervisorNonce: string,
  portSelectionAttempt = 1,
): Promise<number> {
  const challengePort = randomInt(
    EVENT_ROOM_PLAYWRIGHT_MINIMUM_CHALLENGE_PORT,
    65_536,
  );
  const server = createServer((socket) => {
    let request = '';
    let handled = false;
    const failClosed = () => {
      handled = true;
      socket.destroy();
    };
    socket.setEncoding('utf8');
    socket.setTimeout(WEB_SERVER_CHALLENGE_TIMEOUT_MS, failClosed);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      if (handled) return;
      request += chunk;
      if (request.length > WEB_SERVER_CHALLENGE_LINE_LENGTH) {
        failClosed();
        return;
      }
      if (!request.endsWith('\n')) return;
      if (!/^[0-9a-f]{64}\n$/u.test(request)) {
        failClosed();
        return;
      }
      handled = true;
      const challenge = request.slice(0, -1);
      const response = webServerChallengeResponse(
        context,
        { ...identity, challengePort },
        supervisorNonce,
        challenge,
      );
      socket.end(`${response}\n`);
    });
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const rejectStartup = (error: Error) => rejectListen(error);
      server.once('error', rejectStartup);
      server.listen(challengePort, '127.0.0.1', () => {
        server.off('error', rejectStartup);
        server.on('error', () => undefined);
        server.unref();
        resolveListen();
      });
    });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE' &&
      portSelectionAttempt < WEB_SERVER_CHALLENGE_PORT_ATTEMPTS
    ) {
      return startWebServerRunChallenge(
        context,
        identity,
        supervisorNonce,
        portSelectionAttempt + 1,
      );
    }
    throw error;
  }
  return challengePort;
}

function proveWebServerRunIdentity(
  context: EventRoomPlaywrightRunContext,
  identity: EventRoomPlaywrightWebServerIdentity,
  supervisorNonce: string,
): Promise<boolean> {
  const challenge = randomBytes(WEB_SERVER_CHALLENGE_BYTES).toString('hex');
  const expected = `${webServerChallengeResponse(
    context,
    identity,
    supervisorNonce,
    challenge,
  )}\n`;
  return new Promise((resolveProof) => {
    const socket = createConnection({
      host: '127.0.0.1',
      port: identity.challengePort,
    });
    let response = '';
    let settled = false;
    const settle = (proven: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProof(proven);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${challenge}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.length > WEB_SERVER_CHALLENGE_LINE_LENGTH) {
        settle(false);
        return;
      }
      if (response.endsWith('\n')) settle(exactTextEqual(response, expected));
    });
    socket.once('end', () => settle(false));
    socket.once('error', () => settle(false));
    socket.setTimeout(WEB_SERVER_CHALLENGE_TIMEOUT_MS, () => settle(false));
  });
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

async function inspectDarwinProcess(
  pid: number,
): Promise<DarwinProcessIdentity | null> {
  const child = Bun.spawn(
    [
      '/bin/ps',
      '-ww',
      '-p',
      String(pid),
      '-o',
      'pgid=',
      '-o',
      'lstart=',
      '-o',
      'command=',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode === 1 && stdout.trim().length === 0) return null;
  if (exitCode !== 0) {
    throw new Error(`Process identity inspection failed: ${stderr.trim()}`);
  }
  const match = stdout.trim().match(/^(\d+)\s+(.{24})\s+([\s\S]+)$/u);
  if (match === null) {
    throw new Error('Process identity inspection was ambiguous.');
  }
  const processGroupId = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('Process group identity was invalid.');
  }
  return {
    processGroupId,
    startedAt: match[2]!,
    command: match[3]!,
  };
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

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function forwardOutput(
  stream: NodeJS.ReadableStream | null,
  destination: NodeJS.WritableStream,
  recordError: (message: string) => void,
): void {
  stream?.on('error', (error: Error) => {
    recordError(`Supervised output source failed: ${error.message}`);
  });
  stream?.on('data', (chunk: Uint8Array | string) => {
    try {
      destination.write(chunk);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        recordError(
          `Supervised output forwarding failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  });
  destination.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      recordError(`Supervised output destination failed: ${error.message}`);
    }
  });
}

async function waitForCoordinatorIdentity(
  coordinatorPid: number,
  nonce: string,
): Promise<DarwinProcessIdentity> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const identity = await inspectDarwinProcess(coordinatorPid);
    if (
      identity !== null &&
      identity.processGroupId === coordinatorPid &&
      identity.command.includes(nonce)
    ) {
      return identity;
    }
    await Bun.sleep(25);
  }
  throw new Error('The dedicated Playwright process group was not proven.');
}

function serializeSupervisorReady(
  context: EventRoomPlaywrightRunContext,
  identity: EventRoomPlaywrightCoordinatorIdentity,
): string {
  return JSON.stringify({
    kind: 'psd-eoc-event-room-playwright-supervisor-ready',
    version: 1,
    runId: context.runId,
    supervisorPid: process.pid,
    coordinatorPid: identity.coordinatorPid,
    processGroupId: identity.processGroupId,
    processStartedAt: identity.processStartedAt,
    commandHash: identity.commandHash,
  });
}

function coordinatorChildExitMarker(
  context: EventRoomPlaywrightRunContext,
  coordinatorPid: number,
  nonce: string,
  exitCode: number,
): string {
  return JSON.stringify({
    kind: 'psd-eoc-event-room-playwright-coordinator-child-exit',
    version: 1,
    runId: context.runId,
    leaseOwnerPid: context.leaseOwnerPid,
    coordinatorPid,
    supervisorNonceHash: sha256(nonce),
    exitCode,
  });
}

function readCoordinatorChildExit(
  context: EventRoomPlaywrightRunContext,
  coordinatorPid: number,
  nonce: string,
): number | null {
  let serialized: string;
  try {
    serialized = readFileSync(context.coordinatorChildExitPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      'The Playwright coordinator child-exit marker is invalid.',
      {
        cause: error,
      },
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('exitCode' in parsed) ||
    typeof parsed.exitCode !== 'number' ||
    !Number.isSafeInteger(parsed.exitCode) ||
    parsed.exitCode < 0 ||
    serialized !==
      coordinatorChildExitMarker(
        context,
        coordinatorPid,
        nonce,
        parsed.exitCode,
      )
  ) {
    throw new Error(
      'The Playwright coordinator child-exit marker was altered.',
    );
  }
  return parsed.exitCode;
}

async function coordinateWorkload(nonce: string): Promise<void> {
  const context = requireInheritedEventRoomPlaywrightRunContext();
  if (nonce.length < 32) throw new Error('The coordinator nonce is missing.');
  const synthetic = process.env.PSD_EOC_EVENT_ROOM_SYNTHETIC_COMMAND === 'true';
  const playwrightConfig = process.env[EVENT_ROOM_PLAYWRIGHT_CONFIG_ENV];
  if (!synthetic && playwrightConfig === undefined) {
    throw new Error('The Playwright coordinator config path is missing.');
  }
  const command = synthetic
    ? [process.execPath, scriptPath, '--synthetic-workload', nonce]
    : [
        process.execPath,
        'x',
        'playwright',
        'test',
        '--config',
        playwrightConfig!,
      ];
  const workload = spawn(command[0]!, command.slice(1), {
    cwd: process.env[EVENT_ROOM_PLAYWRIGHT_CWD_ENV],
    detached: false,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let workloadExited = false;
  // The supervisor signals this exact process group, so descendants receive
  // the same signal directly. Keep the identity anchor alive while they exit;
  // never re-signal a child PID that could already have been reused.
  const holdAnchor = () => undefined;
  const releaseAnchor = () => {
    if (!workloadExited) {
      throw new Error(
        'The Playwright coordinator anchor was released before its child exited.',
      );
    }
    process.exit(0);
  };
  process.on('SIGINT', holdAnchor);
  process.on('SIGTERM', holdAnchor);
  process.once('SIGUSR1', releaseAnchor);
  try {
    const exitCode = await new Promise<number>((resolveExit) => {
      workload.once('exit', (code, signal) => {
        resolveExit(code ?? (signal === null ? 1 : 128));
      });
      workload.once('error', (error) => {
        console.error(
          new Error('The supervised Playwright workload failed to spawn.', {
            cause: error,
          }),
        );
        resolveExit(1);
      });
    });
    workloadExited = true;
    writeFileSync(
      context.coordinatorChildExitPath,
      coordinatorChildExitMarker(context, process.pid, nonce, exitCode),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await new Promise<void>(() => undefined);
  } finally {
    process.off('SIGINT', holdAnchor);
    process.off('SIGTERM', holdAnchor);
    process.off('SIGUSR1', releaseAnchor);
  }
}

async function superviseCoordinator(): Promise<void> {
  const context = requireInheritedEventRoomPlaywrightRunContext();
  const nonce = process.env[EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_NONCE_ENV];
  if (nonce === undefined || nonce.length < 32) {
    throw new Error('The Playwright supervisor nonce is missing.');
  }
  const gatePid = parsePositiveInteger(
    process.env[EVENT_ROOM_PLAYWRIGHT_GATE_PID_ENV],
    'The Playwright gate PID',
  );
  requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
  // The fresh nonce-bound heartbeat authenticates the parent PID before this
  // immutable OS snapshot is accepted as liveness evidence. The snapshot is
  // never termination authority; coordinator and web-server signals still
  // require their own exact run markers and process proofs below.
  const gateProcessIdentity = await inspectDarwinProcess(gatePid);
  if (gateProcessIdentity === null) {
    throw new Error(
      'The Playwright gate process identity is missing at supervisor startup.',
    );
  }

  const playwrightConfig = process.env[EVENT_ROOM_PLAYWRIGHT_CONFIG_ENV];
  if (
    process.env.PSD_EOC_EVENT_ROOM_SYNTHETIC_COMMAND !== 'true' &&
    playwrightConfig === undefined
  ) {
    throw new Error('The Playwright supervisor config path is missing.');
  }
  const command = [process.execPath, scriptPath, '--coordinate', nonce];
  const coordinator = spawn(command[0]!, command.slice(1), {
    cwd: process.env[EVENT_ROOM_PLAYWRIGHT_CWD_ENV],
    detached: true,
    env: {
      ...process.env,
      [EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_MODE_ENV]: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputErrors: string[] = [];
  const recordOutputError = (message: string) => outputErrors.push(message);
  forwardOutput(coordinator.stdout, process.stdout, recordOutputError);
  forwardOutput(coordinator.stderr, process.stderr, recordOutputError);

  let identity: EventRoomPlaywrightCoordinatorIdentity | undefined;
  let primaryError: Error | null = null;
  let signalExitCode: number | null = null;
  let coordinatorAnchorExit: number | null = null;
  let workloadExit: number | null = null;
  let parentHeartbeatStopped = false;
  const coordinatorExited = new Promise<number>((resolveExit) => {
    coordinator.once('exit', (code, signal) => {
      resolveExit(code ?? (signal === null ? 1 : 128));
    });
    coordinator.once('error', (error) => {
      primaryError = new Error('The Playwright coordinator failed to spawn.', {
        cause: error,
      });
      resolveExit(1);
    });
  });
  const requestCleanup = (signal: NodeJS.Signals) => {
    signalExitCode = signal === 'SIGINT' ? 130 : 143;
    parentHeartbeatStopped = true;
  };
  const interrupt = () => requestCleanup('SIGINT');
  const terminate = () => requestCleanup('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  try {
    const observed = await waitForCoordinatorIdentity(coordinator.pid!, nonce);
    identity = writeEventRoomPlaywrightCoordinatorIdentity(
      context,
      {
        coordinatorPid: coordinator.pid!,
        processGroupId: observed.processGroupId,
        processStartedAt: observed.startedAt,
        commandHash: sha256(observed.command),
      },
      nonce,
    );
    writeFileSync(
      context.supervisorReadyPath,
      serializeSupervisorReady(context, identity),
      {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      },
    );

    while (workloadExit === null && !parentHeartbeatStopped) {
      workloadExit = readCoordinatorChildExit(
        context,
        identity.coordinatorPid,
        nonce,
      );
      if (workloadExit !== null) break;
      const outcome = await Promise.race([
        coordinatorExited.then((code) => ({ kind: 'exit' as const, code })),
        Bun.sleep(SUPERVISOR_POLL_MS).then(() => ({ kind: 'poll' as const })),
      ]);
      if (outcome.kind === 'exit') {
        coordinatorAnchorExit = outcome.code;
        primaryError = new Error(
          'The Playwright coordinator anchor exited before reporting its child.',
        );
        break;
      }
      try {
        requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
      } catch (error) {
        // Hosted runners can delay both 250 ms heartbeat writes and this poll
        // beyond the strict two-second freshness window. Only a stale marker
        // gets this liveness recheck: missing or altered evidence still fails
        // closed, while an exact live parent cannot be mistaken for death.
        if (
          isStaleGateHeartbeatError(error) &&
          exactProcessIdentityMatches(
            await inspectDarwinProcess(gatePid),
            gateProcessIdentity,
          )
        ) {
          continue;
        }
        parentHeartbeatStopped = true;
        primaryError = new Error(
          'The event-room Playwright gate heartbeat stopped.',
          { cause: error },
        );
      }
    }
  } catch (error) {
    primaryError ??= error instanceof Error ? error : new Error(String(error));
    parentHeartbeatStopped = true;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }

  let cleanupError: Error | null = null;
  try {
    writeEventRoomPlaywrightSupervisorStopping(context, process.pid, nonce);
    await Bun.sleep(750);
    const operations = {
      inspectProcess: inspectDarwinProcess,
      signalProcessGroup,
      signalProcess,
      processGroupMembers,
      proveWebServerRunIdentity,
      waitForPortClose: waitForEventRoomPlaywrightPortToClose,
      dropOwnedDatabase: dropOwnedEventRoomPlaywrightDatabase,
    };
    if (identity === undefined) {
      const observed = await inspectDarwinProcess(coordinator.pid!);
      if (observed !== null) {
        throw new Error(
          'The Playwright supervisor refused cleanup without its immutable coordinator identity.',
        );
      }
      await cleanupEventRoomPlaywrightRunAfterChildExit(context);
      await dropOwnedEventRoomPlaywrightDatabase(context);
    } else {
      const webServerIdentity = readEventRoomPlaywrightWebServerIdentity(
        context,
        nonce,
      );
      if (webServerIdentity !== null) {
        const webServerProcess = await inspectDarwinProcess(
          webServerIdentity.webServerPid,
        );
        const webServerGroup = await processGroupMembers(
          webServerIdentity.processGroupId,
        );
        if (webServerProcess !== null) {
          await terminateInterruptedEventRoomPlaywrightWebServer(
            context,
            webServerIdentity,
            nonce,
            operations,
          );
        } else if (webServerGroup.length > 0) {
          throw new Error(
            'The event-room Playwright web-server leader disappeared while its process group remained.',
          );
        }
      }
      await cleanupInterruptedEventRoomPlaywrightCoordinator(
        context,
        identity,
        nonce,
        operations,
      );
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }

  const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (coordinatorAnchorExit === null && Date.now() < exitDeadline) {
    const outcome = await Promise.race([
      coordinatorExited.then((code) => ({ done: true as const, code })),
      Bun.sleep(25).then(() => ({ done: false as const })),
    ]);
    if (outcome.done) coordinatorAnchorExit = outcome.code;
  }
  if (coordinatorAnchorExit === null) {
    cleanupError ??= new Error(
      'The Playwright coordinator exit promise exceeded its cleanup deadline.',
    );
  }
  if (outputErrors.length > 0) {
    const outputError = new Error(outputErrors.join('\n'));
    if (primaryError === null) primaryError = outputError;
    else if (cleanupError === null) cleanupError = outputError;
  }
  if (primaryError !== null || cleanupError !== null) {
    const errors = [primaryError, cleanupError].filter(
      (error): error is Error => error !== null,
    );
    console.error(
      new AggregateError(
        errors,
        primaryError?.message ?? 'Event-room Playwright cleanup failed.',
      ),
    );
  }
  const reportedExitCode = signalExitCode ?? workloadExit;
  process.exitCode =
    primaryError !== null || cleanupError !== null
      ? reportedExitCode !== null && reportedExitCode !== 0
        ? reportedExitCode
        : 1
      : (reportedExitCode ?? 0);
}

export function createEventRoomPlaywrightSupervisorEnvironment(
  contextValue: unknown,
  baseEnvironment: NodeJS.ProcessEnv,
  nonce: string,
  gatePid: number,
  playwrightConfig: string,
  cwd: string,
): NodeJS.ProcessEnv {
  const context = requireEventRoomPlaywrightRunContext(contextValue);
  if (nonce.length < 32 || !Number.isSafeInteger(gatePid) || gatePid <= 0) {
    throw new Error('The Playwright supervisor launch identity is invalid.');
  }
  return {
    ...baseEnvironment,
    [EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV]: JSON.stringify(context),
    [EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_MODE_ENV]: 'true',
    [EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_NONCE_ENV]: nonce,
    [EVENT_ROOM_PLAYWRIGHT_GATE_PID_ENV]: String(gatePid),
    [EVENT_ROOM_PLAYWRIGHT_CONFIG_ENV]: playwrightConfig,
    [EVENT_ROOM_PLAYWRIGHT_CWD_ENV]: cwd,
  };
}

async function runSyntheticGateParent(): Promise<void> {
  const context = requireInheritedEventRoomPlaywrightRunContext();
  const nonce =
    process.env[EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_NONCE_ENV] ??
    randomBytes(32).toString('hex');
  writeEventRoomPlaywrightGateHeartbeat(context, process.pid, nonce);
  const environment = createEventRoomPlaywrightSupervisorEnvironment(
    context,
    process.env,
    nonce,
    process.pid,
    process.env[EVENT_ROOM_PLAYWRIGHT_CONFIG_ENV] ?? 'synthetic-unused',
    process.env[EVENT_ROOM_PLAYWRIGHT_CWD_ENV] ?? process.cwd(),
  );
  environment.PSD_EOC_EVENT_ROOM_SYNTHETIC_COMMAND = 'true';
  environment[EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_MODE_ENV] = 'false';
  const supervisor = Bun.spawn([process.execPath, scriptPath], {
    cwd: process.env[EVENT_ROOM_PLAYWRIGHT_CWD_ENV] ?? process.cwd(),
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const heartbeat = setInterval(() => {
    if (
      hasEventRoomPlaywrightSupervisorStoppingMarker(
        context,
        supervisor.pid,
        nonce,
      )
    ) {
      clearInterval(heartbeat);
      return;
    }
    writeEventRoomPlaywrightGateHeartbeat(context, process.pid, nonce);
  }, 250);
  const pauseHeartbeat = () => {
    clearInterval(heartbeat);
    writeFileSync(
      join(
        context.supervisionDirectory,
        'synthetic-parent-heartbeat-paused.json',
      ),
      JSON.stringify({
        kind: 'psd-eoc-event-room-playwright-synthetic-heartbeat-paused',
        version: 1,
        runId: context.runId,
        gatePid: process.pid,
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  };
  const pauseHeartbeatTimer =
    process.env[EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PAUSE_HEARTBEAT_ENV] === 'true'
      ? setTimeout(pauseHeartbeat, 500)
      : undefined;
  try {
    process.exitCode = await supervisor.exited;
  } finally {
    clearInterval(heartbeat);
    if (pauseHeartbeatTimer !== undefined) clearTimeout(pauseHeartbeatTimer);
  }
}

async function syntheticWorkload(nonce: string): Promise<void> {
  const context = requireInheritedEventRoomPlaywrightRunContext();
  const artifactPath = join(
    context.outputDirectory,
    'synthetic-browser-artifact',
  );
  const browser = spawn(
    process.execPath,
    [scriptPath, '--synthetic-descendant', nonce],
    { env: process.env, stdio: 'ignore' },
  );
  mkdirSync(context.outputDirectory, { mode: 0o700, recursive: true });
  spawn(process.execPath, [scriptPath, '--synthetic-web-server', nonce], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  }).unref();
  writeFileSync(artifactPath, String(browser.pid), { mode: 0o600 });
  const stop = () => {
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>(() => undefined);
}

async function syntheticWebServer(nonce: string): Promise<void> {
  const context = requireInheritedEventRoomPlaywrightRunContext();
  const gatePid = parsePositiveInteger(
    process.env[EVENT_ROOM_PLAYWRIGHT_GATE_PID_ENV],
    'The synthetic web-server gate PID',
  );
  requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
  const identity = await inspectDarwinProcess(process.pid);
  if (identity === null || identity.processGroupId !== process.pid) {
    throw new Error(
      'The synthetic web server did not receive a dedicated process group.',
    );
  }
  requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
  const commandHash = sha256(identity.command);
  const challengePort = await startWebServerRunChallenge(
    context,
    {
      webServerPid: process.pid,
      processGroupId: identity.processGroupId,
      processStartedAt: identity.startedAt,
      commandHash,
    },
    nonce,
  );
  requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
  writeEventRoomPlaywrightWebServerIdentity(
    context,
    {
      webServerPid: process.pid,
      processGroupId: identity.processGroupId,
      processStartedAt: identity.startedAt,
      commandHash,
      challengePort,
    },
    nonce,
  );
  const next = spawn(
    process.execPath,
    [scriptPath, '--synthetic-descendant', nonce],
    { env: process.env, stdio: 'ignore' },
  );
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(context.appPort, '127.0.0.1', resolveListen);
  });
  writeFileSync(
    join(context.outputDirectory, 'synthetic-web-server-ready.json'),
    JSON.stringify({
      webServerPid: process.pid,
      processGroupId: identity.processGroupId,
      nextPid: next.pid,
    }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  let nextExited = next.exitCode !== null || next.signalCode !== null;
  let serverClosed = false;
  const finishStop = () => {
    if (nextExited && serverClosed) process.exit(0);
  };
  next.once('exit', () => {
    nextExited = true;
    finishStop();
  });
  const stop = () => {
    server.close(() => {
      serverClosed = true;
      finishStop();
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>(() => undefined);
}

async function syntheticDescendant(nonce: string): Promise<void> {
  if (nonce.length < 32) throw new Error('Synthetic descendant nonce missing.');
  process.once('SIGTERM', () => process.exit(0));
  process.once('SIGINT', () => process.exit(0));
  await new Promise<void>(() => undefined);
}

async function runNextWebServer(): Promise<void> {
  const context = requireInheritedEventRoomPlaywrightRunContext();
  if (
    realpathSync(resolve(process.cwd())) !==
    realpathSync(resolve(context.serverDirectory))
  ) {
    throw new Error(
      'The event-room Playwright web server started outside its run workspace.',
    );
  }
  const nonce = process.env[EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_NONCE_ENV];
  if (nonce === undefined || nonce.length < 32) {
    throw new Error('The Playwright web-server supervisor nonce is missing.');
  }
  const gatePid = parsePositiveInteger(
    process.env[EVENT_ROOM_PLAYWRIGHT_GATE_PID_ENV],
    'The Playwright web-server gate PID',
  );
  requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
  const webServerProcessIdentity = await inspectDarwinProcess(process.pid);
  if (
    webServerProcessIdentity === null ||
    webServerProcessIdentity.processGroupId !== process.pid
  ) {
    throw new Error(
      'The Playwright web server did not receive a dedicated process group.',
    );
  }
  requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
  const commandHash = sha256(webServerProcessIdentity.command);
  const challengePort = await startWebServerRunChallenge(
    context,
    {
      webServerPid: process.pid,
      processGroupId: webServerProcessIdentity.processGroupId,
      processStartedAt: webServerProcessIdentity.startedAt,
      commandHash,
    },
    nonce,
  );
  requireCurrentEventRoomPlaywrightGateHeartbeat(context, gatePid, nonce);
  writeEventRoomPlaywrightWebServerIdentity(
    context,
    {
      webServerPid: process.pid,
      processGroupId: webServerProcessIdentity.processGroupId,
      processStartedAt: webServerProcessIdentity.startedAt,
      commandHash,
      challengePort,
    },
    nonce,
  );

  let nextProcess: ReturnType<typeof Bun.spawn> | undefined;
  let forcedShutdown: ReturnType<typeof setTimeout> | undefined;
  let shutdownRequested = false;
  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownRequested = true;
    if (nextProcess === undefined) return;
    const ignoreRepeatedGroupSignal = () => undefined;
    if (signal === 'SIGTERM') {
      process.off('SIGTERM', terminate);
      process.on('SIGTERM', ignoreRepeatedGroupSignal);
    } else {
      process.off('SIGINT', interrupt);
      process.on('SIGINT', ignoreRepeatedGroupSignal);
    }
    signalProcessGroup(webServerProcessIdentity.processGroupId, signal);
    forcedShutdown ??= setTimeout(() => {
      signalProcessGroup(webServerProcessIdentity.processGroupId, 'SIGKILL');
    }, NEXT_SHUTDOWN_TIMEOUT_MS);
  };
  const terminate = () => requestShutdown('SIGTERM');
  const interrupt = () => requestShutdown('SIGINT');
  process.once('SIGTERM', terminate);
  process.once('SIGINT', interrupt);
  try {
    const nextCli = join(
      context.workspaceDirectory,
      'node_modules',
      'next',
      'dist',
      'bin',
      'next',
    );
    const spawnedNext = Bun.spawn(
      [
        process.execPath,
        nextCli,
        'dev',
        '--hostname',
        'localhost',
        '--port',
        String(context.appPort),
      ],
      {
        cwd: context.serverDirectory,
        env: process.env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    nextProcess = spawnedNext;
    if (shutdownRequested) requestShutdown('SIGTERM');
    const exitCode = await finalizeEventRoomPlaywrightWebServer(
      context,
      async () => {
        const code = await spawnedNext.exited;
        if (forcedShutdown !== undefined) clearTimeout(forcedShutdown);
        process.chdir(tmpdir());
        return code;
      },
      waitForEventRoomPlaywrightPortToClose,
      () => dropOwnedEventRoomPlaywrightDatabase(context),
    );
    process.exitCode = shutdownRequested ? 0 : exitCode;
  } finally {
    if (forcedShutdown !== undefined) clearTimeout(forcedShutdown);
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
    process.chdir(tmpdir());
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (process.env[EVENT_ROOM_PLAYWRIGHT_SYNTHETIC_PARENT_MODE_ENV] === 'true') {
    await runSyntheticGateParent();
  } else if (
    process.env[EVENT_ROOM_PLAYWRIGHT_SUPERVISOR_MODE_ENV] === 'true'
  ) {
    await superviseCoordinator();
  } else if (mode === '--coordinate') {
    await coordinateWorkload(process.argv[3] ?? '');
  } else if (mode === '--synthetic-workload') {
    await syntheticWorkload(process.argv[3] ?? '');
  } else if (mode === '--synthetic-web-server') {
    await syntheticWebServer(process.argv[3] ?? '');
  } else if (mode === '--synthetic-descendant') {
    await syntheticDescendant(process.argv[3] ?? '');
  } else {
    await runNextWebServer();
  }
}
