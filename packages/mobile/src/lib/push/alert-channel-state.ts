import { AndroidImportance } from 'expo-notifications/build/NotificationChannelManager.types';

import type { PushPermissionStatus } from './registration-controller';

/**
 * An Android notification channel as the operating system reports it back.
 *
 * Deliberately narrower than Expo's `NotificationChannel`: these are the only
 * fields any decision may read, and the field that is missing here is the
 * point. `lockscreenVisibility` is excluded so that no rule can be written
 * against it again.
 */
export interface AlertChannelReadback {
  readonly importance: number;
  readonly sound: string | null;
}

/**
 * Whether a granted Android permission still means push can be delivered.
 *
 * The app previously also required
 * `channel.lockscreenVisibility === AndroidNotificationVisibility.PUBLIC`.
 * Android does not honour `setLockscreenVisibility` from an ordinary
 * application -- it stores `VISIBILITY_NO_OVERRIDE`, which expo-notifications
 * maps through `NotificationVisibility.fromNativeValue` to `UNKNOWN`, whose
 * enum value is `0`, against a `PUBLIC` of `1`. That comparison was false on
 * every Android device that ever ran this app, so permission read as denied
 * however the person had their settings, no push token was ever requested, and
 * no Android device ever registered. A phone displays that same state as
 * "Default", because that is what it is.
 *
 * A channel that does not exist still denies: nothing can be presented through
 * it. Everything else is deliverable.
 */
export function androidPushPermission(
  base: PushPermissionStatus,
  channel: AlertChannelReadback | null,
): PushPermissionStatus {
  if (base !== 'granted') return base;
  return channel === null ? 'denied' : 'granted';
}

/**
 * Whether the channel will present an alert quietly.
 *
 * Reported to the person, never enforced. Importance and sound are both
 * user-editable, and Android locks a channel against the app once someone has
 * edited it, so the app cannot restore either. Treating them as a denial made
 * one settings change a permanent loss of push, because denial unregisters the
 * endpoint. A quiet notification still arrives and can still be read; one that
 * was never sent cannot be recovered.
 */
export function alertChannelMuted(
  channel: AlertChannelReadback | null,
): boolean {
  if (channel === null) return false;
  return !(
    channel.importance >= AndroidImportance.HIGH && channel.sound !== null
  );
}
