import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
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
  assertMobileE2EPostAuthenticationWarmupRejection,
  createMobileE2ERunId,
  mobileE2EAndroidArchitectureArguments,
  mobileE2EAndroidBuildArguments,
  mobileE2ECompletionMarkerFilename,
  mobileE2EAndroidInstrumentationArguments,
  mobileE2EDevClientUrl,
  mobileE2EEnrollmentWarmupRequest,
  mobileE2EPostAuthenticationWarmupRequests,
  mobileE2EExpoStartArguments,
  mobileE2EFixtureMetroEnvironment,
  mobileE2EIosBuildArguments,
  mobileE2EIosDeviceAuthenticationScreenshotEvidence,
  mobileE2EIosDirectLaunchArguments,
  mobileE2EIsolatedExpoConfig,
  mobileE2EIosSimulatorPushPayload,
  mobileE2EIosNotificationActionLogEvidence,
  mobileE2EIosNotificationOpenScreenshotTapPoint,
  mobileE2EIosNotificationScreenshotEvidence,
  mobileE2ELoopbackMetroEnvironment,
  mobileE2EMaestroDriverPortArguments,
  mobileE2EMaestroDriverReuseArguments,
  mobileE2EOwnedIosMaestroDriverPids,
  mobileE2EMaestroEnvironment,
  mobileE2ENormalMetroEnvironment,
  isMobileE2EAndroidApplicationForeground,
  isMobileE2EAndroidDeviceAuthenticationPrompt,
  isMobileE2EIosApplicationReady,
  isMobileE2EIosAuthenticationSheetReady,
  isMobileE2EUnlockRetryReady,
  patchMobileE2EIsolatedIssue21Fixture,
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
const ANDROID_APP_BUILD_TIMEOUT_MS = 60 * 60_000;
const RUNTIME_TIMEOUT_MS = 4 * 60_000;
const METRO_TIMEOUT_MS = 4 * 60_000;
const PROCESS_TERMINATION_GRACE_MS = 15_000;
const IOS_DRIVER_RETIREMENT_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 500;
const IOS_NOTIFICATION_SWIPE_ACTION_TIMEOUT_MS = 5_000;
const IOS_NOTIFICATION_ACTION_LOG_TIMEOUT_MS = 30_000;
const IOS_NOTIFICATION_FOREGROUND_BANNER_SETTLE_MS = 8_000;
const IOS_INITIAL_HIERARCHY_TIMEOUT_MS = 90_000;
const IOS_AUTH_RETRY_VISION_INTERVAL_MS = 250;
const MOBILE_ENROLLMENT_WARMUP_TIMEOUT_MS = 30_000;
const IOS_BUNDLE_RELATIVE_PATH =
  'ios/build/Build/Products/Debug-iphonesimulator/PSDEOC.app';
const ANDROID_APK_RELATIVE_PATH =
  'android/app/build/outputs/apk/debug/app-debug.apk';
const IOS_DEVICE_NAME_PREFIX = 'PSD EOC Issue 32';
const ANDROID_DEVICE_PIN = '246832';
const METRO_STATUS = 'packager-status:running';

type BunChild = ReturnType<typeof Bun.spawn>;
const activeChildren = new Set<BunChild>();
const activeLinuxProcessGroups = new Set<number>();
let androidHierarchySequence = 0;

type MobileE2ESpawnOptions = Bun.SpawnOptions.OptionsObject<
  undefined,
  'pipe',
  'pipe'
> & {
  readonly detached?: boolean;
};

interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
  readonly logPath?: string;
  readonly allowFailure?: boolean;
  readonly quiet?: boolean;
  readonly killLinuxProcessTreeOnCompletion?: boolean;
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

interface RunningMaestroFlow {
  readonly process: ManagedProcess;
  readonly flowName: string;
  readonly deadline: number;
}

interface IosDevice {
  readonly udid: string;
  readonly name: string;
}

interface IosMaestroDriverSession {
  currentPort: number;
}

type IosNotificationPurpose = 'route';

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
        for (const processGroupId of activeLinuxProcessGroups) {
          signalLinuxProcessGroup(processGroupId, 'SIGTERM');
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

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ESRCH'
  );
}

function signalLinuxProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

async function waitForLinuxProcessGroupExit(
  processGroupId: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!signalLinuxProcessGroup(processGroupId, 0)) return true;
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  return !signalLinuxProcessGroup(processGroupId, 0);
}

async function terminateLinuxProcessGroup(
  processGroupId: number,
): Promise<void> {
  if (!signalLinuxProcessGroup(processGroupId, 'SIGTERM')) return;
  if (
    await waitForLinuxProcessGroupExit(
      processGroupId,
      PROCESS_TERMINATION_GRACE_MS,
    )
  ) {
    return;
  }
  signalLinuxProcessGroup(processGroupId, 'SIGKILL');
  if (
    !(await waitForLinuxProcessGroupExit(
      processGroupId,
      PROCESS_TERMINATION_GRACE_MS,
    ))
  ) {
    throw new Error('The owned Linux process group did not terminate.');
  }
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

function signalOwnedProcess(
  processId: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(processId, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

async function waitForOwnedProcesses(
  processIds: readonly number[],
  timeoutMilliseconds: number,
): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMilliseconds;
  let remaining = processIds.filter((processId) =>
    signalOwnedProcess(processId, 0),
  );
  while (remaining.length > 0 && Date.now() < deadline) {
    await Bun.sleep(RETRY_INTERVAL_MS);
    remaining = remaining.filter((processId) =>
      signalOwnedProcess(processId, 0),
    );
  }
  return Object.freeze(remaining);
}

async function loopbackPortIsAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveAvailability, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === 'EADDRINUSE') resolveAvailability(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolveAvailability(true);
      });
    });
  });
}

async function retireIosMaestroDriverOwners(
  deviceId: string,
  driverSession: IosMaestroDriverSession,
  artifactRoot: string,
  artifactName: string,
): Promise<void> {
  const previousPort = driverSession.currentPort;
  // Maestro can leave xcodebuild alive after its CLI exits. Target only the
  // exact xctestrun owners bound to this suite-created simulator; a broad kill
  // could interfere with unrelated Xcode work on a shared host.
  const snapshot = await runCommand(['ps', '-ww', '-axo', 'pid=,command='], {
    quiet: true,
    timeoutMilliseconds: 20_000,
  });
  const processIds = mobileE2EOwnedIosMaestroDriverPids(
    snapshot.stdout,
    deviceId,
  );
  for (const processId of processIds) {
    signalOwnedProcess(processId, 'SIGTERM');
  }
  let remaining = await waitForOwnedProcesses(
    processIds,
    PROCESS_TERMINATION_GRACE_MS,
  );
  if (remaining.length > 0) {
    for (const processId of remaining) {
      signalOwnedProcess(processId, 'SIGKILL');
    }
    remaining = await waitForOwnedProcesses(
      remaining,
      PROCESS_TERMINATION_GRACE_MS,
    );
  }
  if (remaining.length > 0) {
    throw new Error('An owned iOS Maestro driver process did not terminate.');
  }

  const runnerTermination = await runCommand(
    [
      'xcrun',
      'simctl',
      'terminate',
      deviceId,
      'dev.mobile.maestro-driver-iosUITests.xctrunner',
    ],
    { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
  );
  if (
    runnerTermination.exitCode !== 0 &&
    !/(?:no such process|not running|found nothing)/iu.test(
      `${runnerTermination.stdout}\n${runnerTermination.stderr}`,
    )
  ) {
    throw new Error('The owned iOS Maestro XCTest runner could not terminate.');
  }

  const deadline = Date.now() + IOS_DRIVER_RETIREMENT_TIMEOUT_MS;
  while (!(await loopbackPortIsAvailable(previousPort))) {
    if (Date.now() >= deadline) {
      throw new Error('The retired iOS Maestro driver port remained occupied.');
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  await writeFile(
    resolve(artifactRoot, `ios-maestro-driver-retirement-${artifactName}.txt`),
    `issue=32\nplatform=ios\nclassification=drill\nroster=synthetic\nproviders=mocked\npreviousPort=${previousPort}\nownerCount=${processIds.length}\nstatus=retired\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
}

async function runCommand(
  command: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const environment = options.environment ?? definedProcessEnvironment();
  const detachedLinuxProcessGroup =
    options.killLinuxProcessTreeOnCompletion === true &&
    process.platform === 'linux';
  const spawnOptions: MobileE2ESpawnOptions = {
    cwd: options.cwd ?? repositoryRoot,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(detachedLinuxProcessGroup ? { detached: true } : {}),
  };
  const child = trackChild(Bun.spawn([...command], spawnOptions));
  const linuxProcessGroupId = detachedLinuxProcessGroup ? child.pid : undefined;
  if (linuxProcessGroupId !== undefined) {
    activeLinuxProcessGroups.add(linuxProcessGroupId);
  }
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
  try {
    if (linuxProcessGroupId !== undefined) {
      // A Gradle wrapper may exit or time out while descendants still own the
      // captured pipes. Retire the exact detached group before collecting the
      // transcript so cleanup and artifact upload remain bounded.
      await terminateLinuxProcessGroup(linuxProcessGroupId);
    } else if (outcome.kind === 'timeout') {
      await terminateProcess(child);
    }
  } finally {
    if (linuxProcessGroupId !== undefined) {
      activeLinuxProcessGroups.delete(linuxProcessGroupId);
    }
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

async function warmMobileEnrollmentStartRoute(
  platform: MobileE2EPlatform,
  manifest: MobileRuntimeManifest,
  artifactRoot: string,
  cancellation: MobileE2ECancellation,
): Promise<void> {
  cancellation.throwIfRequested();
  const warmup = mobileE2EEnrollmentWarmupRequest(manifest);
  let response: Response;
  try {
    response = await fetch(warmup.url, {
      method: warmup.method,
      headers: warmup.headers,
      body: warmup.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(MOBILE_ENROLLMENT_WARMUP_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      'The synthetic mobile OIDC start route did not respond before enrollment.',
    );
  }
  const status = response.status;
  await response.body?.cancel();
  if (status !== warmup.expectedStatus) {
    throw new Error(
      'The synthetic mobile OIDC warmup was not rejected before state creation.',
    );
  }
  cancellation.throwIfRequested();
  await writeFile(
    resolve(artifactRoot, `${platform}-oidc-start-warmup.txt`),
    `issue=32\nplatform=${platform}\nclassification=drill\nroster=synthetic\nproviders=mocked\nroute=mobile-oidc-start\nstatus=validation-rejected\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function warmMobilePostAuthenticationRoutes(
  platform: MobileE2EPlatform,
  manifest: MobileRuntimeManifest,
  artifactRoot: string,
  cancellation: MobileE2ECancellation,
): Promise<void> {
  const completedRoutes: string[] = [];
  for (const warmup of mobileE2EPostAuthenticationWarmupRequests(manifest)) {
    cancellation.throwIfRequested();
    let response: Response;
    try {
      response = await fetch(warmup.url, {
        method: warmup.method,
        headers: warmup.headers,
        ...(warmup.body === undefined ? {} : { body: warmup.body }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(MOBILE_ENROLLMENT_WARMUP_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        `The ${warmup.evidenceRoute} route did not respond during credential-free warmup.`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `The ${warmup.evidenceRoute} route returned a malformed warmup response.`,
      );
    }
    assertMobileE2EPostAuthenticationWarmupRejection(
      warmup,
      response.status,
      payload,
    );
    completedRoutes.push(warmup.evidenceRoute);
  }
  cancellation.throwIfRequested();
  await writeFile(
    resolve(artifactRoot, `${platform}-post-auth-route-warmup.txt`),
    [
      'issue=32',
      `platform=${platform}`,
      'classification=drill',
      'roster=synthetic',
      'providers=mocked',
      'credentials=omitted',
      ...completedRoutes.map((route) => `route=${route}`),
      'status=fail-closed-rejections-verified',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function copyMobileWorkspace(
  paths: MobileE2ERunnerPaths,
  runId: string,
): Promise<void> {
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
  // The current issue-21 development fixture predates two read/cleanup calls
  // now made by the production UI. Add their fail-closed synthetic responses
  // only inside this marker-owned copy; the checkout remains untouched.
  await patchMobileE2EIsolatedIssue21Fixture(runId);
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
      ...mobileE2EAndroidBuildArguments(),
    ],
    {
      cwd: resolve(paths.copiedMobile, 'android'),
      environment: mobileE2EFixtureMetroEnvironment(
        definedProcessEnvironment(),
      ),
      timeoutMilliseconds: ANDROID_APP_BUILD_TIMEOUT_MS,
      logPath: resolve(artifactRoot, 'android-build.log'),
      killLinuxProcessTreeOnCompletion: true,
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
  driverSession: IosMaestroDriverSession,
): Promise<string> {
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
  return launchIosBundleDirectly(
    device,
    metroPort,
    expectedApplicationText,
    artifactRoot,
    driverSession,
  );
}

async function launchIosBundleDirectly(
  device: IosDevice,
  metroPort: number,
  expectedApplicationText: string,
  artifactRoot: string,
  driverSession: IosMaestroDriverSession,
): Promise<string> {
  // Expo Dev Launcher consumes this process argument inside the installed app.
  // Supplying the validated loopback URL directly avoids iOS's external-URL
  // confirmation alert, which XCTest/Maestro cannot inspect on iOS 26.
  await runCommand(
    ['xcrun', ...mobileE2EIosDirectLaunchArguments(device.udid, metroPort)],
    {
      logPath: resolve(artifactRoot, `ios-direct-launch-${metroPort}.log`),
    },
  );
  return awaitIosApplicationReady(
    device.udid,
    expectedApplicationText,
    artifactRoot,
    metroPort,
    driverSession,
  );
}

async function awaitIosApplicationReady(
  deviceId: string,
  expectedText: string,
  artifactRoot: string,
  metroPort: number,
  driverSession: IosMaestroDriverSession,
): Promise<string> {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  let firstPoll = true;
  let lastHierarchy = '';
  let lastHierarchyDiagnostic = 'No hierarchy command completed.\n';
  while (Date.now() < deadline) {
    const remainingMilliseconds = Math.max(1, deadline - Date.now());
    const hierarchyTimeout = Math.min(
      firstPoll ? IOS_INITIAL_HIERARCHY_TIMEOUT_MS : 30_000,
      remainingMilliseconds,
    );
    firstPoll = false;
    const result = await runCommand(
      [
        'maestro',
        '--udid',
        deviceId,
        ...mobileE2EMaestroDriverPortArguments(
          'ios',
          driverSession.currentPort,
        ),
        'hierarchy',
        ...mobileE2EMaestroDriverReuseArguments('ios'),
      ],
      {
        allowFailure: true,
        quiet: true,
        timeoutMilliseconds: hierarchyTimeout,
      },
    );
    lastHierarchy = `${result.stdout}\n${result.stderr}`;
    lastHierarchyDiagnostic = redactedProcessOutput(
      `exit=${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    if (
      result.exitCode === 0 &&
      isMobileE2EIosApplicationReady(lastHierarchy, expectedText)
    ) {
      return lastHierarchy;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  await writeFile(
    resolve(
      artifactRoot,
      `ios-direct-launch-${metroPort}-failure-hierarchy.txt`,
    ),
    lastHierarchyDiagnostic,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  await runCommand(
    [
      'xcrun',
      'simctl',
      'io',
      deviceId,
      'screenshot',
      resolve(
        artifactRoot,
        `ios-direct-launch-${metroPort}-failure-screen.png`,
      ),
    ],
    {
      allowFailure: true,
      logPath: resolve(
        artifactRoot,
        `ios-direct-launch-${metroPort}-failure-screenshot.log`,
      ),
    },
  );
  throw new Error(`ios app did not expose ${expectedText} in time.`);
}

async function warmIosMaestroDriver(
  deviceId: string,
  artifactRoot: string,
): Promise<IosMaestroDriverSession> {
  // Starting XCTest while LocalAuthentication is already presented can cancel
  // the transient secure sheet. Warm the pinned driver against SpringBoard
  // before launching PSD EOC so the launch-auth observation is immediate.
  const driverSession: IosMaestroDriverSession = {
    currentPort: await reserveLoopbackPort(),
  };
  const hierarchy = await runCommand(
    [
      'maestro',
      '--udid',
      deviceId,
      ...mobileE2EMaestroDriverPortArguments('ios', driverSession.currentPort),
      'hierarchy',
      ...mobileE2EMaestroDriverReuseArguments('ios'),
    ],
    {
      environment: {
        ...definedProcessEnvironment(),
        MAESTRO_DRIVER_STARTUP_TIMEOUT: String(RUNTIME_TIMEOUT_MS),
      },
      quiet: true,
      // Hosted XCTest bootstrap has taken longer than 90 seconds. Keep one
      // uninterrupted process for the full bounded runtime window; repeatedly
      // terminating a cold driver prevents it from ever becoming reusable.
      timeoutMilliseconds: RUNTIME_TIMEOUT_MS,
      logPath: resolve(artifactRoot, 'ios-maestro-warmup.log'),
    },
  );
  if (hierarchy.stdout.trim().length === 0) {
    throw new Error('The warmed iOS Maestro hierarchy was empty.');
  }
  return driverSession;
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
  iosDriverSession?: IosMaestroDriverSession,
): Promise<string> {
  if (platform === 'ios') {
    if (iosDriverSession === undefined) {
      throw new Error('The tracked iOS Maestro driver session is missing.');
    }
    const result = await runCommand(
      [
        'maestro',
        '--udid',
        deviceId,
        ...mobileE2EMaestroDriverPortArguments(
          'ios',
          iosDriverSession.currentPort,
        ),
        'hierarchy',
        ...mobileE2EMaestroDriverReuseArguments('ios'),
      ],
      { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
    );
    return `${result.stdout}\n${result.stderr}`;
  }
  androidHierarchySequence += 1;
  if (!Number.isSafeInteger(androidHierarchySequence)) {
    throw new Error('The Android hierarchy sequence is exhausted.');
  }
  const remotePath = `/sdcard/psd-eoc-issue32-window-${androidHierarchySequence}.xml`;
  const dump = await runCommand(
    ['adb', '-s', deviceId, 'shell', 'uiautomator', 'dump', remotePath],
    { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
  );
  if (dump.exitCode !== 0) return '';
  const result = await runCommand(
    ['adb', '-s', deviceId, 'shell', 'cat', remotePath],
    { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
  );
  return result.exitCode === 0 ? result.stdout : '';
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

async function respondToRetriedIosDeviceAuthentication(
  deviceId: string,
  artifactRoot: string,
  flowName: string,
  environment: Readonly<Record<string, string>>,
  applesimutils: string,
  iosDriverSession: IosMaestroDriverSession,
): Promise<void> {
  const retryFlow = await startMaestroFlow(
    'ios',
    deviceId,
    'retry-locked-session-ios-pre-auth',
    artifactRoot,
    environment,
    iosDriverSession,
  );
  const evidenceDeadline = Math.min(
    retryFlow.deadline,
    // Each iOS flow owns a fresh XCTest runner. Hosted startup has exceeded
    // one minute, so keep the proof window aligned with the same bounded
    // runtime budget used to start that runner instead of interrupting it.
    Date.now() + RUNTIME_TIMEOUT_MS,
  );
  let attempt = 0;
  try {
    while (Date.now() < evidenceDeadline) {
      if (retryFlow.process.child.exitCode !== null) {
        await awaitMaestroFlow(retryFlow);
        throw new Error(
          'The exact iOS authentication retry ended before Face ID evidence.',
        );
      }
      await Bun.sleep(IOS_AUTH_RETRY_VISION_INTERVAL_MS);
      if (Date.now() >= evidenceDeadline) break;
      attempt += 1;
      const label = `device-auth-${flowName}-retry-${String(attempt).padStart(2, '0')}`;
      const analysis = await analyzeIosNotificationScreenshot(
        deviceId,
        artifactRoot,
        label,
        evidenceDeadline,
      );
      const evidence =
        mobileE2EIosDeviceAuthenticationScreenshotEvidence(analysis);
      if (evidence.status === 'not-ready') continue;
      if (Date.now() >= evidenceDeadline) {
        throw new Error(
          'The proven iOS Face ID evidence expired before response.',
        );
      }
      if (retryFlow.process.child.exitCode !== null) {
        await awaitMaestroFlow(retryFlow);
        throw new Error(
          'The exact iOS authentication retry ended before its proven Face ID response.',
        );
      }
      await writeFile(
        resolve(artifactRoot, `device-auth-${flowName}-retry-evidence.txt`),
        `issue=32\nplatform=ios\nclassification=drill\nroster=synthetic\nproviders=mocked\nstate=face-id-prompt-observed\nsource=apple-vision\nattempt=${attempt}\nscreenshot=${label}.png\nvision=${label}-vision.json\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      if (retryFlow.process.child.exitCode !== null) {
        await awaitMaestroFlow(retryFlow);
        throw new Error(
          'The exact iOS authentication retry ended after its proven Face ID evidence.',
        );
      }
      const responseTimeout = evidenceDeadline - Date.now();
      if (responseTimeout <= 0) {
        throw new Error(
          'The proven iOS Face ID evidence expired before response.',
        );
      }
      await runCommand(
        [applesimutils, '--byId', deviceId, '--biometricMatch'],
        {
          logPath: resolve(
            artifactRoot,
            `device-auth-${flowName}-retry-response.log`,
          ),
          timeoutMilliseconds: responseTimeout,
        },
      );
      await awaitMaestroFlow(retryFlow, evidenceDeadline);
      return;
    }
    throw new Error(
      'The exact iOS authentication retry did not expose proven Face ID evidence.',
    );
  } catch (error) {
    if (retryFlow.process.child.exitCode === null) {
      await terminateProcess(retryFlow.process.child);
    }
    await retryFlow.process.completion;
    throw error;
  }
}

async function respondToDeviceAuthentication(
  platform: MobileE2EPlatform,
  deviceId: string,
  artifactRoot: string,
  flowName: string,
  environment: Readonly<Record<string, string>>,
  applesimutils: string | undefined,
  iosDriverSession?: IosMaestroDriverSession,
  initialIosHierarchy?: string,
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
    if (iosDriverSession === undefined) {
      throw new Error('The tracked iOS Maestro driver session is missing.');
    }
    // Metro can still be compiling after the direct development-client launch.
    // Wait for the exact secure-sheet accessibility token retained by pinned
    // Maestro 2.7. A hierarchy returned by that same launch readiness probe is
    // current evidence, not a cached response. If XCTest cold-start canceled
    // the first prompt, one exact app-owned retry is allowed; the retry flow
    // cannot act on a generic error or coordinates. The following authenticated
    // post-state remains the executable pass gate.
    const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
    let readyHierarchy: string | undefined;
    let pendingHierarchy = initialIosHierarchy;
    let lastHierarchy = initialIosHierarchy ?? '';
    let retryAttempted = false;
    while (Date.now() < deadline) {
      const hierarchy =
        pendingHierarchy ??
        (await platformHierarchy('ios', deviceId, iosDriverSession));
      pendingHierarchy = undefined;
      if (hierarchy.trim().length > 0) lastHierarchy = hierarchy;
      if (isMobileE2EIosAuthenticationSheetReady(hierarchy)) {
        readyHierarchy = hierarchy;
        break;
      }
      if (
        flowName === 'start-synthetic-drill-ios' &&
        !retryAttempted &&
        isMobileE2EUnlockRetryReady(hierarchy)
      ) {
        retryAttempted = true;
        await respondToRetriedIosDeviceAuthentication(
          deviceId,
          artifactRoot,
          flowName,
          environment,
          applesimutils,
          iosDriverSession,
        );
        return;
      }
      await Bun.sleep(RETRY_INTERVAL_MS);
    }
    if (readyHierarchy === undefined) {
      await writeFile(
        resolve(artifactRoot, `device-auth-${flowName}-failure-hierarchy.txt`),
        lastHierarchy.length > 0
          ? lastHierarchy
          : 'No non-empty iOS hierarchy was observed.\n',
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
  let lastHierarchy = '';
  let retryAttempted = false;
  while (Date.now() < deadline) {
    const hierarchy = await platformHierarchy(platform, deviceId);
    if (hierarchy.trim().length > 0) lastHierarchy = hierarchy;
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
    if (
      flowName === 'start-synthetic-drill-android' &&
      !retryAttempted &&
      isMobileE2EUnlockRetryReady(hierarchy)
    ) {
      retryAttempted = true;
      const retryFlow = await startMaestroFlow(
        'android',
        deviceId,
        'retry-locked-session-android-pre-auth',
        artifactRoot,
        environment,
      );
      await awaitMaestroFlow(retryFlow, deadline);
      continue;
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
  await writeFile(
    resolve(artifactRoot, `device-auth-${flowName}-failure-hierarchy.txt`),
    lastHierarchy.length > 0
      ? lastHierarchy
      : 'No non-empty Android hierarchy was observed.\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const remoteScreenshot = `/sdcard/psd-eoc-issue32-auth-failure-${Date.now()}.png`;
  const localScreenshot = resolve(
    artifactRoot,
    `device-auth-${flowName}-failure-prompt.png`,
  );
  const capture = await runCommand(
    ['adb', '-s', deviceId, 'shell', 'screencap', '-p', remoteScreenshot],
    {
      allowFailure: true,
      quiet: true,
      logPath: resolve(
        artifactRoot,
        `device-auth-${flowName}-failure-screenshot-capture.log`,
      ),
    },
  );
  let screenshotIsValid = false;
  if (capture.exitCode === 0) {
    const pull = await runCommand(
      ['adb', '-s', deviceId, 'pull', remoteScreenshot, localScreenshot],
      {
        allowFailure: true,
        quiet: true,
        logPath: resolve(
          artifactRoot,
          `device-auth-${flowName}-failure-screenshot-pull.log`,
        ),
      },
    );
    if (pull.exitCode === 0) {
      const screenshot = await lstat(localScreenshot).catch(() => undefined);
      screenshotIsValid =
        screenshot !== undefined &&
        screenshot.isFile() &&
        !screenshot.isSymbolicLink() &&
        screenshot.size > 0;
    }
  }
  if (!screenshotIsValid) {
    await unlink(localScreenshot).catch(() => undefined);
  }
  await runCommand(
    ['adb', '-s', deviceId, 'shell', 'rm', '-f', remoteScreenshot],
    { allowFailure: true, quiet: true, timeoutMilliseconds: 20_000 },
  );
  throw new Error(
    'The exact PSD EOC device-authentication prompt was not observed.',
  );
}

function maestroArguments(
  platform: MobileE2EPlatform,
  deviceId: string,
  flowPath: string,
  artifactDirectory: string,
  environment: Readonly<Record<string, string>>,
  iosDriverPort?: number,
): readonly string[] {
  const arguments_: string[] = [
    'maestro',
    'test',
    ...mobileE2EMaestroDriverReuseArguments(platform),
    ...mobileE2EMaestroDriverPortArguments(platform, iosDriverPort),
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

async function startMaestroFlow(
  platform: MobileE2EPlatform,
  deviceId: string,
  flowName: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
  iosDriverSession?: IosMaestroDriverSession,
  artifactName: string = flowName,
  explicitFlowPath?: string,
): Promise<RunningMaestroFlow> {
  if (!/^[a-z0-9-]+$/u.test(artifactName)) {
    throw new Error('The Maestro artifact name is invalid.');
  }
  let iosDriverPort: number | undefined;
  if (platform === 'ios') {
    if (iosDriverSession === undefined) {
      throw new Error('The tracked iOS Maestro driver session is missing.');
    }
    await retireIosMaestroDriverOwners(
      deviceId,
      iosDriverSession,
      artifactRoot,
      artifactName,
    );
    // Maestro 2.7 refuses to start `test` on an occupied explicit port. Give
    // each flow a fresh port, then retain that exact runner for any hierarchy
    // observation that follows the flow (especially secure-sheet evidence).
    iosDriverPort = await reserveLoopbackPort();
    iosDriverSession.currentPort = iosDriverPort;
  }
  const artifactDirectory = resolve(artifactRoot, `maestro-${artifactName}`);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const flowPath = explicitFlowPath ?? resolve(flowRoot, `${flowName}.yaml`);
  const command = maestroArguments(
    platform,
    deviceId,
    flowPath,
    artifactDirectory,
    environment,
    iosDriverPort,
  );
  const process_ = startManagedProcess(command, {
    cwd: flowRoot,
    environment: {
      ...definedProcessEnvironment(),
      MAESTRO_CLI_NO_ANALYTICS: '1',
      MAESTRO_DRIVER_STARTUP_TIMEOUT: String(RUNTIME_TIMEOUT_MS),
    },
    logPath: resolve(artifactDirectory, 'maestro.log'),
  });
  return Object.freeze({
    process: process_,
    flowName,
    deadline: Date.now() + COMMAND_TIMEOUT_MS,
  });
}

async function awaitMaestroFlow(
  flow: RunningMaestroFlow,
  upperDeadline: number = flow.deadline,
): Promise<void> {
  if (!Number.isSafeInteger(upperDeadline)) {
    throw new Error('The Maestro flow deadline is invalid.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remainingMilliseconds = Math.max(
    0,
    Math.min(flow.deadline, upperDeadline) - Date.now(),
  );
  const outcome = await Promise.race([
    flow.process.completion.then((exitCode) => ({
      kind: 'exit' as const,
      exitCode,
    })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolveTimeout) => {
      timer = setTimeout(
        () => resolveTimeout({ kind: 'timeout' }),
        remainingMilliseconds,
      );
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind !== 'exit') await terminateProcess(flow.process.child);
  const exitCode = await flow.process.completion;
  if (outcome.kind === 'timeout' || exitCode !== 0) {
    throw new Error(
      outcome.kind === 'timeout'
        ? `Maestro flow timed out: ${flow.flowName}`
        : `Maestro flow failed (${exitCode}): ${flow.flowName}`,
    );
  }
}

async function runMaestroFlow(
  platform: MobileE2EPlatform,
  deviceId: string,
  flowName: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
  iosDriverSession?: IosMaestroDriverSession,
  artifactName: string = flowName,
  explicitFlowPath?: string,
): Promise<void> {
  const flow = await startMaestroFlow(
    platform,
    deviceId,
    flowName,
    artifactRoot,
    environment,
    iosDriverSession,
    artifactName,
    explicitFlowPath,
  );
  await awaitMaestroFlow(flow);
}

async function runAuthenticationSplit(
  platform: MobileE2EPlatform,
  deviceId: string,
  flowName: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
  applesimutils?: string,
  iosDriverSession?: IosMaestroDriverSession,
): Promise<void> {
  await runMaestroFlow(
    platform,
    deviceId,
    `${flowName}-pre-auth`,
    artifactRoot,
    environment,
    iosDriverSession,
  );
  await respondToDeviceAuthentication(
    platform,
    deviceId,
    artifactRoot,
    flowName,
    environment,
    applesimutils,
    iosDriverSession,
  );
  if (
    platform === 'android' &&
    flowName === 'notification-event-room-android'
  ) {
    // The first exact DRILL notification exists only to cross the protected
    // unlock boundary. Reopen SystemUI after that authentication so the
    // post-auth flow can tap the independently retained route notification.
    await runCommand([
      'adb',
      '-s',
      deviceId,
      'shell',
      'cmd',
      'statusbar',
      'expand-notifications',
    ]);
  }
  await runMaestroFlow(
    platform,
    deviceId,
    `${flowName}-post-auth`,
    artifactRoot,
    environment,
    iosDriverSession,
  );
}

async function runLaunchAuthentication(
  platform: MobileE2EPlatform,
  deviceId: string,
  flowName: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
  applesimutils?: string,
  iosDriverSession?: IosMaestroDriverSession,
  initialIosHierarchy?: string,
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
    environment,
    applesimutils,
    iosDriverSession,
    initialIosHierarchy,
  );
  await runMaestroFlow(
    platform,
    deviceId,
    `${flowName}-post-auth`,
    artifactRoot,
    environment,
    iosDriverSession,
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
  driverSession: IosMaestroDriverSession,
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
    driverSession,
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
  await launchIosBundleDirectly(
    device,
    normalMetroPort,
    'Sign in to PSD EOC',
    artifactRoot,
    driverSession,
  );
}

async function awaitIosFreshEnrollmentReady(
  deviceId: string,
  artifactRoot: string,
  applesimutils: string,
  environment: Readonly<Record<string, string>>,
  driverSession: IosMaestroDriverSession,
): Promise<void> {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  let stableSignInSamples = 0;
  let recoveredFixtureVault = false;
  while (Date.now() < deadline) {
    const hierarchy = await platformHierarchy('ios', deviceId, driverSession);
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
        environment,
        applesimutils,
        driverSession,
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
  // Inject only after the normal app's independently authenticated protected
  // shell is stable. The foreground handler places this provider-free alert
  // in Notification Center, where Vision proves the exact DRILL card before a
  // single system action exercises the production response listener.
  await runCommand([
    'xcrun',
    'simctl',
    'push',
    device.udid,
    MOBILE_E2E_APPLICATION_ID,
    payloadPath,
  ]);
}

async function analyzeIosNotificationScreenshot(
  deviceId: string,
  artifactRoot: string,
  label: string,
  deadline?: number,
): Promise<unknown> {
  if (!/^[a-z0-9-]+$/u.test(label)) {
    throw new Error('The iOS notification screenshot label is invalid.');
  }
  const remainingTimeout = (): number | undefined => {
    if (deadline === undefined) return undefined;
    if (!Number.isSafeInteger(deadline)) {
      throw new Error('The iOS screenshot analysis deadline is invalid.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('The iOS screenshot analysis deadline expired.');
    }
    return remaining;
  };
  const screenshotPath = resolve(artifactRoot, `${label}.png`);
  const screenshotTimeout = remainingTimeout();
  await runCommand(
    ['xcrun', 'simctl', 'io', deviceId, 'screenshot', screenshotPath],
    {
      logPath: resolve(artifactRoot, `${label}-screenshot.log`),
      ...(screenshotTimeout === undefined
        ? {}
        : { timeoutMilliseconds: screenshotTimeout }),
    },
  );
  const screenshot = await lstat(screenshotPath);
  if (
    !screenshot.isFile() ||
    screenshot.isSymbolicLink() ||
    screenshot.size === 0
  ) {
    throw new Error('The iOS notification screenshot is invalid.');
  }
  const analysisTimeout = remainingTimeout();
  const analysis = await runCommand(
    [
      'xcrun',
      'swift',
      resolve(mobileRoot, 'e2e/ios/notification-ocr.swift'),
      screenshotPath,
    ],
    {
      quiet: true,
      logPath: resolve(artifactRoot, `${label}-vision.log`),
      ...(analysisTimeout === undefined
        ? {}
        : { timeoutMilliseconds: analysisTimeout }),
    },
  );
  const analysisText = analysis.stdout.trim();
  await writeFile(
    resolve(artifactRoot, `${label}-vision.json`),
    `${analysisText}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  try {
    return JSON.parse(analysisText) as unknown;
  } catch {
    throw new Error('Apple Vision returned malformed notification evidence.');
  }
}

async function writeIosNotificationRevealFlow(
  artifactRoot: string,
  purpose: IosNotificationPurpose,
  gesture: Readonly<{
    revealStartPoint: string;
    revealEndPoint: string;
  }>,
): Promise<string> {
  const pointPattern = /^(\d{1,2})%, (\d{1,2})%$/u;
  const start = pointPattern.exec(gesture.revealStartPoint);
  const end = pointPattern.exec(gesture.revealEndPoint);
  if (start === null || end === null) {
    throw new Error('The Vision-derived iOS notification gesture is invalid.');
  }
  const startX = Number(start[1]);
  const startY = Number(start[2]);
  const endX = Number(end[1]);
  const endY = Number(end[2]);
  if (
    !Number.isSafeInteger(startX) ||
    !Number.isSafeInteger(startY) ||
    !Number.isSafeInteger(endX) ||
    !Number.isSafeInteger(endY) ||
    startX < 15 ||
    startX > 80 ||
    startY < 40 ||
    startY > 95 ||
    endX !== 95 ||
    endY !== startY
  ) {
    throw new Error('The Vision-derived iOS notification gesture is unsafe.');
  }
  const flowPath = resolve(
    artifactRoot,
    `notification-${purpose}-ios-system-reveal-open.yaml`,
  );
  await writeFile(
    flowPath,
    `appId: com.apple.springboard
name: Issue 32 - reveal Open from the Vision-verified iOS drill card
tags: [issue-32, synthetic-only, ios, notification, verified-reveal]
---
- assertTrue:
    condition: \${PSD_EOC_E2E_SYNTHETIC_ONLY == 'true'}
    label: Refuse system notification gestures outside the synthetic environment
- assertTrue:
    condition: \${EVENT_ID != null && EVENT_ID.length == 36 && FACILITY_ID != null && FACILITY_ID.length == 36 && EVENT_TYPE_VERSION_ID != null && EVENT_TYPE_VERSION_ID.length == 36}
    label: Require canonical synthetic drill identifiers
- assertTrue:
    condition: \${NOTIFICATION_TITLE == '[DRILL] Synthetic lockdown drill'}
    label: Require the exact synthetic drill notification title
# The runner generated these literals only after Apple Vision proved the
# origin is inside high-confidence body text from the exact DRILL card.
- swipe:
    start: ${startX}%, ${startY}%
    end: ${endX}%, ${endY}%
    duration: 350
- waitForAnimationToEnd:
    timeout: 5000
`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return flowPath;
}

async function executeIosNotificationAction(
  deviceId: string,
  artifactRoot: string,
  environment: Readonly<Record<string, string>>,
  driverSession: IosMaestroDriverSession,
  purpose: IosNotificationPurpose,
  verifiedNotificationAnalysis: unknown,
): Promise<void> {
  const notificationGesture = mobileE2EIosNotificationScreenshotEvidence(
    verifiedNotificationAnalysis,
  );
  const revealFlowPath = await writeIosNotificationRevealFlow(
    artifactRoot,
    purpose,
    notificationGesture,
  );
  const swipeActionStartedAt = Date.now();
  await runMaestroFlow(
    'ios',
    deviceId,
    'notification-event-room-ios-system-reveal-open',
    artifactRoot,
    environment,
    driverSession,
    `notification-${purpose}-ios-system-reveal-open`,
    revealFlowPath,
  );
  // A sufficiently decisive right swipe can itself execute Open. Admit that
  // outcome only from the same SpringBoard transaction evidence used for the
  // explicit Open tap; otherwise continue to a fresh revealed-card proof.
  const swipeActionDeadline =
    Date.now() + IOS_NOTIFICATION_SWIPE_ACTION_TIMEOUT_MS;
  let swipeActionLog = '';
  do {
    const elapsedSeconds = Math.ceil(
      (Date.now() - swipeActionStartedAt) / 1_000,
    );
    swipeActionLog = await iosNotificationActionLogsSince(
      deviceId,
      Math.min(120, Math.max(2, elapsedSeconds + 2)),
    );
    if (mobileE2EIosNotificationActionLogEvidence(swipeActionLog).valid) {
      await writeFile(
        resolve(artifactRoot, `notification-${purpose}-default-action-ios.log`),
        swipeActionLog,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      return;
    }
    if (Date.now() < swipeActionDeadline) {
      await Bun.sleep(RETRY_INTERVAL_MS);
    }
  } while (Date.now() < swipeActionDeadline);
  await writeFile(
    resolve(artifactRoot, `notification-${purpose}-swipe-action-ios.log`),
    swipeActionLog,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const openTapPoint = mobileE2EIosNotificationOpenScreenshotTapPoint(
    verifiedNotificationAnalysis,
    await analyzeIosNotificationScreenshot(
      deviceId,
      artifactRoot,
      `notification-${purpose}-revealed-open-ios`,
    ),
  );
  const openActionStartedAt = Date.now();
  await runMaestroFlow(
    'ios',
    deviceId,
    'notification-event-room-ios-system-tap-open',
    artifactRoot,
    Object.freeze({
      ...environment,
      IOS_NOTIFICATION_OPEN_POINT: openTapPoint,
    }),
    driverSession,
    `notification-${purpose}-ios-system-tap-open`,
  );
  await requireIosNotificationActionEvidence(
    deviceId,
    artifactRoot,
    purpose,
    openActionStartedAt,
  );
}

async function requireIosNotificationActionEvidence(
  deviceId: string,
  artifactRoot: string,
  purpose: IosNotificationPurpose,
  actionTapStartedAt: number,
): Promise<void> {
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
        ? `notification-${purpose}-default-action-ios.log`
        : `notification-${purpose}-default-action-ios-failure.log`,
    ),
    actionLog,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  if (!actionEvidence.valid) {
    throw new Error(
      'SpringBoard did not prove one same-request default notification action after the Vision-verified Open tap.',
    );
  }
}

async function openIosSyntheticEventRoute(
  deviceId: string,
  artifactRoot: string,
  manifest: MobileRuntimeManifest,
  environment: Readonly<Record<string, string>>,
  driverSession: IosMaestroDriverSession,
): Promise<void> {
  const eventId = manifest.event.id;
  const routeEvidence = manifest.event.routeEvidence;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      eventId,
    ) ||
    routeEvidence.length === 0 ||
    manifest.classification !== 'drill' ||
    manifest.rosterPopulation !== 'synthetic'
  ) {
    throw new Error(
      'The registered iOS event route is not synthetic drill data.',
    );
  }
  const routeCandidates = [
    `psdeoc:///events/${eventId}`,
    `psdeoc://events/${eventId}`,
  ] as const;
  let lastHierarchy = '';
  for (const [index, route] of routeCandidates.entries()) {
    await runCommand(['xcrun', 'simctl', 'openurl', deviceId, route], {
      logPath: resolve(artifactRoot, `ios-event-route-open-${index + 1}.log`),
    });
    lastHierarchy = await platformHierarchy('ios', deviceId, driverSession);
    if (lastHierarchy.includes('Open in “PSD EOC”?')) {
      await runMaestroFlow(
        'ios',
        deviceId,
        'accept-event-route-ios',
        artifactRoot,
        environment,
        driverSession,
        `accept-event-route-ios-${index + 1}`,
      );
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      lastHierarchy = await platformHierarchy('ios', deviceId, driverSession);
      if (lastHierarchy.includes(routeEvidence)) {
        await writeFile(
          resolve(artifactRoot, 'ios-event-route-open-hierarchy.txt'),
          lastHierarchy,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
        return;
      }
      await Bun.sleep(RETRY_INTERVAL_MS);
    }
  }
  await writeFile(
    resolve(artifactRoot, 'ios-event-route-open-failure-hierarchy.txt'),
    lastHierarchy.length > 0
      ? lastHierarchy
      : 'No non-empty iOS hierarchy was observed.\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  throw new Error(
    'The registered iOS event URL did not open the exact synthetic drill room.',
  );
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
      ...mobileE2EAndroidArchitectureArguments(),
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
      killLinuxProcessTreeOnCompletion: true,
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
  let iosDriverSession: IosMaestroDriverSession | undefined;
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
      iosDriverSession = await warmIosMaestroDriver(
        iosDevice.udid,
        artifacts.root,
      );
      cancellation.throwIfRequested();

      fixtureMetro = startMetro(
        paths,
        artifacts.root,
        ports.fixtureMetro,
        'fixture',
        mobileE2EFixtureMetroEnvironment(definedProcessEnvironment()),
      );
      await awaitMetro(ports.fixtureMetro, fixtureMetro);
      const fixtureLaunchHierarchy = await installAndOpenIosBundle(
        iosDevice,
        appPath,
        ports.fixtureMetro,
        'Unlock PSD EOC',
        artifacts.root,
        iosDriverSession,
      );
      await runLaunchAuthentication(
        platform,
        iosDevice.udid,
        'start-synthetic-drill-ios',
        artifacts.root,
        maestroEnvironment,
        applesimutils,
        iosDriverSession,
        fixtureLaunchHierarchy,
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
        iosDriverSession,
      );
      await awaitIosFreshEnrollmentReady(
        iosDevice.udid,
        artifacts.root,
        applesimutils,
        maestroEnvironment,
        iosDriverSession,
      );
      await warmMobileEnrollmentStartRoute(
        platform,
        manifest,
        artifacts.root,
        cancellation,
      );
      await warmMobilePostAuthenticationRoutes(
        platform,
        manifest,
        artifacts.root,
        cancellation,
      );
      await runAuthenticationSplit(
        platform,
        iosDevice.udid,
        'enroll-loopback-oidc-ios',
        artifacts.root,
        maestroEnvironment,
        applesimutils,
        iosDriverSession,
      );
      cancellation.throwIfRequested();
      await injectIosNotification(iosDevice, paths, manifest);
      // The foreground handler first presents the provider-free notification
      // as a transient system banner. A top-edge gesture during that animation
      // is consumed by the banner on iOS 26 instead of opening Notification
      // Center. Wait for that bounded presentation to settle; the card remains
      // pending and no notification action is attempted during this interval.
      await Bun.sleep(IOS_NOTIFICATION_FOREGROUND_BANNER_SETTLE_MS);
      // Enrollment and its independent LocalAuthentication split have already
      // committed the protected navigator. Open Notification Center without a
      // background transition so production response readiness remains tied
      // to that exact authenticated shell.
      await runMaestroFlow(
        platform,
        iosDevice.udid,
        'notification-event-room-ios-notification-center-open',
        artifacts.root,
        maestroEnvironment,
        iosDriverSession,
      );
      // XCTest exposes the app hierarchy through Notification Center on iOS
      // 26. A fresh screenshot must instead prove exactly one complete DRILL
      // title/body, no INCIDENT text, and safe title geometry via Apple Vision
      // before the runner admits one non-retrying body-scoped right swipe.
      const routeNotificationAnalysis = await analyzeIosNotificationScreenshot(
        iosDevice.udid,
        artifacts.root,
        'notification-route-foreground-ios',
      );
      mobileE2EIosNotificationScreenshotEvidence(routeNotificationAnalysis);
      await executeIosNotificationAction(
        iosDevice.udid,
        artifacts.root,
        maestroEnvironment,
        iosDriverSession,
        'route',
        routeNotificationAnalysis,
      );
      // The same-request system action has now exercised the mounted listener
      // and production parser. iOS 26 leaves this protected shell on its
      // lobby, so join the exact run-specific active drill through the normal
      // UI, open the app's existing read-only event URL, and require the
      // canonical room evidence there.
      await runMaestroFlow(
        platform,
        iosDevice.udid,
        'notification-event-room-ios-post-auth',
        artifacts.root,
        maestroEnvironment,
        iosDriverSession,
      );
      await openIosSyntheticEventRoute(
        iosDevice.udid,
        artifacts.root,
        manifest,
        maestroEnvironment,
        iosDriverSession,
      );
      await runMaestroFlow(
        platform,
        iosDevice.udid,
        'notification-event-room-ios-event-room',
        artifacts.root,
        maestroEnvironment,
        iosDriverSession,
      );
      cancellation.throwIfRequested();
      await holdEventRoomForOperatorScreenshot(artifacts.root);
      await runMaestroFlow(
        platform,
        iosDevice.udid,
        'event-room-lifecycle',
        artifacts.root,
        maestroEnvironment,
        iosDriverSession,
      );
    } else {
      const suiteAndroidSerial = process.env.ANDROID_SERIAL ?? '';
      androidSerial = suiteAndroidSerial;
      await ensureAndroidDevice(suiteAndroidSerial);
      androidPackagesWereAbsent = true;
      const apkPath = await buildAndroidApp(paths, artifacts.root);
      // Claim cleanup before the mutating command so a lost adb response
      // cannot leave the suite's synthetic PIN behind on the emulator.
      androidCredentialConfigured = true;
      await configureAndroidCredential(suiteAndroidSerial);
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
        suiteAndroidSerial,
        apkPath,
        ports.fixtureMetro,
        [],
        androidReversePorts,
      );
      await runLaunchAuthentication(
        platform,
        suiteAndroidSerial,
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
        suiteAndroidSerial,
        apkPath,
        ports.normalMetro,
        [ports.app, ports.idp],
        androidReversePorts,
      );
      await awaitApplicationReady(
        platform,
        suiteAndroidSerial,
        'Sign in to PSD EOC',
      );
      await warmMobileEnrollmentStartRoute(
        platform,
        manifest,
        artifacts.root,
        cancellation,
      );
      await warmMobilePostAuthenticationRoutes(
        platform,
        manifest,
        artifacts.root,
        cancellation,
      );
      await runAuthenticationSplit(
        platform,
        suiteAndroidSerial,
        'enroll-loopback-oidc-android',
        artifacts.root,
        maestroEnvironment,
      );
      cancellation.throwIfRequested();
      await injectAndroidNotification(
        suiteAndroidSerial,
        paths,
        artifacts.root,
        manifest,
      );
      await runAuthenticationSplit(
        platform,
        suiteAndroidSerial,
        'notification-event-room-android',
        artifacts.root,
        maestroEnvironment,
      );
      cancellation.throwIfRequested();
      await holdEventRoomForOperatorScreenshot(artifacts.root);
      await runMaestroFlow(
        platform,
        suiteAndroidSerial,
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
    if (iosDevice !== undefined && iosDriverSession !== undefined) {
      await retireIosMaestroDriverOwners(
        iosDevice.udid,
        iosDriverSession,
        artifacts.root,
        'suite-failure-cleanup',
      ).catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
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
    if (iosDevice !== undefined && iosDriverSession !== undefined) {
      await retireIosMaestroDriverOwners(
        iosDevice.udid,
        iosDriverSession,
        artifacts.root,
        'suite-cleanup',
      ).catch((error: unknown) => failures.push(error));
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
      await copyMobileWorkspace(paths, runId);
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
    const completionMarkerFilename = mobileE2ECompletionMarkerFilename(
      platform,
      process.env.PSD_EOC_ANDROID_EMULATOR_COMPLETION_DEFERRED,
    );
    const completionStatus =
      completionMarkerFilename === 'complete.txt'
        ? 'passed'
        : 'suite-passed-awaiting-emulator-cleanup';
    await writeFile(
      resolve(artifacts.root, completionMarkerFilename),
      `issue=32\nplatform=${platform}\nclassification=drill\nroster=synthetic\nproviders=mocked\nstatus=${completionStatus}\n`,
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
