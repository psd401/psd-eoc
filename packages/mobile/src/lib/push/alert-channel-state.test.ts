import { describe, expect, test } from 'bun:test';
import {
  AndroidImportance,
  AndroidNotificationVisibility,
} from 'expo-notifications/build/NotificationChannelManager.types';

import {
  alertChannelMuted,
  androidPushPermission,
  type AlertChannelReadback,
} from './alert-channel-state';

/** What `configureAlertChannel` asks Android for, once Android has answered. */
const CONFIGURED: AlertChannelReadback = Object.freeze({
  importance: AndroidImportance.MAX,
  sound: 'default',
});

describe('android alert channel state', () => {
  test('grants permission for the channel Android actually returns', () => {
    // The regression. The app requests `lockscreenVisibility: PUBLIC`, Android
    // stores VISIBILITY_NO_OVERRIDE instead, and expo-notifications reports
    // that back as UNKNOWN -- enum value 0, against a PUBLIC of 1. Requiring
    // PUBLIC therefore denied every Android device that ever ran this app, so
    // none of them ever requested a token or registered for push.
    expect(AndroidNotificationVisibility.UNKNOWN).toBe(0);
    expect(AndroidNotificationVisibility.PUBLIC).toBe(1);
    expect(androidPushPermission('granted', CONFIGURED)).toBe('granted');
  });

  test('denies only when the channel does not exist', () => {
    expect(androidPushPermission('granted', null)).toBe('denied');
  });

  test('never upgrades a permission the operating system refused', () => {
    expect(androidPushPermission('denied', CONFIGURED)).toBe('denied');
    expect(androidPushPermission('undetermined', CONFIGURED)).toBe(
      'undetermined',
    );
  });

  test('keeps delivering to a channel the person has silenced', () => {
    // Android locks a channel against the app once someone edits it, so this
    // is unrecoverable from inside the app. Denying here unregistered the
    // endpoint and made one settings change a permanent loss of push.
    const silenced: AlertChannelReadback = { importance: 1, sound: null };
    expect(androidPushPermission('granted', silenced)).toBe('granted');
    expect(alertChannelMuted(silenced)).toBe(true);
  });

  test('reports a demoted or muted channel without refusing it', () => {
    expect(alertChannelMuted(CONFIGURED)).toBe(false);
    expect(
      alertChannelMuted({ importance: AndroidImportance.HIGH, sound: null }),
    ).toBe(true);
    expect(
      alertChannelMuted({
        importance: AndroidImportance.LOW,
        sound: 'default',
      }),
    ).toBe(true);
    // Nothing to report when there is no channel; that is a denial, not a
    // warning, and the two must not both fire.
    expect(alertChannelMuted(null)).toBe(false);
  });
});
