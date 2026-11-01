import { describe, expect, test } from 'bun:test';

import {
  AuthApiClient,
  parseAuthApiBaseUrl,
  privacyPolicyUrl,
} from './auth-api-client';
import { MobileAuthError } from './auth-errors';
import {
  partnerSessionFixture,
  sessionFixture,
  TEST_TOKEN,
} from './auth-test-fixtures';

const PARTNER_FLOW_TOKEN = `n1.${'a'.repeat(16)}.${'b'.repeat(40)}.${'c'.repeat(22)}`;

const REVOCATION_ID = '00000000-0000-4000-8000-000000000091';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000092';
const IDEMPOTENCY_KEY = 'mobile-revoke-idempotency-0001';

function revocationReceipt(sessionId = sessionFixture().session.id) {
  return {
    id: REVOCATION_ID,
    sessionId,
    revokedBy: {
      kind: 'human',
      userId: sessionFixture().user.id,
      sessionId: sessionFixture().session.id,
    },
    reasonCode: 'USER_SIGN_OUT',
    revokedAt: '2026-08-12T20:00:00.000Z',
  };
}

async function expectInvalidResponse(
  operation: Promise<unknown>,
): Promise<void> {
  try {
    await operation;
    throw new Error('Expected an invalid authentication response.');
  } catch (error) {
    expect(error).toBeInstanceOf(MobileAuthError);
    expect((error as MobileAuthError).kind).toBe('invalid-response');
  }
}

describe('mobile auth API client', () => {
  test('requires HTTPS except for explicit development loopback', () => {
    expect(parseAuthApiBaseUrl('https://eoc.example.invalid/', false)).toBe(
      'https://eoc.example.invalid',
    );
    expect(parseAuthApiBaseUrl('http://127.0.0.1:3000', true)).toBe(
      'http://127.0.0.1:3000',
    );
    expect(parseAuthApiBaseUrl('http://[::1]:3000', true)).toBe(
      'http://[::1]:3000',
    );
    expect(() =>
      parseAuthApiBaseUrl('http://eoc.example.invalid', true),
    ).toThrow(MobileAuthError);
  });

  test('derives the public privacy route from the exact configured origin', () => {
    expect(privacyPolicyUrl('https://eoc.example.invalid/', false)).toBe(
      'https://eoc.example.invalid/privacy',
    );
    expect(privacyPolicyUrl('http://127.0.0.1:3000', true)).toBe(
      'http://127.0.0.1:3000/privacy',
    );
    expect(() =>
      privacyPolicyUrl('https://eoc.example.invalid/not-an-origin', false),
    ).toThrow(MobileAuthError);
  });

  for (const status of [429, 500, 503] as const) {
    test(`classifies a non-JSON ${status} outage as offline`, async () => {
      const client = new AuthApiClient(
        () => 'https://eoc.example.invalid',
        async () =>
          new Response('<html>gateway unavailable</html>', { status }),
      );
      const signal = new AbortController().signal;
      try {
        await client.refresh(
          TEST_TOKEN,
          'mobile-refresh-idempotency-0001',
          signal,
        );
        throw new Error('Expected an offline failure.');
      } catch (error) {
        expect(error).toBeInstanceOf(MobileAuthError);
        expect((error as MobileAuthError).kind).toBe('offline');
      }
    });
  }

  test('classifies a non-JSON unauthorized response as rejected', async () => {
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async () => new Response('unauthorized', { status: 401 }),
    );
    try {
      await client.refresh(
        TEST_TOKEN,
        'mobile-refresh-idempotency-0001',
        new AbortController().signal,
      );
      throw new Error('Expected a rejected failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(MobileAuthError);
      expect((error as MobileAuthError).kind).toBe('rejected');
    }
  });

  test('accepts only a canonical revocation receipt for the requested session', async () => {
    const requestedSessionId = sessionFixture().session.id;
    const requests: Array<Readonly<{ input: string; init: RequestInit }>> = [];
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async (input, init) => {
        requests.push({ input, init });
        return Response.json(revocationReceipt(requestedSessionId));
      },
    );

    await client.revoke(TEST_TOKEN, requestedSessionId, IDEMPOTENCY_KEY);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.input).toBe('https://eoc.example.invalid/api/auth/revoke');
    expect(request?.init.headers).toMatchObject({
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Idempotency-Key': IDEMPOTENCY_KEY,
    });
    expect(JSON.parse(String(request?.init.body))).toEqual({
      sessionId: requestedSessionId,
      reasonCode: 'USER_SIGN_OUT',
    });
  });

  test('rejects a malformed successful revocation response', async () => {
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async () => Response.json({ status: 'revoked' }),
    );

    await expectInvalidResponse(
      client.revoke(TEST_TOKEN, sessionFixture().session.id, IDEMPOTENCY_KEY),
    );
  });

  test('asks the partner pool for a code without carrying a credential', async () => {
    const requests: Array<Readonly<{ input: string; init: RequestInit }>> = [];
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async (input, init) => {
        requests.push({ input, init });
        return Response.json({
          flowToken: PARTNER_FLOW_TOKEN,
          expiresAt: '2026-08-10T18:05:00.000Z',
        });
      },
    );

    const started = await client.partnerSignInStart({
      email: 'Synthetic.Responder@Agency.Example.Invalid',
      platform: 'ios',
      installationId: 'synthetic-installation-0002',
    });

    expect(started.flowToken).toBe(PARTNER_FLOW_TOKEN);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(
      'https://eoc.example.invalid/api/auth/mobile/partner/start',
    );
    // No bearer: nobody is signed in yet, and this step must not look like an
    // authenticated call.
    expect(requests[0]?.init.headers).not.toHaveProperty('Authorization');
    // The address is normalized by the contract before it leaves the device,
    // so the sealed flow and the pool agree on one spelling of it.
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      email: 'synthetic.responder@agency.example.invalid',
      platform: 'ios',
      installationId: 'synthetic-installation-0002',
    });
  });

  test('answers the sealed flow with the code and no address', async () => {
    const requests: Array<Readonly<{ input: string; init: RequestInit }>> = [];
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async (input, init) => {
        requests.push({ input, init });
        return Response.json({
          session: partnerSessionFixture(),
          tokenType: 'Bearer',
          refreshToken: TEST_TOKEN,
        });
      },
    );

    const payload = await client.partnerSignInVerify({
      flowToken: PARTNER_FLOW_TOKEN,
      code: '123456',
    });

    expect(payload.session.user.roles).toEqual(['partner']);
    expect(payload.session.session.authorization.kind).toBe(
      'partner-admission',
    );
    expect(requests[0]?.input).toBe(
      'https://eoc.example.invalid/api/auth/mobile/partner/verify',
    );
    // The sealed flow owns the address. Sending one here would let a code be
    // answered on behalf of somebody else.
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      flowToken: PARTNER_FLOW_TOKEN,
      code: '123456',
    });
  });

  test('a refused partner code is rejected with the server’s one message', async () => {
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async () =>
        Response.json(
          {
            code: 'UNAUTHENTICATED',
            message: 'The sign-in details were not accepted.',
            requestId: '00000000-0000-4000-8000-0000000000a1',
            retryable: false,
            fieldErrors: [],
          },
          { status: 401 },
        ),
    );

    try {
      await client.partnerSignInVerify({
        flowToken: PARTNER_FLOW_TOKEN,
        code: '999999',
      });
      throw new Error('Expected a rejected partner sign-in.');
    } catch (error) {
      expect(error).toBeInstanceOf(MobileAuthError);
      expect((error as MobileAuthError).kind).toBe('rejected');
      // One message for every refusal, so the app cannot be read as an answer
      // about who holds partner access.
      expect((error as MobileAuthError).message).toBe(
        'The sign-in details were not accepted.',
      );
    }
  });

  test('refuses a partner session response it cannot parse strictly', async () => {
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async () => Response.json({ flowToken: PARTNER_FLOW_TOKEN }),
    );

    await expectInvalidResponse(
      client.partnerSignInVerify({
        flowToken: PARTNER_FLOW_TOKEN,
        code: '123456',
      }),
    );
  });

  test('rejects a canonical revocation receipt for a different session', async () => {
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async () => Response.json(revocationReceipt(OTHER_SESSION_ID)),
    );

    await expectInvalidResponse(
      client.revoke(TEST_TOKEN, sessionFixture().session.id, IDEMPOTENCY_KEY),
    );
  });
});
