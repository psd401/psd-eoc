import { createHash, randomUUID } from 'node:crypto';

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import {
  PLAYWRIGHT_MEMBER_SUBJECT,
  PLAYWRIGHT_NONMEMBER_SUBJECT,
} from './auth-test-runtime';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const HOSTED_DOMAIN = 'psd401.net';
const KEY_ID = 'synthetic-google-key';
const PORT = Number(process.env.MOCK_GOOGLE_OIDC_PORT ?? '4106');
const CLIENT_ID = process.env.GOOGLE_OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OIDC_CLIENT_SECRET;

if (
  !Number.isSafeInteger(PORT) ||
  PORT < 1_024 ||
  PORT > 65_535 ||
  CLIENT_ID === undefined ||
  CLIENT_SECRET === undefined
) {
  throw new Error('The synthetic Google IdP configuration is invalid.');
}

interface PendingAuthorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

interface AuthorizationCode extends PendingAuthorization {
  readonly identity: 'member' | 'nonmember';
}

const pendingAuthorizations = new Map<string, PendingAuthorization>();
const authorizationCodes = new Map<string, AuthorizationCode>();
const { privateKey, publicKey } = await generateKeyPair('RS256', {
  extractable: true,
});
const publicJwk: JWK = {
  ...(await exportJWK(publicKey)),
  alg: 'RS256',
  kid: KEY_ID,
  use: 'sig',
};

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
  return new Response('Invalid synthetic OIDC request.', {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function exactQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== undefined ? values[0] : null;
}

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
    clientId !== CLIENT_ID ||
    redirectUri === null ||
    state === null ||
    nonce === null ||
    codeChallenge === null ||
    exactQueryValue(url, 'response_type') !== 'code' ||
    exactQueryValue(url, 'code_challenge_method') !== 'S256' ||
    url.searchParams.has('hd') ||
    !/^https?:\/\/localhost:\d+\/auth\/callback$/u.test(redirectUri) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)
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
      <p>This local identity provider makes no Google network calls.</p>
      <p><a href="/authorize/complete?request_id=${requestId}&amp;identity=member">Continue as access-group member</a></p>
      <p><a href="/authorize/complete?request_id=${requestId}&amp;identity=nonmember">Continue as non-member</a></p>
    </main>
  </body>
</html>`);
}

async function completeAuthorization(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405 });
  }
  const url = new URL(request.url);
  const requestId = exactQueryValue(url, 'request_id');
  const identity = exactQueryValue(url, 'identity');
  if (
    typeof requestId !== 'string' ||
    (identity !== 'member' && identity !== 'nonmember')
  ) {
    return badRequest();
  }
  const pending = pendingAuthorizations.get(requestId);
  pendingAuthorizations.delete(requestId);
  if (pending === undefined) {
    return badRequest();
  }
  const code = randomUUID();
  authorizationCodes.set(code, { ...pending, identity });
  const callback = new URL(pending.redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', pending.state);
  return Response.redirect(callback, 302);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function expectedCodeChallenge(verifier: string): Promise<string> {
  return base64Url(createHash('sha256').update(verifier, 'utf8').digest());
}

async function exchangeToken(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405 });
  }
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    return badRequest();
  }
  const form = new URLSearchParams(await request.text());
  const code = form.get('code');
  if (code === null) {
    return badRequest();
  }
  const authorization = authorizationCodes.get(code);
  if (authorization === undefined) {
    return new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const verifier = form.get('code_verifier') ?? '';
  if (
    form.get('client_id') !== CLIENT_ID ||
    form.get('client_secret') !== CLIENT_SECRET ||
    form.get('grant_type') !== 'authorization_code' ||
    form.get('redirect_uri') !== authorization.redirectUri ||
    (await expectedCodeChallenge(verifier)) !== authorization.codeChallenge
  ) {
    return new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  authorizationCodes.delete(code);

  const member = authorization.identity === 'member';
  const idToken = await new SignJWT({
    nonce: authorization.nonce,
    hd: HOSTED_DOMAIN,
    email: member ? 'member@psd401.net' : 'nonmember@psd401.net',
    email_verified: true,
    name: member ? 'Synthetic Member' : 'Synthetic Non-member',
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
    .setIssuer(GOOGLE_ISSUER)
    .setAudience(authorization.clientId)
    .setSubject(
      member ? PLAYWRIGHT_MEMBER_SUBJECT : PLAYWRIGHT_NONMEMBER_SUBJECT,
    )
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  return new Response(
    JSON.stringify({
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 300,
    }),
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
    },
  );
}

const server = Bun.serve({
  hostname: 'localhost',
  port: PORT,
  async fetch(request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    switch (pathname) {
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

process.on('SIGTERM', () => server.stop(true));
