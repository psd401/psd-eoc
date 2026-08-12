import { createHash } from 'node:crypto';

import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  TimestampSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
} from '@psd-eoc/contracts';

import type {
  AttemptEvidenceInput,
  AttemptEvidenceWriter,
} from '../shared/delivery-state-client';
import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import {
  DEFAULT_RETRY_POLICY,
  normalizeProviderFailure,
  type ProviderFailureDisposition,
} from '../shared/retry';
import type { PushEndpointInvalidator } from './invalidation';
import {
  EXPO_PUSH_PROVIDER,
  EXPO_RECEIPT_CHUNK_SIZE,
  EXPO_EMERGENCY_TTL_SECONDS,
  chunkExpoValues,
  expired,
  isExpoSafeReasonCode,
  parseExpoProviderOutcome,
  unknown,
  type ExpoProviderOutcome,
  type ExpoSafeReasonCode,
} from './protocol';
import type { ExpoPushTransport } from './transport';

export const EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS = 15 * 60_000;
export const EXPO_RECEIPT_HORIZON_MILLISECONDS = (23 * 60 + 45) * 60_000;
export const EXPO_RECEIPT_RETRY_BASE_DELAY_MILLISECONDS = 60_000;
export const EXPO_RECEIPT_RETRY_MAX_DELAY_MILLISECONDS = 60 * 60_000;

const DEFAULT_LEASE_MILLISECONDS = 2 * 60_000;
const MAX_LEASE_CLOCK_SKEW_MILLISECONDS = 30_000;
const MAX_CLAIMS = EXPO_RECEIPT_CHUNK_SIZE;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_LEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_PROVIDER_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export interface PersistedExpoReceiptTarget {
  readonly attempt: ChannelAttempt;
  readonly receiptId: string;
  readonly providerAcceptedEvidence: DeliveryEvidence;
  readonly batchCreatedAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export interface ExpoReceiptScheduleRequest {
  readonly target: PersistedExpoReceiptTarget;
  readonly firstPollAt: string;
  readonly horizonAt: string;
}

export interface ExpoReceiptClaimRequest {
  readonly now: string;
  readonly limit: number;
  readonly leaseMilliseconds: number;
}

export interface ExpoReceiptClaim {
  readonly target: PersistedExpoReceiptTarget;
  readonly dueAt: string;
  readonly horizonAt: string;
  readonly pollAttemptNumber: number;
  readonly lastReasonCode: ExpoSafeReasonCode | null;
  readonly pendingAction: ExpoReceiptPendingAction | null;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface ExpoReceiptResendRequest {
  readonly sourceAttempt: ChannelAttempt;
  readonly sourceFingerprint: string;
  readonly receiptId: string;
  readonly nextAttemptNumber: number;
  readonly delayMilliseconds: number;
  readonly retryAt: string;
  readonly expiresAt: string;
  readonly reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED';
}

export type ExpoReceiptResendResult = Readonly<{
  kind: 'scheduled' | 'expired';
}>;

/**
 * Schedules the next immutable send attempt. Implementations must durably and
 * idempotently key the request by sourceAttempt.id plus sourceFingerprint. An
 * exact retained request always replays as `scheduled`, including after its
 * deadline. Only an absent request checked against the scheduler's
 * authoritative clock may return `expired`; conflicts reject. The next
 * attempt preserves retryAt and the original expiresAt without re-anchoring.
 */
export interface ExpoReceiptResendScheduler {
  scheduleReceiptRetry(
    request: ExpoReceiptResendRequest,
  ): Promise<ExpoReceiptResendResult>;
}

export type ExpoReceiptDefiniteFailureReasonCode =
  | 'EXPO_DEVICE_NOT_REGISTERED'
  | 'EXPO_MESSAGE_TOO_BIG'
  | 'EXPO_MISMATCH_SENDER_ID'
  | 'EXPO_INVALID_CREDENTIALS'
  | 'PROVIDER_RETRY_EXHAUSTED';

export type ExpoReceiptPendingAction =
  | Readonly<{
      kind: 'terminal-failure';
      state: 'failed';
      reasonCode: ExpoReceiptDefiniteFailureReasonCode;
      invalidatesEndpoint: boolean;
    }>
  | Readonly<{
      kind: 'terminal-expiry';
      state: 'expired';
      reasonCode: 'EXPO_NOTIFICATION_EXPIRED';
    }>
  | Readonly<{
      kind: 'resend';
      state: 'failed';
      reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED';
      nextAttemptNumber: number;
      delayMilliseconds: number;
      retryAt: string;
      expiresAt: string;
    }>;

export type ExpoReceiptDurableDecision =
  | Readonly<{
      kind: 'known-outcome-pending';
      decidedAt: string;
      action: ExpoReceiptPendingAction;
    }>
  | Readonly<{
      kind: 'reschedule';
      decidedAt: string;
      nextPollAt: string;
      nextPollAttemptNumber: number;
      reasonCode: ExpoSafeReasonCode;
    }>
  | Readonly<{
      kind: 'complete';
      decidedAt: string;
      state: 'provider-accepted';
    }>
  | Readonly<{
      kind: 'resend-scheduled';
      decidedAt: string;
      state: 'failed';
      reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED';
      nextAttemptNumber: number;
      delayMilliseconds: number;
      retryAt: string;
      expiresAt: string;
    }>
  | Readonly<{
      kind: 'terminal-dlq';
      decidedAt: string;
      state: 'failed' | 'expired' | 'unknown';
      reasonCode: ExpoSafeReasonCode;
    }>;

export interface ExpoReceiptDecisionRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly leaseToken: string;
  readonly decision: ExpoReceiptDurableDecision;
}

/**
 * Production implementations must be durable. schedule is idempotent by
 * attempt ID plus fingerprint. claimDue atomically leases only due work until
 * leaseExpiresAt. An implementation must reclaim a lease whose expiry is less
 * than or equal to its authoritative current time with a new, unique token.
 * A returned expiry must be later than request.now and no more than the
 * requested lease plus 30 seconds of bounded store/worker clock skew.
 * decide must atomically reject expired, superseded, or otherwise mismatched
 * lease tokens using that same authoritative clock; decidedAt is audit data,
 * not a substitute for the store's clock. A known-outcome-pending decision
 * durably stores its token-free action while retaining the current lease;
 * claimDue must return that action after a lease is reclaimed. Only the
 * matching terminal-dlq or resend-scheduled decision may clear it.
 */
export interface DurableExpoReceiptStore {
  schedule(request: ExpoReceiptScheduleRequest): Promise<void>;
  claimDue(
    request: ExpoReceiptClaimRequest,
  ): Promise<readonly ExpoReceiptClaim[]>;
  decide(request: ExpoReceiptDecisionRequest): Promise<void>;
}

export interface ExpoReceiptScheduler {
  readonly provider: string;
  scheduleProviderAccepted(
    workItem: WorkerAttemptWorkItem,
    providerAcceptedEvidence: DeliveryEvidence,
  ): Promise<void>;
}

export type ExpoReceiptLifecycleResult = Readonly<{
  attemptId: string;
  decision: ExpoReceiptDurableDecision;
}>;

export interface ExpoReceiptLifecycleOptions {
  readonly store: DurableExpoReceiptStore;
  readonly transport: ExpoPushTransport;
  readonly evidenceWriter: AttemptEvidenceWriter;
  readonly endpointInvalidator: PushEndpointInvalidator;
  readonly resendScheduler: ExpoReceiptResendScheduler;
  readonly provider?: string;
  readonly clock?: () => string;
  readonly random?: () => number;
  readonly leaseMilliseconds?: number;
  /** Must match the send worker's canonical retry policy. */
  readonly maxSendAttempts?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function timestamp(value: unknown, message: string): string {
  const result = TimestampSchema.safeParse(value);
  if (!result.success) throw new TypeError(message);
  return result.data;
}

function timestampAfter(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function targetFingerprint(
  attempt: ChannelAttempt,
  receiptId: string,
  providerAcceptedEvidence: DeliveryEvidence,
  batchCreatedAt: string,
  expiresAt: string,
): string {
  return createHash('sha256')
    .update(
      stableJson({
        attempt,
        providerAcceptedEvidence,
        receiptId,
        batchCreatedAt,
        expiresAt,
      }),
      'utf8',
    )
    .digest('hex');
}

export function createPersistedExpoReceiptTarget(
  workValue: WorkerAttemptWorkItem | unknown,
  providerAcceptedEvidenceValue: DeliveryEvidence | unknown,
): PersistedExpoReceiptTarget {
  const workItem = parseWorkerAttemptWorkItem(workValue);
  const attemptResult = ChannelAttemptSchema.safeParse(workItem.attempt);
  const evidenceResult = DeliveryEvidenceSchema.safeParse(
    providerAcceptedEvidenceValue,
  );
  if (!attemptResult.success || !evidenceResult.success) {
    throw new TypeError('Expo receipt target is invalid.');
  }
  const attempt = attemptResult.data;
  const batchCreatedAt = timestamp(
    workItem.batch.createdAt,
    'Expo receipt target is invalid.',
  );
  const expiresAt = timestampAfter(
    batchCreatedAt,
    EXPO_EMERGENCY_TTL_SECONDS * 1_000,
  );
  const providerAcceptedEvidence = evidenceResult.data;
  const receiptId = providerAcceptedEvidence.providerReference;
  if (
    attempt.channel !== 'push' ||
    providerAcceptedEvidence.state !== 'provider-accepted' ||
    providerAcceptedEvidence.subject.kind !== 'attempt' ||
    providerAcceptedEvidence.subject.attemptId !== attempt.id ||
    receiptId === null ||
    !SAFE_REFERENCE_PATTERN.test(receiptId)
  ) {
    throw new TypeError('Expo receipt target is invalid.');
  }
  return Object.freeze({
    attempt,
    receiptId,
    providerAcceptedEvidence,
    batchCreatedAt,
    expiresAt,
    fingerprint: targetFingerprint(
      attempt,
      receiptId,
      providerAcceptedEvidence,
      batchCreatedAt,
      expiresAt,
    ),
  });
}

function targetFingerprintFromPersisted(
  attempt: ChannelAttempt,
  receiptId: string,
  providerAcceptedEvidence: DeliveryEvidence,
  batchCreatedAt: string,
  expiresAt: string,
): string {
  return targetFingerprint(
    attempt,
    receiptId,
    providerAcceptedEvidence,
    batchCreatedAt,
    expiresAt,
  );
}

export function parsePersistedExpoReceiptTarget(
  value: PersistedExpoReceiptTarget | unknown,
): PersistedExpoReceiptTarget {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'attempt',
      'receiptId',
      'providerAcceptedEvidence',
      'batchCreatedAt',
      'expiresAt',
      'fingerprint',
    ]) ||
    typeof value.fingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    throw new TypeError('Persisted Expo receipt target is invalid.');
  }
  const attemptResult = ChannelAttemptSchema.safeParse(value.attempt);
  const evidenceResult = DeliveryEvidenceSchema.safeParse(
    value.providerAcceptedEvidence,
  );
  const batchCreatedAt = timestamp(
    value.batchCreatedAt,
    'Persisted Expo receipt target is invalid.',
  );
  const expiresAt = timestamp(
    value.expiresAt,
    'Persisted Expo receipt target is invalid.',
  );
  if (
    !attemptResult.success ||
    !evidenceResult.success ||
    attemptResult.data.channel !== 'push' ||
    evidenceResult.data.state !== 'provider-accepted' ||
    evidenceResult.data.subject.kind !== 'attempt' ||
    evidenceResult.data.subject.attemptId !== attemptResult.data.id ||
    evidenceResult.data.providerReference !== value.receiptId ||
    typeof value.receiptId !== 'string' ||
    !SAFE_REFERENCE_PATTERN.test(value.receiptId) ||
    expiresAt !==
      timestampAfter(batchCreatedAt, EXPO_EMERGENCY_TTL_SECONDS * 1_000) ||
    value.fingerprint !==
      targetFingerprintFromPersisted(
        attemptResult.data,
        value.receiptId,
        evidenceResult.data,
        batchCreatedAt,
        expiresAt,
      )
  ) {
    throw new TypeError('Persisted Expo receipt target is invalid.');
  }
  return Object.freeze({
    attempt: attemptResult.data,
    receiptId: value.receiptId,
    providerAcceptedEvidence: evidenceResult.data,
    batchCreatedAt,
    expiresAt,
    fingerprint: value.fingerprint,
  });
}

function parseProvider(value: string): string {
  if (
    value.length < 1 ||
    value.length > 100 ||
    !SAFE_PROVIDER_PATTERN.test(value)
  ) {
    throw new TypeError('Expo receipt provider is invalid.');
  }
  return value;
}

function parseLease(value: number | undefined): number {
  const lease = value ?? DEFAULT_LEASE_MILLISECONDS;
  if (!Number.isSafeInteger(lease) || lease < 1_000 || lease > 15 * 60_000) {
    throw new TypeError('Expo receipt lease is invalid.');
  }
  return lease;
}

function parseMaxSendAttempts(value: number | undefined): number {
  const maximum = value ?? DEFAULT_RETRY_POLICY.maxAttempts;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10) {
    throw new TypeError('Expo receipt send retry budget is invalid.');
  }
  return maximum;
}

function boundedFailureCode(
  code: string,
  disposition: ProviderFailureDisposition,
): ExpoSafeReasonCode {
  if (isExpoSafeReasonCode(code)) return code;
  return disposition === 'ambiguous'
    ? 'EXPO_NETWORK_OUTCOME_AMBIGUOUS'
    : 'EXPO_RECEIPT_ERROR_UNKNOWN';
}

function isDefiniteReceiptFailureReason(
  value: unknown,
): value is ExpoReceiptDefiniteFailureReasonCode {
  return (
    value === 'EXPO_DEVICE_NOT_REGISTERED' ||
    value === 'EXPO_MESSAGE_TOO_BIG' ||
    value === 'EXPO_MISMATCH_SENDER_ID' ||
    value === 'EXPO_INVALID_CREDENTIALS' ||
    value === 'PROVIDER_RETRY_EXHAUSTED'
  );
}

function parsePendingAction(
  value: unknown,
  sourceAttemptNumber: number,
  maxSendAttempts: number,
  expectedExpiresAt: string,
): ExpoReceiptPendingAction | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) {
    throw new TypeError('Expo receipt pending action is invalid.');
  }
  if (
    value.kind === 'terminal-failure' &&
    hasExactKeys(value, [
      'kind',
      'state',
      'reasonCode',
      'invalidatesEndpoint',
    ]) &&
    value.state === 'failed' &&
    isDefiniteReceiptFailureReason(value.reasonCode) &&
    typeof value.invalidatesEndpoint === 'boolean' &&
    value.invalidatesEndpoint ===
      (value.reasonCode === 'EXPO_DEVICE_NOT_REGISTERED')
  ) {
    return Object.freeze({
      kind: value.kind,
      state: value.state,
      reasonCode: value.reasonCode,
      invalidatesEndpoint: value.invalidatesEndpoint,
    });
  }
  if (
    value.kind === 'terminal-expiry' &&
    hasExactKeys(value, ['kind', 'state', 'reasonCode']) &&
    value.state === 'expired' &&
    value.reasonCode === 'EXPO_NOTIFICATION_EXPIRED'
  ) {
    return Object.freeze({
      kind: value.kind,
      state: value.state,
      reasonCode: value.reasonCode,
    });
  }
  const expectedNextAttemptNumber = sourceAttemptNumber + 1;
  if (
    value.kind === 'resend' &&
    hasExactKeys(value, [
      'kind',
      'state',
      'reasonCode',
      'nextAttemptNumber',
      'delayMilliseconds',
      'retryAt',
      'expiresAt',
    ]) &&
    value.state === 'failed' &&
    value.reasonCode === 'EXPO_MESSAGE_RATE_EXCEEDED' &&
    Number.isSafeInteger(value.nextAttemptNumber) &&
    value.nextAttemptNumber === expectedNextAttemptNumber &&
    expectedNextAttemptNumber <= maxSendAttempts &&
    Number.isSafeInteger(value.delayMilliseconds) &&
    Number(value.delayMilliseconds) >= 1 &&
    Number(value.delayMilliseconds) <=
      EXPO_RECEIPT_RETRY_MAX_DELAY_MILLISECONDS &&
    TimestampSchema.safeParse(value.retryAt).success &&
    value.expiresAt === expectedExpiresAt &&
    Date.parse(value.retryAt as string) < Date.parse(expectedExpiresAt)
  ) {
    return Object.freeze({
      kind: value.kind,
      state: value.state,
      reasonCode: value.reasonCode,
      nextAttemptNumber: value.nextAttemptNumber as number,
      delayMilliseconds: value.delayMilliseconds as number,
      retryAt: value.retryAt as string,
      expiresAt: value.expiresAt,
    });
  }
  throw new TypeError('Expo receipt pending action is invalid.');
}

function parseClaim(
  value: ExpoReceiptClaim | unknown,
  provider: string,
  now: string,
  leaseMilliseconds: number,
  maxSendAttempts: number,
): ExpoReceiptClaim {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'target',
      'dueAt',
      'horizonAt',
      'pollAttemptNumber',
      'lastReasonCode',
      'pendingAction',
      'leaseToken',
      'leaseExpiresAt',
    ])
  ) {
    throw new TypeError('Expo receipt claim is invalid.');
  }
  const target = parsePersistedExpoReceiptTarget(value.target);
  const dueAt = timestamp(value.dueAt, 'Expo receipt claim is invalid.');
  const horizonAt = timestamp(
    value.horizonAt,
    'Expo receipt claim is invalid.',
  );
  const leaseExpiresAt = timestamp(
    value.leaseExpiresAt,
    'Expo receipt claim is invalid.',
  );
  const expectedHorizon = timestampAfter(
    target.providerAcceptedEvidence.recordedAt,
    EXPO_RECEIPT_HORIZON_MILLISECONDS,
  );
  const expectedFirstPoll = timestampAfter(
    target.providerAcceptedEvidence.recordedAt,
    EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS,
  );
  const leaseDurationMilliseconds =
    Date.parse(leaseExpiresAt) - Date.parse(now);
  const pendingAction = parsePendingAction(
    value.pendingAction,
    target.attempt.attemptNumber,
    maxSendAttempts,
    target.expiresAt,
  );
  if (
    target.providerAcceptedEvidence.provider !== provider ||
    horizonAt !== expectedHorizon ||
    Date.parse(dueAt) > Date.parse(now) ||
    Date.parse(dueAt) < Date.parse(expectedFirstPoll) ||
    Date.parse(dueAt) > Date.parse(horizonAt) ||
    !Number.isSafeInteger(value.pollAttemptNumber) ||
    Number(value.pollAttemptNumber) < 1 ||
    Number(value.pollAttemptNumber) > 10_000 ||
    (value.pollAttemptNumber === 1 && dueAt !== expectedFirstPoll) ||
    (value.pollAttemptNumber === 1) !== (value.lastReasonCode === null) ||
    (value.lastReasonCode !== null &&
      !isExpoSafeReasonCode(value.lastReasonCode)) ||
    typeof value.leaseToken !== 'string' ||
    !SAFE_LEASE_PATTERN.test(value.leaseToken) ||
    leaseDurationMilliseconds <= 0 ||
    leaseDurationMilliseconds >
      leaseMilliseconds + MAX_LEASE_CLOCK_SKEW_MILLISECONDS
  ) {
    throw new TypeError('Expo receipt claim is invalid.');
  }
  return Object.freeze({
    target,
    dueAt,
    horizonAt,
    pollAttemptNumber: value.pollAttemptNumber as number,
    lastReasonCode: value.lastReasonCode as ExpoSafeReasonCode | null,
    pendingAction,
    leaseToken: value.leaseToken,
    leaseExpiresAt,
  });
}

function retryDelayMilliseconds(
  pollAttemptNumber: number,
  random: () => number,
): number {
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new TypeError('Expo receipt retry random source is invalid.');
  }
  const exponential = Math.min(
    EXPO_RECEIPT_RETRY_MAX_DELAY_MILLISECONDS,
    EXPO_RECEIPT_RETRY_BASE_DELAY_MILLISECONDS *
      2 ** Math.min(pollAttemptNumber - 1, 20),
  );
  const jitter = 0.8 + randomValue * 0.4;
  return Math.max(
    1,
    Math.min(
      EXPO_RECEIPT_RETRY_MAX_DELAY_MILLISECONDS,
      Math.round(exponential * jitter),
    ),
  );
}

function retryableReceiptOutcome(outcome: ExpoProviderOutcome): boolean {
  return (
    outcome.kind === 'unknown' &&
    (outcome.reasonCode === 'EXPO_RECEIPT_MISSING' ||
      outcome.reasonCode === 'EXPO_RECEIPT_RESPONSE_INVALID' ||
      outcome.reasonCode === 'EXPO_RECEIPT_ERROR_UNKNOWN')
  );
}

function invalidationInput(attempt: ChannelAttempt) {
  return Object.freeze({
    rosterSnapshotId: attempt.rosterSnapshotId,
    recipientId: attempt.recipientId,
    endpointId: attempt.endpointId,
    status: 'invalid' as const,
    reasonCode: 'EXPO_DEVICE_NOT_REGISTERED' as const,
  });
}

/** Durable scheduler and due-work runner; it never records delivered. */
export class ExpoReceiptLifecycle implements ExpoReceiptScheduler {
  readonly #store: DurableExpoReceiptStore;
  readonly #transport: ExpoPushTransport;
  readonly #writer: AttemptEvidenceWriter;
  readonly #invalidator: PushEndpointInvalidator;
  readonly #resendScheduler: ExpoReceiptResendScheduler;
  public readonly provider: string;
  readonly #clock: () => string;
  readonly #random: () => number;
  readonly #leaseMilliseconds: number;
  readonly #maxSendAttempts: number;

  public constructor(options: ExpoReceiptLifecycleOptions) {
    if (typeof options.resendScheduler?.scheduleReceiptRetry !== 'function') {
      throw new TypeError('Expo receipt resend scheduler is invalid.');
    }
    this.#store = options.store;
    this.#transport = options.transport;
    this.#writer = options.evidenceWriter;
    this.#invalidator = options.endpointInvalidator;
    this.#resendScheduler = options.resendScheduler;
    this.provider = parseProvider(options.provider ?? EXPO_PUSH_PROVIDER);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#random = options.random ?? Math.random;
    this.#leaseMilliseconds = parseLease(options.leaseMilliseconds);
    this.#maxSendAttempts = parseMaxSendAttempts(options.maxSendAttempts);
  }

  public async scheduleProviderAccepted(
    workValue: WorkerAttemptWorkItem,
    providerAcceptedEvidence: DeliveryEvidence,
  ): Promise<void> {
    const workItem = parseWorkerAttemptWorkItem(workValue);
    const target = createPersistedExpoReceiptTarget(
      workItem,
      providerAcceptedEvidence,
    );
    if (target.providerAcceptedEvidence.provider !== this.provider) {
      throw new TypeError('Expo receipt provider is invalid.');
    }
    await this.#store.schedule({
      target,
      firstPollAt: timestampAfter(
        target.providerAcceptedEvidence.recordedAt,
        EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS,
      ),
      horizonAt: timestampAfter(
        target.providerAcceptedEvidence.recordedAt,
        EXPO_RECEIPT_HORIZON_MILLISECONDS,
      ),
    });
  }

  public async runDue(
    limit = EXPO_RECEIPT_CHUNK_SIZE,
  ): Promise<readonly ExpoReceiptLifecycleResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLAIMS) {
      throw new TypeError('Expo receipt claim limit is invalid.');
    }
    const now = timestamp(this.#clock(), 'Expo receipt clock is invalid.');
    const rawClaims = await this.#store.claimDue({
      now,
      limit,
      leaseMilliseconds: this.#leaseMilliseconds,
    });
    if (!Array.isArray(rawClaims) || rawClaims.length > limit) {
      throw new TypeError('Expo receipt claims are invalid.');
    }
    const parsedClaims: ExpoReceiptClaim[] = [];
    for (const claim of rawClaims) {
      try {
        parsedClaims.push(
          parseClaim(
            claim,
            this.provider,
            now,
            this.#leaseMilliseconds,
            this.#maxSendAttempts,
          ),
        );
      } catch {
        // A malformed leased row cannot safely be decided without a validated
        // identity and fencing token. Isolate it until its lease is reclaimed.
      }
    }
    const attemptCounts = new Map<string, number>();
    const receiptCounts = new Map<string, number>();
    for (const claim of parsedClaims) {
      const attemptId = claim.target.attempt.id;
      const receiptId = claim.target.receiptId;
      attemptCounts.set(attemptId, (attemptCounts.get(attemptId) ?? 0) + 1);
      receiptCounts.set(receiptId, (receiptCounts.get(receiptId) ?? 0) + 1);
    }
    const claims = parsedClaims.filter(
      (claim) =>
        attemptCounts.get(claim.target.attempt.id) === 1 &&
        receiptCounts.get(claim.target.receiptId) === 1,
    );

    const results = new Map<string, ExpoReceiptLifecycleResult>();
    let firstFailure: unknown;
    let hasFailure = false;
    const settleClaim = async (
      claim: ExpoReceiptClaim,
      operation: () => Promise<ExpoReceiptLifecycleResult>,
    ): Promise<void> => {
      try {
        results.set(claim.target.attempt.id, await operation());
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = error;
        }
      }
    };
    const pollable: ExpoReceiptClaim[] = [];
    for (const claim of claims) {
      if (claim.pendingAction !== null) {
        await settleClaim(claim, () =>
          this.#executePendingAction(claim, claim.pendingAction!, now),
        );
      } else if (Date.parse(now) >= Date.parse(claim.horizonAt)) {
        await settleClaim(claim, () =>
          this.#recordTerminal(
            claim,
            unknown(
              claim.lastReasonCode ?? 'EXPO_RECEIPT_HORIZON_EXPIRED',
              claim.target.receiptId,
            ),
            now,
          ),
        );
      } else {
        pollable.push(claim);
      }
    }

    for (const chunk of chunkExpoValues(pollable, EXPO_RECEIPT_CHUNK_SIZE)) {
      let outcomes: readonly ExpoProviderOutcome[];
      try {
        const values = await this.#transport.queryReceiptChunk(
          chunk.map((claim) => claim.target.receiptId),
        );
        outcomes =
          values.length === chunk.length
            ? values.map((value, index) => {
                const parsed = parseExpoProviderOutcome(value);
                return parsed !== null &&
                  parsed.providerReference === chunk[index]!.target.receiptId
                  ? parsed
                  : unknown(
                      'EXPO_RECEIPT_RESPONSE_INVALID',
                      chunk[index]!.target.receiptId,
                    );
              })
            : chunk.map(() => unknown('EXPO_RECEIPT_RESPONSE_INVALID'));
      } catch (error) {
        const failure = normalizeProviderFailure(error);
        const reasonCode = boundedFailureCode(
          failure.code,
          failure.disposition,
        );
        for (const claim of chunk) {
          await settleClaim(claim, () =>
            this.#reschedule(claim, reasonCode, now),
          );
        }
        continue;
      }

      for (let index = 0; index < chunk.length; index += 1) {
        const claim = chunk[index]!;
        const outcome = outcomes[index]!;
        await settleClaim(claim, async () => {
          if (outcome.kind === 'provider-accepted') {
            return this.#complete(claim, now);
          }
          if (
            outcome.kind === 'retry' &&
            outcome.reasonCode === 'EXPO_MESSAGE_RATE_EXCEEDED'
          ) {
            const delayMilliseconds = retryDelayMilliseconds(
              claim.target.attempt.attemptNumber,
              this.#random,
            );
            const retryAt = timestampAfter(now, delayMilliseconds);
            if (
              claim.target.attempt.attemptNumber < this.#maxSendAttempts &&
              Date.parse(retryAt) < Date.parse(claim.target.expiresAt)
            ) {
              return this.#stageKnownOutcome(
                claim,
                Object.freeze({
                  kind: 'resend' as const,
                  state: 'failed' as const,
                  reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED' as const,
                  nextAttemptNumber: claim.target.attempt.attemptNumber + 1,
                  delayMilliseconds,
                  retryAt,
                  expiresAt: claim.target.expiresAt,
                }),
                now,
              );
            }
            if (Date.parse(retryAt) >= Date.parse(claim.target.expiresAt)) {
              return this.#stageKnownOutcome(
                claim,
                Object.freeze({
                  kind: 'terminal-expiry' as const,
                  state: 'expired' as const,
                  reasonCode: 'EXPO_NOTIFICATION_EXPIRED' as const,
                }),
                now,
              );
            }
            return this.#stageKnownOutcome(
              claim,
              Object.freeze({
                kind: 'terminal-failure' as const,
                state: 'failed' as const,
                reasonCode: 'PROVIDER_RETRY_EXHAUSTED' as const,
                invalidatesEndpoint: false as const,
              }),
              now,
            );
          }
          if (
            retryableReceiptOutcome(outcome) ||
            (outcome.kind === 'unknown' &&
              outcome.reasonCode === 'EXPO_NETWORK_OUTCOME_AMBIGUOUS')
          ) {
            return this.#reschedule(claim, outcome.reasonCode, now);
          }
          if (outcome.kind === 'retry') {
            return this.#reschedule(
              claim,
              'EXPO_RECEIPT_RESPONSE_INVALID',
              now,
            );
          }
          if (
            outcome.kind === 'failed' &&
            isDefiniteReceiptFailureReason(outcome.reasonCode)
          ) {
            return this.#stageKnownOutcome(
              claim,
              Object.freeze({
                kind: 'terminal-failure',
                state: 'failed',
                reasonCode: outcome.reasonCode,
                invalidatesEndpoint: outcome.invalidatesEndpoint,
              }),
              now,
            );
          }
          if (outcome.kind === 'failed') {
            return this.#reschedule(
              claim,
              'EXPO_RECEIPT_RESPONSE_INVALID',
              now,
            );
          }
          return this.#recordTerminal(claim, outcome, now);
        });
      }
    }

    if (hasFailure) throw firstFailure;
    return Object.freeze(
      claims.map((claim) => {
        const result = results.get(claim.target.attempt.id);
        if (result === undefined) {
          throw new TypeError('Expo receipt lifecycle result is missing.');
        }
        return result;
      }),
    );
  }

  async #complete(
    claim: ExpoReceiptClaim,
    now: string,
  ): Promise<ExpoReceiptLifecycleResult> {
    const decision: ExpoReceiptDurableDecision = Object.freeze({
      kind: 'complete',
      decidedAt: now,
      state: 'provider-accepted',
    });
    await this.#store.decide({
      attemptId: claim.target.attempt.id,
      fingerprint: claim.target.fingerprint,
      leaseToken: claim.leaseToken,
      decision,
    });
    return Object.freeze({
      attemptId: claim.target.attempt.id,
      decision,
    });
  }

  async #reschedule(
    claim: ExpoReceiptClaim,
    reasonCode: ExpoSafeReasonCode,
    now: string,
  ): Promise<ExpoReceiptLifecycleResult> {
    const nextPollAt = new Date(
      Math.min(
        Date.parse(claim.horizonAt),
        Date.parse(now) +
          retryDelayMilliseconds(claim.pollAttemptNumber, this.#random),
      ),
    ).toISOString();
    const decision: ExpoReceiptDurableDecision = Object.freeze({
      kind: 'reschedule',
      decidedAt: now,
      nextPollAt,
      nextPollAttemptNumber: claim.pollAttemptNumber + 1,
      reasonCode,
    });
    await this.#store.decide({
      attemptId: claim.target.attempt.id,
      fingerprint: claim.target.fingerprint,
      leaseToken: claim.leaseToken,
      decision,
    });
    return Object.freeze({
      attemptId: claim.target.attempt.id,
      decision,
    });
  }

  async #stageKnownOutcome(
    claim: ExpoReceiptClaim,
    action: ExpoReceiptPendingAction,
    now: string,
  ): Promise<ExpoReceiptLifecycleResult> {
    const parsedAction = parsePendingAction(
      action,
      claim.target.attempt.attemptNumber,
      this.#maxSendAttempts,
      claim.target.expiresAt,
    );
    if (parsedAction === null) {
      throw new TypeError('Expo receipt pending action is invalid.');
    }
    const decision: ExpoReceiptDurableDecision = Object.freeze({
      kind: 'known-outcome-pending',
      decidedAt: now,
      action: parsedAction,
    });
    await this.#store.decide({
      attemptId: claim.target.attempt.id,
      fingerprint: claim.target.fingerprint,
      leaseToken: claim.leaseToken,
      decision,
    });
    return this.#executePendingAction(claim, parsedAction, now);
  }

  async #executePendingAction(
    claim: ExpoReceiptClaim,
    action: ExpoReceiptPendingAction,
    now: string,
  ): Promise<ExpoReceiptLifecycleResult> {
    if (action.kind === 'resend') {
      return this.#scheduleResend(claim, action, now);
    }
    if (action.kind === 'terminal-expiry') {
      return this.#recordTerminal(claim, expired(claim.target.receiptId), now);
    }
    return this.#recordTerminal(
      claim,
      Object.freeze({
        kind: 'failed',
        state: action.state,
        providerReference: claim.target.receiptId,
        reasonCode: action.reasonCode,
        invalidatesEndpoint: action.invalidatesEndpoint,
      }),
      now,
    );
  }

  async #scheduleResend(
    claim: ExpoReceiptClaim,
    action: Extract<ExpoReceiptPendingAction, { kind: 'resend' }>,
    now: string,
  ): Promise<ExpoReceiptLifecycleResult> {
    const scheduleResult = await this.#resendScheduler.scheduleReceiptRetry(
      Object.freeze({
        sourceAttempt: claim.target.attempt,
        sourceFingerprint: claim.target.fingerprint,
        receiptId: claim.target.receiptId,
        nextAttemptNumber: action.nextAttemptNumber,
        delayMilliseconds: action.delayMilliseconds,
        retryAt: action.retryAt,
        expiresAt: action.expiresAt,
        reasonCode: action.reasonCode,
      }),
    );
    if (scheduleResult.kind === 'expired') {
      return this.#recordTerminal(claim, expired(claim.target.receiptId), now);
    }
    if (scheduleResult.kind !== 'scheduled') {
      throw new TypeError('Expo receipt resend result is invalid.');
    }
    const evidence: AttemptEvidenceInput = Object.freeze({
      subject: Object.freeze({
        kind: 'attempt',
        attemptId: claim.target.attempt.id,
      }),
      state: 'failed',
      provider: this.provider,
      providerReference: claim.target.receiptId,
      proof: null,
      reasonCode: action.reasonCode,
      diagnosticDigest: null,
    });
    await this.#writer.recordAttemptEvidence({
      attempt: claim.target.attempt,
      evidence,
    });
    const decision: ExpoReceiptDurableDecision = Object.freeze({
      kind: 'resend-scheduled',
      decidedAt: now,
      state: 'failed',
      reasonCode: action.reasonCode,
      nextAttemptNumber: action.nextAttemptNumber,
      delayMilliseconds: action.delayMilliseconds,
      retryAt: action.retryAt,
      expiresAt: action.expiresAt,
    });
    await this.#store.decide({
      attemptId: claim.target.attempt.id,
      fingerprint: claim.target.fingerprint,
      leaseToken: claim.leaseToken,
      decision,
    });
    return Object.freeze({
      attemptId: claim.target.attempt.id,
      decision,
    });
  }

  async #recordTerminal(
    claim: ExpoReceiptClaim,
    outcome: Exclude<ExpoProviderOutcome, { kind: 'provider-accepted' }>,
    now: string,
  ): Promise<ExpoReceiptLifecycleResult> {
    const evidence: AttemptEvidenceInput = Object.freeze({
      subject: Object.freeze({
        kind: 'attempt',
        attemptId: claim.target.attempt.id,
      }),
      state: outcome.state,
      provider: this.provider,
      providerReference: claim.target.receiptId,
      proof: null,
      reasonCode: outcome.reasonCode,
      diagnosticDigest: null,
    });
    await this.#writer.recordAttemptEvidence({
      attempt: claim.target.attempt,
      evidence,
    });
    if (outcome.invalidatesEndpoint) {
      await this.#invalidator.invalidate(
        invalidationInput(claim.target.attempt),
      );
    }
    const decision: ExpoReceiptDurableDecision = Object.freeze({
      kind: 'terminal-dlq',
      decidedAt: now,
      state: outcome.state,
      reasonCode: outcome.reasonCode,
    });
    await this.#store.decide({
      attemptId: claim.target.attempt.id,
      fingerprint: claim.target.fingerprint,
      leaseToken: claim.leaseToken,
      decision,
    });
    return Object.freeze({
      attemptId: claim.target.attempt.id,
      decision,
    });
  }
}
