import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  executeCapability,
  parseCapabilityEnvelopeFor,
  type CompleteOidcSignInInput,
} from '@psd-eoc/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import {
  checkAccessGate,
  readBootstrapAdminSubjects,
} from '../../lib/auth/access-gate';
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

const GOOGLE_ISSUER = 'https://accounts.google.com';
const CLIENT_ID = 'synthetic-unit.apps.googleusercontent.com';
const CLIENT_SECRET = 'synthetic-unit-client-secret';
const HOSTED_DOMAIN = 'psd401.net';
const COOKIE_SECRET = Buffer.alloc(32, 11).toString('base64url');
const SESSION_POLICY: Readonly<WebSessionPolicy> = Object.freeze({
  sessionLifetimeSeconds: 90 * 24 * 60 * 60,
  membershipTtlSeconds: 24 * 60 * 60,
  membershipGraceSeconds: 72 * 60 * 60,
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

describe('Google OIDC adapter', () => {
  test('starts exact hosted-domain code+S256 PKCE without a network call', async () => {
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
    expect(authorization.searchParams.get('hd')).toBe(HOSTED_DOMAIN);
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

  for (const variant of [
    'wrong-issuer',
    'wrong-audience',
    'wrong-domain',
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

  test('requires a snapshot begun after the latest successful group-source update', async () => {
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
    expect(decision).toEqual({
      granted: false,
      reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
    });
    expect(runtime.auditEntries).toContainEqual(
      expect.objectContaining({
        outcome: 'denied',
        reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
      }),
    );
  });

  test('denies and truthfully audits a mobile non-member without session issuance', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const decision = await checkAccessGate(
      {
        googleSubject: 'mock-google-subject-nonmember',
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

  test('does not let a configured bootstrap subject bypass membership', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const decision = await checkAccessGate(
      {
        googleSubject: 'configured-but-unknown-subject',
        subjectDigest: 'b'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date().toISOString(),
        source: 'web',
      },
      {
        store: runtime.accessStore,
        audit: runtime.auditSink,
        bootstrapAdminSubjects: new Set(['configured-but-unknown-subject']),
      },
    );
    expect(decision).toEqual({ granted: false, reasonCode: 'UNKNOWN_USER' });
    expect(runtime.auditEntries).toHaveLength(1);
  });

  test('grants bootstrap admin only inside canonical Group-gated issuance', async () => {
    const runtime = createPlaywrightAuthRuntime();
    const checkedAt = new Date().toISOString();
    const access = await checkAccessGate(
      {
        googleSubject: PLAYWRIGHT_MEMBER_SUBJECT,
        subjectDigest: 'c'.repeat(64),
        requestId: randomUUID(),
        checkedAt,
        source: 'web',
      },
      {
        store: runtime.accessStore,
        audit: runtime.auditSink,
        bootstrapAdminSubjects: readBootstrapAdminSubjects({
          PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS: PLAYWRIGHT_MEMBER_SUBJECT,
        }),
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
