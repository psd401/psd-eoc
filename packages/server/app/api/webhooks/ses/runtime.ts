import { createHash } from 'node:crypto';

import {
  ChannelAttemptSchema,
  EndpointStatusRecordSchema,
  RecordDeliveryEvidenceInputSchema,
  RecordEndpointStatusInputSchema,
  UuidSchema,
  executeCapability,
  registerCapabilityHandler,
  type Actor,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type ChannelAttempt,
  type DeliveryEvidence,
  type EndpointStatusRecord,
  type RecordDeliveryEvidenceInput,
  type RecordEndpointStatusInput,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import { and, desc, eq, like, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseQuery,
} from '../../../../db/client';
import {
  channelAttempts,
  endpointStatusRecords,
  idempotencyRecords,
  notificationIntents,
} from '../../../../db/schema';
import {
  DeliveryStateError,
  createDrizzleDeliveryEvidenceStore,
  type DeliveryEvidenceStore,
} from '../../internal/delivery-state/runtime';
import {
  SnsSignatureError,
  canonicalSnsEnvelopeDigest,
  parseSnsEnvelope,
  verifySnsSignature,
  type SnsNotificationEnvelope,
} from '../../../../../../workers/email/sns-signature';
import {
  parseSesEvent,
  type ParsedSesEvent,
} from '../../../../../../workers/email/ses-events';

export const SES_SNS_TOPIC_ARN_ENV = 'PSD_EOC_SES_SNS_TOPIC_ARN' as const;
export const SES_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;

/**
 * The one SNS topic this webhook accepts, matched by shape rather than pinned
 * to one district's account and region. Which topic exactly is still pinned —
 * by `PSD_EOC_SES_SNS_TOPIC_ARN`, checked against this — so a notification from
 * any other topic is still refused.
 */
const EXPECTED_TOPIC_ARN =
  /^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/u;
const CALLBACK_LEASE_MILLISECONDS = 5 * 60_000;
const CALLBACK_LOCK_NAMESPACE = 4_013;
const CALLBACK_GENERATION_WIDTH = 6;
const CALLBACK_MAX_GENERATION = 10 ** CALLBACK_GENERATION_WIDTH - 1;
const CALLBACK_CAPABILITY_ID = 'record-delivery-evidence' as const;
const CALLBACK_PRINCIPAL = Object.freeze({
  kind: 'system' as const,
  serviceId: 'amazon-sns',
});
const CALLBACK_PRINCIPAL_DIGEST = createHash('sha256')
  .update('psd-eoc:system:amazon-sns:ses-webhook:v1', 'utf8')
  .digest('hex');

type AttemptEvidenceInput = RecordDeliveryEvidenceInput &
  Readonly<{
    subject: Readonly<{ kind: 'attempt'; attemptId: string }>;
    state:
      | 'attempted'
      | 'provider-accepted'
      | 'delivered'
      | 'failed'
      | 'expired'
      | 'unknown';
  }>;

export type SesCallbackClaim =
  | Readonly<{ kind: 'acquired'; recordId: string; leaseToken: string }>
  | Readonly<{ kind: 'replay' }>
  | Readonly<{ kind: 'in-progress' }>
  | Readonly<{ kind: 'conflict' }>;

export interface SesWebhookStore {
  claimCallback(
    messageId: string,
    requestDigest: string,
  ): Promise<SesCallbackClaim>;
  completeCallback(
    recordId: string,
    leaseToken: string,
    messageId: string,
  ): Promise<void>;
  failCallback(
    recordId: string,
    leaseToken: string,
    reasonCode: string,
  ): Promise<void>;
  loadAttempt(attemptId: string): Promise<ChannelAttempt | null>;
  recordAttemptEvidence(
    attempt: ChannelAttempt,
    input: AttemptEvidenceInput,
  ): Promise<DeliveryEvidence>;
  recordEndpointStatus(
    attempt: ChannelAttempt,
    input: RecordEndpointStatusInput,
    semanticIdempotencyKey: string,
  ): Promise<EndpointStatusRecord>;
  close(): Promise<void>;
}

export interface SesWebhookRouteDependencies {
  readonly readExpectedTopicArn: () => string;
  readonly verifySignature: (
    envelope: SnsNotificationEnvelope,
  ) => Promise<void>;
  readonly createStore: () => Promise<SesWebhookStore>;
}

export type SesWebhookRouteHandler = (request: Request) => Promise<Response>;

interface SesWebhookCapabilityContext {
  readonly actor: Actor;
  readonly source: 'webhook';
  readonly transport: 'webhook-delivery';
  readonly signatureVerified: true;
  readonly topicArn: string;
  readonly snsMessageId: string;
  readonly attempt: ChannelAttempt;
}

type WebhookRequestErrorStatus = 400 | 401 | 409 | 413 | 415;

class SesWebhookRequestError extends Error {
  public constructor(
    public readonly status: WebhookRequestErrorStatus,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SesWebhookRequestError';
  }
}

class SesWebhookPersistenceError extends Error {
  public constructor() {
    super('The SES callback could not be persisted safely.');
    this.name = 'SesWebhookPersistenceError';
  }
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

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: responseHeaders(headers) },
  );
}

function assertContentType(request: Request): void {
  if (request.headers.has('content-encoding')) {
    throw new SesWebhookRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Compressed SNS callback bodies are not accepted.',
    );
  }
  const contentType = request.headers.get('content-type')?.trim() ?? '';
  if (
    !/^(?:text\/plain|application\/json)(?:;\s*charset=utf-8)?$/iu.test(
      contentType,
    )
  ) {
    throw new SesWebhookRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'SNS callbacks must use plain text or JSON with optional UTF-8 charset.',
    );
  }
}

function declaredContentLength(request: Request): void {
  const value = request.headers.get('content-length');
  if (value === null) return;
  if (!/^\d+$/u.test(value)) {
    throw new SesWebhookRequestError(
      400,
      'INVALID_SNS_ENVELOPE',
      'The callback Content-Length was invalid.',
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > SES_WEBHOOK_MAX_BODY_BYTES) {
    throw new SesWebhookRequestError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The callback exceeded the configured size limit.',
    );
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  assertContentType(request);
  declaredContentLength(request);
  if (request.body === null) {
    throw new SesWebhookRequestError(
      400,
      'INVALID_SNS_ENVELOPE',
      'The callback body was missing.',
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
      if (totalBytes > SES_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SesWebhookRequestError(
          413,
          'PAYLOAD_TOO_LARGE',
          'The callback exceeded the configured size limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A canceled stream may already have released its lock.
    }
  }
  if (totalBytes === 0) {
    throw new SesWebhookRequestError(
      400,
      'INVALID_SNS_ENVELOPE',
      'The callback body was empty.',
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
    throw new SesWebhookRequestError(
      400,
      'INVALID_SNS_ENVELOPE',
      'The callback body was not valid UTF-8.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SesWebhookRequestError(
      400,
      'INVALID_SNS_ENVELOPE',
      'The callback body was malformed JSON.',
    );
  }
}

function assertSnsHeaders(
  request: Request,
  envelope: SnsNotificationEnvelope,
): void {
  if (
    request.headers.get('x-amz-sns-message-type') !== envelope.Type ||
    request.headers.get('x-amz-sns-message-id') !== envelope.MessageId ||
    request.headers.get('x-amz-sns-topic-arn') !== envelope.TopicArn
  ) {
    throw new SesWebhookRequestError(
      400,
      'SNS_HEADER_MISMATCH',
      'SNS callback headers did not match the signed envelope.',
    );
  }
}

function readExpectedTopicArn(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[SES_SNS_TOPIC_ARN_ENV];
  if (value === undefined || !EXPECTED_TOPIC_ARN.test(value)) {
    throw new SesWebhookPersistenceError();
  }
  return value;
}

function attemptEvidenceInput(
  value: RecordDeliveryEvidenceInput,
  attemptId: string,
): AttemptEvidenceInput {
  const parsed = RecordDeliveryEvidenceInputSchema.parse(value);
  if (
    parsed.subject.kind !== 'attempt' ||
    parsed.subject.attemptId !== attemptId ||
    parsed.state === 'accepted' ||
    parsed.state === 'recorded'
  ) {
    throw new SesWebhookRequestError(
      400,
      'SES_CORRELATION_INVALID',
      'The signed SES event did not match its immutable attempt.',
    );
  }
  return parsed as AttemptEvidenceInput;
}

function assertEventMatchesAttempt(
  event: ParsedSesEvent,
  attempt: ChannelAttempt,
): void {
  const endpointStatus = event.endpointStatus;
  if (
    attempt.id !== event.attemptId ||
    attempt.endpointId !== event.endpointId ||
    attempt.rosterSnapshotId !== event.rosterSnapshotId ||
    attempt.recipientId !== event.recipientId ||
    attempt.eventKind !== event.eventKind ||
    attempt.channel !== 'email' ||
    attempt.templateMode !== event.templateMode ||
    (endpointStatus !== null &&
      (endpointStatus.rosterSnapshotId !== attempt.rosterSnapshotId ||
        endpointStatus.recipientId !== attempt.recipientId ||
        endpointStatus.endpointId !== attempt.endpointId))
  ) {
    throw new SesWebhookRequestError(
      400,
      'SES_CORRELATION_INVALID',
      'The signed SES event did not match its immutable attempt.',
    );
  }
}

function capabilityContext(
  topicArn: string,
  snsMessageId: string,
  attempt: ChannelAttempt,
): SesWebhookCapabilityContext {
  return Object.freeze({
    actor: CALLBACK_PRINCIPAL,
    source: 'webhook',
    transport: 'webhook-delivery',
    signatureVerified: true,
    topicArn,
    snsMessageId,
    attempt,
  });
}

function authorizeWebhookCapability(
  request: CapabilityAuthorizationRequest<
    RegisteredCapabilityId,
    SesWebhookCapabilityContext
  >,
): void {
  const context = request.context;
  const baseAllowed =
    (request.definition.id === 'record-delivery-evidence' ||
      request.definition.id === 'record-endpoint-status') &&
    request.definition.operation === 'mutation' &&
    request.definition.safetyEffect === 'none' &&
    request.invocationPolicy.agentGrantable === false &&
    request.invocationPolicy.principalKinds.includes('system') &&
    request.invocationPolicy.sources.includes('webhook') &&
    request.humanActionRequirement.actionIds.length === 0 &&
    request.humanActionRequirement.consequenceDigest === null &&
    context.actor.kind === 'system' &&
    context.actor.serviceId === CALLBACK_PRINCIPAL.serviceId &&
    context.source === 'webhook' &&
    context.transport === 'webhook-delivery' &&
    context.signatureVerified === true &&
    EXPECTED_TOPIC_ARN.test(context.topicArn) &&
    UuidSchema.safeParse(context.snsMessageId).success &&
    context.attempt.channel === 'email';
  if (!baseAllowed) {
    throw new SesWebhookRequestError(
      401,
      'SES_WEBHOOK_UNAUTHORIZED',
      'The SES callback capability was not authorized.',
    );
  }

  if (request.definition.id === 'record-delivery-evidence') {
    const input = RecordDeliveryEvidenceInputSchema.safeParse(request.input);
    if (
      !input.success ||
      input.data.subject.kind !== 'attempt' ||
      input.data.subject.attemptId !== context.attempt.id
    ) {
      throw new SesWebhookRequestError(
        401,
        'SES_WEBHOOK_UNAUTHORIZED',
        'The SES callback capability was not authorized.',
      );
    }
    return;
  }

  const input = RecordEndpointStatusInputSchema.safeParse(request.input);
  if (
    !input.success ||
    input.data.rosterSnapshotId !== context.attempt.rosterSnapshotId ||
    input.data.recipientId !== context.attempt.recipientId ||
    input.data.endpointId !== context.attempt.endpointId
  ) {
    throw new SesWebhookRequestError(
      401,
      'SES_WEBHOOK_UNAUTHORIZED',
      'The SES callback capability was not authorized.',
    );
  }
}

export function createSesWebhookAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<SesWebhookCapabilityContext>
> {
  return Object.freeze({ authorize: authorizeWebhookCapability });
}

async function executeMappedEvent(
  store: SesWebhookStore,
  event: ParsedSesEvent,
  envelope: SnsNotificationEnvelope,
  attempt: ChannelAttempt,
): Promise<void> {
  const context = capabilityContext(
    envelope.TopicArn,
    envelope.MessageId,
    attempt,
  );
  const authorizer = createSesWebhookAuthorizer();

  if (event.endpointStatus !== null) {
    const endpointInput = RecordEndpointStatusInputSchema.parse(
      event.endpointStatus,
    );
    const endpointHandler = registerCapabilityHandler(
      'record-endpoint-status',
      (input) =>
        store.recordEndpointStatus(
          attempt,
          input,
          `${event.mailMessageId}:${event.eventType}:${input.reasonCode}`,
        ),
    );
    await executeCapability(endpointHandler, endpointInput, {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer,
    });
  }

  if (event.evidence !== null) {
    const evidenceInput = attemptEvidenceInput(event.evidence, attempt.id);
    const evidenceHandler = registerCapabilityHandler(
      'record-delivery-evidence',
      (input) =>
        store.recordAttemptEvidence(
          attempt,
          attemptEvidenceInput(input, attempt.id),
        ),
    );
    await executeCapability(evidenceHandler, evidenceInput, {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer,
    });
  }
}

/**
 * POST-only SNS adapter. Signature and topic verification finish before the
 * database opens, and every domain write crosses executeCapability.
 */
export function createSesWebhookRouteHandler(
  dependencies: SesWebhookRouteDependencies,
): SesWebhookRouteHandler {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return errorResponse(
        405,
        'METHOD_NOT_ALLOWED',
        'This endpoint accepts signed SNS POST callbacks only.',
        { Allow: 'POST' },
      );
    }

    let expectedTopicArn: string;
    try {
      expectedTopicArn = dependencies.readExpectedTopicArn();
    } catch {
      return errorResponse(
        503,
        'SES_WEBHOOK_UNAVAILABLE',
        'SES callback ingestion is not configured.',
      );
    }

    let envelope: SnsNotificationEnvelope;
    try {
      envelope = parseSnsEnvelope(
        await readBoundedJson(request),
        expectedTopicArn,
      );
      assertSnsHeaders(request, envelope);
    } catch (error) {
      if (error instanceof SesWebhookRequestError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(
        400,
        'INVALID_SNS_ENVELOPE',
        'The callback did not match the required SNS envelope.',
      );
    }

    try {
      await dependencies.verifySignature(envelope);
    } catch (error) {
      if (
        error instanceof SnsSignatureError &&
        error.code === 'CERTIFICATE_UNAVAILABLE'
      ) {
        return errorResponse(
          503,
          'SNS_VERIFICATION_UNAVAILABLE',
          'SNS callback authentication is temporarily unavailable.',
          { 'Retry-After': '5' },
        );
      }
      return errorResponse(
        401,
        'SNS_SIGNATURE_INVALID',
        'The SNS callback signature could not be verified.',
      );
    }

    let event: ParsedSesEvent;
    try {
      event = parseSesEvent(envelope.Message, {
        snsMessageId: envelope.MessageId,
      });
    } catch {
      return errorResponse(
        400,
        'INVALID_SES_EVENT',
        'The signed callback was not a supported SES event.',
      );
    }

    let store: SesWebhookStore | undefined;
    let acquiredRecordId: string | undefined;
    let acquiredLeaseToken: string | undefined;
    try {
      store = await dependencies.createStore();
      const claim = await store.claimCallback(
        envelope.MessageId,
        canonicalSnsEnvelopeDigest(envelope),
      );
      if (claim.kind === 'replay') {
        // Acknowledge the transport so SNS does not report a delivery error,
        // while rejecting the duplicate before any domain capability runs.
        return new Response(null, {
          status: 204,
          headers: responseHeaders(),
        });
      }
      if (claim.kind === 'in-progress') {
        return errorResponse(
          503,
          'SNS_CALLBACK_IN_PROGRESS',
          'The SNS callback is already being processed.',
          { 'Retry-After': '5' },
        );
      }
      if (claim.kind === 'conflict') {
        return errorResponse(
          409,
          'SNS_MESSAGE_ID_CONFLICT',
          'The SNS message identity conflicts with retained evidence.',
        );
      }
      acquiredRecordId = claim.recordId;
      acquiredLeaseToken = claim.leaseToken;

      const attempt = await store.loadAttempt(event.attemptId);
      if (attempt === null) {
        throw new SesWebhookRequestError(
          400,
          'SES_ATTEMPT_NOT_FOUND',
          'The signed SES event did not identify a retained attempt.',
        );
      }
      assertEventMatchesAttempt(event, attempt);
      await executeMappedEvent(store, event, envelope, attempt);
      await store.completeCallback(
        acquiredRecordId,
        acquiredLeaseToken,
        envelope.MessageId,
      );
      return new Response(null, {
        status: 204,
        headers: responseHeaders(),
      });
    } catch (error) {
      if (
        store !== undefined &&
        acquiredRecordId !== undefined &&
        acquiredLeaseToken !== undefined
      ) {
        const reasonCode =
          error instanceof SesWebhookRequestError ||
          error instanceof DeliveryStateError
            ? error.code
            : 'SES_CALLBACK_PROCESSING_FAILED';
        await store
          .failCallback(acquiredRecordId, acquiredLeaseToken, reasonCode)
          .catch(() => undefined);
      }
      if (error instanceof SesWebhookRequestError) {
        return errorResponse(error.status, error.code, error.message);
      }
      if (error instanceof DeliveryStateError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(
        503,
        'SES_WEBHOOK_UNAVAILABLE',
        'SES callback persistence failed safely.',
      );
    } finally {
      await store?.close().catch(() => undefined);
    }
  };
}

type WebhookQueryDatabase = DatabaseQuery;
type ChannelAttemptRow = typeof channelAttempts.$inferSelect;
type EndpointStatusRow = typeof endpointStatusRecords.$inferSelect;
type DeliveryTestIntentRow = Readonly<{
  deliveryTestTargetSetId: string | null;
  deliveryTestTargetSetVersion: number | null;
  deliveryTestEndpointReferenceDigest: string | null;
}>;

function webhookQueryDatabase(database: unknown): WebhookQueryDatabase {
  return database as WebhookQueryDatabase;
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new SesWebhookPersistenceError();
  }
  return date.toISOString();
}

function deliveryTestFromIntentRow(
  row: DeliveryTestIntentRow,
): ChannelAttempt['deliveryTest'] {
  const targetSetId = row.deliveryTestTargetSetId;
  const targetSetVersion = row.deliveryTestTargetSetVersion;
  const endpointReferenceDigest = row.deliveryTestEndpointReferenceDigest;
  if (
    targetSetId === null &&
    targetSetVersion === null &&
    endpointReferenceDigest === null
  ) {
    return null;
  }
  if (
    targetSetId === null ||
    targetSetVersion === null ||
    endpointReferenceDigest === null
  ) {
    throw new SesWebhookPersistenceError();
  }
  return {
    purpose: 'monthly-live-delivery-test',
    targetSet: {
      id: targetSetId,
      version: targetSetVersion,
    },
    endpointReferenceDigest,
  };
}

function attemptFromRow(
  row: ChannelAttemptRow,
  intent: DeliveryTestIntentRow,
): ChannelAttempt {
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
    deliveryTest: deliveryTestFromIntentRow(intent),
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    channel: row.channel,
    attemptNumber: row.attemptNumber,
    attemptedAt: dateIso(row.attemptedAt),
  });
}

function endpointStatusFromRow(row: EndpointStatusRow): EndpointStatusRecord {
  return EndpointStatusRecordSchema.parse({
    id: row.id,
    rosterSnapshotId: row.rosterSnapshotId,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    status: row.status,
    reasonCode: row.reasonCode,
    recordedAt: dateIso(row.recordedAt),
  });
}

async function readDatabaseTime(database: WebhookQueryDatabase): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) throw new SesWebhookPersistenceError();
  return new Date(dateIso(row.value));
}

function deterministicUuid(value: string): string {
  const hexadecimal = createHash('sha256').update(value, 'utf8').digest('hex');
  const characters = [...hexadecimal.slice(0, 32)];
  characters[12] = '5';
  characters[16] = (
    (Number.parseInt(characters[16] ?? '0', 16) & 0x3) |
    0x8
  ).toString(16);
  const compact = characters.join('');
  return UuidSchema.parse(
    `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`,
  );
}

async function claimCallback(
  database: Database,
  messageId: string,
  requestDigest: string,
): Promise<SesCallbackClaim> {
  const parsedMessageId = UuidSchema.parse(messageId);
  if (!/^[a-f0-9]{64}$/u.test(requestDigest)) {
    throw new SesWebhookPersistenceError();
  }
  const keyPrefix = `ses-sns:${parsedMessageId}:lease:`;

  function generationKey(generation: number): string {
    if (
      !Number.isInteger(generation) ||
      generation < 0 ||
      generation > CALLBACK_MAX_GENERATION
    ) {
      throw new SesWebhookPersistenceError();
    }
    return `${keyPrefix}${generation
      .toString()
      .padStart(CALLBACK_GENERATION_WIDTH, '0')}`;
  }

  function generationFromKey(key: string): number {
    const suffix = key.slice(keyPrefix.length);
    if (
      !key.startsWith(keyPrefix) ||
      !/^\d{6}$/u.test(suffix) ||
      Number(suffix) > CALLBACK_MAX_GENERATION
    ) {
      throw new SesWebhookPersistenceError();
    }
    return Number(suffix);
  }

  return database.transaction(async (transaction) => {
    const query = webhookQueryDatabase(transaction);
    await query.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${keyPrefix}, ${CALLBACK_LOCK_NAMESPACE}))`,
    );
    const now = await readDatabaseTime(query);
    const [latest] = await query
      .select({
        id: idempotencyRecords.id,
        key: idempotencyRecords.key,
        requestDigest: idempotencyRecords.requestDigest,
        status: idempotencyRecords.status,
        createdAt: idempotencyRecords.createdAt,
      })
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.capabilityId, CALLBACK_CAPABILITY_ID),
          eq(idempotencyRecords.principalDigest, CALLBACK_PRINCIPAL_DIGEST),
          like(idempotencyRecords.key, `${keyPrefix}%`),
        ),
      )
      .for('update')
      .orderBy(desc(idempotencyRecords.key))
      .limit(1);

    if (latest !== undefined && latest.requestDigest !== requestDigest) {
      return Object.freeze({ kind: 'conflict' });
    }

    if (latest?.status === 'completed') {
      return Object.freeze({ kind: 'replay' });
    }

    let nextGeneration = 0;
    if (latest !== undefined) {
      const latestGeneration = generationFromKey(latest.key);
      nextGeneration = latestGeneration + 1;
      if (latest.status === 'in-progress') {
        const isStale =
          now.getTime() - latest.createdAt.getTime() >=
          CALLBACK_LEASE_MILLISECONDS;
        if (!isStale) {
          return Object.freeze({ kind: 'in-progress' });
        }
        const [expired] = await query
          .update(idempotencyRecords)
          .set({
            status: 'failed',
            completedAt: now,
            resultReference: `ses-sns-lease-expired:${generationKey(
              nextGeneration,
            )}`,
          })
          .where(
            and(
              eq(idempotencyRecords.id, latest.id),
              eq(idempotencyRecords.status, 'in-progress'),
            ),
          )
          .returning({ id: idempotencyRecords.id });
        if (expired === undefined) throw new SesWebhookPersistenceError();
      } else if (latest.status !== 'failed') {
        throw new SesWebhookPersistenceError();
      }
    }

    const [inserted] = await query
      .insert(idempotencyRecords)
      .values({
        capabilityId: CALLBACK_CAPABILITY_ID,
        principal: CALLBACK_PRINCIPAL,
        principalDigest: CALLBACK_PRINCIPAL_DIGEST,
        key: generationKey(nextGeneration),
        requestDigest,
        status: 'in-progress',
        createdAt: now,
      })
      .returning({ id: idempotencyRecords.id });
    if (inserted === undefined) throw new SesWebhookPersistenceError();
    return Object.freeze({
      kind: 'acquired',
      recordId: inserted.id,
      leaseToken: inserted.id,
    });
  });
}

async function completeCallback(
  database: Database,
  recordId: string,
  leaseToken: string,
  messageId: string,
): Promise<void> {
  const persistedRecordId = UuidSchema.parse(recordId);
  if (UuidSchema.parse(leaseToken) !== persistedRecordId) {
    throw new SesWebhookPersistenceError();
  }
  const query = webhookQueryDatabase(database);
  const now = await readDatabaseTime(query);
  const [completed] = await query
    .update(idempotencyRecords)
    .set({
      status: 'completed',
      completedAt: now,
      resultReference: `ses-sns:${UuidSchema.parse(messageId)}`,
    })
    .where(
      and(
        eq(idempotencyRecords.id, persistedRecordId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (completed === undefined) throw new SesWebhookPersistenceError();
}

async function failCallback(
  database: Database,
  recordId: string,
  leaseToken: string,
  reasonCode: string,
): Promise<void> {
  const persistedRecordId = UuidSchema.parse(recordId);
  if (UuidSchema.parse(leaseToken) !== persistedRecordId) {
    throw new SesWebhookPersistenceError();
  }
  if (!/^[A-Z0-9_]{1,100}$/u.test(reasonCode)) {
    throw new SesWebhookPersistenceError();
  }
  const query = webhookQueryDatabase(database);
  const now = await readDatabaseTime(query);
  const [failed] = await query
    .update(idempotencyRecords)
    .set({
      status: 'failed',
      completedAt: now,
      resultReference: `ses-sns-failed:${reasonCode}`,
    })
    .where(
      and(
        eq(idempotencyRecords.id, persistedRecordId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (failed === undefined) throw new SesWebhookPersistenceError();
}

function sameEndpointStatus(
  left: EndpointStatusRecord,
  right: EndpointStatusRecord,
): boolean {
  return (
    left.id === right.id &&
    left.rosterSnapshotId === right.rosterSnapshotId &&
    left.recipientId === right.recipientId &&
    left.endpointId === right.endpointId &&
    left.status === right.status &&
    left.reasonCode === right.reasonCode
  );
}

async function recordEndpointStatus(
  database: Database,
  attempt: ChannelAttempt,
  inputValue: RecordEndpointStatusInput,
  semanticIdempotencyKey: string,
): Promise<EndpointStatusRecord> {
  const input = RecordEndpointStatusInputSchema.parse(inputValue);
  if (
    attempt.channel !== 'email' ||
    input.rosterSnapshotId !== attempt.rosterSnapshotId ||
    input.recipientId !== attempt.recipientId ||
    input.endpointId !== attempt.endpointId
  ) {
    throw new SesWebhookPersistenceError();
  }
  const id = deterministicUuid(
    `ses-endpoint-status:${attempt.id}:${semanticIdempotencyKey}`,
  );
  return database.transaction(async (transaction) => {
    const query = webhookQueryDatabase(transaction);
    await query.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${id}, ${CALLBACK_LOCK_NAMESPACE}))`,
    );
    const [existing] = await query
      .select()
      .from(endpointStatusRecords)
      .where(eq(endpointStatusRecords.id, id))
      .limit(1);
    if (existing !== undefined) {
      const persisted = endpointStatusFromRow(existing);
      if (
        persisted.rosterSnapshotId !== input.rosterSnapshotId ||
        persisted.recipientId !== input.recipientId ||
        persisted.endpointId !== input.endpointId ||
        persisted.status !== input.status ||
        persisted.reasonCode !== input.reasonCode
      ) {
        throw new SesWebhookPersistenceError();
      }
      return persisted;
    }

    const recordedAt = await readDatabaseTime(query);
    const record = EndpointStatusRecordSchema.parse({
      id,
      rosterSnapshotId: input.rosterSnapshotId,
      recipientId: input.recipientId,
      endpointId: input.endpointId,
      status: input.status,
      reasonCode: input.reasonCode,
      recordedAt: recordedAt.toISOString(),
    });
    await query.insert(endpointStatusRecords).values({
      id: record.id,
      rosterSnapshotId: record.rosterSnapshotId,
      recipientId: record.recipientId,
      endpointId: record.endpointId,
      population: attempt.rosterPopulation,
      channel: 'email',
      status: record.status,
      reasonCode: record.reasonCode,
      recordedAt,
    });
    const [inserted] = await query
      .select()
      .from(endpointStatusRecords)
      .where(eq(endpointStatusRecords.id, id))
      .limit(1);
    if (inserted === undefined) throw new SesWebhookPersistenceError();
    const persisted = endpointStatusFromRow(inserted);
    if (!sameEndpointStatus(record, persisted)) {
      throw new SesWebhookPersistenceError();
    }
    return persisted;
  });
}

/** Production persistence boundary, exported for database-backed verification. */
export function createDrizzleSesWebhookStore(
  database: Database,
  close: () => Promise<void> = async () => undefined,
): SesWebhookStore {
  const evidenceStore: DeliveryEvidenceStore =
    createDrizzleDeliveryEvidenceStore(database);
  return Object.freeze({
    claimCallback: (messageId: string, requestDigest: string) =>
      claimCallback(database, messageId, requestDigest),
    completeCallback: (
      recordId: string,
      leaseToken: string,
      messageId: string,
    ) => completeCallback(database, recordId, leaseToken, messageId),
    failCallback: (recordId: string, leaseToken: string, reasonCode: string) =>
      failCallback(database, recordId, leaseToken, reasonCode),
    async loadAttempt(attemptId: string): Promise<ChannelAttempt | null> {
      const [row] = await database
        .select({
          attempt: channelAttempts,
          deliveryTestTargetSetId: notificationIntents.deliveryTestTargetSetId,
          deliveryTestTargetSetVersion:
            notificationIntents.deliveryTestTargetSetVersion,
          deliveryTestEndpointReferenceDigest:
            notificationIntents.deliveryTestEndpointReferenceDigest,
        })
        .from(channelAttempts)
        .innerJoin(
          notificationIntents,
          eq(notificationIntents.id, channelAttempts.intentId),
        )
        .where(eq(channelAttempts.id, UuidSchema.parse(attemptId)))
        .limit(1);
      return row === undefined
        ? null
        : attemptFromRow(row.attempt, {
            deliveryTestTargetSetId: row.deliveryTestTargetSetId,
            deliveryTestTargetSetVersion: row.deliveryTestTargetSetVersion,
            deliveryTestEndpointReferenceDigest:
              row.deliveryTestEndpointReferenceDigest,
          });
    },
    recordAttemptEvidence(
      attempt: ChannelAttempt,
      input: AttemptEvidenceInput,
    ): Promise<DeliveryEvidence> {
      return evidenceStore.recordAttemptEvidence({ attempt, evidence: input });
    },
    recordEndpointStatus: (
      attempt: ChannelAttempt,
      input: RecordEndpointStatusInput,
      semanticIdempotencyKey: string,
    ) => recordEndpointStatus(database, attempt, input, semanticIdempotencyKey),
    close,
  });
}

async function createDefaultStore(): Promise<SesWebhookStore> {
  const connection = createDatabaseClient(readDatabaseConfig());
  return createDrizzleSesWebhookStore(connection.db, connection.close);
}

const defaultHandler = createSesWebhookRouteHandler({
  readExpectedTopicArn,
  verifySignature: (envelope) => verifySnsSignature(envelope),
  createStore: createDefaultStore,
});

/** Signed SNS entry point; it cannot reach an event-lifecycle capability. */
export function handleSesWebhookPost(request: Request): Promise<Response> {
  return defaultHandler(request);
}
