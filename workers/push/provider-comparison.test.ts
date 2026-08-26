import { describe, expect, test } from 'bun:test';

import { APNS_DIRECT_PROVIDER, FCM_DIRECT_PROVIDER } from './direct-protocol';
import {
  summarizePushProviderComparison,
  summarizeIsolatedPushProviderComparison,
  type PushProviderComparisonSample,
} from './provider-comparison';

function samples(
  provider: 'expo-push' | 'apns-direct' | 'fcm-direct',
  platform: 'ios' | 'android' = provider === FCM_DIRECT_PROVIDER
    ? 'android'
    : 'ios',
  cohortOffset = 1,
): PushProviderComparisonSample[] {
  return Array.from({ length: 100 }, (_, index) => ({
    attemptId: `00000000-0000-4000-8000-${String(index + cohortOffset * 100).padStart(12, '0')}`,
    cohortId: `10000000-0000-4000-8000-${String(cohortOffset).padStart(12, '0')}`,
    logicalNotificationId: `20000000-0000-4000-8000-${String(index + cohortOffset * 100).padStart(12, '0')}`,
    endpointReferenceDigest: String(index + cohortOffset * 100).padStart(
      64,
      'a',
    ),
    provider,
    platform,
    durationMilliseconds: 900 + index * 10,
    classification: 'provider-accepted',
    providerReference: `synthetic-provider-reference-${index + 1}`,
  }));
}

describe('direct-push-cutover', () => {
  test('proves the sanitized 100-attempt APNs and FCM comparison contract', () => {
    expect(
      summarizePushProviderComparison(samples(APNS_DIRECT_PROVIDER)),
    ).toEqual({
      provider: APNS_DIRECT_PROVIDER,
      platform: 'ios',
      attemptCount: 100,
      p95Milliseconds: 1_840,
      duplicateReferenceCount: 0,
      unclassifiedCount: 0,
    });
    expect(
      summarizePushProviderComparison(samples(FCM_DIRECT_PROVIDER)),
    ).toEqual({
      provider: FCM_DIRECT_PROVIDER,
      platform: 'android',
      attemptCount: 100,
      p95Milliseconds: 1_840,
      duplicateReferenceCount: 0,
      unclassifiedCount: 0,
    });
  });

  test('fails closed on duplicates, unclassified results, or p95 above five seconds', () => {
    const duplicate = samples(APNS_DIRECT_PROVIDER);
    duplicate[99] = {
      ...duplicate[99]!,
      providerReference: duplicate[0]!.providerReference,
    };
    expect(() => summarizePushProviderComparison(duplicate)).toThrow();

    const unclassified = samples(FCM_DIRECT_PROVIDER);
    unclassified[0] = { ...unclassified[0]!, classification: 'delivered' };
    expect(() => summarizePushProviderComparison(unclassified)).toThrow();

    const slow = samples(APNS_DIRECT_PROVIDER);
    for (let index = 94; index < 100; index += 1) {
      slow[index] = { ...slow[index]!, durationMilliseconds: 5_001 };
    }
    expect(() => summarizePushProviderComparison(slow)).toThrow();
  });

  test('proves baseline and candidate use separate notifications, cohorts, and endpoints', () => {
    const baseline = samples('expo-push', 'ios', 1);
    const candidate = samples(APNS_DIRECT_PROVIDER, 'ios', 2);
    expect(
      summarizeIsolatedPushProviderComparison(baseline, candidate),
    ).toMatchObject({
      baseline: { provider: 'expo-push', platform: 'ios' },
      candidate: { provider: APNS_DIRECT_PROVIDER, platform: 'ios' },
    });

    candidate[0] = {
      ...candidate[0]!,
      logicalNotificationId: baseline[0]!.logicalNotificationId,
    };
    expect(() =>
      summarizeIsolatedPushProviderComparison(baseline, candidate),
    ).toThrow('not isolated');
  });
});
