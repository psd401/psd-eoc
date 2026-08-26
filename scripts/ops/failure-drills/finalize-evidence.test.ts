import { describe, expect, test } from 'bun:test';

import {
  classifyAppRunnerCleanupReadback,
  parseCleanupObservation,
} from './finalize-evidence';

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
  test('classifies App Runner deletion tombstones and missing services as absent', () => {
    expect(
      classifyAppRunnerCleanupReadback(
        0,
        JSON.stringify({ Service: { Status: 'DELETED' } }),
      ),
    ).toBe('absent');
    expect(
      classifyAppRunnerCleanupReadback(
        254,
        'An error occurred (ResourceNotFoundException) when calling DescribeService',
      ),
    ).toBe('absent');
  });

  test('classifies active App Runner states as present and fails closed on bad readback', () => {
    for (const status of [
      'RUNNING',
      'OPERATION_IN_PROGRESS',
      'DELETE_FAILED',
    ]) {
      expect(
        classifyAppRunnerCleanupReadback(
          0,
          JSON.stringify({ Service: { Status: status } }),
        ),
      ).toBe('present');
    }
    for (const [status, readback] of [
      [255, 'AccessDeniedException'],
      [0, '{'],
      [0, JSON.stringify({ Service: {} })],
    ] as const) {
      expect(() =>
        classifyAppRunnerCleanupReadback(status, readback),
      ).toThrow();
    }
  });

  test('runs the cleanup classifier CLI from the workflow infra directory', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '../scripts/ops/failure-drills/finalize-evidence.ts',
        'classify-apprunner-readback',
        '0',
        JSON.stringify({ Service: { Status: 'DELETED' } }),
      ],
      {
        cwd: new URL('../../../infra', import.meta.url).pathname,
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('absent');
  });

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
