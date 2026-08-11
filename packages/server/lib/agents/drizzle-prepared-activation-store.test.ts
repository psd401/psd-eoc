import { describe, expect, test } from 'bun:test';
import type {
  ExecuteStatementCommand,
  ExecuteStatementCommandOutput,
  RDSDataClient,
} from '@aws-sdk/client-rds-data';
import { drizzle as drizzleAwsDataApi } from 'drizzle-orm/aws-data-api/pg';

import type { DatabaseQuery } from '../../db/client';
import { readPreparedActivationDatabaseTime } from './drizzle-prepared-activation-store';

describe('prepared-activation authoritative database clock', () => {
  test('normalizes the pinned AWS Data API result envelope without credentials or network', async () => {
    const commands: ExecuteStatementCommand[] = [];
    const response = {
      $metadata: { httpStatusCode: 200 },
      columnMetadata: [{ name: 'value', typeName: 'timestamptz' }],
      records: [[{ stringValue: '2026-08-10 17:34:56+00' }]],
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

    const value = await readPreparedActivationDatabaseTime(
      database as unknown as Pick<DatabaseQuery, 'execute'>,
    );

    expect(value.toISOString()).toBe('2026-08-10T17:34:56.000Z');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toMatchObject({
      database: 'synthetic',
      includeResultMetadata: true,
      parameters: [],
      sql: 'select clock_timestamp() as value',
    });
  });

  test('also accepts the postgres-js direct row array', async () => {
    const database = {
      execute: () => Promise.resolve([{ value: '2026-08-10T17:34:56.000Z' }]),
    } as unknown as Pick<DatabaseQuery, 'execute'>;

    await expect(readPreparedActivationDatabaseTime(database)).resolves.toEqual(
      new Date('2026-08-10T17:34:56.000Z'),
    );
  });
});
