import { timingSafeEqual } from 'node:crypto';

import {
  SmsRuntimeRequestSchema,
  type SmsRuntimeRequest,
} from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  readDatabaseConfig,
} from '../../../../db/client';
import {
  createDrizzleSmsRuntimeStore,
  readSmsRuntimeStoreConfiguration,
  SmsRuntimeStoreError,
  type SmsRuntimeStore,
} from '../../../../lib/notify/sms-runtime-store';

export const SMS_RUNTIME_WORKER_TOKEN_ENV =
  'PSD_EOC_SMS_RUNTIME_WORKER_TOKEN' as const;
export const SMS_RUNTIME_MAX_BODY_BYTES = 256 * 1024;

export interface SmsRuntimeRouteDependencies {
  readonly readExpectedBearerToken: () => string;
  readonly openStore: () => SmsRuntimeStore | Promise<SmsRuntimeStore>;
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

export function readSmsRuntimeWorkerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[SMS_RUNTIME_WORKER_TOKEN_ENV];
  if (
    value === undefined ||
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new Error('The SMS runtime credential is unsafe.');
  }
  return value;
}

export function verifySmsRuntimeWorkerToken(
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
    (!/^\d+$/u.test(declared) || Number(declared) > SMS_RUNTIME_MAX_BODY_BYTES)
  ) {
    throw new RouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request body is larger than this endpoint accepts.',
    );
  }
  if (request.body === null) {
    throw new RouteRequestError(
      400,
      'INVALID_SMS_RUNTIME_REQUEST',
      'The request body is missing.',
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
      if (totalBytes > SMS_RUNTIME_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RouteRequestError(
          413,
          'PAYLOAD_TOO_LARGE',
          'The request body is larger than this endpoint accepts.',
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
    throw new RouteRequestError(
      400,
      'INVALID_SMS_RUNTIME_REQUEST',
      'The request body is not valid UTF-8.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteRequestError(
      400,
      'INVALID_SMS_RUNTIME_REQUEST',
      'The request body is not valid JSON.',
    );
  }
}

export function parseSmsRuntimeRequest(value: unknown): SmsRuntimeRequest {
  const parsed = SmsRuntimeRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new RouteRequestError(
      400,
      'INVALID_SMS_RUNTIME_REQUEST',
      'The SMS runtime request is not valid.',
    );
  }
  return parsed.data;
}

async function runOperation(
  store: SmsRuntimeStore,
  body: SmsRuntimeRequest,
): Promise<Response> {
  switch (body.operation) {
    case 'lookup-provider-io':
      return safeJson(200, await store.lookupProviderIo(body));
    case 'claim-provider-io':
      return safeJson(200, await store.claimProviderIo(body));
    case 'complete-provider-io':
      await store.completeProviderIo(body);
      return safeJson(200, { kind: 'completed' });
    case 'schedule-retry':
      return safeJson(200, await store.scheduleRetry(body));
    case 'resolve-batch':
      return safeJson(200, await store.resolveBatch(body));
    case 'resolve-retry':
      return safeJson(200, await store.resolveRetry(body.attemptId));
    case 'authorize-provider-send':
      return safeJson(200, await store.authorizeProviderSend(body.workItem));
    case 'record-sms-opt-out':
      return safeJson(200, await store.executeLifecycle(body));
    case 'resolve-sms-destination':
      return safeJson(200, await store.resolveSmsDestination(body));
    case 'load-attempt-by-provider-reference':
      return safeJson(
        200,
        await store.loadAttemptByProviderReference(body.providerReference),
      );
    case 'load-unknown-attempt':
      return safeJson(
        200,
        await store.loadUnknownAttempt(body.attemptId, body.correlationToken),
      );
    case 'list-current-roster-snapshots':
      return safeJson(200, {
        snapshots: await store.listCurrentRosterSnapshots(),
      });
  }
}

export function createSmsRuntimeRouteHandler(
  dependencies: SmsRuntimeRouteDependencies,
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
        'SMS_RUNTIME_UNAVAILABLE',
        'SMS runtime state is temporarily unavailable.',
      );
    }
    if (
      !verifySmsRuntimeWorkerToken(request.headers.get('authorization'), token)
    ) {
      return errorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid SMS runtime bearer credential is required.',
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-sms-runtime"' },
      );
    }
    let body: SmsRuntimeRequest;
    try {
      assertJsonContentType(request);
      body = parseSmsRuntimeRequest(await readBoundedJson(request));
    } catch (error) {
      return error instanceof RouteRequestError
        ? errorResponse(error.status, error.code, error.message)
        : errorResponse(
            400,
            'INVALID_SMS_RUNTIME_REQUEST',
            'The SMS runtime request could not be read.',
          );
    }
    try {
      return await runOperation(await dependencies.openStore(), body);
    } catch (error) {
      if (error instanceof SmsRuntimeStoreError) {
        return errorResponse(409, error.code, error.message);
      }
      return errorResponse(
        503,
        'SMS_RUNTIME_UNAVAILABLE',
        'SMS runtime state is temporarily unavailable.',
      );
    }
  };
}

let cachedStore: SmsRuntimeStore | undefined;

function defaultStore(): SmsRuntimeStore {
  cachedStore ??= createDrizzleSmsRuntimeStore(
    createDatabaseClient(readDatabaseConfig()).db,
    readSmsRuntimeStoreConfiguration(),
  );
  return cachedStore;
}

const defaultHandler = createSmsRuntimeRouteHandler({
  openStore: defaultStore,
  readExpectedBearerToken: readSmsRuntimeWorkerToken,
});

export function handleSmsRuntimePost(request: Request): Promise<Response> {
  return defaultHandler(request);
}
