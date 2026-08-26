import { describe, expect, test } from 'bun:test';

import {
  FAILURE_DRILL_SCENARIO_IDS,
  assertCompletedFailureDrillManifest,
  assertSuccessfulFailureDrillManifest,
  parseFocusedFailureDrillResult,
  parseFailureDrillManifest,
  reconcileSideEffects,
  type FailureDrillManifest,
} from './contract';

function manifest(): FailureDrillManifest {
  const attemptIdentity =
    'attempt:00000000-0000-4000-8000-000000000013:endpoint:00000000-0000-4000-8000-000000000012';
  const secondAttemptIdentity =
    'attempt:00000000-0000-4000-8000-000000000014:endpoint:00000000-0000-4000-8000-000000000015';
  const callbackIdentity =
    'callback:00000000-0000-4000-8000-000000000018:attempt:00000000-0000-4000-8000-000000000013:endpoint:00000000-0000-4000-8000-000000000012';
  return {
    schemaVersion: 1,
    runId: 'issue-31-a1b2c3d4',
    revision: {
      sourceSha: '1'.repeat(40),
      imageDigest: `sha256:${'2'.repeat(64)}`,
      stackId:
        'arn:aws:cloudformation:us-west-2:111111111111:stack/PsdEocFailureDrill-issue-31-a1b2c3d4/123',
    },
    safety: {
      deploymentClass: 'non-production',
      providerMode: 'mocked',
      rosterPopulation: 'synthetic',
      recipientDomain: 'example.invalid',
    },
    startedAt: '2026-08-25T12:00:00.000Z',
    completedAt: '2026-08-25T12:10:00.000Z',
    scenarios: FAILURE_DRILL_SCENARIO_IDS.map((id) => ({
      id,
      status: 'passed',
      observation: `Synthetic observation for ${id}.`,
      alarmTransitions:
        id === 'aurora-failover'
          ? [
              {
                alarmName: `psd-eoc-drill-issue-31-a1b2c3d4-aurora-acu`,
                state: 'OK' as const,
                phase: 'before' as const,
                observedAt: '2026-08-25T12:01:00.000Z',
                stateUpdatedAt: '2026-08-25T12:00:00.000Z',
              },
              {
                alarmName: `psd-eoc-drill-issue-31-a1b2c3d4-apprunner-5xx`,
                state: 'OK' as const,
                phase: 'before' as const,
                observedAt: '2026-08-25T12:01:00.000Z',
                stateUpdatedAt: '2026-08-25T12:00:00.000Z',
              },
              {
                alarmName: `psd-eoc-drill-issue-31-a1b2c3d4-aurora-acu`,
                state: 'OK' as const,
                phase: 'after' as const,
                observedAt: '2026-08-25T12:02:00.000Z',
                stateUpdatedAt: '2026-08-25T12:00:00.000Z',
              },
              {
                alarmName: `psd-eoc-drill-issue-31-a1b2c3d4-apprunner-5xx`,
                state: 'OK' as const,
                phase: 'after' as const,
                observedAt: '2026-08-25T12:02:00.000Z',
                stateUpdatedAt: '2026-08-25T12:00:00.000Z',
              },
            ]
          : id === 'dlq-redrive'
            ? [
                {
                  alarmName: `psd-eoc-drill-issue-31-a1b2c3d4-dlq-2`,
                  state: 'OK' as const,
                  phase: 'before' as const,
                  observedAt: '2026-08-25T12:01:00.000Z',
                  stateUpdatedAt: '2026-08-25T12:00:00.000Z',
                },
                {
                  alarmName: `psd-eoc-drill-issue-31-a1b2c3d4-dlq-2`,
                  state: 'ALARM' as const,
                  phase: 'during' as const,
                  observedAt: '2026-08-25T12:02:00.000Z',
                  stateUpdatedAt: '2026-08-25T12:02:00.000Z',
                },
                {
                  alarmName: `psd-eoc-drill-issue-31-a1b2c3d4-dlq-2`,
                  state: 'OK' as const,
                  phase: 'after' as const,
                  observedAt: '2026-08-25T12:03:00.000Z',
                  stateUpdatedAt: '2026-08-25T12:03:00.000Z',
                },
              ]
            : [],
      invariants: {
        appendOnlyHistory: {
          status: 'preserved',
          evidence: [`${id}: append-only evidence`],
        },
        authorization: {
          status: 'preserved',
          evidence: [`${id}: authorization evidence`],
        },
        classification: {
          status: 'preserved',
          evidence: [`${id}: classification evidence`],
        },
        honestUnknown: {
          status: 'preserved',
          evidence: [`${id}: unknown evidence`],
        },
      },
      facts:
        id === 'worker-termination-mid-fanout'
          ? { fanoutEndpointCount: 2, logicalSideEffectCount: 2 }
          : id === 'dlq-redrive'
            ? {
                attemptId: '00000000-0000-4000-8000-000000000013',
                endpointId: '00000000-0000-4000-8000-000000000012',
                eventId: '00000000-0000-4000-8000-000000000016',
                evidenceId: '00000000-0000-4000-8000-000000000017',
                evidenceState: 'attempted',
              }
            : id === 'duplicate-provider-callback'
              ? {
                  callbackId: '00000000-0000-4000-8000-000000000018',
                  attemptId: '00000000-0000-4000-8000-000000000013',
                  endpointId: '00000000-0000-4000-8000-000000000012',
                  callbackClaimId: '00000000-0000-4000-8000-000000000019',
                  capabilityEvidenceId: '00000000-0000-4000-8000-000000000020',
                  capabilityEvidenceSequence: 2,
                  firstStatus: 204,
                  replayStatus: 204,
                }
              : { scenario: id },
      sideEffects:
        id === 'worker-termination-mid-fanout'
          ? reconcileSideEffects(
              [attemptIdentity, secondAttemptIdentity],
              [attemptIdentity, secondAttemptIdentity],
            )
          : id === 'dlq-redrive' || id === 'delayed-callback-after-all-clear'
            ? reconcileSideEffects([attemptIdentity], [attemptIdentity])
            : id === 'duplicate-provider-callback'
              ? reconcileSideEffects([callbackIdentity], [callbackIdentity])
              : reconcileSideEffects([], []),
    })),
    cleanup: {
      status: 'pending',
      stackName: 'PsdEocFailureDrill-issue-31-a1b2c3d4',
      remainingResources: [],
    },
  };
}

describe('failure-drill evidence contract', () => {
  test('accepts exactly eight scenarios bound to one revision', () => {
    const value = manifest();
    expect(parseFailureDrillManifest(value)).toEqual(value);
    expect(() => assertSuccessfulFailureDrillManifest(value)).not.toThrow();
    expect(() => assertCompletedFailureDrillManifest(value)).toThrow(
      'cleanup is not complete',
    );
    expect(() =>
      assertCompletedFailureDrillManifest({
        ...value,
        cleanup: { ...value.cleanup, status: 'complete' },
      }),
    ).not.toThrow();
  });

  test('rejects missing, duplicate, or revisionless evidence', () => {
    const missing = manifest();
    expect(() =>
      parseFailureDrillManifest({
        ...missing,
        scenarios: missing.scenarios.slice(1),
      }),
    ).toThrow('all eight drills once');
    expect(() =>
      parseFailureDrillManifest({
        ...missing,
        revision: { ...missing.revision, sourceSha: 'moving-branch' },
      }),
    ).toThrow('exact Git commit');
  });

  test('reports zero, missing, unexpected, and duplicate mock side effects', () => {
    expect(
      reconcileSideEffects(
        ['attempt:a', 'attempt:b'],
        ['attempt:b', 'attempt:b', 'attempt:c'],
      ),
    ).toEqual({
      expected: ['attempt:a', 'attempt:b'],
      observed: ['attempt:b', 'attempt:b', 'attempt:c'],
      missing: ['attempt:a'],
      unexpected: ['attempt:c'],
      duplicates: ['attempt:b'],
    });
  });

  test('strictly parses one primitive, evidence-derived focused result', () => {
    const scenarioId = 'worker-termination-mid-fanout';
    const result = {
      kind: 'failure-drill-focused-result',
      scenarioId,
      expectedSideEffects: ['attempt:a:endpoint:b'],
      observedSideEffects: ['attempt:a:endpoint:b'],
      facts: { count: 1, retained: true },
    } as const;
    expect(
      parseFocusedFailureDrillResult(JSON.stringify(result), scenarioId),
    ).toEqual(result);
    for (const invalid of [
      { ...result, expectedSideEffects: [1] },
      { ...result, observedSideEffects: [{}] },
      { ...result, facts: {} },
      { ...result, facts: { nested: { value: true } } },
    ]) {
      expect(() =>
        parseFocusedFailureDrillResult(JSON.stringify(invalid), scenarioId),
      ).toThrow('invalid evidence');
    }
    expect(() =>
      parseFocusedFailureDrillResult(
        `${JSON.stringify(result)}\n${JSON.stringify(result)}`,
        scenarioId,
      ),
    ).toThrow('exactly one structured result');
  });

  test('fails the run on any scenario or side-effect divergence', () => {
    const value = manifest();
    const scenarios = value.scenarios.map((scenario, index) =>
      index === 0
        ? {
            ...scenario,
            sideEffects: reconcileSideEffects(
              ['attempt:expected'],
              ['attempt:unexpected'],
            ),
          }
        : scenario,
    );
    expect(() =>
      assertSuccessfulFailureDrillManifest({ ...value, scenarios }),
    ).toThrow('worker-termination-mid-fanout');
  });

  test('rejects a ledger whose claimed reconciliation differs from its identity sets', () => {
    const value = manifest();
    const scenarios = value.scenarios.map((scenario, index) =>
      index === 0
        ? {
            ...scenario,
            sideEffects: {
              expected: ['attempt:expected'],
              observed: ['attempt:unexpected'],
              missing: [],
              unexpected: [],
              duplicates: [],
            },
          }
        : scenario,
    );
    expect(() => parseFailureDrillManifest({ ...value, scenarios })).toThrow(
      'does not match its immutable identity sets',
    );
  });

  test('rejects descriptive reconciliation labels without immutable attempt and endpoint identities', () => {
    const value = manifest();
    const scenarios = value.scenarios.map((scenario) =>
      scenario.id === 'worker-termination-mid-fanout'
        ? {
            ...scenario,
            sideEffects: reconcileSideEffects(
              ['mock-attempt:worker-restart'],
              ['mock-attempt:worker-restart'],
            ),
          }
        : scenario,
    );
    expect(() => parseFailureDrillManifest({ ...value, scenarios })).toThrow(
      'evidence-derived immutable attempt and endpoint identities',
    );
    const oneEndpoint = value.scenarios.map((scenario) =>
      scenario.id === 'worker-termination-mid-fanout'
        ? {
            ...scenario,
            sideEffects: reconcileSideEffects(
              [scenario.sideEffects.expected[0]!],
              [scenario.sideEffects.observed[0]!],
            ),
          }
        : scenario,
    );
    expect(() =>
      parseFailureDrillManifest({ ...value, scenarios: oneEndpoint }),
    ).toThrow('multi-endpoint immutable fan-out set');
  });

  test('rejects incomplete or mislabeled CloudWatch recovery sequences', () => {
    const value = manifest();
    const missingAuroraAfter = value.scenarios.map((scenario) =>
      scenario.id === 'aurora-failover'
        ? {
            ...scenario,
            alarmTransitions: scenario.alarmTransitions.slice(0, -1),
          }
        : scenario,
    );
    expect(() =>
      parseFailureDrillManifest({
        ...value,
        scenarios: missingAuroraAfter,
      }),
    ).toThrow('exact before-and-after');

    const unrecoveredDlq = value.scenarios.map((scenario) =>
      scenario.id === 'dlq-redrive'
        ? {
            ...scenario,
            alarmTransitions: scenario.alarmTransitions.map((observation) =>
              observation.phase === 'after'
                ? { ...observation, state: 'ALARM' as const }
                : observation,
            ),
          }
        : scenario,
    );
    expect(() =>
      parseFailureDrillManifest({ ...value, scenarios: unrecoveredDlq }),
    ).toThrow('recovered OK');
  });

  test('rejects DLQ transport identities without persisted attempt evidence', () => {
    const value = manifest();
    const scenarios = value.scenarios.map((scenario) =>
      scenario.id === 'dlq-redrive'
        ? {
            ...scenario,
            facts: { ...scenario.facts, evidenceState: 'invented' },
          }
        : scenario,
    );
    expect(() => parseFailureDrillManifest({ ...value, scenarios })).toThrow(
      'persisted attempt, endpoint, event',
    );
  });

  test('refuses any live provider, recipient, or roster classification', () => {
    const value = manifest();
    expect(() =>
      parseFailureDrillManifest({
        ...value,
        safety: { ...value.safety, providerMode: 'live' },
      }),
    ).toThrow('synthetic-only');
  });
});
