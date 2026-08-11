import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  DeliveryTruthTransitionSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
  type RecordEndpointStatusInput,
} from '@psd-eoc/contracts';

import type { AttemptEvidenceWriter } from '../shared/delivery-state-client';
import { parseDeliveryStateWriteRequest } from '../shared/delivery-state-client';
import {
  type AttemptExecutionClaim,
  type AttemptExecutionClaimRequest,
  type AttemptExecutionCompletion,
  type AttemptExecutionStore,
  type CompleteAttemptExecutionRequest,
  type ReleaseAttemptExecutionRequest,
} from '../shared/processor';
import { IDS, TIMES, syntheticBatch, workItem } from '../shared/test-fixtures';
import type { PushEndpointInvalidator } from './invalidation';
import { MOCK_EXPO_PUSH_PROVIDER, MockExpoPushAdapter } from './mock';
import type { ExpoReceiptScheduler } from './receipt-lifecycle';
import { ExpoPushWorker } from './worker';

const RETRY_POLICY = Object.freeze({
  maxAttempts: 2,
  baseDelayMilliseconds: 1_000,
  maxDelayMilliseconds: 5_000,
  multiplier: 2,
  jitterRatio: 0,
});

interface StoredExecution {
  readonly fingerprint: string;
  readonly leaseToken: string;
  completion: AttemptExecutionCompletion | null;
}

class MemoryExecutionStore implements AttemptExecutionStore {
  public readonly executions = new Map<string, StoredExecution>();

  public claim(
    request: AttemptExecutionClaimRequest,
  ): Promise<AttemptExecutionClaim> {
    const existing = this.executions.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.fingerprint) {
        throw new Error('Synthetic fingerprint conflict.');
      }
      return Promise.resolve(
        existing.completion === null
          ? { kind: 'in-progress' }
          : { kind: 'completed', completion: existing.completion },
      );
    }
    const execution = {
      fingerprint: request.fingerprint,
      leaseToken: `lease-${request.attemptId}`,
      completion: null,
    };
    this.executions.set(request.attemptId, execution);
    return Promise.resolve({
      kind: 'acquired',
      leaseToken: execution.leaseToken,
    });
  }

  public complete(request: CompleteAttemptExecutionRequest): Promise<void> {
    const existing = this.executions.get(request.attemptId);
    if (
      existing === undefined ||
      existing.fingerprint !== request.fingerprint ||
      existing.leaseToken !== request.leaseToken
    ) {
      throw new Error('Synthetic completion conflict.');
    }
    existing.completion = request.completion;
    return Promise.resolve();
  }

  public release(request: ReleaseAttemptExecutionRequest): Promise<void> {
    const existing = this.executions.get(request.attemptId);
    if (
      existing === undefined ||
      existing.fingerprint !== request.fingerprint ||
      existing.leaseToken !== request.leaseToken
    ) {
      throw new Error('Synthetic release conflict.');
    }
    this.executions.delete(request.attemptId);
    return Promise.resolve();
  }
}

class MemoryEvidenceWriter implements AttemptEvidenceWriter {
  public readonly evidence: DeliveryEvidence[] = [];

  public constructor(private readonly events: string[] = []) {}

  public recordAttemptEvidence(value: unknown): Promise<DeliveryEvidence> {
    const request = parseDeliveryStateWriteRequest(value);
    const input = request.evidence;
    const existing = this.evidence.find(
      (item) =>
        item.subject.kind === 'attempt' &&
        item.subject.attemptId === request.attempt.id &&
        item.state === input.state &&
        item.provider === input.provider &&
        item.providerReference === input.providerReference &&
        item.reasonCode === input.reasonCode,
    );
    if (existing !== undefined) return Promise.resolve(existing);
    const prior = this.evidence.filter(
      (item) =>
        item.subject.kind === 'attempt' &&
        item.subject.attemptId === request.attempt.id,
    );
    const previous = prior.at(-1);
    if (
      previous !== undefined &&
      !DeliveryTruthTransitionSchema.safeParse({
        subjectKind: 'attempt',
        from: previous.state,
        to: input.state,
      }).success
    ) {
      throw new Error('Synthetic delivery transition is invalid.');
    }
    const suffix = String(500 + this.evidence.length).padStart(12, '0');
    const result = DeliveryEvidenceSchema.parse({
      id: `00000000-0000-4000-8000-${suffix}`,
      subject: input.subject,
      sequence: prior.length + 1,
      previousEvidenceId: previous?.id ?? null,
      state: input.state,
      recordedAt: TIMES.recorded,
      provider: input.provider,
      providerReference: input.providerReference,
      proof: input.proof,
      reasonCode: input.reasonCode,
      diagnosticDigest: input.diagnosticDigest,
    });
    this.evidence.push(result);
    this.events.push(`evidence:${result.state}`);
    return Promise.resolve(result);
  }
}

class RecordingInvalidator implements PushEndpointInvalidator {
  public readonly inputs: RecordEndpointStatusInput[] = [];

  public constructor(private readonly events: string[] = []) {}

  public invalidate(input: RecordEndpointStatusInput): Promise<void> {
    this.inputs.push(input);
    this.events.push('invalidate');
    return Promise.resolve();
  }
}

class RecordingReceiptScheduler implements ExpoReceiptScheduler {
  public readonly provider = MOCK_EXPO_PUSH_PROVIDER;
  public readonly schedules: Array<{
    attempt: ChannelAttempt;
    evidence: DeliveryEvidence;
  }> = [];
  public failOnce = false;

  public scheduleProviderAccepted(
    attempt: ChannelAttempt,
    evidence: DeliveryEvidence,
  ): Promise<void> {
    this.schedules.push({ attempt, evidence });
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('Synthetic receipt schedule failure.');
    }
    return Promise.resolve();
  }
}

function workerRuntime(
  adapter = new MockExpoPushAdapter(),
  events: string[] = [],
  scheduler = new RecordingReceiptScheduler(),
) {
  const writer = new MemoryEvidenceWriter(events);
  const invalidator = new RecordingInvalidator(events);
  const store = new MemoryExecutionStore();
  const worker = new ExpoPushWorker({
    adapter,
    executionStore: store,
    evidenceWriter: writer,
    endpointInvalidator: invalidator,
    receiptScheduler: scheduler,
    retryPolicy: RETRY_POLICY,
    random: () => 0.5,
  });
  return { adapter, writer, invalidator, scheduler, store, worker };
}

function itemWithAttempt(suffix: number, attemptNumber = 1) {
  return workItem(syntheticBatch(), {
    attemptId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    attemptNumber,
  });
}

describe('Expo durable attempt worker', () => {
  test('rejects missing or provider-mismatched receipt schedulers before provider I/O', () => {
    const adapter = new MockExpoPushAdapter();
    const dependencies = {
      adapter,
      executionStore: new MemoryExecutionStore(),
      evidenceWriter: new MemoryEvidenceWriter(),
      endpointInvalidator: new RecordingInvalidator(),
    };

    expect(
      () =>
        new ExpoPushWorker({
          ...dependencies,
          receiptScheduler: undefined as never,
        }),
    ).toThrow('Expo receipt scheduler is invalid.');
    expect(
      () =>
        new ExpoPushWorker({
          ...dependencies,
          receiptScheduler: {
            provider: 'expo-push',
            scheduleProviderAccepted: () => Promise.resolve(),
          },
        }),
    ).toThrow('Expo receipt scheduler is invalid.');
    expect(adapter.requests).toHaveLength(0);
  });

  test('uses shared durable processing and replays without another logical send', async () => {
    const app = workerRuntime();
    const item = workItem();

    await expect(app.worker.process(item)).resolves.toMatchObject({
      kind: 'completed',
      replayed: false,
    });
    await expect(app.worker.process(item)).resolves.toMatchObject({
      kind: 'completed',
      replayed: true,
    });

    expect(app.adapter.logicalSends).toBe(1);
    expect(app.adapter.requests).toHaveLength(1);
    expect(app.scheduler.schedules).toHaveLength(2);
    expect(
      app.scheduler.schedules.map((schedule) => schedule.evidence.state),
    ).toEqual(['provider-accepted', 'provider-accepted']);
    expect(app.writer.evidence.map((entry) => entry.state)).toEqual([
      'attempted',
      'provider-accepted',
    ]);
  });

  test('replays provider acceptance until durable receipt scheduling succeeds', async () => {
    const scheduler = new RecordingReceiptScheduler();
    scheduler.failOnce = true;
    const app = workerRuntime(new MockExpoPushAdapter(), [], scheduler);
    const item = workItem();

    await expect(app.worker.process(item)).rejects.toThrow(
      'Synthetic receipt schedule failure.',
    );
    expect(app.adapter.logicalSends).toBe(1);

    await expect(app.worker.process(item)).resolves.toMatchObject({
      kind: 'completed',
      replayed: true,
    });
    expect(app.adapter.logicalSends).toBe(1);
    expect(scheduler.schedules).toHaveLength(2);
  });

  test('records DeviceNotRegistered before token-free invalidation', async () => {
    const events: string[] = [];
    const app = workerRuntime(
      new MockExpoPushAdapter({ behaviors: ['device-not-registered'] }),
      events,
    );

    await expect(app.worker.process(workItem())).resolves.toMatchObject({
      kind: 'dlq',
      outcome: {
        state: 'failed',
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
      },
    });
    expect(events).toEqual([
      'evidence:attempted',
      'evidence:failed',
      'invalidate',
    ]);
    expect(app.invalidator.inputs).toEqual([
      {
        rosterSnapshotId: IDS.roster,
        recipientId: IDS.recipient,
        endpointId: IDS.endpoint,
        status: 'invalid',
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
      },
    ]);
  });

  test('handles mixed mock outcomes independently', async () => {
    const app = workerRuntime(
      new MockExpoPushAdapter({
        behaviors: ['accepted', 'device-not-registered', 'unknown'],
      }),
    );
    const results = await app.worker.processAll([
      itemWithAttempt(21),
      itemWithAttempt(22),
      itemWithAttempt(23),
    ]);

    expect(results.map((result) => result.kind)).toEqual([
      'completed',
      'dlq',
      'dlq',
    ]);
    expect(app.adapter.logicalSends).toBe(3);
    expect(app.invalidator.inputs).toHaveLength(1);
  });

  test('backs off retryable failures and reaches terminal DLQ at the bound', async () => {
    const app = workerRuntime(
      new MockExpoPushAdapter({
        behaviors: ['message-rate-exceeded', 'message-rate-exceeded'],
      }),
    );
    const first = itemWithAttempt(31, 1);
    const second = itemWithAttempt(32, 2);

    await expect(app.worker.process(first)).resolves.toMatchObject({
      kind: 'retry',
      delayMilliseconds: 1_000,
      nextAttemptNumber: 2,
      reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
    });
    await expect(app.worker.process(second)).resolves.toMatchObject({
      kind: 'dlq',
      outcome: {
        state: 'failed',
        reasonCode: 'PROVIDER_RETRY_EXHAUSTED',
      },
    });
    expect(app.adapter.logicalSends).toBe(2);
  });
});
