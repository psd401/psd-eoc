import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  MOBILE_E2E_APPLICATION_ID,
  MOBILE_E2E_NOTIFICATION_BODY,
  MOBILE_E2E_NOTIFICATION_TITLE,
  acquireMobileE2EArtifactDirectory,
  acquireMobileE2ERunnerRoot,
  assertMobileE2EArtifactDirectoryOwned,
  assertMobileE2ERunnerRootOwned,
  createMobileE2ERunId,
  decideMobileE2EIosRevealedOpenAction,
  decideMobileE2EIosNotificationResponse,
  mobileE2EAndroidInstrumentationArguments,
  mobileE2EArtifactPaths,
  mobileE2EDevClientUrl,
  mobileE2EExpoStartArguments,
  mobileE2EFixtureMetroEnvironment,
  mobileE2EIosBuildArguments,
  mobileE2EIsolatedExpoConfig,
  mobileE2EIosNotificationActionLogEvidence,
  mobileE2EIosSimulatorPushPayload,
  mobileE2EIosSyntheticNotificationState,
  mobileE2ELoopbackMetroEnvironment,
  mobileE2EMaestroEnvironment,
  mobileE2ENormalMetroEnvironment,
  mobileE2ERunnerPaths,
  isMobileE2EAndroidApplicationForeground,
  isMobileE2EAndroidDeviceAuthenticationPrompt,
  isMobileE2EIosApplicationForeground,
  isMobileE2EIosApplicationReadyAfterHandoff,
  isMobileE2EIosAuthenticationSheetReady,
  isMobileE2EIosNotificationOnLockedScreen,
  isMobileE2EIosSyntheticNotificationVisible,
  parseMobileE2EManifest,
  parseMobileE2EManifestText,
  parseMobileE2EPlatformCli,
  removeMobileE2EArtifactDirectory,
  removeMobileE2ERunnerRoot,
  requireMobileE2EEnvironment,
  requireMatchingMobileE2ERunIds,
  selectMobileE2EIosRuntimeAndDeviceType,
  shouldCopyMobileE2EWorkspaceSource,
} from './run-ci-lib';

const RUN_ID = 'a'.repeat(32);
const EVENT_ID = '15000000-0000-4000-8000-000000000011';
const FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const TEST_DATABASE_URL =
  'postgresql://synthetic@127.0.0.1:54329/psd_eoc_mobile_test';

function manifest(runId = RUN_ID) {
  return {
    runId,
    appOrigin: 'http://127.0.0.1:23132',
    idpOrigin: 'http://127.0.0.1:33132',
    event: {
      id: EVENT_ID,
      facilityId: FACILITY_ID,
      eventTypeVersionId: EVENT_TYPE_VERSION_ID,
      routeEvidence: `Issue 32 route proof ${runId}`,
    },
    classification: 'drill' as const,
    templateMode: 'drill' as const,
    rosterPopulation: 'synthetic' as const,
  };
}

function syntheticEnvironment(): Record<string, string> {
  return {
    PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
    TEST_DATABASE_URL,
  };
}

function uniqueTemporaryPath(label: string): string {
  return resolve(
    tmpdir(),
    `psd-eoc-issue32-${label}-${randomBytes(8).toString('hex')}`,
  );
}

describe('issue #32 mobile E2E process boundary', () => {
  test('accepts exactly one supported platform', () => {
    expect(parseMobileE2EPlatformCli(['ios'])).toBe('ios');
    expect(parseMobileE2EPlatformCli(['android'])).toBe('android');

    for (const arguments_ of [
      [],
      ['IOS'],
      ['web'],
      ['ios', 'android'],
      ['android', '--unsafe'],
    ]) {
      expect(() => parseMobileE2EPlatformCli(arguments_)).toThrow(
        'Usage: run-ci.ts <ios|android>',
      );
    }
  });

  test('requires the explicit synthetic-only flag and loopback *_test database', () => {
    expect(requireMobileE2EEnvironment(syntheticEnvironment())).toBe(
      TEST_DATABASE_URL,
    );
    expect(() =>
      requireMobileE2EEnvironment({
        ...syntheticEnvironment(),
        PSD_EOC_E2E_SYNTHETIC_ONLY: 'false',
      }),
    ).toThrow('PSD_EOC_E2E_SYNTHETIC_ONLY=true');
    expect(() =>
      requireMobileE2EEnvironment({
        ...syntheticEnvironment(),
        TEST_DATABASE_URL:
          'postgresql://synthetic@database.example/psd_eoc_mobile_test',
      }),
    ).toThrow('loopback PostgreSQL');
    expect(() =>
      requireMobileE2EEnvironment({
        ...syntheticEnvironment(),
        TEST_DATABASE_URL: 'postgresql://synthetic@127.0.0.1/psd_eoc_mobile',
      }),
    ).toThrow('ends in _test');
    expect(() =>
      requireMobileE2EEnvironment({
        ...syntheticEnvironment(),
        TEST_DATABASE_URL:
          'postgresql://synthetic@127.0.0.1/psd_eoc_mobile_test?sslmode=require',
      }),
    ).toThrow('loopback PostgreSQL');
  });

  test('copies no dotenv or generated native state into the isolated app', () => {
    const root = '/tmp/psd-eoc-mobile-source';
    expect(shouldCopyMobileE2EWorkspaceSource(root, root)).toBe(true);
    expect(
      shouldCopyMobileE2EWorkspaceSource(root, resolve(root, 'src/app.tsx')),
    ).toBe(true);
    for (const excluded of [
      '.env',
      '.env.local',
      'src/.env.development',
      '.expo/state.json',
      'android/app/build.gradle',
      'ios/Podfile',
      'node_modules/expo/package.json',
      'tsconfig.tsbuildinfo',
    ]) {
      expect(
        shouldCopyMobileE2EWorkspaceSource(root, resolve(root, excluded)),
      ).toBe(false);
    }
    expect(() =>
      shouldCopyMobileE2EWorkspaceSource(root, '/tmp/outside-mobile/.env'),
    ).toThrow('escaped the mobile root');
  });
});

describe('issue #32 marker-owned runner paths', () => {
  test('creates a random lowercase run ID and derives only one temp child', () => {
    const runId = createMobileE2ERunId();
    expect(runId).toMatch(/^[0-9a-f]{32}$/u);
    const paths = mobileE2ERunnerPaths(runId);
    expect(paths.root).toBe(
      resolve(tmpdir(), `psd-eoc-issue32-mobile-runner-${runId}`),
    );
    expect(paths.copiedMobile).toBe(
      resolve(paths.root, 'repository/packages/mobile'),
    );
    expect(paths.manifestPath).toBe(
      resolve(paths.root, `psd-eoc-issue32-mobile-${runId}.json`),
    );
    expect(() => mobileE2ERunnerPaths('../unsafe')).toThrow(
      '32 lowercase hexadecimal',
    );
  });

  test('acquires, verifies, and removes only its exact marker-owned root', async () => {
    const runId = createMobileE2ERunId();
    const paths = await acquireMobileE2ERunnerRoot(runId);
    try {
      expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
      expect((await lstat(paths.owner)).mode & 0o777).toBe(0o600);
      expect(await readFile(paths.owner, 'utf8')).toBe(`${runId}\n`);
      await assertMobileE2ERunnerRootOwned(runId);
      await mkdir(paths.repository);
      await writeFile(resolve(paths.repository, 'proof.txt'), 'synthetic\n');
    } finally {
      await removeMobileE2ERunnerRoot(runId);
    }
    expect(await lstat(paths.root).catch(() => null)).toBeNull();
  });

  test('refuses a changed marker and a symlink in place of the runner root', async () => {
    const runId = createMobileE2ERunId();
    const paths = await acquireMobileE2ERunnerRoot(runId);
    await writeFile(paths.owner, `${RUN_ID}\n`, 'utf8');
    try {
      await expect(removeMobileE2ERunnerRoot(runId)).rejects.toThrow(
        'marker does not match',
      );
      expect((await lstat(paths.root)).isDirectory()).toBe(true);
    } finally {
      await writeFile(paths.owner, `${runId}\n`, 'utf8');
      await removeMobileE2ERunnerRoot(runId);
    }

    const symlinkRunId = createMobileE2ERunId();
    const symlinkPaths = mobileE2ERunnerPaths(symlinkRunId);
    const target = uniqueTemporaryPath('runner-symlink-target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, symlinkPaths.root, 'dir');
    try {
      await expect(
        assertMobileE2ERunnerRootOwned(symlinkRunId),
      ).rejects.toThrow('cannot be a symlink');
      await expect(acquireMobileE2ERunnerRoot(symlinkRunId)).rejects.toThrow();
    } finally {
      await unlink(symlinkPaths.root);
      await rm(target, { recursive: true });
    }
  });
});

describe('issue #32 marker-owned artifact paths', () => {
  test('preserves the caller base while acquiring and removing only issue-32/platform', async () => {
    const base = uniqueTemporaryPath('artifact-base');
    const callerEvidence = resolve(base, 'workflow-safety-context.txt');
    const runId = createMobileE2ERunId();
    await mkdir(base, { mode: 0o700 });
    await writeFile(callerEvidence, 'providers=mocked\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      const paths = await acquireMobileE2EArtifactDirectory(base, 'ios', runId);
      expect(paths).toEqual(mobileE2EArtifactPaths(base, 'ios'));
      expect(paths.root).toBe(resolve(base, 'issue-32/ios'));
      expect(await readFile(paths.owner, 'utf8')).toBe(`${runId}\n`);
      await assertMobileE2EArtifactDirectoryOwned(base, 'ios', runId);
      await writeFile(resolve(paths.root, 'maestro.xml'), '<testsuite />\n');

      await removeMobileE2EArtifactDirectory(base, 'ios', runId);
      expect(await lstat(paths.root).catch(() => null)).toBeNull();
      expect(await readFile(callerEvidence, 'utf8')).toBe('providers=mocked\n');
      expect((await lstat(base)).isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true });
    }
  });

  test('rejects non-temp, relative, reused, and symlinked artifact bases', async () => {
    expect(() => mobileE2EArtifactPaths('relative', 'ios')).toThrow(
      'absolute path',
    );
    expect(() => mobileE2EArtifactPaths(tmpdir(), 'ios')).toThrow(
      'child of os.tmpdir',
    );
    expect(() =>
      mobileE2EArtifactPaths(resolve(tmpdir(), '..', 'outside'), 'android'),
    ).toThrow('child of os.tmpdir');

    const base = uniqueTemporaryPath('artifact-reuse');
    const runId = createMobileE2ERunId();
    try {
      await acquireMobileE2EArtifactDirectory(base, 'android', runId);
      await expect(
        acquireMobileE2EArtifactDirectory(
          base,
          'android',
          createMobileE2ERunId(),
        ),
      ).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true });
    }

    const target = uniqueTemporaryPath('artifact-symlink-target');
    const link = uniqueTemporaryPath('artifact-symlink');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link, 'dir');
    try {
      await expect(
        acquireMobileE2EArtifactDirectory(link, 'ios', createMobileE2ERunId()),
      ).rejects.toThrow('cannot be a symlink');
    } finally {
      await unlink(link);
      await rm(target, { recursive: true });
    }
  });
});

describe('issue #32 exact synthetic drill data', () => {
  test('parses only the exact server-owned loopback synthetic drill manifest', () => {
    expect(parseMobileE2EManifest(manifest())).toEqual(manifest());
    expect(parseMobileE2EManifestText(JSON.stringify(manifest()))).toEqual(
      manifest(),
    );
    expect(() => parseMobileE2EManifestText('{not-json')).toThrow('valid JSON');

    for (const unsafe of [
      { ...manifest(), classification: 'incident' },
      { ...manifest(), templateMode: 'real' },
      { ...manifest(), rosterPopulation: 'staff' },
      { ...manifest(), appOrigin: 'https://eoc.psd401.net' },
      { ...manifest(), idpOrigin: 'http://identity.example:33132' },
      {
        ...manifest(),
        event: { ...manifest().event, routeEvidence: 'unbound evidence' },
      },
    ]) {
      expect(() => parseMobileE2EManifest(unsafe)).toThrow();
    }
    expect(requireMatchingMobileE2ERunIds(RUN_ID, manifest())).toEqual(
      manifest(),
    );
    expect(() =>
      requireMatchingMobileE2ERunIds('b'.repeat(32), manifest()),
    ).toThrow('must match');
  });

  test('maps the manifest to synthetic-only Maestro evidence', () => {
    expect(mobileE2EMaestroEnvironment(manifest())).toEqual({
      PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
      RUN_ID,
      EVENT_ID,
      EVENT_KIND: 'drill',
      EVENT_ROUTE_EVIDENCE: `Issue 32 route proof ${RUN_ID}`,
      EVENT_TYPE_NAME: 'Lockdown Drill',
      EVENT_TYPE_VERSION_ID,
      FACILITY_CODE: 'SYN-NORTH',
      FACILITY_ID,
      FACILITY_NAME: 'Synthetic North Campus',
      NOTIFICATION_TITLE: MOBILE_E2E_NOTIFICATION_TITLE,
      PURPOSE: 'activation',
      ROSTER_POPULATION: 'synthetic',
      TEMPLATE_MODE: 'drill',
      TIMELINE_TEXT: 'Synthetic mobile issue 32 update.',
    });
    expect(() =>
      mobileE2EMaestroEnvironment({
        ...manifest(),
        classification: 'incident',
      }),
    ).toThrow();
  });

  test('builds mutually exclusive fixture and normal Metro environments', () => {
    const inherited = {
      ...syntheticEnvironment(),
      PATH: '/synthetic/bin',
      EXPO_PUBLIC_PSD_EOC_API_BASE_URL: 'https://live.invalid',
      EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'true',
      EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE: 'unsafe-fixture',
      EXPO_PUBLIC_PSD_EOC_UNREVIEWED: 'unsafe',
    };
    const normal = mobileE2ENormalMetroEnvironment(inherited, manifest());
    const fixture = mobileE2EFixtureMetroEnvironment(inherited);

    expect(normal.PATH).toBe('/synthetic/bin');
    expect(normal.EXPO_PUBLIC_PSD_EOC_API_BASE_URL).toBe(manifest().appOrigin);
    expect(normal.EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED).toBe('false');
    expect(normal).not.toHaveProperty('EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE');
    expect(normal).not.toHaveProperty('EXPO_PUBLIC_PSD_EOC_UNREVIEWED');

    expect(fixture.PATH).toBe('/synthetic/bin');
    expect(fixture.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE).toBe('issue-21');
    expect(fixture.EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED).toBe('false');
    expect(fixture).not.toHaveProperty('EXPO_PUBLIC_PSD_EOC_API_BASE_URL');
    expect(fixture).not.toHaveProperty('EXPO_PUBLIC_PSD_EOC_UNREVIEWED');
    expect(inherited.EXPO_PUBLIC_PSD_EOC_API_BASE_URL).toBe(
      'https://live.invalid',
    );

    expect(() =>
      mobileE2ENormalMetroEnvironment(inherited, {
        ...manifest(),
        templateMode: 'real',
      }),
    ).toThrow();
  });

  test('creates an exact provider-free iOS simulator APNs drill payload', () => {
    const payload = mobileE2EIosSimulatorPushPayload(manifest());
    expect(payload).toEqual({
      'Simulator Target Bundle': MOBILE_E2E_APPLICATION_ID,
      aps: {
        alert: {
          title: MOBILE_E2E_NOTIFICATION_TITLE,
          body: MOBILE_E2E_NOTIFICATION_BODY,
        },
        sound: 'default',
        'interruption-level': 'time-sensitive',
        category: 'PSD_EOC_DRILL',
      },
      body: {
        version: 1,
        eventId: EVENT_ID,
        eventKind: 'drill',
        templateMode: 'drill',
        facilityId: FACILITY_ID,
        eventTypeVersionId: EVENT_TYPE_VERSION_ID,
        purpose: 'activation',
      },
    });
    expect(payload.aps).not.toHaveProperty('body');
    expect(JSON.stringify(payload)).not.toContain('[INCIDENT]');
    expect(() =>
      mobileE2EIosSimulatorPushPayload({
        ...manifest(),
        classification: 'incident',
      }),
    ).toThrow();
  });

  test('creates exact provider-free Android instrumentation properties', () => {
    expect(mobileE2EAndroidInstrumentationArguments(manifest())).toEqual([
      `-Pandroid.testInstrumentationRunnerArguments.runId=${RUN_ID}`,
      `-Pandroid.testInstrumentationRunnerArguments.responseId=issue-32-${RUN_ID}`,
      `-Pandroid.testInstrumentationRunnerArguments.eventId=${EVENT_ID}`,
      '-Pandroid.testInstrumentationRunnerArguments.eventKind=drill',
      '-Pandroid.testInstrumentationRunnerArguments.templateMode=drill',
      `-Pandroid.testInstrumentationRunnerArguments.facilityId=${FACILITY_ID}`,
      `-Pandroid.testInstrumentationRunnerArguments.eventTypeVersionId=${EVENT_TYPE_VERSION_ID}`,
      '-Pandroid.testInstrumentationRunnerArguments.purpose=activation',
    ]);
    expect(() =>
      mobileE2EAndroidInstrumentationArguments({
        ...manifest(),
        rosterPopulation: 'staff',
      }),
    ).toThrow();
  });

  test('creates only the exact loopback Expo development-client URL', () => {
    expect(mobileE2EDevClientUrl(19_000)).toBe(
      'psdeoc://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A19000',
    );
    for (const port of [0, 80, 65_536, Number.NaN, 19_000.5]) {
      expect(() => mobileE2EDevClientUrl(port)).toThrow('Metro port');
    }
  });

  test('starts Expo on loopback without incompatible offline mode', () => {
    expect(mobileE2EExpoStartArguments(19_000)).toEqual([
      'x',
      'expo',
      'start',
      '--dev-client',
      '--localhost',
      '--clear',
      '--max-workers',
      '2',
      '--port',
      '19000',
    ]);
    expect(mobileE2EExpoStartArguments(19_000)).not.toContain('--offline');
    expect(() => mobileE2EExpoStartArguments(80)).toThrow('Metro port');

    expect(
      mobileE2ELoopbackMetroEnvironment({ PATH: '/synthetic/bin' }),
    ).toEqual({
      PATH: '/synthetic/bin',
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
    });
    expect(
      mobileE2ELoopbackMetroEnvironment({
        NODE_OPTIONS: '--max-old-space-size=4096',
      }).NODE_OPTIONS,
    ).toBe('--max-old-space-size=4096 --dns-result-order=ipv4first');
  });

  test('keeps simulator code signing enabled for Keychain entitlements', () => {
    const arguments_ = mobileE2EIosBuildArguments(
      '01234567-89AB-CDEF-0123-456789ABCDEF',
    );
    expect(arguments_).toEqual([
      'xcodebuild',
      '-workspace',
      'PSDEOC.xcworkspace',
      '-scheme',
      'PSDEOC',
      '-configuration',
      'Debug',
      '-destination',
      'platform=iOS Simulator,id=01234567-89AB-CDEF-0123-456789ABCDEF',
      '-derivedDataPath',
      'build',
      'build',
    ]);
    expect(arguments_).not.toContain('CODE_SIGNING_ALLOWED=NO');
    expect(() => mobileE2EIosBuildArguments('booted')).toThrow(
      'simulator UDID is invalid',
    );
  });

  test('suppresses only isolated dev-client chrome on pristine installs', () => {
    const config = mobileE2EIsolatedExpoConfig({
      expo: {
        name: 'PSD EOC',
        slug: 'psd-eoc',
        ios: { bundleIdentifier: MOBILE_E2E_APPLICATION_ID },
        android: { package: MOBILE_E2E_APPLICATION_ID },
        plugins: ['expo-router'],
      },
    });
    expect(config).toEqual({
      expo: {
        name: 'PSD EOC',
        slug: 'psd-eoc',
        ios: { bundleIdentifier: MOBILE_E2E_APPLICATION_ID },
        android: { package: MOBILE_E2E_APPLICATION_ID },
        plugins: [
          'expo-router',
          [
            'expo-dev-client',
            {
              skipOnboarding: true,
              showMenuAtLaunch: false,
              toolsButton: false,
            },
          ],
        ],
      },
    });
    expect(() =>
      mobileE2EIsolatedExpoConfig({
        expo: {
          name: 'PSD EOC',
          slug: 'psd-eoc',
          ios: { bundleIdentifier: MOBILE_E2E_APPLICATION_ID },
          android: { package: MOBILE_E2E_APPLICATION_ID },
          plugins: [['expo-dev-client', {}]],
        },
      }),
    ).toThrow('already owns expo-dev-client settings');
  });

  test('recognizes only the exact Android SystemUI authentication prompt', () => {
    expect(
      isMobileE2EAndroidDeviceAuthenticationPrompt(
        '<node package="com.android.systemui" text="Unlock PSD EOC" />',
      ),
    ).toBe(true);
    expect(
      isMobileE2EAndroidDeviceAuthenticationPrompt(
        '<node package="net.psd401.eoc" text="Unlock PSD EOC" />',
      ),
    ).toBe(false);
  });

  test('recognizes only a resumed PSD EOC Android activity as foreground', () => {
    expect(
      isMobileE2EAndroidApplicationForeground(
        'mResumedActivity: ActivityRecord{abc u0 net.psd401.eoc/.MainActivity t12}',
      ),
    ).toBe(true);
    expect(
      isMobileE2EAndroidApplicationForeground(
        'topResumedActivity=ActivityRecord{abc u0 net.psd401.eoc/net.psd401.eoc.MainActivity}',
      ),
    ).toBe(true);
    expect(
      isMobileE2EAndroidApplicationForeground(
        'mResumedActivity: ActivityRecord{abc u0 com.android.launcher3/.Launcher}\nTask{net.psd401.eoc}',
      ),
    ).toBe(false);
    expect(
      isMobileE2EAndroidApplicationForeground(
        'mResumedActivity: ActivityRecord{abc u0 net.psd401.eoc.preview/.MainActivity}',
      ),
    ).toBe(false);
  });

  test('uses only exact iOS secure-sheet text as a readiness signal', () => {
    expect(
      isMobileE2EIosAuthenticationSheetReady(
        '{"attributes":{"accessibilityText" : "Face ID"}}',
      ),
    ).toBe(true);
    expect(
      isMobileE2EIosAuthenticationSheetReady(
        'Enter iPhone Passcode for “PSD EOC”',
      ),
    ).toBe(true);
    expect(
      isMobileE2EIosAuthenticationSheetReady(
        '{"hintText":"Opens Face ID, Android biometric, or the operating system device passcode fallback"}',
      ),
    ).toBe(false);
    expect(isMobileE2EIosAuthenticationSheetReady('Unlock PSD EOC')).toBe(
      false,
    );
  });

  test('counts an iOS handoff only after its alert is gone and the app is ready', () => {
    expect(
      isMobileE2EIosApplicationReadyAfterHandoff(
        'Open in “PSD EOC”? Unlock PSD EOC',
        'Unlock PSD EOC',
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosApplicationReadyAfterHandoff(
        'Unlock PSD EOC',
        'Unlock PSD EOC',
      ),
    ).toBe(true);
    expect(
      isMobileE2EIosApplicationReadyAfterHandoff(
        '{"attributes":{"accessibilityText" : "Face ID"}}',
        'Unlock PSD EOC',
      ),
    ).toBe(true);
    const foregroundScene =
      '{"resource-id" : "card:net.psd401.eoc:sceneID:net.psd401.eoc-default"}';
    expect(isMobileE2EIosApplicationForeground(foregroundScene)).toBe(true);
    expect(
      isMobileE2EIosApplicationReadyAfterHandoff(
        foregroundScene,
        'Unlock PSD EOC',
      ),
    ).toBe(true);
    expect(
      isMobileE2EIosApplicationReadyAfterHandoff(
        `Open in “PSD EOC”? ${foregroundScene}`,
        'Unlock PSD EOC',
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosApplicationReadyAfterHandoff(
        '{"resource-id":"card:com.example.other:sceneID:default"}',
        'Unlock PSD EOC',
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosApplicationForeground(
        '{"resource-id":"card:com.example.other:sceneID:default"}',
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosApplicationReadyAfterHandoff(
        'PSD EOC is loading',
        'Unlock PSD EOC',
      ),
    ).toBe(false);
  });

  test('recognizes only the synthetic drill notification behind the iOS system lock', () => {
    const pendingHierarchy = JSON.stringify({
      children: [
        { attributes: { 'resource-id': 'lockscreen-date-view' } },
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,564][388,659]',
            accessibilityText: `PSD EOC, now, ${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
          },
        },
      ],
    });
    expect(isMobileE2EIosNotificationOnLockedScreen(pendingHierarchy)).toBe(
      true,
    );
    expect(isMobileE2EIosSyntheticNotificationVisible(pendingHierarchy)).toBe(
      true,
    );
    expect(mobileE2EIosSyntheticNotificationState(pendingHierarchy)).toEqual({
      valid: true,
      locked: true,
      visible: true,
      openable: false,
      coverSheetBounds: null,
      exactCardBounds: { left: 14, top: 564, right: 388, bottom: 659 },
      otherCardBounds: [],
    });
    expect(
      isMobileE2EIosNotificationOnLockedScreen(
        pendingHierarchy.replace(
          MOBILE_E2E_NOTIFICATION_BODY,
          `${MOBILE_E2E_NOTIFICATION_BODY}, Time Sensitive`,
        ),
      ),
    ).toBe(true);
    expect(
      isMobileE2EIosNotificationOnLockedScreen(
        pendingHierarchy.replace(
          MOBILE_E2E_NOTIFICATION_TITLE,
          '[INCIDENT] Synthetic lockdown incident',
        ),
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosSyntheticNotificationVisible(
        pendingHierarchy.replace('PSD EOC, ', 'Other App, PSD EOC, '),
      ),
    ).toBe(false);
    const unlockedNotification = JSON.stringify({
      attributes: {
        'resource-id': 'NotificationShortLookView',
        bounds: '[14,564][388,659]',
        accessibilityText: `PSD EOC, now, ${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
      },
    });
    expect(isMobileE2EIosNotificationOnLockedScreen(unlockedNotification)).toBe(
      false,
    );
    expect(
      isMobileE2EIosSyntheticNotificationVisible(unlockedNotification),
    ).toBe(true);
    expect(
      isMobileE2EIosNotificationOnLockedScreen(
        JSON.stringify({
          children: [
            { attributes: { 'resource-id': 'lockscreen-date-view' } },
            {
              attributes: {
                'resource-id': 'NotificationShortLookView',
                bounds: '[14,564][388,659]',
                accessibilityText: 'PSD EOC, now',
              },
            },
            {
              attributes: {
                accessibilityText: `${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
              },
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosNotificationOnLockedScreen(
        pendingHierarchy.replace(MOBILE_E2E_NOTIFICATION_BODY, 'Open event.'),
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosNotificationOnLockedScreen(
        pendingHierarchy.replace(
          MOBILE_E2E_NOTIFICATION_BODY,
          `${MOBILE_E2E_NOTIFICATION_BODY}, [INCIDENT] Lockdown`,
        ),
      ),
    ).toBe(false);
    expect(isMobileE2EIosNotificationOnLockedScreen('not JSON')).toBe(false);
    expect(isMobileE2EIosSyntheticNotificationVisible('not JSON')).toBe(false);
    expect(mobileE2EIosSyntheticNotificationState('not JSON')).toEqual({
      valid: false,
      locked: false,
      visible: false,
      openable: false,
      coverSheetBounds: null,
      exactCardBounds: null,
      otherCardBounds: [],
    });
    const collapsedHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'SBCoverSheetWindow',
        bounds: '[0,0][402,874]',
      },
      children: [
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,613][388,705]',
            accessibilityText: `PSD EOC, now, ${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
          },
        },
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,676][388,736]',
            accessibilityText: 'Settings, Ready for synthetic setup',
          },
        },
      ],
    });
    expect(mobileE2EIosSyntheticNotificationState(collapsedHierarchy)).toEqual({
      valid: true,
      locked: false,
      visible: true,
      openable: false,
      coverSheetBounds: { left: 0, top: 0, right: 402, bottom: 874 },
      exactCardBounds: { left: 14, top: 613, right: 388, bottom: 705 },
      otherCardBounds: [{ left: 14, top: 676, right: 388, bottom: 736 }],
    });
    const expandedHierarchy = collapsedHierarchy
      .replace('[14,613][388,705]', '[14,564][388,659]')
      .replace('[14,676][388,736]', '[14,667][388,746]');
    expect(mobileE2EIosSyntheticNotificationState(expandedHierarchy)).toEqual({
      valid: true,
      locked: false,
      visible: true,
      openable: true,
      coverSheetBounds: { left: 0, top: 0, right: 402, bottom: 874 },
      exactCardBounds: { left: 14, top: 564, right: 388, bottom: 659 },
      otherCardBounds: [{ left: 14, top: 667, right: 388, bottom: 746 }],
    });
    const singleCardHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'SBCoverSheetWindow',
        bounds: '[0,0][402,874]',
      },
      children: [
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,613][388,705]',
            accessibilityText: `PSD EOC, now, ${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
          },
        },
      ],
    });
    expect(mobileE2EIosSyntheticNotificationState(singleCardHierarchy)).toEqual(
      {
        valid: true,
        locked: false,
        visible: true,
        openable: true,
        coverSheetBounds: { left: 0, top: 0, right: 402, bottom: 874 },
        exactCardBounds: { left: 14, top: 613, right: 388, bottom: 705 },
        otherCardBounds: [],
      },
    );
    expect(
      mobileE2EIosSyntheticNotificationState(
        expandedHierarchy.replace('[14,667][388,746]', '[14,667][500,746]'),
      ).openable,
    ).toBe(false);
    expect(
      mobileE2EIosSyntheticNotificationState(
        expandedHierarchy.replace(
          'Settings, Ready for synthetic setup',
          `PSD EOC, now, ${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
        ),
      ).valid,
    ).toBe(false);
    expect(
      mobileE2EIosSyntheticNotificationState(
        expandedHierarchy.replace(
          'Settings, Ready for synthetic setup',
          '[INCIDENT] Synthetic lockdown incident',
        ),
      ).valid,
    ).toBe(false);
    expect(
      mobileE2EIosSyntheticNotificationState(
        expandedHierarchy.replace('[14,667][388,746]', 'invalid-bounds'),
      ).valid,
    ).toBe(false);
    expect(
      mobileE2EIosSyntheticNotificationState(
        expandedHierarchy.replace('[0,0][402,874]', '[0,0][40,87]'),
      ).openable,
    ).toBe(false);
    expect(
      mobileE2EIosSyntheticNotificationState(
        expandedHierarchy.replace('[14,564][388,659]', '[250,564][500,659]'),
      ).openable,
    ).toBe(false);
  });

  test('fails closed while deciding whether an expanded iOS notification needs an explicit Open action', () => {
    const expandedHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'SBCoverSheetWindow',
        bounds: '[0,0][402,874]',
      },
      children: [
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,564][388,659]',
            accessibilityText: `PSD EOC, now, ${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
          },
        },
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,667][388,746]',
            accessibilityText: 'Settings, Ready for synthetic setup',
          },
        },
      ],
    });
    const absentHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'SBCoverSheetWindow',
        bounds: '[0,0][402,874]',
      },
    });
    const foregroundHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'card:net.psd401.eoc:sceneID:net.psd401.eoc-default',
      },
    });

    expect(decideMobileE2EIosNotificationResponse([])).toBe('wait');
    expect(
      decideMobileE2EIosNotificationResponse([
        expandedHierarchy,
        expandedHierarchy,
      ]),
    ).toBe('wait');
    expect(
      decideMobileE2EIosNotificationResponse([
        expandedHierarchy,
        expandedHierarchy,
        expandedHierarchy,
      ]),
    ).toBe('open-explicit-notification');
    expect(decideMobileE2EIosNotificationResponse(['not JSON'])).toBe(
      'refuse-explicit-open',
    );
    expect(
      decideMobileE2EIosNotificationResponse([
        expandedHierarchy,
        foregroundHierarchy,
      ]),
    ).toBe('response-started');
    expect(
      decideMobileE2EIosNotificationResponse([
        expandedHierarchy,
        absentHierarchy,
      ]),
    ).toBe('refuse-explicit-open');
    expect(
      decideMobileE2EIosNotificationResponse([
        expandedHierarchy,
        expandedHierarchy.replace('[14,564][388,659]', '[14,565][388,660]'),
        expandedHierarchy,
      ]),
    ).toBe('wait');
    expect(
      decideMobileE2EIosNotificationResponse([
        expandedHierarchy,
        expandedHierarchy.replace(
          'Settings, Ready for synthetic setup',
          '[INCIDENT] Synthetic lockdown incident',
        ),
      ]),
    ).toBe('refuse-explicit-open');
  });

  test('admits one iOS Open tap only from a stable measured reveal strip', () => {
    const beforeRevealHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'SBCoverSheetWindow',
        bounds: '[0,0][402,874]',
      },
      children: [
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,564][388,659]',
            accessibilityText: `PSD EOC, now, ${MOBILE_E2E_NOTIFICATION_TITLE}, ${MOBILE_E2E_NOTIFICATION_BODY}`,
          },
        },
        {
          attributes: {
            'resource-id': 'NotificationShortLookView',
            bounds: '[14,667][388,746]',
            accessibilityText: 'Settings, Ready for synthetic setup',
          },
        },
      ],
    });
    const revealedHierarchy = beforeRevealHierarchy.replace(
      '[14,564][388,659]',
      '[112,564][486,659]',
    );
    const foregroundHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'card:net.psd401.eoc:sceneID:net.psd401.eoc-default',
      },
    });
    const absentHierarchy = JSON.stringify({
      attributes: {
        'resource-id': 'SBCoverSheetWindow',
        bounds: '[0,0][402,874]',
      },
    });

    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, []),
    ).toEqual({ decision: 'wait', tapPoint: null });
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        revealedHierarchy,
        revealedHierarchy,
      ]),
    ).toEqual({ decision: 'wait', tapPoint: null });
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        revealedHierarchy,
        revealedHierarchy,
        revealedHierarchy,
      ]),
    ).toEqual({ decision: 'tap-revealed-open', tapPoint: '63,612' });
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        revealedHierarchy,
        revealedHierarchy.replace('[112,564][486,659]', '[113,564][487,659]'),
        revealedHierarchy,
      ]),
    ).toEqual({ decision: 'wait', tapPoint: null });
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        beforeRevealHierarchy,
        beforeRevealHierarchy,
        beforeRevealHierarchy,
      ]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
    const partialReveal = beforeRevealHierarchy.replace(
      '[14,564][388,659]',
      '[50,564][424,659]',
    );
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        partialReveal,
        partialReveal,
        partialReveal,
      ]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
    const verticalShift = beforeRevealHierarchy.replace(
      '[14,564][388,659]',
      '[112,565][486,660]',
    );
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        verticalShift,
        verticalShift,
        verticalShift,
      ]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
    const resizedCard = beforeRevealHierarchy.replace(
      '[14,564][388,659]',
      '[112,564][485,659]',
    );
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        resizedCard,
        resizedCard,
        resizedCard,
      ]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        absentHierarchy,
      ]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        revealedHierarchy.replace(
          MOBILE_E2E_NOTIFICATION_TITLE,
          '[INCIDENT] Synthetic lockdown incident',
        ),
      ]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        foregroundHierarchy,
      ]),
    ).toEqual({ decision: 'response-started', tapPoint: null });
    const overlappingOtherCard = revealedHierarchy.replace(
      '[14,667][388,746]',
      '[40,580][100,650]',
    );
    expect(
      decideMobileE2EIosRevealedOpenAction(beforeRevealHierarchy, [
        overlappingOtherCard,
        overlappingOtherCard,
        overlappingOtherCard,
      ]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
    expect(
      decideMobileE2EIosRevealedOpenAction('not JSON', [revealedHierarchy]),
    ).toEqual({ decision: 'refuse-revealed-open', tapPoint: null });
  });

  test('requires one same-request iOS default-action execution after the measured Open tap', () => {
    const validLog = [
      'Notification List requests executing action com.apple.UNNotificationDefaultActionIdentifier for notification request 71D9-8111',
      'Notification List removing notification request 71D9-8111',
    ].join('\n');
    expect(mobileE2EIosNotificationActionLogEvidence(validLog)).toEqual({
      valid: true,
      requestId: '71D9-8111',
    });
    expect(mobileE2EIosNotificationActionLogEvidence('')).toEqual({
      valid: false,
      requestId: null,
    });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        'Notification List removing notification request 71D9-8111',
      ),
    ).toEqual({ valid: false, requestId: null });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        validLog.replace('removing notification request 71D9-8111', ''),
      ),
    ).toEqual({ valid: false, requestId: null });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        `${validLog}\n${validLog.replaceAll('71D9-8111', '2D08-516E')}`,
      ),
    ).toEqual({ valid: false, requestId: null });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        `${validLog}\nAction completion for 71D9-8111 didExecute? NO`,
      ),
    ).toEqual({ valid: false, requestId: null });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        `${validLog}\nHinting side swipe instead of executing action for 71D9-8111`,
      ),
    ).toEqual({ valid: false, requestId: null });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        validLog.replaceAll('71D9-8111', 'not-a-request'),
      ),
    ).toEqual({ valid: false, requestId: null });
  });

  test('selects an iPhone explicitly supported by the newest usable runtime', () => {
    expect(
      selectMobileE2EIosRuntimeAndDeviceType({
        runtimes: [
          {
            platform: 'iOS',
            identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
            version: '26.0',
            isAvailable: true,
            supportedDeviceTypes: [
              {
                productFamily: 'iPhone',
                identifier:
                  'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
              },
            ],
          },
          {
            platform: 'iOS',
            identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
            version: '18.5',
            isAvailable: true,
            supportedDeviceTypes: [
              {
                productFamily: 'iPhone',
                identifier:
                  'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
              },
            ],
          },
        ],
      }),
    ).toEqual({
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    });

    expect(
      selectMobileE2EIosRuntimeAndDeviceType({
        runtimes: [
          {
            platform: 'iOS',
            identifier: 'newest-but-ipad-only',
            version: '27.0',
            isAvailable: true,
            supportedDeviceTypes: [
              { productFamily: 'iPad', identifier: 'synthetic-ipad' },
            ],
          },
          {
            identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
            version: '18.5',
            isAvailable: true,
            supportedDeviceTypes: [
              {
                productFamily: 'iPhone',
                identifier:
                  'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
              },
              {
                productFamily: 'iPhone',
                identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-8',
              },
            ],
          },
        ],
      }),
    ).toEqual({
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
    });

    expect(() =>
      selectMobileE2EIosRuntimeAndDeviceType({ runtimes: [] }),
    ).toThrow('supported iPhone');
    expect(() => selectMobileE2EIosRuntimeAndDeviceType({})).toThrow(
      'malformed',
    );
  });
});
