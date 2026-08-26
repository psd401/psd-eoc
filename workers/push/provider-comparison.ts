import { UuidSchema } from '@psd-eoc/contracts';

import {
  APNS_DIRECT_PROVIDER,
  FCM_DIRECT_PROVIDER,
  type DirectPushProvider,
} from './direct-protocol';

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_DIGEST = /^[a-f0-9]{64}$/u;
const CLASSIFICATIONS = new Set([
  'provider-accepted',
  'terminal-failure',
  'retryable-failure',
  'unknown',
  'expired',
  'endpoint-invalidating-failure',
]);

export interface PushProviderComparisonSample {
  readonly attemptId: string;
  readonly cohortId: string;
  readonly logicalNotificationId: string;
  readonly endpointReferenceDigest: string;
  readonly provider: DirectPushProvider | 'expo-push';
  readonly platform: 'ios' | 'android';
  readonly durationMilliseconds: number;
  readonly classification: string;
  readonly providerReference: string | null;
}

export interface PushProviderComparisonSummary {
  readonly provider: DirectPushProvider | 'expo-push';
  readonly platform: 'ios' | 'android';
  readonly attemptCount: 100;
  readonly p95Milliseconds: number;
  readonly duplicateReferenceCount: 0;
  readonly unclassifiedCount: 0;
}

/**
 * Token-free comparison evidence gate. It does not perform provider I/O; a
 * human-controlled run supplies exactly 100 sanitized immutable samples.
 */
export function summarizePushProviderComparison(
  values: readonly PushProviderComparisonSample[],
): PushProviderComparisonSummary {
  if (values.length !== 100) {
    throw new TypeError('Push provider comparison requires 100 attempts.');
  }
  const provider = values[0]?.provider;
  const platform = values[0]?.platform;
  const cohortId = values[0]?.cohortId;
  const expectedPlatform =
    provider === APNS_DIRECT_PROVIDER
      ? 'ios'
      : provider === FCM_DIRECT_PROVIDER
        ? 'android'
        : provider === 'expo-push'
          ? platform
          : null;
  const attemptIds = new Set<string>();
  const logicalNotificationIds = new Set<string>();
  const providerReferences = new Set<string>();
  const durations: number[] = [];
  for (const sample of values) {
    if (
      expectedPlatform === null ||
      platform !== expectedPlatform ||
      sample.provider !== provider ||
      sample.platform !== platform ||
      sample.cohortId !== cohortId ||
      !UuidSchema.safeParse(sample.cohortId).success ||
      !UuidSchema.safeParse(sample.logicalNotificationId).success ||
      logicalNotificationIds.has(sample.logicalNotificationId) ||
      !SAFE_DIGEST.test(sample.endpointReferenceDigest) ||
      !UuidSchema.safeParse(sample.attemptId).success ||
      attemptIds.has(sample.attemptId) ||
      !Number.isSafeInteger(sample.durationMilliseconds) ||
      sample.durationMilliseconds < 0 ||
      sample.durationMilliseconds > 60_000 ||
      !CLASSIFICATIONS.has(sample.classification) ||
      (sample.providerReference !== null &&
        !SAFE_REFERENCE.test(sample.providerReference)) ||
      (sample.providerReference !== null &&
        providerReferences.has(sample.providerReference))
    ) {
      throw new TypeError('Push provider comparison sample is invalid.');
    }
    attemptIds.add(sample.attemptId);
    logicalNotificationIds.add(sample.logicalNotificationId);
    if (sample.providerReference !== null) {
      providerReferences.add(sample.providerReference);
    }
    durations.push(sample.durationMilliseconds);
  }
  durations.sort((left, right) => left - right);
  const p95Milliseconds = durations[Math.ceil(durations.length * 0.95) - 1];
  if (p95Milliseconds === undefined || p95Milliseconds > 5_000) {
    throw new TypeError('Push provider comparison exceeded its p95 target.');
  }
  return Object.freeze({
    provider,
    platform,
    attemptCount: 100,
    p95Milliseconds,
    duplicateReferenceCount: 0,
    unclassifiedCount: 0,
  }) as PushProviderComparisonSummary;
}

/** Proves baseline and candidate cohorts use distinct logical sends/endpoints. */
export function summarizeIsolatedPushProviderComparison(
  baseline: readonly PushProviderComparisonSample[],
  candidate: readonly PushProviderComparisonSample[],
): Readonly<{
  baseline: PushProviderComparisonSummary;
  candidate: PushProviderComparisonSummary;
}> {
  const baselineSummary = summarizePushProviderComparison(baseline);
  const candidateSummary = summarizePushProviderComparison(candidate);
  if (
    baselineSummary.provider !== 'expo-push' ||
    candidateSummary.provider === 'expo-push' ||
    baselineSummary.platform !== candidateSummary.platform ||
    baseline[0]?.cohortId === candidate[0]?.cohortId
  ) {
    throw new TypeError('Push provider comparison cohorts are not isolated.');
  }
  const baselineNotifications = new Set(
    baseline.map((sample) => sample.logicalNotificationId),
  );
  const baselineAttempts = new Set(baseline.map((sample) => sample.attemptId));
  const baselineEndpoints = new Set(
    baseline.map((sample) => sample.endpointReferenceDigest),
  );
  if (
    candidate.some(
      (sample) =>
        baselineNotifications.has(sample.logicalNotificationId) ||
        baselineAttempts.has(sample.attemptId) ||
        baselineEndpoints.has(sample.endpointReferenceDigest),
    )
  ) {
    throw new TypeError('Push provider comparison cohorts are not isolated.');
  }
  return Object.freeze({
    baseline: baselineSummary,
    candidate: candidateSummary,
  });
}
