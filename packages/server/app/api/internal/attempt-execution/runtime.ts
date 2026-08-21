/**
 * The worker-facing side of the channel attempt execution lease.
 *
 * A channel worker holds no database credential. It reaches the application
 * over HTTPS with a bearer credential of its own, the way delivery-state
 * writeback already does, and this route is the only way it can claim, look up,
 * complete, or release the right to call a provider.
 *
 * The safety property is narrow and worth stating: nothing reachable here can
 * start, reactivate, all-clear, or close an event, and nothing here sends
 * anything to anybody. It hands out and takes back permission to make one
 * provider call for one already-authorized attempt.
 */
import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  AttemptExecutionStoreError,
  createDrizzleAttemptExecutionStore,
  type AttemptExecutionStore,
} from '../../../../lib/notify/attempt-execution-store';
import {
  createDatabaseClient,
  readDatabaseConfig,
} from '../../../../db/client';

/** Worker-only bearer; deliberately unrelated to any database secret. */
export const ATTEMPT_EXECUTION_WORKER_TOKEN_ENV =
  'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN' as const;
export const ATTEMPT_EXECUTION_MAX_BODY_BYTES = 32 * 1024;

const AttemptIdSchema = z.string().uuid();
const FingerprintSchema = z.string().trim().min(1).max(200);
const LeaseTokenSchema = z.string().uuid();

/**
 * The provider outcome is carried through without interpretation. What a send
 * result means belongs to the worker that produced it; this route stores it and
 * hands the same value back on replay.
 *
 * It must still be an object, because the store refuses to read back a
 * completion without one. Accepting on write what cannot be read is how a
 * durable record becomes unreadable long after the worker has moved on.
 */
const OutcomeSchema = z.object({}).passthrough();

const CompletionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('final'), outcome: OutcomeSchema }).strict(),
  z
    .object({
      kind: z.literal('retry'),
      outcome: OutcomeSchema,
      delayMilliseconds: z.number().int().nonnegative().max(86_400_000),
      nextAttemptNumber: z.number().int().positive().max(1_000),
      reasonCode: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

const AttemptExecutionRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('lookup'),
      attemptId: AttemptIdSchema,
      fingerprint: FingerprintSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('claim'),
      attemptId: AttemptIdSchema,
      fingerprint: FingerprintSchema,
      leaseMilliseconds: z
        .number()
        .int()
        .positive()
        .max(10 * 60 * 1_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('complete'),
      attemptId: AttemptIdSchema,
      fingerprint: FingerprintSchema,
      leaseToken: LeaseTokenSchema,
      completion: CompletionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('release'),
      attemptId: AttemptIdSchema,
      fingerprint: FingerprintSchema,
      leaseToken: LeaseTokenSchema,
    })
    .strict(),
]);

export type AttemptExecutionRequest = z.infer<
  typeof AttemptExecutionRequestSchema
>;

export interface AttemptExecutionRouteDependencies {
  readonly readExpectedBearerToken: () => string;
  readonly openStore: () =>
    | AttemptExecutionStore
    | Promise<AttemptExecutionStore>;
}

export type AttemptExecutionRouteHandler = (
  request: Request,
) => Promise<Response>;

class RouteRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RouteRequestError';
  }
}

function safeJson(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    status,
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return safeJson(status, { error: { code, message } }, headers);
}

/** Constant-time bearer comparison performed before any body is read. */
export function verifyAttemptExecutionWorkerToken(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return false;
  }
  const supplied = Buffer.from(authorizationHeader.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return (
    expected.byteLength >= 32 &&
    expected.byteLength <= 4_096 &&
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
}

export function readAttemptExecutionWorkerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[ATTEMPT_EXECUTION_WORKER_TOKEN_ENV];
  if (
    value === undefined ||
    value.length < 32 ||
    value.length > 4_096 ||
    value !== value.trim() ||
    /\s/u.test(value)
  ) {
    throw new Error('The attempt-execution worker credential is unsafe.');
  }
  return value;
}

function assertJsonContentType(request: Request): void {
  if (request.headers.has('content-encoding')) {
    throw new RouteRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Compressed request bodies are not accepted.',
    );
  }
  const contentType = request.headers.get('content-type')?.trim() ?? '';
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new RouteRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json with optional UTF-8 charset.',
    );
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (
    declared !== null &&
    Number(declared) > ATTEMPT_EXECUTION_MAX_BODY_BYTES
  ) {
    throw new RouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request body is larger than this endpoint accepts.',
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > ATTEMPT_EXECUTION_MAX_BODY_BYTES) {
    throw new RouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request body is larger than this endpoint accepts.',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RouteRequestError(
      400,
      'INVALID_ATTEMPT_EXECUTION_REQUEST',
      'The request body is not valid JSON.',
    );
  }
}

export function parseAttemptExecutionRequest(
  value: unknown,
): AttemptExecutionRequest {
  const parsed = AttemptExecutionRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new RouteRequestError(
      400,
      'INVALID_ATTEMPT_EXECUTION_REQUEST',
      'The attempt-execution request is not valid.',
    );
  }
  return parsed.data;
}

async function runOperation(
  store: AttemptExecutionStore,
  body: AttemptExecutionRequest,
): Promise<Response> {
  switch (body.operation) {
    case 'lookup':
      return safeJson(200, await store.lookup(body));
    case 'claim':
      return safeJson(200, await store.claim(body));
    case 'complete':
      await store.complete(body);
      return safeJson(200, { kind: 'completed' });
    case 'release':
      await store.release(body);
      return safeJson(200, { kind: 'released' });
  }
}

/**
 * Builds a POST-only adapter. Authentication completes before request bytes are
 * read or a database runtime is opened.
 */
export function createAttemptExecutionRouteHandler(
  dependencies: AttemptExecutionRouteDependencies,
): AttemptExecutionRouteHandler {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return errorResponse(
        405,
        'METHOD_NOT_ALLOWED',
        'This endpoint accepts authenticated POST requests only.',
        { Allow: 'POST' },
      );
    }

    let expectedToken: string;
    try {
      expectedToken = dependencies.readExpectedBearerToken();
    } catch {
      return errorResponse(
        503,
        'ATTEMPT_EXECUTION_UNAVAILABLE',
        'Attempt execution is temporarily unavailable.',
      );
    }
    if (
      !verifyAttemptExecutionWorkerToken(
        request.headers.get('authorization'),
        expectedToken,
      )
    ) {
      return errorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid attempt-execution worker bearer credential is required.',
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-attempt-execution"' },
      );
    }

    let body: AttemptExecutionRequest;
    try {
      assertJsonContentType(request);
      body = parseAttemptExecutionRequest(await readBoundedJson(request));
    } catch (error) {
      if (error instanceof RouteRequestError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(
        400,
        'INVALID_ATTEMPT_EXECUTION_REQUEST',
        'The attempt-execution request could not be read.',
      );
    }

    try {
      return await runOperation(await dependencies.openStore(), body);
    } catch (error) {
      if (error instanceof AttemptExecutionStoreError) {
        // A conflict is the caller's answer, not a server fault: it means
        // another worker owns this attempt, or the caller's belief about the
        // work disagrees with what was recorded.
        return errorResponse(409, error.code, error.message);
      }
      return errorResponse(
        503,
        'ATTEMPT_EXECUTION_UNAVAILABLE',
        'Attempt execution is temporarily unavailable.',
      );
    }
  };
}

let cachedStore: AttemptExecutionStore | undefined;

function defaultStore(): AttemptExecutionStore {
  cachedStore ??= createDrizzleAttemptExecutionStore(
    createDatabaseClient(readDatabaseConfig()).db,
  );
  return cachedStore;
}

const defaultHandler = createAttemptExecutionRouteHandler({
  openStore: defaultStore,
  readExpectedBearerToken: readAttemptExecutionWorkerToken,
});

export function handleAttemptExecutionPost(
  request: Request,
): Promise<Response> {
  return defaultHandler(request);
}
