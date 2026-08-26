import {
  connect,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type SecureClientSessionOptions,
} from 'node:http2';

import { importPKCS8, SignJWT } from 'jose';

import type { ApnsJwtSigner, ApnsJwtSigningInput } from './apns-credentials';
import type {
  ApnsHttp2Client,
  ApnsHttp2Request,
  ApnsHttp2Response,
} from './apns-transport';
import {
  FCM_MESSAGING_SCOPE,
  type FcmOAuthTokenRequest,
  type FcmOAuthTokenResult,
  type FcmOAuthTokenSource,
} from './fcm-credentials';

const GOOGLE_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1_024;
const DEFAULT_FCM_OAUTH_TIMEOUT_MILLISECONDS = 10_000;
const SERVICE_ACCOUNT_EMAIL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,253}@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/u;

export type FcmOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FcmOAuthTokenSourceErrorCode =
  | 'FCM_OAUTH_AUTHENTICATION_FAILED'
  | 'FCM_OAUTH_REQUEST_RETRYABLE'
  | 'FCM_OAUTH_RESPONSE_INVALID';

/** Safe OAuth failure metadata; it never reflects tokens or provider bodies. */
export class FcmOAuthTokenSourceError extends Error {
  public constructor(
    public readonly code: FcmOAuthTokenSourceErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('FCM OAuth token acquisition failed safely.');
    this.name = 'FcmOAuthTokenSourceError';
  }
}

type ApnsHttp2ConnectionFactory = (
  authority: string | URL,
  options: SecureClientSessionOptions,
) => ClientHttp2Session;

function boundedBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (size > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new TypeError('Provider response exceeded the safe bound.');
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function safeResponseHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string | undefined>> {
  const apnsId = headers['apns-id'];
  return Object.freeze({
    'apns-id': typeof apnsId === 'string' ? apnsId : undefined,
  });
}

/** Production APNs client pins the request's reviewed TLS/HTTP2 boundary. */
export class NodeApnsHttp2Client implements ApnsHttp2Client {
  public constructor(
    private readonly connectSession: ApnsHttp2ConnectionFactory = connect,
  ) {}

  public request(request: ApnsHttp2Request): Promise<ApnsHttp2Response> {
    return new Promise((resolve, reject) => {
      const safeFailure = () => new TypeError('APNs request did not complete.');
      if (request.signal.aborted) {
        reject(safeFailure());
        return;
      }
      let session: ClientHttp2Session;
      try {
        session = this.connectSession(request.origin, {
          ALPNProtocols: [request.tls.alpnProtocol],
          minVersion: request.tls.minimumVersion,
          servername: request.tls.servername,
        });
      } catch {
        reject(safeFailure());
        return;
      }
      let stream: ClientHttp2Stream;
      try {
        stream = session.request({
          ':method': request.method,
          ':path': request.path,
          ...request.headers,
        });
      } catch {
        try {
          session.destroy();
        } catch {
          // The connection never became usable; preserve the safe failure.
        }
        reject(safeFailure());
        return;
      }
      const chunks: Uint8Array[] = [];
      let responseBytes = 0;
      let status = 0;
      let responseHeaders: Readonly<Record<string, string | undefined>> = {};
      let settled = false;
      const cleanup = (destroy: boolean) => {
        request.signal.removeEventListener('abort', onAbort);
        session.removeListener('error', onSessionError);
        stream.removeListener('error', onStreamError);
        stream.removeListener('close', onStreamClose);
        stream.removeListener('response', onResponse);
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        try {
          if (destroy) {
            stream.destroy();
            session.destroy();
          } else {
            session.close();
          }
        } catch {
          try {
            stream.destroy();
          } catch {
            // Best effort after a provider-controlled stream failure.
          }
          try {
            session.destroy();
          } catch {
            // The safe result has already been selected.
          }
        }
      };
      const settleFailure = () => {
        if (settled) return;
        settled = true;
        cleanup(true);
        reject(safeFailure());
      };
      const onAbort = () => settleFailure();
      const onSessionError = () => settleFailure();
      const onStreamError = () => settleFailure();
      const onStreamClose = () => settleFailure();
      const onResponse = (headers: IncomingHttpHeaders) => {
        status = Number(headers[':status']);
        responseHeaders = safeResponseHeaders(headers);
      };
      const onData = (chunk: Uint8Array) => {
        if (settled) return;
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_PROVIDER_RESPONSE_BYTES) {
          settleFailure();
          return;
        }
        chunks.push(new Uint8Array(chunk));
      };
      const onEnd = () => {
        if (settled) return;
        try {
          const body = boundedBytes(chunks);
          settled = true;
          cleanup(false);
          resolve({
            status,
            headers: responseHeaders,
            body,
          });
        } catch {
          settleFailure();
        }
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      session.once('error', onSessionError);
      stream.once('error', onStreamError);
      stream.once('close', onStreamClose);
      stream.once('response', onResponse);
      stream.on('data', onData);
      stream.once('end', onEnd);
      try {
        stream.end(request.body);
      } catch {
        settleFailure();
      }
    });
  }
}

/** ES256 Apple signer; private key material never leaves this closure. */
export function createApnsJwtSigner(): ApnsJwtSigner {
  return async (input: ApnsJwtSigningInput): Promise<string> => {
    if (input.algorithm !== 'ES256') {
      throw new TypeError('APNs signing algorithm is invalid.');
    }
    const key = await importPKCS8(input.privateKey, 'ES256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: input.keyId })
      .setIssuer(input.teamId)
      .setIssuedAt(input.issuedAt)
      .sign(key);
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError();
  }
  if (response.body === null) throw new TypeError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TypeError();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The bounded reader has already rejected the response.
    }
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(boundedBytes(chunks)),
  ) as unknown;
}

/** Fixed-audience service-account exchange for short-lived FCM OAuth tokens. */
export function createFcmServiceAccountTokenSource(
  input: Readonly<{
    clientEmail: string;
    privateKey: string;
    fetch?: FcmOAuthFetch;
    clock?: () => number;
    timeoutMilliseconds?: number;
  }>,
): FcmOAuthTokenSource {
  if (!SERVICE_ACCOUNT_EMAIL_PATTERN.test(input.clientEmail)) {
    throw new TypeError('FCM service account identity is invalid.');
  }
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const clock = input.clock ?? Date.now;
  const timeoutMilliseconds =
    input.timeoutMilliseconds ?? DEFAULT_FCM_OAUTH_TIMEOUT_MILLISECONDS;
  if (
    typeof fetchImplementation !== 'function' ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 100 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new TypeError('FCM OAuth client configuration is invalid.');
  }
  return async (
    request: FcmOAuthTokenRequest,
  ): Promise<FcmOAuthTokenResult> => {
    if (request.scope !== FCM_MESSAGING_SCOPE) {
      throw new TypeError('FCM OAuth scope is invalid.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const issuedAt = Math.floor(clock() / 1_000);
      if (!Number.isSafeInteger(issuedAt)) throw new TypeError();
      let assertion: string;
      try {
        const key = await importPKCS8(input.privateKey, 'RS256');
        assertion = await new SignJWT({ scope: request.scope })
          .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
          .setIssuer(input.clientEmail)
          .setAudience(GOOGLE_OAUTH_TOKEN_ENDPOINT)
          .setIssuedAt(issuedAt)
          .setExpirationTime(issuedAt + 3_600)
          .sign(key);
      } catch {
        throw new FcmOAuthTokenSourceError(
          'FCM_OAUTH_AUTHENTICATION_FAILED',
          false,
        );
      }
      let response: Response;
      try {
        response = await fetchImplementation(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            assertion,
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          }).toString(),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw new FcmOAuthTokenSourceError('FCM_OAUTH_REQUEST_RETRYABLE', true);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        throw new FcmOAuthTokenSourceError(
          retryable
            ? 'FCM_OAUTH_REQUEST_RETRYABLE'
            : 'FCM_OAUTH_AUTHENTICATION_FAILED',
          retryable,
          response.status,
        );
      }
      let value: unknown;
      try {
        value = await readBoundedJson(response);
      } catch {
        throw new FcmOAuthTokenSourceError(
          'FCM_OAUTH_RESPONSE_INVALID',
          true,
          response.status,
        );
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new FcmOAuthTokenSourceError(
          'FCM_OAUTH_RESPONSE_INVALID',
          true,
          response.status,
        );
      }
      const record = value as Readonly<Record<string, unknown>>;
      if (
        typeof record.access_token !== 'string' ||
        record.token_type !== 'Bearer' ||
        !Number.isSafeInteger(record.expires_in) ||
        Number(record.expires_in) < 300 ||
        Number(record.expires_in) > 3_600
      ) {
        throw new FcmOAuthTokenSourceError(
          'FCM_OAUTH_RESPONSE_INVALID',
          true,
          response.status,
        );
      }
      return Object.freeze({
        accessToken: record.access_token,
        projectId: request.projectId,
        expiresAt: clock() + Number(record.expires_in) * 1_000,
      });
    } catch (error) {
      if (error instanceof FcmOAuthTokenSourceError) throw error;
      throw new FcmOAuthTokenSourceError(
        'FCM_OAUTH_AUTHENTICATION_FAILED',
        false,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}
