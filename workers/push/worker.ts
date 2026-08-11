import type { RecordEndpointStatusInput } from '@psd-eoc/contracts';

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
        workItem.attempt,
        result.outcomeEvidence,
      );
    }
    if (
      'outcome' in result &&
      result.outcome.reasonCode === 'EXPO_DEVICE_NOT_REGISTERED'
    ) {
      // Evidence is durable before token-free endpoint invalidation is called.
      await this.#invalidator.invalidate(invalidationInput(workItem));
    }
    return result;
  }

  public async processAll(
    workValues: readonly (WorkerAttemptWorkItem | unknown)[],
  ): Promise<readonly WorkerAttemptProcessResult[]> {
    const results: WorkerAttemptProcessResult[] = [];
    for (const workValue of workValues) {
      results.push(await this.process(workValue));
    }
    return Object.freeze(results);
  }
}
