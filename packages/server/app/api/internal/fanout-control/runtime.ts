import { timingSafeEqual } from 'node:crypto';

import {
  FanoutAuthorizationCheckInputSchema,
  FanoutAuthorizationDecisionSchema,
  executeCapability,
  registerCapabilityHandler,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type FanoutAuthorizationCheckInput,
  type FanoutAuthorizationDecision,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
} from '../../../../db/client';
import { isNotificationIntentAuthorizedForCurrentFanout } from '../../../../lib/notify/fanout-control';

export const FANOUT_CONTROL_WORKER_TOKEN_ENV =
  'PSD_EOC_FANOUT_CONTROL_WORKER_TOKEN' as const;
export const FANOUT_CONTROL_WORKER_SERVICE_ID =
  'notification-fanout-worker' as const;
export const FANOUT_CONTROL_MAX_BODY_BYTES = 4 * 1024;

export interface FanoutAuthorizationStore {
  authorize(
    input: FanoutAuthorizationCheckInput,
  ): Promise<FanoutAuthorizationDecision>;
}

export interface FanoutAuthorizationCapabilityContext {
  readonly actor: Readonly<{
    kind: 'system';
    serviceId: typeof FANOUT_CONTROL_WORKER_SERVICE_ID;
  }>;
  readonly source: 'worker';
  readonly transport: 'worker-execution';
  readonly workerAuthenticated: true;
  readonly intentId: string;
}

export interface FanoutControlRouteRuntime {
  readonly handler: RegisteredCapabilityHandler<
    'authorize-notification-fanout',
    FanoutAuthorizationCapabilityContext
  >;
  readonly authorizer: CapabilityExecutionAuthorizer<FanoutAuthorizationCapabilityContext>;
  close(): Promise<void>;
}

export interface FanoutControlRouteDependencies {
  readonly readExpectedBearerToken: () => string;
  readonly createRuntime: () => Promise<FanoutControlRouteRuntime>;
}

export type FanoutControlRouteHandler = (request: Request) => Promise<Response>;

function responseHeaders(additional: Record<string, string> = {}): Headers {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...additional,
  });
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: responseHeaders() });
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

/** Constant-time worker bearer comparison completed before body reads. */
export function verifyFanoutControlWorkerToken(
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

/** Reads only the dedicated fan-out query credential, never DB credentials. */
export function readFanoutControlWorkerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[FANOUT_CONTROL_WORKER_TOKEN_ENV];
  if (
    value === undefined ||
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new Error('Fan-out worker credential is unavailable.');
  }
  return value;
}

async function readBoundedInput(request: Request): Promise<unknown> {
  if (request.headers.has('content-encoding')) {
    throw new Error('unsupported content encoding');
  }
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
      request.headers.get('content-type')?.trim() ?? '',
    )
  ) {
    throw new Error('invalid content type');
  }
  const declared = request.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) ||
      Number(declared) > FANOUT_CONTROL_MAX_BODY_BYTES)
  ) {
    throw new Error('invalid content length');
  }
  if (request.body === null) throw new Error('missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > FANOUT_CONTROL_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('oversized body');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled oversized request remains rejected.
    }
  }
  if (total === 0) throw new Error('empty body');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as unknown;
}

export function createFanoutAuthorizationHandler(
  store: FanoutAuthorizationStore,
): RegisteredCapabilityHandler<
  'authorize-notification-fanout',
  FanoutAuthorizationCapabilityContext
> {
  return registerCapabilityHandler(
    'authorize-notification-fanout',
    async (input, context) => {
      if (input.intentId !== context.intentId) {
        throw new Error('Fan-out authorization identity mismatch.');
      }
      return FanoutAuthorizationDecisionSchema.parse(
        await store.authorize(input),
      );
    },
  );
}

/** Deny-by-default authorization for the one fixed worker query. */
export function createFanoutControlAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<FanoutAuthorizationCapabilityContext>
> {
  return Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        FanoutAuthorizationCapabilityContext
      >,
    ): void {
      const parsed = FanoutAuthorizationCheckInputSchema.safeParse(
        request.input,
      );
      const context = request.context;
      if (
        request.definition.id !== 'authorize-notification-fanout' ||
        request.definition.operation !== 'query' ||
        request.definition.safetyEffect !== 'none' ||
        request.invocationPolicy.agentGrantable ||
        !request.invocationPolicy.principalKinds.includes('system') ||
        !request.invocationPolicy.sources.includes('worker') ||
        context.actor.kind !== 'system' ||
        context.actor.serviceId !== FANOUT_CONTROL_WORKER_SERVICE_ID ||
        context.source !== 'worker' ||
        context.transport !== 'worker-execution' ||
        context.workerAuthenticated !== true ||
        request.humanActionRequirement.actionIds.length !== 0 ||
        request.humanActionRequirement.consequenceDigest !== null ||
        !parsed.success ||
        parsed.data.intentId !== context.intentId
      ) {
        throw new Error('Fan-out worker invocation was not authorized.');
      }
    },
  });
}

function capabilityContextFor(
  input: FanoutAuthorizationCheckInput,
): FanoutAuthorizationCapabilityContext {
  return Object.freeze({
    actor: Object.freeze({
      kind: 'system' as const,
      serviceId: FANOUT_CONTROL_WORKER_SERVICE_ID,
    }),
    source: 'worker',
    transport: 'worker-execution',
    workerAuthenticated: true,
    intentId: input.intentId,
  });
}

/**
 * Builds the POST-only internal adapter. Authentication completes before the
 * body is read or a database connection is opened; every error fails closed.
 */
export function createFanoutControlRouteHandler(
  dependencies: FanoutControlRouteDependencies,
): FanoutControlRouteHandler {
  return async (request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: 'This endpoint accepts authenticated POST only.',
          },
        }),
        {
          status: 405,
          headers: responseHeaders({
            Allow: 'POST',
            'Content-Type': 'application/json',
          }),
        },
      );
    }
    let expectedToken: string;
    try {
      expectedToken = dependencies.readExpectedBearerToken();
    } catch {
      return error(
        503,
        'FANOUT_CONTROL_UNAVAILABLE',
        'Notification fan-out authorization is unavailable.',
      );
    }
    if (
      !verifyFanoutControlWorkerToken(
        request.headers.get('authorization'),
        expectedToken,
      )
    ) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'A valid fan-out worker credential is required.',
          },
        }),
        {
          status: 401,
          headers: responseHeaders({
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer realm="psd-eoc-fanout-control"',
          }),
        },
      );
    }
    let input: FanoutAuthorizationCheckInput;
    try {
      input = FanoutAuthorizationCheckInputSchema.parse(
        await readBoundedInput(request),
      );
    } catch {
      return error(
        400,
        'INVALID_FANOUT_CONTROL_REQUEST',
        'The fan-out authorization request is invalid.',
      );
    }
    let runtime: FanoutControlRouteRuntime | undefined;
    try {
      runtime = await dependencies.createRuntime();
      const result = await executeCapability(runtime.handler, input, {
        context: capabilityContextFor(input),
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: runtime.authorizer,
      });
      return json(200, { result });
    } catch {
      return error(
        503,
        'FANOUT_CONTROL_UNAVAILABLE',
        'Notification fan-out authorization failed safely.',
      );
    } finally {
      await runtime?.close().catch(() => undefined);
    }
  };
}

export function createDrizzleFanoutAuthorizationStore(
  database: Database,
): FanoutAuthorizationStore {
  return Object.freeze({
    authorize(input: FanoutAuthorizationCheckInput) {
      return database.transaction((transaction) =>
        isNotificationIntentAuthorizedForCurrentFanout(
          transaction,
          input.intentId,
        ),
      );
    },
  });
}

async function createDefaultRuntime(): Promise<FanoutControlRouteRuntime> {
  const connection = createDatabaseClient(readDatabaseConfig());
  try {
    const store = createDrizzleFanoutAuthorizationStore(connection.db);
    return Object.freeze({
      handler: createFanoutAuthorizationHandler(store),
      authorizer: createFanoutControlAuthorizer(),
      close: connection.close,
    });
  } catch (cause) {
    await connection.close().catch(() => undefined);
    throw cause;
  }
}

const defaultHandler = createFanoutControlRouteHandler({
  readExpectedBearerToken: readFanoutControlWorkerToken,
  createRuntime: createDefaultRuntime,
});

/** Fixed worker-authenticated query; no lifecycle mutation is reachable. */
export async function handleFanoutControlPost(
  request: Request,
): Promise<Response> {
  return defaultHandler(request);
}
