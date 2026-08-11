import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  readonly appPort: number;
  readonly portLeasePath: string;
  readonly leaseOwnerPid: number;
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
 */
export async function cleanupEventRoomPlaywrightRunAfterChildExit(
  value: unknown,
  waitForPortClose: (
    appPort: number,
  ) => Promise<void> = waitForEventRoomPlaywrightPortToClose,
): Promise<void> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const leaseOwnership = inspectEventRoomPlaywrightPortLease(context);
  if (!existsSync(context.runDirectory) && leaseOwnership !== 'owned') return;
  if (!hasStoppedServerEvidence(context)) {
    await waitForPortClose(context.appPort);
  }
  rmSync(context.runDirectory, { force: true, recursive: true });
  releaseEventRoomPlaywrightPortLeaseIfOwned(context);
}

/**
 * Keeps the run directory and port lease until the owned Next process exits
 * and its loopback port is confirmed closed, then records stopped evidence
 * and releases the lease. Reporter output remains until the cleanup reporter's
 * onExit, after every reporter has finished writing.
 */
export async function finalizeEventRoomPlaywrightWebServer(
  value: unknown,
  waitForServerExit: () => Promise<number>,
  waitForPortClose: (appPort: number) => Promise<void>,
): Promise<number> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const exitCode = await waitForServerExit();
  await waitForPortClose(context.appPort);
  recordStoppedEventRoomPlaywrightServer(context);
  return exitCode;
}
