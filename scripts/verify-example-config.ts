import { readFileSync } from 'node:fs';

import { readDatabaseConfig } from '../packages/server/db/client';
import {
  applicationOrigin,
  displayTimeZone,
  iosBundleId,
  organizationName,
  staffHostedDomain,
  type DeploymentEnvironment,
} from '../packages/server/lib/config/deployment';
import { requireSyntheticTestDatabaseUrl } from '../packages/server/lib/testing/database';

const EXAMPLE_CONFIGURATION_PATH = new URL('../.env.example', import.meta.url);

export function parseExampleConfiguration(
  contents: string,
): DeploymentEnvironment {
  const environment: Record<string, string> = {};
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (
      separator < 1 ||
      !/^[A-Z][A-Z0-9_]*$/u.test(key) ||
      Object.hasOwn(environment, key)
    ) {
      throw new Error(
        `.env.example line ${String(index + 1)} must be one unique KEY=value assignment.`,
      );
    }
    environment[key] = value;
  }
  return environment;
}

export function validateExampleConfiguration(
  environment: DeploymentEnvironment,
): void {
  const origin = new URL(applicationOrigin(environment));
  const hostedDomain = staffHostedDomain(environment);
  const bundleId = iosBundleId(environment);
  displayTimeZone(environment);
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
  const environment = parseExampleConfiguration(
    readFileSync(EXAMPLE_CONFIGURATION_PATH, 'utf8'),
  );
  validateExampleConfiguration(environment);
  console.info('Synthetic example configuration is valid.');
}
