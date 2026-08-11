import { randomUUID } from 'node:crypto';

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
  type ExecuteStatementCommandOutput,
  type Field,
  type RDSDataClient,
} from '@aws-sdk/client-rds-data';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { drizzle as drizzleAwsDataApi } from 'drizzle-orm/aws-data-api/pg';
import { asc, eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type AwsDataApiDatabase,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  eventTypeVersions,
  events,
  facilities,
  journalEntries,
  rosterSnapshots,
  securityAuditEntries,
} from '../../db/schema';
import { seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticEventRoomTestDatabaseUrl } from '../../app/(app)/events/[id]/test-database';
import {
  CapabilityEngineError,
  type TrustedCapabilityInvocation,
} from './engine';
import {
  EVENT_ROOM_TRANSACTION_CONFIG,
  createEventRoomCapabilityRuntime,
  createEventRoomCursor,
  readEventRoomCursorSequence,
  type EventRoomCapabilityRuntime,
} from './event-room';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticEventRoomTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const HUMAN_ACTOR = Object.freeze({
  kind: 'human' as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
});
const CONNECTIVITY_EPOCH_ID = randomUUID();
const DISTRICT_SCOPE = Object.freeze({
  facilityScope: { kind: 'district' as const },
});

interface FixtureIds {
  readonly facilityId: string;
  readonly eventTypeVersionId: string;
  readonly rosterSnapshotId: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('Missing resolver.');
      resolvePromise(value);
    },
    reject(reason) {
      if (rejectPromise === undefined) throw new Error('Missing rejecter.');
      rejectPromise(reason);
    },
  };
}

let setupConnection: PostgresDatabaseConnection | undefined;
let writerConnection: PostgresDatabaseConnection | undefined;
let readConnection: PostgresDatabaseConnection | undefined;
let runtime: EventRoomCapabilityRuntime | undefined;
let fixtureIds: FixtureIds | undefined;

function setupDatabase(): PostgresDatabase {
  if (setupConnection === undefined) {
    throw new Error('The event-room test database is unavailable.');
  }
  return setupConnection.db;
}

function writerDatabase(): PostgresDatabase {
  if (writerConnection === undefined) {
    throw new Error('The event-room writer database is unavailable.');
  }
  return writerConnection.db;
}

function eventRoomRuntime(): EventRoomCapabilityRuntime {
  if (runtime === undefined) {
    throw new Error('The event-room runtime is unavailable.');
  }
  return runtime;
}

function fixtures(): FixtureIds {
  if (fixtureIds === undefined) {
    throw new Error('The event-room fixtures are unavailable.');
  }
  return fixtureIds;
}

function invocation(requestId = randomUUID()): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope: DISTRICT_SCOPE,
    requestId,
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: null,
  };
}

async function createActiveEvent(): Promise<string> {
  const ids = fixtures();
  const eventId = randomUUID();
  const activatedAt = new Date();
  await setupDatabase()
    .insert(events)
    .values({
      id: eventId,
      facilityId: ids.facilityId,
      kind: 'test',
      templateMode: 'drill',
      eventTypeVersionId: ids.eventTypeVersionId,
      status: 'active',
      rosterSnapshotId: ids.rosterSnapshotId,
      rosterPopulation: 'synthetic',
      createdBy: HUMAN_ACTOR,
      createdAt: new Date(activatedAt.getTime() - 1_000),
      activatedAt,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: {
        kind: 'synthetic-training',
        activationPreviewId: randomUUID(),
        consequenceDigest: 'a'.repeat(64),
        requestId: randomUUID(),
      },
    });
  return eventId;
}

async function appendText(
  database: PostgresDatabase,
  eventId: string,
  sequence: number,
  text: string,
): Promise<void> {
  await database.insert(journalEntries).values({
    id: randomUUID(),
    eventId,
    sequence,
    kind: 'text',
    author: HUMAN_ACTOR,
    source: 'web',
    serverTime: new Date(),
    clientTime: null,
    payload: { text },
    mediaId: null,
    transitionId: null,
    supersedesEntryId: null,
    supersedesEntrySequence: null,
    supersessionKind: null,
    supersessionReason: null,
  });
}

async function captureEngineError(
  operation: () => Promise<unknown>,
): Promise<CapabilityEngineError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityEngineError);
    return error as CapabilityEngineError;
  }
  throw new Error('Expected an event-room capability error.');
}

type ObservedDataApiCommand =
  | BeginTransactionCommand
  | CommitTransactionCommand
  | ExecuteStatementCommand
  | RollbackTransactionCommand;

describe('event-room AWS Data API transaction transport', () => {
  test('uses one repeatable-read, read-only transaction for the event and journal snapshot', async () => {
    const eventId = randomUUID();
    const facilityId = randomUUID();
    const eventTypeVersionId = randomUUID();
    const rosterSnapshotId = randomUUID();
    const activationPreviewId = randomUUID();
    const activationRequestId = randomUUID();
    const transactionId = 'synthetic-event-room-transaction';
    const commands: ObservedDataApiCommand[] = [];
    const eventRecord = [
      { stringValue: eventId },
      { stringValue: facilityId },
      { stringValue: 'test' },
      { stringValue: 'drill' },
      { stringValue: eventTypeVersionId },
      { stringValue: 'active' },
      { stringValue: rosterSnapshotId },
      { stringValue: 'synthetic' },
      { stringValue: JSON.stringify(HUMAN_ACTOR) },
      { stringValue: '2026-08-10 12:00:00+00' },
      { stringValue: '2026-08-10 12:00:01+00' },
      { isNull: true },
      { isNull: true },
      { isNull: true },
      { isNull: true },
      { isNull: true },
      {
        stringValue: JSON.stringify({
          kind: 'synthetic-training',
          activationPreviewId,
          consequenceDigest: 'a'.repeat(64),
          requestId: activationRequestId,
        }),
      },
    ] satisfies Field[];
    const fakeClient = {
      async send(command: ObservedDataApiCommand): Promise<unknown> {
        commands.push(command);
        if (command instanceof BeginTransactionCommand) {
          return { $metadata: {}, transactionId };
        }
        if (command instanceof ExecuteStatementCommand) {
          const statement = command.input.sql ?? '';
          if (statement.includes('from "events"')) {
            return {
              $metadata: {},
              records: [eventRecord],
            } satisfies ExecuteStatementCommandOutput;
          }
          if (
            statement ===
              'set transaction isolation level repeatable read read only' ||
            statement.includes('from "journal_entries"')
          ) {
            return {
              $metadata: {},
              records: [],
            } satisfies ExecuteStatementCommandOutput;
          }
          throw new Error(`Unexpected synthetic Data API SQL: ${statement}`);
        }
        if (command instanceof CommitTransactionCommand) {
          return { $metadata: {}, transactionStatus: 'Transaction Committed' };
        }
        if (command instanceof RollbackTransactionCommand) {
          return {
            $metadata: {},
            transactionStatus: 'Transaction Rolled Back',
          };
        }
        throw new Error('Unexpected synthetic Data API command.');
      },
    } as unknown as RDSDataClient;
    const database = drizzleAwsDataApi({
      client: fakeClient,
      database: 'synthetic',
      resourceArn:
        'arn:aws:rds:us-west-2:000000000000:cluster:psd-eoc-synthetic',
      secretArn:
        'arn:aws:secretsmanager:us-west-2:000000000000:secret:psd-eoc-synthetic',
      schema: { events, journalEntries },
    });
    const dataApiRuntime = createEventRoomCapabilityRuntime({
      driver: 'aws-data-api',
      db: database as unknown as AwsDataApiDatabase,
      close: () => Promise.resolve(),
    });

    try {
      const result = await dataApiRuntime.execute(
        { eventId, cursor: null, limit: 100 },
        invocation(),
      );

      expect(result).toMatchObject({
        eventId,
        event: {
          id: eventId,
          facilityId,
          kind: 'test',
          templateMode: 'drill',
          status: 'active',
          rosterSnapshotId,
          rosterPopulation: 'synthetic',
        },
        entries: [],
        hasMore: false,
        snapshotSequence: 0,
      });
      expect(readEventRoomCursorSequence(result.cursor, eventId)).toBe(0);
      expect(commands.map((command) => command.constructor.name)).toEqual([
        'BeginTransactionCommand',
        'ExecuteStatementCommand',
        'ExecuteStatementCommand',
        'ExecuteStatementCommand',
        'ExecuteStatementCommand',
        'CommitTransactionCommand',
      ]);
      const executeCommands = commands.filter(
        (command): command is ExecuteStatementCommand =>
          command instanceof ExecuteStatementCommand,
      );
      expect(
        executeCommands.map((command) => command.input.transactionId),
      ).toEqual(Array.from({ length: 4 }, () => transactionId));
      expect(executeCommands[0]?.input.sql).toBe(
        'set transaction isolation level repeatable read read only',
      );
      expect(executeCommands[1]?.input.sql).toContain('from "events"');
      expect(executeCommands[2]?.input.sql).toContain(
        'order by "journal_entries"."sequence" desc',
      );
      expect(executeCommands[3]?.input.sql).toContain(
        'order by "journal_entries"."sequence" asc',
      );
      expect(commands.at(-1)).toBeInstanceOf(CommitTransactionCommand);
      expect(
        (commands.at(-1) as CommitTransactionCommand).input.transactionId,
      ).toBe(transactionId);
      expect(
        commands.some(
          (command) => command instanceof RollbackTransactionCommand,
        ),
      ).toBe(false);
    } finally {
      await dataApiRuntime.close();
    }
  });
});

describeWithDatabase('event-room atomic synchronization', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const connections = [8, 4, 4].map((maxConnections) =>
      createDatabaseClient({
        driver: 'postgres',
        url: testDatabaseUrl,
        maxConnections,
      }),
    );
    if (connections.some((connection) => connection.driver !== 'postgres')) {
      throw new Error('Event-room integration tests require PostgreSQL.');
    }
    [setupConnection, writerConnection, readConnection] = connections as [
      PostgresDatabaseConnection,
      PostgresDatabaseConnection,
      PostgresDatabaseConnection,
    ];
    await migrateDatabase(setupConnection);
    await seedDatabase(setupConnection.db);

    const [[facility], [version], [snapshot]] = await Promise.all([
      setupConnection.db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.code, 'SYN-NORTH'))
        .limit(1),
      setupConnection.db
        .select({ id: eventTypeVersions.id })
        .from(eventTypeVersions)
        .where(eq(eventTypeVersions.templateMode, 'drill'))
        .orderBy(asc(eventTypeVersions.id))
        .limit(1),
      setupConnection.db
        .select({ id: rosterSnapshots.id })
        .from(rosterSnapshots)
        .where(eq(rosterSnapshots.population, 'synthetic'))
        .limit(1),
    ]);
    if (
      facility === undefined ||
      version === undefined ||
      snapshot === undefined
    ) {
      throw new Error('Synthetic event-room seed fixtures are missing.');
    }
    fixtureIds = {
      facilityId: facility.id,
      eventTypeVersionId: version.id,
      rosterSnapshotId: snapshot.id,
    };
    runtime = createEventRoomCapabilityRuntime(readConnection);
  });

  afterAll(async () => {
    await Promise.all([
      runtime?.close(),
      setupConnection?.close(),
      writerConnection?.close(),
    ]);
    runtime = undefined;
    readConnection = undefined;
    setupConnection = undefined;
    writerConnection = undefined;
  });

  test('uses the same repeatable-read, read-only posture for every driver branch', () => {
    expect(EVENT_ROOM_TRANSACTION_CONFIG).toEqual({
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  });

  test('returns either the coherent before-commit or after-commit lifecycle snapshot, never a mixed pair', async () => {
    if (testDatabaseUrl === undefined) throw new Error('Missing test URL.');
    const eventId = await createActiveEvent();
    await appendText(setupDatabase(), eventId, 1, 'projection:active');

    const eventRead = deferred<void>();
    const continueRead = deferred<void>();
    const hookedConnection = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 2,
    });
    if (hookedConnection.driver !== 'postgres') {
      throw new Error('Expected a PostgreSQL event-room reader.');
    }
    const hookedRuntime = createEventRoomCapabilityRuntime(hookedConnection, {
      afterAuthorizedEventRead: async () => {
        eventRead.resolve();
        await continueRead.promise;
      },
    });

    try {
      const duringCommitPromise = hookedRuntime.execute(
        { eventId, cursor: null, limit: 100 },
        invocation(),
      );
      await eventRead.promise;
      const allClearAt = new Date();
      await writerDatabase().transaction(async (transaction) => {
        await transaction
          .update(events)
          .set({ status: 'all-clear', allClearAt })
          .where(eq(events.id, eventId));
        await appendText(
          transaction as unknown as PostgresDatabase,
          eventId,
          2,
          'projection:all-clear',
        );
      });
      continueRead.resolve();

      const before = await duringCommitPromise;
      expect(before.event?.status).toBe('active');
      expect(before.snapshotSequence).toBe(1);
      expect(before.entries.map((entry) => entry.payload)).toEqual([
        { text: 'projection:active' },
      ]);

      const after = await hookedRuntime.execute(
        { eventId, cursor: null, limit: 100 },
        invocation(),
      );
      expect(after.event?.status).toBe('all-clear');
      expect(after.snapshotSequence).toBe(2);
      expect(after.entries.map((entry) => entry.payload)).toEqual([
        { text: 'projection:active' },
        { text: 'projection:all-clear' },
      ]);
    } finally {
      continueRead.resolve();
      await hookedRuntime.close();
    }
  });

  test('rejects cross-event, unknown-version, and future cursors', async () => {
    const firstEventId = await createActiveEvent();
    const secondEventId = await createActiveEvent();
    await appendText(setupDatabase(), firstEventId, 1, 'first event');

    const crossEvent = await captureEngineError(() =>
      eventRoomRuntime().execute(
        {
          eventId: secondEventId,
          cursor: createEventRoomCursor(firstEventId, 1),
          limit: 100,
        },
        invocation(),
      ),
    );
    expect(crossEvent.status).toBe(400);

    const future = await captureEngineError(() =>
      eventRoomRuntime().execute(
        {
          eventId: firstEventId,
          cursor: createEventRoomCursor(firstEventId, 99),
          limit: 100,
        },
        invocation(),
      ),
    );
    expect(future.status).toBe(400);

    const unknownVersion = Buffer.from(
      JSON.stringify({ v: 2, e: firstEventId, s: 1 }),
      'utf8',
    ).toString('base64url');
    expect(() =>
      readEventRoomCursorSequence(unknownVersion, firstEventId),
    ).toThrow(CapabilityEngineError);
  });

  test('fails closed instead of skipping a discontinuous journal sequence', async () => {
    const eventId = await createActiveEvent();
    await appendText(setupDatabase(), eventId, 1, 'entry:1');
    await appendText(setupDatabase(), eventId, 3, 'entry:3');

    const error = await captureEngineError(() =>
      eventRoomRuntime().execute(
        {
          eventId,
          cursor: createEventRoomCursor(eventId, 1),
          limit: 100,
        },
        invocation(),
      ),
    );
    expect(error.status).toBe(409);
    expect(error.reasonCode).toBe('PERSISTENCE_CONFLICT');
  });

  test('paginates concurrent appends without gaps or duplicates and exposes state only at a page head', async () => {
    const eventId = await createActiveEvent();
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      await appendText(setupDatabase(), eventId, sequence, `entry:${sequence}`);
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    let pageNumber = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await eventRoomRuntime().execute(
        { eventId, cursor, limit: 2 },
        invocation(),
      );
      pageNumber += 1;
      seen.push(...page.entries.map((entry) => entry.sequence));
      cursor = page.cursor;
      hasMore = page.hasMore;
      if (pageNumber === 1) {
        expect(page.event?.id).toBe(eventId);
        await appendText(setupDatabase(), eventId, 8, 'entry:8');
      } else if (hasMore) {
        expect(page.event).toBeNull();
      } else {
        expect(page.event?.id).toBe(eventId);
      }
    }

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(readEventRoomCursorSequence(cursor, eventId)).toBe(8);
  });

  test('persists no successful security-audit entry for an authorized sync', async () => {
    const eventId = await createActiveEvent();
    const requestId = randomUUID();
    await eventRoomRuntime().execute(
      { eventId, cursor: null, limit: 100 },
      invocation(requestId),
    );
    const rows = await setupDatabase()
      .select({ id: securityAuditEntries.id })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, requestId));
    expect(rows).toHaveLength(0);
  });
});
