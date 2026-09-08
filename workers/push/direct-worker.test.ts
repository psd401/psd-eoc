import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  DispatchBatchSchema,
  EndpointSchema,
  type DeliveryEvidence,
  type Endpoint,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import {
  parseDeliveryStateWriteRequest,
  type AttemptEvidenceWriter,
} from '../shared/delivery-state-client';
import type {
  AttemptExecutionCompletion,
  AttemptExecutionStore,
  AttemptIdempotentProviderAdapter,
  CompleteAttemptExecutionRequest,
  WorkerAttemptProcessResult,
} from '../shared/processor';
import { attemptFor, realBatch, TIMES } from '../shared/test-fixtures';
import { APNS_DIRECT_PROVIDER } from './direct-protocol';
import {
  DirectPushWorker,
  PushProviderRouter,
  type PushAttemptWorker,
} from './direct-worker';

function work(
  provider: 'expo' | 'apns' = 'apns',
  integrationId: 'expo-push' | 'mobile-push' = 'mobile-push',
): WorkerAttemptWorkItem {
  const base = realBatch();
  const batch = DispatchBatchSchema.parse({
    ...base,
    integrationId,
  });
  const endpoint: Endpoint = EndpointSchema.parse({
    id: '00000000-0000-4000-8000-000000000012',
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'push',
    platform: 'ios',
    provider,
    serviceEnvironment: 'production',
    token:
      provider === 'expo'
        ? 'ExponentPushToken[synthetic-unroutable]'
        : 'a'.repeat(64),
  });
  return Object.freeze({ batch, attempt: attemptFor(batch), endpoint });
}

class MemoryExecutionStore implements AttemptExecutionStore {
  completion: AttemptExecutionCompletion | null = null;

  lookup() {
    return Promise.resolve(
      this.completion === null
        ? ({ kind: 'missing' } as const)
        : ({ kind: 'completed', completion: this.completion } as const),
    );
  }

  claim() {
    return Promise.resolve({ kind: 'acquired' as const, leaseToken: 'lease' });
  }

  complete(request: CompleteAttemptExecutionRequest) {
    this.completion = request.completion;
    return Promise.resolve();
  }

  release() {
    return Promise.resolve();
  }
}

class MemoryWriter implements AttemptEvidenceWriter {
  readonly evidence: DeliveryEvidence[] = [];

  public constructor(private readonly events: string[]) {}

  recordAttemptEvidence(value: unknown): Promise<DeliveryEvidence> {
    const request = parseDeliveryStateWriteRequest(value);
    const prior = this.evidence.at(-1);
    const result = DeliveryEvidenceSchema.parse({
      id: `00000000-0000-4000-8000-${String(900 + this.evidence.length).padStart(12, '0')}`,
      subject: request.evidence.subject,
      sequence: this.evidence.length + 1,
      previousEvidenceId: prior?.id ?? null,
      state: request.evidence.state,
      recordedAt: TIMES.recorded,
      provider: request.evidence.provider,
      providerReference: request.evidence.providerReference,
      ...(request.evidence.providerOccurredAt === undefined
        ? {}
        : { providerOccurredAt: request.evidence.providerOccurredAt }),
      proof: request.evidence.proof,
      reasonCode: request.evidence.reasonCode,
      diagnosticDigest: request.evidence.diagnosticDigest,
    });
    this.evidence.push(result);
    this.events.push(`evidence:${result.state}`);
    return Promise.resolve(result);
  }
}

function adapter(
  state: 'failed' | 'unknown',
): AttemptIdempotentProviderAdapter {
  return {
    channel: 'push',
    integrationId: 'mobile-push',
    provider: APNS_DIRECT_PROVIDER,
    deliverySemantics: 'attempt-id-idempotent',
    send: () =>
      Promise.resolve({
        state,
        provider: APNS_DIRECT_PROVIDER,
        providerReference: null,
        proof: null,
        reasonCode:
          state === 'failed'
            ? 'APNS_BAD_DEVICE_TOKEN'
            : 'APNS_NETWORK_OUTCOME_AMBIGUOUS',
        diagnosticDigest: null,
      }),
  };
}

describe('direct push worker', () => {
  test('invalidates only after durable terminal provider evidence', async () => {
    const events: string[] = [];
    const invalidations: unknown[] = [];
    const worker = new DirectPushWorker({
      adapter: adapter('failed'),
      executionStore: new MemoryExecutionStore(),
      evidenceWriter: new MemoryWriter(events),
      endpointEligibility: { isEligible: () => Promise.resolve(true) },
      endpointInvalidator: {
        invalidate(input) {
          invalidations.push(input);
          events.push('invalidate');
          return Promise.resolve();
        },
      },
    });

    await expect(worker.process(work())).resolves.toMatchObject({
      kind: 'dlq',
      outcome: { state: 'failed', reasonCode: 'APNS_BAD_DEVICE_TOKEN' },
    });
    expect(events).toEqual([
      'evidence:attempted',
      'evidence:failed',
      'invalidate',
    ]);
    expect(invalidations).toEqual([
      expect.objectContaining({
        status: 'invalid',
        reasonCode: 'APNS_BAD_DEVICE_TOKEN',
      }),
    ]);
  });

  test('retains ambiguous outcomes without retry or invalidation', async () => {
    const invalidations: unknown[] = [];
    const worker = new DirectPushWorker({
      adapter: adapter('unknown'),
      executionStore: new MemoryExecutionStore(),
      evidenceWriter: new MemoryWriter([]),
      endpointEligibility: { isEligible: () => Promise.resolve(true) },
      endpointInvalidator: {
        invalidate: (input) => {
          invalidations.push(input);
          return Promise.resolve();
        },
      },
    });
    await expect(worker.process(work())).resolves.toMatchObject({
      kind: 'dlq',
      outcome: { state: 'unknown' },
    });
    expect(invalidations).toHaveLength(0);
  });

  test('preserves the authoritative APNs unregistration time through durable invalidation', async () => {
    const invalidations: unknown[] = [];
    const directAdapter: AttemptIdempotentProviderAdapter = {
      channel: 'push',
      integrationId: 'mobile-push',
      provider: APNS_DIRECT_PROVIDER,
      deliverySemantics: 'attempt-id-idempotent',
      send: () =>
        Promise.resolve({
          state: 'failed',
          provider: APNS_DIRECT_PROVIDER,
          providerReference: null,
          providerOccurredAt: TIMES.attempted,
          proof: null,
          reasonCode: 'APNS_UNREGISTERED',
          diagnosticDigest: null,
        }),
    };
    const worker = new DirectPushWorker({
      adapter: directAdapter,
      executionStore: new MemoryExecutionStore(),
      evidenceWriter: new MemoryWriter([]),
      endpointEligibility: { isEligible: () => Promise.resolve(true) },
      endpointInvalidator: {
        invalidate: (input) => {
          invalidations.push(input);
          return Promise.resolve();
        },
      },
    });
    await worker.process(work());
    expect(invalidations).toEqual([
      expect.objectContaining({
        reasonCode: 'APNS_UNREGISTERED',
        providerOccurredAt: TIMES.attempted,
      }),
    ]);
  });
});

describe('push provider router', () => {
  test('preserves legacy Expo and selects one provider from pinned endpoint metadata', async () => {
    const calls: string[] = [];
    const result: WorkerAttemptProcessResult = {
      kind: 'in-progress',
      retryAfterMilliseconds: 100,
    };
    const worker = (name: string): PushAttemptWorker => ({
      process: () => {
        calls.push(name);
        return Promise.resolve(result);
      },
    });
    const router = new PushProviderRouter({
      legacyExpo: worker('legacy-expo'),
      expo: worker('expo'),
      apns: worker('apns'),
      fcm: worker('fcm'),
    });

    await router.process(work('expo', 'expo-push'));
    await router.process(work('apns', 'mobile-push'));
    await router.process(work('expo', 'mobile-push'));
    expect(calls).toEqual(['legacy-expo', 'apns', 'expo']);
  });
});
