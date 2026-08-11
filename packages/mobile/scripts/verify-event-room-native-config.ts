import appConfig from '../app.json';
import packageManifest from '../package.json';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Plugin = string | readonly [string, Readonly<Record<string, unknown>>];

function configuredPlugin(name: string): Readonly<Record<string, unknown>> {
  const plugin = (appConfig.expo.plugins as readonly Plugin[]).find(
    (candidate) => Array.isArray(candidate) && candidate[0] === name,
  );
  assert(Array.isArray(plugin), `${name} must be explicitly configured.`);
  const options = plugin[1];
  assert(
    typeof options === 'object' && options !== null,
    `${name} must have fail-closed options.`,
  );
  return options;
}

const picker = configuredPlugin('expo-image-picker');
assert(
  picker.microphonePermission === false,
  'Photo selection must not request microphone access.',
);
assert(
  picker.cameraPermission === false,
  'Photo selection must not request unused camera access.',
);
assert(
  typeof picker.photosPermission === 'string' &&
    picker.photosPermission.includes('event journal'),
  'Photo access must explain its event-journal purpose.',
);

const location = configuredPlugin('expo-location');
assert(
  location.isIosBackgroundLocationEnabled === false &&
    location.isAndroidBackgroundLocationEnabled === false,
  'Location must remain foreground-only on both platforms.',
);
assert(
  location.locationAlwaysAndWhenInUsePermission === false &&
    location.locationAlwaysPermission === false &&
    location.motionUsagePermission === false,
  'iOS always-location and motion usage descriptions must be omitted.',
);
assert(
  location.isAndroidForegroundServiceEnabled === false &&
    location.isAndroidMotionActivityEnabled === false,
  'Android location services and motion activity must stay disabled.',
);
assert(
  typeof location.locationWhenInUsePermission === 'string' &&
    location.locationWhenInUsePermission.includes('room-level'),
  'Location permission copy must disclaim room-level precision.',
);

const blockedPermissions = new Set(appConfig.expo.android.blockedPermissions);
assert(
  blockedPermissions.has('android.permission.ACCESS_BACKGROUND_LOCATION'),
  'Android background location must be blocked.',
);
assert(
  blockedPermissions.has('android.permission.FOREGROUND_SERVICE_LOCATION'),
  'Android location foreground services must be blocked.',
);
assert(
  blockedPermissions.has('android.permission.ACTIVITY_RECOGNITION') &&
    blockedPermissions.has(
      'com.google.android.gms.permission.ACTIVITY_RECOGNITION',
    ),
  'Android motion activity permissions must be blocked.',
);
assert(
  blockedPermissions.has('android.permission.RECORD_AUDIO'),
  'Photo selection must not gain Android microphone permission.',
);

for (const dependency of [
  'expo-file-system',
  'expo-image-picker',
  'expo-location',
] as const) {
  assert(
    dependency in packageManifest.dependencies,
    `${dependency} must be a direct mobile dependency.`,
  );
}

console.info('Event-room native permissions are foreground-only and explicit.');
