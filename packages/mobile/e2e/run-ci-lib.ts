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
