import { describe, expect, test } from 'bun:test';

import { assertIssue31TestResult } from './local-test-runner';

describe('issue-31 local failure-drill test gate', () => {
  test('accepts one successful summary and an exact focused pass', () => {
    expect(() =>
      assertIssue31TestResult({ exitCode: 0, output: ' 123 pass\n' }),
    ).not.toThrow();
    expect(() =>
      assertIssue31TestResult({ exitCode: 0, output: ' 1 pass\n' }, 1),
    ).not.toThrow();
  });

  test('rejects failed, skipped, todo, empty, duplicate, and broad focused runs', () => {
    const invalid = [
      { exitCode: 1, output: ' 1 fail\n' },
      { exitCode: 0, output: ' 0 pass\n 1 skip\n' },
      { exitCode: 0, output: ' 1 pass\n 1 todo\n' },
      { exitCode: 0, output: ' 0 pass\n' },
      { exitCode: 0, output: ' 1 pass\n 1 pass\n' },
    ] as const;
    for (const result of invalid) {
      expect(() => assertIssue31TestResult(result)).toThrow();
    }
    expect(() =>
      assertIssue31TestResult({ exitCode: 0, output: ' 2 pass\n' }, 1),
    ).toThrow();
  });
});
