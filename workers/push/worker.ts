import {
  DeliveryEvidenceSchema,
  type RecordEndpointStatusInput,
} from '@psd-eoc/contracts';

import {
  workerAttemptFingerprint,
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import type { AttemptEvidenceWriter } from '../shared/delivery-state-client';
import {
  WorkerAttemptProcessor,
  type AttemptExecutionClaim,
  type AttemptExecutionClaimRequest,
  type AttemptExecutionCompletion,
  type AttemptExecutionLookup,
  type AttemptExecutionLookupRequest,
  type AttemptExecutionStore,
  type AttemptIdempotentProviderAdapter,
  type CompleteAttemptExecutionRequest,
  type LiveProviderAuthorizer,
  type ProviderRecoveryResult,
  type ProviderSendOutcome,
  type ProviderSendRequest,
  type ReleaseAttemptExecutionRequest,
  type WorkerAttemptProcessResult,
} from '../shared/processor';
import {
  calculateRetryDelayMilliseconds,
  DEFAULT_RETRY_POLICY,
  ProviderDispatchError,
  parseRetryPolicy,
  type RetryPolicy,
} from '../shared/retry';
import {
  LedgeredExpoPushAdapter,
  expoProviderFailureDisposition,
  type DurableExpoSendLedger,
} from './adapter';
import {
  createProductionPushEndpointEligibilityClient,
  type ProductionPushEndpointEligibilityClientOptions,
  type PushEndpointEligibilityChecker,
} from './eligibility';
import type { PushEndpointInvalidator } from './invalidation';
import type { ExpoReceiptScheduler } from './receipt-lifecycle';
import {
  ExpoPushHttpTransport,
  type ExpoLiveTransportAuthorizer,
} from './transport';

function invalidationInput(
  workItem: WorkerAttemptWorkItem,
): RecordEndpointStatusInput {
  return Object.freeze({
    rosterSnapshotId: workItem.batch.rosterSnapshotId,
    recipientId: workItem.attempt.recipientId,
    endpointId: workItem.attempt.endpointId,
    status: 'invalid',
    reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
  });
}

export interface ExpoPushWorkerOptions {
  readonly adapter: AttemptIdempotentProviderAdapter;
  readonly executionStore: AttemptExecutionStore;
  readonly evidenceWriter: AttemptEvidenceWriter;
  readonly endpointInvalidator: PushEndpointInvalidator;
  readonly receiptScheduler: ExpoReceiptScheduler;
  readonly endpointEligibility: PushEndpointEligibilityChecker;
  readonly retryPolicy?: RetryPolicy;
  readonly leaseMilliseconds?: number;
  readonly random?: () => number;
  readonly authorizeLiveProvider?: LiveProviderAuthorizer;
}

/**
 * Deployable worker composition accepts only validated eligibility service
 * configuration, never a caller-supplied eligibility implementation.
 */
export type ProductionExpoPushWorkerOptions = Readonly<
  Omit<ExpoPushWorkerOptions, 'adapter' | 'endpointEligibility'> & {
    readonly integrationId?: 'expo-push' | 'mobile-push';
    readonly expoAccessToken: string;
    readonly authorizeLiveTransport: ExpoLiveTransportAuthorizer;
    readonly sendLedger: DurableExpoSendLedger;
    readonly batchWindowMilliseconds?: number;
    readonly transportTimeoutMilliseconds?: number;
    readonly endpointEligibilityService: ProductionPushEndpointEligibilityClientOptions;
  }
>;

const EXPO_FORBIDDEN_DELIVERY_REASON = 'EXPO_DELIVERED_TRUTH_FORBIDDEN';
const MAX_EXPO_WORK_ITEMS = 12_000;
const SAFE_EXPO_PROVIDER_REFERENCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const EXPO_ADAPTER_FAILED_REASONS: ReadonlySet<string> = new Set([
  'EXPO_DEVICE_NOT_REGISTERED',
  'EXPO_INVALID_CREDENTIALS',
  'EXPO_MESSAGE_TOO_BIG',
  'EXPO_MISMATCH_SENDER_ID',
]);
const EXPO_STORED_FINAL_FAILED_REASONS: ReadonlySet<string> = new Set([
  ...EXPO_ADAPTER_FAILED_REASONS,
  'EXPO_HTTP_CLIENT_ERROR',
  'EXPO_LIVE_TRANSPORT_DISABLED',
  'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
  'EXPO_ENDPOINT_INELIGIBLE',
  'EXPO_SEND_LEDGER_CONFLICT',
  'EXPO_SEND_REQUEST_INVALID',
  'PROVIDER_RETRY_EXHAUSTED',
]);
const EXPO_ADAPTER_UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  'EXPO_SEND_OUTCOME_AMBIGUOUS',
  'EXPO_TICKET_ERROR_UNKNOWN',
  'EXPO_TICKET_MISSING',
  'EXPO_TICKET_RESPONSE_INVALID',
]);
const EXPO_STORED_FINAL_UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  ...EXPO_ADAPTER_UNKNOWN_REASONS,
  'PROVIDER_OUTCOME_AMBIGUOUS',
  'PROVIDER_OUTCOME_INVALID',
]);
const EXPO_RETRY_REASONS: ReadonlySet<string> = new Set([
  'EXPO_HTTP_RATE_LIMITED',
  'EXPO_HTTP_SERVER_ERROR',
  'EXPO_MESSAGE_RATE_EXCEEDED',
  'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE',
]);
const EXPO_OUTCOME_KEYS = Object.freeze([
  'state',
  'provider',
  'providerReference',
  'proof',
  'reasonCode',
  'diagnosticDigest',
] as const);

type ExpoOutcomeContext = 'adapter' | 'stored-final' | 'stored-retry';

interface ExpoExecutionContext {
  readonly attemptNumber: number;
  readonly retryPolicy: RetryPolicy;
}

interface RegisteredExpoExecutionContext extends ExpoExecutionContext {
  readonly fingerprint: string;
  activeCalls: number;
}

class ExpoExecutionContextRegistry {
  readonly #contexts = new Map<string, RegisteredExpoExecutionContext>();

  public constructor(private readonly retryPolicy: RetryPolicy) {}

  public register(workItem: WorkerAttemptWorkItem): () => void {
    const attemptId = workItem.attempt.id;
    const fingerprint = workerAttemptFingerprint(workItem);
    const existing = this.#contexts.get(attemptId);
    if (existing !== undefined) {
      if (
        existing.fingerprint !== fingerprint ||
        existing.attemptNumber !== workItem.attempt.attemptNumber
      ) {
        throw new TypeError('Expo push execution context is invalid.');
      }
      existing.activeCalls += 1;
    } else {
      this.#contexts.set(attemptId, {
        fingerprint,
        attemptNumber: workItem.attempt.attemptNumber,
        retryPolicy: this.retryPolicy,
        activeCalls: 1,
      });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.#contexts.get(attemptId);
      if (current === undefined || current.fingerprint !== fingerprint) return;
      current.activeCalls -= 1;
      if (current.activeCalls === 0) this.#contexts.delete(attemptId);
    };
  }

  public require(
    request: AttemptExecutionLookupRequest | AttemptExecutionClaimRequest,
  ): ExpoExecutionContext {
    const context = this.#contexts.get(request.attemptId);
    if (
      context === undefined ||
      context.fingerprint !== request.fingerprint ||
      context.activeCalls < 1
    ) {
      throw new ProviderDispatchError(
        EXPO_FORBIDDEN_DELIVERY_REASON,
        'ambiguous',
      );
    }
    return Object.freeze({
      attemptNumber: context.attemptNumber,
      retryPolicy: context.retryPolicy,
    });
  }
}

function canonicalExpoOutcome(
  value: unknown,
  expectedProvider: string,
  context: ExpoOutcomeContext,
): ProviderSendOutcome {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== EXPO_OUTCOME_KEYS.length ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !(EXPO_OUTCOME_KEYS as readonly string[]).includes(key),
      )
    ) {
      throw new TypeError();
    }
    const properties: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of EXPO_OUTCOME_KEYS) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError();
      }
      properties[key] = descriptor.value;
    }
    const providerReference = properties.providerReference;
    const reasonCode = properties.reasonCode;
    const failedReasons =
      context === 'adapter'
        ? EXPO_ADAPTER_FAILED_REASONS
        : EXPO_STORED_FINAL_FAILED_REASONS;
    const unknownReasons =
      context === 'adapter'
        ? EXPO_ADAPTER_UNKNOWN_REASONS
        : EXPO_STORED_FINAL_UNKNOWN_REASONS;
    const accepted =
      context !== 'stored-retry' &&
      properties.state === 'provider-accepted' &&
      typeof providerReference === 'string' &&
      SAFE_EXPO_PROVIDER_REFERENCE_PATTERN.test(providerReference) &&
      reasonCode === null;
    const failed =
      properties.state === 'failed' &&
      providerReference === null &&
      typeof reasonCode === 'string' &&
      (context === 'stored-retry'
        ? EXPO_RETRY_REASONS.has(reasonCode)
        : failedReasons.has(reasonCode));
    const expired =
      context !== 'stored-retry' &&
      properties.state === 'expired' &&
      providerReference === null &&
      reasonCode === 'EXPO_NOTIFICATION_EXPIRED';
    const unknown =
      context !== 'stored-retry' &&
      properties.state === 'unknown' &&
      providerReference === null &&
      typeof reasonCode === 'string' &&
      unknownReasons.has(reasonCode);
    if (
      properties.provider !== expectedProvider ||
      properties.proof !== null ||
      properties.diagnosticDigest !== null ||
      (!accepted && !failed && !expired && !unknown)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      state: properties.state,
      provider: properties.provider,
      providerReference: properties.providerReference,
      proof: properties.proof,
      reasonCode: properties.reasonCode,
      diagnosticDigest: properties.diagnosticDigest,
    }) as ProviderSendOutcome;
  } catch {
    throw new ProviderDispatchError(
      EXPO_FORBIDDEN_DELIVERY_REASON,
      'ambiguous',
    );
  }
}

function failClosedExpoAdapter(
  adapter: AttemptIdempotentProviderAdapter,
): AttemptIdempotentProviderAdapter {
  return Object.freeze({
    channel: adapter.channel,
    integrationId: adapter.integrationId,
    truthLabel: adapter.truthLabel,
    provider: adapter.provider,
    deliverySemantics: adapter.deliverySemantics,
    ...(adapter.recover === undefined
      ? {}
      : {
          async recover(
            request: ProviderSendRequest,
          ): Promise<ProviderRecoveryResult> {
            return canonicalExpoRecovery(
              await adapter.recover!(request),
              adapter.provider,
            );
          },
        }),
    async send(
      request: ProviderSendRequest,
    ): Promise<ProviderSendOutcome | unknown> {
      return canonicalExpoOutcome(
        await adapter.send(request),
        adapter.provider,
        'adapter',
      );
    },
  });
}

function failClosedExecutionStore(
  store: AttemptExecutionStore,
  provider: string,
  contexts: ExpoExecutionContextRegistry,
): AttemptExecutionStore {
  return Object.freeze({
    async lookup(
      request: AttemptExecutionLookupRequest,
    ): Promise<AttemptExecutionLookup> {
      const safeRequest = Object.freeze({
        attemptId: request.attemptId,
        fingerprint: request.fingerprint,
      });
      const context = contexts.require(safeRequest);
      return canonicalExecutionLookup(
        await store.lookup(safeRequest),
        provider,
        context,
      );
    },
    async claim(
      request: AttemptExecutionClaimRequest,
    ): Promise<AttemptExecutionClaim> {
      const safeRequest = Object.freeze({
        attemptId: request.attemptId,
        fingerprint: request.fingerprint,
        leaseMilliseconds: request.leaseMilliseconds,
      });
      const context = contexts.require(safeRequest);
      return canonicalExecutionClaim(
        await store.claim(safeRequest),
        provider,
        context,
      );
    },
    complete(request: CompleteAttemptExecutionRequest) {
      return store.complete(
        Object.freeze({
          attemptId: request.attemptId,
          fingerprint: request.fingerprint,
          leaseToken: request.leaseToken,
          completion: request.completion,
        }),
      );
    },
    release(request: ReleaseAttemptExecutionRequest) {
      return store.release(
        Object.freeze({
          attemptId: request.attemptId,
          fingerprint: request.fingerprint,
          leaseToken: request.leaseToken,
        }),
      );
    },
  });
}

function retryDelayBounds(
  context: ExpoExecutionContext,
): readonly [minimum: number, maximum: number] {
  return Object.freeze([
    calculateRetryDelayMilliseconds(
      context.attemptNumber,
      context.retryPolicy,
      () => 0,
    ),
    calculateRetryDelayMilliseconds(
      context.attemptNumber,
      context.retryPolicy,
      () => 1,
    ),
  ]);
}

function exactDataProperties(
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== 'string' || !expected.includes(key))
    ) {
      return null;
    }
    const properties: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      properties[key] = descriptor.value;
    }
    return properties;
  } catch {
    return null;
  }
}

function canonicalExecutionCompletion(
  value: unknown,
  provider: string,
  context: ExpoExecutionContext,
): AttemptExecutionCompletion {
  const final = exactDataProperties(value, ['kind', 'outcome']);
  if (final?.kind === 'final') {
    return Object.freeze({
      kind: 'final',
      outcome: canonicalStoredFinalOutcome(final.outcome, provider, context),
    });
  }
  const retry = exactDataProperties(value, [
    'kind',
    'outcome',
    'delayMilliseconds',
    'nextAttemptNumber',
    'reasonCode',
  ]);
  if (retry?.kind === 'retry') {
    const [minimumDelay, maximumDelay] = retryDelayBounds(context);
    if (
      !Number.isSafeInteger(retry.delayMilliseconds) ||
      Number(retry.delayMilliseconds) < minimumDelay ||
      Number(retry.delayMilliseconds) > maximumDelay ||
      !Number.isSafeInteger(retry.nextAttemptNumber) ||
      Number(retry.nextAttemptNumber) !== context.attemptNumber + 1 ||
      Number(retry.nextAttemptNumber) > context.retryPolicy.maxAttempts ||
      typeof retry.reasonCode !== 'string' ||
      !EXPO_RETRY_REASONS.has(retry.reasonCode)
    ) {
      throw new ProviderDispatchError(
        EXPO_FORBIDDEN_DELIVERY_REASON,
        'ambiguous',
      );
    }
    const outcome = canonicalExpoOutcome(
      retry.outcome,
      provider,
      'stored-retry',
    );
    if (outcome.reasonCode !== retry.reasonCode) {
      throw new ProviderDispatchError(
        EXPO_FORBIDDEN_DELIVERY_REASON,
        'ambiguous',
      );
    }
    return Object.freeze({
      kind: 'retry',
      outcome,
      delayMilliseconds: retry.delayMilliseconds as number,
      nextAttemptNumber: retry.nextAttemptNumber as number,
      reasonCode: retry.reasonCode as string,
    });
  }
  throw new ProviderDispatchError(EXPO_FORBIDDEN_DELIVERY_REASON, 'ambiguous');
}

function canonicalStoredFinalOutcome(
  value: unknown,
  provider: string,
  context: ExpoExecutionContext,
): ProviderSendOutcome {
  const outcome = canonicalExpoOutcome(value, provider, 'stored-final');
  if (
    outcome.reasonCode === 'PROVIDER_RETRY_EXHAUSTED' &&
    context.attemptNumber < context.retryPolicy.maxAttempts
  ) {
    throw new ProviderDispatchError(
      EXPO_FORBIDDEN_DELIVERY_REASON,
      'ambiguous',
    );
  }
  return outcome;
}

function canonicalExecutionLookup(
  value: unknown,
  provider: string,
  context: ExpoExecutionContext,
): AttemptExecutionLookup {
  const missing = exactDataProperties(value, ['kind']);
  if (missing?.kind === 'missing') return Object.freeze({ kind: 'missing' });
  if (missing?.kind === 'reclaimable') {
    return Object.freeze({ kind: 'reclaimable' });
  }
  if (missing?.kind === 'in-progress') {
    return Object.freeze({ kind: 'in-progress' });
  }
  const completed = exactDataProperties(value, ['kind', 'completion']);
  if (completed?.kind === 'completed') {
    return Object.freeze({
      kind: 'completed',
      completion: canonicalExecutionCompletion(
        completed.completion,
        provider,
        context,
      ),
    });
  }
  throw new ProviderDispatchError(EXPO_FORBIDDEN_DELIVERY_REASON, 'ambiguous');
}

function canonicalExpoRecovery(
  value: unknown,
  provider: string,
): ProviderRecoveryResult {
  const terminal = exactDataProperties(value, ['kind']);
  if (terminal?.kind === 'missing' || terminal?.kind === 'in-progress') {
    return Object.freeze({ kind: terminal.kind });
  }
  const outcome = exactDataProperties(value, ['kind', 'outcome']);
  if (outcome?.kind === 'outcome') {
    return Object.freeze({
      kind: 'outcome',
      outcome: canonicalExpoOutcome(outcome.outcome, provider, 'adapter'),
    });
  }
  const providerError = exactDataProperties(value, ['kind', 'error']);
  if (providerError?.kind === 'provider-error') {
    const rawError = providerError.error;
    if (!(rawError instanceof ProviderDispatchError)) {
      throw new ProviderDispatchError(
        EXPO_FORBIDDEN_DELIVERY_REASON,
        'ambiguous',
      );
    }
    let code: unknown;
    let disposition: unknown;
    let diagnosticDigest: unknown;
    try {
      code = rawError.code;
      disposition = rawError.disposition;
      diagnosticDigest = rawError.diagnosticDigest;
    } catch {
      throw new ProviderDispatchError(
        EXPO_FORBIDDEN_DELIVERY_REASON,
        'ambiguous',
      );
    }
    if (
      typeof code !== 'string' ||
      typeof disposition !== 'string' ||
      diagnosticDigest !== null ||
      expoProviderFailureDisposition(code) !== disposition
    ) {
      throw new ProviderDispatchError(
        EXPO_FORBIDDEN_DELIVERY_REASON,
        'ambiguous',
      );
    }
    return Object.freeze({
      kind: 'provider-error',
      error: new ProviderDispatchError(code, disposition),
    });
  }
  throw new ProviderDispatchError(EXPO_FORBIDDEN_DELIVERY_REASON, 'ambiguous');
}

function canonicalExecutionClaim(
  value: unknown,
  provider: string,
  context: ExpoExecutionContext,
): AttemptExecutionClaim {
  const acquired = exactDataProperties(value, ['kind', 'leaseToken']);
  if (acquired?.kind === 'acquired') {
    return Object.freeze({
      kind: 'acquired',
      leaseToken: acquired.leaseToken as string,
    });
  }
  const completed = exactDataProperties(value, ['kind', 'completion']);
  if (completed?.kind === 'completed') {
    return Object.freeze({
      kind: 'completed',
      completion: canonicalExecutionCompletion(
        completed.completion,
        provider,
        context,
      ),
    });
  }
  const inProgress = exactDataProperties(value, ['kind']);
  if (inProgress?.kind === 'in-progress') {
    return Object.freeze({ kind: 'in-progress' });
  }
  throw new ProviderDispatchError(EXPO_FORBIDDEN_DELIVERY_REASON, 'ambiguous');
}

/** Safe local batch result that never exposes provider or dependency errors. */
export type ExpoPushBatchItemResult =
  | WorkerAttemptProcessResult
  | Readonly<{
      kind: 'error';
      attemptId: string;
      errorCode: 'EXPO_PUSH_ITEM_FAILED';
    }>;

/**
 * Queue-facing failure for a batch with one or more isolated item failures.
 * Only bounded, PII-free results are retained; raw dependency failures never
 * become an error cause or aggregate entry.
 */
export class ExpoPushBatchError extends Error {
  public readonly code = 'EXPO_PUSH_BATCH_FAILED' as const;
  public readonly results: readonly ExpoPushBatchItemResult[];

  public constructor(results: readonly ExpoPushBatchItemResult[]) {
    super('One or more Expo push items failed safely.');
    this.name = 'ExpoPushBatchError';
    this.results = Object.freeze(Array.from(results));
    Object.freeze(this);
  }
}

function parseWorkBatch(value: unknown): readonly WorkerAttemptWorkItem[] {
  try {
    if (!Array.isArray(value)) {
      throw new TypeError('Expo push work batch is invalid.');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      Number(lengthDescriptor.value) < 1 ||
      Number(lengthDescriptor.value) > MAX_EXPO_WORK_ITEMS
    ) {
      throw new TypeError('Expo push work batch is invalid.');
    }
    const workItems: WorkerAttemptWorkItem[] = [];
    for (let index = 0; index < Number(lengthDescriptor.value); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError('Expo push work batch is invalid.');
      }
      workItems.push(parseWorkerAttemptWorkItem(descriptor.value));
    }
    return Object.freeze(workItems);
  } catch {
    throw new TypeError('Expo push work batch is invalid.');
  }
}

/**
 * Executable attempt worker. Provider sending stays behind the shared durable
 * processor; raw Expo HTTP transport is deliberately not an adapter.
 */
export class ExpoPushWorker {
  readonly #processor: WorkerAttemptProcessor;
  readonly #invalidator: PushEndpointInvalidator;
  readonly #receiptScheduler: ExpoReceiptScheduler;
  readonly #executionContexts: ExpoExecutionContextRegistry;

  public constructor(options: ExpoPushWorkerOptions) {
    if (
      options.adapter.channel !== 'push' ||
      (options.adapter.integrationId !== 'expo-push' &&
        options.adapter.integrationId !== 'mobile-push')
    ) {
      throw new TypeError('Expo worker adapter is invalid.');
    }
    if (
      typeof options.receiptScheduler?.scheduleProviderAccepted !==
        'function' ||
      options.receiptScheduler.provider !== options.adapter.provider
    ) {
      throw new TypeError('Expo receipt scheduler is invalid.');
    }
    if (typeof options.endpointEligibility?.isEligible !== 'function') {
      throw new TypeError('Expo endpoint eligibility checker is invalid.');
    }
    if (
      options.adapter.truthLabel === 'live-verified' &&
      !LedgeredExpoPushAdapter.usesEndpointEligibility(
        options.adapter,
        options.endpointEligibility,
      )
    ) {
      throw new TypeError(
        'Live Expo adapter endpoint eligibility checker is invalid.',
      );
    }
    const retryPolicy = parseRetryPolicy(
      options.retryPolicy ?? DEFAULT_RETRY_POLICY,
    );
    this.#executionContexts = new ExpoExecutionContextRegistry(retryPolicy);
    this.#processor = new WorkerAttemptProcessor({
      adapter: failClosedExpoAdapter(options.adapter),
      executionStore: failClosedExecutionStore(
        options.executionStore,
        options.adapter.provider,
        this.#executionContexts,
      ),
      evidenceWriter: options.evidenceWriter,
      retryPolicy,
      ...(options.leaseMilliseconds === undefined
        ? {}
        : { leaseMilliseconds: options.leaseMilliseconds }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.authorizeLiveProvider === undefined
        ? {}
        : { authorizeLiveProvider: options.authorizeLiveProvider }),
      authorizeProviderSend: (workItem) =>
        options.endpointEligibility.isEligible(workItem),
    });
    this.#invalidator = options.endpointInvalidator;
    this.#receiptScheduler = options.receiptScheduler;
  }

  public async process(
    workValue: WorkerAttemptWorkItem | unknown,
  ): Promise<WorkerAttemptProcessResult> {
    const workItem = parseWorkerAttemptWorkItem(workValue);
    const unregister = this.#executionContexts.register(workItem);
    let result: WorkerAttemptProcessResult;
    try {
      result = await this.#processor.process(workItem);
    } finally {
      unregister();
    }
    if ('outcome' in result && result.outcome.state === 'delivered') {
      throw new TypeError('Expo push delivery truth is invalid.');
    }
    if ('outcome' in result && result.outcome.state === 'provider-accepted') {
      await this.#receiptScheduler.scheduleProviderAccepted(
        workItem,
        result.outcomeEvidence,
      );
    }
    const durableOutcomeEvidence =
      'outcome' in result
        ? DeliveryEvidenceSchema.safeParse(result.outcomeEvidence)
        : null;
    if (
      'outcome' in result &&
      result.outcome.state === 'failed' &&
      result.outcome.reasonCode === 'EXPO_DEVICE_NOT_REGISTERED'
    ) {
      if (
        durableOutcomeEvidence?.success !== true ||
        durableOutcomeEvidence.data.subject.kind !== 'attempt' ||
        durableOutcomeEvidence.data.subject.attemptId !== workItem.attempt.id ||
        durableOutcomeEvidence.data.state !== 'failed' ||
        durableOutcomeEvidence.data.provider !== result.outcome.provider ||
        durableOutcomeEvidence.data.providerReference !==
          result.outcome.providerReference ||
        durableOutcomeEvidence.data.reasonCode !== 'EXPO_DEVICE_NOT_REGISTERED'
      ) {
        throw new TypeError(
          'Expo push durable invalidation evidence is invalid.',
        );
      }
      // Evidence is durable before token-free endpoint invalidation is called.
      await this.#invalidator.invalidate(invalidationInput(workItem));
    }
    return result;
  }

  public async processAll(
    workValues: readonly (WorkerAttemptWorkItem | unknown)[],
  ): Promise<readonly ExpoPushBatchItemResult[]> {
    // Validate the entire caller-supplied batch before any item can cross the
    // provider boundary, then start all durable processors concurrently. The
    // live adapter coalesces only the attempts that independently acquire both
    // execution and provider-I/O ledger claims.
    const workItems = parseWorkBatch(workValues);
    const settled = await Promise.allSettled(
      Array.from(workItems, (workItem) => this.process(workItem)),
    );
    const results = Object.freeze(
      Array.from(settled, (result, index) => {
        if (result.status === 'fulfilled') return result.value;
        return Object.freeze({
          kind: 'error' as const,
          attemptId: workItems[index]!.attempt.id,
          errorCode: 'EXPO_PUSH_ITEM_FAILED' as const,
        });
      }),
    );
    if (
      results.some(
        (result) =>
          result.kind === 'error' ||
          result.kind === 'retry' ||
          result.kind === 'in-progress',
      )
    ) {
      throw new ExpoPushBatchError(results);
    }
    return results;
  }
}

/**
 * Canonical production composition. Any runtime `endpointEligibility`
 * property is overwritten by the authenticated fail-closed HTTP client.
 */
export function createProductionExpoPushWorker(
  options: ProductionExpoPushWorkerOptions,
): ExpoPushWorker {
  const endpointEligibility = createProductionPushEndpointEligibilityClient(
    options.endpointEligibilityService,
  );
  const transport = new ExpoPushHttpTransport({
    accessToken: options.expoAccessToken,
    authorizeLiveTransport: options.authorizeLiveTransport,
    endpointEligibility,
    ...(options.transportTimeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.transportTimeoutMilliseconds }),
  });
  const adapter = new LedgeredExpoPushAdapter({
    transport,
    sendLedger: options.sendLedger,
    endpointEligibility,
    ...(options.integrationId === undefined
      ? {}
      : { integrationId: options.integrationId }),
    ...(options.batchWindowMilliseconds === undefined
      ? {}
      : { batchWindowMilliseconds: options.batchWindowMilliseconds }),
  });
  return new ExpoPushWorker({
    adapter,
    executionStore: options.executionStore,
    evidenceWriter: options.evidenceWriter,
    endpointInvalidator: options.endpointInvalidator,
    receiptScheduler: options.receiptScheduler,
    endpointEligibility,
    ...(options.retryPolicy === undefined
      ? {}
      : { retryPolicy: options.retryPolicy }),
    ...(options.leaseMilliseconds === undefined
      ? {}
      : { leaseMilliseconds: options.leaseMilliseconds }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.authorizeLiveProvider === undefined
      ? {}
      : { authorizeLiveProvider: options.authorizeLiveProvider }),
  });
}
