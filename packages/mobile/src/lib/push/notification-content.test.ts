import { describe, expect, test } from 'bun:test';

import {
  foregroundBehaviorFor,
  parseMobilePushNotification,
  type PushNotificationContent,
} from './notification-content';

const payload = Object.freeze({
  version: 1 as const,
  eventId: '00000000-0000-4000-8000-000000002301',
  eventKind: 'incident' as const,
  templateMode: 'real' as const,
  facilityId: '00000000-0000-4000-8000-000000002302',
  eventTypeVersionId: '00000000-0000-4000-8000-000000002303',
  purpose: 'activation' as const,
});

function content(
  overrides: Partial<PushNotificationContent> = {},
): PushNotificationContent {
  return {
    title: '[INCIDENT] Synthetic alert',
    body: '[INCIDENT] Synthetic instructions.',
    data: payload,
    ...overrides,
  };
}

describe('mobile push notification content', () => {
  test('accepts exact canonical data only when all visible copy matches real classification', () => {
    expect(parseMobilePushNotification(content())).toEqual(payload);
    expect(foregroundBehaviorFor(content())).toEqual({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    });
  });

  test('suppresses malformed, incomplete, and classification-confused foreground notifications', () => {
    const invalidContents = [
      content({ data: { ...payload, facilityId: undefined } }),
      content({ data: { ...payload, eventKind: 'drill' } }),
      content({ title: '[DRILL] Synthetic alert' }),
      content({ body: '[DRILL] Synthetic instructions.' }),
      content({ title: '[INCIDENT] Synthetic [DRILL] alert' }),
      content({ body: null }),
      content({ title: null }),
    ];

    for (const invalid of invalidContents) {
      expect(parseMobilePushNotification(invalid)).toBeNull();
      expect(foregroundBehaviorFor(invalid)).toEqual({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      });
    }
  });

  test('keeps drill notifications distinctly and consistently marked', () => {
    const drill = content({
      title: '[DRILL] Synthetic drill alert',
      body: '[DRILL] Synthetic drill instructions.',
      data: {
        ...payload,
        eventKind: 'test',
        templateMode: 'drill',
      },
    });
    expect(parseMobilePushNotification(drill)).toMatchObject({
      eventKind: 'test',
      templateMode: 'drill',
    });
  });
});
