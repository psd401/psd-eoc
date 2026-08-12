import { createHash, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  ActivationPreviewSchema,
  EventTransitionSchema,
  HUMAN_CONFIRMATION_MAX_AGE_SECONDS,
  IntegrationStatusSchema,
  MediaRecordSchema,
  SessionEstablishmentResultSchema,
  type JournalEntry,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import {
  createDatabaseClient,
  type Database,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  accessMembershipMembers,
  accessMembershipSnapshots,
  activationPreviews,
  audienceConfigurations,
  channelAttempts,
  channelConfigurations,
  connectivityEpochs,
  deliveryEvidence,
  deviceEnrollments,
  dispatchBatches,
  eventTypeVersions,
  eventTransitions,
  events,
  facilities,
  humanConfirmationActions,
  humanConfirmationRecords,
  integrationStatuses,
  journalEntries,
  lifecycleConsequencePreviews,
  mediaRecords,
  mediaUploadIntents,
  notificationIntentChannels,
  notificationIntents,
  outbox,
  rosterEndpoints,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSourceConfigurations,
  securityAuditEntries,
  sessions,
  users,
} from '../../../../db/schema';
import { seedDatabase } from '../../../../db/seed';
import { migrateDatabase } from '../../../../drizzle/migrate';
import {
  digestCapabilityValue,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '../../../../lib/capabilities/events';
import {
  EVENT_CONFIRMATION_PHRASES,
  createJournalCapabilityRuntime,
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
  type JournalCapabilityStore,
} from '../../../../lib/capabilities/journal';
import {
  quarantineStorageKey,
  readyStorageKey,
} from '../../../../lib/media/model';
import { buildPhotoChecksumExportQuery } from '../../../../lib/media/repository';
import type { AuthenticatedSession } from '../../../../lib/auth/sessions';
import { requireSyntheticEventRoomTestDatabaseUrl } from './test-database';

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

interface SyntheticFixtureIds {
  readonly northFacilityId: string;
  readonly southFacilityId: string;
  readonly eventTypeVersionId: string;
  readonly rosterSnapshotId: string;
  readonly audienceConfigId: string;
  readonly audienceConfigVersion: number;
}

interface SyntheticReadyPhoto {
  readonly id: string;
  readonly sanitizedContentSha256: string;
  readonly sanitizedByteLength: number;
}

let connection: PostgresDatabaseConnection | undefined;
let fixtureIds: SyntheticFixtureIds | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The event journal integration database is not open.');
  }
  return connection;
}

function syntheticFixtureIds(): SyntheticFixtureIds {
  if (fixtureIds === undefined) {
    throw new Error('The synthetic event journal fixture is unavailable.');
  }
  return fixtureIds;
}

function store(): JournalCapabilityStore {
  return createDrizzleJournalCapabilityStore(databaseConnection().db);
}

function humanMutationInvocation(
  idempotencyKey: string,
  scope: TrustedCapabilityInvocation['scope'] = DISTRICT_SCOPE,
  source: AuthenticatedSession['source'] = 'web',
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source,
    scope,
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: {
      idempotencyKey,
      transport:
        source === 'web'
          ? {
              kind: 'web-interactive',
              method: 'POST',
              interaction: 'explicit-user-submit',
              csrfVerified: true,
            }
          : {
              kind: 'mobile-interactive',
              interaction: 'explicit-user-submit',
            },
      humanConfirmationId: null,
    },
  };
}

function humanQueryInvocation(
  scope: TrustedCapabilityInvocation['scope'] = DISTRICT_SCOPE,
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope,
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: null,
  };
}

function confirmedHumanMutationInvocation(input: {
  readonly idempotencyKey: string;
  readonly confirmationId: string;
  readonly requestId?: string;
  readonly actor?: Extract<
    TrustedCapabilityInvocation['actor'],
    { readonly kind: 'human' }
  >;
  readonly connectivityEpochId?: string;
  readonly serverTime?: Date;
  readonly source?: AuthenticatedSession['source'];
}): TrustedCapabilityInvocation {
  const source = input.source ?? 'web';
  return {
    actor: input.actor ?? HUMAN_ACTOR,
    source,
    scope: DISTRICT_SCOPE,
    requestId: input.requestId ?? randomUUID(),
    serverTime: input.serverTime ?? new Date(),
    connectivityEpochId: input.connectivityEpochId ?? CONNECTIVITY_EPOCH_ID,
    mutation: {
      idempotencyKey: input.idempotencyKey,
      transport:
        source === 'web'
          ? {
              kind: 'web-interactive',
              method: 'POST',
              interaction: 'explicit-user-submit',
              csrfVerified: true,
            }
          : {
              kind: 'mobile-interactive',
              interaction: 'explicit-user-submit',
            },
      humanConfirmationId: input.confirmationId,
    },
  };
}

async function createActiveSyntheticEvent(): Promise<string> {
  const ids = syntheticFixtureIds();
  const eventId = randomUUID();
  const activatedAt = new Date();
  await databaseConnection()
    .db.insert(events)
    .values({
      id: eventId,
      facilityId: ids.northFacilityId,
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function createReadySyntheticPhoto(
  eventId: string,
): Promise<SyntheticReadyPhoto> {
  const uploadIntentId = randomUUID();
  const mediaId = randomUUID();
  const rawContent = `synthetic raw photo ${uploadIntentId}`;
  const sanitizedContent = `synthetic sanitized photo ${mediaId}`;
  const createdAt = new Date();
  const record = MediaRecordSchema.parse({
    id: mediaId,
    uploadIntentId,
    eventId,
    status: 'ready',
    detectedContentType: 'image/jpeg',
    sanitizedByteLength: Buffer.byteLength(sanitizedContent, 'utf8'),
    sanitizedContentSha256: sha256(sanitizedContent),
    malwareScan: 'clean',
    exifStripped: true,
    createdAt: createdAt.toISOString(),
  });

  await databaseConnection().db.transaction(async (transaction) => {
    await transaction.insert(mediaUploadIntents).values({
      id: uploadIntentId,
      eventId,
      facilityId: syntheticFixtureIds().northFacilityId,
      budgetPrincipalDigest: sha256(
        'synthetic journal photo fixture principal',
      ),
      budgetPrincipalAttributed: true,
      byteLength: Buffer.byteLength(rawContent, 'utf8'),
      contentSha256: sha256(rawContent),
      declaredContentType: 'image/jpeg',
      storageKey: quarantineStorageKey(eventId, uploadIntentId),
      status: 'completed',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
    });
    await transaction.insert(mediaRecords).values({
      id: record.id,
      uploadIntentId: record.uploadIntentId,
      eventId: record.eventId,
      status: record.status,
      detectedContentType: record.detectedContentType,
      sanitizedByteLength: record.sanitizedByteLength,
      sanitizedContentSha256: record.sanitizedContentSha256,
      storageKey: readyStorageKey(eventId, record.id),
      malwareScan: record.malwareScan,
      exifStripped: record.exifStripped,
      createdAt,
    });
  });

  return {
    id: record.id,
    sanitizedContentSha256: record.sanitizedContentSha256,
    sanitizedByteLength: record.sanitizedByteLength,
  };
}

function textInput(
  eventId: string,
  text: string,
  clientTime: string | null,
  supersedes: JournalEntry['supersedes'] = null,
) {
  return {
    eventId,
    kind: 'text' as const,
    payload: { text },
    clientTime,
    supersedes,
  };
}

function photoInput(
  eventId: string,
  mediaId: string,
  altText: string,
  caption: string | null,
  clientTime: string | null,
) {
  return {
    eventId,
    kind: 'photo' as const,
    payload: { mediaId, altText, caption },
    clientTime,
    supersedes: null,
  };
}

function systemJournalCode(entry: JournalEntry): string {
  if (entry.kind !== 'system') {
    throw new Error('Expected an immutable system lifecycle journal fact.');
  }
  return entry.payload.code;
}

async function appendText(
  journalStore: JournalCapabilityStore,
  eventId: string,
  text: string,
  clientTime: string | null,
): Promise<JournalEntry> {
  return executeJournalCapability(
    'append-journal-entry',
    textInput(eventId, text, clientTime),
    humanMutationInvocation(`issue16-append-${randomUUID()}`),
    journalStore,
  );
}

async function listJournal(
  journalStore: JournalCapabilityStore,
  eventId: string,
  cursor: string | null,
  limit: number,
) {
  return executeJournalCapability(
    'list-journal-entries',
    { eventId, cursor, limit },
    humanQueryInvocation(),
    journalStore,
  );
}

describeWithDatabase('event journal database guarantees', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 8,
    });
    if (created.driver !== 'postgres') {
      throw new Error('Event journal integration tests require PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
    await seedDatabase(created.db);

    const [[north], [south], [version], [snapshot]] = await Promise.all([
      created.db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.code, 'SYN-NORTH'))
        .limit(1),
      created.db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.code, 'SYN-SOUTH'))
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
      north === undefined ||
      south === undefined ||
      version === undefined ||
      snapshot === undefined
    ) {
      throw new Error('The synthetic seed is missing event journal fixtures.');
    }
    const [audience] = await created.db
      .select({
        id: audienceConfigurations.id,
        version: audienceConfigurations.version,
      })
      .from(audienceConfigurations)
      .where(eq(audienceConfigurations.facilityId, north.id))
      .orderBy(asc(audienceConfigurations.version))
      .limit(1);
    if (audience === undefined) {
      throw new Error('The synthetic seed is missing an audience fixture.');
    }
    fixtureIds = {
      northFacilityId: north.id,
      southFacilityId: south.id,
      eventTypeVersionId: version.id,
      rosterSnapshotId: snapshot.id,
      audienceConfigId: audience.id,
      audienceConfigVersion: audience.version,
    };
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('gives late joiners the complete server order and resumes an event-bound keyset cursor across concurrent posts', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const deliberatelyReversedClientTimes = [
      '2026-08-10T18:04:00.000Z',
      '2026-08-10T18:03:00.000Z',
      '2026-08-10T18:02:00.000Z',
      '2026-08-10T18:01:00.000Z',
    ] as const;
    const initialEntries: JournalEntry[] = [];
    for (const [
      index,
      clientTime,
    ] of deliberatelyReversedClientTimes.entries()) {
      initialEntries.push(
        await appendText(
          journalStore,
          eventId,
          `Initial post ${index + 1}`,
          clientTime,
        ),
      );
    }

    const firstPage = await listJournal(journalStore, eventId, null, 2);
    expect(firstPage.items.map(({ entry }) => entry.id)).toEqual(
      initialEntries.slice(0, 2).map((entry) => entry.id),
    );
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.pageInfo.nextCursor).not.toBeNull();

    const concurrentEntries = await Promise.all([
      appendText(
        journalStore,
        eventId,
        'Concurrent post A',
        '2026-08-10T17:00:00.000Z',
      ),
      appendText(
        journalStore,
        eventId,
        'Concurrent post B',
        '2026-08-10T16:00:00.000Z',
      ),
    ]);

    const secondPage = await listJournal(
      journalStore,
      eventId,
      firstPage.pageInfo.nextCursor,
      2,
    );
    expect(secondPage.items.map(({ entry }) => entry.id)).toEqual(
      initialEntries.slice(2).map((entry) => entry.id),
    );
    expect(secondPage.pageInfo.hasMore).toBe(true);
    expect(secondPage.pageInfo.nextCursor).not.toBeNull();

    const thirdPage = await listJournal(
      journalStore,
      eventId,
      secondPage.pageInfo.nextCursor,
      2,
    );
    expect(thirdPage.items.map(({ entry }) => entry.id).sort()).toEqual(
      concurrentEntries.map((entry) => entry.id).sort(),
    );
    expect(thirdPage.items.map(({ entry }) => entry.sequence)).toEqual([5, 6]);
    expect(thirdPage.pageInfo).toEqual({ hasMore: false, nextCursor: null });

    const lateJoin = await listJournal(journalStore, eventId, null, 200);
    expect(lateJoin.items).toHaveLength(6);
    expect(lateJoin.items.map(({ entry }) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(
      lateJoin.items.slice(0, 4).map(({ entry }) => entry.clientTime),
    ).toEqual([...deliberatelyReversedClientTimes]);
    for (let index = 1; index < lateJoin.items.length; index += 1) {
      const previous = lateJoin.items[index - 1];
      const current = lateJoin.items[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(Date.parse(previous!.entry.serverTime)).toBeLessThanOrEqual(
        Date.parse(current!.entry.serverTime),
      );
    }

    const otherEventId = await createActiveSyntheticEvent();
    await expect(
      listJournal(
        journalStore,
        otherEventId,
        firstPage.pageInfo.nextCursor,
        10,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The journal cursor is invalid for this event.',
    });
  });

  test('replays an idempotent post without appending a duplicate journal row', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const input = textInput(
      eventId,
      'One deliberate user submission',
      '2026-08-10T18:10:00.000Z',
    );
    const idempotencyKey = `issue16-idempotent-${randomUUID()}`;

    const first = await executeJournalCapability(
      'append-journal-entry',
      input,
      humanMutationInvocation(idempotencyKey),
      journalStore,
    );
    const replays = await Promise.all([
      executeJournalCapability(
        'append-journal-entry',
        input,
        humanMutationInvocation(idempotencyKey),
        journalStore,
      ),
      executeJournalCapability(
        'append-journal-entry',
        input,
        humanMutationInvocation(idempotencyKey),
        journalStore,
      ),
    ]);

    expect(replays).toEqual([first, first]);
    const rows = await databaseConnection()
      .db.select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.eventId, eventId));
    expect(rows).toEqual([{ id: first.id }]);
  });

  test('appends one same-event ready photo, replays idempotently, and exports its sanitized checksum', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const media = await createReadySyntheticPhoto(eventId);
    const input = photoInput(
      eventId,
      media.id,
      'Synthetic emergency operations scene; no people are shown.',
      'Synthetic photo used only for persistence evidence.',
      '2026-08-10T18:15:00.000Z',
    );
    const idempotencyKey = `issue17-photo-${randomUUID()}`;

    const first = await executeJournalCapability(
      'append-journal-entry',
      input,
      humanMutationInvocation(idempotencyKey),
      journalStore,
    );
    const replay = await executeJournalCapability(
      'append-journal-entry',
      input,
      humanMutationInvocation(idempotencyKey),
      journalStore,
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      eventId,
      kind: 'photo',
      payload: {
        mediaId: media.id,
        altText: 'Synthetic emergency operations scene; no people are shown.',
        caption: 'Synthetic photo used only for persistence evidence.',
      },
    });
    const rows = await databaseConnection()
      .db.select({
        id: journalEntries.id,
        mediaId: journalEntries.mediaId,
        payload: journalEntries.payload,
      })
      .from(journalEntries)
      .where(eq(journalEntries.eventId, eventId));
    expect(rows).toEqual([
      {
        id: first.id,
        mediaId: media.id,
        payload: first.payload,
      },
    ]);

    const projection = await buildPhotoChecksumExportQuery(
      databaseConnection().db,
      eventId,
    );
    expect(projection).toEqual([
      {
        journalEntryId: first.id,
        eventId,
        sequence: first.sequence,
        mediaId: media.id,
        sanitizedContentSha256: media.sanitizedContentSha256,
        sanitizedByteLength: media.sanitizedByteLength,
        detectedContentType: 'image/jpeg',
      },
    ]);
  });

  test('rejects a ready photo from a different event without appending a journal row', async () => {
    const journalStore = store();
    const mediaEventId = await createActiveSyntheticEvent();
    const targetEventId = await createActiveSyntheticEvent();
    const media = await createReadySyntheticPhoto(mediaEventId);

    await expect(
      executeJournalCapability(
        'append-journal-entry',
        photoInput(
          targetEventId,
          media.id,
          'This cross-event media reference must be rejected.',
          null,
          null,
        ),
        humanMutationInvocation(`issue17-wrong-event-${randomUUID()}`),
        journalStore,
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      reasonCode: 'PERSISTENCE_CONFLICT',
      message: 'The capability could not be completed.',
    });

    const targetRows = await databaseConnection()
      .db.select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.eventId, targetEventId));
    expect(targetRows).toEqual([]);
    const [retainedMedia] = await databaseConnection()
      .db.select({ eventId: mediaRecords.eventId })
      .from(mediaRecords)
      .where(eq(mediaRecords.id, media.id))
      .limit(1);
    expect(retainedMedia).toEqual({ eventId: mediaEventId });
  });

  test('redacts a photo with an appended supersession while retaining the checksum-bound original', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const media = await createReadySyntheticPhoto(eventId);
    const original = await executeJournalCapability(
      'append-journal-entry',
      photoInput(
        eventId,
        media.id,
        'Synthetic scene before append-only redaction.',
        null,
        '2026-08-10T18:16:00.000Z',
      ),
      humanMutationInvocation(`issue17-redaction-original-${randomUUID()}`),
      journalStore,
    );
    const redaction = await executeJournalCapability(
      'redact-journal-entry',
      textInput(
        eventId,
        '[Content redacted — original retained in journal]',
        '2026-08-10T18:17:00.000Z',
        {
          entryId: original.id,
          entrySequence: original.sequence,
          kind: 'redaction',
          reason: 'Synthetic privacy-safe photo redaction.',
        },
      ),
      humanMutationInvocation(`issue17-redaction-${randomUUID()}`),
      journalStore,
    );

    const persisted = await databaseConnection()
      .db.select({
        id: journalEntries.id,
        kind: journalEntries.kind,
        mediaId: journalEntries.mediaId,
        payload: journalEntries.payload,
        supersedesEntryId: journalEntries.supersedesEntryId,
        supersedesEntrySequence: journalEntries.supersedesEntrySequence,
        supersessionKind: journalEntries.supersessionKind,
      })
      .from(journalEntries)
      .where(eq(journalEntries.eventId, eventId))
      .orderBy(asc(journalEntries.sequence));
    expect(persisted).toEqual([
      {
        id: original.id,
        kind: 'photo',
        mediaId: media.id,
        payload: original.payload,
        supersedesEntryId: null,
        supersedesEntrySequence: null,
        supersessionKind: null,
      },
      {
        id: redaction.id,
        kind: 'text',
        mediaId: null,
        payload: redaction.payload,
        supersedesEntryId: original.id,
        supersedesEntrySequence: original.sequence,
        supersessionKind: 'redaction',
      },
    ]);
    const projection = await buildPhotoChecksumExportQuery(
      databaseConnection().db,
      eventId,
    );
    expect(projection).toEqual([
      {
        journalEntryId: original.id,
        eventId,
        sequence: original.sequence,
        mediaId: media.id,
        sanitizedContentSha256: media.sanitizedContentSha256,
        sanitizedByteLength: media.sanitizedByteLength,
        detectedContentType: 'image/jpeg',
      },
    ]);
  });

  test('appends corrections and redactions with provenance while retaining every original row', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const correctedOriginal = await appendText(
      journalStore,
      eventId,
      'Initial accountability count is three.',
      '2026-08-10T18:20:00.000Z',
    );
    const correction = await executeJournalCapability(
      'correct-journal-entry',
      textInput(
        eventId,
        'Corrected accountability count is four.',
        '2026-08-10T18:21:00.000Z',
        {
          entryId: correctedOriginal.id,
          entrySequence: correctedOriginal.sequence,
          kind: 'correction',
          reason: 'The fourth synthetic staff member checked in.',
        },
      ),
      humanMutationInvocation(`issue16-correct-${randomUUID()}`),
      journalStore,
    );
    await expect(
      executeJournalCapability(
        'correct-journal-entry',
        textInput(
          eventId,
          'A second correction must not fork the supersession history.',
          '2026-08-10T18:21:30.000Z',
          {
            entryId: correctedOriginal.id,
            entrySequence: correctedOriginal.sequence,
            kind: 'correction',
            reason: 'Synthetic duplicate correction attempt.',
          },
        ),
        humanMutationInvocation(`issue77-duplicate-correct-${randomUUID()}`),
        journalStore,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'A journal correction cannot target an entry that is already superseded.',
    });
    const redaction = await executeJournalCapability(
      'redact-journal-entry',
      textInput(
        eventId,
        '[Content redacted; original retained in append-only history.]',
        '2026-08-10T18:22:00.000Z',
        {
          entryId: correctedOriginal.id,
          entrySequence: correctedOriginal.sequence,
          kind: 'redaction',
          reason: 'Synthetic sensitive detail was posted unnecessarily.',
        },
      ),
      humanMutationInvocation(`issue16-redact-${randomUUID()}`),
      journalStore,
    );
    await expect(
      executeJournalCapability(
        'redact-journal-entry',
        textInput(
          eventId,
          '[Content redacted; original retained in append-only history.]',
          '2026-08-10T18:22:30.000Z',
          {
            entryId: correctedOriginal.id,
            entrySequence: correctedOriginal.sequence,
            kind: 'redaction',
            reason: 'Synthetic duplicate redaction attempt.',
          },
        ),
        humanMutationInvocation(`issue77-duplicate-redact-${randomUUID()}`),
        journalStore,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The journal entry already has an append-only redaction.',
    });

    const lateJoin = await listJournal(journalStore, eventId, null, 200);
    expect(lateJoin.items.map(({ entry }) => entry.id)).toEqual([
      correctedOriginal.id,
      correction.id,
      redaction.id,
    ]);
    expect(lateJoin.items[0]).toEqual({
      visibility: 'redacted',
      entry: {
        id: correctedOriginal.id,
        eventId,
        sequence: correctedOriginal.sequence,
        kind: correctedOriginal.kind,
        author: correctedOriginal.author,
        source: correctedOriginal.source,
        serverTime: correctedOriginal.serverTime,
        clientTime: correctedOriginal.clientTime,
        supersedes: null,
      },
    });
    expect(JSON.stringify(lateJoin.items[0])).not.toContain(
      'Initial accountability count is three.',
    );
    expect(correction.supersedes).toEqual({
      entryId: correctedOriginal.id,
      entrySequence: correctedOriginal.sequence,
      kind: 'correction',
      reason: 'The fourth synthetic staff member checked in.',
    });
    expect(redaction.supersedes).toEqual({
      entryId: correctedOriginal.id,
      entrySequence: correctedOriginal.sequence,
      kind: 'redaction',
      reason: 'Synthetic sensitive detail was posted unnecessarily.',
    });

    const persisted = await databaseConnection()
      .db.select({
        id: journalEntries.id,
        sequence: journalEntries.sequence,
        supersedesEntryId: journalEntries.supersedesEntryId,
        supersedesEntrySequence: journalEntries.supersedesEntrySequence,
        supersessionKind: journalEntries.supersessionKind,
        supersessionReason: journalEntries.supersessionReason,
      })
      .from(journalEntries)
      .where(eq(journalEntries.eventId, eventId))
      .orderBy(asc(journalEntries.sequence));
    expect(persisted).toHaveLength(3);
    expect(persisted[0]).toMatchObject({
      id: correctedOriginal.id,
      supersedesEntryId: null,
    });
    expect(persisted[1]).toMatchObject({
      id: correction.id,
      supersedesEntryId: correctedOriginal.id,
      supersedesEntrySequence: correctedOriginal.sequence,
      supersessionKind: 'correction',
      supersessionReason: 'The fourth synthetic staff member checked in.',
    });
    expect(persisted[2]).toMatchObject({
      id: redaction.id,
      supersedesEntryId: correctedOriginal.id,
      supersedesEntrySequence: correctedOriginal.sequence,
      supersessionKind: 'redaction',
      supersessionReason:
        'Synthetic sensitive detail was posted unnecessarily.',
    });
  });

  test('serializes a winning redaction before concurrent correction and duplicate redaction attempts', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const original = await appendText(
      journalStore,
      eventId,
      'Synthetic detail that must remain hidden after redaction.',
      '2026-08-10T18:24:00.000Z',
    );

    let releaseWinningRedaction: () => void = () => undefined;
    const winningRedactionRelease = new Promise<void>((resolve) => {
      releaseWinningRedaction = resolve;
    });
    let markWinningRedactionLocked: () => void = () => undefined;
    const winningRedactionLocked = new Promise<void>((resolve) => {
      markWinningRedactionLocked = resolve;
    });
    const winningRedactionStore: JournalCapabilityStore = {
      ...journalStore,
      transaction(operation) {
        return journalStore.transaction((transaction) =>
          operation({
            ...transaction,
            async lockEventForJournal(candidateEventId) {
              const locked =
                await transaction.lockEventForJournal(candidateEventId);
              if (candidateEventId === eventId) {
                markWinningRedactionLocked();
                await winningRedactionRelease;
              }
              return locked;
            },
          }),
        );
      },
    };

    const winningRedactionPromise = executeJournalCapability(
      'redact-journal-entry',
      textInput(
        eventId,
        '[Content redacted; original retained in append-only history.]',
        '2026-08-10T18:25:00.000Z',
        {
          entryId: original.id,
          entrySequence: original.sequence,
          kind: 'redaction',
          reason: 'Synthetic concurrent redaction winner.',
        },
      ),
      humanMutationInvocation(`issue77-winning-redact-${randomUUID()}`),
      winningRedactionStore,
    );
    await winningRedactionLocked;

    const lockAttemptStore = (
      markAttempted: () => void,
    ): JournalCapabilityStore => ({
      ...journalStore,
      transaction(operation) {
        return journalStore.transaction((transaction) =>
          operation({
            ...transaction,
            lockEventForJournal(candidateEventId) {
              const locked = transaction.lockEventForJournal(candidateEventId);
              if (candidateEventId === eventId) markAttempted();
              return locked;
            },
          }),
        );
      },
    });
    let markCorrectionWaiting: () => void = () => undefined;
    const correctionWaiting = new Promise<void>((resolve) => {
      markCorrectionWaiting = resolve;
    });
    let markDuplicateRedactionWaiting: () => void = () => undefined;
    const duplicateRedactionWaiting = new Promise<void>((resolve) => {
      markDuplicateRedactionWaiting = resolve;
    });

    const correctionResultPromise = executeJournalCapability(
      'correct-journal-entry',
      textInput(
        eventId,
        'This stale correction must never become visible.',
        '2026-08-10T18:25:01.000Z',
        {
          entryId: original.id,
          entrySequence: original.sequence,
          kind: 'correction',
          reason: 'Synthetic correction racing a redaction.',
        },
      ),
      humanMutationInvocation(`issue77-racing-correct-${randomUUID()}`),
      lockAttemptStore(markCorrectionWaiting),
    ).then(
      (value) => value,
      (error: unknown) => error,
    );
    const duplicateRedactionResultPromise = executeJournalCapability(
      'redact-journal-entry',
      textInput(
        eventId,
        '[Content redacted; original retained in append-only history.]',
        '2026-08-10T18:25:02.000Z',
        {
          entryId: original.id,
          entrySequence: original.sequence,
          kind: 'redaction',
          reason: 'Synthetic redaction racing the winning redaction.',
        },
      ),
      humanMutationInvocation(`issue77-racing-redact-${randomUUID()}`),
      lockAttemptStore(markDuplicateRedactionWaiting),
    ).then(
      (value) => value,
      (error: unknown) => error,
    );

    await Promise.all([correctionWaiting, duplicateRedactionWaiting]);
    releaseWinningRedaction();

    const [winningRedaction, correctionResult, duplicateRedactionResult] =
      await Promise.all([
        winningRedactionPromise,
        correctionResultPromise,
        duplicateRedactionResultPromise,
      ]);
    expect(correctionResult).toMatchObject({
      code: 'CONFLICT',
      message:
        'A journal correction cannot target an entry that is already superseded.',
    });
    expect(duplicateRedactionResult).toMatchObject({
      code: 'CONFLICT',
      message: 'The journal entry already has an append-only redaction.',
    });

    const persisted = await databaseConnection()
      .db.select({ id: journalEntries.id, sequence: journalEntries.sequence })
      .from(journalEntries)
      .where(eq(journalEntries.eventId, eventId))
      .orderBy(asc(journalEntries.sequence));
    expect(persisted).toEqual([
      { id: original.id, sequence: 1 },
      { id: winningRedaction.id, sequence: 2 },
    ]);
  });

  test('agent-grantable list reads omit photo and location payloads redacted on a later page', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const mediaId = randomUUID();
    const uploadIntentId = randomUUID();
    const mediaCreatedAt = new Date();
    await databaseConnection()
      .db.insert(mediaUploadIntents)
      .values({
        id: uploadIntentId,
        eventId,
        facilityId: syntheticFixtureIds().northFacilityId,
        budgetPrincipalDigest: sha256(
          'synthetic journal projection fixture principal',
        ),
        budgetPrincipalAttributed: true,
        byteLength: 128,
        contentSha256: 'd'.repeat(64),
        declaredContentType: 'image/jpeg',
        storageKey: `synthetic/journal/${uploadIntentId}/upload`,
        status: 'completed',
        createdAt: mediaCreatedAt,
        expiresAt: new Date(mediaCreatedAt.getTime() + 5 * 60_000),
      });
    await databaseConnection()
      .db.insert(mediaRecords)
      .values({
        id: mediaId,
        uploadIntentId,
        eventId,
        status: 'ready',
        detectedContentType: 'image/jpeg',
        sanitizedByteLength: 120,
        sanitizedContentSha256: 'e'.repeat(64),
        storageKey: `synthetic/journal/${uploadIntentId}/sanitized`,
        malwareScan: 'clean',
        exifStripped: true,
        createdAt: mediaCreatedAt,
      });
    const photo = await executeJournalCapability(
      'append-journal-entry',
      {
        eventId,
        kind: 'photo',
        payload: {
          mediaId,
          altText: 'synthetic-list-redacted-photo-alt',
          caption: 'synthetic-list-redacted-photo-caption',
        },
        clientTime: null,
        supersedes: null,
      },
      humanMutationInvocation(`issue77-photo-${randomUUID()}`),
      journalStore,
    );
    const location = await executeJournalCapability(
      'append-journal-entry',
      {
        eventId,
        kind: 'location',
        payload: {
          state: 'known',
          latitude: 47.391,
          longitude: -122.591,
          accuracyMeters: 4,
          label: 'synthetic-list-redacted-location',
        },
        clientTime: null,
        supersedes: null,
      },
      humanMutationInvocation(`issue77-location-${randomUUID()}`),
      journalStore,
    );
    for (const target of [photo, location]) {
      await executeJournalCapability(
        'redact-journal-entry',
        textInput(
          eventId,
          '[Content redacted — original retained in journal]',
          null,
          {
            entryId: target.id,
            entrySequence: target.sequence,
            kind: 'redaction',
            reason: 'Synthetic list projection regression.',
          },
        ),
        humanMutationInvocation(`issue77-redact-${randomUUID()}`),
        journalStore,
      );
    }

    const firstPage = await listJournal(journalStore, eventId, null, 2);
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.items.map(({ visibility }) => visibility)).toEqual([
      'redacted',
      'redacted',
    ]);
    const outwardJson = JSON.stringify(firstPage.items);
    for (const forbidden of [
      mediaId,
      'synthetic-list-redacted-photo-alt',
      'synthetic-list-redacted-photo-caption',
      '47.391',
      '-122.591',
      'synthetic-list-redacted-location',
      'payload',
    ]) {
      expect(outwardJson).not.toContain(forbidden);
    }

    const persisted = await databaseConnection()
      .db.select({ payload: journalEntries.payload })
      .from(journalEntries)
      .where(inArray(journalEntries.id, [photo.id, location.id]));
    expect(JSON.stringify(persisted)).toContain(mediaId);
    expect(JSON.stringify(persisted)).toContain(
      'synthetic-list-redacted-location',
    );
  });

  test('records synthetic all-clear fan-out and close as distinct append-only lifecycle facts', async () => {
    const ids = syntheticFixtureIds();
    await databaseConnection().db.transaction(async (transaction) => {
      const transactionalDatabase = transaction as unknown as Database;
      const journalStore = createDrizzleJournalCapabilityStore(
        transactionalDatabase,
      );
      const eventStore = createDrizzleEventCapabilityStore(
        transactionalDatabase,
      );
      const integrationIds = ['expo-push', 'ses-email'] as const;
      const originalConfigurations = await transaction
        .select()
        .from(channelConfigurations)
        .where(inArray(channelConfigurations.integrationId, integrationIds));
      if (originalConfigurations.length !== integrationIds.length) {
        throw new Error(
          'The synthetic seed is missing mocked push/email configurations.',
        );
      }
      await transaction
        .update(channelConfigurations)
        .set({ enabled: true, changedAt: new Date() })
        .where(inArray(channelConfigurations.integrationId, integrationIds));

      try {
        const statusRows = await transaction
          .select()
          .from(integrationStatuses)
          .where(inArray(integrationStatuses.integrationId, integrationIds));
        const integrationStatusFor = (
          integrationId: (typeof integrationIds)[number],
        ) => {
          const row = statusRows.find(
            (candidate) => candidate.integrationId === integrationId,
          );
          if (row === undefined || row.label !== 'mocked') {
            throw new Error(
              `The ${integrationId} fixture is not a fail-closed mock.`,
            );
          }
          return IntegrationStatusSchema.parse({
            integrationId: row.integrationId,
            label: row.label,
            verifiedAt:
              row.verifiedAt === null ? null : row.verifiedAt.toISOString(),
            verifiedByUserId: row.verifiedByUserId,
            authorizationReference: row.authorizationReference,
            reasonCode: row.reasonCode,
            observedAt: row.observedAt.toISOString(),
          });
        };
        const [recipientRows, pushEndpointRows, emailEndpointRows] =
          await Promise.all([
            transaction
              .select({ id: rosterRecipients.id })
              .from(rosterRecipients)
              .where(
                eq(rosterRecipients.rosterSnapshotId, ids.rosterSnapshotId),
              ),
            transaction
              .select({ id: rosterEndpoints.id })
              .from(rosterEndpoints)
              .where(
                and(
                  eq(rosterEndpoints.rosterSnapshotId, ids.rosterSnapshotId),
                  eq(rosterEndpoints.channel, 'push'),
                ),
              ),
            transaction
              .select({ id: rosterEndpoints.id })
              .from(rosterEndpoints)
              .where(
                and(
                  eq(rosterEndpoints.rosterSnapshotId, ids.rosterSnapshotId),
                  eq(rosterEndpoints.channel, 'email'),
                ),
              ),
          ]);
        if (
          recipientRows.length === 0 ||
          pushEndpointRows.length === 0 ||
          emailEndpointRows.length === 0
        ) {
          throw new Error(
            'The synthetic roster is missing required mock endpoints.',
          );
        }

        const activationPreviewId = randomUUID();
        const activeEventRows = await transaction
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.facilityId, ids.northFacilityId),
              eq(events.status, 'active'),
            ),
          )
          .orderBy(asc(events.id));
        const activeEventIds = activeEventRows.map((event) => event.id);
        const sourceConsequenceDigest = digestCapabilityValue({
          fixture: 'issue-16-synthetic-activation',
          activationPreviewId,
        });
        const sourceCreatedAt = new Date(Date.now() - 1_000);
        const sourcePreview = ActivationPreviewSchema.parse({
          id: activationPreviewId,
          facilityId: ids.northFacilityId,
          kind: 'test',
          templateMode: 'drill',
          eventTypeVersion: {
            id: ids.eventTypeVersionId,
            templateMode: 'drill',
          },
          rosterSnapshotId: ids.rosterSnapshotId,
          rosterPopulation: 'synthetic',
          audienceConfig: {
            id: ids.audienceConfigId,
            version: ids.audienceConfigVersion,
          },
          recipientCount: recipientRows.length,
          channels: [
            {
              channel: 'push',
              endpointCount: pushEndpointRows.length,
              renderedMessage: {
                channel: 'push',
                eventKind: 'test',
                templateMode: 'drill',
                purpose: 'activation',
                classificationMarker: 'DRILL',
                title: '[DRILL] SYNTHETIC TEST ACTIVATION',
                body: '[DRILL] Synthetic test activation only.',
              },
              integrationStatus: integrationStatusFor('expo-push'),
            },
            {
              channel: 'email',
              endpointCount: emailEndpointRows.length,
              renderedMessage: {
                channel: 'email',
                eventKind: 'test',
                templateMode: 'drill',
                purpose: 'activation',
                classificationMarker: 'DRILL',
                subject: '[DRILL] SYNTHETIC TEST ACTIVATION',
                textBody: '[DRILL] Synthetic test activation only.',
              },
              integrationStatus: integrationStatusFor('ses-email'),
            },
          ],
          sendReadiness: 'ready',
          blockingReasonCodes: [],
          activeEventIds,
          consequenceDigest: sourceConsequenceDigest,
          createdAt: sourceCreatedAt.toISOString(),
          expiresAt: new Date(
            sourceCreatedAt.getTime() + 15 * 60_000,
          ).toISOString(),
        });
        await transaction.insert(activationPreviews).values({
          id: sourcePreview.id,
          facilityId: sourcePreview.facilityId,
          kind: sourcePreview.kind,
          templateMode: sourcePreview.templateMode,
          eventTypeVersionId: sourcePreview.eventTypeVersion.id,
          rosterSnapshotId: sourcePreview.rosterSnapshotId,
          rosterPopulation: sourcePreview.rosterPopulation,
          audienceConfigId: sourcePreview.audienceConfig.id,
          audienceConfigVersion: sourcePreview.audienceConfig.version,
          recipientCount: sourcePreview.recipientCount,
          channels: sourcePreview.channels,
          sendReadiness: sourcePreview.sendReadiness,
          blockingReasonCodes: sourcePreview.blockingReasonCodes,
          activeEventIds: sourcePreview.activeEventIds,
          consequenceDigest: sourcePreview.consequenceDigest,
          createdAt: sourceCreatedAt,
          expiresAt: new Date(sourcePreview.expiresAt),
        });

        const started = await executeEventCapability(
          'start-event',
          {
            source: 'activation-preview',
            activationPreviewId,
            activeEventDecision: {
              decision: 'start-new',
              activeEventIdsSeen: activeEventIds,
            },
          },
          humanMutationInvocation(`issue16-start-${randomUUID()}`),
          eventStore,
        );
        const eventId = started.event.id;
        expect(started.event).toMatchObject({
          status: 'active',
          kind: 'test',
          templateMode: 'drill',
          rosterPopulation: 'synthetic',
          activationAuthorization: { kind: 'synthetic-training' },
        });
        expect(started.notificationIntent).toMatchObject({
          purpose: 'activation',
          eventKind: 'test',
          templateMode: 'drill',
        });

        const previewIdempotencyKey = `issue77-preview-${randomUUID()}`;
        const previewInvocation = humanMutationInvocation(
          previewIdempotencyKey,
        );
        const lifecyclePreview = await executeJournalCapability(
          'create-lifecycle-consequence-preview',
          { eventId, purpose: 'all-clear' },
          previewInvocation,
          journalStore,
        );
        const previewReplayInvocation = humanMutationInvocation(
          previewIdempotencyKey,
        );
        const lifecyclePreviewReplay = await executeJournalCapability(
          'create-lifecycle-consequence-preview',
          { eventId, purpose: 'all-clear' },
          previewReplayInvocation,
          journalStore,
        );
        expect(lifecyclePreviewReplay).toEqual(lifecyclePreview);
        expect(previewReplayInvocation.requestId).not.toBe(
          previewInvocation.requestId,
        );

        const deniedReplayInvocation = humanMutationInvocation(
          previewIdempotencyKey,
          {
            facilityScope: {
              kind: 'facilities',
              facilityIds: [ids.southFacilityId],
            },
          },
        );
        await expect(
          executeJournalCapability(
            'create-lifecycle-consequence-preview',
            { eventId, purpose: 'all-clear' },
            deniedReplayInvocation,
            journalStore,
          ),
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
          reasonCode: 'CAPABILITY_SCOPE_DENIED',
        });

        const persistedPreviews = await transaction
          .select({ id: lifecycleConsequencePreviews.id })
          .from(lifecycleConsequencePreviews)
          .where(eq(lifecycleConsequencePreviews.eventId, eventId));
        expect(persistedPreviews).toEqual([{ id: lifecyclePreview.id }]);
        const previewAuditRows = await transaction
          .select({
            action: securityAuditEntries.action,
            outcome: securityAuditEntries.outcome,
            requestId: securityAuditEntries.requestId,
            reasonCode: securityAuditEntries.reasonCode,
          })
          .from(securityAuditEntries)
          .where(
            inArray(securityAuditEntries.requestId, [
              previewInvocation.requestId,
              previewReplayInvocation.requestId,
              deniedReplayInvocation.requestId,
            ]),
          );
        expect(previewAuditRows).toHaveLength(3);
        expect(
          previewAuditRows
            .filter((row) => row.outcome === 'success')
            .map((row) => row.requestId)
            .sort(),
        ).toEqual(
          [
            previewInvocation.requestId,
            previewReplayInvocation.requestId,
          ].sort(),
        );
        expect(
          previewAuditRows.find(
            (row) => row.requestId === deniedReplayInvocation.requestId,
          ),
        ).toMatchObject({
          action: 'create-lifecycle-consequence-preview',
          outcome: 'denied',
          reasonCode: 'CAPABILITY_SCOPE_DENIED',
        });
        expect(lifecyclePreview).toMatchObject({
          eventId,
          purpose: 'all-clear',
          kind: 'test',
          templateMode: 'drill',
          rosterPopulation: 'synthetic',
          sendReadiness: 'ready',
          blockingReasonCodes: [],
        });
        expect(
          lifecyclePreview.channels.map((channel) => ({
            channel: channel.channel,
            marker: channel.renderedMessage.classificationMarker,
            integration: channel.integrationStatus.label,
          })),
        ).toEqual([
          { channel: 'push', marker: 'DRILL', integration: 'mocked' },
          { channel: 'email', marker: 'DRILL', integration: 'mocked' },
        ]);

        const allClearInput = {
          eventId,
          lifecyclePreviewId: lifecyclePreview.id,
        };
        const allClearIdempotencyKey = `issue16-all-clear-${randomUUID()}`;
        const allClear = await executeEventCapability(
          'all-clear-event',
          allClearInput,
          humanMutationInvocation(allClearIdempotencyKey),
          eventStore,
        );
        expect(allClear.event.status).toBe('all-clear');
        expect(allClear.transition).toMatchObject({
          transition: 'all-clear',
          confirmationId: null,
          consequenceDigest: null,
        });
        expect(allClear.journalEntries.map(systemJournalCode)).toEqual([
          'all-clear-issued',
          'notification-intent-recorded',
        ]);
        expect(allClear.journalEntries[0]?.id).not.toBe(
          allClear.journalEntries[1]?.id,
        );
        const allClearIntent = allClear.notificationIntent;
        if (allClearIntent === null) {
          throw new Error(
            'Synthetic all-clear omitted its notification intent.',
          );
        }
        expect(allClearIntent).toMatchObject({
          eventId,
          eventKind: 'test',
          templateMode: 'drill',
          purpose: 'all-clear',
          rosterPopulation: 'synthetic',
          authorization: {
            kind: 'synthetic-lifecycle',
            purpose: 'all-clear',
          },
        });
        expect(
          allClearIntent.channels.every(
            (channel) =>
              channel.renderedMessage.classificationMarker === 'DRILL' &&
              channel.integrationStatus.label === 'mocked',
          ),
        ).toBe(true);
        const allClearReplay = await executeEventCapability(
          'all-clear-event',
          allClearInput,
          humanMutationInvocation(allClearIdempotencyKey),
          eventStore,
        );
        expect(allClearReplay).toEqual(allClear);

        const closeInput = { eventId };
        const closeIdempotencyKey = `issue16-close-${randomUUID()}`;
        const closed = await executeEventCapability(
          'close-event',
          closeInput,
          humanMutationInvocation(closeIdempotencyKey),
          eventStore,
        );
        const closeReplay = await executeEventCapability(
          'close-event',
          closeInput,
          humanMutationInvocation(closeIdempotencyKey),
          eventStore,
        );
        expect(closeReplay).toEqual(closed);
        expect(closed.event.status).toBe('closed');
        expect(closed.transition).toMatchObject({
          transition: 'close',
          confirmationId: null,
          consequenceDigest: null,
        });
        expect(closed.notificationIntent).toBeNull();
        expect(closed.journalEntries).toHaveLength(1);
        const closedJournalEntry = closed.journalEntries[0];
        expect(closedJournalEntry).toBeDefined();
        expect(systemJournalCode(closedJournalEntry!)).toBe('event-closed');
        expect(closed.journalEntries[0]?.id).not.toBe(
          allClear.journalEntries[0]?.id,
        );

        const retainedJournal = await executeJournalCapability(
          'list-journal-entries',
          { eventId, cursor: null, limit: 200 },
          humanQueryInvocation(),
          journalStore,
        );
        expect(
          retainedJournal.items.map(({ entry }) => entry.sequence),
        ).toEqual([1, 2, 3, 4, 5, 6]);
        expect(
          retainedJournal.items.map((projection) => {
            if (projection.visibility !== 'visible') {
              throw new Error('Lifecycle system facts cannot be redacted.');
            }
            return systemJournalCode(projection.entry);
          }),
        ).toEqual([
          'event-created',
          'event-activated',
          'notification-intent-recorded',
          'all-clear-issued',
          'notification-intent-recorded',
          'event-closed',
        ]);

        const persistedIntents = await transaction
          .select({
            id: notificationIntents.id,
            eventKind: notificationIntents.eventKind,
            templateMode: notificationIntents.templateMode,
            purpose: notificationIntents.purpose,
            rosterPopulation: notificationIntents.rosterPopulation,
          })
          .from(notificationIntents)
          .where(
            and(
              eq(notificationIntents.eventId, eventId),
              eq(notificationIntents.purpose, 'all-clear'),
            ),
          );
        expect(persistedIntents).toEqual([
          {
            id: allClearIntent.id,
            eventKind: 'test',
            templateMode: 'drill',
            purpose: 'all-clear',
            rosterPopulation: 'synthetic',
          },
        ]);
        const persistedChannels = await transaction
          .select({
            channel: notificationIntentChannels.channel,
            classificationMarker:
              notificationIntentChannels.classificationMarker,
            integrationLabel: notificationIntentChannels.integrationLabel,
          })
          .from(notificationIntentChannels)
          .where(eq(notificationIntentChannels.intentId, allClearIntent.id))
          .orderBy(asc(notificationIntentChannels.sequence));
        expect(persistedChannels).toEqual([
          {
            channel: 'push',
            classificationMarker: 'DRILL',
            integrationLabel: 'mocked',
          },
          {
            channel: 'email',
            classificationMarker: 'DRILL',
            integrationLabel: 'mocked',
          },
        ]);
        const persistedOutbox = await transaction
          .select({
            intentId: outbox.intentId,
            eventKind: outbox.eventKind,
            templateMode: outbox.templateMode,
            purpose: outbox.purpose,
            rosterPopulation: outbox.rosterPopulation,
            status: outbox.status,
            channels: outbox.channels,
          })
          .from(outbox)
          .where(
            and(eq(outbox.eventId, eventId), eq(outbox.purpose, 'all-clear')),
          );
        expect(persistedOutbox).toEqual([
          {
            intentId: allClearIntent.id,
            eventKind: 'test',
            templateMode: 'drill',
            purpose: 'all-clear',
            rosterPopulation: 'synthetic',
            status: 'pending',
            channels: allClearIntent.channels,
          },
        ]);
        const eventIntentPurposes = await transaction
          .select({ purpose: notificationIntents.purpose })
          .from(notificationIntents)
          .where(eq(notificationIntents.eventId, eventId));
        const eventOutboxPurposes = await transaction
          .select({ purpose: outbox.purpose })
          .from(outbox)
          .where(eq(outbox.eventId, eventId));
        expect(
          eventIntentPurposes.map(({ purpose }) => purpose).sort(),
        ).toEqual(['activation', 'all-clear']);
        expect(
          eventOutboxPurposes.map(({ purpose }) => purpose).sort(),
        ).toEqual(['activation', 'all-clear']);
      } finally {
        for (const configuration of originalConfigurations) {
          await transaction
            .update(channelConfigurations)
            .set({
              enabled: configuration.enabled,
              changedAt: configuration.changedAt,
            })
            .where(
              eq(
                channelConfigurations.integrationId,
                configuration.integrationId,
              ),
            );
        }
      }
    });
  });

  test('binds mobile real staff all-clear and close to exact fresh human confirmations', async () => {
    const ids = syntheticFixtureIds();
    const rollbackFixture = new Error(
      'Rollback the isolated real/staff confirmation fixture.',
    );
    try {
      await databaseConnection().db.transaction(async (transaction) => {
        const transactionalDatabase = transaction as unknown as Database;
        const journalStore = createDrizzleJournalCapabilityStore(
          transactionalDatabase,
        );
        const eventStore = createDrizzleEventCapabilityStore(
          transactionalDatabase,
        );
        const journalRuntime = createJournalCapabilityRuntime({
          driver: 'postgres',
          db: transaction as unknown as PostgresDatabaseConnection['db'],
          close: async () => {},
        });
        const suffix = randomUUID().replaceAll('-', '');
        const membershipSnapshotVersion =
          Number.parseInt(suffix.slice(0, 7), 16) + 1;
        const fixtureTime = new Date();
        const identityCreatedAt = new Date(fixtureTime.getTime() - 60_000);
        const membershipSnapshotId = randomUUID();
        const deviceEnrollmentId = randomUUID();
        const staffRosterSnapshotId = randomUUID();
        const staffRecipientId = randomUUID();
        const sourcePreviewId = randomUUID();
        const eventId = randomUUID();

        const [realEventTypeVersion] = await transaction
          .select({ id: eventTypeVersions.id })
          .from(eventTypeVersions)
          .where(eq(eventTypeVersions.templateMode, 'real'))
          .orderBy(asc(eventTypeVersions.id))
          .limit(1);
        if (realEventTypeVersion === undefined) {
          throw new Error('The seed is missing a real incident event type.');
        }

        const [latestStaffRosterSnapshot] = await transaction
          .select({
            version: rosterSnapshots.version,
            sourceConfigurationId: rosterSnapshots.sourceConfigurationId,
            sourceConfigurationVersion:
              rosterSnapshots.sourceConfigurationVersion,
          })
          .from(rosterSnapshots)
          .where(eq(rosterSnapshots.population, 'staff'))
          .orderBy(desc(rosterSnapshots.version))
          .limit(1);
        const [unpublishedStaffConfiguration] =
          latestStaffRosterSnapshot === undefined
            ? await transaction
                .select({
                  id: rosterSourceConfigurations.id,
                  version: rosterSourceConfigurations.version,
                })
                .from(rosterSourceConfigurations)
                .where(eq(rosterSourceConfigurations.population, 'staff'))
                .orderBy(
                  desc(rosterSourceConfigurations.version),
                  asc(rosterSourceConfigurations.id),
                )
                .limit(1)
            : [];
        const staffRosterConfigurationId =
          latestStaffRosterSnapshot?.sourceConfigurationId ??
          unpublishedStaffConfiguration?.id ??
          randomUUID();
        const staffRosterConfigurationVersion =
          latestStaffRosterSnapshot?.sourceConfigurationVersion ??
          unpublishedStaffConfiguration?.version ??
          1;
        const staffRosterSnapshotVersion =
          (latestStaffRosterSnapshot?.version ?? 0) + 1;

        await transaction.insert(users).values({
          id: HUMAN_ACTOR.userId,
          googleSubject: `synthetic-issue77-${suffix}`,
          email: `synthetic.issue77.${suffix}@psd401.net`,
          displayName: 'Synthetic Issue 77 Staff Operator',
          facilityScopeKind: 'district',
          createdAt: identityCreatedAt,
          disabledAt: null,
        });
        await transaction.insert(accessMembershipSnapshots).values({
          id: membershipSnapshotId,
          version: membershipSnapshotVersion,
          complete: true,
          syncStartedAt: identityCreatedAt,
          capturedAt: identityCreatedAt,
        });
        await transaction.insert(accessMembershipMembers).values({
          snapshotId: membershipSnapshotId,
          userId: HUMAN_ACTOR.userId,
          googleSubject: `synthetic-issue77-${suffix}`,
          facilityScopeKind: 'district',
        });
        await transaction.insert(deviceEnrollments).values({
          id: deviceEnrollmentId,
          userId: HUMAN_ACTOR.userId,
          platform: 'ios',
          unlockMethod: 'biometric',
          installationId: `synthetic-issue77-${suffix}`,
          enrolledAt: identityCreatedAt,
          lastSeenAt: fixtureTime,
          revokedAt: null,
        });
        const membershipValidUntil = new Date(
          fixtureTime.getTime() + 60 * 60_000,
        );
        const membershipGraceUntil = new Date(
          fixtureTime.getTime() + 2 * 60 * 60_000,
        );
        const sessionExpiresAt = new Date(
          fixtureTime.getTime() + 24 * 60 * 60_000,
        );
        await transaction.insert(sessions).values({
          id: HUMAN_ACTOR.sessionId,
          userId: HUMAN_ACTOR.userId,
          deviceEnrollmentId,
          membershipSnapshotId,
          membershipValidUntil,
          membershipGraceUntil,
          createdAt: identityCreatedAt,
          expiresAt: sessionExpiresAt,
          revokedAt: null,
        });
        await transaction.insert(connectivityEpochs).values({
          id: CONNECTIVITY_EPOCH_ID,
          sessionId: HUMAN_ACTOR.sessionId,
          establishedAt: fixtureTime,
        });

        const sessionResult = SessionEstablishmentResultSchema.parse({
          user: {
            id: HUMAN_ACTOR.userId,
            googleSubject: `synthetic-issue77-${suffix}`,
            email: `synthetic.issue77.${suffix}@psd401.net`,
            displayName: 'Synthetic Issue 77 Staff Operator',
            roles: ['staff'],
            facilityScope: { kind: 'district' },
            createdAt: identityCreatedAt.toISOString(),
            disabledAt: null,
          },
          session: {
            id: HUMAN_ACTOR.sessionId,
            userId: HUMAN_ACTOR.userId,
            deviceEnrollmentId,
            createdAt: identityCreatedAt.toISOString(),
            expiresAt: sessionExpiresAt.toISOString(),
            authorization: {
              kind: 'group-membership',
              source: 'google-group-snapshot',
              membershipSnapshotId,
              membershipValidUntil: membershipValidUntil.toISOString(),
              membershipGraceUntil: membershipGraceUntil.toISOString(),
            },
            revokedAt: null,
          },
          deviceEnrollment: {
            id: deviceEnrollmentId,
            userId: HUMAN_ACTOR.userId,
            platform: 'ios',
            unlockMethod: 'biometric',
            installationId: `synthetic-issue77-${suffix}`,
            enrolledAt: identityCreatedAt.toISOString(),
            lastSeenAt: fixtureTime.toISOString(),
            revokedAt: null,
          },
          connectivityEpoch: {
            id: CONNECTIVITY_EPOCH_ID,
            sessionId: HUMAN_ACTOR.sessionId,
            establishedAt: fixtureTime.toISOString(),
          },
        });
        const authenticated: AuthenticatedSession = Object.freeze({
          actor: HUMAN_ACTOR,
          source: 'mobile',
          roles: ['staff'] as const,
          scope: DISTRICT_SCOPE,
          membershipState: 'fresh',
          result: sessionResult,
        });
        const webEnrollmentSessionResult =
          SessionEstablishmentResultSchema.parse({
            ...sessionResult,
            deviceEnrollment: {
              ...sessionResult.deviceEnrollment,
              platform: 'web',
              unlockMethod: 'secure-session-cookie',
            },
          });
        const androidAuthenticated: AuthenticatedSession = Object.freeze({
          ...authenticated,
          result: SessionEstablishmentResultSchema.parse({
            ...sessionResult,
            deviceEnrollment: {
              ...sessionResult.deviceEnrollment,
              platform: 'android',
              unlockMethod: 'biometric',
            },
          }),
        });

        if (
          latestStaffRosterSnapshot === undefined &&
          unpublishedStaffConfiguration === undefined
        ) {
          await transaction.insert(rosterSourceConfigurations).values({
            id: staffRosterConfigurationId,
            version: staffRosterConfigurationVersion,
            population: 'staff',
            createdAt: identityCreatedAt,
          });
        }
        await transaction.insert(rosterSnapshots).values({
          id: staffRosterSnapshotId,
          version: staffRosterSnapshotVersion,
          population: 'staff',
          complete: true,
          sourceConfigurationId: staffRosterConfigurationId,
          sourceConfigurationVersion: staffRosterConfigurationVersion,
          syncStartedAt: identityCreatedAt,
          capturedAt: fixtureTime,
        });
        await transaction.insert(rosterSnapshotFacilities).values({
          rosterSnapshotId: staffRosterSnapshotId,
          facilityId: ids.northFacilityId,
        });
        await transaction.insert(rosterRecipients).values({
          id: staffRecipientId,
          rosterSnapshotId: staffRosterSnapshotId,
          population: 'staff',
          googleSubject: `synthetic-staff-target-${suffix}`,
          displayName: 'Synthetic Staff Notification Target',
        });
        await transaction.insert(rosterEndpoints).values([
          {
            id: randomUUID(),
            rosterSnapshotId: staffRosterSnapshotId,
            recipientId: staffRecipientId,
            population: 'staff',
            channel: 'push',
            status: 'active',
            capturedAt: fixtureTime,
            platform: 'ios',
            token: `synthetic-unroutable:issue77-${suffix}`,
            email: null,
            phoneNumber: null,
          },
          {
            id: randomUUID(),
            rosterSnapshotId: staffRosterSnapshotId,
            recipientId: staffRecipientId,
            population: 'staff',
            channel: 'email',
            status: 'active',
            capturedAt: fixtureTime,
            platform: null,
            token: null,
            email: `issue77-${suffix}@example.invalid`,
            phoneNumber: null,
          },
        ]);

        const integrationIds = ['expo-push', 'ses-email'] as const;
        const originalConfigurations = await transaction
          .select()
          .from(channelConfigurations)
          .where(inArray(channelConfigurations.integrationId, integrationIds));
        if (originalConfigurations.length !== integrationIds.length) {
          throw new Error(
            'The synthetic seed is missing push/email channel configurations.',
          );
        }
        const verifiedAt = new Date(fixtureTime.getTime() - 5_000);
        const observedAt = new Date(fixtureTime.getTime() - 4_000);
        const liveStatuses = integrationIds.map((integrationId) => ({
          id: randomUUID(),
          value: IntegrationStatusSchema.parse({
            integrationId,
            label: 'live-verified',
            verifiedAt: verifiedAt.toISOString(),
            verifiedByUserId: HUMAN_ACTOR.userId,
            authorizationReference: 'synthetic-issue77-test-authorization',
            reasonCode: null,
            observedAt: observedAt.toISOString(),
          }),
        }));
        await transaction.insert(integrationStatuses).values(
          liveStatuses.map(({ id, value }) => ({
            id,
            integrationId: value.integrationId,
            label: value.label,
            verifiedAt,
            verifiedByUserId: value.verifiedByUserId,
            authorizationReference: value.authorizationReference,
            reasonCode: value.reasonCode,
            observedAt,
          })),
        );
        for (const status of liveStatuses) {
          await transaction
            .update(channelConfigurations)
            .set({
              enabled: true,
              statusId: status.id,
              statusLabel: status.value.label,
              changedAt: fixtureTime,
            })
            .where(
              eq(
                channelConfigurations.integrationId,
                status.value.integrationId,
              ),
            );
        }

        try {
          const sourceCreatedAt = new Date(fixtureTime.getTime() - 3_000);
          const activatedAt = new Date(fixtureTime.getTime() - 2_000);
          const sourceConsequenceDigest = digestCapabilityValue({
            fixture: 'issue-77-real-staff-activation',
            sourcePreviewId,
          });
          const statusFor = (
            integrationId: (typeof integrationIds)[number],
          ) => {
            const status = liveStatuses.find(
              (candidate) => candidate.value.integrationId === integrationId,
            );
            if (status === undefined) {
              throw new Error(
                `The ${integrationId} status fixture is missing.`,
              );
            }
            return status.value;
          };
          const sourcePreview = ActivationPreviewSchema.parse({
            id: sourcePreviewId,
            facilityId: ids.northFacilityId,
            kind: 'incident',
            templateMode: 'real',
            eventTypeVersion: {
              id: realEventTypeVersion.id,
              templateMode: 'real',
            },
            rosterSnapshotId: staffRosterSnapshotId,
            rosterPopulation: 'staff',
            audienceConfig: {
              id: ids.audienceConfigId,
              version: ids.audienceConfigVersion,
            },
            recipientCount: 1,
            channels: [
              {
                channel: 'push',
                endpointCount: 1,
                renderedMessage: {
                  channel: 'push',
                  eventKind: 'incident',
                  templateMode: 'real',
                  purpose: 'activation',
                  classificationMarker: 'INCIDENT',
                  title: '[INCIDENT] REAL INCIDENT ACTIVATION: Synthetic test',
                  body: '[INCIDENT] REAL INCIDENT — NOT A DRILL. Synthetic database proof only.',
                },
                integrationStatus: statusFor('expo-push'),
              },
              {
                channel: 'email',
                endpointCount: 1,
                renderedMessage: {
                  channel: 'email',
                  eventKind: 'incident',
                  templateMode: 'real',
                  purpose: 'activation',
                  classificationMarker: 'INCIDENT',
                  subject:
                    '[INCIDENT] REAL INCIDENT ACTIVATION: Synthetic test',
                  textBody:
                    '[INCIDENT] REAL INCIDENT — NOT A DRILL. Synthetic database proof only.',
                },
                integrationStatus: statusFor('ses-email'),
              },
            ],
            sendReadiness: 'ready',
            blockingReasonCodes: [],
            activeEventIds: [],
            consequenceDigest: sourceConsequenceDigest,
            createdAt: sourceCreatedAt.toISOString(),
            expiresAt: new Date(
              sourceCreatedAt.getTime() + 15 * 60_000,
            ).toISOString(),
          });
          await transaction.insert(activationPreviews).values({
            id: sourcePreview.id,
            facilityId: sourcePreview.facilityId,
            kind: sourcePreview.kind,
            templateMode: sourcePreview.templateMode,
            eventTypeVersionId: sourcePreview.eventTypeVersion.id,
            rosterSnapshotId: sourcePreview.rosterSnapshotId,
            rosterPopulation: sourcePreview.rosterPopulation,
            audienceConfigId: sourcePreview.audienceConfig.id,
            audienceConfigVersion: sourcePreview.audienceConfig.version,
            recipientCount: sourcePreview.recipientCount,
            channels: sourcePreview.channels,
            sendReadiness: sourcePreview.sendReadiness,
            blockingReasonCodes: sourcePreview.blockingReasonCodes,
            activeEventIds: sourcePreview.activeEventIds,
            consequenceDigest: sourcePreview.consequenceDigest,
            createdAt: sourceCreatedAt,
            expiresAt: new Date(sourcePreview.expiresAt),
          });
          const activationRequestId = randomUUID();
          const activationConfirmationId = randomUUID();
          const activationAuthorization = {
            kind: 'human-confirmed' as const,
            activationPreviewId: sourcePreview.id,
            preparedActivationId: null,
            confirmationId: activationConfirmationId,
            consequenceDigest: sourcePreview.consequenceDigest,
            requestId: activationRequestId,
          };
          const activationTransition = EventTransitionSchema.parse({
            id: randomUUID(),
            sequence: 1,
            transition: 'activate',
            eventId,
            from: 'draft',
            to: 'active',
            actor: HUMAN_ACTOR,
            source: 'web',
            occurredAt: activatedAt.toISOString(),
            requestId: activationRequestId,
            confirmationId: activationConfirmationId,
            consequenceDigest: sourcePreview.consequenceDigest,
            targeting: {
              kind: 'incident',
              templateMode: 'real',
              rosterPopulation: 'staff',
            },
            idempotencyKey: `issue77-real-activation-${suffix}`,
            activationAuthorization,
          });
          if (activationTransition.transition !== 'activate') {
            throw new Error('The fixture transition was not activation.');
          }
          await transaction.insert(humanConfirmationRecords).values({
            id: activationConfirmationId,
            capabilityId: 'start-event',
            connectivityEpochId: CONNECTIVITY_EPOCH_ID,
            confirmedByUserId: HUMAN_ACTOR.userId,
            confirmedWithSessionId: HUMAN_ACTOR.sessionId,
            consequenceDigest: sourcePreview.consequenceDigest,
            issuedAt: sourceCreatedAt,
            expiresAt: new Date(sourceCreatedAt.getTime() + 5 * 60_000),
            status: 'consumed',
            consumedAt: activatedAt,
            consumedForRequestId: activationRequestId,
            expiredAt: null,
          });
          await transaction.insert(humanConfirmationActions).values([
            {
              confirmationId: activationConfirmationId,
              actionId: 'start-real-incident',
            },
            {
              confirmationId: activationConfirmationId,
              actionId: 'send-real-notification',
            },
          ]);
          await transaction.insert(events).values({
            id: eventId,
            facilityId: ids.northFacilityId,
            kind: 'incident',
            templateMode: 'real',
            eventTypeVersionId: realEventTypeVersion.id,
            status: 'active',
            rosterSnapshotId: staffRosterSnapshotId,
            rosterPopulation: 'staff',
            createdBy: HUMAN_ACTOR,
            createdAt: sourceCreatedAt,
            activatedAt,
            allClearAt: null,
            reactivatedAt: null,
            closedAt: null,
            correctionOfEventId: null,
            correctionReason: null,
            activationAuthorization,
          });
          await transaction.insert(eventTransitions).values({
            id: activationTransition.id,
            sequence: activationTransition.sequence,
            transition: activationTransition.transition,
            eventId: activationTransition.eventId,
            sourceEventId: null,
            correctionEventId: null,
            journalEventId: activationTransition.eventId,
            fromStatus: activationTransition.from,
            toStatus: activationTransition.to,
            kind: activationTransition.targeting.kind,
            templateMode: activationTransition.targeting.templateMode,
            rosterPopulation: activationTransition.targeting.rosterPopulation,
            actor: activationTransition.actor,
            source: activationTransition.source,
            occurredAt: activatedAt,
            requestId: activationTransition.requestId,
            confirmationId: activationTransition.confirmationId,
            confirmationStatus: 'consumed',
            consequenceDigest: activationTransition.consequenceDigest,
            idempotencyKey: activationTransition.idempotencyKey,
            activationAuthorization:
              activationTransition.activationAuthorization,
            notificationAuthorization: null,
            correctionReason: null,
          });
          await transaction.insert(journalEntries).values({
            id: randomUUID(),
            eventId,
            sequence: 1,
            kind: 'system',
            author: HUMAN_ACTOR,
            source: 'web',
            serverTime: activatedAt,
            clientTime: null,
            payload: {
              code: 'event-activated',
              summary: 'Synthetic real/staff fixture activation recorded.',
              transition: activationTransition,
            },
            mediaId: null,
            transitionId: activationTransition.id,
            supersedesEntryId: null,
            supersedesEntrySequence: null,
            supersessionKind: null,
            supersessionReason: null,
          });

          const firstPreview = await executeJournalCapability(
            'create-lifecycle-consequence-preview',
            { eventId, purpose: 'all-clear' },
            humanMutationInvocation(
              `issue77-real-preview-a-${suffix}`,
              DISTRICT_SCOPE,
              'mobile',
            ),
            journalStore,
          );
          const secondPreview = await executeJournalCapability(
            'create-lifecycle-consequence-preview',
            { eventId, purpose: 'all-clear' },
            humanMutationInvocation(
              `issue77-real-preview-b-${suffix}`,
              DISTRICT_SCOPE,
              'mobile',
            ),
            journalStore,
          );
          expect(firstPreview).toMatchObject({
            eventId,
            purpose: 'all-clear',
            kind: 'incident',
            templateMode: 'real',
            rosterPopulation: 'staff',
            sendReadiness: 'ready',
            blockingReasonCodes: [],
          });
          expect(
            firstPreview.channels.map((channel) => ({
              marker: channel.renderedMessage.classificationMarker,
              integration: channel.integrationStatus.label,
            })),
          ).toEqual([
            { marker: 'INCIDENT', integration: 'live-verified' },
            { marker: 'INCIDENT', integration: 'live-verified' },
          ]);
          expect(secondPreview.consequenceDigest).not.toBe(
            firstPreview.consequenceDigest,
          );

          // Android biometric enrollment crosses the same trusted mobile
          // identity boundary as iOS; the deliberately wrong phrase then
          // fails at validation rather than at the human-only source check.
          await expect(
            journalRuntime.issueHumanConfirmation({
              authenticated: androidAuthenticated,
              eventId,
              action: 'all-clear',
              lifecyclePreviewId: firstPreview.id,
              confirmationPhrase: 'NOT THE CONFIRMATION PHRASE',
              requestId: randomUUID(),
              now: new Date(),
            }),
          ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            reasonCode: 'PERSISTENCE_CONFLICT',
            status: 400,
          });

          const mismatchedAuthenticatedSessions = [
            {
              name: 'web source with native enrollment',
              value: Object.freeze({
                ...authenticated,
                source: 'web' as const,
              }),
            },
            {
              name: 'mobile source with web enrollment',
              value: Object.freeze({
                ...authenticated,
                result: webEnrollmentSessionResult,
              }),
            },
          ] as const;
          for (const mismatch of mismatchedAuthenticatedSessions) {
            await expect(
              journalRuntime.issueHumanConfirmation({
                authenticated: mismatch.value,
                eventId,
                action: 'all-clear',
                lifecyclePreviewId: firstPreview.id,
                confirmationPhrase: EVENT_CONFIRMATION_PHRASES['all-clear'],
                requestId: randomUUID(),
                now: new Date(),
              }),
              mismatch.name,
            ).rejects.toMatchObject({
              code: 'FORBIDDEN',
              reasonCode: 'HUMAN_ONLY_REQUIRED',
              status: 403,
            });
          }

          expect(EVENT_CONFIRMATION_PHRASES['all-clear']).toBe('ALL CLEAR');
          await expect(
            journalRuntime.issueHumanConfirmation({
              authenticated,
              eventId,
              action: 'all-clear',
              lifecyclePreviewId: firstPreview.id,
              confirmationPhrase: 'ALL CLEAR ',
              requestId: randomUUID(),
              now: new Date(),
            }),
          ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            status: 400,
          });
          const rejectedPhraseRows = await transaction
            .select({ id: humanConfirmationRecords.id })
            .from(humanConfirmationRecords)
            .where(
              and(
                eq(
                  humanConfirmationRecords.confirmedByUserId,
                  HUMAN_ACTOR.userId,
                ),
                eq(humanConfirmationRecords.capabilityId, 'all-clear-event'),
              ),
            );
          expect(rejectedPhraseRows).toEqual([]);

          const actionRequestId = randomUUID();
          const issued = await journalRuntime.issueHumanConfirmation({
            authenticated,
            eventId,
            action: 'all-clear',
            lifecyclePreviewId: firstPreview.id,
            confirmationPhrase: EVENT_CONFIRMATION_PHRASES['all-clear'],
            requestId: actionRequestId,
            now: new Date(),
          });
          if (issued.confirmationId === null) {
            throw new Error('The real staff all-clear omitted confirmation.');
          }
          const confirmationId = issued.confirmationId;
          const [confirmationBeforeUse] = await transaction
            .select()
            .from(humanConfirmationRecords)
            .where(eq(humanConfirmationRecords.id, confirmationId))
            .limit(1);
          if (confirmationBeforeUse === undefined) {
            throw new Error('The issued confirmation was not persisted.');
          }
          const confirmationActionRows = await transaction
            .select({ actionId: humanConfirmationActions.actionId })
            .from(humanConfirmationActions)
            .where(eq(humanConfirmationActions.confirmationId, confirmationId));
          expect(confirmationBeforeUse).toMatchObject({
            capabilityId: 'all-clear-event',
            connectivityEpochId: CONNECTIVITY_EPOCH_ID,
            confirmedByUserId: HUMAN_ACTOR.userId,
            confirmedWithSessionId: HUMAN_ACTOR.sessionId,
            consequenceDigest: firstPreview.consequenceDigest,
            status: 'issued',
            consumedAt: null,
            consumedForRequestId: null,
            expiredAt: null,
          });
          expect(
            confirmationActionRows.map(({ actionId }) => actionId).sort(),
          ).toEqual(['all-clear', 'send-real-notification']);
          expect(
            confirmationBeforeUse.expiresAt.getTime() -
              confirmationBeforeUse.issuedAt.getTime(),
          ).toBeLessThanOrEqual(HUMAN_CONFIRMATION_MAX_AGE_SECONDS * 1_000);
          expect(confirmationBeforeUse.expiresAt.getTime()).toBeLessThanOrEqual(
            Date.parse(firstPreview.expiresAt),
          );
          expect(confirmationBeforeUse.expiresAt.getTime()).toBeGreaterThan(
            confirmationBeforeUse.issuedAt.getTime(),
          );

          const bindingCases = [
            {
              name: 'user',
              lifecyclePreviewId: firstPreview.id,
              invocation: confirmedHumanMutationInvocation({
                idempotencyKey: `issue77-real-wrong-user-${suffix}`,
                confirmationId,
                source: 'mobile',
                actor: {
                  kind: 'human',
                  userId: randomUUID(),
                  sessionId: HUMAN_ACTOR.sessionId,
                },
              }),
            },
            {
              name: 'session',
              lifecyclePreviewId: firstPreview.id,
              invocation: confirmedHumanMutationInvocation({
                idempotencyKey: `issue77-real-wrong-session-${suffix}`,
                confirmationId,
                source: 'mobile',
                actor: {
                  kind: 'human',
                  userId: HUMAN_ACTOR.userId,
                  sessionId: randomUUID(),
                },
              }),
            },
            {
              name: 'connectivity epoch',
              lifecyclePreviewId: firstPreview.id,
              invocation: confirmedHumanMutationInvocation({
                idempotencyKey: `issue77-real-wrong-epoch-${suffix}`,
                confirmationId,
                source: 'mobile',
                connectivityEpochId: randomUUID(),
              }),
            },
            {
              name: 'consequence digest',
              lifecyclePreviewId: secondPreview.id,
              invocation: confirmedHumanMutationInvocation({
                idempotencyKey: `issue77-real-wrong-digest-${suffix}`,
                confirmationId,
                source: 'mobile',
              }),
            },
          ] as const;
          for (const bindingCase of bindingCases) {
            await expect(
              executeEventCapability(
                'all-clear-event',
                {
                  eventId,
                  lifecyclePreviewId: bindingCase.lifecyclePreviewId,
                },
                bindingCase.invocation,
                eventStore,
              ),
              bindingCase.name,
            ).rejects.toMatchObject({
              code: 'FORBIDDEN',
              reasonCode: 'CONFIRMATION_INVALID',
              status: 403,
            });
          }
          const [confirmationAfterBindingFailures] = await transaction
            .select({ status: humanConfirmationRecords.status })
            .from(humanConfirmationRecords)
            .where(eq(humanConfirmationRecords.id, confirmationId))
            .limit(1);
          expect(confirmationAfterBindingFailures?.status).toBe('issued');

          const expiredConfirmationId = randomUUID();
          const expiredIssuedAt = new Date(fixtureTime.getTime() - 6 * 60_000);
          const expiredAt = new Date(fixtureTime.getTime() - 60_000);
          await transaction.insert(humanConfirmationRecords).values({
            id: expiredConfirmationId,
            capabilityId: 'all-clear-event',
            connectivityEpochId: CONNECTIVITY_EPOCH_ID,
            confirmedByUserId: HUMAN_ACTOR.userId,
            confirmedWithSessionId: HUMAN_ACTOR.sessionId,
            consequenceDigest: firstPreview.consequenceDigest,
            issuedAt: expiredIssuedAt,
            expiresAt: expiredAt,
            status: 'issued',
            consumedAt: null,
            consumedForRequestId: null,
            expiredAt: null,
          });
          await transaction.insert(humanConfirmationActions).values([
            { confirmationId: expiredConfirmationId, actionId: 'all-clear' },
            {
              confirmationId: expiredConfirmationId,
              actionId: 'send-real-notification',
            },
          ]);
          await expect(
            executeEventCapability(
              'all-clear-event',
              { eventId, lifecyclePreviewId: firstPreview.id },
              confirmedHumanMutationInvocation({
                idempotencyKey: `issue77-real-expired-${suffix}`,
                confirmationId: expiredConfirmationId,
                source: 'mobile',
              }),
              eventStore,
            ),
          ).rejects.toMatchObject({
            code: 'FORBIDDEN',
            reasonCode: 'CONFIRMATION_INVALID',
            status: 403,
          });

          const pushStatus = liveStatuses.find(
            (status) => status.value.integrationId === 'expo-push',
          );
          if (pushStatus === undefined) {
            throw new Error('The live push fixture is unavailable.');
          }
          const newerPushStatusId = randomUUID();
          const newerObservedAt = new Date(fixtureTime.getTime() - 1_000);
          await transaction.insert(integrationStatuses).values({
            id: newerPushStatusId,
            integrationId: 'expo-push',
            label: 'live-verified',
            verifiedAt,
            verifiedByUserId: HUMAN_ACTOR.userId,
            authorizationReference:
              'synthetic-issue77-newer-test-authorization',
            reasonCode: null,
            observedAt: newerObservedAt,
          });
          await transaction
            .update(channelConfigurations)
            .set({
              enabled: true,
              statusId: newerPushStatusId,
              statusLabel: 'live-verified',
              changedAt: newerObservedAt,
            })
            .where(eq(channelConfigurations.integrationId, 'expo-push'));
          await expect(
            executeEventCapability(
              'all-clear-event',
              { eventId, lifecyclePreviewId: firstPreview.id },
              confirmedHumanMutationInvocation({
                idempotencyKey: `issue77-real-stale-integration-${suffix}`,
                confirmationId,
                source: 'mobile',
              }),
              eventStore,
            ),
          ).rejects.toMatchObject({
            code: 'CONFLICT',
            reasonCode: 'PERSISTENCE_CONFLICT',
            status: 409,
          });
          const [confirmationAfterStaleIntegration] = await transaction
            .select({ status: humanConfirmationRecords.status })
            .from(humanConfirmationRecords)
            .where(eq(humanConfirmationRecords.id, confirmationId))
            .limit(1);
          expect(confirmationAfterStaleIntegration?.status).toBe('issued');
          await transaction
            .update(channelConfigurations)
            .set({
              enabled: true,
              statusId: pushStatus.id,
              statusLabel: pushStatus.value.label,
              changedAt: fixtureTime,
            })
            .where(eq(channelConfigurations.integrationId, 'expo-push'));

          const allClearIdempotencyKey = `issue77-real-all-clear-${suffix}`;
          const allClear = await executeEventCapability(
            'all-clear-event',
            { eventId, lifecyclePreviewId: firstPreview.id },
            confirmedHumanMutationInvocation({
              idempotencyKey: allClearIdempotencyKey,
              confirmationId,
              requestId: actionRequestId,
              source: 'mobile',
            }),
            eventStore,
          );
          expect(allClear.event).toMatchObject({
            id: eventId,
            status: 'all-clear',
            kind: 'incident',
            templateMode: 'real',
            rosterPopulation: 'staff',
          });
          expect(allClear.transition).toMatchObject({
            transition: 'all-clear',
            source: 'mobile',
            confirmationId,
            consequenceDigest: firstPreview.consequenceDigest,
            requestId: actionRequestId,
          });
          if (allClear.transition.transition !== 'all-clear') {
            throw new Error('The real staff transition was not all-clear.');
          }
          expect(allClear.transition.notificationAuthorization).toMatchObject({
            kind: 'human-confirmed-lifecycle',
            purpose: 'all-clear',
            actionIds: ['all-clear', 'send-real-notification'],
            confirmationId,
            consequenceDigest: firstPreview.consequenceDigest,
            requestId: actionRequestId,
          });
          const allClearIntent = allClear.notificationIntent;
          if (allClearIntent === null) {
            throw new Error('The real staff all-clear omitted its intent.');
          }
          expect(allClearIntent).toMatchObject({
            eventId,
            eventKind: 'incident',
            templateMode: 'real',
            purpose: 'all-clear',
            rosterPopulation: 'staff',
            authorization: {
              kind: 'human-confirmed-lifecycle',
              confirmationId,
              consequenceDigest: firstPreview.consequenceDigest,
            },
          });
          expect(
            allClearIntent.channels.every(
              (channel) =>
                channel.renderedMessage.classificationMarker === 'INCIDENT' &&
                channel.integrationStatus.label === 'live-verified',
            ),
          ).toBe(true);
          expect(allClear.journalEntries.map(systemJournalCode)).toContain(
            'all-clear-issued',
          );
          expect(
            allClear.journalEntries.every((entry) => entry.source === 'mobile'),
          ).toBe(true);

          const replay = await executeEventCapability(
            'all-clear-event',
            { eventId, lifecyclePreviewId: firstPreview.id },
            humanMutationInvocation(
              allClearIdempotencyKey,
              DISTRICT_SCOPE,
              'mobile',
            ),
            eventStore,
          );
          expect(replay).toEqual(allClear);

          const [consumedConfirmation] = await transaction
            .select()
            .from(humanConfirmationRecords)
            .where(eq(humanConfirmationRecords.id, confirmationId))
            .limit(1);
          expect(consumedConfirmation).toMatchObject({
            status: 'consumed',
            consumedForRequestId: actionRequestId,
            expiredAt: null,
          });
          expect(consumedConfirmation?.consumedAt).not.toBeNull();
          const persistedTransitions = await transaction
            .select({
              confirmationId: eventTransitions.confirmationId,
              confirmationStatus: eventTransitions.confirmationStatus,
              consequenceDigest: eventTransitions.consequenceDigest,
              requestId: eventTransitions.requestId,
            })
            .from(eventTransitions)
            .where(
              and(
                eq(eventTransitions.eventId, eventId),
                eq(eventTransitions.transition, 'all-clear'),
              ),
            );
          expect(persistedTransitions).toEqual([
            {
              confirmationId,
              confirmationStatus: 'consumed',
              consequenceDigest: firstPreview.consequenceDigest,
              requestId: actionRequestId,
            },
          ]);
          const persistedIntents = await transaction
            .select({ id: notificationIntents.id })
            .from(notificationIntents)
            .where(eq(notificationIntents.eventId, eventId));
          expect(persistedIntents).toHaveLength(1);
          const persistedOutbox = await transaction
            .select({
              id: outbox.id,
              intentId: outbox.intentId,
              status: outbox.status,
              attempts: outbox.attempts,
              lockedUntil: outbox.lockedUntil,
              publishedAt: outbox.publishedAt,
              failedAt: outbox.failedAt,
            })
            .from(outbox)
            .where(eq(outbox.eventId, eventId));
          expect(persistedOutbox).toEqual([
            {
              id: expect.any(String),
              intentId: allClearIntent.id,
              status: 'pending',
              attempts: 0,
              lockedUntil: null,
              publishedAt: null,
              failedAt: null,
            },
          ]);
          expect(
            await transaction
              .select({ id: dispatchBatches.id })
              .from(dispatchBatches)
              .where(eq(dispatchBatches.eventId, eventId)),
          ).toEqual([]);
          expect(
            await transaction
              .select({ id: channelAttempts.id })
              .from(channelAttempts)
              .where(eq(channelAttempts.eventId, eventId)),
          ).toEqual([]);
          expect(
            await transaction
              .select({ id: deliveryEvidence.id })
              .from(deliveryEvidence)
              .where(eq(deliveryEvidence.intentId, allClearIntent.id)),
          ).toEqual([]);

          expect(EVENT_CONFIRMATION_PHRASES.close).toBe('CLOSE EVENT');
          const closeRequestId = randomUUID();
          const issuedClose = await journalRuntime.issueHumanConfirmation({
            authenticated,
            eventId,
            action: 'close',
            lifecyclePreviewId: null,
            confirmationPhrase: EVENT_CONFIRMATION_PHRASES.close,
            requestId: closeRequestId,
            now: new Date(),
          });
          if (issuedClose.confirmationId === null) {
            throw new Error(
              'The mobile real-event close omitted confirmation.',
            );
          }
          const closeConfirmationId = issuedClose.confirmationId;
          const [closeConfirmationBeforeUse] = await transaction
            .select()
            .from(humanConfirmationRecords)
            .where(eq(humanConfirmationRecords.id, closeConfirmationId))
            .limit(1);
          if (closeConfirmationBeforeUse === undefined) {
            throw new Error('The mobile close confirmation was not persisted.');
          }
          const closeConfirmationActions = await transaction
            .select({ actionId: humanConfirmationActions.actionId })
            .from(humanConfirmationActions)
            .where(
              eq(humanConfirmationActions.confirmationId, closeConfirmationId),
            );
          expect(closeConfirmationBeforeUse).toMatchObject({
            capabilityId: 'close-event',
            connectivityEpochId: CONNECTIVITY_EPOCH_ID,
            confirmedByUserId: HUMAN_ACTOR.userId,
            confirmedWithSessionId: HUMAN_ACTOR.sessionId,
            status: 'issued',
            consumedAt: null,
            consumedForRequestId: null,
            expiredAt: null,
          });
          expect(
            closeConfirmationActions.map(({ actionId }) => actionId),
          ).toEqual(['close-real-event']);

          const closeIdempotencyKey = `issue77-real-close-${suffix}`;
          const closed = await executeEventCapability(
            'close-event',
            { eventId },
            confirmedHumanMutationInvocation({
              idempotencyKey: closeIdempotencyKey,
              confirmationId: closeConfirmationId,
              requestId: closeRequestId,
              source: 'mobile',
            }),
            eventStore,
          );
          expect(closed.event).toMatchObject({
            id: eventId,
            status: 'closed',
            kind: 'incident',
            templateMode: 'real',
            rosterPopulation: 'staff',
          });
          expect(closed.transition).toMatchObject({
            transition: 'close',
            source: 'mobile',
            confirmationId: closeConfirmationId,
            consequenceDigest: closeConfirmationBeforeUse.consequenceDigest,
            requestId: closeRequestId,
          });
          expect(closed.notificationIntent).toBeNull();
          expect(closed.journalEntries).toHaveLength(1);
          expect(closed.journalEntries[0]).toMatchObject({
            source: 'mobile',
            payload: { code: 'event-closed' },
          });

          const closeReplay = await executeEventCapability(
            'close-event',
            { eventId },
            humanMutationInvocation(
              closeIdempotencyKey,
              DISTRICT_SCOPE,
              'mobile',
            ),
            eventStore,
          );
          expect(closeReplay).toEqual(closed);

          const [consumedCloseConfirmation] = await transaction
            .select()
            .from(humanConfirmationRecords)
            .where(eq(humanConfirmationRecords.id, closeConfirmationId))
            .limit(1);
          expect(consumedCloseConfirmation).toMatchObject({
            status: 'consumed',
            consumedForRequestId: closeRequestId,
            expiredAt: null,
          });
          expect(consumedCloseConfirmation?.consumedAt).not.toBeNull();
          expect(
            await transaction
              .select({
                confirmationId: eventTransitions.confirmationId,
                confirmationStatus: eventTransitions.confirmationStatus,
                source: eventTransitions.source,
                requestId: eventTransitions.requestId,
              })
              .from(eventTransitions)
              .where(
                and(
                  eq(eventTransitions.eventId, eventId),
                  eq(eventTransitions.transition, 'close'),
                ),
              ),
          ).toEqual([
            {
              confirmationId: closeConfirmationId,
              confirmationStatus: 'consumed',
              source: 'mobile',
              requestId: closeRequestId,
            },
          ]);
          expect(
            await transaction
              .select({
                id: notificationIntents.id,
                purpose: notificationIntents.purpose,
              })
              .from(notificationIntents)
              .where(eq(notificationIntents.eventId, eventId)),
          ).toEqual([{ id: allClearIntent.id, purpose: 'all-clear' }]);
          expect(
            await transaction
              .select({ intentId: outbox.intentId, purpose: outbox.purpose })
              .from(outbox)
              .where(eq(outbox.eventId, eventId)),
          ).toEqual([{ intentId: allClearIntent.id, purpose: 'all-clear' }]);
        } finally {
          for (const configuration of originalConfigurations) {
            await transaction
              .update(channelConfigurations)
              .set({
                enabled: configuration.enabled,
                statusId: configuration.statusId,
                statusLabel: configuration.statusLabel,
                changedAt: configuration.changedAt,
              })
              .where(
                eq(
                  channelConfigurations.integrationId,
                  configuration.integrationId,
                ),
              );
          }
        }
        throw rollbackFixture;
      });
    } catch (error) {
      if (error !== rollbackFixture) {
        throw error;
      }
    }
  });

  test('denies journal writes outside the authenticated facility scope', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const { southFacilityId } = syntheticFixtureIds();

    await expect(
      executeJournalCapability(
        'append-journal-entry',
        textInput(eventId, 'This must not be persisted.', null),
        humanMutationInvocation(`issue16-scope-${randomUUID()}`, {
          facilityScope: {
            kind: 'facilities',
            facilityIds: [southFacilityId],
          },
        }),
        journalStore,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
    });

    const authorizedView = await listJournal(journalStore, eventId, null, 200);
    expect(authorizedView.items).toEqual([]);
  });
});
