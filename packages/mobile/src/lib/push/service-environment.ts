import type { PushServiceEnvironment } from '@psd-eoc/contracts';

/**
 * expo-application's native release-type enum. Only the two distributions that
 * use the production APNs environment are named.
 */
const ENTERPRISE_RELEASE_TYPE = 2;
const APP_STORE_RELEASE_TYPE = 5;

/**
 * Decides which APNs environment this build registers against.
 *
 * The entitlement is read out of `embedded.mobileprovision`, and an App Store
 * build does not contain one: Apple strips it, which is why expo-application
 * treats a missing profile as App Store distribution. The entitlement is
 * therefore null for every TestFlight and App Store install, and this returned
 * null as a failure — so push registration could not succeed on the only
 * channel this application ships through.
 *
 * A null entitlement is answered by how the build was distributed instead.
 * Store and enterprise builds are production. A simulator or an unknown
 * release type is still refused, because neither can register with APNs and
 * guessing an environment would register a token against the wrong one.
 */
export function resolveIosServiceEnvironment(
  entitlement: 'development' | 'production' | null | undefined,
  releaseType: number | undefined,
): PushServiceEnvironment | null {
  if (entitlement === 'development' || entitlement === 'production') {
    return entitlement;
  }
  return releaseType === APP_STORE_RELEASE_TYPE ||
    releaseType === ENTERPRISE_RELEASE_TYPE
    ? 'production'
    : null;
}
