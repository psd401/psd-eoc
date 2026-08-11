import {
  ApiErrorSchema,
  IdempotencyKeySchema,
  OpaqueSessionBearerSchema,
  type ApiError,
} from '@psd-eoc/contracts';

export type AuthenticatedMutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface JsonResponseSchema<Output> {
  parse(value: unknown): Output;
}

interface AuthenticatedRequestBase<Output> {
  readonly path: string;
  readonly schema: JsonResponseSchema<Output>;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The only request shape exposed to feature code. Transport controls are
 * deliberately absent so React callers cannot observe or override the bearer,
 * cookies, redirect policy, cache policy, or response object.
 */
export type AuthenticatedRequestOptions<Output> =
  | (AuthenticatedRequestBase<Output> &
      Readonly<{
        method: 'GET';
        body?: never;
        idempotencyKey?: never;
      }>)
  | (AuthenticatedRequestBase<Output> &
      Readonly<{
        method: AuthenticatedMutationMethod;
        body?: unknown;
        idempotencyKey: string;
      }>);

export type RequestAuthenticated = <Output>(
  request: AuthenticatedRequestOptions<Output>,
) => Promise<Output>;

export type AuthenticatedRequestFailureKind =
  | 'configuration'
  | 'invalid-request'
  | 'invalid-response'
  | 'network';

/** A bounded local failure that never exposes headers, credentials, or bodies. */
export class AuthenticatedRequestFailure extends Error {
  public constructor(
    public readonly kind: AuthenticatedRequestFailureKind,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AuthenticatedRequestFailure';
  }
}

/** A non-success HTTP response validated against the canonical API contract. */
export class AuthenticatedApiError extends Error {
  public constructor(
    public readonly apiError: ApiError,
    public readonly status: number,
  ) {
    super(apiError.message);
    this.name = 'AuthenticatedApiError';
  }
}

export interface AuthenticatedRequestTransport {
  request<Output>(
    bearer: string,
    request: AuthenticatedRequestOptions<Output>,
    signal: AbortSignal,
  ): Promise<Output>;
}

export type AuthenticatedFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const INVALID_REQUEST_MESSAGE =
  'PSD EOC blocked an invalid authenticated request before it was sent.';
const INVALID_RESPONSE_MESSAGE =
  'PSD EOC received an invalid authenticated response.';
const NETWORK_MESSAGE =
  'PSD EOC could not reach the server. Reconnect before trying again.';

function invalidRequest(): AuthenticatedRequestFailure {
  return new AuthenticatedRequestFailure(
    'invalid-request',
    INVALID_REQUEST_MESSAGE,
  );
}

function originOnly(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AuthenticatedRequestFailure(
      'configuration',
      'PSD EOC authenticated requests are not configured for this build.',
    );
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
  ) {
    throw new AuthenticatedRequestFailure(
      'configuration',
      'PSD EOC authenticated requests are not configured for this build.',
    );
  }
  return parsed;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function requestUrl(baseUrl: string, path: string): string {
  if (
    path.length === 0 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('#') ||
    containsControlCharacter(path)
  ) {
    throw invalidRequest();
  }

  const base = originOnly(baseUrl);
  let parsed: URL;
  try {
    parsed = new URL(path, base);
  } catch {
    throw invalidRequest();
  }
  if (
    parsed.origin !== base.origin ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw invalidRequest();
  }
  return parsed.toString();
}

function assertCallerCannotOverrideTransport(request: object): void {
  if (
    'headers' in request ||
    'credentials' in request ||
    'redirect' in request ||
    'cache' in request
  ) {
    throw invalidRequest();
  }
}

function assertMethodShape<Output>(
  request: AuthenticatedRequestOptions<Output>,
): void {
  if (request.method === 'GET') {
    if ('body' in request || 'idempotencyKey' in request) {
      throw invalidRequest();
    }
    return;
  }
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    throw invalidRequest();
  }
}

function serializeBody(body: unknown): string {
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) {
      throw invalidRequest();
    }
    return serialized;
  } catch (error) {
    if (error instanceof AuthenticatedRequestFailure) {
      throw error;
    }
    throw invalidRequest();
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AuthenticatedRequestFailure(
      'invalid-response',
      INVALID_RESPONSE_MESSAGE,
      response.status,
    );
  }
}

/**
 * Fetch adapter with a fixed transport policy. Only the auth controller calls
 * this class because it is the sole owner of an unlocked bearer.
 */
export class AuthenticatedApiClient implements AuthenticatedRequestTransport {
  public constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImplementation: AuthenticatedFetch = fetch,
  ) {}

  public async request<Output>(
    bearer: string,
    request: AuthenticatedRequestOptions<Output>,
    signal: AbortSignal,
  ): Promise<Output> {
    assertCallerCannotOverrideTransport(request);
    assertMethodShape(request);
    const url = requestUrl(this.baseUrl(), request.path);
    let authorization: string;
    try {
      authorization = `Bearer ${OpaqueSessionBearerSchema.parse(bearer)}`;
    } catch {
      throw new AuthenticatedRequestFailure(
        'configuration',
        'PSD EOC could not use the protected device credential.',
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authorization,
      'Cache-Control': 'no-store',
    };
    let body: string | undefined;
    if (request.method !== 'GET') {
      try {
        headers['Idempotency-Key'] = IdempotencyKeySchema.parse(
          request.idempotencyKey,
        );
      } catch {
        throw invalidRequest();
      }
      if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = serializeBody(request.body);
      }
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new AuthenticatedRequestFailure('network', NETWORK_MESSAGE);
    }

    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new AuthenticatedRequestFailure(
        'invalid-response',
        INVALID_RESPONSE_MESSAGE,
        response.status,
      );
    }

    const value = await readJson(response);
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(value);
      if (!parsed.success) {
        throw new AuthenticatedRequestFailure(
          'invalid-response',
          INVALID_RESPONSE_MESSAGE,
          response.status,
        );
      }
      throw new AuthenticatedApiError(parsed.data, response.status);
    }

    try {
      return request.schema.parse(value);
    } catch {
      throw new AuthenticatedRequestFailure(
        'invalid-response',
        INVALID_RESPONSE_MESSAGE,
        response.status,
      );
    }
  }
}
