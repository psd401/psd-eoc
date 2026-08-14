import {
  IdempotencyKeySchema,
  SyncRosterInputSchema,
  TimestampSchema,
  UuidSchema,
  executeCapability,
  parseCapabilityEnvelopeFor,
  type CapabilityExecutionAuthorizer,
  type RegisteredCapabilityHandler,
  type RosterSyncResult,
} from '@psd-eoc/contracts';
import { z } from 'zod';

import {
  createDatabaseClient,
  readDatabaseConfig,
} from '../../../../db/client';
import {
  RosterSyncError,
  createDrizzleRosterSyncStore,
  createGoogleAdminRosterAdapter,
  createScheduledRosterSyncAuthorizer,
  createStructuredRosterSyncAlertSink,
  createSyncRosterHandler,
  readGoogleAdminRosterConfiguration,
  verifyRosterSyncJobToken,
  type RosterSyncAlert,
  type RosterSyncAlertSink,
  type RosterSyncCapabilityContext,
} from '../../../../lib/roster/groups-sync';

export const ROSTER_SYNC_EVENT_SOURCE = 'psd-eoc.roster-sync' as const;
export const ROSTER_SYNC_EVENT_DETAIL_TYPE =
  'PSD EOC Scheduled Roster Sync' as const;
export const ROSTER_SYNC_EVENT_MAX_BODY_BYTES = 16 * 1024;
export const ROSTER_SYNC_JOB_TOKEN_ENV =
  'PSD_EOC_ROSTER_SYNC_JOB_TOKEN' as const;

const EventBridgeRosterSyncEventSchema = z
  .object({
    version: z.literal('0'),
    id: UuidSchema,
    'detail-type': z.literal(ROSTER_SYNC_EVENT_DETAIL_TYPE),
    source: z.literal(ROSTER_SYNC_EVENT_SOURCE),
    account: z.string().regex(/^\d{12}$/u),
    time: TimestampSchema,
    region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u),
    resources: z
      .array(z.string().trim().min(1).max(2_048).regex(/^arn:/u))
      .max(20)
      .readonly(),
    detail: SyncRosterInputSchema,
  })
  .strict()
  .readonly();

export type EventBridgeRosterSyncEvent = z.infer<
  typeof EventBridgeRosterSyncEventSchema
>;

class RosterSyncRouteRequestError extends Error {
  public readonly status: 400 | 413 | 415;
  public readonly code:
    | 'INVALID_EVENT'
    | 'PAYLOAD_TOO_LARGE'
    | 'UNSUPPORTED_MEDIA_TYPE';

  public constructor(
    status: 400 | 413 | 415,
    code: 'INVALID_EVENT' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE',
    message: string,
  ) {
    super(message);
    this.name = 'RosterSyncRouteRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface RosterSyncRouteRuntime {
  readonly handler: RegisteredCapabilityHandler<
    'sync-roster',
    RosterSyncCapabilityContext
  >;
  readonly authorizer: CapabilityExecutionAuthorizer<RosterSyncCapabilityContext>;
  close(): Promise<void>;
}

export interface RosterSyncRouteDependencies {
  readonly readExpectedBearerToken: () => string;
  readonly createRuntime: () => Promise<RosterSyncRouteRuntime>;
  readonly alerts: RosterSyncAlertSink;
  readonly cleanupFailures?: RosterSyncCleanupFailureSink;
  readonly clock: () => Date;
}

export interface RosterSyncCleanupFailure {
  readonly eventId: string;
  readonly errorCode: 'ROSTER_SYNC_RUNTIME_CLOSE_FAILED';
  readonly occurredAt: string;
}

export interface RosterSyncCleanupFailureSink {
  notify(failure: RosterSyncCleanupFailure): void | Promise<void>;
}

export type RosterSyncRouteHandler = (request: Request) => Promise<Response>;

function responseHeaders(
  additional: Readonly<Record<string, string>> = {},
): Headers {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...additional,
  });
}

function safeJson(
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(body, {
    status,
    headers: responseHeaders(headers),
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

function methodNotAllowed(): Response {
  return errorResponse(
    405,
    'METHOD_NOT_ALLOWED',
    'This endpoint accepts authenticated POST requests only.',
    { Allow: 'POST' },
  );
}

function assertJsonContentType(request: Request): void {
  if (request.headers.has('content-encoding')) {
    throw new RosterSyncRouteRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Compressed request bodies are not accepted.',
    );
  }
  const contentType = request.headers.get('content-type')?.trim() ?? '';
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new RosterSyncRouteRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json with optional UTF-8 charset.',
    );
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (value === null) {
    return null;
  }
  if (!/^\d+$/u.test(value)) {
    throw new RosterSyncRouteRequestError(
      400,
      'INVALID_EVENT',
      'Content-Length was invalid.',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RosterSyncRouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The scheduled event exceeded the request-size limit.',
    );
  }
  return parsed;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = declaredContentLength(request);
  if (
    declaredLength !== null &&
    declaredLength > ROSTER_SYNC_EVENT_MAX_BODY_BYTES
  ) {
    throw new RosterSyncRouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The scheduled event exceeded the request-size limit.',
    );
  }
  if (request.body === null) {
    throw new RosterSyncRouteRequestError(
      400,
      'INVALID_EVENT',
      'The scheduled event body was missing.',
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > ROSTER_SYNC_EVENT_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RosterSyncRouteRequestError(
          413,
          'PAYLOAD_TOO_LARGE',
          'The scheduled event exceeded the request-size limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new RosterSyncRouteRequestError(
      400,
      'INVALID_EVENT',
      'The scheduled event body was empty.',
    );
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
    throw new RosterSyncRouteRequestError(
      400,
      'INVALID_EVENT',
      'The scheduled event was not valid UTF-8.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RosterSyncRouteRequestError(
      400,
      'INVALID_EVENT',
      'The scheduled event was malformed JSON.',
    );
  }
}

async function parseEvent(
  request: Request,
): Promise<EventBridgeRosterSyncEvent> {
  assertJsonContentType(request);
  const parsed = EventBridgeRosterSyncEventSchema.safeParse(
    await readBoundedJson(request),
  );
  if (!parsed.success) {
    throw new RosterSyncRouteRequestError(
      400,
      'INVALID_EVENT',
      'The scheduled event did not match the required schema.',
    );
  }
  return parsed.data;
}

function readTrustedTime(clock: () => Date): string {
  let value: Date;
  try {
    value = clock();
  } catch {
    throw new RosterSyncError(
      'ROSTER_SYNC_CLOCK_INVALID',
      'The roster-sync route clock failed.',
    );
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RosterSyncError(
      'ROSTER_SYNC_CLOCK_INVALID',
      'The roster-sync route clock was invalid.',
    );
  }
  return TimestampSchema.parse(value.toISOString());
}

function buildScheduledEnvelope(
  event: EventBridgeRosterSyncEvent,
  now: string,
) {
  const actor = Object.freeze({
    kind: 'system' as const,
    serviceId: 'roster-sync-job',
  });
  const idempotencyKey = IdempotencyKeySchema.parse(`eventbridge:${event.id}`);
  const envelope = parseCapabilityEnvelopeFor<'sync-roster'>('sync-roster', {
    capabilityId: 'sync-roster',
    operation: 'mutation',
    actor,
    source: 'scheduled-job',
    scope: { facilityScope: { kind: 'district' } },
    requestId: event.id,
    serverTime: now,
    input: event.detail,
    idempotencyKey,
    transport: { kind: 'scheduled-execution' },
    connectivityEpochId: null,
    requiredHumanActionIds: [],
    requiredConsequenceDigest: null,
    humanConfirmation: null,
  });
  const context: RosterSyncCapabilityContext = Object.freeze({
    actor,
    source: 'scheduled-job',
    transport: 'scheduled-execution',
    schedulerAuthenticated: true,
    requestId: UuidSchema.parse(event.id),
    idempotencyKey,
  });
  return Object.freeze({ envelope, context });
}

function safeExecutionErrorCode(error: unknown): string {
  return error instanceof RosterSyncError
    ? error.code
    : 'ROSTER_SYNC_ROUTE_FAILED';
}

async function notifyExecutionFailure(
  alerts: RosterSyncAlertSink,
  event: EventBridgeRosterSyncEvent,
  error: unknown,
  occurredAt: string,
): Promise<void> {
  const alert: RosterSyncAlert = Object.freeze({
    sourceConfiguration: event.detail.sourceConfiguration,
    population: null,
    syncResultId: null,
    outcome: 'execution-failed',
    errorCodes: Object.freeze([safeExecutionErrorCode(error)]),
    occurredAt,
  });
  await Promise.resolve(alerts.notify(alert)).catch(() => undefined);
}

/**
 * Builds the transport adapter without opening a database or reading secrets.
 * Method and bearer checks therefore remain side-effect-free and precede all
 * request-body parsing.
 */
export function createRosterSyncRouteHandler(
  dependencies: RosterSyncRouteDependencies,
): RosterSyncRouteHandler {
  const readExpectedBearerToken = dependencies.readExpectedBearerToken;
  const createRuntime = dependencies.createRuntime;
  const alerts = dependencies.alerts;
  const cleanupFailures = dependencies.cleanupFailures;
  const clock = dependencies.clock;

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return methodNotAllowed();
    }

    let expectedToken: string;
    try {
      expectedToken = readExpectedBearerToken();
    } catch {
      return errorResponse(
        503,
        'ROSTER_SYNC_UNAVAILABLE',
        'Roster synchronization is temporarily unavailable.',
      );
    }
    if (
      !verifyRosterSyncJobToken(
        request.headers.get('authorization'),
        expectedToken,
      )
    ) {
      return errorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid scheduled-job bearer credential is required.',
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-roster-sync"' },
      );
    }

    let event: EventBridgeRosterSyncEvent;
    try {
      event = await parseEvent(request);
    } catch (error) {
      if (error instanceof RosterSyncRouteRequestError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(
        400,
        'INVALID_EVENT',
        'The scheduled event could not be read.',
      );
    }

    let runtime: RosterSyncRouteRuntime | undefined;
    let result: RosterSyncResult | undefined;
    let executionError: unknown;
    let occurredAt = event.time;
    let cleanupFailed = false;
    try {
      occurredAt = readTrustedTime(clock);
      const { envelope, context } = buildScheduledEnvelope(event, occurredAt);
      runtime = await createRuntime();
      result = await executeCapability(runtime.handler, envelope.input, {
        context,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: runtime.authorizer,
      });
    } catch (error) {
      executionError = error;
      try {
        occurredAt = readTrustedTime(clock);
      } catch {
        occurredAt = event.time;
      }
    } finally {
      if (runtime !== undefined) {
        try {
          await runtime.close();
        } catch {
          cleanupFailed = true;
        }
      }
    }

    if (cleanupFailed) {
      await Promise.resolve(
        cleanupFailures?.notify(
          Object.freeze({
            eventId: event.id,
            errorCode: 'ROSTER_SYNC_RUNTIME_CLOSE_FAILED',
            occurredAt,
          }),
        ),
      ).catch(() => undefined);
    }

    if (executionError !== undefined || result === undefined) {
      const error =
        executionError ??
        new RosterSyncError(
          'ROSTER_SYNC_RESULT_MISSING',
          'The roster-sync capability returned no result.',
        );
      await notifyExecutionFailure(alerts, event, error, occurredAt);
      return errorResponse(
        503,
        'ROSTER_SYNC_UNAVAILABLE',
        'Roster synchronization failed safely; the last complete snapshot remains active.',
      );
    }

    return safeJson(200, { result });
  };
}

function readExpectedBearerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[ROSTER_SYNC_JOB_TOKEN_ENV];
  if (
    value === undefined ||
    value.length < 32 ||
    value.length > 512 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new RosterSyncError(
      'ROSTER_SYNC_AUTH_CONFIGURATION_INVALID',
      'The roster-sync job credential is not configured safely.',
    );
  }
  return value;
}

async function createDefaultRuntime(
  alerts: RosterSyncAlertSink,
): Promise<RosterSyncRouteRuntime> {
  const connection = createDatabaseClient(readDatabaseConfig());
  try {
    const adapter = createGoogleAdminRosterAdapter(
      readGoogleAdminRosterConfiguration(),
    );
    return Object.freeze({
      handler: createSyncRosterHandler({
        store: createDrizzleRosterSyncStore(connection.db),
        adapter,
        alerts,
      }),
      authorizer: createScheduledRosterSyncAuthorizer(),
      close: connection.close,
    });
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

const defaultAlerts = createStructuredRosterSyncAlertSink();
const defaultCleanupFailures: RosterSyncCleanupFailureSink = Object.freeze({
  notify(failure: RosterSyncCleanupFailure): void {
    console.error(
      JSON.stringify({ event: 'roster-sync-cleanup-failure', ...failure }),
    );
  },
});
const defaultHandler = createRosterSyncRouteHandler({
  readExpectedBearerToken,
  createRuntime: () => createDefaultRuntime(defaultAlerts),
  alerts: defaultAlerts,
  cleanupFailures: defaultCleanupFailures,
  clock: () => new Date(),
});

/** Authenticated EventBridge entry point. No other HTTP method can mutate. */
export async function handleRosterSyncPost(
  request: Request,
): Promise<Response> {
  return defaultHandler(request);
}
