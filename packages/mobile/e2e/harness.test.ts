import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expoDevelopmentClientUrl,
  IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS,
  mobileE2EIdentity,
  requireSyntheticMobileE2E,
  shouldRetryIosDevelopmentClientOpen,
} from './harness';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('issue-32 mobile E2E harness', () => {
  test('derives each application identity and local development URL from app.json', async () => {
    const config = await Bun.file(resolve(mobileRoot, 'app.json')).json();
    const ios = mobileE2EIdentity(config, 'ios');
    const android = mobileE2EIdentity(config, 'android');
    expect(ios.appId.length).toBeGreaterThan(3);
    expect(android.appId.length).toBeGreaterThan(3);
    expect(ios.developmentScheme).toBe(`exp+${config.expo.slug}`);
    expect(
      expoDevelopmentClientUrl(ios.developmentScheme, 'http://127.0.0.1:8081'),
    ).toStartWith(`${ios.developmentScheme}://expo-development-client/`);
    expect(() =>
      expoDevelopmentClientUrl(ios.scheme, 'https://example.com'),
    ).toThrow('local machine');
  });

  test('requires every provider-free safety flag', () => {
    const safe = {
      PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
      EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE: 'issue-21',
      EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE: 'issue-32',
      EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE: 'issue-32',
      EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'false',
    };
    expect(() => requireSyntheticMobileE2E(safe)).not.toThrow();
    for (const key of Object.keys(safe)) {
      expect(() =>
        requireSyntheticMobileE2E({ ...safe, [key]: 'unsafe' }),
      ).toThrow('exact synthetic fixtures');
    }
  });

  test('retries only the bounded iOS simulator URL-open timeout', () => {
    expect(IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS).toBe(3);
    expect(shouldRetryIosDevelopmentClientOpen(60, 1)).toBe(true);
    expect(shouldRetryIosDevelopmentClientOpen(60, 2)).toBe(true);
    expect(shouldRetryIosDevelopmentClientOpen(60, 3)).toBe(false);
    expect(shouldRetryIosDevelopmentClientOpen(1, 1)).toBe(false);
  });

  test('keeps every Maestro flow config-derived and synthetic-guarded', async () => {
    const flowRoot = resolve(mobileRoot, 'e2e/flows');
    const flowNames = (await readdir(flowRoot))
      .filter((name) => name.endsWith('.yaml'))
      .sort();
    expect(flowNames).toEqual([
      'activation-result.yaml',
      'event-room-lifecycle.yaml',
      'open-push-android.yaml',
      'open-push-ios.yaml',
      'prepare-ios.yaml',
      'push-opened-event-room.yaml',
      'reveal-push-ios.yaml',
      'start-drill.yaml',
    ]);
    for (const flowName of flowNames) {
      const flow = await Bun.file(resolve(flowRoot, flowName)).text();
      expect(flow).toStartWith(
        flowName === 'open-push-ios.yaml' || flowName === 'reveal-push-ios.yaml'
          ? 'appId: ${SYSTEM_APP_ID}\n'
          : 'appId: ${APP_ID}\n',
      );
      expect(flow).toContain('PSD_EOC_E2E_SYNTHETIC_ONLY');
      expect(flow).not.toMatch(/^appId: [a-z0-9_.-]+$/mu);
    }

    const start = await Bun.file(resolve(flowRoot, 'start-drill.yaml')).text();
    expect(start).toContain(
      "visible: 'Continue|Close|Synthetic test mode\\. Synthetic recipients only\\. No live provider sends\\.'",
    );
    expect(start).toContain("text: '^Continue$'");
    expect(start).toContain("id: 'xmark'");
    expect(start).toContain('platform: iOS');
    expect(start).toContain('platform: Android');
    expect(start).toContain("text: '^Close$'");
    expect(start).toContain("notVisible: 'Continue|Close'");
    expect(start).toContain('timeout: 90000');
    expect(start).toContain(
      "- tapOn: 'DRILL — TRAINING ONLY. Run practice drill at Synthetic Test School'",
    );
    expect(start.match(/id: 'issue-21-drill-event-type'/gu)).toHaveLength(2);
    expect(start).toContain(
      "- tapOn: 'Start a separate DRILL — TRAINING ONLY and notify 2 synthetic recipients'",
    );
    expect(start).toContain(
      "element:\n      text: 'Start a separate DRILL — TRAINING ONLY and notify 2 synthetic recipients'\n    direction: DOWN",
    );
    expect(start).not.toContain("element:\n      id: 'issue-21-confirm-drill'");
    expect(start).toContain('- runFlow: activation-result.yaml');
    expect(start).not.toContain("visible: 'Allow'");
    const activationResult = await Bun.file(
      resolve(flowRoot, 'activation-result.yaml'),
    ).text();
    expect(activationResult).toContain("text: 'Allow'");
    expect(activationResult).toContain('waitUntilVisible: true');
    expect(activationResult).toContain('optional: true');
    expect(activationResult).toContain(
      'Synthetic earthquake drill. Threat: Synthetic wildlife. Synthetic Test School, SYNTH.',
    );
    expect(activationResult).not.toContain("id: 'issue-21-activation-result'");
    const iosNotification = await Bun.file(
      resolve(flowRoot, 'open-push-ios.yaml'),
    ).text();
    expect(iosNotification).toStartWith('appId: ${SYSTEM_APP_ID}\n');
    expect(iosNotification).toContain('start: 50%, 83%');
    expect(iosNotification).toContain('end: 95%, 83%');
    expect(iosNotification).toContain('point: 15%, 83%');
    expect(iosNotification).toContain('duration: 700');
    expect(iosNotification).not.toContain('launchApp');
    expect(iosNotification).not.toContain("visible: 'Open event'");
    expect(iosNotification).toContain(
      'Synthetic earthquake drill. Threat: Synthetic wildlife. Synthetic Test School, SYNTH.',
    );
    const openedEventRoom = await Bun.file(
      resolve(flowRoot, 'push-opened-event-room.yaml'),
    ).text();
    expect(openedEventRoom).toContain(
      "visible: 'Synthetic earthquake drill. Threat: Synthetic wildlife. Synthetic Test School, SYNTH.'",
    );
    expect(openedEventRoom).toContain("assertNotVisible: '^REAL INCIDENT$'");
    const iosReveal = await Bun.file(
      resolve(flowRoot, 'reveal-push-ios.yaml'),
    ).text();
    expect(iosReveal).toStartWith('appId: ${SYSTEM_APP_ID}\n');
    expect(iosReveal).toContain('start: 25%, 1%');
    expect(iosReveal).toContain('start: 50%, 1%');
    expect(iosReveal).toContain('start: 35%, 1%');
    expect(iosReveal).toContain("notVisible: '.*Synthetic recipients only.*'");
    expect(iosReveal.match(/end: (25|35|50)%, (80|85|90)%/gu)).toHaveLength(3);
    const lifecycle = await Bun.file(
      resolve(flowRoot, 'event-room-lifecycle.yaml'),
    ).text();
    expect(lifecycle).toContain('Synthetic mobile issue 32 update.');
    expect(lifecycle).toContain(
      "element:\n      text: '.*Synthetic mobile issue 32 update.*'\n    direction: UP",
    );
    // Ending an event is one confirmed action with no phrase to type, so the
    // flow neither types one nor reaches a second lifecycle step.
    expect(lifecycle).not.toContain('lifecycle-confirmation-input');
    expect(lifecycle).toContain("visible: 'Status: closed'");
    expect(lifecycle).not.toContain('Finish ending the event');

    const syntheticFixture = await Bun.file(
      resolve(mobileRoot, 'src/lib/start/issue-21-synthetic-fixture.ts'),
    ).text();
    const preloadIndex = syntheticFixture.indexOf(
      'preloadIssue32SyntheticPush()',
    );
    const activationIndex = syntheticFixture.indexOf(
      "input.path === '/api/mobile/start/activate'",
    );
    expect(preloadIndex).toBeGreaterThan(-1);
    expect(activationIndex).toBeGreaterThan(preloadIndex);
    expect(syntheticFixture).toContain("kind: 'failed' as const");

    const syntheticPush = await Bun.file(
      resolve(mobileRoot, 'src/lib/start/issue-32-synthetic-push.ts'),
    ).text();
    expect(syntheticPush).toContain("platform === 'android'");
    expect(syntheticPush).toContain('permissions.getPermissionsAsync()');
    expect(syntheticFixture).toContain(
      'scheduleIssue32SyntheticPush(\n              result.event,\n              platform,',
    );

    const runner = await Bun.file(resolve(mobileRoot, 'e2e/run.ts')).text();
    expect(runner).toContain('childEnvironment.ANDROID_SERIAL = deviceId');
    expect(runner).toContain("'run:android',\n          '--device'");
    expect(runner).toContain("'emu', 'avd', 'name'");
    expect(runner).not.toContain("await maestro('activation-result.yaml')");
    expect(runner).toContain("const metroUrl = 'http://127.0.0.1:8081'");
    expect(runner).toContain("'simctl', 'launch', deviceId, appId");
    expect(runner).toContain('await openIosDevelopmentClient');
    expect(runner).toContain(
      "await maestro('reveal-push-ios.yaml');\n    await maestro('open-push-ios.yaml');",
    );
    expect(runner).not.toContain(
      "await maestro('open-push-ios.yaml');\n    await openIosDevelopmentClient",
    );
    expect(
      runner.match(/`\$\{identity\.appId\}\/\.MainActivity`/gu),
    ).toHaveLength(2);
    expect(runner).toContain("'start',\n      '-W',\n      '-n'");
    expect(runner).not.toContain('android.intent.category.BROWSABLE');
    expect(runner).toContain("await maestro('push-opened-event-room.yaml')");
    expect(runner).toContain('iOS mobile E2E cannot skip the native build');
    expect(runner).not.toContain('http://10.0.2.2:8081');
    expect(runner.indexOf('const childEnvironment')).toBeLessThan(
      runner.indexOf('requireSyntheticMobileE2E(childEnvironment)'),
    );

    const workflow = await Bun.file(
      resolve(mobileRoot, '../../.github/workflows/mobile-e2e.yml'),
    ).text();
    expect(workflow).toContain('-Dorg.gradle.jvmargs=-Xmx4096m');
    expect(workflow).toContain('-Dorg.gradle.workers.max=2');
    expect(workflow).toContain('--project-dir android');
    expect(workflow).toContain('-PreactNativeArchitectures=x86_64');
    expect(workflow).toContain('--no-daemon');
    expect(workflow).not.toContain('--build-cache');
    expect(workflow).toContain(
      'cp android/app/build/outputs/apk/debug/app-debug.apk',
    );
    expect(workflow).toContain('rm -rf -- android');
    expect(workflow).toContain(
      'android_apk="$RUNNER_TEMP/psd-eoc-mobile-e2e.apk"',
    );
    expect(workflow).toContain('adb install -r "$android_apk"');
    expect(workflow).toContain("PSD_EOC_MOBILE_E2E_SKIP_NATIVE_BUILD: 'true'");
    expect(workflow.indexOf('app:assembleDebug')).toBeLessThan(
      workflow.indexOf('Create an Android 35 emulator'),
    );
    expect(
      workflow.indexOf('"$sdkmanager_bin" --install platform-tools'),
    ).toBeLessThan(workflow.indexOf('available_kib='));
    expect(workflow.indexOf('available_kib=')).toBeLessThan(
      workflow.indexOf('-avd issue32_api35'),
    );
  });
});
