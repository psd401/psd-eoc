import { describe, expect, test } from 'bun:test';

import { GOOGLE_IDENTITY_ISSUER } from '@psd-eoc/contracts';

import {
  isTrustedStaffIssuer,
  partnerSignInConfigured,
  PartnerPoolConfigurationError,
  readPartnerPoolConfiguration,
  resolveTrustedIdentityProvider,
  SYNTHETIC_PARTNER_ISSUER,
} from './identity-providers';

/**
 * Issue #593. The registry is the only place an issuer becomes a sign-in
 * path, so it is what keeps the Google path staff-only and the partner path
 * partner-only.
 */

const POOL = 'us-west-2_Example1';
const POOL_ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`;

const configured = Object.freeze({
  PSD_EOC_PARTNER_USER_POOL_ID: POOL,
  PSD_EOC_PARTNER_USER_POOL_CLIENT_ID: 'partner-app-client',
  PSD_EOC_PARTNER_USER_POOL_CLIENT_SECRET_ARN:
    'arn:aws:secretsmanager:us-west-2:111111111111:secret:/psd-eoc/partner-user-pool-client-AbCdEf',
});

describe('trusted identity provider registry', () => {
  test('partner access is off until the pool parameters are supplied', () => {
    for (const environment of [
      {},
      { PSD_EOC_PARTNER_USER_POOL_ID: '' },
      { PSD_EOC_PARTNER_USER_POOL_ID: 'UNCONFIGURED' },
    ]) {
      expect(readPartnerPoolConfiguration(environment)).toBeNull();
      expect(partnerSignInConfigured(environment)).toBe(false);
      expect(
        resolveTrustedIdentityProvider(POOL_ISSUER, environment),
      ).toBeNull();
    }
  });

  test('a pool without its app client is a configuration error', () => {
    expect(() =>
      readPartnerPoolConfiguration({
        PSD_EOC_PARTNER_USER_POOL_ID: POOL,
      }),
    ).toThrow(PartnerPoolConfigurationError);
    // The sign-in page only needs to know not to offer the option.
    expect(
      partnerSignInConfigured({ PSD_EOC_PARTNER_USER_POOL_ID: POOL }),
    ).toBe(false);
  });

  test('a pool id that is not region-prefixed is refused', () => {
    expect(() =>
      readPartnerPoolConfiguration({
        ...configured,
        PSD_EOC_PARTNER_USER_POOL_ID: 'not-a-pool',
      }),
    ).toThrow(PartnerPoolConfigurationError);
  });

  test('the issuer is derived from the pool id, never configured', () => {
    expect(readPartnerPoolConfiguration(configured)).toMatchObject({
      userPoolId: POOL,
      clientId: 'partner-app-client',
      issuer: POOL_ISSUER,
      jwksUri: `${POOL_ISSUER}/.well-known/jwks.json`,
      synthetic: false,
    });
  });

  test('the synthetic pool resolves to the synthetic issuer', () => {
    expect(
      readPartnerPoolConfiguration({
        PSD_EOC_PARTNER_USER_POOL_ID: 'SYNTHETIC',
        PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: 'allowed',
      }),
    ).toMatchObject({ issuer: SYNTHETIC_PARTNER_ISSUER, synthetic: true });
  });

  test('the synthetic pool is refused without the test-only allowance', () => {
    // Its codes are derived from the address, so a deployment that somehow
    // carried the pool id alone must not get a sign-in anyone can complete.
    for (const allowance of [undefined, '', 'true', 'ALLOWED']) {
      const environment = {
        PSD_EOC_PARTNER_USER_POOL_ID: 'SYNTHETIC',
        ...(allowance === undefined
          ? {}
          : { PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: allowance }),
      };
      expect(() => readPartnerPoolConfiguration(environment)).toThrow(
        PartnerPoolConfigurationError,
      );
      expect(partnerSignInConfigured(environment)).toBe(false);
    }
  });

  test('Google is the staff path and a partner pool never is', () => {
    expect(resolveTrustedIdentityProvider(GOOGLE_IDENTITY_ISSUER, {})).toEqual({
      kind: 'google',
      issuer: GOOGLE_IDENTITY_ISSUER,
    });
    expect(isTrustedStaffIssuer(GOOGLE_IDENTITY_ISSUER, configured)).toBe(true);
    expect(isTrustedStaffIssuer(POOL_ISSUER, configured)).toBe(false);
    expect(
      resolveTrustedIdentityProvider(GOOGLE_IDENTITY_ISSUER, configured)?.kind,
    ).toBe('google');
  });

  test('only this deployment’s own pool resolves to the partner path', () => {
    expect(
      resolveTrustedIdentityProvider(POOL_ISSUER, configured),
    ).toMatchObject({ kind: 'partner', configuration: { userPoolId: POOL } });
    expect(
      resolveTrustedIdentityProvider(
        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Someone',
        configured,
      ),
    ).toBeNull();
    expect(
      resolveTrustedIdentityProvider(
        'https://evil.example.invalid',
        configured,
      ),
    ).toBeNull();
  });
});
