import { describe, expect, test } from 'bun:test';

import {
  DeploymentConfigurationError,
  androidApplicationId,
  androidSigningFingerprints,
  appleAppTeamId,
  applicationOrigin,
  displayTimeZone,
  iosBundleId,
  organizationName,
  privacyContactUrl,
  smsSupportEmail,
  smsSupportPhone,
  staffHostedDomain,
} from './deployment';

describe('deployment configuration', () => {
  test('accepts a complete synthetic second-district identity', () => {
    const environment = {
      GOOGLE_OIDC_APPLICATION_ORIGIN: 'https://alerts.example.invalid',
      GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
      PSD_EOC_IOS_BUNDLE_ID: 'invalid.example.alerts',
      PSD_EOC_ORGANIZATION_NAME: 'Example Unified School District',
      PSD_EOC_PRIVACY_CONTACT_URL: 'https://www.example.invalid/contact',
      PSD_EOC_DISPLAY_TIME_ZONE: 'America/New_York',
      PSD_EOC_SMS_SUPPORT_EMAIL: 'servicecentral@example.invalid',
      PSD_EOC_SMS_SUPPORT_PHONE: '+12535550123',
    };

    expect(applicationOrigin(environment)).toBe(
      'https://alerts.example.invalid',
    );
    expect(staffHostedDomain(environment)).toBe('example.invalid');
    expect(iosBundleId(environment)).toBe('invalid.example.alerts');
    expect(organizationName(environment)).toBe(
      'Example Unified School District',
    );
    expect(privacyContactUrl(environment)).toBe(
      'https://www.example.invalid/contact',
    );
    expect(displayTimeZone(environment)).toBe('America/New_York');
  });

  test('store identities are optional and absent by default', () => {
    // A district that ships no store build is a legitimate deployment: the
    // association documents are then not served, native passkeys are
    // unavailable, and the emailed code needs none of this.
    expect(appleAppTeamId({})).toBeNull();
    expect(androidApplicationId({})).toBeNull();
    expect(androidSigningFingerprints({})).toEqual([]);
  });

  test('store identities are read and normalized when configured', () => {
    const fingerprint = `${'AB:'.repeat(31)}CD`;
    expect(appleAppTeamId({ PSD_EOC_APPLE_APP_TEAM_ID: ' A1B2C3D4E5 ' })).toBe(
      'A1B2C3D4E5',
    );
    expect(
      androidApplicationId({
        PSD_EOC_ANDROID_APPLICATION_ID: 'invalid.example.alerts',
      }),
    ).toBe('invalid.example.alerts');
    expect(
      androidSigningFingerprints({
        PSD_EOC_ANDROID_SIGNING_FINGERPRINTS: fingerprint.toLowerCase(),
      }),
    ).toEqual([fingerprint]);
  });

  test('requires a valid configured display time zone', () => {
    expect(() => displayTimeZone({})).toThrow(DeploymentConfigurationError);
    expect(() =>
      displayTimeZone({ PSD_EOC_DISPLAY_TIME_ZONE: 'Not/A_Real_Zone' }),
    ).toThrow(DeploymentConfigurationError);
  });

  test('fails closed for absent, unbounded, or control-bearing organization names', () => {
    expect(
      organizationName({ PSD_EOC_ORGANIZATION_NAME: '😀'.repeat(80) }),
    ).toBe('😀'.repeat(80));
    expect(
      organizationName({ PSD_EOC_ORGANIZATION_NAME: '界'.repeat(106) }),
    ).toBe('界'.repeat(106));

    for (const value of [
      undefined,
      '',
      'x'.repeat(161),
      '😀'.repeat(81),
      '界'.repeat(107),
      'District\nName',
      'District\u202eName',
      'District\u2028Name',
    ]) {
      expect(() =>
        organizationName({ PSD_EOC_ORGANIZATION_NAME: value }),
      ).toThrow(DeploymentConfigurationError);
    }
  });

  test('requires a public HTTPS privacy contact mechanism', () => {
    expect(() => privacyContactUrl({})).toThrow(DeploymentConfigurationError);
    for (const value of [
      'http://www.example.invalid/contact',
      'https://localhost/contact',
      'https://privacy.localhost/contact',
      'https://127.0.0.1/contact',
      'https://2130706433/contact',
      'https://[::1]/contact',
      'https://user:password@example.invalid/contact',
      'https://www.example.invalid/contact#private',
    ]) {
      expect(() =>
        privacyContactUrl({ PSD_EOC_PRIVACY_CONTACT_URL: value }),
      ).toThrow(DeploymentConfigurationError);
    }
  });
});

describe('SMS support contact configuration', () => {
  test('reads a configured support mailbox and E.164 phone', () => {
    const environment = {
      PSD_EOC_SMS_SUPPORT_EMAIL: 'servicecentral@example.invalid',
      PSD_EOC_SMS_SUPPORT_PHONE: '+12535550123',
    };

    expect(smsSupportEmail(environment)).toBe('servicecentral@example.invalid');
    expect(smsSupportPhone(environment)).toBe('+12535550123');
  });

  test.each([
    ['', 'absent'],
    ['servicecentral', 'no domain'],
    ['servicecentral@localhost', 'no public domain'],
    ['service central@example.invalid', 'whitespace'],
  ])('refuses the support email %p (%s)', (value) => {
    expect(() => smsSupportEmail({ PSD_EOC_SMS_SUPPORT_EMAIL: value })).toThrow(
      DeploymentConfigurationError,
    );
  });

  test.each([
    ['', 'absent'],
    ['2535550123', 'not E.164'],
    ['+02535550123', 'leading zero'],
    ['253-555-0123', 'formatted'],
  ])('refuses the support phone %p (%s)', (value) => {
    expect(() => smsSupportPhone({ PSD_EOC_SMS_SUPPORT_PHONE: value })).toThrow(
      DeploymentConfigurationError,
    );
  });
});
