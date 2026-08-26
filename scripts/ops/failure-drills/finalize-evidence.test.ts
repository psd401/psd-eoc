import { describe, expect, test } from 'bun:test';

import { parseCleanupObservation } from './finalize-evidence';

const STACK_NAME = 'PsdEocFailureDrill-issue-31-cleanup';

function observation() {
  return {
    stackName: STACK_NAME,
    stackAbsent: true,
    observedAt: '2026-08-26T12:00:00.000Z',
    checkedResources: ['AWS::RDS::DBCluster:synthetic-cluster'],
    remainingResources: [],
  } as const;
}

describe('failure-drill cleanup evidence', () => {
  test('accepts an exact-stack readback with at least one checked resource', () => {
    expect(parseCleanupObservation(observation(), STACK_NAME)).toEqual(
      observation(),
    );
  });

  test('rejects manufactured, mismatched, or incomplete cleanup claims', () => {
    const value = observation();
    for (const invalid of [
      { ...value, stackName: 'PsdEocFailureDrill-another-run' },
      { ...value, stackAbsent: false },
      { ...value, checkedResources: [] },
      { ...value, remainingResources: [null] },
    ]) {
      expect(() => parseCleanupObservation(invalid, STACK_NAME)).toThrow();
    }
  });
});
