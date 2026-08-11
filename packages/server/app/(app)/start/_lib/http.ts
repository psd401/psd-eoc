import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  CreateActivationPreviewInputSchema,
  IdempotencyKeySchema,
  JoinEventInputSchema,
  StartEventInputSchema,
  type ApiErrorCode,
  type CapabilityInput,
  type StartEventInput,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { authenticateSessionRequest } from '../../../../lib/auth/middleware';
import {
  getDefaultSessionService,
  SessionAccessError,
  type AuthenticatedSession,
  type SessionService,
} from '../../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  resolveHumanCapabilityInvocation,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import { getDefaultEventCapabilityRuntime } from '../../../../lib/capabilities/events';
import { getDefaultStartFlowCapabilityRuntime } from './capabilities';
import {
  getDefaultStartConfirmationRuntime,
  type IssueStartConfirmationInput,
  type StartConfirmationReceipt,
} from './confirmation';

export const START_FLOW_IDEMPOTENCY_HEADER = 'idempotency-key' as const;
export const START_FLOW_CONFIRMATION_HEADER = 'human-confirmation-id' as const;

const JSON_MEDIA_TYPE = 'application/json';
const MAX_START_FLOW_REQUEST_BODY_BYTES = 16 * 1_024;
const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization, Cookie',
});

type ActivationPreviewStartInput = Extract<
  StartEventInput,
  Readonly<{ source: 'activation-preview' }>
>;
type StartEventCapabilityId = 'join-event' | 'start-event';

/** Testable route seam; production still authenticates every POST itself. */
export interface StartFlowRouteRuntime {
  createRequestId(): string;
  now(): Date;
  authenticate(request: Request, now: Date): Promise<AuthenticatedSession>;
  issueConfirmation(
    input: IssueStartConfirmationInput,
  ): Promise<StartConfirmationReceipt>;
  executePreview(
    input: CapabilityInput<'create-activation-preview'>,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
  executeEvent(
    capabilityId: StartEventCapabilityId,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
}

/**
 * Authenticates the web-only transport. POST, same-origin, and double-submit
 * CSRF verification are performed before any body can cause work.
 */
export async function authenticateStartFlowWebRequest(
  request: Request,
  sessions: SessionService,
  now: Date,
): Promise<AuthenticatedSession> {
  if (request.method !== 'POST') {
    throw new SyntaxError('The start flow requires POST.');
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

/** Production adapters; all domain operations use canonical capabilities. */
export function getDefaultStartFlowRouteRuntime(): StartFlowRouteRuntime {
  const sessions = getDefaultSessionService();
  const previewCapabilities = getDefaultStartFlowCapabilityRuntime();
  const eventCapabilities = getDefaultEventCapabilityRuntime();
  const confirmations = getDefaultStartConfirmationRuntime();
  return Object.freeze({
    createRequestId: randomUUID,
    now: () => new Date(),
    authenticate: (request: Request, now: Date) =>
      authenticateStartFlowWebRequest(request, sessions, now),
    issueConfirmation: (input: IssueStartConfirmationInput) =>
      confirmations.issue(input),
    executePreview: (
      input: CapabilityInput<'create-activation-preview'>,
      invocation: TrustedCapabilityInvocation,
    ) =>
      previewCapabilities.execute(
        'create-activation-preview',
        input,
        invocation,
      ),
    executeEvent: (
      capabilityId: StartEventCapabilityId,
      input: unknown,
      invocation: TrustedCapabilityInvocation,
    ) => eventCapabilities.execute(capabilityId, input, invocation),
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

/** Maps only bounded public-safe failures into the canonical API envelope. */
export function startFlowApiErrorResponse(
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
      ? 'The start-flow request is invalid.'
      : 'The start-flow request failed.');

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
    throw new SyntaxError('This route does not accept query parameters.');
  }
}

function assertNoClientConfirmation(request: Request): void {
  if (request.headers.has(START_FLOW_CONFIRMATION_HEADER)) {
    throw new SyntaxError(
      'Human confirmation metadata cannot be supplied by the client.',
    );
  }
}

function parseMutationIdempotencyKey(request: Request): string {
  return IdempotencyKeySchema.parse(
    request.headers.get(START_FLOW_IDEMPOTENCY_HEADER) ?? '',
  );
}

function assertPreviewHasNoMutationHeaders(request: Request): void {
  if (
    request.headers.has(START_FLOW_IDEMPOTENCY_HEADER) ||
    request.headers.has(START_FLOW_CONFIRMATION_HEADER)
  ) {
    throw new SyntaxError(
      'Consequence preview requests cannot carry mutation metadata.',
    );
  }
}

function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get('content-type');
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new SyntaxError('Start-flow requests require JSON content.');
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
      Number(contentLength) > MAX_START_FLOW_REQUEST_BODY_BYTES)
  ) {
    throw new SyntaxError('The start-flow request body is too large.');
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
      if (byteLength > MAX_START_FLOW_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SyntaxError('The start-flow request body is too large.');
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
    throw new SyntaxError('The start-flow request body is not valid UTF-8.');
  }
  if (text.trim().length === 0) {
    throw new SyntaxError('The start-flow request body is required.');
  }
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('The start-flow request body must be an object.');
  }
  return value as Record<string, unknown>;
}

function queryInvocation(
  authenticated: AuthenticatedSession,
  requestId: string,
  serverTime: Date,
): TrustedCapabilityInvocation {
  return resolveHumanCapabilityInvocation(authenticated, {
    requestId,
    serverTime,
    mutation: null,
  });
}

function mutationInvocation(
  authenticated: AuthenticatedSession,
  requestId: string,
  serverTime: Date,
  idempotencyKey: string,
  humanConfirmationId: string | null,
): TrustedCapabilityInvocation {
  return resolveHumanCapabilityInvocation(authenticated, {
    requestId,
    serverTime,
    mutation: { idempotencyKey, humanConfirmationId },
  });
}

function confirmedExecutionTime(receipt: StartConfirmationReceipt): Date {
  const issuedAt = receipt.confirmationIssuedAt.getTime();
  const executionTime = receipt.executionTime.getTime();
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(executionTime) ||
    executionTime < issuedAt
  ) {
    throw new CapabilityEngineError(
      'LIVE_ACTION_UNAVAILABLE',
      'CONFIRMATION_INVALID',
      'The confirmed activation time is unavailable.',
      503,
      true,
    );
  }
  return new Date(executionTime);
}

async function routeContext(
  request: Request,
  runtimeValue: StartFlowRouteRuntime | undefined,
) {
  const runtime = runtimeValue ?? getDefaultStartFlowRouteRuntime();
  const requestId = runtime.createRequestId();
  const serverTime = runtime.now();
  const authenticated = await runtime.authenticate(request, serverTime);
  return { authenticated, requestId, runtime, serverTime } as const;
}

export async function handleCreateActivationPreview(
  request: Request,
  runtime?: StartFlowRouteRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const context = await routeContext(request, runtime);
    requestId = context.requestId;
    assertNoQueryParameters(request);
    assertPreviewHasNoMutationHeaders(request);
    const input = CreateActivationPreviewInputSchema.parse(
      await readJsonObject(request),
    );
    const result = await context.runtime.executePreview(
      input,
      queryInvocation(
        context.authenticated,
        context.requestId,
        context.serverTime,
      ),
    );
    return successResponse(result);
  } catch (error) {
    return startFlowApiErrorResponse(error, requestId);
  }
}

export async function handleActivateEvent(
  request: Request,
  runtime?: StartFlowRouteRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const context = await routeContext(request, runtime);
    requestId = context.requestId;
    assertNoQueryParameters(request);
    assertNoClientConfirmation(request);
    const idempotencyKey = parseMutationIdempotencyKey(request);
    const parsedInput = StartEventInputSchema.parse(
      await readJsonObject(request),
    );
    if (parsedInput.source !== 'activation-preview') {
      throw new SyntaxError(
        'The browser start flow requires an activation preview.',
      );
    }
    const startInput: ActivationPreviewStartInput = parsedInput;
    const confirmation = await context.runtime.issueConfirmation({
      authenticated: context.authenticated,
      idempotencyKey,
      startInput,
    });
    const executionTime = confirmedExecutionTime(confirmation);
    const result = await context.runtime.executeEvent(
      'start-event',
      startInput,
      mutationInvocation(
        context.authenticated,
        context.requestId,
        executionTime,
        idempotencyKey,
        confirmation.confirmationId,
      ),
    );
    return successResponse(result);
  } catch (error) {
    return startFlowApiErrorResponse(error, requestId);
  }
}

export async function handleJoinExistingEvent(
  request: Request,
  runtime?: StartFlowRouteRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const context = await routeContext(request, runtime);
    requestId = context.requestId;
    assertNoQueryParameters(request);
    assertNoClientConfirmation(request);
    const idempotencyKey = parseMutationIdempotencyKey(request);
    const input = JoinEventInputSchema.parse(await readJsonObject(request));
    const result = await context.runtime.executeEvent(
      'join-event',
      input,
      mutationInvocation(
        context.authenticated,
        context.requestId,
        context.serverTime,
        idempotencyKey,
        null,
      ),
    );
    return successResponse(result);
  } catch (error) {
    return startFlowApiErrorResponse(error, requestId);
  }
}
