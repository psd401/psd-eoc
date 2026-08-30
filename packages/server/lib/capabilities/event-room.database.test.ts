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
import { asc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type AwsDataApiDatabase,
  type DatabaseExecuteResult,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  eventTypeVersions,
  events,
  facilities,
  journalEntries,
  mediaRecords,
  mediaUploadIntents,
  rosterSnapshots,
  securityAuditEntries,
} from '../../db/schema';
import { seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
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
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
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
  readonly facilityCode: string;
  readonly facilityName: string;
  readonly eventTypeVersionId: string;
  readonly eventTypeVersionName: string;
  readonly eventTypeTemplateMode: 'real' | 'drill';
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

function invocation(
  requestId = randomUUID(),
  source: 'web' | 'mobile' = 'web',
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source,
    scope: DISTRICT_SCOPE,
    requestId,
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: null,
  };
}

async function createActiveEvent(
  facilityId = fixtures().facilityId,
): Promise<string> {
  const ids = fixtures();
  const eventId = randomUUID();
  const activatedAt = new Date();
  await setupDatabase()
    .insert(events)
    .values({
      id: eventId,
      facilityId,
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

function expectedHeader() {
  const ids = fixtures();
  return {
    facility: {
      id: ids.facilityId,
      code: ids.facilityCode,
      name: ids.facilityName,
    },
    eventType: {
      id: ids.eventTypeVersionId,
      name: ids.eventTypeVersionName,
      templateMode: ids.eventTypeTemplateMode,
    },
  };
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
    const facilityRecord = [
      { stringValue: facilityId },
      { stringValue: 'SYN-NORTH' },
      { stringValue: 'Synthetic North School' },
    ] satisfies Field[];
    const eventTypeRecord = [
      { stringValue: eventTypeVersionId },
      { stringValue: 'Synthetic Exercise' },
      { stringValue: 'drill' },
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
          if (statement.includes('from "facilities"')) {
            return {
              $metadata: {},
              records: [facilityRecord],
            } satisfies ExecuteStatementCommandOutput;
          }
          if (statement.includes('from "event_type_versions"')) {
            return {
              $metadata: {},
              records: [eventTypeRecord],
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
        'arn:aws:rds:us-east-1:000000000000:cluster:psd-eoc-synthetic',
      secretArn:
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:psd-eoc-synthetic',
      schema: { events, eventTypeVersions, facilities, journalEntries },
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
        header: {
          facility: {
            id: facilityId,
            code: 'SYN-NORTH',
            name: 'Synthetic North School',
          },
          eventType: {
            id: eventTypeVersionId,
            name: 'Synthetic Exercise',
            templateMode: 'drill',
          },
        },
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
      ).toEqual(Array.from({ length: 6 }, () => transactionId));
      expect(executeCommands[0]?.input.sql).toBe(
        'set transaction isolation level repeatable read read only',
      );
      expect(executeCommands[1]?.input.sql).toContain('from "events"');
      expect(executeCommands[2]?.input.sql).toContain('from "facilities"');
      expect(executeCommands[3]?.input.sql).toContain(
        'from "event_type_versions"',
      );
      expect(executeCommands[4]?.input.sql).toContain(
        'order by "journal_entries"."sequence" desc',
      );
      expect(executeCommands[5]?.input.sql).toContain(
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
        .select({
          id: facilities.id,
          code: facilities.code,
          name: facilities.name,
        })
        .from(facilities)
        .where(eq(facilities.code, 'SYN-NORTH'))
        .limit(1),
      setupConnection.db
        .select({
          id: eventTypeVersions.id,
          name: eventTypeVersions.name,
          templateMode: eventTypeVersions.templateMode,
        })
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
      facilityCode: facility.code,
      facilityName: facility.name,
      eventTypeVersionId: version.id,
      eventTypeVersionName: version.name,
      eventTypeTemplateMode: version.templateMode,
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

  test('normalizes the real postgres-js raw execute row-list shape', async () => {
    const result = await setupDatabase().execute<{ value: number }>(
      sql`select 77::integer as value`,
    );
    expect(Array.isArray(result)).toBe(true);
    expect(
      databaseExecuteRows(
        result as unknown as DatabaseExecuteResult<{ value: number }>,
      ),
    ).toEqual([{ value: 77 }]);
  });

  test('returns either the coherent before-commit or after-commit lifecycle snapshot, never a mixed pair', async () => {
    if (testDatabaseUrl === undefined) throw new Error('Missing test URL.');
    const concurrentFacilityId = randomUUID();
    const concurrentFacilityCode = `ROOM-${concurrentFacilityId.slice(0, 8).toUpperCase()}`;
    const beforeFacilityName = 'Synthetic Before Commit School';
    const afterFacilityName = 'Synthetic After Commit School';
    await setupDatabase().insert(facilities).values({
      id: concurrentFacilityId,
      code: concurrentFacilityCode,
      name: beforeFacilityName,
      active: true,
    });
    const eventId = await createActiveEvent(concurrentFacilityId);
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
          .update(facilities)
          .set({ name: afterFacilityName })
          .where(eq(facilities.id, concurrentFacilityId));
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
      expect(before.header).toEqual({
        facility: {
          id: concurrentFacilityId,
          code: concurrentFacilityCode,
          name: beforeFacilityName,
        },
        eventType: expectedHeader().eventType,
      });
      expect(before.snapshotSequence).toBe(1);
      expect(
        before.entries.map((projection) =>
          projection.visibility === 'visible' ? projection.entry.payload : null,
        ),
      ).toEqual([{ text: 'projection:active' }]);

      const after = await hookedRuntime.execute(
        { eventId, cursor: null, limit: 100 },
        invocation(),
      );
      expect(after.event?.status).toBe('all-clear');
      expect(after.header).toEqual({
        facility: {
          id: concurrentFacilityId,
          code: concurrentFacilityCode,
          name: afterFacilityName,
        },
        eventType: expectedHeader().eventType,
      });
      expect(after.snapshotSequence).toBe(2);
      expect(
        after.entries.map((projection) =>
          projection.visibility === 'visible' ? projection.entry.payload : null,
        ),
      ).toEqual([
        { text: 'projection:active' },
        { text: 'projection:all-clear' },
      ]);
    } finally {
      continueRead.resolve();
      await hookedRuntime.close();
    }
  });

  test('omits redacted text, photo, and location payloads even when the redaction is outside the current page', async () => {
    const eventId = await createActiveEvent();
    const textId = randomUUID();
    const photoId = randomUUID();
    const locationId = randomUUID();
    const photoMediaId = randomUUID();
    const uploadIntentId = randomUUID();
    const baseTime = Date.now();
    const mediaCreatedAt = new Date(baseTime - 1_000);
    await setupDatabase()
      .insert(mediaUploadIntents)
      .values({
        id: uploadIntentId,
        eventId,
        facilityId: fixtures().facilityId,
        budgetPrincipalDigest: 'f'.repeat(64),
        budgetPrincipalAttributed: true,
        byteLength: 128,
        contentSha256: 'b'.repeat(64),
        declaredContentType: 'image/jpeg',
        storageKey: `synthetic/event-room/${uploadIntentId}/upload`,
        status: 'completed',
        createdAt: mediaCreatedAt,
        expiresAt: new Date(mediaCreatedAt.getTime() + 5 * 60_000),
      });
    await setupDatabase()
      .insert(mediaRecords)
      .values({
        id: photoMediaId,
        uploadIntentId,
        eventId,
        status: 'ready',
        detectedContentType: 'image/jpeg',
        sanitizedByteLength: 120,
        sanitizedContentSha256: 'c'.repeat(64),
        storageKey: `synthetic/event-room/${uploadIntentId}/sanitized`,
        malwareScan: 'clean',
        exifStripped: true,
        createdAt: mediaCreatedAt,
      });
    const common = (sequence: number) => ({
      eventId,
      sequence,
      author: HUMAN_ACTOR,
      authorDisplayName: null,
      source: 'web' as const,
      serverTime: new Date(baseTime + sequence),
      clientTime: null,
      transitionId: null,
    });
    await setupDatabase()
      .insert(journalEntries)
      .values([
        {
          ...common(1),
          id: textId,
          kind: 'text',
          payload: { text: 'synthetic-redacted-text-secret' },
          mediaId: null,
          supersedesEntryId: null,
          supersedesEntrySequence: null,
          supersessionKind: null,
          supersessionReason: null,
        },
        {
          ...common(2),
          id: photoId,
          kind: 'photo',
          payload: {
            mediaId: photoMediaId,
            altText: 'synthetic-redacted-photo-alt',
            caption: 'synthetic-redacted-photo-caption',
          },
          mediaId: photoMediaId,
          supersedesEntryId: null,
          supersedesEntrySequence: null,
          supersessionKind: null,
          supersessionReason: null,
        },
        {
          ...common(3),
          id: locationId,
          kind: 'location',
          payload: {
            state: 'known',
            latitude: 47.389,
            longitude: -122.589,
            accuracyMeters: 5,
            label: 'synthetic-redacted-location-label',
          },
          mediaId: null,
          supersedesEntryId: null,
          supersedesEntrySequence: null,
          supersessionKind: null,
          supersessionReason: null,
        },
        ...[
          { sequence: 4, targetId: textId, targetSequence: 1 },
          { sequence: 5, targetId: photoId, targetSequence: 2 },
          { sequence: 6, targetId: locationId, targetSequence: 3 },
        ].map(({ sequence, targetId, targetSequence }) => ({
          ...common(sequence),
          id: randomUUID(),
          kind: 'text' as const,
          payload: {
            text: '[Content redacted — original retained in journal]',
          },
          mediaId: null,
          supersedesEntryId: targetId,
          supersedesEntrySequence: targetSequence,
          supersessionKind: 'redaction' as const,
          supersessionReason: 'Synthetic read-projection regression.',
        })),
      ]);

    const firstPage = await eventRoomRuntime().execute(
      { eventId, cursor: null, limit: 1 },
      invocation(),
    );
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.entries).toEqual([
      {
        visibility: 'redacted',
        entry: {
          id: textId,
          eventId,
          sequence: 1,
          kind: 'text',
          author: HUMAN_ACTOR,
          authorDisplayName: null,
          source: 'web',
          serverTime: firstPage.entries[0]!.entry.serverTime,
          clientTime: null,
          supersedes: null,
        },
      },
    ]);

    const threeOriginals = await eventRoomRuntime().execute(
      { eventId, cursor: null, limit: 3 },
      invocation(),
    );
    expect(threeOriginals.entries.map(({ visibility }) => visibility)).toEqual([
      'redacted',
      'redacted',
      'redacted',
    ]);
    const outwardJson = JSON.stringify(threeOriginals.entries);
    for (const forbidden of [
      'synthetic-redacted-text-secret',
      photoMediaId,
      'synthetic-redacted-photo-alt',
      'synthetic-redacted-photo-caption',
      '47.389',
      '-122.589',
      'synthetic-redacted-location-label',
      'payload',
    ]) {
      expect(outwardJson).not.toContain(forbidden);
    }

    const persisted = await setupDatabase()
      .select({ id: journalEntries.id, payload: journalEntries.payload })
      .from(journalEntries)
      .where(inArray(journalEntries.id, [textId, photoId, locationId]));
    expect(JSON.stringify(persisted)).toContain(
      'synthetic-redacted-text-secret',
    );
    expect(JSON.stringify(persisted)).toContain(photoMediaId);
    expect(JSON.stringify(persisted)).toContain(
      'synthetic-redacted-location-label',
    );

    const sequences: number[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    while (hasMore) {
      const page = await eventRoomRuntime().execute(
        { eventId, cursor, limit: 2 },
        invocation(),
      );
      sequences.push(...page.entries.map(({ entry }) => entry.sequence));
      cursor = page.cursor;
      hasMore = page.hasMore;
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(sequences).size).toBe(sequences.length);
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
      expect(page.header).toEqual(expectedHeader());
      seen.push(...page.entries.map(({ entry }) => entry.sequence));
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

  test('returns the trusted header to an authenticated mobile human without a success-audit write', async () => {
    const eventId = await createActiveEvent();
    const requestId = randomUUID();
    const result = await eventRoomRuntime().execute(
      { eventId, cursor: null, limit: 100 },
      invocation(requestId, 'mobile'),
    );
    expect(result.header).toEqual(expectedHeader());
    expect(result.event?.eventTypeVersion.id).toBe(result.header.eventType.id);
    expect(result.event?.templateMode).toBe(
      result.header.eventType.templateMode,
    );
    const rows = await setupDatabase()
      .select({ id: securityAuditEntries.id })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, requestId));
    expect(rows).toHaveLength(0);
  });
});
