import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  IdempotencyKeySchema,
  type ApiErrorCode,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import {
  CapabilityEngineError,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import { SessionAccessError } from '../auth/sessions';

/**
 * Request handling shared by authenticated human REST routes.
 *
 * The device and SMS-consent routes were the same file with different nouns:
 * identical content-type checks, byte-bounded body reading, idempotency header
 * parsing, and error mapping, differing only in the words used in messages.
 * That noun is now an argument.
 */
export interface HumanRouteSubject {
  /** Names the surface in public error text, e.g. 'device' or 'SMS consent'. */
  readonly noun: string;
  /** Largest accepted request body. */
  readonly maxBodyBytes: number;
}

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;

const JSON_MEDIA_TYPE = 'application/json';

export const HUMAN_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Vary: 'Authorization, Cookie',
});

export class HumanRequestError extends SyntaxError {
  public constructor(
    public readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'HumanRequestError';
  }
}

export function apiCodeForStatus(status: number): ApiErrorCode {
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

/**
 * Maps a failure to a public error body that never echoes the request.
 *
 * A rejected body can hold a staff member's mobile number or a push token, and
 * the validation path is the one most likely to be logged or screenshotted.
 */
export function humanErrorResponse(
  error: unknown,
  requestId: string,
  subject: HumanRouteSubject,
): NextResponse {
  const engineError = error instanceof CapabilityEngineError ? error : null;
  const sessionError = error instanceof SessionAccessError ? error : null;
  const requestError = error instanceof HumanRequestError ? error : null;
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
          ? `The ${subject.noun} request is invalid.`
          : `The ${subject.noun} request failed.`),
      requestId,
      retryable: engineError?.retryable ?? status >= 500,
      fieldErrors: [],
    }),
    { status, headers: HUMAN_RESPONSE_HEADERS },
  );
}

function assertJsonContentType(
  request: Request,
  subject: HumanRouteSubject,
): void {
  if (request.headers.has('content-encoding')) {
    throw new HumanRequestError(
      415,
      `Compressed ${subject.noun} requests are not accepted.`,
    );
  }
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new HumanRequestError(
      415,
      `${subject.noun} mutations require JSON content.`,
    );
  }
}

/** Reads a JSON body, refusing anything past the subject's byte ceiling. */
export async function readBoundedJson(
  request: Request,
  subject: HumanRouteSubject,
): Promise<unknown> {
  assertJsonContentType(request, subject);
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^\d+$/u.test(declaredLength)) {
    throw new HumanRequestError(400, 'The content length is invalid.');
  }
  if (
    declaredLength !== null &&
    Number(declaredLength) > subject.maxBodyBytes
  ) {
    throw new HumanRequestError(
      413,
      `The ${subject.noun} request body is too large.`,
    );
  }
  if (request.body === null) {
    throw new HumanRequestError(
      400,
      `The ${subject.noun} request body is required.`,
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
      if (totalBytes > subject.maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HumanRequestError(
          413,
          `The ${subject.noun} request body is too large.`,
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
    throw new HumanRequestError(
      400,
      `The ${subject.noun} request body is not valid UTF-8.`,
    );
  }
  if (text.trim().length === 0) {
    throw new HumanRequestError(
      400,
      `The ${subject.noun} request body is required.`,
    );
  }
  return JSON.parse(text) as unknown;
}

export function parseMutationMetadata(
  request: Request,
): Readonly<{ idempotencyKey: string }> {
  return Object.freeze({
    idempotencyKey: IdempotencyKeySchema.parse(
      request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? '',
    ),
  });
}

export function assertQueryHasNoMutationHeaders(
  request: Request,
  subject: HumanRouteSubject,
): void {
  if (request.headers.has(IDEMPOTENCY_KEY_HEADER)) {
    throw new SyntaxError(
      `${subject.noun} queries cannot carry mutation metadata.`,
    );
  }
}

export interface HumanRouteInvocationRequest {
  readonly requestId: string;
  readonly serverTime: Date;
  readonly mutation: Readonly<{ idempotencyKey: string }> | null;
}

/** Test seam; production still derives the actor from session middleware. */
export interface HumanRouteRuntime<Id extends string> {
  readonly capabilities: {
    execute(
      capabilityId: Id,
      input: unknown,
      invocation: TrustedCapabilityInvocation,
    ): Promise<unknown>;
  };
  createRequestId(): string;
  now(): Date;
  resolveInvocation(
    request: Request,
    input: HumanRouteInvocationRequest,
  ): Promise<TrustedCapabilityInvocation>;
}

/** Runs one authenticated human capability behind a REST route. */
export async function executeHumanRoute<Id extends string>(
  request: Request,
  runtime: HumanRouteRuntime<Id>,
  capabilityId: Id,
  mutation: boolean,
  subject: HumanRouteSubject,
  loadInput: () => unknown | Promise<unknown>,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    requestId = runtime.createRequestId();
    const invocation = await runtime.resolveInvocation(request, {
      requestId,
      serverTime: runtime.now(),
      mutation: mutation ? parseMutationMetadata(request) : null,
    });
    if (!mutation) assertQueryHasNoMutationHeaders(request, subject);
    const result = await runtime.capabilities.execute(
      capabilityId,
      await loadInput(),
      invocation,
    );
    return NextResponse.json(result, { headers: HUMAN_RESPONSE_HEADERS });
  } catch (error) {
    return humanErrorResponse(error, requestId, subject);
  }
}
