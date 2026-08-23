export type MobileE2EPlatform = 'ios' | 'android';

interface ExpoAppConfiguration {
  readonly expo?: {
    readonly slug?: unknown;
    readonly scheme?: unknown;
    readonly ios?: { readonly bundleIdentifier?: unknown };
    readonly android?: { readonly package?: unknown };
  };
}

const APP_ID = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_-]+)+$/u;
const SCHEME = /^[a-z][a-z0-9+.-]*$/u;
const SLUG = /^[a-z0-9][a-z0-9-]*$/u;

export function mobileE2EIdentity(
  raw: unknown,
  platform: MobileE2EPlatform,
): Readonly<{ appId: string; developmentScheme: string; scheme: string }> {
  const config = raw as ExpoAppConfiguration;
  const appId =
    platform === 'ios'
      ? config.expo?.ios?.bundleIdentifier
      : config.expo?.android?.package;
  const scheme = config.expo?.scheme;
  const slug = config.expo?.slug;
  if (typeof appId !== 'string' || !APP_ID.test(appId)) {
    throw new TypeError(`app.json has no valid ${platform} application ID.`);
  }
  if (typeof scheme !== 'string' || !SCHEME.test(scheme)) {
    throw new TypeError('app.json has no valid Expo URL scheme.');
  }
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new TypeError('app.json has no valid Expo slug.');
  }
  return Object.freeze({ appId, developmentScheme: `exp+${slug}`, scheme });
}

export function requireSyntheticMobileE2E(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (
    environment.PSD_EOC_E2E_SYNTHETIC_ONLY !== 'true' ||
    environment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE !== 'issue-21' ||
    environment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE !== 'issue-32' ||
    environment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE !== 'issue-32' ||
    environment.EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED !== 'false'
  ) {
    throw new Error(
      'Mobile E2E requires the exact synthetic fixtures and disabled push registration.',
    );
  }
}

export function expoDevelopmentClientUrl(
  scheme: string,
  metroUrl: string,
): string {
  if (!SCHEME.test(scheme)) throw new TypeError('Invalid Expo URL scheme.');
  const parsed = new URL(metroUrl);
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
  ) {
    throw new TypeError('The E2E Metro URL must stay on the local machine.');
  }
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(parsed.toString())}`;
}
