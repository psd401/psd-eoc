import { describe, expect, test } from 'bun:test';
import type {
  ExecuteStatementCommand,
  ExecuteStatementCommandOutput,
  RDSDataClient,
} from '@aws-sdk/client-rds-data';
import {
  drizzle as drizzleAwsDataApi,
  type AwsDataApiPgQueryResult,
} from 'drizzle-orm/aws-data-api/pg';
import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  DatabaseConfigurationError,
  DatabaseExecuteResultError,
  readDatabaseConfig,
} from '../db/client';

const DATA_API_ENVIRONMENT = {
  DATABASE_DRIVER: 'aws-data-api',
  AWS_REGION: 'us-east-1',
  DATABASE_NAME: 'psd_eoc',
  DATABASE_RESOURCE_ARN:
    'arn:aws:rds:us-east-1:000000000000:cluster:psd-eoc-synthetic',
  DATABASE_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:000000000000:secret:psd-eoc-synthetic-AbCdEf',
} as const;

const RDS_CA_PATH = new URL(
  '../certs/aws-rds-global-bundle.pem',
  import.meta.url,
).pathname;

const COMPONENT_POSTGRES_ENVIRONMENT = {
  DATABASE_DRIVER: 'postgres',
  DATABASE_HOST:
    'psd-eoc-exploration-smoke.cluster-abcdefghijkl.us-east-1.rds.amazonaws.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'psd_eoc',
  DATABASE_USERNAME: 'psd_eoc_application',
  DATABASE_PASSWORD: 'synthetic-component-password-value',
  DATABASE_SSL_ROOT_CERT: RDS_CA_PATH,
  DATABASE_MAX_CONNECTIONS: '1',
  DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
  DATABASE_IDLE_TIMEOUT_SECONDS: '0',
  NODE_ENV: 'production',
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

  test('requires deployed component credentials, pinned TLS, and a one-connection pool', async () => {
    expect(readDatabaseConfig(COMPONENT_POSTGRES_ENVIRONMENT)).toEqual({
      driver: 'postgres',
      host: COMPONENT_POSTGRES_ENVIRONMENT.DATABASE_HOST,
      port: 5432,
      database: 'psd_eoc',
      username: 'psd_eoc_application',
      password: COMPONENT_POSTGRES_ENVIRONMENT.DATABASE_PASSWORD,
      sslRootCertificatePath: RDS_CA_PATH,
      maxConnections: 1,
      connectTimeoutSeconds: 10,
      idleTimeoutSeconds: 0,
    });

    const connection = createDatabaseClient(
      readDatabaseConfig(COMPONENT_POSTGRES_ENVIRONMENT),
    );
    if (
      connection.driver !== 'postgres' ||
      connection.nativeClient === undefined
    ) {
      throw new Error('Component PostgreSQL must expose its native client.');
    }
    expect(connection.nativeClient.options.idle_timeout).toBe(0);
    expect(connection.nativeClient.options.max_lifetime).toBe(0);
    expect(connection.nativeClient.options.max).toBe(1);
    await connection.close();

    for (const environment of [
      { ...COMPONENT_POSTGRES_ENVIRONMENT, DATABASE_MAX_CONNECTIONS: '2' },
      {
        ...COMPONENT_POSTGRES_ENVIRONMENT,
        DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/psd_eoc_test',
      },
      {
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/psd_eoc_test',
        NODE_ENV: 'production',
      },
    ]) {
      let message = '';
      try {
        readDatabaseConfig(environment);
      } catch (error) {
        message = String(error);
      }
      expect(message).toBeTruthy();
      expect(message).not.toContain(
        COMPONENT_POSTGRES_ENVIRONMENT.DATABASE_PASSWORD,
      );
    }
  });

  test('defaults deployed max-one pools to no idle eviction', () => {
    expect(
      readDatabaseConfig({
        ...COMPONENT_POSTGRES_ENVIRONMENT,
        DATABASE_IDLE_TIMEOUT_SECONDS: undefined,
      }),
    ).toEqual({
      driver: 'postgres',
      host: COMPONENT_POSTGRES_ENVIRONMENT.DATABASE_HOST,
      port: 5432,
      database: 'psd_eoc',
      username: 'psd_eoc_application',
      password: COMPONENT_POSTGRES_ENVIRONMENT.DATABASE_PASSWORD,
      sslRootCertificatePath: RDS_CA_PATH,
      maxConnections: 1,
      connectTimeoutSeconds: 10,
      idleTimeoutSeconds: 0,
    });
  });

  test('rejects invalid idle timeout values without reflecting credentials', () => {
    for (const idleTimeout of ['-1', 'not-a-number', '601']) {
      let message = '';
      try {
        readDatabaseConfig({
          ...COMPONENT_POSTGRES_ENVIRONMENT,
          DATABASE_IDLE_TIMEOUT_SECONDS: idleTimeout,
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('DATABASE_IDLE_TIMEOUT_SECONDS');
      expect(message).not.toContain(
        COMPONENT_POSTGRES_ENVIRONMENT.DATABASE_PASSWORD,
      );
    }
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
    const postgresClose = postgresClient.close();
    expect(postgresClient.close()).toBe(postgresClose);
    const postCloseQuery = postgresClient.db.execute(
      sql`select 130::integer as value`,
    );
    await expect(Promise.resolve(postCloseQuery)).rejects.toMatchObject({
      cause: { code: 'CONNECTION_ENDED' },
    });
    await postgresClose;

    const dataApiClient = createDatabaseClient(
      readDatabaseConfig(DATA_API_ENVIRONMENT),
    );
    expect(dataApiClient.driver).toBe('aws-data-api');
    const dataApiClose = dataApiClient.close();
    expect(dataApiClient.close()).toBe(dataApiClose);
    await dataApiClose;
  });
});

describe('raw execute result compatibility', () => {
  const row = Object.freeze({ value: '2026-08-10T12:34:56.000Z' });

  test('returns postgres-js array rows without copying them', () => {
    const result = [row];

    expect(databaseExecuteRows(result)).toBe(result);
  });

  test('returns mapped rows from the AWS Data API response envelope', () => {
    const rows = [row];
    const result = {
      $metadata: {},
      rows,
    } satisfies AwsDataApiPgQueryResult<typeof row>;

    expect(databaseExecuteRows(result)).toBe(rows);
  });

  test('preserves empty results from both transports', () => {
    const postgresResult: (typeof row)[] = [];
    const dataApiResult = {
      $metadata: {},
      rows: [] as (typeof row)[],
    } satisfies AwsDataApiPgQueryResult<typeof row>;

    expect(databaseExecuteRows(postgresResult)).toEqual([]);
    expect(databaseExecuteRows(dataApiResult)).toEqual([]);
  });

  test('rejects absent or malformed raw results with an explicit domain error', () => {
    for (const result of [null, undefined, {}, { rows: null }]) {
      expect(() =>
        databaseExecuteRows(
          result as { rows: Record<string, unknown>[] } | null | undefined,
        ),
      ).toThrow(DatabaseExecuteResultError);
    }
  });

  test('normalizes the pinned Drizzle Data API runtime response without AWS I/O', async () => {
    const commands: ExecuteStatementCommand[] = [];
    const response = {
      $metadata: { httpStatusCode: 200 },
      columnMetadata: [{ name: 'value', typeName: 'int8' }],
      records: [[{ longValue: 1 }]],
      numberOfRecordsUpdated: 0,
    } satisfies ExecuteStatementCommandOutput;
    const fakeClient = {
      async send(
        command: ExecuteStatementCommand,
      ): Promise<ExecuteStatementCommandOutput> {
        commands.push(command);
        return response;
      },
    } as unknown as RDSDataClient;
    const database = drizzleAwsDataApi({
      client: fakeClient,
      database: 'synthetic',
      resourceArn:
        'arn:aws:rds:us-east-1:000000000000:cluster:psd-eoc-synthetic',
      secretArn:
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:psd-eoc-synthetic',
    });

    const result = await database.execute<{ value: number }>(
      sql`select 1 as value`,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toMatchObject({
      database: 'synthetic',
      includeResultMetadata: true,
      parameters: [],
      sql: 'select 1 as value',
    });
    expect(Array.isArray(result)).toBe(false);
    expect(Symbol.iterator in result).toBe(false);
    expect(result.rows).toEqual([{ value: 1 }]);
    expect(databaseExecuteRows(result)).toBe(result.rows);
  });
});
