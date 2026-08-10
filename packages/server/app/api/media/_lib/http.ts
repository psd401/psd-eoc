import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  CompleteMediaUploadInputSchema,
  CreateMediaUploadIntentInputSchema,
  GetMediaReadGrantInputSchema,
  IdempotencyKeySchema,
  UuidSchema,
  type ApiErrorCode,
  type CapabilityOutput,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { authenticateSessionRequest } from '../../../../lib/auth/middleware';
import {
  getDefaultSessionService,
  SessionAccessError,
} from '../../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  resolveHumanCapabilityInvocation,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  getDefaultMediaCapabilityRuntime,
  type MediaCapabilityId,
} from '../../../../lib/media/capabilities';

export const MEDIA_IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;

const JSON_MEDIA_TYPE = 'application/json';
const MAX_MEDIA_REQUEST_BODY_BYTES = 4 * 1_024;
const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Authorization, Cookie',
});

export interface MediaRouteInvocationRequest {
  readonly requestId: string;
  readonly serverTime: Date;
  readonly mutation: Readonly<{ idempotencyKey: string }> | null;
}

export interface MediaRouteRuntime {
  createRequestId(): string;
  now(): Date;
  resolveInvocation(
    request: Request,
    input: MediaRouteInvocationRequest,
  ): Promise<TrustedCapabilityInvocation>;
  execute<Id extends MediaCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
}

/** Production runtime: session facts are resolved server-side on every call. */
export function getDefaultMediaRouteRuntime(): MediaRouteRuntime {
  const sessions = getDefaultSessionService();
  const capabilities = getDefaultMediaCapabilityRuntime();
  const runtime: MediaRouteRuntime = {
    createRequestId: randomUUID,
    now: () => new Date(),
    async resolveInvocation(
      request: Request,
      input: MediaRouteInvocationRequest,
    ) {
      const authenticated = await authenticateSessionRequest(
        request,
        sessions,
        { mutation: input.mutation !== null },
        input.serverTime,
      );
      return resolveHumanCapabilityInvocation(authenticated, {
        requestId: input.requestId,
        serverTime: input.serverTime,
        mutation:
          input.mutation === null
            ? null
            : {
                idempotencyKey: input.mutation.idempotencyKey,
                humanConfirmationId: null,
              },
      });
    },
    execute: <Id extends MediaCapabilityId>(
      capabilityId: Id,
      input: unknown,
      invocation: TrustedCapabilityInvocation,
    ) => capabilities.execute(capabilityId, input, invocation),
  };
  return Object.freeze(runtime);
}

function apiCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 415:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

/** Returns only bounded, user-safe failures and never storage/provider text. */
export function mediaApiErrorResponse(
  error: unknown,
  requestId: string,
): NextResponse {
  const engineError = error instanceof CapabilityEngineError ? error : null;
  const sessionError = error instanceof SessionAccessError ? error : null;
  const validationError =
    error instanceof ZodError || error instanceof SyntaxError;
  const status = validationError
    ? 400
    : (engineError?.status ?? sessionError?.status ?? 500);
  const code = engineError?.code ?? apiCodeForStatus(status);
  const message =
    engineError?.message ??
    sessionError?.message ??
    (validationError
      ? 'The media request is invalid.'
      : 'The media request failed safely.');

  return NextResponse.json(
    ApiErrorSchema.parse({
      code,
      message,
      requestId,
      retryable: engineError?.retryable ?? status >= 500,
      fieldErrors: [],
    }),
    { status, headers: RESPONSE_HEADERS },
  );
}

function successResponse(result: unknown): NextResponse {
  return NextResponse.json(result, { headers: RESPONSE_HEADERS });
}

function assertNoQueryParameters(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new SyntaxError('Media routes do not accept query parameters.');
  }
}

function mutationMetadata(
  request: Request,
): MediaRouteInvocationRequest['mutation'] {
  return Object.freeze({
    idempotencyKey: IdempotencyKeySchema.parse(
      request.headers.get(MEDIA_IDEMPOTENCY_KEY_HEADER) ?? '',
    ),
  });
}

function assertQueryHasNoMutationMetadata(request: Request): void {
  if (request.headers.has(MEDIA_IDEMPOTENCY_KEY_HEADER)) {
    throw new SyntaxError('Media queries cannot carry mutation metadata.');
  }
}

async function readBoundedJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new SyntaxError('The media request must use application/json.');
  }
  const reader = request.body?.getReader();
  if (reader === undefined) {
    throw new SyntaxError('The media request body is required.');
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      byteLength += next.value.byteLength;
      if (byteLength > MAX_MEDIA_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new SyntaxError('The media request body is too large.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    );
  } catch {
    throw new SyntaxError('The media request body must use valid UTF-8.');
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError('The media request body must be an object.');
  }
  return parsed as Record<string, unknown>;
}

async function executeMediaRoute<Id extends MediaCapabilityId>(
  request: Request,
  runtime: MediaRouteRuntime | undefined,
  capabilityId: Id,
  mutation: boolean,
  loadInput: () => unknown | Promise<unknown>,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const resolvedRuntime = runtime ?? getDefaultMediaRouteRuntime();
    requestId = resolvedRuntime.createRequestId();
    const serverTime = resolvedRuntime.now();
    const metadata = mutation ? mutationMetadata(request) : null;
    if (!mutation) {
      assertQueryHasNoMutationMetadata(request);
    }
    const invocation = await resolvedRuntime.resolveInvocation(request, {
      requestId,
      serverTime,
      mutation: metadata,
    });
    const input = await loadInput();
    return successResponse(
      await resolvedRuntime.execute(capabilityId, input, invocation),
    );
  } catch (error) {
    return mediaApiErrorResponse(error, requestId);
  }
}

export async function handleCreateMediaUploadIntent(
  request: Request,
  runtime?: MediaRouteRuntime,
): Promise<NextResponse> {
  return executeMediaRoute(
    request,
    runtime,
    'create-media-upload-intent',
    true,
    async () => {
      assertNoQueryParameters(request);
      return CreateMediaUploadIntentInputSchema.parse(
        await readBoundedJsonObject(request),
      );
    },
  );
}

export async function handleCompleteMediaUpload(
  request: Request,
  uploadIntentId: string,
  runtime?: MediaRouteRuntime,
): Promise<NextResponse> {
  return executeMediaRoute(
    request,
    runtime,
    'complete-media-upload',
    true,
    () => {
      assertNoQueryParameters(request);
      if (request.body !== null) {
        throw new SyntaxError('Media completion does not accept a body.');
      }
      return CompleteMediaUploadInputSchema.parse({ uploadIntentId });
    },
  );
}

export async function handleGetMediaReadGrant(
  request: Request,
  eventId: string,
  mediaId: string,
  runtime?: MediaRouteRuntime,
): Promise<NextResponse> {
  return executeMediaRoute(
    request,
    runtime,
    'get-media-read-grant',
    false,
    () => {
      assertNoQueryParameters(request);
      return GetMediaReadGrantInputSchema.parse({
        eventId: UuidSchema.parse(eventId),
        mediaId: UuidSchema.parse(mediaId),
      });
    },
  );
}
