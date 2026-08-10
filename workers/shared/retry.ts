const SAFE_CODE_PATTERN = /^[A-Z0-9_]+$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMilliseconds: number;
  readonly maxDelayMilliseconds: number;
  readonly multiplier: number;
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 5,
  baseDelayMilliseconds: 1_000,
  maxDelayMilliseconds: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
});

export type ProviderFailureDisposition =
  | 'safe-to-retry'
  | 'terminal-failure'
  | 'ambiguous';

/** Adapter error containing only a bounded code and optional safe digest. */
export class ProviderDispatchError extends Error {
  public constructor(
    public readonly code: string,
    public readonly disposition: ProviderFailureDisposition,
    public readonly diagnosticDigest: string | null = null,
  ) {
    if (
      code.length < 1 ||
      code.length > 100 ||
      !SAFE_CODE_PATTERN.test(code) ||
      (diagnosticDigest !== null && !DIGEST_PATTERN.test(diagnosticDigest))
    ) {
      throw new TypeError('Provider failure metadata is invalid.');
    }
    super(`Provider dispatch failed with safe code ${code}.`);
    this.name = 'ProviderDispatchError';
  }
}

export interface ProviderFailure {
  readonly code: string;
  readonly disposition: ProviderFailureDisposition;
  readonly diagnosticDigest: string | null;
}

export type RetryDecision =
  | Readonly<{
      kind: 'retry';
      delayMilliseconds: number;
      nextAttemptNumber: number;
      failure: ProviderFailure;
    }>
  | Readonly<{
      kind: 'dlq';
      reasonCode: string;
      truthState: 'failed' | 'unknown';
      exhausted: boolean;
      failure: ProviderFailure;
    }>;

export function parseRetryPolicy(value: RetryPolicy): RetryPolicy {
  if (
    !Number.isInteger(value.maxAttempts) ||
    value.maxAttempts < 1 ||
    value.maxAttempts > 10 ||
    !Number.isInteger(value.baseDelayMilliseconds) ||
    value.baseDelayMilliseconds < 100 ||
    value.baseDelayMilliseconds > 60_000 ||
    !Number.isInteger(value.maxDelayMilliseconds) ||
    value.maxDelayMilliseconds < value.baseDelayMilliseconds ||
    value.maxDelayMilliseconds > 15 * 60_000 ||
    !Number.isFinite(value.multiplier) ||
    value.multiplier < 1 ||
    value.multiplier > 10 ||
    !Number.isFinite(value.jitterRatio) ||
    value.jitterRatio < 0 ||
    value.jitterRatio > 1
  ) {
    throw new TypeError('Notification retry policy is invalid.');
  }
  return Object.freeze({ ...value });
}

export function normalizeProviderFailure(error: unknown): ProviderFailure {
  if (error instanceof ProviderDispatchError) {
    return Object.freeze({
      code: error.code,
      disposition: error.disposition,
      diagnosticDigest: error.diagnosticDigest,
    });
  }
  return Object.freeze({
    code: 'PROVIDER_OUTCOME_AMBIGUOUS',
    disposition: 'ambiguous',
    diagnosticDigest: null,
  });
}

export function calculateRetryDelayMilliseconds(
  currentAttemptNumber: number,
  policyValue: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const policy = parseRetryPolicy(policyValue);
  if (!Number.isInteger(currentAttemptNumber) || currentAttemptNumber < 1) {
    throw new TypeError('Notification attempt number is invalid.');
  }
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new TypeError('Notification retry random source is invalid.');
  }
  const exponential = Math.min(
    policy.maxDelayMilliseconds,
    policy.baseDelayMilliseconds *
      policy.multiplier ** (currentAttemptNumber - 1),
  );
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * randomValue;
  return Math.max(
    1,
    Math.min(policy.maxDelayMilliseconds, Math.round(exponential * jitter)),
  );
}

/** Unknown outcomes never retry blindly; terminal decisions explicitly redrive. */
export function decideProviderRetry(
  error: unknown,
  currentAttemptNumber: number,
  policyValue: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryDecision {
  const policy = parseRetryPolicy(policyValue);
  if (!Number.isInteger(currentAttemptNumber) || currentAttemptNumber < 1) {
    throw new TypeError('Notification attempt number is invalid.');
  }
  const failure = normalizeProviderFailure(error);
  if (
    failure.disposition === 'safe-to-retry' &&
    currentAttemptNumber < policy.maxAttempts
  ) {
    return Object.freeze({
      kind: 'retry',
      delayMilliseconds: calculateRetryDelayMilliseconds(
        currentAttemptNumber,
        policy,
        random,
      ),
      nextAttemptNumber: currentAttemptNumber + 1,
      failure,
    });
  }
  const ambiguous = failure.disposition === 'ambiguous';
  const exhausted = failure.disposition === 'safe-to-retry';
  return Object.freeze({
    kind: 'dlq',
    reasonCode: ambiguous
      ? 'PROVIDER_OUTCOME_AMBIGUOUS'
      : exhausted
        ? 'PROVIDER_RETRY_EXHAUSTED'
        : failure.code,
    truthState: ambiguous ? 'unknown' : 'failed',
    exhausted,
    failure,
  });
}
