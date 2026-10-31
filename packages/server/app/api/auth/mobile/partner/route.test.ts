import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ApiErrorSchema } from '@psd-eoc/contracts';
import { NextRequest } from 'next/server';

import {
  openPartnerSignInFlow,
  sealPartnerSignInFlow,
} from '../../../../../lib/auth/partner-flow-cookie';
import { syntheticPartnerOtpCode } from '../../../../../lib/auth/partner-otp';
import { POST as START } from './start/route';
import { POST as VERIFY } from './verify/route';

/**
 * Issue #598. The two native partner steps, without a database.
 *
 * Everything here stops before the admission is consulted, which is the
 * point: the first step must behave the same for every address, and the
 * second step must refuse an unusable flow before it reaches the pool or the
 * database at all.
 */

/**
 * Addresses this file alone uses. The limiter's per-address budget is
 * process-wide, so sharing an address with the browser route's tests would
 * let one file spend the other's codes in a sharded run.
 */
const EMAIL = 'native-responder@agency.example.invalid';
const INSTALLATION = 'native-installation-identifier';
const SECRET = Buffer.alloc(32, 11).toString('base64url');

const SYNTHETIC_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PSD_EOC_PARTNER_USER_POOL_ID: 'SYNTHETIC',
  PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: 'allowed',
  GOOGLE_OIDC_COOKIE_SECRET: SECRET,
  DATABASE_URL: 'postgres://psd_eoc@127.0.0.1:5432/psd_eoc_test',
});

const touched = [
  ...Object.keys(SYNTHETIC_ENVIRONMENT),
  'PSD_EOC_PARTNER_USER_POOL_CLIENT_ID',
] as const;
const previous = new Map<string, string | undefined>(
  touched.map((name) => [name, process.env[name]]),
);

function useSyntheticPool(): void {
  for (const [name, value] of Object.entries(SYNTHETIC_ENVIRONMENT)) {
    process.env[name] = value;
  }
}

/**
 * The rate limiter is one process-wide budget, and a request with no
 * forwarded address shares one bucket with every other such request — in a
 * sharded run, with every other test file too. Each test therefore names its
 * own caller, so no test can exhaust another's budget or be exhausted by it.
 */
function request(
  path: string,
  body: unknown,
  client = `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/auth/mobile/partner/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': client,
    },
    body: JSON.stringify(body),
  });
}

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  // A native sign-in never sets a browser cookie, in either direction.
  expect(response.headers.get('set-cookie')).toBeNull();
}

beforeEach(() => {
  useSyntheticPool();
});

afterEach(() => {
  for (const [name, value] of previous) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('the native partner sign-in steps', () => {
  test('neither step exists without a partner pool', async () => {
    delete process.env.PSD_EOC_PARTNER_USER_POOL_ID;
    const started = await START(
      request('start', {
        email: EMAIL,
        platform: 'ios',
        installationId: INSTALLATION,
      }),
    );
    expect(started.status).toBe(404);
    expectPrivateResponse(started);
    const verified = await VERIFY(
      request('verify', { flowToken: 'n1.a.b.c', code: '123456' }),
    );
    expect(verified.status).toBe(404);
    expectPrivateResponse(verified);
  });

  test('the first step says the same thing for every address', async () => {
    const admitted = await START(
      request('start', {
        email: EMAIL,
        platform: 'ios',
        installationId: INSTALLATION,
      }),
    );
    const unknown = await START(
      request('start', {
        email: 'native-nobody@agency.example.invalid',
        platform: 'android',
        installationId: INSTALLATION,
      }),
    );
    expect(admitted.status).toBe(200);
    expect(unknown.status).toBe(200);
    expectPrivateResponse(admitted);
    const first = (await admitted.json()) as Record<string, unknown>;
    const second = (await unknown.json()) as Record<string, unknown>;
    // The only fields either answer carries are the sealed flow and when it
    // stops working, and nothing in them is readable by the caller.
    expect(Object.keys(first).sort()).toEqual(['expiresAt', 'flowToken']);
    expect(Object.keys(second).sort()).toEqual(['expiresAt', 'flowToken']);
    expect(JSON.stringify(first)).not.toContain(EMAIL);
  });

  test('the sealed flow carries the device the first step named', async () => {
    const response = await START(
      request('start', {
        email: EMAIL,
        platform: 'android',
        installationId: INSTALLATION,
      }),
    );
    const { flowToken } = (await response.json()) as { flowToken: string };
    const flow = openPartnerSignInFlow(
      flowToken,
      new Date(),
      process.env,
      'native',
    );
    expect(flow).toMatchObject({
      email: EMAIL,
      installationId: INSTALLATION,
      platform: 'android',
    });
  });

  test('a malformed request never echoes what was sent', async () => {
    const started = await START(
      request('start', { email: 'not-an-email', platform: 'ios' }),
    );
    expect(started.status).toBe(400);
    expectPrivateResponse(started);
    const verified = await VERIFY(
      request('verify', { flowToken: 'n1.a.b.c', code: 'not-a-code' }),
    );
    expect(verified.status).toBe(400);
    const serialized = JSON.stringify(
      ApiErrorSchema.parse(await verified.json()),
    );
    expect(serialized).not.toContain('not-a-code');
  });

  test('a stale or foreign flow has expired, before the pool is asked', async () => {
    const now = new Date();
    const expired = sealPartnerSignInFlow(
      {
        email: EMAIL,
        flowSession: 'provider-session-handle',
        installationId: INSTALLATION,
        platform: 'ios',
        expiresAt: now.getTime() - 1_000,
      },
      process.env,
      'native',
    );
    const browserFlow = sealPartnerSignInFlow(
      {
        email: EMAIL,
        flowSession: 'provider-session-handle',
        installationId: INSTALLATION,
        expiresAt: now.getTime() + 60_000,
      },
      process.env,
    );
    // The browser's seal carries the `p1` label, so the contract schema
    // refuses it as a malformed request before the route runs at all; the
    // native seal is well-formed and is refused as expired. Neither reaches
    // the pool, the limiter or the database.
    expect(browserFlow.startsWith('p1.')).toBe(true);
    const foreign = await VERIFY(
      request('verify', {
        flowToken: browserFlow,
        code: syntheticPartnerOtpCode(EMAIL),
      }),
    );
    expect(foreign.status).toBe(400);
    expectPrivateResponse(foreign);

    const stale = await VERIFY(
      request('verify', {
        flowToken: expired,
        code: syntheticPartnerOtpCode(EMAIL),
      }),
    );
    expect(stale.status).toBe(401);
    expectPrivateResponse(stale);
    expect(ApiErrorSchema.parse(await stale.json()).message).toBe(
      'This sign-in request expired. Request a new code.',
    );
  });

  test('one address gets a fixed number of codes in the window', async () => {
    // Five sends per address in the window, then the sixth is refused with
    // the retry hint the app shows. Each attempt comes from a different
    // caller, so it is the address's budget being spent and not a caller's.
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(
        await START(
          request('start', {
            email: 'native-budget@agency.example.invalid',
            platform: 'ios',
            installationId: INSTALLATION,
          }),
        ),
      );
    }
    const refused = responses.at(-1);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toMatch(/^\d+$/u);
    const body = ApiErrorSchema.parse(await refused?.json());
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryable).toBe(true);
  });
});
