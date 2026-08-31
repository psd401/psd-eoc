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

  test('ships app/runtime 1.0.6 as embedded-only with no OTA routing', () => {
    expect(appConfig.expo.version).toBe('1.0.6');
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
      expo: '~57.0.16',
      'expo-auth-session': '~57.0.9',
      'expo-constants': '~57.0.14',
      'expo-crypto': '~57.0.2',
      'expo-dev-client': '~57.0.15',
      'expo-file-system': '~57.0.5',
      'expo-image-picker': '~57.0.13',
      'expo-linking': '~57.0.7',
      'expo-location': '~57.0.13',
      'expo-notifications': '~57.0.14',
      'expo-router': '~57.0.16',
      'expo-splash-screen': '~57.0.8',
      'expo-updates': '~57.0.17',
    });
    expect(packageManifest.dependencies['expo-application']).toBe('~57.0.2');
    expect(packageManifest.scripts['expo:check']).toBe('expo install --check');
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
    expect(release).toContain('The current app/runtime is 1.0.6');
    // The store record stays factual: 1.0.6 is not installable until it is
    // built and submitted.
    expect(release).toContain('1.0.5/build 12 on iOS');
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

  test('pins the App Store route while archiving one-off provider evidence', () => {
    expect(easConfig.submit.production.ios).toEqual({
      ascAppId: '6801607849',
    });

    const appStoreRunbook = repositoryText('docs/runbooks/appstore-setup.md');
    const archivedRelease = repositoryText(
      'docs/archive/runbooks/release-2026-08-25.md',
    );
    expect(appStoreRunbook).toContain('../INTEGRATIONS.md');
    expect(appStoreRunbook).toContain(
      'The presence of `ascAppId` is routing configuration only, never',
    );
    for (const evidence of [
      'e68d07aa-98e5-4c87-8595-52175975291f',
      '7c22776b959bb8f015f077b8fc73247b005b298ae97e18240d50aea77432adb9',
      'Failed',
      '90683',
    ]) {
      expect(archivedRelease).toContain(evidence);
    }
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

  test('preserves the exact historical build and distribution evidence', () => {
    const release = repositoryText(
      'docs/archive/runbooks/release-2026-08-25.md',
    );
    const normalizedRelease = release.replace(/\\\n\s*/gu, ' ');
    const compactRelease = normalizedRelease.replace(/\s+/gu, ' ');
    const releaseBuildCommands = normalizedRelease
      .split('\n')
      .filter((line) => line.includes('build --platform'));
    const iosBuildRecordStart = compactRelease.indexOf(
      'The one approved iOS BUILD then completed',
    );
    const iosBuildRecordEnd = compactRelease.indexOf(
      '## 3. Version/build automation and commands',
      iosBuildRecordStart,
    );

    expect(iosBuildRecordStart).toBeGreaterThanOrEqual(0);
    expect(iosBuildRecordEnd).toBeGreaterThan(iosBuildRecordStart);
    const iosBuildRecord = compactRelease.slice(
      iosBuildRecordStart,
      iosBuildRecordEnd,
    );

    expect(release).toContain(
      'env:list production --scope project --format long',
    );
    expect(release).toContain(
      'env:list production --scope account --format long',
    );
    expect(compactRelease).toContain(
      'bunx eas-cli@21.7.0 env:exec production \'test "$EXPO_PUBLIC_PSD_EOC_API_BASE_URL" = "https://eoc.psd401.net" && test "$EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED" = "true"\' --non-interactive',
    );
    expect(release).not.toContain('env:exec production --non-interactive --');
    expect(release).not.toContain("sh -c 'test");
    expect(release).toContain(
      'test "$EXPO_PUBLIC_PSD_EOC_API_BASE_URL" = "https://eoc.psd401.net"',
    );
    expect(release).toContain(
      'test "$EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED" = "true"',
    );
    expect(compactRelease).toContain('no account-scope value with that name');
    expect(compactRelease).toContain(
      'BUILD approval alone does not authorize installation, sign-in, registration, provider testing, or any notification',
    );
    expect(release).toContain(
      'build:version:get --platform ios --profile production --json',
    );
    expect(release).toContain(
      'build:version:get --platform android --profile production --json',
    );
    expect(releaseBuildCommands).toHaveLength(2);
    for (const command of releaseBuildCommands) {
      expect(command).toContain('--non-interactive --freeze-credentials');
    }
    expect(release).toContain('does not reliably apply');
    expect(release).toContain('source-upload/build-job');
    expect(release).toContain('quota/cost state');
    expect(release).toContain('Never use `--latest`, `--auto-submit`');

    expect(release).toContain('walkthrough not recorded');
    expect(compactRelease).toContain(
      'current SVGs are illustrated advance references, not provider screenshots',
    );
    expect(compactRelease).toContain(
      'Do not fabricate or relabel an illustration as provider evidence',
    );
    expect(release).toContain('product-owner sign-off not recorded');
    expect(release).toContain('Play app `4972493736740021045` exists');
    expect(release).toContain('Internal draft release 1');
    expect(release).toContain('4860219896995172827');
    expect(compactRelease).toContain(
      'SUPERSEDED — NOT ELIGIBLE FOR PLAY UPLOAD, TESTER EXPOSURE, OR INSTALLATION',
    );
    expect(release).toContain('3742b81d-3942-4fea-b760-53c809d8733f');
    expect(release).toContain(
      '915247b2a3c4c7eb97d685dd04e8886cf93f6caed24d605ac9991166faa64246',
    );
    expect(release).toContain('71e08fa8358f6890e5419289b163aaa0fb0af081');
    expect(release).toContain('version code: `3`');
    for (const evidence of [
      'EAS build: `e68d07aa-98e5-4c87-8595-52175975291f`',
      'source: `bef4d64b40508dd3ef60e4de190a53b23effce40`',
      'EAS status/profile/distribution: `FINISHED` / `production` / `STORE`',
      'bundle ID: `net.psd401.eoc`',
      'application/runtime version: `1.0.1` / `1.0.1`',
      'build number: `2`; the remote counter read back `1` before and `2` after',
      'IPA SHA-256: `7c22776b959bb8f015f077b8fc73247b005b298ae97e18240d50aea77432adb9`',
      'existing distribution certificate serial: `6C578391C0F8BD2C1E2E570FED205DED`',
      'App Store provisioning profile: `U8P2YKU4T8`; SHA-256 `c13a2847c944d0b0f25ba007ca06142c8218d87232ad9d36d1c86726355c1fde`',
      'EAS usage changed from 5/30 total and 1/15 iOS before the sole build to 6/30 total and 2/15 iOS afterward; current estimated total cost is `$0`',
    ]) {
      expect(iosBuildRecord).toContain(evidence);
    }
    expect(release).toContain('existing Ad Hoc profile `525SSPSUMQ`');
    expect(iosBuildRecord).toContain(
      'marked version 1.0.1/build 2 **Failed** with error 90683',
    );
    expect(iosBuildRecord).toContain(
      'A 1.0.4 replacement BUILD and later upload remain pending separate fresh approvals',
    );
    expect(compactRelease).toContain(
      'Before the iOS BUILD, a separate provider-configuration gate was previewed, explicitly approved by the product owner for one exact write, confirmed by the authenticated human operator, and independently read back',
    );
    expect(compactRelease).toContain(
      'BUILD began only after its read-back matched and a later exact one-build preview received its own product-owner approval',
    );
    expect(release).not.toContain('EXPECTED — NOT PROVEN');
    expect(release).toContain('856e54b5-9abd-45a5-b0db-809a295da5ef');
    expect(release).toContain(
      '015911fa614ba7b264f71a5f3186ab9c86940f94b98d77861b2864a761506463',
    );
    expect(compactRelease).toContain('human install evidence');
    expect(compactRelease).toContain(
      'Provider inventory alone is not installed-device evidence',
    );
  });

  test('preserves embedded-only device evidence and no runnable OTA operation', () => {
    const release = repositoryText(
      'docs/archive/runbooks/release-2026-08-25.md',
    );
    const readme = repositoryText('packages/mobile/README.md');
    const compactRelease = release.replace(/\s+/gu, ' ');
    const compactReadme = readme.replace(/\s+/gu, ' ');

    for (const evidence of [
      'Remote updates: `Disabled — embedded store bundle only`',
      'Launch source: `Embedded in this installed binary`',
      'Remote update ID: `Not applicable — remote updates disabled`',
      'Configured runtime version: the same exact installed application version',
      'Remote update channel: `Not applicable — remote updates disabled`',
      'Emergency launch: `No`',
    ]) {
      expect(release).toContain(evidence);
    }

    expect(compactRelease).toContain(
      'Remote updates are **blocked for current app/runtime 1.0.4**',
    );
    expect(compactRelease).toContain(
      'district-held code-signing public certificate embedded in a new app version/runtime',
    );
    expect(compactRelease).toContain(
      'private-key custody, rotation, recovery, and audit outside every repository',
    );
    expect(compactRelease).toContain(
      'No executable OTA command is provided until the separately scoped signing and routing controls exist',
    );
    expect(compactRelease).toContain(
      'For the first release, record `no prior known-good build` and fix forward',
    );
    expect(compactRelease).toContain(
      'stores cannot force-remove installed bytes',
    );
    expect(release).not.toMatch(
      /bunx\s+eas-cli@21\.7\.0\s+update(?::[a-z-]+)?\b/u,
    );
    expect(release).not.toContain('--channel');

    for (const profile of [
      '`development`: internal development-client builds.',
      '`preview`: internal iOS and Android distribution builds.',
      '`production`: store-signed artifacts for TestFlight and Google Play.',
    ]) {
      expect(readme).toContain(profile);
    }
    expect(readme).not.toContain('`ota-preview`:');
    expect(readme).toContain(
      'Remote updates are disabled for app/runtime 1.0.6',
    );
    expect(compactReadme).toContain(
      'Ordinary `preview` must never be used for production-environment OTA verification',
    );
  });

  test('preserves the historical progressive-gate evidence', () => {
    const release = repositoryText(
      'docs/archive/runbooks/release-2026-08-25.md',
    );
    const compactRelease = release.replace(/\s+/gu, ' ');
    const headings = [
      '### BUILD',
      '### SUBMIT',
      '### TESTER EXPOSURE',
      '### FINAL ACCEPTANCE',
    ];
    const headingOffsets = headings.map((heading) => release.indexOf(heading));

    expect(headingOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(headingOffsets).toEqual([...headingOffsets].sort((a, b) => a - b));
    expect(release).toContain(
      'Approval for one gate never authorizes another.',
    );
    expect(release).toMatch(
      /Every write requires\s+a fresh exact consequence preview, explicit product-owner approval, and fresh\s+confirmation by the authorized human operator/u,
    );
    expect(release).toMatch(
      /Tester exposure authorizes installation only\. It does not authorize a\s+PSD EOC notification/u,
    );
    for (const prerequisite of [
      'verified credentials',
      'an approved synthetic target list',
      'a consequence preview',
      'explicit product-owner authorization',
      'authenticated-human confirmation',
    ]) {
      expect(compactRelease).toContain(prerequisite);
    }
    expect(release).toMatch(
      /FINAL ACCEPTANCE is a read-only human evidence decision, not a provider-write\s+authorization/u,
    );
    expect(compactRelease).toContain(
      'Product-owner sign-off is never inferred or supplied by an agent or automation',
    );
    expect(release).toMatch(
      /FINAL ACCEPTANCE does not itself authorize go-live,\s+production deployment, provider configuration, a real incident, a real\s+notification, an all-clear, or closing a real event/u,
    );
  });

  test('keeps one concise readiness row per mobile boundary', () => {
    const integrations = repositoryText('docs/INTEGRATIONS.md');
    const rows = integrations.split('\n');
    const rowFor = (boundary: string): string | undefined =>
      rows.find((line) => line.includes(`| ${boundary}`));
    const build = rowFor('EAS Build');
    const update = rowFor('EAS Update');

    expect(build).toContain('| `live-verified`');
    expect(build).toContain('iOS build 12');
    expect(build).toContain('Android version code 6');
    expect(update).toContain('| `blocked`');
    expect(update).toContain('Remote updates are disabled');
    expect(rowFor('EAS Submit')).toContain('| `live-verified`');

    const apple = rowFor('TestFlight device installation');
    const play = rowFor('Google Play device installation');
    expect(apple).toContain('| `live-verified`');
    expect(play).toContain('| `configured-unverified`');
    expect(apple).toContain('1.0.5/build 12');
    expect(apple).toContain('internal tester group');
    expect(apple).toContain('automatic distribution enabled');
    expect(apple).toContain('`Waiting for Review`');
    expect(apple).toContain(
      'No in-app Release diagnostic readback, push registration, or notification observation is retained',
    );
    expect(play).toContain('1.0.5/code 6');
    expect(play).toContain('saved in the existing Alpha Closed-testing draft');
    const privacy = rowFor('Public mobile privacy policy');
    expect(privacy).toContain('| `live-verified`');
    expect(privacy).toContain("configured production origin's `/privacy`");
    expect(privacy).toContain('returned HTTP 200');
    expect(rowFor('Play app content and store record')).toContain(
      '| `blocked`',
    );
    expect(rowFor('Play app content and store record')).toContain(
      '8/11 setup tasks complete',
    );
    expect(rowFor('Play app content and store record')).toContain(
      'Data Safety is fully answered and saved as a draft',
    );

    expect(rows.filter((line) => line.includes('| EAS Build'))).toHaveLength(1);
    expect(rows.filter((line) => line.includes('| EAS Update'))).toHaveLength(
      1,
    );
    expect(rows.filter((line) => line.includes('| EAS Submit'))).toHaveLength(
      1,
    );
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
