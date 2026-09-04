import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  IdempotencyKeySchema,
  ReadMySmsConsentInputSchema,
  RecordSmsConsentInputSchema,
  WithdrawSmsConsentInputSchema,
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
  getDefaultSmsConsentCapabilityRuntime,
  type SmsConsentCapabilityId,
  type SmsConsentCapabilityRuntime,
} from '../../../../lib/capabilities/sms-consent';

export const SMS_CONSENT_IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;

const JSON_MEDIA_TYPE = 'application/json';
// A consent body is a number, a date-shaped version, and a literal true. The
// generous device limit would only widen what a caller can make the server
// decode before it is rejected.
const MAX_SMS_CONSENT_REQUEST_BODY_BYTES = 2 * 1_024;
const HUMAN_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Vary: 'Authorization, Cookie',
});

export interface SmsConsentRouteInvocationRequest {
  readonly requestId: string;
  readonly serverTime: Date;
  readonly mutation: Readonly<{ idempotencyKey: string }> | null;
}

export interface SmsConsentRouteCapabilityExecutor {
  execute(
    capabilityId: SmsConsentCapabilityId,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
}

/** Test seam; production still derives the actor from session middleware. */
export interface SmsConsentRouteRuntime {
  readonly capabilities: SmsConsentRouteCapabilityExecutor;
  createRequestId(): string;
  now(): Date;
  resolveInvocation(
    request: Request,
    input: SmsConsentRouteInvocationRequest,
  ): Promise<TrustedCapabilityInvocation>;
}

export function getDefaultSmsConsentRouteRuntime(): SmsConsentRouteRuntime {
  const sessions = getDefaultSessionService();
  const capabilities: SmsConsentCapabilityRuntime =
    getDefaultSmsConsentCapabilityRuntime();
  return Object.freeze({
    capabilities: {
      execute: (
        capabilityId: SmsConsentCapabilityId,
        input: unknown,
        invocation: TrustedCapabilityInvocation,
      ) => capabilities.execute(capabilityId, input, invocation),
    },
    createRequestId: randomUUID,
    now: () => new Date(),
    async resolveInvocation(
      request: Request,
      input: SmsConsentRouteInvocationRequest,
    ) {
      const authenticated = await authenticateSessionRequest(
        request,
        sessions,
        { mutation: input.mutation !== null },
        input.serverTime,
      );
      return resolveHumanCapabilityInvocation(authenticated, {
        ...input,
        mutation:
          input.mutation === null
            ? null
            : {
                idempotencyKey: input.mutation.idempotencyKey,
                humanConfirmationId: null,
              },
      });
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
    case 413:
    case 415:
      return 'VALIDATION_ERROR';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

class SmsConsentRequestError extends SyntaxError {
  public constructor(
    public readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'SmsConsentRequestError';
  }
}

/**
 * Never echoes the submitted number.
 *
 * A validation failure is the one path most likely to be logged or shown, and a
 * rejected body still contains a real mobile number.
 */
function humanErrorResponse(error: unknown, requestId: string): NextResponse {
  const engineError = error instanceof CapabilityEngineError ? error : null;
  const sessionError = error instanceof SessionAccessError ? error : null;
  const requestError = error instanceof SmsConsentRequestError ? error : null;
  const validationError =
    error instanceof ZodError || error instanceof SyntaxError;
  const status =
    requestError?.status ??
    (validationError
      ? 400
      : (engineError?.status ?? sessionError?.status ?? 500));
  return NextResponse.json(
    ApiErrorSchema.parse({
      code: engineError?.code ?? apiCodeForStatus(status),
      message:
        engineError?.message ??
        sessionError?.message ??
        (validationError
          ? 'The SMS consent request is invalid.'
          : 'The SMS consent request failed.'),
      requestId,
      retryable: engineError?.retryable ?? status >= 500,
      fieldErrors: [],
    }),
    { status, headers: HUMAN_RESPONSE_HEADERS },
  );
}

function assertJsonContentType(request: Request): void {
  if (request.headers.has('content-encoding')) {
    throw new SmsConsentRequestError(
      415,
      'Compressed SMS consent requests are not accepted.',
    );
  }
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new SmsConsentRequestError(
      415,
      'SMS consent mutations require JSON content.',
    );
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  assertJsonContentType(request);
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^\d+$/u.test(declaredLength)) {
    throw new SmsConsentRequestError(400, 'The content length is invalid.');
  }
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_SMS_CONSENT_REQUEST_BODY_BYTES
  ) {
    throw new SmsConsentRequestError(
      413,
      'The SMS consent request body is too large.',
    );
  }
  if (request.body === null) {
    throw new SmsConsentRequestError(
      400,
      'The SMS consent request body is required.',
    );
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SMS_CONSENT_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SmsConsentRequestError(
          413,
          'The SMS consent request body is too large.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SmsConsentRequestError(
      400,
      'The SMS consent request body is not valid UTF-8.',
    );
  }
  if (text.trim().length === 0) {
    throw new SmsConsentRequestError(
      400,
      'The SMS consent request body is required.',
    );
  }
  return JSON.parse(text) as unknown;
}

function parseMutationMetadata(
  request: Request,
): SmsConsentRouteInvocationRequest['mutation'] {
  return Object.freeze({
    idempotencyKey: IdempotencyKeySchema.parse(
      request.headers.get(SMS_CONSENT_IDEMPOTENCY_KEY_HEADER) ?? '',
    ),
  });
}

function assertQueryHasNoMutationHeaders(request: Request): void {
  if (request.headers.has(SMS_CONSENT_IDEMPOTENCY_KEY_HEADER)) {
    throw new SyntaxError(
      'SMS consent queries cannot carry mutation metadata.',
    );
  }
}

function assertNoQueryParameters(request: Request): void {
  if (new URL(request.url).searchParams.size > 0) {
    throw new SyntaxError('The SMS consent request takes no query parameters.');
  }
}

async function executeSmsConsentRoute(
  request: Request,
  runtime: SmsConsentRouteRuntime | undefined,
  capabilityId: SmsConsentCapabilityId,
  mutation: boolean,
  loadInput: () => unknown | Promise<unknown>,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const resolvedRuntime = runtime ?? getDefaultSmsConsentRouteRuntime();
    requestId = resolvedRuntime.createRequestId();
    const invocation = await resolvedRuntime.resolveInvocation(request, {
      requestId,
      serverTime: resolvedRuntime.now(),
      mutation: mutation ? parseMutationMetadata(request) : null,
    });
    if (!mutation) assertQueryHasNoMutationHeaders(request);
    const result = await resolvedRuntime.capabilities.execute(
      capabilityId,
      await loadInput(),
      invocation,
    );
    return NextResponse.json(result, { headers: HUMAN_RESPONSE_HEADERS });
  } catch (error) {
    return humanErrorResponse(error, requestId);
  }
}

/** Reads the caller's own consent state; never another staff member's. */
export function handleReadMySmsConsent(
  request: Request,
  runtime?: SmsConsentRouteRuntime,
): Promise<NextResponse> {
  return executeSmsConsentRoute(
    request,
    runtime,
    'read-my-sms-consent',
    false,
    () => {
      assertNoQueryParameters(request);
      return ReadMySmsConsentInputSchema.parse({});
    },
  );
}

/** Records an affirmative consent for the authenticated caller. */
export function handleRecordSmsConsent(
  request: Request,
  runtime?: SmsConsentRouteRuntime,
): Promise<NextResponse> {
  return executeSmsConsentRoute(
    request,
    runtime,
    'record-sms-consent',
    true,
    async () =>
      RecordSmsConsentInputSchema.parse(await readBoundedJson(request)),
  );
}

/**
 * Withdraws the caller's live consent.
 *
 * The body is required and must be an empty object rather than absent, so a
 * withdrawal is always a deliberate JSON mutation carrying an idempotency key
 * and can never be triggered by a bare navigation.
 */
export function handleWithdrawSmsConsent(
  request: Request,
  runtime?: SmsConsentRouteRuntime,
): Promise<NextResponse> {
  return executeSmsConsentRoute(
    request,
    runtime,
    'withdraw-sms-consent',
    true,
    async () =>
      WithdrawSmsConsentInputSchema.parse(await readBoundedJson(request)),
  );
}
