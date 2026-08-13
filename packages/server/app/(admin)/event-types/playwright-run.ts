import { randomUUID } from 'node:crypto';
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
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { requireSyntheticTestDatabaseUrl } from './test-database';

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MINIMUM_APP_PORT = 50_000;
const APP_PORT_COUNT = 10_000;
const PORT_CLOSE_TIMEOUT_MS = 15_000;
const PORT_LEASE_DIRECTORY = join(
  tmpdir(),
  'psd-eoc-event-type-playwright-port-leases',
);

export const EVENT_TYPE_PLAYWRIGHT_RUN_CONTEXT_ENV =
  'PSD_EOC_EVENT_TYPE_PLAYWRIGHT_RUN_CONTEXT';

export interface EventTypePlaywrightRunContext {
  readonly runId: string;
  readonly baseDatabaseUrl: string;
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly runDirectory: string;
  readonly runOwnershipPath: string;
  readonly storageStatePath: string;
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

function buildEventTypePlaywrightRunContext(
  baseDatabaseUrl: string,
  runId: string,
  appPort: number,
  leaseOwnerPid: number,
): EventTypePlaywrightRunContext {
  const validatedBaseUrl = requireSyntheticTestDatabaseUrl(baseDatabaseUrl);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('The event-type Playwright run ID must be a random UUID.');
  }
  if (
    !Number.isSafeInteger(appPort) ||
    appPort < MINIMUM_APP_PORT ||
    appPort >= MINIMUM_APP_PORT + APP_PORT_COUNT ||
    !Number.isSafeInteger(leaseOwnerPid) ||
    leaseOwnerPid <= 0
  ) {
    throw new Error('The event-type Playwright port lease is invalid.');
  }

  const compactRunId = runId.replaceAll('-', '');
  const databaseName = `psd_eoc_event_type_${compactRunId}_test`;
  const databaseUrl = new URL(validatedBaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const runDirectory = join(tmpdir(), `psd-eoc-event-type-${runId}`);
  const workspaceDirectory = join(runDirectory, 'workspace');
  const serverDirectory = join(workspaceDirectory, 'packages', 'server');

  return Object.freeze({
    runId,
    baseDatabaseUrl: validatedBaseUrl,
    databaseUrl: databaseUrl.toString(),
    databaseName,
    runDirectory,
    runOwnershipPath: join(runDirectory, 'run-ownership.json'),
    storageStatePath: join(runDirectory, 'storage-state.json'),
    outputDirectory: join(runDirectory, 'playwright-output'),
    workspaceDirectory,
    serverDirectory,
    serverBuildDirectory: join(serverDirectory, '.next'),
    serverTsconfigPath: join(serverDirectory, 'tsconfig.json'),
    serverNextEnvPath: join(serverDirectory, 'next-env.d.ts'),
    serverWorkspaceReadyPath: join(
      workspaceDirectory,
      '.event-type-server-workspace-ready.json',
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

function serializedPortLease(
  context: Pick<
    EventTypePlaywrightRunContext,
    'runId' | 'appPort' | 'leaseOwnerPid'
  >,
): string {
  return JSON.stringify({
    runId: context.runId,
    appPort: context.appPort,
    leaseOwnerPid: context.leaseOwnerPid,
  });
}

function serializedRunOwnership(
  context: EventTypePlaywrightRunContext,
): string {
  return JSON.stringify({
    kind: 'psd-eoc-event-type-playwright-run',
    version: 1,
    runId: context.runId,
    runDirectory: context.runDirectory,
    portLeasePath: context.portLeasePath,
    leaseOwnerPid: context.leaseOwnerPid,
  });
}

function isExistingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function requireOwnedRunDirectory(
  context: EventTypePlaywrightRunContext,
): void {
  let marker: string;
  try {
    marker = readFileSync(context.runOwnershipPath, 'utf8');
  } catch (error) {
    throw new Error(
      'The event-type Playwright run ownership marker is missing.',
      { cause: error },
    );
  }
  if (marker !== serializedRunOwnership(context)) {
    throw new Error(
      'The event-type Playwright run ownership marker was altered.',
    );
  }
}

function initializeOwnedRunDirectory(
  context: EventTypePlaywrightRunContext,
): void {
  let createdDirectory = false;
  try {
    mkdirSync(context.runDirectory, { mode: 0o700 });
    createdDirectory = true;
    const descriptor = openSync(context.runOwnershipPath, 'wx', 0o600);
    try {
      writeFileSync(descriptor, serializedRunOwnership(context), 'utf8');
    } finally {
      closeSync(descriptor);
    }
    requireOwnedRunDirectory(context);
  } catch (error) {
    if (createdDirectory) {
      rmSync(context.runDirectory, { force: true, recursive: true });
    }
    throw error;
  }
}

/** Atomically leases one issue-owned loopback port and artifact directory. */
export function claimEventTypePlaywrightRunContext(
  baseDatabaseUrl: string,
  runId: string,
  preferredPort?: number,
  leaseOwnerPid = process.pid,
): EventTypePlaywrightRunContext {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('The event-type Playwright run ID must be a random UUID.');
  }
  const portSeed = Number.parseInt(runId.replaceAll('-', '').slice(0, 8), 16);
  const startingPort =
    preferredPort ?? MINIMUM_APP_PORT + (portSeed % APP_PORT_COUNT);
  if (
    !Number.isSafeInteger(startingPort) ||
    startingPort < MINIMUM_APP_PORT ||
    startingPort >= MINIMUM_APP_PORT + APP_PORT_COUNT
  ) {
    throw new Error('The preferred event-type Playwright port is invalid.');
  }
  mkdirSync(PORT_LEASE_DIRECTORY, { mode: 0o700, recursive: true });

  for (let offset = 0; offset < APP_PORT_COUNT; offset += 1) {
    const appPort =
      MINIMUM_APP_PORT +
      ((startingPort - MINIMUM_APP_PORT + offset) % APP_PORT_COUNT);
    const context = buildEventTypePlaywrightRunContext(
      baseDatabaseUrl,
      runId,
      appPort,
      leaseOwnerPid,
    );
    let descriptor: number;
    try {
      descriptor = openSync(context.portLeasePath, 'wx', 0o600);
    } catch (error) {
      if (isExistingPath(error)) continue;
      throw error;
    }
    try {
      writeFileSync(descriptor, serializedPortLease(context), 'utf8');
    } finally {
      closeSync(descriptor);
    }
    try {
      initializeOwnedRunDirectory(context);
      return context;
    } catch (error) {
      unlinkSync(context.portLeasePath);
      throw error;
    }
  }
  throw new Error('No event-type Playwright app port lease is available.');
}

export function requireEventTypePlaywrightRunContext(
  value: unknown,
): EventTypePlaywrightRunContext {
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
    throw new Error('The event-type Playwright run metadata is invalid.');
  }
  const expected = buildEventTypePlaywrightRunContext(
    value.baseDatabaseUrl,
    value.runId,
    value.appPort,
    value.leaseOwnerPid,
  );
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error('The event-type Playwright run metadata was altered.');
  }
  return expected;
}

export function requireInheritedEventTypePlaywrightRunContext(
  environment: NodeJS.ProcessEnv = process.env,
): EventTypePlaywrightRunContext {
  const serialized = environment[EVENT_TYPE_PLAYWRIGHT_RUN_CONTEXT_ENV];
  if (serialized === undefined) {
    throw new Error('The inherited event-type Playwright run is missing.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      'The inherited event-type Playwright run metadata is invalid JSON.',
      { cause: error },
    );
  }
  return requireEventTypePlaywrightRunContext(parsed);
}

/** Reuses the coordinator's exact run when Playwright evaluates config again. */
export function resolveEventTypePlaywrightRunContext(
  baseDatabaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  createRunId: () => string = randomUUID,
): EventTypePlaywrightRunContext {
  const inherited = environment[EVENT_TYPE_PLAYWRIGHT_RUN_CONTEXT_ENV];
  if (inherited !== undefined) {
    const context = requireInheritedEventTypePlaywrightRunContext(environment);
    if (context.baseDatabaseUrl !== baseDatabaseUrl) {
      throw new Error(
        'The inherited event-type Playwright run targets a different base database.',
      );
    }
    return context;
  }
  const context = claimEventTypePlaywrightRunContext(
    baseDatabaseUrl,
    createRunId(),
  );
  environment[EVENT_TYPE_PLAYWRIGHT_RUN_CONTEXT_ENV] = JSON.stringify(context);
  return context;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`);
}

function serverWorkspaceMarker(
  context: EventTypePlaywrightRunContext,
  sourceServerDirectory: string,
): string {
  return JSON.stringify({
    kind: 'psd-eoc-event-type-playwright-workspace',
    version: 1,
    runId: context.runId,
    sourceServerDirectory,
    workspaceDirectory: context.workspaceDirectory,
    serverDirectory: context.serverDirectory,
  });
}

function requirePreparedServerWorkspace(
  context: EventTypePlaywrightRunContext,
  sourceServerDirectory: string,
): void {
  requireOwnedRunDirectory(context);
  let marker: string;
  try {
    marker = readFileSync(context.serverWorkspaceReadyPath, 'utf8');
  } catch (error) {
    throw new Error(
      'The event-type Playwright server workspace is not ready.',
      { cause: error },
    );
  }
  if (marker !== serverWorkspaceMarker(context, sourceServerDirectory)) {
    throw new Error(
      'The event-type Playwright server workspace marker was altered.',
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
        'The event-type Playwright server workspace is incomplete.',
      );
    }
  }
}

/** Copies source into a run overlay so Next writes no shared bookkeeping. */
export function prepareEventTypePlaywrightServerWorkspace(
  value: unknown,
  sourceServerDirectoryValue: string,
): void {
  const context = requireEventTypePlaywrightRunContext(value);
  requireOwnedRunDirectory(context);
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
        'The event-type Playwright source workspace is incomplete.',
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
      'The event-type Playwright workspace escaped its run directory.',
    );
  }
  if (existsSync(context.serverWorkspaceReadyPath)) {
    requirePreparedServerWorkspace(context, sourceServerDirectory);
    return;
  }

  let preparationLease: number;
  try {
    preparationLease = openSync(
      context.serverWorkspacePreparationLeasePath,
      'wx',
      0o600,
    );
  } catch (error) {
    if (isExistingPath(error)) {
      throw new Error(
        'Another process is preparing the event-type Playwright workspace.',
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
        'An unpublished event-type Playwright workspace already exists.',
      );
    }
    rmSync(stagingWorkspaceDirectory, { force: true, recursive: true });
    mkdirSync(dirname(stagingServerDirectory), {
      mode: 0o700,
      recursive: true,
    });
    cpSync(sourceServerDirectory, stagingServerDirectory, {
      errorOnExist: true,
      force: false,
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
        '.event-type-server-workspace-ready.json',
      ),
      serverWorkspaceMarker(context, sourceServerDirectory),
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(stagingWorkspaceDirectory, context.workspaceDirectory);
    requirePreparedServerWorkspace(context, sourceServerDirectory);
  } catch (error) {
    rmSync(stagingWorkspaceDirectory, { force: true, recursive: true });
    throw error;
  } finally {
    unlinkSync(context.serverWorkspacePreparationLeasePath);
  }
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

export async function waitForEventTypePlaywrightPortToClose(
  appPort: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(appPort) ||
    appPort < MINIMUM_APP_PORT ||
    appPort >= MINIMUM_APP_PORT + APP_PORT_COUNT
  ) {
    throw new Error('The event-type Playwright app port is invalid.');
  }
  const deadline = Date.now() + PORT_CLOSE_TIMEOUT_MS;
  while (true) {
    const open = (
      await Promise.all([
        loopbackHostAcceptsConnections('127.0.0.1', appPort),
        loopbackHostAcceptsConnections('::1', appPort),
      ])
    ).some(Boolean);
    if (!open) return;
    if (Date.now() >= deadline) {
      throw new Error(
        'The event-type Playwright Next server retained its port after exit.',
      );
    }
    await delay(50);
  }
}

function requireValidReplacementPortLease(
  serialized: string,
  appPort: number,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error('The event-type Playwright port lease is invalid JSON.', {
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
    throw new Error('The event-type Playwright port lease is invalid.');
  }
}

export type EventTypePlaywrightPortLeaseOwnership =
  | 'absent'
  | 'owned'
  | 'replacement';

export function inspectEventTypePlaywrightPortLease(
  value: unknown,
): EventTypePlaywrightPortLeaseOwnership {
  const context = requireEventTypePlaywrightRunContext(value);
  let serialized: string;
  try {
    serialized = readFileSync(context.portLeasePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  if (serialized === serializedPortLease(context)) return 'owned';
  requireValidReplacementPortLease(serialized, context.appPort);
  return 'replacement';
}

export function releaseEventTypePlaywrightPortLease(value: unknown): void {
  const context = requireEventTypePlaywrightRunContext(value);
  if (inspectEventTypePlaywrightPortLease(context) !== 'owned') {
    throw new Error('The event-type Playwright port lease owner changed.');
  }
  unlinkSync(context.portLeasePath);
}

export function releaseEventTypePlaywrightPortLeaseIfOwned(
  value: unknown,
): boolean {
  const context = requireEventTypePlaywrightRunContext(value);
  if (inspectEventTypePlaywrightPortLease(context) !== 'owned') return false;
  releaseEventTypePlaywrightPortLease(context);
  return true;
}

function stoppedServerMarker(context: EventTypePlaywrightRunContext): string {
  return JSON.stringify({
    kind: 'psd-eoc-event-type-playwright-stopped-server',
    version: 1,
    runId: context.runId,
    appPort: context.appPort,
    leaseOwnerPid: context.leaseOwnerPid,
  });
}

function recordStoppedEventTypePlaywrightServer(
  context: EventTypePlaywrightRunContext,
): void {
  requireOwnedRunDirectory(context);
  const descriptor = openSync(context.serverStoppedPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, stoppedServerMarker(context), 'utf8');
  } finally {
    closeSync(descriptor);
  }
  releaseEventTypePlaywrightPortLease(context);
}

function hasStoppedServerEvidence(
  context: EventTypePlaywrightRunContext,
): boolean {
  let marker: string;
  try {
    marker = readFileSync(context.serverStoppedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (marker !== stoppedServerMarker(context)) {
    throw new Error(
      'The event-type Playwright stopped-server marker was altered.',
    );
  }
  return true;
}

/** Reporter cleanup requires exact run and stopped-server marker proof. */
export function cleanupReportedEventTypePlaywrightRun(value: unknown): void {
  const context = requireEventTypePlaywrightRunContext(value);
  requireOwnedRunDirectory(context);
  if (!hasStoppedServerEvidence(context)) {
    throw new Error(
      'The event-type Playwright server has no stopped evidence.',
    );
  }
  if (inspectEventTypePlaywrightPortLease(context) === 'owned') {
    throw new Error(
      'The event-type Playwright port lease remains owned after server stop.',
    );
  }
  rmSync(context.runDirectory, { force: true, recursive: true });
}

/** Idempotent outer-gate cleanup after the exact child process has exited. */
export async function cleanupEventTypePlaywrightRunAfterChildExit(
  value: unknown,
  waitForPortClose: (
    appPort: number,
  ) => Promise<void> = waitForEventTypePlaywrightPortToClose,
): Promise<void> {
  const context = requireEventTypePlaywrightRunContext(value);
  const leaseOwnership = inspectEventTypePlaywrightPortLease(context);
  if (!existsSync(context.runDirectory) && leaseOwnership !== 'owned') return;
  if (existsSync(context.runDirectory)) {
    requireOwnedRunDirectory(context);
  }
  if (!existsSync(context.runDirectory) || !hasStoppedServerEvidence(context)) {
    await waitForPortClose(context.appPort);
  }
  if (existsSync(context.runDirectory)) {
    requireOwnedRunDirectory(context);
    rmSync(context.runDirectory, { force: true, recursive: true });
  }
  releaseEventTypePlaywrightPortLeaseIfOwned(context);
}

/** Records shutdown only after Next, its port, and its owned database stop. */
export async function finalizeEventTypePlaywrightWebServer(
  value: unknown,
  waitForServerExit: () => Promise<number>,
  waitForPortClose: (appPort: number) => Promise<void>,
  cleanupOwnedDatabaseAfterPortClose: () => Promise<unknown>,
): Promise<number> {
  const context = requireEventTypePlaywrightRunContext(value);
  requireOwnedRunDirectory(context);
  const exitCode = await waitForServerExit();
  await waitForPortClose(context.appPort);
  await cleanupOwnedDatabaseAfterPortClose();
  recordStoppedEventTypePlaywrightServer(context);
  return exitCode;
}
