import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import appConfig from '../app.json';
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
  test('uses remote, monotonically increasing store build numbers', () => {
    expect(easConfig.cli.appVersionSource).toBe('remote');
    expect(easConfig.cli.requireCommit).toBe(true);
    expect(easConfig.build.production.autoIncrement).toBe(true);
    expect(easConfig.build.production.distribution).toBe('store');
    expect(easConfig.build.production.credentialsSource).toBe('remote');
  });

  test('isolates ordinary preview, OTA verification, and production updates', () => {
    expect(easConfig.build.preview.channel).toBe('preview');
    expect(easConfig.build.preview.environment).toBe('preview');
    expect(easConfig.build['ota-preview'].channel).toBe('ota-verification');
    expect(easConfig.build['ota-preview'].environment).toBe('production');
    expect(easConfig.build['ota-preview'].distribution).toBe('internal');
    expect(easConfig.build.production.channel).toBe('production');
    expect(easConfig.build.production.environment).toBe('production');
    expect(
      new Set([
        easConfig.build.preview.channel,
        easConfig.build['ota-preview'].channel,
        easConfig.build.production.channel,
      ]).size,
    ).toBe(3);

    expect(appConfig.expo.updates).toEqual({
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      useEmbeddedUpdate: true,
      disableAntiBrickingMeasures: false,
    });
    expect(appConfig.expo.extra.eas.projectId).toBe(EAS_PROJECT_ID);
    expect(appConfig.expo.runtimeVersion).toEqual({ policy: 'appVersion' });
    expect(packageManifest.dependencies['expo-updates']).toBe('~57.0.13');
  });

  test('stages Android closed-test submissions as unreleased drafts', () => {
    expect(easConfig.submit.production.android).toEqual({
      track: 'alpha',
      releaseStatus: 'draft',
      changesNotSentForReview: true,
    });
  });

  test('never auto-submits a build or auto-assigns a TestFlight group', () => {
    const keys = collectObjectKeys(easConfig);

    expect(keys.has('autoSubmit')).toBe(false);
    expect(keys.has('groups')).toBe(false);
    expect(easConfig.submit.production.ios).toEqual({});

    const rootManifest = JSON.parse(
      repositoryText('package.json'),
    ) as typeof packageManifest;
    const commands = [
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
          commands.push(repositoryText(`${directory}/${entry.name}`));
        }
      }
    }

    for (const command of commands) {
      expect(command).not.toMatch(
        /\b(?:eas|eas-cli(?:@[^\s"']+)?)\s+(?:submit|update(?::[a-z-]+)?)\b/u,
      );
      expect(command).not.toMatch(/--auto-submit\b/u);
      expect(command).not.toMatch(
        /(?:^|\n)\s*(?:-\s*)?type:\s*submit(?:\s|$)/u,
      );
    }
  });

  test('records the human-reviewed OTA and store-build classification policy', () => {
    expect(packageManifest.psdEocReleasePolicy).toEqual({
      otaAllowedChangeKinds: [
        'copy-layout-style',
        'javascript-bugfix-existing-contract',
      ],
      storeBuildRequiredChangeKinds: [
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
      otaRequiresDedicatedVerificationChannel: true,
      otaVerificationBuildProfile: 'ota-preview',
      otaVerificationChannel: 'ota-verification',
      otaPublishEnvironment: 'production',
      safetyPathStoreBuildRequiresNewAppVersion: true,
      storeSubmissionRequiresHumanApproval: true,
    });
  });

  test('keeps release evidence blocked until humans prove distribution', () => {
    const release = repositoryText('docs/runbooks/release.md');

    expect(release).toContain('no human install evidence recorded');
    expect(release).toContain('walkthrough not recorded');
    expect(release).toContain('product-owner sign-off not recorded');
    expect(release).toContain('EXPO_PUBLIC_PSD_EOC_API_BASE_URL');
    expect(release).toContain('https://eoc.psd401.net');
    expect(release).toContain('a conflicting account-level value');
    expect(release).toContain('--channel ota-verification');
    expect(release).toContain('after the second cold launch');
    expect(release).toContain('adoption remains `unknown`');
    expect(release).not.toContain('--channel preview');
    expect(release).toMatch(/blocks\s+non-interactive submission/u);
    expect(release).toMatch(
      /do not use interactive submission to create or select an app\s+implicitly/u,
    );
    expect(release).toContain('Never use `--latest`, `--auto-submit`');
    expect(release).toContain('Start-event confirmation');
    expect(release).toContain(
      'New store build and app version plus safety-path evidence',
    );
  });

  test('fails closed on EAS environment, routing, credentials, and internal access', () => {
    const release = repositoryText('docs/runbooks/release.md');
    const readme = repositoryText('packages/mobile/README.md');
    const normalizedRelease = release.replace(/\\\n\s*/gu, ' ');
    const normalizedReadme = readme.replace(/\\\n\s*/gu, ' ');
    const compactRelease = release.replace(/\s+/gu, ' ');
    const releaseBuildCommands = normalizedRelease
      .split('\n')
      .filter((line) => line.includes('bunx eas-cli@21.7.0 build --platform'));

    expect(release).toContain(
      'env:list production --scope project --format long',
    );
    expect(release).toContain(
      'env:list production --scope account --format long',
    );
    expect(release).toContain('env:exec production');
    expect(release).toContain(
      'test "$EXPO_PUBLIC_PSD_EOC_API_BASE_URL" = "https://eoc.psd401.net"',
    );
    expect(release).toContain(
      'test "$EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED" = "true"',
    );
    expect(compactRelease).toContain(
      'exactly one plaintext string `EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED` at project scope with the exact value `true`',
    );
    expect(compactRelease).toContain(
      'no account-scope variable of the same name',
    );
    expect(compactRelease).toContain(
      'makes the installed binary capable of registration',
    );
    expect(compactRelease).toContain(
      'BUILD approval alone does not authorize installation, sign-in, registration, a provider test, or a notification',
    );
    for (const command of [
      'channel:list --limit 25',
      'branch:list --limit 50',
      'channel:view production',
      'branch:view production',
      'update:list --branch production --platform ios',
      'update:list --branch production --platform android',
      "update:view 'EACH_COMPATIBLE_UPDATE_GROUP_ID' --json",
    ]) {
      expect(normalizedRelease).toContain(command);
    }
    expect(release).toContain('complete, paginated inventory');
    expect(compactRelease).toContain(
      'A separately previewed BUILD may create and link the same-name channel and branch only when both are absent',
    );
    expect(compactRelease).toContain(
      "A missing channel with an existing same-name branch is partial state: linking it could expose that branch's updates to already installed clients",
    );
    expect(compactRelease).toContain(
      'If the channel exists, it must already map to exactly one existing same-name branch; BUILD may not repair it',
    );
    expect(compactRelease).toContain(
      'When neither the `production` channel nor same-name branch exists, EAS Build may create and link that pair',
    );
    expect(compactRelease).toContain(
      'A missing channel with an existing same-name branch blocks BUILD',
    );
    expect(compactRelease).toContain(
      "linking it can expose that branch's updates to installed production-channel clients and requires a separate routing/exposure review",
    );
    expect(release).toContain('After BUILD, even after a refusal or partial');

    expect(releaseBuildCommands).toHaveLength(4);
    for (const command of releaseBuildCommands) {
      expect(command).toContain('--non-interactive --freeze-credentials');
    }
    expect(normalizedReadme).toMatch(
      /build --platform ios --profile preview\s+--non-interactive --freeze-credentials/u,
    );
    expect(readme).toContain('never replace `ios` with `all`');

    expect(release).toContain('Unauthenticated access to internal builds');
    expect(release).toContain('is disabled');
    expect(compactRelease).toContain(
      'named, bounded staff-only technical audience',
    );
    for (const profile of ['`development`', '`preview`', '`ota-preview`']) {
      expect(compactRelease).toContain(profile);
    }
    for (const evidence of [
      'audience digest and count',
      'access expiry',
      'planned removal time',
      'post-removal read-back',
    ]) {
      expect(compactRelease).toContain(evidence);
    }
    expect(compactRelease).toContain('A URL alone is never privacy');
    expect(compactRelease).toContain('launched embedded/update identity');
    expect(compactRelease).toContain(
      'provider inventory alone is not device-adoption',
    );

    for (const profile of [
      '`development`:',
      '`preview`:',
      '`ota-preview`:',
      '`production`:',
    ]) {
      expect(readme).toContain(profile);
    }
    expect(readme).toContain(
      '`expo-updates` is required at runtime for runtime-bound staged OTA verification',
    );
    expect(normalizedRelease).toMatch(
      /env -u EXPO_PUBLIC_PSD_EOC_API_BASE_URL\s+-u EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED\s+bunx eas-cli@21\.7\.0 env:exec production/u,
    );
    expect(release).toContain('does not reliably apply `--freeze-credentials`');
    expect(release).toContain(
      'build:version:get --platform ios --profile production --json',
    );
    expect(release).toContain(
      'build:version:get --platform android --profile production --json',
    );
    expect(release).toContain(
      'build:version:get --platform ios --profile ota-preview --json',
    );
    expect(release).toContain(
      'build:version:get --platform android --profile ota-preview --json',
    );
    expect(release).toContain(
      'config --platform ios --profile ota-preview --json',
    );
    expect(release).toContain(
      'config --platform android --profile ota-preview --json',
    );
    expect(compactRelease).toContain(
      '`update:list` is only a group-level summary',
    );
    for (const transition of [
      'first production iOS BUILD is previewed as `{}` to `1`',
      'first production Android BUILD is previewed as `{}` to `2`',
      'with no separately stored remote `1` transition',
      '`ota-preview` build already initialized either counter to `1`',
      'existing numeric `N`, a production BUILD is previewed as `N` to `N + 1`',
    ]) {
      expect(compactRelease).toContain(transition);
    }
    expect(compactRelease).toContain(
      'existing numeric counter must not change because `ota-preview` has no auto-increment',
    );
    expect(normalizedReadme).toContain(
      'any `development`, `preview`, or `ota-preview` internal build',
    );
    expect(compactRelease).toContain(
      'dedicated non-operational verifier devices',
    );
    expect(compactRelease).toContain(
      'Removal alone does not prove a store reinstall',
    );
    expect(compactRelease).toContain(
      'sign out while online, and obtain exact token-free session-revocation and push- unregistration evidence',
    );
    expect(compactRelease).toContain(
      'old internal endpoint is inactive and the current store endpoint is the only expected active endpoint',
    );
    expect(compactRelease).toContain(
      'Access expiry or revocation cannot recall an installed artifact',
    );
    expect(compactRelease).toContain(
      'downloaded Android bytes can be redistributed',
    );
    expect(compactRelease).toContain(
      'iOS provisioning device allowlist must exactly match',
    );
  });

  test('binds every OTA write to one platform and reconciles partial provider state', () => {
    const release = repositoryText('docs/runbooks/release.md');
    const normalizedRelease = release.replace(/\\\n\s*/gu, ' ');
    const compactRelease = release.replace(/\s+/gu, ' ');
    const platformAwareMutations = normalizedRelease
      .split('\n')
      .filter((line) =>
        /bunx eas-cli@21\.7\.0 (?:update|update:republish|update:roll-back-to-embedded)\s/u.test(
          line,
        ),
      );

    expect(platformAwareMutations).toHaveLength(4);
    for (const command of platformAwareMutations) {
      expect(command).toContain("--platform 'APPROVED_PLATFORM'");
      expect(command).toContain('--non-interactive');
      expect(command).not.toMatch(/--platform\s+(?:all|'all'|"all")\b/u);
    }
    expect(compactRelease).toContain(
      'Replace it with exactly `ios` or `android` only after the preview binds that one platform; never use or approve `all`',
    );
    expect(compactRelease).toContain(
      '`update:edit` has no platform flag, so its exact group must first be proven by `update:view` to contain only the one approved platform',
    );
    expect(compactRelease).toContain(
      '`update:revert-update-rollout` has no platform flag',
    );
    expect(compactRelease).toContain(
      'A group ID is not inherently single-platform',
    );
    expect(compactRelease).toContain(
      'operation is non-atomic: it deletes the entire rollout group first',
    );
    expect(compactRelease).toContain(
      'after success, error, interruption, or timeout, perform an independent complete paginated read-back',
    );
    expect(compactRelease).toContain(
      'Run `update:view` for every resulting or compatible group',
    );
    expect(compactRelease).toContain(
      'prove the old rollout is no longer active and bind the exact replacement control group',
    );
    expect(compactRelease).toContain(
      'Append partial and `unknown` truth; never blindly retry',
    );
    expect(compactRelease).toContain(
      'A change to either compiled value is an environment-contract change and therefore requires a new app version and store build; it is never eligible for OTA',
    );
    expect(compactRelease).toContain(
      'Immediately before every OTA write, capture a fresh complete paginated channel, branch, destination-channel/branch, and both-platform exact-runtime update inventory',
    );
    expect(compactRelease).toContain(
      'Every destination OTA routing pair must already exist before its write',
    );
    expect(compactRelease).toContain(
      'Except for the paused-containment rollback path in section 8, the destination channel must also be active',
    );
    expect(compactRelease).toContain(
      'each of these can create or link routing when its destination is absent: `update --channel ota-verification`, `update:republish --destination-channel production`, and `update:roll-back-to-embedded --channel production`',
    );
    expect(compactRelease).toContain(
      'An OTA approval never authorizes channel or branch creation, linking, rerouting, pausing, or unpausing',
    );
    expect(compactRelease).toContain(
      'Ordinary verification publication, production republish, and rollout increases also require the exact destination channel to report `isPaused: false`',
    );
    expect(compactRelease).toContain(
      'canonical unconditional raw `branchMapping`: version `0`, exactly one data entry',
    );
    expect(compactRelease).toContain('`branchMappingLogic` exactly `"true"`');
    expect(compactRelease).toContain(
      '`branchId` equal to the exact same-name branch ID',
    );
    expect(compactRelease).toContain(
      'the section 8 rollback exception instead requires a known unchanged pause status',
    );
    expect(compactRelease).toContain(
      'unknown channel state, conditional mapping, zero or multiple mapping entries',
    );
    expect(compactRelease).toContain(
      'A paused channel additionally blocks every non-rollback command',
    );
    expect(compactRelease).toContain(
      'Unpause or remap a channel only through a separate routing mutation with its own exact preview, explicit product-owner approval, fresh authenticated-human confirmation, and complete read-back',
    );
    expect(compactRelease).toContain(
      'The exact `production` channel must have a known pause status and the canonical unconditional raw mapping to the exact same-name branch as reviewed',
    );
    expect(compactRelease).toContain(
      'For all three write families, success also requires zero routing drift',
    );
    expect(compactRelease).toContain(
      'pre-existing destination channel must retain its exact reviewed pause status and the same version-0, one-entry, unconditional-`"true"` mapping to the reviewed branch',
    );
    expect(compactRelease).toContain(
      'no channel or branch may have been created, linked, relinked, repaired, paused, or unpaused',
    );
    expect(compactRelease).toContain(
      'For ordinary verification publication, production republish, and rollout increases, that unchanged status must be active (`isPaused: false`)',
    );
    expect(compactRelease).toContain(
      'keep `isPaused: true` throughout the rollback command and its complete independent read-back; do not unpause first',
    );
    expect(compactRelease).toContain(
      'A paused rollback succeeds only when the repaired update/control state is proven while the channel remains paused',
    );
    expect(compactRelease).toContain(
      'Exposing that repaired state then requires a separate unpause consequence preview, explicit product-owner approval, fresh authenticated-human confirmation, and complete read-back',
    );
    expect(release).not.toContain(
      'An absent `production` channel/branch means EAS Build may create and\ninventory.',
    );
    for (const success of [
      '`update`: exactly one new verification group',
      '`update:republish`: exactly one new production group',
      '`update:edit`: no new group and only the approved percentage changed',
    ]) {
      expect(compactRelease).toContain(success);
    }
    expect(compactRelease).toContain(
      'Bind its exact update ID to the matching platform update returned by `update:view`',
    );
  });

  test('uses progressive approvals without circular distribution gates', () => {
    const release = repositoryText('docs/runbooks/release.md');
    const headings = [
      '### BUILD',
      '### SUBMIT',
      '### TESTER EXPOSURE',
      '### FINAL ACCEPTANCE',
    ];
    const headingOffsets = headings.map((heading) => release.indexOf(heading));

    expect(headingOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(headingOffsets).toEqual([...headingOffsets].sort((a, b) => a - b));
    expect(release).not.toContain(
      'Issues #37 and #40 are complete with their required human and',
    );
    expect(release.replace(/\s+/gu, ' ')).toContain(
      "Issue #37's first manual AAB upload and issue #40's physical-device delivery consume these BUILD artifacts; completion of #37 or #40 is not a BUILD prerequisite.",
    );
    expect(release).toContain('orphan same-name branch');
    expect(release).toContain('source-upload/build-job');
    expect(release).toContain('quota/cost state');
    expect(release).toContain(
      'Approval for one gate never authorizes another.',
    );
    expect(release).toMatch(
      /Every provider write requires\s+a fresh exact consequence preview, explicit product-owner approval, and fresh\s+authenticated-human confirmation/u,
    );
    expect(release).toMatch(
      /Tester exposure authorizes installation only\. It does not authorize a\s+PSD EOC notification/u,
    );
    expect(release.replace(/\s+/gu, ' ')).toContain(
      'authenticated online session with already granted notification permission automatically acquires a native token, contacts Expo for an Expo token, and registers that token with PSD EOC',
    );
    expect(release.replace(/\s+/gu, ' ')).toContain(
      'issue #40 cannot yet perform that first send through the canonical app path',
    );
    for (const prerequisite of [
      'verified credentials',
      'an approved synthetic target list',
      'a consequence preview',
      'explicit product-owner authorization',
      'authenticated-human confirmation',
    ]) {
      expect(release).toContain(prerequisite);
    }
    expect(release).toMatch(
      /FINAL ACCEPTANCE is a read-only evidence decision, not a provider-write\s+authorization/u,
    );
    expect(release).toMatch(
      /integration truth labels that claim only what is\s+proven/u,
    );
    expect(release).toMatch(
      /This human-only FINAL ACCEPTANCE record does not itself authorize\s+go-live, production deployment, provider configuration, a real incident, a real\s+notification, an all-clear, or closing a real event/u,
    );
  });

  test('truth-labels every distribution provider without live claims', () => {
    const integrations = repositoryText('docs/INTEGRATIONS.md');

    expect(integrations).toMatch(
      /Expo Application Services \(Build \/ Update\)\s+\|[^\n]+\| `configured-unverified`/u,
    );
    for (const integration of [
      'Apple App Store Connect / TestFlight',
      'Google Play closed testing',
      'Firebase App Distribution',
      'Expo Application Services (Submit)',
    ]) {
      const row = integrations
        .split('\n')
        .find((line) => line.includes(`| ${integration}`));
      expect(row).toContain('| `blocked`');
    }
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
      const compactGuide = guide.replace(/\s+/gu, ' ');
      expect(guide).toContain('Do not start an incident or drill just to test');
      expect(guide).toContain('Scheduling the window does not');
      expect(guide).toContain('authenticated human must freshly');
      expect(guide).toContain('not provider screenshots or install proof');
      expect(guide).toMatch(/Deleting\s+the app alone does not prove/u);
      expect(compactGuide).toContain('canonical **`[DRILL]`** marker');
      expect(compactGuide).toContain('**DRILL — PRACTICE**');
      expect(compactGuide).toContain('**`[INCIDENT]`**');
      expect(compactGuide).toContain('omits **`[DRILL]`**');
      expect(compactGuide).toContain('conflicting markers');
      expect(compactGuide).toContain('uses real-incident wording');
      expect(compactGuide).toContain('generic wording such as **TEST ONLY**');
    }
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
  });
});
