import {
  ApiErrorSchema,
  MobileOidcExchangeRequestSchema,
  MobileOidcStartRequestSchema,
  MobileOidcStartResponseSchema,
  MobileSessionResponseSchema,
  RevokeSessionInputSchema,
  SessionRevocationSchema,
  type MobileOidcExchangeRequest,
  type MobileOidcStartRequest,
  type MobileOidcStartResponse,
  type MobileSessionResponse,
} from '@psd-eoc/contracts';

import type { SessionApi } from './auth-controller';
import { MobileAuthError } from './auth-errors';

const REQUEST_TIMEOUT_MS = 8_000;

export type AuthFetch = (input: string, init: RequestInit) => Promise<Response>;

export function parseAuthApiBaseUrl(
  value: string | undefined,
  allowLoopbackHttp: boolean,
): string {
  if (value === undefined || value.trim().length === 0) {
    throw new MobileAuthError(
      'configuration',
      'PSD EOC sign-in is not configured for this build.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MobileAuthError(
      'configuration',
      'PSD EOC sign-in is not configured for this build.',
    );
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname);
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    (parsed.protocol !== 'https:' &&
      !(allowLoopbackHttp && loopback && parsed.protocol === 'http:'))
  ) {
    throw new MobileAuthError(
      'configuration',
      'PSD EOC sign-in is not configured for this build.',
    );
  }
  return parsed.origin;
}

/** Public policy served by the same tenant-configured origin as mobile auth. */
export function privacyPolicyUrl(
  value: string | undefined,
  allowLoopbackHttp: boolean,
): string {
  return `${parseAuthApiBaseUrl(value, allowLoopbackHttp)}/privacy`;
}

interface Schema<Output> {
  parse(value: unknown): Output;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.status === 401 || response.status === 403) {
      throw new MobileAuthError(
        'rejected',
        'This device session is no longer available.',
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new MobileAuthError(
        'offline',
        'PSD EOC cannot reach the server. Cached view only.',
      );
    }
    throw new MobileAuthError(
      'invalid-response',
      'PSD EOC received an invalid authentication response.',
    );
  }
}

function safeErrorMessage(value: unknown, fallback: string): string {
  const parsed = ApiErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.message : fallback;
}

export class AuthApiClient implements SessionApi {
  public constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImplementation: AuthFetch = fetch,
  ) {}

  private async post<Output>(
    path: string,
    body: unknown,
    schema: Schema<Output>,
    options: Readonly<{
      bearer?: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }> = {},
  ): Promise<Output> {
    const controller = new AbortController();
    const abortFromCaller = () => {
      controller.abort();
    };
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      };
      if (options.bearer !== undefined) {
        headers.Authorization = `Bearer ${options.bearer}`;
      }
      if (options.idempotencyKey !== undefined) {
        headers['Idempotency-Key'] = options.idempotencyKey;
      }
      const response = await this.fetchImplementation(
        `${this.baseUrl()}${path}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const value = await responseJson(response);
      if (!response.ok) {
        const fallback = 'PSD EOC authentication was not accepted.';
        const message = safeErrorMessage(value, fallback);
        if (response.status === 401 || response.status === 403) {
          throw new MobileAuthError('rejected', message);
        }
        if (response.status === 429 || response.status >= 500) {
          throw new MobileAuthError('offline', message);
        }
        throw new MobileAuthError('invalid-response', fallback);
      }
      try {
        return schema.parse(value);
      } catch {
        throw new MobileAuthError(
          'invalid-response',
          'PSD EOC received an invalid authentication response.',
        );
      }
    } catch (error) {
      if (error instanceof MobileAuthError) {
        throw error;
      }
      throw new MobileAuthError(
        'offline',
        'PSD EOC cannot reach the server. Cached view only.',
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  public startOidc(
    input: MobileOidcStartRequest,
  ): Promise<MobileOidcStartResponse> {
    return this.post(
      '/api/auth/mobile/oidc/start',
      MobileOidcStartRequestSchema.parse(input),
      MobileOidcStartResponseSchema,
    );
  }

  public exchangeOidc(
    input: MobileOidcExchangeRequest,
  ): Promise<MobileSessionResponse> {
    return this.post(
      '/api/auth/mobile/oidc/exchange',
      MobileOidcExchangeRequestSchema.parse(input),
      MobileSessionResponseSchema,
    );
  }

  public refresh(
    refreshToken: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<MobileSessionResponse> {
    return this.post('/api/auth/refresh', {}, MobileSessionResponseSchema, {
      bearer: refreshToken,
      idempotencyKey,
      signal,
    });
  }

  public async revoke(
    refreshToken: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const revocation = await this.post(
      '/api/auth/revoke',
      RevokeSessionInputSchema.parse({
        sessionId,
        reasonCode: 'USER_SIGN_OUT',
      }),
      SessionRevocationSchema,
      { bearer: refreshToken, idempotencyKey },
    );
    if (revocation.sessionId !== sessionId) {
      throw new MobileAuthError(
        'invalid-response',
        'PSD EOC received an invalid authentication response.',
      );
    }
  }
}
