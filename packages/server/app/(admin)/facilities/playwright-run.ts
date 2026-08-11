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

import { requireSyntheticTestDatabaseUrl } from '../event-types/test-database';

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MINIMUM_APP_PORT = 12_000;
const APP_PORT_COUNT = 8_000;
const PORT_CLOSE_TIMEOUT_MS = 15_000;
const PORT_LEASE_DIRECTORY = join(
  tmpdir(),
  'psd-eoc-issue26-admin-port-leases',
);

export const ADMIN_PLAYWRIGHT_RUN_CONTEXT_ENV =
  'PSD_EOC_ADMIN_PLAYWRIGHT_RUN_CONTEXT';

export interface AdminPlaywrightRunContext {
  readonly runId: string;
  readonly baseDatabaseUrl: string;
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly runDirectory: string;
  readonly storageStatePath: string;
  readonly outputDirectory: string;
  readonly workspaceDirectory: string;
  readonly serverDirectory: string;
  readonly serverWorkspaceReadyPath: string;
  readonly serverWorkspacePreparationLeasePath: string;
  readonly appPort: number;
  readonly portLeasePath: string;
  readonly leaseOwnerPid: number;
}

function buildAdminPlaywrightRunContext(
  baseDatabaseUrl: string,
  runId: string,
  appPort: number,
  leaseOwnerPid: number,
): AdminPlaywrightRunContext {
  const validatedBaseUrl = requireSyntheticTestDatabaseUrl(baseDatabaseUrl);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('The administration Playwright run ID must be a UUID.');
  }
  if (
    !Number.isSafeInteger(appPort) ||
    appPort < MINIMUM_APP_PORT ||
    appPort >= MINIMUM_APP_PORT + APP_PORT_COUNT ||
    !Number.isSafeInteger(leaseOwnerPid) ||
    leaseOwnerPid <= 0
  ) {
    throw new Error('The administration Playwright port lease is invalid.');
  }

  const compactRunId = runId.replaceAll('-', '');
  const databaseName = `psd_eoc_issue26_admin_${compactRunId}_test`;
  const databaseUrl = new URL(validatedBaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const runDirectory = join(tmpdir(), `psd-eoc-issue26-admin-${runId}`);
  const workspaceDirectory = join(runDirectory, 'workspace');
  const serverDirectory = join(workspaceDirectory, 'packages', 'server');

  return Object.freeze({
    runId,
    baseDatabaseUrl: validatedBaseUrl,
    databaseUrl: databaseUrl.toString(),
    databaseName,
    runDirectory,
    storageStatePath: join(runDirectory, 'storage-state.json'),
    outputDirectory: join(runDirectory, 'playwright-output'),
    workspaceDirectory,
    serverDirectory,
    serverWorkspaceReadyPath: join(
      workspaceDirectory,
      '.issue26-admin-server-workspace-ready.json',
    ),
    serverWorkspacePreparationLeasePath: join(
      runDirectory,
      'server-workspace-preparation.json',
    ),
    appPort,
    portLeasePath: join(PORT_LEASE_DIRECTORY, `${appPort}.json`),
    leaseOwnerPid,
  });
}

function serializedPortLease(
  context: Pick<
    AdminPlaywrightRunContext,
    'runId' | 'appPort' | 'leaseOwnerPid'
  >,
): string {
  return JSON.stringify({
    runId: context.runId,
    appPort: context.appPort,
    leaseOwnerPid: context.leaseOwnerPid,
  });
}

function isExistingLease(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

/** Atomically reserves an issue-owned port and derives every run-owned path. */
export function claimAdminPlaywrightRunContext(
  baseDatabaseUrl: string,
  runId: string,
  leaseOwnerPid = process.pid,
): AdminPlaywrightRunContext {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('The administration Playwright run ID must be a UUID.');
  }
  const portSeed = Number.parseInt(runId.replaceAll('-', '').slice(0, 8), 16);
  const startingPort = MINIMUM_APP_PORT + (portSeed % APP_PORT_COUNT);
  mkdirSync(PORT_LEASE_DIRECTORY, { mode: 0o700, recursive: true });

  for (let offset = 0; offset < APP_PORT_COUNT; offset += 1) {
    const appPort =
      MINIMUM_APP_PORT +
      ((startingPort - MINIMUM_APP_PORT + offset) % APP_PORT_COUNT);
    const context = buildAdminPlaywrightRunContext(
      baseDatabaseUrl,
      runId,
      appPort,
      leaseOwnerPid,
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
  throw new Error('No administration Playwright app port lease is available.');
}

export function requireAdminPlaywrightRunContext(
  value: unknown,
): AdminPlaywrightRunContext {
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
    throw new Error('The administration Playwright run metadata is invalid.');
  }
  const expected = buildAdminPlaywrightRunContext(
    value.baseDatabaseUrl,
    value.runId,
    value.appPort,
    value.leaseOwnerPid,
  );
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error('The administration Playwright run metadata was altered.');
  }
  return expected;
}

export function requireInheritedAdminPlaywrightRunContext(
  environment: NodeJS.ProcessEnv = process.env,
): AdminPlaywrightRunContext {
  const serialized = environment[ADMIN_PLAYWRIGHT_RUN_CONTEXT_ENV];
  if (serialized === undefined) {
    throw new Error(
      'The inherited administration Playwright run context is missing.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      'The inherited administration Playwright run context is invalid JSON.',
      { cause: error },
    );
  }
  return requireAdminPlaywrightRunContext(parsed);
}

/**
 * Creates one context in the Bun gate and makes Playwright config re-evaluation
 * reuse that exact database, storage file, output directory, and port.
 */
export function resolveAdminPlaywrightRunContext(
  baseDatabaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  createRunId: () => string = randomUUID,
): AdminPlaywrightRunContext {
  const inherited = environment[ADMIN_PLAYWRIGHT_RUN_CONTEXT_ENV];
  if (inherited !== undefined) {
    const context = requireInheritedAdminPlaywrightRunContext(environment);
    if (context.baseDatabaseUrl !== baseDatabaseUrl) {
      throw new Error(
        'The administration Playwright run targets a different base database.',
      );
    }
    return context;
  }
  const context = claimAdminPlaywrightRunContext(
    baseDatabaseUrl,
    createRunId(),
  );
  environment[ADMIN_PLAYWRIGHT_RUN_CONTEXT_ENV] = JSON.stringify(context);
  return context;
}

function requireOwnedPortLease(context: AdminPlaywrightRunContext): void {
  let actual: string;
  try {
    actual = readFileSync(context.portLeasePath, 'utf8');
  } catch (error) {
    throw new Error('The administration Playwright port lease is missing.', {
      cause: error,
    });
  }
  if (actual !== serializedPortLease(context)) {
    throw new Error('The administration Playwright port lease owner changed.');
  }
}

export function releaseAdminPlaywrightPortLease(value: unknown): void {
  const context = requireAdminPlaywrightRunContext(value);
  requireOwnedPortLease(context);
  unlinkSync(context.portLeasePath);
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`);
}

function serverWorkspaceMarker(
  context: AdminPlaywrightRunContext,
  sourceServerDirectory: string,
): string {
  return JSON.stringify({
    kind: 'psd-eoc-issue26-admin-playwright-workspace',
    version: 1,
    runId: context.runId,
    sourceServerDirectory,
    workspaceDirectory: context.workspaceDirectory,
    serverDirectory: context.serverDirectory,
  });
}

function requirePreparedServerWorkspace(
  context: AdminPlaywrightRunContext,
  sourceServerDirectory: string,
): void {
  let marker: string;
  try {
    marker = readFileSync(context.serverWorkspaceReadyPath, 'utf8');
  } catch (error) {
    throw new Error(
      'The administration Playwright server workspace is not ready.',
      { cause: error },
    );
  }
  if (marker !== serverWorkspaceMarker(context, sourceServerDirectory)) {
    throw new Error(
      'The administration Playwright server workspace marker was altered.',
    );
  }
  for (const path of [
    context.workspaceDirectory,
    context.serverDirectory,
    join(context.serverDirectory, 'package.json'),
    join(context.workspaceDirectory, 'node_modules'),
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        'The administration Playwright server workspace is incomplete.',
      );
    }
  }
}

/** Keeps Next-generated files out of the shared checkout during parallel gates. */
export function prepareAdminPlaywrightServerWorkspace(
  value: unknown,
  sourceServerDirectoryValue: string,
): void {
  const context = requireAdminPlaywrightRunContext(value);
  const sourceServerDirectory = resolve(sourceServerDirectoryValue);
  const sourceWorkspaceDirectory = resolve(sourceServerDirectory, '../..');
  const sourceNodeModules = join(sourceWorkspaceDirectory, 'node_modules');
  const sourcePlaywrightTsconfig = join(
    sourceServerDirectory,
    'app',
    '(admin)',
    'facilities',
    'playwright.server-tsconfig.json',
  );
  for (const sourcePath of [
    sourceServerDirectory,
    join(sourceServerDirectory, 'package.json'),
    sourcePlaywrightTsconfig,
    join(sourceWorkspaceDirectory, 'package.json'),
    join(sourceWorkspaceDirectory, 'tsconfig.base.json'),
    sourceNodeModules,
  ]) {
    if (!existsSync(sourcePath)) {
      throw new Error(
        'The administration Playwright source workspace is incomplete.',
      );
    }
  }
  if (
    !pathIsWithin(context.runDirectory, context.workspaceDirectory) ||
    !pathIsWithin(context.workspaceDirectory, context.serverDirectory)
  ) {
    throw new Error(
      'The administration Playwright workspace escaped its run directory.',
    );
  }
  if (existsSync(context.serverWorkspaceReadyPath)) {
    requirePreparedServerWorkspace(context, sourceServerDirectory);
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
        'Another process is preparing the administration Playwright workspace.',
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
        'An unpublished administration Playwright workspace already exists.',
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
          sourceRelativePath === 'tsconfig.json' ||
          sourceRelativePath.endsWith('.tsbuildinfo')
        );
      },
      recursive: true,
    });
    copyFileSync(
      sourcePlaywrightTsconfig,
      join(stagingServerDirectory, 'tsconfig.json'),
    );
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
        '.issue26-admin-server-workspace-ready.json',
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

export async function waitForAdminPlaywrightPortToClose(
  appPort: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(appPort) ||
    appPort < MINIMUM_APP_PORT ||
    appPort >= MINIMUM_APP_PORT + APP_PORT_COUNT
  ) {
    throw new Error('The administration Playwright app port is invalid.');
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
        'The administration Playwright server retained its port after exit.',
      );
    }
    await delay(50);
  }
}

/** Removes only the exact validated run after its server and database stop. */
export function cleanupAdminPlaywrightRunArtifacts(value: unknown): void {
  const context = requireAdminPlaywrightRunContext(value);
  requireOwnedPortLease(context);
  rmSync(context.runDirectory, { force: true, recursive: true });
  releaseAdminPlaywrightPortLease(context);
}
