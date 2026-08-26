import { createHash } from 'node:crypto';

import {
  MobilePushReceivePayloadSchema,
  type MobilePushReceivePayload,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';

export const APNS_DIRECT_PROVIDER = 'apns-direct' as const;
export const FCM_DIRECT_PROVIDER = 'fcm-direct' as const;
export const DIRECT_PUSH_TTL_SECONDS = 60 * 60;

export type DirectPushProvider =
  | typeof APNS_DIRECT_PROVIDER
  | typeof FCM_DIRECT_PROVIDER;

export type DirectPushReasonCode =
  | 'APNS_AUTHENTICATION_FAILED'
  | 'APNS_BAD_DEVICE_TOKEN'
  | 'APNS_ENDPOINT_INELIGIBLE'
  | 'APNS_LIVE_TRANSPORT_DISABLED'
  | 'APNS_NETWORK_OUTCOME_AMBIGUOUS'
  | 'APNS_NOTIFICATION_EXPIRED'
  | 'APNS_PAYLOAD_REJECTED'
  | 'APNS_RESPONSE_INVALID'
  | 'APNS_SERVER_ERROR'
  | 'APNS_THROTTLED'
  | 'APNS_TOPIC_REJECTED'
  | 'APNS_UNREGISTERED'
  | 'FCM_AUTHENTICATION_FAILED'
  | 'FCM_AUTHENTICATION_UNAVAILABLE'
  | 'FCM_ENDPOINT_INELIGIBLE'
  | 'FCM_INVALID_ARGUMENT'
  | 'FCM_LIVE_TRANSPORT_DISABLED'
  | 'FCM_NETWORK_OUTCOME_AMBIGUOUS'
  | 'FCM_NOTIFICATION_EXPIRED'
  | 'FCM_PAYLOAD_INVALID'
  | 'FCM_RESPONSE_INVALID'
  | 'FCM_SERVER_ERROR'
  | 'FCM_THROTTLED'
  | 'FCM_UNREGISTERED';

const DIRECT_PUSH_REASONS: ReadonlySet<string> = new Set<DirectPushReasonCode>([
  'APNS_AUTHENTICATION_FAILED',
  'APNS_BAD_DEVICE_TOKEN',
  'APNS_ENDPOINT_INELIGIBLE',
  'APNS_LIVE_TRANSPORT_DISABLED',
  'APNS_NETWORK_OUTCOME_AMBIGUOUS',
  'APNS_NOTIFICATION_EXPIRED',
  'APNS_PAYLOAD_REJECTED',
  'APNS_RESPONSE_INVALID',
  'APNS_SERVER_ERROR',
  'APNS_THROTTLED',
  'APNS_TOPIC_REJECTED',
  'APNS_UNREGISTERED',
  'FCM_AUTHENTICATION_FAILED',
  'FCM_AUTHENTICATION_UNAVAILABLE',
  'FCM_ENDPOINT_INELIGIBLE',
  'FCM_INVALID_ARGUMENT',
  'FCM_LIVE_TRANSPORT_DISABLED',
  'FCM_NETWORK_OUTCOME_AMBIGUOUS',
  'FCM_NOTIFICATION_EXPIRED',
  'FCM_PAYLOAD_INVALID',
  'FCM_RESPONSE_INVALID',
  'FCM_SERVER_ERROR',
  'FCM_THROTTLED',
  'FCM_UNREGISTERED',
]);

export type DirectPushProviderOutcome =
  | Readonly<{
      kind: 'provider-accepted';
      state: 'provider-accepted';
      providerReference: string;
      reasonCode: null;
      invalidatesEndpoint: false;
      providerOccurredAt: null;
    }>
  | Readonly<{
      kind: 'terminal-failure';
      state: 'failed';
      providerReference: string | null;
      reasonCode: DirectPushReasonCode;
      invalidatesEndpoint: false;
      providerOccurredAt: null;
    }>
  | Readonly<{
      kind: 'retryable-failure';
      state: 'failed';
      providerReference: string | null;
      reasonCode: DirectPushReasonCode;
      invalidatesEndpoint: false;
      providerOccurredAt: null;
    }>
  | Readonly<{
      kind: 'unknown';
      state: 'unknown';
      providerReference: string | null;
      reasonCode: DirectPushReasonCode;
      invalidatesEndpoint: false;
      providerOccurredAt: null;
    }>
  | Readonly<{
      kind: 'expired';
      state: 'expired';
      providerReference: null;
      reasonCode: 'APNS_NOTIFICATION_EXPIRED' | 'FCM_NOTIFICATION_EXPIRED';
      invalidatesEndpoint: false;
      providerOccurredAt: null;
    }>
  | Readonly<{
      kind: 'endpoint-invalidating-failure';
      state: 'failed';
      providerReference: string | null;
      reasonCode:
        | 'APNS_BAD_DEVICE_TOKEN'
        | 'APNS_UNREGISTERED'
        | 'FCM_INVALID_ARGUMENT'
        | 'FCM_UNREGISTERED';
      invalidatesEndpoint: true;
      providerOccurredAt: string | null;
    }>;

export interface DirectPushMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly expiration: number;
  readonly data: MobilePushReceivePayload;
}

const SAFE_PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const OUTCOME_KEYS = Object.freeze([
  'invalidatesEndpoint',
  'kind',
  'providerReference',
  'providerOccurredAt',
  'reasonCode',
  'state',
] as const);

function exactProperties(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (
      actual.length !== keys.length ||
      actual.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) {
      return null;
    }
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function canonicalCombination(
  properties: Readonly<Record<string, unknown>>,
): boolean {
  const { kind, state, reasonCode, invalidatesEndpoint } = properties;
  if (kind === 'provider-accepted') {
    return (
      state === 'provider-accepted' &&
      reasonCode === null &&
      invalidatesEndpoint === false
    );
  }
  if (typeof reasonCode !== 'string' || !DIRECT_PUSH_REASONS.has(reasonCode)) {
    return false;
  }
  if (kind === 'terminal-failure' || kind === 'retryable-failure') {
    const reasons =
      kind === 'terminal-failure'
        ? [
            'APNS_AUTHENTICATION_FAILED',
            'APNS_ENDPOINT_INELIGIBLE',
            'APNS_LIVE_TRANSPORT_DISABLED',
            'APNS_PAYLOAD_REJECTED',
            'APNS_TOPIC_REJECTED',
            'FCM_AUTHENTICATION_FAILED',
            'FCM_ENDPOINT_INELIGIBLE',
            'FCM_LIVE_TRANSPORT_DISABLED',
            'FCM_PAYLOAD_INVALID',
          ]
        : [
            'APNS_SERVER_ERROR',
            'APNS_THROTTLED',
            'FCM_SERVER_ERROR',
            'FCM_THROTTLED',
            'FCM_AUTHENTICATION_UNAVAILABLE',
          ];
    return (
      state === 'failed' &&
      invalidatesEndpoint === false &&
      reasons.includes(reasonCode)
    );
  }
  if (kind === 'unknown') {
    return (
      state === 'unknown' &&
      invalidatesEndpoint === false &&
      [
        'APNS_NETWORK_OUTCOME_AMBIGUOUS',
        'APNS_RESPONSE_INVALID',
        'FCM_NETWORK_OUTCOME_AMBIGUOUS',
        'FCM_RESPONSE_INVALID',
      ].includes(reasonCode)
    );
  }
  if (kind === 'expired') {
    return (
      state === 'expired' &&
      invalidatesEndpoint === false &&
      properties.providerReference === null &&
      (reasonCode === 'APNS_NOTIFICATION_EXPIRED' ||
        reasonCode === 'FCM_NOTIFICATION_EXPIRED')
    );
  }
  if (kind === 'endpoint-invalidating-failure') {
    return (
      state === 'failed' &&
      invalidatesEndpoint === true &&
      [
        'APNS_BAD_DEVICE_TOKEN',
        'APNS_UNREGISTERED',
        'FCM_INVALID_ARGUMENT',
        'FCM_UNREGISTERED',
      ].includes(reasonCode)
    );
  }
  return false;
}

/** Copies only exact canonical fields from an untrusted provider boundary. */
export function parseDirectPushProviderOutcome(
  value: unknown,
  expectedProvider: DirectPushProvider,
): DirectPushProviderOutcome | null {
  const properties = exactProperties(value, OUTCOME_KEYS);
  if (properties === null || !canonicalCombination(properties)) return null;
  const reference = properties.providerReference;
  if (
    reference !== null &&
    (typeof reference !== 'string' ||
      !SAFE_PROVIDER_REFERENCE_PATTERN.test(reference))
  ) {
    return null;
  }
  if (properties.kind === 'provider-accepted' && reference === null)
    return null;
  if (
    reference !== null &&
    (expectedProvider === APNS_DIRECT_PROVIDER
      ? !/^[A-Fa-f0-9-]{16,64}$/u.test(reference)
      : !/^fcm-[a-f0-9]{64}$/u.test(reference))
  ) {
    return null;
  }
  const reason = properties.reasonCode;
  if (
    typeof reason === 'string' &&
    !(expectedProvider === APNS_DIRECT_PROVIDER
      ? reason.startsWith('APNS_')
      : reason.startsWith('FCM_'))
  ) {
    return null;
  }
  const providerOccurredAt = properties.providerOccurredAt;
  if (
    reason === 'APNS_UNREGISTERED' &&
    expectedProvider === APNS_DIRECT_PROVIDER
  ) {
    if (
      typeof providerOccurredAt !== 'string' ||
      !Number.isFinite(Date.parse(providerOccurredAt))
    ) {
      return null;
    }
  } else if (providerOccurredAt !== null) {
    return null;
  }
  return Object.freeze({ ...properties }) as DirectPushProviderOutcome;
}

export function acceptedDirectPush(
  providerReference: string,
): DirectPushProviderOutcome {
  return Object.freeze({
    kind: 'provider-accepted',
    state: 'provider-accepted',
    providerReference,
    reasonCode: null,
    invalidatesEndpoint: false,
    providerOccurredAt: null,
  });
}

export function terminalDirectPush(
  reasonCode: DirectPushReasonCode,
  providerReference: string | null = null,
): DirectPushProviderOutcome {
  return Object.freeze({
    kind: 'terminal-failure',
    state: 'failed',
    providerReference,
    reasonCode,
    invalidatesEndpoint: false,
    providerOccurredAt: null,
  });
}

export function retryableDirectPush(
  reasonCode: DirectPushReasonCode,
  providerReference: string | null = null,
): DirectPushProviderOutcome {
  return Object.freeze({
    kind: 'retryable-failure',
    state: 'failed',
    providerReference,
    reasonCode,
    invalidatesEndpoint: false,
    providerOccurredAt: null,
  });
}

export function unknownDirectPush(
  reasonCode: DirectPushReasonCode,
  providerReference: string | null = null,
): DirectPushProviderOutcome {
  return Object.freeze({
    kind: 'unknown',
    state: 'unknown',
    providerReference,
    reasonCode,
    invalidatesEndpoint: false,
    providerOccurredAt: null,
  });
}

export function expiredDirectPush(
  provider: DirectPushProvider,
): DirectPushProviderOutcome {
  return Object.freeze({
    kind: 'expired',
    state: 'expired',
    providerReference: null,
    reasonCode:
      provider === APNS_DIRECT_PROVIDER
        ? 'APNS_NOTIFICATION_EXPIRED'
        : 'FCM_NOTIFICATION_EXPIRED',
    invalidatesEndpoint: false,
    providerOccurredAt: null,
  });
}

export function invalidatingDirectPush(
  reasonCode:
    | 'APNS_BAD_DEVICE_TOKEN'
    | 'APNS_UNREGISTERED'
    | 'FCM_INVALID_ARGUMENT'
    | 'FCM_UNREGISTERED',
  providerReference: string | null = null,
  providerOccurredAt: string | null = null,
): DirectPushProviderOutcome {
  return Object.freeze({
    kind: 'endpoint-invalidating-failure',
    state: 'failed',
    providerReference,
    reasonCode,
    invalidatesEndpoint: true,
    providerOccurredAt,
  });
}

export function safeFcmProviderReference(name: string): string | null {
  if (typeof name !== 'string' || name.length < 1 || name.length > 2_048) {
    return null;
  }
  return `fcm-${createHash('sha256').update(name, 'utf8').digest('hex')}`;
}

/** Builds canonical provider-neutral copy and an absolute request expiry. */
export function createDirectPushMessage(
  workValue: WorkerAttemptWorkItem | unknown,
): DirectPushMessage {
  const workItem = parseWorkerAttemptWorkItem(workValue);
  if (
    workItem.batch.channel !== 'push' ||
    workItem.endpoint.channel !== 'push' ||
    workItem.batch.renderedMessage.channel !== 'push'
  ) {
    throw new TypeError('Direct push accepts only canonical push work.');
  }
  return Object.freeze({
    token: workItem.endpoint.token,
    title: workItem.batch.renderedMessage.title,
    body: workItem.batch.renderedMessage.body,
    expiration:
      Math.floor(Date.parse(workItem.batch.createdAt) / 1_000) +
      DIRECT_PUSH_TTL_SECONDS,
    data: MobilePushReceivePayloadSchema.parse({
      version: 1,
      eventId: workItem.batch.eventId,
      eventKind: workItem.batch.eventKind,
      templateMode: workItem.batch.templateMode,
      facilityId: workItem.batch.facilityId,
      eventTypeVersionId: workItem.batch.eventTypeVersion.id,
      purpose: workItem.batch.purpose,
    }),
  });
}

export type DirectPushPreparation =
  | Readonly<{
      kind: 'prepared';
      provider: DirectPushProvider;
      /** Invokes the provider boundary synchronously before returning. */
      send(): Promise<DirectPushProviderOutcome | unknown>;
    }>
  | Readonly<{
      kind: 'outcome';
      provider: DirectPushProvider;
      outcome: DirectPushProviderOutcome | unknown;
    }>;

export interface DirectPushTransport {
  readonly provider: DirectPushProvider;
  /** Completes credentials and transport authorization without sending. */
  prepare(workItem: WorkerAttemptWorkItem): Promise<DirectPushPreparation>;
}
