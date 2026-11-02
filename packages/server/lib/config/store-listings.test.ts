import { describe, expect, test } from 'bun:test';

import { DeploymentConfigurationError } from './deployment';
import { mobileStoreListings } from './store-listings';

describe('mobileStoreListings', () => {
  test('links to nothing when no store identity is configured', () => {
    expect(mobileStoreListings({})).toEqual({
      appStore: null,
      googlePlay: null,
    });
  });

  test('builds each store page from its configured identifier', () => {
    expect(
      mobileStoreListings({
        PSD_EOC_APPLE_APP_STORE_ID: ' 1234567890 ',
        PSD_EOC_ANDROID_APPLICATION_ID: 'invalid.example.eoc',
      }),
    ).toEqual({
      appStore: 'https://apps.apple.com/app/id1234567890',
      googlePlay:
        'https://play.google.com/store/apps/details?id=invalid.example.eoc',
    });
  });

  test('links each store independently', () => {
    expect(
      mobileStoreListings({
        PSD_EOC_ANDROID_APPLICATION_ID: 'invalid.example.eoc',
      }).appStore,
    ).toBeNull();
    expect(
      mobileStoreListings({ PSD_EOC_APPLE_APP_STORE_ID: '1234567890' })
        .googlePlay,
    ).toBeNull();
  });

  test('refuses an App Store identifier that is not numeric', () => {
    for (const invalid of ['id1234567890', 'net.example.eoc', '0123456']) {
      expect(() =>
        mobileStoreListings({ PSD_EOC_APPLE_APP_STORE_ID: invalid }),
      ).toThrow(DeploymentConfigurationError);
    }
  });
});
