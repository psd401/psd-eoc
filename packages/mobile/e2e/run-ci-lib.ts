import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  MobileRuntimeManifestSchema,
  requireMobileRuntimeEnvironment,
  type MobileRuntimeManifest,
} from '../../server/e2e/mobile-runtime-lib';

const RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const RUNNER_ROOT_PREFIX = 'psd-eoc-issue32-mobile-runner-';
const ARTIFACT_ISSUE_DIRECTORY = 'issue-32';
const OWNER_FILENAME = '.issue-32-owner';
const LOOPBACK_METRO_HOST = '127.0.0.1';
const USER_PORT_MINIMUM = 1_024;
const USER_PORT_MAXIMUM = 65_535;
const EXPO_PUBLIC_PSD_EOC_PREFIX = 'EXPO_PUBLIC_PSD_EOC_';
const IOS_DEVICE_TYPE_PREFERENCE =
  'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const LOOPBACK_NODE_OPTIONS = '--dns-result-order=ipv4first';
const MOBILE_WORKSPACE_EXCLUDED_ROOT_ENTRIES = new Set([
  '.expo',
  'android',
  'ios',
  'node_modules',
  'tsconfig.tsbuildinfo',
]);
const IOS_SIMULATOR_UDID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ISSUE_21_FIXTURE_RELATIVE_PATH =
  'src/lib/start/issue-21-synthetic-fixture.ts';
const ISSUE_21_FIXTURE_IMPORT_SENTINEL = `  EventTypeVersionSchema,
  FacilityPageSchema,
  IdempotencyKeySchema,
  JoinEventResultSchema,
  MobileSessionResponseSchema,
  NativeDevicePlatformSchema,
  OpaqueSessionBearerSchema,
  SessionEstablishmentResultSchema,
  StartEventInputSchema,
  StartEventResultSchema,`;
const ISSUE_21_FIXTURE_IMPORT_REPLACEMENT = `  EventTypeVersionSchema,
  FanoutStatusSchema,
  FacilityPageSchema,
  IdempotencyKeySchema,
  JoinEventResultSchema,
  MobileSessionResponseSchema,
  NativeDevicePlatformSchema,
  OpaqueSessionBearerSchema,
  PushTokenUnregistrationReceiptSchema,
  SessionEstablishmentResultSchema,
  StartEventInputSchema,
  StartEventResultSchema,
  UnregisterPushTokenInputSchema,`;
const ISSUE_21_FIXTURE_REQUEST_SENTINEL = `      let payload: unknown;

      if (
        input.method === 'GET' &&
        input.path === '/api/mobile/start/facilities'
      ) {`;
const ISSUE_21_FIXTURE_REQUEST_REPLACEMENT = `      let payload: unknown;
      const issue32CompatibilityEnabled =
        isIssue21SyntheticFixtureEnabled() &&
        process.env.EXPO_PUBLIC_PSD_EOC_E2E_SYNTHETIC_ONLY === 'true';

      if (
        issue32CompatibilityEnabled &&
        input.method === 'GET' &&
        input.path === '/api/mobile/start/fanout-control'
      ) {
        payload = FanoutStatusSchema.parse({ status: 'enabled' });
        return input.schema.parse(payload);
      }

      if (
        issue32CompatibilityEnabled &&
        input.method === 'POST' &&
        input.path === '/api/devices/push-token/unregister'
      ) {
        IdempotencyKeySchema.parse(input.idempotencyKey);
        const unregisterInput = UnregisterPushTokenInputSchema.parse(
          requireBody(input),
        );
        if (unregisterInput.deviceEnrollmentId !== IDS.deviceEnrollment) {
          throw new TypeError(
            'The issue-32 compatibility seam rejected an unexpected device enrollment.',
          );
        }
        payload = PushTokenUnregistrationReceiptSchema.parse({
          deviceEnrollmentId: unregisterInput.deviceEnrollmentId,
          status: 'unregistered',
        });
        return input.schema.parse(payload);
      }

      if (
        input.method === 'GET' &&
        input.path === '/api/mobile/start/facilities'
      ) {`;

export const MOBILE_E2E_APPLICATION_ID = 'net.psd401.eoc' as const;
export const MOBILE_E2E_NOTIFICATION_TITLE =
  '[DRILL] Synthetic lockdown drill' as const;
export const MOBILE_E2E_NOTIFICATION_BODY =
  '[DRILL] Synthetic exercise only. Open the synthetic event room.' as const;
export const MOBILE_E2E_EVENT_TYPE_NAME = 'Lockdown Drill' as const;
export const MOBILE_E2E_FACILITY_NAME = 'Synthetic North Campus' as const;
export const MOBILE_E2E_FACILITY_CODE = 'SYN-NORTH' as const;
export const MOBILE_E2E_TIMELINE_TEXT =
  'Synthetic mobile issue 32 update.' as const;

export type MobileE2EPlatform = 'ios' | 'android';

export interface MobileE2ERunnerPaths {
  readonly root: string;
  readonly owner: string;
  readonly repository: string;
  readonly copiedMobile: string;
  readonly manifestPath: string;
}

export interface MobileE2EArtifactPaths {
  readonly callerBase: string;
  readonly issueDirectory: string;
  readonly root: string;
  readonly owner: string;
}

export interface MobileE2EEnrollmentWarmupRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: '{}';
  readonly expectedStatus: 400;
}

export interface MobileE2EIosRuntimeSelection {
  readonly runtime: string;
  readonly deviceType: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adds test-only Expo dev-client settings to the isolated copied app config. */
export function mobileE2EIsolatedExpoConfig(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !isRecord(value.expo)) {
    throw new Error('The mobile Expo config is malformed.');
  }
  const expo = value.expo;
  const ios = expo.ios;
  const android = expo.android;
  const plugins = expo.plugins;
  if (
    expo.name !== 'PSD EOC' ||
    expo.slug !== 'psd-eoc' ||
    !isRecord(ios) ||
    ios.bundleIdentifier !== MOBILE_E2E_APPLICATION_ID ||
    !isRecord(android) ||
    android.package !== MOBILE_E2E_APPLICATION_ID ||
    !Array.isArray(plugins)
  ) {
    throw new Error('The mobile Expo config has an unexpected app identity.');
  }
  const hasDevClientPlugin = plugins.some((plugin) => {
    if (plugin === 'expo-dev-client') return true;
    return Array.isArray(plugin) && plugin[0] === 'expo-dev-client';
  });
  if (hasDevClientPlugin) {
    throw new Error(
      'The mobile Expo config already owns expo-dev-client settings.',
    );
  }
  return Object.freeze({
    ...value,
    expo: Object.freeze({
      ...expo,
      plugins: Object.freeze([
        ...plugins,
        Object.freeze([
          'expo-dev-client',
          Object.freeze({
            skipOnboarding: true,
            showMenuAtLaunch: false,
            toolsButton: false,
          }),
        ]),
      ]),
    }),
  });
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function requireRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error(
      'The issue #32 mobile E2E run ID must be 32 lowercase hexadecimal characters.',
    );
  }
  return value;
}

function requirePlatform(value: string | undefined): MobileE2EPlatform {
  if (value !== 'ios' && value !== 'android') {
    throw new Error('Usage: run-ci.ts <ios|android>');
  }
  return value;
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent.length > 0 &&
    !fromParent.startsWith(`..${sep}`) &&
    fromParent !== '..' &&
    !isAbsolute(fromParent)
  );
}

/** Keeps generated native state and every dotenv file out of the copied app. */
export function shouldCopyMobileE2EWorkspaceSource(
  sourceRoot: string,
  source: string,
): boolean {
  const root = resolve(sourceRoot);
  const candidate = resolve(source);
  if (candidate === root) return true;
  if (!isStrictDescendant(root, candidate)) {
    throw new Error('The mobile E2E copy source escaped the mobile root.');
  }
  const relativeSource = relative(root, candidate);
  const topLevelEntry = relativeSource.split(sep)[0];
  const name = basename(candidate);
  return (
    !MOBILE_WORKSPACE_EXCLUDED_ROOT_ENTRIES.has(topLevelEntry ?? '') &&
    name !== '.env' &&
    !name.startsWith('.env.')
  );
}

function replaceExactFixtureSentinel(
  source: string,
  sentinel: string,
  replacement: string,
  label: string,
): string {
  const cardinality = source.split(sentinel).length - 1;
  if (cardinality !== 1) {
    throw new Error(
      `The issue-21 fixture ${label} source drifted; expected exactly one sentinel but found ${cardinality}.`,
    );
  }
  return source.replace(sentinel, replacement);
}

/**
 * Adds only the issue #32 compatibility reads to an isolated issue-21 fixture.
 * Exact, single-occurrence sentinels make upstream source drift fail closed.
 */
export function mobileE2EIssue21FixtureCompatibilitySource(
  source: string,
): string {
  const withContracts = replaceExactFixtureSentinel(
    source,
    ISSUE_21_FIXTURE_IMPORT_SENTINEL,
    ISSUE_21_FIXTURE_IMPORT_REPLACEMENT,
    'contract import',
  );
  return replaceExactFixtureSentinel(
    withContracts,
    ISSUE_21_FIXTURE_REQUEST_SENTINEL,
    ISSUE_21_FIXTURE_REQUEST_REPLACEMENT,
    'request dispatch',
  );
}

function requireAbsoluteTemporaryDescendant(
  value: string,
  label: string,
): {
  readonly path: string;
  readonly relativePath: string;
  readonly temporaryRoot: string;
} {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path under os.tmpdir().`);
  }
  const temporaryRoot = resolve(tmpdir());
  const path = resolve(value);
  if (!isStrictDescendant(temporaryRoot, path)) {
    throw new Error(`${label} must be a child of os.tmpdir().`);
  }
  return Object.freeze({
    path,
    relativePath: relative(temporaryRoot, path),
    temporaryRoot,
  });
}

async function assertDirectoryWithoutSymlink(
  path: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a directory and cannot be a symlink.`);
  }
}

async function ensureDirectoryTreeWithoutSymlinks(
  temporaryRoot: string,
  relativePath: string,
): Promise<void> {
  await assertDirectoryWithoutSymlink(
    temporaryRoot,
    'The operating-system temporary directory',
  );
  let current = temporaryRoot;
  for (const component of relativePath.split(sep)) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new Error('The artifact path contains an unsafe component.');
    }
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertDirectoryWithoutSymlink(current, 'The artifact path');
  }

  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const canonicalCurrent = await realpath(current);
  const expectedCanonicalPath = resolve(canonicalTemporaryRoot, relativePath);
  if (
    canonicalCurrent !== expectedCanonicalPath ||
    !isStrictDescendant(canonicalTemporaryRoot, canonicalCurrent)
  ) {
    throw new Error('The artifact path cannot traverse a symlink.');
  }
}

async function assertExistingDirectoryTreeWithoutSymlinks(
  temporaryRoot: string,
  relativePath: string,
): Promise<void> {
  await assertDirectoryWithoutSymlink(
    temporaryRoot,
    'The operating-system temporary directory',
  );
  let current = temporaryRoot;
  for (const component of relativePath.split(sep)) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new Error('The artifact path contains an unsafe component.');
    }
    current = resolve(current, component);
    await assertDirectoryWithoutSymlink(current, 'The artifact path');
  }

  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const canonicalCurrent = await realpath(current);
  if (
    canonicalCurrent !== resolve(canonicalTemporaryRoot, relativePath) ||
    !isStrictDescendant(canonicalTemporaryRoot, canonicalCurrent)
  ) {
    throw new Error('The artifact path cannot traverse a symlink.');
  }
}

function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !name.startsWith(EXPO_PUBLIC_PSD_EOC_PREFIX)) {
      result[name] = value;
    }
  }
  return result;
}

/** Parses the deliberately tiny, platform-only issue #32 CLI. */
export function parseMobileE2EPlatformCli(
  arguments_: readonly string[],
): MobileE2EPlatform {
  if (arguments_.length !== 1) {
    throw new Error('Usage: run-ci.ts <ios|android>');
  }
  return requirePlatform(arguments_[0]);
}

/** Refuses to run without an explicit synthetic flag and loopback test DB. */
export function requireMobileE2EEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return requireMobileRuntimeEnvironment(environment);
}

export function createMobileE2ERunId(): string {
  return randomBytes(16).toString('hex');
}

export function mobileE2ERunnerPaths(runIdValue: string): MobileE2ERunnerPaths {
  const runId = requireRunId(runIdValue);
  const temporaryRoot = resolve(tmpdir());
  const expectedBasename = `${RUNNER_ROOT_PREFIX}${runId}`;
  const root = resolve(temporaryRoot, expectedBasename);
  if (dirname(root) !== temporaryRoot || basename(root) !== expectedBasename) {
    throw new Error('Refusing to address an unexpected mobile E2E root.');
  }
  const repository = resolve(root, 'repository');
  return Object.freeze({
    root,
    owner: resolve(root, OWNER_FILENAME),
    repository,
    copiedMobile: resolve(repository, 'packages/mobile'),
    manifestPath: resolve(root, `psd-eoc-issue32-mobile-${runId}.json`),
  });
}

export async function acquireMobileE2ERunnerRoot(
  runIdValue: string,
): Promise<MobileE2ERunnerPaths> {
  const runId = requireRunId(runIdValue);
  const paths = mobileE2ERunnerPaths(runId);
  await mkdir(paths.root, { mode: 0o700 });
  try {
    await assertDirectoryWithoutSymlink(paths.root, 'The mobile E2E root');
    await writeFile(paths.owner, `${runId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await assertMobileE2ERunnerRootOwned(runId);
    return paths;
  } catch (error) {
    await rmdir(paths.root).catch(() => undefined);
    throw error;
  }
}

export async function assertMobileE2ERunnerRootOwned(
  runIdValue: string,
): Promise<void> {
  const runId = requireRunId(runIdValue);
  const paths = mobileE2ERunnerPaths(runId);
  await assertDirectoryWithoutSymlink(paths.root, 'The mobile E2E root');
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const canonicalRoot = await realpath(paths.root);
  if (
    canonicalRoot !== resolve(canonicalTemporaryRoot, basename(paths.root)) ||
    !isStrictDescendant(canonicalTemporaryRoot, canonicalRoot)
  ) {
    throw new Error('The mobile E2E root cannot traverse a symlink.');
  }
  const ownerMetadata = await lstat(paths.owner);
  if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink()) {
    throw new Error('The mobile E2E ownership marker is invalid.');
  }
  if ((await readFile(paths.owner, 'utf8')) !== `${runId}\n`) {
    throw new Error('The mobile E2E ownership marker does not match.');
  }
}

/** Patches only the marker-owned, isolated mobile source copied for this run. */
export async function patchMobileE2EIsolatedIssue21Fixture(
  runIdValue: string,
): Promise<void> {
  const runId = requireRunId(runIdValue);
  const paths = mobileE2ERunnerPaths(runId);
  await assertMobileE2ERunnerRootOwned(runId);

  const canonicalRoot = await realpath(paths.root);
  const canonicalMobile = await realpath(paths.copiedMobile);
  const expectedMobile = resolve(
    canonicalRoot,
    'repository',
    'packages',
    'mobile',
  );
  if (
    canonicalMobile !== expectedMobile ||
    !isStrictDescendant(canonicalRoot, canonicalMobile)
  ) {
    throw new Error(
      'The isolated issue-21 fixture source escaped the marker-owned copy.',
    );
  }

  const fixturePath = resolve(
    paths.copiedMobile,
    ISSUE_21_FIXTURE_RELATIVE_PATH,
  );
  const fixtureMetadata = await lstat(fixturePath);
  if (!fixtureMetadata.isFile() || fixtureMetadata.isSymbolicLink()) {
    throw new Error(
      'The isolated issue-21 fixture source must be a regular file.',
    );
  }
  if (
    (await realpath(fixturePath)) !==
    resolve(canonicalMobile, ISSUE_21_FIXTURE_RELATIVE_PATH)
  ) {
    throw new Error(
      'The isolated issue-21 fixture source cannot traverse a symlink.',
    );
  }

  const source = await readFile(fixturePath, 'utf8');
  const compatibleSource = mobileE2EIssue21FixtureCompatibilitySource(source);
  await writeFile(fixturePath, compatibleSource, {
    encoding: 'utf8',
    flag: 'w',
    mode: 0o600,
  });
}

export async function removeMobileE2ERunnerRoot(
  runIdValue: string,
): Promise<void> {
  const paths = mobileE2ERunnerPaths(runIdValue);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  await assertMobileE2ERunnerRootOwned(runIdValue);
  await rm(paths.root, { recursive: true });
}

export function mobileE2EArtifactPaths(
  artifactBaseValue: string,
  platformValue: string,
): MobileE2EArtifactPaths {
  const platform = requirePlatform(platformValue);
  const { path: callerBase } = requireAbsoluteTemporaryDescendant(
    artifactBaseValue,
    'PSD_EOC_MOBILE_E2E_ARTIFACT_DIR',
  );
  const issueDirectory = resolve(callerBase, ARTIFACT_ISSUE_DIRECTORY);
  const root = resolve(issueDirectory, platform);
  if (
    dirname(issueDirectory) !== callerBase ||
    dirname(root) !== issueDirectory ||
    basename(root) !== platform
  ) {
    throw new Error('Refusing to address an unexpected artifact directory.');
  }
  return Object.freeze({
    callerBase,
    issueDirectory,
    root,
    owner: resolve(root, OWNER_FILENAME),
  });
}

/**
 * Acquires only base/issue-32/platform. The workflow-owned base and its safety
 * context remain untouched.
 */
export async function acquireMobileE2EArtifactDirectory(
  artifactBaseValue: string,
  platformValue: string,
  runIdValue: string,
): Promise<MobileE2EArtifactPaths> {
  const runId = requireRunId(runIdValue);
  const platform = requirePlatform(platformValue);
  const safeBase = requireAbsoluteTemporaryDescendant(
    artifactBaseValue,
    'PSD_EOC_MOBILE_E2E_ARTIFACT_DIR',
  );
  await ensureDirectoryTreeWithoutSymlinks(
    safeBase.temporaryRoot,
    safeBase.relativePath,
  );
  const paths = mobileE2EArtifactPaths(safeBase.path, platform);
  await mkdir(paths.issueDirectory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  await assertDirectoryWithoutSymlink(
    paths.issueDirectory,
    'The issue #32 artifact directory',
  );
  await mkdir(paths.root, { mode: 0o700 });
  try {
    await assertDirectoryWithoutSymlink(
      paths.root,
      'The platform artifact directory',
    );
    await writeFile(paths.owner, `${runId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await assertMobileE2EArtifactDirectoryOwned(safeBase.path, platform, runId);
    return paths;
  } catch (error) {
    await rmdir(paths.root).catch(() => undefined);
    throw error;
  }
}

export async function assertMobileE2EArtifactDirectoryOwned(
  artifactBaseValue: string,
  platformValue: string,
  runIdValue: string,
): Promise<void> {
  const runId = requireRunId(runIdValue);
  const platform = requirePlatform(platformValue);
  const safeBase = requireAbsoluteTemporaryDescendant(
    artifactBaseValue,
    'PSD_EOC_MOBILE_E2E_ARTIFACT_DIR',
  );
  const paths = mobileE2EArtifactPaths(safeBase.path, platform);
  await assertExistingDirectoryTreeWithoutSymlinks(
    safeBase.temporaryRoot,
    relative(safeBase.temporaryRoot, paths.root),
  );
  const ownerMetadata = await lstat(paths.owner);
  if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink()) {
    throw new Error('The artifact ownership marker is invalid.');
  }
  if ((await readFile(paths.owner, 'utf8')) !== `${runId}\n`) {
    throw new Error('The artifact ownership marker does not match.');
  }
}

export async function removeMobileE2EArtifactDirectory(
  artifactBaseValue: string,
  platformValue: string,
  runIdValue: string,
): Promise<void> {
  const paths = mobileE2EArtifactPaths(artifactBaseValue, platformValue);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  await assertMobileE2EArtifactDirectoryOwned(
    artifactBaseValue,
    platformValue,
    runIdValue,
  );
  await rm(paths.root, { recursive: true });
}

export function parseMobileE2EManifest(value: unknown): MobileRuntimeManifest {
  return MobileRuntimeManifestSchema.parse(value);
}

/**
 * Builds a deliberately invalid request that reaches the exact OIDC start
 * handler but is rejected by its contract before any transport state exists.
 */
export function mobileE2EEnrollmentWarmupRequest(
  manifestValue: unknown,
): MobileE2EEnrollmentWarmupRequest {
  const manifest = parseMobileE2EManifest(manifestValue);
  return Object.freeze({
    url: new URL('/api/auth/mobile/oidc/start', manifest.appOrigin).toString(),
    method: 'POST',
    headers: Object.freeze({
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    }),
    body: '{}',
    expectedStatus: 400,
  });
}

export function requireMatchingMobileE2ERunIds(
  runnerRunId: string,
  manifestValue: unknown,
): MobileRuntimeManifest {
  const manifest = parseMobileE2EManifest(manifestValue);
  if (manifest.runId !== requireRunId(runnerRunId)) {
    throw new Error('The runner and server manifest run IDs must match.');
  }
  return manifest;
}

export function parseMobileE2EManifestText(
  serialized: string,
): MobileRuntimeManifest {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('The mobile runtime manifest must be valid JSON.');
  }
  return parseMobileE2EManifest(value);
}

export function mobileE2EMaestroEnvironment(
  manifestValue: unknown,
): Readonly<Record<string, string>> {
  const manifest = parseMobileE2EManifest(manifestValue);
  return Object.freeze({
    PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
    RUN_ID: manifest.runId,
    EVENT_ID: manifest.event.id,
    EVENT_KIND: 'drill',
    EVENT_ROUTE_EVIDENCE: manifest.event.routeEvidence,
    EVENT_TYPE_NAME: MOBILE_E2E_EVENT_TYPE_NAME,
    EVENT_TYPE_VERSION_ID: manifest.event.eventTypeVersionId,
    FACILITY_CODE: MOBILE_E2E_FACILITY_CODE,
    FACILITY_ID: manifest.event.facilityId,
    FACILITY_NAME: MOBILE_E2E_FACILITY_NAME,
    NOTIFICATION_TITLE: MOBILE_E2E_NOTIFICATION_TITLE,
    PURPOSE: 'activation',
    ROSTER_POPULATION: 'synthetic',
    TEMPLATE_MODE: 'drill',
    TIMELINE_TEXT: MOBILE_E2E_TIMELINE_TEXT,
  });
}

export function mobileE2ENormalMetroEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  manifestValue: unknown,
): Readonly<Record<string, string>> {
  requireMobileE2EEnvironment(environment);
  const manifest = parseMobileE2EManifest(manifestValue);
  return Object.freeze({
    ...definedEnvironment(environment),
    PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
    EXPO_PUBLIC_PSD_EOC_API_BASE_URL: manifest.appOrigin,
    EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'false',
  });
}

export function mobileE2EFixtureMetroEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  requireMobileE2EEnvironment(environment);
  return Object.freeze({
    ...definedEnvironment(environment),
    PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
    EXPO_PUBLIC_PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
    EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'false',
    EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE: 'issue-21',
  });
}

export function mobileE2EIosSimulatorPushPayload(manifestValue: unknown) {
  const manifest = parseMobileE2EManifest(manifestValue);
  return Object.freeze({
    'Simulator Target Bundle': MOBILE_E2E_APPLICATION_ID,
    aps: Object.freeze({
      alert: Object.freeze({
        title: MOBILE_E2E_NOTIFICATION_TITLE,
        body: MOBILE_E2E_NOTIFICATION_BODY,
      }),
      sound: 'default' as const,
      'interruption-level': 'time-sensitive' as const,
      category: 'PSD_EOC_DRILL' as const,
    }),
    body: Object.freeze({
      version: 1 as const,
      eventId: manifest.event.id,
      eventKind: 'drill' as const,
      templateMode: 'drill' as const,
      facilityId: manifest.event.facilityId,
      eventTypeVersionId: manifest.event.eventTypeVersionId,
      purpose: 'activation' as const,
    }),
  });
}

export function mobileE2EAndroidInstrumentationArguments(
  manifestValue: unknown,
): readonly string[] {
  const manifest = parseMobileE2EManifest(manifestValue);
  const prefix = '-Pandroid.testInstrumentationRunnerArguments.';
  return Object.freeze([
    `${prefix}runId=${manifest.runId}`,
    `${prefix}responseId=issue-32-${manifest.runId}`,
    `${prefix}eventId=${manifest.event.id}`,
    `${prefix}eventKind=drill`,
    `${prefix}templateMode=drill`,
    `${prefix}facilityId=${manifest.event.facilityId}`,
    `${prefix}eventTypeVersionId=${manifest.event.eventTypeVersionId}`,
    `${prefix}purpose=activation`,
  ]);
}

/** Restricts native work to the exact ABI used by the hosted emulator. */
export function mobileE2EAndroidArchitectureArguments(): readonly string[] {
  return Object.freeze(['-PreactNativeArchitectures=x86_64']);
}

/** Builds only the ABI used by the issue #32 hosted Android emulator. */
export function mobileE2EAndroidBuildArguments(): readonly string[] {
  return Object.freeze([
    '--no-daemon',
    '--stacktrace',
    ...mobileE2EAndroidArchitectureArguments(),
    'app:assembleDebug',
  ]);
}

export function mobileE2EAndroidEmulatorControlArguments(
  serial: string,
  action: 'pause' | 'resume',
): readonly string[] {
  if (!/^emulator-\d+$/u.test(serial)) {
    throw new Error(
      'Android emulator control requires one exact local emulator serial.',
    );
  }
  return Object.freeze(['adb', '-s', serial, 'emu', 'avd', action]);
}

/**
 * Frees the constrained hosted runner's CPUs for a cold native build while
 * guaranteeing that cleanup can still reach the exact validated emulator.
 */
export async function withMobileE2EAndroidEmulatorPaused<T>(
  serial: string,
  operation: () => Promise<T>,
  control: (command: readonly string[]) => Promise<void>,
): Promise<T> {
  const pauseCommand = mobileE2EAndroidEmulatorControlArguments(
    serial,
    'pause',
  );
  const resumeCommand = mobileE2EAndroidEmulatorControlArguments(
    serial,
    'resume',
  );
  let pauseFailure: Readonly<{ error: unknown }> | undefined;
  try {
    await control(pauseCommand);
  } catch (error) {
    pauseFailure = { error };
  }
  if (pauseFailure !== undefined) {
    try {
      await control(resumeCommand);
    } catch (resumeError) {
      throw new AggregateError(
        [pauseFailure.error, resumeError],
        'The Android emulator pause was uncertain and its recovery resume failed.',
      );
    }
    throw pauseFailure.error;
  }

  let result: T | undefined;
  let operationFailure: Readonly<{ error: unknown }> | undefined;
  try {
    result = await operation();
  } catch (error) {
    operationFailure = { error };
  }

  let resumeFailure: Readonly<{ error: unknown }> | undefined;
  try {
    await control(resumeCommand);
  } catch (error) {
    resumeFailure = { error };
  }

  if (operationFailure !== undefined && resumeFailure !== undefined) {
    throw new AggregateError(
      [operationFailure.error, resumeFailure.error],
      'The Android native operation failed and its emulator could not resume.',
    );
  }
  if (operationFailure !== undefined) throw operationFailure.error;
  if (resumeFailure !== undefined) throw resumeFailure.error;
  return result as T;
}

export function mobileE2EDevClientUrl(port: number): string {
  const metroOrigin = mobileE2ELoopbackMetroOrigin(port);
  return `psdeoc://expo-development-client/?url=${encodeURIComponent(metroOrigin)}`;
}

function mobileE2ELoopbackMetroOrigin(port: number): string {
  if (
    !Number.isSafeInteger(port) ||
    port < USER_PORT_MINIMUM ||
    port > USER_PORT_MAXIMUM
  ) {
    throw new Error(
      `The Metro port must be from ${USER_PORT_MINIMUM} through ${USER_PORT_MAXIMUM}.`,
    );
  }
  return `http://${LOOPBACK_METRO_HOST}:${port}`;
}

/** Launches the iOS dev client directly at synthetic loopback Metro. */
export function mobileE2EIosDirectLaunchArguments(
  deviceId: string,
  port: number,
): readonly string[] {
  if (!IOS_SIMULATOR_UDID_PATTERN.test(deviceId)) {
    throw new Error('The iOS simulator UDID is invalid.');
  }
  return Object.freeze([
    'simctl',
    'launch',
    '--terminate-running-process',
    deviceId,
    MOBILE_E2E_APPLICATION_ID,
    '--initialUrl',
    mobileE2ELoopbackMetroOrigin(port),
  ]);
}

/** Keeps the warmed iOS XCTest runner alive; Android owns no XCTest process. */
export function mobileE2EMaestroDriverReuseArguments(
  platform: MobileE2EPlatform,
): readonly string[] {
  return platform === 'ios'
    ? Object.freeze(['--no-reinstall-driver'])
    : Object.freeze([]);
}

/** Pins every iOS Maestro process to its explicitly tracked XCTest session. */
export function mobileE2EMaestroDriverPortArguments(
  platform: MobileE2EPlatform,
  port: number | undefined,
): readonly string[] {
  if (platform === 'android') {
    if (port !== undefined) {
      throw new Error('Android must not receive an iOS XCTest driver port.');
    }
    return Object.freeze([]);
  }
  if (
    !Number.isSafeInteger(port) ||
    port === undefined ||
    port < USER_PORT_MINIMUM ||
    port > USER_PORT_MAXIMUM
  ) {
    throw new Error(
      `The iOS Maestro driver port must be from ${USER_PORT_MINIMUM} through ${USER_PORT_MAXIMUM}.`,
    );
  }
  return Object.freeze(['--driver-host-port', String(port)]);
}

/** Keeps Metro loopback-only without combining Expo's incompatible flags. */
export function mobileE2EExpoStartArguments(port: number): readonly string[] {
  mobileE2EDevClientUrl(port);
  return Object.freeze([
    'x',
    'expo',
    'start',
    '--dev-client',
    '--localhost',
    '--clear',
    '--max-workers',
    '2',
    '--port',
    String(port),
  ]);
}

/** Builds a locally signed simulator app so Keychain entitlements function. */
export function mobileE2EIosBuildArguments(
  deviceId: string,
): readonly string[] {
  if (!IOS_SIMULATOR_UDID_PATTERN.test(deviceId)) {
    throw new Error('The iOS simulator UDID is invalid.');
  }
  return Object.freeze([
    'xcodebuild',
    '-workspace',
    'PSDEOC.xcworkspace',
    '-scheme',
    'PSDEOC',
    '-configuration',
    'Debug',
    '-destination',
    `platform=iOS Simulator,id=${deviceId}`,
    '-derivedDataPath',
    'build',
    'build',
  ]);
}

/** Makes Expo's `localhost` listener and advertised URL resolve to IPv4. */
export function mobileE2ELoopbackMetroEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...environment,
    NODE_OPTIONS: [environment.NODE_OPTIONS, LOOPBACK_NODE_OPTIONS]
      .filter((value): value is string => value !== undefined)
      .join(' '),
    REACT_NATIVE_PACKAGER_HOSTNAME: LOOPBACK_METRO_HOST,
  });
}

/** Distinguishes Android SystemUI authentication from the app unlock screen. */
export function isMobileE2EAndroidDeviceAuthenticationPrompt(
  hierarchy: string,
): boolean {
  return (
    hierarchy.includes('Unlock PSD EOC') &&
    (hierarchy.includes('package="com.android.systemui"') ||
      hierarchy.includes('package: com.android.systemui'))
  );
}

/** Detects only an actually resumed PSD EOC activity in Android diagnostics. */
export function isMobileE2EAndroidApplicationForeground(
  activityState: string,
): boolean {
  return activityState.split(/\r?\n/u).some((line) => {
    if (
      !/(?:mResumedActivity|topResumedActivity|ResumedActivity)/u.test(line)
    ) {
      return false;
    }
    return new RegExp(
      String.raw`(?:^|[\s{/])${MOBILE_E2E_APPLICATION_ID.replaceAll('.', String.raw`\.`)}(?:[/\s}:]|$)`,
      'u',
    ).test(line);
  });
}

/** Synchronizes on iOS's secure sheet without treating it as pass evidence. */
export function isMobileE2EIosAuthenticationSheetReady(
  hierarchy: string,
): boolean {
  return (
    /"accessibilityText"\s*:\s*"Face ID"/u.test(hierarchy) ||
    hierarchy.includes('Enter iPhone Passcode for “PSD EOC”')
  );
}

export function isMobileE2EIosApplicationForeground(
  hierarchy: string,
): boolean {
  const foregroundSceneCard = new RegExp(
    String.raw`"resource-id"\s*:\s*"card:${MOBILE_E2E_APPLICATION_ID.replaceAll('.', String.raw`\.`)}:sceneID:`,
    'u',
  );
  return foregroundSceneCard.test(hierarchy);
}

/**
 * Synchronizes a direct dev-client launch on app-owned UI or its exact secure
 * authentication transition. A stale external-URL alert never counts as app
 * readiness, even if its hierarchy also contains an app label.
 */
export function isMobileE2EIosApplicationReady(
  hierarchy: string,
  expectedApplicationText: string,
): boolean {
  return (
    expectedApplicationText.length > 0 &&
    !hierarchy.includes('Open in “PSD EOC”?') &&
    (hierarchy.includes(expectedApplicationText) ||
      isMobileE2EIosAuthenticationSheetReady(hierarchy) ||
      isMobileE2EIosApplicationForeground(hierarchy))
  );
}

/** Admits an authentication retry only from PSD EOC's exact locked UI. */
export function isMobileE2EIosUnlockRetryReady(hierarchy: string): boolean {
  return (
    hierarchy.includes('Unlock PSD EOC') &&
    hierarchy.includes('PSD EOC remains locked') &&
    hierarchy.includes(
      'PSD EOC could not verify device authentication. Try again or contact district technology support.',
    ) &&
    hierarchy.includes('Try device unlock again')
  );
}

export interface MobileE2EIosSyntheticNotificationState {
  readonly valid: boolean;
  readonly locked: boolean;
  readonly visible: boolean;
  readonly openable: boolean;
  readonly coverSheetBounds: MobileE2EIosBounds | null;
  readonly exactCardBounds: MobileE2EIosBounds | null;
  readonly otherCardBounds: readonly MobileE2EIosBounds[];
}

export type MobileE2EIosNotificationResponseDecision =
  | 'wait'
  | 'response-started'
  | 'open-explicit-notification'
  | 'refuse-explicit-open';

export interface MobileE2EIosRevealedOpenActionDecision {
  readonly decision:
    | 'wait'
    | 'response-started'
    | 'tap-revealed-open'
    | 'refuse-revealed-open';
  readonly tapPoint: string | null;
}

export interface MobileE2EIosNotificationActionLogEvidence {
  readonly valid: boolean;
  readonly requestId: string | null;
}

export interface MobileE2EIosBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface MobileE2EIosNotificationScreenshotEvidence {
  readonly revealStartPoint: string;
  readonly revealEndPoint: string;
}

interface MobileE2EIosOcrObservation {
  readonly text: string;
  readonly confidence: number;
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

function mobileE2EIosOcrObservations(
  value: unknown,
): readonly MobileE2EIosOcrObservation[] {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pixelWidth) ||
    !Number.isSafeInteger(value.pixelHeight) ||
    (value.pixelWidth as number) < 320 ||
    (value.pixelHeight as number) <= (value.pixelWidth as number) ||
    (value.pixelHeight as number) > 10_000 ||
    !Array.isArray(value.observations) ||
    value.observations.length === 0 ||
    value.observations.length > 100
  ) {
    throw new Error('The iOS notification OCR analysis is malformed.');
  }
  return Object.freeze(
    value.observations.map((candidate) => {
      if (!isRecord(candidate)) {
        throw new Error('The iOS notification OCR observation is malformed.');
      }
      const { text, confidence, minX, minY, width, height } = candidate;
      if (
        typeof text !== 'string' ||
        text.length === 0 ||
        text.length > 500 ||
        typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1 ||
        typeof minX !== 'number' ||
        !Number.isFinite(minX) ||
        typeof minY !== 'number' ||
        !Number.isFinite(minY) ||
        typeof width !== 'number' ||
        !Number.isFinite(width) ||
        typeof height !== 'number' ||
        !Number.isFinite(height) ||
        minX < 0 ||
        minY < 0 ||
        width <= 0 ||
        height <= 0 ||
        minX + width > 1.001 ||
        minY + height > 1.001
      ) {
        throw new Error('The iOS notification OCR observation is invalid.');
      }
      return Object.freeze({ text, confidence, minX, minY, width, height });
    }),
  );
}

function mobileE2EIosOcrCenter(
  observation: MobileE2EIosOcrObservation,
): Readonly<{ x: number; y: number }> {
  return Object.freeze({
    x: (observation.minX + observation.width / 2) * 100,
    y: (1 - (observation.minY + observation.height / 2)) * 100,
  });
}

function mobileE2EIosOcrContainsScreenPoint(
  observation: MobileE2EIosOcrObservation,
  x: number,
  y: number,
): boolean {
  const normalizedX = x / 100;
  const normalizedY = 1 - y / 100;
  return (
    normalizedX > observation.minX &&
    normalizedX < observation.minX + observation.width &&
    normalizedY > observation.minY &&
    normalizedY < observation.minY + observation.height
  );
}

function mobileE2EIosPercentPoint(x: number, y: number): string {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x <= 0 ||
    x >= 100 ||
    y <= 0 ||
    y >= 100
  ) {
    throw new Error('The iOS notification OCR point is outside the screen.');
  }
  return `${Math.round(x)}%, ${Math.round(y)}%`;
}

function mobileE2EIosExactOcrObservation(
  observations: readonly MobileE2EIosOcrObservation[],
  text: string,
): MobileE2EIosOcrObservation {
  const matches = observations.filter(
    (observation) => observation.text === text && observation.confidence >= 0.9,
  );
  if (matches.length !== 1) {
    throw new Error(`The iOS screenshot did not prove exactly one ${text}.`);
  }
  return matches[0] as MobileE2EIosOcrObservation;
}

function requireMobileE2EIosDrillOnlyOcr(
  observations: readonly MobileE2EIosOcrObservation[],
): void {
  if (
    observations.some((observation) =>
      observation.text.toUpperCase().includes('INCIDENT'),
    )
  ) {
    throw new Error('The iOS notification screenshot contained INCIDENT text.');
  }
}

function mobileE2EIosNotificationFullCard(
  observations: readonly MobileE2EIosOcrObservation[],
): Readonly<{
  title: MobileE2EIosOcrObservation;
  body: readonly MobileE2EIosOcrObservation[];
}> {
  const title = mobileE2EIosExactOcrObservation(
    observations,
    MOBILE_E2E_NOTIFICATION_TITLE,
  );
  const isHighConfidenceBodyFragmentBoundToTitle = (
    observation: MobileE2EIosOcrObservation,
  ): boolean =>
    observation.confidence >= 0.9 &&
    MOBILE_E2E_NOTIFICATION_BODY.includes(observation.text) &&
    Math.abs(observation.minX - title.minX) <= 0.08 &&
    observation.minX + observation.width <= title.minX + title.width + 0.25 &&
    observation.minY + observation.height <= title.minY + 0.01 &&
    observation.minY >= title.minY - 0.12;
  const body = observations
    .filter(isHighConfidenceBodyFragmentBoundToTitle)
    .sort((left, right) => right.minY - left.minY);
  if (body.length === 0 || body.length > 4) {
    throw new Error(
      'The iOS screenshot did not prove the exact complete DRILL notification.',
    );
  }
  const leadingBodyLine = body[0] as MobileE2EIosOcrObservation;
  if (
    !leadingBodyLine.text.startsWith('[DRILL]') ||
    leadingBodyLine.width < 0.3
  ) {
    throw new Error(
      'The iOS screenshot did not prove plausible DRILL body geometry.',
    );
  }
  let precedingBottom = title.minY;
  for (const line of body) {
    const gap = precedingBottom - (line.minY + line.height);
    if (gap < -0.01 || gap > 0.04) {
      throw new Error(
        'The iOS screenshot did not prove adjacent DRILL notification text.',
      );
    }
    precedingBottom = line.minY;
  }
  const recognizedBody = body
    .map((observation) => observation.text)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (recognizedBody !== MOBILE_E2E_NOTIFICATION_BODY) {
    throw new Error(
      'The iOS screenshot did not prove the exact complete DRILL notification.',
    );
  }
  return Object.freeze({ title, body: Object.freeze(body) });
}

/**
 * Converts exact Apple Vision DRILL title/body evidence into guarded
 * right-swipe geometry. Percent geometry stays resolution-independent.
 */
export function mobileE2EIosNotificationScreenshotEvidence(
  value: unknown,
): MobileE2EIosNotificationScreenshotEvidence {
  const observations = mobileE2EIosOcrObservations(value);
  requireMobileE2EIosDrillOnlyOcr(observations);
  const { title, body } = mobileE2EIosNotificationFullCard(observations);
  if (title.width < 0.2 || title.height < 0.01) {
    throw new Error(
      'The iOS screenshot did not prove the exact complete DRILL notification.',
    );
  }
  const center = mobileE2EIosOcrCenter(title);
  if (center.x < 10 || center.x > 90 || center.y < 40 || center.y > 95) {
    throw new Error('The exact iOS DRILL title has unsafe screen geometry.');
  }
  if (
    !mobileE2EIosOcrContainsScreenPoint(
      title,
      Math.round(center.x),
      Math.round(center.y),
    )
  ) {
    throw new Error(
      'The rounded iOS notification title center escaped its exact OCR box.',
    );
  }
  // Bind Maestro's swipe origin to the widest high-confidence body line from
  // this exact screenshot. A benign system card can move the DRILL card, so a
  // fixed percentage would either become flaky or escape the proven bounds.
  const swipeLine = body.reduce((widest, observation) =>
    observation.width > widest.width ? observation : widest,
  );
  const swipeCenter = mobileE2EIosOcrCenter(swipeLine);
  const swipeX = Math.round(swipeCenter.x);
  const swipeY = Math.round(swipeCenter.y);
  if (
    swipeLine.width < 0.3 ||
    swipeX < 15 ||
    swipeX > 80 ||
    swipeY < 40 ||
    swipeY > 95 ||
    !mobileE2EIosOcrContainsScreenPoint(swipeLine, swipeX, swipeY)
  ) {
    throw new Error(
      'The exact iOS DRILL body does not admit a guarded swipe origin.',
    );
  }
  return Object.freeze({
    revealStartPoint: mobileE2EIosPercentPoint(swipeX, swipeY),
    revealEndPoint: mobileE2EIosPercentPoint(95, swipeY),
  });
}

/**
 * Requires one exact Open label beside a uniformly shifted, still-identifiable
 * crop of the exact DRILL card proven immediately before the right swipe.
 */
export function mobileE2EIosNotificationOpenScreenshotTapPoint(
  beforeValue: unknown,
  revealedValue: unknown,
): string {
  const beforeObservations = mobileE2EIosOcrObservations(beforeValue);
  requireMobileE2EIosDrillOnlyOcr(beforeObservations);
  const { title, body } = mobileE2EIosNotificationFullCard(beforeObservations);
  const revealedObservations = mobileE2EIosOcrObservations(revealedValue);
  requireMobileE2EIosDrillOnlyOcr(revealedObservations);
  const titlePrefix = MOBILE_E2E_NOTIFICATION_TITLE.split(' ')
    .slice(0, -1)
    .join(' ');
  const bodyPrefix = '[DRILL] Synthetic exercise only.';
  const bodySuffix = 'synthetic event room.';
  const uniquePrefix = (
    prefix: string,
    description: string,
  ): MobileE2EIosOcrObservation => {
    const matches = revealedObservations.filter(
      (observation) =>
        observation.confidence >= 0.9 && observation.text.startsWith(prefix),
    );
    if (matches.length !== 1) {
      throw new Error(
        `The revealed iOS screenshot did not prove one ${description}.`,
      );
    }
    return matches[0] as MobileE2EIosOcrObservation;
  };
  const revealedTitle = uniquePrefix(titlePrefix, 'exact DRILL title prefix');
  const revealedBodyPrefix = uniquePrefix(
    bodyPrefix,
    'exact DRILL body prefix',
  );
  const beforeBodyPrefix = body[0] as MobileE2EIosOcrObservation;
  const beforeBodySuffix = body.find(
    (observation) => observation.text === bodySuffix,
  );
  if (beforeBodySuffix === undefined) {
    throw new Error(
      'The pre-swipe iOS screenshot did not isolate the exact DRILL body suffix.',
    );
  }
  const revealedBodySuffix = mobileE2EIosExactOcrObservation(
    revealedObservations,
    bodySuffix,
  );
  const titleShift = revealedTitle.minX - title.minX;
  const bodyPrefixShift = revealedBodyPrefix.minX - beforeBodyPrefix.minX;
  const bodySuffixShift = revealedBodySuffix.minX - beforeBodySuffix.minX;
  if (
    titleShift < 0.15 ||
    titleShift > 0.35 ||
    Math.abs(titleShift - bodyPrefixShift) > 0.03 ||
    Math.abs(titleShift - bodySuffixShift) > 0.03 ||
    Math.abs(revealedTitle.minY - title.minY) > 0.01 ||
    Math.abs(revealedBodyPrefix.minY - beforeBodyPrefix.minY) > 0.01 ||
    Math.abs(revealedBodySuffix.minY - beforeBodySuffix.minY) > 0.01 ||
    revealedTitle.width < 0.3 ||
    revealedBodyPrefix.width < 0.3 ||
    revealedBodySuffix.width < 0.1
  ) {
    throw new Error(
      'The revealed iOS DRILL card did not preserve the verified pre-swipe geometry.',
    );
  }
  const open = mobileE2EIosExactOcrObservation(revealedObservations, 'Open');
  const titleCenter = mobileE2EIosOcrCenter(revealedTitle);
  const openCenter = mobileE2EIosOcrCenter(open);
  const horizontalGap = revealedTitle.minX - (open.minX + open.width);
  if (
    openCenter.x >= title.minX * 100 ||
    horizontalGap < 0.15 ||
    horizontalGap > 0.35 ||
    Math.abs(openCenter.y - titleCenter.y) > 8 ||
    open.width < 0.03 ||
    open.height < 0.01 ||
    !mobileE2EIosOcrContainsScreenPoint(
      open,
      Math.round(openCenter.x),
      Math.round(openCenter.y),
    )
  ) {
    throw new Error(
      'The exact iOS Open action is not beside the exact DRILL notification.',
    );
  }
  return mobileE2EIosPercentPoint(openCenter.x, openCenter.y);
}

function mobileE2EIosBounds(value: unknown): MobileE2EIosBounds | null {
  if (typeof value !== 'string') return null;
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(value);
  if (match === null) return null;
  const [, leftText, topText, rightText, bottomText] = match;
  const left = Number(leftText);
  const top = Number(topText);
  const right = Number(rightText);
  const bottom = Number(bottomText);
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(top) ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(bottom) ||
    left < 0 ||
    top < 0 ||
    right <= left ||
    bottom <= top
  ) {
    return null;
  }
  return Object.freeze({ left, top, right, bottom });
}

function mobileE2EIosBoundsOverlap(
  left: MobileE2EIosBounds,
  right: MobileE2EIosBounds,
): boolean {
  return (
    left.left < right.right &&
    right.left < left.right &&
    left.top < right.bottom &&
    right.top < left.bottom
  );
}

function mobileE2EIosBoundsInside(
  child: MobileE2EIosBounds,
  parent: MobileE2EIosBounds,
): boolean {
  return (
    child.left >= parent.left &&
    child.top >= parent.top &&
    child.right <= parent.right &&
    child.bottom <= parent.bottom
  );
}

function mobileE2EIosBoundsEqual(
  left: MobileE2EIosBounds | null,
  right: MobileE2EIosBounds | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.left === right.left &&
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom
  );
}

export function mobileE2EIosSyntheticNotificationState(
  hierarchy: string,
): MobileE2EIosSyntheticNotificationState {
  let root: unknown;
  try {
    root = JSON.parse(hierarchy);
  } catch {
    return {
      valid: false,
      locked: false,
      visible: false,
      openable: false,
      coverSheetBounds: null,
      exactCardBounds: null,
      otherCardBounds: Object.freeze([]),
    };
  }
  if (!isRecord(root)) {
    return {
      valid: false,
      locked: false,
      visible: false,
      openable: false,
      coverSheetBounds: null,
      exactCardBounds: null,
      otherCardBounds: Object.freeze([]),
    };
  }

  let foundLockScreen = false;
  let foundCoverSheet = false;
  let coverSheetBounds: MobileE2EIosBounds | null = null;
  let invalidNotificationBounds = false;
  let foundIncidentNotification = false;
  const notificationBounds: MobileE2EIosBounds[] = [];
  const exactNotificationBounds: MobileE2EIosBounds[] = [];
  const visit = (value: unknown): void => {
    if (!isRecord(value)) return;
    const attributes = value.attributes;
    if (isRecord(attributes)) {
      if (attributes['resource-id'] === 'lockscreen-date-view') {
        foundLockScreen = true;
      }
      if (attributes['resource-id'] === 'SBCoverSheetWindow') {
        foundCoverSheet = true;
        coverSheetBounds = mobileE2EIosBounds(attributes.bounds);
      }
      if (attributes['resource-id'] === 'NotificationShortLookView') {
        const bounds = mobileE2EIosBounds(attributes.bounds);
        if (bounds === null) {
          invalidNotificationBounds = true;
        } else {
          notificationBounds.push(bounds);
        }
        const accessibilityText = attributes.accessibilityText;
        if (
          typeof accessibilityText === 'string' &&
          accessibilityText.includes('[INCIDENT]')
        ) {
          foundIncidentNotification = true;
        }
        if (
          bounds !== null &&
          typeof accessibilityText === 'string' &&
          accessibilityText.startsWith('PSD EOC, ') &&
          accessibilityText.includes(
            `${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
          ) &&
          !accessibilityText.includes('[INCIDENT]')
        ) {
          exactNotificationBounds.push(bounds);
        }
      }
    }
    if (Array.isArray(value.children)) {
      for (const child of value.children) visit(child);
    }
  };
  visit(root);
  const exactBounds = exactNotificationBounds[0] ?? null;
  const valid =
    !invalidNotificationBounds &&
    !foundIncidentNotification &&
    exactNotificationBounds.length <= 1 &&
    (!foundCoverSheet || coverSheetBounds !== null);
  const boundsAreInsideCoverSheet =
    coverSheetBounds !== null &&
    notificationBounds.every((bounds) =>
      mobileE2EIosBoundsInside(bounds, coverSheetBounds as MobileE2EIosBounds),
    );
  const exactCardIsDisjoint =
    exactBounds !== null &&
    notificationBounds
      .filter((bounds) => bounds !== exactBounds)
      .every((bounds) => !mobileE2EIosBoundsOverlap(exactBounds, bounds));
  const openable =
    valid &&
    foundCoverSheet &&
    boundsAreInsideCoverSheet &&
    exactBounds !== null &&
    exactCardIsDisjoint;
  return {
    valid,
    locked: foundLockScreen,
    visible: valid && exactNotificationBounds.length === 1,
    openable,
    coverSheetBounds,
    exactCardBounds: exactBounds,
    otherCardBounds: Object.freeze(
      notificationBounds.filter((bounds) => bounds !== exactBounds),
    ),
  };
}

export function decideMobileE2EIosNotificationResponse(
  hierarchies: readonly string[],
): MobileE2EIosNotificationResponseDecision {
  const latestHierarchy = hierarchies.at(-1);
  if (latestHierarchy === undefined) return 'wait';
  if (
    isMobileE2EIosAuthenticationSheetReady(latestHierarchy) ||
    isMobileE2EIosApplicationForeground(latestHierarchy)
  ) {
    return 'response-started';
  }
  const latest = mobileE2EIosSyntheticNotificationState(latestHierarchy);
  if (!latest.valid || !latest.visible) return 'refuse-explicit-open';
  const finalSamples = hierarchies.slice(-3);
  if (
    finalSamples.length === 3 &&
    latest.exactCardBounds !== null &&
    finalSamples.every((hierarchy) => {
      const state = mobileE2EIosSyntheticNotificationState(hierarchy);
      return (
        state.valid &&
        state.openable &&
        mobileE2EIosBoundsEqual(
          state.exactCardBounds,
          latest.exactCardBounds,
        ) &&
        mobileE2EIosBoundsEqual(state.coverSheetBounds, latest.coverSheetBounds)
      );
    })
  ) {
    return 'open-explicit-notification';
  }
  return 'wait';
}

/**
 * Admits one Open tap only after an exact-card right swipe has measurably and
 * stably exposed a leading action strip. Notification disappearance alone is
 * never treated as a response.
 */
export function decideMobileE2EIosRevealedOpenAction(
  beforeRevealHierarchy: string,
  afterRevealHierarchies: readonly string[],
): MobileE2EIosRevealedOpenActionDecision {
  const before = mobileE2EIosSyntheticNotificationState(beforeRevealHierarchy);
  if (
    !before.valid ||
    !before.openable ||
    before.exactCardBounds === null ||
    before.coverSheetBounds === null
  ) {
    return Object.freeze({
      decision: 'refuse-revealed-open',
      tapPoint: null,
    });
  }

  const latestHierarchy = afterRevealHierarchies.at(-1);
  if (latestHierarchy === undefined) {
    return Object.freeze({ decision: 'wait', tapPoint: null });
  }
  if (
    isMobileE2EIosAuthenticationSheetReady(latestHierarchy) ||
    isMobileE2EIosApplicationForeground(latestHierarchy)
  ) {
    return Object.freeze({
      decision: 'response-started',
      tapPoint: null,
    });
  }

  const latest = mobileE2EIosSyntheticNotificationState(latestHierarchy);
  if (
    !latest.valid ||
    !latest.visible ||
    latest.exactCardBounds === null ||
    !mobileE2EIosBoundsEqual(latest.coverSheetBounds, before.coverSheetBounds)
  ) {
    return Object.freeze({
      decision: 'refuse-revealed-open',
      tapPoint: null,
    });
  }

  const finalSamples = afterRevealHierarchies.slice(-3);
  if (
    finalSamples.length < 3 ||
    !finalSamples.every((hierarchy) => {
      const state = mobileE2EIosSyntheticNotificationState(hierarchy);
      return (
        state.valid &&
        state.visible &&
        mobileE2EIosBoundsEqual(
          state.exactCardBounds,
          latest.exactCardBounds,
        ) &&
        mobileE2EIosBoundsEqual(state.coverSheetBounds, before.coverSheetBounds)
      );
    })
  ) {
    return Object.freeze({ decision: 'wait', tapPoint: null });
  }

  const beforeCard = before.exactCardBounds;
  const revealedCard = latest.exactCardBounds;
  const screen = before.coverSheetBounds;
  const exposedWidth = revealedCard.left - beforeCard.left;
  const beforeWidth = beforeCard.right - beforeCard.left;
  const revealedWidth = revealedCard.right - revealedCard.left;
  if (
    exposedWidth < 44 ||
    exposedWidth > (screen.right - screen.left) / 2 ||
    beforeCard.top !== revealedCard.top ||
    beforeCard.bottom !== revealedCard.bottom ||
    beforeWidth !== revealedWidth
  ) {
    return Object.freeze({
      decision: 'refuse-revealed-open',
      tapPoint: null,
    });
  }

  const openX = Math.round((beforeCard.left + revealedCard.left) / 2);
  const openY = Math.round((revealedCard.top + revealedCard.bottom) / 2);
  const pointInsideBounds = (bounds: MobileE2EIosBounds): boolean =>
    openX >= bounds.left &&
    openX < bounds.right &&
    openY >= bounds.top &&
    openY < bounds.bottom;
  if (
    openX < screen.left ||
    openX >= screen.right ||
    openX >= revealedCard.left ||
    openY < screen.top ||
    openY >= screen.bottom ||
    latest.otherCardBounds.some(pointInsideBounds)
  ) {
    return Object.freeze({
      decision: 'refuse-revealed-open',
      tapPoint: null,
    });
  }
  return Object.freeze({
    decision: 'tap-revealed-open',
    tapPoint: `${openX},${openY}`,
  });
}

/**
 * Requires one same-request SpringBoard default-action transaction after the
 * measured Open tap. A prior hint/NO transaction cannot satisfy this gate.
 */
export function mobileE2EIosNotificationActionLogEvidence(
  log: string,
): MobileE2EIosNotificationActionLogEvidence {
  const requestPattern = '[A-F0-9]{4}-[A-F0-9]{4}';
  const executions = [
    ...log.matchAll(
      new RegExp(
        String.raw`requests executing action com\.apple\.UNNotificationDefaultActionIdentifier for notification request (${requestPattern})`,
        'gu',
      ),
    ),
  ].map((match) => match[1] as string);
  const removals = [
    ...log.matchAll(
      new RegExp(
        String.raw`removing notification request (${requestPattern})([^\r\n]*)`,
        'gu',
      ),
    ),
  ]
    .filter(
      (match) =>
        !/\bon long look dismissal\b/iu.test((match[2] as string) ?? ''),
    )
    .map((match) => match[1] as string);
  if (executions.length !== 1) {
    return Object.freeze({ valid: false, requestId: null });
  }
  const requestId = executions[0] as string;
  if (!removals.includes(requestId)) {
    return Object.freeze({ valid: false, requestId: null });
  }
  const otherExecution = executions.some(
    (candidate) => candidate !== requestId,
  );
  const refusalAfterExecution = new RegExp(
    String.raw`(?:Action completion for ${requestId} didExecute\? NO|Completion of action execution for ${requestId}\. didExecute: NO|Hinting side swipe instead of executing action for ${requestId})`,
    'u',
  ).test(log.slice(log.indexOf('requests executing action')));
  if (otherExecution || refusalAfterExecution) {
    return Object.freeze({ valid: false, requestId: null });
  }
  return Object.freeze({ valid: true, requestId });
}

/** Detects only the complete synthetic DRILL card in iOS system UI. */
export function isMobileE2EIosSyntheticNotificationVisible(
  hierarchy: string,
): boolean {
  return mobileE2EIosSyntheticNotificationState(hierarchy).visible;
}

/** Proves the synthetic notification is waiting behind the iOS system lock. */
export function isMobileE2EIosNotificationOnLockedScreen(
  hierarchy: string,
): boolean {
  const state = mobileE2EIosSyntheticNotificationState(hierarchy);
  return state.locked && state.visible;
}

/** Selects a newest available iOS runtime and an iPhone it explicitly supports. */
export function selectMobileE2EIosRuntimeAndDeviceType(
  value: unknown,
): MobileE2EIosRuntimeSelection {
  const runtimes =
    typeof value === 'object' && value !== null && 'runtimes' in value
      ? (value as { readonly runtimes?: unknown }).runtimes
      : undefined;
  if (!Array.isArray(runtimes)) {
    throw new Error('The iOS Simulator runtime list is malformed.');
  }

  const candidates = runtimes
    .flatMap((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) return [];
      const runtime = candidate as Readonly<Record<string, unknown>>;
      if (
        runtime.isAvailable !== true ||
        typeof runtime.identifier !== 'string' ||
        typeof runtime.version !== 'string' ||
        !(
          runtime.platform === 'iOS' ||
          runtime.identifier.includes('.SimRuntime.iOS-')
        ) ||
        !Array.isArray(runtime.supportedDeviceTypes)
      ) {
        return [];
      }
      const supportedIphones = runtime.supportedDeviceTypes.flatMap((type) => {
        if (typeof type !== 'object' || type === null) return [];
        const record = type as Readonly<Record<string, unknown>>;
        return record.productFamily === 'iPhone' &&
          typeof record.identifier === 'string'
          ? [record.identifier]
          : [];
      });
      if (supportedIphones.length === 0) return [];
      const fallbackDeviceType = supportedIphones[0];
      if (fallbackDeviceType === undefined) return [];
      return [
        Object.freeze({
          runtime: runtime.identifier,
          version: runtime.version,
          deviceType: supportedIphones.includes(IOS_DEVICE_TYPE_PREFERENCE)
            ? IOS_DEVICE_TYPE_PREFERENCE
            : fallbackDeviceType,
        }),
      ];
    })
    .sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }),
    );
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error(
      'No available iOS Simulator runtime with a supported iPhone was found.',
    );
  }
  return Object.freeze({
    runtime: selected.runtime,
    deviceType: selected.deviceType,
  });
}
