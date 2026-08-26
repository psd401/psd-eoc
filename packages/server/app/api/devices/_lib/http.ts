import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  ApiErrorSchema,
  IdempotencyKeySchema,
  ListMyDevicesInputSchema,
  PushEndpointSendEligibilityInputSchema,
  PushEndpointSendEligibilityResultSchema,
  RecordEndpointStatusInputSchema,
  RegisterPushTokenInputSchema,
  UnregisterPushTokenInputSchema,
  type ApiErrorCode,
  type RecordEndpointStatusInput,
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
  getDefaultDeviceCapabilityRuntime,
  PUSH_ENDPOINT_INVALIDATION_REASONS,
  PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
  type DeviceCapabilityRuntime,
} from '../../../../lib/capabilities/devices';

export const DEVICE_IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;
export const PUSH_ENDPOINT_WORKER_TOKEN_ENV =
  'PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN' as const;
export const PUSH_ENDPOINT_MAX_BODY_BYTES = 8 * 1_024;

const JSON_MEDIA_TYPE = 'application/json';
const DEFAULT_DEVICE_PAGE_LIMIT = 50;
const MAX_DEVICE_REQUEST_BODY_BYTES = 8 * 1_024;
const HUMAN_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Vary: 'Authorization, Cookie',
});
const WORKER_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

type HumanDeviceCapabilityId = Extract<
  Parameters<DeviceCapabilityRuntime['execute']>[0],
  'list-my-devices' | 'register-push-token' | 'unregister-push-token'
>;

export interface DeviceRouteInvocationRequest {
  readonly requestId: string;
  readonly serverTime: Date;
  readonly mutation: Readonly<{ idempotencyKey: string }> | null;
}

export interface DeviceRouteCapabilityExecutor {
  execute(
    capabilityId: HumanDeviceCapabilityId,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
}

/** Test seam; production still derives the actor from session middleware. */
export interface DeviceRouteRuntime {
  readonly capabilities: DeviceRouteCapabilityExecutor;
  createRequestId(): string;
  now(): Date;
  resolveInvocation(
    request: Request,
    input: DeviceRouteInvocationRequest,
  ): Promise<TrustedCapabilityInvocation>;
}

export function getDefaultDeviceRouteRuntime(): DeviceRouteRuntime {
  const sessions = getDefaultSessionService();
  const capabilities = getDefaultDeviceCapabilityRuntime();
  return Object.freeze({
    capabilities: {
      execute: (
        capabilityId: HumanDeviceCapabilityId,
        input: unknown,
        invocation: TrustedCapabilityInvocation,
      ) => capabilities.execute(capabilityId, input, invocation),
    },
    createRequestId: randomUUID,
    now: () => new Date(),
    async resolveInvocation(
      request: Request,
      input: DeviceRouteInvocationRequest,
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
      return 'VALIDATION_ERROR';
    case 415:
      return 'VALIDATION_ERROR';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

function humanErrorResponse(error: unknown, requestId: string): NextResponse {
  const engineError = error instanceof CapabilityEngineError ? error : null;
  const sessionError = error instanceof SessionAccessError ? error : null;
  const requestError = error instanceof DeviceRequestError ? error : null;
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
          ? 'The device request is invalid.'
          : 'The device request failed.'),
      requestId,
      retryable: engineError?.retryable ?? status >= 500,
      fieldErrors: [],
    }),
    { status, headers: HUMAN_RESPONSE_HEADERS },
  );
}

class DeviceRequestError extends SyntaxError {
  public constructor(
    public readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceRequestError';
  }
}

function assertJsonContentType(request: Request): void {
  if (request.headers.has('content-encoding')) {
    throw new DeviceRequestError(
      415,
      'Compressed device requests are not accepted.',
    );
  }
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new DeviceRequestError(415, 'Device mutations require JSON content.');
  }
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  assertJsonContentType(request);
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^\d+$/u.test(declaredLength)) {
    throw new DeviceRequestError(400, 'The content length is invalid.');
  }
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new DeviceRequestError(413, 'The device request body is too large.');
  }
  if (request.body === null) {
    throw new DeviceRequestError(400, 'The device request body is required.');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DeviceRequestError(
          413,
          'The device request body is too large.',
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
    throw new DeviceRequestError(
      400,
      'The device request body is not valid UTF-8.',
    );
  }
  if (text.trim().length === 0) {
    throw new DeviceRequestError(400, 'The device request body is required.');
  }
  return JSON.parse(text) as unknown;
}

function parseMutationMetadata(
  request: Request,
): DeviceRouteInvocationRequest['mutation'] {
  return Object.freeze({
    idempotencyKey: IdempotencyKeySchema.parse(
      request.headers.get(DEVICE_IDEMPOTENCY_KEY_HEADER) ?? '',
    ),
  });
}

function assertQueryHasNoMutationHeaders(request: Request): void {
  if (request.headers.has(DEVICE_IDEMPOTENCY_KEY_HEADER)) {
    throw new SyntaxError('Device queries cannot carry mutation metadata.');
  }
}

function listMyDevicesInput(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const allowed = new Set(['includeRevoked', 'cursor', 'limit']);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
      throw new SyntaxError('The device query parameters are invalid.');
    }
  }
  const includeRevoked = parameters.get('includeRevoked');
  if (
    includeRevoked !== null &&
    includeRevoked !== 'true' &&
    includeRevoked !== 'false'
  ) {
    throw new SyntaxError('The device query parameters are invalid.');
  }
  const limit = parameters.get('limit');
  return ListMyDevicesInputSchema.parse({
    includeRevoked: includeRevoked === 'true',
    cursor: parameters.get('cursor'),
    limit: limit === null ? DEFAULT_DEVICE_PAGE_LIMIT : Number(limit),
  });
}

async function executeHumanDeviceRoute(
  request: Request,
  runtime: DeviceRouteRuntime | undefined,
  capabilityId: HumanDeviceCapabilityId,
  mutation: boolean,
  loadInput: () => unknown | Promise<unknown>,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const resolvedRuntime = runtime ?? getDefaultDeviceRouteRuntime();
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

export function handleListMyDevices(
  request: Request,
  runtime?: DeviceRouteRuntime,
): Promise<NextResponse> {
  return executeHumanDeviceRoute(
    request,
    runtime,
    'list-my-devices',
    false,
    () => listMyDevicesInput(request),
  );
}

export function handleRegisterPushToken(
  request: Request,
  runtime?: DeviceRouteRuntime,
): Promise<NextResponse> {
  return executeHumanDeviceRoute(
    request,
    runtime,
    'register-push-token',
    true,
    async () =>
      RegisterPushTokenInputSchema.parse(
        await readBoundedJson(request, MAX_DEVICE_REQUEST_BODY_BYTES),
      ),
  );
}

export function handleUnregisterPushToken(
  request: Request,
  runtime?: DeviceRouteRuntime,
): Promise<NextResponse> {
  return executeHumanDeviceRoute(
    request,
    runtime,
    'unregister-push-token',
    true,
    async () =>
      UnregisterPushTokenInputSchema.parse(
        await readBoundedJson(request, MAX_DEVICE_REQUEST_BODY_BYTES),
      ),
  );
}

export interface PushEndpointInvalidationRouteDependencies {
  readExpectedBearerToken(): string;
  execute(
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
  createRequestId(): string;
  now(): Date;
}

export interface PushEndpointEligibilityRouteDependencies {
  readExpectedBearerToken(): string;
  checkEligibility(input: unknown): Promise<unknown>;
  createRequestId(): string;
}

class PushEndpointRouteError extends Error {
  public constructor(
    public readonly status: 503,
    message: string,
  ) {
    super(message);
    this.name = 'PushEndpointRouteError';
  }
}

export function readPushEndpointWorkerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const token = environment[PUSH_ENDPOINT_WORKER_TOKEN_ENV];
  if (
    token === undefined ||
    token.length < 32 ||
    token.length > 4_096 ||
    token !== token.trim() ||
    /\s/u.test(token)
  ) {
    throw new PushEndpointRouteError(
      503,
      'The push endpoint worker credential is not configured safely.',
    );
  }
  return token;
}

export function verifyPushEndpointWorkerToken(
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

function workerErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  additionalHeaders: Readonly<Record<string, string>> = {},
): NextResponse {
  return NextResponse.json(
    ApiErrorSchema.parse({
      code,
      message,
      requestId,
      retryable: status >= 500,
      fieldErrors: [],
    }),
    {
      status,
      headers: { ...WORKER_RESPONSE_HEADERS, ...additionalHeaders },
    },
  );
}

function defaultPushInvalidationDependencies(): PushEndpointInvalidationRouteDependencies {
  return {
    readExpectedBearerToken: readPushEndpointWorkerToken,
    createRequestId: randomUUID,
    now: () => new Date(),
    execute: (input, invocation) =>
      getDefaultDeviceCapabilityRuntime().execute(
        'record-endpoint-status',
        input,
        invocation,
      ),
  };
}

function defaultPushEligibilityDependencies(): PushEndpointEligibilityRouteDependencies {
  return {
    readExpectedBearerToken: readPushEndpointWorkerToken,
    createRequestId: randomUUID,
    checkEligibility: (input) =>
      getDefaultDeviceCapabilityRuntime().checkPushEndpointSendEligibility(
        input,
      ),
  };
}

/**
 * Authenticates before reading bytes or touching persistence, then performs
 * the one token-free endpoint policy read exposed to the Expo worker.
 */
export async function handlePushEndpointEligibility(
  request: Request,
  dependencies?: PushEndpointEligibilityRouteDependencies,
): Promise<NextResponse> {
  const runtime = dependencies ?? defaultPushEligibilityDependencies();
  let requestId: string = randomUUID();
  try {
    requestId = runtime.createRequestId();
    let expectedToken: string;
    try {
      expectedToken = runtime.readExpectedBearerToken();
    } catch {
      return workerErrorResponse(
        503,
        'INTERNAL_ERROR',
        'Push endpoint eligibility is temporarily unavailable.',
        requestId,
      );
    }
    if (
      !verifyPushEndpointWorkerToken(
        request.headers.get('authorization'),
        expectedToken,
      )
    ) {
      return workerErrorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid push endpoint worker credential is required.',
        requestId,
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-push-endpoint"' },
      );
    }
    let input: unknown;
    try {
      input = PushEndpointSendEligibilityInputSchema.parse(
        await readBoundedJson(request, PUSH_ENDPOINT_MAX_BODY_BYTES),
      );
    } catch (error) {
      const routeError = error instanceof DeviceRequestError ? error : null;
      return workerErrorResponse(
        routeError?.status ?? 400,
        'VALIDATION_ERROR',
        'The push endpoint eligibility request is invalid.',
        requestId,
      );
    }
    const eligible = await runtime.checkEligibility(input);
    if (eligible !== true && eligible !== false) {
      throw new TypeError('Invalid push endpoint eligibility result.');
    }
    return NextResponse.json(
      PushEndpointSendEligibilityResultSchema.parse({
        version: 1,
        eligible,
      }),
      { headers: WORKER_RESPONSE_HEADERS },
    );
  } catch {
    return workerErrorResponse(
      503,
      'INTERNAL_ERROR',
      'Push endpoint eligibility failed safely.',
      requestId,
    );
  }
}

function pushInvalidationIdempotencyKey(
  input: RecordEndpointStatusInput,
  requestId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ input, requestId }), 'utf8')
    .digest('hex');
  return IdempotencyKeySchema.parse(`push-endpoint-invalid:${digest}`);
}

/**
 * Authenticates the route-specific worker before reading bytes or opening the
 * database, then exposes only one fixed invalidation mutation.
 */
export async function handlePushEndpointInvalidation(
  request: Request,
  dependencies?: PushEndpointInvalidationRouteDependencies,
): Promise<NextResponse> {
  const runtime = dependencies ?? defaultPushInvalidationDependencies();
  let requestId: string = randomUUID();
  try {
    requestId = runtime.createRequestId();
    let expectedToken: string;
    try {
      expectedToken = runtime.readExpectedBearerToken();
    } catch {
      return workerErrorResponse(
        503,
        'INTERNAL_ERROR',
        'Push endpoint invalidation is temporarily unavailable.',
        requestId,
      );
    }
    if (
      !verifyPushEndpointWorkerToken(
        request.headers.get('authorization'),
        expectedToken,
      )
    ) {
      return workerErrorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid push endpoint worker credential is required.',
        requestId,
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-push-endpoint"' },
      );
    }
    let input: RecordEndpointStatusInput;
    try {
      input = RecordEndpointStatusInputSchema.parse(
        await readBoundedJson(request, PUSH_ENDPOINT_MAX_BODY_BYTES),
      );
      if (
        input.status !== 'invalid' ||
        !PUSH_ENDPOINT_INVALIDATION_REASONS.includes(
          input.reasonCode as (typeof PUSH_ENDPOINT_INVALIDATION_REASONS)[number],
        )
      ) {
        throw new SyntaxError('The endpoint status is outside route scope.');
      }
    } catch (error) {
      const routeError = error instanceof DeviceRequestError ? error : null;
      return workerErrorResponse(
        routeError?.status ?? 400,
        'VALIDATION_ERROR',
        'The push endpoint invalidation request is invalid.',
        requestId,
      );
    }
    const serverTime = runtime.now();
    const invocation: TrustedCapabilityInvocation = Object.freeze({
      actor: {
        kind: 'system' as const,
        serviceId: PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
      },
      source: 'worker',
      scope: { facilityScope: { kind: 'district' as const } },
      requestId,
      serverTime,
      connectivityEpochId: null,
      mutation: {
        // Each authenticated delivery must reconcile against the latest
        // retained provider evidence. Database writes are semantically
        // idempotent, while reusing an input-only key would replay the first
        // result forever and skip later DeviceNotRegistered evidence.
        idempotencyKey: pushInvalidationIdempotencyKey(input, requestId),
        transport: { kind: 'worker-execution' as const },
        humanConfirmationId: null,
      },
    });
    const result = await runtime.execute(input, invocation);
    return NextResponse.json(result, { headers: WORKER_RESPONSE_HEADERS });
  } catch (error) {
    const engineError = error instanceof CapabilityEngineError ? error : null;
    const status = engineError?.status ?? 503;
    return workerErrorResponse(
      status,
      engineError?.code ?? 'INTERNAL_ERROR',
      engineError?.message ?? 'Push endpoint invalidation failed safely.',
      requestId,
    );
  }
}
