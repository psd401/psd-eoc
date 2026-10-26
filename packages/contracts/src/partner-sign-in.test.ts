import { describe, expect, test } from 'bun:test';

import './index';
import {
  AuthenticationCapabilityEnvelopeSchema,
  CompleteOidcSignInInputSchema,
  GOOGLE_IDENTITY_ISSUER,
  isPartnerIssuer,
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

  test('a partner identity carries no hosted domain and no native device', () => {
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
    expect(() =>
      CompleteOidcSignInInputSchema.parse(
        input({}, { platform: 'ios', unlockMethod: 'biometric' }),
      ),
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

  test('a partner never signs in from a native application', () => {
    expect(() =>
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({ source: 'mobile' }),
      ),
    ).toThrow();
  });
});
