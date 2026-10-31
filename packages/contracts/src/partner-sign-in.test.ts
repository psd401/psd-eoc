import { describe, expect, test } from 'bun:test';

import './index';
import {
  AuthenticationCapabilityEnvelopeSchema,
  CompleteOidcSignInInputSchema,
  GOOGLE_IDENTITY_ISSUER,
  isPartnerIssuer,
  MobilePartnerSignInFlowTokenSchema,
  MobilePartnerSignInStartRequestSchema,
  MobilePartnerSignInVerifyRequestSchema,
  PreSessionOidcPrincipalSchema,
} from './index';

/**
 * Issue #593. The two web sign-in paths must stay apart at the contract
 * layer: a partner Cognito token presented as a Google code callback, and a
 * Google token presented as a partner one-time password, are both refused
 * before any handler, authorizer, or store runs.
 */

const PARTNER_ISSUER =
  'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Example1';
const DIGEST = 'a'.repeat(64);

function claims(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    issuer: PARTNER_ISSUER,
    audience: 'partner-app-client',
    subject: 'cognito-subject-1',
    subjectDigest: DIGEST,
    claimsDigest: DIGEST,
    hostedDomain: null,
    email: 'responder@agency.example.invalid',
    emailVerified: true,
    displayName: 'Synthetic Responder',
    ...overrides,
  };
}

function input(
  claimOverrides: Readonly<Record<string, unknown>> = {},
  deviceOverrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    claims: claims(claimOverrides),
    device: {
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: 'web.installation-identifier',
      ...deviceOverrides,
    },
  };
}

function envelope(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    capabilityId: 'complete-oidc-sign-in',
    operation: 'mutation',
    principal: PreSessionOidcPrincipalSchema.parse({
      kind: 'verified-oidc-claims',
      ...claims(),
      audienceVerified: true,
    }),
    source: 'web',
    requestId: '00000000-0000-4000-8000-000000000001',
    serverTime: '2026-10-25T00:00:00.000Z',
    input: input(),
    idempotencyKey: `oidc:${DIGEST}`,
    transport: {
      kind: 'partner-email-otp',
      method: 'POST',
      otpVerified: true,
      signatureVerified: true,
    },
    ...overrides,
  };
}

describe('partner sign-in contracts', () => {
  test('a Cognito pool issuer is a partner issuer and Google is not', () => {
    expect(isPartnerIssuer(PARTNER_ISSUER)).toBe(true);
    expect(isPartnerIssuer(GOOGLE_IDENTITY_ISSUER)).toBe(false);
    expect(
      isPartnerIssuer('https://cognito-idp.example.invalid/synthetic-pool'),
    ).toBe(true);
    expect(isPartnerIssuer('https://accounts.google.com.evil.invalid')).toBe(
      false,
    );
  });

  test('a partner identity completes sign-in on the web', () => {
    expect(CompleteOidcSignInInputSchema.parse(input())).toMatchObject({
      claims: { issuer: PARTNER_ISSUER, hostedDomain: null },
    });
    expect(
      AuthenticationCapabilityEnvelopeSchema.parse(envelope()),
    ).toMatchObject({ transport: { kind: 'partner-email-otp' } });
  });

  test('a partner identity carries no hosted domain', () => {
    expect(() =>
      CompleteOidcSignInInputSchema.parse(
        input({ hostedDomain: 'agency.example.invalid' }),
      ),
    ).toThrow();
    expect(() =>
      PreSessionOidcPrincipalSchema.parse({
        kind: 'verified-oidc-claims',
        ...claims({ hostedDomain: 'agency.example.invalid' }),
        audienceVerified: true,
      }),
    ).toThrow();
  });

  test('a partner token cannot arrive as a Google code callback', () => {
    expect(() =>
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({
          transport: {
            kind: 'oidc-code-callback',
            method: 'GET',
            stateVerified: true,
            nonceVerified: true,
            pkceVerified: true,
            signatureVerified: true,
          },
        }),
      ),
    ).toThrow();
  });

  test('a Google token cannot arrive as a partner one-time password', () => {
    const googleClaims = claims({
      issuer: GOOGLE_IDENTITY_ISSUER,
      audience: '1-abc.apps.googleusercontent.com',
      email: 'staff@district.example.invalid',
    });
    expect(() =>
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({
          principal: PreSessionOidcPrincipalSchema.parse({
            kind: 'verified-oidc-claims',
            ...googleClaims,
            audienceVerified: true,
          }),
          input: { ...input(), claims: googleClaims },
        }),
      ),
    ).toThrow();
  });

  // Issue #598. The native app is the second partner surface. It carries the
  // same one-time-password transport, and the device platform is what binds
  // the issued credential to its transport: a browser gets the cookie, a
  // phone gets the bearer, and neither can claim the other's.
  test('a partner signs in from the native application', () => {
    expect(
      CompleteOidcSignInInputSchema.parse(
        input({}, { platform: 'ios', unlockMethod: 'biometric' }),
      ),
    ).toMatchObject({ device: { platform: 'ios', unlockMethod: 'biometric' } });
    expect(
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({
          source: 'mobile',
          input: input({}, { platform: 'android', unlockMethod: 'biometric' }),
        }),
      ),
    ).toMatchObject({ source: 'mobile' });
  });

  test('a partner device never mixes its platform and its credential', () => {
    for (const device of [
      { platform: 'ios', unlockMethod: 'secure-session-cookie' },
      { platform: 'android', unlockMethod: 'secure-session-cookie' },
      { platform: 'web', unlockMethod: 'biometric' },
    ]) {
      expect(() =>
        CompleteOidcSignInInputSchema.parse(input({}, device)),
      ).toThrow();
    }
  });

  test('a native partner still cannot arrive as a native Google exchange', () => {
    expect(() =>
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({
          source: 'mobile',
          input: input({}, { platform: 'ios', unlockMethod: 'biometric' }),
          transport: {
            kind: 'mobile-oidc-code-exchange',
            method: 'POST',
            stateVerified: true,
            nonceVerified: true,
            pkceVerified: true,
            signatureVerified: true,
          },
        }),
      ),
    ).toThrow();
  });

  test('the native partner flow token is the native label only', () => {
    const sealed = `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`;
    expect(MobilePartnerSignInFlowTokenSchema.parse(sealed)).toBe(sealed);
    // The browser's sealed partner flow carries the `p1` label and must not
    // be accepted here, so one surface can never finish the other's sign-in.
    expect(() =>
      MobilePartnerSignInFlowTokenSchema.parse(
        `p1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`,
      ),
    ).toThrow();
    expect(() =>
      MobilePartnerSignInFlowTokenSchema.parse(`n1.${'a'.repeat(16)}`),
    ).toThrow();
  });

  test('the native partner steps read the address from the sealed flow', () => {
    const flowToken = `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`;
    expect(
      MobilePartnerSignInStartRequestSchema.parse({
        email: 'Responder@Agency.Example.Invalid',
        platform: 'ios',
        installationId: 'native-installation-identifier',
      }),
    ).toMatchObject({ email: 'responder@agency.example.invalid' });
    expect(
      MobilePartnerSignInVerifyRequestSchema.parse({
        flowToken,
        code: '123456',
      }),
    ).toMatchObject({ code: '123456' });
    // No address on the verification: the sealed flow owns it.
    expect(() =>
      MobilePartnerSignInVerifyRequestSchema.parse({
        flowToken,
        code: '123456',
        email: 'someone.else@agency.example.invalid',
      }),
    ).toThrow();
    for (const code of ['12345', '123456789', '12345a', '']) {
      expect(() =>
        MobilePartnerSignInVerifyRequestSchema.parse({ flowToken, code }),
      ).toThrow();
    }
  });
});
