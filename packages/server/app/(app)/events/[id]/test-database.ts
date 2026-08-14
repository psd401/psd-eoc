import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  type Dirent,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MINIMUM_APP_PORT = 20_000;
const APP_PORT_COUNT = 30_000;
const PORT_CLOSE_TIMEOUT_MS = 10_000;
const PORT_LEASE_DIRECTORY = join(tmpdir(), 'psd-eoc-event-room-port-leases');
const RUN_DIRECTORY_PREFIX = 'psd-eoc-event-room-';
const SUPERVISION_DIRECTORY_PREFIX = 'psd-eoc-event-room-supervision-';
export const EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV =
  'PSD_EOC_EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT';

export interface EventRoomPlaywrightRunContext {
  readonly runId: string;
  readonly baseDatabaseUrl: string;
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly runDirectory: string;
  readonly storageStatePath: string;
  readonly fixturePath: string;
  readonly channelStatePath: string;
  readonly outputDirectory: string;
  readonly workspaceDirectory: string;
  readonly serverDirectory: string;
  readonly serverBuildDirectory: string;
  readonly serverTsconfigPath: string;
  readonly serverNextEnvPath: string;
  readonly serverWorkspaceReadyPath: string;
  readonly serverWorkspacePreparationLeasePath: string;
  readonly serverStoppedPath: string;
  readonly supervisionDirectory: string;
  readonly gateHeartbeatPath: string;
  readonly coordinatorIdentityPath: string;
  readonly coordinatorChildExitPath: string;
  readonly webServerIdentityPath: string;
  readonly supervisorReadyPath: string;
  readonly supervisorStoppingPath: string;
  readonly appPort: number;
  readonly portLeasePath: string;
  readonly leaseOwnerPid: number;
}

/** Exact non-secret ownership comment attached to the disposable database. */
export function eventRoomPlaywrightDatabaseMarker(value: unknown): string {
  const context = requireEventRoomPlaywrightRunContext(value);
  return JSON.stringify({
    kind: 'psd-eoc-event-room-playwright-database',
    version: 1,
    runId: context.runId,
    databaseName: context.databaseName,
  });
}

/** Fails closed unless a database comment names this exact validated run. */
export function requireEventRoomPlaywrightDatabaseOwnership(
  value: unknown,
  actualMarker: unknown,
): void {
  if (
    typeof actualMarker !== 'string' ||
    actualMarker !== eventRoomPlaywrightDatabaseMarker(value)
  ) {
    throw new Error(
      'The event-room Playwright database ownership marker does not match this run.',
    );
  }
}

/**
 * Fails closed before issue #16 tests can migrate, seed, or mutate a database.
 * Remote test services require an explicit opt-in and every database name must
 * end in `_test` or `-test` so an ordinary production URL cannot be reused.
 */
export function requireSyntheticEventRoomTestDatabaseUrl(
  value: string | undefined,
  allowRemote = process.env.PSD_EOC_ALLOW_REMOTE_TEST_DATABASE === 'true',
): string {
  if (value === undefined || value.length === 0) {
    throw new Error('TEST_DATABASE_URL is required for event-room tests.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL must name a synthetic test database.');
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname.length === 0 ||
    !/^[A-Za-z0-9_-]+[-_]test$/u.test(databaseName) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (!LOOPBACK_HOSTS.has(parsed.hostname) && !allowRemote)
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target a loopback PostgreSQL database whose name ends in _test; remote test databases require explicit opt-in.',
    );
  }
  return value;
}

function loopbackHostAcceptsConnections(
  host: '127.0.0.1' | '::1',
  port: number,
): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const settle = (acceptsConnections: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(acceptsConnections);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(250, () => settle(false));
  });
}

export async function waitForEventRoomPlaywrightPortToClose(
  appPort: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(appPort) ||
    appPort < MINIMUM_APP_PORT ||
    appPort >= MINIMUM_APP_PORT + APP_PORT_COUNT
  ) {
    throw new Error('The event-room Playwright app port is invalid.');
  }
  const deadline = Date.now() + PORT_CLOSE_TIMEOUT_MS;
  while (true) {
    const acceptsConnections = (
      await Promise.all([
        loopbackHostAcceptsConnections('127.0.0.1', appPort),
        loopbackHostAcceptsConnections('::1', appPort),
      ])
    ).some(Boolean);
    if (!acceptsConnections) return;
    if (Date.now() >= deadline) {
      throw new Error(
        'The event-room Playwright Next server retained its port after exit.',
      );
    }
    await delay(50);
  }
}

const GATE_HEARTBEAT_MAX_AGE_MS = 2_000;
const SUPERVISOR_STOPPING_MAX_AGE_MS = 35_000;
const MAXIMUM_SUPERVISION_MARKER_BYTES = 4_096;
const SUPERVISION_MARKER_NAMES = Object.freeze([
  'coordinator-identity.json',
  'coordinator-child-exit.json',
  'web-server-identity.json',
  'supervisor-ready.json',
  'supervisor-stopping.json',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function gateHeartbeatMarker(
  context: EventRoomPlaywrightRunContext,
  gatePid: number,
  supervisorNonceHash: string,
  observedAt: number,
): string {
  return JSON.stringify({
    kind: 'psd-eoc-event-room-playwright-gate-heartbeat',
    version: 1,
    runId: context.runId,
    leaseOwnerPid: context.leaseOwnerPid,
    gatePid,
    supervisorNonceHash,
    observedAt,
  });
}

export type EventRoomPlaywrightPriorResidueReason =
  | 'altered-heartbeat'
  | 'legacy-run-marker'
  | 'marker-without-heartbeat'
  | 'orphaned-port-lease'
  | 'stale-heartbeat';

export interface EventRoomPlaywrightPriorResidue {
  readonly runId: string;
  readonly reason: EventRoomPlaywrightPriorResidueReason;
}

function parsePriorGateHeartbeat(
  serialized: string,
  runId: string,
): Readonly<{ observedAt: number }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('kind' in parsed) ||
    parsed.kind !== 'psd-eoc-event-room-playwright-gate-heartbeat' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('runId' in parsed) ||
    parsed.runId !== runId ||
    !('leaseOwnerPid' in parsed) ||
    typeof parsed.leaseOwnerPid !== 'number' ||
    !Number.isSafeInteger(parsed.leaseOwnerPid) ||
    parsed.leaseOwnerPid <= 0 ||
    !('gatePid' in parsed) ||
    typeof parsed.gatePid !== 'number' ||
    !Number.isSafeInteger(parsed.gatePid) ||
    parsed.gatePid <= 0 ||
    !('supervisorNonceHash' in parsed) ||
    typeof parsed.supervisorNonceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(parsed.supervisorNonceHash) ||
    !('observedAt' in parsed) ||
    typeof parsed.observedAt !== 'number' ||
    !Number.isSafeInteger(parsed.observedAt) ||
    parsed.observedAt <= 0 ||
    serialized !==
      JSON.stringify({
        kind: parsed.kind,
        version: parsed.version,
        runId: parsed.runId,
        leaseOwnerPid: parsed.leaseOwnerPid,
        gatePid: parsed.gatePid,
        supervisorNonceHash: parsed.supervisorNonceHash,
        observedAt: parsed.observedAt,
      })
  ) {
    return null;
  }
  return { observedAt: parsed.observedAt };
}

function priorSupervisorStoppingIsCurrent(
  directory: string,
  runId: string,
  now: number,
): boolean {
  const stoppingPath = join(directory, 'supervisor-stopping.json');
  let serialized: string;
  try {
    const markerEntry = lstatSync(stoppingPath);
    if (
      !markerEntry.isFile() ||
      markerEntry.isSymbolicLink() ||
      markerEntry.size > MAXIMUM_SUPERVISION_MARKER_BYTES
    ) {
      return false;
    }
    serialized = readFileSync(stoppingPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return false;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('kind' in parsed) ||
    parsed.kind !== 'psd-eoc-event-room-playwright-supervisor-stopping' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('runId' in parsed) ||
    parsed.runId !== runId ||
    !('leaseOwnerPid' in parsed) ||
    typeof parsed.leaseOwnerPid !== 'number' ||
    !Number.isSafeInteger(parsed.leaseOwnerPid) ||
    parsed.leaseOwnerPid <= 0 ||
    !('supervisorPid' in parsed) ||
    typeof parsed.supervisorPid !== 'number' ||
    !Number.isSafeInteger(parsed.supervisorPid) ||
    parsed.supervisorPid <= 0 ||
    !('supervisorNonceHash' in parsed) ||
    typeof parsed.supervisorNonceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(parsed.supervisorNonceHash) ||
    !('observedAt' in parsed) ||
    typeof parsed.observedAt !== 'number' ||
    !Number.isSafeInteger(parsed.observedAt) ||
    parsed.observedAt <= 0 ||
    serialized !==
      JSON.stringify({
        kind: parsed.kind,
        version: parsed.version,
        runId: parsed.runId,
        leaseOwnerPid: parsed.leaseOwnerPid,
        supervisorPid: parsed.supervisorPid,
        supervisorNonceHash: parsed.supervisorNonceHash,
        observedAt: parsed.observedAt,
      })
  ) {
    return false;
  }
  return (
    now >= parsed.observedAt &&
    now - parsed.observedAt <= SUPERVISOR_STOPPING_MAX_AGE_MS
  );
}

function priorLegacySupervisorMarkerIsCanonical(
  serialized: string,
  runId: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return false;
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'kind' in parsed &&
    parsed.kind === 'psd-eoc-event-room-playwright-supervisor' &&
    'version' in parsed &&
    parsed.version === 1 &&
    'runId' in parsed &&
    parsed.runId === runId &&
    'contextSha256' in parsed &&
    typeof parsed.contextSha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(parsed.contextSha256) &&
    'ownerPid' in parsed &&
    typeof parsed.ownerPid === 'number' &&
    Number.isSafeInteger(parsed.ownerPid) &&
    parsed.ownerPid > 0 &&
    'coordinatorNonce' in parsed &&
    typeof parsed.coordinatorNonce === 'string' &&
    RUN_ID_PATTERN.test(parsed.coordinatorNonce) &&
    serialized ===
      JSON.stringify({
        kind: parsed.kind,
        version: parsed.version,
        runId: parsed.runId,
        contextSha256: parsed.contextSha256,
        ownerPid: parsed.ownerPid,
        coordinatorNonce: parsed.coordinatorNonce,
      })
  );
}

function priorLegacyCoordinatorHeartbeatIsCanonical(
  serialized: string,
  runId: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return false;
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'kind' in parsed &&
    parsed.kind === 'psd-eoc-event-room-playwright-coordinator-heartbeat' &&
    'version' in parsed &&
    parsed.version === 1 &&
    'runId' in parsed &&
    parsed.runId === runId &&
    'leaseOwnerPid' in parsed &&
    typeof parsed.leaseOwnerPid === 'number' &&
    Number.isSafeInteger(parsed.leaseOwnerPid) &&
    parsed.leaseOwnerPid > 0 &&
    'coordinatorPid' in parsed &&
    typeof parsed.coordinatorPid === 'number' &&
    Number.isSafeInteger(parsed.coordinatorPid) &&
    parsed.coordinatorPid > 0 &&
    'observedAt' in parsed &&
    typeof parsed.observedAt === 'number' &&
    Number.isSafeInteger(parsed.observedAt) &&
    parsed.observedAt > 0 &&
    serialized ===
      JSON.stringify({
        kind: parsed.kind,
        version: parsed.version,
        runId: parsed.runId,
        leaseOwnerPid: parsed.leaseOwnerPid,
        coordinatorPid: parsed.coordinatorPid,
        observedAt: parsed.observedAt,
      })
  );
}

function hasCanonicalPriorLegacyRunMarker(
  directory: string,
  runId: string,
): boolean {
  const markers = [
    {
      name: 'process-supervisor.json',
      validate: priorLegacySupervisorMarkerIsCanonical,
    },
    {
      name: 'coordinator-heartbeat.json',
      validate: priorLegacyCoordinatorHeartbeatIsCanonical,
    },
  ] as const;
  for (const marker of markers) {
    const path = join(directory, marker.name);
    try {
      const entry = lstatSync(path);
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.size <= MAXIMUM_SUPERVISION_MARKER_BYTES &&
        marker.validate(readFileSync(path, 'utf8'), runId)
      ) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

function readCanonicalPriorPortLease(
  name: string,
  now: number,
): Readonly<{ runId: string; isFresh: boolean }> | null {
  const match = name.match(/^(\d{5})\.json$/u);
  if (match === null) return null;
  const appPort = Number.parseInt(match[1]!, 10);
  if (
    appPort < MINIMUM_APP_PORT ||
    appPort >= MINIMUM_APP_PORT + APP_PORT_COUNT
  ) {
    return null;
  }
  const path = join(PORT_LEASE_DIRECTORY, name);
  let entry: ReturnType<typeof lstatSync>;
  let serialized: string;
  try {
    entry = lstatSync(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.size > MAXIMUM_SUPERVISION_MARKER_BYTES
    ) {
      return null;
    }
    serialized = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('runId' in parsed) ||
    typeof parsed.runId !== 'string' ||
    !RUN_ID_PATTERN.test(parsed.runId) ||
    !('appPort' in parsed) ||
    parsed.appPort !== appPort ||
    !('leaseOwnerPid' in parsed) ||
    typeof parsed.leaseOwnerPid !== 'number' ||
    !Number.isSafeInteger(parsed.leaseOwnerPid) ||
    parsed.leaseOwnerPid <= 0 ||
    serialized !==
      serializedPortLease({
        runId: parsed.runId,
        appPort: parsed.appPort,
        leaseOwnerPid: parsed.leaseOwnerPid,
      })
  ) {
    return null;
  }
  return {
    runId: parsed.runId,
    isFresh:
      now >= entry.mtimeMs && now - entry.mtimeMs <= GATE_HEARTBEAT_MAX_AGE_MS,
  };
}

/**
 * Reports current supervision evidence and strict canonical marker/lease
 * residue from earlier harness revisions without treating a directory name,
 * PID, port, or path as cleanup authority. Active runs with a current,
 * canonical heartbeat are left alone, as are fresh leases that may not have
 * published their heartbeat yet. This detector never signals a process,
 * removes a file, releases a lease, or drops a database; the exact supervisor
 * nonce and immutable process markers remain mandatory for those operations.
 */
export function detectPriorEventRoomPlaywrightResidue(
  value: unknown,
  now: number = Date.now(),
): readonly EventRoomPlaywrightPriorResidue[] {
  const current = requireEventRoomPlaywrightRunContext(value);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error('The event-room Playwright residue check time is invalid.');
  }
  const results: EventRoomPlaywrightPriorResidue[] = [];
  const activeRunIds = new Set<string>();
  const residueRunIds = new Set<string>();
  const addResidue = (
    runId: string,
    reason: EventRoomPlaywrightPriorResidueReason,
  ): void => {
    if (residueRunIds.has(runId)) return;
    residueRunIds.add(runId);
    results.push({ runId, reason });
  };
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    const runId = entry.name.startsWith(SUPERVISION_DIRECTORY_PREFIX)
      ? entry.name.slice(SUPERVISION_DIRECTORY_PREFIX.length)
      : undefined;
    if (
      runId === undefined ||
      !RUN_ID_PATTERN.test(runId) ||
      runId === current.runId ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    const directory = join(tmpdir(), entry.name);
    if (priorSupervisorStoppingIsCurrent(directory, runId, now)) {
      activeRunIds.add(runId);
      continue;
    }
    const heartbeatPath = join(directory, 'gate-heartbeat.json');
    let heartbeatBytes: number | null = null;
    try {
      const heartbeatEntry = lstatSync(heartbeatPath);
      if (heartbeatEntry.isFile() && !heartbeatEntry.isSymbolicLink()) {
        heartbeatBytes = heartbeatEntry.size;
      } else {
        addResidue(runId, 'altered-heartbeat');
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (heartbeatBytes === null) {
      const hasRunBoundMarker = SUPERVISION_MARKER_NAMES.some((name) => {
        try {
          const markerEntry = lstatSync(join(directory, name));
          return markerEntry.isFile() && !markerEntry.isSymbolicLink();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      });
      if (hasRunBoundMarker) {
        addResidue(runId, 'marker-without-heartbeat');
      }
      continue;
    }
    if (heartbeatBytes > MAXIMUM_SUPERVISION_MARKER_BYTES) {
      addResidue(runId, 'altered-heartbeat');
      continue;
    }
    const heartbeat = parsePriorGateHeartbeat(
      readFileSync(heartbeatPath, 'utf8'),
      runId,
    );
    if (heartbeat === null || now < heartbeat.observedAt) {
      addResidue(runId, 'altered-heartbeat');
    } else if (now - heartbeat.observedAt > GATE_HEARTBEAT_MAX_AGE_MS) {
      addResidue(runId, 'stale-heartbeat');
    } else {
      activeRunIds.add(runId);
    }
  }

  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    const runId = entry.name.startsWith(RUN_DIRECTORY_PREFIX)
      ? entry.name.slice(RUN_DIRECTORY_PREFIX.length)
      : undefined;
    if (
      runId === undefined ||
      !RUN_ID_PATTERN.test(runId) ||
      runId === current.runId ||
      activeRunIds.has(runId) ||
      residueRunIds.has(runId) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    if (hasCanonicalPriorLegacyRunMarker(join(tmpdir(), entry.name), runId)) {
      addResidue(runId, 'legacy-run-marker');
    }
  }

  let leaseEntries: Dirent<string>[];
  try {
    leaseEntries = readdirSync(PORT_LEASE_DIRECTORY, {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return results.sort((left, right) =>
        left.runId.localeCompare(right.runId),
      );
    }
    throw error;
  }
  for (const entry of leaseEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const lease = readCanonicalPriorPortLease(entry.name, now);
    if (
      lease === null ||
      lease.isFresh ||
      lease.runId === current.runId ||
      activeRunIds.has(lease.runId) ||
      residueRunIds.has(lease.runId)
    ) {
      continue;
    }
    addResidue(lease.runId, 'orphaned-port-lease');
  }
  return results.sort((left, right) => left.runId.localeCompare(right.runId));
}

export function writeEventRoomPlaywrightGateHeartbeat(
  value: unknown,
  gatePid: number,
  supervisorNonce: string,
  observedAt: number = Date.now(),
): void {
  const context = requireEventRoomPlaywrightRunContext(value);
  if (
    !Number.isSafeInteger(gatePid) ||
    gatePid <= 0 ||
    supervisorNonce.length < 32 ||
    !Number.isSafeInteger(observedAt) ||
    observedAt <= 0
  ) {
    throw new Error('The event-room Playwright gate heartbeat is invalid.');
  }
  mkdirSync(context.supervisionDirectory, { mode: 0o700, recursive: true });
  const stagingPath = `${context.gateHeartbeatPath}.${gatePid}.tmp`;
  writeFileSync(
    stagingPath,
    gateHeartbeatMarker(context, gatePid, sha256(supervisorNonce), observedAt),
    { encoding: 'utf8', mode: 0o600 },
  );
  renameSync(stagingPath, context.gateHeartbeatPath);
}

export function requireCurrentEventRoomPlaywrightGateHeartbeat(
  value: unknown,
  gatePid: number,
  supervisorNonce: string,
  now: number = Date.now(),
): number {
  const context = requireEventRoomPlaywrightRunContext(value);
  let serialized: string;
  try {
    serialized = readFileSync(context.gateHeartbeatPath, 'utf8');
  } catch (error) {
    throw new Error('The event-room Playwright gate heartbeat is missing.', {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      'The event-room Playwright gate heartbeat is invalid JSON.',
      {
        cause: error,
      },
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('observedAt' in parsed) ||
    typeof parsed.observedAt !== 'number' ||
    serialized !==
      gateHeartbeatMarker(
        context,
        gatePid,
        sha256(supervisorNonce),
        parsed.observedAt,
      )
  ) {
    throw new Error('The event-room Playwright gate heartbeat was altered.');
  }
  if (
    !Number.isSafeInteger(parsed.observedAt) ||
    parsed.observedAt <= 0 ||
    now < parsed.observedAt ||
    now - parsed.observedAt > GATE_HEARTBEAT_MAX_AGE_MS
  ) {
    throw new Error('The event-room Playwright gate heartbeat is stale.');
  }
  return parsed.observedAt;
}

function supervisorStoppingMarker(
  context: EventRoomPlaywrightRunContext,
  supervisorPid: number,
  supervisorNonce: string,
  observedAt: number,
): string {
  return JSON.stringify({
    kind: 'psd-eoc-event-room-playwright-supervisor-stopping',
    version: 1,
    runId: context.runId,
    leaseOwnerPid: context.leaseOwnerPid,
    supervisorPid,
    supervisorNonceHash: sha256(supervisorNonce),
    observedAt,
  });
}

export function writeEventRoomPlaywrightSupervisorStopping(
  value: unknown,
  supervisorPid: number,
  supervisorNonce: string,
  observedAt: number = Date.now(),
): void {
  const context = requireEventRoomPlaywrightRunContext(value);
  if (
    !Number.isSafeInteger(supervisorPid) ||
    supervisorPid <= 0 ||
    supervisorNonce.length < 32 ||
    !Number.isSafeInteger(observedAt) ||
    observedAt <= 0
  ) {
    throw new Error('The Playwright supervisor stopping identity is invalid.');
  }
  let descriptor: number;
  try {
    descriptor = openSync(context.supervisorStoppingPath, 'wx', 0o600);
  } catch (error) {
    throw new Error(
      'The Playwright supervisor stopping identity already exists.',
      { cause: error },
    );
  }
  try {
    writeFileSync(
      descriptor,
      supervisorStoppingMarker(
        context,
        supervisorPid,
        supervisorNonce,
        observedAt,
      ),
      'utf8',
    );
  } finally {
    closeSync(descriptor);
  }
}

export function hasEventRoomPlaywrightSupervisorStoppingMarker(
  value: unknown,
  supervisorPid: number,
  supervisorNonce: string,
): boolean {
  const context = requireEventRoomPlaywrightRunContext(value);
  let serialized: string;
  try {
    serialized = readFileSync(context.supervisorStoppingPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      'The Playwright supervisor stopping identity is invalid JSON.',
      { cause: error },
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('observedAt' in parsed) ||
    typeof parsed.observedAt !== 'number' ||
    !Number.isSafeInteger(parsed.observedAt) ||
    parsed.observedAt <= 0 ||
    !exactStringEqual(
      serialized,
      supervisorStoppingMarker(
        context,
        supervisorPid,
        supervisorNonce,
        parsed.observedAt,
      ),
    )
  ) {
    throw new Error(
      'The Playwright supervisor stopping identity was altered or replaced.',
    );
  }
  return true;
}

export interface EventRoomPlaywrightCoordinatorIdentity {
  readonly kind: 'psd-eoc-event-room-playwright-coordinator';
  readonly version: 1;
  readonly runId: string;
  readonly leaseOwnerPid: number;
  readonly coordinatorPid: number;
  readonly processGroupId: number;
  readonly processStartedAt: string;
  readonly commandHash: string;
  readonly supervisorNonceHash: string;
}

function coordinatorIdentityMarker(
  context: EventRoomPlaywrightRunContext,
  identity: Omit<
    EventRoomPlaywrightCoordinatorIdentity,
    'kind' | 'version' | 'runId' | 'leaseOwnerPid'
  >,
): EventRoomPlaywrightCoordinatorIdentity {
  return {
    kind: 'psd-eoc-event-room-playwright-coordinator',
    version: 1,
    runId: context.runId,
    leaseOwnerPid: context.leaseOwnerPid,
    ...identity,
  };
}

export function writeEventRoomPlaywrightCoordinatorIdentity(
  value: unknown,
  identity: Omit<
    EventRoomPlaywrightCoordinatorIdentity,
    'kind' | 'version' | 'runId' | 'leaseOwnerPid' | 'supervisorNonceHash'
  >,
  supervisorNonce: string,
): EventRoomPlaywrightCoordinatorIdentity {
  const context = requireEventRoomPlaywrightRunContext(value);
  if (
    !Number.isSafeInteger(identity.coordinatorPid) ||
    identity.coordinatorPid <= 0 ||
    identity.processGroupId !== identity.coordinatorPid ||
    identity.processStartedAt.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(identity.commandHash) ||
    supervisorNonce.length < 32
  ) {
    throw new Error(
      'The event-room Playwright coordinator identity is invalid.',
    );
  }
  const marker = coordinatorIdentityMarker(context, {
    ...identity,
    supervisorNonceHash: sha256(supervisorNonce),
  });
  mkdirSync(context.supervisionDirectory, { mode: 0o700, recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(context.coordinatorIdentityPath, 'wx', 0o600);
  } catch (error) {
    throw new Error(
      'The event-room Playwright coordinator identity already exists.',
      { cause: error },
    );
  }
  try {
    writeFileSync(descriptor, JSON.stringify(marker), 'utf8');
  } finally {
    closeSync(descriptor);
  }
  return marker;
}

export function requireEventRoomPlaywrightCoordinatorIdentity(
  value: unknown,
  expected: EventRoomPlaywrightCoordinatorIdentity,
  supervisorNonce: string,
): EventRoomPlaywrightCoordinatorIdentity {
  const context = requireEventRoomPlaywrightRunContext(value);
  let serialized: string;
  try {
    serialized = readFileSync(context.coordinatorIdentityPath, 'utf8');
  } catch (error) {
    throw new Error(
      'The event-room Playwright coordinator identity is missing.',
      { cause: error },
    );
  }
  const canonical = JSON.stringify(
    coordinatorIdentityMarker(context, {
      coordinatorPid: expected.coordinatorPid,
      processGroupId: expected.processGroupId,
      processStartedAt: expected.processStartedAt,
      commandHash: expected.commandHash,
      supervisorNonceHash: sha256(supervisorNonce),
    }),
  );
  if (!exactStringEqual(serialized, canonical)) {
    throw new Error(
      'The event-room Playwright coordinator identity was altered or replaced.',
    );
  }
  return expected;
}

export interface EventRoomPlaywrightWebServerIdentity {
  readonly kind: 'psd-eoc-event-room-playwright-web-server';
  readonly version: 1;
  readonly runId: string;
  readonly leaseOwnerPid: number;
  readonly webServerPid: number;
  readonly processGroupId: number;
  readonly processStartedAt: string;
  readonly commandHash: string;
  readonly supervisorNonceHash: string;
}

function webServerIdentityMarker(
  context: EventRoomPlaywrightRunContext,
  identity: Omit<
    EventRoomPlaywrightWebServerIdentity,
    'kind' | 'version' | 'runId' | 'leaseOwnerPid'
  >,
): EventRoomPlaywrightWebServerIdentity {
  return {
    kind: 'psd-eoc-event-room-playwright-web-server',
    version: 1,
    runId: context.runId,
    leaseOwnerPid: context.leaseOwnerPid,
    ...identity,
  };
}

export function writeEventRoomPlaywrightWebServerIdentity(
  value: unknown,
  identity: Omit<
    EventRoomPlaywrightWebServerIdentity,
    'kind' | 'version' | 'runId' | 'leaseOwnerPid' | 'supervisorNonceHash'
  >,
  supervisorNonce: string,
): EventRoomPlaywrightWebServerIdentity {
  const context = requireEventRoomPlaywrightRunContext(value);
  if (
    !Number.isSafeInteger(identity.webServerPid) ||
    identity.webServerPid <= 0 ||
    identity.processGroupId !== identity.webServerPid ||
    identity.processStartedAt.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(identity.commandHash) ||
    supervisorNonce.length < 32
  ) {
    throw new Error(
      'The event-room Playwright web-server identity is invalid.',
    );
  }
  const marker = webServerIdentityMarker(context, {
    ...identity,
    supervisorNonceHash: sha256(supervisorNonce),
  });
  mkdirSync(context.supervisionDirectory, { mode: 0o700, recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(context.webServerIdentityPath, 'wx', 0o600);
  } catch (error) {
    throw new Error(
      'The event-room Playwright web-server identity already exists.',
      { cause: error },
    );
  }
  try {
    writeFileSync(descriptor, JSON.stringify(marker), 'utf8');
  } finally {
    closeSync(descriptor);
  }
  return marker;
}

export function readEventRoomPlaywrightWebServerIdentity(
  value: unknown,
  supervisorNonce: string,
): EventRoomPlaywrightWebServerIdentity | null {
  const context = requireEventRoomPlaywrightRunContext(value);
  let serialized: string;
  try {
    serialized = readFileSync(context.webServerIdentityPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      'The event-room Playwright web-server identity is invalid JSON.',
      { cause: error },
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('webServerPid' in parsed) ||
    typeof parsed.webServerPid !== 'number' ||
    !('processGroupId' in parsed) ||
    typeof parsed.processGroupId !== 'number' ||
    !('processStartedAt' in parsed) ||
    typeof parsed.processStartedAt !== 'string' ||
    !('commandHash' in parsed) ||
    typeof parsed.commandHash !== 'string'
  ) {
    throw new Error(
      'The event-room Playwright web-server identity is invalid.',
    );
  }
  const canonical = JSON.stringify(
    webServerIdentityMarker(context, {
      webServerPid: parsed.webServerPid,
      processGroupId: parsed.processGroupId,
      processStartedAt: parsed.processStartedAt,
      commandHash: parsed.commandHash,
      supervisorNonceHash: sha256(supervisorNonce),
    }),
  );
  if (
    parsed.processGroupId !== parsed.webServerPid ||
    !exactStringEqual(serialized, canonical)
  ) {
    throw new Error(
      'The event-room Playwright web-server identity was altered or replaced.',
    );
  }
  return parsed as EventRoomPlaywrightWebServerIdentity;
}

function buildEventRoomPlaywrightRunContext(
  baseDatabaseUrl: string,
  runId: string,
  appPort: number,
  leaseOwnerPid: number,
): EventRoomPlaywrightRunContext {
  const validatedBaseUrl =
    requireSyntheticEventRoomTestDatabaseUrl(baseDatabaseUrl);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('The event-room Playwright run ID must be a random UUID.');
  }
  const compactRunId = runId.replaceAll('-', '');
  const databaseName = `psd_eoc_event_room_${compactRunId}_test`;
  const databaseUrl = new URL(validatedBaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const runDirectory = join(tmpdir(), `psd-eoc-event-room-${runId}`);
  const supervisionDirectory = join(
    tmpdir(),
    `${SUPERVISION_DIRECTORY_PREFIX}${runId}`,
  );
  const workspaceDirectory = join(runDirectory, 'workspace');
  const serverDirectory = join(workspaceDirectory, 'packages', 'server');
  if (
    !Number.isSafeInteger(appPort) ||
    appPort < MINIMUM_APP_PORT ||
    appPort >= MINIMUM_APP_PORT + APP_PORT_COUNT ||
    !Number.isSafeInteger(leaseOwnerPid) ||
    leaseOwnerPid <= 0
  ) {
    throw new Error('The event-room Playwright port lease is invalid.');
  }
  return Object.freeze({
    runId,
    baseDatabaseUrl: validatedBaseUrl,
    databaseUrl: databaseUrl.toString(),
    databaseName,
    runDirectory,
    storageStatePath: join(runDirectory, 'storage-state.json'),
    fixturePath: join(runDirectory, 'fixture.json'),
    channelStatePath: join(runDirectory, 'channel-state.json'),
    outputDirectory: join(runDirectory, 'playwright-output'),
    workspaceDirectory,
    serverDirectory,
    serverBuildDirectory: join(serverDirectory, '.next'),
    serverTsconfigPath: join(serverDirectory, 'tsconfig.json'),
    serverNextEnvPath: join(serverDirectory, 'next-env.d.ts'),
    serverWorkspaceReadyPath: join(
      workspaceDirectory,
      '.event-room-server-workspace-ready.json',
    ),
    serverWorkspacePreparationLeasePath: join(
      runDirectory,
      'server-workspace-preparation.json',
    ),
    serverStoppedPath: join(runDirectory, 'server-stopped.json'),
    supervisionDirectory,
    gateHeartbeatPath: join(supervisionDirectory, 'gate-heartbeat.json'),
    coordinatorIdentityPath: join(
      supervisionDirectory,
      'coordinator-identity.json',
    ),
    coordinatorChildExitPath: join(
      supervisionDirectory,
      'coordinator-child-exit.json',
    ),
    webServerIdentityPath: join(
      supervisionDirectory,
      'web-server-identity.json',
    ),
    supervisorReadyPath: join(supervisionDirectory, 'supervisor-ready.json'),
    supervisorStoppingPath: join(
      supervisionDirectory,
      'supervisor-stopping.json',
    ),
    appPort,
    portLeasePath: join(PORT_LEASE_DIRECTORY, `${appPort}.json`),
    leaseOwnerPid,
  });
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`);
}

function serverWorkspaceMarker(
  context: EventRoomPlaywrightRunContext,
  sourceServerDirectory: string,
): string {
  return JSON.stringify({
    runId: context.runId,
    sourceServerDirectory,
    workspaceDirectory: context.workspaceDirectory,
    serverDirectory: context.serverDirectory,
  });
}

function requirePreparedEventRoomPlaywrightServerWorkspace(
  context: EventRoomPlaywrightRunContext,
  sourceServerDirectory: string,
): void {
  const expectedMarker = serverWorkspaceMarker(context, sourceServerDirectory);
  let marker: string;
  try {
    marker = readFileSync(context.serverWorkspaceReadyPath, 'utf8');
  } catch (error) {
    throw new Error(
      'The event-room Playwright server workspace is not ready.',
      { cause: error },
    );
  }
  if (marker !== expectedMarker) {
    throw new Error(
      'The event-room Playwright server workspace marker was altered.',
    );
  }
  for (const path of [
    context.workspaceDirectory,
    context.serverDirectory,
    context.serverTsconfigPath,
    join(context.serverDirectory, 'package.json'),
    join(context.workspaceDirectory, 'node_modules'),
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        'The event-room Playwright server workspace is incomplete.',
      );
    }
  }
}

/**
 * Prepares the Next.js web server before Playwright starts it. Source files
 * are copied into a run-scoped monorepo overlay while installed dependencies
 * are reused through a symlink. Next's generated .next, tsconfig, and next-env
 * artifacts are therefore confined to this run's server directory.
 *
 * The ready marker makes config re-evaluation idempotent: once published, a
 * worker validates and reuses the overlay instead of replacing a live server.
 */
export function prepareEventRoomPlaywrightServerWorkspace(
  value: unknown,
  sourceServerDirectoryValue: string,
): void {
  const context = requireEventRoomPlaywrightRunContext(value);
  const sourceServerDirectory = resolve(sourceServerDirectoryValue);
  const sourceWorkspaceDirectory = resolve(sourceServerDirectory, '../..');
  const sourceNodeModules = join(sourceWorkspaceDirectory, 'node_modules');
  for (const sourcePath of [
    sourceServerDirectory,
    join(sourceServerDirectory, 'package.json'),
    join(sourceServerDirectory, 'tsconfig.json'),
    join(sourceWorkspaceDirectory, 'package.json'),
    join(sourceWorkspaceDirectory, 'tsconfig.base.json'),
    sourceNodeModules,
  ]) {
    if (!existsSync(sourcePath)) {
      throw new Error(
        'The event-room Playwright source workspace is incomplete.',
      );
    }
  }
  if (
    !pathIsWithin(context.runDirectory, context.workspaceDirectory) ||
    !pathIsWithin(context.workspaceDirectory, context.serverDirectory) ||
    !pathIsWithin(context.serverDirectory, context.serverBuildDirectory) ||
    !pathIsWithin(context.serverDirectory, context.serverTsconfigPath) ||
    !pathIsWithin(context.serverDirectory, context.serverNextEnvPath)
  ) {
    throw new Error(
      'The event-room Playwright server workspace escaped its run directory.',
    );
  }

  if (existsSync(context.serverWorkspaceReadyPath)) {
    requirePreparedEventRoomPlaywrightServerWorkspace(
      context,
      sourceServerDirectory,
    );
    return;
  }

  mkdirSync(context.runDirectory, { mode: 0o700, recursive: true });
  let preparationLease: number;
  try {
    preparationLease = openSync(
      context.serverWorkspacePreparationLeasePath,
      'wx',
      0o600,
    );
  } catch (error) {
    if (isExistingLease(error)) {
      throw new Error(
        'Another process is preparing the event-room Playwright server workspace.',
        { cause: error },
      );
    }
    throw error;
  }
  try {
    writeFileSync(
      preparationLease,
      JSON.stringify({ runId: context.runId, preparerPid: process.pid }),
      'utf8',
    );
  } finally {
    closeSync(preparationLease);
  }

  const stagingWorkspaceDirectory = join(
    context.runDirectory,
    'workspace.preparing',
  );
  const stagingServerDirectory = join(
    stagingWorkspaceDirectory,
    'packages',
    'server',
  );
  try {
    if (existsSync(context.workspaceDirectory)) {
      throw new Error(
        'An unpublished event-room Playwright server workspace already exists.',
      );
    }
    rmSync(stagingWorkspaceDirectory, { force: true, recursive: true });
    mkdirSync(dirname(stagingServerDirectory), {
      mode: 0o700,
      recursive: true,
    });
    cpSync(sourceServerDirectory, stagingServerDirectory, {
      errorOnExist: true,
      filter: (source) => {
        const sourceRelativePath = relative(sourceServerDirectory, source);
        return !(
          sourceRelativePath === '.next' ||
          sourceRelativePath.startsWith(`.next${sep}`) ||
          sourceRelativePath === 'node_modules' ||
          sourceRelativePath.startsWith(`node_modules${sep}`) ||
          sourceRelativePath === 'next-env.d.ts' ||
          sourceRelativePath.endsWith('.tsbuildinfo')
        );
      },
      recursive: true,
    });
    for (const rootFile of [
      'bun.lock',
      'bunfig.toml',
      'package.json',
      'tsconfig.base.json',
    ]) {
      const sourcePath = join(sourceWorkspaceDirectory, rootFile);
      if (existsSync(sourcePath)) {
        copyFileSync(sourcePath, join(stagingWorkspaceDirectory, rootFile));
      }
    }
    symlinkSync(
      sourceNodeModules,
      join(stagingWorkspaceDirectory, 'node_modules'),
      'dir',
    );
    writeFileSync(
      join(
        stagingWorkspaceDirectory,
        '.event-room-server-workspace-ready.json',
      ),
      serverWorkspaceMarker(context, sourceServerDirectory),
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(stagingWorkspaceDirectory, context.workspaceDirectory);
    requirePreparedEventRoomPlaywrightServerWorkspace(
      context,
      sourceServerDirectory,
    );
  } catch (error) {
    rmSync(stagingWorkspaceDirectory, { force: true, recursive: true });
    throw error;
  } finally {
    unlinkSync(context.serverWorkspacePreparationLeasePath);
  }
}

function isExistingLease(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function serializedPortLease(
  lease: Pick<
    EventRoomPlaywrightRunContext,
    'runId' | 'appPort' | 'leaseOwnerPid'
  >,
): string {
  return JSON.stringify({
    runId: lease.runId,
    appPort: lease.appPort,
    leaseOwnerPid: lease.leaseOwnerPid,
  });
}

function requireValidReplacementPortLease(
  serialized: string,
  appPort: number,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error('The event-room Playwright port lease is invalid JSON.', {
      cause: error,
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('runId' in parsed) ||
    typeof parsed.runId !== 'string' ||
    !RUN_ID_PATTERN.test(parsed.runId) ||
    !('appPort' in parsed) ||
    parsed.appPort !== appPort ||
    !('leaseOwnerPid' in parsed) ||
    typeof parsed.leaseOwnerPid !== 'number' ||
    !Number.isSafeInteger(parsed.leaseOwnerPid) ||
    parsed.leaseOwnerPid <= 0 ||
    serialized !==
      serializedPortLease({
        runId: parsed.runId,
        appPort: parsed.appPort,
        leaseOwnerPid: parsed.leaseOwnerPid,
      })
  ) {
    throw new Error('The event-room Playwright port lease is invalid.');
  }
}

/**
 * Atomically reserves one port across concurrent event-room Playwright runs.
 * The exclusive lease exists before any server starts and is released only by
 * validated setup-failure or teardown cleanup.
 */
export function claimEventRoomPlaywrightRunContext(
  baseDatabaseUrl: string,
  runId: string,
  preferredPort?: number,
): EventRoomPlaywrightRunContext {
  const compactRunId = runId.replaceAll('-', '');
  const portSeed = Number.parseInt(compactRunId.slice(0, 8), 16);
  const startingPort =
    preferredPort ?? MINIMUM_APP_PORT + (portSeed % APP_PORT_COUNT);
  if (
    !Number.isSafeInteger(startingPort) ||
    startingPort < MINIMUM_APP_PORT ||
    startingPort >= MINIMUM_APP_PORT + APP_PORT_COUNT
  ) {
    throw new Error('The preferred event-room Playwright port is invalid.');
  }
  mkdirSync(PORT_LEASE_DIRECTORY, { mode: 0o700, recursive: true });
  for (let offset = 0; offset < APP_PORT_COUNT; offset += 1) {
    const appPort =
      MINIMUM_APP_PORT +
      ((startingPort - MINIMUM_APP_PORT + offset) % APP_PORT_COUNT);
    const context = buildEventRoomPlaywrightRunContext(
      baseDatabaseUrl,
      runId,
      appPort,
      process.pid,
    );
    let descriptor: number;
    try {
      descriptor = openSync(context.portLeasePath, 'wx', 0o600);
    } catch (error) {
      if (isExistingLease(error)) continue;
      throw error;
    }
    try {
      writeFileSync(descriptor, serializedPortLease(context), 'utf8');
    } finally {
      closeSync(descriptor);
    }
    return context;
  }
  throw new Error('No event-room Playwright app port lease is available.');
}

export function requireEventRoomPlaywrightRunContext(
  value: unknown,
): EventRoomPlaywrightRunContext {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('runId' in value) ||
    typeof value.runId !== 'string' ||
    !('baseDatabaseUrl' in value) ||
    typeof value.baseDatabaseUrl !== 'string' ||
    !('appPort' in value) ||
    typeof value.appPort !== 'number' ||
    !('leaseOwnerPid' in value) ||
    typeof value.leaseOwnerPid !== 'number'
  ) {
    throw new Error('The event-room Playwright run metadata is invalid.');
  }
  const expected = buildEventRoomPlaywrightRunContext(
    value.baseDatabaseUrl,
    value.runId,
    value.appPort,
    value.leaseOwnerPid,
  );
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error('The event-room Playwright run metadata was altered.');
  }
  return expected;
}

export function requireInheritedEventRoomPlaywrightRunContext(
  environment: NodeJS.ProcessEnv = process.env,
): EventRoomPlaywrightRunContext {
  const serialized = environment[EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV];
  if (serialized === undefined) {
    throw new Error('The inherited event-room Playwright run is missing.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      'The inherited event-room Playwright run metadata is invalid JSON.',
      { cause: error },
    );
  }
  return requireEventRoomPlaywrightRunContext(parsed);
}

/**
 * Playwright evaluates its configuration again in worker processes. Preserve
 * the coordinator's claimed run in inherited environment state so every
 * process uses the same database, files, server port, and lease.
 */
export function resolveEventRoomPlaywrightRunContext(
  baseDatabaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  createRunId: () => string = randomUUID,
): EventRoomPlaywrightRunContext {
  const serialized = environment[EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV];
  if (serialized !== undefined) {
    const inherited =
      requireInheritedEventRoomPlaywrightRunContext(environment);
    if (inherited.baseDatabaseUrl !== baseDatabaseUrl) {
      throw new Error(
        'The inherited event-room Playwright run targets a different base database.',
      );
    }
    return inherited;
  }

  const claimed = claimEventRoomPlaywrightRunContext(
    baseDatabaseUrl,
    createRunId(),
  );
  environment[EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV] = JSON.stringify(claimed);
  return claimed;
}

export function releaseEventRoomPlaywrightPortLease(value: unknown): void {
  const context = requireEventRoomPlaywrightRunContext(value);
  let serialized: string;
  try {
    serialized = readFileSync(context.portLeasePath, 'utf8');
  } catch (error) {
    throw new Error('The event-room Playwright port lease is missing.', {
      cause: error,
    });
  }
  const expected = serializedPortLease(context);
  if (serialized !== expected) {
    throw new Error('The event-room Playwright port lease owner changed.');
  }
  unlinkSync(context.portLeasePath);
}

export type EventRoomPlaywrightPortLeaseOwnership =
  | 'absent'
  | 'owned'
  | 'replacement';

export function inspectEventRoomPlaywrightPortLease(
  value: unknown,
): EventRoomPlaywrightPortLeaseOwnership {
  const context = requireEventRoomPlaywrightRunContext(value);
  let serialized: string;
  try {
    serialized = readFileSync(context.portLeasePath, 'utf8');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') return 'absent';
    throw error;
  }
  if (serialized === serializedPortLease(context)) return 'owned';
  requireValidReplacementPortLease(serialized, context.appPort);
  return 'replacement';
}

export function releaseEventRoomPlaywrightPortLeaseIfOwned(
  value: unknown,
): boolean {
  const context = requireEventRoomPlaywrightRunContext(value);
  if (inspectEventRoomPlaywrightPortLease(context) !== 'owned') return false;
  releaseEventRoomPlaywrightPortLease(context);
  return true;
}

function stoppedServerMarker(context: EventRoomPlaywrightRunContext): string {
  return JSON.stringify({
    runId: context.runId,
    appPort: context.appPort,
    leaseOwnerPid: context.leaseOwnerPid,
  });
}

function recordStoppedEventRoomPlaywrightServer(
  context: EventRoomPlaywrightRunContext,
): void {
  let descriptor: number;
  try {
    descriptor = openSync(context.serverStoppedPath, 'wx', 0o600);
  } catch (error) {
    throw new Error(
      'The event-room Playwright stopped-server marker already exists.',
      { cause: error },
    );
  }
  try {
    writeFileSync(descriptor, stoppedServerMarker(context), 'utf8');
  } finally {
    closeSync(descriptor);
  }
  releaseEventRoomPlaywrightPortLease(context);
}

function hasStoppedServerEvidence(
  context: EventRoomPlaywrightRunContext,
): boolean {
  let marker: string;
  try {
    marker = readFileSync(context.serverStoppedPath, 'utf8');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') return false;
    throw error;
  }
  if (marker !== stoppedServerMarker(context)) {
    throw new Error(
      'The event-room Playwright stopped-server marker was altered.',
    );
  }
  return true;
}

/**
 * Removes reporter output only after the web-server wrapper recorded exact
 * stopped evidence and released its validated port lease. A missing marker or
 * a retained lease fails closed so a live server's workspace is never erased.
 */
export function cleanupReportedEventRoomPlaywrightRun(value: unknown): void {
  const context = requireEventRoomPlaywrightRunContext(value);
  if (!hasStoppedServerEvidence(context)) {
    throw new Error(
      'The event-room Playwright server has no stopped evidence.',
    );
  }
  if (inspectEventRoomPlaywrightPortLease(context) === 'owned') {
    throw new Error(
      'The event-room Playwright port lease remains owned after server stop.',
    );
  }
  rmSync(context.runDirectory, { force: true, recursive: true });
}

/**
 * Idempotent outer-gate fallback. Without stopped evidence it independently
 * waits for both loopback addresses to reject connections before touching the
 * old run directory or its lease. A valid replacement lease is never removed.
 * This covers child/server SIGKILL. If the coordinator itself is SIGKILLed,
 * no cleanup code can execute; its UUID-named resources remain inert and are
 * never reused, while database cleanup still requires the exact run marker.
 */
export async function cleanupEventRoomPlaywrightRunAfterChildExit(
  value: unknown,
  waitForPortClose: (
    appPort: number,
  ) => Promise<void> = waitForEventRoomPlaywrightPortToClose,
): Promise<void> {
  const context = requireEventRoomPlaywrightRunContext(value);
  for (const identityPath of [
    context.coordinatorIdentityPath,
    context.webServerIdentityPath,
  ]) {
    try {
      lstatSync(identityPath);
      throw new Error(
        'The event-room Playwright outer cleanup refused to erase immutable process identity; exact supervisor cleanup is required.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const leaseOwnership = inspectEventRoomPlaywrightPortLease(context);
  if (!existsSync(context.runDirectory) && leaseOwnership !== 'owned') return;
  if (!hasStoppedServerEvidence(context)) {
    await waitForPortClose(context.appPort);
  }
  rmSync(context.runDirectory, { force: true, recursive: true });
  releaseEventRoomPlaywrightPortLeaseIfOwned(context);
  rmSync(context.supervisionDirectory, { force: true, recursive: true });
}

export interface EventRoomPlaywrightOrphanCleanupOperations {
  inspectProcess(pid: number): Promise<Readonly<{
    processGroupId: number;
    startedAt: string;
    command: string;
  }> | null>;
  signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  processGroupMembers(processGroupId: number): Promise<readonly number[]>;
  waitForPortClose(appPort: number): Promise<void>;
  dropOwnedDatabase(context: EventRoomPlaywrightRunContext): Promise<unknown>;
}

interface ExactPlaywrightProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly processStartedAt: string;
  readonly commandHash: string;
  readonly label: 'coordinator' | 'web-server';
  readonly nonceMustAppearInCommand: boolean;
}

function requireExactProcessIdentity(
  actual: Readonly<{
    processGroupId: number;
    startedAt: string;
    command: string;
  }> | null,
  expected: ExactPlaywrightProcessIdentity,
  supervisorNonce: string,
  stage: string,
): void {
  if (actual === null) {
    throw new Error(
      `The event-room Playwright ${expected.label} process identity is missing ${stage}.`,
    );
  }
  if (
    actual.processGroupId !== expected.processGroupId ||
    actual.startedAt !== expected.processStartedAt ||
    sha256(actual.command) !== expected.commandHash ||
    (expected.nonceMustAppearInCommand &&
      !actual.command.includes(supervisorNonce))
  ) {
    throw new Error(
      `The event-room Playwright ${expected.label} process identity is ambiguous or reused ${stage}.`,
    );
  }
}

async function terminateExactPlaywrightProcessGroup(
  identity: ExactPlaywrightProcessIdentity,
  supervisorNonce: string,
  operations: EventRoomPlaywrightOrphanCleanupOperations,
  releaseAnchor: boolean,
): Promise<void> {
  requireExactProcessIdentity(
    await operations.inspectProcess(identity.pid),
    identity,
    supervisorNonce,
    'before termination',
  );
  operations.signalProcessGroup(identity.processGroupId, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  let members = await operations.processGroupMembers(identity.processGroupId);
  while (
    (releaseAnchor
      ? members.some((pid) => pid !== identity.pid)
      : members.length > 0) &&
    Date.now() < deadline
  ) {
    await delay(25);
    members = await operations.processGroupMembers(identity.processGroupId);
  }
  const descendantsRemain = releaseAnchor
    ? members.some((pid) => pid !== identity.pid)
    : members.length > 0;
  if (descendantsRemain) {
    requireExactProcessIdentity(
      await operations.inspectProcess(identity.pid),
      identity,
      supervisorNonce,
      'before forced termination',
    );
    operations.signalProcessGroup(identity.processGroupId, 'SIGKILL');
    const forcedDeadline = Date.now() + 5_000;
    while (
      (await operations.processGroupMembers(identity.processGroupId)).length >
        0 &&
      Date.now() < forcedDeadline
    ) {
      await delay(25);
    }
  } else if (releaseAnchor) {
    requireExactProcessIdentity(
      await operations.inspectProcess(identity.pid),
      identity,
      supervisorNonce,
      'before anchor exit',
    );
    operations.signalProcess(identity.pid, 'SIGUSR1');
    const anchorDeadline = Date.now() + 5_000;
    while (
      (await operations.processGroupMembers(identity.processGroupId)).length >
        0 &&
      Date.now() < anchorDeadline
    ) {
      await delay(25);
    }
  }
  if (
    (await operations.processGroupMembers(identity.processGroupId)).length > 0
  ) {
    throw new Error(
      `The exact event-room Playwright ${identity.label} process group remained after termination.`,
    );
  }
}

export async function terminateInterruptedEventRoomPlaywrightWebServer(
  value: unknown,
  expectedIdentity: EventRoomPlaywrightWebServerIdentity,
  supervisorNonce: string,
  operations: EventRoomPlaywrightOrphanCleanupOperations,
): Promise<void> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const actualMarker = readEventRoomPlaywrightWebServerIdentity(
    context,
    supervisorNonce,
  );
  if (
    actualMarker === null ||
    !exactStringEqual(
      JSON.stringify(actualMarker),
      JSON.stringify(expectedIdentity),
    )
  ) {
    throw new Error(
      'The event-room Playwright web-server identity was altered or replaced.',
    );
  }
  await terminateExactPlaywrightProcessGroup(
    {
      pid: expectedIdentity.webServerPid,
      processGroupId: expectedIdentity.processGroupId,
      processStartedAt: expectedIdentity.processStartedAt,
      commandHash: expectedIdentity.commandHash,
      label: 'web-server',
      nonceMustAppearInCommand: false,
    },
    supervisorNonce,
    operations,
    false,
  );
}

/**
 * Reaps only a coordinator whose immutable run-bound identity is current.
 * Missing, stale, altered, or mismatched identity never authorizes a signal or
 * deletion. Database deletion follows exact tree exit and loopback port close.
 */
export async function cleanupInterruptedEventRoomPlaywrightCoordinator(
  value: unknown,
  expectedIdentity: EventRoomPlaywrightCoordinatorIdentity,
  supervisorNonce: string,
  operations: EventRoomPlaywrightOrphanCleanupOperations,
): Promise<void> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const identity = requireEventRoomPlaywrightCoordinatorIdentity(
    context,
    expectedIdentity,
    supervisorNonce,
  );
  await terminateExactPlaywrightProcessGroup(
    {
      pid: identity.coordinatorPid,
      processGroupId: identity.processGroupId,
      processStartedAt: identity.processStartedAt,
      commandHash: identity.commandHash,
      label: 'coordinator',
      nonceMustAppearInCommand: true,
    },
    supervisorNonce,
    operations,
    true,
  );
  await operations.waitForPortClose(context.appPort);
  await operations.dropOwnedDatabase(context);
  rmSync(context.runDirectory, { force: true, recursive: true });
  releaseEventRoomPlaywrightPortLeaseIfOwned(context);
  rmSync(context.supervisionDirectory, { force: true, recursive: true });
}

/**
 * Keeps the run directory and port lease until the owned Next process exits,
 * its loopback port is confirmed closed, and its owned database cleanup
 * succeeds. Only then does it record stopped evidence and release the lease.
 * Reporter output remains until the cleanup reporter's onExit, after every
 * reporter has finished writing.
 */
export async function finalizeEventRoomPlaywrightWebServer(
  value: unknown,
  waitForServerExit: () => Promise<number>,
  waitForPortClose: (appPort: number) => Promise<void>,
  cleanupOwnedDatabaseAfterPortClose: () => Promise<unknown>,
): Promise<number> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const exitCode = await waitForServerExit();
  await waitForPortClose(context.appPort);
  await cleanupOwnedDatabaseAfterPortClose();
  recordStoppedEventRoomPlaywrightServer(context);
  return exitCode;
}
