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
  type DatabaseQuery,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  facilities,
  groupSources,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
} from '../../../../db/schema';
import { migrateDatabase } from '../../../../drizzle/migrate';
import {
  createDisposableDatabase,
  type DisposableDatabase,
} from '../../../../lib/testing/database';
import { loadRosterSnapshot } from '../../../../lib/capabilities/start';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  configuredTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;
let isolatedDatabase: DisposableDatabase | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The start-flow integration database is not open.');
  }
  return connection;
}

async function closeAndDropRosterTestDatabase(
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
      'The roster hydration test database cleanup failed.',
    );
  }
}

describe('start-flow roster test cleanup', () => {
  test('attempts the exact drop after close failure and retains both errors', async () => {
    const operations: string[] = [];
    const closeError = new Error('Synthetic close failure.');
    const dropError = new Error('Synthetic drop failure.');
    let thrown: unknown;
    try {
      await closeAndDropRosterTestDatabase(
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

describeWithDatabase('start-flow roster hydration', () => {
  beforeAll(async () => {
    if (configuredTestDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for roster hydration tests.',
      );
    }
    const disposable = await createDisposableDatabase(
      'psd_eoc_start_roster',
      configuredTestDatabaseUrl,
    );
    isolatedDatabase = disposable;
    const createdConnection = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 1,
    });
    if (createdConnection.driver !== 'postgres') {
      throw new Error('Roster hydration tests require PostgreSQL.');
    }
    connection = createdConnection;
    await migrateDatabase(createdConnection);
  });

  afterAll(async () => {
    const openConnection = connection;
    const disposable = isolatedDatabase;
    connection = undefined;
    isolatedDatabase = undefined;
    await closeAndDropRosterTestDatabase(
      openConnection === undefined
        ? undefined
        : async () => openConnection.close(),
      disposable === undefined ? undefined : () => disposable.drop(),
    );
  });

  test('round-trips an email-only staff recipient without inventing a Google subject', async () => {
    const database = databaseConnection().db;
    const facilityId = randomUUID();
    const sourceId = randomUUID();
    const configurationId = randomUUID();
    const snapshotId = randomUUID();
    const recipientId = randomUUID();
    const capturedAt = new Date('2030-01-04T00:00:00.000Z');
    const staffEmail = `email-only-${randomBytes(8).toString('hex')}@example.invalid`;

    await database.transaction(async (transaction) => {
      await transaction.insert(facilities).values({
        id: facilityId,
        code: `ER-${randomBytes(4).toString('hex').toUpperCase()}`,
        name: 'Synthetic email-only roster facility',
        active: true,
      });
      await transaction.insert(groupSources).values({
        id: sourceId,
        kind: 'google-group',
        purpose: 'building',
        facilityId,
        displayName: 'Synthetic Cloud Identity staff group',
        active: true,
        googleGroupId: `synthetic-${randomBytes(8).toString('hex')}`,
        email: `synthetic-${randomBytes(8).toString('hex')}@example.invalid`,
        createdAt: capturedAt,
      });
      await transaction.insert(rosterSourceConfigurations).values({
        id: configurationId,
        version: 1,
        population: 'staff',
        createdAt: capturedAt,
      });
      await transaction.insert(rosterSourceConfigurationFacilities).values({
        configurationId,
        configurationVersion: 1,
        facilityId,
      });
      await transaction.insert(rosterSourceConfigurationGroups).values({
        configurationId,
        configurationVersion: 1,
        population: 'staff',
        groupSourceId: sourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
      });
      await transaction.insert(rosterSnapshots).values({
        id: snapshotId,
        version: 1,
        population: 'staff',
        complete: true,
        sourceConfigurationId: configurationId,
        sourceConfigurationVersion: 1,
        syncStartedAt: capturedAt,
        capturedAt,
      });
      await transaction.insert(rosterSnapshotFacilities).values({
        rosterSnapshotId: snapshotId,
        facilityId,
      });
      await transaction.insert(rosterSnapshotSources).values([
        {
          rosterSnapshotId: snapshotId,
          population: 'staff',
          groupSourceId: sourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
          completionKind: 'expected',
        },
        {
          rosterSnapshotId: snapshotId,
          population: 'staff',
          groupSourceId: sourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
          completionKind: 'completed',
        },
      ]);
      await transaction.insert(rosterRecipients).values({
        id: recipientId,
        rosterSnapshotId: snapshotId,
        population: 'staff',
        googleSubject: null,
        staffEmail,
        displayName: 'Synthetic Email-Only Staff',
      });
      await transaction.insert(rosterRecipientGroupSources).values({
        rosterSnapshotId: snapshotId,
        recipientId,
        population: 'staff',
        groupSourceId: sourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
      });
    });

    for (const nonCanonicalStaffEmail of [
      'UPPERCASE.STAFF@EXAMPLE.INVALID',
      'external.staff@example.com',
    ]) {
      await expect(
        (async () => {
          await database.insert(rosterRecipients).values({
            id: randomUUID(),
            rosterSnapshotId: snapshotId,
            population: 'staff',
            googleSubject: null,
            staffEmail: nonCanonicalStaffEmail,
            displayName: 'Rejected Noncanonical Staff',
          });
        })(),
      ).rejects.toThrow();
    }

    const hydrated = await loadRosterSnapshot(
      database as unknown as DatabaseQuery,
      'staff',
      facilityId,
      snapshotId,
    );

    expect(hydrated?.recipients).toEqual([
      {
        id: recipientId,
        population: 'staff',
        googleSubject: null,
        staffEmail,
        displayName: 'Synthetic Email-Only Staff',
        groupSourceRefs: [
          {
            id: sourceId,
            kind: 'google-group',
            purpose: 'building',
            facilityId,
          },
        ],
        endpoints: [],
      },
    ]);
  });
});
