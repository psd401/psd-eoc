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

import { authenticateSessionRequest } from '../../../../lib/auth/middleware';
import { getDefaultSessionService } from '../../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  resolveHumanCapabilityInvocation,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  executeHumanRoute,
  HumanRequestError,
  readBoundedJson,
  type HumanRouteInvocationRequest,
  type HumanRouteRuntime,
  type HumanRouteSubject,
} from '../../../../lib/http/human-route';
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

const DEFAULT_DEVICE_PAGE_LIMIT = 50;
const MAX_DEVICE_REQUEST_BODY_BYTES = 8 * 1_024;
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

export type DeviceRouteRuntime = HumanRouteRuntime<HumanDeviceCapabilityId>;
export type DeviceRouteInvocationRequest = HumanRouteInvocationRequest;

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
      input: HumanRouteInvocationRequest,
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

const SUBJECT: HumanRouteSubject = Object.freeze({
  maxBodyBytes: MAX_DEVICE_REQUEST_BODY_BYTES,
  noun: 'device',
});

/** The Expo worker routes carry their own ceiling and their own wording. */
const WORKER_SUBJECT: HumanRouteSubject = Object.freeze({
  maxBodyBytes: PUSH_ENDPOINT_MAX_BODY_BYTES,
  noun: 'push endpoint',
});

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

export function handleListMyDevices(
  request: Request,
  runtime: DeviceRouteRuntime = getDefaultDeviceRouteRuntime(),
): Promise<NextResponse> {
  return executeHumanRoute(
    request,
    runtime,
    'list-my-devices',
    false,
    SUBJECT,
    () => listMyDevicesInput(request),
  );
}

export function handleRegisterPushToken(
  request: Request,
  runtime: DeviceRouteRuntime = getDefaultDeviceRouteRuntime(),
): Promise<NextResponse> {
  return executeHumanRoute(
    request,
    runtime,
    'register-push-token',
    true,
    SUBJECT,
    async () =>
      RegisterPushTokenInputSchema.parse(
        await readBoundedJson(request, SUBJECT),
      ),
  );
}

export function handleUnregisterPushToken(
  request: Request,
  runtime: DeviceRouteRuntime = getDefaultDeviceRouteRuntime(),
): Promise<NextResponse> {
  return executeHumanRoute(
    request,
    runtime,
    'unregister-push-token',
    true,
    SUBJECT,
    async () =>
      UnregisterPushTokenInputSchema.parse(
        await readBoundedJson(request, SUBJECT),
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
        await readBoundedJson(request, WORKER_SUBJECT),
      );
    } catch (error) {
      const routeError = error instanceof HumanRequestError ? error : null;
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
        await readBoundedJson(request, WORKER_SUBJECT),
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
      const routeError = error instanceof HumanRequestError ? error : null;
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
