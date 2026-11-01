import { describe, expect, test } from 'bun:test';

import './index';
import {
  MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER,
  MobilePartnerPasskeyEnrollmentTokenSchema,
  MobilePartnerPasskeyRegisterFinishRequestSchema,
  MobilePartnerPasskeyRegisterStartRequestSchema,
  MobilePartnerPasskeyRequestSchema,
  MobilePartnerPasskeySignInStartRequestSchema,
  MobilePartnerPasskeySignInStartResponseSchema,
} from './index';

/**
 * Issue #647. The native passkey transport is tested for the two properties
 * that are not obvious from reading it: each seal is accepted only on the
 * surface it was made for, and the two ceremonies cannot be crossed.
 */

const NATIVE_FLOW_TOKEN = `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`;
const ENROLLMENT_TOKEN = `e1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`;
const INSTALLATION_ID = 'native-partner-installation';

const REQUEST_OPTIONS = Object.freeze({
  rpId: 'eoc.example.invalid',
  challenge: 'Y2hhbGxlbmdl',
  userVerification: 'required',
});

const ASSERTION = Object.freeze({
  id: 'Y3JlZGVudGlhbA',
  rawId: 'Y3JlZGVudGlhbA',
  type: 'public-key',
  response: {
    clientDataJSON: 'Y2xpZW50RGF0YQ',
    authenticatorData: 'YXV0aERhdGE',
    signature: 'c2lnbmF0dXJl',
  },
});

const REGISTRATION = Object.freeze({
  id: 'Y3JlZGVudGlhbA',
  rawId: 'Y3JlZGVudGlhbA',
  type: 'public-key',
  response: {
    clientDataJSON: 'Y2xpZW50RGF0YQ',
    attestationObject: 'YXR0ZXN0YXRpb24',
  },
});

describe('the native partner passkey enrollment hand-off', () => {
  test('accepts the native seal and refuses every other surface', () => {
    expect(
      MobilePartnerPasskeyEnrollmentTokenSchema.parse(ENROLLMENT_TOKEN),
    ).toBe(ENROLLMENT_TOKEN);
    // `k1` is the browser cookie's label and `n1` the native sign-in flow's.
    // Neither is an enrollment hand-off, and reading one as the other is the
    // mix-up the labels exist to prevent.
    for (const foreign of [
      `k1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`,
      NATIVE_FLOW_TOKEN,
      `e1.${'a'.repeat(16)}.${'b'.repeat(64)}`,
      `e1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}.extra`,
    ]) {
      expect(
        MobilePartnerPasskeyEnrollmentTokenSchema.safeParse(foreign).success,
      ).toBe(false);
    }
  });

  test('travels under a header name, never a body field', () => {
    expect(MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER).toBe(
      'X-PSD-EOC-Partner-Passkey-Enrollment',
    );
  });
});

describe('the native passkey sign-in steps', () => {
  test('the first step normalizes the address and names the device', () => {
    expect(
      MobilePartnerPasskeySignInStartRequestSchema.parse({
        step: 'sign-in-start',
        email: '  Responder@Agency.Example.Invalid ',
        platform: 'ios',
        installationId: INSTALLATION_ID,
      }),
    ).toEqual({
      step: 'sign-in-start',
      email: 'responder@agency.example.invalid',
      platform: 'ios',
      installationId: INSTALLATION_ID,
    });
  });

  test('a first step with no device is refused', () => {
    expect(
      MobilePartnerPasskeySignInStartRequestSchema.safeParse({
        step: 'sign-in-start',
        email: 'responder@agency.example.invalid',
      }).success,
    ).toBe(false);
  });

  test('the answer is the ceremony or an emailed code, and nothing else', () => {
    const offered = MobilePartnerPasskeySignInStartResponseSchema.parse({
      method: 'passkey',
      flowToken: NATIVE_FLOW_TOKEN,
      options: REQUEST_OPTIONS,
      expiresAt: '2026-10-31T00:05:00.000Z',
    });
    expect(offered.method).toBe('passkey');
    expect(
      MobilePartnerPasskeySignInStartResponseSchema.parse({ method: 'code' }),
    ).toEqual({ method: 'code' });
    // The code answer says nothing else: a field beside it would be a field
    // that could differ between an unenrolled address and an unknown one.
    expect(
      MobilePartnerPasskeySignInStartResponseSchema.safeParse({
        method: 'code',
        enrolled: false,
      }).success,
    ).toBe(false);
    // An address literal cannot be a relying party, so options naming one are
    // refused before any authenticator is asked to sign them.
    expect(
      MobilePartnerPasskeySignInStartResponseSchema.safeParse({
        method: 'passkey',
        flowToken: NATIVE_FLOW_TOKEN,
        options: { ...REQUEST_OPTIONS, rpId: '127.0.0.1' },
        expiresAt: '2026-10-31T00:05:00.000Z',
      }).success,
    ).toBe(false);
  });

  test('the second step reads the address from the seal alone', () => {
    const parsed = MobilePartnerPasskeyRequestSchema.parse({
      step: 'sign-in-finish',
      flowToken: NATIVE_FLOW_TOKEN,
      credential: ASSERTION,
    });
    expect(parsed.step).toBe('sign-in-finish');
    expect(
      MobilePartnerPasskeyRequestSchema.safeParse({
        step: 'sign-in-finish',
        flowToken: NATIVE_FLOW_TOKEN,
        credential: ASSERTION,
        email: 'someone.else@agency.example.invalid',
      }).success,
    ).toBe(false);
  });
});

describe('the native passkey enrollment steps', () => {
  test('each step is authorized by the hand-off and nothing else', () => {
    expect(
      MobilePartnerPasskeyRegisterStartRequestSchema.parse({
        step: 'register-start',
        enrollmentToken: ENROLLMENT_TOKEN,
      }).enrollmentToken,
    ).toBe(ENROLLMENT_TOKEN);
    expect(
      MobilePartnerPasskeyRegisterFinishRequestSchema.parse({
        step: 'register-finish',
        enrollmentToken: ENROLLMENT_TOKEN,
        credential: REGISTRATION,
      }).step,
    ).toBe('register-finish');
  });

  test('an assertion is not an enrollment and a registration is not a sign-in', () => {
    // The two ceremonies produce different documents, and crossing them is
    // what a confused-ceremony attempt looks like on the wire.
    expect(
      MobilePartnerPasskeyRegisterFinishRequestSchema.safeParse({
        step: 'register-finish',
        enrollmentToken: ENROLLMENT_TOKEN,
        credential: ASSERTION,
      }).success,
    ).toBe(false);
    expect(
      MobilePartnerPasskeyRequestSchema.safeParse({
        step: 'sign-in-finish',
        flowToken: NATIVE_FLOW_TOKEN,
        credential: REGISTRATION,
      }).success,
    ).toBe(false);
  });

  test('an unknown step is refused rather than guessed', () => {
    expect(
      MobilePartnerPasskeyRequestSchema.safeParse({
        step: 'register-cancel',
        enrollmentToken: ENROLLMENT_TOKEN,
      }).success,
    ).toBe(false);
  });
});
