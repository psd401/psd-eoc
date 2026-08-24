import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  CreateDeliveryTestPreviewInputSchema,
  CreateDeliveryTestTargetSetVersionInputSchema,
  IdempotencyKeySchema,
  RecordDeliveryTestCanaryEligibilityInputSchema,
  type ApiErrorCode,
  type CapabilityInput,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { authenticateSessionRequest } from '../../../lib/auth/middleware';
import {
  getDefaultSessionService,
  SessionAccessError,
  type AuthenticatedSession,
  type SessionService,
} from '../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  resolveHumanCapabilityInvocation,
  type TrustedCapabilityInvocation,
} from '../../../lib/capabilities/engine';
import { getDefaultStartFlowCapabilityRuntime } from '../../../lib/capabilities/start';
import {
  executeCreateDeliveryTestTargetSetVersion,
  executeRecordDeliveryTestCanaryEligibility,
  type CreateDeliveryTestTargetSetVersionExecution,
  type RecordDeliveryTestCanaryEligibilityExecution,
} from '../../../lib/capabilities/delivery-tests';

export const DELIVERY_TEST_IDEMPOTENCY_HEADER = 'idempotency-key' as const;

const JSON_MEDIA_TYPE = 'application/json';
const MAX_PREVIEW_BODY_BYTES = 16 * 1_024;
const MAX_ELIGIBILITY_BODY_BYTES = 32 * 1_024;
// A target version may contain the contract maximum of 12,000 opaque endpoint
// references. The transport remains bounded and never accepts destinations.
const MAX_TARGET_SET_BODY_BYTES = 8 * 1_024 * 1_024;
const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization, Cookie',
});

export interface DeliveryTestWebRuntime {
  createRequestId(): string;
  now(): Date;
  authenticate(request: Request, now: Date): Promise<AuthenticatedSession>;
  executePreview(
    input: CapabilityInput<'create-delivery-test-preview'>,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
  createTargetSetVersion(
    input: CreateDeliveryTestTargetSetVersionExecution,
  ): Promise<unknown>;
  recordCanaryEligibility(
    input: RecordDeliveryTestCanaryEligibilityExecution,
  ): Promise<unknown>;
}

/** Requires a browser session plus same-origin, double-submit CSRF evidence. */
export async function authenticateDeliveryTestWebRequest(
  request: Request,
  sessions: SessionService,
  now: Date,
): Promise<AuthenticatedSession> {
  if (request.method !== 'POST') {
    throw new SyntaxError('Delivery-test commands require POST.');
  }
  const authenticated = await authenticateSessionRequest(
    request,
    sessions,
    { mutation: true },
    now,
  );
  if (authenticated.source !== 'web') {
    throw new SessionAccessError(
      'FORBIDDEN',
      'This endpoint requires an authenticated browser session.',
    );
  }
  return authenticated;
}

/** Production adapters; every domain operation remains a canonical capability. */
export function getDefaultDeliveryTestWebRuntime(): DeliveryTestWebRuntime {
  const sessions = getDefaultSessionService();
  const previews = getDefaultStartFlowCapabilityRuntime();
  return Object.freeze({
    createRequestId: randomUUID,
    now: () => new Date(),
    authenticate: (request: Request, now: Date) =>
      authenticateDeliveryTestWebRequest(request, sessions, now),
    executePreview: (
      input: CapabilityInput<'create-delivery-test-preview'>,
      invocation: TrustedCapabilityInvocation,
    ) => previews.execute('create-delivery-test-preview', input, invocation),
    createTargetSetVersion: executeCreateDeliveryTestTargetSetVersion,
    recordCanaryEligibility: executeRecordDeliveryTestCanaryEligibility,
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

/** Maps bounded, public-safe capability/session failures into the API envelope. */
export function deliveryTestApiErrorResponse(
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
      ? 'The delivery-test request is invalid.'
      : 'The delivery-test request failed.');

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

function assertNoQueryParameters(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new SyntaxError('This route does not accept query parameters.');
  }
}

function assertNoClientConfirmation(request: Request): void {
  if (request.headers.has('human-confirmation-id')) {
    throw new SyntaxError(
      'Human confirmation metadata cannot be supplied by the client.',
    );
  }
}

function assertJsonContentType(request: Request): void {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new SyntaxError('Delivery-test requests require JSON content.');
  }
}

export async function readDeliveryTestJsonObject(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  assertJsonContentType(request);
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new SyntaxError('The delivery-test request body is too large.');
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (reader !== undefined) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SyntaxError('The delivery-test request body is too large.');
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
    throw new SyntaxError('The delivery-test request body is not valid UTF-8.');
  }
  if (text.trim().length === 0) {
    throw new SyntaxError('The delivery-test request body is required.');
  }
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('The delivery-test request body must be an object.');
  }
  return value as Record<string, unknown>;
}

async function routeContext(
  request: Request,
  runtimeValue: DeliveryTestWebRuntime | undefined,
) {
  const runtime = runtimeValue ?? getDefaultDeliveryTestWebRuntime();
  const requestId = runtime.createRequestId();
  const now = runtime.now();
  const authenticated = await runtime.authenticate(request, now);
  return { authenticated, now, requestId, runtime } as const;
}

function successResponse(result: unknown): NextResponse {
  return NextResponse.json(result, { headers: RESPONSE_HEADERS });
}

export async function handleCreateDeliveryTestPreview(
  request: Request,
  runtime?: DeliveryTestWebRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const context = await routeContext(request, runtime);
    requestId = context.requestId;
    assertNoQueryParameters(request);
    assertNoClientConfirmation(request);
    if (request.headers.has(DELIVERY_TEST_IDEMPOTENCY_HEADER)) {
      throw new SyntaxError(
        'Consequence preview requests cannot carry mutation metadata.',
      );
    }
    const input = CreateDeliveryTestPreviewInputSchema.parse(
      await readDeliveryTestJsonObject(request, MAX_PREVIEW_BODY_BYTES),
    );
    const result = await context.runtime.executePreview(
      input,
      resolveHumanCapabilityInvocation(context.authenticated, {
        requestId: context.requestId,
        serverTime: context.now,
        mutation: null,
      }),
    );
    return successResponse(result);
  } catch (error) {
    return deliveryTestApiErrorResponse(error, requestId);
  }
}

export async function handleCreateDeliveryTestTargetSetVersion(
  request: Request,
  runtime?: DeliveryTestWebRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const context = await routeContext(request, runtime);
    requestId = context.requestId;
    assertNoQueryParameters(request);
    assertNoClientConfirmation(request);
    const idempotencyKey = IdempotencyKeySchema.parse(
      request.headers.get(DELIVERY_TEST_IDEMPOTENCY_HEADER) ?? '',
    );
    const command = CreateDeliveryTestTargetSetVersionInputSchema.parse(
      await readDeliveryTestJsonObject(request, MAX_TARGET_SET_BODY_BYTES),
    );
    const result = await context.runtime.createTargetSetVersion({
      authenticated: context.authenticated,
      command,
      metadata: {
        idempotencyKey,
        requestId: context.requestId,
        now: context.now,
      },
    });
    return successResponse(result);
  } catch (error) {
    return deliveryTestApiErrorResponse(error, requestId);
  }
}

export async function handleRecordDeliveryTestCanaryEligibility(
  request: Request,
  runtime?: DeliveryTestWebRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const context = await routeContext(request, runtime);
    requestId = context.requestId;
    assertNoQueryParameters(request);
    assertNoClientConfirmation(request);
    const idempotencyKey = IdempotencyKeySchema.parse(
      request.headers.get(DELIVERY_TEST_IDEMPOTENCY_HEADER) ?? '',
    );
    const command = RecordDeliveryTestCanaryEligibilityInputSchema.parse(
      await readDeliveryTestJsonObject(request, MAX_ELIGIBILITY_BODY_BYTES),
    );
    const result = await context.runtime.recordCanaryEligibility({
      authenticated: context.authenticated,
      command,
      metadata: {
        idempotencyKey,
        requestId: context.requestId,
        now: context.now,
      },
    });
    return successResponse(result);
  } catch (error) {
    return deliveryTestApiErrorResponse(error, requestId);
  }
}
