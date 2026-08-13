import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MOBILE_E2E_APPLICATION_ID,
  acquireMobileE2EArtifactDirectory,
  acquireMobileE2ERunnerRoot,
  createMobileE2ERunId,
  decideMobileE2EIosRevealedOpenAction,
  decideMobileE2EIosNotificationResponse,
  mobileE2EAndroidInstrumentationArguments,
  mobileE2EDevClientUrl,
  mobileE2EExpoStartArguments,
  mobileE2EFixtureMetroEnvironment,
  mobileE2EIosBuildArguments,
  mobileE2EIsolatedExpoConfig,
  mobileE2EIosSimulatorPushPayload,
  mobileE2EIosNotificationActionLogEvidence,
  mobileE2ELoopbackMetroEnvironment,
  mobileE2EMaestroEnvironment,
  mobileE2ENormalMetroEnvironment,
  isMobileE2EAndroidApplicationForeground,
  isMobileE2EAndroidDeviceAuthenticationPrompt,
  isMobileE2EIosApplicationReadyAfterHandoff,
  isMobileE2EIosAuthenticationSheetReady,
  isMobileE2EIosNotificationOnLockedScreen,
  parseMobileE2EManifestText,
  parseMobileE2EPlatformCli,
  removeMobileE2ERunnerRoot,
  requireMobileE2EEnvironment,
  requireMatchingMobileE2ERunIds,
  selectMobileE2EIosRuntimeAndDeviceType,
  shouldCopyMobileE2EWorkspaceSource,
  type MobileE2EArtifactPaths,
  type MobileE2EPlatform,
  type MobileE2ERunnerPaths,
} from './run-ci-lib';
import type { MobileRuntimeManifest } from '../../server/e2e/mobile-runtime-lib';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const mobileRoot = resolve(repositoryRoot, 'packages/mobile');
const flowRoot = resolve(mobileRoot, 'e2e/flows');
const mobileRuntimeEntrypoint = resolve(
  repositoryRoot,
  'packages/server/e2e/mobile-runtime.ts',
);
const androidInitScriptRelativePath =
  'e2e/android/issue-32.init.gradle' as const;
const COMMAND_TIMEOUT_MS = 30 * 60_000;
const NATIVE_BUILD_TIMEOUT_MS = 45 * 60_000;
const RUNTIME_TIMEOUT_MS = 4 * 60_000;
const METRO_TIMEOUT_MS = 4 * 60_000;
const PROCESS_TERMINATION_GRACE_MS = 15_000;
const RETRY_INTERVAL_MS = 500;
const IOS_NOTIFICATION_RESPONSE_TIMEOUT_MS = 60_000;
const IOS_NOTIFICATION_FIRST_RESPONSE_TIMEOUT_MS = 5_000;
const IOS_NOTIFICATION_ACTION_LOG_TIMEOUT_MS = 30_000;
const IOS_BUNDLE_RELATIVE_PATH =
  'ios/build/Build/Products/Debug-iphonesimulator/PSDEOC.app';
const ANDROID_APK_RELATIVE_PATH =
  'android/app/build/outputs/apk/debug/app-debug.apk';
const IOS_DEVICE_NAME_PREFIX = 'PSD EOC Issue 32';
const ANDROID_DEVICE_PIN = '246832';
const METRO_STATUS = 'packager-status:running';

type BunChild = ReturnType<typeof Bun.spawn>;
const activeChildren = new Set<BunChild>();

interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
  readonly logPath?: string;
  readonly allowFailure?: boolean;
  readonly quiet?: boolean;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ManagedProcess {
  readonly child: BunChild;
  readonly completion: Promise<number>;
}

interface IosDevice {
  readonly udid: string;
  readonly name: string;
}

interface RunnerEvidence {
  readonly issue: 32;
  readonly platform: MobileE2EPlatform;
  readonly runId: string;
  readonly classification: 'drill';
  readonly templateMode: 'drill';
  readonly rosterPopulation: 'synthetic';
  readonly providers: 'mocked';
  readonly pushRegistration: 'disabled';
  readonly eventId: string;
  readonly routeEvidence: string;
  readonly status: 'planned';
  readonly plannedJourneys: readonly [
    'three-tap-synthetic-drill-start',
    'loopback-oidc-enrollment',
    'provider-free-notification-response',
    'append-only-text-and-human-all-clear',
  ];
}

class MobileE2ECancellation {
  private signal: NodeJS.Signals | undefined;
  private readonly handlers = new Map<NodeJS.Signals, () => void>();

  public constructor() {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        if (this.signal === undefined) {
          this.signal = signal;
        }
        for (const child of activeChildren) {
          if (child.exitCode === null) child.kill('SIGTERM');
        }
      };
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  public throwIfRequested(): void {
    if (this.signal !== undefined) {
      throw new Error(`Issue #32 mobile E2E cancelled by ${this.signal}.`);
    }
  }

  public dispose(): void {
    for (const [signal, handler] of this.handlers) {
      process.off(signal, handler);
    }
  }
}

function trackChild(child: BunChild): BunChild {
  activeChildren.add(child);
  void child.exited.then(() => activeChildren.delete(child));
  return child;
}

function commandText(command: readonly string[]): string {
  return command
    .map((argument) =>
      /^[A-Za-z0-9_./:=@+-]+$/u.test(argument)
        ? argument
        : JSON.stringify(argument),
    )
    .join(' ');
}

function redactedProcessOutput(value: string): string {
  return value
    .replace(
      /([?&](?:code|state|token|authorization_code|flow_token)=)[^&\s"']+/giu,
      '$1[redacted]',
    )
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/giu, '$1[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^@\s"']+@/giu, 'postgresql://[redacted]@')
    .replace(
      /("(?:accessToken|refreshToken|authorizationCode|flowToken|codeVerifier)"\s*:\s*")[^"]+("?)/giu,
      '$1[redacted]$2',
    );
}

function errorSummary(error: unknown, depth = 0): string {
  const message =
    error instanceof Error ? error.message : 'Unknown mobile E2E failure.';
  if (!(error instanceof AggregateError) || depth >= 4) return message;
  return [
    message,
    ...error.errors.map(
      (nested: unknown) => `caused by: ${errorSummary(nested, depth + 1)}`,
    ),
  ].join('\n');
}

const SAFE_INHERITED_ENVIRONMENT_NAMES = Object.freeze([
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'CI',
  'COCOAPODS_DISABLE_STATS',
  'DEVELOPER_DIR',
  'GITHUB_ACTIONS',
  'GRADLE_USER_HOME',
  'HOME',
  'JAVA_HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_OPTIONS',
  'PATH',
  'PSD_EOC_E2E_SYNTHETIC_ONLY',
  'RUNNER_TEMP',
  'SDKROOT',
  'SHELL',
  'TERM',
  'TEST_DATABASE_URL',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME',
]);

function definedProcessEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  return new Response(stream).text();
}

async function terminateProcess(child: BunChild): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = child.exited.then(() => undefined);
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout('timeout'),
          PROCESS_TERMINATION_GRACE_MS,
        );
      }),
    ]);
    if (result === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runCommand(
  command: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const environment = options.environment ?? definedProcessEnvironment();
  const child = trackChild(
    Bun.spawn([...command], {
      cwd: options.cwd ?? repositoryRoot,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  if (
    !(child.stdout instanceof ReadableStream) ||
    !(child.stderr instanceof ReadableStream)
  ) {
    throw new Error('The command process did not expose captured output.');
  }
  const stdoutPromise = collectStream(child.stdout);
  const stderrPromise = collectStream(child.stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ kind: 'exit' as const, exitCode })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolveTimeout) => {
      timer = setTimeout(
        () => resolveTimeout({ kind: 'timeout' }),
        options.timeoutMilliseconds ?? COMMAND_TIMEOUT_MS,
      );
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === 'timeout') {
    await terminateProcess(child);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const exitCode = outcome.kind === 'exit' ? outcome.exitCode : 124;
  const transcript = redactedProcessOutput(
    [
      `$ ${commandText(command)}`,
      '',
      stdout,
      stderr,
      `exit=${exitCode}`,
      '',
    ].join('\n'),
  );
  if (options.logPath !== undefined) {
    await writeFile(options.logPath, transcript, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  if (options.quiet !== true && options.logPath === undefined) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderr.length > 0) process.stderr.write(stderr);
  }
  if (exitCode !== 0 && options.allowFailure !== true) {
    throw new Error(
      outcome.kind === 'timeout'
        ? `Command timed out: ${commandText(command)}`
        : `Command failed (${exitCode}): ${commandText(command)}`,
    );
  }
  return Object.freeze({ exitCode, stdout, stderr });
}

function startManagedProcess(
  command: readonly string[],
  options: Required<Pick<CommandOptions, 'cwd' | 'environment' | 'logPath'>>,
): ManagedProcess {
  const child = trackChild(
    Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.environment,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  if (
    !(child.stdout instanceof ReadableStream) ||
    !(child.stderr instanceof ReadableStream)
  ) {
    throw new Error('The managed process did not expose captured output.');
  }
  const stdoutPromise = collectStream(child.stdout);
  const stderrPromise = collectStream(child.stderr);
  const completion = (async () => {
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const transcript = redactedProcessOutput(
      [
        `$ ${commandText(command)}`,
        '',
        stdout,
        stderr,
        `exit=${exitCode}`,
        '',
      ].join('\n'),
    );
    await writeFile(options.logPath, transcript, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const redactedStdout = redactedProcessOutput(stdout);
    const redactedStderr = redactedProcessOutput(stderr);
    if (redactedStdout.length > 0) process.stdout.write(redactedStdout);
    if (redactedStderr.length > 0) process.stderr.write(redactedStderr);
    return exitCode;
  })();
  return Object.freeze({ child, completion });
}

async function stopManagedProcess(process_: ManagedProcess): Promise<void> {
  await terminateProcess(process_.child);
  const exitCode = await process_.completion;
  if (exitCode !== 0 && exitCode !== 143 && exitCode !== 130) {
    throw new Error(`Managed process exited unexpectedly (${exitCode}).`);
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port.'));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function reserveDistinctPorts(count: number): Promise<readonly number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await reserveLoopbackPort());
  return Object.freeze([...ports]);
}

async function awaitFile(
  path: string,
  timeoutMilliseconds: number,
  process_: ManagedProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (process_.child.exitCode !== null) {
      throw new Error(
        `The mobile runtime exited before publishing its manifest (${process_.child.exitCode}).`,
      );
    }
    const metadata = await lstat(path).catch(() => null);
    if (metadata !== null) {
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('The mobile runtime manifest is not a regular file.');
      }
      if ((metadata.mode & 0o777) !== 0o600) {
        throw new Error('The mobile runtime manifest must have mode 0600.');
      }
      return;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  throw new Error('The mobile runtime did not publish its manifest in time.');
}

async function awaitMetro(
  port: number,
  process_: ManagedProcess,
): Promise<void> {
  const deadline = Date.now() + METRO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (process_.child.exitCode !== null) {
      throw new Error(
        `Metro exited before readiness (${process_.child.exitCode}).`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok && (await response.text()).trim() === METRO_STATUS)
        return;
    } catch {
      // Readiness failures retry until the bounded deadline.
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  throw new Error(`Metro on loopback port ${port} was not ready in time.`);
}

async function copyMobileWorkspace(paths: MobileE2ERunnerPaths): Promise<void> {
  await mkdir(resolve(paths.repository, 'packages'), {
    recursive: true,
    mode: 0o700,
  });
  await cp(mobileRoot, paths.copiedMobile, {
    recursive: true,
    filter(source) {
      return shouldCopyMobileE2EWorkspaceSource(mobileRoot, source);
    },
  });
  await cp(
    resolve(repositoryRoot, 'tsconfig.base.json'),
    resolve(paths.repository, 'tsconfig.base.json'),
  );
  await symlink(
    resolve(repositoryRoot, 'node_modules'),
    resolve(paths.repository, 'node_modules'),
    'dir',
  );
  const linked = await readlink(resolve(paths.repository, 'node_modules'));
  if (resolve(linked) !== resolve(repositoryRoot, 'node_modules')) {
    throw new Error(
      'The isolated mobile workspace has an unexpected dependency link.',
    );
  }
  // Keep Metro's entry inside the isolated mobile root. Resolving the package
  // main directly through the dependency symlink makes Expo publish the real
  // checkout's absolute entry path, which the copied app cannot bundle.
  const packagePath = resolve(paths.copiedMobile, 'package.json');
  const packageValue: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
  if (
    typeof packageValue !== 'object' ||
    packageValue === null ||
    Array.isArray(packageValue) ||
    (packageValue as Readonly<Record<string, unknown>>).main !==
      'expo-router/entry'
  ) {
    throw new Error('The mobile package has an unexpected Expo entry point.');
  }
  const localEntryPath = resolve(paths.copiedMobile, 'e2e/metro-entry.js');
  const localEntry = await lstat(localEntryPath);
  if (!localEntry.isFile() || localEntry.isSymbolicLink()) {
    throw new Error('The isolated mobile Metro entry must be a regular file.');
  }
  await writeFile(
    packagePath,
    `${JSON.stringify(
      {
        ...(packageValue as Readonly<Record<string, unknown>>),
        main: './e2e/metro-entry.js',
      },
      undefined,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const appConfigPath = resolve(paths.copiedMobile, 'app.json');
  const isolatedAppConfig = mobileE2EIsolatedExpoConfig(
    JSON.parse(await readFile(appConfigPath, 'utf8')),
  );
  await writeFile(
    appConfigPath,
    `${JSON.stringify(isolatedAppConfig, undefined, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function requireExecutable(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute.`);
  await access(path);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new Error(`${label} must be a regular executable file.`);
  }
  return path;
}

function applesimutilsPath(): string {
  return resolve(homedir(), '.maestro/deps/applesimutils');
}

async function selectIosRuntimeAndDeviceType(
  artifactRoot: string,
): Promise<Readonly<{ runtime: string; deviceType: string }>> {
  const runtimes = await runCommand(
    ['xcrun', 'simctl', 'list', 'runtimes', '--json'],
    {
      logPath: resolve(artifactRoot, 'ios-runtime-selection.log'),
      quiet: true,
    },
  );
  let parsedRuntimes: unknown;
  try {
    parsedRuntimes = JSON.parse(runtimes.stdout);
  } catch {
    throw new Error('The iOS Simulator runtime list was not valid JSON.');
  }
  return selectMobileE2EIosRuntimeAndDeviceType(parsedRuntimes);
}

async function createIosDevice(
  runId: string,
  artifactRoot: string,
): Promise<IosDevice> {
  const selected = await selectIosRuntimeAndDeviceType(artifactRoot);
  const name = `${IOS_DEVICE_NAME_PREFIX} ${runId.slice(0, 8)}`;
  const created = await runCommand(
    ['xcrun', 'simctl', 'create', name, selected.deviceType, selected.runtime],
    {
      logPath: resolve(artifactRoot, 'ios-create-simulator.log'),
      quiet: true,
    },
  );
  const udid = created.stdout.trim();
  if (!/^[0-9A-Fa-f-]{36}$/u.test(udid)) {
    throw new Error('simctl returned an invalid owned simulator UDID.');
  }
  const device = Object.freeze({ udid, name });
  try {
    await runCommand(['xcrun', 'simctl', 'boot', udid], {
      logPath: resolve(artifactRoot, 'ios-boot.log'),
    });
    await runCommand(['xcrun', 'simctl', 'bootstatus', udid, '-b'], {
      timeoutMilliseconds: 10 * 60_000,
      logPath: resolve(artifactRoot, 'ios-bootstatus.log'),
    });
    return device;
  } catch (error) {
    try {
      await deleteIosDevice(device);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'The owned iOS simulator failed to start and could not be deleted.',
      );
    }
    throw error;
  }
}

async function deleteIosDevice(device: IosDevice): Promise<void> {
  if (!device.name.startsWith(`${IOS_DEVICE_NAME_PREFIX} `)) {
    throw new Error('Refusing to delete a simulator not owned by issue #32.');
  }
  await runCommand(['xcrun', 'simctl', 'shutdown', device.udid], {
    allowFailure: true,
  });
  await runCommand(['xcrun', 'simctl', 'delete', device.udid]);
}

async function ensureAndroidDevice(serial: string): Promise<void> {
  if (!/^emulator-\d+$/u.test(serial)) {
    throw new Error('ANDROID_SERIAL must identify one local Android emulator.');
  }
  const state = await runCommand(['adb', '-s', serial, 'get-state']);
  if (state.stdout.trim() !== 'device') {
    throw new Error('The Android emulator is not ready.');
  }
  const qemu = await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'getprop',
    'ro.kernel.qemu',
  ]);
  if (qemu.stdout.trim() !== '1') {
    throw new Error('Issue #32 Android evidence requires an emulator build.');
  }
  for (const packageId of [
    MOBILE_E2E_APPLICATION_ID,
    `${MOBILE_E2E_APPLICATION_ID}.test`,
  ]) {
    if (await androidPackageInstalled(serial, packageId)) {
      throw new Error(
        `The Android emulator must not contain pre-existing package ${packageId}.`,
      );
    }
  }
}

async function androidPackageInstalled(
  serial: string,
  packageId: string,
): Promise<boolean> {
  const result = await runCommand(
    ['adb', '-s', serial, 'shell', 'pm', 'path', packageId],
    { allowFailure: true, quiet: true },
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function prebuildNativeProject(
  platform: MobileE2EPlatform,
  paths: MobileE2ERunnerPaths,
  artifactRoot: string,
): Promise<void> {
  await runCommand(
    [
      process.execPath,
      'x',
      'expo',
      'prebuild',
      '--no-install',
      '--platform',
      platform,
    ],
    {
      cwd: paths.copiedMobile,
      environment: mobileE2EFixtureMetroEnvironment(
        definedProcessEnvironment(),
      ),
      timeoutMilliseconds: NATIVE_BUILD_TIMEOUT_MS,
      logPath: resolve(artifactRoot, `${platform}-prebuild.log`),
    },
  );
}

async function buildIosApp(
  paths: MobileE2ERunnerPaths,
  artifactRoot: string,
  device: IosDevice,
): Promise<string> {
  const iosRoot = resolve(paths.copiedMobile, 'ios');
  await runCommand(['pod', 'install'], {
    cwd: iosRoot,
    environment: mobileE2EFixtureMetroEnvironment(definedProcessEnvironment()),
    timeoutMilliseconds: NATIVE_BUILD_TIMEOUT_MS,
    logPath: resolve(artifactRoot, 'ios-pod-install.log'),
  });
  await runCommand(mobileE2EIosBuildArguments(device.udid), {
    cwd: iosRoot,
    environment: mobileE2EFixtureMetroEnvironment(definedProcessEnvironment()),
    timeoutMilliseconds: NATIVE_BUILD_TIMEOUT_MS,
    logPath: resolve(artifactRoot, 'ios-xcodebuild.log'),
  });
  const appPath = resolve(paths.copiedMobile, IOS_BUNDLE_RELATIVE_PATH);
  const metadata = await lstat(appPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The iOS build did not produce the expected app bundle.');
  }
  return appPath;
}

async function buildAndroidApp(
  paths: MobileE2ERunnerPaths,
  artifactRoot: string,
): Promise<string> {
  await runCommand(
    [
      resolve(paths.copiedMobile, 'android/gradlew'),
      '--no-daemon',
      '--stacktrace',
      'app:assembleDebug',
    ],
    {
      cwd: resolve(paths.copiedMobile, 'android'),
      environment: mobileE2EFixtureMetroEnvironment(
        definedProcessEnvironment(),
      ),
      timeoutMilliseconds: NATIVE_BUILD_TIMEOUT_MS,
      logPath: resolve(artifactRoot, 'android-build.log'),
    },
  );
  const apkPath = resolve(paths.copiedMobile, ANDROID_APK_RELATIVE_PATH);
  const metadata = await lstat(apkPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('The Android build did not produce the expected APK.');
  }
  return apkPath;
}

function startMetro(
  paths: MobileE2ERunnerPaths,
  artifactRoot: string,
  port: number,
  label: string,
  environment: Readonly<Record<string, string>>,
): ManagedProcess {
  return startManagedProcess(
    [process.execPath, ...mobileE2EExpoStartArguments(port)],
    {
      cwd: paths.copiedMobile,
      environment: mobileE2ELoopbackMetroEnvironment(environment),
      logPath: resolve(artifactRoot, `${label}-metro.log`),
    },
  );
}

async function installAndOpenIosBundle(
  device: IosDevice,
  appPath: string,
  metroPort: number,
  expectedApplicationText: string,
  artifactRoot: string,
): Promise<void> {
  await runCommand(
    ['xcrun', 'simctl', 'terminate', device.udid, MOBILE_E2E_APPLICATION_ID],
    {
      allowFailure: true,
    },
  );
  await runCommand(
    ['xcrun', 'simctl', 'uninstall', device.udid, MOBILE_E2E_APPLICATION_ID],
    {
      allowFailure: true,
    },
  );
  await runCommand(['xcrun', 'simctl', 'install', device.udid, appPath]);
  await openIosBundleThroughSystemHandoff(
    device,
    metroPort,
    expectedApplicationText,
    artifactRoot,
  );
}

async function openIosBundleThroughSystemHandoff(
  device: IosDevice,
  metroPort: number,
  expectedApplicationText: string,
  artifactRoot: string,
): Promise<void> {
  await openIosBundle(device, metroPort);
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  let handoffAttempts = 0;
  let quietPolls = 0;
  let urlAttempts = 1;
  let lastHierarchy = '';
  const attemptExactSystemHandoff = async (): Promise<boolean> => {
    if (handoffAttempts >= 8) return false;
    handoffAttempts += 1;
    await runCommand(
      [
        'maestro',
        '--udid',
        device.udid,
        'test',
        '--no-ansi',
        '--env',
        'PSD_EOC_E2E_SYNTHETIC_ONLY=true',
        resolve(flowRoot, 'shared/accept-dev-client-handoff-ios.yaml'),
      ],
      {
        allowFailure: true,
        timeoutMilliseconds: 30_000,
        logPath: resolve(
          artifactRoot,
          `ios-handoff-${metroPort}-open-attempt-${handoffAttempts}.log`,
        ),
      },
    );
    await Bun.sleep(RETRY_INTERVAL_MS);
    return true;
  };

  // iOS 26 can omit this SpringBoard alert from Maestro's standalone
  // hierarchy even while it is visibly blocking the app. The synthetic-only
  // flow asserts the exact alert and exact Open label, so trying it after each
  // bounded openurl attempt is safe; a missing alert simply fails the flow and
  // readiness remains unproven.
  await attemptExactSystemHandoff();
  while (Date.now() < deadline) {
    const hierarchy = await platformHierarchy('ios', device.udid);
    lastHierarchy = hierarchy;
    if (
      isMobileE2EIosApplicationReadyAfterHandoff(
        hierarchy,
        expectedApplicationText,
      )
    ) {
      await writeFile(
        resolve(artifactRoot, `ios-handoff-${metroPort}-ready-hierarchy.txt`),
        hierarchy,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      return;
    }
    if (hierarchy.includes('Open in “PSD EOC”?')) {
      quietPolls = 0;
      if (!(await attemptExactSystemHandoff())) break;
      continue;
    }
    quietPolls += 1;
    if (quietPolls >= 5 && urlAttempts < 4) {
      quietPolls = 0;
      urlAttempts += 1;
      await openIosBundle(device, metroPort);
      if (!(await attemptExactSystemHandoff())) break;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  await writeFile(
    resolve(artifactRoot, `ios-handoff-${metroPort}-failure-hierarchy.txt`),
    lastHierarchy,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  await runCommand(
    [
      'xcrun',
      'simctl',
      'io',
      device.udid,
      'screenshot',
      resolve(artifactRoot, `ios-handoff-${metroPort}-failure-screen.png`),
    ],
    {
      allowFailure: true,
      logPath: resolve(
        artifactRoot,
        `ios-handoff-${metroPort}-failure-screenshot.log`,
      ),
    },
  );
  throw new Error('The iOS development-client handoff did not open PSD EOC.');
}

async function openIosBundle(
  device: IosDevice,
  metroPort: number,
): Promise<void> {
  await runCommand([
    'xcrun',
    'simctl',
    'openurl',
    device.udid,
    mobileE2EDevClientUrl(metroPort),
  ]);
}

async function installAndOpenAndroidBundle(
  serial: string,
  apkPath: string,
  metroPort: number,
  reversePorts: readonly number[],
  ownedReversePorts: Set<number>,
): Promise<void> {
  await runCommand(['adb', '-s', serial, 'install', '-r', '-t', apkPath]);
  await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'pm',
    'clear',
    MOBILE_E2E_APPLICATION_ID,
  ]);
  await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'pm',
    'grant',
    MOBILE_E2E_APPLICATION_ID,
    'android.permission.POST_NOTIFICATIONS',
  ]);
  for (const port of new Set([metroPort, ...reversePorts])) {
    const existing = await runCommand(
      ['adb', '-s', serial, 'reverse', '--list'],
      {
        quiet: true,
      },
    );
    if (
      existing.stdout
        .split('\n')
        .some((line) => line.split(/\s+/u).includes(`tcp:${port}`))
    ) {
      throw new Error(
        `The Android emulator already owns reverse mapping tcp:${port}.`,
      );
    }
    // Claim the exact absent mapping before the mutation so cleanup still
    // runs if adb applies it but its response is lost or interrupted.
    ownedReversePorts.add(port);
    await runCommand([
      'adb',
      '-s',
      serial,
      'reverse',
      `tcp:${port}`,
      `tcp:${port}`,
    ]);
  }
  await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    mobileE2EDevClientUrl(metroPort),
    '-p',
    MOBILE_E2E_APPLICATION_ID,
  ]);
}

async function awaitApplicationReady(
  platform: MobileE2EPlatform,
  deviceId: string,
  expectedText: string,
): Promise<void> {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hierarchy = await runCommand(
      ['maestro', '--udid', deviceId, 'hierarchy'],
      { allowFailure: true, quiet: true, timeoutMilliseconds: 30_000 },
    );
    if (hierarchy.exitCode === 0 && hierarchy.stdout.includes(expectedText))
      return;
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  throw new Error(`${platform} app did not expose ${expectedText} in time.`);
}

async function platformHierarchy(
  platform: MobileE2EPlatform,
  deviceId: string,
): Promise<string> {
  if (platform === 'ios') {
    const result = await runCommand(
      ['maestro', '--udid', deviceId, 'hierarchy'],
      { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
    );
    return `${result.stdout}\n${result.stderr}`;
  }
  const remotePath = '/sdcard/psd-eoc-issue32-window.xml';
  await runCommand(
    ['adb', '-s', deviceId, 'shell', 'uiautomator', 'dump', remotePath],
    { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
  );
  const result = await runCommand(
    ['adb', '-s', deviceId, 'shell', 'cat', remotePath],
    { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
  );
  return `${result.stdout}\n${result.stderr}`;
}

async function iosNotificationActionLogsSince(
  deviceId: string,
  seconds: number,
): Promise<string> {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120) {
    throw new Error('The iOS notification log window is invalid.');
  }
  const result = await runCommand(
    [
      'xcrun',
      'simctl',
      'spawn',
      deviceId,
      'log',
      'show',
      '--style',
      'compact',
      '--last',
      `${seconds}s`,
      '--predicate',
      'subsystem == "com.apple.UserNotificationsKit" AND category == "Lists"',
      '--info',
    ],
    { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
  );
  return `${result.stdout}\n${result.stderr}`;
}

async function respondToDeviceAuthentication(
  platform: MobileE2EPlatform,
  deviceId: string,
  artifactRoot: string,
  flowName: string,
  applesimutils: string | undefined,
): Promise<void> {
  // The pre-auth Maestro flow has completed immediately after the foreground
  // app tap or callback that requests device authentication. Android exposes
  // its pending SystemUI sheet to uiautomator, while iOS 26 deliberately omits
  // secure-sheet text from a later XCTest hierarchy. An early or cached
  // response cannot count as evidence.
  if (platform === 'ios') {
    if (applesimutils === undefined) {
      throw new Error('The pinned Apple simulator helper is missing.');
    }
    // Metro can still be compiling after the development-client handoff.
    // Wait for the exact secure-sheet accessibility token retained by pinned
    // Maestro 2.7. This token is synchronization only: the following
    // authenticated post-state remains the executable pass gate.
    const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
    let readyHierarchy: string | undefined;
    while (Date.now() < deadline) {
      const hierarchy = await platformHierarchy('ios', deviceId);
      if (isMobileE2EIosAuthenticationSheetReady(hierarchy)) {
        readyHierarchy = hierarchy;
        break;
      }
      await Bun.sleep(RETRY_INTERVAL_MS);
    }
    if (readyHierarchy === undefined) {
      const failureHierarchy = await platformHierarchy('ios', deviceId);
      await writeFile(
        resolve(artifactRoot, `device-auth-${flowName}-failure-hierarchy.txt`),
        failureHierarchy,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      await runCommand(
        [
          'xcrun',
          'simctl',
          'io',
          deviceId,
          'screenshot',
          resolve(artifactRoot, `device-auth-${flowName}-failure-prompt.png`),
        ],
        {
          allowFailure: true,
          logPath: resolve(
            artifactRoot,
            `device-auth-${flowName}-failure-screenshot.log`,
          ),
        },
      );
      throw new Error('The iOS device-authentication sheet was not ready.');
    }
    await writeFile(
      resolve(artifactRoot, `device-auth-${flowName}-hierarchy.txt`),
      readyHierarchy,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const screenshotPath = resolve(
      artifactRoot,
      `device-auth-${flowName}-prompt.png`,
    );
    await runCommand(
      ['xcrun', 'simctl', 'io', deviceId, 'screenshot', screenshotPath],
      {
        logPath: resolve(
          artifactRoot,
          `device-auth-${flowName}-screenshot.log`,
        ),
      },
    );
    const screenshot = await lstat(screenshotPath);
    if (
      !screenshot.isFile() ||
      screenshot.isSymbolicLink() ||
      screenshot.size === 0
    ) {
      throw new Error('The iOS device-authentication screenshot is invalid.');
    }
    await runCommand([applesimutils, '--byId', deviceId, '--biometricMatch'], {
      logPath: resolve(artifactRoot, `device-auth-${flowName}-response.log`),
    });
    return;
  }
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hierarchy = await platformHierarchy(platform, deviceId);
    if (isMobileE2EAndroidDeviceAuthenticationPrompt(hierarchy)) {
      await writeFile(
        resolve(artifactRoot, `device-auth-${flowName}-hierarchy.txt`),
        hierarchy,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      await runCommand([
        'adb',
        '-s',
        deviceId,
        'shell',
        'input',
        'text',
        ANDROID_DEVICE_PIN,
      ]);
      await runCommand([
        'adb',
        '-s',
        deviceId,
        'shell',
        'input',
        'keyevent',
        '66',
      ]);
      return;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  throw new Error(
    'The exact PSD EOC device-authentication prompt was not observed.',
  );
}

function maestroArguments(
  deviceId: string,
  flowPath: string,
  artifactDirectory: string,
  environment: Readonly<Record<string, string>>,
): readonly string[] {
  const arguments_: string[] = [
    'maestro',
    'test',
    '--udid',
    deviceId,
    '--no-ansi',
    '--format',
    'JUNIT',
    '--output',
    resolve(artifactDirectory, 'junit.xml'),
    '--test-output-dir',
    resolve(artifactDirectory, 'maestro-artifacts'),
    '--debug-output',
    resolve(artifactDirectory, 'maestro-debug'),
    '--flatten-debug-output',
  ];
  for (const [name, value] of Object.entries(environment).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    arguments_.push('--env', `${name}=${value}`);
  }
  arguments_.push(flowPath);
  return Object.freeze(arguments_);
}

async function runMaestroFlow(
  deviceId: string,
  flowName: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const artifactDirectory = resolve(artifactRoot, `maestro-${flowName}`);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const flowPath = resolve(flowRoot, `${flowName}.yaml`);
  const command = maestroArguments(
    deviceId,
    flowPath,
    artifactDirectory,
    environment,
  );
  const process_ = startManagedProcess(command, {
    cwd: flowRoot,
    environment: {
      ...definedProcessEnvironment(),
      MAESTRO_CLI_NO_ANALYTICS: '1',
    },
    logPath: resolve(artifactDirectory, 'maestro.log'),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    process_.completion.then((exitCode) => ({
      kind: 'exit' as const,
      exitCode,
    })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolveTimeout) => {
      timer = setTimeout(
        () => resolveTimeout({ kind: 'timeout' }),
        COMMAND_TIMEOUT_MS,
      );
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind !== 'exit') await terminateProcess(process_.child);
  const exitCode = await process_.completion;
  if (outcome.kind === 'timeout' || exitCode !== 0) {
    throw new Error(
      outcome.kind === 'timeout'
        ? `Maestro flow timed out: ${flowName}`
        : `Maestro flow failed (${exitCode}): ${flowName}`,
    );
  }
}

async function runAuthenticationSplit(
  platform: MobileE2EPlatform,
  deviceId: string,
  flowName: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
  applesimutils?: string,
): Promise<void> {
  await runMaestroFlow(
    deviceId,
    `${flowName}-pre-auth`,
    artifactRoot,
    environment,
  );
  await respondToDeviceAuthentication(
    platform,
    deviceId,
    artifactRoot,
    flowName,
    applesimutils,
  );
  await runMaestroFlow(
    deviceId,
    `${flowName}-post-auth`,
    artifactRoot,
    environment,
  );
}

async function runLaunchAuthentication(
  platform: MobileE2EPlatform,
  deviceId: string,
  flowName: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
  applesimutils?: string,
): Promise<void> {
  // An enrolled session invokes device authentication automatically as its
  // foreground bootstrap completes. Starting XCTest before answering that
  // native sheet can hide or contend with it, so only the authenticated
  // post-state is driven through Maestro.
  await respondToDeviceAuthentication(
    platform,
    deviceId,
    artifactRoot,
    flowName,
    applesimutils,
  );
  await runMaestroFlow(
    deviceId,
    `${flowName}-post-auth`,
    artifactRoot,
    environment,
  );
}

async function holdEventRoomForOperatorScreenshot(
  artifactRoot: string,
): Promise<void> {
  const requested = process.env.PSD_EOC_MOBILE_E2E_SCREENSHOT_HOLD_SECONDS;
  if (requested === undefined) return;
  if (!/^\d{1,3}$/u.test(requested)) {
    throw new Error(
      'PSD_EOC_MOBILE_E2E_SCREENSHOT_HOLD_SECONDS must be an integer from 1 through 600.',
    );
  }
  const seconds = Number(requested);
  if (seconds < 1 || seconds > 600) {
    throw new Error(
      'PSD_EOC_MOBILE_E2E_SCREENSHOT_HOLD_SECONDS must be an integer from 1 through 600.',
    );
  }
  await writeFile(
    resolve(artifactRoot, 'operator-screenshot-ready.txt'),
    'The authenticated synthetic drill event room is ready for a screenshot.\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const donePath = resolve(artifactRoot, 'operator-screenshot-done.txt');
  console.log(
    `[issue #32 mobile E2E] screenshot ready; holding the synthetic drill event room for up to ${seconds} seconds`,
  );
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    if (await Bun.file(donePath).exists()) {
      const marker = await lstat(donePath);
      if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 64) {
        throw new Error(
          'The operator screenshot completion marker is invalid.',
        );
      }
      console.log('[issue #32 mobile E2E] screenshot hold released');
      return;
    }
    await Bun.sleep(1_000);
  }
}

async function resetIosForNormalApp(
  device: IosDevice,
  appPath: string,
  normalMetroPort: number,
  applesimutils: string,
  artifactRoot: string,
): Promise<void> {
  // The activation fixture exercises the real protected credential store.
  // Xcode's native reset removes access-controlled vault items that uninstall
  // and the older helper can retain, while preserving this dedicated
  // simulator's enrolled biometric state for the next genuine auth prompt.
  await runCommand(['xcrun', 'simctl', 'keychain', device.udid, 'reset'], {
    logPath: resolve(artifactRoot, 'ios-normal-reset-keychain.log'),
  });
  await installAndOpenIosBundle(
    device,
    appPath,
    normalMetroPort,
    'Sign in to PSD EOC',
    artifactRoot,
  );
  await runCommand([
    applesimutils,
    '--byId',
    device.udid,
    '--bundle',
    MOBILE_E2E_APPLICATION_ID,
    '--setPermissions',
    'notifications=YES,faceid=YES',
  ]);
  await runCommand([
    applesimutils,
    '--byId',
    device.udid,
    '--biometricEnrollment',
    'YES',
  ]);
  await openIosBundleThroughSystemHandoff(
    device,
    normalMetroPort,
    'Sign in to PSD EOC',
    artifactRoot,
  );
}

async function awaitIosFreshEnrollmentReady(
  deviceId: string,
  artifactRoot: string,
  applesimutils: string,
): Promise<void> {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  let stableSignInSamples = 0;
  let recoveredFixtureVault = false;
  while (Date.now() < deadline) {
    const hierarchy = await platformHierarchy('ios', deviceId);
    if (isMobileE2EIosAuthenticationSheetReady(hierarchy)) {
      if (recoveredFixtureVault) {
        throw new Error(
          'The iOS fixture-vault recovery requested authentication more than once.',
        );
      }
      recoveredFixtureVault = true;
      stableSignInSamples = 0;
      await respondToDeviceAuthentication(
        'ios',
        deviceId,
        artifactRoot,
        'reset-fixture-vault-ios',
        applesimutils,
      );
      continue;
    }
    if (hierarchy.includes('Sign in with Google')) {
      stableSignInSamples += 1;
      if (stableSignInSamples >= 3) return;
    } else {
      stableSignInSamples = 0;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  throw new Error(
    'The iOS normal app did not reach a stable fresh-enrollment state.',
  );
}

async function configureAndroidCredential(serial: string): Promise<void> {
  await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'locksettings',
    'set-pin',
    ANDROID_DEVICE_PIN,
  ]);
}

async function cleanupAndroidState(
  serial: string,
  ownedReversePorts: ReadonlySet<number>,
  credentialConfigured: boolean,
  packagesWereAbsent: boolean,
): Promise<void> {
  const failures: unknown[] = [];
  for (const port of ownedReversePorts) {
    await runCommand([
      'adb',
      '-s',
      serial,
      'reverse',
      '--remove',
      `tcp:${port}`,
    ]).catch((error: unknown) => failures.push(error));
  }
  if (packagesWereAbsent) {
    for (const packageId of [
      `${MOBILE_E2E_APPLICATION_ID}.test`,
      MOBILE_E2E_APPLICATION_ID,
    ]) {
      try {
        if (await androidPackageInstalled(serial, packageId)) {
          await runCommand(['adb', '-s', serial, 'uninstall', packageId]);
        }
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (credentialConfigured) {
    await runCommand([
      'adb',
      '-s',
      serial,
      'shell',
      'locksettings',
      'clear',
      '--old',
      ANDROID_DEVICE_PIN,
    ]).catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Android E2E state cleanup failed.');
  }
}

async function injectIosNotification(
  device: IosDevice,
  paths: MobileE2ERunnerPaths,
  manifest: MobileRuntimeManifest,
): Promise<void> {
  const payloadPath = resolve(paths.root, 'issue-32-drill.apns');
  await writeFile(
    payloadPath,
    `${JSON.stringify(mobileE2EIosSimulatorPushPayload(manifest))}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await runCommand([
    'xcrun',
    'simctl',
    'terminate',
    device.udid,
    MOBILE_E2E_APPLICATION_ID,
  ]);
  await runCommand([
    'xcrun',
    'simctl',
    'push',
    device.udid,
    MOBILE_E2E_APPLICATION_ID,
    payloadPath,
  ]);
}

async function awaitIosNotificationOnLockedScreen(
  deviceId: string,
  artifactRoot: string,
): Promise<void> {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  let hierarchy = '';
  while (Date.now() < deadline) {
    hierarchy = await platformHierarchy('ios', deviceId);
    if (isMobileE2EIosNotificationOnLockedScreen(hierarchy)) break;
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  if (!isMobileE2EIosNotificationOnLockedScreen(hierarchy)) {
    await writeFile(
      resolve(artifactRoot, 'notification-locked-ios-failure-hierarchy.txt'),
      hierarchy,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    await runCommand(
      [
        'xcrun',
        'simctl',
        'io',
        deviceId,
        'screenshot',
        resolve(artifactRoot, 'notification-locked-ios-failure-screen.png'),
      ],
      {
        allowFailure: true,
        logPath: resolve(
          artifactRoot,
          'notification-locked-ios-failure-screenshot.log',
        ),
      },
    );
    throw new Error(
      'The exact synthetic drill notification did not appear on the locked iOS simulator.',
    );
  }
  await writeFile(
    resolve(artifactRoot, 'notification-locked-ios-hierarchy.txt'),
    hierarchy,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const screenshotPath = resolve(
    artifactRoot,
    'notification-locked-ios-screen.png',
  );
  await runCommand(
    ['xcrun', 'simctl', 'io', deviceId, 'screenshot', screenshotPath],
    {
      logPath: resolve(artifactRoot, 'notification-locked-ios-screenshot.log'),
    },
  );
  const screenshot = await lstat(screenshotPath);
  if (
    !screenshot.isFile() ||
    screenshot.isSymbolicLink() ||
    screenshot.size === 0
  ) {
    throw new Error('The locked iOS notification screenshot is invalid.');
  }
}

async function satisfyIosSystemLockAuthentication(
  deviceId: string,
  applesimutils: string,
  artifactRoot: string,
): Promise<void> {
  // This biometric response clears only the dedicated simulator's operating-
  // system lock. The notification tap must still launch PSD EOC and produce a
  // separate LocalAuthentication sheet before the event room can be read.
  await runCommand([applesimutils, '--byId', deviceId, '--biometricMatch'], {
    logPath: resolve(
      artifactRoot,
      'ios-notification-system-lock-biometric-response.log',
    ),
  });
}

async function openExplicitIosNotificationIfNeeded(
  deviceId: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  // Give the original tap a fixed opportunity to launch PSD EOC before any
  // explicit-state decision. Each pinned-Maestro hierarchy starts a fresh JVM
  // and can take several seconds, so valid sample collection has its own
  // bounded window rather than pretending three samples fit in this grace.
  await Bun.sleep(IOS_NOTIFICATION_FIRST_RESPONSE_TIMEOUT_MS);
  const samplingDeadline = Date.now() + IOS_NOTIFICATION_RESPONSE_TIMEOUT_MS;
  let hierarchy = '';
  const responseHierarchies: string[] = [];
  let beforeRevealHierarchy = '';
  while (Date.now() < samplingDeadline) {
    hierarchy = await platformHierarchy('ios', deviceId);
    responseHierarchies.push(hierarchy);
    const decision =
      decideMobileE2EIosNotificationResponse(responseHierarchies);
    if (decision === 'response-started') return;
    if (decision === 'refuse-explicit-open') break;
    if (decision === 'open-explicit-notification') {
      beforeRevealHierarchy = hierarchy;
      break;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  if (beforeRevealHierarchy.length === 0) {
    await writeFile(
      resolve(artifactRoot, 'notification-explicit-ios-unsafe-hierarchy.txt'),
      hierarchy,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    throw new Error(
      'The synthetic iOS notification did not settle into one valid explicit-card state; an Open action was refused.',
    );
  }

  // A pristine simulator stacks the synthetic card with Apple's first-run
  // notification. iOS 26 expands that stack on the first exact-title tap but
  // can then deliberately refuse a default-action tap. Three stable Cover
  // Sheet samples provide the exact, unstacked card bounds. One element-
  // scoped right swipe runs by itself; only a second set of stable hierarchies
  // measuring a >=44-point revealed strip can admit one Open tap. No tap is
  // retried.
  await writeFile(
    resolve(artifactRoot, 'notification-before-reveal-ios-hierarchy.txt'),
    beforeRevealHierarchy,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  await runMaestroFlow(
    deviceId,
    'notification-event-room-ios-system-reveal-open',
    artifactRoot,
    environment,
  );

  const revealedDeadline = Date.now() + IOS_NOTIFICATION_RESPONSE_TIMEOUT_MS;
  const revealedHierarchies: string[] = [];
  let openActionTapPoint: string | null = null;
  while (Date.now() < revealedDeadline) {
    hierarchy = await platformHierarchy('ios', deviceId);
    revealedHierarchies.push(hierarchy);
    const result = decideMobileE2EIosRevealedOpenAction(
      beforeRevealHierarchy,
      revealedHierarchies,
    );
    if (result.decision === 'response-started') return;
    if (result.decision === 'refuse-revealed-open') break;
    if (result.decision === 'tap-revealed-open') {
      openActionTapPoint = result.tapPoint;
      break;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  if (openActionTapPoint === null) {
    await writeFile(
      resolve(artifactRoot, 'notification-revealed-ios-unsafe-hierarchy.txt'),
      hierarchy,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    throw new Error(
      'The exact synthetic iOS notification did not expose one stable measured Open action; a tap was refused.',
    );
  }
  await writeFile(
    resolve(artifactRoot, 'notification-revealed-ios-hierarchy.txt'),
    hierarchy,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const actionTapStartedAt = Date.now();
  await runMaestroFlow(
    deviceId,
    'notification-event-room-ios-system-tap-open',
    artifactRoot,
    Object.freeze({
      ...environment,
      IOS_NOTIFICATION_OPEN_POINT: openActionTapPoint,
    }),
  );

  const actionLogDeadline = Date.now() + IOS_NOTIFICATION_ACTION_LOG_TIMEOUT_MS;
  let actionLog = '';
  while (Date.now() < actionLogDeadline) {
    const elapsedSeconds = Math.ceil((Date.now() - actionTapStartedAt) / 1_000);
    actionLog = await iosNotificationActionLogsSince(
      deviceId,
      Math.min(120, Math.max(2, elapsedSeconds + 2)),
    );
    if (mobileE2EIosNotificationActionLogEvidence(actionLog).valid) break;
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  const actionEvidence = mobileE2EIosNotificationActionLogEvidence(actionLog);
  await writeFile(
    resolve(
      artifactRoot,
      actionEvidence.valid
        ? 'notification-default-action-ios.log'
        : 'notification-default-action-ios-failure.log',
    ),
    actionLog,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  if (!actionEvidence.valid) {
    throw new Error(
      'SpringBoard did not prove one same-request default notification action after the measured Open tap.',
    );
  }
}

async function injectAndroidNotification(
  serial: string,
  paths: MobileE2ERunnerPaths,
  artifactRoot: string,
  manifest: MobileRuntimeManifest,
): Promise<void> {
  await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'am',
    'force-stop',
    MOBILE_E2E_APPLICATION_ID,
  ]);
  await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'input',
    'keyevent',
    'KEYCODE_HOME',
  ]);
  const stoppedProcess = await runCommand(
    ['adb', '-s', serial, 'shell', 'pidof', MOBILE_E2E_APPLICATION_ID],
    {
      allowFailure: true,
      quiet: true,
      logPath: resolve(
        artifactRoot,
        'android-notification-stopped-process.log',
      ),
    },
  );
  if (stoppedProcess.stdout.trim().length > 0) {
    throw new Error(
      'PSD EOC was still running before Android background notification injection.',
    );
  }

  await runCommand(
    [
      resolve(paths.copiedMobile, 'android/gradlew'),
      '--no-daemon',
      '--stacktrace',
      '--init-script',
      resolve(paths.copiedMobile, androidInitScriptRelativePath),
      ...mobileE2EAndroidInstrumentationArguments(manifest),
      'app:connectedDebugAndroidTest',
    ],
    {
      cwd: resolve(paths.copiedMobile, 'android'),
      environment: {
        ...definedProcessEnvironment(),
        ANDROID_SERIAL: serial,
        PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
      },
      timeoutMilliseconds: NATIVE_BUILD_TIMEOUT_MS,
      logPath: resolve(artifactRoot, 'android-provider-free-injection.log'),
    },
  );
  const activityState = await runCommand(
    ['adb', '-s', serial, 'shell', 'dumpsys', 'activity', 'activities'],
    {
      quiet: true,
      logPath: resolve(
        artifactRoot,
        'android-notification-background-activity.log',
      ),
    },
  );
  if (isMobileE2EAndroidApplicationForeground(activityState.stdout)) {
    throw new Error(
      'PSD EOC entered the foreground during Android notification injection.',
    );
  }
  await runCommand([
    'adb',
    '-s',
    serial,
    'shell',
    'cmd',
    'statusbar',
    'expand-notifications',
  ]);
}

async function writeSafetyEvidence(
  artifacts: MobileE2EArtifactPaths,
  platform: MobileE2EPlatform,
  manifest: MobileRuntimeManifest,
): Promise<void> {
  const evidence: RunnerEvidence = Object.freeze({
    issue: 32,
    platform,
    runId: manifest.runId,
    classification: 'drill',
    templateMode: 'drill',
    rosterPopulation: 'synthetic',
    providers: 'mocked',
    pushRegistration: 'disabled',
    eventId: manifest.event.id,
    routeEvidence: manifest.event.routeEvidence,
    status: 'planned',
    plannedJourneys: [
      'three-tap-synthetic-drill-start',
      'loopback-oidc-enrollment',
      'provider-free-notification-response',
      'append-only-text-and-human-all-clear',
    ] as const,
  });
  await writeFile(
    resolve(artifacts.root, 'safety-manifest.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function runPlatformSuite(
  platform: MobileE2EPlatform,
  runId: string,
  paths: MobileE2ERunnerPaths,
  artifacts: MobileE2EArtifactPaths,
  manifest: MobileRuntimeManifest,
  ports: Readonly<{
    fixtureMetro: number;
    normalMetro: number;
    app: number;
    idp: number;
  }>,
  cancellation: MobileE2ECancellation,
): Promise<() => Promise<void>> {
  cancellation.throwIfRequested();
  await prebuildNativeProject(platform, paths, artifacts.root);
  const maestroEnvironment = mobileE2EMaestroEnvironment(manifest);
  let fixtureMetro: ManagedProcess | undefined;
  let normalMetro: ManagedProcess | undefined;
  let iosDevice: IosDevice | undefined;
  let applesimutils: string | undefined;
  let androidSerial: string | undefined;
  let androidCredentialConfigured = false;
  let androidPackagesWereAbsent = false;
  const androidReversePorts = new Set<number>();
  try {
    if (platform === 'ios') {
      await runCommand(['maestro', '--version'], {
        logPath: resolve(artifacts.root, 'maestro-version.log'),
      });
      applesimutils = await requireExecutable(
        applesimutilsPath(),
        "Maestro's pinned applesimutils",
      );
      iosDevice = await createIosDevice(runId, artifacts.root);
      await runCommand([
        applesimutils,
        '--byId',
        iosDevice.udid,
        '--biometricEnrollment',
        'YES',
      ]);
      const appPath = await buildIosApp(paths, artifacts.root, iosDevice);
      cancellation.throwIfRequested();

      fixtureMetro = startMetro(
        paths,
        artifacts.root,
        ports.fixtureMetro,
        'fixture',
        mobileE2EFixtureMetroEnvironment(definedProcessEnvironment()),
      );
      await awaitMetro(ports.fixtureMetro, fixtureMetro);
      await installAndOpenIosBundle(
        iosDevice,
        appPath,
        ports.fixtureMetro,
        'Unlock PSD EOC',
        artifacts.root,
      );
      await runLaunchAuthentication(
        platform,
        iosDevice.udid,
        'start-synthetic-drill-ios',
        artifacts.root,
        maestroEnvironment,
        applesimutils,
      );
      cancellation.throwIfRequested();
      await stopManagedProcess(fixtureMetro);
      fixtureMetro = undefined;

      normalMetro = startMetro(
        paths,
        artifacts.root,
        ports.normalMetro,
        'normal',
        mobileE2ENormalMetroEnvironment(definedProcessEnvironment(), manifest),
      );
      await awaitMetro(ports.normalMetro, normalMetro);
      await resetIosForNormalApp(
        iosDevice,
        appPath,
        ports.normalMetro,
        applesimutils,
        artifacts.root,
      );
      await awaitIosFreshEnrollmentReady(
        iosDevice.udid,
        artifacts.root,
        applesimutils,
      );
      await runAuthenticationSplit(
        platform,
        iosDevice.udid,
        'enroll-loopback-oidc-ios',
        artifacts.root,
        maestroEnvironment,
        applesimutils,
      );
      cancellation.throwIfRequested();
      await runMaestroFlow(
        iosDevice.udid,
        'notification-event-room-ios-system-lock',
        artifacts.root,
        maestroEnvironment,
      );
      await injectIosNotification(iosDevice, paths, manifest);
      await awaitIosNotificationOnLockedScreen(iosDevice.udid, artifacts.root);
      await satisfyIosSystemLockAuthentication(
        iosDevice.udid,
        applesimutils,
        artifacts.root,
      );
      await runMaestroFlow(
        iosDevice.udid,
        'notification-event-room-ios-system-open',
        artifacts.root,
        maestroEnvironment,
      );
      await openExplicitIosNotificationIfNeeded(
        iosDevice.udid,
        artifacts.root,
        maestroEnvironment,
      );
      await runLaunchAuthentication(
        platform,
        iosDevice.udid,
        'notification-event-room-ios',
        artifacts.root,
        maestroEnvironment,
        applesimutils,
      );
      cancellation.throwIfRequested();
      await holdEventRoomForOperatorScreenshot(artifacts.root);
      await runMaestroFlow(
        iosDevice.udid,
        'event-room-lifecycle',
        artifacts.root,
        maestroEnvironment,
      );
    } else {
      androidSerial = process.env.ANDROID_SERIAL ?? '';
      await ensureAndroidDevice(androidSerial);
      androidPackagesWereAbsent = true;
      // Claim cleanup before the mutating command so a lost adb response
      // cannot leave the suite's synthetic PIN behind on the emulator.
      androidCredentialConfigured = true;
      await configureAndroidCredential(androidSerial);
      const apkPath = await buildAndroidApp(paths, artifacts.root);
      cancellation.throwIfRequested();

      fixtureMetro = startMetro(
        paths,
        artifacts.root,
        ports.fixtureMetro,
        'fixture',
        mobileE2EFixtureMetroEnvironment(definedProcessEnvironment()),
      );
      await awaitMetro(ports.fixtureMetro, fixtureMetro);
      await installAndOpenAndroidBundle(
        androidSerial,
        apkPath,
        ports.fixtureMetro,
        [],
        androidReversePorts,
      );
      await runLaunchAuthentication(
        platform,
        androidSerial,
        'start-synthetic-drill-android',
        artifacts.root,
        maestroEnvironment,
      );
      cancellation.throwIfRequested();
      await stopManagedProcess(fixtureMetro);
      fixtureMetro = undefined;

      normalMetro = startMetro(
        paths,
        artifacts.root,
        ports.normalMetro,
        'normal',
        mobileE2ENormalMetroEnvironment(definedProcessEnvironment(), manifest),
      );
      await awaitMetro(ports.normalMetro, normalMetro);
      await installAndOpenAndroidBundle(
        androidSerial,
        apkPath,
        ports.normalMetro,
        [ports.app, ports.idp],
        androidReversePorts,
      );
      await awaitApplicationReady(
        platform,
        androidSerial,
        'Sign in to PSD EOC',
      );
      await runAuthenticationSplit(
        platform,
        androidSerial,
        'enroll-loopback-oidc-android',
        artifacts.root,
        maestroEnvironment,
      );
      cancellation.throwIfRequested();
      await injectAndroidNotification(
        androidSerial,
        paths,
        artifacts.root,
        manifest,
      );
      await runAuthenticationSplit(
        platform,
        androidSerial,
        'notification-event-room-android',
        artifacts.root,
        maestroEnvironment,
      );
      cancellation.throwIfRequested();
      await holdEventRoomForOperatorScreenshot(artifacts.root);
      await runMaestroFlow(
        androidSerial,
        'event-room-lifecycle',
        artifacts.root,
        maestroEnvironment,
      );
    }
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (fixtureMetro !== undefined) {
      await stopManagedProcess(fixtureMetro).catch((cleanupError: unknown) =>
        cleanupFailures.push(cleanupError),
      );
    }
    if (normalMetro !== undefined) {
      await stopManagedProcess(normalMetro).catch((cleanupError: unknown) =>
        cleanupFailures.push(cleanupError),
      );
    }
    if (iosDevice !== undefined) {
      await deleteIosDevice(iosDevice).catch((cleanupError: unknown) =>
        cleanupFailures.push(cleanupError),
      );
    }
    if (androidSerial !== undefined && /^emulator-\d+$/u.test(androidSerial)) {
      await cleanupAndroidState(
        androidSerial,
        androidReversePorts,
        androidCredentialConfigured,
        androidPackagesWereAbsent,
      ).catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Mobile platform suite and cleanup failed.',
      );
    }
    throw error;
  }

  return async () => {
    const failures: unknown[] = [];
    if (fixtureMetro !== undefined) {
      await stopManagedProcess(fixtureMetro).catch((error: unknown) =>
        failures.push(error),
      );
    }
    if (normalMetro !== undefined) {
      await stopManagedProcess(normalMetro).catch((error: unknown) =>
        failures.push(error),
      );
    }
    if (iosDevice !== undefined) {
      await deleteIosDevice(iosDevice).catch((error: unknown) =>
        failures.push(error),
      );
    }
    if (androidSerial !== undefined) {
      await cleanupAndroidState(
        androidSerial,
        androidReversePorts,
        androidCredentialConfigured,
        androidPackagesWereAbsent,
      ).catch((error: unknown) => failures.push(error));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Mobile platform cleanup failed.');
    }
  };
}

async function main(): Promise<void> {
  const cancellation = new MobileE2ECancellation();
  try {
    const platform = parseMobileE2EPlatformCli(process.argv.slice(2));
    requireMobileE2EEnvironment();
    const artifactBase = process.env.PSD_EOC_MOBILE_E2E_ARTIFACT_DIR;
    if (artifactBase === undefined || artifactBase.length === 0) {
      throw new Error('PSD_EOC_MOBILE_E2E_ARTIFACT_DIR is required.');
    }
    const runId = createMobileE2ERunId();
    const paths = await acquireMobileE2ERunnerRoot(runId);
    let artifacts: MobileE2EArtifactPaths;
    try {
      artifacts = await acquireMobileE2EArtifactDirectory(
        artifactBase,
        platform,
        runId,
      );
    } catch (error) {
      try {
        await removeMobileE2ERunnerRoot(runId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Artifact acquisition and runner cleanup failed.',
        );
      }
      throw error;
    }
    let serverRuntime: ManagedProcess | undefined;
    let platformCleanup: (() => Promise<void>) | undefined;
    let failure: unknown;
    try {
      const [app, idp, fixtureMetro, normalMetro] =
        await reserveDistinctPorts(4);
      if (
        app === undefined ||
        idp === undefined ||
        fixtureMetro === undefined ||
        normalMetro === undefined
      ) {
        throw new Error('Could not reserve the required loopback ports.');
      }
      await copyMobileWorkspace(paths);
      serverRuntime = startManagedProcess(
        [
          process.execPath,
          mobileRuntimeEntrypoint,
          'start',
          '--run-id',
          runId,
          '--manifest',
          paths.manifestPath,
          '--app-port',
          String(app),
          '--idp-port',
          String(idp),
        ],
        {
          cwd: repositoryRoot,
          environment: {
            ...definedProcessEnvironment(),
            PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
          },
          logPath: resolve(artifacts.root, 'server-runtime.log'),
        },
      );
      await awaitFile(paths.manifestPath, RUNTIME_TIMEOUT_MS, serverRuntime);
      if (serverRuntime.child.exitCode !== null) {
        throw new Error(
          `The mobile runtime exited before the platform suite (${serverRuntime.child.exitCode}).`,
        );
      }
      const manifest = requireMatchingMobileE2ERunIds(
        runId,
        parseMobileE2EManifestText(await readFile(paths.manifestPath, 'utf8')),
      );
      await writeSafetyEvidence(artifacts, platform, manifest);
      platformCleanup = await runPlatformSuite(
        platform,
        runId,
        paths,
        artifacts,
        manifest,
        { app, idp, fixtureMetro, normalMetro },
        cancellation,
      );
    } catch (error) {
      failure = error;
    }

    const cleanupFailures: unknown[] = [];
    if (platformCleanup !== undefined) {
      await platformCleanup().catch((error: unknown) =>
        cleanupFailures.push(error),
      );
    }
    if (serverRuntime !== undefined) {
      await stopManagedProcess(serverRuntime).catch((error: unknown) =>
        cleanupFailures.push(error),
      );
    }
    await removeMobileE2ERunnerRoot(runId).catch((error: unknown) =>
      cleanupFailures.push(error),
    );
    if (failure !== undefined || cleanupFailures.length > 0) {
      const failures =
        failure === undefined ? cleanupFailures : [failure, ...cleanupFailures];
      throw new AggregateError(
        failures,
        'Issue #32 mobile E2E failed and cleaned up fail-closed.',
      );
    }
    await writeFile(
      resolve(artifacts.root, 'complete.txt'),
      `issue=32\nplatform=${platform}\nclassification=drill\nroster=synthetic\nproviders=mocked\nstatus=passed\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } finally {
    cancellation.dispose();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(redactedProcessOutput(errorSummary(error)));
    process.exitCode = 1;
  }
}
