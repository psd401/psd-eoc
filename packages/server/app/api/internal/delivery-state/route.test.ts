import { describe, expect, test } from 'bun:test';

import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
  type DeliveryTestNotificationMetadata,
} from '@psd-eoc/contracts';

import {
  channelAttempts,
  deliveryEvidence,
  notificationIntents,
} from '../../../../db/schema';
import {
  DELIVERY_STATE_WORKER_SERVICE_ID,
  DeliveryStateError,
  createDeliveryStateAuthorizer,
  createDeliveryStateRouteHandler,
  createDrizzleDeliveryEvidenceStore,
  createRecordDeliveryEvidenceHandler,
  type AttemptEvidenceInput,
  type DeliveryStateRouteRuntime,
  type DeliveryStateWriteRequest,
} from './route';
import type { TrustedCapabilityInvocation } from '../../../../lib/capabilities/engine';

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

const DELIVERY_TEST: DeliveryTestNotificationMetadata = Object.freeze({
  purpose: 'monthly-live-delivery-test',
  targetSet: Object.freeze({ id: IDS.targetSet, version: 3 }),
  endpointReferenceDigest: 'a'.repeat(64),
});

type IntentDeliveryTestRow = Pick<
  typeof notificationIntents.$inferSelect,
  | 'id'
  | 'deliveryTestTargetSetId'
  | 'deliveryTestTargetSetVersion'
  | 'deliveryTestEndpointReferenceDigest'
>;

interface FakeDatabaseOptions {
  readonly intent: IntentDeliveryTestRow | null;
  readonly existingAttempt?: typeof channelAttempts.$inferSelect;
  readonly firstEvidence?: typeof deliveryEvidence.$inferSelect;
}

function attemptWith(
  deliveryTest: DeliveryTestNotificationMetadata | null | undefined,
): ChannelAttempt {
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
  return ChannelAttemptSchema.parse(
    deliveryTest === undefined ? base : { ...base, deliveryTest },
  );
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

function attemptedEvidence(attempt: ChannelAttempt): AttemptEvidenceInput {
  return {
    subject: { kind: 'attempt', attemptId: attempt.id },
    state: 'attempted',
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
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
  readonly finalize: (
    intentId: string,
    invocation: TrustedCapabilityInvocation,
  ) => Promise<unknown | null>;
  readonly close?: () => Promise<void>;
}): DeliveryStateRouteRuntime {
  return Object.freeze({
    handler: createRecordDeliveryEvidenceHandler({
      recordAttemptEvidence: input.record,
    }),
    authorizer: createDeliveryStateAuthorizer(),
    finalizeDeliveryTestReportByIntent: input.finalize,
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
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  };
}

function deliveryTestIntent(
  overrides: Partial<IntentDeliveryTestRow> = {},
): IntentDeliveryTestRow {
  return {
    id: IDS.intent,
    deliveryTestTargetSetId: DELIVERY_TEST.targetSet.id,
    deliveryTestTargetSetVersion: DELIVERY_TEST.targetSet.version,
    deliveryTestEndpointReferenceDigest: DELIVERY_TEST.endpointReferenceDigest,
    ...overrides,
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
    if (table === notificationIntents) {
      return options.intent === null ? [] : [options.intent];
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
        return {
          where: () => ({
            limit: async () => rows,
            orderBy: () => ({
              limit: async () => rows,
            }),
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

describe('delivery-state delivery-test provenance', () => {
  test('accepts exact immutable intent metadata on the first attempt write', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const fixture = fakeDatabase({ intent: deliveryTestIntent() });
    const store = createDrizzleDeliveryEvidenceStore(fixture.database, {
      uuid: () => IDS.evidence,
    });

    const result = await store.recordAttemptEvidence({
      attempt,
      evidence: attemptedEvidence(attempt),
    });

    expect(result).toMatchObject({
      id: IDS.evidence,
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'attempted',
    });
    expect(fixture.insertedTables).toEqual([channelAttempts, deliveryEvidence]);
  });

  test('fails closed before create when required delivery-test metadata is missing', async () => {
    const attempt = attemptWith(undefined);
    const fixture = fakeDatabase({ intent: deliveryTestIntent() });
    const store = createDrizzleDeliveryEvidenceStore(fixture.database);

    const error = await deliveryStateError(
      store.recordAttemptEvidence({
        attempt,
        evidence: attemptedEvidence(attempt),
      }),
    );

    expect(error).toMatchObject({ code: 'ATTEMPT_CONFLICT', status: 409 });
    expect(fixture.insertedTables).toHaveLength(0);
    expect(fixture.selectedTables).toEqual([
      channelAttempts,
      channelAttempts,
      notificationIntents,
    ]);
  });

  test('fails closed on idempotent replay when delivery-test metadata changed', async () => {
    const original = attemptWith(DELIVERY_TEST);
    const changed = attemptWith({
      ...DELIVERY_TEST,
      endpointReferenceDigest: 'b'.repeat(64),
    });
    const fixture = fakeDatabase({
      intent: deliveryTestIntent(),
      existingAttempt: attemptRow(original),
      firstEvidence: evidenceRow(original),
    });
    const store = createDrizzleDeliveryEvidenceStore(fixture.database);

    const error = await deliveryStateError(
      store.recordAttemptEvidence({
        attempt: changed,
        evidence: attemptedEvidence(changed),
      }),
    );

    expect(error).toMatchObject({ code: 'ATTEMPT_CONFLICT', status: 409 });
    expect(fixture.insertedTables).toHaveLength(0);
    expect(fixture.selectedTables).toEqual([
      channelAttempts,
      channelAttempts,
      notificationIntents,
    ]);
  });

  test('returns the original fact when an exact delivery-test attempt is replayed', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const firstEvidence = evidenceRow(attempt);
    const fixture = fakeDatabase({
      intent: deliveryTestIntent(),
      existingAttempt: attemptRow(attempt),
      firstEvidence,
    });
    const store = createDrizzleDeliveryEvidenceStore(fixture.database);

    const result = await store.recordAttemptEvidence({
      attempt,
      evidence: attemptedEvidence(attempt),
    });

    expect(result.id).toBe(firstEvidence.id);
    expect(result.sequence).toBe(1);
    expect(fixture.insertedTables).toHaveLength(0);
  });

  test('rejects delivery-test metadata introduced for an ordinary intent', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const fixture = fakeDatabase({
      intent: deliveryTestIntent({
        deliveryTestTargetSetId: null,
        deliveryTestTargetSetVersion: null,
        deliveryTestEndpointReferenceDigest: null,
      }),
    });
    const store = createDrizzleDeliveryEvidenceStore(fixture.database);

    const error = await deliveryStateError(
      store.recordAttemptEvidence({
        attempt,
        evidence: attemptedEvidence(attempt),
      }),
    );

    expect(error).toMatchObject({ code: 'ATTEMPT_CONFLICT', status: 409 });
    expect(fixture.insertedTables).toHaveLength(0);
  });

  test('treats partial persisted delivery-test metadata as invalid truth', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const fixture = fakeDatabase({
      intent: deliveryTestIntent({ deliveryTestTargetSetVersion: null }),
    });
    const store = createDrizzleDeliveryEvidenceStore(fixture.database);

    const error = await deliveryStateError(
      store.recordAttemptEvidence({
        attempt,
        evidence: attemptedEvidence(attempt),
      }),
    );

    expect(error).toMatchObject({
      code: 'DELIVERY_STATE_PERSISTENCE_INVALID',
      status: 503,
    });
    expect(fixture.insertedTables).toHaveLength(0);
  });

  test('fails closed when the immutable notification intent is unavailable', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const fixture = fakeDatabase({ intent: null });
    const store = createDrizzleDeliveryEvidenceStore(fixture.database);

    const error = await deliveryStateError(
      store.recordAttemptEvidence({
        attempt,
        evidence: attemptedEvidence(attempt),
      }),
    );

    expect(error).toMatchObject({
      code: 'DELIVERY_STATE_PERSISTENCE_INVALID',
      status: 503,
    });
    expect(fixture.insertedTables).toHaveLength(0);
  });
});

describe('delivery-state monthly report projection', () => {
  test('does not open persistence or report projection before worker authentication', async () => {
    let runtimeCreateCount = 0;
    const handler = createDeliveryStateRouteHandler({
      readExpectedBearerToken: () => WORKER_TOKEN,
      createRuntime: async () => {
        runtimeCreateCount += 1;
        throw new Error('The unauthenticated request opened persistence.');
      },
    });
    const attempt = attemptWith(DELIVERY_TEST);
    const evidence = providerAcceptedEvidence(attempt);
    const unauthenticated = routeRequest({ attempt, evidence });
    unauthenticated.headers.delete('authorization');

    const response = await handler(unauthenticated);

    expect(response.status).toBe(401);
    expect(runtimeCreateCount).toBe(0);
  });

  test('projects committed terminal evidence with system-only, evidence-idempotent invocation', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const evidence = providerAcceptedEvidence(attempt);
    const committed = committedEvidence(evidence);
    const order: string[] = [];
    const projections: Array<{
      readonly intentId: string;
      readonly invocation: TrustedCapabilityInvocation;
    }> = [];
    const runtime = fakeRouteRuntime({
      async record(request) {
        order.push('evidence-committed');
        expect(request).toEqual({ attempt, evidence });
        return committed;
      },
      async finalize(intentId, invocation) {
        order.push('report-projected');
        projections.push({ intentId, invocation });
        return null;
      },
    });
    const handler = createDeliveryStateRouteHandler({
      readExpectedBearerToken: () => WORKER_TOKEN,
      createRuntime: async () => runtime,
    });

    const response = await handler(routeRequest({ attempt, evidence }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: committed });
    expect(order).toEqual(['evidence-committed', 'report-projected']);
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      intentId: IDS.intent,
      invocation: {
        actor: {
          kind: 'system',
          serviceId: DELIVERY_STATE_WORKER_SERVICE_ID,
        },
        source: 'worker',
        scope: { facilityScope: { kind: 'district' } },
        serverTime: new Date(COMMITTED_AT),
        connectivityEpochId: null,
        mutation: {
          idempotencyKey: `delivery-test-report:${IDS.evidence}`,
          transport: { kind: 'worker-execution' },
          humanConfirmationId: null,
        },
      },
    });
    expect(projections[0]!.invocation.requestId).not.toBe(IDS.evidence);
  });

  test('projects explicit unknown provider truth into an incomplete monthly report path', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const evidence = unknownEvidence(attempt);
    const projected: string[] = [];
    const runtime = fakeRouteRuntime({
      record: async () => committedEvidence(evidence),
      async finalize(intentId) {
        projected.push(intentId);
        return null;
      },
    });
    const handler = createDeliveryStateRouteHandler({
      readExpectedBearerToken: () => WORKER_TOKEN,
      createRuntime: async () => runtime,
    });

    const response = await handler(routeRequest({ attempt, evidence }));

    expect(response.status).toBe(200);
    expect(projected).toEqual([IDS.intent]);
  });

  test('skips ordinary and nonterminal evidence and treats an unresolved monthly run as no report', async () => {
    const ordinaryAttempt = attemptWith(null);
    const ordinaryInput = providerAcceptedEvidence(ordinaryAttempt);
    const monthlyAttempt = attemptWith(DELIVERY_TEST);
    const monthlyInput = providerAcceptedEvidence(monthlyAttempt);
    const monthlyAttempted = attemptedEvidence(monthlyAttempt);
    const projectedIntents: string[] = [];
    const runtime = fakeRouteRuntime({
      record: async (request) => committedEvidence(request.evidence),
      async finalize(intentId) {
        projectedIntents.push(intentId);
        // Canonical readiness/run resolution uses null for no report.
        return null;
      },
    });
    const handler = createDeliveryStateRouteHandler({
      readExpectedBearerToken: () => WORKER_TOKEN,
      createRuntime: async () => runtime,
    });

    const ordinaryResponse = await handler(
      routeRequest({ attempt: ordinaryAttempt, evidence: ordinaryInput }),
    );
    const attemptedResponse = await handler(
      routeRequest({ attempt: monthlyAttempt, evidence: monthlyAttempted }),
    );
    const monthlyResponse = await handler(
      routeRequest({ attempt: monthlyAttempt, evidence: monthlyInput }),
    );

    expect(ordinaryResponse.status).toBe(200);
    expect(attemptedResponse.status).toBe(200);
    expect(monthlyResponse.status).toBe(200);
    expect(projectedIntents).toEqual([IDS.intent]);
  });

  test('fails closed after evidence commit and retries with stable idempotency but a fresh audit request', async () => {
    const attempt = attemptWith(DELIVERY_TEST);
    const evidence = providerAcceptedEvidence(attempt);
    const committed = committedEvidence(evidence);
    const committedIds: string[] = [];
    const invocations: TrustedCapabilityInvocation[] = [];
    let closeCount = 0;
    const runtime = fakeRouteRuntime({
      async record() {
        // Models canonical evidence replay: the immutable committed fact is
        // returned again rather than appended or rewritten.
        committedIds.push(committed.id);
        return committed;
      },
      async finalize(_intentId, invocation) {
        invocations.push(invocation);
        if (invocations.length === 1) {
          throw new Error('sensitive projection failure');
        }
        return null;
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

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: {
        code: 'DELIVERY_STATE_UNAVAILABLE',
        message: 'Delivery-state writeback failed safely.',
      },
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ result: committed });
    expect(committedIds).toEqual([IDS.evidence, IDS.evidence]);
    expect(invocations).toHaveLength(2);
    expect(invocations[1]!.requestId).not.toBe(invocations[0]!.requestId);
    expect(invocations[1]).toMatchObject({
      actor: invocations[0]!.actor,
      source: invocations[0]!.source,
      scope: invocations[0]!.scope,
      serverTime: invocations[0]!.serverTime,
      connectivityEpochId: null,
      mutation: invocations[0]!.mutation,
    });
    expect(closeCount).toBe(2);
  });
});
