import {
  DeliveryEvidenceSchema,
  type RecordEndpointStatusInput,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import type { AttemptEvidenceWriter } from '../shared/delivery-state-client';
import {
  WorkerAttemptProcessor,
  type AttemptExecutionClaim,
  type AttemptExecutionClaimRequest,
  type AttemptExecutionCompletion,
  type AttemptExecutionStore,
  type AttemptIdempotentProviderAdapter,
  type CompleteAttemptExecutionRequest,
  type LiveProviderAuthorizer,
  type ProviderSendOutcome,
  type ProviderSendRequest,
  type ReleaseAttemptExecutionRequest,
  type WorkerAttemptProcessResult,
} from '../shared/processor';
import { ProviderDispatchError, type RetryPolicy } from '../shared/retry';
import type { PushEndpointInvalidator } from './invalidation';
import type { ExpoReceiptScheduler } from './receipt-lifecycle';

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
  readonly retryPolicy?: RetryPolicy;
  readonly leaseMilliseconds?: number;
  readonly random?: () => number;
  readonly authorizeLiveProvider?: LiveProviderAuthorizer;
}

const EXPO_FORBIDDEN_DELIVERY_REASON = 'EXPO_DELIVERED_TRUTH_FORBIDDEN';
const MAX_EXPO_WORK_ITEMS = 12_000;
const SAFE_EXPO_PROVIDER_REFERENCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const EXPO_OUTCOME_KEYS = Object.freeze([
  'state',
  'provider',
  'providerReference',
  'proof',
  'reasonCode',
  'diagnosticDigest',
] as const);

function canonicalExpoOutcome(
  value: unknown,
  expectedProvider: string,
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
    if (
      properties.state === 'delivered' ||
      properties.provider !== expectedProvider ||
      properties.proof !== null ||
      (properties.providerReference !== null &&
        (typeof properties.providerReference !== 'string' ||
          !SAFE_EXPO_PROVIDER_REFERENCE_PATTERN.test(
            properties.providerReference,
          ))) ||
      (properties.state === 'provider-accepted' &&
        (properties.providerReference === null ||
          properties.reasonCode !== null ||
          properties.diagnosticDigest !== null)) ||
      ((properties.state === 'failed' ||
        properties.state === 'expired' ||
        properties.state === 'unknown') &&
        (typeof properties.reasonCode !== 'string' ||
          properties.reasonCode.length < 1))
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
    async send(
      request: ProviderSendRequest,
    ): Promise<ProviderSendOutcome | unknown> {
      return canonicalExpoOutcome(
        await adapter.send(request),
        adapter.provider,
      );
    },
  });
}

function failClosedExecutionStore(
  store: AttemptExecutionStore,
  provider: string,
): AttemptExecutionStore {
  return Object.freeze({
    async claim(
      request: AttemptExecutionClaimRequest,
    ): Promise<AttemptExecutionClaim> {
      return canonicalExecutionClaim(await store.claim(request), provider);
    },
    complete(request: CompleteAttemptExecutionRequest) {
      return store.complete(request);
    },
    release(request: ReleaseAttemptExecutionRequest) {
      return store.release(request);
    },
  });
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
): AttemptExecutionCompletion {
  const final = exactDataProperties(value, ['kind', 'outcome']);
  if (final?.kind === 'final') {
    return Object.freeze({
      kind: 'final',
      outcome: canonicalExpoOutcome(final.outcome, provider),
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
    if (
      !Number.isSafeInteger(retry.delayMilliseconds) ||
      Number(retry.delayMilliseconds) < 1 ||
      !Number.isSafeInteger(retry.nextAttemptNumber) ||
      Number(retry.nextAttemptNumber) < 2 ||
      typeof retry.reasonCode !== 'string'
    ) {
      throw new ProviderDispatchError(
        EXPO_FORBIDDEN_DELIVERY_REASON,
        'ambiguous',
      );
    }
    return Object.freeze({
      kind: 'retry',
      outcome: canonicalExpoOutcome(retry.outcome, provider),
      delayMilliseconds: retry.delayMilliseconds as number,
      nextAttemptNumber: retry.nextAttemptNumber as number,
      reasonCode: retry.reasonCode as string,
    });
  }
  throw new ProviderDispatchError(EXPO_FORBIDDEN_DELIVERY_REASON, 'ambiguous');
}

function canonicalExecutionClaim(
  value: unknown,
  provider: string,
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
      completion: canonicalExecutionCompletion(completed.completion, provider),
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

  public constructor(options: ExpoPushWorkerOptions) {
    if (
      options.adapter.channel !== 'push' ||
      options.adapter.integrationId !== 'expo-push'
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
    this.#processor = new WorkerAttemptProcessor({
      adapter: failClosedExpoAdapter(options.adapter),
      executionStore: failClosedExecutionStore(
        options.executionStore,
        options.adapter.provider,
      ),
      evidenceWriter: options.evidenceWriter,
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
    this.#invalidator = options.endpointInvalidator;
    this.#receiptScheduler = options.receiptScheduler;
  }

  public async process(
    workValue: WorkerAttemptWorkItem | unknown,
  ): Promise<WorkerAttemptProcessResult> {
    const workItem = parseWorkerAttemptWorkItem(workValue);
    const result = await this.#processor.process(workItem);
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
