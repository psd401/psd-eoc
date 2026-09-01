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
const REQUEST_TIMEOUT_MS = 8_000;

type RequestInterruption = 'caller' | 'timeout' | null;

interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly interruption: Promise<never>;
  readonly interruptedBy: () => RequestInterruption;
  readonly dispose: () => void;
}

function requestDeadline(callerSignal: AbortSignal): RequestDeadline {
  const controller = new AbortController();
  let interruptedBy: RequestInterruption = null;
  let interrupt: (reason: unknown) => void = () => {};
  const interruption = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
  const abortFromCaller = () => {
    if (interruptedBy !== null) {
      return;
    }
    interruptedBy = 'caller';
    controller.abort(callerSignal.reason);
    interrupt(callerSignal.reason);
  };

  if (callerSignal.aborted) {
    abortFromCaller();
  } else {
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => {
    if (interruptedBy !== null) {
      return;
    }
    interruptedBy = 'timeout';
    const failure = new AuthenticatedRequestFailure('network', NETWORK_MESSAGE);
    controller.abort(failure);
    interrupt(failure);
  }, REQUEST_TIMEOUT_MS);

  return {
    signal: controller.signal,
    interruption,
    interruptedBy: () => interruptedBy,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal.removeEventListener('abort', abortFromCaller);
    },
  };
}

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

async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
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
/** The reporting surface this client needs, kept narrow so tests can stand in. */
export interface ClientFailureReporter {
  report(
    input: Readonly<{
      kind: AuthenticatedRequestFailureKind | 'status';
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      status: number | null;
      requestId: string | null;
    }>,
  ): void;
}

export class AuthenticatedApiClient implements AuthenticatedRequestTransport {
  public constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImplementation: AuthenticatedFetch = fetch,
    /**
     * Reports failures the server cannot see. A request refused by the server
     * is already in its logs; one that never arrived is witnessed only here.
     */
    private readonly diagnostics: ClientFailureReporter | null = null,
  ) {}

  #reportFailure(
    request: AuthenticatedRequestOptions<unknown>,
    error: unknown,
  ): void {
    if (this.diagnostics === null) return;
    if (error instanceof AuthenticatedRequestFailure) {
      this.diagnostics.report({
        kind: error.kind,
        method: request.method,
        path: request.path,
        status: error.status,
        requestId: null,
      });
      return;
    }
    if (error instanceof AuthenticatedApiError) {
      this.diagnostics.report({
        kind: 'status',
        method: request.method,
        path: request.path,
        status: error.status,
        requestId: error.apiError.requestId,
      });
    }
  }

  public async request<Output>(
    bearer: string,
    request: AuthenticatedRequestOptions<Output>,
    signal: AbortSignal,
  ): Promise<Output> {
    if (signal.aborted) throw signal.reason;
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

    const deadline = requestDeadline(signal);
    const fetchAndParse = async (): Promise<Output> => {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: deadline.signal,
        });
      } catch (error) {
        if (deadline.interruptedBy() === 'caller') {
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

      const value = await readJson(response, deadline.signal);
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
      } catch (error) {
        // Keep why the body was unreadable. Discarding it left the event room
        // showing "temporarily unavailable" for a permanent schema mismatch.
        const failure = new AuthenticatedRequestFailure(
          'invalid-response',
          INVALID_RESPONSE_MESSAGE,
          response.status,
        );
        failure.cause = error;
        throw failure;
      }
    };

    try {
      return await Promise.race([fetchAndParse(), deadline.interruption]);
    } catch (error) {
      if (deadline.interruptedBy() === 'caller') {
        // The caller abandoned this request; that is not a failure to report.
        throw error;
      }
      if (deadline.interruptedBy() === 'timeout') {
        const timedOut = new AuthenticatedRequestFailure(
          'network',
          NETWORK_MESSAGE,
        );
        this.#reportFailure(request, timedOut);
        throw timedOut;
      }
      this.#reportFailure(request, error);
      throw error;
    } finally {
      deadline.dispose();
    }
  }
}
