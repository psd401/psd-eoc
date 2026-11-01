import { describe, expect, test } from 'bun:test';

import {
  ANDROID_LOGIN_CREDENTIALS_RELATION,
  androidAssetLinks,
  appleAppSiteAssociation,
} from './app-association';
import { DeploymentConfigurationError } from './deployment';

/**
 * Issue #647. What is worth proving about these documents is that an
 * unconfigured deployment produces none, a misconfigured one produces an
 * error rather than a document the platform silently refuses, and a
 * configured one names exactly one app with exactly one relation.
 */

const FINGERPRINT = `${'AB:'.repeat(31)}CD`;
const SECOND_FINGERPRINT = `${'EF:'.repeat(31)}01`;

const CONFIGURED = Object.freeze({
  PSD_EOC_IOS_BUNDLE_ID: 'invalid.example.eoc',
  PSD_EOC_APPLE_APP_TEAM_ID: 'A1B2C3D4E5',
  PSD_EOC_ANDROID_APPLICATION_ID: 'invalid.example.eoc',
  PSD_EOC_ANDROID_SIGNING_FINGERPRINTS: FINGERPRINT,
});

describe("Apple's app association document", () => {
  test('names the signed app once, and only the webcredentials service', () => {
    const association = appleAppSiteAssociation(CONFIGURED);
    expect(association).toEqual({
      webcredentials: { apps: ['A1B2C3D4E5.invalid.example.eoc'] },
    });
    // `applinks` would make this deployment's domain open in the app, which
    // is a different decision from passkeys and is not taken here.
    expect(Object.keys(association ?? {})).toEqual(['webcredentials']);
  });

  test('a deployment with no team identifier serves no document', () => {
    expect(
      appleAppSiteAssociation({
        PSD_EOC_IOS_BUNDLE_ID: 'invalid.example.eoc',
      }),
    ).toBeNull();
  });

  test('a malformed team identifier is a configuration error', () => {
    expect(() =>
      appleAppSiteAssociation({
        ...CONFIGURED,
        PSD_EOC_APPLE_APP_TEAM_ID: 'a1b2c3d4e5f6',
      }),
    ).toThrow(DeploymentConfigurationError);
  });

  test('a team identifier with no bundle identifier beside it is an error', () => {
    // Half a configuration would otherwise produce an app id Apple refuses.
    expect(() =>
      appleAppSiteAssociation({
        PSD_EOC_APPLE_APP_TEAM_ID: 'A1B2C3D4E5',
      }),
    ).toThrow(DeploymentConfigurationError);
  });
});

describe("Google's asset links document", () => {
  test('carries the login-credentials relation and nothing else', () => {
    expect(androidAssetLinks(CONFIGURED)).toEqual([
      {
        relation: [ANDROID_LOGIN_CREDENTIALS_RELATION],
        target: {
          namespace: 'android_app',
          package_name: 'invalid.example.eoc',
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
    expect(ANDROID_LOGIN_CREDENTIALS_RELATION).toBe(
      'delegate_permission/common.get_login_creds',
    );
  });

  test('a signing-key rotation may name both certificates', () => {
    const statements = androidAssetLinks({
      ...CONFIGURED,
      PSD_EOC_ANDROID_SIGNING_FINGERPRINTS: `${FINGERPRINT}, ${SECOND_FINGERPRINT.toLowerCase()}`,
    });
    expect(statements?.[0]?.target.sha256_cert_fingerprints).toEqual([
      FINGERPRINT,
      SECOND_FINGERPRINT,
    ]);
  });

  test('half a configuration serves no document', () => {
    // A statement naming a package with no fingerprint, or a fingerprint with
    // no package, names no app at all.
    expect(
      androidAssetLinks({
        PSD_EOC_ANDROID_APPLICATION_ID: 'invalid.example.eoc',
      }),
    ).toBeNull();
    expect(
      androidAssetLinks({
        PSD_EOC_ANDROID_SIGNING_FINGERPRINTS: FINGERPRINT,
      }),
    ).toBeNull();
  });

  test('a malformed fingerprint or duplicate is a configuration error', () => {
    for (const fingerprints of [
      'AB:CD:EF',
      `${FINGERPRINT},${FINGERPRINT}`,
      `${FINGERPRINT.replace(/:/gu, '')}`,
    ]) {
      expect(() =>
        androidAssetLinks({
          ...CONFIGURED,
          PSD_EOC_ANDROID_SIGNING_FINGERPRINTS: fingerprints,
        }),
      ).toThrow(DeploymentConfigurationError);
    }
  });

  test('an upper-case application id is refused', () => {
    // Play holds the application id exactly as the manifest declares it, and
    // Android compares it literally.
    expect(() =>
      androidAssetLinks({
        ...CONFIGURED,
        PSD_EOC_ANDROID_APPLICATION_ID: 'Invalid.Example.Eoc',
      }),
    ).toThrow(DeploymentConfigurationError);
  });
});
