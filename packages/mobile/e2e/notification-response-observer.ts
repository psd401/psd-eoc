import type { NotificationResponse } from 'expo-notifications/build/Notifications.types';
import {
  addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync,
} from 'expo-notifications/build/NotificationsEmitter';

import { parseMobilePushNotification } from '../src/lib/push/notification-content';

const OBSERVER_PREFIX = '[issue #32 native response evidence]';
const EXPECTED_TITLE = '[DRILL] Synthetic lockdown drill';
const EXPECTED_BODY =
  '[DRILL] Synthetic exercise only. Open the synthetic event room.';

function objectKeys(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze([]);
  }
  return Object.freeze(Object.keys(value).sort());
}

function observe(
  source: 'listener' | 'startup-last',
  response: NotificationResponse,
): void {
  const request = response.notification.request;
  const content = request.content;
  const parsed = parseMobilePushNotification({
    body: content.body,
    data: content.data,
    title: content.title,
  });
  // Emit only shape, exact synthetic-copy comparisons, and parser outcome.
  // This observer never navigates, clears native evidence, or logs payload
  // values, credentials, recipients, or authentication state.
  console.info(
    `${OBSERVER_PREFIX} ${JSON.stringify({
      source,
      actionIdentifier: response.actionIdentifier,
      requestIdentifierLength: request.identifier.length,
      exactTitle: content.title === EXPECTED_TITLE,
      exactBody: content.body === EXPECTED_BODY,
      dataKind:
        typeof content.data === 'object' && content.data !== null
          ? Array.isArray(content.data)
            ? 'array'
            : 'object'
          : typeof content.data,
      dataKeys: objectKeys(content.data),
      productionParserAccepted: parsed !== null,
    })}`,
  );
}

addNotificationResponseReceivedListener((response) => {
  observe('listener', response);
});

void getLastNotificationResponseAsync()
  .then((response) => {
    if (response !== null) observe('startup-last', response);
  })
  .catch(() => undefined);
