import { timingSafeEqual } from 'node:crypto';

import {
  ExpoPushRuntimeRequestSchema,
  type ExpoPushRuntimeRequest,
} from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  readDatabaseConfig,
} from '../../../../db/client';
import {
  createDrizzleExpoPushRuntimeStore,
  ExpoPushRuntimeStoreError,
  type ExpoPushRuntimeStore,
} from '../../../../lib/notify/expo-push-runtime-store';

export const EXPO_PUSH_RUNTIME_WORKER_TOKEN_ENV =
  'PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN' as const;
export const EXPO_PUSH_RUNTIME_MAX_BODY_BYTES = 128 * 1024;

export interface ExpoPushRuntimeRouteDependencies {
  readonly readExpectedBearerToken: () => string;
  readonly openStore: () =>
    ExpoPushRuntimeStore | Promise<ExpoPushRuntimeStore>;
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

export function readExpoPushRuntimeWorkerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[EXPO_PUSH_RUNTIME_WORKER_TOKEN_ENV];
  if (
    value === undefined ||
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new Error('The Expo push runtime credential is unsafe.');
  }
  return value;
}

export function verifyExpoPushRuntimeWorkerToken(
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
      Number(declared) > EXPO_PUSH_RUNTIME_MAX_BODY_BYTES)
  ) {
    throw new RouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request body is larger than this endpoint accepts.',
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > EXPO_PUSH_RUNTIME_MAX_BODY_BYTES) {
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
      'INVALID_EXPO_PUSH_RUNTIME_REQUEST',
      'The request body is not valid JSON.',
    );
  }
}

export function parseExpoPushRuntimeRequest(
  value: unknown,
): ExpoPushRuntimeRequest {
  const parsed = ExpoPushRuntimeRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new RouteRequestError(
      400,
      'INVALID_EXPO_PUSH_RUNTIME_REQUEST',
      'The Expo push runtime request is not valid.',
    );
  }
  return parsed.data;
}

async function runOperation(
  store: ExpoPushRuntimeStore,
  body: ExpoPushRuntimeRequest,
): Promise<Response> {
  switch (body.operation) {
    case 'read-stuck-outbox-count':
      return safeJson(200, { count: await store.countStuckOutbox() });
    case 'lookup-provider-io':
      return safeJson(200, await store.lookupProviderIo(body));
    case 'claim-provider-io':
      return safeJson(200, await store.claimProviderIo(body));
    case 'complete-provider-io':
      await store.completeProviderIo(body);
      return safeJson(200, { kind: 'completed' });
    case 'schedule-receipt':
      await store.scheduleReceipt(body);
      return safeJson(200, { kind: 'scheduled' });
    case 'claim-due-receipts':
      return safeJson(200, { claims: await store.claimDueReceipts(body) });
    case 'decide-receipt':
      await store.decideReceipt(body);
      return safeJson(200, { kind: 'decided' });
    case 'schedule-retry':
      return safeJson(200, await store.scheduleRetry(body));
    case 'resolve-batch':
      return safeJson(200, await store.resolveBatch(body));
    case 'resolve-retry':
      return safeJson(200, await store.resolveRetry(body.attemptId));
  }
}

export function createExpoPushRuntimeRouteHandler(
  dependencies: ExpoPushRuntimeRouteDependencies,
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
        'EXPO_PUSH_RUNTIME_UNAVAILABLE',
        'Expo push runtime state is temporarily unavailable.',
      );
    }
    if (
      !verifyExpoPushRuntimeWorkerToken(
        request.headers.get('authorization'),
        token,
      )
    ) {
      return errorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid Expo push runtime bearer credential is required.',
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-expo-push-runtime"' },
      );
    }
    let body: ExpoPushRuntimeRequest;
    try {
      assertJsonContentType(request);
      body = parseExpoPushRuntimeRequest(await readBoundedJson(request));
    } catch (error) {
      return error instanceof RouteRequestError
        ? errorResponse(error.status, error.code, error.message)
        : errorResponse(
            400,
            'INVALID_EXPO_PUSH_RUNTIME_REQUEST',
            'The Expo push runtime request could not be read.',
          );
    }
    try {
      return await runOperation(await dependencies.openStore(), body);
    } catch (error) {
      if (error instanceof ExpoPushRuntimeStoreError) {
        return errorResponse(409, error.code, error.message);
      }
      return errorResponse(
        503,
        'EXPO_PUSH_RUNTIME_UNAVAILABLE',
        'Expo push runtime state is temporarily unavailable.',
      );
    }
  };
}

let cachedStore: ExpoPushRuntimeStore | undefined;

function defaultStore(): ExpoPushRuntimeStore {
  cachedStore ??= createDrizzleExpoPushRuntimeStore(
    createDatabaseClient(readDatabaseConfig()).db,
  );
  return cachedStore;
}

const defaultHandler = createExpoPushRuntimeRouteHandler({
  openStore: defaultStore,
  readExpectedBearerToken: readExpoPushRuntimeWorkerToken,
});

export function handleExpoPushRuntimePost(request: Request): Promise<Response> {
  return defaultHandler(request);
}
