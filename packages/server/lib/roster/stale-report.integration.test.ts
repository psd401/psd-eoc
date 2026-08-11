import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  RosterHealthQuerySchema,
  executeCapability,
  type CapabilityExecutionAuthorizer,
  type RosterHealthQuery,
} from '@psd-eoc/contracts';
import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedDatabase } from '../../db/seed';
import {
  endpointStatusRecords,
  groupSources,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  rosterSyncGroupFailures,
  rosterSyncResultSources,
  rosterSyncResults,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  createDrizzleStaleRosterReportStore,
  createGetStaleRosterReportHandler,
  type StaleRosterAuthorizationContext,
} from './stale-report';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface StaleReportTestContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i26_stale_[a-f0-9]{32}_test$/u;

const ids = Object.freeze({
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  facilitySouth: '00000000-0000-4000-8000-000000000002',
  groupNorth: '80000000-0000-4000-8000-000000000030',
  groupSouth: '80000000-0000-4000-8000-000000000031',
  groupOthers: '80000000-0000-4000-8000-000000000032',
  configuration: '80000000-0000-4000-8000-000000000040',
  snapshot: '80000000-0000-4000-8000-000000000041',
  recipientNorthStale: '80000000-0000-4000-8000-000000000050',
  recipientNorthActive: '80000000-0000-4000-8000-000000000051',
  recipientSouthNoEndpoint: '80000000-0000-4000-8000-000000000052',
  recipientOthersNoEndpoint: '80000000-0000-4000-8000-000000000053',
  endpointNorthStale: '80000000-0000-4000-8000-000000000060',
  endpointNorthActive: '80000000-0000-4000-8000-000000000061',
  endpointStatusNorthStale: '80000000-0000-4000-8000-000000000070',
  oldNorthFailureResult: '80000000-0000-4000-8000-000000000080',
  newSouthFailureResult: '80000000-0000-4000-8000-000000000081',
  newOthersFailureResult: '80000000-0000-4000-8000-000000000082',
  oldNorthFailure: '80000000-0000-4000-8000-000000000090',
  newSouthFailure: '80000000-0000-4000-8000-000000000091',
  newOthersFailure: '80000000-0000-4000-8000-000000000092',
});

const CONFIGURATION_CREATED_AT = new Date('2026-08-04T12:00:00.000Z');
const SNAPSHOT_STARTED_AT = new Date('2026-08-06T11:00:00.000Z');
const SNAPSHOT_CAPTURED_AT = new Date('2026-08-06T12:00:00.000Z');
const REPORT_TIME = new Date('2026-08-08T12:00:00.000Z');
const STALE_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;
const SNAPSHOT_VERSION = 8_008;

const NORTH_STALE_EMAIL = 'stale-report-north-canary@example.invalid';
const NORTH_ACTIVE_EMAIL = 'active-report-north-canary@example.invalid';

const groupRefs = Object.freeze([
  Object.freeze({
    id: ids.groupNorth,
    purpose: 'building' as const,
    facilityId: ids.facilityNorth,
  }),
  Object.freeze({
    id: ids.groupSouth,
    purpose: 'building' as const,
    facilityId: ids.facilitySouth,
  }),
  Object.freeze({
    id: ids.groupOthers,
    purpose: 'others' as const,
    facilityId: null,
  }),
]);

let context: StaleReportTestContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
let databaseCreated = false;

function buildContext(baseDatabaseUrl: string): StaleReportTestContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i26_stale_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable stale-report database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-26:stale-report-test:${runId}`,
  });
}

function openPostgresConnection(
  url: string,
  maxConnections: number,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Stale-report integration tests require PostgreSQL.');
  }
  return opened;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readDatabaseMarker(
  admin: PostgresDatabaseConnection,
  databaseName: string,
): Promise<string | null | undefined> {
  const rows = databaseExecuteRows<MarkerRow>(
    await admin.db.execute<MarkerRow>(sql`
      select shobj_description(oid, 'pg_database') as marker
      from pg_database
      where datname = ${databaseName}
    `),
  );
  if (rows.length > 1) {
    throw new Error(
      'The disposable stale-report database identity is ambiguous.',
    );
  }
  return rows[0]?.marker;
}

function requireDatabaseOwnership(
  createdContext: StaleReportTestContext,
  marker: string | null | undefined,
): void {
  if (marker !== createdContext.marker) {
    throw new Error(
      'Refusing to drop a database without the exact issue #26 stale-report ownership marker.',
    );
  }
}

async function createOwnedDatabase(
  createdContext: StaleReportTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  let created = false;
  try {
    await admin.db.execute(
      sql.raw(`create database "${createdContext.databaseName}"`),
    );
    created = true;
    await admin.db.execute(
      sql.raw(
        `comment on database "${createdContext.databaseName}" is ${quotedLiteral(createdContext.marker)}`,
      ),
    );
    requireDatabaseOwnership(
      createdContext,
      await readDatabaseMarker(admin, createdContext.databaseName),
    );
  } catch (error) {
    if (created) {
      try {
        await admin.db.execute(
          sql.raw(
            `drop database "${createdContext.databaseName}" with (force)`,
          ),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Disposable stale-report database creation and rollback both failed.',
        );
      }
    }
    throw error;
  } finally {
    await admin.close();
  }
}

async function dropOwnedDatabase(
  createdContext: StaleReportTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  try {
    const marker = await readDatabaseMarker(admin, createdContext.databaseName);
    if (marker === undefined) return;
    requireDatabaseOwnership(createdContext, marker);
    await admin.db.execute(
      sql.raw(`drop database "${createdContext.databaseName}" with (force)`),
    );
    expect(
      await readDatabaseMarker(admin, createdContext.databaseName),
    ).toBeUndefined();
  } finally {
    await admin.close();
  }
}

async function cleanupResources(): Promise<void> {
  const errors: unknown[] = [];
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      errors.push(error);
    } finally {
      connection = undefined;
    }
  }
  if (databaseCreated && context !== undefined) {
    try {
      await dropOwnedDatabase(context);
      databaseCreated = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #26 stale-report integration test cleanup failed.',
    );
  }
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The stale-report PostgreSQL connection is not open.');
  }
  return connection;
}

async function installStaffReportFixture(
  database: PostgresDatabase,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .insert(groupSources)
      .values([
        {
          id: ids.groupNorth,
          kind: 'google-group',
          purpose: 'building',
          facilityId: ids.facilityNorth,
          displayName: 'Synthetic report North staff',
          active: true,
          googleGroupId: 'synthetic-stale-report-north',
          email: 'stale-report-north-group@example.invalid',
          fixtureKey: null,
          createdAt: CONFIGURATION_CREATED_AT,
        },
        {
          id: ids.groupSouth,
          kind: 'google-group',
          purpose: 'building',
          facilityId: ids.facilitySouth,
          displayName: 'Synthetic report South staff',
          active: true,
          googleGroupId: 'synthetic-stale-report-south',
          email: 'stale-report-south-group@example.invalid',
          fixtureKey: null,
          createdAt: CONFIGURATION_CREATED_AT,
        },
        {
          id: ids.groupOthers,
          kind: 'google-group',
          purpose: 'others',
          facilityId: null,
          displayName: 'Synthetic report district staff',
          active: true,
          googleGroupId: 'synthetic-stale-report-others',
          email: 'stale-report-others-group@example.invalid',
          fixtureKey: null,
          createdAt: CONFIGURATION_CREATED_AT,
        },
      ])
      .onConflictDoNothing();

    await transaction
      .insert(rosterSourceConfigurations)
      .values({
        id: ids.configuration,
        version: 1,
        population: 'staff',
        createdAt: CONFIGURATION_CREATED_AT,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationFacilities)
      .values([
        {
          configurationId: ids.configuration,
          configurationVersion: 1,
          facilityId: ids.facilityNorth,
        },
        {
          configurationId: ids.configuration,
          configurationVersion: 1,
          facilityId: ids.facilitySouth,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationGroups)
      .values(
        groupRefs.map((source) => ({
          configurationId: ids.configuration,
          configurationVersion: 1,
          population: 'staff' as const,
          groupSourceId: source.id,
          groupSourceKind: 'google-group' as const,
          groupPurpose: source.purpose,
        })),
      )
      .onConflictDoNothing();

    await transaction
      .insert(rosterSnapshots)
      .values({
        id: ids.snapshot,
        version: SNAPSHOT_VERSION,
        population: 'staff',
        complete: true,
        sourceConfigurationId: ids.configuration,
        sourceConfigurationVersion: 1,
        syncStartedAt: SNAPSHOT_STARTED_AT,
        capturedAt: SNAPSHOT_CAPTURED_AT,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotFacilities)
      .values([
        {
          rosterSnapshotId: ids.snapshot,
          facilityId: ids.facilityNorth,
        },
        {
          rosterSnapshotId: ids.snapshot,
          facilityId: ids.facilitySouth,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotSources)
      .values(
        groupRefs.flatMap((source) =>
          (['expected', 'completed'] as const).map((completionKind) => ({
            rosterSnapshotId: ids.snapshot,
            population: 'staff' as const,
            groupSourceId: source.id,
            groupSourceKind: 'google-group' as const,
            groupPurpose: source.purpose,
            completionKind,
          })),
        ),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterRecipients)
      .values([
        {
          id: ids.recipientNorthStale,
          rosterSnapshotId: ids.snapshot,
          population: 'staff',
          googleSubject: 'synthetic-subject-report-north-stale',
          displayName: 'Synthetic Report North Stale',
        },
        {
          id: ids.recipientNorthActive,
          rosterSnapshotId: ids.snapshot,
          population: 'staff',
          googleSubject: 'synthetic-subject-report-north-active',
          displayName: 'Synthetic Report North Active',
        },
        {
          id: ids.recipientSouthNoEndpoint,
          rosterSnapshotId: ids.snapshot,
          population: 'staff',
          googleSubject: 'synthetic-subject-report-south-no-endpoint',
          displayName: 'Synthetic Report South No Endpoint',
        },
        {
          id: ids.recipientOthersNoEndpoint,
          rosterSnapshotId: ids.snapshot,
          population: 'staff',
          googleSubject: 'synthetic-subject-report-others-no-endpoint',
          displayName: 'Synthetic Report Others No Endpoint',
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterRecipientGroupSources)
      .values([
        {
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipientNorthStale,
          population: 'staff',
          groupSourceId: ids.groupNorth,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        },
        {
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipientNorthActive,
          population: 'staff',
          groupSourceId: ids.groupNorth,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        },
        {
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipientSouthNoEndpoint,
          population: 'staff',
          groupSourceId: ids.groupSouth,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        },
        {
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipientOthersNoEndpoint,
          population: 'staff',
          groupSourceId: ids.groupOthers,
          groupSourceKind: 'google-group',
          groupPurpose: 'others',
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterEndpoints)
      .values([
        {
          id: ids.endpointNorthStale,
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipientNorthStale,
          population: 'staff',
          channel: 'email',
          status: 'active',
          capturedAt: SNAPSHOT_CAPTURED_AT,
          platform: null,
          token: null,
          email: NORTH_STALE_EMAIL,
          phoneNumber: null,
        },
        {
          id: ids.endpointNorthActive,
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipientNorthActive,
          population: 'staff',
          channel: 'email',
          status: 'active',
          capturedAt: SNAPSHOT_CAPTURED_AT,
          platform: null,
          token: null,
          email: NORTH_ACTIVE_EMAIL,
          phoneNumber: null,
        },
      ])
      .onConflictDoNothing();

    await transaction
      .insert(endpointStatusRecords)
      .values({
        id: ids.endpointStatusNorthStale,
        rosterSnapshotId: ids.snapshot,
        recipientId: ids.recipientNorthStale,
        endpointId: ids.endpointNorthStale,
        population: 'staff',
        channel: 'email',
        status: 'invalid',
        reasonCode: 'SYNTHETIC_REPORT_TEST',
        recordedAt: new Date('2026-08-06T13:00:00.000Z'),
      })
      .onConflictDoNothing();

    await transaction
      .insert(rosterSyncResults)
      .values([
        {
          id: ids.oldNorthFailureResult,
          sourceConfigurationId: ids.configuration,
          sourceConfigurationVersion: 1,
          population: 'staff',
          outcome: 'failed',
          startedAt: new Date('2026-08-05T09:00:00.000Z'),
          completedAt: new Date('2026-08-05T09:30:00.000Z'),
          expectedSourceCount: 1,
          completedSourceCount: 0,
          groupFailureCount: 1,
          publishedSnapshotId: null,
        },
        {
          id: ids.newSouthFailureResult,
          sourceConfigurationId: ids.configuration,
          sourceConfigurationVersion: 1,
          population: 'staff',
          outcome: 'failed',
          startedAt: new Date('2026-08-07T09:00:00.000Z'),
          completedAt: new Date('2026-08-07T09:30:00.000Z'),
          expectedSourceCount: 1,
          completedSourceCount: 0,
          groupFailureCount: 1,
          publishedSnapshotId: null,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSyncResultSources)
      .values([
        {
          syncResultId: ids.oldNorthFailureResult,
          population: 'staff',
          groupSourceId: ids.groupNorth,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
          setKind: 'expected',
          expectedSetKind: 'expected',
        },
        {
          syncResultId: ids.newSouthFailureResult,
          population: 'staff',
          groupSourceId: ids.groupSouth,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
          setKind: 'expected',
          expectedSetKind: 'expected',
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSyncGroupFailures)
      .values([
        {
          id: ids.oldNorthFailure,
          syncResultId: ids.oldNorthFailureResult,
          population: 'staff',
          groupSourceId: ids.groupNorth,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
          expectedSetKind: 'expected',
          errorCode: 'SYNTHETIC_OLD_NORTH_FAILURE',
          attemptedAt: new Date('2026-08-05T09:15:00.000Z'),
        },
        {
          id: ids.newSouthFailure,
          syncResultId: ids.newSouthFailureResult,
          population: 'staff',
          groupSourceId: ids.groupSouth,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
          expectedSetKind: 'expected',
          errorCode: 'SYNTHETIC_NEW_SOUTH_FAILURE',
          attemptedAt: new Date('2026-08-07T09:15:00.000Z'),
        },
      ])
      .onConflictDoNothing();
  });
}

function query(
  facilityId: string | null,
  cursor: string | null = null,
): RosterHealthQuery {
  return RosterHealthQuerySchema.parse({
    population: 'staff',
    facilityId,
    cursor,
    limit: 200,
  });
}

function authorizer(): CapabilityExecutionAuthorizer<StaleRosterAuthorizationContext> {
  const value: CapabilityExecutionAuthorizer<StaleRosterAuthorizationContext> =
    {
      authorize(request): void {
        expect(request.definition.id).toBe('get-stale-roster-report');
        expect(request.definition.operation).toBe('query');
        expect(request.humanActionRequirement.actionIds).toEqual([]);
      },
    };
  return Object.freeze(value);
}

async function executeReport(
  database: PostgresDatabase,
  input: RosterHealthQuery,
  context: StaleRosterAuthorizationContext,
) {
  return executeCapability(
    createGetStaleRosterReportHandler({
      store: createDrizzleStaleRosterReportStore(database),
      clock: () => REPORT_TIME,
      staleThresholdSeconds: STALE_THRESHOLD_SECONDS,
    }),
    input,
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: authorizer(),
    },
  );
}

describeWithDatabase('PostgreSQL stale-roster report capability', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }

    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      databaseCreated = true;
      connection = openPostgresConnection(context.databaseUrl, 3);
      await migrateDatabase(connection);
      await seedDatabase(connection.db);
      await installStaffReportFixture(connection.db);
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Stale-report database setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
  });

  test('requires the exact run marker before disposable database cleanup', () => {
    const currentContext = context;
    if (currentContext === undefined) {
      throw new Error('The stale-report test context is not available.');
    }
    expect(() => requireDatabaseOwnership(currentContext, null)).toThrow(
      'Refusing to drop a database without the exact issue #26 stale-report ownership marker.',
    );
    expect(() =>
      requireDatabaseOwnership(currentContext, 'wrong-marker'),
    ).toThrow(
      'Refusing to drop a database without the exact issue #26 stale-report ownership marker.',
    );
    expect(() =>
      requireDatabaseOwnership(currentContext, currentContext.marker),
    ).not.toThrow();
  });

  test('returns endpoint-value-free district and facility-scoped stale recipients', async () => {
    const database = databaseConnection().db;
    const district = await executeReport(database, query(null), {
      facilityScope: { kind: 'district' },
    });
    const north = await executeReport(database, query(ids.facilityNorth), {
      facilityScope: {
        kind: 'facilities',
        facilityIds: [ids.facilityNorth],
      },
    });

    expect(district.latestCompleteSnapshotId).toBe(ids.snapshot);
    expect(district.failedGroups).toHaveLength(1);
    expect(district.failedGroups[0]?.groupSourceRef.id).toBe(ids.groupSouth);
    expect(district.staleRecipients).toEqual([
      {
        recipientId: ids.recipientNorthStale,
        reason: 'no-active-endpoint',
      },
      {
        recipientId: ids.recipientSouthNoEndpoint,
        reason: 'no-endpoint',
      },
      {
        recipientId: ids.recipientOthersNoEndpoint,
        reason: 'no-endpoint',
      },
    ]);
    expect(north.staleRecipients).toEqual([
      {
        recipientId: ids.recipientNorthStale,
        reason: 'no-active-endpoint',
      },
    ]);
    expect(north.staleRecipients).not.toContainEqual({
      recipientId: ids.recipientNorthActive,
      reason: 'no-active-endpoint',
    });

    const serialized = JSON.stringify({ district, north });
    expect(serialized).not.toContain(NORTH_STALE_EMAIL);
    expect(serialized).not.toContain(NORTH_ACTIVE_EMAIL);
    expect(serialized).not.toContain('Synthetic Report');
    expect(serialized).not.toContain('googleSubject');
    expect(serialized).not.toContain('displayName');
  });

  test('keeps the report stale when a cursor pages past an earlier stale recipient', async () => {
    const afterNorthStale = Buffer.from(
      ids.recipientNorthStale,
      'utf8',
    ).toString('base64url');
    const report = await executeReport(
      databaseConnection().db,
      query(ids.facilityNorth, afterNorthStale),
      {
        facilityScope: {
          kind: 'facilities',
          facilityIds: [ids.facilityNorth],
        },
      },
    );

    expect(report.status).toBe('stale');
    expect(report.staleRecipients).toEqual([]);
    expect(report.failedGroups).toEqual([]);
  });

  test('surfaces a newer scoped failure and clears an older failure after recovery', async () => {
    const database = databaseConnection().db;
    const north = await executeReport(database, query(ids.facilityNorth), {
      facilityScope: {
        kind: 'facilities',
        facilityIds: [ids.facilityNorth],
      },
    });
    const south = await executeReport(database, query(ids.facilitySouth), {
      facilityScope: {
        kind: 'facilities',
        facilityIds: [ids.facilitySouth],
      },
    });

    expect(north.status).toBe('stale');
    expect(north.failedGroups).toEqual([]);
    expect(south.status).toBe('failed');
    expect(south.failedGroups).toEqual([
      {
        groupSourceRef: {
          id: ids.groupSouth,
          kind: 'google-group',
          purpose: 'building',
          facilityId: ids.facilitySouth,
        },
        errorCode: 'SYNTHETIC_NEW_SOUTH_FAILURE',
        attemptedAt: '2026-08-07T09:15:00.000Z',
      },
    ]);
    expect(south.staleRecipients).toEqual([
      {
        recipientId: ids.recipientSouthNoEndpoint,
        reason: 'no-endpoint',
      },
    ]);
  });

  test('surfaces shared others failures without disclosing facility-unbound recipient IDs', async () => {
    const database = databaseConnection().db;
    await database.transaction(async (transaction) => {
      await transaction.insert(rosterSyncResults).values({
        id: ids.newOthersFailureResult,
        sourceConfigurationId: ids.configuration,
        sourceConfigurationVersion: 1,
        population: 'staff',
        outcome: 'failed',
        startedAt: new Date('2026-08-07T10:00:00.000Z'),
        completedAt: new Date('2026-08-07T10:30:00.000Z'),
        expectedSourceCount: 1,
        completedSourceCount: 0,
        groupFailureCount: 1,
        publishedSnapshotId: null,
      });
      await transaction.insert(rosterSyncResultSources).values({
        syncResultId: ids.newOthersFailureResult,
        population: 'staff',
        groupSourceId: ids.groupOthers,
        groupSourceKind: 'google-group',
        groupPurpose: 'others',
        setKind: 'expected',
        expectedSetKind: 'expected',
      });
      await transaction.insert(rosterSyncGroupFailures).values({
        id: ids.newOthersFailure,
        syncResultId: ids.newOthersFailureResult,
        population: 'staff',
        groupSourceId: ids.groupOthers,
        groupSourceKind: 'google-group',
        groupPurpose: 'others',
        expectedSetKind: 'expected',
        errorCode: 'SYNTHETIC_NEW_OTHERS_FAILURE',
        attemptedAt: new Date('2026-08-07T10:15:00.000Z'),
      });
    });

    const north = await executeReport(database, query(ids.facilityNorth), {
      facilityScope: {
        kind: 'facilities',
        facilityIds: [ids.facilityNorth],
      },
    });

    expect(north.status).toBe('failed');
    expect(north.failedGroups).toEqual([
      {
        groupSourceRef: {
          id: ids.groupOthers,
          kind: 'google-group',
          purpose: 'others',
          facilityId: null,
        },
        errorCode: 'SYNTHETIC_NEW_OTHERS_FAILURE',
        attemptedAt: '2026-08-07T10:15:00.000Z',
      },
    ]);
    expect(north.staleRecipients).toEqual([
      {
        recipientId: ids.recipientNorthStale,
        reason: 'no-active-endpoint',
      },
    ]);
    expect(north.staleRecipients).not.toContainEqual({
      recipientId: ids.recipientOthersNoEndpoint,
      reason: 'no-endpoint',
    });
  });

  test('denies an out-of-scope facility before starting a database transaction', async () => {
    const database = databaseConnection().db;
    let transactionStarts = 0;
    const trackedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'transaction') {
          return value;
        }
        if (typeof value !== 'function') {
          throw new Error('The database transaction member is not callable.');
        }
        return (...args: unknown[]) => {
          transactionStarts += 1;
          return Reflect.apply(value, target, args);
        };
      },
    });

    await expect(
      executeReport(trackedDatabase, query(ids.facilitySouth), {
        facilityScope: {
          kind: 'facilities',
          facilityIds: [ids.facilityNorth],
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REPORT_EVIDENCE',
      name: 'StaleRosterReportError',
    });
    expect(transactionStarts).toBe(0);
  });
});
