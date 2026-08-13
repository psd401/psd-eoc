import { createHash, randomUUID } from 'node:crypto';

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const HOSTED_DOMAIN = 'psd401.net';
const MEMBER_SUBJECT = 'mock-google-subject-member';
const KEY_ID = 'issue-32-synthetic-google-key';
const MOBILE_STATE_PATTERN = /^m1\.[A-Za-z0-9_-]{43}$/u;
const PKCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CALLBACK_PATTERN = /^\/auth\/callback$/u;

export const MOBILE_MOCK_GOOGLE_MEMBER_LINK_LABEL =
  'Continue as access-group member';

interface PendingAuthorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

interface MobileMockGoogleIdpOptions {
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackOrigin: string;
}

export interface MobileMockGoogleIdp {
  readonly origin: string;
  stop(): void;
}

function exactQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== undefined ? values[0] : null;
}

export function isAcceptedMobileOidcState(
  value: string | null,
): value is string {
  return value !== null && MOBILE_STATE_PATTERN.test(value);
}

function isExactCallback(
  value: string | null,
  callbackOrigin: string,
): value is string {
  if (value === null) return false;
  let callback: URL;
  try {
    callback = new URL(value);
  } catch {
    return false;
  }
  return (
    callback.origin === callbackOrigin &&
    CALLBACK_PATTERN.test(callback.pathname) &&
    callback.search.length === 0 &&
    callback.hash.length === 0 &&
    callback.username.length === 0 &&
    callback.password.length === 0
  );
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function badRequest(): Response {
  return new Response('Invalid synthetic mobile OIDC request.', {
    status: 400,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function expectedCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'utf8').digest());
}

/** Starts a loopback-only provider that supports only PSD EOC's mobile flow. */
export async function createMobileMockGoogleIdp(
  options: MobileMockGoogleIdpOptions,
): Promise<MobileMockGoogleIdp> {
  const expectedOrigin = `http://${options.hostname}:${options.port}`;
  if (
    options.callbackOrigin !== options.callbackOrigin.trim() ||
    new URL(options.callbackOrigin).origin !== options.callbackOrigin ||
    !['127.0.0.1', 'localhost'].includes(
      new URL(options.callbackOrigin).hostname,
    ) ||
    !Number.isSafeInteger(options.port) ||
    options.port < 1_024 ||
    options.port > 65_535 ||
    options.clientId.length === 0 ||
    options.clientSecret.length === 0
  ) {
    throw new Error(
      'The synthetic mobile Google IdP configuration is invalid.',
    );
  }

  const pendingAuthorizations = new Map<string, PendingAuthorization>();
  const authorizationCodes = new Map<string, PendingAuthorization>();
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    alg: 'RS256',
    kid: KEY_ID,
    use: 'sig',
  };

  function authorizationPage(request: Request): Response {
    if (request.method !== 'GET') {
      return new Response(null, { status: 405 });
    }
    const url = new URL(request.url);
    const clientId = exactQueryValue(url, 'client_id');
    const redirectUri = exactQueryValue(url, 'redirect_uri');
    const state = exactQueryValue(url, 'state');
    const nonce = exactQueryValue(url, 'nonce');
    const codeChallenge = exactQueryValue(url, 'code_challenge');
    if (
      clientId !== options.clientId ||
      !isExactCallback(redirectUri, options.callbackOrigin) ||
      !isAcceptedMobileOidcState(state) ||
      nonce === null ||
      !PKCE_PATTERN.test(nonce) ||
      codeChallenge === null ||
      !PKCE_PATTERN.test(codeChallenge) ||
      exactQueryValue(url, 'response_type') !== 'code' ||
      exactQueryValue(url, 'code_challenge_method') !== 'S256' ||
      exactQueryValue(url, 'hd') !== HOSTED_DOMAIN
    ) {
      return badRequest();
    }

    const requestId = randomUUID();
    pendingAuthorizations.set(requestId, {
      clientId,
      redirectUri,
      state,
      nonce,
      codeChallenge,
    });
    const memberHref = `/authorize/complete?request_id=${requestId}&amp;identity=member`;
    return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Synthetic Google sign-in</title>
  </head>
  <body style="font-family: sans-serif; max-width: 36rem; margin: 4rem auto; padding: 1rem">
    <main>
      <h1>Synthetic Google sign-in</h1>
      <p>This issue #32 loopback provider makes no Google network calls.</p>
      <p><a href="${memberHref}">${MOBILE_MOCK_GOOGLE_MEMBER_LINK_LABEL}</a></p>
    </main>
  </body>
</html>`);
  }

  function completeAuthorization(request: Request): Response {
    if (request.method !== 'GET') {
      return new Response(null, { status: 405 });
    }
    const url = new URL(request.url);
    const requestId = exactQueryValue(url, 'request_id');
    if (requestId === null || exactQueryValue(url, 'identity') !== 'member') {
      return badRequest();
    }
    const pending = pendingAuthorizations.get(requestId);
    pendingAuthorizations.delete(requestId);
    if (pending === undefined) {
      return badRequest();
    }
    const code = randomUUID();
    authorizationCodes.set(code, pending);
    const callback = new URL(pending.redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', pending.state);
    return Response.redirect(callback, 302);
  }

  async function exchangeToken(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405 });
    }
    const contentType =
      request.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/x-www-form-urlencoded')) {
      return badRequest();
    }
    const form = new URLSearchParams(await request.text());
    const code = form.get('code');
    const authorization =
      code === null ? undefined : authorizationCodes.get(code);
    const verifier = form.get('code_verifier') ?? '';
    if (
      code === null ||
      authorization === undefined ||
      form.get('client_id') !== options.clientId ||
      form.get('client_secret') !== options.clientSecret ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('redirect_uri') !== authorization.redirectUri ||
      expectedCodeChallenge(verifier) !== authorization.codeChallenge
    ) {
      return Response.json(
        { error: 'invalid_grant' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    authorizationCodes.delete(code);
    const idToken = await new SignJWT({
      nonce: authorization.nonce,
      hd: HOSTED_DOMAIN,
      email: 'member@psd401.net',
      email_verified: true,
      name: 'Synthetic Issue 32 Member',
    })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(GOOGLE_ISSUER)
      .setAudience(authorization.clientId)
      .setSubject(MEMBER_SUBJECT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return Response.json(
      { id_token: idToken, token_type: 'Bearer', expires_in: 300 },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== expectedOrigin) return badRequest();
      switch (url.pathname) {
        case '/authorize':
          return authorizationPage(request);
        case '/authorize/complete':
          return completeAuthorization(request);
        case '/token':
          return exchangeToken(request);
        case '/jwks':
          return Response.json(
            { keys: [publicJwk] },
            { headers: { 'Cache-Control': 'no-store' } },
          );
        default:
          return new Response('Not found.', { status: 404 });
      }
    },
  });

  let stopped = false;
  return Object.freeze({
    origin: expectedOrigin,
    stop(): void {
      if (!stopped) {
        stopped = true;
        server.stop(true);
      }
    },
  });
}
