import { describe, expect, test } from 'bun:test';

import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
} from '@psd-eoc/contracts';

import { channelAttempts, deliveryEvidence } from '../../../../db/schema';
import {
  DeliveryStateError,
  createDeliveryStateAuthorizer,
  createDeliveryStateRouteHandler,
  createDrizzleDeliveryEvidenceStore,
  createRecordDeliveryEvidenceHandler,
  type AttemptEvidenceInput,
  type DeliveryStateRouteRuntime,
  type DeliveryStateWriteRequest,
} from './runtime';

const IDS = Object.freeze({
  attempt: '10000000-0000-4000-8000-000000000001',
  batch: '10000000-0000-4000-8000-000000000002',
  endpoint: '10000000-0000-4000-8000-000000000003',
  event: '10000000-0000-4000-8000-000000000004',
  eventTypeVersion: '10000000-0000-4000-8000-000000000005',
  evidence: '10000000-0000-4000-8000-000000000006',
  intent: '10000000-0000-4000-8000-000000000007',
  priorEvidence: '10000000-0000-4000-8000-000000000011',
  recipient: '10000000-0000-4000-8000-000000000008',
  roster: '10000000-0000-4000-8000-000000000009',
  targetSet: '10000000-0000-4000-8000-000000000010',
});

const WORKER_TOKEN = 'synthetic-delivery-worker-token-000000000001';
const COMMITTED_AT = '2026-08-13T16:00:03.000Z';

interface FakeDatabaseOptions {
  readonly existingAttempt?: typeof channelAttempts.$inferSelect;
  readonly firstEvidence?: typeof deliveryEvidence.$inferSelect;
}

function attemptWith(): ChannelAttempt {
  const base = {
    id: IDS.attempt,
    batchId: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    eventKind: 'drill' as const,
    templateMode: 'drill' as const,
    purpose: 'activation' as const,
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: 'drill' as const,
    },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'staff' as const,
    recipientId: IDS.recipient,
    endpointId: IDS.endpoint,
    channel: 'push' as const,
    attemptNumber: 1,
    attemptedAt: '2026-08-13T16:00:00.000Z',
  };
  return ChannelAttemptSchema.parse(base);
}

function attemptRow(
  attempt: ChannelAttempt,
): typeof channelAttempts.$inferSelect {
  return {
    id: attempt.id,
    batchId: attempt.batchId,
    intentId: attempt.intentId,
    eventId: attempt.eventId,
    eventKind: attempt.eventKind,
    templateMode: attempt.templateMode,
    purpose: attempt.purpose,
    eventTypeVersionId: attempt.eventTypeVersion.id,
    rosterSnapshotId: attempt.rosterSnapshotId,
    rosterPopulation: attempt.rosterPopulation,
    recipientId: attempt.recipientId,
    endpointId: attempt.endpointId,
    channel: attempt.channel,
    attemptNumber: attempt.attemptNumber,
    attemptedAt: new Date(attempt.attemptedAt),
  };
}

function providerAcceptedEvidence(
  attempt: ChannelAttempt,
): AttemptEvidenceInput {
  return {
    subject: { kind: 'attempt', attemptId: attempt.id },
    state: 'provider-accepted',
    provider: 'synthetic-test-provider',
    providerReference: 'synthetic-acceptance-reference',
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  };
}

function unknownEvidence(attempt: ChannelAttempt): AttemptEvidenceInput {
  return {
    subject: { kind: 'attempt', attemptId: attempt.id },
    state: 'unknown',
    provider: 'synthetic-test-provider',
    providerReference: null,
    proof: null,
    reasonCode: 'PROVIDER_RESULT_AMBIGUOUS',
    diagnosticDigest: 'a'.repeat(64),
  };
}

function committedEvidence(input: AttemptEvidenceInput): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: IDS.evidence,
    subject: input.subject,
    sequence: 2,
    previousEvidenceId: IDS.priorEvidence,
    state: input.state,
    recordedAt: COMMITTED_AT,
    provider: input.provider,
    providerReference: input.providerReference,
    proof: input.proof,
    reasonCode: input.reasonCode,
    diagnosticDigest: input.diagnosticDigest,
  });
}

function routeRequest(request: DeliveryStateWriteRequest): Request {
  return new Request('https://eoc.test/api/internal/delivery-state', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${WORKER_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
}

function fakeRouteRuntime(input: {
  readonly record: (
    request: DeliveryStateWriteRequest,
  ) => Promise<DeliveryEvidence>;
  readonly close?: () => Promise<void>;
}): DeliveryStateRouteRuntime {
  return Object.freeze({
    handler: createRecordDeliveryEvidenceHandler({
      recordAttemptEvidence: input.record,
    }),
    authorizer: createDeliveryStateAuthorizer(),
    close: input.close ?? (async () => undefined),
  });
}

function evidenceRow(
  attempt: ChannelAttempt,
): typeof deliveryEvidence.$inferSelect {
  return {
    id: IDS.evidence,
    subjectKind: 'attempt',
    subjectId: attempt.id,
    intentId: null,
    attemptId: attempt.id,
    sequence: 1,
    previousEvidenceId: null,
    state: 'attempted',
    recordedAt: new Date('2026-08-13T16:00:01.000Z'),
    provider: null,
    providerReference: null,
    providerOccurredAt: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  };
}

function deliveredEvidenceRow(
  attempt: ChannelAttempt,
  overrides: Readonly<{
    provider?: string;
    providerReference?: string;
  }> = {},
): typeof deliveryEvidence.$inferSelect {
  const provider = overrides.provider ?? 'synthetic-test-provider';
  return {
    ...evidenceRow(attempt),
    sequence: 3,
    previousEvidenceId: IDS.priorEvidence,
    state: 'delivered',
    recordedAt: new Date(COMMITTED_AT),
    provider,
    providerReference:
      overrides.providerReference ?? 'synthetic-acceptance-reference',
    proof: {
      kind: 'provider-delivery-receipt',
      provider,
      receiptId: 'synthetic-delivery-receipt',
      deliveredAt: COMMITTED_AT,
    },
  };
}

function providerAcceptedEvidenceRow(
  attempt: ChannelAttempt,
  provider = 'synthetic-test-provider',
): typeof deliveryEvidence.$inferSelect {
  return {
    ...evidenceRow(attempt),
    sequence: 2,
    previousEvidenceId: IDS.priorEvidence,
    state: 'provider-accepted',
    recordedAt: new Date(COMMITTED_AT),
    provider,
    providerReference: 'synthetic-acceptance-reference',
  };
}

function fakeDatabase(options: FakeDatabaseOptions) {
  const selectedTables: unknown[] = [];
  const insertedTables: unknown[] = [];
  let executeCount = 0;

  function rowsFor(table: unknown): readonly unknown[] {
    if (table === channelAttempts) {
      return options.existingAttempt === undefined
        ? []
        : [options.existingAttempt];
    }
    if (table === deliveryEvidence) {
      return options.firstEvidence === undefined ? [] : [options.firstEvidence];
    }
    throw new Error('Unexpected table read by delivery-state store.');
  }

  const query = {
    execute: async () => {
      executeCount += 1;
      return executeCount > 2
        ? [{ value: new Date('2026-08-13T16:00:01.000Z') }]
        : [];
    },
    select: () => ({
      from: (table: unknown) => {
        selectedTables.push(table);
        const rows = rowsFor(table);
        const orderedRows = Object.assign(Promise.resolve(rows), {
          limit: async () => rows,
        });
        return {
          where: () => ({
            limit: async () => rows,
            orderBy: () => orderedRows,
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: async () => {
        insertedTables.push(table);
      },
    }),
  };
  const database = {
    transaction: async (
      operation: (transaction: typeof query) => Promise<unknown>,
    ) => operation(query),
  } as unknown as Parameters<typeof createDrizzleDeliveryEvidenceStore>[0];

  return {
    database,
    insertedTables,
    selectedTables,
  };
}

async function deliveryStateError(
  promise: Promise<unknown>,
): Promise<DeliveryStateError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeliveryStateError) return error;
    throw error;
  }
  throw new Error('Expected delivery-state write to fail closed.');
}

describe('delivery-state terminal evidence subsumption', () => {
  test('preserves stronger matching-provider truth for late weaker writes', async () => {
    const attempt = attemptWith();
    const existingAttempt = attemptRow(attempt);
    const terminal = deliveredEvidenceRow(attempt);

    for (const evidence of [
      providerAcceptedEvidence(attempt),
      unknownEvidence(attempt),
    ]) {
      const fixture = fakeDatabase({
        existingAttempt,
        firstEvidence: terminal,
      });
      const store = createDrizzleDeliveryEvidenceStore(fixture.database);

      await expect(
        store.recordAttemptEvidence({ attempt, evidence }),
      ).resolves.toMatchObject({
        id: terminal.id,
        state: 'delivered',
        providerReference: terminal.providerReference,
      });
      expect(fixture.insertedTables).toHaveLength(0);
    }

    const accepted = providerAcceptedEvidenceRow(attempt);
    const acceptedFixture = fakeDatabase({
      existingAttempt,
      firstEvidence: accepted,
    });
    const acceptedStore = createDrizzleDeliveryEvidenceStore(
      acceptedFixture.database,
    );

    await expect(
      acceptedStore.recordAttemptEvidence({
        attempt,
        evidence: unknownEvidence(attempt),
      }),
    ).resolves.toMatchObject({
      id: accepted.id,
      state: 'provider-accepted',
      providerReference: accepted.providerReference,
    });
    expect(acceptedFixture.insertedTables).toHaveLength(0);
  });

  test('rejects stronger evidence from a different provider lineage', async () => {
    const attempt = attemptWith();
    const existingAttempt = attemptRow(attempt);

    for (const mismatchedTerminal of [
      deliveredEvidenceRow(attempt, {
        providerReference: 'different-provider-reference',
      }),
      deliveredEvidenceRow(attempt, { provider: 'different-provider' }),
    ]) {
      const mismatchFixture = fakeDatabase({
        existingAttempt,
        firstEvidence: mismatchedTerminal,
      });
      const mismatchStore = createDrizzleDeliveryEvidenceStore(
        mismatchFixture.database,
      );
      const error = await deliveryStateError(
        mismatchStore.recordAttemptEvidence({
          attempt,
          evidence: providerAcceptedEvidence(attempt),
        }),
      );

      expect(error).toMatchObject({
        code: 'INVALID_DELIVERY_TRANSITION',
        status: 409,
      });
      expect(mismatchFixture.insertedTables).toHaveLength(0);
    }

    const mismatchedUnknownFixture = fakeDatabase({
      existingAttempt,
      firstEvidence: deliveredEvidenceRow(attempt, {
        provider: 'different-provider',
      }),
    });
    const mismatchedUnknownStore = createDrizzleDeliveryEvidenceStore(
      mismatchedUnknownFixture.database,
    );
    const error = await deliveryStateError(
      mismatchedUnknownStore.recordAttemptEvidence({
        attempt,
        evidence: unknownEvidence(attempt),
      }),
    );

    expect(error).toMatchObject({
      code: 'INVALID_DELIVERY_TRANSITION',
      status: 409,
    });
    expect(mismatchedUnknownFixture.insertedTables).toHaveLength(0);

    const mismatchedAcceptedFixture = fakeDatabase({
      existingAttempt,
      firstEvidence: providerAcceptedEvidenceRow(attempt, 'different-provider'),
    });
    const mismatchedAcceptedStore = createDrizzleDeliveryEvidenceStore(
      mismatchedAcceptedFixture.database,
    );
    const acceptedError = await deliveryStateError(
      mismatchedAcceptedStore.recordAttemptEvidence({
        attempt,
        evidence: unknownEvidence(attempt),
      }),
    );

    expect(acceptedError).toMatchObject({
      code: 'INVALID_DELIVERY_TRANSITION',
      status: 409,
    });
    expect(mismatchedAcceptedFixture.insertedTables).toHaveLength(0);
  });
});

describe('delivery-state route', () => {
  test('does not open persistence before worker authentication', async () => {
    let runtimeCreateCount = 0;
    const handler = createDeliveryStateRouteHandler({
      readExpectedBearerToken: () => WORKER_TOKEN,
      createRuntime: async () => {
        runtimeCreateCount += 1;
        throw new Error('The unauthenticated request opened persistence.');
      },
    });
    const attempt = attemptWith();
    const evidence = providerAcceptedEvidence(attempt);
    const unauthenticated = routeRequest({ attempt, evidence });
    unauthenticated.headers.delete('authorization');

    const response = await handler(unauthenticated);

    expect(response.status).toBe(401);
    expect(runtimeCreateCount).toBe(0);
  });

  test('records evidence and closes the runtime on every request', async () => {
    const attempt = attemptWith();
    const evidence = providerAcceptedEvidence(attempt);
    const committed = committedEvidence(evidence);
    const committedIds: string[] = [];
    let closeCount = 0;
    const runtime = fakeRouteRuntime({
      async record() {
        committedIds.push(committed.id);
        return committed;
      },
      async close() {
        closeCount += 1;
      },
    });
    const handler = createDeliveryStateRouteHandler({
      readExpectedBearerToken: () => WORKER_TOKEN,
      createRuntime: async () => runtime,
    });

    const first = await handler(routeRequest({ attempt, evidence }));
    const retry = await handler(routeRequest({ attempt, evidence }));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ result: committed });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ result: committed });
    expect(committedIds).toEqual([IDS.evidence, IDS.evidence]);
    expect(closeCount).toBe(2);
  });
});
