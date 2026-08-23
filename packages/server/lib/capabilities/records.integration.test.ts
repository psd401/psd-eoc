import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { desc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type DatabaseQuery,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedDatabase } from '../../db/seed';
import {
  events,
  journalEntries,
  notificationIntentChannels,
  notificationIntents,
  rosterSnapshots,
  rosterSourceConfigurations,
  securityAuditEntries,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import type { TrustedCapabilityInvocation } from './engine';
import {
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
  type JournalCapabilityStore,
} from './journal';
import {
  createRecordsCapabilityRuntime,
  executeEventRecordsCapability,
  executeRecordsCapability,
  type RecordsCapabilityRuntime,
} from './records';
import type {
  RecordsArtifactStore,
  StoreRecordsArtifactInput,
} from './records/artifact-store';
import { loadEventSummarySnapshot } from './records/snapshot';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const MILLISECONDS_PER_MINUTE = 60_000;
const RANDOM_WINDOW_SPAN_MS = 50 * 366 * 24 * 60 * 60 * 1_000;
const runEntropy = Number.parseInt(
  randomUUID().replaceAll('-', '').slice(0, 12),
  16,
);
const runWindowStartMs =
  Date.UTC(2100, 0, 1) + (runEntropy % RANDOM_WINDOW_SPAN_MS);

function runTime(minutesAfterStart: number): Date {
  return new Date(
    runWindowStartMs + minutesAfterStart * MILLISECONDS_PER_MINUTE,
  );
}

function runTimestamp(minutesAfterStart: number): string {
  return runTime(minutesAfterStart).toISOString();
}

const RUN = Object.freeze({
  token: `issue-25-${randomUUID()}`,
  windowFrom: runTimestamp(5),
  northDrillAt: runTimestamp(10),
  northVisibleEntryAt: runTime(11),
  northRedactedEntryAt: runTime(12),
  northRedactionAt: runTime(13),
  northTestAt: runTimestamp(60),
  northIncidentAt: runTimestamp(75),
  southDrillAt: runTimestamp(90),
  southIncidentAt: runTimestamp(105),
  southEntryAt: runTime(91),
  northDraftAt: runTime(120),
  northNewerDrillAt: runTimestamp(150),
  windowThrough: runTimestamp(180),
  invocationAt: runTime(240),
});

const JOURNAL_TEXT = Object.freeze({
  visibleNorth: `Visible synthetic ${RUN.token} for North.`,
  redactedNorth: `Redacted synthetic ${RUN.token} for North.`,
  visibleSouth: `Visible synthetic ${RUN.token} for South.`,
});

const SEEDED = Object.freeze({
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  facilitySouth: '00000000-0000-4000-8000-000000000002',
  audienceNorth: '00000000-0000-4000-8000-000000000020',
  rosterSnapshot: '00000000-0000-4000-8000-000000000041',
  staffRosterConfiguration: randomUUID(),
  staffRosterSnapshot: randomUUID(),
  drillEventType: '00000000-0000-4000-8000-000000000101',
  otherDrillEventType: '00000000-0000-4000-8000-000000000103',
  drillEventTypeVersion: '00000000-0000-4000-8000-000000000201',
  realEventTypeVersion: '00000000-0000-4000-8000-000000000200',
  integrationExpoPush: '00000000-0000-4000-8000-000000000301',
  integrationSesEmail: '00000000-0000-4000-8000-000000000302',
});

const ACTOR = Object.freeze({
  kind: 'agent' as const,
  agentId: randomUUID(),
  apiKeyId: randomUUID(),
});

const HUMAN_ACTOR = Object.freeze({
  kind: 'human' as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
});

const FIXTURE = Object.freeze({
  northDrill: randomUUID(),
  northTest: randomUUID(),
  northIncident: randomUUID(),
  northDraft: randomUUID(),
  southDrill: randomUUID(),
  southIncident: randomUUID(),
  northNewerDrill: randomUUID(),
  northVisibleEntry: randomUUID(),
  northRedactedEntry: randomUUID(),
  northRedaction: randomUUID(),
  southEntry: randomUUID(),
  northNotificationIntent: randomUUID(),
});

let connection: PostgresDatabaseConnection | undefined;
let store: JournalCapabilityStore | undefined;
let recordsRuntime: RecordsCapabilityRuntime | undefined;
const storedArtifacts: StoreRecordsArtifactInput[] = [];

function database(): PostgresDatabase {
  if (connection === undefined) {
    throw new Error('The records integration database is not open.');
  }
  return connection.db;
}

function capabilityStore(): JournalCapabilityStore {
  if (store === undefined) {
    throw new Error('The records integration store is not available.');
  }
  return store;
}

function exportRuntime(): RecordsCapabilityRuntime {
  if (recordsRuntime === undefined) {
    throw new Error('The records export runtime is not available.');
  }
  return recordsRuntime;
}

function invocation(
  requestId = randomUUID(),
  facilityIds: readonly string[] = [SEEDED.facilityNorth],
): TrustedCapabilityInvocation {
  return Object.freeze({
    actor: ACTOR,
    source: 'agent-rest' as const,
    scope: {
      facilityScope: {
        kind: 'facilities' as const,
        facilityIds: [...facilityIds],
      },
    },
    requestId,
    serverTime: RUN.invocationAt,
    connectivityEpochId: null,
    mutation: null,
  });
}

function humanInvocation(
  requestId = randomUUID(),
  facilityIds: readonly string[] = [SEEDED.facilityNorth],
): TrustedCapabilityInvocation {
  return Object.freeze({
    actor: HUMAN_ACTOR,
    source: 'web' as const,
    scope: {
      facilityScope: {
        kind: 'facilities' as const,
        facilityIds: [...facilityIds],
      },
    },
    requestId,
    serverTime: RUN.invocationAt,
    connectivityEpochId: null,
    mutation: null,
  });
}

function activationAuthorization() {
  return {
    kind: 'synthetic-training' as const,
    activationPreviewId: randomUUID(),
    consequenceDigest: 'a'.repeat(64),
    requestId: randomUUID(),
  };
}

function activatedEvent(
  input: Readonly<{
    id: string;
    facilityId: string;
    kind: 'incident' | 'drill' | 'test';
    activatedAt: string;
    status?: 'active' | 'closed';
  }>,
) {
  const status = input.status ?? 'active';
  const activatedAt = new Date(input.activatedAt);
  const allClearAt =
    status === 'closed'
      ? new Date(activatedAt.getTime() + 10 * 60 * 1_000)
      : null;
  return {
    id: input.id,
    facilityId: input.facilityId,
    kind: input.kind,
    templateMode:
      input.kind === 'incident' ? ('real' as const) : ('drill' as const),
    eventTypeVersionId:
      input.kind === 'incident'
        ? SEEDED.realEventTypeVersion
        : SEEDED.drillEventTypeVersion,
    status,
    rosterSnapshotId:
      input.kind === 'incident'
        ? SEEDED.staffRosterSnapshot
        : SEEDED.rosterSnapshot,
    rosterPopulation:
      input.kind === 'incident' ? ('staff' as const) : ('synthetic' as const),
    createdBy: input.kind === 'incident' ? HUMAN_ACTOR : ACTOR,
    createdAt: new Date(activatedAt.getTime() - 60_000),
    activatedAt,
    allClearAt,
    reactivatedAt: null,
    closedAt:
      allClearAt === null ? null : new Date(allClearAt.getTime() + 60_000),
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization:
      input.kind === 'incident'
        ? {
            kind: 'human-confirmed' as const,
            activationPreviewId: randomUUID(),
            preparedActivationId: null,
            confirmationId: randomUUID(),
            consequenceDigest: 'd'.repeat(64),
            requestId: randomUUID(),
          }
        : activationAuthorization(),
  };
}

describeWithDatabase('canonical records and journal-search persistence', () => {
  beforeAll(async () => {
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl ?? '',
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('The records integration test requires PostgreSQL.');
    }
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);
    store = createDrizzleJournalCapabilityStore(opened.db);
    const artifactStore: RecordsArtifactStore = {
      async store(input) {
        storedArtifacts.push(input);
        return {
          id: randomUUID(),
          format: input.format,
          contentType:
            input.format === 'csv'
              ? 'text/csv; charset=utf-8'
              : 'application/pdf',
          fileName: input.fileName,
          byteLength: input.bytes.byteLength,
          contentSha256: 'c'.repeat(64),
          rowCount: input.rowCount,
          downloadUrl: 'https://private.example.test/synthetic-records-export',
          generatedAt: input.generatedAt.toISOString(),
          expiresAt: new Date(
            input.generatedAt.getTime() + 5 * 60 * 1_000,
          ).toISOString(),
        };
      },
    };
    recordsRuntime = createRecordsCapabilityRuntime(opened, artifactStore);

    const [existingStaffRosterConfiguration] = await opened.db
      .select({
        id: rosterSourceConfigurations.id,
        version: rosterSourceConfigurations.version,
      })
      .from(rosterSourceConfigurations)
      .where(eq(rosterSourceConfigurations.population, 'staff'))
      .orderBy(desc(rosterSourceConfigurations.version))
      .limit(1);
    const staffRosterConfiguration = existingStaffRosterConfiguration ?? {
      id: SEEDED.staffRosterConfiguration,
      version: 1,
    };
    if (existingStaffRosterConfiguration === undefined) {
      await opened.db.insert(rosterSourceConfigurations).values({
        ...staffRosterConfiguration,
        population: 'staff',
        createdAt: runTime(1),
      });
    }
    const [latestStaffRosterSnapshot] = await opened.db
      .select({ version: rosterSnapshots.version })
      .from(rosterSnapshots)
      .where(eq(rosterSnapshots.population, 'staff'))
      .orderBy(desc(rosterSnapshots.version))
      .limit(1);
    await opened.db.insert(rosterSnapshots).values({
      id: SEEDED.staffRosterSnapshot,
      version: (latestStaffRosterSnapshot?.version ?? 0) + 1,
      population: 'staff',
      complete: true,
      sourceConfigurationId: staffRosterConfiguration.id,
      sourceConfigurationVersion: staffRosterConfiguration.version,
      syncStartedAt: runTime(2),
      capturedAt: runTime(3),
    });

    await opened.db.insert(events).values([
      activatedEvent({
        id: FIXTURE.northDrill,
        facilityId: SEEDED.facilityNorth,
        kind: 'drill',
        activatedAt: RUN.northDrillAt,
        status: 'closed',
      }),
      activatedEvent({
        id: FIXTURE.northTest,
        facilityId: SEEDED.facilityNorth,
        kind: 'test',
        activatedAt: RUN.northTestAt,
      }),
      activatedEvent({
        id: FIXTURE.northIncident,
        facilityId: SEEDED.facilityNorth,
        kind: 'incident',
        activatedAt: RUN.northIncidentAt,
      }),
      activatedEvent({
        id: FIXTURE.southDrill,
        facilityId: SEEDED.facilitySouth,
        kind: 'drill',
        activatedAt: RUN.southDrillAt,
      }),
      activatedEvent({
        id: FIXTURE.southIncident,
        facilityId: SEEDED.facilitySouth,
        kind: 'incident',
        activatedAt: RUN.southIncidentAt,
      }),
      {
        id: FIXTURE.northDraft,
        facilityId: SEEDED.facilityNorth,
        kind: 'drill',
        templateMode: 'drill',
        eventTypeVersionId: SEEDED.drillEventTypeVersion,
        status: 'draft',
        rosterSnapshotId: null,
        rosterPopulation: null,
        createdBy: ACTOR,
        createdAt: RUN.northDraftAt,
        activatedAt: null,
        allClearAt: null,
        reactivatedAt: null,
        closedAt: null,
        correctionOfEventId: null,
        correctionReason: null,
        activationAuthorization: null,
      },
    ]);

    await opened.db.insert(journalEntries).values([
      {
        id: FIXTURE.northVisibleEntry,
        eventId: FIXTURE.northDrill,
        sequence: 1,
        kind: 'text',
        author: ACTOR,
        source: 'agent-rest',
        serverTime: RUN.northVisibleEntryAt,
        clientTime: null,
        payload: { text: JOURNAL_TEXT.visibleNorth },
        mediaId: null,
        transitionId: null,
        supersedesEntryId: null,
        supersedesEntrySequence: null,
        supersessionKind: null,
        supersessionReason: null,
      },
      {
        id: FIXTURE.northRedactedEntry,
        eventId: FIXTURE.northDrill,
        sequence: 2,
        kind: 'text',
        author: ACTOR,
        source: 'agent-rest',
        serverTime: RUN.northRedactedEntryAt,
        clientTime: null,
        payload: { text: JOURNAL_TEXT.redactedNorth },
        mediaId: null,
        transitionId: null,
        supersedesEntryId: null,
        supersedesEntrySequence: null,
        supersessionKind: null,
        supersessionReason: null,
      },
      {
        id: FIXTURE.northRedaction,
        eventId: FIXTURE.northDrill,
        sequence: 3,
        kind: 'text',
        author: ACTOR,
        source: 'agent-rest',
        serverTime: RUN.northRedactionAt,
        clientTime: null,
        payload: { text: 'Content removed from outward reads.' },
        mediaId: null,
        transitionId: null,
        supersedesEntryId: FIXTURE.northRedactedEntry,
        supersedesEntrySequence: 2,
        supersessionKind: 'redaction',
        supersessionReason: 'Synthetic redaction integration proof.',
      },
      {
        id: FIXTURE.southEntry,
        eventId: FIXTURE.southDrill,
        sequence: 1,
        kind: 'text',
        author: ACTOR,
        source: 'agent-rest',
        serverTime: RUN.southEntryAt,
        clientTime: null,
        payload: { text: JOURNAL_TEXT.visibleSouth },
        mediaId: null,
        transitionId: null,
        supersedesEntryId: null,
        supersedesEntrySequence: null,
        supersessionKind: null,
        supersessionReason: null,
      },
    ]);

    const notificationRequestId = randomUUID();
    const notificationAuthorization = {
      kind: 'synthetic-training' as const,
      activationPreviewId: randomUUID(),
      consequenceDigest: 'b'.repeat(64),
      requestId: notificationRequestId,
    };
    await opened.db.insert(notificationIntents).values({
      id: FIXTURE.northNotificationIntent,
      eventId: FIXTURE.northDrill,
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.drillEventTypeVersion,
      rosterSnapshotId: SEEDED.rosterSnapshot,
      rosterPopulation: 'synthetic',
      createdBy: ACTOR,
      source: 'agent-rest',
      requestId: notificationRequestId,
      authorization: notificationAuthorization,
      createdAt: RUN.northVisibleEntryAt,
    });
    await opened.db.insert(notificationIntentChannels).values([
      {
        intentId: FIXTURE.northNotificationIntent,
        sequence: 1,
        channel: 'push',
        eventKind: 'drill',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'synthetic',
        classificationMarker: 'DRILL',
        endpointCount: 2,
        renderedMessage: {
          channel: 'push',
          eventKind: 'drill',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          title: '[DRILL] Synthetic lockdown drill',
          body: '[DRILL] Synthetic records integration notification.',
        },
        integrationStatusId: SEEDED.integrationExpoPush,
        integrationId: 'expo-push',
        integrationLabel: 'mocked',
      },
      {
        intentId: FIXTURE.northNotificationIntent,
        sequence: 2,
        channel: 'email',
        eventKind: 'drill',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'synthetic',
        classificationMarker: 'DRILL',
        endpointCount: 2,
        renderedMessage: {
          channel: 'email',
          eventKind: 'drill',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          subject: '[DRILL] Synthetic lockdown drill',
          textBody: '[DRILL] Synthetic records integration notification.',
        },
        integrationStatusId: SEEDED.integrationSesEmail,
        integrationId: 'ses-email',
        integrationLabel: 'mocked',
      },
    ]);
  });

  afterAll(async () => {
    store = undefined;
    recordsRuntime = undefined;
    storedArtifacts.length = 0;
    await connection?.close();
    connection = undefined;
  });

  test('lists only activated drill/test records in scope with stable RCW fields and a keyset cursor', async () => {
    const allRequestId = randomUUID();
    const all = await executeRecordsCapability(
      {
        facilityId: null,
        eventTypeId: null,
        startedFrom: RUN.windowFrom,
        startedThrough: RUN.windowThrough,
        cursor: null,
        limit: 25,
      },
      invocation(allRequestId),
      capabilityStore(),
    );

    expect(all.items.map((record) => record.eventId)).toEqual([
      FIXTURE.northTest,
      FIXTURE.northDrill,
    ]);
    expect(all.items.map((record) => record.eventId)).not.toContain(
      FIXTURE.northDraft,
    );
    expect(all.items.map((record) => record.eventId)).not.toContain(
      FIXTURE.southDrill,
    );
    expect(all.items.map((record) => record.eventId)).not.toContain(
      FIXTURE.northIncident,
    );
    expect(all.items).toEqual([
      expect.objectContaining({
        facilityId: SEEDED.facilityNorth,
        kind: 'test',
        eventTypeName: 'Lockdown Drill',
        startedAt: RUN.northTestAt,
      }),
      expect.objectContaining({
        facilityId: SEEDED.facilityNorth,
        kind: 'drill',
        eventTypeName: 'Lockdown Drill',
        startedAt: RUN.northDrillAt,
        status: 'closed',
      }),
    ]);

    const filtered = await executeRecordsCapability(
      {
        facilityId: SEEDED.facilityNorth,
        eventTypeId: SEEDED.drillEventType,
        startedFrom: RUN.windowFrom,
        startedThrough: RUN.windowThrough,
        cursor: null,
        limit: 25,
      },
      invocation(),
      capabilityStore(),
    );
    expect(filtered.items.map((record) => record.eventId)).toEqual([
      FIXTURE.northTest,
      FIXTURE.northDrill,
    ]);
    const wrongType = await executeRecordsCapability(
      {
        facilityId: SEEDED.facilityNorth,
        eventTypeId: SEEDED.otherDrillEventType,
        startedFrom: RUN.windowFrom,
        startedThrough: RUN.windowThrough,
        cursor: null,
        limit: 25,
      },
      invocation(),
      capabilityStore(),
    );
    expect(wrongType.items).toEqual([]);

    const first = await executeRecordsCapability(
      {
        facilityId: null,
        eventTypeId: null,
        startedFrom: RUN.windowFrom,
        startedThrough: RUN.windowThrough,
        cursor: null,
        limit: 1,
      },
      invocation(),
      capabilityStore(),
    );
    expect(first.items.map((record) => record.eventId)).toEqual([
      FIXTURE.northTest,
    ]);
    expect(first.pageInfo).toMatchObject({ hasMore: true });

    await database()
      .insert(events)
      .values(
        activatedEvent({
          id: FIXTURE.northNewerDrill,
          facilityId: SEEDED.facilityNorth,
          kind: 'drill',
          activatedAt: RUN.northNewerDrillAt,
        }),
      );
    const second = await executeRecordsCapability(
      {
        facilityId: null,
        eventTypeId: null,
        startedFrom: RUN.windowFrom,
        startedThrough: RUN.windowThrough,
        cursor: first.pageInfo.nextCursor,
        limit: 1,
      },
      invocation(),
      capabilityStore(),
    );
    expect(second.items.map((record) => record.eventId)).toEqual([
      FIXTURE.northDrill,
    ]);

    const auditRows = await database()
      .select()
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, allRequestId));
    expect(auditRows).toEqual([
      expect.objectContaining({
        action: 'list-drill-records',
        outcome: 'success',
        principal: ACTOR,
        requestId: allRequestId,
      }),
    ]);
  });

  test('lists incident, drill, and test records for an authorized human without leaking another facility', async () => {
    const requestId = randomUUID();
    const result = await executeEventRecordsCapability(
      {
        facilityId: null,
        eventTypeId: null,
        startedFrom: RUN.windowFrom,
        startedThrough: RUN.windowThrough,
        cursor: null,
        limit: 25,
      },
      humanInvocation(requestId),
      capabilityStore(),
    );

    expect(result.items.map((record) => record.eventId)).toEqual([
      FIXTURE.northNewerDrill,
      FIXTURE.northIncident,
      FIXTURE.northTest,
      FIXTURE.northDrill,
    ]);
    expect(result.items).toEqual([
      expect.objectContaining({
        eventId: FIXTURE.northNewerDrill,
        facilityId: SEEDED.facilityNorth,
        kind: 'drill',
        eventTypeVersion: expect.objectContaining({ templateMode: 'drill' }),
      }),
      expect.objectContaining({
        eventId: FIXTURE.northIncident,
        facilityId: SEEDED.facilityNorth,
        kind: 'incident',
        eventTypeVersion: expect.objectContaining({ templateMode: 'real' }),
        eventTypeName: 'Lockdown',
        startedAt: RUN.northIncidentAt,
      }),
      expect.objectContaining({
        eventId: FIXTURE.northTest,
        kind: 'test',
        eventTypeVersion: expect.objectContaining({ templateMode: 'drill' }),
      }),
      expect.objectContaining({
        eventId: FIXTURE.northDrill,
        kind: 'drill',
        eventTypeVersion: expect.objectContaining({ templateMode: 'drill' }),
      }),
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FIXTURE.southIncident);
    expect(serialized).not.toContain(FIXTURE.southDrill);
    expect(serialized).not.toContain(SEEDED.facilitySouth);

    const auditRows = await database()
      .select()
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, requestId));
    expect(auditRows).toEqual([
      expect.objectContaining({
        action: 'list-event-records',
        outcome: 'success',
        principal: HUMAN_ACTOR,
        requestId,
      }),
    ]);
  });

  test('exports authorized CSV/PDF artifacts from complete redaction-safe snapshots and audits both', async () => {
    storedArtifacts.length = 0;
    const csvRequestId = randomUUID();
    const csv = await exportRuntime().execute(
      'export-drill-records',
      {
        facilityId: SEEDED.facilityNorth,
        eventTypeId: SEEDED.drillEventType,
        startedFrom: RUN.windowFrom,
        startedThrough: RUN.windowThrough,
        format: 'csv',
      },
      invocation(csvRequestId),
    );
    expect(csv).toMatchObject({
      format: 'csv',
      contentType: 'text/csv; charset=utf-8',
    });
    const csvArtifact = storedArtifacts.find(
      (artifact) => artifact.format === 'csv',
    );
    expect(csvArtifact).toBeDefined();
    if (csvArtifact === undefined) {
      throw new Error('Expected the CSV artifact to be stored.');
    }
    const csvText = new TextDecoder().decode(csvArtifact.bytes);
    expect(csvText).toStartWith(
      'site,date,time,type,duration,participants_count\r\n',
    );
    expect(csvText).toContain('[DRILL] Lockdown Drill');
    expect(csvText).toContain('[TEST] Lockdown Drill');

    const snapshot = await loadEventSummarySnapshot(
      database() as DatabaseQuery,
      FIXTURE.northDrill,
      RUN.invocationAt.toISOString(),
    );
    expect(snapshot.journal).toHaveLength(3);
    expect(snapshot.journal[1]).toMatchObject({
      visibility: 'redacted',
      entry: {
        id: FIXTURE.northRedactedEntry,
        sequence: 2,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(JOURNAL_TEXT.redactedNorth);
    expect(snapshot.recordedParticipantCount).toBe(0);
    expect(snapshot.delivery).toEqual([
      {
        purpose: 'activation',
        createdAt: RUN.northVisibleEntryAt.toISOString(),
        explicitIntentState: null,
        channels: [
          {
            channel: 'push',
            plannedEndpointCount: 2,
            noAttemptRecordCount: 2,
            noEvidenceCount: 0,
            stateCounts: [
              { state: 'attempted', count: 0 },
              { state: 'provider-accepted', count: 0 },
              { state: 'delivered', count: 0 },
              { state: 'failed', count: 0 },
              { state: 'expired', count: 0 },
              { state: 'unknown', count: 0 },
            ],
          },
          {
            channel: 'email',
            plannedEndpointCount: 2,
            noAttemptRecordCount: 2,
            noEvidenceCount: 0,
            stateCounts: [
              { state: 'attempted', count: 0 },
              { state: 'provider-accepted', count: 0 },
              { state: 'delivered', count: 0 },
              { state: 'failed', count: 0 },
              { state: 'expired', count: 0 },
              { state: 'unknown', count: 0 },
            ],
          },
        ],
      },
    ]);

    const pdfRequestId = randomUUID();
    const pdf = await exportRuntime().execute(
      'export-event-summary',
      { eventId: FIXTURE.northDrill, format: 'pdf' },
      invocation(pdfRequestId),
    );
    expect(pdf).toMatchObject({
      eventId: FIXTURE.northDrill,
      artifact: {
        format: 'pdf',
        contentType: 'application/pdf',
        rowCount: 3,
      },
    });
    const pdfArtifact = storedArtifacts.find(
      (artifact) => artifact.format === 'pdf',
    );
    expect(pdfArtifact).toBeDefined();
    if (pdfArtifact === undefined) {
      throw new Error('Expected the PDF artifact to be stored.');
    }
    expect(new TextDecoder().decode(pdfArtifact.bytes.slice(0, 8))).toBe(
      '%PDF-1.7',
    );

    const auditRows = await database()
      .select()
      .from(securityAuditEntries)
      .where(
        sql`${securityAuditEntries.requestId} in (${csvRequestId}::uuid, ${pdfRequestId}::uuid)`,
      );
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.action).sort()).toEqual([
      'export-drill-records',
      'export-event-summary',
    ]);
    expect(auditRows.every((row) => row.outcome === 'success')).toBe(true);
  });

  test('searches only scoped visible content and never uses a redacted original as an oracle', async () => {
    const requestId = randomUUID();
    const result = await executeJournalCapability(
      'search-journal-entries',
      {
        eventId: null,
        kind: 'text',
        query: RUN.token,
        occurredFrom: RUN.windowFrom,
        occurredThrough: RUN.windowThrough,
        cursor: null,
        limit: 25,
      },
      invocation(requestId),
      capabilityStore(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      visibility: 'visible',
      entry: {
        id: FIXTURE.northVisibleEntry,
        eventId: FIXTURE.northDrill,
        payload: { text: JOURNAL_TEXT.visibleNorth },
      },
    });
    expect(JSON.stringify(result)).not.toContain(JOURNAL_TEXT.redactedNorth);
    expect(JSON.stringify(result)).not.toContain(JOURNAL_TEXT.visibleSouth);

    const unfiltered = await executeJournalCapability(
      'search-journal-entries',
      {
        eventId: FIXTURE.northDrill,
        kind: 'text',
        query: null,
        occurredFrom: null,
        occurredThrough: null,
        cursor: null,
        limit: 25,
      },
      invocation(),
      capabilityStore(),
    );
    expect(
      unfiltered.items.find(
        ({ entry }) => entry.id === FIXTURE.northRedactedEntry,
      ),
    ).toMatchObject({
      visibility: 'redacted',
      entry: { id: FIXTURE.northRedactedEntry },
    });
    expect(JSON.stringify(unfiltered)).not.toContain(
      JOURNAL_TEXT.redactedNorth,
    );

    const auditRows = await database()
      .select()
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, requestId));
    expect(auditRows).toEqual([
      expect.objectContaining({
        action: 'search-journal-entries',
        outcome: 'success',
        principal: ACTOR,
        requestId,
      }),
    ]);
  });
});
