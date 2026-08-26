import {
  IntegrationIdSchema,
  IntegrationTruthLabelSchema,
  NotificationChannelSchema,
  RecordDeliveryEvidenceInputSchema,
  type DeliveryEvidence,
  type DeliveryProof,
  type IntegrationTruthLabel,
  type NotificationChannel,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  workerAttemptFingerprint,
  type WorkerAttemptWorkItem,
} from './attempt';
import type {
  AttemptEvidenceInput,
  AttemptEvidenceWriter,
} from './delivery-state-client';
import {
  DEFAULT_RETRY_POLICY,
  calculateRetryDelayMilliseconds,
  decideProviderRetry,
  parseRetryPolicy,
  type RetryPolicy,
} from './retry';

const SAFE_PROVIDER_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/u;

export type ProviderSendOutcome = (
  | Readonly<{
      state: 'provider-accepted';
      provider: string;
      providerReference: string;
      proof: null;
      reasonCode: null;
      diagnosticDigest: null;
    }>
  | Readonly<{
      state: 'delivered';
      provider: string;
      providerReference: string;
      proof: DeliveryProof;
      reasonCode: null;
      diagnosticDigest: null;
    }>
  | Readonly<{
      state: 'failed' | 'expired' | 'unknown';
      provider: string | null;
      providerReference: string | null;
      proof: null;
      reasonCode: string;
      diagnosticDigest: string | null;
    }>
) &
  Readonly<{ providerOccurredAt?: string }>;

export interface ProviderSendRequest {
  readonly workItem: WorkerAttemptWorkItem;
  readonly idempotencyKey: string;
}

export type ProviderRecoveryResult =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'in-progress' }>
  | Readonly<{
      kind: 'outcome';
      outcome: ProviderSendOutcome | unknown;
    }>
  | Readonly<{
      kind: 'provider-error';
      error: unknown;
    }>;

/** Adapter repeats of one attempt ID must produce at most one logical send. */
export interface AttemptIdempotentProviderAdapter {
  readonly channel: NotificationChannel;
  readonly integrationId: string;
  readonly truthLabel: IntegrationTruthLabel;
  readonly provider: string;
  readonly deliverySemantics: 'attempt-id-idempotent';
  /**
   * Optional read-only recovery from provider-adapter truth already retained
   * for this exact immutable attempt. It must never claim or send. `missing`
   * means ordinary processing may continue; `in-progress` prevents a blind
   * resend; outcomes and provider errors preserve the adapter's retained
   * result so the outer processor can apply its ordinary completion policy.
   */
  recover?(request: ProviderSendRequest): Promise<ProviderRecoveryResult>;
  send(request: ProviderSendRequest): Promise<ProviderSendOutcome | unknown>;
}

export interface AttemptExecutionClaimRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly leaseMilliseconds: number;
}

export interface AttemptExecutionLookupRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
}

export type AttemptExecutionCompletion =
  | Readonly<{
      kind: 'final';
      outcome: ProviderSendOutcome;
    }>
  | Readonly<{
      kind: 'retry';
      outcome: ProviderSendOutcome;
      delayMilliseconds: number;
      nextAttemptNumber: number;
      reasonCode: string;
    }>;

export type AttemptExecutionClaim =
  | Readonly<{ kind: 'acquired'; leaseToken: string }>
  | Readonly<{
      kind: 'completed';
      completion: AttemptExecutionCompletion;
    }>
  | Readonly<{ kind: 'in-progress' }>;

export type AttemptExecutionLookup =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'reclaimable' }>
  | Readonly<{
      kind: 'completed';
      completion: AttemptExecutionCompletion;
    }>
  | Readonly<{ kind: 'in-progress' }>;

export interface CompleteAttemptExecutionRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly leaseToken: string;
  readonly completion: AttemptExecutionCompletion;
}

export interface ReleaseAttemptExecutionRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly leaseToken: string;
}

/** Production implementations persist claims and reject fingerprint conflicts. */
export interface AttemptExecutionStore {
  /** Read-only recovery never acquires permission to call a provider. */
  lookup(
    request: AttemptExecutionLookupRequest,
  ): Promise<AttemptExecutionLookup>;
  claim(request: AttemptExecutionClaimRequest): Promise<AttemptExecutionClaim>;
  complete(request: CompleteAttemptExecutionRequest): Promise<void>;
  release(request: ReleaseAttemptExecutionRequest): Promise<void>;
}

export type LiveProviderAuthorizer = (
  workItem: WorkerAttemptWorkItem,
) => boolean | Promise<boolean>;

/** Optional channel-specific policy gate immediately before a new send. */
export type ProviderSendAuthorizer = (
  workItem: WorkerAttemptWorkItem,
) => boolean | Promise<boolean>;

/**
 * Fresh authorization checked after the immutable attempt is
 * claimed and immediately before any provider adapter can perform I/O.
 * Missing, stale, or unreadable control truth must resolve to `false`.
 */
export interface WorkerAttemptProcessorOptions {
  readonly adapter: AttemptIdempotentProviderAdapter;
  readonly executionStore: AttemptExecutionStore;
  readonly evidenceWriter: AttemptEvidenceWriter;
  readonly retryPolicy?: RetryPolicy;
  readonly leaseMilliseconds?: number;
  readonly random?: () => number;
  /** Omission disables live-verified providers. */
  readonly authorizeLiveProvider?: LiveProviderAuthorizer;
  readonly authorizeProviderSend?: ProviderSendAuthorizer;
}

export type WorkerProcessingErrorCode =
  | 'INVALID_ADAPTER'
  | 'ADAPTER_MISMATCH'
  | 'LIVE_PROVIDER_DISABLED'
  | 'PROVIDER_SEND_DISABLED'
  | 'RETRY_BUDGET_EXCEEDED'
  | 'INVALID_IDEMPOTENCY_CLAIM'
  | 'IDEMPOTENCY_STORE_FAILED'
  | 'INVALID_PROVIDER_OUTCOME';

export class WorkerProcessingError extends Error {
  public constructor(public readonly code: WorkerProcessingErrorCode) {
    super('The notification attempt could not be processed safely.');
    this.name = 'WorkerProcessingError';
  }
}

type FinalAttemptResult = Readonly<{
  kind: 'completed' | 'dlq';
  replayed: boolean;
  outcome: ProviderSendOutcome;
  attemptedEvidence: DeliveryEvidence;
  outcomeEvidence: DeliveryEvidence;
}>;

export type WorkerAttemptProcessResult =
  | FinalAttemptResult
  | Readonly<{
      kind: 'retry';
      replayed: boolean;
      delayMilliseconds: number;
      nextAttemptNumber: number;
      reasonCode: string;
      outcome: ProviderSendOutcome;
      attemptedEvidence: DeliveryEvidence;
      outcomeEvidence: DeliveryEvidence;
    }>
  | Readonly<{
      kind: 'in-progress';
      retryAfterMilliseconds: number;
    }>;

function parseLease(value: number | undefined): number {
  const lease = value ?? 2 * 60_000;
  if (!Number.isInteger(lease) || lease < 1_000 || lease > 15 * 60_000) {
    throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
  }
  return lease;
}

function validateAdapter(adapter: AttemptIdempotentProviderAdapter): void {
  if (
    !NotificationChannelSchema.safeParse(adapter.channel).success ||
    !IntegrationIdSchema.safeParse(adapter.integrationId).success ||
    !IntegrationTruthLabelSchema.safeParse(adapter.truthLabel).success ||
    adapter.provider.length < 1 ||
    adapter.provider.length > 100 ||
    adapter.provider.trim() !== adapter.provider ||
    !SAFE_PROVIDER_PATTERN.test(adapter.provider) ||
    adapter.deliverySemantics !== 'attempt-id-idempotent' ||
    (adapter.recover !== undefined && typeof adapter.recover !== 'function')
  ) {
    throw new WorkerProcessingError('INVALID_ADAPTER');
  }
}

function parseProviderOutcome(
  value: unknown,
  attemptId: string,
  expectedProvider: string,
): ProviderSendOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerProcessingError('INVALID_PROVIDER_OUTCOME');
  }
  const parsed = RecordDeliveryEvidenceInputSchema.safeParse({
    subject: { kind: 'attempt', attemptId },
    ...(value as Readonly<Record<string, unknown>>),
  });
  if (
    !parsed.success ||
    ![
      'provider-accepted',
      'delivered',
      'failed',
      'expired',
      'unknown',
    ].includes(parsed.data.state) ||
    (parsed.data.provider !== null && parsed.data.provider !== expectedProvider)
  ) {
    throw new WorkerProcessingError('INVALID_PROVIDER_OUTCOME');
  }
  return Object.freeze({
    state: parsed.data.state,
    provider: parsed.data.provider,
    providerReference: parsed.data.providerReference,
    proof: parsed.data.proof,
    reasonCode: parsed.data.reasonCode,
    diagnosticDigest: parsed.data.diagnosticDigest,
    ...(parsed.data.providerOccurredAt === undefined
      ? {}
      : { providerOccurredAt: parsed.data.providerOccurredAt }),
  }) as ProviderSendOutcome;
}

function attemptedInput(attemptId: string): AttemptEvidenceInput {
  return Object.freeze({
    subject: Object.freeze({ kind: 'attempt', attemptId }),
    state: 'attempted',
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
}

function finalInput(
  attemptId: string,
  outcome: ProviderSendOutcome,
): AttemptEvidenceInput {
  return Object.freeze({
    subject: Object.freeze({ kind: 'attempt', attemptId }),
    ...outcome,
  });
}

function failureOutcome(
  state: 'failed' | 'unknown',
  provider: string,
  reasonCode: string,
  diagnosticDigest: string | null,
): ProviderSendOutcome {
  return Object.freeze({
    state,
    provider,
    providerReference: null,
    proof: null,
    reasonCode,
    diagnosticDigest,
  });
}

function finalKind(outcome: ProviderSendOutcome): 'completed' | 'dlq' {
  return ['failed', 'expired', 'unknown'].includes(outcome.state)
    ? 'dlq'
    : 'completed';
}

function parseClaim(
  value: AttemptExecutionClaim,
  attemptId: string,
  provider: string,
): AttemptExecutionClaim {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
  }
  switch (value.kind) {
    case 'acquired':
      if (
        typeof value.leaseToken !== 'string' ||
        value.leaseToken.length < 1 ||
        value.leaseToken.length > 512
      ) {
        throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
      }
      return Object.freeze({ kind: 'acquired', leaseToken: value.leaseToken });
    case 'completed':
      return Object.freeze({
        kind: 'completed',
        completion: parseCompletion(value.completion, attemptId, provider),
      });
    case 'in-progress':
      return Object.freeze({ kind: 'in-progress' });
    default:
      throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
  }
}

function parseLookup(
  value: AttemptExecutionLookup,
  attemptId: string,
  provider: string,
): AttemptExecutionLookup {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
  }
  switch (value.kind) {
    case 'missing':
      return Object.freeze({ kind: 'missing' });
    case 'reclaimable':
      return Object.freeze({ kind: 'reclaimable' });
    case 'completed':
      return Object.freeze({
        kind: 'completed',
        completion: parseCompletion(value.completion, attemptId, provider),
      });
    case 'in-progress':
      return Object.freeze({ kind: 'in-progress' });
    default:
      throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
  }
}

function parseCompletion(
  value: AttemptExecutionCompletion,
  attemptId: string,
  provider: string,
): AttemptExecutionCompletion {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
  }
  const outcome = parseProviderOutcome(value.outcome, attemptId, provider);
  if (value.kind === 'final') {
    return Object.freeze({ kind: 'final', outcome });
  }
  if (
    value.kind !== 'retry' ||
    outcome.state !== 'failed' ||
    !Number.isInteger(value.delayMilliseconds) ||
    value.delayMilliseconds < 1 ||
    !Number.isInteger(value.nextAttemptNumber) ||
    value.nextAttemptNumber < 2 ||
    typeof value.reasonCode !== 'string' ||
    !/^[A-Z0-9_]{1,100}$/u.test(value.reasonCode)
  ) {
    throw new WorkerProcessingError('INVALID_IDEMPOTENCY_CLAIM');
  }
  return Object.freeze({
    kind: 'retry',
    outcome,
    delayMilliseconds: value.delayMilliseconds,
    nextAttemptNumber: value.nextAttemptNumber,
    reasonCode: value.reasonCode,
  });
}

/** Durable attempt processing for an at-least-once SQS delivery. */
export class WorkerAttemptProcessor {
  readonly #adapter: AttemptIdempotentProviderAdapter;
  readonly #store: AttemptExecutionStore;
  readonly #writer: AttemptEvidenceWriter;
  readonly #retryPolicy: RetryPolicy;
  readonly #leaseMilliseconds: number;
  readonly #random: () => number;
  readonly #authorizeLive: LiveProviderAuthorizer | undefined;
  readonly #authorizeSend: ProviderSendAuthorizer | undefined;

  public constructor(options: WorkerAttemptProcessorOptions) {
    validateAdapter(options.adapter);
    this.#adapter = options.adapter;
    this.#store = options.executionStore;
    this.#writer = options.evidenceWriter;
    this.#retryPolicy = parseRetryPolicy(
      options.retryPolicy ?? DEFAULT_RETRY_POLICY,
    );
    this.#leaseMilliseconds = parseLease(options.leaseMilliseconds);
    this.#random = options.random ?? Math.random;
    this.#authorizeLive = options.authorizeLiveProvider;
    this.#authorizeSend = options.authorizeProviderSend;
  }

  public async process(
    workValue: WorkerAttemptWorkItem | unknown,
  ): Promise<WorkerAttemptProcessResult> {
    const workItem = parseWorkerAttemptWorkItem(workValue);
    const batch = workItem.batch;
    if (
      this.#adapter.channel !== batch.channel ||
      this.#adapter.integrationId !== batch.integrationStatus.integrationId ||
      this.#adapter.truthLabel !== batch.integrationStatus.label
    ) {
      throw new WorkerProcessingError('ADAPTER_MISMATCH');
    }
    const attempt = workItem.attempt;
    const fingerprint = workerAttemptFingerprint(workItem);
    let recovered: AttemptExecutionLookup;
    try {
      recovered = parseLookup(
        await this.#store.lookup({
          attemptId: attempt.id,
          fingerprint,
        }),
        attempt.id,
        this.#adapter.provider,
      );
    } catch (error) {
      if (error instanceof WorkerProcessingError) throw error;
      throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
    }
    if (recovered.kind === 'in-progress') {
      return Object.freeze({
        kind: 'in-progress',
        retryAfterMilliseconds: calculateRetryDelayMilliseconds(
          attempt.attemptNumber,
          this.#retryPolicy,
          this.#random,
        ),
      });
    }
    if (recovered.kind === 'completed') {
      return this.#writeCompletion(attempt, recovered.completion, true);
    }

    // Both a genuinely missing attempt and an expired outer lease must first
    // consult the adapter's irreversible-send ledger. Only `claim` may issue
    // a new fencing token, and it happens below after recovery has proved that
    // a provider call is not already in progress or durably completed.

    if (this.#adapter.recover !== undefined) {
      let adapterRecovery: ProviderRecoveryResult;
      try {
        adapterRecovery = await this.#adapter.recover(
          Object.freeze({ workItem, idempotencyKey: attempt.id }),
        );
      } catch {
        throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
      }
      if (adapterRecovery.kind === 'in-progress') {
        return Object.freeze({
          kind: 'in-progress',
          retryAfterMilliseconds: calculateRetryDelayMilliseconds(
            attempt.attemptNumber,
            this.#retryPolicy,
            this.#random,
          ),
        });
      }
      if (
        adapterRecovery.kind === 'outcome' ||
        adapterRecovery.kind === 'provider-error'
      ) {
        const completion = this.#recoveredAdapterCompletion(
          attempt,
          adapterRecovery,
        );
        const claim = await this.#claimRecoveredAdapterCompletion(
          workItem,
          fingerprint,
          completion,
        );
        if (claim.kind === 'in-progress') {
          return Object.freeze({
            kind: 'in-progress',
            retryAfterMilliseconds: calculateRetryDelayMilliseconds(
              attempt.attemptNumber,
              this.#retryPolicy,
              this.#random,
            ),
          });
        }
        return this.#writeCompletion(attempt, claim.completion, true);
      } else if (adapterRecovery.kind !== 'missing') {
        throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
      }
    }

    if (attempt.attemptNumber > this.#retryPolicy.maxAttempts) {
      throw new WorkerProcessingError('RETRY_BUDGET_EXCEEDED');
    }
    if (this.#adapter.truthLabel === 'live-verified') {
      if (this.#authorizeLive === undefined) {
        throw new WorkerProcessingError('LIVE_PROVIDER_DISABLED');
      }
      let authorized = false;
      try {
        authorized = (await this.#authorizeLive(workItem)) === true;
      } catch {
        authorized = false;
      }
      if (!authorized) {
        throw new WorkerProcessingError('LIVE_PROVIDER_DISABLED');
      }
    }

    let claim: AttemptExecutionClaim;
    try {
      claim = parseClaim(
        await this.#store.claim({
          attemptId: attempt.id,
          fingerprint,
          leaseMilliseconds: this.#leaseMilliseconds,
        }),
        attempt.id,
        this.#adapter.provider,
      );
    } catch (error) {
      if (error instanceof WorkerProcessingError) throw error;
      throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
    }

    if (claim.kind === 'in-progress') {
      return Object.freeze({
        kind: 'in-progress',
        retryAfterMilliseconds: calculateRetryDelayMilliseconds(
          attempt.attemptNumber,
          this.#retryPolicy,
          this.#random,
        ),
      });
    }

    if (claim.kind === 'completed') {
      return this.#writeCompletion(attempt, claim.completion, true);
    }

    const lease = Object.freeze({
      attemptId: attempt.id,
      fingerprint,
      leaseToken: claim.leaseToken,
    });
    if (!(await this.#providerSendIsAuthorized(workItem))) {
      await this.#releaseProviderSendDenied(lease);
    }
    let attemptedEvidence: DeliveryEvidence;
    try {
      attemptedEvidence = await this.#writer.recordAttemptEvidence({
        attempt,
        evidence: attemptedInput(attempt.id),
      });
    } catch (error) {
      try {
        await this.#store.release(lease);
      } catch {
        throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
      }
      throw error;
    }

    const providerRequest = Object.freeze({
      workItem,
      idempotencyKey: attempt.id,
    });
    // The initial check avoids creating attempted evidence for an endpoint
    // already known to be ineligible. This final check closes the asynchronous
    // evidence-write window, and is deliberately the last awaited operation
    // before adapter.send: its locked transaction is the provider handoff's
    // linearization point. No later awaited work may reopen that gap.
    if (!(await this.#providerSendIsAuthorized(workItem))) {
      await this.#releaseProviderSendDenied(lease);
    }
    let rawOutcome: ProviderSendOutcome | unknown;
    try {
      rawOutcome = await this.#adapter.send(providerRequest);
    } catch (error) {
      const decision = decideProviderRetry(
        error,
        attempt.attemptNumber,
        this.#retryPolicy,
        this.#random,
      );
      if (decision.kind === 'retry') {
        const outcome = failureOutcome(
          'failed',
          this.#adapter.provider,
          decision.failure.code,
          decision.failure.diagnosticDigest,
        );
        const completion = Object.freeze({
          kind: 'retry' as const,
          outcome,
          delayMilliseconds: decision.delayMilliseconds,
          nextAttemptNumber: decision.nextAttemptNumber,
          reasonCode: decision.failure.code,
        });
        try {
          await this.#store.complete({ ...lease, completion });
        } catch {
          throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
        }
        const outcomeEvidence = await this.#writer.recordAttemptEvidence({
          attempt,
          evidence: finalInput(attempt.id, outcome),
        });
        return Object.freeze({
          kind: 'retry',
          replayed: false,
          delayMilliseconds: decision.delayMilliseconds,
          nextAttemptNumber: decision.nextAttemptNumber,
          reasonCode: decision.failure.code,
          outcome,
          attemptedEvidence,
          outcomeEvidence,
        });
      }
      rawOutcome = failureOutcome(
        decision.truthState,
        this.#adapter.provider,
        decision.reasonCode,
        decision.failure.diagnosticDigest,
      );
    }

    let outcome: ProviderSendOutcome;
    try {
      outcome = parseProviderOutcome(
        rawOutcome,
        attempt.id,
        this.#adapter.provider,
      );
    } catch (error) {
      if (
        !(error instanceof WorkerProcessingError) ||
        error.code !== 'INVALID_PROVIDER_OUTCOME'
      ) {
        throw error;
      }
      // The adapter may already have crossed its provider side-effect
      // boundary. Malformed result data is therefore ambiguous truth, never a
      // reason to release the claim and resend blindly.
      outcome = failureOutcome(
        'unknown',
        this.#adapter.provider,
        'PROVIDER_OUTCOME_INVALID',
        null,
      );
    }
    try {
      await this.#store.complete({
        ...lease,
        completion: Object.freeze({ kind: 'final', outcome }),
      });
    } catch {
      // A provider side effect may have occurred. Never release this claim for
      // a blind resend; lease recovery still requires adapter idempotency.
      throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
    }
    const outcomeEvidence = await this.#writer.recordAttemptEvidence({
      attempt,
      evidence: finalInput(attempt.id, outcome),
    });
    return Object.freeze({
      kind: finalKind(outcome),
      replayed: false,
      outcome,
      attemptedEvidence,
      outcomeEvidence,
    });
  }

  #recoveredAdapterCompletion(
    attempt: WorkerAttemptWorkItem['attempt'],
    recovery: Extract<
      ProviderRecoveryResult,
      { kind: 'outcome' | 'provider-error' }
    >,
  ): AttemptExecutionCompletion {
    if (recovery.kind === 'provider-error') {
      const decision = decideProviderRetry(
        recovery.error,
        attempt.attemptNumber,
        this.#retryPolicy,
        this.#random,
      );
      if (decision.kind === 'retry') {
        return Object.freeze({
          kind: 'retry',
          outcome: failureOutcome(
            'failed',
            this.#adapter.provider,
            decision.failure.code,
            decision.failure.diagnosticDigest,
          ),
          delayMilliseconds: decision.delayMilliseconds,
          nextAttemptNumber: decision.nextAttemptNumber,
          reasonCode: decision.failure.code,
        });
      }
      return Object.freeze({
        kind: 'final',
        outcome: failureOutcome(
          decision.truthState,
          this.#adapter.provider,
          decision.reasonCode,
          decision.failure.diagnosticDigest,
        ),
      });
    }

    let outcome: ProviderSendOutcome;
    try {
      outcome = parseProviderOutcome(
        recovery.outcome,
        attempt.id,
        this.#adapter.provider,
      );
    } catch {
      outcome = failureOutcome(
        'unknown',
        this.#adapter.provider,
        'PROVIDER_OUTCOME_INVALID',
        null,
      );
    }
    return Object.freeze({ kind: 'final', outcome });
  }

  async #providerSendIsAuthorized(
    workItem: WorkerAttemptWorkItem,
  ): Promise<boolean> {
    if (this.#authorizeSend === undefined) return true;
    try {
      return (await this.#authorizeSend(workItem)) === true;
    } catch {
      return false;
    }
  }

  async #releaseProviderSendDenied(
    lease: ReleaseAttemptExecutionRequest,
  ): Promise<never> {
    try {
      await this.#store.release(lease);
    } catch {
      throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
    }
    throw new WorkerProcessingError('PROVIDER_SEND_DISABLED');
  }

  async #claimRecoveredAdapterCompletion(
    workItem: WorkerAttemptWorkItem,
    fingerprint: string,
    completion: AttemptExecutionCompletion,
  ): Promise<
    | Readonly<{ kind: 'completed'; completion: AttemptExecutionCompletion }>
    | Readonly<{ kind: 'in-progress' }>
  > {
    const attempt = workItem.attempt;
    let claim: AttemptExecutionClaim;
    try {
      claim = parseClaim(
        await this.#store.claim({
          attemptId: attempt.id,
          fingerprint,
          leaseMilliseconds: this.#leaseMilliseconds,
        }),
        attempt.id,
        this.#adapter.provider,
      );
    } catch (error) {
      if (error instanceof WorkerProcessingError) throw error;
      throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
    }
    if (claim.kind === 'in-progress') {
      return Object.freeze({ kind: 'in-progress' });
    }
    if (claim.kind === 'completed') return claim;

    try {
      await this.#store.complete({
        attemptId: attempt.id,
        fingerprint,
        leaseToken: claim.leaseToken,
        completion,
      });
    } catch {
      throw new WorkerProcessingError('IDEMPOTENCY_STORE_FAILED');
    }
    return Object.freeze({ kind: 'completed', completion });
  }

  async #writeCompletion(
    attempt: WorkerAttemptWorkItem['attempt'],
    completion: AttemptExecutionCompletion,
    replayed: boolean,
  ): Promise<WorkerAttemptProcessResult> {
    const outcome = completion.outcome;
    const attemptedEvidence = await this.#writer.recordAttemptEvidence({
      attempt,
      evidence: attemptedInput(attempt.id),
    });
    const outcomeEvidence = await this.#writer.recordAttemptEvidence({
      attempt,
      evidence: finalInput(attempt.id, outcome),
    });
    if (completion.kind === 'retry') {
      return Object.freeze({
        kind: 'retry',
        replayed,
        delayMilliseconds: completion.delayMilliseconds,
        nextAttemptNumber: completion.nextAttemptNumber,
        reasonCode: completion.reasonCode,
        outcome,
        attemptedEvidence,
        outcomeEvidence,
      });
    }
    return Object.freeze({
      kind: finalKind(outcome),
      replayed,
      outcome,
      attemptedEvidence,
      outcomeEvidence,
    });
  }
}
