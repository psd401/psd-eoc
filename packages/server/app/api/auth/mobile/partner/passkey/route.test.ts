import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { NextRequest } from 'next/server';

import {
  openPartnerSignInFlow,
  sealPartnerSignInFlow,
} from '../../../../../../lib/auth/partner-flow-cookie';
import { syntheticPartnerAccessToken } from '../../../../../../lib/auth/partner-otp';
import { sealPartnerPasskeyEnrollment } from '../../../../../../lib/auth/partner-passkey-enrollment';
import {
  resetPoolMailsOnProbe,
  resetSyntheticPartnerPasskeys,
  syntheticPartnerHasPasskey,
} from '../../../../../../lib/auth/partner-passkey';
import { POST } from './route';

/**
 * Issue #647. The native partner passkey endpoint: what it accepts, what it
 * refuses, and what it declines to say.
 *
 * Nothing here reaches a database. Every path tested either refuses before a
 * session could be issued or stops at the enrollment hand-off, which never
 * touches one; the admission's own refusals are proved against a real
 * database in `lib/auth/partner-sign-in.database.test.ts`.
 */

const ORIGIN = 'http://localhost:3000';
const ACTION = `${ORIGIN}/api/auth/mobile/partner/passkey`;
// Outside production the relying party is the request's own host, so the
// ceremony origin iOS would report for this request is this.
const IOS_CEREMONY_ORIGIN = 'https://localhost';
const FINGERPRINT = `${'AB:'.repeat(31)}CD`;
const ANDROID_CEREMONY_ORIGIN = `android:apk-key-hash:${Buffer.from(
  FINGERPRINT.replace(/:/gu, ''),
  'hex',
).toString('base64url')}`;
const COOKIE_SECRET = Buffer.alloc(32, 61).toString('base64url');
/**
 * One address per test, and one caller per request.
 *
 * The limiter's budgets are per address and per client and live for the life
 * of the process, so a shard that runs this file beside the browser passkey
 * route's tests would have each of them spending the other's. Every test here
 * therefore names an address only it uses, and every request a caller only it
 * uses, which is the same rule the native emailed-code route's tests keep.
 */
let addressCounter = 0;
function address(): string {
  addressCounter += 1;
  return `native-passkey-${String(addressCounter)}@agency.example.invalid`;
}

function caller(): string {
  return `198.51.100.${String(Math.floor(Math.random() * 254) + 1)}`;
}
const INSTALLATION_ID = 'native-partner-installation';

const names = [
  'PSD_EOC_PARTNER_USER_POOL_ID',
  'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN',
  'PSD_EOC_ANDROID_SIGNING_FINGERPRINTS',
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_SSL_ROOT_CERT',
  'GOOGLE_OIDC_COOKIE_SECRET',
  'NODE_ENV',
] as const;
const original = new Map<string, string | undefined>();

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function clientData(overrides: Readonly<Record<string, unknown>> = {}): string {
  return base64url(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: 'Y2hhbGxlbmdl',
      origin: IOS_CEREMONY_ORIGIN,
      ...overrides,
    }),
  );
}

function assertionCredential(
  clientDataJSON = clientData(),
): Readonly<Record<string, unknown>> {
  return {
    id: 'Y3JlZGVudGlhbC1pZA',
    rawId: 'Y3JlZGVudGlhbC1pZA',
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData: 'YXV0aA',
      signature: 'c2ln',
    },
  };
}

function registrationCredential(
  clientDataJSON: string,
): Readonly<Record<string, unknown>> {
  return {
    id: 'Y3JlZGVudGlhbC1pZA',
    rawId: 'Y3JlZGVudGlhbC1pZA',
    type: 'public-key',
    response: { clientDataJSON, attestationObject: 'YXR0ZXN0YXRpb24' },
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(ACTION, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': caller(),
      },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

/** The hand-off the emailed-code sign-in would have handed this device. */
function enrollmentToken(
  options: Readonly<{
    email: string;
    platform?: 'ios' | 'android';
    accessToken?: string;
  }>,
): string {
  const { email } = options;
  return sealPartnerPasskeyEnrollment(
    {
      email,
      accessToken: options.accessToken ?? syntheticPartnerAccessToken(email),
      platform: options.platform ?? 'ios',
      expiresAt: Date.now() + 10 * 60 * 1_000,
    },
    process.env,
    'native',
  );
}

async function enrollPasskey(
  email: string,
  platform: 'ios' | 'android' = 'ios',
): Promise<void> {
  const token = enrollmentToken({ email, platform });
  const started = await post({
    step: 'register-start',
    enrollmentToken: token,
  });
  expect(started.status).toBe(200);
  const { options } = (await started.json()) as {
    options: { challenge: string };
  };
  const finished = await post({
    step: 'register-finish',
    enrollmentToken: token,
    credential: registrationCredential(
      clientData({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin:
          platform === 'ios' ? IOS_CEREMONY_ORIGIN : ANDROID_CEREMONY_ORIGIN,
      }),
    ),
  });
  expect(finished.status).toBe(200);
  expect(await finished.json()).toEqual({ status: 'registered' });
}

beforeEach(() => {
  for (const name of names) original.set(name, process.env[name]);
  Reflect.set(process.env, 'PSD_EOC_PARTNER_USER_POOL_ID', 'SYNTHETIC');
  Reflect.set(process.env, 'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN', 'allowed');
  Reflect.set(process.env, 'PSD_EOC_ANDROID_SIGNING_FINGERPRINTS', FINGERPRINT);
  Reflect.set(
    process.env,
    'DATABASE_URL',
    'postgresql://psd_eoc_test@127.0.0.1:55432/psd_eoc_test',
  );
  Reflect.deleteProperty(process.env, 'DATABASE_HOST');
  Reflect.deleteProperty(process.env, 'DATABASE_SSL_ROOT_CERT');
  Reflect.set(process.env, 'GOOGLE_OIDC_COOKIE_SECRET', COOKIE_SECRET);
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  resetSyntheticPartnerPasskeys();
  resetPoolMailsOnProbe();
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
  resetSyntheticPartnerPasskeys();
  resetPoolMailsOnProbe();
});

describe('the native partner passkey endpoint', () => {
  test('refuses anything that is not one of the four steps', async () => {
    const email = address();
    for (const body of [
      { step: 'list-credentials' },
      { step: 'sign-in-start' },
      { step: 'sign-in-start', email: 'not-an-address', platform: 'ios' },
      { step: 'sign-in-start', email, platform: 'web' },
      { step: 'register-start' },
      { step: 'register-start', enrollmentToken: 'k1.a.b.c' },
      {},
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  test('an address with no passkey is told to use a code', async () => {
    const email = address();
    const response = await post({
      step: 'sign-in-start',
      email,
      platform: 'ios',
      installationId: INSTALLATION_ID,
    });
    expect(response.status).toBe(200);
    // The answer carries nothing but the method, so it says nothing about
    // whether the address has partner access or an account at all.
    expect(await response.json()).toEqual({ method: 'code' });
  });

  test('every response forbids caching and referrers', async () => {
    const email = address();
    const response = await post({
      step: 'sign-in-start',
      email,
      platform: 'android',
      installationId: INSTALLATION_ID,
    });
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('a deployment with no partner pool has no native passkey path', async () => {
    const email = address();
    Reflect.set(process.env, 'PSD_EOC_PARTNER_USER_POOL_ID', 'UNCONFIGURED');
    const response = await post({
      step: 'sign-in-start',
      email,
      platform: 'ios',
      installationId: INSTALLATION_ID,
    });
    expect(response.status).toBe(404);
  });

  test('registration needs the hand-off, never a session', async () => {
    // A session is this application's own credential and cannot authorize a
    // change inside the pool, so a hand-off this deployment did not seal is
    // refused.
    const email = address();
    const foreign = sealPartnerPasskeyEnrollment(
      {
        email,
        accessToken: syntheticPartnerAccessToken(email),
        platform: 'ios',
        expiresAt: Date.now() + 10 * 60 * 1_000,
      },
      { GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 7).toString('base64url') },
      'native',
    );
    expect(
      (await post({ step: 'register-start', enrollmentToken: foreign })).status,
    ).toBe(401);
    // An expired hand-off is refused the same way.
    const expired = sealPartnerPasskeyEnrollment(
      {
        email,
        accessToken: syntheticPartnerAccessToken(email),
        platform: 'ios',
        expiresAt: Date.now() - 1_000,
      },
      process.env,
      'native',
    );
    expect(
      (await post({ step: 'register-start', enrollmentToken: expired })).status,
    ).toBe(401);
  });

  test('a hand-off for another address enrolls nothing', async () => {
    // The stand-in derives the pool's token from the address, so a hand-off
    // whose token belongs to somebody else is the pool refusing it.
    const email = address();
    const response = await post({
      step: 'register-start',
      enrollmentToken: enrollmentToken({
        email,
        accessToken: syntheticPartnerAccessToken('someone.else@x.invalid'),
      }),
    });
    expect(response.status).toBe(401);
    expect(syntheticPartnerHasPasskey(email)).toBe(false);
  });

  test('a partner enrolls a passkey from the app and then signs in with it', async () => {
    const email = address();
    expect(syntheticPartnerHasPasskey(email)).toBe(false);
    await enrollPasskey(email);
    expect(syntheticPartnerHasPasskey(email)).toBe(true);

    const offered = await post({
      step: 'sign-in-start',
      email,
      platform: 'ios',
      installationId: INSTALLATION_ID,
    });
    expect(offered.status).toBe(200);
    const answer = (await offered.json()) as {
      method: string;
      flowToken: string;
      options: { rpId: string; userVerification: string };
    };
    expect(answer.method).toBe('passkey');
    expect(answer.options.rpId).toBe('localhost');
    expect(answer.options.userVerification).toBe('required');
    // The flow is sealed for the app, for this device, and for the passkey
    // factor, so it can neither be answered with a code nor presented as the
    // browser's cookie.
    const flow = openPartnerSignInFlow(
      answer.flowToken,
      new Date(),
      process.env,
      'native',
    );
    expect(flow).toMatchObject({
      email,
      factor: 'passkey',
      platform: 'ios',
      installationId: INSTALLATION_ID,
    });
    expect(
      openPartnerSignInFlow(answer.flowToken, new Date(), process.env),
    ).toBeNull();
  });

  test('a ceremony performed for another origin is refused', async () => {
    const email = address();
    await enrollPasskey(email);
    const offered = await post({
      step: 'sign-in-start',
      email,
      platform: 'ios',
      installationId: INSTALLATION_ID,
    });
    const { flowToken, options } = (await offered.json()) as {
      flowToken: string;
      options: { challenge: string };
    };
    for (const origin of [
      'https://evil.example.invalid',
      // An Android app's own ceremony origin is not this device's: the
      // platform comes from the seal, so one cannot be presented as the
      // other.
      ANDROID_CEREMONY_ORIGIN,
    ]) {
      const response = await post({
        step: 'sign-in-finish',
        flowToken,
        credential: assertionCredential(
          clientData({ challenge: options.challenge, origin }),
        ),
      });
      expect(response.status).toBe(401);
    }
  });

  test('an Android ceremony is checked against the signing certificate', async () => {
    // The same fingerprint `/.well-known/assetlinks.json` is built from, so
    // the document and this check cannot disagree.
    const email = address();
    await enrollPasskey(email, 'android');
    expect(syntheticPartnerHasPasskey(email)).toBe(true);
    // And an Android enrollment that reports an https origin is refused.
    resetSyntheticPartnerPasskeys();
    const token = enrollmentToken({ email, platform: 'android' });
    const started = await post({
      step: 'register-start',
      enrollmentToken: token,
    });
    const { options } = (await started.json()) as {
      options: { challenge: string };
    };
    const response = await post({
      step: 'register-finish',
      enrollmentToken: token,
      credential: registrationCredential(
        clientData({
          type: 'webauthn.create',
          challenge: options.challenge,
          origin: IOS_CEREMONY_ORIGIN,
        }),
      ),
    });
    expect(response.status).toBe(401);
    expect(syntheticPartnerHasPasskey(email)).toBe(false);
  });

  test('a deployment with no asset-links document completes no Android ceremony', async () => {
    // No configured fingerprint means no acceptable Android ceremony origin,
    // which is the right order: the document is what makes the platform
    // willing to run one at all.
    Reflect.deleteProperty(process.env, 'PSD_EOC_ANDROID_SIGNING_FINGERPRINTS');
    const token = enrollmentToken({ email: address(), platform: 'android' });
    const started = await post({
      step: 'register-start',
      enrollmentToken: token,
    });
    const { options } = (await started.json()) as {
      options: { challenge: string };
    };
    const response = await post({
      step: 'register-finish',
      enrollmentToken: token,
      credential: registrationCredential(
        clientData({
          type: 'webauthn.create',
          challenge: options.challenge,
          origin: ANDROID_CEREMONY_ORIGIN,
        }),
      ),
    });
    expect(response.status).toBe(401);
  });

  test('an emailed-code flow cannot be answered with an assertion', async () => {
    const email = address();
    await enrollPasskey(email);
    // A flow the code path sealed carries no passkey factor, and the pool's
    // continuation belongs to one challenge, so refusing it here spends no
    // provider call and no verify budget. It is refused in the same words as
    // a flow that expired or was never sealed here: two messages would be
    // two answers about a value only this deployment can produce.
    const codeFlow = sealPartnerSignInFlow(
      {
        email,
        flowSession: 'synthetic-partner-otp:unused',
        installationId: INSTALLATION_ID,
        platform: 'ios',
        factor: 'email-otp',
        expiresAt: Date.now() + 5 * 60 * 1_000,
      },
      process.env,
      'native',
    );
    const answers = await Promise.all(
      [
        codeFlow,
        `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`,
      ].map(async (flowToken) => {
        const response = await post({
          step: 'sign-in-finish',
          flowToken,
          credential: assertionCredential(),
        });
        expect(response.status).toBe(401);
        return ((await response.json()) as { message: string }).message;
      }),
    );
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toContain('expired');
  });

  test("a malformed store identity is this deployment's fault, not a refusal", async () => {
    // A fingerprint the synth would have refused can still reach a running
    // instance through a hand-edited environment. There is then no origin to
    // compare a ceremony against, which is not an answer about the partner:
    // the app is told to try again later and the emailed code is unaffected.
    Reflect.set(
      process.env,
      'PSD_EOC_ANDROID_SIGNING_FINGERPRINTS',
      'AB:CD:EF',
    );
    const token = enrollmentToken({ email: address(), platform: 'android' });
    const response = await post({
      step: 'register-finish',
      enrollmentToken: token,
      credential: registrationCredential(
        clientData({
          type: 'webauthn.create',
          origin: ANDROID_CEREMONY_ORIGIN,
        }),
      ),
    });
    expect(response.status).toBe(500);
    expect((await response.json()) as { retryable: boolean }).toMatchObject({
      retryable: true,
    });
  });

  test('a refused request says the one thing every refusal says', async () => {
    const response = await post({
      step: 'register-start',
      enrollmentToken: enrollmentToken({
        email: address(),
        accessToken: syntheticPartnerAccessToken('nobody@x.invalid'),
      }),
    });
    expect(await response.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'The sign-in details were not accepted.',
      retryable: false,
    });
  });
});
