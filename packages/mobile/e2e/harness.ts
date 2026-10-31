import type { MobileE2EPlatform } from './device';

export type { MobileE2EPlatform };

export const IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS = 3;

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

/**
 * The native partner journey (issue #598) is the one mobile harness that
 * drives the real authentication client against a real server, because the
 * thing under test is two server endpoints and the screen that calls them.
 * Its safety rules are therefore the opposite shape of the issue-32 journey's:
 *
 * - the in-process synthetic auth and start fixtures must be ABSENT, or the
 *   app would never reach the server and the run would prove nothing;
 * - the server it talks to must be an http loopback origin, so a run can
 *   never be pointed at a deployment; and
 * - the local authenticator is still the exact-flag synthetic one and push
 *   registration is still off, so no biometric prompt and no provider
 *   registration can occur.
 */
export function requireSyntheticNativePartnerE2E(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (
    environment.PSD_EOC_E2E_SYNTHETIC_ONLY !== 'true' ||
    environment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE !== 'issue-32' ||
    environment.EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED !== 'false' ||
    environment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE !== undefined ||
    environment.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE !== undefined
  ) {
    throw new Error(
      'The native partner journey requires the synthetic authenticator, disabled push registration, and no in-process app fixture.',
    );
  }
  requireLoopbackApiOrigin(environment.EXPO_PUBLIC_PSD_EOC_API_BASE_URL);
}

/**
 * Refuses any server but one on this machine. The app itself only accepts an
 * http origin on loopback in a development build, and this says so again in
 * the harness, where it can be read before a device is ever built.
 */
export function requireLoopbackApiOrigin(value: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(value ?? '');
  } catch {
    throw new Error('The native partner journey needs an API base URL.');
  }
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error(
      'The native partner journey refuses any API origin but http loopback.',
    );
  }
  return parsed.origin;
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

export function shouldRetryIosDevelopmentClientOpen(
  exitCode: number,
  attempt: number,
): boolean {
  return exitCode === 60 && attempt < IOS_DEVELOPMENT_CLIENT_OPEN_ATTEMPTS;
}
