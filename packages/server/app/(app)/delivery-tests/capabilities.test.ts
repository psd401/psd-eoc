import { randomUUID } from 'node:crypto';

import type { CapabilityScope } from '@psd-eoc/contracts';
import { describe, expect, test } from 'bun:test';

import {
  channelAttempts,
  deliveryEvidence,
  deliveryTestReports,
  deliveryTestRuns,
  deliveryTestTargetEndpoints,
  dispatchBatches,
} from '../../../db/schema';
import {
  CapabilityEngineError,
  type CapabilityHandlerContext,
  type TrustedCapabilityInvocation,
} from '../../../lib/capabilities/engine';
import type { AuthenticatedAgentApiKey } from '../../../lib/agents/keys';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { deliveryTestEndpointReferenceDigest } from '../../../lib/testing/e2e-delivery';
import {
  assertAuthenticatedDeliveryTestReportInvocation,
  decodeDeliveryTestReportPageCursor,
  deliveryTestTargetModeMatches,
  deliveryTestReportIsInPageWindow,
  encodeDeliveryTestReportPageCursor,
  finalizeDeliveryTestReportRegistration,
  resolveReadyDeliveryTestReportRunIdByIntent,
  type DeliveryTestCapabilityStore,
} from '../../../lib/capabilities/delivery-tests';

type DeliveryTestTransaction = Parameters<
  DeliveryTestCapabilityStore['transaction']
>[0] extends (transaction: infer Transaction) => Promise<unknown>
  ? Transaction
  : never;
type FinalizerContext = CapabilityHandlerContext<DeliveryTestTransaction>;
type FakeRow = Readonly<Record<string, unknown>>;

class FakeSelectQuery implements PromiseLike<readonly FakeRow[]> {
  private source: unknown;
  private maximum: number | null = null;

  public constructor(
    private readonly rowsFor: (
      source: unknown,
      selection: unknown,
    ) => readonly FakeRow[],
    private readonly selection: unknown,
  ) {}

  public from(source: unknown): this {
    this.source = source;
    return this;
  }

  public innerJoin(): this {
    return this;
  }

  public where(): this {
    return this;
  }

  public orderBy(): this {
    return this;
  }

  public for(): this {
    return this;
  }

  public limit(maximum: number): this {
    this.maximum = maximum;
    return this;
  }

  public then<TResult1 = readonly FakeRow[], TResult2 = never>(
    onfulfilled?:
      | ((value: readonly FakeRow[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.rowsFor(this.source, this.selection);
    const limited = this.maximum === null ? rows : rows.slice(0, this.maximum);
    return Promise.resolve(limited).then(onfulfilled, onrejected);
  }
}

const STARTED_AT = new Date('2026-08-13T18:00:00.000Z');

describe('controlled single-channel canary target modes', () => {
  const email = Object.freeze({
    recipientId: '10000000-0000-4000-8000-000000000001',
    endpointId: '10000000-0000-4000-8000-000000000002',
    channel: 'email' as const,
  });
  const push = Object.freeze({
    recipientId: '10000000-0000-4000-8000-000000000003',
    endpointId: '10000000-0000-4000-8000-000000000004',
    channel: 'push' as const,
  });
  const sms = Object.freeze({
    recipientId: '10000000-0000-4000-8000-000000000005',
    endpointId: '10000000-0000-4000-8000-000000000006',
    channel: 'sms' as const,
  });

  test('requires the discriminated mode to resolve to exactly one email endpoint', () => {
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-email-canary' }, [
        email,
      ]),
    ).toBe(true);
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-email-canary' }, [
        push,
      ]),
    ).toBe(false);
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-email-canary' }, [
        email,
        push,
      ]),
    ).toBe(false);
  });

  test('requires the push mode to resolve to exactly one push endpoint', () => {
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-push-canary' }, [push]),
    ).toBe(true);
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-push-canary' }, [
        email,
      ]),
    ).toBe(false);
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-push-canary' }, [
        email,
        push,
      ]),
    ).toBe(false);
  });

  test('requires the SMS mode to resolve to exactly one SMS endpoint', () => {
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-sms-canary' }, [sms]),
    ).toBe(true);
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-sms-canary' }, [push]),
    ).toBe(false);
    expect(
      deliveryTestTargetModeMatches({ mode: 'controlled-sms-canary' }, [
        email,
        sms,
      ]),
    ).toBe(false);
  });

  test('retains the ordinary push-and-email minimum', () => {
    expect(deliveryTestTargetModeMatches({}, [email, push])).toBe(true);
    expect(deliveryTestTargetModeMatches({}, [email])).toBe(false);
    expect(deliveryTestTargetModeMatches({}, [push])).toBe(false);
  });
});

function systemInvocation(serverTime: Date): TrustedCapabilityInvocation {
  const requestId = randomUUID();
  return Object.freeze({
    actor: Object.freeze({
      kind: 'system' as const,
      serviceId: 'notification-delivery-worker',
    }),
    source: 'worker',
    scope: Object.freeze({
      facilityScope: Object.freeze({ kind: 'district' as const }),
    }),
    requestId,
    serverTime,
    connectivityEpochId: null,
    mutation: Object.freeze({
      idempotencyKey: `delivery-test-report:${requestId}`,
      transport: Object.freeze({ kind: 'worker-execution' } as const),
      humanConfirmationId: null,
    }),
  });
}

describe('delivery-test report capability', () => {
  test('appends incomplete, accepted, and failed truth while de-duplicating an unchanged projection', async () => {
    const ids = Object.freeze({
      activationPreview: randomUUID(),
      batchEmail: randomUUID(),
      batchPush: randomUUID(),
      confirmation: randomUUID(),
      endpointEmail: randomUUID(),
      endpointPush: randomUUID(),
      event: randomUUID(),
      facility: randomUUID(),
      intent: randomUUID(),
      recipientEmail: randomUUID(),
      recipientPush: randomUUID(),
      request: randomUUID(),
      roster: randomUUID(),
      run: randomUUID(),
      session: randomUUID(),
      targetSet: randomUUID(),
      user: randomUUID(),
      attemptEmail: randomUUID(),
      attemptPush: randomUUID(),
    });
    const targets = Object.freeze([
      Object.freeze({
        recipientId: ids.recipientPush,
        endpointId: ids.endpointPush,
        channel: 'push' as const,
      }),
      Object.freeze({
        recipientId: ids.recipientEmail,
        endpointId: ids.endpointEmail,
        channel: 'email' as const,
      }),
    ]);
    const endpointReferenceDigest =
      deliveryTestEndpointReferenceDigest(targets);
    const run: typeof deliveryTestRuns.$inferSelect = {
      id: ids.run,
      activationPreviewId: ids.activationPreview,
      eventId: ids.event,
      notificationIntentId: ids.intent,
      targetSetVersionId: ids.targetSet,
      targetSetVersion: 1,
      endpointReferenceDigest,
      consequenceDigest: 'a'.repeat(64),
      confirmationId: ids.confirmation,
      confirmationStatus: 'consumed',
      requestId: ids.request,
      startedByUserId: ids.user,
      startedWithSessionId: ids.session,
      startedAt: STARTED_AT,
    };
    const batches: readonly FakeRow[] = [
      {
        id: ids.batchPush,
        intentId: ids.intent,
        channel: 'push',
        endpointCount: 1,
      },
      {
        id: ids.batchEmail,
        intentId: ids.intent,
        channel: 'email',
        endpointCount: 1,
      },
    ];
    const attempts: readonly FakeRow[] = [
      {
        id: ids.attemptPush,
        batchId: ids.batchPush,
        intentId: ids.intent,
        recipientId: ids.recipientPush,
        endpointId: ids.endpointPush,
        channel: 'push',
        attemptNumber: 1,
        attemptedAt: new Date('2026-08-13T18:00:00.500Z'),
      },
      {
        id: ids.attemptEmail,
        batchId: ids.batchEmail,
        intentId: ids.intent,
        recipientId: ids.recipientEmail,
        endpointId: ids.endpointEmail,
        channel: 'email',
        attemptNumber: 1,
        attemptedAt: new Date('2026-08-13T18:00:00.600Z'),
      },
    ];
    let evidenceRows: readonly FakeRow[] = [
      {
        attemptId: ids.attemptPush,
        sequence: 1,
        state: 'attempted',
        recordedAt: new Date('2026-08-13T18:00:01.000Z'),
      },
      {
        attemptId: ids.attemptEmail,
        sequence: 1,
        state: 'attempted',
        recordedAt: new Date('2026-08-13T18:00:02.000Z'),
      },
    ];
    const persistedReports: Array<typeof deliveryTestReports.$inferSelect> = [];
    const operationOrder: string[] = [];
    const rowsFor = (
      source: unknown,
      selection: unknown,
    ): readonly FakeRow[] => {
      if (source === deliveryTestRuns) {
        if (
          typeof selection === 'object' &&
          selection !== null &&
          'id' in selection
        ) {
          return [{ id: run.id }];
        }
        return [{ run, facilityId: ids.facility }];
      }
      if (source === deliveryTestTargetEndpoints) return targets;
      if (source === dispatchBatches) return batches;
      if (source === channelAttempts) return attempts;
      if (source === deliveryEvidence) {
        operationOrder.push('projection-evidence');
        return evidenceRows;
      }
      if (source === deliveryTestReports) {
        return [...persistedReports].reverse();
      }
      throw new Error('The fake finalizer received an unexpected table.');
    };
    const database = {
      select: (selection?: unknown) => new FakeSelectQuery(rowsFor, selection),
      execute: async () => [],
      insert: (table: unknown) => ({
        values: async (value: unknown): Promise<void> => {
          if (table !== deliveryTestReports) {
            throw new Error('The finalizer wrote an unexpected table.');
          }
          persistedReports.push(
            value as typeof deliveryTestReports.$inferSelect,
          );
        },
      }),
    };
    const context = (serverTime: Date): FinalizerContext => ({
      invocation: systemInvocation(serverTime),
      transaction: {
        database,
        readCurrentTime: async () => {
          operationOrder.push('report-clock');
          return serverTime;
        },
      } as unknown as DeliveryTestTransaction,
      cache: new Map<string, unknown>(),
      authorization: null,
      resolvedFacilityId: ids.facility,
      safetyResolution: null,
    });

    const incompleteReport =
      await finalizeDeliveryTestReportRegistration.handler(
        { runId: ids.run },
        context(new Date('2026-08-13T18:00:03.000Z')),
      );

    expect(incompleteReport).toMatchObject({
      runId: ids.run,
      sequence: 1,
      supersedesReportId: null,
      status: 'incomplete',
      reasonCode: 'PROVIDER_TRUTH_PENDING',
      source: 'worker',
    });
    expect(JSON.stringify(incompleteReport)).not.toContain(ids.endpointPush);
    expect(JSON.stringify(incompleteReport)).not.toContain(ids.recipientPush);
    expect(persistedReports).toHaveLength(1);
    expect(operationOrder.indexOf('report-clock')).toBeGreaterThan(
      operationOrder.indexOf('projection-evidence'),
    );
    await expect(
      resolveReadyDeliveryTestReportRunIdByIntent(database, ids.intent),
    ).resolves.toBeNull();

    evidenceRows = evidenceRows.map((row) => ({
      ...row,
      sequence: 2,
      state: 'unknown',
      recordedAt: new Date('2026-08-13T18:00:03.500Z'),
    }));
    await expect(
      resolveReadyDeliveryTestReportRunIdByIntent(database, ids.intent),
    ).resolves.toBeNull();
    const unknownReport = await finalizeDeliveryTestReportRegistration.handler(
      { runId: ids.run },
      context(new Date('2026-08-13T18:00:04.000Z')),
    );
    expect(unknownReport).toMatchObject({
      sequence: 1,
      supersedesReportId: null,
      status: 'incomplete',
      reasonCode: 'PROVIDER_TRUTH_PENDING',
    });

    evidenceRows = [
      ...evidenceRows,
      {
        attemptId: ids.attemptPush,
        sequence: 3,
        state: 'provider-accepted',
        recordedAt: new Date('2026-08-13T18:00:04.000Z'),
      },
      {
        attemptId: ids.attemptEmail,
        sequence: 3,
        state: 'provider-accepted',
        recordedAt: new Date('2026-08-13T18:00:05.000Z'),
      },
    ];
    await expect(
      resolveReadyDeliveryTestReportRunIdByIntent(database, ids.intent),
    ).resolves.toBe(ids.run);
    const acceptedReport = await finalizeDeliveryTestReportRegistration.handler(
      { runId: ids.run },
      context(new Date('2026-08-13T18:00:06.000Z')),
    );

    expect(acceptedReport).toMatchObject({
      runId: ids.run,
      sequence: 2,
      supersedesReportId: unknownReport.id,
      status: 'succeeded',
      reasonCode: null,
    });
    expect(persistedReports).toHaveLength(2);
    await expect(
      resolveReadyDeliveryTestReportRunIdByIntent(database, ids.intent),
    ).resolves.toBeNull();

    evidenceRows = [
      ...evidenceRows,
      {
        attemptId: ids.attemptPush,
        sequence: 4,
        state: 'failed',
        recordedAt: new Date('2026-08-13T18:00:07.000Z'),
      },
    ];
    const failedReport = await finalizeDeliveryTestReportRegistration.handler(
      { runId: ids.run },
      context(new Date('2026-08-13T18:00:08.000Z')),
    );

    expect(failedReport).toMatchObject({
      runId: ids.run,
      sequence: 3,
      supersedesReportId: acceptedReport.id,
      status: 'failed',
      reasonCode: 'DELIVERY_TEST_PROVIDER_FAILURE',
    });
    expect(persistedReports).toHaveLength(3);

    const replayedProjection =
      await finalizeDeliveryTestReportRegistration.handler(
        { runId: ids.run },
        context(new Date('2026-08-13T18:00:09.000Z')),
      );

    expect(replayedProjection).toEqual(failedReport);
    expect(persistedReports).toHaveLength(3);
  });

  test('keeps a stable keyset snapshot when a newer report is inserted between pages', () => {
    const filterDigest = 'f'.repeat(64);
    const cursor = {
      version: 2 as const,
      snapshotExclusive: '2026-08-13T18:00:10.000Z',
      after: {
        generatedAt: '2026-08-13T18:00:08.000Z',
        id: '30000000-0000-4000-8000-000000000020',
      },
      filterDigest,
    };
    const encoded = encodeDeliveryTestReportPageCursor(cursor);

    expect(encoded).not.toContain(filterDigest);
    expect(decodeDeliveryTestReportPageCursor(encoded, filterDigest)).toEqual(
      cursor,
    );
    expect(() =>
      decodeDeliveryTestReportPageCursor(encoded, '0'.repeat(64)),
    ).toThrow(CapabilityEngineError);
    expect(
      deliveryTestReportIsInPageWindow(
        {
          // This report arrived after page one began. It must never shift the
          // snapshot or duplicate a row on page two.
          generatedAt: '2026-08-13T18:00:11.000Z',
          id: '30000000-0000-4000-8000-000000000099',
        },
        cursor,
      ),
    ).toBe(false);
    expect(
      deliveryTestReportIsInPageWindow(
        {
          // Same timestamp as the final page-one row but strictly later ID:
          // descending keyset order says this row was already before it.
          generatedAt: cursor.after.generatedAt,
          id: '30000000-0000-4000-8000-000000000030',
        },
        cursor,
      ),
    ).toBe(false);
    expect(
      deliveryTestReportIsInPageWindow(
        {
          generatedAt: cursor.after.generatedAt,
          id: '30000000-0000-4000-8000-000000000010',
        },
        cursor,
      ),
    ).toBe(true);
    expect(
      deliveryTestReportIsInPageWindow(
        {
          generatedAt: '2026-08-13T18:00:07.999Z',
          id: '30000000-0000-4000-8000-000000000099',
        },
        cursor,
      ),
    ).toBe(true);
  });

  test('binds report reads to the exact scoped human or granted agent identity and denies systems', () => {
    const facilityId = randomUUID();
    const otherFacilityId = randomUUID();
    const scope: CapabilityScope = {
      facilityScope: { kind: 'facilities', facilityIds: [facilityId] },
    };
    const agentActor = Object.freeze({
      kind: 'agent' as const,
      agentId: randomUUID(),
      apiKeyId: randomUUID(),
    });
    const agentInvocation: TrustedCapabilityInvocation = {
      actor: agentActor,
      source: 'agent-rest',
      scope,
      requestId: randomUUID(),
      serverTime: new Date('2026-08-13T18:00:00.000Z'),
      connectivityEpochId: null,
      mutation: null,
    };
    const agent = {
      actor: agentActor,
      scope,
      capabilityIds: ['list-delivery-test-reports'],
      key: {},
    } as unknown as AuthenticatedAgentApiKey;

    expect(() =>
      assertAuthenticatedDeliveryTestReportInvocation(agentInvocation, agent),
    ).not.toThrow();
    expect(() =>
      assertAuthenticatedDeliveryTestReportInvocation(agentInvocation, {
        ...agent,
        actor: { ...agentActor, apiKeyId: randomUUID() },
      }),
    ).toThrow(CapabilityEngineError);
    expect(() =>
      assertAuthenticatedDeliveryTestReportInvocation(agentInvocation, {
        ...agent,
        scope: {
          facilityScope: {
            kind: 'facilities',
            facilityIds: [otherFacilityId],
          },
        },
      }),
    ).toThrow(CapabilityEngineError);
    expect(() =>
      assertAuthenticatedDeliveryTestReportInvocation(agentInvocation, {
        ...agent,
        capabilityIds: [],
      }),
    ).toThrow(CapabilityEngineError);

    const humanActor = Object.freeze({
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    });
    const humanInvocation: TrustedCapabilityInvocation = {
      actor: humanActor,
      source: 'web',
      scope,
      requestId: randomUUID(),
      serverTime: new Date('2026-08-13T18:00:00.000Z'),
      connectivityEpochId: randomUUID(),
      mutation: null,
    };
    const human = {
      actor: humanActor,
      source: 'web',
      roles: ['viewer'],
      scope,
      result: {
        session: { id: humanActor.sessionId },
        connectivityEpoch: { id: humanInvocation.connectivityEpochId },
      },
    } as unknown as AuthenticatedSession;

    expect(() =>
      assertAuthenticatedDeliveryTestReportInvocation(humanInvocation, human),
    ).not.toThrow();
    expect(() =>
      assertAuthenticatedDeliveryTestReportInvocation(humanInvocation, {
        ...human,
        actor: { ...humanActor, userId: randomUUID() },
      }),
    ).toThrow(CapabilityEngineError);
    expect(() =>
      assertAuthenticatedDeliveryTestReportInvocation(
        {
          ...humanInvocation,
          actor: { kind: 'system', serviceId: 'report-worker' },
          source: 'worker',
          connectivityEpochId: null,
        },
        undefined,
      ),
    ).toThrow(CapabilityEngineError);
  });

  test('denies report finalization before persistence for a non-system actor', async () => {
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const invocation: TrustedCapabilityInvocation = {
      actor,
      source: 'web',
      scope: { facilityScope: { kind: 'district' } },
      requestId: randomUUID(),
      serverTime: new Date('2026-08-13T18:00:00.000Z'),
      connectivityEpochId: randomUUID(),
      mutation: {
        idempotencyKey: `human-finalizer-denial-${randomUUID()}`,
        transport: {
          kind: 'web-interactive',
          method: 'POST',
          interaction: 'explicit-user-submit',
          csrfVerified: true,
        },
        humanConfirmationId: null,
      },
    };
    let databaseRead = false;
    const transaction = {
      database: {
        execute: async () => {
          databaseRead = true;
          return [];
        },
      },
      readCurrentTime: async () => invocation.serverTime,
    } as unknown as DeliveryTestTransaction;

    await expect(
      finalizeDeliveryTestReportRegistration.handler(
        { runId: randomUUID() },
        {
          invocation,
          transaction,
          cache: new Map<string, unknown>(),
          authorization: null,
          resolvedFacilityId: null,
          safetyResolution: null,
        },
      ),
    ).rejects.toBeInstanceOf(CapabilityEngineError);
    expect(databaseRead).toBe(false);
  });

  test('denies scheduled report finalization before persistence', async () => {
    const workerInvocation = systemInvocation(
      new Date('2026-08-13T18:00:00.000Z'),
    );
    const invocation: TrustedCapabilityInvocation = {
      ...workerInvocation,
      source: 'scheduled-job',
      mutation: {
        idempotencyKey: `scheduled-finalizer-denial-${randomUUID()}`,
        transport: { kind: 'scheduled-execution' },
        humanConfirmationId: null,
      },
    };
    let databaseRead = false;
    const transaction = {
      database: {
        execute: async () => {
          databaseRead = true;
          return [];
        },
      },
      readCurrentTime: async () => invocation.serverTime,
    } as unknown as DeliveryTestTransaction;

    await expect(
      finalizeDeliveryTestReportRegistration.handler(
        { runId: randomUUID() },
        {
          invocation,
          transaction,
          cache: new Map<string, unknown>(),
          authorization: null,
          resolvedFacilityId: null,
          safetyResolution: null,
        },
      ),
    ).rejects.toBeInstanceOf(CapabilityEngineError);
    expect(databaseRead).toBe(false);
  });
});
