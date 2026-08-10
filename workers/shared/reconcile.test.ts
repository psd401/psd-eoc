import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  ReconcileDeliveryAttemptsResultSchema,
  type DeliveryEvidence,
  type ReconcileDeliveryAttemptsInput,
  type ReconcileDeliveryAttemptsResult,
} from '@psd-eoc/contracts';

import {
  RECONCILIATION_REASON_CODE,
  buildDlqDrainReport,
  buildReconciliationUnknownEvidence,
  executeReconcileDeliveryAttempts,
  type DlqQueueObservation,
  type ReconciliationStore,
} from '../../packages/server/lib/notify/reconcile';
import { IDS, TIMES } from './test-fixtures';

const ATTEMPTED_EVIDENCE_ID = '91000000-0000-4000-8000-000000000001';
const ACCEPTED_EVIDENCE_ID = '91000000-0000-4000-8000-000000000002';
const DELIVERED_EVIDENCE_ID = '91000000-0000-4000-8000-000000000003';
const ACCEPTED_ATTEMPT_ID = '92000000-0000-4000-8000-000000000001';
const DELIVERED_ATTEMPT_ID = '92000000-0000-4000-8000-000000000002';
const UNKNOWN_TIME = '2026-08-10T16:30:00.000Z';

function attemptedEvidence(): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: ATTEMPTED_EVIDENCE_ID,
    subject: { kind: 'attempt', attemptId: IDS.attempt },
    sequence: 1,
    previousEvidenceId: null,
    state: 'attempted',
    recordedAt: TIMES.recorded,
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
}

function providerAcceptedEvidence(): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: ACCEPTED_EVIDENCE_ID,
    subject: { kind: 'attempt', attemptId: ACCEPTED_ATTEMPT_ID },
    sequence: 2,
    previousEvidenceId: '91000000-0000-4000-8000-000000000010',
    state: 'provider-accepted',
    recordedAt: TIMES.recorded,
    provider: 'synthetic-provider',
    providerReference: 'synthetic-acceptance-1',
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
}

function deliveredEvidence(): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: DELIVERED_EVIDENCE_ID,
    subject: { kind: 'attempt', attemptId: DELIVERED_ATTEMPT_ID },
    sequence: 2,
    previousEvidenceId: '91000000-0000-4000-8000-000000000011',
    state: 'delivered',
    recordedAt: TIMES.recorded,
    provider: 'synthetic-provider',
    providerReference: 'synthetic-delivery-1',
    proof: {
      kind: 'provider-delivery-receipt',
      provider: 'synthetic-provider',
      receiptId: 'synthetic-delivery-1',
      deliveredAt: TIMES.attempted,
    },
    reasonCode: null,
    diagnosticDigest: null,
  });
}

class MemoryReconciliationStore implements ReconciliationStore {
  public calls = 0;

  public async reconcile(
    input: ReconcileDeliveryAttemptsInput,
  ): Promise<ReconcileDeliveryAttemptsResult> {
    this.calls += 1;
    const examined = [
      attemptedEvidence(),
      providerAcceptedEvidence(),
      deliveredEvidence(),
    ].slice(0, input.limit);
    const appendedEvidence = examined.flatMap((evidence, index) => {
      const unknown = buildReconciliationUnknownEvidence(
        evidence,
        UNKNOWN_TIME,
        `93000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      );
      return unknown === null ? [] : [unknown];
    });
    return ReconcileDeliveryAttemptsResultSchema.parse({
      examinedAttemptCount: examined.length,
      appendedEvidence,
    });
  }
}

describe('delivery-attempt reconciliation', () => {
  test('appends explicit unknown after attempted and provider-accepted while leaving terminal evidence untouched', () => {
    const attemptedUnknown = buildReconciliationUnknownEvidence(
      attemptedEvidence(),
      UNKNOWN_TIME,
      '94000000-0000-4000-8000-000000000001',
    );
    const acceptedUnknown = buildReconciliationUnknownEvidence(
      providerAcceptedEvidence(),
      UNKNOWN_TIME,
      '94000000-0000-4000-8000-000000000002',
    );
    const terminalResult = buildReconciliationUnknownEvidence(
      deliveredEvidence(),
      UNKNOWN_TIME,
      '94000000-0000-4000-8000-000000000003',
    );

    expect(attemptedUnknown).toMatchObject({
      state: 'unknown',
      sequence: 2,
      previousEvidenceId: ATTEMPTED_EVIDENCE_ID,
      provider: null,
      providerReference: null,
      reasonCode: RECONCILIATION_REASON_CODE,
    });
    expect(acceptedUnknown).toMatchObject({
      state: 'unknown',
      sequence: 3,
      previousEvidenceId: ACCEPTED_EVIDENCE_ID,
      provider: 'synthetic-provider',
      providerReference: 'synthetic-acceptance-1',
      reasonCode: RECONCILIATION_REASON_CODE,
    });
    expect(terminalResult).toBeNull();
  });

  test('executes the exact canonical reconciliation capability and exposes unknown in its result', async () => {
    const store = new MemoryReconciliationStore();
    const result = await executeReconcileDeliveryAttempts(
      { intentId: null, limit: 10 },
      {
        store,
        requestId: '95000000-0000-4000-8000-000000000001',
        idempotencyKey: 'scheduled-reconciliation-20260810-001',
      },
    );

    expect(store.calls).toBe(1);
    expect(result.examinedAttemptCount).toBe(3);
    expect(result.appendedEvidence).toHaveLength(2);
    expect(result.appendedEvidence.map((evidence) => evidence.state)).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(
      result.appendedEvidence.every(
        (evidence) => evidence.reasonCode === RECONCILIATION_REASON_CODE,
      ),
    ).toBe(true);
  });
});

describe('destination-free DLQ drain reporting', () => {
  test('aggregates only queue metrics and explicitly performs no delete or redrive', () => {
    const observations: readonly DlqQueueObservation[] = [
      {
        channel: 'push',
        visibleMessageCount: 2,
        inFlightMessageCount: 1,
        oldestMessageAgeSeconds: 90,
      },
      {
        channel: 'push',
        visibleMessageCount: 3,
        inFlightMessageCount: 0,
        oldestMessageAgeSeconds: 120,
      },
      {
        channel: 'email',
        visibleMessageCount: 0,
        inFlightMessageCount: 1,
        oldestMessageAgeSeconds: null,
      },
    ];
    const report = buildDlqDrainReport(observations, new Date(UNKNOWN_TIME));

    expect(report).toEqual({
      observedAt: UNKNOWN_TIME,
      messageCount: 7,
      visibleMessageCount: 5,
      inFlightMessageCount: 2,
      requiresOperatorReview: true,
      automaticRedrivePerformed: false,
      messagesDeleted: 0,
      channels: [
        {
          channel: 'push',
          visibleMessageCount: 5,
          inFlightMessageCount: 1,
          oldestMessageAgeSeconds: 120,
          messageCount: 6,
        },
        {
          channel: 'email',
          visibleMessageCount: 0,
          inFlightMessageCount: 1,
          oldestMessageAgeSeconds: null,
          messageCount: 1,
        },
      ],
    });
    expect(Object.keys(report).sort()).toEqual(
      [
        'automaticRedrivePerformed',
        'channels',
        'inFlightMessageCount',
        'messageCount',
        'messagesDeleted',
        'observedAt',
        'requiresOperatorReview',
        'visibleMessageCount',
      ].sort(),
    );
  });

  test('rejects any observation that tries to carry destination data', () => {
    expect(() =>
      buildDlqDrainReport(
        [
          {
            channel: 'sms',
            visibleMessageCount: 1,
            inFlightMessageCount: 0,
            oldestMessageAgeSeconds: 60,
            destination: '+12025550199',
          },
        ] as unknown as readonly DlqQueueObservation[],
        new Date(UNKNOWN_TIME),
      ),
    ).toThrow();
  });
});
