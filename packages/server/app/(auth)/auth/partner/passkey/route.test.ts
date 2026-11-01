import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  openPartnerSignInFlow,
  PARTNER_FLOW_COOKIE_NAME,
  partnerFlowCookieHeader,
} from '../../../../../lib/auth/partner-flow-cookie';
import { syntheticPartnerAccessToken } from '../../../../../lib/auth/partner-otp';
import {
  getPartnerOtpLimiter,
  PARTNER_PASSKEY_REGISTRATIONS_PER_EMAIL,
} from '../../../../../lib/auth/partner-otp-limit';
import {
  PARTNER_PASSKEY_COOKIE_NAME,
  partnerPasskeyCookieHeader,
} from '../../../../../lib/auth/partner-passkey-enrollment';
import {
  resetSyntheticPartnerPasskeys,
  syntheticPartnerHasPasskey,
} from '../../../../../lib/auth/partner-passkey';
import { POST } from './route';

/**
 * Issue #599. The partner passkey endpoint: what it accepts, what it
 * refuses, and what it declines to say.
 *
 * Nothing here reaches a database. Every path tested either refuses before a
 * session could be issued, or stops at the enrollment hand-off, which never
 * touches one.
 */

const ORIGIN = 'http://localhost:3000';
const ACTION = `${ORIGIN}/auth/partner/passkey`;
const COOKIE_SECRET = Buffer.alloc(32, 43).toString('base64url');
const EMAIL = 'responder@agency.example.invalid';

const names = [
  'PSD_EOC_PARTNER_USER_POOL_ID',
  'PSD_EOC_PARTNER_USER_POOL_CLIENT_ID',
  'PSD_EOC_PARTNER_USER_POOL_CLIENT_SECRET_ARN',
  'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN',
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
      origin: ORIGIN,
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
      authenticatorData: 'YXV0aGVudGljYXRvci1kYXRh',
      signature: 'c2lnbmF0dXJl',
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

function post(
  body: unknown,
  options: Readonly<{
    origin?: string | null;
    cookie?: string;
    contentType?: string | null;
    client?: string;
  }> = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.client !== undefined) {
    headers.set('x-forwarded-for', options.client);
  }
  const contentType =
    options.contentType === undefined
      ? 'application/json'
      : options.contentType;
  if (contentType !== null) headers.set('content-type', contentType);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.set('origin', origin);
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  return POST(
    new Request(ACTION, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

function enrollmentCookie(email = EMAIL): string {
  return `${PARTNER_PASSKEY_COOKIE_NAME}=${
    partnerPasskeyCookieHeader(
      {
        email,
        accessToken: syntheticPartnerAccessToken(email),
        expiresAt: Date.now() + 10 * 60 * 1_000,
      },
      process.env,
    )
      .split(';', 1)[0]
      ?.split('=')
      .slice(1)
      .join('=') ?? ''
  }`;
}

async function enrollPasskey(): Promise<void> {
  const started = await post(
    { step: 'register-start' },
    {
      cookie: enrollmentCookie(),
    },
  );
  const { options } = (await started.json()) as {
    options: { challenge: string };
  };
  const finished = await post(
    {
      step: 'register-finish',
      credential: registrationCredential(
        clientData({ type: 'webauthn.create', challenge: options.challenge }),
      ),
    },
    { cookie: enrollmentCookie() },
  );
  expect(finished.status).toBe(200);
}

beforeEach(() => {
  for (const name of names) original.set(name, process.env[name]);
  Reflect.set(process.env, 'PSD_EOC_PARTNER_USER_POOL_ID', 'SYNTHETIC');
  Reflect.set(process.env, 'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN', 'allowed');
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
});

describe('the partner passkey route', () => {
  test('refuses a submission from another site', async () => {
    for (const origin of [null, 'https://evil.example.invalid']) {
      const response = await post(
        { step: 'sign-in-start', email: EMAIL },
        { origin },
      );
      expect(response.status).toBe(401);
    }
  });

  test('refuses anything that is not one of the four steps', async () => {
    for (const body of [
      { step: 'list-credentials' },
      { step: 'sign-in-start' },
      { step: 'sign-in-start', email: 'not-an-address' },
      {},
    ]) {
      expect((await post(body)).status).toBeGreaterThanOrEqual(400);
    }
    // A body that is not JSON at all is refused before it is parsed.
    expect(
      (await post({ step: 'register-start' }, { contentType: 'text/plain' }))
        .status,
    ).toBe(400);
  });

  test('an address with no passkey is told to use a code', async () => {
    const response = await post({ step: 'sign-in-start', email: EMAIL });
    expect(response.status).toBe(200);
    // The answer carries nothing but the method, so it reveals nothing about
    // whether the address has partner access or an account at all.
    expect(await response.json()).toEqual({ method: 'code' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test('every response forbids caching and referrers', async () => {
    const response = await post({ step: 'sign-in-start', email: EMAIL });
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('a deployment with no partner pool has no passkey path', async () => {
    Reflect.set(process.env, 'PSD_EOC_PARTNER_USER_POOL_ID', 'UNCONFIGURED');
    const response = await post({ step: 'sign-in-start', email: EMAIL });
    expect(response.status).toBe(503);
  });

  test('registration needs the hand-off, never a session', async () => {
    // A session is this application's own credential and cannot authorize a
    // change inside the pool, so a request with no hand-off is refused.
    expect((await post({ step: 'register-start' })).status).toBe(401);
    expect(
      (
        await post({
          step: 'register-finish',
          credential: registrationCredential(
            clientData({ type: 'webauthn.create' }),
          ),
        })
      ).status,
    ).toBe(401);
  });

  test('a partner enrolls a passkey and the hand-off is then spent', async () => {
    expect(syntheticPartnerHasPasskey(EMAIL)).toBe(false);
    await enrollPasskey();
    expect(syntheticPartnerHasPasskey(EMAIL)).toBe(true);
    // One enrollment per code sign-in: the finish clears the cookie.
    const started = await post(
      { step: 'register-start' },
      {
        cookie: enrollmentCookie(),
      },
    );
    const { options } = (await started.json()) as {
      options: { challenge: string };
    };
    const replayed = await post(
      {
        step: 'register-finish',
        credential: registrationCredential(
          clientData({ type: 'webauthn.create', challenge: options.challenge }),
        ),
      },
      { cookie: enrollmentCookie() },
    );
    expect(replayed.headers.getSetCookie().join(' ')).toContain(
      `${PARTNER_PASSKEY_COOKIE_NAME}=;`,
    );
  });

  test('a ceremony performed for another origin is refused', async () => {
    const started = await post(
      { step: 'register-start' },
      {
        cookie: enrollmentCookie(),
      },
    );
    const { options } = (await started.json()) as {
      options: { challenge: string };
    };
    const response = await post(
      {
        step: 'register-finish',
        credential: registrationCredential(
          clientData({
            type: 'webauthn.create',
            challenge: options.challenge,
            origin: 'https://evil.example.invalid',
          }),
        ),
      },
      { cookie: enrollmentCookie() },
    );
    expect(response.status).toBe(401);
    expect(syntheticPartnerHasPasskey(EMAIL)).toBe(false);
  });

  test('a sign-in assertion presented as a registration is refused', async () => {
    const response = await post(
      {
        step: 'register-finish',
        // `webauthn.get` client data in a registration: the ceremony the
        // authenticator performed is not the one being completed.
        credential: registrationCredential(clientData()),
      },
      { cookie: enrollmentCookie() },
    );
    expect(response.status).toBe(401);
  });

  test('an enrolled address is offered its passkey, bound to this host', async () => {
    await enrollPasskey();
    const response = await post({ step: 'sign-in-start', email: EMAIL });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      method: string;
      options: { rpId: string; userVerification: string };
    };
    expect(answer.method).toBe('passkey');
    // Derived from the request origin outside production, so the ceremony is
    // always bound to the host the page was served from.
    expect(answer.options.rpId).toBe('localhost');
    expect(answer.options.userVerification).toBe('required');
    // The flow carries the pool's continuation, sealed, and names the factor.
    const flowCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${PARTNER_FLOW_COOKIE_NAME}=`));
    expect(flowCookie).toBeDefined();
    const sealed = flowCookie?.split(';', 1)[0]?.split('=').slice(1).join('=');
    expect(
      openPartnerSignInFlow(sealed ?? null, new Date(), process.env),
    ).toMatchObject({ email: EMAIL, factor: 'passkey' });
  });

  test('a flow opened for a code is never answered with an assertion', async () => {
    await enrollPasskey();
    const codeFlow = partnerFlowCookieHeader(
      {
        email: EMAIL,
        flowSession: 'provider-session-handle',
        installationId: 'web.installation-identifier',
        factor: 'email-otp',
        expiresAt: Date.now() + 5 * 60 * 1_000,
      },
      process.env,
    );
    const response = await post(
      { step: 'sign-in-finish', credential: assertionCredential() },
      {
        cookie: `${PARTNER_FLOW_COOKIE_NAME}=${
          codeFlow.split(';', 1)[0]?.split('=').slice(1).join('=') ?? ''
        }`,
      },
    );
    expect(response.status).toBe(401);
  });

  test('enrolling is bounded, and never spends the code’s budget', async () => {
    // Behind the sealed hand-off, so not anonymous — but each attempt is a
    // call to the pool, and nothing else bounds how many a script could make
    // inside the hand-off's ten minutes.
    // Its own address and its own caller: the limiter is one per process, so
    // spending a budget here would otherwise spend it for every test after
    // this one.
    const bounded = 'enrolment-budget@agency.example.invalid';
    const client = '198.51.100.7';
    let limited = false;
    for (
      let attempt = 0;
      attempt < PARTNER_PASSKEY_REGISTRATIONS_PER_EMAIL + 1;
      attempt += 1
    ) {
      const response = await post(
        { step: 'register-start' },
        { cookie: enrollmentCookie(bounded), client },
      );
      if (response.status === 429) {
        limited = true;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(limited).toBe(true);

    // The emailed code is untouched: a partner whose enrolment budget is
    // spent can still ask for a code and answer it.
    const decision = getPartnerOtpLimiter().admit(
      { kind: 'send', email: bounded, client },
      new Date(),
    );
    expect(decision.admitted).toBe(true);
  });

  test('an assertion with no flow at all is refused', async () => {
    expect(
      (
        await post({
          step: 'sign-in-finish',
          credential: assertionCredential(),
        })
      ).status,
    ).toBe(401);
  });
});
