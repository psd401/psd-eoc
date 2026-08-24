import {
  MobilePushReceivePayloadSchema,
  type Event,
  type NativeDevicePlatform,
} from '@psd-eoc/contracts';

import { isIssue21SyntheticFixtureEnabled } from './issue-21-synthetic-fixture';

export const ISSUE_32_SYNTHETIC_PUSH_TITLE =
  '[DRILL] Synthetic earthquake drill';
export const ISSUE_32_SYNTHETIC_PUSH_BODY =
  '[DRILL] Synthetic recipients only. Open the synthetic event room.';

export function isIssue32SyntheticPushFixtureEnabled(): boolean {
  return (
    isIssue21SyntheticFixtureEnabled() &&
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE === 'issue-32'
  );
}

export function issue32SyntheticPushContent(event: Event) {
  if (
    event.kind !== 'drill' ||
    event.templateMode !== 'drill' ||
    event.rosterPopulation !== 'synthetic'
  ) {
    throw new TypeError(
      'The issue-32 local push fixture accepts only a synthetic drill.',
    );
  }
  const data = MobilePushReceivePayloadSchema.parse({
    version: 1,
    eventId: event.id,
    eventKind: event.kind,
    templateMode: event.templateMode,
    facilityId: event.facilityId,
    eventTypeVersionId: event.eventTypeVersion.id,
    purpose: 'activation',
  });
  return Object.freeze({
    title: ISSUE_32_SYNTHETIC_PUSH_TITLE,
    body: ISSUE_32_SYNTHETIC_PUSH_BODY,
    data,
  });
}

function loadIssue32NotificationModules() {
  return Promise.all([
    import('expo-notifications/build/NotificationPermissions'),
    import('expo-notifications/build/scheduleNotificationAsync'),
    import('expo-notifications/build/Notifications.types'),
    import('../../notifications/alert-channel'),
    import('expo-notifications/build/cancelAllScheduledNotificationsAsync'),
    import('expo-notifications/build/dismissAllNotificationsAsync'),
  ] as const);
}

/** Warms the exact-gated native modules before the timed activation request. */
export async function preloadIssue32SyntheticPush(): Promise<void> {
  if (!isIssue32SyntheticPushFixtureEnabled()) {
    throw new TypeError('The issue-32 local push fixture is disabled.');
  }
  await loadIssue32NotificationModules();
}

/**
 * Schedules one provider-free OS notification for the issue-32 native journey.
 * The extra fixture flag, development-build check, and synthetic event checks
 * keep this seam unreachable from a production or real-incident build.
 */
export async function scheduleIssue32SyntheticPush(
  event: Event,
  platform: NativeDevicePlatform,
): Promise<void> {
  if (!isIssue32SyntheticPushFixtureEnabled()) {
    throw new TypeError('The issue-32 local push fixture is disabled.');
  }
  const [
    permissions,
    scheduler,
    notificationTypes,
    alertChannel,
    pendingNotifications,
    presentedNotifications,
  ] = await loadIssue32NotificationModules();
  const permission =
    platform === 'android'
      ? permissions.getPermissionsAsync()
      : permissions.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: true, allowSound: true },
        });
  const [permissionStatus] = await Promise.all([
    permission,
    pendingNotifications.cancelAllScheduledNotificationsAsync(),
    presentedNotifications.dismissAllNotificationsAsync(),
  ]);
  if (permissionStatus.granted !== true) {
    throw new Error('Synthetic notification permission was not granted.');
  }
  await scheduler.scheduleNotificationAsync({
    content: {
      ...issue32SyntheticPushContent(event),
    },
    trigger: {
      type: notificationTypes.SchedulableTriggerInputTypes.TIME_INTERVAL,
      channelId: alertChannel.ALERT_NOTIFICATION_CHANNEL_ID,
      repeats: false,
      seconds: 4,
    },
  });
}
