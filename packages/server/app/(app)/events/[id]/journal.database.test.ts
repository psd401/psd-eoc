import { randomUUID } from 'node:crypto';

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
  IntegrationStatusSchema,
  type JournalEntry,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  createDatabaseClient,
  type Database,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  activationPreviews,
  audienceConfigurations,
  channelConfigurations,
  eventTypeVersions,
  events,
  facilities,
  integrationStatuses,
  journalEntries,
  notificationIntentChannels,
  notificationIntents,
  outbox,
  rosterEndpoints,
  rosterRecipients,
  rosterSnapshots,
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
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
  type JournalCapabilityStore,
} from '../../../../lib/capabilities/journal';
import { requireSyntheticTestDatabaseUrl } from '../../../(admin)/event-types/test-database';

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

interface SyntheticFixtureIds {
  readonly northFacilityId: string;
  readonly southFacilityId: string;
  readonly eventTypeVersionId: string;
  readonly rosterSnapshotId: string;
  readonly audienceConfigId: string;
  readonly audienceConfigVersion: number;
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
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope,
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: {
      idempotencyKey,
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
    expect(firstPage.items.map((entry) => entry.id)).toEqual(
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
    expect(secondPage.items.map((entry) => entry.id)).toEqual(
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
    expect(thirdPage.items.map((entry) => entry.id).sort()).toEqual(
      concurrentEntries.map((entry) => entry.id).sort(),
    );
    expect(thirdPage.items.map((entry) => entry.sequence)).toEqual([5, 6]);
    expect(thirdPage.pageInfo).toEqual({ hasMore: false, nextCursor: null });

    const lateJoin = await listJournal(journalStore, eventId, null, 200);
    expect(lateJoin.items).toHaveLength(6);
    expect(lateJoin.items.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(lateJoin.items.slice(0, 4).map((entry) => entry.clientTime)).toEqual(
      [...deliberatelyReversedClientTimes],
    );
    for (let index = 1; index < lateJoin.items.length; index += 1) {
      const previous = lateJoin.items[index - 1];
      const current = lateJoin.items[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(Date.parse(previous!.serverTime)).toBeLessThanOrEqual(
        Date.parse(current!.serverTime),
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

  test('appends corrections and redactions with provenance while retaining every original row', async () => {
    const journalStore = store();
    const eventId = await createActiveSyntheticEvent();
    const correctedOriginal = await appendText(
      journalStore,
      eventId,
      'Initial accountability count is three.',
      '2026-08-10T18:20:00.000Z',
    );
    const redactedOriginal = await appendText(
      journalStore,
      eventId,
      'Synthetic content requiring redaction.',
      '2026-08-10T18:21:00.000Z',
    );

    const correction = await executeJournalCapability(
      'correct-journal-entry',
      textInput(
        eventId,
        'Corrected accountability count is four.',
        '2026-08-10T18:22:00.000Z',
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
    const redaction = await executeJournalCapability(
      'redact-journal-entry',
      textInput(
        eventId,
        '[Content redacted; original retained in append-only history.]',
        '2026-08-10T18:23:00.000Z',
        {
          entryId: redactedOriginal.id,
          entrySequence: redactedOriginal.sequence,
          kind: 'redaction',
          reason: 'Synthetic sensitive detail was posted unnecessarily.',
        },
      ),
      humanMutationInvocation(`issue16-redact-${randomUUID()}`),
      journalStore,
    );

    const lateJoin = await listJournal(journalStore, eventId, null, 200);
    expect(lateJoin.items.map((entry) => entry.id)).toEqual([
      correctedOriginal.id,
      redactedOriginal.id,
      correction.id,
      redaction.id,
    ]);
    expect(lateJoin.items[0]).toMatchObject({
      payload: { text: 'Initial accountability count is three.' },
      supersedes: null,
    });
    expect(lateJoin.items[1]).toMatchObject({
      payload: { text: 'Synthetic content requiring redaction.' },
      supersedes: null,
    });
    expect(correction.supersedes).toEqual({
      entryId: correctedOriginal.id,
      entrySequence: correctedOriginal.sequence,
      kind: 'correction',
      reason: 'The fourth synthetic staff member checked in.',
    });
    expect(redaction.supersedes).toEqual({
      entryId: redactedOriginal.id,
      entrySequence: redactedOriginal.sequence,
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
    expect(persisted).toHaveLength(4);
    expect(persisted[0]).toMatchObject({
      id: correctedOriginal.id,
      supersedesEntryId: null,
    });
    expect(persisted[1]).toMatchObject({
      id: redactedOriginal.id,
      supersedesEntryId: null,
    });
    expect(persisted[2]).toMatchObject({
      id: correction.id,
      supersedesEntryId: correctedOriginal.id,
      supersedesEntrySequence: correctedOriginal.sequence,
      supersessionKind: 'correction',
      supersessionReason: 'The fourth synthetic staff member checked in.',
    });
    expect(persisted[3]).toMatchObject({
      id: redaction.id,
      supersedesEntryId: redactedOriginal.id,
      supersedesEntrySequence: redactedOriginal.sequence,
      supersessionKind: 'redaction',
      supersessionReason:
        'Synthetic sensitive detail was posted unnecessarily.',
    });
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

        const lifecyclePreview = await executeJournalCapability(
          'create-lifecycle-consequence-preview',
          { eventId, purpose: 'all-clear' },
          humanQueryInvocation(),
          journalStore,
        );
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
        expect(retainedJournal.items.map((entry) => entry.sequence)).toEqual([
          1, 2, 3, 4, 5, 6,
        ]);
        expect(retainedJournal.items.map(systemJournalCode)).toEqual([
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
