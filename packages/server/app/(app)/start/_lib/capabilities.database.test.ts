import { randomBytes, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import { audienceConfigurations, facilities } from '../../../../db/schema';
import { migrateDatabase } from '../../../../drizzle/migrate';
import {
  dropStartFlowPlaywrightDatabase,
  recreateStartFlowPlaywrightDatabase,
} from '../test/playwright-database';
import { loadLatestAudienceConfigurationHeader } from './capabilities';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  configuredTestDatabaseUrl === undefined ? describe.skip : describe;
const runId = randomBytes(16).toString('hex');

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;
let isolatedDatabaseMayExist = false;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The start-flow integration database is not open.');
  }
  return connection;
}

function postgresErrorFacts(
  error: unknown,
  field: 'code' | 'message',
): readonly string[] {
  const visited = new Set<unknown>();
  const facts: string[] = [];
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const value = Reflect.get(current, field);
    if (typeof value === 'string') facts.push(value);
    current = Reflect.get(current, 'cause');
  }
  return facts;
}

async function closeAndDropAudienceTestDatabase(
  close: (() => Promise<void>) | undefined,
  drop: (() => Promise<void>) | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of [close, drop]) {
    if (operation === undefined) continue;
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'The audience selection test database cleanup failed.',
    );
  }
}

describe('start-flow audience test cleanup', () => {
  test('attempts the exact drop after close failure and retains both errors', async () => {
    const operations: string[] = [];
    const closeError = new Error('Synthetic close failure.');
    const dropError = new Error('Synthetic drop failure.');
    let thrown: unknown;
    try {
      await closeAndDropAudienceTestDatabase(
        async () => {
          operations.push('close');
          throw closeError;
        },
        async () => {
          operations.push('drop');
          throw dropError;
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(operations).toEqual(['close', 'drop']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([closeError, dropError]);
  });
});

describeWithDatabase('start-flow audience version selection', () => {
  beforeAll(async () => {
    if (configuredTestDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for audience selection tests.',
      );
    }
    isolatedDatabaseMayExist = true;
    const isolatedUrl = await recreateStartFlowPlaywrightDatabase(
      configuredTestDatabaseUrl,
      runId,
    );
    const createdConnection = createDatabaseClient({
      driver: 'postgres',
      url: isolatedUrl,
      maxConnections: 1,
    });
    if (createdConnection.driver !== 'postgres') {
      throw new Error('Audience selection tests require PostgreSQL.');
    }
    connection = createdConnection;
    await migrateDatabase(createdConnection);
  });

  afterAll(async () => {
    const openConnection = connection;
    const databaseMayExist = isolatedDatabaseMayExist;
    connection = undefined;
    isolatedDatabaseMayExist = false;
    await closeAndDropAudienceTestDatabase(
      openConnection === undefined
        ? undefined
        : async () => openConnection.close(),
      databaseMayExist
        ? async () =>
            dropStartFlowPlaywrightDatabase(configuredTestDatabaseUrl, runId)
        : undefined,
    );
  });

  test('uses the highest version despite inverted timestamps and the database rejects a second lineage', async () => {
    const database = databaseConnection().db;
    const facilityId = randomUUID();
    const audienceId = randomUUID();
    await database.insert(facilities).values({
      id: facilityId,
      code: `AUD-${randomBytes(4).toString('hex').toUpperCase()}`,
      name: 'Synthetic audience selection facility',
      active: true,
    });
    await database.insert(audienceConfigurations).values([
      {
        id: audienceId,
        facilityId,
        version: 1,
        createdAt: new Date('2030-01-02T00:00:00.000Z'),
      },
      {
        id: audienceId,
        facilityId,
        version: 2,
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);

    const selected = await loadLatestAudienceConfigurationHeader(
      database,
      facilityId,
    );
    expect(selected).toMatchObject({ id: audienceId, version: 2 });

    let lineageError: unknown;
    try {
      await database.insert(audienceConfigurations).values({
        id: randomUUID(),
        facilityId,
        version: 1,
        createdAt: new Date('2030-01-03T00:00:00.000Z'),
      });
    } catch (error) {
      lineageError = error;
    }
    expect(postgresErrorFacts(lineageError, 'code')).toContain('55000');
    expect(postgresErrorFacts(lineageError, 'message').join('\n')).toMatch(
      /Admin version lineage cannot change/,
    );

    const stillSelected = await loadLatestAudienceConfigurationHeader(
      database,
      facilityId,
    );
    expect(stillSelected).toMatchObject({ id: audienceId, version: 2 });
  });
});
