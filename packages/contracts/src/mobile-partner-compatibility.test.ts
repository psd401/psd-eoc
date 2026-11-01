import { describe, expect, test } from 'bun:test';

import './index';
import {
  MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER,
  MobileAppReviewSignInRequestSchema,
  MobileOidcExchangeRequestSchema,
  MobileOidcStartRequestSchema,
  MobileOidcStartResponseSchema,
  MobilePartnerPasskeySignInStartRequestSchema,
  MobilePartnerSignInStartRequestSchema,
  MobilePartnerSignInVerifyRequestSchema,
  MobileSessionResponseSchema,
  RevokeSessionInputSchema,
  SessionRevocationSchema,
  sessionAuthorizationUsableUntil,
} from './index';

/**
 * Issue #598, guarding the issue #470 failure: a contracts change shipped
 * ahead of the stores broke the start flow of every installed build.
 *
 * The mobile auth client parses every response with a strict schema
 * (`packages/mobile/src/lib/auth/auth-api-client.ts` calls `schema.parse`),
 * so an installed build breaks in two ways: the server tightens a request it
 * still sends, or the server answers with a shape its frozen schema refuses.
 *
 * The literals below are the exact payloads an installed build sends and
 * expects. They are frozen on purpose: adding a field to one of these shapes
 * is the change that must not happen silently, and editing a literal here is
 * the moment to ask whether the stores have the build that can read it.
 *
 * Native partner sign-in adds endpoints and schemas; it changes none of
 * these. That is what keeps it safe to deploy before the stores ship.
 */

const INSTALLED_BUILD_INSTALLATION_ID = 'installed-build-installation';
const BEARER = 'a'.repeat(43);

/** What an installed build sends to begin native Google sign-in. */
const INSTALLED_OIDC_START_REQUEST = Object.freeze({
  platform: 'ios',
  installationId: INSTALLED_BUILD_INSTALLATION_ID,
  codeChallenge: 'c'.repeat(43),
});

/** What an installed build requires back from that first step. */
const INSTALLED_OIDC_START_RESPONSE = Object.freeze({
  clientId: '1-abc.apps.googleusercontent.com',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1',
  flowToken: `m1.${'a'.repeat(32)}.${'b'.repeat(32)}`,
  state: `m1.${'s'.repeat(43)}`,
  appRedirectUri: 'psdeoc://auth/callback',
  expiresAt: '2026-10-31T00:05:00.000Z',
});

/** What an installed build sends to finish native Google sign-in. */
const INSTALLED_OIDC_EXCHANGE_REQUEST = Object.freeze({
  authorizationCode: 'installed-build-authorization-code',
  state: `m1.${'s'.repeat(43)}`,
  codeVerifier: 'v'.repeat(64),
  flowToken: `m1.${'a'.repeat(32)}.${'b'.repeat(32)}`,
});

/** What an installed build sends on the app-store review path. */
const INSTALLED_APP_REVIEW_REQUEST = Object.freeze({
  email: 'review@district.example.invalid',
  code: 'review-code-supplied-with-submission',
  platform: 'android',
  installationId: INSTALLED_BUILD_INSTALLATION_ID,
});

/**
 * The staff session an installed build enrolls and stores. Every key here is
 * one its frozen `MobileSessionResponseSchema` requires, and no key it does
 * not know is present.
 */
const INSTALLED_STAFF_SESSION_RESPONSE = Object.freeze({
  session: {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      googleSubject: 'installed-build-google-subject',
      email: 'staff@district.example.invalid',
      displayName: 'Installed Build Staff',
      roles: ['staff'],
      facilityScope: { kind: 'district' },
      createdAt: '2026-01-01T00:00:00.000Z',
      disabledAt: null,
    },
    session: {
      id: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000001',
      deviceEnrollmentId: '00000000-0000-4000-8000-000000000003',
      createdAt: '2026-10-31T00:00:00.000Z',
      expiresAt: '2026-11-07T00:00:00.000Z',
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: '00000000-0000-4000-8000-000000000004',
        membershipValidUntil: '2026-11-01T00:00:00.000Z',
        membershipGraceUntil: '2026-11-07T00:00:00.000Z',
      },
      revokedAt: null,
    },
    deviceEnrollment: {
      id: '00000000-0000-4000-8000-000000000003',
      userId: '00000000-0000-4000-8000-000000000001',
      platform: 'ios',
      unlockMethod: 'biometric',
      installationId: INSTALLED_BUILD_INSTALLATION_ID,
      enrolledAt: '2026-10-31T00:00:00.000Z',
      lastSeenAt: '2026-10-31T00:00:00.000Z',
      revokedAt: null,
    },
    connectivityEpoch: {
      id: '00000000-0000-4000-8000-000000000005',
      sessionId: '00000000-0000-4000-8000-000000000002',
      establishedAt: '2026-10-31T00:00:00.000Z',
    },
  },
  tokenType: 'Bearer',
  refreshToken: BEARER,
});

/** The session a native partner sign-in issues on the same envelope. */
const PARTNER_SESSION_RESPONSE = Object.freeze({
  session: {
    user: {
      id: '00000000-0000-4000-8000-000000000011',
      googleSubject: null,
      email: 'responder@agency.example.invalid',
      displayName: 'Synthetic Responder',
      roles: ['partner'],
      facilityScope: { kind: 'district' },
      createdAt: '2026-01-01T00:00:00.000Z',
      disabledAt: null,
    },
    session: {
      id: '00000000-0000-4000-8000-000000000012',
      userId: '00000000-0000-4000-8000-000000000011',
      deviceEnrollmentId: '00000000-0000-4000-8000-000000000013',
      createdAt: '2026-10-31T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z',
      authorization: {
        kind: 'partner-admission',
        partnerAdmissionId: '00000000-0000-4000-8000-000000000014',
        admissionExpiresAt: '2027-01-01T00:00:00.000Z',
      },
      revokedAt: null,
    },
    deviceEnrollment: {
      id: '00000000-0000-4000-8000-000000000013',
      userId: '00000000-0000-4000-8000-000000000011',
      platform: 'android',
      unlockMethod: 'biometric',
      installationId: INSTALLED_BUILD_INSTALLATION_ID,
      enrolledAt: '2026-10-31T00:00:00.000Z',
      lastSeenAt: '2026-10-31T00:00:00.000Z',
      revokedAt: null,
    },
    connectivityEpoch: {
      id: '00000000-0000-4000-8000-000000000015',
      sessionId: '00000000-0000-4000-8000-000000000012',
      establishedAt: '2026-10-31T00:00:00.000Z',
    },
  },
  tokenType: 'Bearer',
  refreshToken: BEARER,
});

function keysOf(value: unknown): readonly string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

describe('installed mobile builds against the partner-capable server', () => {
  test('every request an installed build still sends is still accepted', () => {
    expect(
      MobileOidcStartRequestSchema.parse(INSTALLED_OIDC_START_REQUEST),
    ).toMatchObject({ platform: 'ios' });
    expect(
      MobileOidcExchangeRequestSchema.parse(INSTALLED_OIDC_EXCHANGE_REQUEST),
    ).toMatchObject({ codeVerifier: 'v'.repeat(64) });
    expect(
      MobileAppReviewSignInRequestSchema.parse(INSTALLED_APP_REVIEW_REQUEST),
    ).toMatchObject({ platform: 'android' });
    expect(
      RevokeSessionInputSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000002',
        reasonCode: 'USER_SIGN_OUT',
      }),
    ).toMatchObject({ reasonCode: 'USER_SIGN_OUT' });
  });

  test('every response an installed build parses strictly is unchanged', () => {
    // A field added to one of these is a field the installed build's strict
    // parse would refuse, which is how #470 broke every enrolled phone.
    const start = MobileOidcStartResponseSchema.parse(
      INSTALLED_OIDC_START_RESPONSE,
    );
    expect(keysOf(start)).toEqual(keysOf(INSTALLED_OIDC_START_RESPONSE));

    const session = MobileSessionResponseSchema.parse(
      INSTALLED_STAFF_SESSION_RESPONSE,
    );
    expect(keysOf(session)).toEqual(['refreshToken', 'session', 'tokenType']);
    expect(keysOf(session.session)).toEqual([
      'connectivityEpoch',
      'deviceEnrollment',
      'session',
      'user',
    ]);
    expect(keysOf(session.session.user)).toEqual(
      keysOf(INSTALLED_STAFF_SESSION_RESPONSE.session.user),
    );
    expect(keysOf(session.session.session)).toEqual(
      keysOf(INSTALLED_STAFF_SESSION_RESPONSE.session.session),
    );
    expect(keysOf(session.session.session.authorization)).toEqual(
      keysOf(INSTALLED_STAFF_SESSION_RESPONSE.session.session.authorization),
    );
    expect(keysOf(session.session.deviceEnrollment)).toEqual(
      keysOf(INSTALLED_STAFF_SESSION_RESPONSE.session.deviceEnrollment),
    );

    const revocation = SessionRevocationSchema.parse({
      id: '00000000-0000-4000-8000-000000000006',
      sessionId: '00000000-0000-4000-8000-000000000002',
      revokedBy: {
        kind: 'human',
        userId: '00000000-0000-4000-8000-000000000001',
        sessionId: '00000000-0000-4000-8000-000000000002',
      },
      revokedAt: '2026-10-31T00:10:00.000Z',
      reasonCode: 'USER_SIGN_OUT',
    });
    // Sign-out compares this receipt's session id with the one it revoked,
    // so the receipt's shape is part of the installed build's contract.
    expect(keysOf(revocation)).toEqual([
      'id',
      'reasonCode',
      'revokedAt',
      'revokedBy',
      'sessionId',
    ]);
  });

  test('native partner sign-in adds endpoints, never fields', () => {
    // The partner session travels on the envelope installed builds already
    // parse, so the server does not grow a second session shape. The only
    // difference is which arm of the authorization union it carries, and the
    // staff arm is byte-for-byte what it was.
    const partner = MobileSessionResponseSchema.parse(PARTNER_SESSION_RESPONSE);
    expect(keysOf(partner)).toEqual(keysOf(INSTALLED_STAFF_SESSION_RESPONSE));
    expect(keysOf(partner.session)).toEqual(
      keysOf(INSTALLED_STAFF_SESSION_RESPONSE.session),
    );
    expect(keysOf(partner.session.user)).toEqual(
      keysOf(INSTALLED_STAFF_SESSION_RESPONSE.session.user),
    );
    expect(keysOf(partner.session.deviceEnrollment)).toEqual(
      keysOf(INSTALLED_STAFF_SESSION_RESPONSE.session.deviceEnrollment),
    );
    // The partner request schemas are new names on new paths, so no
    // installed build sends or receives them.
    expect(
      MobilePartnerSignInStartRequestSchema.parse({
        email: 'responder@agency.example.invalid',
        platform: 'ios',
        installationId: INSTALLED_BUILD_INSTALLATION_ID,
      }),
    ).toMatchObject({ platform: 'ios' });
    expect(
      MobilePartnerSignInVerifyRequestSchema.parse({
        flowToken: `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`,
        code: '123456',
      }),
    ).toMatchObject({ code: '123456' });
  });

  test('native partner passkeys add endpoints, never fields', () => {
    // Issue #647. An installed build has no passkey code at all, so the only
    // thing that could break it is a change to what it already sends or
    // parses. The passkey ceremony lives on its own path, and the enrollment
    // hand-off the code sign-in now offers travels in a response header, so
    // the session envelope that build parses strictly is untouched.
    const verified = MobileSessionResponseSchema.parse(
      PARTNER_SESSION_RESPONSE,
    );
    expect(keysOf(verified)).toEqual(['refreshToken', 'session', 'tokenType']);
    expect(MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER.startsWith('X-')).toBe(
      true,
    );
    // The passkey request schemas are new names on a new path, so no
    // installed build sends or receives them.
    expect(
      MobilePartnerPasskeySignInStartRequestSchema.parse({
        step: 'sign-in-start',
        email: 'responder@agency.example.invalid',
        platform: 'android',
        installationId: INSTALLED_BUILD_INSTALLATION_ID,
      }).step,
    ).toBe('sign-in-start');
    // And the emailed code remains answerable exactly as it was, which is
    // the path an installed build and a device with no passkey both take.
    expect(
      MobilePartnerSignInVerifyRequestSchema.parse({
        flowToken: `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`,
        code: '654321',
      }),
    ).toMatchObject({ code: '654321' });
  });

  test('each session kind reports its own usable deadline', () => {
    const staff = MobileSessionResponseSchema.parse(
      INSTALLED_STAFF_SESSION_RESPONSE,
    );
    const partner = MobileSessionResponseSchema.parse(PARTNER_SESSION_RESPONSE);
    // The staff deadline is unchanged, so an installed build's cached-shell
    // arithmetic is unchanged.
    expect(
      sessionAuthorizationUsableUntil(staff.session.session.authorization),
    ).toBe('2026-11-07T00:00:00.000Z');
    expect(
      sessionAuthorizationUsableUntil(partner.session.session.authorization),
    ).toBe('2027-01-01T00:00:00.000Z');
    // A partner session itself still expires within the day, which is what
    // returns the partner to sign-in.
    expect(
      Date.parse(partner.session.session.expiresAt) -
        Date.parse(partner.session.session.createdAt),
    ).toBe(24 * 60 * 60 * 1_000);
  });
});
