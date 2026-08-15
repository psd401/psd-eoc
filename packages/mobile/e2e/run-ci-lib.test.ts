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
  assertMobileE2EAndroidEmulatorControlResponse,
  assertMobileE2EArtifactDirectoryOwned,
  assertMobileE2EPostAuthenticationWarmupRejection,
  assertMobileE2ERunnerRootOwned,
  createMobileE2ERunId,
  decideMobileE2EIosRevealedOpenAction,
  decideMobileE2EIosNotificationResponse,
  mobileE2EAndroidArchitectureArguments,
  mobileE2EAndroidBuildArguments,
  mobileE2EAndroidEmulatorControlArguments,
  mobileE2EAndroidGradleWorkerArguments,
  mobileE2EAndroidInstrumentationArguments,
  mobileE2EArtifactPaths,
  mobileE2ECompletionMarkerFilename,
  mobileE2EDevClientUrl,
  mobileE2EEnrollmentWarmupRequests,
  mobileE2EExpoStartArguments,
  mobileE2EFixtureMetroEnvironment,
  mobileE2EIosBuildArguments,
  mobileE2EIosAuthenticationEvidenceDeadline,
  mobileE2EIosAuthenticationPhaseBudget,
  mobileE2EIosAuthenticationRetryDeadlines,
  mobileE2EIosDeviceAuthenticationScreenshotEvidence,
  mobileE2EIosDirectLaunchArguments,
  mobileE2EIsolatedExpoConfig,
  mobileE2EIssue21FixtureCompatibilitySource,
  mobileE2EIosNotificationActionLogEvidence,
  mobileE2EIosNotificationOpenScreenshotTapPoint,
  mobileE2EIosNotificationScreenshotEvidence,
  mobileE2EIosSimulatorPushPayload,
  mobileE2EIosSyntheticNotificationState,
  mobileE2ELoopbackMetroEnvironment,
  mobileE2EMaestroDriverPortArguments,
  mobileE2EMaestroDriverReuseArguments,
  mobileE2EOwnedIosMaestroDriverPids,
  mobileE2EMaestroEnvironment,
  mobileE2ENormalMetroEnvironment,
  mobileE2EPostAuthenticationWarmupRequests,
  mobileE2ERunnerPaths,
  isMobileE2EAndroidApplicationForeground,
  isMobileE2EAndroidDeviceAuthenticationPrompt,
  isMobileE2EIosApplicationForeground,
  isMobileE2EIosApplicationReady,
  isMobileE2EIosAuthenticationSheetReady,
  isMobileE2EIosNotificationOnLockedScreen,
  isMobileE2EIosSyntheticNotificationVisible,
  isMobileE2EUnlockRetryReady,
  parseMobileE2EManifest,
  parseMobileE2EManifestText,
  parseMobileE2EPlatformCli,
  patchMobileE2EIsolatedIssue21Fixture,
  removeMobileE2EArtifactDirectory,
  removeMobileE2ERunnerRoot,
  requireMobileE2EEnvironment,
  requireMatchingMobileE2ERunIds,
  selectMobileE2EIosRuntimeAndDeviceType,
  shouldCopyMobileE2EWorkspaceSource,
  withMobileE2EAndroidEmulatorPaused,
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

  test('defers only the Android CI completion marker until emulator cleanup', () => {
    expect(mobileE2ECompletionMarkerFilename('ios', undefined)).toBe(
      'complete.txt',
    );
    expect(mobileE2ECompletionMarkerFilename('android', undefined)).toBe(
      'complete.txt',
    );
    expect(mobileE2ECompletionMarkerFilename('android', 'true')).toBe(
      'suite-complete-awaiting-emulator-cleanup.txt',
    );
    expect(() => mobileE2ECompletionMarkerFilename('ios', 'true')).toThrow(
      'allowed only for the issue #32 Android CI emulator cleanup',
    );
    expect(() => mobileE2ECompletionMarkerFilename('android', 'false')).toThrow(
      'allowed only for the issue #32 Android CI emulator cleanup',
    );
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

  test('observes native response shape without navigating or consuming evidence', async () => {
    const [entry, observer] = await Promise.all([
      readFile(new URL('metro-entry.js', import.meta.url), 'utf8'),
      readFile(
        new URL('notification-response-observer.ts', import.meta.url),
        'utf8',
      ),
    ]);
    expect(entry).toMatch(
      /import '\.\/notification-response-observer';[\s\S]+import 'expo-router\/entry';/u,
    );
    expect(observer).toContain('addNotificationResponseReceivedListener');
    expect(observer).toContain('getLastNotificationResponseAsync');
    expect(observer).toContain('parseMobilePushNotification');
    expect(observer).toContain('productionParserAccepted');
    expect(observer).not.toContain('clearLastNotificationResponse');
    expect(observer).not.toContain('router.');
    expect(observer).not.toContain('navigate(');
  });
});

describe('issue #32 bounded iOS authentication retry clock', () => {
  test('starts Face ID evidence only after a 3m50 fresh-driver cold start', () => {
    const operationStartedAtMilliseconds = 1_000;
    const driverReadinessStartedAtMilliseconds = 2_000;
    const driverReadyAtMilliseconds =
      driverReadinessStartedAtMilliseconds + 3 * 60_000 + 50_000;
    const flowDeadlineMilliseconds =
      driverReadinessStartedAtMilliseconds + 30 * 60_000;
    const deadlines = mobileE2EIosAuthenticationRetryDeadlines({
      operationStartedAtMilliseconds,
      driverReadinessStartedAtMilliseconds,
      flowDeadlineMilliseconds,
      operationTimeoutMilliseconds: 10 * 60_000,
      driverReadinessTimeoutMilliseconds: 5 * 60_000,
    });

    expect(deadlines).toEqual({
      operationDeadlineMilliseconds:
        operationStartedAtMilliseconds + 10 * 60_000,
      driverReadinessDeadlineMilliseconds:
        driverReadinessStartedAtMilliseconds + 5 * 60_000,
    });
    const evidenceDeadline = mobileE2EIosAuthenticationEvidenceDeadline({
      driverReadyAtMilliseconds,
      driverReadinessDeadlineMilliseconds:
        deadlines.driverReadinessDeadlineMilliseconds,
      operationDeadlineMilliseconds: deadlines.operationDeadlineMilliseconds,
      flowDeadlineMilliseconds,
      evidenceTimeoutMilliseconds: 4 * 60_000,
    });
    const oldSharedDeadline = driverReadinessStartedAtMilliseconds + 4 * 60_000;
    expect(oldSharedDeadline - driverReadyAtMilliseconds).toBe(10_000);
    expect(evidenceDeadline - driverReadyAtMilliseconds).toBe(4 * 60_000);
    expect(evidenceDeadline).toBeLessThanOrEqual(
      deadlines.operationDeadlineMilliseconds,
    );
  });

  test('preserves the full evidence window after a 4m30 driver cold start', () => {
    const operationStartedAtMilliseconds = 1_000;
    const driverReadinessStartedAtMilliseconds = 2_000;
    const driverReadyAtMilliseconds =
      driverReadinessStartedAtMilliseconds + 4 * 60_000 + 30_000;
    const flowDeadlineMilliseconds =
      driverReadinessStartedAtMilliseconds + 30 * 60_000;
    const deadlines = mobileE2EIosAuthenticationRetryDeadlines({
      operationStartedAtMilliseconds,
      driverReadinessStartedAtMilliseconds,
      flowDeadlineMilliseconds,
      operationTimeoutMilliseconds: 10 * 60_000,
      driverReadinessTimeoutMilliseconds: 5 * 60_000,
    });

    const evidenceDeadline = mobileE2EIosAuthenticationEvidenceDeadline({
      driverReadyAtMilliseconds,
      driverReadinessDeadlineMilliseconds:
        deadlines.driverReadinessDeadlineMilliseconds,
      operationDeadlineMilliseconds: deadlines.operationDeadlineMilliseconds,
      flowDeadlineMilliseconds,
      evidenceTimeoutMilliseconds: 4 * 60_000,
    });

    expect(
      deadlines.driverReadinessDeadlineMilliseconds - driverReadyAtMilliseconds,
    ).toBe(30_000);
    expect(evidenceDeadline - driverReadyAtMilliseconds).toBe(4 * 60_000);
  });

  test('fails closed at the exact five-minute readiness boundary', () => {
    const deadlines = mobileE2EIosAuthenticationRetryDeadlines({
      operationStartedAtMilliseconds: 1_000,
      driverReadinessStartedAtMilliseconds: 2_000,
      flowDeadlineMilliseconds: 32 * 60_000,
      operationTimeoutMilliseconds: 10 * 60_000,
      driverReadinessTimeoutMilliseconds: 5 * 60_000,
    });
    expect(() =>
      mobileE2EIosAuthenticationEvidenceDeadline({
        driverReadyAtMilliseconds:
          deadlines.driverReadinessDeadlineMilliseconds,
        driverReadinessDeadlineMilliseconds:
          deadlines.driverReadinessDeadlineMilliseconds,
        operationDeadlineMilliseconds: deadlines.operationDeadlineMilliseconds,
        flowDeadlineMilliseconds: 32 * 60_000,
        evidenceTimeoutMilliseconds: 4 * 60_000,
      }),
    ).toThrow('was not ready inside its bounded phase');
  });

  test('clamps evidence to the unchanged ten-minute outer budget', () => {
    const operationStartedAtMilliseconds = 1_000;
    const driverReadinessStartedAtMilliseconds = 4 * 60_000 + 1_000;
    const driverReadyAtMilliseconds =
      driverReadinessStartedAtMilliseconds + 4 * 60_000 + 30_000;
    const flowDeadlineMilliseconds = 32 * 60_000;
    const deadlines = mobileE2EIosAuthenticationRetryDeadlines({
      operationStartedAtMilliseconds,
      driverReadinessStartedAtMilliseconds,
      flowDeadlineMilliseconds,
      operationTimeoutMilliseconds: 10 * 60_000,
      driverReadinessTimeoutMilliseconds: 5 * 60_000,
    });
    const evidenceDeadline = mobileE2EIosAuthenticationEvidenceDeadline({
      driverReadyAtMilliseconds,
      driverReadinessDeadlineMilliseconds:
        deadlines.driverReadinessDeadlineMilliseconds,
      operationDeadlineMilliseconds: deadlines.operationDeadlineMilliseconds,
      flowDeadlineMilliseconds,
      evidenceTimeoutMilliseconds: 4 * 60_000,
    });

    expect(evidenceDeadline).toBe(operationStartedAtMilliseconds + 10 * 60_000);
    expect(evidenceDeadline - driverReadyAtMilliseconds).toBe(90_000);
  });

  test('fails closed before an under-budget OCR attempt', () => {
    expect(
      mobileE2EIosAuthenticationPhaseBudget({
        nowMilliseconds: 409_999,
        deadlineMilliseconds: 470_000,
        minimumRequiredMilliseconds: 60_000,
      }),
    ).toBe(60_001);
    expect(
      mobileE2EIosAuthenticationPhaseBudget({
        nowMilliseconds: 410_001,
        deadlineMilliseconds: 470_000,
        minimumRequiredMilliseconds: 60_000,
      }),
    ).toBeNull();
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

describe('issue #32 isolated issue-21 compatibility seam', () => {
  test('adds only exact synthetic fanout and unregister responses', async () => {
    const source = await readFile(
      new URL(
        '../src/lib/start/issue-21-synthetic-fixture.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const compatible = mobileE2EIssue21FixtureCompatibilitySource(source);

    expect(
      compatible.match(/\/api\/mobile\/start\/fanout-control/gu),
    ).toHaveLength(1);
    expect(compatible).toContain(
      "input.method === 'GET' &&\n        input.path === '/api/mobile/start/fanout-control'",
    );
    expect(compatible).toContain(
      "payload = FanoutStatusSchema.parse({ status: 'enabled' });",
    );
    expect(
      compatible.match(/\/api\/devices\/push-token\/unregister/gu),
    ).toHaveLength(1);
    expect(compatible).toContain(
      "input.method === 'POST' &&\n        input.path === '/api/devices/push-token/unregister'",
    );
    expect(compatible).toContain(
      'const unregisterInput = UnregisterPushTokenInputSchema.parse(',
    );
    expect(compatible).toContain(
      'unregisterInput.deviceEnrollmentId !== IDS.deviceEnrollment',
    );
    expect(compatible).toContain(
      'deviceEnrollmentId: unregisterInput.deviceEnrollmentId,',
    );
    expect(compatible).toMatch(
      /const issue32CompatibilityEnabled =\s+isIssue21SyntheticFixtureEnabled\(\) &&\s+process\.env\.EXPO_PUBLIC_PSD_EOC_E2E_SYNTHETIC_ONLY === 'true';/u,
    );
    expect(compatible).toMatch(
      /if \(\s+issue32CompatibilityEnabled &&\s+input\.method === 'GET' &&\s+input\.path === '\/api\/mobile\/start\/fanout-control'[\s\S]+?status: 'enabled'/u,
    );
    expect(compatible).not.toContain(
      "input.method === 'POST' &&\n        input.path === '/api/mobile/start/fanout-control'",
    );
    expect(compatible).not.toContain(
      "input.method === 'GET' &&\n        input.path === '/api/devices/push-token/unregister'",
    );
  });

  test('refuses missing and duplicate source sentinels', async () => {
    const source = await readFile(
      new URL(
        '../src/lib/start/issue-21-synthetic-fixture.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(() =>
      mobileE2EIssue21FixtureCompatibilitySource(
        source.replace(
          '      let payload: unknown;\n',
          '      let payload: unknown = undefined;\n',
        ),
      ),
    ).toThrow('request dispatch source drifted');
    expect(() =>
      mobileE2EIssue21FixtureCompatibilitySource(`${source}\n${source}`),
    ).toThrow('expected exactly one sentinel but found 2');
  });

  test('patches only a marker-owned copied fixture and leaves checkout unchanged', async () => {
    const checkoutPath = new URL(
      '../src/lib/start/issue-21-synthetic-fixture.ts',
      import.meta.url,
    );
    const checkoutSource = await readFile(checkoutPath, 'utf8');
    const runId = createMobileE2ERunId();
    const paths = await acquireMobileE2ERunnerRoot(runId);
    const copiedFixturePath = resolve(
      paths.copiedMobile,
      'src/lib/start/issue-21-synthetic-fixture.ts',
    );
    try {
      await mkdir(resolve(paths.copiedMobile, 'src/lib/start'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(copiedFixturePath, checkoutSource, {
        encoding: 'utf8',
        mode: 0o600,
      });

      const wrongRunId = runId === RUN_ID ? 'b'.repeat(32) : RUN_ID;
      await writeFile(paths.owner, `${wrongRunId}\n`, 'utf8');
      try {
        await expect(
          patchMobileE2EIsolatedIssue21Fixture(runId),
        ).rejects.toThrow('marker does not match');
      } finally {
        await writeFile(paths.owner, `${runId}\n`, 'utf8');
      }

      await patchMobileE2EIsolatedIssue21Fixture(runId);
      const copiedSource = await readFile(copiedFixturePath, 'utf8');
      expect(copiedSource).not.toBe(checkoutSource);
      expect(copiedSource).toContain('/api/mobile/start/fanout-control');
      expect(copiedSource).toContain('/api/devices/push-token/unregister');
      expect(await readFile(checkoutPath, 'utf8')).toBe(checkoutSource);
    } finally {
      await removeMobileE2ERunnerRoot(runId);
    }
  });

  test('applies the copied-source compatibility patch before platform Metro', async () => {
    const runner = await readFile(
      new URL('run-ci.ts', import.meta.url),
      'utf8',
    );
    expect(runner).toMatch(
      /async function copyMobileWorkspace[\s\S]+await cp\(mobileRoot, paths\.copiedMobile[\s\S]+await patchMobileE2EIsolatedIssue21Fixture\(runId\)/u,
    );
    expect(runner).toMatch(
      /await copyMobileWorkspace\(paths, runId\);[\s\S]+await runPlatformSuite\(/u,
    );
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
      EXPO_PUBLIC_PSD_EOC_E2E_SYNTHETIC_ONLY: 'false',
      EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'true',
      EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE: 'unsafe-fixture',
      EXPO_PUBLIC_PSD_EOC_UNREVIEWED: 'unsafe',
    };
    const normal = mobileE2ENormalMetroEnvironment(inherited, manifest());
    const fixture = mobileE2EFixtureMetroEnvironment(inherited);

    expect(normal.PATH).toBe('/synthetic/bin');
    expect(normal.EXPO_PUBLIC_PSD_EOC_API_BASE_URL).toBe(manifest().appOrigin);
    expect(normal.EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED).toBe('false');
    expect(normal).not.toHaveProperty('EXPO_PUBLIC_PSD_EOC_E2E_SYNTHETIC_ONLY');
    expect(normal).not.toHaveProperty('EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE');
    expect(normal).not.toHaveProperty('EXPO_PUBLIC_PSD_EOC_UNREVIEWED');

    expect(fixture.PATH).toBe('/synthetic/bin');
    expect(fixture.EXPO_PUBLIC_PSD_EOC_E2E_SYNTHETIC_ONLY).toBe('true');
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

  test('warms only the exact synthetic OIDC routes before enrollment', async () => {
    expect(mobileE2EEnrollmentWarmupRequests(manifest())).toEqual([
      {
        evidenceRoute: 'mobile-oidc-start',
        url: `${manifest().appOrigin}/api/auth/mobile/oidc/start`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
        body: '{}',
        expectedStatus: 400,
        expectedCode: 'VALIDATION_ERROR',
      },
      {
        evidenceRoute: 'mobile-oidc-exchange',
        url: `${manifest().appOrigin}/api/auth/mobile/oidc/exchange`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
        body: '{}',
        expectedStatus: 400,
        expectedCode: 'VALIDATION_ERROR',
      },
    ]);
    expect(() =>
      mobileE2EEnrollmentWarmupRequests({
        ...manifest(),
        classification: 'incident',
      }),
    ).toThrow();

    const runner = await readFile(
      new URL('run-ci.ts', import.meta.url),
      'utf8',
    );
    const warmup = runner.match(
      /async function warmMobileEnrollmentRoutes[\s\S]+?(?=async function warmMobilePostAuthenticationRoutes)/u,
    )?.[0];
    expect(warmup).toBeDefined();
    expect(warmup).toContain('mobileE2EEnrollmentWarmupRequests(manifest)');
    expect(warmup).toContain("credentials: 'omit'");
    expect(warmup).toContain("redirect: 'manual'");
    expect(warmup).toContain("cache: 'no-store'");
    expect(warmup).toContain("cacheDirectives.includes('no-store')");
    expect(warmup).toContain("response.headers.get('location') !== null");
    expect(warmup).toContain("response.headers.get('set-cookie') !== null");
    expect(warmup).toContain('payload = await response.json()');
    expect(warmup).toContain(
      'assertMobileE2EPostAuthenticationWarmupRejection(',
    );
    expect(warmup).toContain('status=fail-closed-rejections-verified');
    expect(warmup).toContain("flag: 'wx'");
    expect(runner.match(/await warmMobileEnrollmentRoutes\(/gu)).toHaveLength(
      2,
    );
    expect(runner).toMatch(
      /awaitIosFreshEnrollmentReady[\s\S]+await warmMobilePostAuthenticationRoutes\([\s\S]+await warmMobileEnrollmentRoutes\([\s\S]+enroll-loopback-oidc-ios/u,
    );
    expect(runner).toMatch(
      /awaitApplicationReady\([\s\S]+Sign in to PSD EOC[\s\S]+await warmMobilePostAuthenticationRoutes\([\s\S]+await warmMobileEnrollmentRoutes\([\s\S]+enroll-loopback-oidc-android/u,
    );
  });

  test('precompiles every native post-auth route through canonical credential-free rejection', async () => {
    const requests = mobileE2EPostAuthenticationWarmupRequests(manifest());
    expect(requests).toEqual([
      {
        evidenceRoute: 'mobile-start-facilities',
        url: `${manifest().appOrigin}/api/mobile/start/facilities`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
        expectedStatus: 401,
        expectedCode: 'UNAUTHENTICATED',
      },
      {
        evidenceRoute: 'event-type-list',
        url: `${manifest().appOrigin}/event-types/api?operation=list&enabled=true`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
        expectedStatus: 401,
        expectedCode: 'UNAUTHENTICATED',
      },
      {
        evidenceRoute: 'active-events',
        url: `${manifest().appOrigin}/api/events`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
        expectedStatus: 401,
        expectedCode: 'UNAUTHENTICATED',
      },
      {
        evidenceRoute: 'push-token-unregister',
        url: `${manifest().appOrigin}/api/devices/push-token/unregister`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
        body: '{}',
        expectedStatus: 400,
        expectedCode: 'VALIDATION_ERROR',
      },
      {
        evidenceRoute: 'session-refresh',
        url: `${manifest().appOrigin}/api/auth/refresh`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
        body: '{}',
        expectedStatus: 401,
        expectedCode: 'UNAUTHENTICATED',
      },
      {
        evidenceRoute: 'join-event',
        url: `${manifest().appOrigin}/api/events/${EVENT_ID}/join`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
        body: '{}',
        expectedStatus: 400,
        expectedCode: 'VALIDATION_ERROR',
      },
      {
        evidenceRoute: 'event-room',
        url: `${manifest().appOrigin}/events/${EVENT_ID}/api`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
        expectedStatus: 401,
        expectedCode: 'UNAUTHENTICATED',
      },
    ]);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe(manifest().appOrigin);
      const names = Object.keys(request.headers).map((name) =>
        name.toLowerCase(),
      );
      expect(names).not.toContain('authorization');
      expect(names).not.toContain('cookie');
      expect(names).not.toContain('idempotency-key');
      expect(names).not.toContain('human-confirmation-id');
      if (request.method === 'GET') expect(request.body).toBeUndefined();
    }
    expect(() =>
      mobileE2EPostAuthenticationWarmupRequests({
        ...manifest(),
        classification: 'incident',
      }),
    ).toThrow();

    const runner = await readFile(
      new URL('run-ci.ts', import.meta.url),
      'utf8',
    );
    const warmup = runner.match(
      /async function warmMobilePostAuthenticationRoutes[\s\S]+?(?=async function copyMobileWorkspace)/u,
    )?.[0];
    expect(warmup).toBeDefined();
    expect(warmup).toContain('for (const warmup of');
    expect(warmup).toContain("credentials: 'omit'");
    expect(warmup).toContain("redirect: 'manual'");
    expect(warmup).toContain("cache: 'no-store'");
    expect(warmup).toContain('payload = await response.json()');
    expect(warmup).toContain(
      'assertMobileE2EPostAuthenticationWarmupRejection(',
    );
    expect(warmup).toContain('status=fail-closed-rejections-verified');
    expect(warmup).toContain("evidencePhase: 'initial' | 'event-join'");
    expect(warmup).toContain('`${platform}-post-auth-route-warmup.txt`');
    expect(warmup).toContain('`${platform}-event-join-route-warmup.txt`');
    expect(warmup).toContain("flag: 'wx'");
    expect(
      runner.match(/await warmMobilePostAuthenticationRoutes\(/gu),
    ).toHaveLength(3);
    expect(runner).toMatch(
      /awaitIosFreshEnrollmentReady[\s\S]+await warmMobilePostAuthenticationRoutes\([\s\S]+await warmMobileEnrollmentRoutes\([\s\S]+enroll-loopback-oidc-ios/u,
    );
    expect(runner).toMatch(
      /awaitApplicationReady\([\s\S]+Sign in to PSD EOC[\s\S]+await warmMobilePostAuthenticationRoutes\([\s\S]+await warmMobileEnrollmentRoutes\([\s\S]+enroll-loopback-oidc-android/u,
    );
    expect(runner).toMatch(
      /executeIosNotificationAction\([\s\S]+await warmMobilePostAuthenticationRoutes\([\s\S]+notification-event-room-ios-post-auth/u,
    );
  });

  test('rejects any warmup response that is not the exact non-retryable API error', () => {
    const request = mobileE2EPostAuthenticationWarmupRequests(manifest())[0];
    const enrollmentRequest = mobileE2EEnrollmentWarmupRequests(manifest())[1];
    expect(request).toBeDefined();
    expect(enrollmentRequest).toBeDefined();
    const canonical = {
      code: 'UNAUTHENTICATED',
      message: 'A current synthetic session is required.',
      requestId: '15000000-0000-4000-8000-000000000032',
      retryable: false,
      fieldErrors: [],
    };
    expect(() =>
      assertMobileE2EPostAuthenticationWarmupRejection(
        request!,
        401,
        canonical,
      ),
    ).not.toThrow();
    for (const [status, payload] of [
      [200, canonical],
      [400, canonical],
      [401, { ...canonical, code: 'FORBIDDEN' }],
      [401, { ...canonical, retryable: true }],
      [401, { ...canonical, fieldErrors: [{ path: [], message: 'drift' }] }],
      [401, { code: 'UNAUTHENTICATED' }],
    ] as const) {
      expect(() =>
        assertMobileE2EPostAuthenticationWarmupRejection(
          request!,
          status,
          payload,
        ),
      ).toThrow();
    }

    const canonicalValidation = {
      ...canonical,
      code: 'VALIDATION_ERROR',
      message: 'The mobile sign-in exchange is invalid.',
    };
    expect(() =>
      assertMobileE2EPostAuthenticationWarmupRejection(
        enrollmentRequest!,
        400,
        canonicalValidation,
      ),
    ).not.toThrow();
    for (const [status, payload] of [
      [200, canonicalValidation],
      [301, canonicalValidation],
      [401, canonicalValidation],
      [403, canonicalValidation],
      [500, canonicalValidation],
      [400, { ...canonicalValidation, code: 'UNAUTHENTICATED' }],
      [400, { ...canonicalValidation, retryable: true }],
      [
        400,
        {
          ...canonicalValidation,
          fieldErrors: [{ path: [], message: 'drift' }],
        },
      ],
      [400, { code: 'VALIDATION_ERROR' }],
    ] as const) {
      expect(() =>
        assertMobileE2EPostAuthenticationWarmupRejection(
          enrollmentRequest!,
          status,
          payload,
        ),
      ).toThrow();
    }
  });

  test('pins every credential-free rejection before session or capability execution', async () => {
    const [
      oidcStart,
      oidcExchange,
      devices,
      refresh,
      mobileStart,
      eventTypes,
      events,
      eventRoom,
    ] = await Promise.all([
      readFile(
        new URL(
          '../../server/app/api/auth/mobile/oidc/start/route.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL(
          '../../server/app/api/auth/mobile/oidc/exchange/route.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL('../../server/app/api/devices/_lib/http.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../../server/app/api/auth/refresh/route.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          '../../server/app/api/mobile/start/_lib/http.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL(
          '../../server/app/(admin)/event-types/api/route.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL('../../server/app/api/events/_lib/http.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          '../../server/app/(app)/events/[id]/api/route.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    const expectInOrder = (
      source: string,
      sentinels: readonly string[],
    ): void => {
      let previous = -1;
      for (const sentinel of sentinels) {
        const index = source.indexOf(sentinel, previous + 1);
        expect(index).toBeGreaterThan(previous);
        previous = index;
      }
    };

    expectInOrder(
      oidcStart.match(/export async function POST[\s\S]+$/u)?.[0] ?? '',
      ['MobileOidcStartRequestSchema.parse', 'beginGoogleMobileOidcSignIn'],
    );
    expectInOrder(
      oidcExchange.match(/export async function POST[\s\S]+$/u)?.[0] ?? '',
      [
        'MobileOidcExchangeRequestSchema.parse',
        'readGoogleOidcConfiguration',
        'completeGoogleMobileOidcExchange',
        'createDatabaseClient',
        'executeCapability',
      ],
    );
    expectInOrder(
      devices.match(
        /async function executeHumanDeviceRoute[\s\S]+?(?=export function handleListMyDevices)/u,
      )?.[0] ?? '',
      [
        'resolvedRuntime.resolveInvocation',
        'parseMutationMetadata(request)',
        'resolvedRuntime.capabilities.execute',
      ],
    );
    expectInOrder(
      refresh.match(/export async function POST[\s\S]+$/u)?.[0] ?? '',
      [
        'await parseEmptyInput(request)',
        'readPresentedSessionCredential',
        'executeRefreshSessionCapability',
      ],
    );
    expectInOrder(
      mobileStart.match(
        /export async function handleListMobileStartFacilities[\s\S]+?(?=\/\*\* Creates)/u,
      )?.[0] ?? '',
      ['runtime.authenticateQuery', 'runtime.executeFacilities'],
    );
    expectInOrder(
      eventTypes.match(
        /export async function GET[\s\S]+?(?=export async function POST)/u,
      )?.[0] ?? '',
      ['authenticateSessionRequest', 'executeListEventTypesCapability'],
    );
    expectInOrder(
      events.match(
        /async function executeEventRoute[\s\S]+?(?=export async function handleListEvents)/u,
      )?.[0] ?? '',
      [
        'parseMutationHeaders(request)',
        'resolvedRuntime.resolveInvocation',
        'resolvedRuntime.capabilities.execute',
      ],
    );
    expectInOrder(
      eventRoom.match(
        /async function handleTimelineQuery[\s\S]+?(?=async function handleMutation)/u,
      )?.[0] ?? '',
      [
        'authenticateSessionRequest',
        'getDefaultEventRoomCapabilityRuntime().execute',
      ],
    );
  });

  test('retries a cold loopback server only through the visible reconnect control', async () => {
    const [retryFlow, iosEnrollment, androidEnrollment] = await Promise.all([
      readFile(
        new URL('flows/shared/retry-loopback-if-offline.yaml', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          'flows/enroll-loopback-oidc-ios-post-auth.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL(
          'flows/enroll-loopback-oidc-android-post-auth.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    expect(retryFlow).toContain("visible: '^Offline — cached view only$'");
    expect(retryFlow).toContain("tapOn: '^Retry secure connection$'");
    expect(retryFlow.match(/tapOn:/gu)).toHaveLength(1);
    for (const enrollment of [iosEnrollment, androidEnrollment]) {
      expect(enrollment).toContain(
        'file: shared/retry-loopback-if-offline.yaml',
      );
    }
  });

  test('selects the synthetic drill start control by its exact safety label', async () => {
    const activationFlow = await readFile(
      new URL(
        'flows/shared/start-synthetic-drill-after-auth.yaml',
        import.meta.url,
      ),
      'utf8',
    );
    const activationCommands = activationFlow.split(/\n(?=- )/u);
    const scrollCommands = activationCommands.filter((command) =>
      command.startsWith('- scrollUntilVisible:'),
    );
    const tapCommands = activationCommands
      .filter((command) => command.startsWith('- tapOn:'))
      .map((command) => command.trim());

    expect(activationFlow).toMatch(
      /scrollUntilVisible:\n {4}element: 'DRILL — PRACTICE\. Run practice drill at Synthetic Test School'\n {4}direction: DOWN\n {4}waitToSettleTimeoutMs: 500\n- assertVisible: 'DRILL — PRACTICE\. Run practice drill at Synthetic Test School'\n- tapOn: 'DRILL — PRACTICE\. Run practice drill at Synthetic Test School'/u,
    );
    expect(scrollCommands).toHaveLength(9);
    for (const scrollCommand of scrollCommands) {
      expect(scrollCommand).toContain('    waitToSettleTimeoutMs: 500');
    }
    expect(tapCommands).toEqual([
      "- tapOn: 'DRILL — PRACTICE. Run practice drill at Synthetic Test School'",
      "- tapOn: 'DRILL — PRACTICE. Choose Synthetic earthquake drill'",
      "- tapOn: 'Start a separate DRILL — PRACTICE and record notification intents for 2 synthetic recipients'",
    ]);
    expect(activationFlow).not.toContain("id: 'issue-21-start-drill'");
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

  test('admits biometric response only from exact central Face ID Vision evidence', () => {
    const analysis = {
      pixelWidth: 1206,
      pixelHeight: 2622,
      observations: [
        {
          text: 'Unlock PSD EOC',
          confidence: 1,
          minX: 0.054054058108108004,
          minY: 0.6498855828809562,
          width: 0.6666666666666666,
          height: 0.04195270785659799,
        },
        {
          text: 'Face ID',
          confidence: 1,
          minX: 0.42525445441083376,
          minY: 0.4333249403897961,
          width: 0.14633651910531975,
          height: 0.018524538006698843,
        },
      ],
    };
    expect(
      mobileE2EIosDeviceAuthenticationScreenshotEvidence(analysis),
    ).toEqual({
      status: 'proven',
      applicationText: 'Unlock PSD EOC',
      promptText: 'Face ID',
    });
    expect(
      mobileE2EIosDeviceAuthenticationScreenshotEvidence({
        ...analysis,
        observations: analysis.observations.slice(0, 1),
      }),
    ).toEqual({ status: 'not-ready' });

    for (const observations of [
      [...analysis.observations, analysis.observations[1]],
      [
        analysis.observations[0],
        { ...analysis.observations[1], confidence: 0.89 },
      ],
      [analysis.observations[0], { ...analysis.observations[1], minX: 0.1 }],
      [
        { ...analysis.observations[0], text: 'Unlock with device security' },
        analysis.observations[1],
      ],
      [
        ...analysis.observations,
        {
          ...analysis.observations[0],
          text: '[INCIDENT] Unlock PSD EOC',
        },
      ],
    ]) {
      expect(() =>
        mobileE2EIosDeviceAuthenticationScreenshotEvidence({
          ...analysis,
          observations,
        }),
      ).toThrow();
    }
  });

  test('admits iOS screenshot taps only from exact Vision DRILL evidence', () => {
    const analysis = {
      pixelWidth: 1206,
      pixelHeight: 2622,
      observations: [
        {
          text: MOBILE_E2E_NOTIFICATION_TITLE,
          confidence: 1,
          minX: 0.19242902111544422,
          minY: 0.202034883992255,
          width: 0.5709779147880389,
          height: 0.01889534782217628,
        },
        {
          text: '[DRILL] Synthetic exercise only. Open the',
          confidence: 1,
          minX: 0.19242903098425915,
          minY: 0.1815408085021155,
          width: 0.7066246020062449,
          height: 0.019069412662089946,
        },
        {
          text: 'synthetic event room.',
          confidence: 1,
          minX: 0.19242903651368104,
          minY: 0.16279069819760106,
          width: 0.37223972807673866,
          height: 0.016080392216290318,
        },
      ],
    };
    expect(mobileE2EIosNotificationScreenshotEvidence(analysis)).toEqual({
      revealStartPoint: '55%, 81%',
      revealEndPoint: '95%, 81%',
    });
    const revealedAnalysis = {
      pixelWidth: 1206,
      pixelHeight: 2622,
      observations: [
        {
          text: 'Open',
          confidence: 1,
          minX: 0.09748811414375509,
          minY: 0.18129897671827,
          width: 0.09524458953199498,
          height: 0.016762511590161844,
        },
        {
          text: '[DRILL] Synthetic lockdown dril',
          confidence: 1,
          minX: 0.435331237657695,
          minY: 0.202034883992255,
          width: 0.5615141759464396,
          height: 0.01889534782217628,
        },
        {
          text: '[DRILL] Synthetic exercise only. (',
          confidence: 1,
          minX: 0.4353312365930262,
          minY: 0.1815408083949207,
          width: 0.5615141759464397,
          height: 0.019069412662089946,
        },
        {
          text: 'synthetic event room.',
          confidence: 1,
          minX: 0.43217665850841047,
          minY: 0.16132723079985434,
          width: 0.37539432456046595,
          height: 0.01754385964912286,
        },
      ],
    };
    expect(
      mobileE2EIosNotificationOpenScreenshotTapPoint(
        analysis,
        revealedAnalysis,
      ),
    ).toBe('15%, 81%');
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: [
          ...analysis.observations,
          {
            ...analysis.observations[0],
            text: '[INCIDENT] Synthetic lockdown incident',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: [...analysis.observations, analysis.observations[0]],
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: analysis.observations.slice(0, 2),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: [
          { ...analysis.observations[0], confidence: 0.89 },
          ...analysis.observations.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: [
          {
            ...analysis.observations[0],
            minX: 0.1,
            width: 0.25,
          },
          ...analysis.observations.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: analysis.observations.map((observation, index) =>
          index === 1 ? { ...observation, confidence: 0.89 } : observation,
        ),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: analysis.observations.map((observation, index) =>
          index === 1
            ? { ...observation, minX: 0.12, width: 0.25 }
            : observation,
        ),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        observations: analysis.observations.map((observation, index) =>
          index === 1 ? { ...observation, minX: 0.5 } : observation,
        ),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationOpenScreenshotTapPoint(analysis, {
        ...revealedAnalysis,
        observations: revealedAnalysis.observations.slice(1),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationOpenScreenshotTapPoint(
        {
          ...analysis,
          observations: analysis.observations.map((observation, index) =>
            index === 1 ? { ...observation, confidence: 0.89 } : observation,
          ),
        },
        revealedAnalysis,
      ),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationOpenScreenshotTapPoint(analysis, {
        ...revealedAnalysis,
        observations: revealedAnalysis.observations.map((observation) =>
          observation.text === 'Open'
            ? { ...observation, minX: 0.005, width: 0.04 }
            : observation,
        ),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationOpenScreenshotTapPoint(analysis, {
        ...revealedAnalysis,
        observations: revealedAnalysis.observations.map((observation) =>
          observation.text === 'Open'
            ? { ...observation, minX: 0.7, width: 0.08 }
            : observation,
        ),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationOpenScreenshotTapPoint(analysis, {
        ...revealedAnalysis,
        observations: revealedAnalysis.observations.map((observation) =>
          observation.text.startsWith('[DRILL] Synthetic exercise only.')
            ? { ...observation, confidence: 0.89 }
            : observation,
        ),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationOpenScreenshotTapPoint(analysis, {
        ...revealedAnalysis,
        observations: revealedAnalysis.observations.map((observation) =>
          observation.text === 'Open'
            ? observation
            : { ...observation, minX: observation.minX - 0.2 },
        ),
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationOpenScreenshotTapPoint(analysis, {
        ...revealedAnalysis,
        observations: [
          ...revealedAnalysis.observations,
          {
            ...revealedAnalysis.observations[0],
            text: '[INCIDENT] Synthetic lockdown incident',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        ...analysis,
        pixelHeight: 100,
      }),
    ).toThrow();
  });

  test('rejects a complete iOS notification body from low-confidence OCR', () => {
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        pixelWidth: 1206,
        pixelHeight: 2622,
        observations: [
          {
            text: MOBILE_E2E_NOTIFICATION_TITLE,
            confidence: 1,
            minX: 0.19,
            minY: 0.21,
            width: 0.58,
            height: 0.02,
          },
          {
            text: MOBILE_E2E_NOTIFICATION_BODY,
            confidence: 0.89,
            minX: 0.19,
            minY: 0.18,
            width: 0.7,
            height: 0.025,
          },
        ],
      }),
    ).toThrow(
      'The iOS screenshot did not prove the exact complete DRILL notification.',
    );
  });

  test('rejects a complete iOS notification body spatially unrelated to its title', () => {
    expect(() =>
      mobileE2EIosNotificationScreenshotEvidence({
        pixelWidth: 1206,
        pixelHeight: 2622,
        observations: [
          {
            text: MOBILE_E2E_NOTIFICATION_TITLE,
            confidence: 1,
            minX: 0.19,
            minY: 0.42,
            width: 0.58,
            height: 0.02,
          },
          {
            text: MOBILE_E2E_NOTIFICATION_BODY,
            confidence: 1,
            minX: 0.19,
            minY: 0.18,
            width: 0.7,
            height: 0.025,
          },
        ],
      }),
    ).toThrow(
      'The iOS screenshot did not prove the exact complete DRILL notification.',
    );
  });

  test('proves the foreground iOS response before opening the exact drill through ordinary UI', async () => {
    const [
      runner,
      notificationCenterFlow,
      postResponseFlow,
      eventRoomFlow,
      acceptRouteFlow,
      lifecycleFlow,
      openTapFlow,
      ocrSource,
    ] = await Promise.all([
      readFile(new URL('run-ci.ts', import.meta.url), 'utf8'),
      readFile(
        new URL(
          'flows/notification-event-room-ios-notification-center-open.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL(
          'flows/notification-event-room-ios-post-auth.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL(
          'flows/notification-event-room-ios-event-room.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL('flows/accept-event-route-ios.yaml', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('flows/event-room-lifecycle.yaml', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          'flows/notification-event-room-ios-system-tap-open.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(new URL('ios/notification-ocr.swift', import.meta.url), 'utf8'),
    ]);
    const injection = runner.match(
      /async function injectIosNotification[\s\S]+?(?=async function analyzeIosNotificationScreenshot)/u,
    )?.[0];
    expect(injection).toBeDefined();
    expect(injection).toContain("'push'");
    expect(injection).not.toContain("'terminate'");
    expect(runner.match(/await injectIosNotification\(/gu)).toHaveLength(1);
    expect(runner).toMatch(
      /enroll-loopback-oidc-ios[\s\S]+await injectIosNotification[\s\S]+Bun\.sleep\(IOS_NOTIFICATION_FOREGROUND_BANNER_SETTLE_MS\)[\s\S]+notification-event-room-ios-notification-center-open[\s\S]+analyzeIosNotificationScreenshot[\s\S]+mobileE2EIosNotificationScreenshotEvidence[\s\S]+executeIosNotificationAction[\s\S]+notification-event-room-ios-post-auth/u,
    );
    expect(runner).toContain(
      'const IOS_NOTIFICATION_FOREGROUND_BANNER_SETTLE_MS = 8_000;',
    );
    expect(runner).toMatch(
      /mobileE2EIosNotificationOpenScreenshotTapPoint\(\s*verifiedNotificationAnalysis,\s*await analyzeIosNotificationScreenshot/u,
    );
    const notificationRouteSequence = runner.match(
      /await injectIosNotification[\s\S]+?notification-event-room-ios-post-auth/u,
    )?.[0];
    expect(notificationRouteSequence).toBeDefined();
    expect(notificationRouteSequence).not.toContain(
      'respondToDeviceAuthentication',
    );
    expect(notificationRouteSequence).not.toContain('terminate');
    for (const systemFlow of [openTapFlow]) {
      expect(systemFlow).toContain('appId: com.apple.springboard');
      expect(systemFlow).toContain("PSD_EOC_E2E_SYNTHETIC_ONLY == 'true'");
      expect(systemFlow).toContain('EVENT_ID.length == 36');
      expect(systemFlow).not.toContain('shared/assert-synthetic-context.yaml');
    }
    expect(notificationCenterFlow).toContain('appId: net.psd401.eoc');
    expect(notificationCenterFlow).toContain(
      "PSD_EOC_E2E_SYNTHETIC_ONLY == 'true'",
    );
    expect(notificationCenterFlow).toContain('EVENT_ID.length == 36');
    expect(notificationCenterFlow).not.toContain(
      'shared/assert-synthetic-context.yaml',
    );
    expect(notificationCenterFlow).not.toContain('pressKey:');
    expect(notificationCenterFlow).toMatch(
      /start: 50%, 1%[\s\S]+end: 50%, 80%[\s\S]+duration: 800[\s\S]+waitForAnimationToEnd/u,
    );
    expect(notificationCenterFlow).not.toContain('start: 50%, 0%');
    expect(notificationCenterFlow).not.toContain('tapOn:');
    expect(postResponseFlow).toMatch(
      /Join existing DRILL — PRACTICE:[\s\S]+Event ID \$\{EVENT_ID\}[\s\S]+tapOn: 'Join existing DRILL — PRACTICE:[\s\S]+Event ID \$\{EVENT_ID\}'[\s\S]+waitForAnimationToEnd:[\s\S]+visible: '\^Open event\$'[\s\S]+timeout: 60000/u,
    );
    expect(postResponseFlow).toContain(
      'production response listener and parser are exercised and logged',
    );
    expect(postResponseFlow).not.toContain('routed to the exact drill room');
    expect(eventRoomFlow).toContain(
      'registered iOS event URL opened the exact drill room',
    );
    expect(eventRoomFlow).toContain('shared/assert-active-drill-room.yaml');
    expect(acceptRouteFlow).toContain('appId: com.apple.springboard');
    expect(acceptRouteFlow).toContain("PSD_EOC_E2E_SYNTHETIC_ONLY == 'true'");
    expect(acceptRouteFlow).toContain('EVENT_ID.length == 36');
    expect(acceptRouteFlow).toContain('^Open in “PSD EOC”\\?$');
    expect(acceptRouteFlow).toMatch(
      /tapOn:[\s\S]+text: '\^Open\$'[\s\S]+retryTapIfNoChange: false/u,
    );
    expect(lifecycleFlow).toMatch(
      /text: '\.\*Timeline text update\.\*'[\s\S]+enabled: true[\s\S]+inputText: '\$\{TIMELINE_TEXT\}'/u,
    );
    expect(lifecycleFlow).toMatch(
      /tapOn:[\s\S]+text: 'Post'[\s\S]+scrollUntilVisible:[\s\S]+element: '\.\*\$\{TIMELINE_TEXT\}\.\*'[\s\S]+direction: DOWN[\s\S]+assertVisible: '\.\*\$\{TIMELINE_TEXT\}\.\*'/u,
    );
    expect(lifecycleFlow).toContain(
      'push\\. [0-9]+ endpoints\\. Integration mocked\\. Message preview: DRILL:',
    );
    expect(lifecycleFlow).toContain(
      'email\\. [0-9]+ endpoints\\. Integration mocked\\. Message preview: DRILL:',
    );
    expect(lifecycleFlow).toContain("element: 'Status: all clear'");
    expect(runner).toMatch(
      /notification-event-room-ios-post-auth[\s\S]+openIosSyntheticEventRoute\([\s\S]+notification-event-room-ios-event-room/u,
    );
    expect(runner).toMatch(
      /async function openIosSyntheticEventRoute[\s\S]+manifest\.classification !== 'drill'[\s\S]+manifest\.rosterPopulation !== 'synthetic'[\s\S]+psdeoc:\/\/\/events\/\$\{eventId\}[\s\S]+psdeoc:\/\/events\/\$\{eventId\}[\s\S]+'openurl'[\s\S]+Open in “PSD EOC”\?[\s\S]+accept-event-route-ios[\s\S]+lastHierarchy\.includes\(routeEvidence\)[\s\S]+ios-event-route-open-hierarchy\.txt/u,
    );
    expect(runner).toMatch(
      /async function writeIosNotificationRevealFlow[\s\S]+pointPattern[\s\S]+startX < 15[\s\S]+startX > 80[\s\S]+endX !== 95[\s\S]+endY !== startY[\s\S]+resolve\(\s*artifactRoot,[\s\S]+notification-\$\{purpose\}-ios-system-reveal-open\.yaml[\s\S]+appId: com\.apple\.springboard[\s\S]+start: \$\{startX\}%, \$\{startY\}%[\s\S]+end: \$\{endX\}%, \$\{endY\}%[\s\S]+duration: 350[\s\S]+flag: 'wx',[\s\S]+mode: 0o600/u,
    );
    expect(runner).toMatch(
      /mobileE2EIosNotificationScreenshotEvidence\(\s*verifiedNotificationAnalysis[\s\S]+writeIosNotificationRevealFlow\([\s\S]+notificationGesture[\s\S]+notification-event-room-ios-system-reveal-open[\s\S]+revealFlowPath/u,
    );
    expect(openTapFlow).toMatch(
      /IOS_NOTIFICATION_OPEN_POINT[\s\S]+point: '\$\{IOS_NOTIFICATION_OPEN_POINT\}'[\s\S]+retryTapIfNoChange: false/u,
    );
    expect(runner).toMatch(
      /swipeActionStartedAt[\s\S]+notification-event-room-ios-system-reveal-open[\s\S]+mobileE2EIosNotificationActionLogEvidence\(swipeActionLog\)[\s\S]+mobileE2EIosNotificationOpenScreenshotTapPoint/u,
    );
    expect(ocrSource).toContain('import Vision');
    expect(ocrSource).toContain('request.recognitionLevel = .accurate');
    expect(ocrSource).toContain('request.usesLanguageCorrection = false');
    expect(ocrSource).toContain('candidate.confidence');
    expect(ocrSource).toContain('observation.boundingBox');
    expect(runner).toMatch(
      /'simctl', 'io', deviceId, 'screenshot'[\s\S]+'xcrun',[\s\S]+'swift',[\s\S]+notification-ocr\.swift/u,
    );
    expect(runner).toContain('`notification-${purpose}-swipe-action-ios.log`');
    expect(runner).not.toContain('IOS_NOTIFICATION_TITLE_POINT');
    expect(runner).not.toContain('IOS_NOTIFICATION_REVEAL_END_POINT');
    expect(runner).toContain('IOS_NOTIFICATION_OPEN_POINT');
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

  test('reopens Android SystemUI only between notification unlock and route proof', async () => {
    const runner = await readFile(
      new URL('run-ci.ts', import.meta.url),
      'utf8',
    );
    const authenticationSplit = runner.match(
      /async function runAuthenticationSplit[\s\S]+?(?=async function runLaunchAuthentication)/u,
    )?.[0];
    expect(authenticationSplit).toBeDefined();
    expect(authenticationSplit).toContain("platform === 'android'");
    expect(authenticationSplit).toContain(
      "flowName === 'notification-event-room-android'",
    );
    expect(authenticationSplit).toContain("'expand-notifications'");

    const authentication = authenticationSplit?.indexOf(
      'await respondToDeviceAuthentication(',
    );
    const exactGuard = authenticationSplit?.indexOf(
      "flowName === 'notification-event-room-android'",
    );
    const shadeExpansion = authenticationSplit?.indexOf(
      "'expand-notifications'",
    );
    const postAuthFlow = authenticationSplit?.lastIndexOf(
      'await runMaestroFlow(',
    );
    expect(authentication).toBeGreaterThanOrEqual(0);
    expect(exactGuard).toBeGreaterThan(authentication ?? -1);
    expect(shadeExpansion).toBeGreaterThan(exactGuard ?? -1);
    expect(postAuthFlow).toBeGreaterThan(shadeExpansion ?? -1);
  });

  test('creates only the exact loopback Expo development-client URL', () => {
    expect(mobileE2EDevClientUrl(19_000)).toBe(
      'psdeoc://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A19000',
    );
    for (const port of [0, 80, 65_536, Number.NaN, 19_000.5]) {
      expect(() => mobileE2EDevClientUrl(port)).toThrow('Metro port');
    }
  });

  test('launches the iOS development client directly at loopback Metro', () => {
    const deviceId = '01234567-89AB-CDEF-0123-456789ABCDEF';
    expect(mobileE2EIosDirectLaunchArguments(deviceId, 19_000)).toEqual([
      'simctl',
      'launch',
      '--terminate-running-process',
      deviceId,
      MOBILE_E2E_APPLICATION_ID,
      '--initialUrl',
      'http://127.0.0.1:19000',
    ]);
    for (const port of [0, 80, 65_536, Number.NaN, 19_000.5]) {
      expect(() => mobileE2EIosDirectLaunchArguments(deviceId, port)).toThrow(
        'Metro port',
      );
    }
    expect(() =>
      mobileE2EIosDirectLaunchArguments('not-a-device', 19_000),
    ).toThrow('simulator UDID');
  });

  test('reuses only the iOS Maestro XCTest driver after warmup', () => {
    expect(mobileE2EMaestroDriverReuseArguments('ios')).toEqual([
      '--no-reinstall-driver',
    ]);
    expect(mobileE2EMaestroDriverReuseArguments('android')).toEqual([]);
  });

  test('pins iOS Maestro commands to one explicitly tracked XCTest port', () => {
    expect(mobileE2EMaestroDriverPortArguments('ios', 22_087)).toEqual([
      '--driver-host-port',
      '22087',
    ]);
    expect(mobileE2EMaestroDriverPortArguments('android', undefined)).toEqual(
      [],
    );
    for (const invalidPort of [
      undefined,
      0,
      80,
      65_536,
      Number.NaN,
      22_087.5,
    ]) {
      expect(() =>
        mobileE2EMaestroDriverPortArguments('ios', invalidPort),
      ).toThrow('iOS Maestro driver port');
    }
    expect(() =>
      mobileE2EMaestroDriverPortArguments('android', 22_087),
    ).toThrow('Android must not receive');
  });

  test('selects only exact suite-owned iOS Maestro xcodebuild owners', () => {
    const deviceId = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    const otherDeviceId = '11111111-2222-4333-8444-555555555555';
    const target = `/usr/bin/xcodebuild test-without-building -xctestrun /tmp/maestro-driver-ios-config.xctestrun -destination id=${deviceId}`;
    const snapshot = [
      `  742 ${target}`,
      `81 ${target} -only-testing dev.mobile.maestro-driver-iosUITests`,
      `90 /usr/bin/xcodebuild test-without-building -xctestrun /tmp/maestro-driver-ios-config.xctestrun -destination id=${otherDeviceId}`,
      `91 /usr/bin/xcodebuild build -destination id=${deviceId}`,
      `92 maestro test --udid ${deviceId}`,
      `not-a-pid ${target}`,
      '',
    ].join('\n');
    expect(mobileE2EOwnedIosMaestroDriverPids(snapshot, deviceId)).toEqual([
      81, 742,
    ]);
    expect(mobileE2EOwnedIosMaestroDriverPids(snapshot, otherDeviceId)).toEqual(
      [90],
    );
    expect(() =>
      mobileE2EOwnedIosMaestroDriverPids(snapshot, 'not-a-udid'),
    ).toThrow('iOS simulator UDID');
  });

  test('bounds the cold Android build while quiescing its exact emulator', async () => {
    expect(mobileE2EAndroidArchitectureArguments()).toEqual([
      '-PreactNativeArchitectures=x86_64',
    ]);
    expect(mobileE2EAndroidGradleWorkerArguments()).toEqual([
      '--max-workers',
      '2',
    ]);
    expect(mobileE2EAndroidBuildArguments()).toEqual([
      '--no-daemon',
      '--stacktrace',
      '--max-workers',
      '2',
      '-PreactNativeArchitectures=x86_64',
      'app:assembleDebug',
    ]);
    const [runner, library, androidCiRunner, workflow] = await Promise.all([
      readFile(new URL('run-ci.ts', import.meta.url), 'utf8'),
      readFile(new URL('run-ci-lib.ts', import.meta.url), 'utf8'),
      readFile(new URL('run-android-emulator-ci.sh', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../.github/workflows/mobile-e2e.yml', import.meta.url),
        'utf8',
      ),
    ]);
    expect(runner).toMatch(
      /async function buildAndroidApp[\s\S]+\.\.\.mobileE2EAndroidBuildArguments\(\)/u,
    );
    const androidBuild = runner.match(
      /async function buildAndroidApp[\s\S]+?(?=function startMetro)/u,
    )?.[0];
    expect(androidBuild).toBeDefined();
    expect(androidBuild).toContain(
      'timeoutMilliseconds: ANDROID_APP_BUILD_TIMEOUT_MS',
    );
    expect(androidBuild).toContain('killLinuxProcessTreeOnCompletion: true');
    expect(runner).toContain(
      'const ANDROID_APP_BUILD_TIMEOUT_MS = 60 * 60_000;',
    );
    expect(runner).toContain('const NATIVE_BUILD_TIMEOUT_MS = 45 * 60_000;');
    const commandRunner = runner.match(
      /async function runCommand[\s\S]+?(?=function startManagedProcess)/u,
    )?.[0];
    expect(commandRunner).toBeDefined();
    expect(commandRunner).toMatch(
      /killLinuxProcessTreeOnCompletion === true &&\s+process\.platform === 'linux'/u,
    );
    expect(commandRunner).toMatch(
      /detachedLinuxProcessGroup \? \{ detached: true \} : \{\}/u,
    );
    expect(commandRunner).toMatch(
      /await terminateLinuxProcessGroup\(linuxProcessGroupId\);[\s\S]+Promise\.all\(\[stdoutPromise, stderrPromise\]\)/u,
    );
    const processGroupRetirement = runner.match(
      /async function terminateLinuxProcessGroup[\s\S]+?(?=function commandText)/u,
    )?.[0];
    expect(processGroupRetirement).toBeDefined();
    expect(processGroupRetirement).toContain("'SIGTERM'");
    expect(processGroupRetirement).toContain("'SIGKILL'");
    expect(runner).toContain('process.kill(-processGroupId, signal)');
    expect(runner).toMatch(
      /async function injectAndroidNotification[\s\S]+\.\.\.mobileE2EAndroidGradleWorkerArguments\(\)[\s\S]+\.\.\.mobileE2EAndroidArchitectureArguments\(\)[\s\S]+app:connectedDebugAndroidTest[\s\S]+killLinuxProcessTreeOnCompletion: true/u,
    );
    expect(runner).toMatch(
      /ensureAndroidDevice\(suiteAndroidSerial\);[\s\S]+const apkPath = await buildAndroidAppWithPausedEmulator\([\s\S]+ensureAndroidDevice\(suiteAndroidSerial\);[\s\S]+androidCredentialConfigured = true[\s\S]+configureAndroidCredential\(suiteAndroidSerial\)/u,
    );
    expect(runner).toContain(
      'const ANDROID_EMULATOR_CONTROL_TIMEOUT_MS = 30_000;',
    );
    expect(runner).toMatch(
      /async function buildAndroidAppWithPausedEmulator[\s\S]+withMobileE2EAndroidEmulatorPaused\([\s\S]+android-emulator-\$\{action\}-for-build\.log/u,
    );
    expect(library).toContain('withMobileE2EAndroidEmulatorPaused');
    const iosJob = workflow.match(/ {2}ios:\n[\s\S]+?(?=\n {2}android:)/u)?.[0];
    const androidJob = workflow.match(/ {2}android:\n[\s\S]+/u)?.[0];
    expect(iosJob).toContain('timeout-minutes: 90');
    expect(androidJob).toMatch(
      /^ {2}android:\n[\s\S]*?^ {4}timeout-minutes: 250$/mu,
    );
    expect(androidJob).toMatch(
      /- name: Run the synthetic Android Maestro suite\n {8}timeout-minutes: 180\n {8}run: bash packages\/mobile\/e2e\/run-android-emulator-ci\.sh/u,
    );
    expect(androidJob).toMatch(
      /- name: Upload Android E2E evidence\n {8}if: always\(\)\n {8}timeout-minutes: 10\n {8}uses: actions\/upload-artifact@v4/u,
    );
    expect(androidJob).not.toContain('reactivecircus/android-emulator-runner');
    const actionReferences = [
      ...workflow.matchAll(/^\s+uses:\s+(\S+)$/gmu),
    ].map((match) => match[1]);
    expect(actionReferences).toEqual([
      'actions/checkout@v5',
      'oven-sh/setup-bun@v2',
      'actions/setup-java@v5',
      'actions/upload-artifact@v4',
      'actions/checkout@v5',
      'oven-sh/setup-bun@v2',
      'actions/setup-java@v5',
      'actions/upload-artifact@v4',
    ]);
    const androidJobTimeout = Number(
      androidJob?.match(/^ {4}timeout-minutes: (\d+)$/mu)?.[1],
    );
    const androidStepTimeouts = [
      ...(androidJob?.matchAll(/^ {8}timeout-minutes: (\d+)$/gmu) ?? []),
    ].map((match) => Number(match[1]));
    const androidStepTimeoutTotal = androidStepTimeouts.reduce(
      (total, timeout) => total + timeout,
      0,
    );
    expect(androidJobTimeout).toBe(250);
    expect(androidStepTimeouts).toEqual([2, 5, 5, 5, 10, 5, 5, 2, 10, 180, 10]);
    expect(androidStepTimeoutTotal).toBe(239);
    expect(androidJobTimeout - androidStepTimeoutTotal).toBeGreaterThanOrEqual(
      10,
    );
    expect(androidCiRunner).toContain(
      "readonly system_image='system-images;android-36;google_apis;x86_64'",
    );
    expect(androidCiRunner).toContain("readonly emulator_port='5554'");
    expect(androidCiRunner).toContain("readonly suite_timeout='120m'");
    expect(androidCiRunner).toContain(
      'sdkmanager_bin="${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager"',
    );
    expect(androidCiRunner).toContain(
      'avdmanager_bin="${ANDROID_HOME}/cmdline-tools/latest/bin/avdmanager"',
    );
    expect(androidCiRunner).toContain(
      'adb_bin="${ANDROID_HOME}/platform-tools/adb"',
    );
    expect(androidCiRunner).not.toMatch(
      /command -v (?:sdkmanager|avdmanager|adb)/u,
    );
    expect(androidCiRunner).toContain('command -v timeout || true');
    expect(androidCiRunner).toContain('command -v setsid || true');
    expect(androidCiRunner).toContain('command -v bun || true');
    expect(androidCiRunner).toMatch(
      /\[\[ "\$required_bin" = \/\*[\s\S]+export PATH="\$\{ANDROID_HOME\}\/platform-tools:\$\{PATH\}"[\s\S]+"\$bun_bin" packages\/mobile\/e2e\/run-ci\.ts android/u,
    );
    expect(androidCiRunner).toContain('hw.cpu.ncore=1');
    expect(androidCiRunner).toContain('hw.keyboard=yes');
    expect(androidCiRunner).toContain('export ANDROID_USER_HOME=');
    expect(androidCiRunner).toContain('export ANDROID_EMULATOR_HOME=');
    expect(androidCiRunner).toContain('"$emulator_bin" -accel-check');
    expect(androidCiRunner).toContain('-accel on');
    expect(androidCiRunner).toContain('-no-snapshot-save');
    expect(androidCiRunner).toContain('-gpu software');
    expect(androidCiRunner).toContain('-feature -Vulkan');
    expect(androidCiRunner).not.toContain('swiftshader_indirect');
    expect(androidCiRunner).toContain(
      'initial_process_group_id="$(ps -o pgid= -p "$emulator_pid" | tr -d \'[:space:]\')"',
    );
    expect(androidCiRunner).toContain('boot_deadline=$((SECONDS + 900))');
    expect(androidCiRunner).toContain(
      "test \"$api_level\" = '36' || fail 'the booted Android emulator is not API 36.'",
    );
    expect(androidCiRunner).toContain("trap 'on_signal 143' TERM");
    expect(androidCiRunner).toContain('env ANDROID_SERIAL="$emulator_serial"');
    expect(androidCiRunner).toContain(
      '"$bun_bin" packages/mobile/e2e/run-ci.ts android',
    );
    expect(androidCiRunner).toContain(
      'command_line="$(tr \'\\0\' \' \' <"/proc/${emulator_pid}/cmdline")"',
    );
    expect(androidCiRunner).toContain(
      'test "$initial_process_group_id" = "$emulator_pgid"',
    );
    expect(androidCiRunner).toContain(
      'while read -r candidate_pgid member_state; do',
    );
    expect(androidCiRunner).toContain(
      'while read -r member_pid candidate_pgid; do',
    );
    expect(androidCiRunner).toContain(
      'process_table="$(ps -eo pgid=,stat=)" || return 0',
    );
    expect(androidCiRunner).toMatch(
      /emulator_pid=\$!\nemulator_pgid="\$emulator_pid"/u,
    );
    expect(androidCiRunner).toContain('kill "-$signal" -- "-${emulator_pgid}"');
    expect(androidCiRunner).toMatch(
      /"\$adb_bin" -s "\$emulator_serial" emu kill[\s\S]+signal_owned_emulator_group TERM[\s\S]+signal_owned_emulator_group KILL/u,
    );
    expect(androidCiRunner).not.toMatch(/^\s*wait(?:\s|$)/mu);
    expect(androidCiRunner).toContain(
      'suite-complete-awaiting-emulator-cleanup.txt',
    );
    expect(androidCiRunner).toContain(
      'status=suite-passed-awaiting-emulator-cleanup',
    );
    expect(androidCiRunner).toContain(
      "PSD_EOC_ANDROID_EMULATOR_COMPLETION_DEFERRED='true'",
    );
    expect(androidCiRunner).toMatch(
      /if test "\$cleanup_status" -ne 0; then[\s\S]+promote_completion_marker/u,
    );
    expect(runner).toMatch(
      /const completionMarkerFilename = mobileE2ECompletionMarkerFilename\([\s\S]+completionMarkerFilename === 'complete\.txt'[\s\S]+suite-passed-awaiting-emulator-cleanup/u,
    );
    for (const boundedOperation of [
      '--kill-after=10s 5m',
      '--kill-after=30s 25m',
      '--kill-after=5s 30s',
      '--kill-after=10s 2m',
      '--kill-after=5s 15s',
      '--kill-after=5s 10s',
      '--kill-after=1s 2s',
      '--kill-after=30s "$suite_timeout"',
    ]) {
      expect(androidCiRunner).toContain(boundedOperation);
    }
    const androidHelperWorstCaseSeconds =
      5 * 60 +
      10 +
      (25 * 60 + 30) +
      (30 + 5) +
      (2 * 60 + 10) +
      900 +
      (120 * 60 + 30) +
      2 * (15 + 5) +
      (10 + 5) +
      20 +
      10 +
      5 +
      10 +
      11 * (2 + 1);
    expect(180 * 60 - androidHelperWorstCaseSeconds).toBeGreaterThanOrEqual(
      8 * 60,
    );
    expect(androidCiRunner).toContain('emulator_device_is_present_or_unknown');
    expect(androidCiRunner).toContain(
      'device_snapshot="$(\n    "$timeout_bin" --signal=TERM --kill-after=1s 2s',
    );
    expect(androidCiRunner).not.toMatch(/\b(?:pkill|killall)\b/u);
  });

  test('always resumes only the exact paused Android emulator', async () => {
    expect(
      mobileE2EAndroidEmulatorControlArguments('emulator-5554', 'pause'),
    ).toEqual(['adb', '-s', 'emulator-5554', 'emu', 'avd', 'pause']);
    expect(
      mobileE2EAndroidEmulatorControlArguments('emulator-5554', 'resume'),
    ).toEqual(['adb', '-s', 'emulator-5554', 'emu', 'avd', 'resume']);
    expect(() =>
      assertMobileE2EAndroidEmulatorControlResponse('OK\r\n', ''),
    ).not.toThrow();
    for (const [stdout, stderr] of [
      ['KO: invalid state\r\n', ''],
      ['unexpected\n', ''],
      ['', 'console failure\n'],
      ['OK\r\n', 'console warning\n'],
    ] as const) {
      expect(() =>
        assertMobileE2EAndroidEmulatorControlResponse(stdout, stderr),
      ).toThrow('control command was not accepted');
    }
    for (const invalidSerial of [
      '',
      'device',
      '127.0.0.1:5555',
      'emulator-*',
    ]) {
      expect(() =>
        mobileE2EAndroidEmulatorControlArguments(invalidSerial, 'pause'),
      ).toThrow('exact local emulator serial');
    }

    const successOrder: string[] = [];
    await expect(
      withMobileE2EAndroidEmulatorPaused(
        'emulator-5554',
        async () => {
          successOrder.push('build');
          return 'synthetic-apk';
        },
        async (command) => {
          successOrder.push(command.at(-1) ?? 'missing');
        },
      ),
    ).resolves.toBe('synthetic-apk');
    expect(successOrder).toEqual(['pause', 'build', 'resume']);

    const buildFailure = new Error('synthetic build failure');
    const resumeFailure = new Error('synthetic resume failure');
    const failureOrder: string[] = [];
    await expect(
      withMobileE2EAndroidEmulatorPaused(
        'emulator-5554',
        async () => {
          failureOrder.push('build');
          throw buildFailure;
        },
        async (command) => {
          const action = command.at(-1) ?? 'missing';
          failureOrder.push(action);
          if (action === 'resume') throw resumeFailure;
        },
      ),
    ).rejects.toMatchObject({
      message:
        'The Android native operation failed and its emulator could not resume.',
      errors: [buildFailure, resumeFailure],
    });
    expect(failureOrder).toEqual(['pause', 'build', 'resume']);

    const uncertainPause = new Error('synthetic lost pause response');
    const pauseRecoveryOrder: string[] = [];
    await expect(
      withMobileE2EAndroidEmulatorPaused(
        'emulator-5554',
        async () => {
          pauseRecoveryOrder.push('build');
        },
        async (command) => {
          const action = command.at(-1) ?? 'missing';
          pauseRecoveryOrder.push(action);
          if (action === 'pause') throw uncertainPause;
        },
      ),
    ).rejects.toBe(uncertainPause);
    expect(pauseRecoveryOrder).toEqual(['pause', 'resume']);

    const lostResume = new Error('synthetic lost recovery response');
    await expect(
      withMobileE2EAndroidEmulatorPaused(
        'emulator-5554',
        async () => {
          throw new Error('operation must not run after an uncertain pause');
        },
        async (command) => {
          if (command.at(-1) === 'pause') throw uncertainPause;
          throw lostResume;
        },
      ),
    ).rejects.toMatchObject({
      message:
        'The Android emulator pause was uncertain and its recovery resume failed.',
      errors: [uncertainPause, lostResume],
    });
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
    expect(
      isMobileE2EAndroidDeviceAuthenticationPrompt(
        '<node package="net.psd401.eoc" text="Unlock PSD EOC" /><node package="com.android.systemui" text="Unrelated system UI" />',
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

  test('recognizes only the PSD EOC iOS foreground scene', () => {
    const foregroundScene =
      '{"resource-id" : "card:net.psd401.eoc:sceneID:net.psd401.eoc-default"}';
    expect(isMobileE2EIosApplicationForeground(foregroundScene)).toBe(true);
    expect(
      isMobileE2EIosApplicationForeground(
        '{"resource-id":"card:com.example.other:sceneID:default"}',
      ),
    ).toBe(false);
  });

  test('accepts direct iOS launch readiness only from exact app-owned states', () => {
    const expectedText = 'Unlock PSD EOC';
    const authenticationSheet =
      '{"attributes":{"accessibilityText" : "Face ID"}}';
    const foregroundScene =
      '{"resource-id" : "card:net.psd401.eoc:sceneID:net.psd401.eoc-default"}';

    expect(isMobileE2EIosApplicationReady(expectedText, expectedText)).toBe(
      true,
    );
    expect(
      isMobileE2EIosApplicationReady(authenticationSheet, expectedText),
    ).toBe(true);
    expect(isMobileE2EIosApplicationReady(foregroundScene, expectedText)).toBe(
      true,
    );
    expect(
      isMobileE2EIosApplicationReady(
        `Open in “PSD EOC”? ${expectedText}`,
        expectedText,
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosApplicationReady(
        `Open in “PSD EOC”? ${authenticationSheet}`,
        expectedText,
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosApplicationReady(
        `Open in “PSD EOC”? ${foregroundScene}`,
        expectedText,
      ),
    ).toBe(false);
    expect(
      isMobileE2EIosApplicationReady(
        '{"resource-id":"card:com.example.other:sceneID:default"}',
        expectedText,
      ),
    ).toBe(false);
    expect(isMobileE2EIosApplicationReady('PSD EOC is loading', '')).toBe(
      false,
    );
  });

  test('admits a native auth retry only from the exact app-owned failure state', () => {
    const exactFailure = [
      'Unlock PSD EOC',
      'PSD EOC remains locked',
      'PSD EOC could not verify device authentication. Try again or contact district technology support.',
      'Try device unlock again',
    ].join('\n');
    expect(isMobileE2EUnlockRetryReady(exactFailure)).toBe(true);
    for (const requiredText of exactFailure.split('\n')) {
      expect(
        isMobileE2EUnlockRetryReady(
          exactFailure.replace(requiredText, 'Unexpected state'),
        ),
      ).toBe(false);
    }
  });

  test('uses direct iOS launch without an external URL handoff', async () => {
    const [runner, retryFlow] = await Promise.all([
      readFile(new URL('run-ci.ts', import.meta.url), 'utf8'),
      readFile(
        new URL(
          'flows/retry-locked-session-ios-pre-auth.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    const directLaunch = runner.match(
      /async function launchIosBundleDirectly[\s\S]+?(?=async function awaitIosApplicationReady)/u,
    )?.[0];
    expect(directLaunch).toBeDefined();
    expect(directLaunch).toMatch(
      /\['xcrun',\s+\.\.\.mobileE2EIosDirectLaunchArguments\(device\.udid, metroPort\)\]/u,
    );
    expect(directLaunch).not.toMatch(/['"]openurl['"]/u);
    expect(runner).not.toContain('accept-dev-client-handoff-ios.yaml');
    expect(runner).toContain('IOS_INITIAL_HIERARCHY_TIMEOUT_MS = 90_000');
    expect(runner).toContain(
      '`ios-direct-launch-${metroPort}-failure-hierarchy.txt`',
    );
    expect(runner).toMatch(
      /const appPath = await buildIosApp[\s\S]+iosDriverSession = await warmIosMaestroDriver\([\s\S]+const fixtureLaunchHierarchy = await installAndOpenIosBundle/u,
    );
    expect(runner).toMatch(
      /async function warmIosMaestroDriver[\s\S]+timeoutMilliseconds: RUNTIME_TIMEOUT_MS/u,
    );
    expect(runner).toContain(
      'MAESTRO_DRIVER_STARTUP_TIMEOUT: String(RUNTIME_TIMEOUT_MS)',
    );
    expect(
      runner.match(
        /'hierarchy',\s+\.\.\.mobileE2EMaestroDriverReuseArguments\('ios'\)/gu,
      ),
    ).toHaveLength(3);
    expect(runner).toMatch(
      /'maestro',\s+'test',\s+\.\.\.mobileE2EMaestroDriverReuseArguments\(platform\)/u,
    );
    expect(runner).toMatch(
      /'maestro',\s+'test',[\s\S]+mobileE2EMaestroDriverPortArguments\(platform, iosDriverPort\)/u,
    );
    expect(
      runner.match(
        /mobileE2EMaestroDriverPortArguments\(\s*'ios',\s+(?:driverSession|iosDriverSession)\.currentPort,?\s*\)/gu,
      ),
    ).toHaveLength(3);
    expect(runner).toMatch(
      /iosDriverPort = await reserveLoopbackPort\(\);\s+iosDriverSession\.currentPort = iosDriverPort/u,
    );
    const flowStarter = runner.match(
      /async function startMaestroFlow[\s\S]+?(?=async function awaitMaestroFlow)/u,
    )?.[0];
    expect(flowStarter).toBeDefined();
    expect(flowStarter).toMatch(
      /await retireIosMaestroDriverOwners\([\s\S]+iosDriverPort = await reserveLoopbackPort\(\);\s+iosDriverSession\.currentPort = iosDriverPort/u,
    );
    expect(flowStarter).toMatch(
      /return Object\.freeze\(\{\s+process: process_,\s+flowName,\s+deadline: Date\.now\(\) \+ COMMAND_TIMEOUT_MS,\s+iosDriverPort,/u,
    );
    const driverRetirement = runner.match(
      /async function retireIosMaestroDriverOwners[\s\S]+?(?=async function runCommand)/u,
    )?.[0];
    expect(driverRetirement).toBeDefined();
    expect(driverRetirement).toContain(
      "['ps', '-ww', '-axo', 'pid=,command=']",
    );
    expect(driverRetirement).toContain('mobileE2EOwnedIosMaestroDriverPids');
    expect(driverRetirement).toContain(
      "'dev.mobile.maestro-driver-iosUITests.xctrunner'",
    );
    expect(driverRetirement).toContain('loopbackPortIsAvailable(previousPort)');
    expect(driverRetirement).not.toMatch(/\bpkill\b|\bkillall\b/u);
    expect(runner).not.toContain('22087');
    expect(runner).toContain("flowName === 'start-synthetic-drill-ios'");
    expect(runner).toContain(
      'IOS_AUTH_RETRY_DRIVER_READINESS_TIMEOUT_MS = 5 * 60_000',
    );
    const retryResponder = runner.match(
      /async function respondToRetriedIosDeviceAuthentication[\s\S]+?(?=async function respondToDeviceAuthentication)/u,
    )?.[0];
    expect(retryResponder).toBeDefined();
    expect(retryResponder).toMatch(
      /startMaestroFlow\([\s\S]+awaitRetriedIosMaestroDriverReady\([\s\S]+mobileE2EIosAuthenticationEvidenceDeadline\([\s\S]+analyzeIosNotificationScreenshot\([\s\S]+mobileE2EIosDeviceAuthenticationScreenshotEvidence\(analysis\)[\s\S]+retryFlow\.process\.child\.exitCode[\s\S]+--biometricMatch[\s\S]+awaitMaestroFlow\(retryFlow,\s+evidenceDeadline\)/u,
    );
    expect(retryResponder).toMatch(
      /startMaestroFlow\([\s\S]+iosDriverSession,\s+IOS_AUTH_RETRY_DRIVER_READINESS_TIMEOUT_MS[\s\S]+driverReadinessTimeoutMilliseconds:\s+IOS_AUTH_RETRY_DRIVER_READINESS_TIMEOUT_MS/u,
    );
    expect(retryResponder).toContain('endpoint=/status');
    expect(retryResponder).toContain('httpStatus=200');
    expect(retryResponder).toContain("flag: 'wx'");
    expect(retryResponder).toContain('mode: 0o600');
    expect(retryResponder).toContain("evidence.status === 'not-ready'");
    expect(retryResponder).toContain('evidenceDeadline');
    expect(retryResponder).toContain('operationStartedAtMilliseconds');
    expect(retryResponder).toContain('driverReadinessStartedAtMilliseconds');
    expect(retryResponder).toContain(
      'IOS_AUTH_RETRY_FACE_ID_EVIDENCE_TIMEOUT_MS',
    );
    expect(retryResponder).toContain(
      'IOS_AUTH_RETRY_MIN_EVIDENCE_ATTEMPT_BUDGET_MS',
    );
    expect(retryResponder).toContain(
      'The proven iOS Face ID evidence expired before response.',
    );
    expect(retryResponder).toContain(
      'The exact iOS authentication retry ended after its proven Face ID evidence.',
    );
    expect(retryResponder).toContain('attempt=${attempt}');
    expect(retryResponder).toContain('screenshot=${label}.png');
    expect(retryResponder).toContain('vision=${label}-vision.json');
    expect(retryResponder).toMatch(
      /const responseBudget = mobileE2EIosAuthenticationPhaseBudget\([\s\S]+responseBudget === null[\s\S]+--biometricMatch[\s\S]+IOS_AUTH_RETRY_BIOMETRIC_RESPONSE_TIMEOUT_MS/u,
    );
    expect(retryResponder).toContain(
      'await awaitMaestroFlow(retryFlow, evidenceDeadline)',
    );
    expect(retryResponder).toContain(
      'await terminateProcess(retryFlow.process.child)',
    );
    expect(retryResponder).toMatch(
      /catch \(error\)[\s\S]+await terminateProcess\(retryFlow\.process\.child\)[\s\S]+await retryFlow\.process\.completion[\s\S]+throw error/u,
    );
    const retryDriverReadiness = runner.match(
      /async function awaitRetriedIosMaestroDriverReady[\s\S]+?(?=async function respondToDeviceAuthentication)/u,
    )?.[0];
    expect(retryDriverReadiness).toBeDefined();
    expect(retryDriverReadiness).toContain(
      'iosMaestroDriverStatusReady(\n      retryFlow.iosDriverPort',
    );
    expect(retryDriverReadiness).toContain(
      'deadlineMilliseconds: driverReadinessDeadline',
    );
    expect(retryDriverReadiness).toContain('state=fresh-maestro-driver-ready');
    expect(retryDriverReadiness).toContain('`http://127.0.0.1:${port}/status`');
    expect(retryDriverReadiness).toContain("credentials: 'omit'");
    expect(retryDriverReadiness).toContain("redirect: 'error'");
    expect(retryDriverReadiness).toContain("cache: 'no-store'");
    expect(retryDriverReadiness).toContain('response.status === 200');
    expect(retryDriverReadiness).toContain('await response.body?.cancel()');
    expect(retryDriverReadiness).not.toContain(
      'analyzeIosNotificationScreenshot',
    );
    expect(retryDriverReadiness).not.toContain('--biometricMatch');
    expect(flowStarter).toContain('iosDriverStartupTimeoutMilliseconds');
    expect(flowStarter).toContain('MAESTRO_DRIVER_STARTUP_TIMEOUT: String(');
    const screenshotAnalyzer = runner.match(
      /async function analyzeIosNotificationScreenshot[\s\S]+?(?=async function writeIosNotificationRevealFlow)/u,
    )?.[0];
    expect(screenshotAnalyzer).toBeDefined();
    expect(screenshotAnalyzer).toContain('minimumOcrStartBudgetMilliseconds');
    expect(screenshotAnalyzer).toContain(
      'mobileE2EIosAuthenticationPhaseBudget',
    );
    expect(screenshotAnalyzer).toMatch(
      /const analysisTimeout = remainingTimeout\(\s*timing\?\.minimumOcrStartBudgetMilliseconds \?\? 1,?\s*\);[\s\S]+?'xcrun',[\s\S]+?'swift'/u,
    );
    expect(screenshotAnalyzer).toContain(
      'maximumScreenshotTimeoutMilliseconds',
    );
    expect(screenshotAnalyzer).toContain('maximumOcrTimeoutMilliseconds');
    for (const exactBoundary of [
      "- assertVisible: '^Unlock PSD EOC$'",
      "- assertVisible: '^PSD EOC remains locked$'",
      "text: '^Try device unlock again$'",
      'retryTapIfNoChange: false',
      'waitToSettleTimeoutMs: 500',
    ]) {
      expect(retryFlow).toContain(exactBoundary);
    }
    expect(retryFlow.match(/tapOn:/gu)).toHaveLength(1);
    for (const unsafeSelector of [
      'point:',
      'index:',
      'longPressOn:',
      'swipe:',
    ]) {
      expect(retryFlow).not.toContain(unsafeSelector);
    }
  });

  test('retries Android launch auth once and preserves terminal evidence', async () => {
    const [runner, retryFlow] = await Promise.all([
      readFile(new URL('run-ci.ts', import.meta.url), 'utf8'),
      readFile(
        new URL(
          'flows/retry-locked-session-android-pre-auth.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    for (const exactBoundary of [
      "- assertVisible: '^Unlock PSD EOC$'",
      "- assertVisible: '^PSD EOC remains locked$'",
      "- assertVisible: '^PSD EOC could not verify device authentication\\. Try again or contact district technology support\\.$'",
      "text: '^Try device unlock again$'",
      'retryTapIfNoChange: false',
      'waitToSettleTimeoutMs: 500',
    ]) {
      expect(retryFlow).toContain(exactBoundary);
    }
    expect(retryFlow.match(/tapOn:/gu)).toHaveLength(1);
    for (const unsafeSelector of [
      'point:',
      'index:',
      'longPressOn:',
      'swipe:',
    ]) {
      expect(retryFlow).not.toContain(unsafeSelector);
    }
    expect(runner).toMatch(
      /flowName === 'start-synthetic-drill-android'[\s\S]+!retryAttempted[\s\S]+isMobileE2EUnlockRetryReady\(hierarchy\)[\s\S]+retryAttempted = true[\s\S]+retry-locked-session-android-pre-auth/u,
    );
    expect(runner).toMatch(
      /const retryFlow = await startMaestroFlow\([\s\S]+retry-locked-session-android-pre-auth[\s\S]+await awaitMaestroFlow\(retryFlow, deadline\)/u,
    );
    expect(runner).toMatch(
      /androidHierarchySequence \+= 1[\s\S]+psd-eoc-issue32-window-\$\{androidHierarchySequence\}\.xml[\s\S]+if \(dump\.exitCode !== 0\) return ''[\s\S]+result\.exitCode === 0 \? result\.stdout : ''/u,
    );
    expect(runner).toMatch(
      /const capture = await runCommand\([\s\S]+if \(capture\.exitCode === 0\)[\s\S]+if \(pull\.exitCode === 0\)[\s\S]+lstat\(localScreenshot\)[\s\S]+unlink\(localScreenshot\)[\s\S]+remoteScreenshot/u,
    );
    expect(runner).toContain('`device-auth-${flowName}-failure-hierarchy.txt`');
    expect(runner).toContain('`device-auth-${flowName}-failure-prompt.png`');
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
        [
          'Notification List requests executing action com.apple.UNNotificationDefaultActionIdentifier for notification request 71D9-8111',
          'Notification List Completion of action execution for 71D9-8111. didExecute: NO',
          'Notification List removing notification request 71D9-8111 on long look dismissal',
        ].join('\n'),
      ),
    ).toEqual({ valid: false, requestId: null });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        validLog.replace(
          'removing notification request 71D9-8111',
          'removing notification request 71D9-8111 on long look dismissal',
        ),
      ),
    ).toEqual({ valid: false, requestId: null });
    expect(
      mobileE2EIosNotificationActionLogEvidence(
        `${validLog}\nCompletion of action execution for 71D9-8111. didExecute: NO`,
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
