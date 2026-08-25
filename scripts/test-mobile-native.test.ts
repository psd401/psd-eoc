import { describe, expect, test } from 'bun:test';

import { mobileNativeResultExitCode } from './test-mobile-native';

describe('mobile-native test gate', () => {
  test('accepts a passing Jest run with no pending tests', () => {
    expect(
      mobileNativeResultExitCode({ numPendingTests: 0, success: true }),
    ).toBe(0);
  });

  test('rejects failed or skipped Jest runs', () => {
    expect(
      mobileNativeResultExitCode({ numPendingTests: 0, success: false }),
    ).toBe(1);
    expect(
      mobileNativeResultExitCode({ numPendingTests: 1, success: true }),
    ).toBe(1);
  });
});
