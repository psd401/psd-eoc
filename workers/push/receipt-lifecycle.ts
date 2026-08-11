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
  normalizeProviderFailure,
  type ProviderFailureDisposition,
} from '../shared/retry';
import type { PushEndpointInvalidator } from './invalidation';
import {
  EXPO_PUSH_PROVIDER,
  EXPO_RECEIPT_CHUNK_SIZE,
  chunkExpoValues,
  failed,
  isExpoSafeReasonCode,
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
const MAX_CLAIMS = EXPO_RECEIPT_CHUNK_SIZE;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_LEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_PROVIDER_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export interface PersistedExpoReceiptTarget {
  readonly attempt: ChannelAttempt;
  readonly receiptId: string;
  readonly providerAcceptedEvidence: DeliveryEvidence;
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
  readonly leaseToken: string;
}

export type ExpoReceiptDurableDecision =
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
      kind: 'terminal-dlq';
      decidedAt: string;
      state: 'failed' | 'unknown';
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
 * attempt ID plus fingerprint, claimDue atomically leases only due work, and
 * decide fences mutation by fingerprint plus lease token.
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
    attempt: ChannelAttempt,
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
  readonly provider?: string;
  readonly clock?: () => string;
  readonly leaseMilliseconds?: number;
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
): string {
  return createHash('sha256')
    .update(
      stableJson({ attempt, providerAcceptedEvidence, receiptId }),
      'utf8',
    )
    .digest('hex');
}

export function createPersistedExpoReceiptTarget(
  attemptValue: ChannelAttempt | unknown,
  providerAcceptedEvidenceValue: DeliveryEvidence | unknown,
): PersistedExpoReceiptTarget {
  const attemptResult = ChannelAttemptSchema.safeParse(attemptValue);
  const evidenceResult = DeliveryEvidenceSchema.safeParse(
    providerAcceptedEvidenceValue,
  );
  if (!attemptResult.success || !evidenceResult.success) {
    throw new TypeError('Expo receipt target is invalid.');
  }
  const attempt = attemptResult.data;
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
    fingerprint: targetFingerprint(
      attempt,
      receiptId,
      providerAcceptedEvidence,
    ),
  });
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
      'fingerprint',
    ]) ||
    typeof value.fingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    throw new TypeError('Persisted Expo receipt target is invalid.');
  }
  const target = createPersistedExpoReceiptTarget(
    value.attempt,
    value.providerAcceptedEvidence,
  );
  if (
    value.receiptId !== target.receiptId ||
    value.fingerprint !== target.fingerprint
  ) {
    throw new TypeError('Persisted Expo receipt target is invalid.');
  }
  return target;
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

function boundedFailureCode(
  code: string,
  disposition: ProviderFailureDisposition,
): ExpoSafeReasonCode {
  if (isExpoSafeReasonCode(code)) return code;
  return disposition === 'ambiguous'
    ? 'EXPO_NETWORK_OUTCOME_AMBIGUOUS'
    : 'EXPO_RECEIPT_ERROR_UNKNOWN';
}

function parseClaim(
  value: ExpoReceiptClaim | unknown,
  provider: string,
  now: string,
): ExpoReceiptClaim {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'target',
      'dueAt',
      'horizonAt',
      'pollAttemptNumber',
      'lastReasonCode',
      'leaseToken',
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
  const expectedHorizon = timestampAfter(
    target.providerAcceptedEvidence.recordedAt,
    EXPO_RECEIPT_HORIZON_MILLISECONDS,
  );
  const expectedFirstPoll = timestampAfter(
    target.providerAcceptedEvidence.recordedAt,
    EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS,
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
    !SAFE_LEASE_PATTERN.test(value.leaseToken)
  ) {
    throw new TypeError('Expo receipt claim is invalid.');
  }
  return Object.freeze({
    target,
    dueAt,
    horizonAt,
    pollAttemptNumber: value.pollAttemptNumber as number,
    lastReasonCode: value.lastReasonCode as ExpoSafeReasonCode | null,
    leaseToken: value.leaseToken,
  });
}

function retryDelayMilliseconds(pollAttemptNumber: number): number {
  return Math.min(
    EXPO_RECEIPT_RETRY_MAX_DELAY_MILLISECONDS,
    EXPO_RECEIPT_RETRY_BASE_DELAY_MILLISECONDS *
      2 ** Math.min(pollAttemptNumber - 1, 20),
  );
}

function retryableReceiptOutcome(outcome: ExpoProviderOutcome): boolean {
  return (
    outcome.kind === 'retry' ||
    (outcome.kind === 'unknown' &&
      (outcome.reasonCode === 'EXPO_RECEIPT_MISSING' ||
        outcome.reasonCode === 'EXPO_RECEIPT_RESPONSE_INVALID' ||
        outcome.reasonCode === 'EXPO_RECEIPT_ERROR_UNKNOWN'))
  );
}

function validProviderOutcome(value: unknown): value is ExpoProviderOutcome {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'state',
      'providerReference',
      'reasonCode',
      'invalidatesEndpoint',
    ]) ||
    (value.providerReference !== null &&
      (typeof value.providerReference !== 'string' ||
        !SAFE_REFERENCE_PATTERN.test(value.providerReference)))
  ) {
    return false;
  }
  if (value.kind === 'provider-accepted') {
    return (
      value.state === 'provider-accepted' &&
      typeof value.providerReference === 'string' &&
      value.reasonCode === null &&
      value.invalidatesEndpoint === false
    );
  }
  if (
    !isExpoSafeReasonCode(value.reasonCode) ||
    typeof value.invalidatesEndpoint !== 'boolean'
  ) {
    return false;
  }
  if (value.kind === 'failed') {
    return (
      value.state === 'failed' &&
      value.invalidatesEndpoint ===
        (value.reasonCode === 'EXPO_DEVICE_NOT_REGISTERED')
    );
  }
  if (value.kind === 'retry') {
    return value.state === 'failed' && value.invalidatesEndpoint === false;
  }
  return (
    value.kind === 'unknown' &&
    value.state === 'unknown' &&
    value.invalidatesEndpoint === false
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
  public readonly provider: string;
  readonly #clock: () => string;
  readonly #leaseMilliseconds: number;

  public constructor(options: ExpoReceiptLifecycleOptions) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#writer = options.evidenceWriter;
    this.#invalidator = options.endpointInvalidator;
    this.provider = parseProvider(options.provider ?? EXPO_PUSH_PROVIDER);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#leaseMilliseconds = parseLease(options.leaseMilliseconds);
  }

  public async scheduleProviderAccepted(
    attempt: ChannelAttempt,
    providerAcceptedEvidence: DeliveryEvidence,
  ): Promise<void> {
    const target = createPersistedExpoReceiptTarget(
      attempt,
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
    const claims = rawClaims.map((claim) =>
      parseClaim(claim, this.provider, now),
    );
    if (
      new Set(claims.map((claim) => claim.target.attempt.id)).size !==
        claims.length ||
      new Set(claims.map((claim) => claim.target.receiptId)).size !==
        claims.length
    ) {
      throw new TypeError('Expo receipt claims are invalid.');
    }

    const results = new Map<string, ExpoReceiptLifecycleResult>();
    const pollable: ExpoReceiptClaim[] = [];
    for (const claim of claims) {
      if (Date.parse(now) >= Date.parse(claim.horizonAt)) {
        results.set(
          claim.target.attempt.id,
          await this.#recordTerminal(
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
            ? values.map((value, index) =>
                validProviderOutcome(value) &&
                value.providerReference === chunk[index]!.target.receiptId
                  ? value
                  : unknown(
                      'EXPO_RECEIPT_RESPONSE_INVALID',
                      chunk[index]!.target.receiptId,
                    ),
              )
            : chunk.map(() => unknown('EXPO_RECEIPT_RESPONSE_INVALID'));
      } catch (error) {
        const failure = normalizeProviderFailure(error);
        const reasonCode = boundedFailureCode(
          failure.code,
          failure.disposition,
        );
        if (failure.disposition !== 'terminal-failure') {
          for (const claim of chunk) {
            results.set(
              claim.target.attempt.id,
              await this.#reschedule(claim, reasonCode, now),
            );
          }
          continue;
        }
        outcomes = chunk.map(() => failed(reasonCode));
      }

      for (let index = 0; index < chunk.length; index += 1) {
        const claim = chunk[index]!;
        const outcome = outcomes[index]!;
        let result: ExpoReceiptLifecycleResult;
        if (outcome.kind === 'provider-accepted') {
          result = await this.#complete(claim, now);
        } else if (
          retryableReceiptOutcome(outcome) ||
          (outcome.kind === 'unknown' &&
            outcome.reasonCode === 'EXPO_NETWORK_OUTCOME_AMBIGUOUS')
        ) {
          result = await this.#reschedule(claim, outcome.reasonCode, now);
        } else {
          result = await this.#recordTerminal(claim, outcome, now);
        }
        results.set(claim.target.attempt.id, result);
      }
    }

    return Object.freeze(
      claims.map((claim) => results.get(claim.target.attempt.id)!),
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
        Date.parse(now) + retryDelayMilliseconds(claim.pollAttemptNumber),
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
