import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  openPartnerSignInFlow,
  PARTNER_FLOW_COOKIE_NAME,
  partnerFlowCookieHeader,
} from '../../../../lib/auth/partner-flow-cookie';
import { syntheticPartnerOtpCode } from '../../../../lib/auth/partner-otp';
import { POST } from './route';

/**
 * Issue #593. The partner sign-in form's two POSTs: what they accept, what
 * they refuse, and what they say about it. Nothing here reaches a database —
 * every path tested refuses before a session could be issued.
 */

const ORIGIN = 'http://localhost:3000';
const ACTION = `${ORIGIN}/auth/partner`;
const COOKIE_SECRET = Buffer.alloc(32, 41).toString('base64url');
const EMAIL = 'responder@agency.example.invalid';

const names = [
  'PSD_EOC_PARTNER_USER_POOL_ID',
  'PSD_EOC_PARTNER_USER_POOL_CLIENT_ID',
  'PSD_EOC_PARTNER_USER_POOL_CLIENT_SECRET_ARN',
  'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN',
  'GOOGLE_OIDC_COOKIE_SECRET',
  'NODE_ENV',
] as const;
const original = new Map<string, string | undefined>();

function post(
  body: Readonly<Record<string, string>>,
  options: Readonly<{ origin?: string | null; cookie?: string }> = {},
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
  });
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.set('origin', origin);
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  return POST(
    new Request(ACTION, {
      method: 'POST',
      headers,
      body: new URLSearchParams(body).toString(),
    }),
  ) as Promise<Response>;
}

function location(response: Response): URL {
  const value = response.headers.get('location');
  if (value === null) throw new Error('No redirect location.');
  return new URL(value);
}

function setCookies(response: Response): readonly string[] {
  return response.headers.getSetCookie();
}

beforeEach(() => {
  for (const name of names) {
    original.set(name, process.env[name]);
  }
  Reflect.set(process.env, 'PSD_EOC_PARTNER_USER_POOL_ID', 'SYNTHETIC');
  Reflect.set(process.env, 'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN', 'allowed');
  Reflect.set(process.env, 'GOOGLE_OIDC_COOKIE_SECRET', COOKIE_SECRET);
  Reflect.deleteProperty(process.env, 'NODE_ENV');
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

describe('the partner sign-in route', () => {
  test('refuses a submission from another site', async () => {
    for (const origin of [null, 'https://evil.example.invalid']) {
      const response = await post(
        { step: 'send-code', email: EMAIL },
        {
          origin,
        },
      );
      expect(response.status).toBe(303);
      expect(location(response).searchParams.get('status')).toBe('refused');
      expect(setCookies(response).join(' ')).toContain(
        `${PARTNER_FLOW_COOKIE_NAME}=;`,
      );
    }
  });

  test('refuses a body that is not the sign-in form', async () => {
    for (const body of [{}, { step: 'something-else' }, { step: '' }]) {
      expect(location(await post(body)).searchParams.get('status')).toBe(
        'refused',
      );
    }
  });

  test('says partner sign-in is unavailable when no pool is configured', async () => {
    Reflect.deleteProperty(process.env, 'PSD_EOC_PARTNER_USER_POOL_ID');
    const response = await post({ step: 'send-code', email: EMAIL });
    expect(location(response).searchParams.get('status')).toBe('unavailable');
  });

  test('refuses an address that is not an address', async () => {
    for (const email of [
      '',
      'not-an-address',
      'a@b',
      `${'a'.repeat(400)}@b.c`,
    ]) {
      expect(
        location(await post({ step: 'send-code', email })).searchParams.get(
          'status',
        ),
      ).toBe('refused');
    }
  });

  test('asks for a code and carries the flow in a sealed cookie', async () => {
    const response = await post({ step: 'send-code', email: EMAIL });
    const target = location(response);
    expect(target.pathname).toBe('/partner-sign-in');
    expect(target.searchParams.get('status')).toBe('code-sent');
    expect(target.searchParams.get('step')).toBe('code');
    const cookie = setCookies(response).find((value) =>
      value.startsWith(`${PARTNER_FLOW_COOKIE_NAME}=`),
    );
    expect(cookie).toBeDefined();
    const sealed = cookie?.split(';', 1)[0]?.split('=')[1] ?? '';
    expect(sealed).not.toContain(EMAIL);
    const flow = openPartnerSignInFlow(sealed, new Date());
    expect(flow?.email).toBe(EMAIL);
    expect(flow?.installationId.startsWith('web.')).toBe(true);
  });

  test('the first step says the same thing for every address', async () => {
    const admitted = location(
      await post({ step: 'send-code', email: EMAIL }),
    ).searchParams.get('status');
    const unknown = location(
      await post({
        step: 'send-code',
        email: 'nobody@agency.example.invalid',
      }),
    ).searchParams.get('status');
    expect(admitted).toBe('code-sent');
    expect(unknown).toBe(admitted);
  });

  test('a code without a flow has expired', async () => {
    const response = await post({ step: 'verify-code', code: '123456' });
    expect(location(response).searchParams.get('status')).toBe('expired');
  });

  test('a stale flow cookie has expired', async () => {
    const cookie = partnerFlowCookieHeader({
      email: EMAIL,
      flowSession: 'provider-session-handle',
      installationId: 'web.installation-identifier',
      expiresAt: Date.now() - 1_000,
    });
    const response = await post(
      { step: 'verify-code', code: '123456' },
      { cookie: cookie.split(';', 1)[0] ?? '' },
    );
    expect(location(response).searchParams.get('status')).toBe('expired');
  });

  test('a value that is not a code is refused before the provider', async () => {
    const started = await post({ step: 'send-code', email: EMAIL });
    const cookie =
      setCookies(started)
        .find((value) => value.startsWith(`${PARTNER_FLOW_COOKIE_NAME}=`))
        ?.split(';', 1)[0] ?? '';
    for (const code of ['', 'abcdef', '12345', '123456789']) {
      const response = await post({ step: 'verify-code', code }, { cookie });
      const target = location(response);
      expect(target.searchParams.get('status')).toBe('refused');
      // The flow survives a typo, so the partner can retype the code.
      expect(target.searchParams.get('step')).toBe('code');
    }
  });

  test('a sealed flow from another deployment is not a flow', async () => {
    const cookie = partnerFlowCookieHeader(
      {
        email: EMAIL,
        flowSession: `synthetic-partner-otp:${'0'.repeat(64)}`,
        installationId: 'web.installation-identifier',
        expiresAt: Date.now() + 60_000,
      },
      { GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 9).toString('base64url') },
    );
    const response = await post(
      { step: 'verify-code', code: syntheticPartnerOtpCode(EMAIL) },
      { cookie: cookie.split(';', 1)[0] ?? '' },
    );
    expect(location(response).searchParams.get('status')).toBe('expired');
  });

  test('every response forbids caching and referrers', async () => {
    const response = await post({ step: 'send-code', email: EMAIL });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
