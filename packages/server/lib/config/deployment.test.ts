import { describe, expect, test } from 'bun:test';

import {
  DeploymentConfigurationError,
  applicationOrigin,
  iosBundleId,
  organizationName,
  staffHostedDomain,
} from './deployment';

describe('deployment configuration', () => {
  test('accepts a complete synthetic second-district identity', () => {
    const environment = {
      GOOGLE_OIDC_APPLICATION_ORIGIN: 'https://alerts.example.invalid',
      GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
      PSD_EOC_IOS_BUNDLE_ID: 'invalid.example.alerts',
      PSD_EOC_ORGANIZATION_NAME: 'Example Unified School District',
    };

    expect(applicationOrigin(environment)).toBe(
      'https://alerts.example.invalid',
    );
    expect(staffHostedDomain(environment)).toBe('example.invalid');
    expect(iosBundleId(environment)).toBe('invalid.example.alerts');
    expect(organizationName(environment)).toBe(
      'Example Unified School District',
    );
  });

  test('fails closed for absent, unbounded, or control-bearing organization names', () => {
    for (const value of [undefined, '', 'x'.repeat(161), 'District\nName']) {
      expect(() =>
        organizationName({ PSD_EOC_ORGANIZATION_NAME: value }),
      ).toThrow(DeploymentConfigurationError);
    }
  });
});
