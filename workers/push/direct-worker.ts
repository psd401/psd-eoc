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
import {
  DEFAULT_RETRY_POLICY,
  parseRetryPolicy,
  type RetryPolicy,
} from '../shared/retry';
import {
  APNS_DIRECT_PROVIDER,
  FCM_DIRECT_PROVIDER,
  type DirectPushProvider,
} from './direct-protocol';
import type { PushEndpointEligibilityChecker } from './eligibility';
import type { PushEndpointInvalidator } from './invalidation';

const INVALIDATING_REASONS = new Set([
  'APNS_BAD_DEVICE_TOKEN',
  'APNS_UNREGISTERED',
  'FCM_INVALID_ARGUMENT',
  'FCM_UNREGISTERED',
]);

export interface DirectPushWorkerOptions {
  readonly adapter: AttemptIdempotentProviderAdapter;
  readonly executionStore: AttemptExecutionStore;
  readonly evidenceWriter: AttemptEvidenceWriter;
  readonly endpointInvalidator: PushEndpointInvalidator;
  readonly endpointEligibility: PushEndpointEligibilityChecker;
  readonly retryPolicy?: RetryPolicy;
  readonly leaseMilliseconds?: number;
  readonly random?: () => number;
  readonly authorizeLiveProvider?: LiveProviderAuthorizer;
}

function invalidationInput(
  workItem: WorkerAttemptWorkItem,
  reasonCode: string,
  providerOccurredAt?: string,
): RecordEndpointStatusInput {
  if (reasonCode === 'APNS_UNREGISTERED') {
    if (providerOccurredAt === undefined) {
      throw new TypeError('APNs invalidation occurrence time is missing.');
    }
    return {
      rosterSnapshotId: workItem.batch.rosterSnapshotId,
      recipientId: workItem.attempt.recipientId,
      endpointId: workItem.attempt.endpointId,
      status: 'invalid',
      reasonCode,
      providerOccurredAt,
    };
  }
  return {
    rosterSnapshotId: workItem.batch.rosterSnapshotId,
    recipientId: workItem.attempt.recipientId,
    endpointId: workItem.attempt.endpointId,
    status: 'invalid',
    reasonCode,
  };
}

/** Direct handoff worker; it never creates Expo receipts or delivery truth. */
export class DirectPushWorker {
  readonly #processor: WorkerAttemptProcessor;
  readonly #invalidator: PushEndpointInvalidator;
  readonly #provider: DirectPushProvider;

  public constructor(options: DirectPushWorkerOptions) {
    if (
      options.adapter.channel !== 'push' ||
      options.adapter.integrationId !== 'mobile-push' ||
      options.adapter.truthLabel !== 'live-verified' ||
      (options.adapter.provider !== APNS_DIRECT_PROVIDER &&
        options.adapter.provider !== FCM_DIRECT_PROVIDER) ||
      typeof options.endpointEligibility?.isEligible !== 'function' ||
      typeof options.endpointInvalidator?.invalidate !== 'function'
    ) {
      throw new TypeError('Direct push worker configuration is invalid.');
    }
    const retryPolicy = parseRetryPolicy(
      options.retryPolicy ?? DEFAULT_RETRY_POLICY,
    );
    this.#processor = new WorkerAttemptProcessor({
      adapter: options.adapter,
      executionStore: options.executionStore,
      evidenceWriter: options.evidenceWriter,
      retryPolicy,
      authorizeProviderSend: (workItem) =>
        options.endpointEligibility.isEligible(workItem),
      ...(options.leaseMilliseconds === undefined
        ? {}
        : { leaseMilliseconds: options.leaseMilliseconds }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.authorizeLiveProvider === undefined
        ? {}
        : { authorizeLiveProvider: options.authorizeLiveProvider }),
    });
    this.#invalidator = options.endpointInvalidator;
    this.#provider = options.adapter.provider;
  }

  public async process(
    workValue: WorkerAttemptWorkItem | unknown,
  ): Promise<WorkerAttemptProcessResult> {
    const workItem = parseWorkerAttemptWorkItem(workValue);
    const result = await this.#processor.process(workItem);
    if ('outcome' in result && result.outcome.state === 'delivered') {
      throw new TypeError('Direct push delivery truth is invalid.');
    }
    if (
      'outcome' in result &&
      result.outcome.state === 'failed' &&
      INVALIDATING_REASONS.has(result.outcome.reasonCode)
    ) {
      const durable = DeliveryEvidenceSchema.safeParse(result.outcomeEvidence);
      if (
        !durable.success ||
        durable.data.subject.kind !== 'attempt' ||
        durable.data.subject.attemptId !== workItem.attempt.id ||
        durable.data.state !== 'failed' ||
        durable.data.provider !== this.#provider ||
        durable.data.reasonCode !== result.outcome.reasonCode
      ) {
        throw new TypeError(
          'Direct push durable invalidation evidence is invalid.',
        );
      }
      await this.#invalidator.invalidate(
        invalidationInput(
          workItem,
          result.outcome.reasonCode,
          durable.data.providerOccurredAt,
        ),
      );
    }
    return result;
  }
}

export interface PushAttemptWorker {
  process(
    workValue: WorkerAttemptWorkItem | unknown,
  ): Promise<WorkerAttemptProcessResult>;
}

export interface PushProviderRouterOptions {
  readonly legacyExpo: PushAttemptWorker;
  readonly expo: PushAttemptWorker;
  readonly apns: PushAttemptWorker;
  readonly fcm: PushAttemptWorker;
}

/** Routes from the immutable endpoint selection, never from token shape. */
export class PushProviderRouter implements PushAttemptWorker {
  public constructor(private readonly workers: PushProviderRouterOptions) {
    if (
      typeof workers.legacyExpo?.process !== 'function' ||
      typeof workers.expo?.process !== 'function' ||
      typeof workers.apns?.process !== 'function' ||
      typeof workers.fcm?.process !== 'function'
    ) {
      throw new TypeError('Push provider router configuration is invalid.');
    }
  }

  public process(
    workValue: WorkerAttemptWorkItem | unknown,
  ): Promise<WorkerAttemptProcessResult> {
    const workItem = parseWorkerAttemptWorkItem(workValue);
    if (workItem.endpoint.channel !== 'push') {
      throw new TypeError('Push provider route is invalid.');
    }
    const integrationId = workItem.batch.integrationStatus.integrationId;
    if (integrationId === 'expo-push') {
      if (workItem.endpoint.provider !== 'expo') {
        throw new TypeError('Legacy push provider route is invalid.');
      }
      return this.workers.legacyExpo.process(workItem);
    }
    if (integrationId !== 'mobile-push') {
      throw new TypeError('Push provider route is invalid.');
    }
    if (workItem.endpoint.provider === 'expo') {
      return this.workers.expo.process(workItem);
    }
    if (
      workItem.endpoint.provider === 'apns' &&
      workItem.endpoint.platform === 'ios'
    ) {
      return this.workers.apns.process(workItem);
    }
    if (
      workItem.endpoint.provider === 'fcm' &&
      workItem.endpoint.platform === 'android'
    ) {
      return this.workers.fcm.process(workItem);
    }
    throw new TypeError('Push provider route is invalid.');
  }
}
