import appConfig from '../app.json';
import packageManifest from '../package.json';
import { DISABLED_EXPO_AUTO_REGISTRATION_INFO } from '../src/lib/push/expo-auto-registration';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Plugin = string | readonly [string, Readonly<Record<string, unknown>>];

const notificationPlugin = (appConfig.expo.plugins as readonly Plugin[]).find(
  (candidate) =>
    Array.isArray(candidate) && candidate[0] === 'expo-notifications',
);
assert(
  Array.isArray(notificationPlugin),
  'expo-notifications must be explicitly configured.',
);
const options = notificationPlugin[1];
assert(
  options.defaultChannel === 'eoc-alerts',
  'Native and worker alerts must use the stable eoc-alerts channel.',
);
assert(
  options.icon === './assets/notification-icon.png',
  'Android alerts must retain the reviewed monochrome notification icon.',
);

const entitlements = appConfig.expo.ios.entitlements;
assert(
  entitlements['aps-environment'] === 'development',
  'Source config must retain the development APNs entitlement.',
);
assert(
  entitlements['com.apple.developer.usernotifications.time-sensitive'] === true,
  'iOS must declare the time-sensitive notification entitlement.',
);
assert(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    appConfig.expo.extra.eas.projectId,
  ),
  'Expo project identity must be a canonical UUID.',
);
assert(
  'expo-notifications' in packageManifest.dependencies,
  'expo-notifications must remain a direct runtime dependency.',
);

const channelSource = await Bun.file(
  new URL('../src/notifications/alert-channel.ts', import.meta.url),
).text();
for (const requirement of [
  'AndroidImportance.MAX',
  'enableVibrate: true',
  'AndroidNotificationVisibility.PUBLIC',
] as const) {
  assert(
    channelSource.includes(requirement),
    `Android alert channel is missing ${requirement}.`,
  );
}
assert(
  !/\bsound\s*:/u.test(channelSource),
  'Android alert channel must use the system default sound, not a custom resource name.',
);

const runtimeSources: Array<Readonly<{ path: string; source: string }>> = [];
const reviewedNotificationModules = new Set([
  'expo-notifications/build/NotificationChannelManager.types',
  'expo-notifications/build/NotificationPermissions',
  'expo-notifications/build/NotificationPermissions.types',
  'expo-notifications/build/Notifications.types',
  'expo-notifications/build/NotificationsEmitter',
  'expo-notifications/build/NotificationsHandler',
  'expo-notifications/build/TokenEmitter',
  'expo-notifications/build/getDevicePushTokenAsync',
  'expo-notifications/build/getNotificationChannelAsync',
  'expo-notifications/build/setNotificationChannelAsync',
]);
const syntheticFixtureNotificationModules = new Set([
  'expo-notifications/build/cancelAllScheduledNotificationsAsync',
  'expo-notifications/build/dismissAllNotificationsAsync',
  'expo-notifications/build/scheduleNotificationAsync',
]);
const syntheticFixturePath = '/src/lib/start/issue-32-synthetic-push.ts';
const runtimeGlob = new Bun.Glob('src/**/*.{ts,tsx}');
for await (const path of runtimeGlob.scan({
  absolute: true,
  cwd: new URL('..', import.meta.url).pathname,
  onlyFiles: true,
})) {
  runtimeSources.push({ path, source: await Bun.file(path).text() });
}
for (const { path, source } of runtimeSources) {
  const isIssue32SyntheticFixture = path
    .replaceAll('\\', '/')
    .endsWith(syntheticFixturePath);
  const imports = source.matchAll(
    /(?:from\s+|import\s*\()\s*(['"])(expo-notifications[^'"]*)\1/gu,
  );
  for (const runtimeImport of imports) {
    const specifier = runtimeImport[2] ?? '';
    assert(
      specifier !== 'expo-notifications',
      `${path} must not import the expo-notifications package barrel.`,
    );
    assert(
      !specifier.includes('getExpoPushTokenAsync') &&
        !specifier.includes('DevicePushTokenAutoRegistration'),
      `${path} must not load Expo's import-time automatic-registration path.`,
    );
    assert(
      reviewedNotificationModules.has(specifier) ||
        (isIssue32SyntheticFixture &&
          syntheticFixtureNotificationModules.has(specifier)),
      `${path} imports an unreviewed expo-notifications runtime boundary: ${specifier}.`,
    );
  }
}

const nativePortSource = await Bun.file(
  new URL('../src/lib/push/native-port.ts', import.meta.url),
).text();
assert(
  nativePortSource.includes("'NotificationsServerRegistrationModule'"),
  'Push setup must use the side-effect-free native registration module.',
);
assert(
  nativePortSource.includes(
    'disableExpoAutoRegistration(serverRegistrationModule)',
  ),
  'Expo automatic server registration must be disabled before listener setup.',
);
const alertChannelStateSource = await Bun.file(
  new URL('../src/lib/push/alert-channel-state.ts', import.meta.url),
).text();
/** Comments explain the rule that was wrong; only executable code is checked. */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
// The regression guard. Requiring a lock-screen visibility Android does not
// honour denied every Android device this app ever ran on, so no Android
// device requested a token or registered for push at all. No permission rule
// may read that field again.
assert(
  ![alertChannelStateSource, nativePortSource]
    .map(withoutComments)
    .some((source) => source.includes('lockscreenVisibility')),
  'Android push permission must not be decided by lockscreenVisibility; Android does not honour it.',
);
assert(
  alertChannelStateSource.includes('channel.sound !== null'),
  'A muted alert channel must still be reported to the person.',
);
assert(
  nativePortSource.includes('androidPushPermission('),
  'Android permission must be decided by the reviewed alert-channel rule.',
);
assert(
  DISABLED_EXPO_AUTO_REGISTRATION_INFO === '{"isEnabled":false}',
  'Expo auto registration must persist an explicit non-null disabled record.',
);

const autoRegistrationSource = await Bun.file(
  new URL('../src/lib/push/expo-auto-registration.ts', import.meta.url),
).text();
assert(
  !autoRegistrationSource.includes('setRegistrationInfoAsync(null)'),
  'Expo 57 iOS must never receive null registration info.',
);

const expoTokenSource = await Bun.file(
  new URL('../src/lib/push/expo-token.ts', import.meta.url),
).text();
assert(
  expoTokenSource.includes(
    "'https://exp.host/--/api/v2/push/getExpoPushToken'",
  ) &&
    expoTokenSource.includes('fetchToken(EXPO_PUSH_TOKEN_URL') &&
    expoTokenSource.includes('const EXPO_PUSH_TOKEN_TIMEOUT_MS = 8_000') &&
    expoTokenSource.includes('new AbortController()'),
  'Expo token acquisition must use the single explicit, non-persisting endpoint.',
);

console.info('Push native configuration is explicit and fail closed.');
