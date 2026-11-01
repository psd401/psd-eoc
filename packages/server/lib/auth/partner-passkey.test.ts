import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  CompleteWebAuthnRegistrationCommand,
  StartWebAuthnRegistrationCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  readPartnerPoolConfiguration,
  SYNTHETIC_PARTNER_USER_POOL_ID,
  type PartnerPoolConfiguration,
} from './identity-providers';
import { syntheticPartnerAccessToken } from './partner-otp';
import {
  CognitoPartnerPasskeyProvider,
  partnerRelyingPartyIdForRequest,
  partnerRelyingPartyIdFromOrigin,
  readPasskeyClientData,
  resetSyntheticPartnerPasskeys,
  resolvePartnerPasskeyProvider,
  syntheticPartnerHasPasskey,
  syntheticPartnerPasskeyProvider,
  type PartnerPasskeyProvider,
} from './partner-passkey';

/**
 * Issue #599. The partner pool's second first factor.
 *
 * The properties that matter are: the relying-party id is derived from the
 * application's own origin and never configured beside it; a ceremony
 * performed for another origin is refused; a pool that offers passkey options
 * for another relying party is a configuration failure rather than something
 * handed to a partner; and every refusal is one refusal.
 */

const EMAIL = 'responder@agency.example.invalid';
const ORIGIN = 'https://eoc.example.invalid';
const RELYING_PARTY = 'eoc.example.invalid';

const pool: PartnerPoolConfiguration = Object.freeze({
  userPoolId: 'us-west-2_Example1',
  clientId: 'partner-app-client',
  clientSecretArn:
    'arn:aws:secretsmanager:us-west-2:111122223333:secret:/psd-eoc/partner-user-pool-client-AbCdEf',
  issuer: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Example1',
  jwksUri:
    'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Example1/.well-known/jwks.json',
  synthetic: false,
});

const syntheticPool: PartnerPoolConfiguration = Object.freeze({
  userPoolId: SYNTHETIC_PARTNER_USER_POOL_ID,
  clientId: SYNTHETIC_PARTNER_USER_POOL_ID,
  clientSecretArn: null,
  issuer: 'https://cognito-idp.example.invalid/synthetic-partner-pool',
  jwksUri:
    'https://cognito-idp.example.invalid/synthetic-partner-pool/.well-known/jwks.json',
  synthetic: true,
});

/** base64url, the encoding every WebAuthn transport field uses. */
function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function clientData(overrides: Readonly<Record<string, unknown>> = {}): string {
  return base64url(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: 'Y2hhbGxlbmdl',
      origin: ORIGIN,
      ...overrides,
    }),
  );
}

function assertion(
  clientDataJSON: string,
  id = 'Y3JlZGVudGlhbC1pZA',
): Parameters<PartnerPasskeyProvider['verifySignIn']>[0]['credential'] {
  return Object.freeze({
    id,
    rawId: id,
    type: 'public-key' as const,
    response: Object.freeze({
      clientDataJSON,
      authenticatorData: 'YXV0aGVudGljYXRvci1kYXRh',
      signature: 'c2lnbmF0dXJl',
    }),
  });
}

function registration(
  clientDataJSON: string,
  id = 'Y3JlZGVudGlhbC1pZA',
): Parameters<PartnerPasskeyProvider['completeRegistration']>[0]['credential'] {
  return Object.freeze({
    id,
    rawId: id,
    type: 'public-key' as const,
    response: Object.freeze({
      clientDataJSON,
      attestationObject: 'YXR0ZXN0YXRpb24',
    }),
  });
}

describe('the partner passkey relying party', () => {
  test('is the application origin’s own hostname', () => {
    expect(partnerRelyingPartyIdFromOrigin(ORIGIN)).toBe(RELYING_PARTY);
    // A port is not part of a relying-party id, and localhost is a hostname.
    expect(partnerRelyingPartyIdFromOrigin('http://localhost:3000')).toBe(
      'localhost',
    );
    expect(
      partnerRelyingPartyIdFromOrigin('https://EOC.Example.Invalid/ignored'),
    ).toBe(RELYING_PARTY);
  });

  test('an origin with no usable hostname is a configuration failure', () => {
    // Deriving rather than configuring is the point: an origin a passkey
    // could never be bound to must fail loudly here instead of producing
    // ceremonies no browser will ever complete.
    for (const origin of [
      'not-a-url',
      'https://127.0.0.1',
      'https://[::1]',
      'https://_underscore.example.invalid',
    ]) {
      expect(() => partnerRelyingPartyIdFromOrigin(origin)).toThrow();
    }
  });

  test('production uses the configured origin and development the request’s', () => {
    expect(
      partnerRelyingPartyIdForRequest('http://localhost:3000/auth/partner', {
        NODE_ENV: 'development',
      }),
    ).toBe('localhost');
    expect(
      partnerRelyingPartyIdForRequest('http://localhost:3000/auth/partner', {
        NODE_ENV: 'production',
        GOOGLE_OIDC_APPLICATION_ORIGIN: ORIGIN,
      }),
    ).toBe(RELYING_PARTY);
  });
});

describe('reading WebAuthn client data', () => {
  test('accepts the expected ceremony on this origin', () => {
    expect(
      readPasskeyClientData(clientData(), {
        type: 'webauthn.get',
        origin: ORIGIN,
      }),
    ).toMatchObject({ type: 'webauthn.get', origin: ORIGIN });
  });

  test('refuses another origin, another ceremony, and a framed ceremony', () => {
    const cases: readonly string[] = [
      clientData({ origin: 'https://evil.example.invalid' }),
      clientData({ type: 'webauthn.create' }),
      clientData({ crossOrigin: true }),
      clientData({ topOrigin: 'https://evil.example.invalid' }),
    ];
    for (const value of cases) {
      expect(
        readPasskeyClientData(value, {
          type: 'webauthn.get',
          origin: ORIGIN,
        }),
      ).toBeNull();
    }
  });

  test('refuses anything that is not client data at all', () => {
    for (const value of [
      '',
      'not base64url!!',
      base64url('not json'),
      base64url(JSON.stringify({ type: 'webauthn.get' })),
      base64url(JSON.stringify([])),
    ]) {
      expect(
        readPasskeyClientData(value, {
          type: 'webauthn.get',
          origin: ORIGIN,
        }),
      ).toBeNull();
    }
  });

  test('an unknown extra field does not refuse a valid ceremony', () => {
    // Browsers may add fields to client data; one must not break sign-in.
    expect(
      readPasskeyClientData(clientData({ somethingNew: 'value' }), {
        type: 'webauthn.get',
        origin: ORIGIN,
      }),
    ).not.toBeNull();
  });
});

describe('the synthetic partner passkey stand-in', () => {
  let provider: PartnerPasskeyProvider;

  beforeEach(() => {
    resetSyntheticPartnerPasskeys();
    provider = syntheticPartnerPasskeyProvider(syntheticPool);
  });

  afterEach(() => {
    resetSyntheticPartnerPasskeys();
  });

  async function enroll(email = EMAIL, id = 'Y3JlZGVudGlhbC1pZA') {
    const options = await provider.startRegistration({
      email,
      accessToken: syntheticPartnerAccessToken(email),
      relyingPartyId: RELYING_PARTY,
    });
    await provider.completeRegistration({
      email,
      accessToken: syntheticPartnerAccessToken(email),
      credential: registration(
        clientData({
          type: 'webauthn.create',
          challenge: options.challenge,
        }),
        id,
      ),
    });
    return options;
  }

  test('an address with no passkey signs in with a code instead', async () => {
    // Null is the answer for every address that cannot use a passkey, which
    // is what keeps the first step from answering who is enrolled.
    expect(await provider.startSignIn(EMAIL, RELYING_PARTY)).toBeNull();
    expect(syntheticPartnerHasPasskey(EMAIL)).toBe(false);
  });

  test('an enrolled address is offered its own credential', async () => {
    await enroll();
    expect(syntheticPartnerHasPasskey(EMAIL)).toBe(true);
    const challenge = await provider.startSignIn(EMAIL, RELYING_PARTY);
    expect(challenge).not.toBeNull();
    expect(challenge?.options).toMatchObject({
      rpId: RELYING_PARTY,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: 'Y3JlZGVudGlhbC1pZA' }],
    });
  });

  test('an enrolled partner signs in with its passkey', async () => {
    await enroll();
    const challenge = await provider.startSignIn(EMAIL, RELYING_PARTY);
    const verified = await provider.verifySignIn({
      email: EMAIL,
      flowSession: challenge?.flowSession ?? '',
      credential: assertion(
        clientData({ challenge: challenge?.options.challenge }),
      ),
    });
    expect(verified.claims).toMatchObject({
      issuer: syntheticPool.issuer,
      email: EMAIL,
    });
    expect(verified.accessToken).toBe(syntheticPartnerAccessToken(EMAIL));
  });

  test('two sign-ins by one partner are two exchanges, never a replay', async () => {
    await enroll();
    const digests = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const challenge = await provider.startSignIn(EMAIL, RELYING_PARTY);
      const verified = await provider.verifySignIn({
        email: EMAIL,
        flowSession: challenge?.flowSession ?? '',
        credential: assertion(
          clientData({ challenge: challenge?.options.challenge }),
        ),
      });
      digests.add(verified.claims.claimsDigest);
    }
    expect(digests.size).toBe(2);
  });

  test('a challenge is spent whether or not the assertion is accepted', async () => {
    await enroll();
    const challenge = await provider.startSignIn(EMAIL, RELYING_PARTY);
    const flowSession = challenge?.flowSession ?? '';
    // Wrong challenge: refused, and the session is gone with it.
    await expect(
      provider.verifySignIn({
        email: EMAIL,
        flowSession,
        credential: assertion(clientData({ challenge: 'd3Jvbmc' })),
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
    await expect(
      provider.verifySignIn({
        email: EMAIL,
        flowSession,
        credential: assertion(
          clientData({ challenge: challenge?.options.challenge }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
  });

  test('a credential registered to another address is refused', async () => {
    await enroll(EMAIL, 'Zmlyc3Q');
    await enroll('other@agency.example.invalid', 'c2Vjb25k');
    const challenge = await provider.startSignIn(EMAIL, RELYING_PARTY);
    await expect(
      provider.verifySignIn({
        email: EMAIL,
        flowSession: challenge?.flowSession ?? '',
        credential: assertion(
          clientData({ challenge: challenge?.options.challenge }),
          'c2Vjb25k',
        ),
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
  });

  test('a hand-off for another address enrolls nothing', async () => {
    // The real pool decides this by reading its own token; the stand-in
    // derives it, so the binding is still proven.
    for (const call of [
      provider.startRegistration({
        email: EMAIL,
        accessToken: syntheticPartnerAccessToken(
          'someone-else@example.invalid',
        ),
        relyingPartyId: RELYING_PARTY,
      }),
      provider.completeRegistration({
        email: EMAIL,
        accessToken: syntheticPartnerAccessToken(
          'someone-else@example.invalid',
        ),
        credential: registration(clientData({ type: 'webauthn.create' })),
      }),
    ]) {
      await expect(call).rejects.toMatchObject({
        code: 'PARTNER_SIGN_IN_REFUSED',
      });
    }
    expect(syntheticPartnerHasPasskey(EMAIL)).toBe(false);
  });

  test('a credential answering a challenge that was never issued is refused', async () => {
    await expect(
      provider.completeRegistration({
        email: EMAIL,
        accessToken: syntheticPartnerAccessToken(EMAIL),
        credential: registration(
          clientData({ type: 'webauthn.create', challenge: 'dW5pc3N1ZWQ' }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
    expect(syntheticPartnerHasPasskey(EMAIL)).toBe(false);
  });

  test('registration options name this relying party and require verification', async () => {
    const options = await provider.startRegistration({
      email: EMAIL,
      accessToken: syntheticPartnerAccessToken(EMAIL),
      relyingPartyId: RELYING_PARTY,
    });
    expect(options).toMatchObject({
      rp: { id: RELYING_PARTY },
      user: { name: EMAIL },
      authenticatorSelection: { userVerification: 'required' },
    });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
  });
});

/** One stubbed Cognito call, recording what the provider asked for. */
function stubClient(
  handler: (command: unknown) => unknown,
): Readonly<{ sent: unknown[]; send: (command: unknown) => Promise<unknown> }> {
  const sent: unknown[] = [];
  return {
    sent,
    send: (command: unknown) => {
      sent.push(command);
      const answer = handler(command);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
}

function cognito(handler: (command: unknown) => unknown): Readonly<{
  provider: CognitoPartnerPasskeyProvider;
  sent: unknown[];
}> {
  const client = stubClient(handler);
  return {
    provider: new CognitoPartnerPasskeyProvider(pool, client as never, () =>
      Promise.resolve('client-secret'),
    ),
    sent: client.sent,
  };
}

describe('the Cognito partner passkey provider', () => {
  test('asks the pool for the passkey challenge by preference', async () => {
    const requestOptions = {
      rpId: RELYING_PARTY,
      challenge: 'Y2hhbGxlbmdl',
      userVerification: 'required',
    };
    const { provider, sent } = cognito((command) =>
      command instanceof AdminInitiateAuthCommand
        ? {
            Session: 'pool-session',
            ChallengeName: 'WEB_AUTHN',
            ChallengeParameters: {
              CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(requestOptions),
            },
          }
        : new Error('unexpected command'),
    );
    const challenge = await provider.startSignIn(EMAIL, RELYING_PARTY);
    expect(challenge).toMatchObject({
      flowSession: 'pool-session',
      options: requestOptions,
    });
    const initiated = sent[0] as AdminInitiateAuthCommand;
    expect(initiated.input.AuthFlow).toBe('USER_AUTH');
    expect(initiated.input.AuthParameters?.PREFERRED_CHALLENGE).toBe(
      'WEB_AUTHN',
    );
    // Every call on a partner's behalf is attributable to the confidential
    // client, so the secret hash is never omitted.
    expect(initiated.input.AuthParameters?.SECRET_HASH).toBeString();
  });

  test('every answer that is not a passkey challenge means use a code', async () => {
    const answers: readonly unknown[] = [
      { Session: 'pool-session', ChallengeName: 'EMAIL_OTP' },
      { ChallengeName: 'WEB_AUTHN' },
      Object.assign(new Error('no such user'), {
        name: 'UserNotFoundException',
      }),
    ];
    for (const answer of answers) {
      const { provider } = cognito(() => answer);
      expect(await provider.startSignIn(EMAIL, RELYING_PARTY)).toBeNull();
    }
  });

  test('options for another relying party are never handed to a partner', async () => {
    // A pool whose WebAuthn configuration has drifted from the application's
    // hostname would mint passkeys the browser never offers back. That is a
    // configuration failure, not a ceremony.
    const { provider } = cognito(() => ({
      Session: 'pool-session',
      ChallengeName: 'WEB_AUTHN',
      ChallengeParameters: {
        CREDENTIAL_REQUEST_OPTIONS: JSON.stringify({
          rpId: 'elsewhere.example.invalid',
          challenge: 'Y2hhbGxlbmdl',
          userVerification: 'required',
        }),
      },
    }));
    await expect(
      provider.startSignIn(EMAIL, RELYING_PARTY),
    ).rejects.toMatchObject({ code: 'PARTNER_PROVIDER_UNAVAILABLE' });
  });

  test('a rejected assertion is the one refusal', async () => {
    const { provider } = cognito((command) =>
      command instanceof AdminRespondToAuthChallengeCommand
        ? new Error('NotAuthorizedException')
        : new Error('unexpected command'),
    );
    await expect(
      provider.verifySignIn({
        email: EMAIL,
        flowSession: 'pool-session',
        credential: assertion(clientData()),
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
  });

  test('answers the challenge with the credential document the pool expects', async () => {
    const { provider, sent } = cognito((command) =>
      command instanceof AdminRespondToAuthChallengeCommand
        ? { AuthenticationResult: {} }
        : new Error('unexpected command'),
    );
    // No identity token in the answer, so this is still a refusal — what is
    // being checked is the shape of the call that was made.
    await expect(
      provider.verifySignIn({
        email: EMAIL,
        flowSession: 'pool-session',
        credential: assertion(clientData()),
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
    const responded = sent[0] as AdminRespondToAuthChallengeCommand;
    expect(responded.input.ChallengeName).toBe('WEB_AUTHN');
    expect(responded.input.Session).toBe('pool-session');
    expect(responded.input.ChallengeResponses?.USERNAME).toBe(EMAIL);
    expect(
      JSON.parse(responded.input.ChallengeResponses?.CREDENTIAL ?? 'null'),
    ).toMatchObject({ type: 'public-key' });
  });

  test('registration is authorized by the pool’s access token', async () => {
    const creationOptions = {
      rp: { id: RELYING_PARTY, name: 'PSD EOC' },
      user: { id: 'dXNlci1pZA', name: EMAIL, displayName: EMAIL },
      challenge: 'Y2hhbGxlbmdl',
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    };
    const { provider, sent } = cognito((command) => {
      if (command instanceof StartWebAuthnRegistrationCommand) {
        return { CredentialCreationOptions: creationOptions };
      }
      if (command instanceof CompleteWebAuthnRegistrationCommand) {
        return {};
      }
      return new Error('unexpected command');
    });
    expect(
      await provider.startRegistration({
        email: EMAIL,
        accessToken: 'pool-access-token',
        relyingPartyId: RELYING_PARTY,
      }),
    ).toMatchObject(creationOptions);
    expect(
      (sent[0] as StartWebAuthnRegistrationCommand).input.AccessToken,
    ).toBe('pool-access-token');

    await provider.completeRegistration({
      email: EMAIL,
      accessToken: 'pool-access-token',
      credential: registration(clientData({ type: 'webauthn.create' })),
    });
    const completed = sent[1] as CompleteWebAuthnRegistrationCommand;
    expect(completed.input.AccessToken).toBe('pool-access-token');
    // The credential reaches the pool as a plain JSON document.
    expect(completed.input.Credential).toMatchObject({ type: 'public-key' });
  });

  test('a passkey for another relying party is never enrolled', async () => {
    const { provider } = cognito((command) =>
      command instanceof StartWebAuthnRegistrationCommand
        ? {
            CredentialCreationOptions: {
              rp: { id: 'elsewhere.example.invalid', name: 'PSD EOC' },
              user: { id: 'dXNlci1pZA', name: EMAIL, displayName: EMAIL },
              challenge: 'Y2hhbGxlbmdl',
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            },
          }
        : new Error('unexpected command'),
    );
    await expect(
      provider.startRegistration({
        email: EMAIL,
        accessToken: 'pool-access-token',
        relyingPartyId: RELYING_PARTY,
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_PROVIDER_UNAVAILABLE' });
  });

  test('a pool with no app-client credential cannot be constructed', () => {
    expect(
      () =>
        new CognitoPartnerPasskeyProvider({ ...pool, clientSecretArn: null }),
    ).toThrow();
  });
});

describe('resolving the partner passkey provider', () => {
  const names = [
    'PSD_EOC_PARTNER_USER_POOL_ID',
    'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN',
    'DATABASE_URL',
  ] as const;
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of names) original.set(name, process.env[name]);
  });

  afterEach(() => {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        Reflect.set(process.env, name, value);
      }
    }
  });

  test('a deployment with no partner pool has no passkey path', () => {
    expect(resolvePartnerPasskeyProvider({})).toBeNull();
    expect(
      resolvePartnerPasskeyProvider({
        PSD_EOC_PARTNER_USER_POOL_ID: 'UNCONFIGURED',
      }),
    ).toBeNull();
  });

  test('the synthetic pool selects the stand-in, and only from a test', () => {
    const testEnvironment = Object.freeze({
      PSD_EOC_PARTNER_USER_POOL_ID: SYNTHETIC_PARTNER_USER_POOL_ID,
      PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: 'allowed',
      DATABASE_URL: 'postgresql://psd_eoc_test@127.0.0.1:55432/psd_eoc_test',
    });
    // The same rule the code path already enforces, restated through this
    // resolver: the stand-in is not reachable from a deployed configuration.
    expect(readPartnerPoolConfiguration(testEnvironment)?.synthetic).toBe(true);
    expect(resolvePartnerPasskeyProvider(testEnvironment)).not.toBeNull();
    expect(() =>
      resolvePartnerPasskeyProvider({
        ...testEnvironment,
        PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: undefined,
      }),
    ).toThrow();
  });
});
