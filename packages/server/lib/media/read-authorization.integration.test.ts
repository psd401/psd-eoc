import { createHash, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';

import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import {
  createDatabaseClient,
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
import {
  CapabilityEngineError,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import {
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
  type JournalCapabilityStore,
} from '../capabilities/journal';
import { executeMediaCapability } from './capabilities';
import type { MediaObjectStore } from './object-store';
import {
  createDrizzleMediaCapabilityStore,
  type MediaCapabilityStore,
} from './repository';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const HUMAN_ACTOR = Object.freeze({
  kind: 'human' as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
});
const CONNECTIVITY_EPOCH_ID = randomUUID();
const CONTENT_SHA256 = createHash('sha256')
  .update('synthetic redaction-aware media fixture', 'utf8')
  .digest('hex');

interface FixtureIds {
  readonly facilityId: string;
  readonly eventTypeVersionId: string;
  readonly rosterSnapshotId: string;
}

interface ReadyMediaFixture {
  readonly mediaId: string;
  readonly storageKey: string;
}

interface JournalTarget {
  readonly id: string;
  readonly sequence: number;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) {
        throw new Error('The deferred resolver is unavailable.');
      }
      resolvePromise();
    },
  };
}

let setupConnection: PostgresDatabaseConnection | undefined;
let fixtureIds: FixtureIds | undefined;

function setupDatabase(): PostgresDatabase {
  if (setupConnection === undefined) {
    throw new Error('The media read-authorization database is unavailable.');
  }
  return setupConnection.db;
}

function fixtures(): FixtureIds {
  if (fixtureIds === undefined) {
    throw new Error('The synthetic media read fixtures are unavailable.');
  }
  return fixtureIds;
}

function createPostgresTestConnection(url: string): PostgresDatabaseConnection {
  const connection = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections: 1,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('The media read race requires PostgreSQL clients.');
  }
  return connection;
}

function invocation(
  facilityId: string,
  requestId = randomUUID(),
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope: {
      facilityScope: { kind: 'facilities', facilityIds: [facilityId] },
    },
    requestId,
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: null,
  };
}

function journalMutationInvocation(
  facilityId: string,
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope: {
      facilityScope: { kind: 'facilities', facilityIds: [facilityId] },
    },
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: {
      idempotencyKey: `synthetic-media-redaction-${randomUUID()}`,
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId: null,
    },
  };
}

function redactionInput(eventId: string, target: JournalTarget) {
  return {
    eventId,
    kind: 'text' as const,
    payload: { text: '[Content redacted — original retained in journal]' },
    clientTime: null,
    supersedes: {
      entryId: target.id,
      entrySequence: target.sequence,
      kind: 'redaction' as const,
      reason: 'Synthetic concurrent media-read redaction.',
    },
  };
}

function readOnlyObjectStore(
  createPrivateReadGrant: MediaObjectStore['createPrivateReadGrant'],
): MediaObjectStore {
  const unexpected = async (): Promise<never> => {
    throw new Error('An unrelated media provider method was called.');
  };
  return {
    createRawUploadGrant: unexpected,
    readVerifiedRawObject: unexpected,
    putSanitizedObject: unexpected,
    getMalwareScanStatus: unexpected,
    createPrivateReadGrant,
  };
}

async function captureEngineError(
  operation: Promise<unknown>,
): Promise<CapabilityEngineError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityEngineError);
    return error as CapabilityEngineError;
  }
  throw new Error('Expected the media read capability to reject.');
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

async function createReadyMedia(eventId: string): Promise<ReadyMediaFixture> {
  const uploadIntentId = randomUUID();
  const mediaId = randomUUID();
  const createdAt = new Date();
  const storageKey = `synthetic/media-read/${eventId}/${mediaId}`;
  await setupDatabase()
    .insert(mediaUploadIntents)
    .values({
      id: uploadIntentId,
      eventId,
      facilityId: fixtures().facilityId,
      budgetPrincipalDigest: 'd'.repeat(64),
      budgetPrincipalAttributed: true,
      byteLength: 128,
      contentSha256: CONTENT_SHA256,
      declaredContentType: 'image/jpeg',
      storageKey: `${storageKey}/quarantine`,
      status: 'completed',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 5 * 60_000),
    });
  await setupDatabase().insert(mediaRecords).values({
    id: mediaId,
    uploadIntentId,
    eventId,
    status: 'ready',
    detectedContentType: 'image/jpeg',
    sanitizedByteLength: 120,
    sanitizedContentSha256: CONTENT_SHA256,
    storageKey,
    malwareScan: 'clean',
    exifStripped: true,
    createdAt,
  });
  return Object.freeze({ mediaId, storageKey });
}

function commonJournalValues(eventId: string, sequence: number) {
  return {
    eventId,
    sequence,
    author: HUMAN_ACTOR,
    source: 'web' as const,
    serverTime: new Date(),
    clientTime: null,
    transitionId: null,
  };
}

async function appendText(
  database: PostgresDatabase,
  eventId: string,
  sequence: number,
): Promise<JournalTarget> {
  const id = randomUUID();
  await database.insert(journalEntries).values({
    ...commonJournalValues(eventId, sequence),
    id,
    kind: 'text',
    payload: { text: `Synthetic non-photo entry ${sequence}` },
    mediaId: null,
    supersedesEntryId: null,
    supersedesEntrySequence: null,
    supersessionKind: null,
    supersessionReason: null,
  });
  return Object.freeze({ id, sequence });
}

async function appendPhoto(
  database: PostgresDatabase,
  eventId: string,
  mediaId: string,
  sequence: number,
): Promise<JournalTarget> {
  const id = randomUUID();
  await database.insert(journalEntries).values({
    ...commonJournalValues(eventId, sequence),
    id,
    kind: 'photo',
    payload: {
      mediaId,
      altText: `Synthetic photo ${sequence}`,
      caption: null,
    },
    mediaId,
    supersedesEntryId: null,
    supersedesEntrySequence: null,
    supersessionKind: null,
    supersessionReason: null,
  });
  return Object.freeze({ id, sequence });
}

async function appendSupersession(
  database: PostgresDatabase,
  eventId: string,
  sequence: number,
  target: JournalTarget,
  kind: 'correction' | 'redaction',
): Promise<void> {
  await database.insert(journalEntries).values({
    ...commonJournalValues(eventId, sequence),
    id: randomUUID(),
    kind: 'text',
    payload: {
      text:
        kind === 'redaction'
          ? '[Content redacted — original retained in journal]'
          : 'Synthetic append-only correction',
    },
    mediaId: null,
    supersedesEntryId: target.id,
    supersedesEntrySequence: target.sequence,
    supersessionKind: kind,
    supersessionReason: `Synthetic ${kind} media-read regression.`,
  });
}

async function resolveReadyMedia(
  store: MediaCapabilityStore,
  eventId: string,
  mediaId: string,
) {
  return store.transaction((transaction) =>
    transaction.resolveReadyMedia(eventId, mediaId),
  );
}

async function backendPid(database: PostgresDatabase): Promise<number> {
  const rows = await database.execute<{ pid: number }>(sql`
    select pg_catalog.pg_backend_pid()::integer as pid
  `);
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    throw new Error('The PostgreSQL backend PID was unavailable.');
  }
  return pid;
}

async function waitForBlocker(
  observer: PostgresDatabase,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer.execute<{ blocked: boolean }>(sql`
      select ${blockerPid}::integer = any(
        pg_catalog.pg_blocking_pids(${blockedPid}::integer)
      ) as blocked
    `);
    if (rows[0]?.blocked === true) {
      return;
    }
  }
  throw new Error('The expected PostgreSQL lock waiter was not observed.');
}

describeWithDatabase('redaction-aware media read authorization', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 4,
    });
    if (created.driver !== 'postgres') {
      throw new Error('Media read integration tests require PostgreSQL.');
    }
    setupConnection = created;
    await migrateDatabase(created);
    await seedDatabase(created.db);

    const [[facility], [version], [snapshot]] = await Promise.all([
      created.db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.code, 'SYN-NORTH'))
        .limit(1),
      created.db
        .select({ id: eventTypeVersions.id })
        .from(eventTypeVersions)
        .where(eq(eventTypeVersions.templateMode, 'drill'))
        .orderBy(asc(eventTypeVersions.id))
        .limit(1),
      created.db
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
      throw new Error('The synthetic seed is missing media read fixtures.');
    }
    fixtureIds = {
      facilityId: facility.id,
      eventTypeVersionId: version.id,
      rosterSnapshotId: snapshot.id,
    };
  });

  afterAll(async () => {
    await setupConnection?.close();
    setupConnection = undefined;
    fixtureIds = undefined;
  });

  test('requires any visible exact-event photo binding and ignores corrections or unrelated redactions', async () => {
    const eventId = await createActiveEvent();
    const otherEventId = await createActiveEvent();
    const media = await createReadyMedia(eventId);
    const unrelatedMedia = await createReadyMedia(eventId);
    const otherEventMedia = await createReadyMedia(otherEventId);
    const store = createDrizzleMediaCapabilityStore(setupDatabase());

    expect(await resolveReadyMedia(store, eventId, media.mediaId)).toBeNull();
    await appendText(setupDatabase(), eventId, 1);
    expect(await resolveReadyMedia(store, eventId, media.mediaId)).toBeNull();

    await appendPhoto(
      setupDatabase(),
      otherEventId,
      otherEventMedia.mediaId,
      1,
    );
    expect(
      await resolveReadyMedia(store, eventId, otherEventMedia.mediaId),
    ).toBeNull();

    const firstBinding = await appendPhoto(
      setupDatabase(),
      eventId,
      media.mediaId,
      2,
    );
    expect(
      await resolveReadyMedia(store, eventId, media.mediaId),
    ).toMatchObject({
      facilityId: fixtures().facilityId,
      record: { id: media.mediaId },
    });

    await appendSupersession(
      setupDatabase(),
      eventId,
      3,
      firstBinding,
      'correction',
    );
    const unrelatedBinding = await appendPhoto(
      setupDatabase(),
      eventId,
      unrelatedMedia.mediaId,
      4,
    );
    await appendSupersession(
      setupDatabase(),
      eventId,
      5,
      unrelatedBinding,
      'redaction',
    );
    expect(
      await resolveReadyMedia(store, eventId, media.mediaId),
    ).toMatchObject({ record: { id: media.mediaId } });

    const secondBinding = await appendPhoto(
      setupDatabase(),
      eventId,
      media.mediaId,
      6,
    );
    await appendSupersession(
      setupDatabase(),
      eventId,
      7,
      firstBinding,
      'redaction',
    );
    expect(
      await resolveReadyMedia(store, eventId, media.mediaId),
    ).toMatchObject({ record: { id: media.mediaId } });

    await appendSupersession(
      setupDatabase(),
      eventId,
      8,
      secondBinding,
      'redaction',
    );
    expect(await resolveReadyMedia(store, eventId, media.mediaId)).toBeNull();
  });

  test('holds the event read lock through signing, audit, and commit before a redaction proceeds', async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('The PostgreSQL test URL is unavailable.');
    }
    const eventId = await createActiveEvent();
    const media = await createReadyMedia(eventId);
    const binding = await appendPhoto(
      setupDatabase(),
      eventId,
      media.mediaId,
      1,
    );
    const reader = createPostgresTestConnection(testDatabaseUrl);
    const writer = createPostgresTestConnection(testDatabaseUrl);
    const observer = createPostgresTestConnection(testDatabaseUrl);
    const signerEntered = deferred();
    const releaseSigner = deferred();
    const requestId = randomUUID();
    let signerCalls = 0;
    const objectStore = readOnlyObjectStore(async (input) => {
      signerCalls += 1;
      expect(input.storageKey).toBe(media.storageKey);
      signerEntered.resolve();
      await releaseSigner.promise;
      return {
        readUrl: 'https://media.example.test/synthetic-read-first',
        expiresInSeconds: input.expiresInSeconds ?? 60,
      };
    });
    let readPromise: Promise<unknown> | undefined;
    let writerPromise: Promise<unknown> | undefined;

    try {
      const [readerPid, writerPid] = await Promise.all([
        backendPid(reader.db),
        backendPid(writer.db),
      ]);
      readPromise = executeMediaCapability(
        'get-media-read-grant',
        { eventId, mediaId: media.mediaId },
        invocation(fixtures().facilityId, requestId),
        createDrizzleMediaCapabilityStore(reader.db),
        { objectStore },
      );
      await signerEntered.promise;

      writerPromise = executeJournalCapability(
        'redact-journal-entry',
        redactionInput(eventId, binding),
        journalMutationInvocation(fixtures().facilityId),
        createDrizzleJournalCapabilityStore(writer.db),
      );
      await waitForBlocker(observer.db, writerPid, readerPid);
      expect(signerCalls).toBe(1);

      releaseSigner.resolve();
      await expect(readPromise).resolves.toMatchObject({
        eventId,
        mediaId: media.mediaId,
      });
      await expect(writerPromise).resolves.toMatchObject({
        eventId,
        supersedes: {
          entryId: binding.id,
          entrySequence: binding.sequence,
          kind: 'redaction',
        },
      });
      const [audit] = await setupDatabase()
        .select({ outcome: securityAuditEntries.outcome })
        .from(securityAuditEntries)
        .where(eq(securityAuditEntries.requestId, requestId))
        .limit(1);
      expect(audit?.outcome).toBe('success');

      const denied = await captureEngineError(
        executeMediaCapability(
          'get-media-read-grant',
          { eventId, mediaId: media.mediaId },
          invocation(fixtures().facilityId),
          createDrizzleMediaCapabilityStore(reader.db),
          { objectStore },
        ),
      );
      expect(denied.code).toBe('NOT_FOUND');
      expect(signerCalls).toBe(1);
    } finally {
      releaseSigner.resolve();
      const pending: Promise<unknown>[] = [];
      if (readPromise !== undefined) pending.push(readPromise);
      if (writerPromise !== undefined) pending.push(writerPromise);
      await Promise.allSettled(pending);
      await Promise.all([reader.close(), writer.close(), observer.close()]);
    }
  });

  test('waits behind an uncommitted redaction and rechecks visibility before signing', async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('The PostgreSQL test URL is unavailable.');
    }
    const eventId = await createActiveEvent();
    const media = await createReadyMedia(eventId);
    const binding = await appendPhoto(
      setupDatabase(),
      eventId,
      media.mediaId,
      1,
    );
    const reader = createPostgresTestConnection(testDatabaseUrl);
    const writer = createPostgresTestConnection(testDatabaseUrl);
    const observer = createPostgresTestConnection(testDatabaseUrl);
    const redactionInserted = deferred();
    const releaseWriter = deferred();
    let signerCalls = 0;
    const objectStore = readOnlyObjectStore(async (input) => {
      signerCalls += 1;
      return {
        readUrl: 'https://media.example.test/synthetic-redaction-first',
        expiresInSeconds: input.expiresInSeconds ?? 60,
      };
    });
    let writerPromise: Promise<void> | undefined;
    let readPromise: Promise<unknown> | undefined;

    try {
      const [readerPid, writerPid] = await Promise.all([
        backendPid(reader.db),
        backendPid(writer.db),
      ]);
      const journalStore = createDrizzleJournalCapabilityStore(writer.db);
      const hookedJournalStore: JournalCapabilityStore = {
        ...journalStore,
        transaction(operation) {
          return journalStore.transaction((transaction) =>
            operation({
              ...transaction,
              async appendJournalEntry(entry) {
                await transaction.appendJournalEntry(entry);
                if (entry.supersedes?.kind === 'redaction') {
                  redactionInserted.resolve();
                  await releaseWriter.promise;
                }
              },
            }),
          );
        },
      };
      writerPromise = executeJournalCapability(
        'redact-journal-entry',
        redactionInput(eventId, binding),
        journalMutationInvocation(fixtures().facilityId),
        hookedJournalStore,
      ).then(() => undefined);
      await redactionInserted.promise;

      readPromise = executeMediaCapability(
        'get-media-read-grant',
        { eventId, mediaId: media.mediaId },
        invocation(fixtures().facilityId),
        createDrizzleMediaCapabilityStore(reader.db),
        { objectStore },
      );
      await waitForBlocker(observer.db, readerPid, writerPid);
      expect(signerCalls).toBe(0);

      releaseWriter.resolve();
      await writerPromise;
      const denied = await captureEngineError(readPromise);
      expect(denied.code).toBe('NOT_FOUND');
      expect(signerCalls).toBe(0);
    } finally {
      releaseWriter.resolve();
      const pending: Promise<unknown>[] = [];
      if (writerPromise !== undefined) pending.push(writerPromise);
      if (readPromise !== undefined) pending.push(readPromise);
      await Promise.allSettled(pending);
      await Promise.all([reader.close(), writer.close(), observer.close()]);
    }
  });
});
