import { describe, expect, test } from 'bun:test';

import { AuthApiClient, parseAuthApiBaseUrl } from './auth-api-client';
import { MobileAuthError } from './auth-errors';
import { sessionFixture, TEST_TOKEN } from './auth-test-fixtures';

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
