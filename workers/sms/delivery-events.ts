import {
  RecordDeliveryEvidenceInputSchema,
  TimestampSchema,
  UuidSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
  type RecordDeliveryEvidenceInput,
} from '@psd-eoc/contracts';

import type { AttemptEvidenceWriter } from '../shared/delivery-state-client';

export const AWS_EUM_SMS_PROVIDER = 'aws-eum-sms' as const;
export const AWS_EUM_EVENT_SOURCE = 'aws.sms-voice' as const;
export const AWS_EUM_TEXT_DELIVERY_DETAIL_TYPE =
  'Text Message Delivery Status Updated' as const;

const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/u;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9._:/+=-]{1,500}$/u;
const EVENT_VERSION_PATTERN = /^1(?:\.\d+)?$/u;
const MAX_EVENT_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1_000;

const RECOGNIZED_STATUSES = new Set([
  'ACCEPTED',
  'BLOCKED',
  'CARRIER_BLOCKED',
  'CARRIER_UNREACHABLE',
  'DELIVERED',
  'FAILED',
  'INVALID',
  'INVALID_MESSAGE',
  'PENDING',
  'PROTECT_BLOCKED',
  'QUEUED',
  'SENT',
  'SPAM',
  'SUCCESSFUL',
  'TTL_EXPIRED',
  'UNKNOWN',
  'UNREACHABLE',
  'UNROUTABLE',
]);

const PROVIDER_ACCEPTED_STATUSES = new Set([
  'ACCEPTED',
  'PENDING',
  'QUEUED',
  'SENT',
  'SUCCESSFUL',
]);

const CARRIER_FILTERING_STATUSES = new Set([
  'BLOCKED',
  'CARRIER_BLOCKED',
  'PROTECT_BLOCKED',
  'SPAM',
]);

const FAILURE_REASON_BY_STATUS = Object.freeze({
  BLOCKED: 'AWS_RECIPIENT_BLOCKED',
  CARRIER_BLOCKED: 'AWS_CARRIER_FILTERED',
  CARRIER_UNREACHABLE: 'AWS_CARRIER_UNREACHABLE',
  FAILED: 'AWS_SEND_FAILED',
  INVALID: 'AWS_INVALID_DESTINATION',
  INVALID_MESSAGE: 'AWS_INVALID_MESSAGE',
  PROTECT_BLOCKED: 'AWS_PROTECT_BLOCKED',
  SPAM: 'AWS_SPAM_FILTERED',
  UNREACHABLE: 'AWS_UNREACHABLE',
  UNROUTABLE: 'AWS_UNROUTABLE',
} as const);

type AwsEumFailureStatus = keyof typeof FAILURE_REASON_BY_STATUS;

export type AwsEumSmsDeliveryEventErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_EVENT'
  | 'EVENT_SCOPE_MISMATCH'
  | 'EVENT_TIME_INVALID'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_MISMATCH';

/** Safe event failure which never reflects provider text or phone numbers. */
export class AwsEumSmsDeliveryEventError extends Error {
  public constructor(public readonly code: AwsEumSmsDeliveryEventErrorCode) {
    super('The AWS End User Messaging SMS delivery event was rejected.');
    this.name = 'AwsEumSmsDeliveryEventError';
  }
}

export interface AwsEumSmsDeliveryEventConfiguration {
  readonly accountId: string;
  readonly region: string;
  readonly clock?: () => Date;
}

export interface ParsedAwsEumSmsDeliveryEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly messageId: string;
  readonly attemptId: string | null;
  readonly status: string;
  readonly isFinal: boolean;
}

export type AwsEumSmsDeliveryMapping =
  | Readonly<{ kind: 'intermediate'; event: ParsedAwsEumSmsDeliveryEvent }>
  | Readonly<{
      kind: 'evidence';
      event: ParsedAwsEumSmsDeliveryEvent;
      evidence: RecordDeliveryEvidenceInput &
        Readonly<{
          subject: Readonly<{ kind: 'attempt'; attemptId: string }>;
        }>;
    }>;

export interface SmsDeliveryAttemptLookup {
  /** Provider message IDs are the authoritative delivery-event correlation. */
  loadAttemptByProviderReference(
    provider: typeof AWS_EUM_SMS_PROVIDER,
    providerReference: string,
  ): Promise<ChannelAttempt | null>;
}

export interface SmsDeliveryEventProcessorOptions {
  readonly configuration: AwsEumSmsDeliveryEventConfiguration;
  readonly attempts: SmsDeliveryAttemptLookup;
  readonly evidenceWriter: AttemptEvidenceWriter;
}

export type SmsDeliveryEventProcessResult =
  | Readonly<{
      kind: 'intermediate';
      event: ParsedAwsEumSmsDeliveryEvent;
    }>
  | Readonly<{
      kind: 'recorded';
      event: ParsedAwsEumSmsDeliveryEvent;
      evidence: DeliveryEvidence;
    }>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function requiredString(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !pattern.test(value)
  ) {
    throw new AwsEumSmsDeliveryEventError('INVALID_EVENT');
  }
  return value;
}

function validClock(clock: (() => Date) | undefined): Date {
  let value: Date;
  try {
    value = (clock ?? (() => new Date()))();
  } catch {
    throw new AwsEumSmsDeliveryEventError('INVALID_CONFIGURATION');
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AwsEumSmsDeliveryEventError('INVALID_CONFIGURATION');
  }
  return new Date(value.getTime());
}

function parseConfiguration(
  configuration: AwsEumSmsDeliveryEventConfiguration,
): Readonly<{ accountId: string; region: string; now: Date }> {
  if (
    !isPlainRecord(configuration) ||
    !AWS_ACCOUNT_ID_PATTERN.test(configuration.accountId) ||
    !AWS_REGION_PATTERN.test(configuration.region)
  ) {
    throw new AwsEumSmsDeliveryEventError('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    accountId: configuration.accountId,
    region: configuration.region,
    now: validClock(configuration.clock),
  });
}

function validatedEventTime(date: Date, now: Date): string {
  const milliseconds = date.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < now.getTime() - MAX_EVENT_AGE_MILLISECONDS ||
    milliseconds > now.getTime() + MAX_FUTURE_SKEW_MILLISECONDS
  ) {
    throw new AwsEumSmsDeliveryEventError('EVENT_TIME_INVALID');
  }
  return TimestampSchema.parse(date.toISOString());
}

function timestampFromMilliseconds(value: unknown, now: Date): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AwsEumSmsDeliveryEventError('EVENT_TIME_INVALID');
  }
  return validatedEventTime(new Date(value as number), now);
}

function timestampFromEnvelope(value: unknown, now: Date): string {
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new AwsEumSmsDeliveryEventError('EVENT_TIME_INVALID');
  }
  return validatedEventTime(new Date(parsed.data), now);
}

function contextAttemptId(
  detail: Readonly<Record<string, unknown>>,
): string | null {
  const context = detail.context;
  if (context === undefined) return null;
  if (!isPlainRecord(context)) {
    throw new AwsEumSmsDeliveryEventError('INVALID_EVENT');
  }
  const candidate = context.psdAttemptId;
  if (candidate === undefined) return null;
  const result = UuidSchema.safeParse(candidate);
  if (!result.success) {
    throw new AwsEumSmsDeliveryEventError('INVALID_EVENT');
  }
  return result.data;
}

/**
 * Parses only the documented EventBridge envelope and drops every destination
 * and free-text field at this boundary. Provider payloads remain untrusted.
 */
export function parseAwsEumSmsDeliveryEvent(
  value: unknown,
  configuration: AwsEumSmsDeliveryEventConfiguration,
): ParsedAwsEumSmsDeliveryEvent {
  const parsedConfiguration = parseConfiguration(configuration);
  if (!isPlainRecord(value) || !isPlainRecord(value.detail)) {
    throw new AwsEumSmsDeliveryEventError('INVALID_EVENT');
  }
  if (
    value.version !== '0' ||
    value.source !== AWS_EUM_EVENT_SOURCE ||
    value['detail-type'] !== AWS_EUM_TEXT_DELIVERY_DETAIL_TYPE ||
    value.account !== parsedConfiguration.accountId ||
    value.region !== parsedConfiguration.region
  ) {
    throw new AwsEumSmsDeliveryEventError('EVENT_SCOPE_MISMATCH');
  }
  const detail = value.detail;
  const envelopeTime = timestampFromEnvelope(
    value.time,
    parsedConfiguration.now,
  );
  requiredString(value.id, PROVIDER_REFERENCE_PATTERN, 500);
  requiredString(detail.messageId, PROVIDER_REFERENCE_PATTERN, 500);
  requiredString(detail.eventVersion, EVENT_VERSION_PATTERN, 20);
  const eventType = requiredString(
    detail.eventType,
    /^TEXT_[A-Z_]{1,80}$/u,
    100,
  );
  const status = requiredString(detail.messageStatus, /^[A-Z_]{1,80}$/u, 100);
  if (typeof detail.isFinal !== 'boolean') {
    throw new AwsEumSmsDeliveryEventError('INVALID_EVENT');
  }
  const occurredAt =
    detail.eventTimestamp === undefined
      ? envelopeTime
      : timestampFromMilliseconds(
          detail.eventTimestamp,
          parsedConfiguration.now,
        );
  return Object.freeze({
    eventId: value.id as string,
    occurredAt,
    messageId: detail.messageId as string,
    attemptId: contextAttemptId(detail),
    status:
      eventType === `TEXT_${status}` && RECOGNIZED_STATUSES.has(status)
        ? status
        : 'UNRECOGNIZED',
    isFinal: detail.isFinal,
  });
}

function evidenceFor(
  event: ParsedAwsEumSmsDeliveryEvent,
  attemptId: string,
): AwsEumSmsDeliveryMapping {
  if (
    !event.isFinal &&
    !PROVIDER_ACCEPTED_STATUSES.has(event.status) &&
    !CARRIER_FILTERING_STATUSES.has(event.status)
  ) {
    return Object.freeze({ kind: 'intermediate', event });
  }

  const subject = Object.freeze({ kind: 'attempt' as const, attemptId });
  let candidate: RecordDeliveryEvidenceInput;
  if (PROVIDER_ACCEPTED_STATUSES.has(event.status)) {
    candidate = {
      subject,
      state: 'provider-accepted',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: event.messageId,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    };
  } else if (!event.isFinal && CARRIER_FILTERING_STATUSES.has(event.status)) {
    candidate = {
      subject,
      state: 'unknown',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: event.messageId,
      proof: null,
      reasonCode: 'AWS_CARRIER_FILTERING_NOT_FINAL',
      diagnosticDigest: null,
    };
  } else if (event.status === 'DELIVERED') {
    candidate = {
      subject,
      state: 'delivered',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: event.messageId,
      proof: {
        kind: 'provider-delivery-receipt',
        provider: AWS_EUM_SMS_PROVIDER,
        receiptId: event.eventId,
        deliveredAt: event.occurredAt,
      },
      reasonCode: null,
      diagnosticDigest: null,
    };
  } else if (event.status === 'TTL_EXPIRED') {
    candidate = {
      subject,
      state: 'expired',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: event.messageId,
      proof: null,
      reasonCode: 'AWS_TTL_EXPIRED',
      diagnosticDigest: null,
    };
  } else if (event.status === 'UNKNOWN') {
    candidate = {
      subject,
      state: 'unknown',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: event.messageId,
      proof: null,
      reasonCode: 'AWS_STATUS_UNKNOWN',
      diagnosticDigest: null,
    };
  } else if (event.status in FAILURE_REASON_BY_STATUS) {
    candidate = {
      subject,
      state: 'failed',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: event.messageId,
      proof: null,
      reasonCode: FAILURE_REASON_BY_STATUS[event.status as AwsEumFailureStatus],
      diagnosticDigest: null,
    };
  } else {
    candidate = {
      subject,
      state: 'unknown',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: event.messageId,
      proof: null,
      reasonCode: 'AWS_STATUS_UNRECOGNIZED',
      diagnosticDigest: null,
    };
  }

  const parsedEvidence = RecordDeliveryEvidenceInputSchema.parse(candidate);
  if (parsedEvidence.subject.kind !== 'attempt') {
    throw new AwsEumSmsDeliveryEventError('ATTEMPT_MISMATCH');
  }
  const evidence = Object.freeze({
    ...parsedEvidence,
    subject: parsedEvidence.subject,
  });
  return Object.freeze({ kind: 'evidence', event, evidence });
}

/** Maps AWS carrier/device facts without upgrading acceptance to delivery. */
export function mapAwsEumSmsDeliveryEvent(
  value: unknown,
  configuration: AwsEumSmsDeliveryEventConfiguration,
  attemptId: string,
): AwsEumSmsDeliveryMapping {
  const parsedAttemptId = UuidSchema.safeParse(attemptId);
  if (!parsedAttemptId.success) {
    throw new AwsEumSmsDeliveryEventError('ATTEMPT_MISMATCH');
  }
  const event = parseAwsEumSmsDeliveryEvent(value, configuration);
  if (event.attemptId !== null && event.attemptId !== parsedAttemptId.data) {
    throw new AwsEumSmsDeliveryEventError('ATTEMPT_MISMATCH');
  }
  return evidenceFor(event, parsedAttemptId.data);
}

/** Correlates by retained MessageId, then appends canonical delivery truth. */
export class SmsDeliveryEventProcessor {
  readonly #configuration: AwsEumSmsDeliveryEventConfiguration;
  readonly #attempts: SmsDeliveryAttemptLookup;
  readonly #writer: AttemptEvidenceWriter;

  public constructor(options: SmsDeliveryEventProcessorOptions) {
    parseConfiguration(options.configuration);
    if (
      typeof options.attempts?.loadAttemptByProviderReference !== 'function' ||
      typeof options.evidenceWriter?.recordAttemptEvidence !== 'function'
    ) {
      throw new AwsEumSmsDeliveryEventError('INVALID_CONFIGURATION');
    }
    this.#configuration = options.configuration;
    this.#attempts = options.attempts;
    this.#writer = options.evidenceWriter;
  }

  public async process(value: unknown): Promise<SmsDeliveryEventProcessResult> {
    const event = parseAwsEumSmsDeliveryEvent(value, this.#configuration);
    const attempt = await this.#attempts.loadAttemptByProviderReference(
      AWS_EUM_SMS_PROVIDER,
      event.messageId,
    );
    if (attempt === null) {
      throw new AwsEumSmsDeliveryEventError('ATTEMPT_NOT_FOUND');
    }
    if (
      attempt.channel !== 'sms' ||
      (event.attemptId !== null && event.attemptId !== attempt.id)
    ) {
      throw new AwsEumSmsDeliveryEventError('ATTEMPT_MISMATCH');
    }
    const mapping = evidenceFor(event, attempt.id);
    if (mapping.kind === 'intermediate') {
      return mapping;
    }
    const evidence = await this.#writer.recordAttemptEvidence({
      attempt,
      evidence: mapping.evidence,
    });
    return Object.freeze({ kind: 'recorded', event, evidence });
  }
}
