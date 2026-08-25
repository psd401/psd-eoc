import { readDatabaseConfig } from '../packages/server/db/client';
import {
  applicationOrigin,
  iosBundleId,
  organizationName,
  staffHostedDomain,
  type DeploymentEnvironment,
} from '../packages/server/lib/config/deployment';
import { requireSyntheticTestDatabaseUrl } from '../packages/server/lib/testing/database';

export function validateExampleConfiguration(
  environment: DeploymentEnvironment,
): void {
  const origin = new URL(applicationOrigin(environment));
  const hostedDomain = staffHostedDomain(environment);
  const bundleId = iosBundleId(environment);
  organizationName(environment);
  if (
    !origin.hostname.endsWith('.invalid') ||
    !hostedDomain.endsWith('.invalid') ||
    !bundleId.startsWith('invalid.')
  ) {
    throw new Error(
      'Example tenant identity must use reserved, non-routable values.',
    );
  }

  const testDatabaseUrl = requireSyntheticTestDatabaseUrl(
    environment.TEST_DATABASE_URL,
    false,
  );
  const database = readDatabaseConfig(environment);
  if (
    database.driver !== 'postgres' ||
    !('url' in database) ||
    database.url !== testDatabaseUrl
  ) {
    throw new Error(
      'Example DATABASE_URL and TEST_DATABASE_URL must name the same synthetic PostgreSQL database.',
    );
  }
}

if (import.meta.main) {
  validateExampleConfiguration(process.env);
  console.info('Synthetic example configuration is valid.');
}
