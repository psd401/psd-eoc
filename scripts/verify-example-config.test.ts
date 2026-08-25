import { describe, expect, test } from 'bun:test';

import {
  parseExampleConfiguration,
  validateExampleConfiguration,
} from './verify-example-config';

const EXAMPLE = {
  DATABASE_DRIVER: 'postgres',
  DATABASE_URL:
    'postgresql://psd_eoc_test:synthetic@localhost:5432/psd_eoc_test',
  GOOGLE_OIDC_APPLICATION_ORIGIN: 'https://eoc.example.invalid',
  GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
  PSD_EOC_DISPLAY_TIME_ZONE: 'America/New_York',
  PSD_EOC_IOS_BUNDLE_ID: 'invalid.example.eoc',
  PSD_EOC_ORGANIZATION_NAME: 'Example School District',
  TEST_DATABASE_URL:
    'postgresql://psd_eoc_test:synthetic@localhost:5432/psd_eoc_test',
} as const;

describe('synthetic example configuration', () => {
  test('accepts a complete non-routable second-district configuration', () => {
    expect(() => validateExampleConfiguration(EXAMPLE)).not.toThrow();
  });

  test('rejects routable identity or a production-shaped database', () => {
    expect(() =>
      validateExampleConfiguration({
        ...EXAMPLE,
        GOOGLE_OIDC_HOSTED_DOMAIN: 'example.com',
      }),
    ).toThrow(/reserved, non-routable/u);
    expect(() =>
      validateExampleConfiguration({
        ...EXAMPLE,
        DATABASE_URL: 'postgresql://admin@localhost/production',
        TEST_DATABASE_URL: 'postgresql://admin@localhost/production',
      }),
    ).toThrow(/name ends in _test/u);
  });

  test('rejects a missing or invalid display time zone', () => {
    const missingTimeZone = {
      ...EXAMPLE,
      PSD_EOC_DISPLAY_TIME_ZONE: undefined,
    };
    expect(() => validateExampleConfiguration(missingTimeZone)).toThrow(
      /PSD_EOC_DISPLAY_TIME_ZONE must be configured/u,
    );
    expect(() =>
      validateExampleConfiguration({
        ...EXAMPLE,
        PSD_EOC_DISPLAY_TIME_ZONE: 'Not/A_Real_Zone',
      }),
    ).toThrow(/valid IANA time zone/u);
  });

  test('parses the committed values without inheriting ambient variables', () => {
    const parsed = parseExampleConfiguration(
      'DATABASE_DRIVER=postgres\nPSD_EOC_ORGANIZATION_NAME=Example District\n',
    );
    expect(parsed).toEqual({
      DATABASE_DRIVER: 'postgres',
      PSD_EOC_ORGANIZATION_NAME: 'Example District',
    });
    expect(() =>
      parseExampleConfiguration(
        'DATABASE_DRIVER=sqlite\nDATABASE_DRIVER=postgres',
      ),
    ).toThrow(/unique KEY=value/u);
  });
});
