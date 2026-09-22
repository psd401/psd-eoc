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
  OidcRedirectNotCapturedError,
  type OidcBrowser,
  type OidcTransport,
} from './oidc-client';
import {
  createPendingOidcFlowStore,
  type PendingOidcFlow,
  type PendingOidcFlowBackend,
  type PendingOidcFlowStore,
} from './pending-oidc-flow';

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

const CODE_VERIFIER = 'A'.repeat(43);

const pendingFixture: PendingOidcFlow = Object.freeze({
  state: OIDC_STATE,
  codeVerifier: CODE_VERIFIER,
  flowToken: startResponse.flowToken,
  expiresAt: startResponse.expiresAt,
});

function memoryFlowStore(initial: PendingOidcFlow | null = null): {
  readonly store: PendingOidcFlowStore;
  readonly saved: PendingOidcFlow[];
  peek(): string | null;
} {
  const saved: PendingOidcFlow[] = [];
  let value: string | null = initial === null ? null : JSON.stringify(initial);
  const backend: PendingOidcFlowBackend = {
    async read() {
      return value;
    },
    async write(next: string) {
      value = next;
      saved.push(JSON.parse(next) as PendingOidcFlow);
    },
    async remove() {
      value = null;
    },
  };
  return {
    store: createPendingOidcFlowStore(backend),
    saved,
    peek: () => value,
  };
}

const pkceSource = {
  randomBytes: async () => new Uint8Array(32),
  sha256Base64: async () => 'challenge',
};

function exchangingTransport(exchanges: unknown[]): OidcTransport {
  return {
    async startOidc() {
      return startResponse;
    },
    async exchangeOidc(input) {
      exchanges.push(input);
      return {
        session: sessionFixture(),
        tokenType: 'Bearer',
        refreshToken: TEST_TOKEN,
      };
    },
  };
}

const refusingBrowser: OidcBrowser = {
  async authorize() {
    throw new Error('the browser must not open on the resume path');
  },
};

describe('native OIDC cold-start resume', () => {
  test('persists the attempt before the browser opens', async () => {
    const flows = memoryFlowStore();
    let savedWhenBrowserOpened: string | null = null;
    const client = new MobileOidcClient(
      exchangingTransport([]),
      {
        async authorize(start) {
          // Android can restart the process from here. Whatever is on disk at
          // this instant is all the resume path will ever have.
          savedWhenBrowserOpened = flows.peek();
          return {
            kind: 'success',
            authorizationCode: 'synthetic-authorization-code',
            state: start.state,
          };
        },
      },
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    await client.signIn('android', 'synthetic-installation-0001');

    expect(savedWhenBrowserOpened).not.toBeNull();
    expect(flows.saved[0]).toEqual({
      state: startResponse.state,
      codeVerifier: CODE_VERIFIER,
      flowToken: startResponse.flowToken,
      expiresAt: startResponse.expiresAt,
    });
  });

  test('clears the attempt once promptAsync completes it', async () => {
    const flows = memoryFlowStore();
    const client = new MobileOidcClient(
      exchangingTransport([]),
      {
        async authorize(start) {
          return {
            kind: 'success',
            authorizationCode: 'synthetic-authorization-code',
            state: start.state,
          };
        },
      },
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    await client.signIn('android', 'synthetic-installation-0001');
    expect(flows.peek()).toBeNull();
  });

  test('keeps the attempt when the browser hands back no redirect', async () => {
    // On Android this is routinely not a cancellation: the OS can route the
    // redirect to the app, which dismisses the custom tab. Discarding the
    // verifier here is what stranded the authorization code on the callback
    // route with nothing able to spend it.
    const flows = memoryFlowStore();
    const client = new MobileOidcClient(
      exchangingTransport([]),
      { authorize: async () => ({ kind: 'cancelled' }) },
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    await expect(
      client.signIn('android', 'synthetic-installation-0001'),
    ).rejects.toThrow(OidcRedirectNotCapturedError);
    expect(flows.peek()).not.toBeNull();
  });

  test('completes the redirect the browser session never captured', async () => {
    // The whole Android race, end to end: the prompt reports a cancellation
    // while the deep-link route is holding the code, and the resume spends it.
    const exchanges: unknown[] = [];
    const flows = memoryFlowStore();
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      { authorize: async () => ({ kind: 'cancelled' }) },
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    await expect(
      client.signIn('android', 'synthetic-installation-0001'),
    ).rejects.toThrow(OidcRedirectNotCapturedError);

    const resumed = await client.completeSignIn(
      'synthetic-authorization-code',
      OIDC_STATE,
    );

    expect(resumed.refreshToken).toBe(TEST_TOKEN);
    expect(exchanges).toEqual([
      {
        authorizationCode: 'synthetic-authorization-code',
        state: OIDC_STATE,
        codeVerifier: CODE_VERIFIER,
        flowToken: startResponse.flowToken,
      },
    ]);
    // Still single-use: the record is gone once it has been spent.
    expect(flows.peek()).toBeNull();
  });

  test('exchanges a redirect that arrived after the process restarted', async () => {
    const exchanges: unknown[] = [];
    const flows = memoryFlowStore(pendingFixture);
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      refusingBrowser,
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    const result = await client.completeSignIn(
      'synthetic-authorization-code',
      OIDC_STATE,
    );

    expect(result.refreshToken).toBe(TEST_TOKEN);
    expect(exchanges[0]).toEqual({
      authorizationCode: 'synthetic-authorization-code',
      state: OIDC_STATE,
      codeVerifier: CODE_VERIFIER,
      flowToken: startResponse.flowToken,
    });
  });

  test('consumes the attempt so the same deep link cannot be replayed', async () => {
    const exchanges: unknown[] = [];
    const flows = memoryFlowStore(pendingFixture);
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      refusingBrowser,
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    await client.completeSignIn('synthetic-authorization-code', OIDC_STATE);
    await expect(
      client.completeSignIn('synthetic-authorization-code', OIDC_STATE),
    ).rejects.toThrow('no Google sign-in waiting');
    expect(exchanges).toHaveLength(1);
  });

  test('refuses a deep link whose state is not the attempt this device started', async () => {
    const exchanges: unknown[] = [];
    const flows = memoryFlowStore(pendingFixture);
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      refusingBrowser,
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    await expect(
      client.completeSignIn('attacker-code', `m1.${'X'.repeat(43)}`),
    ).rejects.toThrow('could not be verified');
    expect(exchanges).toHaveLength(0);
    // Refusing still consumes the attempt, so a mismatched link cannot be used
    // to probe for a still-live pending flow.
    expect(flows.peek()).toBeNull();
  });

  test('refuses to resume an attempt that has expired', async () => {
    const exchanges: unknown[] = [];
    const flows = memoryFlowStore(pendingFixture);
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      refusingBrowser,
      pkceSource,
      () => new Date('2026-08-10T18:06:00.000Z'),
      flows.store,
    );

    await expect(
      client.completeSignIn('synthetic-authorization-code', OIDC_STATE),
    ).rejects.toThrow('expired');
    expect(exchanges).toHaveLength(0);
  });

  test('refuses to resume when no attempt was ever started on this device', async () => {
    const exchanges: unknown[] = [];
    const flows = memoryFlowStore();
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      refusingBrowser,
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
      flows.store,
    );

    await expect(
      client.completeSignIn('synthetic-authorization-code', OIDC_STATE),
    ).rejects.toThrow('no Google sign-in waiting');
    expect(exchanges).toHaveLength(0);
  });

  test('refuses to resume in a build with no pending-flow storage', async () => {
    const exchanges: unknown[] = [];
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      refusingBrowser,
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
    );

    await expect(
      client.completeSignIn('synthetic-authorization-code', OIDC_STATE),
    ).rejects.toThrow('cannot resume');
    expect(exchanges).toHaveLength(0);
  });

  test('signs in normally when no pending-flow storage is configured', async () => {
    const exchanges: unknown[] = [];
    const client = new MobileOidcClient(
      exchangingTransport(exchanges),
      {
        async authorize(start) {
          return {
            kind: 'success',
            authorizationCode: 'synthetic-authorization-code',
            state: start.state,
          };
        },
      },
      pkceSource,
      () => new Date('2026-08-10T18:00:00.000Z'),
    );

    const result = await client.signIn('ios', 'synthetic-installation-0001');
    expect(result.refreshToken).toBe(TEST_TOKEN);
    expect(exchanges).toHaveLength(1);
  });
});
