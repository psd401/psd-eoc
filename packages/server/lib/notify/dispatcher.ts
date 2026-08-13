import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  DispatchBatchSchema,
  DispatchOutboxResultSchema,
  IdempotencyKeySchema,
  NotificationOutboxMessageSchema,
  OutboxRecordSchema,
  UuidSchema,
  executeCapability as executeCanonicalCapability,
  registerCapabilityHandler,
  type Actor,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type DispatchBatch,
  type DispatchOutboxResult,
  type InvocationSource,
  type NotificationOutboxMessage,
  type OutboxRecord,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import { and, asc, eq, lte, or, sql } from 'drizzle-orm';

import {
  databaseExecuteRows,
  type Database,
  type DatabaseQuery,
} from '../../db/client';
import { isNotificationIntentAuthorizedForCurrentFanout } from './fanout-control';
import {
  dispatchBatches,
  notificationIntentChannels,
  outbox,
} from '../../db/schema';

/** Maximum outbox rows considered by one bounded poll invocation. */
export const MAX_OUTBOX_POLL_SIZE = 100;

/** Maximum durable queue handoff attempts before an outbox becomes failed. */
export const MAX_OUTBOX_DISPATCH_ATTEMPTS = 5;

/** Lease used to fence a dispatcher while it performs external SQS I/O. */
export const DEFAULT_OUTBOX_LEASE_MILLISECONDS = 30_000;

/** First persisted retry delay after a retryable queue failure. */
export const BASE_OUTBOX_BACKOFF_MILLISECONDS = 500;

/** Upper bound for one persisted outbox retry delay. */
export const MAX_OUTBOX_BACKOFF_MILLISECONDS = 30_000;

/** Environment variable containing the central fan-out SQS queue URL. */
export const FANOUT_QUEUE_URL_ENV = 'FANOUT_QUEUE_URL';

const DEFAULT_SQS_TIMEOUT_MILLISECONDS = 10_000;
const MAX_CONTAINER_CREDENTIAL_RESPONSE_BYTES = 32 * 1_024;
const MAX_SQS_RESPONSE_BYTES = 64 * 1_024;
const MAX_SQS_BATCH_PAYLOAD_BYTES = 1_048_576;
const CREDENTIAL_REFRESH_SKEW_MILLISECONDS = 5 * 60 * 1_000;
const SQS_SERVICE = 'sqs';
const AWS_REQUEST_TERMINATOR = 'aws4_request';
const AWS_JSON_CONTENT_TYPE = 'application/x-amz-json-1.0';
const SQS_SEND_BATCH_TARGET = 'AmazonSQS.SendMessageBatch';

/** Closed, non-sensitive dispatcher failure codes safe for persistence. */
export type OutboxDispatcherErrorCode =
  | 'OUTBOX_ALREADY_FAILED'
  | 'OUTBOX_CLAIM_BUSY'
  | 'OUTBOX_CLAIM_LOST'
  | 'OUTBOX_CONFIGURATION_INVALID'
  | 'OUTBOX_DISPATCH_RETRY_EXHAUSTED'
  | 'FANOUT_EMERGENCY_DISABLED'
  | 'OUTBOX_NOT_FOUND'
  | 'OUTBOX_PERSISTENCE_FAILED'
  | 'SQS_AUTHENTICATION_FAILED'
  | 'SQS_BATCH_ENTRY_REJECTED'
  | 'SQS_CREDENTIALS_UNAVAILABLE'
  | 'SQS_REQUEST_FAILED'
  | 'SQS_RESPONSE_INVALID';

/** Public-safe dispatcher error which never retains provider response text. */
export class OutboxDispatcherError extends Error {
  public constructor(
    public readonly code: OutboxDispatcherErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OutboxDispatcherError';
  }
}

/** Whether a failed queue call definitely sent nothing or may have succeeded. */
export type QueueFailureOutcome = 'not-sent' | 'partial' | 'unknown';

/** Sanitized queue failure used by retry and terminal-state decisions. */
export class QueuePublishError extends OutboxDispatcherError {
  public constructor(
    code: Extract<
      OutboxDispatcherErrorCode,
      | 'SQS_AUTHENTICATION_FAILED'
      | 'SQS_BATCH_ENTRY_REJECTED'
      | 'SQS_CREDENTIALS_UNAVAILABLE'
      | 'SQS_REQUEST_FAILED'
      | 'SQS_RESPONSE_INVALID'
    >,
    message: string,
    retryable: boolean,
    public readonly outcome: QueueFailureOutcome,
  ) {
    super(code, message, retryable);
    this.name = 'QueuePublishError';
  }
}

/** Stable SQS batch entry derived from one immutable dispatch batch. */
export interface DispatchQueueEntry {
  readonly id: string;
  readonly batchId: string;
  readonly body: string;
}

/** Successful queue acknowledgement for one immutable dispatch batch. */
export interface DispatchQueueAcknowledgement {
  readonly entryId: string;
  readonly messageId: string;
}

/** Injectable queue boundary used by the production SQS adapter and tests. */
export interface DispatchBatchQueue {
  send(
    batches: readonly DispatchBatch[],
  ): Promise<readonly DispatchQueueAcknowledgement[]>;
}

/** Fencing token carried from the short claim transaction to finalization. */
export interface OutboxDispatchClaim {
  readonly outboxId: string;
  readonly attempt: number;
  readonly lockedUntil: string;
  readonly processingRecord: OutboxRecord;
  readonly batches: readonly DispatchBatch[];
}

/** Result of trying to claim one exact retained outbox record. */
export type OutboxClaimResult =
  | Readonly<{ kind: 'claimed'; claim: OutboxDispatchClaim }>
  | Readonly<{ kind: 'published'; result: DispatchOutboxResult }>
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'failed'; record: OutboxRecord }>
  | Readonly<{ kind: 'missing' }>;

/** Durable outcome after a queue failure is reconciled against the lease. */
export type OutboxFailureDisposition =
  | 'retry-scheduled'
  | 'terminal-failure'
  | 'stale-claim';

/** Persistence boundary kept small for deterministic crash and race tests. */
export interface OutboxDispatcherStore {
  listReadyOutboxIds(limit: number): Promise<readonly string[]>;
  claimOutbox(outboxId: string): Promise<OutboxClaimResult>;
  markPublished(
    claim: OutboxDispatchClaim,
  ): Promise<DispatchOutboxResult | null>;
  recordFailure(
    claim: OutboxDispatchClaim,
    errorCode: OutboxDispatcherErrorCode,
    retryable: boolean,
  ): Promise<OutboxFailureDisposition>;
}

/** Dependencies for a single canonical outbox dispatch execution. */
export interface OutboxDispatcherDependencies {
  readonly store: OutboxDispatcherStore;
  readonly queue: DispatchBatchQueue;
  /** Fresh current-epoch authorization; omission is impossible by type. */
  readonly authorizeFanout: (
    claim: OutboxDispatchClaim,
  ) => boolean | Promise<boolean>;
}

/**
 * Creates the production current-epoch check used immediately before SQS.
 * The check runs in its own short transaction under the shared control lock
 * and is the handoff's linearization point. Missing state, a disabled state,
 * an old epoch, and every read error deny.
 */
export function createDrizzleOutboxFanoutAuthorizer(
  database: Database,
): OutboxDispatcherDependencies['authorizeFanout'] {
  return async (claimValue): Promise<boolean> => {
    let claim: OutboxDispatchClaim;
    try {
      claim = parseDispatchClaim(claimValue);
    } catch {
      return false;
    }
    try {
      const decision = await database.transaction((transaction) =>
        isNotificationIntentAuthorizedForCurrentFanout(
          transaction,
          claim.processingRecord.message.intentId,
        ),
      );
      return decision.authorized;
    } catch {
      return false;
    }
  };
}

/** Trusted provenance supplied by the poller or post-commit server hook. */
export interface DispatchOutboxCapabilityContext {
  readonly actor: Actor;
  readonly source: Extract<InvocationSource, 'worker' | 'scheduled-job'>;
  readonly transport: 'internal-post-commit' | 'scheduled-execution';
  readonly dispatcherAuthenticated: true;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

/** One safe item in a bounded poll report. */
export interface OutboxPollItem {
  readonly outboxId: string;
  readonly outcome: 'published' | 'deferred' | 'failed';
  readonly errorCode: OutboxDispatcherErrorCode | null;
}

/** Destination-free report from one bounded poll pass. */
export interface OutboxPollReport {
  readonly examinedCount: number;
  readonly publishedCount: number;
  readonly deferredCount: number;
  readonly failedCount: number;
  readonly items: readonly OutboxPollItem[];
}

/** Result of the best-effort fast path after the activation transaction. */
export type DirectOutboxDispatchResult =
  | Readonly<{ outcome: 'published'; result: DispatchOutboxResult }>
  | Readonly<{
      outcome: 'deferred';
      errorCode: OutboxDispatcherErrorCode;
    }>;

/** Configuration for the Drizzle-backed outbox store. */
export interface DrizzleOutboxDispatcherOptions {
  readonly leaseMilliseconds?: number;
  readonly maxAttempts?: number;
}

/** Read-only process environment used by the production SQS adapter. */
export type DispatcherEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** Validated destination and timeout for the central fan-out queue. */
export interface SqsDispatchBatchQueueConfiguration {
  readonly queueUrl: string;
  readonly region: string;
  readonly timeoutMilliseconds: number;
}

/** Temporary AWS role credentials. Static access keys are not supported. */
export interface AwsTemporaryCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date | null;
}

/** Injectable credential boundary; production resolves the container role. */
export interface AwsTemporaryCredentialProvider {
  getCredentials(): Promise<AwsTemporaryCredentials>;
  invalidate(): void;
}

/** Pure SigV4 result exposed so signatures can be tested without networking. */
export interface SignedSqsSendMessageBatchRequest {
  readonly endpoint: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Optional seams for production SQS transport tests. */
export interface SqsDispatchBatchQueueOptions {
  readonly environment?: DispatcherEnvironment;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly credentialProvider?: AwsTemporaryCredentialProvider;
}

function assertPositiveBoundedInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new OutboxDispatcherError(
      'OUTBOX_CONFIGURATION_INVALID',
      `${name} is outside its safe operating range.`,
      false,
    );
  }
  return value;
}

function dateIso(value: Date): string {
  return value.toISOString();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new OutboxDispatcherError(
        'OUTBOX_PERSISTENCE_FAILED',
        'Persisted notification JSON contains an unsupported value.',
        false,
      );
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function deterministicJitterFraction(key: string): number {
  const digest = createHash('sha256').update(key, 'utf8').digest();
  return digest.readUInt32BE(0) / 0xffff_ffff;
}

/**
 * Computes bounded exponential backoff with deterministic per-row jitter.
 * Determinism keeps retries testable while preventing synchronized recovery.
 */
export function computeOutboxBackoffMilliseconds(
  attempt: number,
  jitterFraction = 0,
): number {
  assertPositiveBoundedInteger(attempt, 'attempt', 100);
  if (
    !Number.isFinite(jitterFraction) ||
    jitterFraction < 0 ||
    jitterFraction > 1
  ) {
    throw new OutboxDispatcherError(
      'OUTBOX_CONFIGURATION_INVALID',
      'Retry jitter must be between zero and one.',
      false,
    );
  }
  const exponential = Math.min(
    MAX_OUTBOX_BACKOFF_MILLISECONDS,
    BASE_OUTBOX_BACKOFF_MILLISECONDS * 2 ** Math.min(attempt - 1, 16),
  );
  const jittered = exponential * (1 + jitterFraction * 0.25);
  return Math.min(MAX_OUTBOX_BACKOFF_MILLISECONDS, Math.round(jittered));
}

/** Serializes only canonical, destination-free dispatch batches for SQS. */
export function serializeDispatchQueueEntries(
  batches: readonly DispatchBatch[],
): readonly DispatchQueueEntry[] {
  const parsed = batches.map((batch) => DispatchBatchSchema.parse(batch));
  const ids = new Set<string>();
  const entries = parsed.map((batch) => {
    const id = `batch_${batch.sequence}`;
    if (ids.has(id)) {
      throw new QueuePublishError(
        'SQS_BATCH_ENTRY_REJECTED',
        'Dispatch batch entry identities must be unique.',
        false,
        'not-sent',
      );
    }
    ids.add(id);
    return Object.freeze({
      id,
      batchId: batch.id,
      body: JSON.stringify(batch),
    });
  });
  if (entries.length < 1 || entries.length > 10) {
    throw new QueuePublishError(
      'SQS_BATCH_ENTRY_REJECTED',
      'SQS batch size is outside the supported range.',
      false,
      'not-sent',
    );
  }
  return Object.freeze(entries);
}

function requiredDispatcherEnvironmentValue(
  environment: DispatcherEnvironment,
  name: string,
  maximumLength: number,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new OutboxDispatcherError(
      'OUTBOX_CONFIGURATION_INVALID',
      `${name} must be configured for the outbox dispatcher.`,
      false,
    );
  }
  return value;
}

function validatedSqsQueueUrl(queueUrlValue: string, region: string): string {
  let queueUrl: URL;
  try {
    queueUrl = new URL(queueUrlValue);
  } catch {
    throw new OutboxDispatcherError(
      'OUTBOX_CONFIGURATION_INVALID',
      `${FANOUT_QUEUE_URL_ENV} is not a valid URL.`,
      false,
    );
  }
  const expectedSuffix = region.startsWith('cn-')
    ? 'amazonaws.com.cn'
    : 'amazonaws.com';
  if (
    queueUrl.protocol !== 'https:' ||
    queueUrl.hostname !== `sqs.${region}.${expectedSuffix}` ||
    queueUrl.port !== '' ||
    queueUrl.username !== '' ||
    queueUrl.password !== '' ||
    queueUrl.search !== '' ||
    queueUrl.hash !== '' ||
    // This dispatcher intentionally targets standard SQS. FIFO requires a
    // MessageGroupId and has different throughput/deduplication semantics.
    !/^\/\d{12}\/[A-Za-z0-9_-]{1,80}\/?$/u.test(queueUrl.pathname)
  ) {
    throw new OutboxDispatcherError(
      'OUTBOX_CONFIGURATION_INVALID',
      `${FANOUT_QUEUE_URL_ENV} must identify an AWS SQS queue in AWS_REGION.`,
      false,
    );
  }
  return queueUrl.toString();
}

function parseSqsDispatchBatchQueueConfiguration(
  value: SqsDispatchBatchQueueConfiguration,
): SqsDispatchBatchQueueConfiguration {
  const region = value.region;
  if (region.length > 32 || !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)) {
    throw new OutboxDispatcherError(
      'OUTBOX_CONFIGURATION_INVALID',
      'AWS_REGION is invalid for SQS dispatch.',
      false,
    );
  }
  const timeoutMilliseconds = assertPositiveBoundedInteger(
    value.timeoutMilliseconds,
    'SQS timeout',
    30_000,
  );
  return Object.freeze({
    queueUrl: validatedSqsQueueUrl(value.queueUrl, region),
    region,
    timeoutMilliseconds,
  });
}

/** Reads fail-closed fan-out queue configuration from the runtime. */
export function readSqsDispatchBatchQueueConfiguration(
  environment: DispatcherEnvironment = process.env,
): SqsDispatchBatchQueueConfiguration {
  const region = requiredDispatcherEnvironmentValue(
    environment,
    'AWS_REGION',
    32,
  );
  const queueUrl = requiredDispatcherEnvironmentValue(
    environment,
    FANOUT_QUEUE_URL_ENV,
    2_048,
  );
  const timeoutRaw =
    environment.OUTBOX_SQS_HTTP_TIMEOUT_MS ??
    String(DEFAULT_SQS_TIMEOUT_MILLISECONDS);
  const timeoutMilliseconds = Number(timeoutRaw);
  return parseSqsDispatchBatchQueueConfiguration({
    queueUrl,
    region,
    timeoutMilliseconds,
  });
}

function validatedTemporaryCredentials(
  value: AwsTemporaryCredentials,
  now: Date,
): AwsTemporaryCredentials {
  const visibleAscii = /^[\x21-\x7e]+$/u;
  if (
    value.accessKeyId.length < 16 ||
    value.accessKeyId.length > 128 ||
    !/^[A-Z0-9]+$/u.test(value.accessKeyId) ||
    value.secretAccessKey.length < 16 ||
    value.secretAccessKey.length > 256 ||
    !visibleAscii.test(value.secretAccessKey) ||
    value.sessionToken.length < 16 ||
    value.sessionToken.length > 16_384 ||
    !visibleAscii.test(value.sessionToken) ||
    !Number.isFinite(now.getTime()) ||
    (value.expiration !== null &&
      (!Number.isFinite(value.expiration.getTime()) ||
        value.expiration.getTime() <= now.getTime()))
  ) {
    throw new QueuePublishError(
      'SQS_CREDENTIALS_UNAVAILABLE',
      'Temporary AWS role credentials are unavailable.',
      true,
      'not-sent',
    );
  }
  return Object.freeze({
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    sessionToken: value.sessionToken,
    expiration:
      value.expiration === null ? null : new Date(value.expiration.getTime()),
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Uint8Array, value: string): Uint8Array {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function awsDateParts(value: Date): Readonly<{
  amzDate: string;
  dateStamp: string;
}> {
  if (!Number.isFinite(value.getTime())) {
    throw new OutboxDispatcherError(
      'OUTBOX_CONFIGURATION_INVALID',
      'The SQS signing clock returned an invalid timestamp.',
      false,
    );
  }
  const amzDate = value
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return Object.freeze({ amzDate, dateStamp: amzDate.slice(0, 8) });
}

/**
 * Signs one SendMessageBatch JSON request with temporary role credentials.
 * The queue body for every entry remains the raw canonical DispatchBatch.
 */
export function signSqsSendMessageBatchRequest(
  configurationValue: SqsDispatchBatchQueueConfiguration,
  entriesValue: readonly DispatchQueueEntry[],
  credentialsValue: AwsTemporaryCredentials,
  nowValue: Date,
): SignedSqsSendMessageBatchRequest {
  const configuration =
    parseSqsDispatchBatchQueueConfiguration(configurationValue);
  const now = new Date(nowValue.getTime());
  const credentials = validatedTemporaryCredentials(credentialsValue, now);
  const entries = entriesValue.map((entry) => {
    if (
      !/^[A-Za-z0-9_-]{1,80}$/u.test(entry.id) ||
      !UuidSchema.safeParse(entry.batchId).success ||
      entry.body.length === 0
    ) {
      throw new QueuePublishError(
        'SQS_BATCH_ENTRY_REJECTED',
        'A dispatch queue entry is invalid.',
        false,
        'not-sent',
      );
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(entry.body) as unknown;
    } catch {
      throw new QueuePublishError(
        'SQS_BATCH_ENTRY_REJECTED',
        'A dispatch queue entry is not canonical JSON.',
        false,
        'not-sent',
      );
    }
    const parsedBatch = DispatchBatchSchema.safeParse(parsedBody);
    if (!parsedBatch.success || parsedBatch.data.id !== entry.batchId) {
      throw new QueuePublishError(
        'SQS_BATCH_ENTRY_REJECTED',
        'A dispatch queue entry does not contain its canonical batch.',
        false,
        'not-sent',
      );
    }
    return Object.freeze({
      Id: entry.id,
      MessageBody: entry.body,
    });
  });
  if (entries.length < 1 || entries.length > 10) {
    throw new QueuePublishError(
      'SQS_BATCH_ENTRY_REJECTED',
      'SQS batch size is outside the supported range.',
      false,
      'not-sent',
    );
  }
  const totalMessageBytes = entries.reduce(
    (total, entry) =>
      total + new TextEncoder().encode(entry.MessageBody).byteLength,
    0,
  );
  if (totalMessageBytes > MAX_SQS_BATCH_PAYLOAD_BYTES) {
    throw new QueuePublishError(
      'SQS_BATCH_ENTRY_REJECTED',
      'The SQS dispatch payload exceeds the supported size.',
      false,
      'not-sent',
    );
  }

  const body = JSON.stringify({
    QueueUrl: configuration.queueUrl,
    Entries: entries,
  });
  const queueUrl = new URL(configuration.queueUrl);
  const endpoint = `${queueUrl.origin}/`;
  const { amzDate, dateStamp } = awsDateParts(now);
  const canonicalHeaders =
    `content-type:${AWS_JSON_CONTENT_TYPE}\n` +
    `host:${queueUrl.host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${credentials.sessionToken}\n` +
    `x-amz-target:${SQS_SEND_BATCH_TARGET}\n`;
  const signedHeaders =
    'content-type;host;x-amz-date;x-amz-security-token;x-amz-target';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join('\n');
  const credentialScope = `${dateStamp}/${configuration.region}/${SQS_SERVICE}/${AWS_REQUEST_TERMINATOR}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const dateKey = hmacSha256(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmacSha256(dateKey, configuration.region);
  const serviceKey = hmacSha256(regionKey, SQS_SERVICE);
  const signingKey = hmacSha256(serviceKey, AWS_REQUEST_TERMINATOR);
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return Object.freeze({
    endpoint,
    body,
    headers: Object.freeze({
      authorization,
      'content-type': AWS_JSON_CONTENT_TYPE,
      'x-amz-date': amzDate,
      'x-amz-security-token': credentials.sessionToken,
      'x-amz-target': SQS_SEND_BATCH_TARGET,
    }),
  });
}

function queueFailure(
  code: Extract<
    OutboxDispatcherErrorCode,
    | 'SQS_AUTHENTICATION_FAILED'
    | 'SQS_BATCH_ENTRY_REJECTED'
    | 'SQS_CREDENTIALS_UNAVAILABLE'
    | 'SQS_REQUEST_FAILED'
    | 'SQS_RESPONSE_INVALID'
  >,
  message: string,
  retryable: boolean,
  outcome: QueueFailureOutcome,
): () => QueuePublishError {
  return () => new QueuePublishError(code, message, retryable, outcome);
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
  failure: () => QueuePublishError,
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw failure();
  }
  if (response.body === null) {
    throw failure();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(failure());
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
    }
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw failure();
      }
      chunks.push(value);
    }
  } finally {
    if (abortListener !== null) {
      signal.removeEventListener('abort', abortListener);
    }
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // An aborted read can retain the lock; cancellation remains fail-closed.
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw failure();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw failure();
  }
}

async function fetchWithDispatcherTimeout<Result>(
  fetchImplementation: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMilliseconds: number,
  networkFailure: () => QueuePublishError,
  consume: (response: Response, signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetchImplementation(input, {
      ...init,
      signal: controller.signal,
    });
    return await consume(response, controller.signal);
  } catch (error) {
    if (error instanceof QueuePublishError) {
      throw error;
    }
    throw networkFailure();
  } finally {
    clearTimeout(timeout);
  }
}

function unknownRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function validCredentialEndpoint(
  environment: DispatcherEnvironment,
): Readonly<{ endpoint: string; authorization: string | null }> {
  const relative = environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = environment.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  let endpoint: URL;
  if (relative !== undefined) {
    if (
      relative.length < 2 ||
      relative.length > 2_048 ||
      !relative.startsWith('/') ||
      relative.startsWith('//') ||
      /[\0\r\n]/u.test(relative)
    ) {
      throw new QueuePublishError(
        'SQS_CREDENTIALS_UNAVAILABLE',
        'The container role credential endpoint is invalid.',
        false,
        'not-sent',
      );
    }
    endpoint = new URL(relative, 'http://169.254.170.2');
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '169.254.170.2' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.hash !== ''
    ) {
      throw new QueuePublishError(
        'SQS_CREDENTIALS_UNAVAILABLE',
        'The container role credential endpoint is invalid.',
        false,
        'not-sent',
      );
    }
  } else if (full !== undefined) {
    try {
      endpoint = new URL(full);
    } catch {
      throw new QueuePublishError(
        'SQS_CREDENTIALS_UNAVAILABLE',
        'The container role credential endpoint is invalid.',
        false,
        'not-sent',
      );
    }
    const localHttpHosts = new Set([
      '169.254.170.2',
      '127.0.0.1',
      '[::1]',
      'localhost',
    ]);
    if (
      (endpoint.protocol !== 'https:' &&
        !(
          endpoint.protocol === 'http:' && localHttpHosts.has(endpoint.hostname)
        )) ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.hash !== ''
    ) {
      throw new QueuePublishError(
        'SQS_CREDENTIALS_UNAVAILABLE',
        'The container role credential endpoint is invalid.',
        false,
        'not-sent',
      );
    }
  } else {
    throw new QueuePublishError(
      'SQS_CREDENTIALS_UNAVAILABLE',
      'No container role credential endpoint is configured.',
      true,
      'not-sent',
    );
  }
  const authorization = environment.AWS_CONTAINER_AUTHORIZATION_TOKEN ?? null;
  if (
    authorization !== null &&
    (authorization.length === 0 ||
      authorization.length > 4_096 ||
      /[\0\r\n]/u.test(authorization))
  ) {
    throw new QueuePublishError(
      'SQS_CREDENTIALS_UNAVAILABLE',
      'The container role authorization token is invalid.',
      false,
      'not-sent',
    );
  }
  return Object.freeze({ endpoint: endpoint.toString(), authorization });
}

function environmentTemporaryCredentials(
  environment: DispatcherEnvironment,
  now: Date,
): AwsTemporaryCredentials | null {
  const accessKeyId = environment.AWS_ACCESS_KEY_ID;
  const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY;
  const sessionToken = environment.AWS_SESSION_TOKEN;
  const suppliedCount = [accessKeyId, secretAccessKey, sessionToken].filter(
    (value) => value !== undefined,
  ).length;
  if (suppliedCount === 0) {
    return null;
  }
  if (
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    sessionToken === undefined
  ) {
    throw new QueuePublishError(
      'SQS_CREDENTIALS_UNAVAILABLE',
      'Incomplete or static AWS credentials are not supported.',
      false,
      'not-sent',
    );
  }
  const expirationRaw = environment.AWS_CREDENTIAL_EXPIRATION;
  const expiration =
    expirationRaw === undefined ? null : new Date(expirationRaw);
  return validatedTemporaryCredentials(
    { accessKeyId, secretAccessKey, sessionToken, expiration },
    now,
  );
}

function credentialsFromContainerResponse(
  value: unknown,
  now: Date,
): AwsTemporaryCredentials {
  const record = unknownRecord(value);
  const code = record?.Code;
  const accessKeyId = record?.AccessKeyId;
  const secretAccessKey = record?.SecretAccessKey;
  const sessionToken = record?.Token;
  const expirationRaw = record?.Expiration;
  if (
    record === null ||
    (code !== undefined && code !== 'Success') ||
    typeof accessKeyId !== 'string' ||
    typeof secretAccessKey !== 'string' ||
    typeof sessionToken !== 'string' ||
    typeof expirationRaw !== 'string'
  ) {
    throw new QueuePublishError(
      'SQS_CREDENTIALS_UNAVAILABLE',
      'The container role returned invalid temporary credentials.',
      true,
      'not-sent',
    );
  }
  return validatedTemporaryCredentials(
    {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiration: new Date(expirationRaw),
    },
    now,
  );
}

/** Resolves and refreshes temporary environment or container-role credentials. */
export function createAwsContainerRoleCredentialProvider(
  environment: DispatcherEnvironment = process.env,
  options: Readonly<{
    fetch?: typeof fetch;
    now?: () => Date;
    timeoutMilliseconds?: number;
  }> = {},
): AwsTemporaryCredentialProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMilliseconds = assertPositiveBoundedInteger(
    options.timeoutMilliseconds ?? DEFAULT_SQS_TIMEOUT_MILLISECONDS,
    'AWS credential timeout',
    30_000,
  );
  let cached: AwsTemporaryCredentials | undefined;
  let pending: Promise<AwsTemporaryCredentials> | undefined;

  async function loadCredentials(): Promise<AwsTemporaryCredentials> {
    const currentTime = now();
    const configured = environmentTemporaryCredentials(
      environment,
      currentTime,
    );
    if (configured !== null) {
      return configured;
    }
    const { endpoint, authorization } = validCredentialEndpoint(environment);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authorization !== null) {
      headers.Authorization = authorization;
    }
    return fetchWithDispatcherTimeout(
      fetchImplementation,
      endpoint,
      { method: 'GET', headers },
      timeoutMilliseconds,
      queueFailure(
        'SQS_CREDENTIALS_UNAVAILABLE',
        'The container role credential endpoint is unavailable.',
        true,
        'not-sent',
      ),
      async (response, signal) => {
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new QueuePublishError(
            'SQS_CREDENTIALS_UNAVAILABLE',
            'The container role rejected the credential request.',
            response.status >= 500 || response.status === 429,
            'not-sent',
          );
        }
        const parsed = await readBoundedJson(
          response,
          signal,
          MAX_CONTAINER_CREDENTIAL_RESPONSE_BYTES,
          queueFailure(
            'SQS_CREDENTIALS_UNAVAILABLE',
            'The container role returned invalid temporary credentials.',
            true,
            'not-sent',
          ),
        );
        return credentialsFromContainerResponse(parsed, now());
      },
    );
  }

  return Object.freeze({
    async getCredentials(): Promise<AwsTemporaryCredentials> {
      const nowMilliseconds = now().getTime();
      if (
        cached !== undefined &&
        (cached.expiration === null ||
          cached.expiration.getTime() - CREDENTIAL_REFRESH_SKEW_MILLISECONDS >
            nowMilliseconds)
      ) {
        return cached;
      }
      if (pending !== undefined) {
        return pending;
      }
      const request = loadCredentials().then((credentials) => {
        cached = credentials;
        return credentials;
      });
      pending = request;
      try {
        return await request;
      } finally {
        if (pending === request) {
          pending = undefined;
        }
      }
    },
    invalidate(): void {
      cached = undefined;
    },
  });
}

const RETRYABLE_SQS_ERROR_CODES = new Set([
  'InternalError',
  'KmsThrottled',
  'OverLimit',
  'RequestThrottled',
  'RequestTimeout',
  'ServiceUnavailable',
  'ThrottlingException',
]);

const REFRESHABLE_SQS_AUTH_ERROR_CODES = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
]);

const TERMINAL_SQS_AUTH_ERROR_CODES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidSecurity',
  'InvalidSecurityToken',
  'SignatureDoesNotMatch',
]);

function awsErrorCode(value: unknown): string | null {
  const record = unknownRecord(value);
  const candidate = record?.__type ?? record?.code ?? record?.Code;
  if (typeof candidate !== 'string' || candidate.length > 256) {
    return null;
  }
  const fragment = candidate.split('#').at(-1)?.split(':', 1)[0];
  return fragment === undefined || !/^[A-Za-z0-9._-]+$/u.test(fragment)
    ? null
    : fragment;
}

function sqsHttpFailure(status: number, body: unknown): QueuePublishError {
  const code = awsErrorCode(body);
  const refreshableAuthentication =
    code !== null && REFRESHABLE_SQS_AUTH_ERROR_CODES.has(code);
  const terminalAuthentication =
    code !== null && TERMINAL_SQS_AUTH_ERROR_CODES.has(code);
  if (
    refreshableAuthentication ||
    terminalAuthentication ||
    status === 401 ||
    status === 403
  ) {
    return new QueuePublishError(
      'SQS_AUTHENTICATION_FAILED',
      'SQS rejected the dispatcher role authorization.',
      refreshableAuthentication,
      'not-sent',
    );
  }
  const retryable =
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    (code !== null && RETRYABLE_SQS_ERROR_CODES.has(code));
  return new QueuePublishError(
    'SQS_REQUEST_FAILED',
    'SQS rejected the dispatch batch request.',
    retryable,
    retryable ? 'unknown' : 'not-sent',
  );
}

interface ParsedSqsFailure {
  readonly id: string;
  readonly code: string;
  readonly senderFault: boolean;
}

function parseSqsFailure(value: unknown): ParsedSqsFailure | null {
  const record = unknownRecord(value);
  const id = record?.Id;
  const code = record?.Code;
  const senderFault = record?.SenderFault;
  return typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 80 &&
    typeof code === 'string' &&
    code.length > 0 &&
    code.length <= 256 &&
    typeof senderFault === 'boolean'
    ? Object.freeze({ id, code, senderFault })
    : null;
}

/** Validates exact per-entry SQS acknowledgement without trusting messages. */
export function parseSqsSendMessageBatchResponse(
  value: unknown,
  entries: readonly DispatchQueueEntry[],
): readonly DispatchQueueAcknowledgement[] {
  const record = unknownRecord(value);
  const successfulValues = record?.Successful ?? [];
  const failedValues = record?.Failed ?? [];
  if (
    record === null ||
    !Array.isArray(successfulValues) ||
    !Array.isArray(failedValues)
  ) {
    throw new QueuePublishError(
      'SQS_RESPONSE_INVALID',
      'SQS returned an invalid batch response.',
      true,
      'unknown',
    );
  }
  const expectedIds = new Set(entries.map((entry) => entry.id));
  const acknowledgements: DispatchQueueAcknowledgement[] = [];
  const observedIds = new Set<string>();
  for (const valueItem of successfulValues) {
    const item = unknownRecord(valueItem);
    const entryId = item?.Id;
    const messageId = item?.MessageId;
    if (
      typeof entryId !== 'string' ||
      typeof messageId !== 'string' ||
      messageId.length < 1 ||
      messageId.length > 256 ||
      /[\0\r\n]/u.test(messageId) ||
      !expectedIds.has(entryId) ||
      observedIds.has(entryId)
    ) {
      throw new QueuePublishError(
        'SQS_RESPONSE_INVALID',
        'SQS returned an invalid batch acknowledgement.',
        true,
        acknowledgements.length === 0 ? 'unknown' : 'partial',
      );
    }
    observedIds.add(entryId);
    acknowledgements.push(Object.freeze({ entryId, messageId }));
  }
  const failures: ParsedSqsFailure[] = [];
  for (const valueItem of failedValues) {
    const failure = parseSqsFailure(valueItem);
    if (
      failure === null ||
      !expectedIds.has(failure.id) ||
      observedIds.has(failure.id)
    ) {
      throw new QueuePublishError(
        'SQS_RESPONSE_INVALID',
        'SQS returned invalid per-entry failure evidence.',
        true,
        acknowledgements.length === 0 ? 'unknown' : 'partial',
      );
    }
    observedIds.add(failure.id);
    failures.push(failure);
  }
  if (observedIds.size !== expectedIds.size) {
    throw new QueuePublishError(
      'SQS_RESPONSE_INVALID',
      'SQS omitted one or more dispatch batch results.',
      true,
      acknowledgements.length === 0 ? 'unknown' : 'partial',
    );
  }
  if (failures.length > 0) {
    const authenticationFailure = failures.some(
      (failure) =>
        REFRESHABLE_SQS_AUTH_ERROR_CODES.has(failure.code) ||
        TERMINAL_SQS_AUTH_ERROR_CODES.has(failure.code),
    );
    const retryable =
      acknowledgements.length > 0 ||
      failures.some(
        (failure) =>
          !failure.senderFault ||
          RETRYABLE_SQS_ERROR_CODES.has(failure.code) ||
          REFRESHABLE_SQS_AUTH_ERROR_CODES.has(failure.code),
      );
    throw new QueuePublishError(
      authenticationFailure
        ? 'SQS_AUTHENTICATION_FAILED'
        : 'SQS_BATCH_ENTRY_REJECTED',
      'SQS rejected one or more dispatch batch entries.',
      retryable,
      acknowledgements.length > 0 ? 'partial' : 'not-sent',
    );
  }
  return Object.freeze(acknowledgements);
}

/** Creates a production SendMessageBatch adapter using role-based SigV4. */
export function createSqsDispatchBatchQueue(
  configurationValue: SqsDispatchBatchQueueConfiguration,
  options: SqsDispatchBatchQueueOptions = {},
): DispatchBatchQueue {
  const configuration =
    parseSqsDispatchBatchQueueConfiguration(configurationValue);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const credentialProvider =
    options.credentialProvider ??
    createAwsContainerRoleCredentialProvider(
      options.environment ?? process.env,
      {
        fetch: fetchImplementation,
        now,
        timeoutMilliseconds: configuration.timeoutMilliseconds,
      },
    );
  return Object.freeze({
    async send(
      batches: readonly DispatchBatch[],
    ): Promise<readonly DispatchQueueAcknowledgement[]> {
      const entries = serializeDispatchQueueEntries(batches);
      let credentials: AwsTemporaryCredentials;
      try {
        credentials = await credentialProvider.getCredentials();
      } catch (error) {
        if (error instanceof QueuePublishError) {
          throw error;
        }
        throw new QueuePublishError(
          'SQS_CREDENTIALS_UNAVAILABLE',
          'Temporary AWS role credentials are unavailable.',
          true,
          'not-sent',
        );
      }
      const request = signSqsSendMessageBatchRequest(
        configuration,
        entries,
        credentials,
        now(),
      );
      try {
        return await fetchWithDispatcherTimeout(
          fetchImplementation,
          request.endpoint,
          {
            method: 'POST',
            headers: request.headers,
            body: request.body,
          },
          configuration.timeoutMilliseconds,
          queueFailure(
            'SQS_REQUEST_FAILED',
            'The SQS handoff outcome is unknown.',
            true,
            'unknown',
          ),
          async (response, signal) => {
            let parsed: unknown = null;
            try {
              parsed = await readBoundedJson(
                response,
                signal,
                MAX_SQS_RESPONSE_BYTES,
                queueFailure(
                  'SQS_RESPONSE_INVALID',
                  'SQS returned an invalid batch response.',
                  true,
                  'unknown',
                ),
              );
            } catch (error) {
              if (response.ok) {
                throw error;
              }
            }
            if (!response.ok) {
              throw sqsHttpFailure(response.status, parsed);
            }
            return parseSqsSendMessageBatchResponse(parsed, entries);
          },
        );
      } catch (error) {
        if (
          error instanceof QueuePublishError &&
          error.code === 'SQS_AUTHENTICATION_FAILED'
        ) {
          credentialProvider.invalidate();
        }
        throw error;
      }
    },
  });
}

/** Creates the production queue adapter directly from runtime environment. */
export function createConfiguredSqsDispatchBatchQueue(
  environment: DispatcherEnvironment = process.env,
  options: Omit<SqsDispatchBatchQueueOptions, 'environment'> = {},
): DispatchBatchQueue {
  return createSqsDispatchBatchQueue(
    readSqsDispatchBatchQueueConfiguration(environment),
    { ...options, environment },
  );
}

function normalizeDispatcherError(error: unknown): OutboxDispatcherError {
  if (error instanceof OutboxDispatcherError) {
    return error;
  }
  return new OutboxDispatcherError(
    'OUTBOX_PERSISTENCE_FAILED',
    'The outbox dispatch could not be completed.',
    true,
  );
}

type DispatcherQueryDatabase = DatabaseQuery;
type OutboxRow = typeof outbox.$inferSelect;
type DispatchBatchRow = typeof dispatchBatches.$inferSelect;

function dispatcherQueryDatabase(database: unknown): DispatcherQueryDatabase {
  // Both configured Drizzle PostgreSQL transports expose this common query
  // surface. The direct type avoids a union of overloaded method signatures.
  return database as DispatcherQueryDatabase;
}

function parsedDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new OutboxDispatcherError(
      'OUTBOX_PERSISTENCE_FAILED',
      `The persisted ${field} timestamp is invalid.`,
      false,
    );
  }
  return date;
}

async function readDatabaseTime(
  database: DispatcherQueryDatabase,
): Promise<Date> {
  const rows = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  const value = rows[0]?.value;
  if (value === undefined) {
    throw new OutboxDispatcherError(
      'OUTBOX_PERSISTENCE_FAILED',
      'The database clock is unavailable.',
      true,
    );
  }
  return parsedDate(value, 'database clock');
}

function outboxRecordFromRow(row: OutboxRow): OutboxRecord {
  const message = NotificationOutboxMessageSchema.parse(row.message);
  return OutboxRecordSchema.parse({
    id: row.id,
    message,
    status: row.status,
    attempts: row.attempts,
    availableAt: dateIso(row.availableAt),
    lockedUntil: row.lockedUntil === null ? null : dateIso(row.lockedUntil),
    publishedAt: row.publishedAt === null ? null : dateIso(row.publishedAt),
    failedAt: row.failedAt === null ? null : dateIso(row.failedAt),
    lastErrorCode: row.lastErrorCode,
  });
}

function batchFromRow(
  row: DispatchBatchRow,
  message: NotificationOutboxMessage,
): DispatchBatch {
  const planned = message.channels.find(
    (candidate) => candidate.channel === row.channel,
  );
  if (planned === undefined) {
    throw new OutboxDispatcherError(
      'OUTBOX_PERSISTENCE_FAILED',
      'A dispatch batch has no matching immutable channel plan.',
      false,
    );
  }
  return DispatchBatchSchema.parse({
    id: row.id,
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
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    requestId: row.requestId,
    authorization: row.authorization,
    channel: row.channel,
    renderedMessage: row.renderedMessage,
    integrationStatus: planned.integrationStatus,
    sequence: row.sequence,
    endpointCount: row.endpointCount,
    createdAt: dateIso(row.createdAt),
  });
}

async function loadDispatchBatches(
  database: DispatcherQueryDatabase,
  outboxRow: OutboxRow,
): Promise<readonly DispatchBatch[]> {
  const message = NotificationOutboxMessageSchema.parse(outboxRow.message);
  const rows = await database
    .select()
    .from(dispatchBatches)
    .where(eq(dispatchBatches.outboxId, outboxRow.id))
    .orderBy(asc(dispatchBatches.sequence));
  return Object.freeze(rows.map((row) => batchFromRow(row, message)));
}

async function loadDispatchResult(
  database: DispatcherQueryDatabase,
  outboxId: string,
): Promise<DispatchOutboxResult | null> {
  const [row] = await database
    .select()
    .from(outbox)
    .where(eq(outbox.id, outboxId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  return DispatchOutboxResultSchema.parse({
    outboxRecord: outboxRecordFromRow(row),
    batches: await loadDispatchBatches(database, row),
  });
}

async function ensureStableDispatchBatches(
  database: DispatcherQueryDatabase,
  outboxRow: OutboxRow,
  createdAt: Date,
): Promise<readonly DispatchBatch[]> {
  const message = NotificationOutboxMessageSchema.parse(outboxRow.message);
  const channelRows = await database
    .select()
    .from(notificationIntentChannels)
    .where(eq(notificationIntentChannels.intentId, outboxRow.intentId))
    .orderBy(asc(notificationIntentChannels.sequence));

  if (
    channelRows.length !== message.channels.length ||
    channelRows.some((row, index) => {
      const planned = message.channels[index];
      return (
        planned === undefined ||
        row.sequence !== index + 1 ||
        row.channel !== planned.channel ||
        row.endpointCount !== planned.endpointCount ||
        row.integrationId !== planned.integrationStatus.integrationId ||
        row.integrationLabel !== planned.integrationStatus.label ||
        stableJson(row.renderedMessage) !== stableJson(planned.renderedMessage)
      );
    })
  ) {
    throw new OutboxDispatcherError(
      'OUTBOX_PERSISTENCE_FAILED',
      'The persisted notification channel plan is inconsistent.',
      false,
    );
  }

  const existing = await database
    .select()
    .from(dispatchBatches)
    .where(eq(dispatchBatches.outboxId, outboxRow.id))
    .orderBy(asc(dispatchBatches.sequence));
  const existingByChannel = new Map(existing.map((row) => [row.channel, row]));

  for (const [index, planned] of message.channels.entries()) {
    if (existingByChannel.has(planned.channel)) {
      continue;
    }
    const channelRow = channelRows[index];
    if (channelRow === undefined || channelRow.channel !== planned.channel) {
      throw new OutboxDispatcherError(
        'OUTBOX_PERSISTENCE_FAILED',
        'The dispatch channel persistence anchor is unavailable.',
        false,
      );
    }
    await database.insert(dispatchBatches).values({
      id: randomUUID(),
      outboxId: outboxRow.id,
      intentId: message.intentId,
      eventId: message.eventId,
      eventKind: message.eventKind,
      templateMode: message.templateMode,
      purpose: message.purpose,
      eventTypeVersionId: message.eventTypeVersion.id,
      rosterSnapshotId: message.rosterSnapshotId,
      rosterPopulation: message.rosterPopulation,
      audienceConfigId: message.audienceConfig.id,
      audienceConfigVersion: message.audienceConfig.version,
      requestId: message.requestId,
      authorization: message.authorization,
      channel: planned.channel,
      renderedMessage: planned.renderedMessage,
      integrationStatusId: channelRow.integrationStatusId,
      integrationId: planned.integrationStatus.integrationId,
      integrationLabel: planned.integrationStatus.label,
      sequence: index + 1,
      endpointCount: planned.endpointCount,
      createdAt,
    });
  }

  const batches = await loadDispatchBatches(database, outboxRow);
  DispatchOutboxResultSchema.parse({
    outboxRecord: outboxRecordFromRow(outboxRow),
    batches,
  });
  return batches;
}

async function failExhaustedClaim(
  database: DispatcherQueryDatabase,
  row: OutboxRow,
  now: Date,
): Promise<OutboxRow> {
  let processingRow = row;
  if (row.status === 'pending') {
    if (row.attempts >= 100) {
      throw new OutboxDispatcherError(
        'OUTBOX_PERSISTENCE_FAILED',
        'The outbox attempt counter cannot advance to terminal handling.',
        false,
      );
    }
    const [claimed] = await database
      .update(outbox)
      .set({
        status: 'processing',
        attempts: row.attempts + 1,
        lockedUntil: new Date(now.getTime() + 1),
      })
      .where(
        and(
          eq(outbox.id, row.id),
          eq(outbox.status, 'pending'),
          eq(outbox.attempts, row.attempts),
        ),
      )
      .returning();
    if (claimed === undefined) {
      throw new OutboxDispatcherError(
        'OUTBOX_CLAIM_LOST',
        'The outbox claim changed during terminal handling.',
        true,
      );
    }
    processingRow = claimed;
  }

  const [failed] = await database
    .update(outbox)
    .set({
      status: 'failed',
      lockedUntil: null,
      failedAt: now,
      lastErrorCode: 'OUTBOX_DISPATCH_RETRY_EXHAUSTED',
    })
    .where(
      and(
        eq(outbox.id, processingRow.id),
        eq(outbox.status, 'processing'),
        eq(outbox.attempts, processingRow.attempts),
      ),
    )
    .returning();
  if (failed === undefined) {
    throw new OutboxDispatcherError(
      'OUTBOX_CLAIM_LOST',
      'The exhausted outbox claim could not be finalized.',
      true,
    );
  }
  return failed;
}

/** Creates the production PostgreSQL/Aurora outbox persistence adapter. */
export function createDrizzleOutboxDispatcherStore(
  database: Database,
  options: DrizzleOutboxDispatcherOptions = {},
): OutboxDispatcherStore {
  const leaseMilliseconds = assertPositiveBoundedInteger(
    options.leaseMilliseconds ?? DEFAULT_OUTBOX_LEASE_MILLISECONDS,
    'leaseMilliseconds',
    10 * 60 * 1_000,
  );
  const maxAttempts = assertPositiveBoundedInteger(
    options.maxAttempts ?? MAX_OUTBOX_DISPATCH_ATTEMPTS,
    'maxAttempts',
    100,
  );

  return Object.freeze({
    async listReadyOutboxIds(limitValue: number): Promise<readonly string[]> {
      const limit = assertPositiveBoundedInteger(
        limitValue,
        'poll limit',
        MAX_OUTBOX_POLL_SIZE,
      );
      const query = dispatcherQueryDatabase(database);
      const now = sql<Date>`clock_timestamp()`;
      const rows = await query
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          or(
            and(eq(outbox.status, 'pending'), lte(outbox.availableAt, now)),
            and(eq(outbox.status, 'processing'), lte(outbox.lockedUntil, now)),
          ),
        )
        .orderBy(asc(outbox.availableAt), asc(outbox.createdAt), asc(outbox.id))
        .limit(limit);
      return Object.freeze(rows.map((row) => row.id));
    },

    claimOutbox(outboxIdValue: string): Promise<OutboxClaimResult> {
      const outboxId = UuidSchema.parse(outboxIdValue);
      return database.transaction(async (rawTransaction) => {
        const transaction = dispatcherQueryDatabase(rawTransaction);
        const databaseNow = sql<Date>`clock_timestamp()`;
        const [row] = await transaction
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.id, outboxId),
              or(
                and(
                  eq(outbox.status, 'pending'),
                  lte(outbox.availableAt, databaseNow),
                ),
                and(
                  eq(outbox.status, 'processing'),
                  lte(outbox.lockedUntil, databaseNow),
                ),
              ),
            ),
          )
          .limit(1)
          .for('update', { skipLocked: true });

        if (row === undefined) {
          const [current] = await transaction
            .select()
            .from(outbox)
            .where(eq(outbox.id, outboxId))
            .limit(1);
          if (current === undefined) {
            return Object.freeze({ kind: 'missing' as const });
          }
          if (current.status === 'published') {
            const result = await loadDispatchResult(transaction, outboxId);
            if (result === null) {
              throw new OutboxDispatcherError(
                'OUTBOX_PERSISTENCE_FAILED',
                'The published outbox result is unavailable.',
                false,
              );
            }
            return Object.freeze({ kind: 'published' as const, result });
          }
          if (current.status === 'failed') {
            return Object.freeze({
              kind: 'failed' as const,
              record: outboxRecordFromRow(current),
            });
          }
          return Object.freeze({ kind: 'busy' as const });
        }

        const now = await readDatabaseTime(transaction);
        const reclaimingExpiredLease = row.status === 'processing';
        if (!reclaimingExpiredLease && row.attempts >= maxAttempts) {
          const failed = await failExhaustedClaim(transaction, row, now);
          return Object.freeze({
            kind: 'failed' as const,
            record: outboxRecordFromRow(failed),
          });
        }

        const lockedUntil = new Date(now.getTime() + leaseMilliseconds);
        // A process crash is not a confirmed queue failure. Reclaim the same
        // durable attempt so repeated crashes cannot consume the retry budget
        // and strand an outbox that may never have reached SQS. Only a
        // pending row starts a new bounded handoff attempt.
        const nextAttempt = reclaimingExpiredLease
          ? row.attempts
          : row.attempts + 1;
        const [claimed] = await transaction
          .update(outbox)
          .set({
            status: 'processing',
            attempts: nextAttempt,
            lockedUntil,
          })
          .where(
            and(
              eq(outbox.id, row.id),
              eq(outbox.status, row.status),
              eq(outbox.attempts, row.attempts),
            ),
          )
          .returning();
        if (claimed === undefined) {
          return Object.freeze({ kind: 'busy' as const });
        }

        const batches = await ensureStableDispatchBatches(
          transaction,
          claimed,
          now,
        );
        const processingRecord = outboxRecordFromRow(claimed);
        const claim: OutboxDispatchClaim = Object.freeze({
          outboxId: claimed.id,
          attempt: claimed.attempts,
          lockedUntil: dateIso(lockedUntil),
          processingRecord,
          batches,
        });
        return Object.freeze({ kind: 'claimed' as const, claim });
      });
    },

    markPublished(
      claimValue: OutboxDispatchClaim,
    ): Promise<DispatchOutboxResult | null> {
      const claim = parseDispatchClaim(claimValue);
      return database.transaction(async (rawTransaction) => {
        const transaction = dispatcherQueryDatabase(rawTransaction);
        const now = await readDatabaseTime(transaction);
        const [published] = await transaction
          .update(outbox)
          .set({
            status: 'published',
            lockedUntil: null,
            publishedAt: now,
          })
          .where(claimFence(claim))
          .returning();
        if (published === undefined) {
          return null;
        }
        return DispatchOutboxResultSchema.parse({
          outboxRecord: outboxRecordFromRow(published),
          batches: await loadDispatchBatches(transaction, published),
        });
      });
    },

    recordFailure(
      claimValue: OutboxDispatchClaim,
      errorCode: OutboxDispatcherErrorCode,
      retryable: boolean,
    ): Promise<OutboxFailureDisposition> {
      const claim = parseDispatchClaim(claimValue);
      return database.transaction(async (rawTransaction) => {
        const transaction = dispatcherQueryDatabase(rawTransaction);
        const now = await readDatabaseTime(transaction);
        if (retryable && claim.attempt < maxAttempts) {
          const backoff = computeOutboxBackoffMilliseconds(
            claim.attempt,
            deterministicJitterFraction(claim.outboxId),
          );
          const [scheduled] = await transaction
            .update(outbox)
            .set({
              status: 'pending',
              lockedUntil: null,
              availableAt: new Date(now.getTime() + backoff),
            })
            .where(claimFence(claim))
            .returning({ id: outbox.id });
          return scheduled === undefined ? 'stale-claim' : 'retry-scheduled';
        }

        const terminalCode: OutboxDispatcherErrorCode = retryable
          ? 'OUTBOX_DISPATCH_RETRY_EXHAUSTED'
          : errorCode;
        const [failed] = await transaction
          .update(outbox)
          .set({
            status: 'failed',
            lockedUntil: null,
            failedAt: now,
            lastErrorCode: terminalCode,
          })
          .where(claimFence(claim))
          .returning({ id: outbox.id });
        return failed === undefined ? 'stale-claim' : 'terminal-failure';
      });
    },
  });
}

function parseDispatchClaim(value: OutboxDispatchClaim): OutboxDispatchClaim {
  UuidSchema.parse(value.outboxId);
  assertPositiveBoundedInteger(value.attempt, 'claim attempt', 100);
  const lockedUntil = parsedDate(value.lockedUntil, 'claim lease');
  const processingRecord = OutboxRecordSchema.parse(value.processingRecord);
  if (
    processingRecord.id !== value.outboxId ||
    processingRecord.status !== 'processing' ||
    processingRecord.attempts !== value.attempt ||
    processingRecord.lockedUntil !== lockedUntil.toISOString()
  ) {
    throw new OutboxDispatcherError(
      'OUTBOX_PERSISTENCE_FAILED',
      'The outbox claim fencing evidence is inconsistent.',
      false,
    );
  }
  const batches = value.batches.map((batch) =>
    DispatchBatchSchema.parse(batch),
  );
  DispatchOutboxResultSchema.parse({ outboxRecord: processingRecord, batches });
  return Object.freeze({
    outboxId: value.outboxId,
    attempt: value.attempt,
    lockedUntil: lockedUntil.toISOString(),
    processingRecord,
    batches: Object.freeze(batches),
  });
}

function claimFence(claim: OutboxDispatchClaim) {
  return and(
    eq(outbox.id, claim.outboxId),
    eq(outbox.status, 'processing'),
    eq(outbox.attempts, claim.attempt),
    eq(outbox.lockedUntil, new Date(claim.lockedUntil)),
  );
}

function assertCompleteQueueAcknowledgement(
  batches: readonly DispatchBatch[],
  acknowledgements: readonly DispatchQueueAcknowledgement[],
): void {
  const expected = serializeDispatchQueueEntries(batches).map(
    (entry) => entry.id,
  );
  const actual = acknowledgements.map((acknowledgement) => {
    if (
      acknowledgement.entryId.trim().length === 0 ||
      acknowledgement.messageId.trim().length === 0
    ) {
      throw new QueuePublishError(
        'SQS_RESPONSE_INVALID',
        'SQS returned an invalid queue acknowledgement.',
        true,
        'unknown',
      );
    }
    return acknowledgement.entryId;
  });
  if (
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((id) => !actual.includes(id))
  ) {
    throw new QueuePublishError(
      'SQS_RESPONSE_INVALID',
      'SQS did not acknowledge every dispatch batch.',
      true,
      actual.length === 0 ? 'unknown' : 'partial',
    );
  }
}

/**
 * Dispatches one exact outbox through a short claim, external queue call, and
 * lease-fenced finalization. Queue I/O never occurs inside a DB transaction.
 */
export async function dispatchOutbox(
  outboxIdValue: string,
  dependencies: OutboxDispatcherDependencies,
): Promise<DispatchOutboxResult> {
  const outboxId = UuidSchema.parse(outboxIdValue);
  const claimed = await dependencies.store.claimOutbox(outboxId);
  switch (claimed.kind) {
    case 'published':
      return DispatchOutboxResultSchema.parse(claimed.result);
    case 'missing':
      throw new OutboxDispatcherError(
        'OUTBOX_NOT_FOUND',
        'The retained outbox record was not found.',
        false,
      );
    case 'busy':
      throw new OutboxDispatcherError(
        'OUTBOX_CLAIM_BUSY',
        'The retained outbox record is already being dispatched.',
        true,
      );
    case 'failed':
      throw new OutboxDispatcherError(
        'OUTBOX_ALREADY_FAILED',
        'The retained outbox record has reached terminal failure.',
        false,
      );
    case 'claimed':
      break;
  }

  const claim = parseDispatchClaim(claimed.claim);
  let fanoutAuthorized = false;
  try {
    fanoutAuthorized = (await dependencies.authorizeFanout(claim)) === true;
  } catch {
    fanoutAuthorized = false;
  }
  if (!fanoutAuthorized) {
    let disposition: OutboxFailureDisposition;
    try {
      disposition = await dependencies.store.recordFailure(
        claim,
        'FANOUT_EMERGENCY_DISABLED',
        false,
      );
    } catch {
      throw new OutboxDispatcherError(
        'OUTBOX_PERSISTENCE_FAILED',
        'Fan-out was denied and the terminal suppression could not be persisted.',
        true,
      );
    }
    if (disposition === 'stale-claim') {
      throw new OutboxDispatcherError(
        'OUTBOX_CLAIM_LOST',
        'The outbox lease changed while emergency suppression was recorded.',
        true,
      );
    }
    throw new OutboxDispatcherError(
      'FANOUT_EMERGENCY_DISABLED',
      'Fan-out is emergency-disabled or its authorization is unavailable.',
      false,
    );
  }
  // No awaited application operation may sit between this successful locked
  // check and queue.send. Once the check linearizes before a later disable,
  // the SQS handoff is classified as already admitted/in flight.
  try {
    const acknowledgements = await dependencies.queue.send(claim.batches);
    assertCompleteQueueAcknowledgement(claim.batches, acknowledgements);
  } catch (error) {
    const dispatchError =
      error instanceof QueuePublishError
        ? error
        : new QueuePublishError(
            'SQS_REQUEST_FAILED',
            'The SQS handoff outcome is unknown.',
            true,
            'unknown',
          );
    let disposition: OutboxFailureDisposition;
    try {
      disposition = await dependencies.store.recordFailure(
        claim,
        dispatchError.code,
        dispatchError.retryable,
      );
    } catch {
      throw new OutboxDispatcherError(
        'OUTBOX_PERSISTENCE_FAILED',
        'Queue handoff failed and its retry state could not be persisted.',
        true,
      );
    }
    if (disposition === 'stale-claim') {
      throw new OutboxDispatcherError(
        'OUTBOX_CLAIM_LOST',
        'The outbox lease changed while queue failure was recorded.',
        true,
      );
    }
    if (disposition === 'terminal-failure' && dispatchError.retryable) {
      throw new OutboxDispatcherError(
        'OUTBOX_DISPATCH_RETRY_EXHAUSTED',
        'The outbox exhausted its bounded queue handoff attempts.',
        false,
      );
    }
    throw dispatchError;
  }

  const result = await dependencies.store.markPublished(claim);
  if (result === null) {
    // SQS may already contain these stable batch IDs. A newer lease will retry
    // and workers must deduplicate; claiming success here would risk loss.
    throw new OutboxDispatcherError(
      'OUTBOX_CLAIM_LOST',
      'SQS accepted the batches but the outbox lease changed before finalization.',
      true,
    );
  }
  return DispatchOutboxResultSchema.parse(result);
}

/** Registers dispatch under the canonical capability catalog. */
export function createDispatchOutboxHandler(
  dependencies: OutboxDispatcherDependencies,
): Readonly<
  RegisteredCapabilityHandler<
    'dispatch-outbox',
    DispatchOutboxCapabilityContext
  >
> {
  return registerCapabilityHandler('dispatch-outbox', (input) =>
    dispatchOutbox(input.outboxId, dependencies),
  );
}

/** Deny-by-default authorizer for scheduled and post-commit dispatch. */
export function createDispatchOutboxAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<DispatchOutboxCapabilityContext>
> {
  return Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        DispatchOutboxCapabilityContext
      >,
    ): void {
      const context = request.context;
      const input = request.input as Readonly<{ outboxId?: unknown }>;
      const parsedOutboxId = UuidSchema.safeParse(input.outboxId);
      const expectedTransport =
        context.source === 'scheduled-job'
          ? 'scheduled-execution'
          : 'internal-post-commit';
      if (
        request.definition.id !== 'dispatch-outbox' ||
        request.definition.operation !== 'mutation' ||
        context.actor.kind !== 'system' ||
        context.actor.serviceId !== 'outbox-dispatcher' ||
        !request.invocationPolicy.principalKinds.includes('system') ||
        !request.invocationPolicy.sources.includes(context.source) ||
        context.transport !== expectedTransport ||
        context.dispatcherAuthenticated !== true ||
        !parsedOutboxId.success ||
        context.idempotencyKey !== `dispatch:${parsedOutboxId.data}` ||
        request.humanActionRequirement.actionIds.length !== 0 ||
        request.humanActionRequirement.consequenceDigest !== null
      ) {
        throw new OutboxDispatcherError(
          'OUTBOX_CONFIGURATION_INVALID',
          'The outbox dispatcher invocation was not authorized.',
          false,
        );
      }
      UuidSchema.parse(context.requestId);
      IdempotencyKeySchema.parse(context.idempotencyKey);
    },
  });
}

/** Executes one dispatch through the canonical executeCapability boundary. */
export function executeDispatchOutboxCapability(
  outboxId: string,
  context: DispatchOutboxCapabilityContext,
  dependencies: OutboxDispatcherDependencies,
): Promise<DispatchOutboxResult> {
  return executeCanonicalCapability(
    createDispatchOutboxHandler(dependencies),
    { outboxId },
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createDispatchOutboxAuthorizer(),
    },
  );
}

/** Builds server-owned dispatch provenance; request bodies cannot supply it. */
export function createDispatchOutboxContext(
  outboxIdValue: string,
  source: DispatchOutboxCapabilityContext['source'],
  requestIdValue: string = randomUUID(),
): DispatchOutboxCapabilityContext {
  const outboxId = UuidSchema.parse(outboxIdValue);
  const requestId = UuidSchema.parse(requestIdValue);
  return Object.freeze({
    actor: Object.freeze({
      kind: 'system' as const,
      serviceId: 'outbox-dispatcher',
    }),
    source,
    transport:
      source === 'scheduled-job'
        ? ('scheduled-execution' as const)
        : ('internal-post-commit' as const),
    dispatcherAuthenticated: true as const,
    requestId,
    idempotencyKey: `dispatch:${outboxId}`,
  });
}

/** Runs one bounded scheduled poll without allowing one row to starve others. */
export async function pollOutbox(
  dependencies: OutboxDispatcherDependencies,
  limitValue = 25,
  createRequestId: () => string = randomUUID,
): Promise<OutboxPollReport> {
  const limit = assertPositiveBoundedInteger(
    limitValue,
    'poll limit',
    MAX_OUTBOX_POLL_SIZE,
  );
  const outboxIds = await dependencies.store.listReadyOutboxIds(limit);
  const items: OutboxPollItem[] = [];
  for (const outboxId of outboxIds) {
    try {
      await executeDispatchOutboxCapability(
        outboxId,
        createDispatchOutboxContext(
          outboxId,
          'scheduled-job',
          createRequestId(),
        ),
        dependencies,
      );
      items.push(
        Object.freeze({
          outboxId,
          outcome: 'published' as const,
          errorCode: null,
        }),
      );
    } catch (error) {
      const dispatchError = normalizeDispatcherError(error);
      items.push(
        Object.freeze({
          outboxId,
          outcome: dispatchError.retryable
            ? ('deferred' as const)
            : ('failed' as const),
          errorCode: dispatchError.code,
        }),
      );
    }
  }
  return Object.freeze({
    examinedCount: items.length,
    publishedCount: items.filter((item) => item.outcome === 'published').length,
    deferredCount: items.filter((item) => item.outcome === 'deferred').length,
    failedCount: items.filter((item) => item.outcome === 'failed').length,
    items: Object.freeze(items),
  });
}

/**
 * Best-effort fast path called only after the event transaction commits.
 * Failure never rolls back or overstates the already durable activation; the
 * retained row remains available to the scheduled poller.
 */
export async function dispatchOutboxAfterCommit(
  outboxId: string,
  dependencies: OutboxDispatcherDependencies,
  requestId: string = randomUUID(),
): Promise<DirectOutboxDispatchResult> {
  try {
    return Object.freeze({
      outcome: 'published' as const,
      result: await executeDispatchOutboxCapability(
        outboxId,
        createDispatchOutboxContext(outboxId, 'worker', requestId),
        dependencies,
      ),
    });
  } catch (error) {
    const dispatchError = normalizeDispatcherError(error);
    return Object.freeze({
      outcome: 'deferred' as const,
      errorCode: dispatchError.code,
    });
  }
}
