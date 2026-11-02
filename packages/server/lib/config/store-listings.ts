import {
  androidApplicationId,
  appleAppStoreId,
  type DeploymentEnvironment,
} from './deployment';

/** Where staff can install this district's mobile app, by store. */
export interface MobileStoreListings {
  readonly appStore: string | null;
  readonly googlePlay: string | null;
}

/**
 * The public store pages for this district's app, built from tenant
 * configuration. Each is null when its identifier is not configured, so a
 * district without a store build links to nothing rather than to an app that
 * is not theirs.
 */
export function mobileStoreListings(
  environment: DeploymentEnvironment = process.env,
): MobileStoreListings {
  const storeId = appleAppStoreId(environment);
  const applicationId = androidApplicationId(environment);
  return Object.freeze({
    appStore:
      storeId === null ? null : `https://apps.apple.com/app/id${storeId}`,
    googlePlay:
      applicationId === null
        ? null
        : `https://play.google.com/store/apps/details?id=${encodeURIComponent(applicationId)}`,
  });
}
