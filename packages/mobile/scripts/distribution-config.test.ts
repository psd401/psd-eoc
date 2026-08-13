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
      expect(guide).toContain('Do not start an incident or drill just to test');
      expect(guide).toContain('Scheduling the window does not');
      expect(guide).toContain('authenticated human must freshly');
      expect(guide).toContain('not provider screenshots or install proof');
      expect(guide).toMatch(/Deleting\s+the app alone does not prove/u);
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
