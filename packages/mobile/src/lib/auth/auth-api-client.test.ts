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

    expect(payload.session.session.user.roles).toEqual(['partner']);
    expect(payload.session.session.session.authorization.kind).toBe(
      'partner-admission',
    );
    // No header, no offer: a build talking to a server that makes none signs
    // in exactly as it did before (issue #647).
    expect(payload.passkeyEnrollmentToken).toBeNull();
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

  test('a completed partner code sign-in picks up the passkey offer', async () => {
    // Issue #647. The offer is a response header, never a field: the session
    // payload stays the shape every installed build parses strictly.
    const enrollment = `e1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`;
    const clientFor = (offered: string | null) =>
      new AuthApiClient(
        () => 'https://eoc.example.invalid',
        async () =>
          Response.json(
            {
              session: partnerSessionFixture(),
              tokenType: 'Bearer',
              refreshToken: TEST_TOKEN,
            },
            {
              headers:
                offered === null
                  ? {}
                  : { 'X-PSD-EOC-Partner-Passkey-Enrollment': offered },
            },
          ),
      );

    expect(
      (
        await clientFor(enrollment).partnerSignInVerify({
          flowToken: PARTNER_FLOW_TOKEN,
          code: '123456',
        })
      ).passkeyEnrollmentToken,
    ).toBe(enrollment);
    // A header this build cannot make sense of is no offer, never a failed
    // sign-in: the session has already been issued.
    expect(
      (
        await clientFor('not-a-sealed-hand-off').partnerSignInVerify({
          flowToken: PARTNER_FLOW_TOKEN,
          code: '123456',
        })
      ).passkeyEnrollmentToken,
    ).toBeNull();
  });

  test('all four passkey steps are one path with a step field', async () => {
    const requests: Array<Readonly<{ input: string; init: RequestInit }>> = [];
    const client = new AuthApiClient(
      () => 'https://eoc.example.invalid',
      async (input, init) => {
        requests.push({ input, init });
        const step = (
          JSON.parse(String(init.body)) as Readonly<{ step: string }>
        ).step;
        if (step === 'sign-in-start') {
          return Response.json({ method: 'code' });
        }
        if (step === 'register-start') {
          return Response.json({
            options: {
              rp: { id: 'eoc.example.invalid', name: 'PSD EOC' },
              user: {
                id: 'dXNlcg',
                name: 'responder@agency.example.invalid',
                displayName: 'Responder',
              },
              challenge: 'Y2hhbGxlbmdl',
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              // A field a newer server added, which an installed build must
              // tolerate rather than refuse (issue #470).
              somethingNew: 'ignored',
            },
          });
        }
        return Response.json({ status: 'registered' });
      },
    );

    expect(
      await client.partnerPasskeySignInStart({
        email: 'responder@agency.example.invalid',
        platform: 'android',
        installationId: 'synthetic-installation-0003',
      }),
    ).toEqual({ method: 'code' });
    const started = await client.partnerPasskeyRegisterStart({
      enrollmentToken: `e1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`,
    });
    expect(started.options.rp.id).toBe('eoc.example.invalid');
    await client.partnerPasskeyRegisterFinish({
      enrollmentToken: `e1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`,
      credential: {
        id: 'Y3JlZGVudGlhbA',
        rawId: 'Y3JlZGVudGlhbA',
        type: 'public-key',
        response: {
          clientDataJSON: 'Y2xpZW50RGF0YQ',
          attestationObject: 'YXR0ZXN0YXRpb24',
        },
      },
    });
    expect(new Set(requests.map((request) => request.input))).toEqual(
      new Set(['https://eoc.example.invalid/api/auth/mobile/partner/passkey']),
    );
    expect(
      requests.map(
        (request) =>
          (JSON.parse(String(request.init.body)) as Readonly<{ step: string }>)
            .step,
      ),
    ).toEqual(['sign-in-start', 'register-start', 'register-finish']);
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
