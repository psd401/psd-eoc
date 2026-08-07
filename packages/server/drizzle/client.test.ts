import { describe, expect, test } from 'bun:test';

import {
  createDatabaseClient,
  DatabaseConfigurationError,
  readDatabaseConfig,
} from '../db/client';

const DATA_API_ENVIRONMENT = {
  DATABASE_DRIVER: 'aws-data-api',
  AWS_REGION: 'us-west-2',
  DATABASE_NAME: 'psd_eoc',
  DATABASE_RESOURCE_ARN:
    'arn:aws:rds:us-west-2:338414773271:cluster:psd-eoc-synthetic',
  DATABASE_SECRET_ARN:
    'arn:aws:secretsmanager:us-west-2:338414773271:secret:psd-eoc-synthetic-AbCdEf',
} as const;

describe('database client configuration', () => {
  test('requires an explicit transport instead of guessing', () => {
    expect(() => readDatabaseConfig({})).toThrow('DATABASE_DRIVER must be set');
  });

  test('reads bounded local PostgreSQL settings', () => {
    expect(
      readDatabaseConfig({
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/psd_eoc_test',
        DATABASE_MAX_CONNECTIONS: '4',
      }),
    ).toEqual({
      driver: 'postgres',
      url: 'postgresql://synthetic:synthetic@localhost/psd_eoc_test',
      maxConnections: 4,
      connectTimeoutSeconds: 10,
      idleTimeoutSeconds: 20,
    });
  });

  test('rejects mixed transport settings without reflecting secret values', () => {
    const suppliedSecret = DATA_API_ENVIRONMENT.DATABASE_SECRET_ARN;

    try {
      readDatabaseConfig({
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/psd_eoc_test',
        DATABASE_SECRET_ARN: suppliedSecret,
      });
      throw new Error('Expected mixed database configuration to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConfigurationError);
      expect(String(error)).toContain('DATABASE_SECRET_ARN');
      expect(String(error)).not.toContain(suppliedSecret);
    }
  });

  test('builds both explicit clients with idempotent close hooks', async () => {
    const postgresClient = createDatabaseClient({
      driver: 'postgres',
      url: 'postgresql://synthetic:synthetic@localhost/psd_eoc_test',
    });
    expect(postgresClient.driver).toBe('postgres');
    await Promise.all([postgresClient.close(), postgresClient.close()]);

    const dataApiClient = createDatabaseClient(
      readDatabaseConfig(DATA_API_ENVIRONMENT),
    );
    expect(dataApiClient.driver).toBe('aws-data-api');
    await Promise.all([dataApiClient.close(), dataApiClient.close()]);
  });
});
