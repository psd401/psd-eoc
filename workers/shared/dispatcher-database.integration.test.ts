import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  ChannelAttemptSchema,
  NotificationOutboxMessageSchema,
  type DispatchBatch,
} from '@psd-eoc/contracts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../packages/server/db/client';
import { seedDatabase } from '../../packages/server/db/seed';
import {
  deliveryEvidence,
  events,
  notificationIntentChannels,
  notificationIntents,
  outbox,
} from '../../packages/server/db/schema';
import { migrateDatabase } from '../../packages/server/drizzle/migrate';
import {
  createDrizzleDeliveryEvidenceStore,
  type AttemptEvidenceInput,
} from '../../packages/server/app/api/internal/delivery-state/runtime';
import {
  createSqsDispatchBatchQueue,
  createDrizzleOutboxDispatcherStore,
  dispatchOutbox,
  serializeDispatchQueueEntries,
  type DispatchBatchQueue,
  type OutboxDispatcherStore,
} from '../../packages/server/lib/notify/dispatcher';
import {
  createDrizzleReconciliationStore,
  executeReconcileDeliveryAttempts,
} from '../../packages/server/lib/notify/reconcile';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../../packages/server/lib/testing/database';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const SEEDED = Object.freeze({
  facility: '00000000-0000-4000-8000-000000000001',
  otherFacility: '00000000-0000-4000-8000-000000000002',
  audience: '00000000-0000-4000-8000-000000000020',
  roster: '00000000-0000-4000-8000-000000000041',
  recipient: '00000000-0000-4000-8000-000000000050',
  pushEndpoint: '00000000-0000-4000-8000-000000000060',
  eventTypeVersion: '00000000-0000-4000-8000-000000000201',
  integrationObservedAt: '2026-08-06T12:00:00.000Z',
});

const ids = Object.freeze({
  event: randomUUID(),
  intent: randomUUID(),
  outbox: randomUUID(),
  request: randomUUID(),
  preview: randomUUID(),
  attempt: randomUUID(),
});

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
let fixtureCreatedAt: Date;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The dispatcher PostgreSQL test connection is not open.');
  }
  return connection;
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function installAtomicEventOutboxFixture(): Promise<void> {
  const database = databaseConnection().db;
  fixtureCreatedAt = new Date();
  const createdAt = fixtureCreatedAt.toISOString();
  const authorization = Object.freeze({
    kind: 'synthetic-training' as const,
    activationPreviewId: ids.preview,
    consequenceDigest: 'd'.repeat(64),
    requestId: ids.request,
  });
  const channels = Object.freeze([
    Object.freeze({
      channel: 'push' as const,
      endpointCount: 2,
      renderedMessage: Object.freeze({
        eventKind: 'test' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        classificationMarker: 'DRILL' as const,
        channel: 'push' as const,
        title: '[DRILL] Dispatcher database test',
        body: '[DRILL] Synthetic and unroutable test only.',
      }),
      integrationId: 'expo-push',
    }),
    Object.freeze({
      channel: 'email' as const,
      endpointCount: 2,
      renderedMessage: Object.freeze({
        eventKind: 'test' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        classificationMarker: 'DRILL' as const,
        channel: 'email' as const,
        subject: '[DRILL] Dispatcher database test',
        textBody: '[DRILL] Synthetic and unroutable test only.',
      }),
      integrationId: 'ses-email',
    }),
  ]);
  const message = NotificationOutboxMessageSchema.parse({
    version: 2,
    outboxId: ids.outbox,
    intentId: ids.intent,
    eventId: ids.event,
    facilityId: SEEDED.facility,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: SEEDED.eventTypeVersion,
      templateMode: 'drill',
    },
    rosterSnapshotId: SEEDED.roster,
    rosterPopulation: 'synthetic',
    requestId: ids.request,
    authorization,
    channels,
    createdAt,
  });

  await database.transaction(async (transaction) => {
    await transaction.insert(events).values({
      id: ids.event,
      facilityId: SEEDED.facility,
      kind: 'test',
      templateMode: 'drill',
      eventTypeVersionId: SEEDED.eventTypeVersion,
      status: 'active',
      rosterSnapshotId: SEEDED.roster,
      rosterPopulation: 'synthetic',
      createdBy: { kind: 'system', serviceId: 'dispatcher-database-test' },
      createdAt: fixtureCreatedAt,
      activatedAt: fixtureCreatedAt,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: authorization,
    });
    await transaction.insert(notificationIntents).values({
      id: ids.intent,
      eventId: ids.event,
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.eventTypeVersion,
      rosterSnapshotId: SEEDED.roster,
      rosterPopulation: 'synthetic',
      createdBy: { kind: 'system', serviceId: 'dispatcher-database-test' },
      source: 'scheduled-job',
      requestId: ids.request,
      authorization,
      createdAt: fixtureCreatedAt,
    });
    await transaction.insert(notificationIntentChannels).values([
      {
        intentId: ids.intent,
        sequence: 1,
        channel: 'push',
        eventKind: 'test' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        rosterPopulation: 'synthetic' as const,
        classificationMarker: 'DRILL' as const,
        endpointCount: channels[0]!.endpointCount,
        renderedMessage: channels[0]!.renderedMessage,
        integrationId: 'expo-push',
      },
      {
        intentId: ids.intent,
        sequence: 2,
        channel: 'email',
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'synthetic',
        classificationMarker: 'DRILL',
        endpointCount: channels[1]!.endpointCount,
        renderedMessage: channels[1]!.renderedMessage,
        integrationId: 'ses-email',
      },
    ]);
    await transaction.insert(outbox).values({
      id: ids.outbox,
      messageVersion: 2,
      intentId: ids.intent,
      eventId: ids.event,
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.eventTypeVersion,
      rosterSnapshotId: SEEDED.roster,
      rosterPopulation: 'synthetic',
      requestId: ids.request,
      authorization,
      channels,
      message,
      status: 'pending',
      attempts: 0,
      availableAt: fixtureCreatedAt,
      lockedUntil: null,
      publishedAt: null,
      failedAt: null,
      lastErrorCode: null,
      createdAt: fixtureCreatedAt,
    });
  });
}

function renderedMessageFor(
  channel: 'push' | 'email' | 'sms',
): Readonly<Record<string, unknown>> {
  const common = {
    eventKind: 'test' as const,
    templateMode: 'drill' as const,
    purpose: 'activation' as const,
    classificationMarker: 'DRILL' as const,
    channel,
  };
  switch (channel) {
    case 'push':
      return {
        ...common,
        title: '[DRILL] Synthetic enqueue latency test',
        body: '[DRILL] Synthetic and unroutable test only.',
      };
    case 'email':
      return {
        ...common,
        subject: '[DRILL] Synthetic enqueue latency test',
        textBody: '[DRILL] Synthetic and unroutable test only.',
      };
    case 'sms':
      return {
        ...common,
        body: '[DRILL] Synthetic and unroutable test only.',
      };
  }
}

async function installSyntheticSloOutboxFixture(
  messageVersion: 1 | 2 = 2,
  messageFacilityId: string = SEEDED.facility,
): Promise<string> {
  const database = databaseConnection().db;
  const eventId = randomUUID();
  const intentId = randomUUID();
  const outboxId = randomUUID();
  const requestId = randomUUID();
  // A minute in the past. `availableAt` equals this, and the claim compares it
  // against the database's `clock_timestamp()` rather than this process's
  // clock — a fixture that means "ready to dispatch now" must not sit on the
  // boundary between two machines' clocks. `outbox_operational_times` also
  // requires `available_at >= created_at`, so both move together.
  const createdAt = new Date(Date.now() - 60_000);
  const authorization = Object.freeze({
    kind: 'synthetic-training' as const,
    activationPreviewId: randomUUID(),
    consequenceDigest: 'e'.repeat(64),
    requestId,
  });
  const channels = (['push', 'email', 'sms'] as const).map((channel) => ({
    channel,
    endpointCount: 1_200,
    renderedMessage: renderedMessageFor(channel),
    integrationId:
      channel === 'push'
        ? 'expo-push'
        : channel === 'email'
          ? 'ses-email'
          : 'aws-eum-sms',
  }));
  const message = NotificationOutboxMessageSchema.parse({
    version: messageVersion,
    outboxId,
    intentId,
    eventId,
    ...(messageVersion === 2 ? { facilityId: messageFacilityId } : {}),
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: SEEDED.eventTypeVersion,
      templateMode: 'drill',
    },
    rosterSnapshotId: SEEDED.roster,
    rosterPopulation: 'synthetic',
    requestId,
    authorization,
    channels,
    createdAt: createdAt.toISOString(),
  });

  await database.transaction(async (transaction) => {
    await transaction.insert(events).values({
      id: eventId,
      facilityId: SEEDED.facility,
      kind: 'test',
      templateMode: 'drill',
      eventTypeVersionId: SEEDED.eventTypeVersion,
      status: 'active',
      rosterSnapshotId: SEEDED.roster,
      rosterPopulation: 'synthetic',
      createdBy: { kind: 'system', serviceId: 'dispatcher-slo-test' },
      createdAt,
      activatedAt: createdAt,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: authorization,
    });
    await transaction.insert(notificationIntents).values({
      id: intentId,
      eventId,
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.eventTypeVersion,
      rosterSnapshotId: SEEDED.roster,
      rosterPopulation: 'synthetic',
      createdBy: { kind: 'system', serviceId: 'dispatcher-slo-test' },
      source: 'scheduled-job',
      requestId,
      authorization,
      createdAt,
    });
    await transaction.insert(notificationIntentChannels).values(
      message.channels.map((plan, index) => ({
        intentId,
        sequence: index + 1,
        channel: plan.channel,
        eventKind: 'test' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        rosterPopulation: 'synthetic' as const,
        classificationMarker: 'DRILL' as const,
        endpointCount: plan.endpointCount,
        renderedMessage: plan.renderedMessage,
        integrationId: plan.integrationId,
      })),
    );
    await transaction.insert(outbox).values({
      id: outboxId,
      messageVersion,
      intentId,
      eventId,
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.eventTypeVersion,
      rosterSnapshotId: SEEDED.roster,
      rosterPopulation: 'synthetic',
      requestId,
      authorization,
      channels: message.channels,
      message,
      status: 'pending',
      attempts: 0,
      availableAt: createdAt,
      lockedUntil: null,
      publishedAt: null,
      failedAt: null,
      lastErrorCode: null,
      createdAt,
    });
  });
  return outboxId;
}

class RecordingQueue implements DispatchBatchQueue {
  public readonly calls: DispatchBatch[][] = [];

  public send(batches: readonly DispatchBatch[]) {
    this.calls.push([...batches]);
    return Promise.resolve(
      serializeDispatchQueueEntries(batches).map((entry, index) => ({
        entryId: entry.id,
        messageId: `synthetic-sqs-message-${index + 1}`,
      })),
    );
  }
}

describeWithDatabase('PostgreSQL outbox crash and reconciliation proof', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for this integration test.',
      );
    }
    // Keep all issue-11 fixtures in a disposable database. This test must not
    // race the seed test's zero-event invariant, and append-only production
    // tables must never be weakened for cleanup.
    const owned = await createDisposableDatabase(
      'psd_eoc_issue11',
      testDatabaseUrl,
    );
    ownedDatabase = owned;

    const createdIsolatedConnection = createDatabaseClient({
      driver: 'postgres',
      url: owned.url,
      maxConnections: 4,
    });
    if (createdIsolatedConnection.driver !== 'postgres') {
      throw new Error('The isolated integration test requires PostgreSQL.');
    }
    connection = createdIsolatedConnection;
    try {
      await migrateDatabase(createdIsolatedConnection);
      await seedDatabase(createdIsolatedConnection.db);
      await installAtomicEventOutboxFixture();
    } catch (error) {
      await closeAndDropDisposableDatabase(
        () => createdIsolatedConnection.close(),
        ownedDatabase,
      );
      connection = undefined;
      ownedDatabase = undefined;
      throw error;
    }
  });

  afterAll(async () => {
    const opened = connection;
    const owned = ownedDatabase;
    connection = undefined;
    ownedDatabase = undefined;
    await closeAndDropDisposableDatabase(
      opened === undefined ? undefined : () => opened.close(),
      owned,
    );
  });

  test('commits the event and outbox atomically and skips a locked row', async () => {
    const database = databaseConnection().db;
    const [eventRow] = await database
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, ids.event));
    const [outboxRow] = await database
      .select({
        id: outbox.id,
        messageVersion: outbox.messageVersion,
        message: outbox.message,
      })
      .from(outbox)
      .where(eq(outbox.id, ids.outbox));
    expect([eventRow?.id, outboxRow?.id]).toEqual([ids.event, ids.outbox]);
    expect(outboxRow?.messageVersion).toBe(2);
    expect(NotificationOutboxMessageSchema.parse(outboxRow?.message)).toEqual(
      expect.objectContaining({
        version: 2,
        facilityId: SEEDED.facility,
      }),
    );

    const locked = deferred();
    const release = deferred();
    const holdingTransaction = database.transaction(async (transaction) => {
      await transaction
        .select({ id: outbox.id })
        .from(outbox)
        .where(eq(outbox.id, ids.outbox))
        .for('update');
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const store = createDrizzleOutboxDispatcherStore(database, {
      leaseMilliseconds: 20,
    });
    await expect(store.claimOutbox(ids.outbox)).resolves.toEqual({
      kind: 'busy',
    });
    release.resolve();
    await holdingTransaction;
  });

  test('dispatches a retained strict v1 message without rewriting it', async () => {
    const database = databaseConnection().db;
    const outboxId = await installSyntheticSloOutboxFixture(1);
    const [before] = await database
      .select({ message: outbox.message })
      .from(outbox)
      .where(eq(outbox.id, outboxId));
    const retained = NotificationOutboxMessageSchema.parse(before?.message);
    expect(retained.version).toBe(1);
    expect(Object.hasOwn(retained, 'facilityId')).toBe(false);

    const queue = new RecordingQueue();
    const result = await dispatchOutbox(outboxId, {
      store: createDrizzleOutboxDispatcherStore(database),
      queue,
    });

    expect(result.facilityId).toBe(SEEDED.facility);
    expect(result.outboxRecord.message).toEqual(retained);
    expect(
      result.batches.every((batch) => batch.facilityId === SEEDED.facility),
    ).toBe(true);
    expect(queue.calls).toHaveLength(1);
    const [after] = await database
      .select({ message: outbox.message })
      .from(outbox)
      .where(eq(outbox.id, outboxId));
    expect(after?.message).toEqual(before?.message);
  });

  test('rejects a v2 facility that disagrees with immutable event truth', async () => {
    const database = databaseConnection().db;
    const outboxId = await installSyntheticSloOutboxFixture(
      2,
      SEEDED.otherFacility,
    );
    const queue = new RecordingQueue();

    await expect(
      dispatchOutbox(outboxId, {
        store: createDrizzleOutboxDispatcherStore(database),
        queue,
      }),
    ).rejects.toMatchObject({
      code: 'OUTBOX_PERSISTENCE_FAILED',
      retryable: false,
    });
    expect(queue.calls).toHaveLength(0);
  });

  test('replays stable batches after a post-SQS crash without losing work', async () => {
    const database = databaseConnection().db;
    const durableStore = createDrizzleOutboxDispatcherStore(database, {
      leaseMilliseconds: 20,
    });
    const queue = new RecordingQueue();
    let crashBeforeFinalization = true;
    const crashingStore: OutboxDispatcherStore = {
      listReadyOutboxIds: (limit) => durableStore.listReadyOutboxIds(limit),
      claimOutbox: (outboxId) => durableStore.claimOutbox(outboxId),
      recordFailure: (claim, code, retryable) =>
        durableStore.recordFailure(claim, code, retryable),
      markPublished(claim) {
        if (crashBeforeFinalization) {
          crashBeforeFinalization = false;
          throw new Error('Synthetic process crash after SQS acceptance.');
        }
        return durableStore.markPublished(claim);
      },
    };

    await expect(
      dispatchOutbox(ids.outbox, {
        store: crashingStore,
        queue,
      }),
    ).rejects.toThrow('Synthetic process crash after SQS acceptance.');
    expect(queue.calls).toHaveLength(1);

    await Bun.sleep(40);
    const replayed = await dispatchOutbox(ids.outbox, {
      store: durableStore,
      queue,
    });
    expect(replayed.outboxRecord).toEqual(
      expect.objectContaining({ status: 'published', attempts: 1 }),
    );
    expect(queue.calls).toHaveLength(2);
    expect(queue.calls[1]).toEqual(queue.calls[0]);
    expect(queue.calls[0]?.map((batch) => batch.templateMode)).toEqual([
      'drill',
      'drill',
    ]);
  });

  test('keeps synthetic 1,200-recipient x 3-channel outbox-to-SQS p95 below two seconds', async () => {
    const sampleCount = 40;
    const outboxIds: string[] = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      outboxIds.push(await installSyntheticSloOutboxFixture());
    }

    let sqsRequests = 0;
    const syntheticSqsFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      expect(String(input)).toBe('https://sqs.us-west-2.amazonaws.com/');
      expect(new Headers(init?.headers).get('x-amz-target')).toBe(
        'AmazonSQS.SendMessageBatch',
      );
      const body = JSON.parse(String(init?.body)) as {
        QueueUrl: string;
        Entries: Array<{ Id: string; MessageBody: string }>;
      };
      expect(body.QueueUrl).toBe(
        'https://sqs.us-west-2.amazonaws.com/123456789012/synthetic-delivery',
      );
      expect(body.Entries).toHaveLength(3);
      for (const entry of body.Entries) {
        const batch = JSON.parse(entry.MessageBody) as {
          endpointCount: number;
        };
        expect(batch.endpointCount).toBe(1_200);
      }
      sqsRequests += 1;
      return Response.json({
        Successful: body.Entries.map((entry, index) => ({
          Id: entry.Id,
          MessageId: `synthetic-sqs-${sqsRequests}-${index + 1}`,
        })),
        Failed: [],
      });
    }) as typeof fetch;
    const queue = createSqsDispatchBatchQueue(
      {
        queueUrl:
          'https://sqs.us-west-2.amazonaws.com/123456789012/synthetic-delivery',
        region: 'us-west-2',
        timeoutMilliseconds: 10_000,
      },
      {
        fetch: syntheticSqsFetch,
        now: () => new Date('2026-08-10T12:34:56.000Z'),
        credentialProvider: {
          getCredentials: () =>
            Promise.resolve({
              accessKeyId: 'ASIAEXAMPLEKEY0000',
              secretAccessKey: 'exampleSecretAccessKey1234567890',
              sessionToken: 'exampleSessionToken1234567890',
              expiration: new Date('2030-01-01T00:00:00.000Z'),
            }),
          invalidate() {},
        },
      },
    );
    const store = createDrizzleOutboxDispatcherStore(databaseConnection().db);
    const samples: number[] = [];
    for (const outboxId of outboxIds) {
      const startedAt = performance.now();
      const result = await dispatchOutbox(outboxId, {
        store,
        queue,
      });
      samples.push(performance.now() - startedAt);
      expect(result.batches).toHaveLength(3);
      expect(
        result.batches.every((batch) => batch.endpointCount === 1_200),
      ).toBe(true);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const p95Milliseconds = sorted[Math.ceil(sampleCount * 0.95) - 1];

    expect(sqsRequests).toBe(sampleCount);
    expect(p95Milliseconds).toBeNumber();
    expect(p95Milliseconds!).toBeLessThan(2_000);
    console.info(
      `[issue-11 synthetic SLO] samples=${sampleCount} recipients=1200 channels=3 p95_ms=${p95Milliseconds!.toFixed(2)}`,
    );
  });

  test('persists an attempt idempotently and exposes stale truth as unknown', async () => {
    const database = databaseConnection().db;
    const batch = new RecordingQueue();
    const durableStore = createDrizzleOutboxDispatcherStore(database);
    const published = await dispatchOutbox(ids.outbox, {
      store: durableStore,
      queue: batch,
    });
    const pushBatch = published.batches.find(
      (candidate) => candidate.channel === 'push',
    );
    if (pushBatch === undefined) {
      throw new Error('The persisted dispatch result is missing push.');
    }
    const attemptedAtInstant = new Date();
    const attemptedAtWithOffset = `${new Date(
      attemptedAtInstant.getTime() - 7 * 60 * 60_000,
    )
      .toISOString()
      .slice(0, -1)}-07:00`;
    const attempt = ChannelAttemptSchema.parse({
      id: ids.attempt,
      batchId: pushBatch.id,
      intentId: pushBatch.intentId,
      eventId: pushBatch.eventId,
      eventKind: pushBatch.eventKind,
      templateMode: pushBatch.templateMode,
      purpose: pushBatch.purpose,
      eventTypeVersion: pushBatch.eventTypeVersion,
      rosterSnapshotId: pushBatch.rosterSnapshotId,
      rosterPopulation: pushBatch.rosterPopulation,
      recipientId: SEEDED.recipient,
      endpointId: SEEDED.pushEndpoint,
      channel: pushBatch.channel,
      attemptNumber: 1,
      attemptedAt: attemptedAtWithOffset,
    });
    const attempted: AttemptEvidenceInput = {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'attempted',
      provider: null,
      providerReference: null,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    };
    const evidenceStore = createDrizzleDeliveryEvidenceStore(database);
    const duplicateWrites = await Promise.all([
      evidenceStore.recordAttemptEvidence({ attempt, evidence: attempted }),
      evidenceStore.recordAttemptEvidence({ attempt, evidence: attempted }),
    ]);
    expect(duplicateWrites[1]).toEqual(duplicateWrites[0]);

    await Bun.sleep(1_100);
    const result = await executeReconcileDeliveryAttempts(
      { intentId: ids.intent, limit: 10 },
      {
        store: createDrizzleReconciliationStore(database, {
          staleAfterMilliseconds: 1_000,
        }),
        requestId: randomUUID(),
        idempotencyKey: `reconcile:${ids.intent}`,
      },
    );
    expect(result).toEqual({
      examinedAttemptCount: 1,
      appendedEvidence: [
        expect.objectContaining({
          subject: { kind: 'attempt', attemptId: ids.attempt },
          state: 'unknown',
          reasonCode: 'RECONCILIATION_DEADLINE_EXCEEDED',
        }),
      ],
    });
    const [reconciledUnknown] = result.appendedEvidence;
    if (reconciledUnknown === undefined) {
      throw new Error('Reconciliation did not append unknown evidence.');
    }

    const persisted = await database
      .select({ state: deliveryEvidence.state })
      .from(deliveryEvidence)
      .where(eq(deliveryEvidence.attemptId, ids.attempt))
      .orderBy(deliveryEvidence.sequence);
    expect(persisted.map((entry) => entry.state)).toEqual([
      'attempted',
      'unknown',
    ]);

    const reconciliationUnknown: AttemptEvidenceInput = {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'unknown',
      provider: null,
      providerReference: null,
      proof: null,
      reasonCode: 'RECONCILIATION_DEADLINE_EXCEEDED',
      diagnosticDigest: null,
    };

    const providerAccepted: AttemptEvidenceInput = {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'provider-accepted',
      provider: 'synthetic-provider',
      providerReference: 'synthetic-acceptance-reference',
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    };
    await evidenceStore.recordAttemptEvidence({
      attempt,
      evidence: providerAccepted,
    });
    const replayedUnknown = await evidenceStore.recordAttemptEvidence({
      attempt,
      evidence: reconciliationUnknown,
    });
    expect(replayedUnknown).toMatchObject({
      state: 'provider-accepted',
      provider: 'synthetic-provider',
      providerReference: 'synthetic-acceptance-reference',
    });

    const statesAfterUnknownReplay = await database
      .select({ state: deliveryEvidence.state })
      .from(deliveryEvidence)
      .where(eq(deliveryEvidence.attemptId, ids.attempt))
      .orderBy(deliveryEvidence.sequence);
    expect(statesAfterUnknownReplay.map((entry) => entry.state)).toEqual([
      'attempted',
      'unknown',
      'provider-accepted',
    ]);

    const delivered: AttemptEvidenceInput = {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'delivered',
      provider: 'synthetic-provider',
      // Acceptance and delivery callbacks for one provider operation carry
      // the same provider message reference. A terminal fact may only
      // subsume a late acceptance replay when that lineage still matches.
      providerReference: 'synthetic-acceptance-reference',
      proof: {
        kind: 'provider-delivery-receipt',
        provider: 'synthetic-provider',
        receiptId: 'synthetic-delivery-receipt',
        deliveredAt: new Date(Date.now() - 1_000).toISOString(),
      },
      reasonCode: null,
      diagnosticDigest: null,
    };
    await evidenceStore.recordAttemptEvidence({ attempt, evidence: delivered });
    const replayedAcceptance = await evidenceStore.recordAttemptEvidence({
      attempt,
      evidence: providerAccepted,
    });
    expect(replayedAcceptance.state).toBe('delivered');

    const statesAfterHistoricalReplay = await database
      .select({ state: deliveryEvidence.state })
      .from(deliveryEvidence)
      .where(eq(deliveryEvidence.attemptId, ids.attempt))
      .orderBy(deliveryEvidence.sequence);
    expect(statesAfterHistoricalReplay.map((entry) => entry.state)).toEqual([
      'attempted',
      'unknown',
      'provider-accepted',
      'delivered',
    ]);

    const outOfOrderAttempt = ChannelAttemptSchema.parse({
      ...attempt,
      id: randomUUID(),
      attemptNumber: 2,
      attemptedAt: new Date(
        Date.parse(attempt.attemptedAt) + 10_000,
      ).toISOString(),
    });
    const outOfOrderAttempted: AttemptEvidenceInput = {
      ...attempted,
      subject: { kind: 'attempt', attemptId: outOfOrderAttempt.id },
    };
    const outOfOrderDelivered: AttemptEvidenceInput = {
      ...delivered,
      subject: { kind: 'attempt', attemptId: outOfOrderAttempt.id },
    };
    const lateAcceptance: AttemptEvidenceInput = {
      ...providerAccepted,
      subject: { kind: 'attempt', attemptId: outOfOrderAttempt.id },
    };
    await evidenceStore.recordAttemptEvidence({
      attempt: outOfOrderAttempt,
      evidence: outOfOrderAttempted,
    });
    const retainedDelivered = await evidenceStore.recordAttemptEvidence({
      attempt: outOfOrderAttempt,
      evidence: outOfOrderDelivered,
    });
    await expect(
      evidenceStore.recordAttemptEvidence({
        attempt: outOfOrderAttempt,
        evidence: lateAcceptance,
      }),
    ).resolves.toEqual(retainedDelivered);

    const outOfOrderStates = await database
      .select({ state: deliveryEvidence.state })
      .from(deliveryEvidence)
      .where(eq(deliveryEvidence.attemptId, outOfOrderAttempt.id))
      .orderBy(deliveryEvidence.sequence);
    expect(outOfOrderStates.map((entry) => entry.state)).toEqual([
      'attempted',
      'delivered',
    ]);
  });
});
