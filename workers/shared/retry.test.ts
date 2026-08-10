import { describe, expect, test } from 'bun:test';

import {
  ProviderDispatchError,
  calculateRetryDelayMilliseconds,
  decideProviderRetry,
  parseRetryPolicy,
  type RetryPolicy,
} from './retry';

const POLICY = Object.freeze({
  maxAttempts: 4,
  baseDelayMilliseconds: 1_000,
  maxDelayMilliseconds: 5_000,
  multiplier: 2,
  jitterRatio: 0,
}) satisfies RetryPolicy;

describe('bounded retry and DLQ policy', () => {
  test('caps exponential backoff and redrives when the budget is exhausted', () => {
    expect(calculateRetryDelayMilliseconds(1, POLICY, () => 0.5)).toBe(1_000);
    expect(calculateRetryDelayMilliseconds(2, POLICY, () => 0.5)).toBe(2_000);
    expect(calculateRetryDelayMilliseconds(3, POLICY, () => 0.5)).toBe(4_000);
    expect(calculateRetryDelayMilliseconds(4, POLICY, () => 0.5)).toBe(5_000);

    const error = new ProviderDispatchError(
      'PROVIDER_THROTTLED',
      'safe-to-retry',
    );
    expect(decideProviderRetry(error, 3, POLICY, () => 0.5)).toEqual({
      kind: 'retry',
      delayMilliseconds: 4_000,
      nextAttemptNumber: 4,
      failure: {
        code: 'PROVIDER_THROTTLED',
        disposition: 'safe-to-retry',
        diagnosticDigest: null,
      },
    });
    expect(decideProviderRetry(error, 4, POLICY, () => 0.5)).toEqual({
      kind: 'dlq',
      reasonCode: 'PROVIDER_RETRY_EXHAUSTED',
      truthState: 'failed',
      exhausted: true,
      failure: {
        code: 'PROVIDER_THROTTLED',
        disposition: 'safe-to-retry',
        diagnosticDigest: null,
      },
    });
  });

  test('sends ambiguous outcomes to unknown and never retries them blindly', () => {
    expect(
      decideProviderRetry(new Error('provider response lost'), 1, POLICY),
    ).toEqual({
      kind: 'dlq',
      reasonCode: 'PROVIDER_OUTCOME_AMBIGUOUS',
      truthState: 'unknown',
      exhausted: false,
      failure: {
        code: 'PROVIDER_OUTCOME_AMBIGUOUS',
        disposition: 'ambiguous',
        diagnosticDigest: null,
      },
    });
    expect(
      decideProviderRetry(
        new ProviderDispatchError('ENDPOINT_INVALID', 'terminal-failure'),
        1,
        POLICY,
      ),
    ).toEqual({
      kind: 'dlq',
      reasonCode: 'ENDPOINT_INVALID',
      truthState: 'failed',
      exhausted: false,
      failure: {
        code: 'ENDPOINT_INVALID',
        disposition: 'terminal-failure',
        diagnosticDigest: null,
      },
    });
  });

  test('rejects policy or jitter sources outside hard bounds', () => {
    expect(() => parseRetryPolicy({ ...POLICY, maxAttempts: 100 })).toThrow(
      TypeError,
    );
    expect(() => calculateRetryDelayMilliseconds(1, POLICY, () => 1.1)).toThrow(
      TypeError,
    );
  });
});
