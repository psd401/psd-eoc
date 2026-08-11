import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { RosterHealthQuerySchema } from '@psd-eoc/contracts';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../packages/server/db/client';
import { seedDatabase } from '../../packages/server/db/seed';
import {
  endpointStatusRecords,
  smsOptOutRecords,
} from '../../packages/server/db/schema';
import { migrateDatabase } from '../../packages/server/drizzle/migrate';
import {
  createDrizzleSmsPolicyStore,
  SMS_OPT_OUT_REASON_CODE,
} from '../../packages/server/lib/notify/sms-policy';
import {
  buildStaleRosterReport,
  createDrizzleStaleRosterReportStore,
} from '../../packages/server/lib/roster/stale-report';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const SEEDED_ROSTER = '00000000-0000-4000-8000-000000000041';
const IDS = Object.freeze({
  recipient: '00000000-0000-4000-8000-000000000050',
  pushEndpoint: '00000000-0000-4000-8000-000000000060',
  emailEndpoint: '00000000-0000-4000-8000-000000000061',
  endpoint: '00000000-0000-4000-8000-000000000062',
  pushStatus: '10000000-0000-4000-8000-000000000014',
  emailStatus: '20000000-0000-4000-8000-000000000014',
  optOutRecord: '30000000-0000-4000-8000-000000000014',
  endpointStatus: '40000000-0000-4000-8000-000000000014',
});
const isolatedDatabaseName = `psd_eoc_issue14_${randomUUID().replaceAll('-', '')}_test`;

let connection: PostgresDatabaseConnection | undefined;
let controlConnection: PostgresDatabaseConnection | undefined;

function isolatedTestDatabaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${isolatedDatabaseName}`;
  return parsed.toString();
}

function databaseIdentifierStatement(operation: 'create' | 'drop') {
  if (!/^[a-z0-9_]+$/u.test(isolatedDatabaseName)) {
    throw new Error('The generated SMS policy test database name is unsafe.');
  }
  return sql.raw(
    operation === 'create'
      ? `create database "${isolatedDatabaseName}" template template0`
      : `drop database if exists "${isolatedDatabaseName}" with (force)`,
  );
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The SMS policy PostgreSQL test connection is not open.');
  }
  return connection;
}

describeWithDatabase('PostgreSQL SMS opt-out and stale-report proof', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for this integration test.',
      );
    }
    const createdControlConnection = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 1,
    });
    if (createdControlConnection.driver !== 'postgres') {
      throw new Error('The SMS policy integration test requires PostgreSQL.');
    }
    controlConnection = createdControlConnection;
    await migrateDatabase(createdControlConnection);
    await createdControlConnection.db.execute(
      databaseIdentifierStatement('create'),
    );

    const createdIsolatedConnection = createDatabaseClient({
      driver: 'postgres',
      url: isolatedTestDatabaseUrl(testDatabaseUrl),
      maxConnections: 4,
    });
    if (createdIsolatedConnection.driver !== 'postgres') {
      throw new Error('The isolated SMS policy test requires PostgreSQL.');
    }
    connection = createdIsolatedConnection;
    await migrateDatabase(createdIsolatedConnection);
    await seedDatabase(createdIsolatedConnection.db);
    await createdIsolatedConnection.db.insert(endpointStatusRecords).values([
      {
        id: IDS.pushStatus,
        rosterSnapshotId: SEEDED_ROSTER,
        recipientId: IDS.recipient,
        endpointId: IDS.pushEndpoint,
        population: 'synthetic',
        channel: 'push',
        status: 'disabled',
        reasonCode: 'SYNTHETIC_TEST_DISABLED',
        recordedAt: new Date('2026-08-11T17:58:00.000Z'),
      },
      {
        id: IDS.emailStatus,
        rosterSnapshotId: SEEDED_ROSTER,
        recipientId: IDS.recipient,
        endpointId: IDS.emailEndpoint,
        population: 'synthetic',
        channel: 'email',
        status: 'disabled',
        reasonCode: 'SYNTHETIC_TEST_DISABLED',
        recordedAt: new Date('2026-08-11T17:59:00.000Z'),
      },
    ]);
  });

  afterAll(async () => {
    await connection?.close();
    connection = undefined;
    if (controlConnection !== undefined) {
      await controlConnection.db.execute(databaseIdentifierStatement('drop'));
      await controlConnection.close();
      controlConnection = undefined;
    }
  });

  test('persists and honors an opt-out and lists its recipient as stale', async () => {
    const database = databaseConnection().db;
    const generatedIds = [IDS.optOutRecord, IDS.endpointStatus];
    const store = createDrizzleSmsPolicyStore(database, {
      uuid() {
        const id = generatedIds.shift();
        if (id === undefined) {
          throw new Error('The SMS policy test requested an unexpected UUID.');
        }
        return id;
      },
    });
    const input = {
      rosterSnapshotId: SEEDED_ROSTER,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      provider: 'aws-eum-sms',
      providerReference: 'synthetic-stop-conflict-1',
    } as const;

    const first = await store.recordSmsOptOut(input);
    const replay = await store.recordSmsOptOut(input);
    expect(replay).toEqual(first);

    const retainedOptOuts = await database
      .select()
      .from(smsOptOutRecords)
      .where(eq(smsOptOutRecords.endpointId, IDS.endpoint));
    const retainedStatuses = await database
      .select()
      .from(endpointStatusRecords)
      .where(eq(endpointStatusRecords.endpointId, IDS.endpoint));
    expect(retainedOptOuts).toHaveLength(1);
    expect(retainedOptOuts[0]).toEqual(
      expect.objectContaining({
        id: IDS.optOutRecord,
        provider: 'aws-eum-sms',
        providerReference: 'synthetic-stop-conflict-1',
      }),
    );
    expect(retainedStatuses).toEqual([
      expect.objectContaining({
        id: IDS.endpointStatus,
        status: 'disabled',
        reasonCode: SMS_OPT_OUT_REASON_CODE,
      }),
    ]);

    await expect(
      store.loadEndpointPolicy({
        rosterSnapshotId: SEEDED_ROSTER,
        rosterPopulation: 'synthetic',
        candidates: [{ recipientId: IDS.recipient, endpointId: IDS.endpoint }],
      }),
    ).resolves.toEqual([
      {
        recipientId: IDS.recipient,
        endpointId: IDS.endpoint,
        status: 'disabled',
        optedOut: true,
      },
    ]);

    const query = RosterHealthQuerySchema.parse({
      population: 'synthetic',
      facilityId: null,
      cursor: null,
      limit: 200,
    });
    const evidence = await createDrizzleStaleRosterReportStore(
      database,
    ).loadScopedEvidence(query, { facilityScope: { kind: 'district' } });
    const report = buildStaleRosterReport(evidence, {
      generatedAt: new Date('2026-08-11T18:00:00.000Z'),
      staleThresholdSeconds: 1_000_000,
    });
    expect(report.status).toBe('stale');
    expect(report.staleRecipients).toContainEqual({
      recipientId: IDS.recipient,
      reason: 'no-active-endpoint',
    });
  });
});
