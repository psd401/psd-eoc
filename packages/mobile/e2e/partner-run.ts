#!/usr/bin/env bun

/**
 * Issue #598 native partner journey: sign in with an emailed code, join the
 * event somebody else started, and post to its timeline — on an iOS simulator
 * and on an Android emulator.
 *
 * This is the one mobile harness that drives the real authentication client
 * against a real server, because what is under test is two server endpoints
 * and the screen that calls them. Everything it touches is still synthetic:
 *
 * - the server is this machine's development server on an http loopback port,
 *   which is the only origin both the app and `requireLoopbackApiOrigin`
 *   accept, so a run cannot be pointed at a deployment;
 * - its database is a disposable one created, seeded and dropped by
 *   `packages/server/e2e/mobile-partner-fixture.ts`;
 * - its partner pool is the synthetic stand-in the browser flows use, which
 *   derives the code from the address and emails nothing; and
 * - the device still uses the exact-flag synthetic local authenticator and
 *   still has push registration disabled, so nothing prompts for a biometric
 *   and nothing registers with a provider.
 *
 * Usage: bun packages/mobile/e2e/partner-run.ts <ios|android>
 */

import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  captureScreen,
  createCommandRunner,
  NATIVE_BUILD_LOCALE,
  ephemeralPort,
  selectAndroidDevice,
  selectIosDevice,
  waitForHttp,
  CommandExitError,
  type MobileE2EPlatform,
} from './device';
import {
  expoDevelopmentClientUrl,
  IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS,
  mobileE2EIdentity,
  requireSyntheticNativePartnerE2E,
  shouldRetryIosDevelopmentClientOpen,
} from './harness';

interface MobilePartnerFixture {
  readonly databaseUrl: string;
  readonly partnerEmail: string;
  readonly partnerCode: string;
  readonly facilityName: string;
  readonly eventTypeName: string;
  readonly eventId: string;
}

const repositoryRoot = resolve(import.meta.dir, '../../..');
const mobileRoot = resolve(repositoryRoot, 'packages/mobile');
const serverRoot = resolve(repositoryRoot, 'packages/server');
const flowRoot = resolve(mobileRoot, 'e2e/flows');
const fixtureScript = resolve(serverRoot, 'e2e/mobile-partner-fixture.ts');

const platform = Bun.argv[2] as MobileE2EPlatform | undefined;
if (platform !== 'ios' && platform !== 'android') {
  throw new Error(
    'Usage: bun packages/mobile/e2e/partner-run.ts <ios|android>',
  );
}

const port = ephemeralPort();
// Both platforms reach the server on loopback: the iOS simulator shares the
// host's network, and the Android emulator is given a reverse tunnel below.
const apiBaseUrl = `http://127.0.0.1:${port}`;

const childEnvironment: Record<string, string | undefined> = {
  ...process.env,
  ...NATIVE_BUILD_LOCALE,
  CI: 'true',
  EXPO_PUBLIC_PSD_EOC_API_BASE_URL: apiBaseUrl,
  EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'false',
  EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE: 'issue-32',
  MAESTRO_CLI_NO_ANALYTICS: '1',
  MAESTRO_DRIVER_STARTUP_TIMEOUT: '120000',
  NODE_OPTIONS: '--dns-result-order=ipv4first',
  PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
  SYSTEM_APP_ID: 'com.apple.springboard',
};
// An inherited in-process fixture would stop the app ever reaching the
// server, which is the whole point of this run.
delete childEnvironment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
delete childEnvironment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
requireSyntheticNativePartnerE2E(childEnvironment);

const runner = createCommandRunner(repositoryRoot, childEnvironment);
const identity = mobileE2EIdentity(
  await Bun.file(resolve(mobileRoot, 'app.json')).json(),
  platform,
);
childEnvironment.APP_ID = identity.appId;

const skipNativeBuild =
  process.env.PSD_EOC_MOBILE_E2E_SKIP_NATIVE_BUILD === 'true';

const artifactRoot = resolve(
  process.env.PSD_EOC_MOBILE_E2E_ARTIFACT_DIR ??
    resolve(repositoryRoot, `.verification/issue-598/mobile-${platform}`),
);
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });

async function readFixture(): Promise<MobilePartnerFixture> {
  const child = Bun.spawn(['bun', fixtureScript, 'create'], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const printed = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error('The native partner fixture could not be created.');
  }
  // The fixture's setup logs capability outcomes on the same stream, so take
  // the last line that is the fixture itself.
  for (const line of printed.split('\n').reverse()) {
    if (!line.startsWith('{"databaseUrl"')) continue;
    return JSON.parse(line) as MobilePartnerFixture;
  }
  throw new Error('The native partner fixture printed no database.');
}

async function maestro(
  flow: string,
  variables: Readonly<Record<string, string>>,
): Promise<void> {
  const flowName = flow.replace(/\.yaml$/u, '');
  const outputRoot = resolve(artifactRoot, flowName);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await runner.run([
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
    ...Object.entries({
      APP_ID: identity.appId,
      PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
      SYSTEM_APP_ID: 'com.apple.springboard',
      ...variables,
    }).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    resolve(flowRoot, flow),
  ]);
}

async function openIosDevelopmentClient(developmentUrl: string): Promise<void> {
  const arguments_ = ['xcrun', 'simctl', 'openurl', deviceId, developmentUrl];
  for (
    let attempt = 1;
    attempt <= IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS;
    attempt += 1
  ) {
    await runner.run(['xcrun', 'simctl', 'launch', deviceId, identity.appId]);
    try {
      await runner.run(arguments_);
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

let androidExpoName: string | undefined;
let deviceId: string;
if (platform === 'ios') {
  deviceId = await selectIosDevice(runner, process.env.PSD_EOC_IOS_UDID);
} else {
  const emulator = await selectAndroidDevice(
    runner,
    process.env.ANDROID_SERIAL,
  );
  androidExpoName = emulator.expoName;
  deviceId = emulator.serial;
  childEnvironment.ANDROID_SERIAL = deviceId;
}

const fixture = await readFixture();
await Bun.write(
  resolve(artifactRoot, 'safety-context.txt'),
  [
    `platform=${platform}`,
    `appId=${identity.appId}`,
    'classification=drill',
    'roster=synthetic',
    'partnerPool=synthetic',
    `apiOrigin=${apiBaseUrl}`,
    'pushRegistration=false',
    `nativeBuild=${skipNativeBuild ? 'reused' : 'this-run'}`,
    '',
  ].join('\n'),
);

const server = Bun.spawn(
  ['bun', 'run', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
  {
    cwd: serverRoot,
    env: {
      ...childEnvironment,
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: fixture.databaseUrl,
      NODE_ENV: 'development',
      PSD_EOC_DISPLAY_TIME_ZONE: 'America/Los_Angeles',
      PSD_EOC_ORGANIZATION_NAME: 'Synthetic Example School District',
      // The synthetic partner identity provider and its test-only allowance.
      // A deployed stack can carry neither.
      PSD_EOC_PARTNER_USER_POOL_ID: 'SYNTHETIC',
      PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: 'allowed',
      // The transient-cookie secret the partner flow seal is derived from.
      // Fresh per run: this server lives for one journey, and a constant here
      // would be a checked-in value shaped like a secret.
      GOOGLE_OIDC_COOKIE_SECRET: randomBytes(32).toString('base64url'),
      GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
      GOOGLE_OIDC_APPLICATION_ORIGIN: apiBaseUrl,
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

let metro: Bun.Subprocess | undefined;
try {
  await waitForHttp(`${apiBaseUrl}/login`, 120);

  if (platform === 'android') {
    // The emulator's own loopback is not the host's, so hand it both the
    // server port and Metro's.
    await runner.run([
      'adb',
      '-s',
      deviceId,
      'reverse',
      `tcp:${port}`,
      `tcp:${port}`,
    ]);
  }

  if (skipNativeBuild) {
    // Iteration only, and recorded in the safety context: the installed
    // build is whatever a previous run of this harness put on the device.
    console.warn(
      'Reusing the installed development client; this run did not build it.',
    );
  } else {
    await runner.run(
      ['bunx', 'expo', 'prebuild', '--platform', platform, '--no-install'],
      mobileRoot,
    );
    await runner.bestEffort(
      platform === 'ios'
        ? ['xcrun', 'simctl', 'uninstall', deviceId, identity.appId]
        : ['adb', '-s', deviceId, 'uninstall', identity.appId],
    );
    try {
      await runner.run(
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
    } catch (error) {
      if (!(error instanceof CommandExitError)) throw error;
      // Expo can install the exact build and still fail to open its own
      // development URL. A present installation proves this run put it there.
      await runner.output(
        platform === 'ios'
          ? [
              'xcrun',
              'simctl',
              'get_app_container',
              deviceId,
              identity.appId,
              'app',
            ]
          : ['adb', '-s', deviceId, 'shell', 'pm', 'path', identity.appId],
      );
      console.warn(
        `Expo installed the exact ${platform} build but its development URL did not open; continuing with the bounded localhost launch.`,
      );
    }
  }

  await runner.bestEffort(
    platform === 'ios'
      ? ['xcrun', 'simctl', 'terminate', deviceId, identity.appId]
      : ['adb', '-s', deviceId, 'shell', 'am', 'force-stop', identity.appId],
  );

  metro = Bun.spawn(
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
  await waitForHttp('http://127.0.0.1:8081/status', 90);

  const developmentUrl = expoDevelopmentClientUrl(
    identity.developmentScheme,
    'http://127.0.0.1:8081',
  );
  if (platform === 'ios') {
    await openIosDevelopmentClient(developmentUrl);
  } else {
    await runner.run([
      'adb',
      '-s',
      deviceId,
      'reverse',
      'tcp:8081',
      'tcp:8081',
    ]);
    await runner.run([
      'adb',
      '-s',
      deviceId,
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      `${identity.appId}/.MainActivity`,
    ]);
    await Bun.sleep(2_000);
    await runner.run([
      'adb',
      '-s',
      deviceId,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      developmentUrl,
      `${identity.appId}/.MainActivity`,
    ]);
  }
  await Bun.sleep(5_000);

  await maestro('partner-sign-in.yaml', {
    PARTNER_EMAIL: fixture.partnerEmail,
    PARTNER_CODE: fixture.partnerCode,
  });
  await captureScreen(
    runner,
    platform,
    deviceId,
    resolve(artifactRoot, `${platform}-partner-signed-in.png`),
  );
  await maestro('partner-join-and-post.yaml', {
    FACILITY_NAME: fixture.facilityName,
    EVENT_TYPE_NAME: fixture.eventTypeName,
  });
  await captureScreen(
    runner,
    platform,
    deviceId,
    resolve(artifactRoot, `${platform}-partner-posted.png`),
  );
} finally {
  metro?.kill('SIGTERM');
  await metro?.exited;
  server.kill('SIGTERM');
  await server.exited;
  if (platform === 'android') {
    await runner.bestEffort(['adb', '-s', deviceId, 'reverse', '--remove-all']);
  }
  await runner.bestEffort(['bun', fixtureScript, 'drop', fixture.databaseUrl]);
}
