import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  type DeliveryEvidence,
  type IntegrationTruthLabel,
} from '@psd-eoc/contracts';

import {
  parseDeliveryStateWriteRequest,
  type AttemptEvidenceWriter,
  type DeliveryStateWriteRequest,
} from './delivery-state-client';
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
  type ProviderRecoveryResult,
  type ProviderSendOutcome,
  type ProviderSendRequest,
  type ReleaseAttemptExecutionRequest,
} from './processor';
import { ProviderDispatchError } from './retry';
import {
  IDS,
  TIMES,
  realBatch,
  syntheticBatch,
  workItem,
} from './test-fixtures';

const ACCEPTED = Object.freeze({
  state: 'provider-accepted',
  provider: 'mock-expo',
  providerReference: 'synthetic-provider-reference',
  proof: null,
  reasonCode: null,
  diagnosticDigest: null,
}) satisfies ProviderSendOutcome;

interface StoredExecution {
  readonly fingerprint: string;
  readonly leaseToken: string;
  completion: AttemptExecutionCompletion | null;
}

class MemoryExecutionStore implements AttemptExecutionStore {
  public readonly executions = new Map<string, StoredExecution>();
  public lookupCalls = 0;
  public claimCalls = 0;
  public completeCalls = 0;
  public releaseCalls = 0;
  public failCompleteOnce = false;

  public lookup(
    request: AttemptExecutionLookupRequest,
  ): Promise<AttemptExecutionLookup> {
    this.lookupCalls += 1;
    const existing = this.executions.get(request.attemptId);
    if (existing === undefined) {
      return Promise.resolve({ kind: 'missing' });
    }
    if (existing.fingerprint !== request.fingerprint) {
      throw new Error('Synthetic attempt fingerprint conflict.');
    }
    return Promise.resolve(
      existing.completion === null
        ? { kind: 'in-progress' }
        : { kind: 'completed', completion: existing.completion },
    );
  }

  public claim(
    request: AttemptExecutionClaimRequest,
  ): Promise<AttemptExecutionClaim> {
    this.claimCalls += 1;
    const existing = this.executions.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.fingerprint) {
        throw new Error('Synthetic attempt fingerprint conflict.');
      }
      return Promise.resolve(
        existing.completion === null
          ? { kind: 'in-progress' }
          : { kind: 'completed', completion: existing.completion },
      );
    }
    const execution: StoredExecution = {
      fingerprint: request.fingerprint,
      leaseToken: `synthetic-lease-${request.attemptId}`,
      completion: null,
    };
    this.executions.set(request.attemptId, execution);
    return Promise.resolve({
      kind: 'acquired',
      leaseToken: execution.leaseToken,
    });
  }

  public complete(request: CompleteAttemptExecutionRequest): Promise<void> {
    this.completeCalls += 1;
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false;
      throw new Error('Synthetic completion crash.');
    }
    const execution = this.executions.get(request.attemptId);
    if (
      execution === undefined ||
      execution.fingerprint !== request.fingerprint ||
      execution.leaseToken !== request.leaseToken
    ) {
      throw new Error('Synthetic completion conflict.');
    }
    execution.completion = request.completion;
    return Promise.resolve();
  }

  public expireLease(attemptId: string): void {
    this.executions.delete(attemptId);
  }

  public release(request: ReleaseAttemptExecutionRequest): Promise<void> {
    this.releaseCalls += 1;
    const execution = this.executions.get(request.attemptId);
    if (
      execution === undefined ||
      execution.fingerprint !== request.fingerprint ||
      execution.leaseToken !== request.leaseToken
    ) {
      throw new Error('Synthetic release conflict.');
    }
    this.executions.delete(request.attemptId);
    return Promise.resolve();
  }
}

class MemoryEvidenceWriter implements AttemptEvidenceWriter {
  public readonly evidence: DeliveryEvidence[] = [];
  public readonly calls: DeliveryStateWriteRequest[] = [];
  public failOnceForState:
    | DeliveryStateWriteRequest['evidence']['state']
    | null = null;

  public recordAttemptEvidence(
    value: DeliveryStateWriteRequest | unknown,
  ): Promise<DeliveryEvidence> {
    const request = parseDeliveryStateWriteRequest(value);
    this.calls.push(request);
    if (request.evidence.state === this.failOnceForState) {
      this.failOnceForState = null;
      throw new Error('Synthetic writeback crash.');
    }
    const attemptId = request.attempt.id;
    const input = request.evidence;
    const existing = this.evidence.find(
      (candidate) =>
        candidate.subject.kind === 'attempt' &&
        candidate.subject.attemptId === attemptId &&
        candidate.state === input.state &&
        candidate.provider === input.provider &&
        candidate.providerReference === input.providerReference &&
        JSON.stringify(candidate.proof) === JSON.stringify(input.proof) &&
        candidate.reasonCode === input.reasonCode &&
        candidate.diagnosticDigest === input.diagnosticDigest,
    );
    if (existing !== undefined) return Promise.resolve(existing);

    const prior = this.evidence.filter(
      (candidate) =>
        candidate.subject.kind === 'attempt' &&
        candidate.subject.attemptId === attemptId,
    );
    const suffix = String(200 + this.evidence.length).padStart(12, '0');
    const result = DeliveryEvidenceSchema.parse({
      id: `00000000-0000-4000-8000-${suffix}`,
      subject: input.subject,
      sequence: prior.length + 1,
      previousEvidenceId: prior.at(-1)?.id ?? null,
      state: input.state,
      recordedAt: TIMES.recorded,
      provider: input.provider,
      providerReference: input.providerReference,
      proof: input.proof,
      reasonCode: input.reasonCode,
      diagnosticDigest: input.diagnosticDigest,
    });
    this.evidence.push(result);
    return Promise.resolve(result);
  }
}

class DeferredAttemptEvidenceWriter extends MemoryEvidenceWriter {
  readonly #writeStarted: Promise<void>;
  readonly #releaseWrite: Promise<void>;
  #markWriteStarted: (() => void) | undefined;
  #resumeWrite: (() => void) | undefined;
  #deferred = false;

  public constructor() {
    super();
    this.#writeStarted = new Promise((resolve) => {
      this.#markWriteStarted = resolve;
    });
    this.#releaseWrite = new Promise((resolve) => {
      this.#resumeWrite = resolve;
    });
  }

  public override async recordAttemptEvidence(
    value: DeliveryStateWriteRequest | unknown,
  ): Promise<DeliveryEvidence> {
    const request = parseDeliveryStateWriteRequest(value);
    if (request.evidence.state === 'attempted' && !this.#deferred) {
      this.#deferred = true;
      this.#markWriteStarted?.();
      await this.#releaseWrite;
    }
    return super.recordAttemptEvidence(request);
  }

  public waitForAttemptedWrite(): Promise<void> {
    return this.#writeStarted;
  }

  public releaseAttemptedWrite(): void {
    this.#resumeWrite?.();
  }
}

class MockAdapter implements AttemptIdempotentProviderAdapter {
  public readonly channel = 'push' as const;
  public readonly integrationId = 'expo-push';
  public readonly provider = 'mock-expo';
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;
  public readonly requests: ProviderSendRequest[] = [];

  public constructor(
    public readonly truthLabel: IntegrationTruthLabel,
    private readonly handler: (
      request: ProviderSendRequest,
    ) => Promise<ProviderSendOutcome | unknown> = () =>
      Promise.resolve(ACCEPTED),
  ) {}

  public send(
    request: ProviderSendRequest,
  ): Promise<ProviderSendOutcome | unknown> {
    this.requests.push(request);
    return this.handler(request);
  }
}

class RecoveringLiveAdapter extends MockAdapter {
  public recovery: ProviderRecoveryResult = { kind: 'missing' };
  public readonly recoveryRequests: ProviderSendRequest[] = [];

  public constructor() {
    super('live-verified');
  }

  public recover(
    request: ProviderSendRequest,
  ): Promise<ProviderRecoveryResult> {
    this.recoveryRequests.push(request);
    return Promise.resolve(this.recovery);
  }
}

function runtime(
  adapter: AttemptIdempotentProviderAdapter,
  store = new MemoryExecutionStore(),
  writer = new MemoryEvidenceWriter(),
  options: Readonly<{
    maxAttempts?: number;
    authorizeFanout?: boolean | (() => boolean | Promise<boolean>);
    authorizeLive?: boolean;
    authorizeSend?: () => boolean | Promise<boolean>;
  }> = {},
) {
  return {
    store,
    writer,
    processor: new WorkerAttemptProcessor({
      adapter,
      executionStore: store,
      evidenceWriter: writer,
      retryPolicy: {
        maxAttempts: options.maxAttempts ?? 5,
        baseDelayMilliseconds: 1_000,
        maxDelayMilliseconds: 30_000,
        multiplier: 2,
        jitterRatio: 0,
      },
      random: () => 0.5,
      authorizeFanout:
        typeof options.authorizeFanout === 'function'
          ? options.authorizeFanout
          : () => options.authorizeFanout !== false,
      ...(options.authorizeLive === undefined
        ? {}
        : { authorizeLiveProvider: () => options.authorizeLive === true }),
      ...(options.authorizeSend === undefined
        ? {}
        : { authorizeProviderSend: options.authorizeSend }),
    }),
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('attempt-ID idempotent processing', () => {
  test('completed redelivery replays evidence without a duplicate provider send', async () => {
    const adapter = new MockAdapter('mocked');
    const app = runtime(adapter);
    const item = workItem();

    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: false }),
    );
    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: true }),
    );

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.idempotencyKey).toBe(IDS.attempt);
    expect(app.store.completeCalls).toBe(1);
    expect(app.writer.evidence.map((entry) => entry.state)).toEqual([
      'attempted',
      'provider-accepted',
    ]);
  });

  test('fails closed before evidence or provider I/O when current send policy denies', async () => {
    const adapter = new MockAdapter('mocked');
    const app = runtime(adapter, new MemoryExecutionStore(), undefined, {
      authorizeSend: () => false,
    });

    await expect(app.processor.process(workItem())).rejects.toEqual(
      expect.objectContaining({ code: 'PROVIDER_SEND_DISABLED' }),
    );
    expect(adapter.requests).toHaveLength(0);
    expect(app.writer.evidence).toHaveLength(0);
    expect(app.store.claimCalls).toBe(1);
    expect(app.store.releaseCalls).toBe(1);
    expect(app.store.executions).toHaveLength(0);
  });

  test('revalidates after attempted evidence and blocks revocation during its async write', async () => {
    const adapter = new MockAdapter('mocked');
    const store = new MemoryExecutionStore();
    const writer = new DeferredAttemptEvidenceWriter();
    let eligible = true;
    let policyChecks = 0;
    const app = runtime(adapter, store, writer, {
      authorizeSend: () => {
        policyChecks += 1;
        return eligible;
      },
    });

    const processing = app.processor.process(workItem());
    await writer.waitForAttemptedWrite();
    expect(policyChecks).toBe(1);
    eligible = false;
    writer.releaseAttemptedWrite();

    await expect(processing).rejects.toEqual(
      expect.objectContaining({ code: 'PROVIDER_SEND_DISABLED' }),
    );
    expect(policyChecks).toBe(2);
    expect(adapter.requests).toHaveLength(0);
    expect(writer.evidence.map(({ state }) => state)).toEqual(['attempted']);
    expect(store.releaseCalls).toBe(1);
    expect(store.executions).toHaveLength(0);
  });

  test('completed provider truth replays without consulting current send policy', async () => {
    const adapter = new MockAdapter('mocked');
    const store = new MemoryExecutionStore();
    const writer = new MemoryEvidenceWriter();
    await runtime(adapter, store, writer, {
      authorizeSend: () => true,
    }).processor.process(workItem());
    let policyCalls = 0;
    const replay = runtime(adapter, store, writer, {
      authorizeSend: () => {
        policyCalls += 1;
        throw new Error(
          'Recovered truth must not require current eligibility.',
        );
      },
    });

    await expect(replay.processor.process(workItem())).resolves.toMatchObject({
      kind: 'completed',
      replayed: true,
    });
    expect(policyCalls).toBe(0);
    expect(adapter.requests).toHaveLength(1);
  });

  test('crash after durable completion resumes writeback without re-sending', async () => {
    const adapter = new MockAdapter('mocked');
    const writer = new MemoryEvidenceWriter();
    writer.failOnceForState = 'provider-accepted';
    const app = runtime(adapter, new MemoryExecutionStore(), writer);
    const item = workItem();

    await expect(app.processor.process(item)).rejects.toThrow(
      'Synthetic writeback crash.',
    );
    expect(adapter.requests).toHaveLength(1);
    expect(app.store.executions.get(IDS.attempt)?.completion).toEqual({
      kind: 'final',
      outcome: ACCEPTED,
    });

    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: true }),
    );
    expect(adapter.requests).toHaveLength(1);
    expect(writer.evidence.map((entry) => entry.state)).toEqual([
      'attempted',
      'provider-accepted',
    ]);
  });

  test('completed live truth replays read-only after live authorization is removed', async () => {
    const adapter = new MockAdapter('live-verified');
    const store = new MemoryExecutionStore();
    const writer = new MemoryEvidenceWriter();
    const live = runtime(adapter, store, writer, { authorizeLive: true });
    const item = workItem(realBatch());

    await expect(live.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: false }),
    );

    const dark = runtime(adapter, store, writer);
    await expect(dark.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: true }),
    );
    expect(adapter.requests).toHaveLength(1);
    expect(store.lookupCalls).toBe(2);
    expect(store.claimCalls).toBe(1);
  });

  test('in-progress live truth remains visible when current live authorization denies', async () => {
    const provider = deferred<ProviderSendOutcome>();
    const started = deferred<void>();
    const adapter = new MockAdapter('live-verified', () => {
      started.resolve();
      return provider.promise;
    });
    const store = new MemoryExecutionStore();
    const writer = new MemoryEvidenceWriter();
    const live = runtime(adapter, store, writer, { authorizeLive: true });
    const item = workItem(realBatch());

    const first = live.processor.process(item);
    await started.promise;

    const dark = runtime(adapter, store, writer, { authorizeLive: false });
    await expect(dark.processor.process(item)).resolves.toEqual({
      kind: 'in-progress',
      retryAfterMilliseconds: 1_000,
    });
    expect(adapter.requests).toHaveLength(1);
    expect(store.lookupCalls).toBe(2);
    expect(store.claimCalls).toBe(1);

    provider.resolve(ACCEPTED);
    await expect(first).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: false }),
    );
  });

  test('crash after provider side effect relies on attempt-ID provider idempotency', async () => {
    let logicalSends = 0;
    const providerResults = new Map<string, ProviderSendOutcome>();
    const adapter = new MockAdapter('mocked', (request) => {
      const existing = providerResults.get(request.idempotencyKey);
      if (existing !== undefined) return Promise.resolve(existing);
      logicalSends += 1;
      providerResults.set(request.idempotencyKey, ACCEPTED);
      return Promise.resolve(ACCEPTED);
    });
    const store = new MemoryExecutionStore();
    store.failCompleteOnce = true;
    const app = runtime(adapter, store);
    const item = workItem();

    await expect(app.processor.process(item)).rejects.toEqual(
      expect.objectContaining({ code: 'IDEMPOTENCY_STORE_FAILED' }),
    );
    expect(adapter.requests).toHaveLength(1);
    expect(logicalSends).toBe(1);

    store.expireLease(IDS.attempt);
    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed' }),
    );
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests.map((call) => call.idempotencyKey)).toEqual([
      IDS.attempt,
      IDS.attempt,
    ]);
    expect(logicalSends).toBe(1);
  });

  test('recovers adapter-retained provider truth before a dark live gate', async () => {
    const adapter = new RecoveringLiveAdapter();
    const store = new MemoryExecutionStore();
    const writer = new MemoryEvidenceWriter();
    const item = workItem(realBatch());
    adapter.recovery = { kind: 'outcome', outcome: ACCEPTED };

    const dark = runtime(adapter, store, writer);
    await expect(dark.processor.process(item)).resolves.toEqual(
      expect.objectContaining({
        kind: 'completed',
        replayed: true,
        outcome: ACCEPTED,
      }),
    );

    expect(adapter.recoveryRequests).toEqual([
      { workItem: item, idempotencyKey: IDS.attempt },
    ]);
    expect(adapter.requests).toHaveLength(0);
    expect(store.lookupCalls).toBe(1);
    expect(store.claimCalls).toBe(1);
    expect(store.completeCalls).toBe(1);
    expect(writer.evidence.map(({ state }) => state)).toEqual([
      'attempted',
      'provider-accepted',
    ]);
  });

  test('concurrent duplicate observes in-progress and cannot race a send', async () => {
    const provider = deferred<ProviderSendOutcome>();
    const started = deferred<void>();
    const adapter = new MockAdapter('mocked', () => {
      started.resolve();
      return provider.promise;
    });
    const app = runtime(adapter);
    const item = workItem();

    const first = app.processor.process(item);
    await started.promise;
    await expect(app.processor.process(item)).resolves.toEqual({
      kind: 'in-progress',
      retryAfterMilliseconds: 1_000,
    });
    expect(adapter.requests).toHaveLength(1);

    provider.resolve(ACCEPTED);
    await expect(first).resolves.toEqual(
      expect.objectContaining({ kind: 'completed' }),
    );
    expect(adapter.requests).toHaveLength(1);
  });

  test('ambiguous provider side effect becomes unknown and never auto-resends', async () => {
    const adapter = new MockAdapter('mocked', () =>
      Promise.reject(new Error('connection ended after request write')),
    );
    const app = runtime(adapter);
    const item = workItem();

    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({
        kind: 'dlq',
        replayed: false,
        outcome: expect.objectContaining({
          state: 'unknown',
          reasonCode: 'PROVIDER_OUTCOME_AMBIGUOUS',
        }),
      }),
    );
    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'dlq', replayed: true }),
    );
    expect(adapter.requests).toHaveLength(1);
    expect(app.writer.evidence.map((entry) => entry.state)).toEqual([
      'attempted',
      'unknown',
    ]);
  });

  test('malformed provider outcome becomes unknown without a blind resend', async () => {
    const adapter = new MockAdapter('mocked', () =>
      Promise.resolve({ state: 'delivered', provider: 'mock-expo' }),
    );
    const app = runtime(adapter);
    const item = workItem();

    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({
        kind: 'dlq',
        outcome: expect.objectContaining({
          state: 'unknown',
          reasonCode: 'PROVIDER_OUTCOME_INVALID',
        }),
      }),
    );
    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'dlq', replayed: true }),
    );
    expect(adapter.requests).toHaveLength(1);
  });
});

describe('bounded retries and live-provider fail closed', () => {
  test('global emergency disable terminally suppresses mocked work before provider I/O', async () => {
    const adapter = new MockAdapter('mocked');
    const app = runtime(adapter, undefined, undefined, {
      authorizeFanout: false,
    });
    const item = workItem();

    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({
        kind: 'dlq',
        replayed: false,
        outcome: expect.objectContaining({
          state: 'failed',
          reasonCode: 'FANOUT_EMERGENCY_DISABLED',
        }),
      }),
    );
    await expect(app.processor.process(item)).resolves.toEqual(
      expect.objectContaining({ kind: 'dlq', replayed: true }),
    );
    expect(adapter.requests).toHaveLength(0);
    expect(app.store.claimCalls).toBe(1);
    expect(app.store.completeCalls).toBe(1);
    expect(app.writer.evidence.map((entry) => entry.state)).toEqual([
      'attempted',
      'failed',
    ]);
  });

  test('suppresses real and drill work without changing their classification', async () => {
    for (const batch of [syntheticBatch(), realBatch()]) {
      const adapter = new MockAdapter(
        batch.eventKind === 'incident' ? 'live-verified' : 'mocked',
      );
      const app = runtime(adapter, undefined, undefined, {
        authorizeFanout: false,
        ...(batch.eventKind === 'incident' ? { authorizeLive: true } : {}),
      });
      const item = workItem(batch);
      const result = await app.processor.process(item);

      expect(result).toMatchObject({
        kind: 'dlq',
        outcome: { reasonCode: 'FANOUT_EMERGENCY_DISABLED' },
      });
      expect(item.batch.eventKind).toBe(batch.eventKind);
      expect(item.batch.templateMode).toBe(batch.templateMode);
      expect(item.attempt.eventKind).toBe(batch.eventKind);
      expect(item.attempt.templateMode).toBe(batch.templateMode);
      expect(adapter.requests).toHaveLength(0);
    }
  });

  test('fan-out authorization failure is fail-closed and terminal', async () => {
    const adapter = new MockAdapter('mocked');
    const app = runtime(adapter, undefined, undefined, {
      authorizeFanout: () => Promise.reject(new Error('unavailable')),
    });

    await expect(app.processor.process(workItem())).resolves.toEqual(
      expect.objectContaining({
        kind: 'dlq',
        outcome: expect.objectContaining({
          reasonCode: 'FANOUT_EMERGENCY_DISABLED',
        }),
      }),
    );
    expect(adapter.requests).toHaveLength(0);
  });

  test('rechecks fan-out after attempted evidence and directly before provider I/O', async () => {
    const operations: string[] = [];
    const adapter = new MockAdapter('mocked', () => {
      operations.push('provider-send');
      return Promise.resolve(ACCEPTED);
    });
    const writer = new MemoryEvidenceWriter();
    const originalWrite = writer.recordAttemptEvidence.bind(writer);
    writer.recordAttemptEvidence = async (request) => {
      const parsed = parseDeliveryStateWriteRequest(request);
      operations.push(`evidence:${parsed.evidence.state}`);
      return originalWrite(request);
    };
    const app = runtime(adapter, undefined, writer, {
      authorizeFanout: () => {
        operations.push('fanout-check');
        return true;
      },
    });

    await app.processor.process(workItem());
    expect(operations.slice(0, 3)).toEqual([
      'evidence:attempted',
      'fanout-check',
      'provider-send',
    ]);
  });

  test('safe retries stop at the bound and produce failed plus DLQ', async () => {
    const adapter = new MockAdapter('mocked', () =>
      Promise.reject(
        new ProviderDispatchError('PROVIDER_THROTTLED', 'safe-to-retry'),
      ),
    );
    const app = runtime(adapter, undefined, undefined, { maxAttempts: 2 });
    const first = workItem(syntheticBatch(), { attemptNumber: 1 });
    const second = workItem(syntheticBatch(), {
      attemptId: IDS.secondAttempt,
      attemptNumber: 2,
    });

    await expect(app.processor.process(first)).resolves.toEqual(
      expect.objectContaining({
        kind: 'retry',
        replayed: false,
        delayMilliseconds: 1_000,
        nextAttemptNumber: 2,
        reasonCode: 'PROVIDER_THROTTLED',
        outcome: expect.objectContaining({
          state: 'failed',
          reasonCode: 'PROVIDER_THROTTLED',
        }),
      }),
    );
    await expect(app.processor.process(first)).resolves.toEqual(
      expect.objectContaining({ kind: 'retry', replayed: true }),
    );
    expect(adapter.requests).toHaveLength(1);
    await expect(app.processor.process(second)).resolves.toEqual(
      expect.objectContaining({
        kind: 'dlq',
        outcome: expect.objectContaining({
          state: 'failed',
          reasonCode: 'PROVIDER_RETRY_EXHAUSTED',
        }),
      }),
    );
    expect(adapter.requests).toHaveLength(2);
    expect(app.writer.evidence.map((entry) => entry.state)).toEqual([
      'attempted',
      'failed',
      'attempted',
      'failed',
    ]);
  });

  test('live-verified adapter requires an explicit successful gate', async () => {
    const adapter = new MockAdapter('live-verified');
    const item = workItem(realBatch());

    await expect(runtime(adapter).processor.process(item)).rejects.toEqual(
      expect.objectContaining({ code: 'LIVE_PROVIDER_DISABLED' }),
    );
    await expect(
      runtime(adapter, undefined, undefined, {
        authorizeLive: false,
      }).processor.process(item),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'LIVE_PROVIDER_DISABLED' }),
    );
    expect(adapter.requests).toHaveLength(0);
  });

  test('configured-unverified and blocked adapters cannot match canonical dispatch work', async () => {
    for (const truthLabel of ['configured-unverified', 'blocked'] as const) {
      const adapter = new MockAdapter(truthLabel);
      await expect(
        runtime(adapter).processor.process(workItem()),
      ).rejects.toEqual(expect.objectContaining({ code: 'ADAPTER_MISMATCH' }));
      expect(adapter.requests).toHaveLength(0);
    }
  });
});
