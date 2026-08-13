import { randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { UuidSchema } from '@psd-eoc/contracts';
import { z } from 'zod';

const RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const MANIFEST_BASENAME_PATTERN =
  /^psd-eoc-issue32-mobile-[A-Za-z0-9_-]+\.json$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const USER_PORT_MINIMUM = 1_024;
const USER_PORT_MAXIMUM = 65_535;
const RUNTIME_ROOT_PREFIX = 'psd-eoc-issue32-mobile-runtime-';

export const MobileRuntimeManifestSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN),
    appOrigin: z.string().url(),
    idpOrigin: z.string().url(),
    event: z
      .object({
        id: UuidSchema,
        facilityId: UuidSchema,
        eventTypeVersionId: UuidSchema,
        routeEvidence: z.string().min(1).max(10_000),
      })
      .strict()
      .readonly(),
    classification: z.literal('drill'),
    templateMode: z.literal('drill'),
    rosterPopulation: z.literal('synthetic'),
  })
  .strict()
  .superRefine((manifest, context) => {
    const origins = new Map<'appOrigin' | 'idpOrigin', string>();
    for (const [field, value] of [
      ['appOrigin', manifest.appOrigin],
      ['idpOrigin', manifest.idpOrigin],
    ] as const) {
      const url = new URL(value);
      origins.set(field, url.origin);
      if (
        url.protocol !== 'http:' ||
        !LOOPBACK_HOSTS.has(normalizedHostname(url)) ||
        url.pathname !== '/' ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        context.addIssue({
          code: 'custom',
          message: `${field} must be an origin-only loopback HTTP URL.`,
          path: [field],
        });
      }
    }
    if (origins.get('appOrigin') === origins.get('idpOrigin')) {
      context.addIssue({
        code: 'custom',
        message: 'The application and identity-provider origins must differ.',
        path: ['idpOrigin'],
      });
    }
    if (
      manifest.event.routeEvidence !== `Issue 32 route proof ${manifest.runId}`
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Route evidence must be bound to the exact runtime run.',
        path: ['event', 'routeEvidence'],
      });
    }
  })
  .readonly();

export type MobileRuntimeManifest = z.infer<typeof MobileRuntimeManifestSchema>;

export interface MobileRuntimeCliOptions {
  readonly command: 'start';
  readonly runId: string;
  readonly manifestPath: string;
  readonly appPort: number;
  readonly idpPort: number;
}

export interface MobileRuntimePaths {
  readonly root: string;
  readonly owner: string;
  readonly workspace: string;
  readonly copiedServer: string;
}

export interface OwnedManifest {
  readonly path: string;
  readonly guardPath: string;
  readonly device: number;
  readonly inode: number;
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function parseUserPort(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a decimal user port.`);
  }
  const port = Number(value);
  if (
    !Number.isSafeInteger(port) ||
    port < USER_PORT_MINIMUM ||
    port > USER_PORT_MAXIMUM
  ) {
    throw new Error(
      `${name} must be from ${USER_PORT_MINIMUM} through ${USER_PORT_MAXIMUM}.`,
    );
  }
  return port;
}

/** Parses the intentionally small, stable process interface used by Maestro. */
export function parseMobileRuntimeCli(
  arguments_: readonly string[],
): MobileRuntimeCliOptions {
  if (arguments_[0] !== 'start') {
    throw new Error(
      'Usage: mobile-runtime.ts start --run-id RUN_ID --manifest PATH --app-port PORT --idp-port PORT',
    );
  }
  const options = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !['--run-id', '--manifest', '--app-port', '--idp-port'].includes(name) ||
      options.has(name)
    ) {
      throw new Error(
        'Usage: mobile-runtime.ts start --run-id RUN_ID --manifest PATH --app-port PORT --idp-port PORT',
      );
    }
    options.set(name, value);
  }
  if (options.size !== 4) {
    throw new Error(
      'Usage: mobile-runtime.ts start --run-id RUN_ID --manifest PATH --app-port PORT --idp-port PORT',
    );
  }
  const runId = requireMobileRuntimeRunId(options.get('--run-id') ?? '');
  const manifestPath = options.get('--manifest') ?? '';
  if (!isAbsolute(manifestPath)) {
    throw new Error('--manifest must be an absolute path.');
  }
  const appPort = parseUserPort(options.get('--app-port'), '--app-port');
  const idpPort = parseUserPort(options.get('--idp-port'), '--idp-port');
  if (appPort === idpPort) {
    throw new Error('The application and identity-provider ports must differ.');
  }
  return Object.freeze({
    command: 'start',
    runId,
    manifestPath: resolve(manifestPath),
    appPort,
    idpPort,
  });
}

/** Refuses to create any database or process without issue #32's safety flag. */
export function requireMobileRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (environment.PSD_EOC_E2E_SYNTHETIC_ONLY !== 'true') {
    throw new Error(
      'PSD_EOC_E2E_SYNTHETIC_ONLY=true is required for the mobile runtime.',
    );
  }
  const value = environment.TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error('TEST_DATABASE_URL is required for the mobile runtime.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL must name a synthetic test database.');
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    !LOOPBACK_HOSTS.has(normalizedHostname(url)) ||
    !/^[A-Za-z0-9_-]+[-_]test$/u.test(databaseName) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target a loopback PostgreSQL database whose name ends in _test.',
    );
  }
  return value;
}

export function createMobileRuntimeRunId(): string {
  return randomBytes(16).toString('hex');
}

export function requireMobileRuntimeRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error(
      'The issue #32 mobile runtime run ID must be 32 lowercase hexadecimal characters.',
    );
  }
  return value;
}

export function mobileRuntimePaths(runIdValue: string): MobileRuntimePaths {
  const runId = requireMobileRuntimeRunId(runIdValue);
  const temporaryRoot = resolve(tmpdir());
  const expectedBasename = `${RUNTIME_ROOT_PREFIX}${runId}`;
  const root = resolve(temporaryRoot, expectedBasename);
  if (dirname(root) !== temporaryRoot || basename(root) !== expectedBasename) {
    throw new Error('Refusing to address an unexpected mobile runtime root.');
  }
  const workspace = resolve(root, 'workspace');
  return Object.freeze({
    root,
    owner: resolve(root, '.owner'),
    workspace,
    copiedServer: resolve(workspace, 'packages/server'),
  });
}

export async function acquireMobileRuntimeRoot(
  runIdValue: string,
): Promise<MobileRuntimePaths> {
  const runId = requireMobileRuntimeRunId(runIdValue);
  const paths = mobileRuntimePaths(runId);
  await mkdir(paths.root, { mode: 0o700 });
  try {
    await writeFile(paths.owner, `${runId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    await rm(paths.root, { recursive: true }).catch(() => undefined);
    throw error;
  }
  return paths;
}

export async function assertMobileRuntimeRootOwned(
  runIdValue: string,
): Promise<void> {
  const runId = requireMobileRuntimeRunId(runIdValue);
  const paths = mobileRuntimePaths(runId);
  const rootMetadata = await lstat(paths.root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('The mobile runtime root is not an owned directory.');
  }
  const ownerMetadata = await lstat(paths.owner);
  if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink()) {
    throw new Error('The mobile runtime ownership marker is invalid.');
  }
  const owner = await readFile(paths.owner, 'utf8');
  if (owner !== `${runId}\n`) {
    throw new Error('The mobile runtime ownership marker does not match.');
  }
}

export async function removeMobileRuntimeRoot(
  runIdValue: string,
): Promise<void> {
  const paths = mobileRuntimePaths(runIdValue);
  try {
    await lstat(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await assertMobileRuntimeRootOwned(runIdValue);
  await rm(paths.root, { recursive: true });
}

async function requireSafeManifestPath(value: string): Promise<string> {
  if (!isAbsolute(value)) {
    throw new Error('The mobile runtime manifest path must be absolute.');
  }
  const path = resolve(value);
  if (!MANIFEST_BASENAME_PATTERN.test(basename(path))) {
    throw new Error(
      'The mobile runtime manifest basename must start with psd-eoc-issue32-mobile- and end in .json.',
    );
  }
  const parent = dirname(path);
  const realParent = await realpath(parent);
  const allowedRoots = await Promise.all([
    realpath(tmpdir()),
    realpath('/tmp'),
  ]);
  const insideAllowedRoot = allowedRoots.some((allowedRoot) => {
    const fromAllowedRoot = relative(allowedRoot, realParent);
    return (
      fromAllowedRoot === '' ||
      (!fromAllowedRoot.startsWith('../') &&
        !fromAllowedRoot.startsWith('..\\') &&
        !isAbsolute(fromAllowedRoot))
    );
  });
  if (!insideAllowedRoot) {
    throw new Error(
      'The mobile runtime manifest must remain under the temporary directory.',
    );
  }
  return path;
}

/**
 * Atomically publishes one previously absent, mode-0600 ready manifest.
 * The retained staging hard link keeps its inode allocated until cleanup so
 * an unlink/recreate ABA cannot make an unrelated replacement look owned.
 */
export async function publishMobileRuntimeManifest(
  pathValue: string,
  manifestValue: unknown,
): Promise<OwnedManifest> {
  const path = await requireSafeManifestPath(pathValue);
  const manifest = MobileRuntimeManifestSchema.parse(manifestValue);
  const stagingPath = `${path}.publishing-${manifest.runId}`;
  const serialized = `${JSON.stringify(manifest)}\n`;
  let linked = false;
  let retainGuard = false;
  await writeFile(stagingPath, serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const stagingMetadata = await lstat(stagingPath);
  if (!stagingMetadata.isFile() || stagingMetadata.isSymbolicLink()) {
    await unlink(stagingPath).catch(() => undefined);
    throw new Error('The staged mobile runtime manifest is invalid.');
  }
  try {
    await link(stagingPath, path);
    linked = true;
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== stagingMetadata.dev ||
      metadata.ino !== stagingMetadata.ino
    ) {
      throw new Error('The published mobile runtime manifest is invalid.');
    }
    retainGuard = true;
    return Object.freeze({
      path,
      guardPath: stagingPath,
      device: metadata.dev,
      inode: metadata.ino,
    });
  } catch (error) {
    if (linked) {
      const publishedMetadata = await lstat(path).catch(() => null);
      if (
        publishedMetadata !== null &&
        publishedMetadata.isFile() &&
        !publishedMetadata.isSymbolicLink() &&
        publishedMetadata.dev === stagingMetadata.dev &&
        publishedMetadata.ino === stagingMetadata.ino
      ) {
        await unlink(path).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (!retainGuard) {
      await unlink(stagingPath).catch(() => undefined);
    }
  }
}

/** Removes only the exact guarded file identity returned by publication. */
export async function removeOwnedMobileRuntimeManifest(
  owned: OwnedManifest,
): Promise<void> {
  const guardMetadata = await lstat(owned.guardPath).catch(() => null);
  if (
    guardMetadata === null ||
    !guardMetadata.isFile() ||
    guardMetadata.isSymbolicLink() ||
    guardMetadata.dev !== owned.device ||
    guardMetadata.ino !== owned.inode
  ) {
    throw new Error(
      'Refusing to remove a mobile runtime manifest whose ownership guard changed.',
    );
  }
  let metadata;
  try {
    metadata = await lstat(owned.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await unlink(owned.guardPath);
      return;
    }
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== owned.device ||
    metadata.ino !== owned.inode
  ) {
    await unlink(owned.guardPath);
    throw new Error(
      'Refusing to remove a mobile runtime manifest whose identity changed.',
    );
  }
  await unlink(owned.path);
  await unlink(owned.guardPath);
}

/** Runs every cleanup task even when an earlier task fails. */
export async function executeMobileRuntimeCleanup(
  tasks: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Issue #32 mobile runtime cleanup did not complete cleanly.',
    );
  }
}
