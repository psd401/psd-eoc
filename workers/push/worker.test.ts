import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  DeliveryTruthTransitionSchema,
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
import {
  IDS,
  TIMES,
  realBatch,
  syntheticBatch,
  workItem,
} from '../shared/test-fixtures';
import type { PushEndpointInvalidator } from './invalidation';
import {
  LedgeredExpoPushAdapter,
  type ClaimExpoProviderIoRequest,
  type CompleteExpoProviderIoRequest,
  type DurableExpoSendLedger,
  type ExpoSendLedgerClaim,
} from './adapter';
import {
  MOCK_EXPO_PUSH_PROVIDER,
  MockExpoPushAdapter,
  MockExpoPushTransport,
} from './mock';
import type { ExpoReceiptScheduler } from './receipt-lifecycle';
import {
  EXPO_PUSH_PROVIDER,
  failed,
  retry,
  type ExpoProviderOutcome,
} from './protocol';
import type { ExpoPushTransport } from './transport';
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
  public readonly schedules: Array<{
    workItem: ReturnType<typeof workItem>;
    evidence: DeliveryEvidence;
  }> = [];
  public failOnce = false;
  public failAttemptId: string | null = null;
  public delayAttemptId: string | null = null;
  public failureObserved = false;
  readonly #delayStarted: Promise<void>;
  readonly #releaseDelay: Promise<void>;
  #markDelayStarted: (() => void) | undefined;
  #releaseDelayedSchedule: (() => void) | undefined;

  public constructor(
    public readonly provider: string = MOCK_EXPO_PUSH_PROVIDER,
  ) {
    this.#delayStarted = new Promise((resolve) => {
      this.#markDelayStarted = resolve;
    });
    this.#releaseDelay = new Promise((resolve) => {
      this.#releaseDelayedSchedule = resolve;
    });
  }

  public async scheduleProviderAccepted(
    scheduledWorkItem: ReturnType<typeof workItem>,
    evidence: DeliveryEvidence,
  ): Promise<void> {
    if (this.failOnce || this.failAttemptId === scheduledWorkItem.attempt.id) {
      this.failOnce = false;
      this.failAttemptId = null;
      this.failureObserved = true;
      throw new Error('Synthetic receipt schedule failure.');
    }
    if (this.delayAttemptId === scheduledWorkItem.attempt.id) {
      this.#markDelayStarted?.();
      await this.#releaseDelay;
    }
    this.schedules.push({ workItem: scheduledWorkItem, evidence });
  }

  public waitForDelayedSchedule(): Promise<void> {
    return this.#delayStarted;
  }

  public releaseDelayedSchedule(): void {
    this.#releaseDelayedSchedule?.();
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

class WorkerMemoryExpoLedger implements DurableExpoSendLedger {
  public readonly claims: ClaimExpoProviderIoRequest[] = [];
  public readonly completions: CompleteExpoProviderIoRequest[] = [];
  readonly #claimed = new Set<string>();

  public claimProviderIo(
    request: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerClaim> {
    this.claims.push(request);
    if (this.#claimed.has(request.attemptId)) {
      return Promise.resolve({ kind: 'uncertain' });
    }
    this.#claimed.add(request.attemptId);
    return Promise.resolve({
      kind: 'execute',
      claimToken: 'synthetic-worker-claim-token-0001',
    });
  }

  public completeProviderIo(
    request: CompleteExpoProviderIoRequest,
  ): Promise<void> {
    this.completions.push(request);
    return Promise.resolve();
  }
}

class WorkerRecordingLiveTransport implements ExpoPushTransport {
  public readonly chunks: string[][] = [];

  public sendChunk(
    workItems: readonly ReturnType<typeof workItem>[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    this.chunks.push(workItems.map((item) => item.attempt.id));
    return Promise.resolve(
      workItems.map((item) => {
        const suffix = item.attempt.id.slice(-3);
        if (suffix === '032') {
          return failed('EXPO_DEVICE_NOT_REGISTERED', null, true);
        }
        if (suffix === '033') {
          return retry('EXPO_MESSAGE_RATE_EXCEEDED');
        }
        return Object.freeze({
          kind: 'provider-accepted' as const,
          state: 'provider-accepted' as const,
          providerReference: `ticket-${item.attempt.id}`,
          reasonCode: null,
          invalidatesEndpoint: false as const,
        });
      }),
    );
  }

  public queryReceiptChunk(): Promise<readonly ExpoProviderOutcome[]> {
    throw new Error('Worker send test must not query receipts.');
  }
}

describe('Expo durable attempt worker', () => {
  test('mock transport and adapter refuse live real-shaped work', () => {
    const item = workItem(realBatch());
    const transport = new MockExpoPushTransport();
    const adapter = new MockExpoPushAdapter();

    expect(() => transport.sendChunk([item])).toThrow(
      'Mock Expo transport accepts synthetic work only.',
    );
    expect(() =>
      adapter.send({ workItem: item, idempotencyKey: item.attempt.id }),
    ).toThrow('Mock Expo transport accepts synthetic work only.');
    expect(transport.sends).toHaveLength(0);
    expect(adapter.logicalSends).toBe(0);
  });

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
    expect(scheduler.schedules).toHaveLength(1);
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

  test('waits for sibling completion before propagating one receipt-scheduler failure', async () => {
    const scheduler = new RecordingReceiptScheduler();
    const items = [
      itemWithAttempt(24),
      itemWithAttempt(25),
      itemWithAttempt(26),
    ];
    scheduler.failAttemptId = items[1]!.attempt.id;
    scheduler.delayAttemptId = items[2]!.attempt.id;
    const app = workerRuntime(new MockExpoPushAdapter(), [], scheduler);

    const processing = app.worker.processAll(items);
    let settled = false;
    void processing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await scheduler.waitForDelayedSchedule();
    await Promise.resolve();
    expect(scheduler.failureObserved).toBe(true);
    expect(settled).toBe(false);

    scheduler.releaseDelayedSchedule();
    await expect(processing).rejects.toThrow(
      'Synthetic receipt schedule failure.',
    );

    expect(app.adapter.logicalSends).toBe(3);
    expect(app.store.executions).toHaveLength(3);
    expect(
      [...app.store.executions.values()].every(
        (execution) => execution.completion !== null,
      ),
    ).toBe(true);
    expect(scheduler.schedules).toHaveLength(2);

    await expect(app.worker.process(items[1]!)).resolves.toMatchObject({
      kind: 'completed',
      replayed: true,
    });
    expect(app.adapter.logicalSends).toBe(3);
    expect(scheduler.schedules).toHaveLength(3);
  });

  test('keeps whole-batch validation fail closed before durable or provider work', async () => {
    const app = workerRuntime();

    await expect(
      app.worker.processAll([itemWithAttempt(27), { malformed: true }]),
    ).rejects.toThrow();

    expect(app.store.executions).toHaveLength(0);
    expect(app.adapter.logicalSends).toBe(0);
    expect(app.adapter.requests).toHaveLength(0);
    expect(app.writer.evidence).toHaveLength(0);
    expect(app.scheduler.schedules).toHaveLength(0);
  });

  test('batches the operative ledger and evidence path with per-item outcomes', async () => {
    const transport = new WorkerRecordingLiveTransport();
    const ledger = new WorkerMemoryExpoLedger();
    const adapter = new LedgeredExpoPushAdapter({
      transport,
      sendLedger: ledger,
      batchWindowMilliseconds: 0,
      clock: () => realBatch().createdAt,
    });
    const writer = new MemoryEvidenceWriter();
    const invalidator = new RecordingInvalidator();
    const scheduler = new RecordingReceiptScheduler(EXPO_PUSH_PROVIDER);
    const worker = new ExpoPushWorker({
      adapter,
      executionStore: new MemoryExecutionStore(),
      evidenceWriter: writer,
      endpointInvalidator: invalidator,
      receiptScheduler: scheduler,
      retryPolicy: RETRY_POLICY,
      random: () => 0.5,
      authorizeLiveProvider: () => true,
    });
    const items = [
      workItem(realBatch(), {
        attemptId: '00000000-0000-4000-8000-000000000031',
      }),
      workItem(realBatch(), {
        attemptId: '00000000-0000-4000-8000-000000000032',
      }),
      workItem(realBatch(), {
        attemptId: '00000000-0000-4000-8000-000000000033',
      }),
    ];

    const results = await worker.processAll(items);

    expect(transport.chunks).toEqual([items.map((item) => item.attempt.id)]);
    expect(results.map((result) => result.kind)).toEqual([
      'completed',
      'dlq',
      'retry',
    ]);
    expect(ledger.completions).toHaveLength(3);
    expect(writer.evidence).toHaveLength(6);
    expect(invalidator.inputs).toHaveLength(1);
    expect(scheduler.schedules).toHaveLength(1);
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
