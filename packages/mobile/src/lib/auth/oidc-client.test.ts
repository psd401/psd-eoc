import { describe, expect, test } from 'bun:test';

import type {
  MobileOidcExchangeRequest,
  MobileOidcStartRequest,
} from '@psd-eoc/contracts';
import { MobileOidcStartResponseSchema } from '@psd-eoc/contracts';

import { sessionFixture, TEST_TOKEN } from './auth-test-fixtures';
import {
  createPkcePair,
  encodeBase64Url,
  MobileOidcClient,
  type OidcBrowser,
  type OidcTransport,
} from './oidc-client';

const OIDC_STATE = `m1.${'S'.repeat(43)}`;

const startResponse = MobileOidcStartResponseSchema.parse({
  authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${OIDC_STATE}`,
  clientId: 'public-native-client-id',
  flowToken: `m1.${'F'.repeat(16)}.${'T'.repeat(80)}`,
  state: OIDC_STATE,
  appRedirectUri: 'psdeoc://auth/callback',
  expiresAt: '2026-08-10T18:05:00.000Z',
});

describe('native OIDC orchestration', () => {
  test('uses a contract-valid start response with matching URL state', () => {
    expect(
      new URL(startResponse.authorizationUrl).searchParams.get('state'),
    ).toBe(startResponse.state);
    expect(MobileOidcStartResponseSchema.parse(startResponse)).toEqual(
      startResponse,
    );
  });

  test('encodes RFC 7636 verifier bytes without padding', () => {
    expect(encodeBase64Url(new Uint8Array([251, 255, 239]))).toBe('-__v');
    expect(encodeBase64Url(new Uint8Array(32))).toHaveLength(43);
  });

  test('binds server start and exchange to the externally generated PKCE pair', async () => {
    const startInputs: MobileOidcStartRequest[] = [];
    const exchangeInputs: MobileOidcExchangeRequest[] = [];
    const transport: OidcTransport = {
      async startOidc(input) {
        startInputs.push(input);
        return startResponse;
      },
      async exchangeOidc(input) {
        exchangeInputs.push(input);
        return {
          session: sessionFixture(),
          tokenType: 'Bearer',
          refreshToken: TEST_TOKEN,
        };
      },
    };
    const browser: OidcBrowser = {
      async authorize(start) {
        expect(start).toBe(startResponse);
        return {
          kind: 'success',
          authorizationCode: 'synthetic-authorization-code',
          state: start.state,
        };
      },
    };
    const client = new MobileOidcClient(
      transport,
      browser,
      {
        randomBytes: async () => new Uint8Array(32),
        sha256Base64: async () => 'challenge+/with-padding==',
      },
      () => new Date('2026-08-10T18:00:00.000Z'),
    );

    const result = await client.signIn('ios', 'synthetic-installation-0001');
    expect(result.refreshToken).toBe(TEST_TOKEN);
    expect(startInputs[0]).toEqual({
      platform: 'ios',
      installationId: 'synthetic-installation-0001',
      codeChallenge: 'challenge-_with-padding',
    });
    expect(exchangeInputs[0]).toEqual({
      authorizationCode: 'synthetic-authorization-code',
      state: startResponse.state,
      codeVerifier: 'A'.repeat(43),
      flowToken: startResponse.flowToken,
    });
  });

  test('refuses to exchange an expired server flow', async () => {
    let exchangeCalled = false;
    const client = new MobileOidcClient(
      {
        startOidc: async () => startResponse,
        exchangeOidc: async () => {
          exchangeCalled = true;
          throw new Error('must not exchange');
        },
      },
      { authorize: async () => ({ kind: 'cancelled' }) },
      {
        randomBytes: async () => new Uint8Array(32),
        sha256Base64: async () => 'challenge',
      },
      () => new Date('2026-08-10T18:06:00.000Z'),
    );
    await expect(
      client.signIn('android', 'synthetic-installation-0001'),
    ).rejects.toThrow('expired');
    expect(exchangeCalled).toBe(false);
  });

  test('creates the expected zero-byte verifier for the injected source', async () => {
    const pair = await createPkcePair({
      randomBytes: async () => new Uint8Array(32),
      sha256Base64: async (value) => {
        expect(value).toBe('A'.repeat(43));
        return 'abc+/=';
      },
    });
    expect(pair).toEqual({ verifier: 'A'.repeat(43), challenge: 'abc-_' });
  });
});
