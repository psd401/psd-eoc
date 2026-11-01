import { describe, expect, test } from 'bun:test';

import type {
  MobilePartnerPasskeySignInStartResponse,
  MobileSessionResponse,
} from '@psd-eoc/contracts';

import {
  enrollPartnerPasskey,
  signInPartnerWithPasskey,
  type PartnerPasskeyApi,
  type PartnerPasskeyPort,
} from './partner-passkey-client';

/**
 * Issue #647. Every way a passkey can fail to happen must end at the emailed
 * code, and the authenticator's answer must reach the server as the shape the
 * contract names and nothing more.
 */

const EMAIL = 'responder@agency.example.invalid';
const INSTALLATION_ID = 'native-partner-installation';
const FLOW_TOKEN = `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`;
const ENROLLMENT_TOKEN = `e1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`;

const REQUEST_OPTIONS = Object.freeze({
  rpId: 'eoc.example.invalid',
  challenge: 'Y2hhbGxlbmdl',
  userVerification: 'required' as const,
});

const CREATION_OPTIONS = Object.freeze({
  rp: { id: 'eoc.example.invalid', name: 'PSD EOC' },
  user: { id: 'dXNlcg', name: EMAIL, displayName: EMAIL },
  challenge: 'Y2hhbGxlbmdl',
  pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
});

const SESSION = { tokenType: 'Bearer' } as unknown as MobileSessionResponse;

/**
 * What a platform authenticator actually answers: WebAuthn's transport shape
 * plus fields the operating system adds and the server never reads.
 */
const NATIVE_ASSERTION = Object.freeze({
  id: 'Y3JlZGVudGlhbA',
  rawId: 'Y3JlZGVudGlhbA',
  type: 'public-key',
  authenticatorAttachment: 'platform',
  clientExtensionResults: {},
  response: {
    clientDataJSON: 'Y2xpZW50RGF0YQ',
    authenticatorData: 'YXV0aA',
    signature: 'c2ln',
    userHandle: 'dXNlcg',
    somethingTheOsAdded: 'ignored',
  },
});

const NATIVE_REGISTRATION = Object.freeze({
  id: 'Y3JlZGVudGlhbA',
  rawId: 'Y3JlZGVudGlhbA',
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response: {
    clientDataJSON: 'Y2xpZW50RGF0YQ',
    attestationObject: 'YXR0ZXN0YXRpb24',
    transports: ['internal', 'hybrid'],
    publicKey: 'cHVibGljLWtleQ',
    publicKeyAlgorithm: -7,
  },
});

interface Recorded {
  readonly calls: string[];
  readonly signInFinish: unknown[];
  readonly registerFinish: unknown[];
}

function api(
  overrides: Partial<PartnerPasskeyApi> = {},
  recorded: Recorded = { calls: [], signInFinish: [], registerFinish: [] },
): PartnerPasskeyApi & { readonly recorded: Recorded } {
  const offered: MobilePartnerPasskeySignInStartResponse = {
    method: 'passkey',
    flowToken: FLOW_TOKEN,
    options: REQUEST_OPTIONS,
    expiresAt: '2026-10-31T00:05:00.000Z',
  };
  return Object.freeze({
    recorded,
    partnerPasskeySignInStart:
      overrides.partnerPasskeySignInStart ??
      (() => {
        recorded.calls.push('sign-in-start');
        return Promise.resolve(offered);
      }),
    partnerPasskeySignInFinish:
      overrides.partnerPasskeySignInFinish ??
      ((
        input: Parameters<PartnerPasskeyApi['partnerPasskeySignInFinish']>[0],
      ) => {
        recorded.calls.push('sign-in-finish');
        recorded.signInFinish.push(input);
        return Promise.resolve(SESSION);
      }),
    partnerPasskeyRegisterStart:
      overrides.partnerPasskeyRegisterStart ??
      (() => {
        recorded.calls.push('register-start');
        return Promise.resolve({ options: CREATION_OPTIONS });
      }),
    partnerPasskeyRegisterFinish:
      overrides.partnerPasskeyRegisterFinish ??
      ((
        input: Parameters<PartnerPasskeyApi['partnerPasskeyRegisterFinish']>[0],
      ) => {
        recorded.calls.push('register-finish');
        recorded.registerFinish.push(input);
        return Promise.resolve();
      }),
  });
}

function port(overrides: Partial<PartnerPasskeyPort> = {}): PartnerPasskeyPort {
  return Object.freeze({
    isSupported: overrides.isSupported ?? (() => true),
    create: overrides.create ?? (() => Promise.resolve(NATIVE_REGISTRATION)),
    get: overrides.get ?? (() => Promise.resolve(NATIVE_ASSERTION)),
  });
}

function signIn(
  overrides: Readonly<{
    api?: PartnerPasskeyApi;
    port?: PartnerPasskeyPort;
  }> = {},
) {
  return signInPartnerWithPasskey({
    api: overrides.api ?? api(),
    port: overrides.port ?? port(),
    email: EMAIL,
    platform: 'ios',
    installationId: INSTALLATION_ID,
  });
}

describe('signing a partner in with a passkey', () => {
  test('a device with a passkey signs in', async () => {
    const recorded: Recorded = {
      calls: [],
      signInFinish: [],
      registerFinish: [],
    };
    const outcome = await signIn({ api: api({}, recorded) });
    expect(outcome).toEqual({ kind: 'signed-in', session: SESSION });
    expect(recorded.calls).toEqual(['sign-in-start', 'sign-in-finish']);
    // The flow the first step sealed is returned untouched, and only the
    // fields the contract names are sent on.
    expect(recorded.signInFinish[0]).toEqual({
      flowToken: FLOW_TOKEN,
      credential: {
        id: 'Y3JlZGVudGlhbA',
        rawId: 'Y3JlZGVudGlhbA',
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: 'Y2xpZW50RGF0YQ',
          authenticatorData: 'YXV0aA',
          signature: 'c2ln',
          userHandle: 'dXNlcg',
        },
      },
    });
  });

  test('a build or device with no passkey support never asks the server', async () => {
    const recorded: Recorded = {
      calls: [],
      signInFinish: [],
      registerFinish: [],
    };
    const outcome = await signIn({
      api: api({}, recorded),
      port: port({ isSupported: () => false }),
    });
    expect(outcome).toEqual({ kind: 'use-code' });
    // Which also means that address is not charged a probe it could not use.
    expect(recorded.calls).toEqual([]);
  });

  test('a server that says code, or cannot answer, ends at the code', async () => {
    expect(
      await signIn({
        api: api({
          partnerPasskeySignInStart: () =>
            Promise.resolve({ method: 'code' } as const),
        }),
      }),
    ).toEqual({ kind: 'use-code' });
    expect(
      await signIn({
        api: api({
          partnerPasskeySignInStart: () =>
            Promise.reject(new Error('unreachable')),
        }),
      }),
    ).toEqual({ kind: 'use-code' });
  });

  test('a dismissed sheet is not an error, it is the code', async () => {
    // The partner sees the address step again, exactly as if they had never
    // had a passkey. Nothing distinguishes the two, deliberately.
    expect(
      await signIn({
        port: port({ get: () => Promise.reject(new Error('cancelled')) }),
      }),
    ).toEqual({ kind: 'use-code' });
    expect(
      await signIn({ port: port({ get: () => Promise.resolve(null) }) }),
    ).toEqual({ kind: 'use-code' });
    expect(
      await signIn({
        port: port({ get: () => Promise.resolve({ id: 'only-an-id' }) }),
      }),
    ).toEqual({ kind: 'use-code' });
  });

  test('a refused assertion is raised, because that is worth showing', async () => {
    const refusal = new Error('The sign-in details were not accepted.');
    await expect(
      signIn({
        api: api({ partnerPasskeySignInFinish: () => Promise.reject(refusal) }),
      }),
    ).rejects.toBe(refusal);
  });
});

describe('enrolling a partner passkey', () => {
  test('a created passkey is handed to the pool in the contract shape', async () => {
    const recorded: Recorded = {
      calls: [],
      signInFinish: [],
      registerFinish: [],
    };
    expect(
      await enrollPartnerPasskey({
        api: api({}, recorded),
        port: port(),
        enrollmentToken: ENROLLMENT_TOKEN,
      }),
    ).toBe(true);
    expect(recorded.calls).toEqual(['register-start', 'register-finish']);
    // The public key the operating system volunteers is not sent: the server
    // never reads it, and its schema refuses what it does not name.
    expect(recorded.registerFinish[0]).toEqual({
      enrollmentToken: ENROLLMENT_TOKEN,
      credential: {
        id: 'Y3JlZGVudGlhbA',
        rawId: 'Y3JlZGVudGlhbA',
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: 'Y2xpZW50RGF0YQ',
          attestationObject: 'YXR0ZXN0YXRpb24',
          transports: ['internal', 'hybrid'],
        },
      },
    });
  });

  test('no support, or a declined ceremony, enrolls nothing and says so', async () => {
    const recorded: Recorded = {
      calls: [],
      signInFinish: [],
      registerFinish: [],
    };
    expect(
      await enrollPartnerPasskey({
        api: api({}, recorded),
        port: port({ isSupported: () => false }),
        enrollmentToken: ENROLLMENT_TOKEN,
      }),
    ).toBe(false);
    expect(recorded.calls).toEqual([]);
    expect(
      await enrollPartnerPasskey({
        api: api(),
        port: port({ create: () => Promise.reject(new Error('cancelled')) }),
        enrollmentToken: ENROLLMENT_TOKEN,
      }),
    ).toBe(false);
    expect(
      await enrollPartnerPasskey({
        api: api(),
        port: port({ create: () => Promise.resolve({ id: 'partial' }) }),
        enrollmentToken: ENROLLMENT_TOKEN,
      }),
    ).toBe(false);
  });

  test('a refused hand-off is raised rather than reported as declined', async () => {
    // An offer that silently did nothing would leave a partner believing
    // their next sign-in needs no inbox.
    const refusal = new Error('The sign-in details were not accepted.');
    await expect(
      enrollPartnerPasskey({
        api: api({
          partnerPasskeyRegisterStart: () => Promise.reject(refusal),
        }),
        port: port(),
        enrollmentToken: ENROLLMENT_TOKEN,
      }),
    ).rejects.toBe(refusal);
  });
});
