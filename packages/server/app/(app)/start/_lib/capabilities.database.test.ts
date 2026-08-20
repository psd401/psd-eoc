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
  audienceConfigurations,
  audienceTargets,
  facilities,
  groupSources,
  neighborhoodFacilities,
  neighborhoodVersions,
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
import { BoundedDatabaseQueryError } from './bounded-query';
import {
  loadAudienceConfiguration,
  loadLatestAudienceConfigurationHeader,
  loadRosterSnapshot,
} from './capabilities';

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
    const disposable = await createDisposableDatabase(
      'psd_eoc_start_audience',
      configuredTestDatabaseUrl,
    );
    isolatedDatabase = disposable;
    const createdConnection = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
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
    const disposable = isolatedDatabase;
    connection = undefined;
    isolatedDatabase = undefined;
    await closeAndDropAudienceTestDatabase(
      openConnection === undefined
        ? undefined
        : async () => openConnection.close(),
      disposable === undefined ? undefined : () => disposable.drop(),
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

  test('fails closed before materializing more than 500 audience targets', async () => {
    const database = databaseConnection().db;
    const facilityId = randomUUID();
    const audienceId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.insert(facilities).values({
        id: facilityId,
        code: `AT-${randomBytes(4).toString('hex').toUpperCase()}`,
        name: 'Synthetic oversized audience facility',
        active: true,
      });
      await transaction.insert(audienceConfigurations).values({
        id: audienceId,
        facilityId,
        version: 1,
        createdAt: new Date('2030-02-01T00:00:00.000Z'),
      });
      await transaction.insert(audienceTargets).values(
        Array.from({ length: 501 }, (_, index) => ({
          audienceConfigId: audienceId,
          audienceConfigVersion: 1,
          ordinal: index + 1,
          targetKind: 'building' as const,
          targetFacilityId: facilityId,
        })),
      );
    });

    await expect(
      loadAudienceConfiguration(
        database as unknown as DatabaseQuery,
        facilityId,
      ),
    ).rejects.toBeInstanceOf(BoundedDatabaseQueryError);
  });

  test('resolves more than one bounded page of others sources in stable order', async () => {
    const database = databaseConnection().db;
    const facilityId = randomUUID();
    const audienceId = randomUUID();
    const prefix = randomBytes(4).toString('hex');
    const sourceIds = Array.from({ length: 101 }, () => randomUUID());
    await database.transaction(async (transaction) => {
      await transaction.insert(facilities).values({
        id: facilityId,
        code: `OS-${prefix.toUpperCase()}`,
        name: 'Synthetic paged others audience facility',
        active: true,
      });
      await transaction.insert(groupSources).values(
        sourceIds.map((id, index) => ({
          id,
          kind: 'synthetic' as const,
          purpose: 'others' as const,
          facilityId: null,
          displayName: `Synthetic others source ${index + 1}`,
          active: true,
          fixtureKey: `aud-${prefix}-${index + 1}`,
        })),
      );
      await transaction.insert(audienceConfigurations).values({
        id: audienceId,
        facilityId,
        version: 1,
        createdAt: new Date('2030-02-02T00:00:00.000Z'),
      });
      await transaction.insert(audienceTargets).values(
        sourceIds.map((groupSourceId, index) => ({
          audienceConfigId: audienceId,
          audienceConfigVersion: 1,
          ordinal: index + 1,
          targetKind: 'others' as const,
          groupSourceId,
        })),
      );
    });

    const loaded = await loadAudienceConfiguration(
      database as unknown as DatabaseQuery,
      facilityId,
    );
    expect(loaded?.audienceConfig.targets).toHaveLength(101);
    expect(
      loaded?.audienceConfig.targets.every(
        (target) => target.kind === 'others',
      ),
    ).toBe(true);
    expect(loaded?.neighborhoodVersions).toEqual([]);
  });

  test('fails closed before materializing more than 200 neighborhood facilities', async () => {
    const database = databaseConnection().db;
    const ownerFacilityId = randomUUID();
    const audienceId = randomUUID();
    const neighborhoodId = randomUUID();
    const prefix = randomBytes(4).toString('hex').toUpperCase();
    const memberFacilities = Array.from({ length: 201 }, (_, index) => ({
      id: index === 0 ? ownerFacilityId : randomUUID(),
      code: `NM-${prefix}-${index + 1}`,
      name: `Synthetic neighborhood member ${index + 1}`,
      active: true,
    }));
    await database.transaction(async (transaction) => {
      await transaction.insert(facilities).values(memberFacilities);
      await transaction.insert(neighborhoodVersions).values({
        id: neighborhoodId,
        version: 1,
        name: 'Synthetic oversized neighborhood',
        createdAt: new Date('2030-02-03T00:00:00.000Z'),
      });
      await transaction.insert(neighborhoodFacilities).values(
        memberFacilities.map((facility) => ({
          neighborhoodId,
          neighborhoodVersion: 1,
          facilityId: facility.id,
        })),
      );
      await transaction.insert(audienceConfigurations).values({
        id: audienceId,
        facilityId: ownerFacilityId,
        version: 1,
        createdAt: new Date('2030-02-03T00:00:00.000Z'),
      });
      await transaction.insert(audienceTargets).values({
        audienceConfigId: audienceId,
        audienceConfigVersion: 1,
        ordinal: 1,
        targetKind: 'neighborhood',
        neighborhoodId,
        neighborhoodVersion: 1,
      });
    });

    await expect(
      loadAudienceConfiguration(
        database as unknown as DatabaseQuery,
        ownerFacilityId,
      ),
    ).rejects.toBeInstanceOf(BoundedDatabaseQueryError);
  });
});
