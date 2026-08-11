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
import { CapabilityEngineError } from '../../../../lib/capabilities/engine';
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
let isolatedDatabaseCreated = false;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The start-flow integration database is not open.');
  }
  return connection;
}

describeWithDatabase('start-flow audience version selection', () => {
  beforeAll(async () => {
    if (configuredTestDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for audience selection tests.',
      );
    }
    const isolatedUrl = await recreateStartFlowPlaywrightDatabase(
      configuredTestDatabaseUrl,
      runId,
    );
    isolatedDatabaseCreated = true;
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
    await connection?.close();
    connection = undefined;
    if (isolatedDatabaseCreated) {
      await dropStartFlowPlaywrightDatabase(configuredTestDatabaseUrl, runId);
      isolatedDatabaseCreated = false;
    }
  });

  test('uses the highest version despite inverted timestamps and rejects a second lineage', async () => {
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

    await database.insert(audienceConfigurations).values({
      id: randomUUID(),
      facilityId,
      version: 1,
      createdAt: new Date('2030-01-03T00:00:00.000Z'),
    });
    let thrown: unknown;
    try {
      await loadLatestAudienceConfigurationHeader(database, facilityId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CapabilityEngineError);
    expect(thrown).toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 409,
    });
  });
});
