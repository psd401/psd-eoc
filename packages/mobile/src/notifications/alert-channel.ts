import {
  AndroidImportance,
  AndroidNotificationVisibility,
} from 'expo-notifications/build/NotificationChannelManager.types';
import { setNotificationChannelAsync } from 'expo-notifications/build/setNotificationChannelAsync';
import { Platform } from 'react-native';

/** Stable channel ID shared with the expo-notifications config plugin. */
export const ALERT_NOTIFICATION_CHANNEL_ID = 'eoc-alerts';

/**
 * Creates the Android alert channel before later push-registration work runs.
 * This configures the local device only: it never requests permission, fetches
 * a push token, contacts a provider, or sends a notification.
 */
export async function configureAlertChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  await setNotificationChannelAsync(ALERT_NOTIFICATION_CHANNEL_ID, {
    name: 'PSD EOC incident and drill alerts',
    description: 'Incident and drill notifications from PSD EOC.',
    importance: AndroidImportance.MAX,
    // A request Android is free to ignore, and does: it stores
    // VISIBILITY_NO_OVERRIDE for an ordinary app's channel, which reads back
    // as UNKNOWN. Asking costs nothing on the phone makers that do honour it.
    // Nothing may assert on reading it back -- see `push/alert-channel-state`.
    enableVibrate: true,
    vibrationPattern: [0, 500, 250, 500],
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
    showBadge: true,
  });
}
