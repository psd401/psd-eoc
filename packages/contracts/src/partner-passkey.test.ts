import { describe, expect, test } from 'bun:test';

import './index';
import {
  AuthenticationCapabilityEnvelopeSchema,
  GOOGLE_IDENTITY_ISSUER,
  PartnerPasskeyAssertionCredentialSchema,
  PartnerPasskeyCreationOptionsSchema,
  PartnerPasskeyRegistrationCredentialSchema,
  PartnerPasskeyRequestOptionsSchema,
  PartnerPasskeyRequestSchema,
  PartnerPasskeySignInStartResponseSchema,
  PasskeyRelyingPartyIdSchema,
  PreSessionOidcPrincipalSchema,
} from './index';

/**
 * Issue #599. The partner passkey contracts.
 *
 * Two properties carry the weight. A passkey sign-in records that a passkey
 * was verified and never that a code was, so the audit cannot claim a code
 * was read from an inbox that received none. And the passkey transport stays
 * inside the partner path: a Google identity cannot present it, and a partner
 * identity still cannot present Google's.
 */

const PARTNER_ISSUER =
  'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Example1';
const DIGEST = 'a'.repeat(64);
const RELYING_PARTY = 'eoc.example.invalid';

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

const PASSKEY_TRANSPORT = Object.freeze({
  kind: 'partner-passkey',
  method: 'POST',
  passkeyVerified: true,
  userVerified: true,
  signatureVerified: true,
});

function envelope(
  overrides: Readonly<Record<string, unknown>> = {},
  claimOverrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    capabilityId: 'complete-oidc-sign-in',
    operation: 'mutation',
    principal: PreSessionOidcPrincipalSchema.parse({
      kind: 'verified-oidc-claims',
      ...claims(claimOverrides),
      audienceVerified: true,
    }),
    source: 'web',
    requestId: '00000000-0000-4000-8000-000000000001',
    serverTime: '2026-10-31T00:00:00.000Z',
    input: {
      claims: claims(claimOverrides),
      device: {
        platform: 'web',
        unlockMethod: 'secure-session-cookie',
        installationId: 'web.installation-identifier',
      },
    },
    idempotencyKey: `oidc:${DIGEST}`,
    transport: PASSKEY_TRANSPORT,
    ...overrides,
  };
}

describe('the partner passkey relying-party id', () => {
  test('accepts a hostname and refuses everything that is not one', () => {
    for (const value of [RELYING_PARTY, 'localhost', 'eoc.example']) {
      expect(PasskeyRelyingPartyIdSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [
      'https://eoc.example.invalid',
      'eoc.example.invalid:443',
      'eoc.example.invalid/path',
      'EOC.Example.Invalid',
      '127.0.0.1',
      '-eoc.example.invalid',
      '',
    ]) {
      expect(PasskeyRelyingPartyIdSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('the partner passkey transport', () => {
  test('a passkey sign-in completes a partner session', () => {
    expect(
      AuthenticationCapabilityEnvelopeSchema.parse(envelope()),
    ).toMatchObject({ transport: { kind: 'partner-passkey' } });
  });

  test('a passkey sign-in never records a verified one-time password', () => {
    // The two partner transports are strict and disjoint, so the recorded
    // evidence can only name the factor the pool actually proved.
    expect(() =>
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({
          transport: { ...PASSKEY_TRANSPORT, otpVerified: true },
        }),
      ),
    ).toThrow();
    expect(() =>
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({
          transport: {
            kind: 'partner-email-otp',
            method: 'POST',
            otpVerified: true,
            signatureVerified: true,
            passkeyVerified: true,
          },
        }),
      ),
    ).toThrow();
  });

  test('a passkey sign-in with unverified user is not a transport', () => {
    // The pool requires user verification, so there is no false to record.
    for (const field of ['passkeyVerified', 'userVerified'] as const) {
      expect(() =>
        AuthenticationCapabilityEnvelopeSchema.parse(
          envelope({ transport: { ...PASSKEY_TRANSPORT, [field]: false } }),
        ),
      ).toThrow();
    }
  });

  test('a Google identity cannot arrive as a partner passkey', () => {
    expect(() =>
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({}, { issuer: GOOGLE_IDENTITY_ISSUER }),
      ),
    ).toThrow();
  });

  test('a partner identity still cannot arrive as a Google callback', () => {
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

  test('a passkey sign-in completes from the native app too', () => {
    // #598 put a partner on a phone; the factor does not change the surface
    // rule, so the native source accepts the passkey transport as well.
    expect(
      AuthenticationCapabilityEnvelopeSchema.parse(
        envelope({
          source: 'mobile',
          input: {
            claims: claims(),
            device: {
              platform: 'ios',
              unlockMethod: 'biometric',
              installationId: 'ios.installation-identifier',
            },
          },
        }),
      ),
    ).toMatchObject({ source: 'mobile' });
  });
});

describe('the partner passkey ceremony payloads', () => {
  test('creation options must require user verification', () => {
    const options = {
      rp: { id: RELYING_PARTY, name: 'PSD EOC' },
      user: { id: 'dXNlci1pZA', name: 'a@b.invalid', displayName: 'A' },
      challenge: 'Y2hhbGxlbmdl',
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    };
    expect(PartnerPasskeyCreationOptionsSchema.parse(options)).toMatchObject({
      rp: { id: RELYING_PARTY },
    });
    expect(() =>
      PartnerPasskeyCreationOptionsSchema.parse({
        ...options,
        authenticatorSelection: { userVerification: 'preferred' },
      }),
    ).toThrow();
  });

  test('request options must require user verification', () => {
    expect(() =>
      PartnerPasskeyRequestOptionsSchema.parse({
        rpId: RELYING_PARTY,
        challenge: 'Y2hhbGxlbmdl',
        userVerification: 'preferred',
      }),
    ).toThrow();
  });

  test('a registration credential is not an assertion, and the reverse', () => {
    const base = { id: 'aWQ', rawId: 'aWQ', type: 'public-key' as const };
    const assertion = {
      ...base,
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
      },
    };
    const created = {
      ...base,
      response: { clientDataJSON: 'Y2Q', attestationObject: 'YW8' },
    };
    expect(
      PartnerPasskeyAssertionCredentialSchema.parse(assertion),
    ).toMatchObject({ type: 'public-key' });
    expect(
      PartnerPasskeyRegistrationCredentialSchema.parse(created),
    ).toMatchObject({ type: 'public-key' });
    expect(() =>
      PartnerPasskeyAssertionCredentialSchema.parse(created),
    ).toThrow();
    expect(() =>
      PartnerPasskeyRegistrationCredentialSchema.parse(assertion),
    ).toThrow();
  });

  test('base64url is the only accepted encoding', () => {
    expect(() =>
      PartnerPasskeyRequestOptionsSchema.parse({
        rpId: RELYING_PARTY,
        // Standard base64 padding is not base64url.
        challenge: 'Y2hhbGxlbmdl==',
        userVerification: 'required',
      }),
    ).toThrow();
  });

  test('the endpoint accepts exactly the four steps', () => {
    expect(
      PartnerPasskeyRequestSchema.parse({ step: 'register-start' }),
    ).toMatchObject({ step: 'register-start' });
    expect(
      PartnerPasskeyRequestSchema.parse({
        step: 'sign-in-start',
        email: 'responder@agency.example.invalid',
      }),
    ).toMatchObject({ step: 'sign-in-start' });
    for (const body of [
      { step: 'register-start', email: 'extra@field.invalid' },
      { step: 'list-credentials' },
      {},
    ]) {
      expect(() => PartnerPasskeyRequestSchema.parse(body)).toThrow();
    }
  });

  test('the first step answers either a ceremony or "use a code"', () => {
    expect(
      PartnerPasskeySignInStartResponseSchema.parse({ method: 'code' }),
    ).toMatchObject({ method: 'code' });
    // `code` carries nothing, so it cannot leak whether an account exists.
    expect(() =>
      PartnerPasskeySignInStartResponseSchema.parse({
        method: 'code',
        enrolled: false,
      }),
    ).toThrow();
  });
});
