import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  DispatchBatchSchema,
  DispatchOutboxResultSchema,
  NotificationOutboxMessageSchema,
  OutboxRecordSchema,
  type DeliveryEvidence,
  type DispatchBatch,
  type DispatchOutboxResult,
  type NotificationChannel,
  type OutboxRecord,
} from '@psd-eoc/contracts';

import {
  MAX_OUTBOX_BACKOFF_MILLISECONDS,
  OutboxDispatcherError,
  QueuePublishError,
  computeOutboxBackoffMilliseconds,
  dispatchOutbox,
  dispatchOutboxAfterCommit,
  parseSqsSendMessageBatchResponse,
  readSqsDispatchBatchQueueConfiguration,
  serializeDispatchQueueEntries,
  signSqsSendMessageBatchRequest,
  type DispatchBatchQueue,
  type DispatchQueueAcknowledgement,
  type OutboxClaimResult,
  type OutboxDispatchClaim,
  type OutboxDispatcherErrorCode,
  type OutboxDispatcherStore,
  type OutboxFailureDisposition,
} from '../../packages/server/lib/notify/dispatcher';
import {
  WorkerAttemptProcessor,
  type AttemptExecutionClaim,
  type AttemptExecutionClaimRequest,
  type AttemptExecutionCompletion,
  type AttemptExecutionLookup,
  type AttemptExecutionLookupRequest,
  type AttemptExecutionStore,
  type CompleteAttemptExecutionRequest,
  type ProviderSendOutcome,
} from './processor';
import {
  parseDeliveryStateWriteRequest,
  type AttemptEvidenceWriter,
  type DeliveryStateWriteRequest,
} from './delivery-state-client';
import { syntheticBatch, workItem } from './test-fixtures';

const IDS = Object.freeze({
  outbox: '00000000-0000-4000-8000-000000001001',
  intent: '00000000-0000-4000-8000-000000001002',
  event: '00000000-0000-4000-8000-000000001003',
  facility: '00000000-0000-4000-8000-000000001013',
  eventTypeVersion: '00000000-0000-4000-8000-000000001004',
  roster: '00000000-0000-4000-8000-000000001005',
  audience: '00000000-0000-4000-8000-000000001006',
  request: '00000000-0000-4000-8000-000000001007',
  preview: '00000000-0000-4000-8000-000000001008',
  pushBatch: '00000000-0000-4000-8000-000000001009',
  emailBatch: '00000000-0000-4000-8000-000000001010',
  smsBatch: '00000000-0000-4000-8000-000000001011',
  directRequest: '00000000-0000-4000-8000-000000001012',
});

const TIMES = Object.freeze({
  created: '2026-08-10T16:00:00.000Z',
  locked: '2026-08-10T16:00:30.000Z',
  published: '2026-08-10T16:01:00.000Z',
});

const AUTHORIZATION = Object.freeze({
  kind: 'synthetic-training' as const,
  activationPreviewId: IDS.preview,
  consequenceDigest: 'a'.repeat(64),
  requestId: IDS.request,
});

function renderedMessage(channel: NotificationChannel) {
  const common = {
    eventKind: 'test' as const,
    templateMode: 'drill' as const,
    purpose: 'activation' as const,
    classificationMarker: 'DRILL' as const,
  };
  switch (channel) {
    case 'push':
      return {
        ...common,
        channel,
        title: '[DRILL] Synthetic lockdown test',
        body: '[DRILL] Synthetic training only.',
      } as const;
    case 'email':
      return {
        ...common,
        channel,
        subject: '[DRILL] Synthetic lockdown test',
        textBody: '[DRILL] Synthetic training only.',
      } as const;
    case 'sms':
      return {
        ...common,
        channel,
        body: '[DRILL] Synthetic training only.',
      } as const;
  }
}

function integrationStatus(channel: NotificationChannel) {
  return {
    integrationId: {
      push: 'expo-push',
      email: 'ses-email',
      sms: 'aws-eum-sms',
    }[channel],
    label: 'mocked' as const,
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: TIMES.created,
  };
}

function channelPlans(endpointCount = 1_200) {
  return (['push', 'email', 'sms'] as const).map((channel) => ({
    channel,
    endpointCount,
    renderedMessage: renderedMessage(channel),
    integrationStatus: integrationStatus(channel),
  }));
}

function outboxMessage(endpointCount = 1_200) {
  return NotificationOutboxMessageSchema.parse({
    version: 2,
    outboxId: IDS.outbox,
    intentId: IDS.intent,
    eventId: IDS.event,
    facilityId: IDS.facility,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: 'drill',
    },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    audienceConfig: { id: IDS.audience, version: 1 },
    requestId: IDS.request,
    authorization: AUTHORIZATION,
    channels: channelPlans(endpointCount),
    createdAt: TIMES.created,
  });
}

function dispatchBatches(endpointCount = 1_200): readonly DispatchBatch[] {
  const ids = [IDS.pushBatch, IDS.emailBatch, IDS.smsBatch] as const;
  return Object.freeze(
    channelPlans(endpointCount).map((plan, index) =>
      DispatchBatchSchema.parse({
        id: ids[index],
        intentId: IDS.intent,
        eventId: IDS.event,
        facilityId: IDS.facility,
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'activation',
        eventTypeVersion: {
          id: IDS.eventTypeVersion,
          templateMode: 'drill',
        },
        rosterSnapshotId: IDS.roster,
        rosterPopulation: 'synthetic',
        audienceConfig: { id: IDS.audience, version: 1 },
        requestId: IDS.request,
        authorization: AUTHORIZATION,
        channel: plan.channel,
        renderedMessage: plan.renderedMessage,
        integrationStatus: plan.integrationStatus,
        sequence: index + 1,
        endpointCount,
        createdAt: TIMES.created,
      }),
    ),
  );
}

type MemoryStatus = 'pending' | 'processing' | 'published' | 'failed';

class DeterministicOutboxStore implements OutboxDispatcherStore {
  public status: MemoryStatus = 'pending';
  public attempts = 0;
  public leaseExpired = false;
  public publicationCrashesRemaining = 0;
  public lastErrorCode: OutboxDispatcherErrorCode | null = null;
  public readonly batches: readonly DispatchBatch[];

  public constructor(
    public readonly maxAttempts = 5,
    endpointCount = 1_200,
  ) {
    this.batches = dispatchBatches(endpointCount);
  }

  public listReadyOutboxIds(): Promise<readonly string[]> {
    return Promise.resolve(
      this.status === 'pending' ||
        (this.status === 'processing' && this.leaseExpired)
        ? [IDS.outbox]
        : [],
    );
  }

  public claimOutbox(outboxId: string): Promise<OutboxClaimResult> {
    if (outboxId !== IDS.outbox) {
      return Promise.resolve({ kind: 'missing' });
    }
    if (this.status === 'published') {
      return Promise.resolve({ kind: 'published', result: this.result() });
    }
    if (this.status === 'failed') {
      return Promise.resolve({ kind: 'failed', record: this.record() });
    }
    if (this.status === 'processing' && !this.leaseExpired) {
      return Promise.resolve({ kind: 'busy' });
    }
    const reclaimingExpiredLease = this.status === 'processing';
    if (!reclaimingExpiredLease && this.attempts >= this.maxAttempts) {
      this.status = 'failed';
      this.lastErrorCode = 'OUTBOX_DISPATCH_RETRY_EXHAUSTED';
      return Promise.resolve({ kind: 'failed', record: this.record() });
    }
    this.status = 'processing';
    this.leaseExpired = false;
    if (!reclaimingExpiredLease) {
      this.attempts += 1;
    }
    return Promise.resolve({ kind: 'claimed', claim: this.claim() });
  }

  public markPublished(
    claim: OutboxDispatchClaim,
  ): Promise<DispatchOutboxResult | null> {
    if (this.publicationCrashesRemaining > 0) {
      this.publicationCrashesRemaining -= 1;
      throw new OutboxDispatcherError(
        'OUTBOX_PERSISTENCE_FAILED',
        'Synthetic crash before publication finalization.',
        true,
      );
    }
    if (
      this.status !== 'processing' ||
      claim.attempt !== this.attempts ||
      claim.outboxId !== IDS.outbox
    ) {
      return Promise.resolve(null);
    }
    this.status = 'published';
    return Promise.resolve(this.result());
  }

  public recordFailure(
    claim: OutboxDispatchClaim,
    errorCode: OutboxDispatcherErrorCode,
    retryable: boolean,
  ): Promise<OutboxFailureDisposition> {
    if (this.status !== 'processing' || claim.attempt !== this.attempts) {
      return Promise.resolve('stale-claim');
    }
    if (retryable && claim.attempt < this.maxAttempts) {
      this.status = 'pending';
      this.leaseExpired = false;
      return Promise.resolve('retry-scheduled');
    }
    this.status = 'failed';
    this.lastErrorCode = retryable
      ? 'OUTBOX_DISPATCH_RETRY_EXHAUSTED'
      : errorCode;
    return Promise.resolve('terminal-failure');
  }

  public expireLease(): void {
    this.leaseExpired = true;
  }

  public record(): OutboxRecord {
    return OutboxRecordSchema.parse({
      id: IDS.outbox,
      message: outboxMessage(),
      status: this.status,
      attempts: this.attempts,
      availableAt: TIMES.created,
      lockedUntil: this.status === 'processing' ? TIMES.locked : null,
      publishedAt: this.status === 'published' ? TIMES.published : null,
      failedAt: this.status === 'failed' ? TIMES.published : null,
      lastErrorCode: this.lastErrorCode,
    });
  }

  private claim(): OutboxDispatchClaim {
    return Object.freeze({
      outboxId: IDS.outbox,
      facilityId: IDS.facility,
      attempt: this.attempts,
      lockedUntil: TIMES.locked,
      processingRecord: this.record(),
      batches: this.batches,
    });
  }

  private result(): DispatchOutboxResult {
    return DispatchOutboxResultSchema.parse({
      facilityId: IDS.facility,
      outboxRecord: this.record(),
      batches: this.batches,
    });
  }
}

class CapturingQueue implements DispatchBatchQueue {
  public readonly calls: ReturnType<typeof serializeDispatchQueueEntries>[] =
    [];

  public send(
    batches: readonly DispatchBatch[],
  ): Promise<readonly DispatchQueueAcknowledgement[]> {
    const entries = serializeDispatchQueueEntries(batches);
    this.calls.push(entries);
    return Promise.resolve(
      entries.map((entry) => ({
        entryId: entry.id,
        messageId: `synthetic-${entry.batchId}`,
      })),
    );
  }
}

class WorkerExecutionStore implements AttemptExecutionStore {
  private readonly completions = new Map<
    string,
    Readonly<{ fingerprint: string; completion: AttemptExecutionCompletion }>
  >();

  public lookup(
    request: AttemptExecutionLookupRequest,
  ): Promise<AttemptExecutionLookup> {
    const existing = this.completions.get(request.attemptId);
    if (existing === undefined) {
      return Promise.resolve({ kind: 'missing' });
    }
    if (existing.fingerprint !== request.fingerprint) {
      throw new Error('Synthetic worker fingerprint conflict.');
    }
    return Promise.resolve({
      kind: 'completed',
      completion: existing.completion,
    });
  }

  public claim(
    request: AttemptExecutionClaimRequest,
  ): Promise<AttemptExecutionClaim> {
    const existing = this.completions.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.fingerprint) {
        throw new Error('Synthetic worker fingerprint conflict.');
      }
      return Promise.resolve({
        kind: 'completed',
        completion: existing.completion,
      });
    }
    return Promise.resolve({
      kind: 'acquired',
      leaseToken: `lease-${request.attemptId}`,
    });
  }

  public complete(request: CompleteAttemptExecutionRequest): Promise<void> {
    this.completions.set(request.attemptId, {
      fingerprint: request.fingerprint,
      completion: request.completion,
    });
    return Promise.resolve();
  }

  public release(): Promise<void> {
    return Promise.resolve();
  }
}

class WorkerEvidenceWriter implements AttemptEvidenceWriter {
  private readonly entries: DeliveryEvidence[] = [];

  public recordAttemptEvidence(
    requestValue: DeliveryStateWriteRequest | unknown,
  ): Promise<DeliveryEvidence> {
    const request = parseDeliveryStateWriteRequest(requestValue);
    const input = request.evidence;
    const existing = this.entries.find(
      (entry) =>
        entry.subject.kind === 'attempt' &&
        entry.subject.attemptId === request.attempt.id &&
        entry.state === input.state,
    );
    if (existing !== undefined) return Promise.resolve(existing);
    const prior = this.entries.filter(
      (entry) =>
        entry.subject.kind === 'attempt' &&
        entry.subject.attemptId === request.attempt.id,
    );
    const idSuffix = String(2_000 + this.entries.length).padStart(12, '0');
    const evidence = DeliveryEvidenceSchema.parse({
      id: `00000000-0000-4000-8000-${idSuffix}`,
      subject: input.subject,
      sequence: prior.length + 1,
      previousEvidenceId: prior.at(-1)?.id ?? null,
      state: input.state,
      recordedAt: TIMES.published,
      provider: input.provider,
      providerReference: input.providerReference,
      proof: input.proof,
      reasonCode: input.reasonCode,
      diagnosticDigest: input.diagnosticDigest,
    });
    this.entries.push(evidence);
    return Promise.resolve(evidence);
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('dispatcher crash, replay, and stable worker idempotency', () => {
  test('SQS success before publication crash retries stable bodies and sends logically once', async () => {
    const store = new DeterministicOutboxStore();
    store.publicationCrashesRemaining = 1;
    const queue = new CapturingQueue();

    await expect(dispatchOutbox(IDS.outbox, { store, queue })).rejects.toEqual(
      expect.objectContaining({ code: 'OUTBOX_PERSISTENCE_FAILED' }),
    );
    expect(store.status).toBe('processing');
    store.expireLease();
    await expect(dispatchOutbox(IDS.outbox, { store, queue })).resolves.toEqual(
      expect.objectContaining({
        outboxRecord: expect.objectContaining({ status: 'published' }),
      }),
    );

    expect(queue.calls).toHaveLength(2);
    expect(queue.calls[1]).toEqual(queue.calls[0]);
    expect(store.attempts).toBe(1);
    expect(queue.calls[0]?.map((entry) => entry.batchId)).toEqual([
      IDS.pushBatch,
      IDS.emailBatch,
      IDS.smsBatch,
    ]);

    const logicalSends = new Set<string>();
    let adapterInvocations = 0;
    const adapter = {
      channel: 'push' as const,
      integrationId: 'expo-push',
      truthLabel: 'mocked' as const,
      provider: 'mock-expo',
      deliverySemantics: 'attempt-id-idempotent' as const,
      send: (request: Readonly<{ idempotencyKey: string }>) => {
        adapterInvocations += 1;
        logicalSends.add(request.idempotencyKey);
        return Promise.resolve({
          state: 'provider-accepted' as const,
          provider: 'mock-expo',
          providerReference: `synthetic-${request.idempotencyKey}`,
          proof: null,
          reasonCode: null,
          diagnosticDigest: null,
        } satisfies ProviderSendOutcome);
      },
    };
    const processor = new WorkerAttemptProcessor({
      adapter,
      executionStore: new WorkerExecutionStore(),
      evidenceWriter: new WorkerEvidenceWriter(),
      random: () => 0.5,
    });
    const pushBatch = queue.calls[0]
      ?.map((entry) => DispatchBatchSchema.parse(JSON.parse(entry.body)))
      .find((batch) => batch.channel === 'push');
    expect(pushBatch).toBeDefined();
    const attempt = workItem(pushBatch);

    await processor.process(attempt);
    await processor.process(attempt);

    expect(adapterInvocations).toBe(1);
    expect(logicalSends.size).toBe(1);
  });

  test('repeated ambiguous crashes retain work beyond the queue-failure budget', async () => {
    const store = new DeterministicOutboxStore(2);
    store.publicationCrashesRemaining = 4;
    const queue = new CapturingQueue();

    for (let crash = 0; crash < 4; crash += 1) {
      await expect(
        dispatchOutbox(IDS.outbox, { store, queue }),
      ).rejects.toEqual(
        expect.objectContaining({ code: 'OUTBOX_PERSISTENCE_FAILED' }),
      );
      expect(store.attempts).toBe(1);
      store.expireLease();
    }
    await expect(dispatchOutbox(IDS.outbox, { store, queue })).resolves.toEqual(
      expect.objectContaining({
        outboxRecord: expect.objectContaining({ status: 'published' }),
      }),
    );

    expect(queue.calls).toHaveLength(5);
    expect(
      queue.calls.every(
        (call) => JSON.stringify(call) === JSON.stringify(queue.calls[0]),
      ),
    ).toBe(true);
    expect(store.attempts).toBe(1);
  });

  test('a concurrent claim observes the lease and does not duplicate queue I/O', async () => {
    const store = new DeterministicOutboxStore();
    const started = deferred<void>();
    const completion = deferred<readonly DispatchQueueAcknowledgement[]>();
    let queueCalls = 0;
    let heldAcknowledgements: readonly DispatchQueueAcknowledgement[] = [];
    const queue: DispatchBatchQueue = {
      send(batches) {
        queueCalls += 1;
        heldAcknowledgements = serializeDispatchQueueEntries(batches).map(
          (entry) => ({
            entryId: entry.id,
            messageId: `synthetic-${entry.batchId}`,
          }),
        );
        started.resolve();
        return completion.promise;
      },
    };

    const first = dispatchOutbox(IDS.outbox, { store, queue });
    await started.promise;
    await expect(dispatchOutbox(IDS.outbox, { store, queue })).rejects.toEqual(
      expect.objectContaining({ code: 'OUTBOX_CLAIM_BUSY' }),
    );
    completion.resolve(heldAcknowledgements);
    await expect(first).resolves.toEqual(
      expect.objectContaining({
        outboxRecord: expect.objectContaining({ status: 'published' }),
      }),
    );
    expect(queueCalls).toBe(1);
  });
});

describe('queue failure and terminal truth', () => {
  test('replays every stable entry after a partial HTTP-200 batch result', async () => {
    const store = new DeterministicOutboxStore();
    const calls: ReturnType<typeof serializeDispatchQueueEntries>[] = [];
    const queue: DispatchBatchQueue = {
      send(batches) {
        const entries = serializeDispatchQueueEntries(batches);
        calls.push(entries);
        if (calls.length === 1) {
          return Promise.resolve(
            parseSqsSendMessageBatchResponse(
              {
                Successful: entries.slice(0, 2).map((entry) => ({
                  Id: entry.id,
                  MessageId: `synthetic-${entry.batchId}`,
                })),
                Failed: [
                  {
                    Id: entries[2]?.id,
                    Code: 'InternalError',
                    SenderFault: false,
                  },
                ],
              },
              entries,
            ),
          );
        }
        return Promise.resolve(
          entries.map((entry) => ({
            entryId: entry.id,
            messageId: `synthetic-replay-${entry.batchId}`,
          })),
        );
      },
    };

    await expect(dispatchOutbox(IDS.outbox, { store, queue })).rejects.toEqual(
      expect.objectContaining({
        code: 'SQS_BATCH_ENTRY_REJECTED',
        retryable: true,
        outcome: 'partial',
      }),
    );
    await expect(dispatchOutbox(IDS.outbox, { store, queue })).resolves.toEqual(
      expect.objectContaining({
        outboxRecord: expect.objectContaining({ status: 'published' }),
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(store.attempts).toBe(2);
  });

  test('bounds retries, then retains terminal outbox failure truth', async () => {
    const store = new DeterministicOutboxStore(2);
    let sends = 0;
    const queue: DispatchBatchQueue = {
      send() {
        sends += 1;
        throw new QueuePublishError(
          'SQS_REQUEST_FAILED',
          'Synthetic SQS timeout.',
          true,
          'unknown',
        );
      },
    };

    await expect(dispatchOutbox(IDS.outbox, { store, queue })).rejects.toEqual(
      expect.objectContaining({ code: 'SQS_REQUEST_FAILED', retryable: true }),
    );
    expect(store.status).toBe('pending');
    await expect(dispatchOutbox(IDS.outbox, { store, queue })).rejects.toEqual(
      expect.objectContaining({
        code: 'OUTBOX_DISPATCH_RETRY_EXHAUSTED',
        retryable: false,
      }),
    );

    expect(sends).toBe(2);
    expect(store.record()).toEqual(
      expect.objectContaining({
        status: 'failed',
        attempts: 2,
        lastErrorCode: 'OUTBOX_DISPATCH_RETRY_EXHAUSTED',
      }),
    );
    expect(computeOutboxBackoffMilliseconds(1, 0)).toBe(500);
    expect(computeOutboxBackoffMilliseconds(100, 1)).toBeLessThanOrEqual(
      MAX_OUTBOX_BACKOFF_MILLISECONDS,
    );
  });

  test('post-commit fast path defers without losing the retained row', async () => {
    const store = new DeterministicOutboxStore();
    const queue: DispatchBatchQueue = {
      send() {
        throw new QueuePublishError(
          'SQS_REQUEST_FAILED',
          'Synthetic queue outage.',
          true,
          'not-sent',
        );
      },
    };

    await expect(
      dispatchOutboxAfterCommit(
        IDS.outbox,
        { store, queue },
        IDS.directRequest,
      ),
    ).resolves.toEqual({
      outcome: 'deferred',
      errorCode: 'SQS_REQUEST_FAILED',
    });
    expect(store.record()).toEqual(
      expect.objectContaining({ status: 'pending', attempts: 1 }),
    );
  });
});

describe('production SQS protocol', () => {
  test('matches the regression-pinned SigV4 golden vector', () => {
    // Generated independently with @smithy/signature-v4 at authoring time and
    // pinned here so this issue does not depend on an undeclared transitive
    // package at test runtime.
    const signed = signSqsSendMessageBatchRequest(
      {
        queueUrl: 'https://sqs.us-west-2.amazonaws.com/123456789012/test-queue',
        region: 'us-west-2',
        timeoutMilliseconds: 10_000,
      },
      serializeDispatchQueueEntries([syntheticBatch()]),
      {
        accessKeyId: 'ASIAEXAMPLEKEY0000',
        secretAccessKey: 'exampleSecretAccessKey1234567890',
        sessionToken: 'exampleSessionToken1234567890',
        expiration: new Date('2030-01-01T00:00:00.000Z'),
      },
      new Date('2026-08-10T12:34:56.000Z'),
    );

    expect(signed.endpoint).toBe('https://sqs.us-west-2.amazonaws.com/');
    expect(signed.headers['x-amz-date']).toBe('20260810T123456Z');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=ASIAEXAMPLEKEY0000/20260810/us-west-2/sqs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=cd2181f5a9c9ebcb8d434fdf0cd719f3342c4bbdfe490efc76547bc2e6671806',
    );
    const body = JSON.parse(signed.body) as {
      QueueUrl: string;
      Entries: Array<{ MessageBody: string }>;
    };
    expect(body.QueueUrl).toBe(
      'https://sqs.us-west-2.amazonaws.com/123456789012/test-queue',
    );
    expect(JSON.parse(body.Entries[0]!.MessageBody)).toEqual(syntheticBatch());
  });

  test('fails closed for FIFO configuration that requires unsupported group semantics', () => {
    expect(() =>
      readSqsDispatchBatchQueueConfiguration({
        AWS_REGION: 'us-west-2',
        FANOUT_QUEUE_URL:
          'https://sqs.us-west-2.amazonaws.com/123456789012/test-queue.fifo',
      }),
    ).toThrow(
      expect.objectContaining({ code: 'OUTBOX_CONFIGURATION_INVALID' }),
    );
  });
});
