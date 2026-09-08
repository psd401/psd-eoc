import { timingSafeEqual } from 'node:crypto';

import {
  EmailRuntimeRequestSchema,
  type EmailRuntimeRequest,
} from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  readDatabaseConfig,
} from '../../../../db/client';
import {
  createDrizzleEmailRuntimeStore,
  EmailRuntimeStoreError,
  type EmailRuntimeStore,
} from '../../../../lib/notify/email-runtime-store';

export const EMAIL_RUNTIME_WORKER_TOKEN_ENV =
  'PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN' as const;
export const EMAIL_RUNTIME_MAX_BODY_BYTES = 128 * 1024;

export interface EmailRuntimeRouteDependencies {
  readonly readExpectedBearerToken: () => string;
  readonly openStore: () => EmailRuntimeStore | Promise<EmailRuntimeStore>;
}

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

function safeJson(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers = {},
): Response {
  return safeJson(status, { error: { code, message } }, headers);
}

export function readEmailRuntimeWorkerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[EMAIL_RUNTIME_WORKER_TOKEN_ENV];
  if (
    value === undefined ||
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new Error('The email runtime credential is unsafe.');
  }
  return value;
}

export function verifyEmailRuntimeWorkerToken(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorizationHeader.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return (
    expected.byteLength >= 32 &&
    expected.byteLength <= 4_096 &&
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
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
    (!/^\d+$/u.test(declared) ||
      Number(declared) > EMAIL_RUNTIME_MAX_BODY_BYTES)
  ) {
    throw new RouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request body is larger than this endpoint accepts.',
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > EMAIL_RUNTIME_MAX_BODY_BYTES) {
    throw new RouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request body is larger than this endpoint accepts.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteRequestError(
      400,
      'INVALID_EMAIL_RUNTIME_REQUEST',
      'The request body is not valid JSON.',
    );
  }
}

async function runOperation(
  store: EmailRuntimeStore,
  body: EmailRuntimeRequest,
): Promise<Response> {
  switch (body.operation) {
    case 'claim-provider-io':
      return safeJson(200, await store.claimProviderIo(body));
    case 'complete-provider-io':
      await store.completeProviderIo(body);
      return safeJson(200, { kind: 'completed' });
    case 'resolve-batch':
      return safeJson(200, await store.resolveBatch(body));
    case 'resolve-retry':
      return safeJson(200, await store.resolveRetry(body.sourceAttemptId));
    case 'authorize-provider-send':
      return safeJson(200, {
        allowed: await store.authorizeProviderSend(body.workItem),
      });
  }
}

export function createEmailRuntimeRouteHandler(
  dependencies: EmailRuntimeRouteDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return errorResponse(
        405,
        'METHOD_NOT_ALLOWED',
        'This endpoint accepts authenticated POST requests only.',
        { Allow: 'POST' },
      );
    }
    let token: string;
    try {
      token = dependencies.readExpectedBearerToken();
    } catch {
      return errorResponse(
        503,
        'EMAIL_RUNTIME_UNAVAILABLE',
        'Email runtime state is temporarily unavailable.',
      );
    }
    if (
      !verifyEmailRuntimeWorkerToken(
        request.headers.get('authorization'),
        token,
      )
    ) {
      return errorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid email runtime bearer credential is required.',
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-email-runtime"' },
      );
    }
    let body: EmailRuntimeRequest;
    try {
      assertJsonContentType(request);
      const parsed = EmailRuntimeRequestSchema.safeParse(
        await readBoundedJson(request),
      );
      if (!parsed.success) {
        throw new RouteRequestError(
          400,
          'INVALID_EMAIL_RUNTIME_REQUEST',
          'The email runtime request is not valid.',
        );
      }
      body = parsed.data;
    } catch (error) {
      return error instanceof RouteRequestError
        ? errorResponse(error.status, error.code, error.message)
        : errorResponse(
            400,
            'INVALID_EMAIL_RUNTIME_REQUEST',
            'The email runtime request could not be read.',
          );
    }
    try {
      return await runOperation(await dependencies.openStore(), body);
    } catch (error) {
      if (error instanceof EmailRuntimeStoreError) {
        // The worker cancels an error body rather than reading it, so this
        // code reaches it only as the status. Whichever conflict it was
        // decides what an operator does about it, and it is a fixed
        // classification rather than content.
        console.error(
          JSON.stringify({
            event: 'email-runtime-conflict',
            code: error.code,
            detail: error.detail,
          }),
        );
        return errorResponse(409, error.code, error.message);
      }
      console.error(
        JSON.stringify({
          event: 'email-runtime-unavailable',
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
      return errorResponse(
        503,
        'EMAIL_RUNTIME_UNAVAILABLE',
        'Email runtime state is temporarily unavailable.',
      );
    }
  };
}

let cachedStore: EmailRuntimeStore | undefined;

function defaultStore(): EmailRuntimeStore {
  cachedStore ??= createDrizzleEmailRuntimeStore(
    createDatabaseClient(readDatabaseConfig()).db,
  );
  return cachedStore;
}

const defaultHandler = createEmailRuntimeRouteHandler({
  openStore: defaultStore,
  readExpectedBearerToken: readEmailRuntimeWorkerToken,
});

export function handleEmailRuntimePost(request: Request): Promise<Response> {
  return defaultHandler(request);
}
