import { describe, expect, test } from 'bun:test';

import type { CapabilityOutput } from '@psd-eoc/contracts';

import type { TrustedCapabilityInvocation } from '../../../../lib/capabilities/engine';
import { CapabilityEngineError } from '../../../../lib/capabilities/engine';
import { SessionAccessError } from '../../../../lib/auth/sessions';
import type { MediaCapabilityId } from '../../../../lib/media/capabilities';
import {
  handleCompleteMediaUpload,
  handleCreateMediaUploadIntent,
  handleGetMediaReadGrant,
  MEDIA_IDEMPOTENCY_KEY_HEADER,
  type MediaRouteInvocationRequest,
  type MediaRouteRuntime,
} from './http';

const ids = {
  user: '00000000-0000-4000-8000-000000000801',
  session: '00000000-0000-4000-8000-000000000802',
  epoch: '00000000-0000-4000-8000-000000000803',
  request: '00000000-0000-4000-8000-000000000804',
  event: '00000000-0000-4000-8000-000000000805',
  media: '00000000-0000-4000-8000-000000000806',
  uploadIntent: '00000000-0000-4000-8000-000000000807',
} as const;

const now = new Date('2026-08-10T18:00:00.000Z');
const idempotencyKey = 'media-route-idempotency-0001';
const contentSha256 = 'a'.repeat(64);

const createInput = Object.freeze({
  eventId: ids.event,
  byteLength: 2_048,
  contentSha256,
  declaredContentType: 'image/jpeg' as const,
});

const capabilityOutputs = Object.freeze({
  'create-media-upload-intent': {
    id: ids.uploadIntent,
    eventId: ids.event,
    byteLength: createInput.byteLength,
    contentSha256,
    declaredContentType: 'image/jpeg',
    uploadMethod: 'PUT',
    uploadUrl: 'https://media.example.test/private-upload',
    status: 'pending-upload',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1_000).toISOString(),
  },
  'complete-media-upload': {
    id: ids.media,
    uploadIntentId: ids.uploadIntent,
    eventId: ids.event,
    status: 'ready',
    detectedContentType: 'image/jpeg',
    sanitizedByteLength: 1_024,
    sanitizedContentSha256: 'b'.repeat(64),
    malwareScan: 'clean',
    exifStripped: true,
    createdAt: now.toISOString(),
  },
  'get-media-read-grant': {
    eventId: ids.event,
    mediaId: ids.media,
    readUrl: 'https://media.example.test/private-read',
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 1_000).toISOString(),
  },
} satisfies Record<MediaCapabilityId, unknown>);

interface ExecutionCall {
  readonly capabilityId: MediaCapabilityId;
  readonly input: unknown;
  readonly invocation: TrustedCapabilityInvocation;
}

interface InvocationCall {
  readonly request: Request;
  readonly input: MediaRouteInvocationRequest;
}

interface TestRuntimeOptions {
  readonly executeError?: unknown;
  readonly resolveError?: unknown;
}

function testRuntime(options: TestRuntimeOptions = {}) {
  const executions: ExecutionCall[] = [];
  const invocationCalls: InvocationCall[] = [];
  const runtime: MediaRouteRuntime = {
    createRequestId: () => ids.request,
    now: () => now,
    async resolveInvocation(request, input) {
      invocationCalls.push({ request, input });
      if (options.resolveError !== undefined) {
        throw options.resolveError;
      }
      const invocation: TrustedCapabilityInvocation = {
        actor: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.session,
        },
        source: 'web',
        scope: { facilityScope: { kind: 'district' } },
        requestId: input.requestId,
        serverTime: input.serverTime,
        connectivityEpochId: ids.epoch,
        mutation:
          input.mutation === null
            ? null
            : {
                idempotencyKey: input.mutation.idempotencyKey,
                humanConfirmationId: null,
                transport: {
                  kind: 'web-interactive',
                  method: 'POST',
                  interaction: 'explicit-user-submit',
                  csrfVerified: true,
                },
              },
      };
      return Object.freeze(invocation);
    },
    async execute<Id extends MediaCapabilityId>(
      capabilityId: Id,
      input: unknown,
      invocation: TrustedCapabilityInvocation,
    ): Promise<CapabilityOutput<Id>> {
      executions.push({ capabilityId, input, invocation });
      if (options.executeError !== undefined) {
        throw options.executeError;
      }
      return capabilityOutputs[capabilityId] as CapabilityOutput<Id>;
    },
  };
  return { executions, invocationCalls, runtime };
}

function mutationRequest(
  path: string,
  body: BodyInit | null,
  contentType = 'application/json; charset=utf-8',
): Request {
  const headers = new Headers({
    [MEDIA_IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
    'x-psd-eoc-csrf': 'synthetic-csrf-token',
    cookie: '__Host-psd-eoc-csrf=synthetic-csrf-token',
  });
  if (contentType.length > 0) {
    headers.set('content-type', contentType);
  }
  return new Request(`https://eoc.example.test${path}`, {
    method: 'POST',
    headers,
    body,
  });
}

function createRequest(
  body: unknown = createInput,
  contentType = 'application/json; charset=utf-8',
): Request {
  return mutationRequest(
    '/api/media/upload-intents',
    typeof body === 'string'
      ? body
      : body instanceof Uint8Array
        ? Uint8Array.from(body).buffer
        : JSON.stringify(body),
    contentType,
  );
}

function completionRequest(suffix = '', body: BodyInit | null = null): Request {
  return mutationRequest(
    `/api/media/upload-intents/${ids.uploadIntent}/complete${suffix}`,
    body,
    '',
  );
}

function expectPrivateResponseHeaders(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, private');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('vary')).toBe('Authorization, Cookie');
}

async function expectSafeValidationError(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expectPrivateResponseHeaders(response);
  expect(await response.json()).toEqual({
    code: 'VALIDATION_ERROR',
    message: 'The media request is invalid.',
    requestId: ids.request,
    retryable: false,
    fieldErrors: [],
  });
}

describe('media REST helper boundary', () => {
  test('authenticates and forwards a strict upload-intent mutation with CSRF-ready trusted facts', async () => {
    const { executions, invocationCalls, runtime } = testRuntime();
    const request = createRequest();
    const response = await handleCreateMediaUploadIntent(request, runtime);

    expect(response.status).toBe(200);
    expectPrivateResponseHeaders(response);
    expect(await response.json()).toEqual(
      capabilityOutputs['create-media-upload-intent'],
    );
    expect(invocationCalls).toEqual([
      {
        request,
        input: {
          requestId: ids.request,
          serverTime: now,
          mutation: { idempotencyKey },
        },
      },
    ]);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      capabilityId: 'create-media-upload-intent',
      input: createInput,
      invocation: {
        actor: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.session,
        },
        source: 'web',
        requestId: ids.request,
        serverTime: now,
        connectivityEpochId: ids.epoch,
        mutation: {
          idempotencyKey,
          humanConfirmationId: null,
          transport: {
            kind: 'web-interactive',
            method: 'POST',
            interaction: 'explicit-user-submit',
            csrfVerified: true,
          },
        },
      },
    });
  });

  test('completes an upload only with a bodyless mutation', async () => {
    const accepted = testRuntime();
    const response = await handleCompleteMediaUpload(
      completionRequest(),
      ids.uploadIntent,
      accepted.runtime,
    );

    expect(response.status).toBe(200);
    expectPrivateResponseHeaders(response);
    expect(await response.json()).toEqual(
      capabilityOutputs['complete-media-upload'],
    );
    expect(accepted.invocationCalls[0]?.input.mutation).toEqual({
      idempotencyKey,
    });
    expect(accepted.executions[0]).toMatchObject({
      capabilityId: 'complete-media-upload',
      input: { uploadIntentId: ids.uploadIntent },
      invocation: {
        mutation: {
          idempotencyKey,
          humanConfirmationId: null,
          transport: { csrfVerified: true },
        },
      },
    });

    const rejected = testRuntime();
    const rejectedResponse = await handleCompleteMediaUpload(
      completionRequest('', '{}'),
      ids.uploadIntent,
      rejected.runtime,
    );
    await expectSafeValidationError(rejectedResponse);
    expect(rejected.invocationCalls).toHaveLength(1);
    expect(rejected.executions).toHaveLength(0);
  });

  test('authorizes each private read request and forwards only canonical path IDs', async () => {
    const { executions, invocationCalls, runtime } = testRuntime();
    const request = new Request(
      `https://eoc.example.test/api/media/events/${ids.event}/${ids.media}/read-grant`,
      { headers: { authorization: 'Bearer synthetic-session-token' } },
    );
    const response = await handleGetMediaReadGrant(
      request,
      ids.event,
      ids.media,
      runtime,
    );

    expect(response.status).toBe(200);
    expectPrivateResponseHeaders(response);
    expect(await response.json()).toEqual(
      capabilityOutputs['get-media-read-grant'],
    );
    expect(invocationCalls).toEqual([
      {
        request,
        input: {
          requestId: ids.request,
          serverTime: now,
          mutation: null,
        },
      },
    ]);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      capabilityId: 'get-media-read-grant',
      input: { eventId: ids.event, mediaId: ids.media },
      invocation: {
        actor: { kind: 'human', userId: ids.user },
        mutation: null,
      },
    });
  });

  test('rejects missing or malformed mutation idempotency before authentication or execution', async () => {
    for (const headerValue of [null, 'too-short', 'invalid key spaces']) {
      const { executions, invocationCalls, runtime } = testRuntime();
      const request = createRequest();
      if (headerValue === null) {
        request.headers.delete(MEDIA_IDEMPOTENCY_KEY_HEADER);
      } else {
        request.headers.set(MEDIA_IDEMPOTENCY_KEY_HEADER, headerValue);
      }

      const response = await handleCreateMediaUploadIntent(request, runtime);

      await expectSafeValidationError(response);
      expect(invocationCalls).toHaveLength(0);
      expect(executions).toHaveLength(0);
    }
  });

  test('authenticates before parsing upload metadata and never executes malformed input', async () => {
    const unauthenticated = testRuntime({
      resolveError: new SessionAccessError(
        'INVALID_CREDENTIAL',
        'A valid session is required.',
      ),
    });
    const request = createRequest('{ definitely-not-json');
    const response = await handleCreateMediaUploadIntent(
      request,
      unauthenticated.runtime,
    );

    expect(response.status).toBe(401);
    expectPrivateResponseHeaders(response);
    expect(await response.json()).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'A valid session is required.',
      requestId: ids.request,
      retryable: false,
      fieldErrors: [],
    });
    expect(unauthenticated.invocationCalls).toHaveLength(1);
    expect(unauthenticated.executions).toHaveLength(0);
  });

  const invalidCreateCases = [
    {
      name: 'an unsupported disguised filename field',
      request: () =>
        createRequest({ ...createInput, filename: 'payload.exe.jpg' }),
    },
    {
      name: 'a non-image declared content type',
      request: () =>
        createRequest({
          ...createInput,
          declaredContentType: 'application/pdf',
        }),
    },
    {
      name: 'an image byte length over the canonical limit',
      request: () =>
        createRequest({ ...createInput, byteLength: 25 * 1_024 * 1_024 + 1 }),
    },
    {
      name: 'a transport body over the four-KiB parser bound',
      request: () =>
        createRequest(`${JSON.stringify(createInput)}${' '.repeat(4_096)}`),
    },
    {
      name: 'malformed JSON',
      request: () => createRequest('{"eventId":'),
    },
    {
      name: 'a JSON array instead of an object',
      request: () => createRequest([]),
    },
    {
      name: 'an absent body',
      request: () =>
        mutationRequest('/api/media/upload-intents', null, 'application/json'),
    },
    {
      name: 'a non-JSON content type',
      request: () => createRequest(JSON.stringify(createInput), 'text/plain'),
    },
  ] as const;

  for (const invalidCase of invalidCreateCases) {
    test(`rejects ${invalidCase.name} with a bounded user-visible error`, async () => {
      const { executions, invocationCalls, runtime } = testRuntime();
      const response = await handleCreateMediaUploadIntent(
        invalidCase.request(),
        runtime,
      );

      await expectSafeValidationError(response);
      expect(invocationCalls).toHaveLength(1);
      expect(executions).toHaveLength(0);
    });
  }

  test('rejects invalid UTF-8 as malformed client input', async () => {
    const { executions, invocationCalls, runtime } = testRuntime();
    const response = await handleCreateMediaUploadIntent(
      createRequest(new Uint8Array([0xff, 0xfe, 0xfd])),
      runtime,
    );

    await expectSafeValidationError(response);
    expect(invocationCalls).toHaveLength(1);
    expect(executions).toHaveLength(0);
  });

  test('rejects query parameters on every media route', async () => {
    const create = testRuntime();
    const createResponse = await handleCreateMediaUploadIntent(
      mutationRequest(
        '/api/media/upload-intents?storageKey=attacker-selected',
        JSON.stringify(createInput),
      ),
      create.runtime,
    );
    await expectSafeValidationError(createResponse);
    expect(create.invocationCalls).toHaveLength(1);
    expect(create.executions).toHaveLength(0);

    const complete = testRuntime();
    const completeResponse = await handleCompleteMediaUpload(
      completionRequest('?eventId=attacker-selected'),
      ids.uploadIntent,
      complete.runtime,
    );
    await expectSafeValidationError(completeResponse);
    expect(complete.invocationCalls).toHaveLength(1);
    expect(complete.executions).toHaveLength(0);

    const read = testRuntime();
    const readResponse = await handleGetMediaReadGrant(
      new Request(
        `https://eoc.example.test/api/media/events/${ids.event}/${ids.media}/read-grant?download=public`,
      ),
      ids.event,
      ids.media,
      read.runtime,
    );
    await expectSafeValidationError(readResponse);
    expect(read.invocationCalls).toHaveLength(1);
    expect(read.executions).toHaveLength(0);
  });

  test('rejects idempotency metadata on private read queries', async () => {
    const { executions, invocationCalls, runtime } = testRuntime();
    const request = new Request(
      `https://eoc.example.test/api/media/events/${ids.event}/${ids.media}/read-grant`,
      { headers: { [MEDIA_IDEMPOTENCY_KEY_HEADER]: idempotencyKey } },
    );
    const response = await handleGetMediaReadGrant(
      request,
      ids.event,
      ids.media,
      runtime,
    );

    await expectSafeValidationError(response);
    expect(invocationCalls).toHaveLength(0);
    expect(executions).toHaveLength(0);
  });

  test('validates completion and read path IDs after authentication', async () => {
    const complete = testRuntime();
    const completeResponse = await handleCompleteMediaUpload(
      completionRequest(),
      'not-an-upload-intent-id',
      complete.runtime,
    );
    await expectSafeValidationError(completeResponse);
    expect(complete.invocationCalls).toHaveLength(1);
    expect(complete.executions).toHaveLength(0);

    for (const [eventId, mediaId] of [
      ['not-an-event-id', ids.media],
      [ids.event, 'not-a-media-id'],
    ] as const) {
      const read = testRuntime();
      const response = await handleGetMediaReadGrant(
        new Request(
          `https://eoc.example.test/api/media/events/${eventId}/${mediaId}/read-grant`,
        ),
        eventId,
        mediaId,
        read.runtime,
      );
      await expectSafeValidationError(response);
      expect(read.invocationCalls).toHaveLength(1);
      expect(read.executions).toHaveLength(0);
    }
  });

  test('maps engine, session, and provider failures without leaking internals', async () => {
    const forbidden = testRuntime({
      executeError: new CapabilityEngineError(
        'FORBIDDEN',
        'CAPABILITY_SCOPE_DENIED',
        'The requested photo is unavailable in this scope.',
        403,
      ),
    });
    const forbiddenResponse = await handleGetMediaReadGrant(
      new Request(
        `https://eoc.example.test/api/media/events/${ids.event}/${ids.media}/read-grant`,
      ),
      ids.event,
      ids.media,
      forbidden.runtime,
    );
    expect(forbiddenResponse.status).toBe(403);
    expectPrivateResponseHeaders(forbiddenResponse);
    const forbiddenJson = await forbiddenResponse.json();
    expect(forbiddenJson).toEqual({
      code: 'FORBIDDEN',
      message: 'The requested photo is unavailable in this scope.',
      requestId: ids.request,
      retryable: false,
      fieldErrors: [],
    });
    expect(JSON.stringify(forbiddenJson)).not.toContain(
      'CAPABILITY_SCOPE_DENIED',
    );

    const providerSecret =
      's3.us-west-2.amazonaws.com accessKey=synthetic-do-not-expose';
    const providerFailure = testRuntime({
      executeError: new Error(providerSecret),
    });
    const providerResponse = await handleCompleteMediaUpload(
      completionRequest(),
      ids.uploadIntent,
      providerFailure.runtime,
    );
    expect(providerResponse.status).toBe(500);
    expectPrivateResponseHeaders(providerResponse);
    const providerJson = await providerResponse.json();
    expect(providerJson).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'The media request failed safely.',
      requestId: ids.request,
      retryable: true,
      fieldErrors: [],
    });
    expect(JSON.stringify(providerJson)).not.toContain(providerSecret);
    expect(JSON.stringify(providerJson)).not.toContain('s3.us-west-2');
  });
});
