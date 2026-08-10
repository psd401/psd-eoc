import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  DeliveryTruthTransitionSchema,
  IdempotencyKeySchema,
  RecordDeliveryEvidenceInputSchema,
  UuidSchema,
  executeCapability,
  registerCapabilityHandler,
  type Actor,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type ChannelAttempt,
  type DeliveryEvidence,
  type RecordDeliveryEvidenceInput,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type PostgresDatabase,
} from '../../../../db/client';
import { channelAttempts, deliveryEvidence } from '../../../../db/schema';

export const dynamic = 'force-dynamic';

/** Worker-only bearer; it is deliberately unrelated to any database secret. */
export const DELIVERY_STATE_WORKER_TOKEN_ENV =
  'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN' as const;
export const DELIVERY_STATE_MAX_BODY_BYTES = 32 * 1024;
export const DELIVERY_STATE_WORKER_SERVICE_ID =
  'notification-delivery-worker' as const;

const ATTEMPT_LOCK_NAMESPACE = 4_011;

const DeliveryStateWriteRequestSchema = z
  .object({
    attempt: ChannelAttemptSchema,
    evidence: RecordDeliveryEvidenceInputSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.evidence.subject.kind !== 'attempt' ||
      request.evidence.subject.attemptId !== request.attempt.id ||
      ['accepted', 'recorded'].includes(request.evidence.state)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence must belong to the supplied immutable attempt.',
        path: ['evidence', 'subject'],
      });
    }
  })
  .readonly();

type AttemptState = Exclude<
  RecordDeliveryEvidenceInput['state'],
  'accepted' | 'recorded'
>;

export type AttemptEvidenceInput = RecordDeliveryEvidenceInput &
  Readonly<{
    subject: Readonly<{ kind: 'attempt'; attemptId: string }>;
    state: AttemptState;
  }>;

/** Strict transport composition of canonical contracts; it adds no domain type. */
export interface DeliveryStateWriteRequest {
  readonly attempt: ChannelAttempt;
  readonly evidence: AttemptEvidenceInput;
}

export type DeliveryStateErrorCode =
  | 'ATTEMPT_CONFLICT'
  | 'DELIVERY_STATE_CONFIGURATION_INVALID'
  | 'DELIVERY_STATE_PERSISTENCE_INVALID'
  | 'DELIVERY_STATE_UNAUTHORIZED'
  | 'INITIAL_ATTEMPT_EVIDENCE_REQUIRED'
  | 'INVALID_DELIVERY_TRANSITION';

/** Public-safe failure which never reflects recipient or provider payloads. */
export class DeliveryStateError extends Error {
  public constructor(
    public readonly code: DeliveryStateErrorCode,
    public readonly status: 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryStateError';
  }
}

export interface DeliveryEvidenceStore {
  recordAttemptEvidence(
    request: DeliveryStateWriteRequest,
  ): Promise<DeliveryEvidence>;
}

/** Trusted context created only after route-specific worker authentication. */
export interface DeliveryEvidenceCapabilityContext {
  readonly actor: Actor;
  readonly source: 'worker';
  readonly transport: 'worker-execution';
  readonly workerAuthenticated: true;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly attempt: ChannelAttempt;
}

export interface DeliveryStateRouteRuntime {
  readonly handler: RegisteredCapabilityHandler<
    'record-delivery-evidence',
    DeliveryEvidenceCapabilityContext
  >;
  readonly authorizer: CapabilityExecutionAuthorizer<DeliveryEvidenceCapabilityContext>;
  close(): Promise<void>;
}

export interface DeliveryStateRouteDependencies {
  readonly readExpectedBearerToken: () => string;
  readonly createRuntime: () => Promise<DeliveryStateRouteRuntime>;
}

export type DeliveryStateRouteHandler = (request: Request) => Promise<Response>;

class DeliveryStateRouteRequestError extends Error {
  public constructor(
    public readonly status: 400 | 413 | 415,
    public readonly code:
      | 'INVALID_DELIVERY_STATE_REQUEST'
      | 'PAYLOAD_TOO_LARGE'
      | 'UNSUPPORTED_MEDIA_TYPE',
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryStateRouteRequestError';
  }
}

type DeliveryStateQueryDatabase = PostgresDatabase;
type ChannelAttemptRow = typeof channelAttempts.$inferSelect;
type DeliveryEvidenceRow = typeof deliveryEvidence.$inferSelect;

function deliveryStateQueryDatabase(
  database: unknown,
): DeliveryStateQueryDatabase {
  // Both supported PostgreSQL transports expose this schema-aware surface.
  // The direct-driver type avoids a union of overloaded method signatures.
  return database as DeliveryStateQueryDatabase;
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new DeliveryStateError(
      'DELIVERY_STATE_PERSISTENCE_INVALID',
      503,
      'Persisted delivery-state time was invalid.',
    );
  }
  return date.toISOString();
}

function attemptFromRow(row: ChannelAttemptRow): ChannelAttempt {
  return ChannelAttemptSchema.parse({
    id: row.id,
    batchId: row.batchId,
    intentId: row.intentId,
    eventId: row.eventId,
    eventKind: row.eventKind,
    templateMode: row.templateMode,
    purpose: row.purpose,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    channel: row.channel,
    attemptNumber: row.attemptNumber,
    attemptedAt: dateIso(row.attemptedAt),
  });
}

function evidenceFromRow(row: DeliveryEvidenceRow): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: row.id,
    subject:
      row.subjectKind === 'attempt'
        ? { kind: 'attempt', attemptId: row.subjectId }
        : { kind: 'intent', intentId: row.subjectId },
    sequence: row.sequence,
    previousEvidenceId: row.previousEvidenceId,
    state: row.state,
    recordedAt: dateIso(row.recordedAt),
    provider: row.provider,
    providerReference: row.providerReference,
    proof: row.proof,
    reasonCode: row.reasonCode,
    diagnosticDigest: row.diagnosticDigest,
  });
}

function sameAttempt(left: ChannelAttempt, right: ChannelAttempt): boolean {
  return (
    left.id === right.id &&
    left.batchId === right.batchId &&
    left.intentId === right.intentId &&
    left.eventId === right.eventId &&
    left.eventKind === right.eventKind &&
    left.templateMode === right.templateMode &&
    left.purpose === right.purpose &&
    left.eventTypeVersion.id === right.eventTypeVersion.id &&
    left.eventTypeVersion.templateMode ===
      right.eventTypeVersion.templateMode &&
    left.rosterSnapshotId === right.rosterSnapshotId &&
    left.rosterPopulation === right.rosterPopulation &&
    left.recipientId === right.recipientId &&
    left.endpointId === right.endpointId &&
    left.channel === right.channel &&
    left.attemptNumber === right.attemptNumber &&
    Date.parse(left.attemptedAt) === Date.parse(right.attemptedAt)
  );
}

function evidenceMatchesInput(
  evidence: DeliveryEvidence,
  input: AttemptEvidenceInput,
): boolean {
  return (
    evidence.subject.kind === 'attempt' &&
    evidence.subject.attemptId === input.subject.attemptId &&
    evidence.state === input.state &&
    evidence.provider === input.provider &&
    evidence.providerReference === input.providerReference &&
    JSON.stringify(evidence.proof) === JSON.stringify(input.proof) &&
    evidence.reasonCode === input.reasonCode &&
    evidence.diagnosticDigest === input.diagnosticDigest
  );
}

async function readDatabaseTime(
  database: DeliveryStateQueryDatabase,
): Promise<Date> {
  const [row] = await database.execute<{ value: Date | string }>(
    sql`select clock_timestamp() as value`,
  );
  const value = row?.value;
  if (value === undefined) {
    throw new DeliveryStateError(
      'DELIVERY_STATE_PERSISTENCE_INVALID',
      503,
      'The authoritative delivery-state clock was unavailable.',
    );
  }
  return new Date(dateIso(value));
}

function attemptNaturalKey(attempt: ChannelAttempt): string {
  return `${attempt.batchId}:${attempt.endpointId}:${attempt.attemptNumber}`;
}

async function lockAttemptIdentity(
  database: DeliveryStateQueryDatabase,
  attempt: ChannelAttempt,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`delivery-attempt-natural:${attemptNaturalKey(attempt)}`}, ${ATTEMPT_LOCK_NAMESPACE}))`,
  );
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`delivery-attempt-id:${attempt.id}`}, ${ATTEMPT_LOCK_NAMESPACE}))`,
  );
}

async function loadLatestEvidence(
  database: DeliveryStateQueryDatabase,
  attemptId: string,
): Promise<DeliveryEvidence | null> {
  const [row] = await database
    .select()
    .from(deliveryEvidence)
    .where(
      and(
        eq(deliveryEvidence.subjectKind, 'attempt'),
        eq(deliveryEvidence.attemptId, attemptId),
      ),
    )
    .orderBy(desc(deliveryEvidence.sequence))
    .limit(1);
  return row === undefined ? null : evidenceFromRow(row);
}

async function loadFirstEvidence(
  database: DeliveryStateQueryDatabase,
  attemptId: string,
): Promise<DeliveryEvidence | null> {
  const [row] = await database
    .select()
    .from(deliveryEvidence)
    .where(
      and(
        eq(deliveryEvidence.subjectKind, 'attempt'),
        eq(deliveryEvidence.attemptId, attemptId),
      ),
    )
    .orderBy(asc(deliveryEvidence.sequence))
    .limit(1);
  return row === undefined ? null : evidenceFromRow(row);
}

async function loadMatchingEvidence(
  database: DeliveryStateQueryDatabase,
  input: AttemptEvidenceInput,
): Promise<DeliveryEvidence | null> {
  const rows = await database
    .select()
    .from(deliveryEvidence)
    .where(
      and(
        eq(deliveryEvidence.subjectKind, 'attempt'),
        eq(deliveryEvidence.attemptId, input.subject.attemptId),
        eq(deliveryEvidence.state, input.state),
        input.provider === null
          ? isNull(deliveryEvidence.provider)
          : eq(deliveryEvidence.provider, input.provider),
        input.providerReference === null
          ? isNull(deliveryEvidence.providerReference)
          : eq(deliveryEvidence.providerReference, input.providerReference),
        input.reasonCode === null
          ? isNull(deliveryEvidence.reasonCode)
          : eq(deliveryEvidence.reasonCode, input.reasonCode),
        input.diagnosticDigest === null
          ? isNull(deliveryEvidence.diagnosticDigest)
          : eq(deliveryEvidence.diagnosticDigest, input.diagnosticDigest),
      ),
    )
    .orderBy(asc(deliveryEvidence.sequence));
  return (
    rows
      .map(evidenceFromRow)
      .find((item) => evidenceMatchesInput(item, input)) ?? null
  );
}

async function appendEvidence(
  database: DeliveryStateQueryDatabase,
  input: AttemptEvidenceInput,
  previous: DeliveryEvidence | null,
  uuid: () => string,
): Promise<DeliveryEvidence> {
  const recordedAt = await readDatabaseTime(database);
  const evidence = DeliveryEvidenceSchema.parse({
    id: UuidSchema.parse(uuid()),
    subject: input.subject,
    sequence: (previous?.sequence ?? 0) + 1,
    previousEvidenceId: previous?.id ?? null,
    state: input.state,
    recordedAt: recordedAt.toISOString(),
    provider: input.provider,
    providerReference: input.providerReference,
    proof: input.proof,
    reasonCode: input.reasonCode,
    diagnosticDigest: input.diagnosticDigest,
  });
  await database.insert(deliveryEvidence).values({
    id: evidence.id,
    subjectKind: 'attempt',
    subjectId: input.subject.attemptId,
    intentId: null,
    attemptId: input.subject.attemptId,
    sequence: evidence.sequence,
    previousEvidenceId: evidence.previousEvidenceId,
    state: evidence.state,
    recordedAt,
    provider: evidence.provider,
    providerReference: evidence.providerReference,
    proof: evidence.proof,
    reasonCode: evidence.reasonCode,
    diagnosticDigest: evidence.diagnosticDigest,
  });
  return evidence;
}

export interface DrizzleDeliveryEvidenceStoreOptions {
  readonly uuid?: () => string;
}

/**
 * Stores an immutable attempt and its first fact atomically, or appends one
 * canonical transition. Per-attempt advisory locks make retries deterministic.
 */
export function createDrizzleDeliveryEvidenceStore(
  database: Database,
  options: DrizzleDeliveryEvidenceStoreOptions = {},
): DeliveryEvidenceStore {
  const uuid = options.uuid ?? randomUUID;
  return Object.freeze({
    recordAttemptEvidence(
      requestValue: DeliveryStateWriteRequest,
    ): Promise<DeliveryEvidence> {
      const request = parseDeliveryStateWriteRequest(requestValue);
      return database.transaction(async (transaction) => {
        const query = deliveryStateQueryDatabase(transaction);
        await lockAttemptIdentity(query, request.attempt);

        const [existingById] = await query
          .select()
          .from(channelAttempts)
          .where(eq(channelAttempts.id, request.attempt.id))
          .limit(1);
        const [existingByNaturalKey] = await query
          .select()
          .from(channelAttempts)
          .where(
            and(
              eq(channelAttempts.batchId, request.attempt.batchId),
              eq(channelAttempts.endpointId, request.attempt.endpointId),
              eq(channelAttempts.attemptNumber, request.attempt.attemptNumber),
            ),
          )
          .limit(1);

        if (
          existingByNaturalKey !== undefined &&
          existingByNaturalKey.id !== request.attempt.id
        ) {
          throw new DeliveryStateError(
            'ATTEMPT_CONFLICT',
            409,
            'The immutable attempt identity conflicts with persisted state.',
          );
        }

        if (existingById === undefined) {
          if (request.evidence.state !== 'attempted') {
            throw new DeliveryStateError(
              'INITIAL_ATTEMPT_EVIDENCE_REQUIRED',
              409,
              'An immutable attempt must begin with attempted evidence.',
            );
          }
          await query.insert(channelAttempts).values({
            id: request.attempt.id,
            batchId: request.attempt.batchId,
            intentId: request.attempt.intentId,
            eventId: request.attempt.eventId,
            eventKind: request.attempt.eventKind,
            templateMode: request.attempt.templateMode,
            purpose: request.attempt.purpose,
            eventTypeVersionId: request.attempt.eventTypeVersion.id,
            rosterSnapshotId: request.attempt.rosterSnapshotId,
            rosterPopulation: request.attempt.rosterPopulation,
            recipientId: request.attempt.recipientId,
            endpointId: request.attempt.endpointId,
            channel: request.attempt.channel,
            attemptNumber: request.attempt.attemptNumber,
            attemptedAt: new Date(request.attempt.attemptedAt),
          });
          return appendEvidence(query, request.evidence, null, uuid);
        }

        if (!sameAttempt(attemptFromRow(existingById), request.attempt)) {
          throw new DeliveryStateError(
            'ATTEMPT_CONFLICT',
            409,
            'The immutable attempt does not match persisted state.',
          );
        }

        if (request.evidence.state === 'attempted') {
          const first = await loadFirstEvidence(query, request.attempt.id);
          if (
            first === null ||
            first.sequence !== 1 ||
            !evidenceMatchesInput(first, request.evidence)
          ) {
            throw new DeliveryStateError(
              'DELIVERY_STATE_PERSISTENCE_INVALID',
              503,
              'The immutable attempt has invalid initial evidence.',
            );
          }
          return first;
        }

        const latest = await loadLatestEvidence(query, request.attempt.id);
        if (latest === null) {
          throw new DeliveryStateError(
            'DELIVERY_STATE_PERSISTENCE_INVALID',
            503,
            'The immutable attempt is missing initial evidence.',
          );
        }
        if (evidenceMatchesInput(latest, request.evidence)) {
          return latest;
        }

        // At-least-once worker and provider callbacks may replay an older
        // immutable fact after a later recovery transition. Return the exact
        // retained fact before considering whether the same state would be a
        // valid transition from today's latest evidence; otherwise an older
        // unknown replay could regress provider-accepted truth back to unknown.
        const matching = await loadMatchingEvidence(query, request.evidence);
        if (matching !== null) {
          return matching;
        }

        const transition = DeliveryTruthTransitionSchema.safeParse({
          subjectKind: 'attempt',
          from: latest.state,
          to: request.evidence.state,
        });
        if (!transition.success) {
          throw new DeliveryStateError(
            'INVALID_DELIVERY_TRANSITION',
            409,
            'The requested delivery-state transition is not allowed.',
          );
        }
        return appendEvidence(query, request.evidence, latest, uuid);
      });
    },
  });
}

/** Parses the worker transport without weakening either canonical schema. */
export function parseDeliveryStateWriteRequest(
  value: unknown,
): DeliveryStateWriteRequest {
  const result = DeliveryStateWriteRequestSchema.safeParse(value);
  if (!result.success) {
    throw new DeliveryStateRouteRequestError(
      400,
      'INVALID_DELIVERY_STATE_REQUEST',
      'The delivery-state request did not match the required schema.',
    );
  }
  return result.data as DeliveryStateWriteRequest;
}

/** Registers the only mutation reachable through the worker writeback route. */
export function createRecordDeliveryEvidenceHandler(
  store: DeliveryEvidenceStore,
): Readonly<
  RegisteredCapabilityHandler<
    'record-delivery-evidence',
    DeliveryEvidenceCapabilityContext
  >
> {
  return registerCapabilityHandler(
    'record-delivery-evidence',
    async (input, context) => {
      const request = parseDeliveryStateWriteRequest({
        attempt: context.attempt,
        evidence: input,
      });
      return DeliveryEvidenceSchema.parse(
        await store.recordAttemptEvidence(request),
      );
    },
  );
}

function idempotencyKeyFor(
  attempt: ChannelAttempt,
  evidence: AttemptEvidenceInput,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(evidence), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return IdempotencyKeySchema.parse(`delivery-state:${attempt.id}:${digest}`);
}

function capabilityContextFor(
  request: DeliveryStateWriteRequest,
): DeliveryEvidenceCapabilityContext {
  const actor = Object.freeze({
    kind: 'system' as const,
    serviceId: DELIVERY_STATE_WORKER_SERVICE_ID,
  });
  return Object.freeze({
    actor,
    source: 'worker',
    transport: 'worker-execution',
    workerAuthenticated: true,
    requestId: UuidSchema.parse(request.attempt.id),
    idempotencyKey: idempotencyKeyFor(request.attempt, request.evidence),
    attempt: request.attempt,
  });
}

/** Deny-by-default authorization for the fixed, bearer-authenticated worker. */
export function createDeliveryStateAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<DeliveryEvidenceCapabilityContext>
> {
  return Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        DeliveryEvidenceCapabilityContext
      >,
    ): void {
      const context = request.context;
      const input = RecordDeliveryEvidenceInputSchema.safeParse(request.input);
      if (
        request.definition.id !== 'record-delivery-evidence' ||
        request.definition.operation !== 'mutation' ||
        request.definition.safetyEffect !== 'none' ||
        request.invocationPolicy.agentGrantable ||
        !request.invocationPolicy.principalKinds.includes('system') ||
        !request.invocationPolicy.sources.includes('worker') ||
        context.actor.kind !== 'system' ||
        context.actor.serviceId !== DELIVERY_STATE_WORKER_SERVICE_ID ||
        context.source !== 'worker' ||
        context.transport !== 'worker-execution' ||
        context.workerAuthenticated !== true ||
        request.humanActionRequirement.actionIds.length !== 0 ||
        request.humanActionRequirement.consequenceDigest !== null ||
        !input.success ||
        input.data.subject.kind !== 'attempt' ||
        input.data.subject.attemptId !== context.attempt.id ||
        context.requestId !== context.attempt.id ||
        context.idempotencyKey !==
          idempotencyKeyFor(context.attempt, input.data as AttemptEvidenceInput)
      ) {
        throw new DeliveryStateError(
          'DELIVERY_STATE_UNAUTHORIZED',
          403,
          'The delivery-state invocation was not authorized.',
        );
      }
      ChannelAttemptSchema.parse(context.attempt);
      UuidSchema.parse(context.requestId);
      IdempotencyKeySchema.parse(context.idempotencyKey);
    },
  });
}

/** Constant-time bearer comparison performed before body parsing. */
export function verifyDeliveryStateWorkerToken(
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

/** Reads only the route-specific bearer; no worker receives DB credentials. */
export function readDeliveryStateWorkerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[DELIVERY_STATE_WORKER_TOKEN_ENV];
  if (
    value === undefined ||
    value.length < 32 ||
    value.length > 4_096 ||
    value !== value.trim() ||
    /\s/u.test(value)
  ) {
    throw new DeliveryStateError(
      'DELIVERY_STATE_CONFIGURATION_INVALID',
      503,
      'The delivery-state worker credential is not configured safely.',
    );
  }
  return value;
}

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

function assertJsonContentType(request: Request): void {
  if (request.headers.has('content-encoding')) {
    throw new DeliveryStateRouteRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Compressed request bodies are not accepted.',
    );
  }
  const contentType = request.headers.get('content-type')?.trim() ?? '';
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new DeliveryStateRouteRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json with optional UTF-8 charset.',
    );
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) {
    throw new DeliveryStateRouteRequestError(
      400,
      'INVALID_DELIVERY_STATE_REQUEST',
      'Content-Length was invalid.',
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > DELIVERY_STATE_MAX_BODY_BYTES) {
    throw new DeliveryStateRouteRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The delivery-state request exceeded the size limit.',
    );
  }
  return length;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  declaredContentLength(request);
  if (request.body === null) {
    throw new DeliveryStateRouteRequestError(
      400,
      'INVALID_DELIVERY_STATE_REQUEST',
      'The delivery-state request body was missing.',
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
      if (totalBytes > DELIVERY_STATE_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeliveryStateRouteRequestError(
          413,
          'PAYLOAD_TOO_LARGE',
          'The delivery-state request exceeded the size limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new DeliveryStateRouteRequestError(
      400,
      'INVALID_DELIVERY_STATE_REQUEST',
      'The delivery-state request body was empty.',
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
    throw new DeliveryStateRouteRequestError(
      400,
      'INVALID_DELIVERY_STATE_REQUEST',
      'The delivery-state request was not valid UTF-8.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DeliveryStateRouteRequestError(
      400,
      'INVALID_DELIVERY_STATE_REQUEST',
      'The delivery-state request was malformed JSON.',
    );
  }
}

async function parseRouteRequest(
  request: Request,
): Promise<DeliveryStateWriteRequest> {
  assertJsonContentType(request);
  return parseDeliveryStateWriteRequest(await readBoundedJson(request));
}

/**
 * Builds a POST-only adapter. Authentication is complete before request bytes
 * are read or a database runtime is opened.
 */
export function createDeliveryStateRouteHandler(
  dependencies: DeliveryStateRouteDependencies,
): DeliveryStateRouteHandler {
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
        'DELIVERY_STATE_UNAVAILABLE',
        'Delivery-state writeback is temporarily unavailable.',
      );
    }
    if (
      !verifyDeliveryStateWorkerToken(
        request.headers.get('authorization'),
        expectedToken,
      )
    ) {
      return errorResponse(
        401,
        'UNAUTHENTICATED',
        'A valid delivery-state worker bearer credential is required.',
        { 'WWW-Authenticate': 'Bearer realm="psd-eoc-delivery-state"' },
      );
    }

    let body: DeliveryStateWriteRequest;
    try {
      body = await parseRouteRequest(request);
    } catch (error) {
      if (error instanceof DeliveryStateRouteRequestError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(
        400,
        'INVALID_DELIVERY_STATE_REQUEST',
        'The delivery-state request could not be read.',
      );
    }

    let runtime: DeliveryStateRouteRuntime | undefined;
    try {
      runtime = await dependencies.createRuntime();
      const result = await executeCapability(runtime.handler, body.evidence, {
        context: capabilityContextFor(body),
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: runtime.authorizer,
      });
      return safeJson(200, { result });
    } catch (error) {
      if (error instanceof DeliveryStateError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(
        503,
        'DELIVERY_STATE_UNAVAILABLE',
        'Delivery-state writeback failed safely.',
      );
    } finally {
      if (runtime !== undefined) {
        await runtime.close().catch(() => undefined);
      }
    }
  };
}

async function createDefaultRuntime(): Promise<DeliveryStateRouteRuntime> {
  const connection = createDatabaseClient(readDatabaseConfig());
  try {
    const store = createDrizzleDeliveryEvidenceStore(connection.db);
    return Object.freeze({
      handler: createRecordDeliveryEvidenceHandler(store),
      authorizer: createDeliveryStateAuthorizer(),
      close: connection.close,
    });
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

const defaultHandler = createDeliveryStateRouteHandler({
  readExpectedBearerToken: readDeliveryStateWorkerToken,
  createRuntime: createDefaultRuntime,
});

/** Fixed worker-authenticated entry point; no event mutation is reachable. */
export async function POST(request: Request): Promise<Response> {
  return defaultHandler(request);
}
