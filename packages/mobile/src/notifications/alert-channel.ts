import * as Notifications from 'expo-notifications';
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

  await Notifications.setNotificationChannelAsync(
    ALERT_NOTIFICATION_CHANNEL_ID,
    {
      name: 'PSD EOC incident and drill alerts',
      description: 'Incident and drill notifications from PSD EOC.',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 500, 250, 500],
      showBadge: true,
    },
  );
}
