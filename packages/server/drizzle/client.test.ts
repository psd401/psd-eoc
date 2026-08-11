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
        'arn:aws:rds:us-west-2:000000000000:cluster:psd-eoc-synthetic',
      secretArn:
        'arn:aws:secretsmanager:us-west-2:000000000000:secret:psd-eoc-synthetic',
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
