import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedDatabase } from '../../db/seed';
import { events, journalEntries, securityAuditEntries } from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import type { TrustedCapabilityInvocation } from './engine';
import {
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
  type JournalCapabilityStore,
} from './journal';
import { executeRecordsCapability } from './records';

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
  southDrillAt: runTimestamp(90),
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
  rosterSnapshot: '00000000-0000-4000-8000-000000000041',
  drillEventTypeVersion: '00000000-0000-4000-8000-000000000201',
});

const ACTOR = Object.freeze({
  kind: 'agent' as const,
  agentId: randomUUID(),
  apiKeyId: randomUUID(),
});

const FIXTURE = Object.freeze({
  northDrill: randomUUID(),
  northTest: randomUUID(),
  northDraft: randomUUID(),
  southDrill: randomUUID(),
  northNewerDrill: randomUUID(),
  northVisibleEntry: randomUUID(),
  northRedactedEntry: randomUUID(),
  northRedaction: randomUUID(),
  southEntry: randomUUID(),
});

let connection: PostgresDatabaseConnection | undefined;
let store: JournalCapabilityStore | undefined;

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
    kind: 'drill' | 'test';
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
    templateMode: 'drill' as const,
    eventTypeVersionId: SEEDED.drillEventTypeVersion,
    status,
    rosterSnapshotId: SEEDED.rosterSnapshot,
    rosterPopulation: 'synthetic' as const,
    createdBy: ACTOR,
    createdAt: new Date(activatedAt.getTime() - 60_000),
    activatedAt,
    allClearAt,
    reactivatedAt: null,
    closedAt:
      allClearAt === null ? null : new Date(allClearAt.getTime() + 60_000),
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: activationAuthorization(),
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
        id: FIXTURE.southDrill,
        facilityId: SEEDED.facilitySouth,
        kind: 'drill',
        activatedAt: RUN.southDrillAt,
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
  });

  afterAll(async () => {
    store = undefined;
    await connection?.close();
    connection = undefined;
  });

  test('lists only activated drill/test records in scope with stable RCW fields and a keyset cursor', async () => {
    const allRequestId = randomUUID();
    const all = await executeRecordsCapability(
      {
        facilityId: null,
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

    const first = await executeRecordsCapability(
      {
        facilityId: null,
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
