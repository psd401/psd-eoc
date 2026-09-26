import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExpoConfig } from 'expo/config';

import appConfig from '../app.json';
import { withPushProviderConfig } from '../app.config';
import easConfig from '../eas.json';
import packageManifest from '../package.json';

const EAS_PROJECT_ID = '24753a23-d863-41e6-8511-5e44c99fa6c2';
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');

const repositoryText = (path: string): string =>
  readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');

const collectObjectKeys = (
  value: unknown,
  keys = new Set<string>(),
): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return keys;
  }
  if (typeof value !== 'object' || value === null) return keys;

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(child, keys);
  }
  return keys;
};

describe('mobile distribution configuration', () => {
  test('requires protected FCM config only on the remote push-enabled Android build', () => {
    const baseConfig = appConfig.expo as ExpoConfig;

    expect(
      withPushProviderConfig(baseConfig, {
        EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'false',
      }),
    ).toEqual(baseConfig);
    expect(
      withPushProviderConfig(baseConfig, {
        EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'true',
      }),
    ).toEqual(baseConfig);
    expect(
      withPushProviderConfig(baseConfig, {
        EAS_BUILD: 'true',
        EAS_BUILD_PLATFORM: 'ios',
        EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'true',
      }),
    ).toEqual(baseConfig);
    expect(() =>
      withPushProviderConfig(baseConfig, {
        EAS_BUILD: 'true',
        EAS_BUILD_PLATFORM: 'android',
        EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'true',
      }),
    ).toThrow('push-enabled Android build');
    expect(
      withPushProviderConfig(baseConfig, {
        EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'true',
        GOOGLE_SERVICES_JSON: '/protected/google-services.json',
      }).android?.googleServicesFile,
    ).toBe('/protected/google-services.json');
  });

  test('uses remote, monotonically increasing store build numbers', () => {
    expect(easConfig.cli.appVersionSource).toBe('remote');
    expect(easConfig.cli.requireCommit).toBe(true);
    expect(easConfig.build.production.autoIncrement).toBe(true);
    expect(easConfig.build.production.distribution).toBe('store');
    expect(easConfig.build.production.credentialsSource).toBe('remote');
    expect(easConfig.build.production.environment).toBe('production');
  });

  test('ships app/runtime 1.0.17 as embedded-only with no OTA routing', () => {
    expect(appConfig.expo.version).toBe('1.0.17');
    expect(appConfig.expo.runtimeVersion).toEqual({ policy: 'appVersion' });
    expect(appConfig.expo.updates).toEqual({
      enabled: false,
      checkAutomatically: 'NEVER',
      useEmbeddedUpdate: true,
      disableAntiBrickingMeasures: false,
    });
    expect(appConfig.expo.extra.eas.projectId).toBe(EAS_PROJECT_ID);
    expect(JSON.stringify(appConfig.expo.updates)).not.toContain('u.expo.dev');

    expect(Object.keys(easConfig.build).sort()).toEqual([
      'development',
      'preview',
      'production',
    ]);
    expect(easConfig.build.preview.environment).toBe('preview');
    for (const profile of Object.values(easConfig.build)) {
      expect('channel' in profile).toBe(false);
    }
    expect(JSON.stringify(easConfig)).not.toContain('ota-preview');
    expect(JSON.stringify(easConfig)).not.toContain('ota-verification');
  });

  test('pins the complete current Expo SDK 57 compatibility patch set', () => {
    expect(packageManifest.dependencies).toMatchObject({
      expo: '~57.0.23',
      'expo-auth-session': '~57.0.12',
      'expo-constants': '~57.0.18',
      'expo-crypto': '~57.0.3',
      'expo-dev-client': '~57.0.19',
      'expo-file-system': '~57.0.7',
      'expo-image-picker': '~57.0.18',
      'expo-linking': '~57.0.10',
      'expo-location': '~57.0.18',
      'expo-notifications': '~57.0.19',
      'expo-router': '~57.0.21',
      'expo-splash-screen': '~57.0.9',
      'expo-updates': '~57.0.22',
    });
    expect(packageManifest.dependencies['expo-application']).toBe('~57.0.3');
    expect(packageManifest.scripts['expo:check']).toBe(
      'bun scripts/check-expo-compatibility.ts',
    );
    expect(JSON.stringify(packageManifest)).not.toContain('EXPO_OFFLINE');
    expect(JSON.stringify(packageManifest)).not.toContain('install.exclude');
  });

  test('records fail-closed current and prospective remote-update policy', () => {
    expect(packageManifest.psdEocReleasePolicy).toEqual({
      remoteUpdatesEnabledInCurrentRuntime: false,
      remoteUpdatesRequireCodeSigning: true,
      remoteUpdatesReenableRequiresNewAppVersionAndStoreBuild: true,
      storeBuildRequiredChangeKinds: [
        'all-current-runtime-changes',
        'push',
        'auth',
        'native',
        'runtime',
        'persistent-data-shape',
        'start-event',
        'human-only-action',
        'real-drill-classification',
        'live-provider-gate',
      ],
      safetyPathStoreBuildRequiresNewAppVersion: true,
      storeSubmissionRequiresHumanApproval: true,
    });
  });

  test('documents the exact current store profiles and evidence boundaries', () => {
    const release = repositoryText('docs/runbooks/release.md');
    const appStore = repositoryText('docs/runbooks/appstore-setup.md');
    const rollback = repositoryText('docs/runbooks/rollback.md');
    const compact = `${release} ${appStore}`.replace(/\s+/gu, ' ');
    const compactRollback = rollback.replace(/\s+/gu, ' ');

    for (const expected of [
      'EAS `production` build profile',
      'EAS `production` submit profile',
      'EAS `internal` submit profile',
      '`alpha` track and `draft` status',
      'artifact upload',
      'provider processing',
      'private-group exposure',
      'physical installation',
      'in-app launch/readback',
      'push registration',
      'provider handoff',
      'human receipt',
    ]) {
      expect(compact).toContain(expected);
    }
    expect(release).toContain(
      'iOS and Android ship the same app from the same source at the same version.',
    );
    expect(release).toContain('The current app/runtime is 1.0.17');
    // The store record names the exact last submitted build, which trails the
    // current app/runtime whenever a bump has not yet been built.
    expect(release).toContain('1.0.17/build 32 on iOS');
    expect(compactRollback).toContain(
      'The current mobile profiles are embedded-only',
    );
    expect(rollback).toContain(
      'Do not publish, republish, check for, download, or route an OTA update',
    );
    expect(rollback).not.toContain('An OTA rollback may republish');
  });

  test('connects one configured public privacy policy to the mobile app', () => {
    const policy = repositoryText(
      'packages/server/app/(public)/privacy/page.tsx',
    );
    const policyLayout = repositoryText(
      'packages/server/app/(public)/layout.tsx',
    );
    const deployment = repositoryText(
      'packages/server/lib/config/deployment.ts',
    );
    const mobileClient = repositoryText(
      'packages/mobile/src/lib/auth/auth-api-client.ts',
    );
    const signIn = repositoryText('packages/mobile/src/app/(auth)/sign-in.tsx');
    const stack = repositoryText('infra/src/stack/psd-eoc-stack.ts');

    expect(policyLayout).toContain('<html lang="en">');
    expect(policy).toContain('privacyContactUrl()');
    expect(policy).toContain('Student data is outside the scope');
    expect(policy).toContain('Device and notification data');
    expect(policy).toContain('work notification email address or phone number');
    expect(policy).toContain('authorized staff who have not signed in');
    expect(policy).toContain('staff attribution');
    expect(policy).toContain('Service providers');
    expect(policy).toContain('notification title and body');
    expect(policy).toContain('event and facility routing identifiers');
    expect(policy).toContain('Retention and deletion');
    expect(deployment).toContain('PSD_EOC_PRIVACY_CONTACT_URL');
    expect(mobileClient).toContain(
      '`${parseAuthApiBaseUrl(value, allowLoopbackHttp)}/privacy`',
    );
    expect(signIn).toContain('privacyPolicyUrl(');
    expect(signIn).toContain('accessibilityRole="link"');
    expect(stack).toContain('PSD_EOC_PRIVACY_CONTACT_URL');
    expect(`${policy}\n${mobileClient}\n${signIn}`).not.toContain(
      'eoc.psd401.net',
    );
  });

  test('stages Android closed-test submissions as unreleased drafts', () => {
    expect(easConfig.submit.production.android).toEqual({
      track: 'alpha',
      releaseStatus: 'draft',
      changesNotSentForReview: true,
    });
  });

  test('can distribute reviewed Android builds to the existing internal testers', () => {
    expect(easConfig.submit.internal.android).toEqual({
      track: 'internal',
      releaseStatus: 'completed',
      changesNotSentForReview: true,
    });
  });

  test('pins the App Store route', () => {
    expect(easConfig.submit.production.ios).toEqual({
      ascAppId: '6801607849',
    });

    const appStoreRunbook = repositoryText('docs/runbooks/appstore-setup.md');
    expect(appStoreRunbook).toContain('../INTEGRATIONS.md');
    expect(appStoreRunbook).toContain(
      'The presence of `ascAppId` is routing configuration only, never',
    );
  });

  test('never auto-submits, auto-exposes, or publishes a remote update', () => {
    const keys = collectObjectKeys(easConfig);

    expect(keys.has('autoSubmit')).toBe(false);
    expect(keys.has('groups')).toBe(false);
    expect(easConfig.submit.production.ios).toEqual({
      ascAppId: '6801607849',
    });

    const rootManifest = JSON.parse(
      repositoryText('package.json'),
    ) as typeof packageManifest;
    const executableText = [
      ...Object.values(packageManifest.scripts),
      ...Object.values(rootManifest.scripts),
    ];
    for (const directory of ['.github/workflows', '.eas/workflows']) {
      const absoluteDirectory = resolve(REPOSITORY_ROOT, directory);
      if (!existsSync(absoluteDirectory)) continue;
      for (const entry of readdirSync(absoluteDirectory, {
        withFileTypes: true,
      })) {
        if (entry.isFile()) {
          executableText.push(repositoryText(`${directory}/${entry.name}`));
        }
      }
    }

    for (const command of executableText) {
      expect(command).not.toMatch(
        /\b(?:eas|eas-cli(?:@[^\s"']+)?)\s+(?:submit|update(?::[a-z-]+)?)\b/u,
      );
      expect(command).not.toMatch(/--auto-submit\b/u);
      expect(command).not.toMatch(
        /(?:^|\n)\s*(?:-\s*)?type:\s*submit(?:\s|$)/u,
      );
    }
  });

  test('preserves embedded-only device evidence and no runnable OTA operation', () => {
    const readme = repositoryText('packages/mobile/README.md');
    const compactReadme = readme.replace(/\s+/gu, ' ');

    for (const profile of [
      '`development`: internal development-client builds.',
      '`preview`: internal iOS and Android distribution builds.',
      '`production`: store-signed artifacts for TestFlight and Google Play.',
    ]) {
      expect(readme).toContain(profile);
    }
    expect(readme).not.toContain('`ota-preview`:');
    expect(readme).toContain(
      'Remote updates are disabled for app/runtime 1.0.17',
    );
    expect(compactReadme).toContain(
      'Ordinary `preview` must never be used for production-environment OTA verification',
    );
  });

  test('keeps one readiness entry per mobile boundary', () => {
    const integrations = repositoryText('docs/INTEGRATIONS.md');
    const rows = integrations.split('\n');
    // Each boundary has one summary row in the status table and one evidence
    // section headed by its name.
    const rowFor = (boundary: string): string => {
      const start = integrations.indexOf(`### ${boundary}\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextSection = integrations.indexOf('\n### ', start + 1);
      const nextChapter = integrations.indexOf('\n## ', start + 1);
      const end =
        nextSection === -1
          ? nextChapter
          : Math.min(nextSection, nextChapter === -1 ? Infinity : nextChapter);
      return integrations.slice(start, end === -1 ? undefined : end);
    };
    const build = rowFor('EAS Build');
    const update = rowFor('EAS Update');

    expect(build).toContain('Status: `live-verified`');
    expect(build).toContain('iOS build 16');
    expect(build).toContain('Android version code 8');
    expect(update).toContain('Status: `blocked`');
    expect(update).toContain('Remote updates are disabled');
    expect(rowFor('EAS Submit')).toContain('Status: `live-verified`');

    const apple = rowFor('TestFlight device installation');
    const play = rowFor('Google Play device installation');
    expect(apple).toContain('Status: `live-verified`');
    expect(play).toContain('Status: `configured-unverified`');
    expect(apple).toContain('1.0.7/build 17');
    expect(apple).toContain('internal tester group');
    expect(apple).toContain('automatic distribution enabled');
    // Internal distribution needs no Beta App Review, so no review state is
    // claimed for the current build; the external-group review state recorded
    // for 1.0.5/build 12 was not re-observed for 1.0.6.
    expect(apple).toContain('requires no Beta App Review');
    expect(apple).toContain(
      'No in-app Release diagnostic readback or notification observation is retained',
    );
    expect(play).toContain('1.0.7/code 9');
    expect(play).toContain('Alpha Closed-testing draft');
    const privacy = rowFor('Public mobile privacy policy');
    expect(privacy).toContain('Status: `live-verified`');
    expect(privacy).toContain("configured production origin's `/privacy`");
    expect(privacy).toContain('returned HTTP 200');
    // The store record left `blocked` on 2026-09-22 when the declarations were
    // sent for review, and became live-verified on 2026-09-26 when Google
    // published release 24 (1.0.17). Matched against collapsed whitespace,
    // because Prettier rewraps this prose whenever a sentence changes length.
    const storeRecord = rowFor('Play app content and store record');
    const compactStoreRecord = storeRecord.replace(/\s+/gu, ' ');
    expect(storeRecord).toContain('Status: `live-verified`');
    expect(compactStoreRecord).toContain(
      '"24 (1.0.17) - Available on Google Play - Released on Sep 26 6:09 AM"',
    );
    expect(compactStoreRecord).toContain(
      'Prior evidence: on 2026-08-26 Play showed 8/11 setup tasks complete',
    );

    for (const boundary of ['EAS Build', 'EAS Update', 'EAS Submit']) {
      expect(rows.filter((line) => line === `### ${boundary}`)).toHaveLength(1);
      expect(
        rows.filter((line) =>
          new RegExp(`^\\| ${boundary}\\s+\\|`, 'u').test(line),
        ),
      ).toHaveLength(1);
    }
    expect(integrations).not.toContain('e68d07aa-98e5-4c87-8595-52175975291f');
  });

  test('ships accessible screen references and safe staff guidance', () => {
    const guides = [
      repositoryText('docs/guides/install-ios.md'),
      repositoryText('docs/guides/install-android.md'),
    ];
    const assets = [
      'ios-testflight-install.svg',
      'ios-notifications-focus.svg',
      'android-play-install.svg',
      'android-notifications-dnd.svg',
    ];

    for (const guide of guides) {
      const compactGuide = guide.replace(/^>\s?/gmu, '').replace(/\s+/gu, ' ');
      expect(guide).toContain('Do not start an incident or drill just to test');
      expect(compactGuide).toContain(
        'A push is **not required** to prove installation',
      );
      expect(compactGuide).toContain('authorizes installation only');
      expect(compactGuide).toContain(
        'approved bounded synthetic staff-context push-registration verification',
      );
      expect(compactGuide).toContain(
        'stop after **Install** and do not open or sign in',
      );
      expect(compactGuide).toContain(
        'may obtain a push token, contact Expo, and register the device with PSD EOC',
      );
      expect(compactGuide).toContain(
        'Registration does not send a notification, but it does change provider and server registration state',
      );
      expect(compactGuide).toContain(
        'Only after District Technology gives the separate registration confirmation above',
      );
      expect(compactGuide).toContain('Otherwise stop after **Install**');
      expect(compactGuide).toContain(
        'Only after the separate registration confirmation above',
      );
      expect(compactGuide).toContain(
        'complete these no-notification-send checks',
      );
      expect(compactGuide).toContain('open **Release diagnostics**');
      expect(compactGuide).toContain('**Native build version**');
      expect(compactGuide).toContain('**Identity available**');
      expect(guide).toContain(
        '## Optional separately authorized synthetic push check',
      );
      expect(guide).toContain('Skip this section unless District Technology');
      expect(guide).toContain('Scheduling the window does not');
      expect(guide).toContain('authenticated human must freshly');
      expect(compactGuide).toContain(
        'not provider screenshots or install proof',
      );
      expect(compactGuide).toContain(
        'confirm district sign-in succeeds, and confirm the visible authorized site list is correct',
      );
      expect(compactGuide).not.toContain('expected staff name');
      expect(guide).toMatch(/Deleting\s+the app alone does not prove/u);
      expect(compactGuide).toContain(
        'canonical **`[DRILL]`** transport marker',
      );
      expect(compactGuide).toContain('**TEST — NOT A REAL INCIDENT**');
      expect(compactGuide).toContain('**`[INCIDENT]`**');
      expect(compactGuide).toContain('omits **`[DRILL]`**');
      expect(compactGuide).toContain('conflicting markers');
      expect(compactGuide).toContain('uses real-incident wording');
      expect(compactGuide).toContain('generic wording such as **TEST ONLY**');
      expect(compactGuide).toContain(
        'opened event does not visibly say **TEST — NOT A REAL INCIDENT**',
      );
      expect(compactGuide).toContain('**DRILL — TRAINING ONLY**');
      expect(compactGuide).toContain('## Use event collaboration safely');
      expect(compactGuide).toContain('server strips EXIF and GPS metadata');
      expect(compactGuide).toContain(
        'appends a linked entry; it never rewrites or deletes the original',
      );
      expect(compactGuide).not.toContain(
        'continues to show **`[DRILL]`** on the opened event content',
      );
      expect(guide.indexOf('## Verify the installation safely')).toBeLessThan(
        guide.indexOf('## Optional separately authorized synthetic push check'),
      );
    }
    expect(guides.join('\n')).not.toContain('Peninsula School District');
    expect(guides[0]).toContain('Time Sensitive Notifications');
    expect(guides[0]).toContain('does **not** have');
    expect(guides[1]).toContain('PSD EOC incident and drill alerts');
    expect(guides[1]).toContain('Do Not Disturb');

    for (const asset of assets) {
      const path = resolve(
        REPOSITORY_ROOT,
        'docs/guides/assets/issue-33',
        asset,
      );
      expect(existsSync(path)).toBe(true);
      const svg = readFileSync(path, 'utf8');
      expect(svg).toContain('role="img"');
      expect(svg).toContain('<title');
      expect(svg).toContain('<desc');
      expect(guides.some((guide) => guide.includes(asset))).toBe(true);
    }

    const iosInstallAsset = repositoryText(
      'docs/guides/assets/issue-33/ios-testflight-install.svg',
    );
    const androidInstallAsset = repositoryText(
      'docs/guides/assets/issue-33/android-play-install.svg',
    );
    expect(iosInstallAsset).toContain(
      `>Version ${appConfig.expo.version}</text>`,
    );
    for (const installAsset of [iosInstallAsset, androidInstallAsset]) {
      expect(installAsset).toContain('Stop after Install unless');
      expect(installAsset).toContain('registration is separately');
      expect(installAsset).toContain('approved by District Technology.');
    }
    expect(iosInstallAsset).not.toContain('Install and open');
    expect(iosInstallAsset).not.toContain('After installation, tap Open');
    expect(iosInstallAsset).not.toContain('sign in with your district');
    expect(androidInstallAsset).not.toContain('Open PSD EOC, sign in');
    expect(androidInstallAsset).not.toContain('allow notifications when asked');
  });
});
