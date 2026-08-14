import { describe, expect, test } from 'bun:test';

import * as Contracts from './index';
import {
  FailureDrillAttemptEvidenceFactSchema,
  FailureDrillAttemptEvidenceSetSchema,
  FailureDrillAttemptSchema,
  FailureDrillAttemptSetSchema,
  FailureDrillDlqFactSetSchema,
  FailureDrillExecutionFactSetSchema,
  FailureDrillExpectedWorkPlanSchema,
  FailureDrillMockSideEffectObservationSetSchema,
  FailureDrillProviderEffectIdentitySetSchema,
  FailureDrillReconciliationResultSchema,
  FailureDrillRetryFulfillmentSetSchema,
  FailureDrillRetryObligationSetSchema,
  FailureDrillRetryableFailureSchema,
  FailureDrillSafeRunAdmissionSchema,
  FailureDrillTerminalDispositionSchema,
  FailureDrillTerminalDispositionSetSchema,
  FailureDrillTerminalOutcomeSchema,
} from './failure-drill-runtime';

const ids = {
  run: '00000000-0000-4000-8000-000000000001',
  event: '00000000-0000-4000-8000-000000000002',
  intent: '00000000-0000-4000-8000-000000000003',
  batch: '00000000-0000-4000-8000-000000000004',
  batch2: '00000000-0000-4000-8000-000000000005',
  endpoint: '00000000-0000-4000-8000-000000000006',
  endpoint2: '00000000-0000-4000-8000-000000000007',
  attempt: '00000000-0000-4000-8000-000000000008',
  attempt2: '00000000-0000-4000-8000-000000000009',
  evidence: '00000000-0000-4000-8000-000000000010',
  evidence2: '00000000-0000-4000-8000-000000000011',
  obligation: '00000000-0000-4000-8000-000000000012',
  user: '00000000-0000-4000-8000-000000000013',
  execution1: '00000000-0000-4000-8000-000000000014',
  execution2: '00000000-0000-4000-8000-000000000015',
  execution3: '00000000-0000-4000-8000-000000000016',
  lease: '00000000-0000-4000-8000-000000000017',
  dlqEntry: '00000000-0000-4000-8000-000000000018',
  dlqFact: '00000000-0000-4000-8000-000000000019',
  dlqFact2: '00000000-0000-4000-8000-000000000020',
  observation: '00000000-0000-4000-8000-000000000021',
  observation2: '00000000-0000-4000-8000-000000000022',
  disposition: '00000000-0000-4000-8000-000000000023',
  fulfillment: '00000000-0000-4000-8000-000000000024',
} as const;

const time = {
  authorized: '2026-08-13T20:00:00.000Z',
  created: '2026-08-13T20:00:01.000Z',
  sealed: '2026-08-13T20:00:02.000Z',
  leased: '2026-08-13T20:00:03.000Z',
  expires: '2026-08-13T20:01:03.000Z',
  completed: '2026-08-13T20:00:04.000Z',
} as const;

const classification = {
  eventKind: 'test',
  templateMode: 'drill',
  classificationMarker: 'DRILL',
  rosterPopulation: 'synthetic',
  providerMode: 'mocked',
} as const;

function runLineage(overrides: Record<string, unknown> = {}) {
  return {
    runId: ids.run,
    eventId: ids.event,
    ...classification,
    ...overrides,
  };
}

function admission(overrides: Record<string, unknown> = {}) {
  return {
    ...runLineage(),
    runtimeEnvironment: 'test',
    stackClassification: 'non-production',
    provider: 'mock-provider',
    authorizationReference: 'issue-31-approved-run',
    authorizedByUserId: ids.user,
    authorizedAt: time.authorized,
    ...overrides,
  };
}

function intentLineage(overrides: Record<string, unknown> = {}) {
  return {
    ...runLineage(),
    intentId: ids.intent,
    purpose: 'activation',
    ...overrides,
  };
}

function batchLineage(overrides: Record<string, unknown> = {}) {
  return {
    ...intentLineage(),
    batchId: ids.batch,
    channel: 'push',
    ...overrides,
  };
}

function workIdentity(overrides: Record<string, unknown> = {}) {
  return {
    ...batchLineage(),
    endpointId: ids.endpoint,
    ...overrides,
  };
}

function expectedBatch(overrides: Record<string, unknown> = {}) {
  return {
    ...batchLineage(),
    sequence: 1,
    endpointCount: 1,
    createdAt: time.created,
    ...overrides,
  };
}

function expectedWork(overrides: Record<string, unknown> = {}) {
  return {
    ...workIdentity(),
    createdAt: time.created,
    ...overrides,
  };
}

function attemptReference(overrides: Record<string, unknown> = {}) {
  return {
    ...workIdentity(),
    attemptId: ids.attempt,
    attemptNumber: 1,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    ...attemptReference(),
    predecessorAttemptId: null,
    retryObligationId: null,
    scheduledAt: time.created,
    ...overrides,
  };
}

function attemptedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    ...attemptReference(),
    evidence: {
      id: ids.evidence,
      subject: { kind: 'attempt', attemptId: ids.attempt },
      sequence: 1,
      previousEvidenceId: null,
      state: 'attempted',
      recordedAt: time.created,
      provider: null,
      providerReference: null,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    },
    ...overrides,
  };
}

function failedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    ...attemptReference(),
    evidence: {
      id: ids.evidence2,
      subject: { kind: 'attempt', attemptId: ids.attempt },
      sequence: 2,
      previousEvidenceId: ids.evidence,
      state: 'failed',
      recordedAt: time.leased,
      provider: null,
      providerReference: null,
      proof: null,
      reasonCode: 'MOCK_RETRYABLE_FAILURE',
      diagnosticDigest: null,
    },
    ...overrides,
  };
}

function retryObligation(overrides: Record<string, unknown> = {}) {
  return {
    ...attemptReference(),
    obligationId: ids.obligation,
    failedEvidenceId: ids.evidence2,
    successorAttemptNumber: 2,
    createdAt: time.leased,
    ...overrides,
  };
}

function batchSetMember(overrides: Record<string, unknown> = {}) {
  return {
    ...intentLineage(),
    channel: 'push',
    ...overrides,
  };
}

function providerEffect(overrides: Record<string, unknown> = {}) {
  return {
    ...attemptReference(),
    provider: 'mock-provider',
    providerReference: 'mock-ref-1',
    ...overrides,
  };
}

function emptyReconciliation(overrides: Record<string, unknown> = {}) {
  return {
    ...runLineage(),
    expectedBatchSet: [batchSetMember()],
    actualBatchSet: [batchSetMember()],
    missingBatchSet: [],
    unexpectedBatchSet: [],
    expectedLogicalWorkSet: [workIdentity()],
    attemptedLogicalWorkSet: [workIdentity()],
    terminalOrUnknownSet: [workIdentity()],
    retainedDlqLogicalWorkSet: [],
    retryableFailedAttemptSet: [],
    fulfilledRetryObligationSet: [],
    orphanedRetryObligationSet: [],
    pendingRetryLogicalWorkSet: [],
    nonfinalHighestAttemptSet: [],
    retryDlqOverlapSet: [],
    invalidAttemptLineageSet: [],
    invalidEvidenceChainSet: [],
    providerClaimSet: [],
    mockSideEffectSet: [],
    missingMockSideEffectSet: [],
    unexpectedMockSideEffectSet: [],
    mockSideEffectWithoutWorkSet: [],
    mockSideEffectIdentityMismatchSet: [],
    missingAttemptSet: [],
    unexpectedAttemptSet: [],
    unaccountedWorkSet: [],
    unexpectedAccountingSet: [],
    terminalDlqOverlapSet: [],
    expectedLogicalWorkCount: 1,
    terminalOrUnknownCount: 1,
    retainedDlqLogicalWorkCount: 0,
    mockLogicalSendCount: 0,
    duplicateMockSendCount: 0,
    status: 'reconciled',
    reconciledAt: time.completed,
    ...overrides,
  };
}

describe('failure-drill runtime contracts', () => {
  test('exports the contract surface from the package index', () => {
    expect(Contracts.FailureDrillSafeRunAdmissionSchema).toBe(
      FailureDrillSafeRunAdmissionSchema,
    );
    expect(Contracts.FailureDrillReconciliationResultSchema).toBe(
      FailureDrillReconciliationResultSchema,
    );
  });

  test('admits exactly test, non-production, synthetic, mocked DRILL runs', () => {
    const parsed = FailureDrillSafeRunAdmissionSchema.parse(admission());
    expect(parsed.runtimeEnvironment).toBe('test');
    expect(parsed.classificationMarker).toBe('DRILL');
    expect(parsed.provider).toBe('mock-provider');
    expect(Object.isFrozen(parsed)).toBe(true);

    const unsafeSubstitutions = [
      { runtimeEnvironment: 'production' },
      { stackClassification: 'production' },
      { rosterPopulation: 'staff' },
      { providerMode: 'live' },
      { provider: 'twilio' },
      { eventKind: 'incident' },
      { templateMode: 'real' },
      { classificationMarker: 'INCIDENT' },
      { destination: 'forbidden-destination' },
      { studentId: ids.endpoint2 },
    ];
    for (const substitution of unsafeSubstitutions) {
      expect(
        FailureDrillSafeRunAdmissionSchema.safeParse(admission(substitution))
          .success,
      ).toBe(false);
    }
  });

  test('seals a complete immutable expected identity set before enqueue', () => {
    const parsed = FailureDrillExpectedWorkPlanSchema.parse({
      admission: admission(),
      batches: [expectedBatch()],
      expectedWork: [expectedWork()],
      expectedWorkCount: 1,
      sealedAt: time.sealed,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.batches)).toBe(true);
    expect(Object.isFrozen(parsed.expectedWork)).toBe(true);

    expect(
      FailureDrillExpectedWorkPlanSchema.safeParse({
        ...parsed,
        expectedWork: [expectedWork(), expectedWork()],
        expectedWorkCount: 2,
      }).success,
    ).toBe(false);
    expect(
      FailureDrillExpectedWorkPlanSchema.safeParse({
        ...parsed,
        batches: [
          expectedBatch(),
          expectedBatch({ batchId: ids.batch2, sequence: 2 }),
        ],
      }).success,
    ).toBe(false);
    expect(
      FailureDrillExpectedWorkPlanSchema.safeParse({
        ...parsed,
        expectedWorkCount: 2,
      }).success,
    ).toBe(false);
    expect(
      FailureDrillExpectedWorkPlanSchema.safeParse({
        ...parsed,
        expectedWork: [expectedWork({ channel: 'email' })],
      }).success,
    ).toBe(false);
    expect(
      FailureDrillExpectedWorkPlanSchema.safeParse({
        ...parsed,
        sealedAt: '2026-08-13T19:59:59.000Z',
      }).success,
    ).toBe(false);
  });

  test('enforces stable contiguous attempts and one successor per obligation', () => {
    const second = attempt({
      attemptId: ids.attempt2,
      attemptNumber: 2,
      predecessorAttemptId: ids.attempt,
      retryObligationId: ids.obligation,
    });
    expect(
      FailureDrillAttemptSetSchema.safeParse([attempt(), second]).success,
    ).toBe(true);
    expect(
      FailureDrillAttemptSetSchema.safeParse([attempt(), attempt()]).success,
    ).toBe(false);
    expect(
      FailureDrillAttemptSetSchema.safeParse([
        attempt(),
        { ...second, attemptNumber: 3 },
      ]).success,
    ).toBe(false);
    expect(
      FailureDrillAttemptSetSchema.safeParse([
        attempt(),
        { ...second, predecessorAttemptId: ids.endpoint2 },
      ]).success,
    ).toBe(false);
    expect(
      FailureDrillAttemptSetSchema.safeParse([
        attempt(),
        { ...second, channel: 'email' },
      ]).success,
    ).toBe(false);
    expect(
      FailureDrillAttemptSchema.safeParse({
        ...attempt(),
        destination: 'synthetic@example.invalid',
      }).success,
    ).toBe(false);
  });

  test('validates append-only evidence with the canonical transition policy', () => {
    expect(
      FailureDrillAttemptEvidenceSetSchema.safeParse([
        attemptedEvidence(),
        failedEvidence(),
      ]).success,
    ).toBe(true);

    const repeatedAttempted = failedEvidence({
      evidence: {
        ...failedEvidence().evidence,
        state: 'attempted',
        reasonCode: null,
      },
    });
    expect(
      FailureDrillAttemptEvidenceSetSchema.safeParse([
        attemptedEvidence(),
        repeatedAttempted,
      ]).success,
    ).toBe(false);
    expect(
      FailureDrillAttemptEvidenceSetSchema.safeParse([
        attemptedEvidence(),
        failedEvidence({
          evidence: {
            ...failedEvidence().evidence,
            previousEvidenceId: ids.batch2,
          },
        }),
      ]).success,
    ).toBe(false);

    const liveProviderFact = {
      ...attemptedEvidence(),
      evidence: {
        ...attemptedEvidence().evidence,
        provider: 'live-provider',
      },
    };
    expect(
      FailureDrillAttemptEvidenceFactSchema.safeParse(liveProviderFact).success,
    ).toBe(false);
  });

  test('keeps unknown distinct and forbids provider acceptance as terminal', () => {
    const unknown = {
      ...failedEvidence(),
      evidence: {
        ...failedEvidence().evidence,
        state: 'unknown',
        reasonCode: 'MOCK_OUTCOME_UNKNOWN',
      },
    };
    expect(
      FailureDrillAttemptEvidenceSetSchema.safeParse([
        attemptedEvidence(),
        unknown,
      ]).success,
    ).toBe(true);
    expect(
      FailureDrillTerminalOutcomeSchema.safeParse({
        kind: 'provider-accepted',
        state: 'provider-accepted',
      }).success,
    ).toBe(false);
    const disposition = {
      ...attemptReference(),
      dispositionId: ids.disposition,
      evidenceId: ids.evidence2,
      outcome: { kind: 'unknown', state: 'unknown' },
      reasonCode: 'MOCK_OUTCOME_UNKNOWN',
      recordedAt: time.completed,
    };
    expect(
      FailureDrillTerminalDispositionSchema.safeParse(disposition).success,
    ).toBe(true);
    expect(
      FailureDrillTerminalDispositionSetSchema.safeParse([
        disposition,
        { ...disposition, dispositionId: ids.observation2 },
      ]).success,
    ).toBe(false);
  });

  test('makes retryable failure inseparable from a durable obligation', () => {
    const retryable = {
      attempt: attempt(),
      failedEvidence: failedEvidence(),
      obligation: retryObligation(),
    };
    expect(
      FailureDrillRetryableFailureSchema.safeParse(retryable).success,
    ).toBe(true);
    expect(
      FailureDrillRetryableFailureSchema.safeParse({
        attempt: attempt(),
        failedEvidence: failedEvidence(),
      }).success,
    ).toBe(false);
    expect(
      FailureDrillRetryableFailureSchema.safeParse({
        ...retryable,
        obligation: retryObligation({ successorAttemptNumber: 3 }),
      }).success,
    ).toBe(false);
    expect(
      FailureDrillRetryableFailureSchema.safeParse({
        ...retryable,
        failedEvidence: {
          ...failedEvidence(),
          evidence: {
            ...failedEvidence().evidence,
            state: 'unknown',
            reasonCode: 'MOCK_OUTCOME_UNKNOWN',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      FailureDrillRetryableFailureSchema.safeParse({
        ...retryable,
        failedEvidence: failedEvidence({ channel: 'email' }),
      }).success,
    ).toBe(false);
    expect(
      FailureDrillRetryableFailureSchema.safeParse({
        ...retryable,
        obligation: retryObligation({ intentId: ids.batch2 }),
      }).success,
    ).toBe(false);
    expect(
      FailureDrillRetryObligationSetSchema.safeParse([
        retryObligation(),
        retryObligation(),
      ]).success,
    ).toBe(false);

    const fulfillment = {
      ...attemptReference(),
      fulfillmentId: ids.fulfillment,
      obligationId: ids.obligation,
      fulfilledAt: time.completed,
      kind: 'successor-attempt',
      successorAttemptId: ids.attempt2,
      successorAttemptNumber: 2,
    };
    expect(
      FailureDrillRetryFulfillmentSetSchema.safeParse([fulfillment]).success,
    ).toBe(true);
    expect(
      FailureDrillRetryFulfillmentSetSchema.safeParse([
        fulfillment,
        { ...fulfillment, fulfillmentId: ids.observation2 },
      ]).success,
    ).toBe(false);
  });

  test('retains append-only schedule, lease, and completion identity', () => {
    const scheduled = {
      ...attemptReference(),
      factId: ids.execution1,
      sequence: 1,
      previousFactId: null,
      state: 'scheduled',
      leaseId: null,
      leaseExpiresAt: null,
      recordedAt: time.created,
    };
    const leased = {
      ...attemptReference(),
      factId: ids.execution2,
      sequence: 2,
      previousFactId: ids.execution1,
      state: 'leased',
      leaseId: ids.lease,
      leaseExpiresAt: time.expires,
      recordedAt: time.leased,
    };
    const completed = {
      ...attemptReference(),
      factId: ids.execution3,
      sequence: 3,
      previousFactId: ids.execution2,
      state: 'completed',
      leaseId: ids.lease,
      leaseExpiresAt: time.expires,
      recordedAt: time.completed,
    };
    expect(
      FailureDrillExecutionFactSetSchema.safeParse([
        scheduled,
        leased,
        completed,
      ]).success,
    ).toBe(true);
    expect(
      FailureDrillExecutionFactSetSchema.safeParse([
        scheduled,
        { ...leased, state: 'completed' },
      ]).success,
    ).toBe(false);
    expect(
      FailureDrillExecutionFactSetSchema.safeParse([
        scheduled,
        { ...leased, leaseId: null },
      ]).success,
    ).toBe(false);
  });

  test('retains exact run-specific DLQ chains and rejects duplicate facts', () => {
    const retained = {
      ...attemptReference(),
      factId: ids.dlqFact,
      dlqEntryId: ids.dlqEntry,
      sequence: 1,
      previousFactId: null,
      state: 'retained',
      recordedAt: time.created,
    };
    const redriven = {
      ...attemptReference(),
      factId: ids.dlqFact2,
      dlqEntryId: ids.dlqEntry,
      sequence: 2,
      previousFactId: ids.dlqFact,
      state: 'redriven',
      recordedAt: time.completed,
    };
    expect(
      FailureDrillDlqFactSetSchema.safeParse([retained, redriven]).success,
    ).toBe(true);
    expect(
      FailureDrillDlqFactSetSchema.safeParse([retained, retained]).success,
    ).toBe(false);
    expect(
      FailureDrillDlqFactSetSchema.safeParse([
        retained,
        { ...redriven, state: 'retained' },
      ]).success,
    ).toBe(false);
  });

  test('records one row per exact mock side effect and no destination', () => {
    const observation = {
      observationId: ids.observation,
      effect: providerEffect(),
      observedAt: time.leased,
    };
    expect(
      FailureDrillMockSideEffectObservationSetSchema.safeParse([observation])
        .success,
    ).toBe(true);
    expect(
      FailureDrillMockSideEffectObservationSetSchema.safeParse([
        observation,
        { ...observation, observationId: ids.observation2 },
      ]).success,
    ).toBe(false);
    expect(
      FailureDrillMockSideEffectObservationSetSchema.safeParse([
        {
          ...observation,
          effect: { ...providerEffect(), destination: 'forbidden-destination' },
        },
      ]).success,
    ).toBe(false);
    expect(
      FailureDrillProviderEffectIdentitySetSchema.safeParse([
        providerEffect(),
        providerEffect(),
      ]).success,
    ).toBe(false);
  });

  test('accepts only a mathematically complete reconciled steady state', () => {
    const parsed = FailureDrillReconciliationResultSchema.parse(
      emptyReconciliation(),
    );
    expect(parsed.status).toBe('reconciled');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.expectedLogicalWorkSet)).toBe(true);

    expect(
      FailureDrillReconciliationResultSchema.safeParse(
        emptyReconciliation({ status: 'diverged' }),
      ).success,
    ).toBe(false);
    expect(
      FailureDrillReconciliationResultSchema.safeParse(
        emptyReconciliation({ expectedLogicalWorkCount: 2 }),
      ).success,
    ).toBe(false);
  });

  test('derives missing and unaccounted work instead of trusting empty claims', () => {
    const divergence = emptyReconciliation({
      actualBatchSet: [],
      missingBatchSet: [batchSetMember()],
      attemptedLogicalWorkSet: [],
      terminalOrUnknownSet: [],
      missingAttemptSet: [workIdentity()],
      unaccountedWorkSet: [workIdentity()],
      terminalOrUnknownCount: 0,
      status: 'diverged',
    });
    expect(
      FailureDrillReconciliationResultSchema.safeParse(divergence).success,
    ).toBe(true);
    expect(
      FailureDrillReconciliationResultSchema.safeParse({
        ...divergence,
        missingAttemptSet: [],
      }).success,
    ).toBe(false);
    expect(
      FailureDrillReconciliationResultSchema.safeParse({
        ...divergence,
        status: 'reconciled',
      }).success,
    ).toBe(false);
    expect(
      FailureDrillReconciliationResultSchema.safeParse(
        emptyReconciliation({
          attemptedLogicalWorkSet: [workIdentity({ channel: 'email' })],
          terminalOrUnknownSet: [workIdentity({ channel: 'email' })],
        }),
      ).success,
    ).toBe(false);
  });

  test('derives exact provider-observer differences', () => {
    const effect = providerEffect();
    const missingEffect = emptyReconciliation({
      providerClaimSet: [effect],
      missingMockSideEffectSet: [effect],
      status: 'diverged',
    });
    expect(
      FailureDrillReconciliationResultSchema.safeParse(missingEffect).success,
    ).toBe(true);
    expect(
      FailureDrillReconciliationResultSchema.safeParse({
        ...missingEffect,
        missingMockSideEffectSet: [],
      }).success,
    ).toBe(false);
  });

  test('counts logical duplicate sends across distinct attempts', () => {
    const first = providerEffect();
    const second = providerEffect({
      attemptId: ids.attempt2,
      attemptNumber: 2,
      providerReference: 'mock-ref-2',
    });
    const duplicate = emptyReconciliation({
      providerClaimSet: [first, second],
      mockSideEffectSet: [first, second],
      mockLogicalSendCount: 1,
      duplicateMockSendCount: 1,
      status: 'diverged',
    });
    expect(
      FailureDrillReconciliationResultSchema.safeParse(duplicate).success,
    ).toBe(true);
    expect(
      FailureDrillReconciliationResultSchema.safeParse({
        ...duplicate,
        duplicateMockSendCount: 0,
      }).success,
    ).toBe(false);
  });
});
