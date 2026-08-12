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
  type AttemptExecutionStore,
  type AttemptIdempotentProviderAdapter,
  type LiveProviderAuthorizer,
  type WorkerAttemptProcessResult,
} from '../shared/processor';
import type { RetryPolicy } from '../shared/retry';
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
      adapter: options.adapter,
      executionStore: options.executionStore,
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
      result.outcome.reasonCode === 'EXPO_DEVICE_NOT_REGISTERED' &&
      durableOutcomeEvidence?.success === true &&
      durableOutcomeEvidence.data.subject.kind === 'attempt' &&
      durableOutcomeEvidence.data.subject.attemptId === workItem.attempt.id &&
      durableOutcomeEvidence.data.state === 'failed' &&
      durableOutcomeEvidence.data.provider === result.outcome.provider &&
      durableOutcomeEvidence.data.reasonCode === 'EXPO_DEVICE_NOT_REGISTERED'
    ) {
      // Evidence is durable before token-free endpoint invalidation is called.
      await this.#invalidator.invalidate(invalidationInput(workItem));
    }
    return result;
  }

  public async processAll(
    workValues: readonly (WorkerAttemptWorkItem | unknown)[],
  ): Promise<readonly WorkerAttemptProcessResult[]> {
    // Validate the entire caller-supplied batch before any item can cross the
    // provider boundary, then start all durable processors concurrently. The
    // live adapter coalesces only the attempts that independently acquire both
    // execution and provider-I/O ledger claims.
    const workItems = workValues.map((value) =>
      parseWorkerAttemptWorkItem(value),
    );
    const settled = await Promise.allSettled(
      workItems.map((workItem) => this.process(workItem)),
    );
    const firstFailure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstFailure !== undefined) throw firstFailure.reason;
    return Object.freeze(
      settled.map(
        (result) =>
          (result as PromiseFulfilledResult<WorkerAttemptProcessResult>).value,
      ),
    );
  }
}
