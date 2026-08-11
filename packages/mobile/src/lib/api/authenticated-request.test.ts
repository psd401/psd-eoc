import { describe, expect, test } from 'bun:test';

import {
  AuthenticatedApiClient,
  AuthenticatedApiError,
  AuthenticatedRequestFailure,
  type AuthenticatedFetch,
  type AuthenticatedRequestOptions,
  type JsonResponseSchema,
} from './authenticated-request';

const TEST_BEARER = 'a'.repeat(43);
const TEST_REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const TEST_IDEMPOTENCY_KEY = 'event-post-key-0001';

interface ParsedResult {
  readonly value: string;
}

const resultSchema: JsonResponseSchema<ParsedResult> = Object.freeze({
  parse(value: unknown): ParsedResult {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('value' in value) ||
      typeof value.value !== 'string'
    ) {
      throw new Error('invalid fixture');
    }
    return Object.freeze({ value: value.value });
  },
});

const canonicalError = Object.freeze({
  code: 'FORBIDDEN',
  message: 'This synthetic request is not permitted.',
  requestId: TEST_REQUEST_ID,
  retryable: false,
  fieldErrors: [],
});

function response(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

function getRequest(
  path = '/api/events/synthetic-event?after=cursor_1',
): AuthenticatedRequestOptions<ParsedResult> {
  return {
    method: 'GET',
    path,
    schema: resultSchema,
  };
}

describe('authenticated mobile request transport', () => {
  test('binds GET requests to the configured origin and fixes every sensitive fetch control', async () => {
    const captured: { input?: string; init?: RequestInit } = {};
    const fetchImplementation: AuthenticatedFetch = async (input, init) => {
      captured.input = input;
      captured.init = init;
      return response({ value: 'parsed' });
    };
    const client = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      fetchImplementation,
    );
    const controller = new AbortController();

    await expect(
      client.request(TEST_BEARER, getRequest(), controller.signal),
    ).resolves.toEqual({ value: 'parsed' });

    expect(captured.input).toBe(
      'https://eoc.synthetic.example/api/events/synthetic-event?after=cursor_1',
    );
    const init = captured.init;
    if (init === undefined) {
      throw new Error('Expected fetch request options.');
    }
    const headers = new Headers(init.headers);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBe(controller.signal);
    expect(init.body).toBeUndefined();
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${TEST_BEARER}`);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('content-type')).toBeNull();
  });

  test('serializes mutation JSON and validates the required idempotency key', async () => {
    let capturedInit: RequestInit | null = null;
    let fetchCount = 0;
    const client = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async (_input, init) => {
        fetchCount += 1;
        capturedInit = init;
        return response({ value: 'posted' });
      },
    );

    await expect(
      client.request(
        TEST_BEARER,
        {
          method: 'POST',
          path: '/api/events/synthetic-event/journal',
          idempotencyKey: TEST_IDEMPOTENCY_KEY,
          body: { kind: 'text', text: 'Synthetic update' },
          schema: resultSchema,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ value: 'posted' });
    expect(fetchCount).toBe(1);
    const init = capturedInit as unknown as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('idempotency-key')).toBe(TEST_IDEMPOTENCY_KEY);
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.body).toBe(
      JSON.stringify({ kind: 'text', text: 'Synthetic update' }),
    );

    await expect(
      client.request(
        TEST_BEARER,
        {
          method: 'POST',
          path: '/api/events/synthetic-event/journal',
          idempotencyKey: 'unsafe\r\nCookie:value',
          schema: resultSchema,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'AuthenticatedRequestFailure',
      kind: 'invalid-request',
    });
    expect(fetchCount).toBe(1);
  });

  test('rejects unsafe paths before fetch', async () => {
    let fetchCount = 0;
    const client = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => {
        fetchCount += 1;
        return response({ value: 'unexpected' });
      },
    );
    const unsafePaths = [
      'https://attacker.invalid/api/events',
      '//attacker.invalid/api/events',
      '//user:password@attacker.invalid/api/events',
      '/\\attacker.invalid/api/events',
      '/api/events#secret-fragment',
      'api/events',
      '',
    ];

    for (const path of unsafePaths) {
      await expect(
        client.request(
          TEST_BEARER,
          getRequest(path),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        name: 'AuthenticatedRequestFailure',
        kind: 'invalid-request',
      });
    }
    expect(fetchCount).toBe(0);
  });

  test('rejects embedded credentials in the configured origin', async () => {
    let fetchCount = 0;
    const client = new AuthenticatedApiClient(
      () => 'https://user:password@eoc.synthetic.example',
      async () => {
        fetchCount += 1;
        return response({ value: 'unexpected' });
      },
    );

    await expect(
      client.request(
        TEST_BEARER,
        getRequest('/api/events'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'AuthenticatedRequestFailure',
      kind: 'configuration',
    });
    expect(fetchCount).toBe(0);
  });

  test('forbids caller Authorization, Cookie, and fetch policy overrides at runtime', async () => {
    let fetchCount = 0;
    const client = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => {
        fetchCount += 1;
        return response({ value: 'unexpected' });
      },
    );
    const overrides: ReadonlyArray<Record<string, unknown>> = [
      { headers: { Authorization: 'Bearer caller-controlled' } },
      { headers: { Cookie: 'session=caller-controlled' } },
      { credentials: 'include' },
      { redirect: 'follow' },
      { cache: 'force-cache' },
    ];

    for (const override of overrides) {
      const unsafe = {
        ...getRequest('/api/events'),
        ...override,
      } as unknown as AuthenticatedRequestOptions<ParsedResult>;
      await expect(
        client.request(TEST_BEARER, unsafe, new AbortController().signal),
      ).rejects.toMatchObject({
        name: 'AuthenticatedRequestFailure',
        kind: 'invalid-request',
      });
    }
    expect(fetchCount).toBe(0);
  });

  test('rejects runtime attempts to attach a body to GET or use an unknown method', async () => {
    let fetchCount = 0;
    const client = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => {
        fetchCount += 1;
        return response({ value: 'unexpected' });
      },
    );
    const unsafeRequests = [
      {
        ...getRequest('/api/events'),
        body: { should: 'not send' },
      },
      {
        ...getRequest('/api/events'),
        idempotencyKey: TEST_IDEMPOTENCY_KEY,
      },
      {
        ...getRequest('/api/events'),
        method: 'TRACE',
        idempotencyKey: TEST_IDEMPOTENCY_KEY,
      },
    ];

    for (const unsafeRequest of unsafeRequests) {
      await expect(
        client.request(
          TEST_BEARER,
          unsafeRequest as unknown as AuthenticatedRequestOptions<ParsedResult>,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: 'invalid-request' });
    }
    expect(fetchCount).toBe(0);
  });

  test('returns only schema-parsed success values and rejects malformed success payloads', async () => {
    const client = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => response({ unexpected: true }),
    );

    await expect(
      client.request(
        TEST_BEARER,
        getRequest('/api/events'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'AuthenticatedRequestFailure',
      kind: 'invalid-response',
      status: 200,
    });
  });

  test('throws a canonical ApiError for non-success responses', async () => {
    const client = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => response(canonicalError, { status: 403 }),
    );

    try {
      await client.request(
        TEST_BEARER,
        getRequest('/api/events'),
        new AbortController().signal,
      );
      throw new Error('Expected a canonical API error.');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticatedApiError);
      const apiFailure = error as AuthenticatedApiError;
      expect(apiFailure.status).toBe(403);
      expect(apiFailure.apiError).toEqual(canonicalError);
      expect(apiFailure.message).toBe(canonicalError.message);
    }
  });

  test('rejects malformed error payloads and redirects without exposing a Response', async () => {
    const malformed = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => response({ provider: 'unsafe-detail' }, { status: 500 }),
    );
    await expect(
      malformed.request(
        TEST_BEARER,
        getRequest('/api/events'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'AuthenticatedRequestFailure',
      kind: 'invalid-response',
      status: 500,
    });

    const redirectedResponse = response({ value: 'unexpected' });
    Object.defineProperty(redirectedResponse, 'redirected', { value: true });
    const redirected = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => redirectedResponse,
    );
    await expect(
      redirected.request(
        TEST_BEARER,
        getRequest('/api/events'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'AuthenticatedRequestFailure',
      kind: 'invalid-response',
    });
  });

  test('maps provider failures to a bounded network error while preserving aborts', async () => {
    const unavailable = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => {
        throw new Error('provider detail must not escape');
      },
    );
    await expect(
      unavailable.request(
        TEST_BEARER,
        getRequest('/api/events'),
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      new AuthenticatedRequestFailure(
        'network',
        'PSD EOC could not reach the server. Reconnect before trying again.',
      ),
    );

    const caller = new AbortController();
    const abort = new Error('synthetic abort');
    caller.abort();
    const aborted = new AuthenticatedApiClient(
      () => 'https://eoc.synthetic.example',
      async () => {
        throw abort;
      },
    );
    await expect(
      aborted.request(TEST_BEARER, getRequest('/api/events'), caller.signal),
    ).rejects.toBe(abort);
  });
});
