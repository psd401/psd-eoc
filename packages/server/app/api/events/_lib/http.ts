import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  GetEventInputSchema,
  HumanConfirmationIdSchema,
  IdempotencyKeySchema,
  JoinEventInputSchema,
  ListActiveEventsInputSchema,
  type ApiErrorCode,
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
  getDefaultEventCapabilityRuntime,
  type EventCapabilityRuntime,
} from '../../../../lib/capabilities/events';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;
export const HUMAN_CONFIRMATION_ID_HEADER = 'human-confirmation-id' as const;

const JSON_MEDIA_TYPE = 'application/json';
const DEFAULT_EVENT_PAGE_LIMIT = 50;
const MAX_EVENT_REQUEST_BODY_BYTES = 64 * 1_024;
const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Vary: 'Authorization, Cookie',
});

type EventRouteCapabilityId = Parameters<EventCapabilityRuntime['execute']>[0];

export interface EventRouteInvocationRequest {
  readonly requestId: string;
  readonly serverTime: Date;
  readonly mutation: Readonly<{
    idempotencyKey: string;
    humanConfirmationId: string | null;
  }> | null;
}

export interface EventRouteCapabilityExecutor {
  execute(
    capabilityId: EventRouteCapabilityId,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
}

/** Testable route seam; production still resolves every actor from a session. */
export interface EventRouteRuntime {
  readonly capabilities: EventRouteCapabilityExecutor;
  createRequestId(): string;
  now(): Date;
  resolveInvocation(
    request: Request,
    input: EventRouteInvocationRequest,
  ): Promise<TrustedCapabilityInvocation>;
}

/** Resolves the production session and capability runtimes without body trust. */
export function getDefaultEventRouteRuntime(): EventRouteRuntime {
  const sessions = getDefaultSessionService();
  const capabilities = getDefaultEventCapabilityRuntime();
  return Object.freeze({
    capabilities: {
      execute: (
        capabilityId: EventRouteCapabilityId,
        input: unknown,
        invocation: TrustedCapabilityInvocation,
      ) => capabilities.execute(capabilityId, input, invocation),
    },
    createRequestId: randomUUID,
    now: () => new Date(),
    async resolveInvocation(
      request: Request,
      input: EventRouteInvocationRequest,
    ) {
      const authenticated = await authenticateSessionRequest(
        request,
        sessions,
        { mutation: input.mutation !== null },
        input.serverTime,
      );
      return resolveHumanCapabilityInvocation(authenticated, input);
    },
  });
}

function apiCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
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

/** Maps only public-safe engine/session failures into the canonical API model. */
export function eventApiErrorResponse(
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
      ? 'The event request is invalid.'
      : 'The event request failed.');

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

function parseMutationHeaders(
  request: Request,
): EventRouteInvocationRequest['mutation'] {
  const idempotencyKey = IdempotencyKeySchema.parse(
    request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? '',
  );
  const confirmationHeader = request.headers.get(HUMAN_CONFIRMATION_ID_HEADER);
  const humanConfirmationId =
    confirmationHeader === null
      ? null
      : HumanConfirmationIdSchema.parse(confirmationHeader);
  return Object.freeze({ idempotencyKey, humanConfirmationId });
}

function assertQueryHasNoMutationHeaders(request: Request): void {
  if (
    request.headers.has(IDEMPOTENCY_KEY_HEADER) ||
    request.headers.has(HUMAN_CONFIRMATION_ID_HEADER)
  ) {
    throw new SyntaxError('Query requests cannot carry mutation metadata.');
  }
}

function assertNoQueryParameters(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new SyntaxError('This route does not accept query parameters.');
  }
}

function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get('content-type');
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new SyntaxError('Event mutations require JSON content.');
  }
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  assertJsonContentType(request);
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_EVENT_REQUEST_BODY_BYTES)
  ) {
    throw new SyntaxError('The event request body is too large.');
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (reader !== undefined) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_EVENT_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SyntaxError('The event request body is too large.');
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError('The event request body is not valid UTF-8.');
  }
  if (text.trim().length === 0) {
    return {};
  }
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('The event request body must be an object.');
  }
  return value as Record<string, unknown>;
}

function assertBodyHasNoFields(body: Readonly<Record<string, unknown>>): void {
  if (Object.keys(body).length > 0) {
    throw new SyntaxError('The event request contains unsupported fields.');
  }
}

function listEventsInput(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const allowed = new Set(['facilityId', 'cursor', 'limit']);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) {
      throw new SyntaxError('The event query parameters are invalid.');
    }
  }
  const limitValue = searchParams.get('limit');
  return ListActiveEventsInputSchema.parse({
    facilityId: searchParams.get('facilityId'),
    cursor: searchParams.get('cursor'),
    limit: limitValue === null ? DEFAULT_EVENT_PAGE_LIMIT : Number(limitValue),
  });
}

async function executeEventRoute(
  request: Request,
  runtime: EventRouteRuntime | undefined,
  capabilityId: EventRouteCapabilityId,
  mutation: boolean,
  loadInput: () => unknown | Promise<unknown>,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const resolvedRuntime = runtime ?? getDefaultEventRouteRuntime();
    requestId = resolvedRuntime.createRequestId();
    const serverTime = resolvedRuntime.now();
    let mutationMetadata: EventRouteInvocationRequest['mutation'];
    if (mutation) {
      mutationMetadata = parseMutationHeaders(request);
    } else {
      assertQueryHasNoMutationHeaders(request);
      mutationMetadata = null;
    }
    const invocation = await resolvedRuntime.resolveInvocation(request, {
      requestId,
      serverTime,
      mutation: mutationMetadata,
    });
    const input = await loadInput();
    return successResponse(
      await resolvedRuntime.capabilities.execute(
        capabilityId,
        input,
        invocation,
      ),
    );
  } catch (error) {
    return eventApiErrorResponse(error, requestId);
  }
}

export async function handleListEvents(
  request: Request,
  runtime?: EventRouteRuntime,
): Promise<NextResponse> {
  return executeEventRoute(request, runtime, 'list-active-events', false, () =>
    listEventsInput(request),
  );
}

export async function handleGetEvent(
  request: Request,
  eventId: string,
  runtime?: EventRouteRuntime,
): Promise<NextResponse> {
  return executeEventRoute(request, runtime, 'get-event', false, () => {
    assertNoQueryParameters(request);
    return GetEventInputSchema.parse({ eventId });
  });
}

export async function handleJoinEvent(
  request: Request,
  eventId: string,
  runtime?: EventRouteRuntime,
): Promise<NextResponse> {
  return executeEventRoute(request, runtime, 'join-event', true, async () => {
    assertNoQueryParameters(request);
    const body = await readJsonObject(request);
    assertBodyHasNoFields(body);
    return JoinEventInputSchema.parse({ eventId });
  });
}
