import { requireOptionalNativeModule } from 'expo';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { NativePushBuildIdentitySchema } from '@psd-eoc/contracts';
import {
  AndroidImportance,
  AndroidNotificationVisibility,
} from 'expo-notifications/build/NotificationChannelManager.types';
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
}

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

async function effectivePermissionStatus(
  status: NotificationPermissionsStatus,
): Promise<PushPermissionStatus> {
  const base = permissionStatus(status);
  if (base !== 'granted' || Platform.OS !== 'android') return base;
  const channel = await getNotificationChannelAsync(
    ALERT_NOTIFICATION_CHANNEL_ID,
  );
  return channel !== null &&
    channel.importance >= AndroidImportance.HIGH &&
    channel.lockscreenVisibility === AndroidNotificationVisibility.PUBLIC &&
    channel.sound !== null
    ? 'granted'
    : 'denied';
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
      throw new Error('The APNs service environment is unavailable.');
    }
    const environment =
      await applicationModule.getPushNotificationServiceEnvironmentAsync();
    if (environment !== 'development' && environment !== 'production') {
      throw new Error('The APNs service environment is unavailable.');
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
    updateMode:
      Constants.expoConfig?.updates?.enabled === false &&
      Updates.isEnabled === false
        ? 'embedded-only'
        : 'unverified',
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
