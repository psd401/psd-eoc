import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  executeCapability,
  parseCapabilityEnvelopeFor,
  type CompleteOidcSignInInput,
} from '@psd-eoc/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import { checkAccessGate } from '../../lib/auth/access-gate';
import {
  beginGoogleOidcSignIn,
  completeGoogleOidcCallback,
  createCompleteOidcSignInEnvelope,
  GoogleOidcCallbackError,
  GoogleOidcConfigurationError,
  readGoogleOidcConfiguration,
} from '../../lib/auth/oidc';
import {
  createCompleteOidcSignInAuthorizer,
  createCompleteOidcSignInHandler,
  digestWebSessionCredential,
  isRetryableSessionTransactionError,
  type CompleteOidcSignInContext,
  type InitialWebSessionStore,
  type PersistInitialWebSessionRequest,
  type WebSessionCookie,
  type WebSessionPolicy,
} from '../../lib/auth/session-cookie';
import {
  createPlaywrightAuthRuntime,
  PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION,
  PLAYWRIGHT_MEMBER_SUBJECT,
} from './test/auth-test-runtime';
import {
  clearReturnToCookieHeader,
  createReturnToCookieHeader,
  readReturnToCookie,
  returnToFromRequestUrl,
  validateReturnTo,
  WEB_RETURN_TO_COOKIE_MAX_AGE_SECONDS,
  WEB_RETURN_TO_COOKIE_NAME,
} from './auth/return-to';
import { GET as completeGoogleOidcSignIn } from './auth/callback/route';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const CLIENT_ID = 'synthetic-unit.apps.googleusercontent.com';
const CLIENT_SECRET = 'synthetic-unit-client-secret';
const HOSTED_DOMAIN = 'psd401.net';
const COOKIE_SECRET = Buffer.alloc(32, 11).toString('base64url');
const PRODUCTION_PROJECT_NUMBER = '338414773271';
const PRODUCTION_WEB_CLIENT_ID = `${PRODUCTION_PROJECT_NUMBER}-webclient.apps.googleusercontent.com`;
const PRODUCTION_IOS_CLIENT_ID = `${PRODUCTION_PROJECT_NUMBER}-iosclient.apps.googleusercontent.com`;
const PRODUCTION_CLIENT_SECRET = `GOCSPX-${'a'.repeat(32)}`;
const SESSION_POLICY: Readonly<WebSessionPolicy> = Object.freeze({
  sessionLifetimeSeconds: 90 * 24 * 60 * 60,
  membershipTtlSeconds: 24 * 60 * 60,
  membershipGraceSeconds: 72 * 60 * 60,
});

test('auth callback uses the shared fail-closed database configuration', async () => {
  const source = await Bun.file(
    new URL('./auth/callback/route.ts', import.meta.url),
  ).text();
  expect(source).toContain('createDatabaseClient');
  expect(source).toContain('readDatabaseConfig');
  expect(source).toContain('Authentication requires native PostgreSQL.');
  expect(source).not.toContain('@aws-sdk/client-rds-data');
  expect(source).not.toContain('drizzle-orm/aws-data-api/pg');
  expect(source).not.toContain("from 'postgres'");
});

test('auth callback keeps App Runner listener URLs off public redirects', async () => {
  const names = [
    'NODE_ENV',
    'GOOGLE_OAUTH_CONFIG',
    'GOOGLE_OIDC_COOKIE_SECRET',
    'GOOGLE_OIDC_CLIENT_ID',
    'GOOGLE_OIDC_CLIENT_SECRET',
    'GOOGLE_OIDC_REDIRECT_URI',
    'GOOGLE_OIDC_AUTHORIZATION_ENDPOINT',
    'GOOGLE_OIDC_TOKEN_ENDPOINT',
    'GOOGLE_OIDC_JWKS_URI',
    'GOOGLE_OIDC_ISSUER',
    'GOOGLE_OIDC_APPLICATION_ORIGIN',
    'GOOGLE_OIDC_ORIGIN',
    'GOOGLE_OIDC_HOSTED_DOMAIN',
    'GOOGLE_OIDC_DOMAIN',
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));

  try {
    for (const name of names) {
      Reflect.deleteProperty(process.env, name);
    }
    Reflect.set(process.env, 'NODE_ENV', 'production');
    Reflect.set(
      process.env,
      'GOOGLE_OAUTH_CONFIG',
      JSON.stringify({
        clientId: PRODUCTION_WEB_CLIENT_ID,
        clientSecret: PRODUCTION_CLIENT_SECRET,
        iosBundleId: 'net.psd401.eoc',
        iosClientId: PRODUCTION_IOS_CLIENT_ID,
        webClientId: PRODUCTION_WEB_CLIENT_ID,
      }),
    );
    Reflect.set(process.env, 'GOOGLE_OIDC_COOKIE_SECRET', COOKIE_SECRET);

    const state = `m1.${'a'.repeat(43)}`;
    const mobileResponse = await completeGoogleOidcSignIn(
      new Request(
        `https://localhost:3000/auth/callback?error=access_denied&state=${state}`,
      ),
    );
    expect(mobileResponse.status).toBe(303);
    expect(mobileResponse.headers.get('location')).toBe(
      `psdeoc://auth/callback?state=${state}&error=access_denied`,
    );

    const webResponse = await completeGoogleOidcSignIn(
      new Request(
        'https://localhost:3000/auth/callback?code=provider-code&state=server-state',
      ),
    );
    expect(webResponse.status).toBe(303);
    expect(webResponse.headers.get('location')).toBe(
      'https://eoc.psd401.net/denied?reason=callback',
    );
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        Reflect.set(process.env, name, value);
      }
    }
  }
});

type ClaimVariant =
  | 'valid'
  | 'missing-name'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'wrong-domain'
  | 'unverified-email'
  | 'wrong-nonce'
  | 'wrong-signature'
  | 'expired-token'
  | 'wrong-algorithm'
  | 'missing-kid';

interface TokenInstruction {
  readonly nonce: string;
  readonly variant: ClaimVariant;
  readonly idTokenOverride?: string;
}

let privateKey: CryptoKey;
let unrelatedPrivateKey: CryptoKey;
let publicJwk: JWK;
const tokenInstructions = new Map<string, TokenInstruction>();
const issuedTokens = new Map<string, string>();
const mockProviderOrigin = 'http://127.0.0.1:45106';
const originalFetch = globalThis.fetch;
let tokenRequestCount = 0;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function signToken(instruction: TokenInstruction): Promise<string> {
  const { variant } = instruction;
  const now = Math.floor(Date.now() / 1_000);
  const token = new SignJWT({
    nonce:
      variant === 'wrong-nonce' ? 'not-the-request-nonce' : instruction.nonce,
    hd: variant === 'wrong-domain' ? 'example.invalid' : HOSTED_DOMAIN,
    email: 'member@psd401.net',
    email_verified: variant !== 'unverified-email',
    ...(variant === 'missing-name' ? {} : { name: 'Synthetic Member' }),
  })
    .setIssuer(
      variant === 'wrong-issuer' ? 'https://issuer.invalid' : GOOGLE_ISSUER,
    )
    .setAudience(variant === 'wrong-audience' ? 'another-client' : CLIENT_ID)
    .setSubject(PLAYWRIGHT_MEMBER_SUBJECT)
    .setIssuedAt(variant === 'expired-token' ? now - 1_200 : now)
    .setExpirationTime(variant === 'expired-token' ? now - 600 : now + 300);

  if (variant === 'wrong-algorithm') {
    return token
      .setProtectedHeader({ alg: 'HS256', kid: 'unit-test-key', typ: 'JWT' })
      .sign(new TextEncoder().encode('synthetic-wrong-algorithm-key-32b'));
  }

  return token
    .setProtectedHeader({
      alg: 'RS256',
      ...(variant === 'missing-kid' ? {} : { kid: 'unit-test-key' }),
      typ: 'JWT',
    })
    .sign(variant === 'wrong-signature' ? unrelatedPrivateKey : privateKey);
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  unrelatedPrivateKey = (await generateKeyPair('RS256', { extractable: true }))
    .privateKey;
  publicJwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid: 'unit-test-key',
    use: 'sig',
  };
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
    if (url.origin !== mockProviderOrigin) {
      throw new Error('Unit OIDC attempted a non-mock network request.');
    }
    if (url.pathname === '/jwks-malformed') {
      return json({ keys: 'not-an-array' });
    }
    if (url.pathname === '/jwks') {
      return json({ keys: [publicJwk] });
    }
    if (url.pathname === '/token' && init?.method === 'POST') {
      tokenRequestCount += 1;
      const body = init.body;
      const form =
        body instanceof URLSearchParams
          ? body
          : new URLSearchParams(typeof body === 'string' ? body : '');
      const code = form.get('code') ?? '';
      const instruction = tokenInstructions.get(code);
      tokenInstructions.delete(code);
      if (
        instruction === undefined ||
        form.get('client_id') !== CLIENT_ID ||
        form.get('client_secret') !== CLIENT_SECRET ||
        form.get('grant_type') !== 'authorization_code' ||
        (form.get('code_verifier')?.length ?? 0) < 43
      ) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const idToken =
        instruction.idTokenOverride ?? (await signToken(instruction));
      issuedTokens.set(code, idToken);
      return json({ id_token: idToken });
    }
    return new Response('Not found.', { status: 404 });
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function oidcEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    NODE_ENV: 'test',
    GOOGLE_OIDC_CLIENT_ID: CLIENT_ID,
    GOOGLE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OIDC_REDIRECT_URI: `${mockProviderOrigin}/callback`,
    GOOGLE_OIDC_COOKIE_SECRET: COOKIE_SECRET,
    GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: `${mockProviderOrigin}/authorize`,
    GOOGLE_OIDC_TOKEN_ENDPOINT: `${mockProviderOrigin}/token`,
    GOOGLE_OIDC_JWKS_URI: `${mockProviderOrigin}/jwks`,
    ...overrides,
  };
}

function productionOidcEnvironment(
  oauthConfig: Readonly<Record<string, unknown>> = {
    clientId: PRODUCTION_WEB_CLIENT_ID,
    clientSecret: PRODUCTION_CLIENT_SECRET,
    iosBundleId: 'net.psd401.eoc',
    iosClientId: PRODUCTION_IOS_CLIENT_ID,
    webClientId: PRODUCTION_WEB_CLIENT_ID,
  },
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    NODE_ENV: 'production',
    GOOGLE_OAUTH_CONFIG: JSON.stringify(oauthConfig),
    GOOGLE_OIDC_COOKIE_SECRET: COOKIE_SECRET,
    ...overrides,
  };
}

function cookieRequestHeader(setCookieHeader: string): string {
  const cookie = setCookieHeader.split(';', 1)[0];
  if (cookie === undefined) {
    throw new Error('OIDC did not issue its transient cookie.');
  }
  return cookie;
}

function createSyntheticSignInEnvelope(
  input: CompleteOidcSignInInput,
  requestId: string,
  serverTime: string,
  responseDigest: string,
) {
  return parseCapabilityEnvelopeFor<'complete-oidc-sign-in'>(
    'complete-oidc-sign-in',
    {
      capabilityId: 'complete-oidc-sign-in',
      operation: 'mutation',
      principal: {
        kind: 'verified-oidc-claims',
        ...input.claims,
        audienceVerified: true,
      },
      source: 'web',
      requestId,
      serverTime,
      input,
      idempotencyKey: `oidc:${responseDigest}`,
      transport: {
        kind: 'oidc-code-callback',
        method: 'GET',
        stateVerified: true,
        nonceVerified: true,
        pkceVerified: true,
        signatureVerified: true,
      },
    },
  );
}

async function callbackForVariant(
  variant: ClaimVariant,
  options: Readonly<{
    idTokenOverride?: string;
    jwksPath?: '/jwks' | '/jwks-malformed';
  }> = {},
) {
  const configuration = readGoogleOidcConfiguration(
    oidcEnvironment({
      GOOGLE_OIDC_JWKS_URI: `${mockProviderOrigin}${options.jwksPath ?? '/jwks'}`,
    }),
  );
  const started = await beginGoogleOidcSignIn(configuration);
  const authorization = new URL(started.authorizationUrl);
  const state = authorization.searchParams.get('state');
  const nonce = authorization.searchParams.get('nonce');
  if (state === null || nonce === null) {
    throw new Error('OIDC start omitted state or nonce.');
  }
  const code = `${variant}-${randomUUID()}`;
  tokenInstructions.set(code, {
    nonce,
    variant,
    ...(options.idTokenOverride === undefined
      ? {}
      : { idTokenOverride: options.idTokenOverride }),
  });
  const callbackUrl = new URL(configuration.redirectUri);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state);
  return {
    configuration,
    started,
    callbackUrl,
    code,
    result: completeGoogleOidcCallback(configuration, {
      method: 'GET',
      callbackUrl,
      cookieHeader: cookieRequestHeader(started.setCookieHeader),
    }),
  };
}

function expectOidcError(
  error: unknown,
  code: GoogleOidcCallbackError['code'],
): void {
  expect(error).toBeInstanceOf(GoogleOidcCallbackError);
  expect((error as GoogleOidcCallbackError).code).toBe(code);
  expect((error as GoogleOidcCallbackError).clearCookieHeader).toContain(
    'Max-Age=0',
  );
}

describe('protected web return destination', () => {
  const environment = Object.freeze({
    GOOGLE_OIDC_COOKIE_SECRET: COOKIE_SECRET,
  });
  const issuedAt = new Date('2026-08-10T12:00:00.000Z');
  const exactDestination =
    '/start?facility=synthetic-harbor%20school&mode=real&next=%2Fevents%2Factive';

  test('preserves an exact app-relative pathname and query', () => {
    expect(validateReturnTo(exactDestination)).toBe(exactDestination);
    expect(
      returnToFromRequestUrl(
        `https://eoc.psd401.net/auth/sign-in?returnTo=${encodeURIComponent(exactDestination)}`,
      ),
    ).toBe(exactDestination);
  });

  test.each([
    ['external URL', 'https://example.invalid/start'],
    ['protocol-relative URL', '//example.invalid/start'],
    ['encoded protocol-relative URL', '/%2f%2fexample.invalid/start'],
    ['malformed percent encoding', '/start?facility=%GG'],
    ['encoded control character', '/start/%00confirmation'],
    ['fragment-bearing URL', '/start#confirmation'],
    ['backslash URL', '/\\example.invalid/start'],
    ['normalized dot segment', '/events/../auth/sign-in'],
    ['login loop', '/login?returnTo=%2Fstart'],
    ['encoded auth loop', '/%61uth/callback'],
    ['completion loop', '/signed-in'],
    ['denial loop', '/denied?reason=access'],
    ['API destination', '/api/events?mode=real'],
    ['nested event-type API', '/event-types/api?operation=list'],
    ['nested event-room API', '/events/synthetic-event/api'],
    ['nested start API', '/start/api/activate'],
    ['matrix-parameter auth loop', '/login;next=start'],
    ['encoded path-separator ambiguity', '/%2e%2f/login'],
  ])('fails closed for %s', (_label, value) => {
    expect(validateReturnTo(value)).toBe('/');
  });

  test('fails closed when the return query is omitted or duplicated', () => {
    expect(returnToFromRequestUrl('https://eoc.psd401.net/auth/sign-in')).toBe(
      '/',
    );
    expect(
      returnToFromRequestUrl(
        'https://eoc.psd401.net/auth/sign-in?returnTo=%2Fstart&returnTo=%2Fevents',
      ),
    ).toBe('/');
  });

  test('issues short-lived, host-only, script-inaccessible signed state', () => {
    const header = createReturnToCookieHeader(exactDestination, {
      environment,
      now: issuedAt,
    });
    expect(header).toContain(`${WEB_RETURN_TO_COOKIE_NAME}=`);
    expect(header).toContain(`Max-Age=${WEB_RETURN_TO_COOKIE_MAX_AGE_SECONDS}`);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Domain=');
    expect(header).not.toContain(exactDestination);

    expect(
      readReturnToCookie(cookieRequestHeader(header), {
        environment,
        now: new Date(issuedAt.getTime() + 599_000),
      }),
    ).toEqual({ destination: exactDestination, valid: true });
  });

  test('rejects tampered, expired, duplicate, and wrongly signed state', () => {
    const header = createReturnToCookieHeader(exactDestination, {
      environment,
      now: issuedAt,
    });
    const cookie = cookieRequestHeader(header);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`;
    const wrongEnvironment = Object.freeze({
      GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 19).toString('base64url'),
    });
    const fallback = { destination: '/', valid: false };

    expect(
      readReturnToCookie(tampered, { environment, now: issuedAt }),
    ).toEqual(fallback);
    expect(
      readReturnToCookie(cookie, {
        environment,
        now: new Date(
          issuedAt.getTime() + WEB_RETURN_TO_COOKIE_MAX_AGE_SECONDS * 1_000,
        ),
      }),
    ).toEqual(fallback);
    expect(
      readReturnToCookie(`${cookie}; ${cookie}`, {
        environment,
        now: issuedAt,
      }),
    ).toEqual(fallback);
    expect(
      readReturnToCookie(cookie, {
        environment: wrongEnvironment,
        now: issuedAt,
      }),
    ).toEqual(fallback);
  });

  test('clears return state with the same restrictive cookie attributes', () => {
    const header = clearReturnToCookieHeader();
    expect(header).toContain(`${WEB_RETURN_TO_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Domain=');
  });
});

describe('Google OIDC adapter', () => {
  test('parses the retained five-field production contract with fixed boundaries', () => {
    const configuration = readGoogleOidcConfiguration(
      productionOidcEnvironment(),
    );

    expect(configuration).toEqual({
      mode: 'production',
      clientId: PRODUCTION_WEB_CLIENT_ID,
      redirectUri: 'https://eoc.psd401.net/auth/callback',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      transientCookieName: '__Host-psd-eoc-oidc',
      secureCookies: true,
      httpTimeoutMilliseconds: 10_000,
    });
    expect(JSON.stringify(configuration)).not.toContain(
      PRODUCTION_CLIENT_SECRET,
    );
    expect(JSON.stringify(configuration)).not.toContain(COOKIE_SECRET);
  });

  test('fails closed on every malformed retained-secret shape', () => {
    const valid = {
      clientId: PRODUCTION_WEB_CLIENT_ID,
      clientSecret: PRODUCTION_CLIENT_SECRET,
      iosBundleId: 'net.psd401.eoc',
      iosClientId: PRODUCTION_IOS_CLIENT_ID,
      webClientId: PRODUCTION_WEB_CLIENT_ID,
    } as const;
    const missingFieldCases = Object.keys(valid).map(
      (missingField) =>
        [
          `missing ${missingField}`,
          Object.fromEntries(
            Object.entries(valid).filter(([name]) => name !== missingField),
          ),
        ] as const,
    );
    const cases: ReadonlyArray<
      readonly [string, Readonly<Record<string, unknown>>]
    > = [
      ...missingFieldCases,
      ['unknown field', { ...valid, issuer: GOOGLE_ISSUER }],
      ['malformed client ID', { ...valid, clientId: 'not-google' }],
      ['malformed web client ID', { ...valid, webClientId: 'not-google' }],
      ['malformed iOS client ID', { ...valid, iosClientId: 'not-google' }],
      [
        'mismatched duplicated web client ID',
        {
          ...valid,
          clientId: `${PRODUCTION_PROJECT_NUMBER}-other.apps.googleusercontent.com`,
        },
      ],
      [
        'mismatched client project',
        {
          ...valid,
          iosClientId: '999999999999-iosclient.apps.googleusercontent.com',
        },
      ],
      [
        'reused web client as iOS client',
        { ...valid, iosClientId: PRODUCTION_WEB_CLIENT_ID },
      ],
      ['wrong iOS bundle', { ...valid, iosBundleId: 'net.psd401.other' }],
      ['empty client secret', { ...valid, clientSecret: '' }],
      ['untrimmed client secret', { ...valid, clientSecret: ' secret' }],
      ['line-bearing client secret', { ...valid, clientSecret: 'secret\n' }],
      [
        'oversized client secret',
        { ...valid, clientSecret: 's'.repeat(2_049) },
      ],
      [
        'placeholder client secret',
        { ...valid, clientSecret: 'BLOCKED_UNTIL_APPROVED' },
      ],
    ];

    for (const [, contract] of cases) {
      expect(() =>
        readGoogleOidcConfiguration(productionOidcEnvironment(contract)),
      ).toThrow(GoogleOidcConfigurationError);
    }

    for (const serialized of ['{', 'null', '[]']) {
      expect(() =>
        readGoogleOidcConfiguration({
          ...productionOidcEnvironment(),
          GOOGLE_OAUTH_CONFIG: serialized,
        }),
      ).toThrow(GoogleOidcConfigurationError);
    }

    expect(() =>
      readGoogleOidcConfiguration(
        productionOidcEnvironment({ ...valid, clientSecret: 's' }),
      ),
    ).not.toThrow();
  });

  test('rejects production legacy, mixed, origin, redirect, issuer, and domain overrides', () => {
    for (const name of [
      'GOOGLE_OIDC_CLIENT_ID',
      'GOOGLE_OIDC_CLIENT_SECRET',
      'GOOGLE_OIDC_REDIRECT_URI',
      'GOOGLE_OIDC_AUTHORIZATION_ENDPOINT',
      'GOOGLE_OIDC_TOKEN_ENDPOINT',
      'GOOGLE_OIDC_JWKS_URI',
      'GOOGLE_OIDC_ISSUER',
      'GOOGLE_OIDC_APPLICATION_ORIGIN',
      'GOOGLE_OIDC_ORIGIN',
      'GOOGLE_OIDC_HOSTED_DOMAIN',
      'GOOGLE_OIDC_DOMAIN',
    ] as const) {
      expect(() =>
        readGoogleOidcConfiguration(
          productionOidcEnvironment(undefined, { [name]: 'override' }),
        ),
      ).toThrow(GoogleOidcConfigurationError);
    }
  });

  test('rejects retained production configuration in a mock-provider runtime', () => {
    expect(() =>
      readGoogleOidcConfiguration({
        ...oidcEnvironment(),
        GOOGLE_OAUTH_CONFIG: productionOidcEnvironment().GOOGLE_OAUTH_CONFIG,
      }),
    ).toThrow(GoogleOidcConfigurationError);
  });

  test('starts code+S256 PKCE without a domain authorization hint or network call', async () => {
    const configuration = readGoogleOidcConfiguration(oidcEnvironment());
    const started = await beginGoogleOidcSignIn(configuration);
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(authorization.searchParams.get('code_challenge')).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    expect(authorization.searchParams.get('hd')).toBeNull();
    expect(started.setCookieHeader).toContain('HttpOnly');
    expect(started.setCookieHeader).toContain('SameSite=Lax');
  });

  test('produces a canonical verified callback and envelope', async () => {
    const callback = await callbackForVariant('valid');
    const result = await callback.result;
    expect(result.capabilityInput.claims).toMatchObject({
      issuer: GOOGLE_ISSUER,
      audience: CLIENT_ID,
      hostedDomain: HOSTED_DOMAIN,
      emailVerified: true,
      subject: PLAYWRIGHT_MEMBER_SUBJECT,
    });
    expect(result.capabilityInput.device.installationId).toMatch(
      /^web\.[A-Za-z0-9_-]{43}$/u,
    );
    expect(result.transport).toEqual({
      kind: 'oidc-code-callback',
      method: 'GET',
      stateVerified: true,
      nonceVerified: true,
      pkceVerified: true,
      signatureVerified: true,
    });
    expect(
      parseCapabilityEnvelopeFor(
        'complete-oidc-sign-in',
        createCompleteOidcSignInEnvelope(result, {
          requestId: randomUUID(),
          serverTime: new Date().toISOString(),
        }),
      ).input,
    ).toEqual(result.capabilityInput);
  });

  test('uses a minimized fallback when Google omits the optional name claim', async () => {
    const callback = await callbackForVariant('missing-name');
    const result = await callback.result;
    expect(result.capabilityInput.claims.displayName).toBe('PSD staff member');
  });

  test('generates a fresh server-owned installation identifier for every flow', async () => {
    const first = await callbackForVariant('valid');
    const second = await callbackForVariant('valid');
    const [firstResult, secondResult] = await Promise.all([
      first.result,
      second.result,
    ]);
    expect(firstResult.capabilityInput.device.installationId).toMatch(
      /^web\.[A-Za-z0-9_-]{43}$/u,
    );
    expect(secondResult.capabilityInput.device.installationId).toMatch(
      /^web\.[A-Za-z0-9_-]{43}$/u,
    );
    expect(firstResult.capabilityInput.device.installationId).not.toBe(
      secondResult.capabilityInput.device.installationId,
    );
  });

  test('retains a signed hosted-domain claim as informational evidence', async () => {
    const callback = await callbackForVariant('wrong-domain');
    const result = await callback.result;
    expect(result.capabilityInput.claims).toMatchObject({
      email: 'member@psd401.net',
      emailVerified: true,
      hostedDomain: 'example.invalid',
    });
  });

  for (const variant of [
    'wrong-issuer',
    'wrong-audience',
    'unverified-email',
    'wrong-nonce',
    'wrong-signature',
    'expired-token',
    'wrong-algorithm',
    'missing-kid',
  ] as const) {
    test(`rejects ${variant.replaceAll('-', ' ')}`, async () => {
      const callback = await callbackForVariant(variant);
      try {
        await callback.result;
        throw new Error('Expected the callback to be rejected.');
      } catch (error) {
        expectOidcError(error, 'OIDC_ID_TOKEN_INVALID');
      }
    });
  }

  test('rejects a malformed JWKS document', async () => {
    const callback = await callbackForVariant('valid', {
      jwksPath: '/jwks-malformed',
    });
    try {
      await callback.result;
      throw new Error('Expected malformed JWKS rejection.');
    } catch (error) {
      expectOidcError(error, 'OIDC_ID_TOKEN_INVALID');
    }
  });

  test('rejects replay of a consumed authorization code', async () => {
    const callback = await callbackForVariant('valid');
    await callback.result;
    try {
      await completeGoogleOidcCallback(callback.configuration, {
        method: 'GET',
        callbackUrl: callback.callbackUrl,
        cookieHeader: cookieRequestHeader(callback.started.setCookieHeader),
      });
      throw new Error('Expected consumed authorization-code rejection.');
    } catch (error) {
      expectOidcError(error, 'OIDC_TOKEN_EXCHANGE_FAILED');
    }
  });

  test('rejects an ID token replayed into a fresh nonce-bound flow', async () => {
    const first = await callbackForVariant('valid');
    await first.result;
    const replayedToken = issuedTokens.get(first.code);
    if (replayedToken === undefined) {
      throw new Error('Synthetic provider did not capture its issued token.');
    }

    const replay = await callbackForVariant('valid', {
      idTokenOverride: replayedToken,
    });
    try {
      await replay.result;
      throw new Error('Expected nonce-bound token replay rejection.');
    } catch (error) {
      expectOidcError(error, 'OIDC_ID_TOKEN_INVALID');
    }
  });

  test('rejects state mismatch before any token request', async () => {
    const configuration = readGoogleOidcConfiguration(oidcEnvironment());
    const started = await beginGoogleOidcSignIn(configuration);
    const callbackUrl = new URL(configuration.redirectUri);
    const code = `must-not-be-used-${randomUUID()}`;
    const requestsBeforeCallback = tokenRequestCount;
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', 'x'.repeat(43));
    try {
      await completeGoogleOidcCallback(configuration, {
        method: 'GET',
        callbackUrl,
        cookieHeader: cookieRequestHeader(started.setCookieHeader),
      });
      throw new Error('Expected state mismatch.');
    } catch (error) {
      expectOidcError(error, 'OIDC_STATE_MISMATCH');
    }
    expect(tokenRequestCount).toBe(requestsBeforeCallback);
  });

  test('rejects a tampered transient cookie', async () => {
    const configuration = readGoogleOidcConfiguration(oidcEnvironment());
    const started = await beginGoogleOidcSignIn(configuration);
    const authorization = new URL(started.authorizationUrl);
    const callbackUrl = new URL(configuration.redirectUri);
    callbackUrl.searchParams.set('code', 'unused');
    callbackUrl.searchParams.set(
      'state',
      authorization.searchParams.get('state') ?? '',
    );
    const cookie = cookieRequestHeader(started.setCookieHeader);
    try {
      await completeGoogleOidcCallback(configuration, {
        method: 'GET',
        callbackUrl,
        cookieHeader: `${cookie.slice(0, -1)}x`,
      });
      throw new Error('Expected cookie tamper rejection.');
    } catch (error) {
      expectOidcError(error, 'OIDC_TRANSIENT_COOKIE_INVALID');
    }
  });

  test('forbids provider endpoint overrides in production', () => {
    expect(() =>
      readGoogleOidcConfiguration({
        ...oidcEnvironment(),
        NODE_ENV: 'production',
        GOOGLE_OIDC_REDIRECT_URI: 'https://eoc.psd401.net/auth/callback',
      }),
    ).toThrow(GoogleOidcConfigurationError);
  });

  test('allows provider overrides only with a non-production loopback callback', () => {
    expect(
      readGoogleOidcConfiguration(oidcEnvironment({ NODE_ENV: 'development' }))
        .authorizationEndpoint,
    ).toBe(`${mockProviderOrigin}/authorize`);

    for (const runtimeMode of [undefined, 'development', 'test'] as const) {
      expect(() =>
        readGoogleOidcConfiguration(
          oidcEnvironment({
            NODE_ENV: runtimeMode,
            GOOGLE_OIDC_REDIRECT_URI: 'https://eoc.psd401.net/auth/callback',
          }),
        ),
      ).toThrow(GoogleOidcConfigurationError);
    }
  });
});

describe('configured Groups access and initial session', () => {
  test('retries only rollback-safe transaction conflicts', () => {
    expect(isRetryableSessionTransactionError({ code: '40001' })).toBe(true);
    expect(
      isRetryableSessionTransactionError({
        code: '23505',
        constraint_name: 'security_audit_entries_sequence_uq',
      }),
    ).toBe(true);
    expect(
      isRetryableSessionTransactionError({
        name: 'DatabaseErrorException',
        message:
          'ERROR: could not serialize access due to read/write dependencies among transactions; SQLState: 40001',
      }),
    ).toBe(true);
    expect(
      isRetryableSessionTransactionError({
        name: 'DatabaseErrorException',
        message:
          'ERROR: duplicate key value violates unique constraint "security_audit_entries_sequence_uq"; SQLState: 23505',
      }),
    ).toBe(true);
    expect(
      isRetryableSessionTransactionError({
        code: '23505',
        constraint_name: 'users_google_subject_uq',
      }),
    ).toBe(false);
  });

  test('uses the requested initial group as authorization configuration', async () => {
    expect(PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION).toMatchObject({
      email: 'tsd-engineering@psd401.net',
      kind: 'google-group',
      purpose: 'access',
    });
    const runtime = createPlaywrightAuthRuntime();
    const evidence = await runtime.accessStore.loadEvidence(
      PLAYWRIGHT_MEMBER_SUBJECT,
    );
    expect(evidence.activeAccessGroupSourceRefs).toContainEqual({
      id: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.id,
      kind: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.kind,
      purpose: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.purpose,
      facilityId: null,
    });
    expect(evidence.snapshot?.expectedAccessGroupSourceRefs).toEqual(
      evidence.activeAccessGroupSourceRefs,
    );
    expect(evidence.snapshot?.completedAccessGroupSourceRefs).toEqual(
      evidence.activeAccessGroupSourceRefs,
    );
    const decision = await checkAccessGate(
      {
        googleSubject: PLAYWRIGHT_MEMBER_SUBJECT,
        email: 'member@psd401.net',
        displayName: 'Synthetic Member',
        subjectDigest: 'e'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date().toISOString(),
        source: 'web',
      },
      { store: runtime.accessStore, audit: runtime.auditSink },
    );
    expect(decision.granted).toBe(true);
    if (!decision.granted) {
      throw new Error('Configured synthetic access group was not honored.');
    }
    expect(decision.membership.accessGroupSourceRefs).toContainEqual({
      id: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.id,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
    });
  });

  test('fails closed when a complete snapshot omits an active configured group', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const evidence = await runtime.accessStore.loadEvidence(
      PLAYWRIGHT_MEMBER_SUBJECT,
    );
    const additionalAccessGroup = {
      id: '00000000-0000-4000-8000-000000000107',
      kind: 'google-group' as const,
      purpose: 'access' as const,
      facilityId: null,
    };
    const decision = await checkAccessGate(
      {
        googleSubject: PLAYWRIGHT_MEMBER_SUBJECT,
        email: 'member@psd401.net',
        displayName: 'Synthetic Member',
        subjectDigest: 'f'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date().toISOString(),
        source: 'web',
      },
      {
        store: {
          async loadEvidence() {
            return {
              ...evidence,
              activeAccessGroupSourceRefs: [
                ...evidence.activeAccessGroupSourceRefs,
                additionalAccessGroup,
              ],
            };
          },
        },
        audit: runtime.auditSink,
      },
    );
    expect(decision).toEqual({
      granted: false,
      reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
    });
    expect(runtime.auditEntries).toContainEqual(
      expect.objectContaining({
        category: 'access-denial',
        outcome: 'denied',
        reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
      }),
    );
  });

  test('audits malformed persisted user evidence without trusting its identifier', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const evidence = await runtime.accessStore.loadEvidence(
      PLAYWRIGHT_MEMBER_SUBJECT,
    );
    if (evidence.user === null) {
      throw new Error('Synthetic member user evidence is unavailable.');
    }
    const user = evidence.user;
    const subjectDigest = '9'.repeat(64);
    const decision = await checkAccessGate(
      {
        googleSubject: PLAYWRIGHT_MEMBER_SUBJECT,
        email: 'member@psd401.net',
        displayName: 'Synthetic Member',
        subjectDigest,
        requestId: randomUUID(),
        checkedAt: new Date().toISOString(),
        source: 'web',
      },
      {
        store: {
          async loadEvidence() {
            return {
              ...evidence,
              user: { ...user, id: 'malformed-user-id' },
            };
          },
        },
        audit: runtime.auditSink,
      },
    );
    expect(decision).toEqual({
      granted: false,
      reasonCode: 'ACCESS_EVIDENCE_INVALID',
    });
    expect(runtime.auditEntries).toHaveLength(1);
    expect(runtime.auditEntries[0]).toMatchObject({
      category: 'access-denial',
      outcome: 'denied',
      principal: { kind: 'unauthenticated', subjectDigest },
      target: null,
      reasonCode: 'ACCESS_EVIDENCE_INVALID',
    });
  });

  test('ignores legacy group-source audit chronology when exact source sets match', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const evidence = await runtime.accessStore.loadEvidence(
      PLAYWRIGHT_MEMBER_SUBJECT,
    );
    if (evidence.snapshot === null) {
      throw new Error('Synthetic access snapshot is unavailable.');
    }
    const decision = await checkAccessGate(
      {
        googleSubject: PLAYWRIGHT_MEMBER_SUBJECT,
        email: 'member@psd401.net',
        displayName: 'Synthetic Member',
        subjectDigest: '1'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date().toISOString(),
        source: 'web',
      },
      {
        store: {
          async loadEvidence() {
            return {
              ...evidence,
              latestSuccessfulGroupSourceUpdateAt:
                evidence.snapshot?.syncStartedAt ?? null,
            };
          },
        },
        audit: runtime.auditSink,
      },
    );
    expect(decision.granted).toBe(true);
    expect(runtime.auditEntries).toEqual([]);
  });

  test('denies and truthfully audits a mobile non-member without session issuance', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const decision = await checkAccessGate(
      {
        googleSubject: 'mock-google-subject-nonmember',
        email: 'nonmember@psd401.net',
        displayName: 'Synthetic Nonmember',
        subjectDigest: 'a'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date().toISOString(),
        source: 'mobile',
      },
      { store: runtime.accessStore, audit: runtime.auditSink },
    );
    expect(decision).toEqual({
      granted: false,
      reasonCode: 'ACCESS_GROUP_MEMBERSHIP_REQUIRED',
    });
    expect(runtime.auditEntries).toHaveLength(1);
    expect(runtime.auditEntries[0]).toMatchObject({
      category: 'access-denial',
      outcome: 'denied',
      source: 'mobile',
      principal: { kind: 'unauthenticated', subjectDigest: 'a'.repeat(64) },
    });
  });

  test('does not let an unevaluated email bypass exact group membership', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const memberEvidence = await runtime.accessStore.loadEvidence(
      PLAYWRIGHT_MEMBER_SUBJECT,
    );
    const decision = await checkAccessGate(
      {
        googleSubject: 'configured-but-unknown-subject',
        email: 'unknown@psd401.net',
        displayName: 'Synthetic Unknown',
        subjectDigest: 'b'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date().toISOString(),
        source: 'web',
      },
      {
        store: {
          async loadEvidence() {
            return {
              ...memberEvidence,
              user: null,
              snapshot:
                memberEvidence.snapshot === null
                  ? null
                  : {
                      ...memberEvidence.snapshot,
                      evaluatedMember: null,
                      member: null,
                    },
            };
          },
        },
        audit: runtime.auditSink,
      },
    );
    expect(decision).toEqual({
      granted: false,
      reasonCode: 'ACCESS_GROUP_MEMBERSHIP_REQUIRED',
    });
    expect(runtime.auditEntries).toHaveLength(1);
  });

  test('grants exact-group admin only inside canonical Group-gated issuance', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const checkedAt = new Date().toISOString();
    const access = await checkAccessGate(
      {
        googleSubject: PLAYWRIGHT_MEMBER_SUBJECT,
        email: 'member@psd401.net',
        displayName: 'Synthetic Member',
        subjectDigest: 'c'.repeat(64),
        requestId: randomUUID(),
        checkedAt,
        source: 'web',
      },
      {
        store: runtime.accessStore,
        audit: runtime.auditSink,
      },
    );
    if (!access.granted) {
      throw new Error('Synthetic access member was unexpectedly denied.');
    }
    expect(access.user.roles).toEqual(['staff']);
    expect(access.bootstrapAdminEligible).toBe(true);

    const input: CompleteOidcSignInInput = {
      claims: {
        issuer: GOOGLE_ISSUER,
        audience: CLIENT_ID,
        subject: PLAYWRIGHT_MEMBER_SUBJECT,
        subjectDigest: 'c'.repeat(64),
        claimsDigest: 'd'.repeat(64),
        hostedDomain: HOSTED_DOMAIN,
        email: 'member@psd401.net',
        emailVerified: true,
        displayName: 'Synthetic Member',
      },
      device: {
        platform: 'web',
        unlockMethod: 'secure-session-cookie',
        installationId: 'web.synthetic-installation-id',
      },
    };
    let persisted: PersistInitialWebSessionRequest | undefined;
    const requestId = randomUUID();
    const responseDigest = 'e'.repeat(64);
    const envelope = createSyntheticSignInEnvelope(
      input,
      requestId,
      checkedAt,
      responseDigest,
    );
    const capturingStore: InitialWebSessionStore = {
      async persist(request) {
        persisted = request;
        return runtime.sessionStore.persist(request);
      },
    };
    let cookie: WebSessionCookie | undefined;
    const context: CompleteOidcSignInContext = {
      authorization: {
        user: access.user,
        membershipSnapshot: {
          id: access.membership.snapshotId,
          version: access.membership.snapshotVersion,
          complete: true,
          syncStartedAt: access.membership.syncStartedAt,
          capturedAt: access.membership.capturedAt,
        },
        membershipMember: {
          userId: access.user.id,
          googleSubject: access.user.googleSubject,
          accessGroupSourceRefs: access.membership.accessGroupSourceRefs,
          facilityScope: access.user.facilityScope,
        },
        grantBootstrapAdmin: access.bootstrapAdminEligible,
      },
      cookieSink: {
        set(value) {
          expect(runtime.auditEntries).toContainEqual(
            expect.objectContaining({
              category: 'sign-in',
              outcome: 'success',
              requestId,
            }),
          );
          cookie = value;
        },
      },
      envelope,
      responseDigest,
    };
    const result = await executeCapability(
      createCompleteOidcSignInHandler({
        store: capturingStore,
        policy: SESSION_POLICY,
      }),
      input,
      {
        context,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: createCompleteOidcSignInAuthorizer({
          policy: SESSION_POLICY,
        }),
      },
    );

    expect(result.user.roles).toEqual(['staff', 'admin']);
    expect(result.session.authorization).toMatchObject({
      source: 'google-group-snapshot',
      membershipSnapshotId: access.membership.snapshotId,
    });
    expect(cookie).toMatchObject({
      name: '__Host-psd-eoc-session',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    if (persisted === undefined || cookie === undefined) {
      throw new Error('Canonical sign-in evidence was not captured.');
    }
    expect(persisted.credentialDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(cookie.value).not.toBe(persisted.credentialDigest);
    expect(digestWebSessionCredential(cookie.value)).toBe(
      persisted.credentialDigest,
    );
    expect(persisted.requestId).toBe(requestId);
    expect(runtime.auditEntries).toContainEqual(
      expect.objectContaining({
        category: 'sign-in',
        outcome: 'success',
        requestId,
        principal: expect.objectContaining({
          kind: 'human',
          sessionId: result.session.id,
          userId: result.user.id,
        }),
      }),
    );

    const auditCount = runtime.auditEntries.length;
    await expect(
      executeCapability(
        createCompleteOidcSignInHandler({
          store: runtime.sessionStore,
          policy: SESSION_POLICY,
        }),
        input,
        {
          context,
          humanActionResolutionContext: null,
          safetyResolver: null,
          authorizer: createCompleteOidcSignInAuthorizer({
            policy: SESSION_POLICY,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_REPLAY_REJECTED' });
    expect(runtime.auditEntries).toHaveLength(auditCount);
  });
});
