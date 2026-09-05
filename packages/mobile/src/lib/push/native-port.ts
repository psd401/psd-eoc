import { requireOptionalNativeModule } from 'expo';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { NativePushBuildIdentitySchema } from '@psd-eoc/contracts';
import {
  IosAuthorizationStatus,
  type NotificationPermissionsStatus,
} from 'expo-notifications/build/NotificationPermissions.types';
import type {
  Notification,
  NotificationResponse,
} from 'expo-notifications/build/Notifications.types';
import {
  addNotificationResponseReceivedListener,
  clearLastNotificationResponseAsync,
  getLastNotificationResponseAsync,
} from 'expo-notifications/build/NotificationsEmitter';
import { setNotificationHandler } from 'expo-notifications/build/NotificationsHandler';
import {
  getPermissionsAsync,
  requestPermissionsAsync,
} from 'expo-notifications/build/NotificationPermissions';
import { addPushTokenListener } from 'expo-notifications/build/TokenEmitter';
import { getDevicePushTokenAsync } from 'expo-notifications/build/getDevicePushTokenAsync';
import { getNotificationChannelAsync } from 'expo-notifications/build/getNotificationChannelAsync';
import { Linking, Platform } from 'react-native';

import {
  ALERT_NOTIFICATION_CHANNEL_ID,
  configureAlertChannel,
} from '../../notifications/alert-channel';
import {
  alertChannelMuted,
  androidPushPermission,
  type AlertChannelReadback,
} from './alert-channel-state';
import {
  disableExpoAutoRegistration,
  type ExpoServerRegistrationModule,
} from './expo-auto-registration';
import { requestExplicitExpoPushToken } from './expo-token';
import {
  foregroundBehaviorFor,
  type PushNotificationContent,
} from './notification-content';
import {
  parsePushRegistrationConfiguration,
  type NativePushPlatform,
  type PushNativePort,
  type PushPermissionStatus,
} from './registration-controller';

interface ExpoApplicationModule {
  readonly applicationId?: string | null;
  readonly getPushNotificationServiceEnvironmentAsync?: () => Promise<
    'development' | 'production' | null
  >;
  readonly getApplicationReleaseTypeAsync?: () => Promise<number>;
}

import { resolveIosServiceEnvironment } from './service-environment';

// Requiring these native modules does not evaluate expo-notifications' package
// barrel or its import-time DevicePushTokenAutoRegistration side effect.
const serverRegistrationModule =
  requireOptionalNativeModule<ExpoServerRegistrationModule>(
    'NotificationsServerRegistrationModule',
  );
const applicationModule =
  requireOptionalNativeModule<ExpoApplicationModule>('ExpoApplication');

function permissionStatus(
  status: NotificationPermissionsStatus,
): PushPermissionStatus {
  if (status.status === 'undetermined') return 'undetermined';
  if (!status.granted) return 'denied';
  if (Platform.OS !== 'ios') return 'granted';
  // Provisional/ephemeral or selectively disabled settings do not meet the
  // emergency-alert UX. Treat degraded permission as denied and report it.
  if (
    status.ios?.status !== IosAuthorizationStatus.AUTHORIZED ||
    status.ios.allowsAlert !== true ||
    status.ios.allowsDisplayOnLockScreen !== true ||
    status.ios.allowsSound !== true
  ) {
    return 'denied';
  }
  return 'granted';
}

/**
 * Reads the alert channel back from Android, narrowed to the only two fields
 * any decision may use. See `alert-channel-state` for why the field that is
 * absent here is absent.
 */
async function readAlertChannel(): Promise<AlertChannelReadback | null> {
  const channel = await getNotificationChannelAsync(
    ALERT_NOTIFICATION_CHANNEL_ID,
  );
  return channel === null
    ? null
    : { importance: channel.importance, sound: channel.sound };
}

async function effectivePermissionStatus(
  status: NotificationPermissionsStatus,
): Promise<PushPermissionStatus> {
  const base = permissionStatus(status);
  if (base !== 'granted' || Platform.OS !== 'android') return base;
  return androidPushPermission(base, await readAlertChannel());
}

/** Native-only adapter; all network-bearing operations stay behind the controller gate. */
export const expoPushNativePort: PushNativePort = Object.freeze({
  async prepare() {
    // Expo persists an optional direct token-update registration. PSD EOC owns
    // registration through its authenticated API, so that side channel is
    // disabled on every launch, including when the feature flag is absent.
    await disableExpoAutoRegistration(serverRegistrationModule);
    await configureAlertChannel();
  },
  async getPermissionStatus() {
    return effectivePermissionStatus(await getPermissionsAsync());
  },
  async isAlertChannelMuted() {
    if (Platform.OS !== 'android') return false;
    return alertChannelMuted(await readAlertChannel());
  },
  async requestPermission() {
    return effectivePermissionStatus(
      await requestPermissionsAsync({
        android: {},
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      }),
    );
  },
  getDevicePushToken: () => getDevicePushTokenAsync(),
  async getServiceEnvironment(platform: NativePushPlatform) {
    if (platform === 'android') return 'production';
    if (
      applicationModule?.getPushNotificationServiceEnvironmentAsync ===
      undefined
    ) {
      throw new Error('This build cannot report an APNs environment.');
    }
    const entitlement =
      await applicationModule.getPushNotificationServiceEnvironmentAsync();
    const releaseType =
      await applicationModule.getApplicationReleaseTypeAsync?.();
    const environment = resolveIosServiceEnvironment(entitlement, releaseType);
    if (environment === null) {
      throw new Error(
        'This build carries no APNs entitlement and was not distributed through a store.',
      );
    }
    return environment;
  },
  async getExpoPushToken(
    input: Parameters<PushNativePort['getExpoPushToken']>[0],
  ) {
    const { devicePushToken, projectId } = input;
    if (
      (devicePushToken.type !== 'ios' && devicePushToken.type !== 'android') ||
      typeof devicePushToken.data !== 'string'
    ) {
      throw new Error('Native push-token identity is invalid.');
    }
    const verifiedDevicePushToken = Object.freeze({
      type: devicePushToken.type,
      data: devicePushToken.data,
    });
    const applicationId = applicationModule?.applicationId;
    if (
      serverRegistrationModule?.getInstallationIdAsync === undefined ||
      !applicationId
    ) {
      throw new Error('Native Expo push-token identity is unavailable.');
    }
    return requestExplicitExpoPushToken({
      applicationId,
      development: input.serviceEnvironment === 'development',
      deviceId: await serverRegistrationModule.getInstallationIdAsync(),
      devicePushToken: verifiedDevicePushToken,
      projectId,
      signal: input.signal,
    });
  },
  addPushTokenListener: (
    listener: Parameters<PushNativePort['addPushTokenListener']>[0],
  ) => addPushTokenListener(listener),
  openSettings: () => Linking.openSettings(),
});

export function currentNativePushPlatform(): NativePushPlatform | null {
  return Platform.OS === 'ios' || Platform.OS === 'android'
    ? Platform.OS
    : null;
}

export function currentPushRegistrationConfiguration() {
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  const build = NativePushBuildIdentitySchema.safeParse({
    applicationId: Application.applicationId,
    applicationVersion: Application.nativeApplicationVersion,
    nativeBuildVersion: Application.nativeBuildVersion,
    expoProjectId: projectId,
    // `Updates.isEnabled` is the running binary's own answer about whether it
    // can take remote code. The application configuration was also required
    // here, but a release build does not always expose it, so a correct
    // device was refused registration for a fact it could not restate.
    updateMode: Updates.isEnabled === false ? 'embedded-only' : 'unverified',
  });
  return parsePushRegistrationConfiguration(
    process.env.EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED,
    projectId,
    build.success ? build.data : null,
  );
}

function notificationContent(
  notification: Notification,
): PushNotificationContent {
  return {
    body: notification.request.content.body,
    data: notification.request.content.data,
    title: notification.request.content.title,
  };
}

/** Installs the single foreground handler. Malformed/misclassified data is silent. */
export function configureForegroundPushHandling(): void {
  setNotificationHandler({
    handleNotification: async (notification) =>
      foregroundBehaviorFor(notificationContent(notification)),
  });
}

export function normalizePushResponse(response: NotificationResponse) {
  return Object.freeze({
    actionIdentifier: response.actionIdentifier,
    notification: Object.freeze({
      request: Object.freeze({
        identifier: response.notification.request.identifier,
        content: notificationContent(response.notification),
      }),
    }),
  });
}

export const expoPushResponsePort = Object.freeze({
  addListener(listener: (response: NotificationResponse) => void) {
    return addNotificationResponseReceivedListener(listener);
  },
  getLast: () => getLastNotificationResponseAsync(),
  clearLast: () => clearLastNotificationResponseAsync(),
});
