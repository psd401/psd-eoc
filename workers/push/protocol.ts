import type { ChannelAttempt } from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';

export const EXPO_PUSH_PROVIDER = 'expo-push' as const;
export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send' as const;
export const EXPO_RECEIPTS_URL =
  'https://exp.host/--/api/v2/push/getReceipts' as const;
export const EXPO_SEND_CHUNK_SIZE = 100;
export const EXPO_RECEIPT_CHUNK_SIZE = 1_000;

export const EXPO_INCIDENT_CATEGORY_ID = 'PSD_EOC_INCIDENT' as const;
export const EXPO_DRILL_CATEGORY_ID = 'PSD_EOC_DRILL' as const;
/** Existing Android channel registered by the mobile application. */
export const EXPO_ANDROID_CHANNEL_ID = 'eoc-alerts' as const;

export type ExpoCategoryId =
  | typeof EXPO_INCIDENT_CATEGORY_ID
  | typeof EXPO_DRILL_CATEGORY_ID;

/** Exact provider payload derived only from canonical rendered worker work. */
export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly sound: 'default';
  readonly priority: 'high';
  readonly categoryId: ExpoCategoryId;
  readonly channelId: typeof EXPO_ANDROID_CHANNEL_ID;
  readonly data: Readonly<{
    eventId: string;
    eventKind: WorkerAttemptWorkItem['batch']['eventKind'];
    templateMode: WorkerAttemptWorkItem['batch']['templateMode'];
    purpose: WorkerAttemptWorkItem['batch']['purpose'];
  }>;
}

export type ExpoSafeReasonCode =
  | 'EXPO_DEVICE_NOT_REGISTERED'
  | 'EXPO_HTTP_CLIENT_ERROR'
  | 'EXPO_HTTP_RATE_LIMITED'
  | 'EXPO_HTTP_SERVER_ERROR'
  | 'EXPO_INVALID_CREDENTIALS'
  | 'EXPO_LIVE_TRANSPORT_DISABLED'
  | 'EXPO_MESSAGE_RATE_EXCEEDED'
  | 'EXPO_MESSAGE_TOO_BIG'
  | 'EXPO_MISMATCH_SENDER_ID'
  | 'EXPO_NETWORK_OUTCOME_AMBIGUOUS'
  | 'EXPO_RECEIPT_ERROR_UNKNOWN'
  | 'EXPO_RECEIPT_HORIZON_EXPIRED'
  | 'EXPO_RECEIPT_MISSING'
  | 'EXPO_RECEIPT_RESPONSE_INVALID'
  | 'EXPO_TICKET_ERROR_UNKNOWN'
  | 'EXPO_TICKET_MISSING'
  | 'EXPO_TICKET_RESPONSE_INVALID'
  | 'EXPO_RESPONSE_TOO_LARGE'
  | 'PROVIDER_RETRY_EXHAUSTED';

const EXPO_SAFE_REASON_CODES: ReadonlySet<string> = new Set([
  'EXPO_DEVICE_NOT_REGISTERED',
  'EXPO_HTTP_CLIENT_ERROR',
  'EXPO_HTTP_RATE_LIMITED',
  'EXPO_HTTP_SERVER_ERROR',
  'EXPO_INVALID_CREDENTIALS',
  'EXPO_LIVE_TRANSPORT_DISABLED',
  'EXPO_MESSAGE_RATE_EXCEEDED',
  'EXPO_MESSAGE_TOO_BIG',
  'EXPO_MISMATCH_SENDER_ID',
  'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
  'EXPO_RECEIPT_ERROR_UNKNOWN',
  'EXPO_RECEIPT_HORIZON_EXPIRED',
  'EXPO_RECEIPT_MISSING',
  'EXPO_RECEIPT_RESPONSE_INVALID',
  'EXPO_TICKET_ERROR_UNKNOWN',
  'EXPO_TICKET_MISSING',
  'EXPO_TICKET_RESPONSE_INVALID',
  'EXPO_RESPONSE_TOO_LARGE',
  'PROVIDER_RETRY_EXHAUSTED',
]);

export function isExpoSafeReasonCode(
  value: unknown,
): value is ExpoSafeReasonCode {
  return typeof value === 'string' && EXPO_SAFE_REASON_CODES.has(value);
}

export type ExpoProviderOutcome =
  | Readonly<{
      kind: 'provider-accepted';
      state: 'provider-accepted';
      providerReference: string;
      reasonCode: null;
      invalidatesEndpoint: false;
    }>
  | Readonly<{
      kind: 'failed';
      state: 'failed';
      providerReference: string | null;
      reasonCode: ExpoSafeReasonCode;
      invalidatesEndpoint: boolean;
    }>
  | Readonly<{
      kind: 'retry';
      state: 'failed';
      providerReference: string | null;
      reasonCode: ExpoSafeReasonCode;
      invalidatesEndpoint: false;
    }>
  | Readonly<{
      kind: 'unknown';
      state: 'unknown';
      providerReference: string | null;
      reasonCode: ExpoSafeReasonCode;
      invalidatesEndpoint: false;
    }>;

export interface ExpoAttemptOutcome {
  readonly attempt: ChannelAttempt;
  readonly outcome: ExpoProviderOutcome;
}

type ExpoResponsePhase = 'ticket' | 'receipt';
const SAFE_PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function accepted(reference: string): ExpoProviderOutcome {
  if (!SAFE_PROVIDER_REFERENCE_PATTERN.test(reference)) {
    return unknown('EXPO_TICKET_RESPONSE_INVALID', null);
  }
  return Object.freeze({
    kind: 'provider-accepted',
    state: 'provider-accepted',
    providerReference: reference,
    reasonCode: null,
    invalidatesEndpoint: false,
  });
}

export function failed(
  reasonCode: ExpoSafeReasonCode,
  providerReference: string | null = null,
  invalidatesEndpoint = false,
): ExpoProviderOutcome {
  return Object.freeze({
    kind: 'failed',
    state: 'failed',
    providerReference,
    reasonCode,
    invalidatesEndpoint,
  });
}

export function retry(
  reasonCode: ExpoSafeReasonCode,
  providerReference: string | null = null,
): ExpoProviderOutcome {
  return Object.freeze({
    kind: 'retry',
    state: 'failed',
    providerReference,
    reasonCode,
    invalidatesEndpoint: false,
  });
}

export function unknown(
  reasonCode: ExpoSafeReasonCode,
  providerReference: string | null = null,
): Extract<ExpoProviderOutcome, { kind: 'unknown' }> {
  return Object.freeze({
    kind: 'unknown',
    state: 'unknown',
    providerReference,
    reasonCode,
    invalidatesEndpoint: false,
  });
}

function responseInvalidReason(phase: ExpoResponsePhase): ExpoSafeReasonCode {
  return phase === 'ticket'
    ? 'EXPO_TICKET_RESPONSE_INVALID'
    : 'EXPO_RECEIPT_RESPONSE_INVALID';
}

function responseUnknownReason(phase: ExpoResponsePhase): ExpoSafeReasonCode {
  return phase === 'ticket'
    ? 'EXPO_TICKET_ERROR_UNKNOWN'
    : 'EXPO_RECEIPT_ERROR_UNKNOWN';
}

function mapExpoProviderError(
  providerError: string,
  phase: ExpoResponsePhase,
  providerReference: string | null,
): ExpoProviderOutcome {
  switch (providerError) {
    case 'DeviceNotRegistered':
      return failed('EXPO_DEVICE_NOT_REGISTERED', providerReference, true);
    case 'MessageTooBig':
      return failed('EXPO_MESSAGE_TOO_BIG', providerReference);
    case 'MessageRateExceeded':
      return retry('EXPO_MESSAGE_RATE_EXCEEDED', providerReference);
    case 'MismatchSenderId':
      return failed('EXPO_MISMATCH_SENDER_ID', providerReference);
    case 'InvalidCredentials':
      return failed('EXPO_INVALID_CREDENTIALS', providerReference);
    default:
      return unknown(responseUnknownReason(phase), providerReference);
  }
}

function mapProviderItem(
  value: unknown,
  phase: ExpoResponsePhase,
  receiptReference: string | null,
): ExpoProviderOutcome {
  if (!isPlainRecord(value)) {
    return unknown(responseInvalidReason(phase), receiptReference);
  }
  if (value.status === 'ok') {
    const reference = phase === 'ticket' ? value.id : receiptReference;
    return typeof reference === 'string'
      ? accepted(reference)
      : unknown(responseInvalidReason(phase), receiptReference);
  }
  if (value.status !== 'error') {
    return unknown(responseInvalidReason(phase), receiptReference);
  }
  const details = value.details;
  const providerError = isPlainRecord(details) ? details.error : undefined;
  return typeof providerError === 'string'
    ? mapExpoProviderError(providerError, phase, receiptReference)
    : unknown(responseUnknownReason(phase), receiptReference);
}

function hasTopLevelErrors(value: Record<string, unknown>): boolean {
  return Array.isArray(value.errors) && value.errors.length > 0;
}

/** Positionally maps untrusted Expo tickets, preserving partial failures. */
export function parseExpoTicketResponse(
  value: unknown,
  expectedCount: number,
): readonly ExpoProviderOutcome[] {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    expectedCount > EXPO_SEND_CHUNK_SIZE
  ) {
    throw new TypeError('Expo ticket count is invalid.');
  }
  const invalid = (): readonly ExpoProviderOutcome[] =>
    Object.freeze(
      Array.from({ length: expectedCount }, () =>
        unknown('EXPO_TICKET_RESPONSE_INVALID'),
      ),
    );
  if (
    !isPlainRecord(value) ||
    hasTopLevelErrors(value) ||
    !Array.isArray(value.data) ||
    value.data.length > expectedCount
  ) {
    return invalid();
  }
  const data: readonly unknown[] = value.data;
  return Object.freeze(
    Array.from({ length: expectedCount }, (_unused, index) =>
      index < data.length
        ? mapProviderItem(data[index], 'ticket', null)
        : unknown('EXPO_TICKET_MISSING'),
    ),
  );
}

/** Maps receipt IDs by key; omitted and malformed receipts become unknown. */
export function parseExpoReceiptResponse(
  value: unknown,
  receiptIds: readonly string[],
): readonly ExpoProviderOutcome[] {
  if (
    receiptIds.length < 1 ||
    receiptIds.length > EXPO_RECEIPT_CHUNK_SIZE ||
    new Set(receiptIds).size !== receiptIds.length ||
    receiptIds.some((id) => !SAFE_PROVIDER_REFERENCE_PATTERN.test(id))
  ) {
    throw new TypeError('Expo receipt IDs are invalid.');
  }
  if (
    !isPlainRecord(value) ||
    hasTopLevelErrors(value) ||
    !isPlainRecord(value.data)
  ) {
    return Object.freeze(
      receiptIds.map((id) => unknown('EXPO_RECEIPT_RESPONSE_INVALID', id)),
    );
  }
  const data: Readonly<Record<string, unknown>> = value.data;
  return Object.freeze(
    receiptIds.map((id) =>
      Object.hasOwn(data, id)
        ? mapProviderItem(data[id], 'receipt', id)
        : unknown('EXPO_RECEIPT_MISSING', id),
    ),
  );
}

function categoryFor(
  templateMode: WorkerAttemptWorkItem['batch']['templateMode'],
): Readonly<{
  categoryId: ExpoCategoryId;
  channelId: typeof EXPO_ANDROID_CHANNEL_ID;
}> {
  return templateMode === 'real'
    ? Object.freeze({
        categoryId: EXPO_INCIDENT_CATEGORY_ID,
        channelId: EXPO_ANDROID_CHANNEL_ID,
      })
    : Object.freeze({
        categoryId: EXPO_DRILL_CATEGORY_ID,
        channelId: EXPO_ANDROID_CHANNEL_ID,
      });
}

/**
 * Preserves renderer-owned copy byte-for-byte and derives classification UI
 * only from the repeated canonical template mode, never editable message text.
 */
export function createExpoPushMessage(
  workValue: WorkerAttemptWorkItem | unknown,
): ExpoPushMessage {
  const workItem = parseWorkerAttemptWorkItem(workValue);
  if (
    workItem.batch.channel !== 'push' ||
    workItem.endpoint.channel !== 'push'
  ) {
    throw new TypeError('Expo Push accepts only canonical push work.');
  }
  const rendered = workItem.batch.renderedMessage;
  if (rendered.channel !== 'push') {
    throw new TypeError('Expo Push rendered copy is invalid.');
  }
  return Object.freeze({
    to: workItem.endpoint.token,
    title: rendered.title,
    body: rendered.body,
    sound: 'default',
    priority: 'high',
    ...categoryFor(workItem.batch.templateMode),
    data: Object.freeze({
      eventId: workItem.batch.eventId,
      eventKind: workItem.batch.eventKind,
      templateMode: workItem.batch.templateMode,
      purpose: workItem.batch.purpose,
    }),
  });
}

/** Stable bounded chunks used for both send tickets and receipt queries. */
export function chunkExpoValues<Value>(
  values: readonly Value[],
  maximum: number,
): readonly (readonly Value[])[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000) {
    throw new TypeError('Expo chunk size is invalid.');
  }
  const chunks: Array<readonly Value[]> = [];
  for (let offset = 0; offset < values.length; offset += maximum) {
    chunks.push(Object.freeze(values.slice(offset, offset + maximum)));
  }
  return Object.freeze(chunks);
}
