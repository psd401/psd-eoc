import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  RosterHealthQuerySchema,
  type SmsLifecycleCapabilityContext,
} from '@psd-eoc/contracts';
import { asc, eq, sql } from 'drizzle-orm';
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
  executeRecordEndpointStatusCapability,
  executeRecordSmsOptOutCapability,
  SMS_OPT_IN_REASON_CODE,
  SMS_OPT_OUT_REASON_CODE,
} from '../../packages/server/lib/notify/sms-policy';
import {
  buildStaleRosterReport,
  createDrizzleStaleRosterReportStore,
  type ScopedStaleRosterEvidence,
} from '../../packages/server/lib/roster/stale-report';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const SEEDED_ROSTER = '00000000-0000-4000-8000-000000000041';
const IDS = Object.freeze({
  recipient: '00000000-0000-4000-8000-000000000050',
  endpoint: '00000000-0000-4000-8000-000000000062',
  optOutRecord: '30000000-0000-4000-8000-000000000014',
  endpointStatus: '40000000-0000-4000-8000-000000000014',
  activeEndpointStatus: '50000000-0000-4000-8000-000000000014',
  delayedOptOutRecord: '60000000-0000-4000-8000-000000000014',
  delayedOptOutStatus: '70000000-0000-4000-8000-000000000014',
  newOptOutRecord: '71000000-0000-4000-8000-000000000014',
  newOptOutStatus: '72000000-0000-4000-8000-000000000014',
  delayedActiveStatus: '73000000-0000-4000-8000-000000000014',
  baseInvalidStatus: '74000000-0000-4000-8000-000000000014',
  newestActiveStatus: '75000000-0000-4000-8000-000000000014',
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

  test('projects the latest authenticated append-only SMS lifecycle fact', async () => {
    const database = databaseConnection().db;
    const generatedIds = [
      IDS.optOutRecord,
      IDS.endpointStatus,
      IDS.activeEndpointStatus,
      IDS.delayedOptOutRecord,
      IDS.delayedOptOutStatus,
      IDS.newOptOutRecord,
      IDS.newOptOutStatus,
      IDS.delayedActiveStatus,
      IDS.baseInvalidStatus,
      IDS.newestActiveStatus,
    ];
    const store = createDrizzleSmsPolicyStore(database, {
      uuid() {
        const id = generatedIds.shift();
        if (id === undefined) {
          throw new Error('The SMS policy test requested an unexpected UUID.');
        }
        return id;
      },
    });
    const workerContext: SmsLifecycleCapabilityContext = {
      actor: { kind: 'system', serviceId: 'sms-worker' },
      source: 'worker',
      transport: 'sqs',
      requestId: '80000000-0000-4000-8000-000000000014',
      authenticated: true,
    };
    const webhookContext: SmsLifecycleCapabilityContext = {
      actor: { kind: 'system', serviceId: 'sms-opt-in-webhook' },
      source: 'webhook',
      transport: 'provider-webhook',
      requestId: '90000000-0000-4000-8000-000000000014',
      authenticated: true,
    };
    const firstOptOut = {
      rosterSnapshotId: SEEDED_ROSTER,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      provider: 'aws-eum-sms',
      providerReference: 'synthetic-stop-conflict-1',
      providerOccurredAt: '2026-08-10T18:00:00.000Z',
    } as const;

    await expect(
      executeRecordSmsOptOutCapability(
        firstOptOut,
        {
          ...workerContext,
          authenticated: false,
        } as unknown as SmsLifecycleCapabilityContext,
        store,
      ),
    ).rejects.toMatchObject({ code: 'SMS_LIFECYCLE_INVOCATION_DENIED' });

    const first = await executeRecordSmsOptOutCapability(
      firstOptOut,
      workerContext,
      store,
    );
    const replay = await executeRecordSmsOptOutCapability(
      firstOptOut,
      workerContext,
      store,
    );
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
        providerOccurredAt: new Date(firstOptOut.providerOccurredAt),
      }),
    );
    expect(retainedStatuses).toEqual([
      expect.objectContaining({
        id: IDS.endpointStatus,
        status: 'disabled',
        reasonCode: SMS_OPT_OUT_REASON_CODE,
        provider: 'aws-eum-sms',
        providerReference: 'synthetic-stop-conflict-1',
        providerOccurredAt: new Date(firstOptOut.providerOccurredAt),
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
        status: 'active',
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
    expect(report.staleRecipients).not.toContainEqual({
      recipientId: IDS.recipient,
      reason: 'no-active-endpoint',
    });
    expect(report.staleEndpoints).toContainEqual({
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      channel: 'sms',
      reason: 'sms-opted-out',
    });
    expect(JSON.stringify(report)).not.toMatch(/\+1|@|token/iu);

    const afterEndpointCursor = RosterHealthQuerySchema.parse({
      population: 'synthetic',
      facilityId: null,
      cursor: Buffer.from(IDS.recipient).toString('base64url'),
      limit: 200,
    });
    const cursorEvidence = (await createDrizzleStaleRosterReportStore(
      database,
    ).loadScopedEvidence(afterEndpointCursor, {
      facilityScope: { kind: 'district' },
    })) as ScopedStaleRosterEvidence;
    expect(
      cursorEvidence.latestCompleteSnapshot?.hasUnreportedStaleEndpoints,
    ).toBe(true);
    expect(
      cursorEvidence.latestCompleteSnapshot?.staleEndpoints,
    ).not.toContainEqual(expect.objectContaining({ endpointId: IDS.endpoint }));

    const activeInput = {
      rosterSnapshotId: SEEDED_ROSTER,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      status: 'active',
      reasonCode: SMS_OPT_IN_REASON_CODE,
      provider: 'aws-eum-sms',
      providerReference: 'synthetic-start-provider-verified-1',
      providerOccurredAt: '2026-08-10T18:02:00.000Z',
    } as const;
    await expect(
      executeRecordEndpointStatusCapability(activeInput, workerContext, store),
    ).rejects.toMatchObject({ code: 'SMS_LIFECYCLE_INVOCATION_DENIED' });
    const active = await executeRecordEndpointStatusCapability(
      activeInput,
      webhookContext,
      store,
    );
    expect(active.id).toBe(IDS.activeEndpointStatus);

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
        status: 'active',
        optedOut: false,
      },
    ]);

    const activeEvidence = await createDrizzleStaleRosterReportStore(
      database,
    ).loadScopedEvidence(query, { facilityScope: { kind: 'district' } });
    const activeReport = buildStaleRosterReport(activeEvidence, {
      generatedAt: new Date('2026-08-11T18:00:00.000Z'),
      staleThresholdSeconds: 1_000_000,
    });
    expect(activeReport.staleEndpoints).not.toContainEqual(
      expect.objectContaining({ endpointId: IDS.endpoint }),
    );

    expect(
      await executeRecordSmsOptOutCapability(firstOptOut, workerContext, store),
    ).toEqual(first);
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
        status: 'active',
        optedOut: false,
      },
    ]);

    const delayedOptOut = await executeRecordSmsOptOutCapability(
      {
        ...firstOptOut,
        providerReference: 'synthetic-stop-conflict-delayed',
        providerOccurredAt: '2026-08-10T17:59:00.000Z',
      },
      workerContext,
      store,
    );
    expect(delayedOptOut.id).toBe(IDS.delayedOptOutRecord);
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
        status: 'active',
        optedOut: false,
      },
    ]);

    const newestOptOut = await executeRecordSmsOptOutCapability(
      {
        ...firstOptOut,
        providerReference: 'synthetic-stop-conflict-2',
        providerOccurredAt: '2026-08-10T18:03:00.000Z',
      },
      workerContext,
      store,
    );
    expect(newestOptOut.id).toBe(IDS.newOptOutRecord);
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
        status: 'active',
        optedOut: true,
      },
    ]);

    const delayedActive = await executeRecordEndpointStatusCapability(
      {
        ...activeInput,
        providerReference: 'synthetic-start-provider-verified-delayed',
        providerOccurredAt: '2026-08-10T18:01:00.000Z',
      },
      webhookContext,
      store,
    );
    expect(delayedActive.id).toBe(IDS.delayedActiveStatus);
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
        status: 'active',
        optedOut: true,
      },
    ]);

    const invalid = await store.recordEndpointStatus({
      rosterSnapshotId: SEEDED_ROSTER,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      status: 'invalid',
      reasonCode: 'SYNTHETIC_INVALID',
      provider: null,
      providerReference: null,
      providerOccurredAt: null,
    });
    expect(invalid.id).toBe(IDS.baseInvalidStatus);

    const newestActive = await executeRecordEndpointStatusCapability(
      {
        ...activeInput,
        providerReference: 'synthetic-start-provider-verified-2',
        providerOccurredAt: '2026-08-10T18:04:00.000Z',
      },
      webhookContext,
      store,
    );
    expect(newestActive.id).toBe(IDS.newestActiveStatus);
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
        status: 'invalid',
        optedOut: false,
      },
    ]);

    const finalEvidence = await createDrizzleStaleRosterReportStore(
      database,
    ).loadScopedEvidence(query, { facilityScope: { kind: 'district' } });
    const finalReport = buildStaleRosterReport(finalEvidence, {
      generatedAt: new Date('2026-08-11T18:00:00.000Z'),
      staleThresholdSeconds: 1_000_000,
    });
    expect(finalReport.staleEndpoints).toContainEqual({
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      channel: 'sms',
      reason: 'invalid',
    });

    const finalStatuses = await database
      .select()
      .from(endpointStatusRecords)
      .where(eq(endpointStatusRecords.endpointId, IDS.endpoint))
      .orderBy(asc(endpointStatusRecords.sequence));
    expect(finalStatuses).toHaveLength(7);
    expect(finalStatuses.map(({ id }) => id)).toEqual([
      IDS.endpointStatus,
      IDS.activeEndpointStatus,
      IDS.delayedOptOutStatus,
      IDS.newOptOutStatus,
      IDS.delayedActiveStatus,
      IDS.baseInvalidStatus,
      IDS.newestActiveStatus,
    ]);
    expect(
      finalStatuses.map(({ providerOccurredAt }) =>
        providerOccurredAt?.toISOString(),
      ),
    ).toEqual([
      firstOptOut.providerOccurredAt,
      activeInput.providerOccurredAt,
      '2026-08-10T17:59:00.000Z',
      '2026-08-10T18:03:00.000Z',
      '2026-08-10T18:01:00.000Z',
      undefined,
      '2026-08-10T18:04:00.000Z',
    ]);
    expect(finalStatuses.map(({ sequence }) => sequence)).toEqual(
      [...finalStatuses]
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ sequence }) => sequence),
    );
    expect(generatedIds).toHaveLength(0);
  });
});
