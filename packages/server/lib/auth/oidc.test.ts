import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parseCapabilityEnvelopeFor } from '@psd-eoc/contracts';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import {
  GoogleOidcCallbackError,
  beginGoogleMobileOidcSignIn,
  completeGoogleMobileOidcExchange,
  createCompleteMobileOidcSignInEnvelope,
  createGoogleMobileOidcCallbackRelayUrl,
  readGoogleOidcConfiguration,
  type GoogleOidcConfiguration,
} from './oidc';

const CLIENT_ID = 'synthetic-mobile-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'synthetic-client-secret';
const COOKIE_SECRET = Buffer.alloc(32, 19).toString('base64url');
const INSTALLATION_ID = 'synthetic-native-installation-0001';
const VERIFIER = 'v'.repeat(64);
const NOW = new Date();
const MOCK_PROVIDER_ORIGIN = 'http://127.0.0.1:4199';
const originalFetch = globalThis.fetch;

interface CodeRecord {
  readonly nonce: string;
  readonly verifier: string;
  readonly claimOverrides?: Readonly<Record<string, unknown>>;
  readonly signingKey?: CryptoKey;
}

const codes = new Map<string, CodeRecord>();
const consumedCodes = new Set<string>();
let configuration: GoogleOidcConfiguration;
let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString('base64url');
}

async function idToken(record: CodeRecord): Promise<string> {
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);
  const { iss, aud, ...claimOverrides } = record.claimOverrides ?? {};
  const issuer = typeof iss === 'string' ? iss : 'https://accounts.google.com';
  const audience = typeof aud === 'string' ? aud : CLIENT_ID;
  const claims = {
    nonce: record.nonce,
    hd: 'psd401.net',
    email: 'synthetic.mobile@psd401.net',
    email_verified: true,
    name: 'Synthetic Mobile Staff',
    ...claimOverrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('synthetic-google-subject-mobile')
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 600)
    .sign(record.signingKey ?? signingKey);
}

beforeAll(async () => {
  const primary = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  signingKey = primary.privateKey;
  otherSigningKey = other.privateKey;
  publicJwk = await exportJWK(primary.publicKey);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    if (url.origin !== MOCK_PROVIDER_ORIGIN) {
      throw new Error('Native OIDC test attempted an external request.');
    }
    if (url.pathname === '/jwks') {
      return Response.json({
        keys: [
          { ...publicJwk, alg: 'RS256', kid: 'synthetic-key', use: 'sig' },
        ],
      });
    }
    if (url.pathname !== '/token' || init?.method !== 'POST') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const form =
      init.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    const code = form.get('code') ?? '';
    const record = codes.get(code);
    if (
      record === undefined ||
      consumedCodes.has(code) ||
      form.get('client_id') !== CLIENT_ID ||
      form.get('client_secret') !== CLIENT_SECRET ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('redirect_uri') !== `${MOCK_PROVIDER_ORIGIN}/callback` ||
      form.get('code_verifier') !== record.verifier
    ) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    consumedCodes.add(code);
    return Response.json({ id_token: await idToken(record) });
  }) as typeof globalThis.fetch;
  const origin = MOCK_PROVIDER_ORIGIN;
  configuration = readGoogleOidcConfiguration({
    NODE_ENV: 'test',
    GOOGLE_OIDC_CLIENT_ID: CLIENT_ID,
    GOOGLE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OIDC_REDIRECT_URI: `${origin}/callback`,
    GOOGLE_OIDC_COOKIE_SECRET: COOKIE_SECRET,
    GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: `${origin}/authorize`,
    GOOGLE_OIDC_TOKEN_ENDPOINT: `${origin}/token`,
    GOOGLE_OIDC_JWKS_URI: `${origin}/jwks`,
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function expectOidcError(
  error: unknown,
  code: GoogleOidcCallbackError['code'],
): void {
  expect(error).toBeInstanceOf(GoogleOidcCallbackError);
  expect((error as GoogleOidcCallbackError).code).toBe(code);
}

async function startedFlow(
  verifier = VERIFIER,
  now = NOW,
): Promise<
  Awaited<ReturnType<typeof beginGoogleMobileOidcSignIn>> & {
    readonly verifier: string;
    readonly nonce: string;
  }
> {
  const result = await beginGoogleMobileOidcSignIn(configuration, {
    platform: 'ios',
    installationId: INSTALLATION_ID,
    codeChallenge: await codeChallenge(verifier),
    now,
  });
  const authorizationUrl = new URL(result.authorizationUrl);
  const nonce = authorizationUrl.searchParams.get('nonce');
  if (nonce === null) {
    throw new Error('Native OIDC start omitted its nonce.');
  }
  return { ...result, verifier, nonce };
}

describe('native Google OIDC adapter', () => {
  test('binds a server-prefixed state, nonce, app challenge, and fixed redirects', async () => {
    const started = await startedFlow();
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(started.clientId).toBe(CLIENT_ID);
    expect(started.state).toMatch(/^m1\.[A-Za-z0-9_-]{43}$/u);
    expect(started.appRedirectUri).toBe('psdeoc://auth/callback');
    expect(authorizationUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      configuration.redirectUri,
    );
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('state')).toBe(started.state);
    expect(authorizationUrl.searchParams.get('nonce')).toBe(started.nonce);
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(
      await codeChallenge(VERIFIER),
    );
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(authorizationUrl.searchParams.has('hd')).toBe(false);
    expect(started.flowToken).not.toContain(VERIFIER);
    expect(started.flowToken).not.toContain(INSTALLATION_ID);
  });

  test('relays only bounded mobile code/state to the fixed application URI', async () => {
    const started = await startedFlow();
    const relayed = createGoogleMobileOidcCallbackRelayUrl(
      configuration,
      `${configuration.redirectUri}?code=one-time-code&state=${started.state}`,
    );
    expect(relayed).not.toBeNull();
    const relayUrl = new URL(relayed ?? '');
    expect(relayUrl.origin).toBe('null');
    expect(relayUrl.protocol).toBe('psdeoc:');
    expect(relayUrl.host).toBe('auth');
    expect(relayUrl.pathname).toBe('/callback');
    expect(relayUrl.searchParams.get('code')).toBe('one-time-code');
    expect(relayUrl.searchParams.get('state')).toBe(started.state);
    expect(relayUrl.searchParams.has('flowToken')).toBe(false);
    expect(
      createGoogleMobileOidcCallbackRelayUrl(
        configuration,
        `${configuration.redirectUri}?code=web-code&state=${'w'.repeat(43)}`,
      ),
    ).toBeNull();
    const duplicate = createGoogleMobileOidcCallbackRelayUrl(
      configuration,
      `${configuration.redirectUri}?code=a&state=${started.state}&state=${started.state}`,
    );
    expect(new URL(duplicate ?? '').searchParams.get('error')).toBe(
      'callback_invalid',
    );
    const providerError = createGoogleMobileOidcCallbackRelayUrl(
      configuration,
      `${configuration.redirectUri}?error=server_error&state=${started.state}`,
    );
    expect(new URL(providerError ?? '').searchParams.get('error')).toBe(
      'provider_rejected',
    );
    const configured = new URL(configuration.redirectUri);
    for (const untrustedUrl of [
      `http://localhost:${configured.port}${configured.pathname}?code=a&state=${started.state}`,
      `${configured.origin}/wrong-path?code=a&state=${started.state}`,
      `https://${configured.host}${configured.pathname}?code=a&state=${started.state}`,
    ]) {
      expect(() =>
        createGoogleMobileOidcCallbackRelayUrl(configuration, untrustedUrl),
      ).toThrow(GoogleOidcCallbackError);
    }
    for (const nonMobileUrl of [
      `http://localhost:${configured.port}${configured.pathname}?code=a&state=${'w'.repeat(43)}`,
      `${configured.origin}/wrong-path?code=a&state=${'w'.repeat(43)}`,
      `https://${configured.host}${configured.pathname}?code=a&state=${'w'.repeat(43)}`,
    ]) {
      expect(
        createGoogleMobileOidcCallbackRelayUrl(configuration, nonMobileUrl),
      ).toBeNull();
    }
  });

  test('verifies exchange evidence before producing a canonical mobile envelope', async () => {
    const started = await startedFlow();
    const code = 'valid-mobile-code';
    codes.set(code, { nonce: started.nonce, verifier: started.verifier });
    const exchange = await completeGoogleMobileOidcExchange(configuration, {
      authorizationCode: code,
      state: started.state,
      codeVerifier: started.verifier,
      flowToken: started.flowToken,
      now: NOW,
    });
    expect(exchange.capabilityInput.device).toEqual({
      platform: 'ios',
      unlockMethod: 'biometric',
      installationId: INSTALLATION_ID,
    });
    expect(exchange.capabilityInput.claims).toMatchObject({
      issuer: 'https://accounts.google.com',
      audience: CLIENT_ID,
      hostedDomain: 'psd401.net',
      emailVerified: true,
    });
    expect(exchange.transport).toEqual({
      kind: 'mobile-oidc-code-exchange',
      method: 'POST',
      stateVerified: true,
      nonceVerified: true,
      pkceVerified: true,
      signatureVerified: true,
    });
    const envelope = createCompleteMobileOidcSignInEnvelope(exchange, {
      requestId: '10000000-0000-4000-8000-000000000001',
      serverTime: NOW.toISOString(),
    });
    expect(() =>
      parseCapabilityEnvelopeFor('complete-oidc-sign-in', envelope),
    ).not.toThrow();
    expect(envelope.source).toBe('mobile');
    expect(JSON.stringify(envelope)).not.toContain(code);
    expect(JSON.stringify(envelope)).not.toContain(started.verifier);
    expect(JSON.stringify(envelope)).not.toContain(started.flowToken);
  });

  test('rejects tampered, expired, wrong-state, and wrong-verifier flows before exchange', async () => {
    const started = await startedFlow();
    const tamperedFlowToken = `${started.flowToken.slice(0, -1)}${
      started.flowToken.endsWith('x') ? 'y' : 'x'
    }`;
    const cases: readonly [
      string,
      Parameters<typeof completeGoogleMobileOidcExchange>[1],
      GoogleOidcCallbackError['code'],
    ][] = [
      [
        'tampered flow',
        {
          authorizationCode: 'unused-code-one',
          state: started.state,
          codeVerifier: started.verifier,
          flowToken: tamperedFlowToken,
          now: NOW,
        },
        'OIDC_FLOW_TOKEN_INVALID',
      ],
      [
        'expired flow',
        {
          authorizationCode: 'unused-code-two',
          state: started.state,
          codeVerifier: started.verifier,
          flowToken: started.flowToken,
          now: new Date(NOW.getTime() + 11 * 60 * 1_000),
        },
        'OIDC_FLOW_TOKEN_INVALID',
      ],
      [
        'wrong state',
        {
          authorizationCode: 'unused-code-three',
          state: `m1.${'q'.repeat(43)}`,
          codeVerifier: started.verifier,
          flowToken: started.flowToken,
          now: NOW,
        },
        'OIDC_STATE_MISMATCH',
      ],
      [
        'wrong verifier',
        {
          authorizationCode: 'unused-code-four',
          state: started.state,
          codeVerifier: 'x'.repeat(64),
          flowToken: started.flowToken,
          now: NOW,
        },
        'OIDC_PKCE_MISMATCH',
      ],
    ];
    for (const [, input, expectedCode] of cases) {
      try {
        await completeGoogleMobileOidcExchange(configuration, input);
        throw new Error('Expected native OIDC exchange rejection.');
      } catch (error) {
        expectOidcError(error, expectedCode);
      }
    }
  });

  test('rejects authorization-code replay and invalid signed identity claims', async () => {
    const replayFlow = await startedFlow();
    const replayCode = 'one-use-only-code';
    codes.set(replayCode, {
      nonce: replayFlow.nonce,
      verifier: replayFlow.verifier,
    });
    const firstExchange = await completeGoogleMobileOidcExchange(
      configuration,
      {
        authorizationCode: replayCode,
        state: replayFlow.state,
        codeVerifier: replayFlow.verifier,
        flowToken: replayFlow.flowToken,
        now: NOW,
      },
    );
    const secondCode = 'second-code-for-same-flow';
    codes.set(secondCode, {
      nonce: replayFlow.nonce,
      verifier: replayFlow.verifier,
    });
    const secondExchange = await completeGoogleMobileOidcExchange(
      configuration,
      {
        authorizationCode: secondCode,
        state: replayFlow.state,
        codeVerifier: replayFlow.verifier,
        flowToken: replayFlow.flowToken,
        now: NOW,
      },
    );
    expect(secondExchange.idempotencyKey).toBe(firstExchange.idempotencyKey);
    expect(secondExchange.responseDigest).toBe(firstExchange.responseDigest);
    try {
      await completeGoogleMobileOidcExchange(configuration, {
        authorizationCode: replayCode,
        state: replayFlow.state,
        codeVerifier: replayFlow.verifier,
        flowToken: replayFlow.flowToken,
        now: NOW,
      });
      throw new Error('Expected consumed code rejection.');
    } catch (error) {
      expectOidcError(error, 'OIDC_TOKEN_EXCHANGE_FAILED');
    }

    const invalidCases: readonly [
      string,
      Readonly<Record<string, unknown>>,
      CryptoKey | undefined,
    ][] = [
      ['wrong nonce', { nonce: 'n'.repeat(43) }, undefined],
      ['wrong audience', { aud: 'attacker-client' }, undefined],
      ['wrong issuer', { iss: 'https://attacker.invalid' }, undefined],
      ['unverified email', { email_verified: false }, undefined],
      ['wrong signature', {}, otherSigningKey],
    ];
    for (const [label, claimOverrides, invalidSigningKey] of invalidCases) {
      const flow = await startedFlow();
      const code = `invalid-claims-${label.replaceAll(' ', '-')}`;
      codes.set(code, {
        nonce: flow.nonce,
        verifier: flow.verifier,
        claimOverrides,
        ...(invalidSigningKey === undefined
          ? {}
          : { signingKey: invalidSigningKey }),
      });
      try {
        await completeGoogleMobileOidcExchange(configuration, {
          authorizationCode: code,
          state: flow.state,
          codeVerifier: flow.verifier,
          flowToken: flow.flowToken,
          now: NOW,
        });
        throw new Error(`Expected ${label} rejection.`);
      } catch (error) {
        expectOidcError(error, 'OIDC_ID_TOKEN_INVALID');
      }
    }

    const nonDistrictFlow = await startedFlow();
    const nonDistrictCode = 'exact-group-not-domain-membership';
    codes.set(nonDistrictCode, {
      nonce: nonDistrictFlow.nonce,
      verifier: nonDistrictFlow.verifier,
      claimOverrides: {
        hd: 'example.org',
        email: 'selected.member@example.org',
      },
    });
    const nonDistrictExchange = await completeGoogleMobileOidcExchange(
      configuration,
      {
        authorizationCode: nonDistrictCode,
        state: nonDistrictFlow.state,
        codeVerifier: nonDistrictFlow.verifier,
        flowToken: nonDistrictFlow.flowToken,
        now: NOW,
      },
    );
    expect(nonDistrictExchange.capabilityInput.claims).toMatchObject({
      hostedDomain: 'example.org',
      email: 'selected.member@example.org',
      emailVerified: true,
    });
  });
});
