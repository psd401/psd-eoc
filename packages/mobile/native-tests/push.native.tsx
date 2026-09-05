import { describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PushNotificationNotice } from '../src/lib/push/permission-notice';

describe('push permission accessibility', () => {
  test('explains real and drill lock-screen alerts before the OS prompt', () => {
    const requestPermission = jest.fn();
    render(
      <PushNotificationNotice
        onOpenSettings={jest.fn()}
        onRequestPermission={requestPermission}
        onRetry={jest.fn()}
        snapshot={{
          phase: 'explanation-required',
          platform: 'ios',
          message: null,
          alertsMuted: false,
        }}
      />,
    );

    expect(
      screen.getByText(/both real incidents.*marked drills/iu),
    ).toBeTruthy();
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole('button', {
        name: 'Continue to notification permission',
      }),
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  test('says nothing once registration is confirmed and audible', () => {
    render(
      <PushNotificationNotice
        onOpenSettings={jest.fn()}
        onRequestPermission={jest.fn()}
        onRetry={jest.fn()}
        snapshot={{
          phase: 'registered',
          platform: 'android',
          message: null,
          alertsMuted: false,
        }}
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('warns that a silenced channel still delivers, without blocking it', () => {
    // Android locks a channel against the app once someone edits it, so the
    // app cannot restore the sound. Refusing to register would have been a
    // permanent loss of push; saying so is the most it can honestly do.
    const openSettings = jest.fn();
    render(
      <PushNotificationNotice
        onOpenSettings={openSettings}
        onRequestPermission={jest.fn()}
        onRetry={jest.fn()}
        snapshot={{
          phase: 'registered',
          platform: 'android',
          message: null,
          alertsMuted: true,
        }}
      />,
    );

    expect(screen.getByText(/still receives PSD EOC alerts/iu)).toBeTruthy();
    fireEvent.press(
      screen.getByRole('button', { name: 'Open device notification settings' }),
    );
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['ios' as const, /iPhone Settings.*Sounds.*Lock Screen/iu],
    ['android' as const, /Android Settings.*alerts channel/iu],
  ])(
    'gives %s denial instructions and accessible recovery controls',
    (platform, instructions) => {
      const openSettings = jest.fn();
      const retry = jest.fn();
      render(
        <PushNotificationNotice
          onOpenSettings={openSettings}
          onRequestPermission={jest.fn()}
          onRetry={retry}
          snapshot={{
            phase: 'denied',
            platform,
            message: null,
            alertsMuted: false,
          }}
        />,
      );

      expect(
        screen.UNSAFE_getByProps({ accessibilityRole: 'alert' }),
      ).toBeTruthy();
      expect(screen.getByText(instructions)).toBeTruthy();
      fireEvent.press(
        screen.getByRole('button', {
          name: 'Open device notification settings',
        }),
      );
      fireEvent.press(
        screen.getByRole('button', {
          name: 'Check push permission again',
        }),
      );
      expect(openSettings).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
    },
  );

  test('surfaces cleanup uncertainty without losing Settings recovery', () => {
    const message =
      'Notifications are disabled, and PSD EOC could not confirm push cleanup.';
    render(
      <PushNotificationNotice
        onOpenSettings={jest.fn()}
        onRequestPermission={jest.fn()}
        onRetry={jest.fn()}
        snapshot={{
          phase: 'denied',
          platform: 'ios',
          message,
          alertsMuted: false,
        }}
      />,
    );

    expect(screen.getByText(message)).toBeTruthy();
    expect(
      screen.getByText(/iPhone Settings.*Sounds.*Lock Screen/iu),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Open device notification settings',
      }),
    ).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(
      /ExponentPushToken|synthetic-apns/iu,
    );
  });
});
