import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseCapabilityEnvelopeFor } from '@psd-eoc/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import {
  beginGoogleOidcSignIn,
  completeGoogleOidcCallback,
  createCompleteOidcSignInEnvelope,
  GoogleOidcCallbackError,
  GoogleOidcConfigurationError,
  readGoogleOidcConfiguration,
} from '../../lib/auth/oidc';
import { isRetryableSessionTransactionError } from '../../lib/auth/session-cookie';
const PLAYWRIGHT_MEMBER_SUBJECT = 'mock-google-subject-member' as const;
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
const HOSTED_DOMAIN = 'example.invalid';
const COOKIE_SECRET = Buffer.alloc(32, 11).toString('base64url');
const PRODUCTION_PROJECT_NUMBER = '000000000000';
const PRODUCTION_WEB_CLIENT_ID = `${PRODUCTION_PROJECT_NUMBER}-webclient.apps.googleusercontent.com`;
const PRODUCTION_IOS_CLIENT_ID = `${PRODUCTION_PROJECT_NUMBER}-iosclient.apps.googleusercontent.com`;
const PRODUCTION_CLIENT_SECRET = `GOCSPX-${'a'.repeat(32)}`;

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
    'PSD_EOC_IOS_BUNDLE_ID',
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
        iosBundleId: SYNTHETIC_IOS_BUNDLE_ID,
        iosClientId: PRODUCTION_IOS_CLIENT_ID,
        webClientId: PRODUCTION_WEB_CLIENT_ID,
      }),
    );
    Reflect.set(process.env, 'GOOGLE_OIDC_COOKIE_SECRET', COOKIE_SECRET);
    // The district this deployment serves, which the callback needs to build a
    // public redirect without trusting the App Runner listener URL.
    Reflect.set(
      process.env,
      'GOOGLE_OIDC_APPLICATION_ORIGIN',
      SYNTHETIC_APPLICATION_ORIGIN,
    );
    Reflect.set(
      process.env,
      'GOOGLE_OIDC_HOSTED_DOMAIN',
      SYNTHETIC_HOSTED_DOMAIN,
    );
    Reflect.set(process.env, 'PSD_EOC_IOS_BUNDLE_ID', SYNTHETIC_IOS_BUNDLE_ID);

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
      'https://eoc.example.invalid/denied?reason=callback',
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
    email: 'member@example.invalid',
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

const SYNTHETIC_APPLICATION_ORIGIN = 'https://eoc.example.invalid';
const SYNTHETIC_HOSTED_DOMAIN = 'example.invalid';
const SYNTHETIC_IOS_BUNDLE_ID = 'invalid.example.eoc';

function productionOidcEnvironment(
  oauthConfig: Readonly<Record<string, unknown>> = {
    clientId: PRODUCTION_WEB_CLIENT_ID,
    clientSecret: PRODUCTION_CLIENT_SECRET,
    iosBundleId: SYNTHETIC_IOS_BUNDLE_ID,
    iosClientId: PRODUCTION_IOS_CLIENT_ID,
    webClientId: PRODUCTION_WEB_CLIENT_ID,
  },
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    NODE_ENV: 'production',
    GOOGLE_OAUTH_CONFIG: JSON.stringify(oauthConfig),
    GOOGLE_OIDC_COOKIE_SECRET: COOKIE_SECRET,
    // A synthetic district, not this one. The values below used to be written
    // into source; a suite that supplies them proves they are configuration.
    GOOGLE_OIDC_APPLICATION_ORIGIN: SYNTHETIC_APPLICATION_ORIGIN,
    GOOGLE_OIDC_HOSTED_DOMAIN: SYNTHETIC_HOSTED_DOMAIN,
    PSD_EOC_IOS_BUNDLE_ID: SYNTHETIC_IOS_BUNDLE_ID,
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
        `https://eoc.example.invalid/auth/sign-in?returnTo=${encodeURIComponent(exactDestination)}`,
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
    expect(
      returnToFromRequestUrl('https://eoc.example.invalid/auth/sign-in'),
    ).toBe('/');
    expect(
      returnToFromRequestUrl(
        'https://eoc.example.invalid/auth/sign-in?returnTo=%2Fstart&returnTo=%2Fevents',
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
      redirectUri: 'https://eoc.example.invalid/auth/callback',
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
      iosBundleId: SYNTHETIC_IOS_BUNDLE_ID,
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
      ['wrong iOS bundle', { ...valid, iosBundleId: 'invalid.example.other' }],
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
      // The origin and hosted domain are configuration now, so they are not
      // here; their near-miss spellings still are.
      'GOOGLE_OIDC_ORIGIN',
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
      email: 'member@example.invalid',
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
        GOOGLE_OIDC_REDIRECT_URI: 'https://eoc.example.invalid/auth/callback',
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
            GOOGLE_OIDC_REDIRECT_URI:
              'https://eoc.example.invalid/auth/callback',
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
});
