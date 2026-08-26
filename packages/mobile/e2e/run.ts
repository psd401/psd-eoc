#!/usr/bin/env bun

import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expoDevelopmentClientUrl,
  IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS,
  mobileE2EIdentity,
  requireSyntheticMobileE2E,
  shouldRetryIosDevelopmentClientOpen,
  type MobileE2EPlatform,
} from './harness';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const mobileRoot = resolve(repositoryRoot, 'packages/mobile');
const flowRoot = resolve(mobileRoot, 'e2e/flows');
const platform = Bun.argv[2] as MobileE2EPlatform | undefined;
if (platform !== 'ios' && platform !== 'android') {
  throw new Error('Usage: bun packages/mobile/e2e/run.ts <ios|android>');
}
requireSyntheticMobileE2E(process.env);

const identity = mobileE2EIdentity(
  await Bun.file(resolve(mobileRoot, 'app.json')).json(),
  platform,
);
const artifactRoot = resolve(
  process.env.PSD_EOC_MOBILE_E2E_ARTIFACT_DIR ??
    resolve(repositoryRoot, `.verification/issue-32/mobile-${platform}`),
);
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
await Bun.write(
  resolve(artifactRoot, 'safety-context.txt'),
  [
    `platform=${platform}`,
    `appId=${identity.appId}`,
    'classification=drill',
    'roster=synthetic',
    'notification=local-provider-free',
    'pushRegistration=false',
    '',
  ].join('\n'),
);

const childEnvironment: Record<string, string | undefined> = {
  ...process.env,
  CI: 'true',
  APP_ID: identity.appId,
  EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'false',
  EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE: 'issue-32',
  EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE: 'issue-21',
  EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE: 'issue-32',
  MAESTRO_CLI_NO_ANALYTICS: '1',
  NODE_OPTIONS: '--dns-result-order=ipv4first',
  PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
  SYSTEM_APP_ID: 'com.apple.springboard',
};

class CommandExitError extends Error {
  constructor(
    readonly exitCode: number,
    arguments_: readonly string[],
  ) {
    super(`${arguments_.join(' ')} exited with ${exitCode}.`);
  }
}

async function command(
  arguments_: readonly string[],
  cwd = repositoryRoot,
): Promise<void> {
  const child = Bun.spawn([...arguments_], {
    cwd,
    env: childEnvironment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new CommandExitError(exitCode, arguments_);
  }
}

async function openIosDevelopmentClient(
  deviceId: string,
  appId: string,
  developmentUrl: string,
): Promise<void> {
  const arguments_ = ['xcrun', 'simctl', 'openurl', deviceId, developmentUrl];
  for (
    let attempt = 1;
    attempt <= IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS;
    attempt += 1
  ) {
    // SpringBoard can report a successful URL open while leaving the home
    // screen in front. Launch the config-derived client before each bounded
    // URL attempt so a successful dispatch has a foreground recipient.
    await command(['xcrun', 'simctl', 'launch', deviceId, appId]);
    try {
      await command(arguments_);
      return;
    } catch (error) {
      if (
        !(error instanceof CommandExitError) ||
        !shouldRetryIosDevelopmentClientOpen(error.exitCode, attempt)
      ) {
        throw error;
      }
      console.warn(
        `The iOS simulator timed out opening the development client on attempt ${attempt}; retrying.`,
      );
      await Bun.sleep(5_000);
    }
  }
}

async function bestEffortCommand(arguments_: readonly string[]): Promise<void> {
  const child = Bun.spawn([...arguments_], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await child.exited;
}

async function output(arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn([...arguments_], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const value = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${arguments_.join(' ')} exited with ${exitCode}.`);
  }
  return value;
}

async function iosDevice(): Promise<string> {
  const configured = process.env.PSD_EOC_IOS_UDID;
  if (configured !== undefined && configured.length > 0) return configured;
  const listing = JSON.parse(
    await output(['xcrun', 'simctl', 'list', 'devices', 'available', '--json']),
  ) as {
    devices?: Record<
      string,
      Array<{
        isAvailable?: boolean;
        name?: string;
        state?: string;
        udid?: string;
      }>
    >;
  };
  const devices = Object.values(listing.devices ?? {}).flat();
  const selected =
    devices.find(
      (device) =>
        device.isAvailable !== false &&
        device.state === 'Booted' &&
        device.name?.startsWith('iPhone') === true,
    ) ??
    devices.find(
      (device) =>
        device.isAvailable !== false &&
        device.name?.startsWith('iPhone') === true,
    );
  if (selected?.udid === undefined) {
    throw new Error('No available iPhone simulator was found.');
  }
  if (selected.state !== 'Booted') {
    await command(['xcrun', 'simctl', 'boot', selected.udid]);
  }
  await command(['xcrun', 'simctl', 'bootstatus', selected.udid, '-b']);
  return selected.udid;
}

async function androidDevice(): Promise<
  Readonly<{ expoName: string; serial: string }>
> {
  const configured = process.env.ANDROID_SERIAL;
  const serial =
    configured !== undefined && configured.length > 0
      ? configured
      : (await output(['adb', 'devices']))
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /^emulator-[0-9]+\tdevice$/u.test(line))
          ?.split('\t')[0];
  if (serial === undefined) throw new Error('No Android emulator was found.');
  if (!/^emulator-[0-9]+$/u.test(serial)) {
    throw new Error(
      `ANDROID_SERIAL must select a running Android emulator; received ${serial}.`,
    );
  }

  const expoName = (await output(['adb', '-s', serial, 'emu', 'avd', 'name']))
    .trim()
    .split(/\r?\n/u)[0];
  if (expoName === undefined || expoName.length === 0 || expoName === 'OK') {
    throw new Error(`Could not resolve the AVD name for ${serial}.`);
  }
  return { expoName, serial };
}

let androidExpoName: string | undefined;
let deviceId: string;
if (platform === 'ios') {
  deviceId = await iosDevice();
} else {
  const emulator = await androidDevice();
  androidExpoName = emulator.expoName;
  deviceId = emulator.serial;
}
if (platform === 'android') childEnvironment.ANDROID_SERIAL = deviceId;
const deviceCommand =
  platform === 'ios'
    ? (arguments_: readonly string[]) =>
        command(['xcrun', 'simctl', ...arguments_])
    : (arguments_: readonly string[]) =>
        command(['adb', '-s', deviceId, ...arguments_]);

async function maestro(flow: string): Promise<void> {
  const flowName = flow.replace(/\.yaml$/u, '');
  const outputRoot = resolve(artifactRoot, flowName);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await command([
    'maestro',
    'test',
    '--udid',
    deviceId,
    '--no-ansi',
    '--format',
    'JUNIT',
    '--output',
    resolve(outputRoot, 'junit.xml'),
    '--test-output-dir',
    resolve(outputRoot, 'artifacts'),
    '--debug-output',
    resolve(outputRoot, 'debug'),
    '--flatten-debug-output',
    '--env',
    `APP_ID=${identity.appId}`,
    '--env',
    'PSD_EOC_E2E_SYNTHETIC_ONLY=true',
    '--env',
    'SYSTEM_APP_ID=com.apple.springboard',
    resolve(flowRoot, flow),
  ]);
}

async function capture(name: string): Promise<void> {
  const destination = resolve(artifactRoot, `${name}.png`);
  if (platform === 'ios') {
    await deviceCommand(['io', deviceId, 'screenshot', destination]);
    return;
  }
  const screenshot = Bun.spawn(
    ['adb', '-s', deviceId, 'exec-out', 'screencap', '-p'],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  const bytes = await new Response(screenshot.stdout).arrayBuffer();
  if ((await screenshot.exited) !== 0) {
    throw new Error('Android screenshot capture failed.');
  }
  await Bun.write(destination, bytes);
}

const skipNativeBuild =
  process.env.PSD_EOC_MOBILE_E2E_SKIP_NATIVE_BUILD === 'true';
if (skipNativeBuild && platform === 'ios') {
  throw new Error(
    'iOS mobile E2E cannot skip the native build because the installed development client must be created by this exact synthetic run.',
  );
}
if (skipNativeBuild) {
  await deviceCommand(['shell', 'pm', 'path', identity.appId]);
} else {
  if (platform === 'android' && androidExpoName === undefined) {
    throw new Error('The Android emulator AVD name was not resolved.');
  }
  await command(
    ['bunx', 'expo', 'prebuild', '--platform', platform, '--no-install'],
    mobileRoot,
  );
  await command(
    platform === 'ios'
      ? ['bunx', 'expo', 'run:ios', '--device', deviceId, '--no-bundler']
      : [
          'bunx',
          'expo',
          'run:android',
          '--device',
          androidExpoName ?? '',
          '--no-bundler',
        ],
    mobileRoot,
  );
}

if (platform === 'ios') {
  // Xcode 26 simulators can reject notification privacy grants even when the
  // app is installed. The synthetic fixture requests permission in-app, and
  // the Maestro flow accepts that native prompt when this best-effort grant is
  // unavailable.
  await bestEffortCommand([
    'xcrun',
    'simctl',
    'privacy',
    deviceId,
    'grant',
    'notifications',
    identity.appId,
  ]);
  await maestro('prepare-ios.yaml');
} else {
  await deviceCommand([
    'shell',
    'pm',
    'grant',
    identity.appId,
    'android.permission.POST_NOTIFICATIONS',
  ]);
  await deviceCommand(['reverse', 'tcp:8081', 'tcp:8081']);
}

if (platform === 'ios') {
  await bestEffortCommand([
    'xcrun',
    'simctl',
    'terminate',
    deviceId,
    identity.appId,
  ]);
} else {
  await bestEffortCommand([
    'adb',
    '-s',
    deviceId,
    'shell',
    'am',
    'force-stop',
    identity.appId,
  ]);
}

const metro = Bun.spawn(
  [
    'bunx',
    'expo',
    'start',
    '--dev-client',
    '--host',
    'localhost',
    '--port',
    '8081',
  ],
  {
    cwd: mobileRoot,
    env: childEnvironment,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8081/status');
      ready = response.ok;
    } catch {
      ready = false;
    }
    if (ready) break;
    await Bun.sleep(1_000);
  }
  if (!ready) throw new Error('Metro did not become ready within 90 seconds.');

  const metroUrl = 'http://127.0.0.1:8081';
  const developmentUrl = expoDevelopmentClientUrl(
    identity.developmentScheme,
    metroUrl,
  );
  if (platform === 'ios') {
    // A recently exercised hosted simulator can transiently time out while
    // SpringBoard dispatches the development-client URL. Keep this bounded,
    // but tolerate that simulator-level flake before starting Maestro.
    await openIosDevelopmentClient(deviceId, identity.appId, developmentUrl);
  } else {
    await deviceCommand([
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      developmentUrl,
      identity.appId,
    ]);
  }
  await Bun.sleep(5_000);
  await maestro('start-drill.yaml');
  await Bun.sleep(6_000);

  if (platform === 'ios') {
    await maestro('reveal-push-ios.yaml');
  } else {
    await deviceCommand(['shell', 'cmd', 'statusbar', 'expand-notifications']);
    await Bun.sleep(2_000);
  }
  await capture(`${platform}-synthetic-push`);
  if (platform === 'ios') {
    await maestro('open-push-ios.yaml');
    // Hosted simulators can evict the JavaScript session while the synthetic
    // notification is visible. The notification tap still launches the exact
    // native development client and retains its native response; reconnecting
    // the config-derived Metro URL proves that killed-process response routes
    // to the intended event instead of mistaking the Expo launcher for success.
    await openIosDevelopmentClient(deviceId, identity.appId, developmentUrl);
  } else {
    await maestro('open-push-android.yaml');
  }
  await maestro('push-opened-event-room.yaml');
  await Bun.sleep(3_000);
  await capture('push-opened-event-room');
  await maestro('event-room-lifecycle.yaml');
  await capture(`${platform}-synthetic-all-clear`);
} finally {
  metro.kill('SIGTERM');
  await metro.exited;
}

const evidenceNames = await readdir(artifactRoot);
if (!evidenceNames.includes(`${platform}-synthetic-all-clear.png`)) {
  throw new Error('The final mobile all-clear screenshot is missing.');
}
