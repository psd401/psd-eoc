import type { FullConfig } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

import {
  ActivationPreviewSchema,
  EventSchema,
  IdempotencyPrincipalSchema,
  IntegrationStatusSchema,
  JournalEntrySchema,
  MediaRecordSchema,
  type Actor,
  type Event,
  type JournalEntry,
} from '@psd-eoc/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  activationPreviews,
  channelConfigurations,
  events,
  groupSources,
  integrationStatuses,
  journalEntries,
  mediaRecords,
  mediaUploadIntents,
  userRoles,
  users,
} from '../../../../db/schema';
import {
  createDrizzleInitialWebSessionStore,
  digestWebSessionCredential,
} from '../../../../lib/auth/session-cookie';
import {
  quarantineStorageKey,
  readyStorageKey,
} from '../../../../lib/media/model';
import {
  appendFanoutControlRecord,
  readFanoutControlEffectiveState,
} from '../../../../lib/notify/fanout-control';
import { createOwnedEventRoomPlaywrightDatabase } from './playwright-database';
import { requireEventRoomPlaywrightRunContext } from './test-database';

const ACCESS_GROUP_ID = '16000000-0000-4000-8000-000000000110';
// The access group these browser fixtures configure. Any address works now
// that the group set is data; this one keeps the fixtures' expectations stable.
const DESIGNATED_ACCESS_GROUP_EMAIL = 'tsd-engineering@psd401.net';
const MEMBER_USER_ID = '16000000-0000-4000-8000-000000000120';
const MEMBER_SUBJECT = 'mock-google-subject-event-room';
const FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const ROSTER_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000041';
const AUDIENCE_CONFIGURATION_ID = '00000000-0000-4000-8000-000000000020';
const DRILL_EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const REAL_EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000200';
const REQUIRED_INTEGRATIONS = ['expo-push', 'ses-email'] as const;
const runFile = promisify(execFile);
const serverRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

interface AccessFixture {
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly syncStartedAt: Date;
  readonly capturedAt: Date;
  readonly userCreatedAt: Date;
}

interface EventRoomFixture {
  readonly sessionId: string;
  readonly concurrentDialogEventId: string;
  readonly continuationEventId: string;
  readonly dialogFailureEventId: string;
  readonly historyEventId: string;
  readonly invalidationEventId: string;
  readonly journalEvidenceEventId: string;
  readonly keyboardEventId: string;
  readonly recoveryEventId: string;
  readonly recoveryOwnerEventId: string;
  readonly lifecycleEventId: string;
  readonly malformedLifecycleEventId: string;
  readonly mismatchedAllClearTransitionEventId: string;
  readonly mismatchedTransitionEventId: string;
  readonly newerPollEventId: string;
  readonly paginatedDialogEventId: string;
  readonly paginatedLifecycleEventId: string;
  readonly pendingDialogEventId: string;
  readonly previewRetryEventId: string;
  readonly realDraftEventId: string;
  readonly rejectedDialogRaceEventId: string;
  readonly rejectedLifecycleDialogEventId: string;
  readonly stalePollEventId: string;
  readonly staleLifecycleResponseEventId: string;
  readonly stalledMutationEventId: string;
  readonly stalledPreviewEventId: string;
  readonly photoEventId: string;
  readonly photoMediaId: string;
  readonly photoUploadMediaId: string;
  readonly photoSanitizedSha256: string;
  readonly photoStressEventId: string;
  readonly photoStressOldestMediaId: string;
  readonly photoStressSecondMediaId: string;
  readonly photoStressMiddleMediaId: string;
  readonly redactedPhotoEventId: string;
  readonly redactedPhotoMediaId: string;
}

interface ChannelConfigurationState {
  readonly integrationId: string;
  readonly enabled: boolean;
  readonly changedAt: string;
}

async function restoreChannelConfigurations(
  connection: PostgresDatabaseConnection,
  state: readonly ChannelConfigurationState[],
): Promise<void> {
  await connection.db.transaction(async (transaction) => {
    for (const configuration of state) {
      const restored = await transaction
        .update(channelConfigurations)
        .set({
          enabled: configuration.enabled,
          changedAt: new Date(configuration.changedAt),
        })
        .where(
          eq(channelConfigurations.integrationId, configuration.integrationId),
        )
        .returning({ integrationId: channelConfigurations.integrationId });
      if (restored.length !== 1) {
        throw new Error(
          'The event-room channel configuration could not be restored.',
        );
      }
    }
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function prepareDatabase(databaseUrl: string): Promise<void> {
  const environment = {
    ...process.env,
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: databaseUrl,
  };
  await runFile('bun', ['drizzle/migrate.ts'], {
    cwd: serverRoot,
    env: environment,
  });
  await runFile('bun', ['db/seed.ts'], {
    cwd: serverRoot,
    env: environment,
  });
}

async function prepareAccessEvidence(
  connection: PostgresDatabaseConnection,
): Promise<AccessFixture> {
  const database = connection.db;
  const [latestVersionSnapshot] = await database
    .select({ version: accessMembershipSnapshots.version })
    .from(accessMembershipSnapshots)
    .orderBy(desc(accessMembershipSnapshots.version))
    .limit(1);
  const [latestCapturedSnapshot] = await database
    .select({ capturedAt: accessMembershipSnapshots.capturedAt })
    .from(accessMembershipSnapshots)
    .orderBy(desc(accessMembershipSnapshots.capturedAt))
    .limit(1);
  const now = new Date(
    Math.max(
      Date.now(),
      (latestCapturedSnapshot?.capturedAt.getTime() ?? 0) + 3_000,
    ),
  );
  const syncStartedAt = new Date(now.getTime() - 2_000);
  const capturedAt = new Date(now.getTime() - 1_000);
  const snapshotId = randomUUID();
  const version = (latestVersionSnapshot?.version ?? 0) + 1;

  return database.transaction(async (transaction) => {
    await transaction
      .insert(groupSources)
      .values({
        id: ACCESS_GROUP_ID,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Synthetic Event Room Playwright Access',
        active: true,
        googleGroupId: 'synthetic-event-room-playwright-access',
        email: DESIGNATED_ACCESS_GROUP_EMAIL,
        fixtureKey: null,
        createdAt: now,
      })
      .onConflictDoNothing();
    await transaction
      .insert(users)
      .values({
        id: MEMBER_USER_ID,
        googleSubject: MEMBER_SUBJECT,
        email: 'synthetic-event-room-playwright@psd401.net',
        displayName: 'Synthetic Event Room Operator',
        facilityScopeKind: 'district',
        createdAt: now,
        disabledAt: null,
      })
      .onConflictDoNothing();
    await transaction
      .insert(userRoles)
      .values([
        { userId: MEMBER_USER_ID, role: 'staff' },
        { userId: MEMBER_USER_ID, role: 'admin' },
      ])
      .onConflictDoNothing();
    await transaction.insert(accessMembershipSnapshots).values({
      id: snapshotId,
      version,
      complete: true,
      syncStartedAt,
      capturedAt,
    });
    const activeAccessGroups = await transaction
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.active, true),
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
        ),
      );
    await transaction.insert(accessMembershipSnapshotGroups).values(
      activeAccessGroups.flatMap(({ id }) => [
        {
          snapshotId,
          groupSourceId: id,
          groupSourceKind: 'google-group' as const,
          groupPurpose: 'access' as const,
          completionKind: 'expected' as const,
        },
        {
          snapshotId,
          groupSourceId: id,
          groupSourceKind: 'google-group' as const,
          groupPurpose: 'access' as const,
          completionKind: 'completed' as const,
        },
      ]),
    );
    await transaction.insert(accessMembershipMembers).values({
      snapshotId,
      userId: MEMBER_USER_ID,
      googleSubject: MEMBER_SUBJECT,
      facilityScopeKind: 'district',
    });
    await transaction.insert(accessMembershipMemberGroups).values({
      snapshotId,
      userId: MEMBER_USER_ID,
      groupSourceId: ACCESS_GROUP_ID,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
    const [persistedUser] = await transaction
      .select({ createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, MEMBER_USER_ID))
      .limit(1);
    if (persistedUser === undefined) {
      throw new Error('The synthetic Playwright user was not retained.');
    }
    return {
      snapshotId,
      snapshotVersion: version,
      syncStartedAt,
      capturedAt,
      userCreatedAt: persistedUser.createdAt,
    };
  });
}

async function issueSyntheticOperatorSession(
  connection: PostgresDatabaseConnection,
  fixture: AccessFixture,
  storageStatePath: string,
): Promise<Extract<Actor, { kind: 'human' }>> {
  const now = new Date(
    Math.max(Date.now(), fixture.capturedAt.getTime() + 1_000),
  );
  const credential = randomBytes(48).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const responseDigest = digest(randomUUID());
  const principal = IdempotencyPrincipalSchema.parse({
    kind: 'oidc-callback',
    subjectDigest: digest(MEMBER_SUBJECT),
    responseDigest,
  });
  const result = await createDrizzleInitialWebSessionStore(
    connection.db,
  ).persist({
    user: {
      id: MEMBER_USER_ID,
      googleSubject: MEMBER_SUBJECT,
      email: 'synthetic-event-room-playwright@psd401.net',
      displayName: 'Synthetic Event Room Operator',
      roles: ['admin', 'staff'],
      facilityScope: { kind: 'district' },
      createdAt: fixture.userCreatedAt.toISOString(),
      disabledAt: null,
    },
    membership: {
      groupSourceIds: [ACCESS_GROUP_ID],
      capturedAt: fixture.capturedAt,
    },
    device: {
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `synthetic-event-room-${randomUUID()}`,
    },
    credentialDigest: digestWebSessionCredential(credential),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000),
    membershipValidUntil: new Date(
      fixture.capturedAt.getTime() + 24 * 60 * 60 * 1_000,
    ),
    membershipGraceUntil: new Date(
      fixture.capturedAt.getTime() + 72 * 60 * 60 * 1_000,
    ),
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digest(JSON.stringify(principal)),
      requestDigest: digest(`synthetic-event-room:${randomUUID()}`),
    },
  });
  if (!result.user.roles.includes('admin')) {
    throw new Error(
      'The synthetic event-room session is not an administrator.',
    );
  }
  const expires = Math.floor(
    new Date(result.session.expiresAt).getTime() / 1_000,
  );
  await writeFile(
    storageStatePath,
    JSON.stringify({
      cookies: [
        {
          name: '__Host-psd-eoc-session',
          value: credential,
          domain: 'localhost',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: '__Host-psd-eoc-csrf',
          value: csrf,
          domain: 'localhost',
          path: '/',
          expires,
          httpOnly: false,
          secure: true,
          sameSite: 'Strict',
        },
      ],
      origins: [],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  return {
    kind: 'human',
    userId: MEMBER_USER_ID,
    sessionId: result.session.id,
  };
}

async function enableSyntheticNotificationFanout(
  connection: PostgresDatabaseConnection,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<void> {
  await connection.db.transaction(async (transaction) => {
    const appendedRecord = await appendFanoutControlRecord({
      database: transaction,
      actor,
      requestId: randomUUID(),
      expectedCurrentRecordId: null,
      desiredMode: 'enabled',
      reason: 'Synthetic event-room Playwright fixture only.',
      productOwnerApprovalReference: `synthetic-test-only-po-approval-playwright-${randomUUID()}`,
      changedAt: new Date(),
    });
    const readback = await readFanoutControlEffectiveState(transaction);
    const expectedReadback = {
      kind: 'current' as const,
      effectiveMode: 'enabled' as const,
      currentEpochId: appendedRecord.enableEpochId,
      currentRecord: appendedRecord,
    };
    if (
      appendedRecord.enableEpochId === null ||
      !isDeepStrictEqual(readback, expectedReadback)
    ) {
      throw new Error(
        'The synthetic event-room fan-out epoch did not read back exactly.',
      );
    }
  });
}

function journalInsert(
  entry: JournalEntry,
): typeof journalEntries.$inferInsert {
  return {
    id: entry.id,
    eventId: entry.eventId,
    sequence: entry.sequence,
    kind: entry.kind,
    author: entry.author,
    source: entry.source,
    serverTime: new Date(entry.serverTime),
    clientTime: entry.clientTime === null ? null : new Date(entry.clientTime),
    payload: entry.payload,
    mediaId: entry.kind === 'photo' ? entry.payload.mediaId : null,
    transitionId: null,
    supersedesEntryId: entry.supersedes?.entryId ?? null,
    supersedesEntrySequence: entry.supersedes?.entrySequence ?? null,
    supersessionKind: entry.supersedes?.kind ?? null,
    supersessionReason: entry.supersedes?.reason ?? null,
  };
}

function eventInsert(event: Event): typeof events.$inferInsert {
  return {
    id: event.id,
    facilityId: event.facilityId,
    kind: event.kind,
    templateMode: event.templateMode,
    eventTypeVersionId: event.eventTypeVersion.id,
    status: event.status,
    rosterSnapshotId: event.rosterSnapshotId,
    rosterPopulation: event.rosterPopulation,
    createdBy: event.createdBy,
    createdAt: new Date(event.createdAt),
    activatedAt:
      event.activatedAt === null ? null : new Date(event.activatedAt),
    allClearAt: event.allClearAt === null ? null : new Date(event.allClearAt),
    reactivatedAt:
      event.reactivatedAt === null ? null : new Date(event.reactivatedAt),
    closedAt: event.closedAt === null ? null : new Date(event.closedAt),
    correctionOfEventId: event.correctionOfEventId,
    correctionReason: event.correctionReason,
    activationAuthorization: event.activationAuthorization,
  };
}

interface SyntheticReadyMediaSeed {
  readonly id: string;
  readonly sanitizedContentSha256: string;
  readonly uploadIntent: typeof mediaUploadIntents.$inferInsert;
  readonly record: typeof mediaRecords.$inferInsert;
}

function readyMediaSeed(
  eventId: string,
  createdAt: Date,
  label: string,
): SyntheticReadyMediaSeed {
  const uploadIntentId = randomUUID();
  const mediaId = randomUUID();
  const rawContent = `synthetic raw ${label} photo ${uploadIntentId}`;
  const sanitizedContent = `synthetic sanitized ${label} photo ${mediaId}`;
  const canonicalRecord = MediaRecordSchema.parse({
    id: mediaId,
    uploadIntentId,
    eventId,
    status: 'ready',
    detectedContentType: 'image/jpeg',
    sanitizedByteLength: Buffer.byteLength(sanitizedContent, 'utf8'),
    sanitizedContentSha256: digest(sanitizedContent),
    malwareScan: 'clean',
    exifStripped: true,
    createdAt: createdAt.toISOString(),
  });
  return {
    id: canonicalRecord.id,
    sanitizedContentSha256: canonicalRecord.sanitizedContentSha256,
    uploadIntent: {
      id: uploadIntentId,
      eventId,
      facilityId: FACILITY_ID,
      budgetPrincipalDigest: digest(
        'synthetic event-room browser media fixture principal',
      ),
      budgetPrincipalAttributed: true,
      byteLength: Buffer.byteLength(rawContent, 'utf8'),
      contentSha256: digest(rawContent),
      declaredContentType: 'image/jpeg',
      storageKey: quarantineStorageKey(eventId, uploadIntentId),
      status: 'completed',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
    },
    record: {
      id: canonicalRecord.id,
      uploadIntentId: canonicalRecord.uploadIntentId,
      eventId: canonicalRecord.eventId,
      status: canonicalRecord.status,
      detectedContentType: canonicalRecord.detectedContentType,
      sanitizedByteLength: canonicalRecord.sanitizedByteLength,
      sanitizedContentSha256: canonicalRecord.sanitizedContentSha256,
      storageKey: readyStorageKey(eventId, canonicalRecord.id),
      malwareScan: canonicalRecord.malwareScan,
      exifStripped: canonicalRecord.exifStripped,
      createdAt,
    },
  };
}

async function prepareEventFixtures(
  connection: PostgresDatabaseConnection,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<EventRoomFixture> {
  const database = connection.db;
  const statusRows = await database
    .select()
    .from(integrationStatuses)
    .where(inArray(integrationStatuses.integrationId, REQUIRED_INTEGRATIONS));
  if (statusRows.length !== REQUIRED_INTEGRATIONS.length) {
    throw new Error('The synthetic notification integrations are incomplete.');
  }
  const statusFor = (integrationId: (typeof REQUIRED_INTEGRATIONS)[number]) => {
    const row = statusRows.find(
      (candidate) => candidate.integrationId === integrationId,
    );
    if (row === undefined) {
      throw new Error(`Missing synthetic integration ${integrationId}.`);
    }
    return IntegrationStatusSchema.parse({
      integrationId: row.integrationId,
      label: row.label,
      verifiedAt: row.verifiedAt === null ? null : iso(row.verifiedAt),
      verifiedByUserId: row.verifiedByUserId,
      authorizationReference: row.authorizationReference,
      reasonCode: row.reasonCode,
      observedAt: iso(row.observedAt),
    });
  };

  const now = new Date();
  const previewCreatedAt = new Date(now.getTime() - 5 * 60_000);
  const activatedAt = new Date(now.getTime() - 4 * 60_000);
  const previewId = randomUUID();
  const consequenceDigest = digest(`event-room-preview:${previewId}`);
  const preview = ActivationPreviewSchema.parse({
    id: previewId,
    facilityId: FACILITY_ID,
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: {
      id: DRILL_EVENT_TYPE_VERSION_ID,
      templateMode: 'drill',
    },
    rosterSnapshotId: ROSTER_SNAPSHOT_ID,
    rosterPopulation: 'synthetic',
    audienceConfig: { id: AUDIENCE_CONFIGURATION_ID, version: 1 },
    recipientCount: 4,
    channels: [
      {
        channel: 'push',
        endpointCount: 4,
        renderedMessage: {
          channel: 'push',
          eventKind: 'drill',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          title: '[DRILL] Synthetic event-room activation',
          body: '[DRILL] Synthetic event-room activation fixture.',
        },
        integrationStatus: statusFor('expo-push'),
      },
      {
        channel: 'email',
        endpointCount: 4,
        renderedMessage: {
          channel: 'email',
          eventKind: 'drill',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          subject: '[DRILL] Synthetic event-room activation',
          textBody: '[DRILL] Synthetic event-room activation fixture.',
        },
        integrationStatus: statusFor('ses-email'),
      },
    ],
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: [],
    consequenceDigest,
    createdAt: previewCreatedAt.toISOString(),
    expiresAt: new Date(previewCreatedAt.getTime() + 15 * 60_000).toISOString(),
  });

  const makeActiveEvent = (): Event => {
    const requestId = randomUUID();
    return EventSchema.parse({
      id: randomUUID(),
      facilityId: FACILITY_ID,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: {
        id: DRILL_EVENT_TYPE_VERSION_ID,
        templateMode: 'drill',
      },
      status: 'active',
      rosterSnapshotId: ROSTER_SNAPSHOT_ID,
      rosterPopulation: 'synthetic',
      createdBy: actor,
      createdAt: activatedAt.toISOString(),
      activatedAt: activatedAt.toISOString(),
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: {
        kind: 'synthetic-training',
        activationPreviewId: preview.id,
        consequenceDigest: preview.consequenceDigest,
        requestId,
      },
    });
  };
  const historyEvent = makeActiveEvent();
  const concurrentDialogEvent = makeActiveEvent();
  const invalidationEvent = makeActiveEvent();
  const journalEvidenceEvent = makeActiveEvent();
  const keyboardEvent = makeActiveEvent();
  const recoveryEvent = makeActiveEvent();
  const recoveryOwnerEvent = makeActiveEvent();
  const lifecycleEvent = makeActiveEvent();
  const continuationEvent = makeActiveEvent();
  const stalePollEvent = makeActiveEvent();
  const malformedLifecycleEvent = makeActiveEvent();
  const mismatchedAllClearTransitionEvent = makeActiveEvent();
  const mismatchedTransitionEvent = makeActiveEvent();
  const newerPollEvent = makeActiveEvent();
  const paginatedDialogEvent = makeActiveEvent();
  const paginatedLifecycleEvent = makeActiveEvent();
  const pendingDialogEvent = makeActiveEvent();
  const previewRetryEvent = makeActiveEvent();
  const rejectedDialogRaceEvent = makeActiveEvent();
  const rejectedLifecycleDialogEvent = makeActiveEvent();
  const staleLifecycleResponseEvent = makeActiveEvent();
  const dialogFailureEvent = makeActiveEvent();
  const stalledMutationEvent = makeActiveEvent();
  const stalledPreviewEvent = makeActiveEvent();
  const photoEvent = makeActiveEvent();
  const photoStressEvent = makeActiveEvent();
  const redactedPhotoEvent = makeActiveEvent();
  const realDraftEvent = EventSchema.parse({
    id: randomUUID(),
    facilityId: FACILITY_ID,
    kind: 'incident',
    templateMode: 'real',
    eventTypeVersion: {
      id: REAL_EVENT_TYPE_VERSION_ID,
      templateMode: 'real',
    },
    status: 'draft',
    rosterSnapshotId: null,
    rosterPopulation: null,
    createdBy: actor,
    createdAt: now.toISOString(),
    activatedAt: null,
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: null,
  });

  const makeHistory = (event: Event, count: number): readonly JournalEntry[] =>
    Array.from({ length: count }, (_, index) => {
      const sequence = index + 1;
      return JournalEntrySchema.parse({
        id: randomUUID(),
        eventId: event.id,
        sequence,
        kind: 'text',
        author: actor,
        source: 'web',
        serverTime: new Date(
          activatedAt.getTime() + sequence * 1_000,
        ).toISOString(),
        clientTime: new Date(
          activatedAt.getTime() + (count - sequence) * 1_000,
        ).toISOString(),
        payload: {
          text: `Synthetic ordered history ${String(sequence).padStart(3, '0')}`,
        },
        supersedes: null,
      });
    });
  const photoMedia = readyMediaSeed(
    photoEvent.id,
    new Date(activatedAt.getTime() + 500),
    'visible',
  );
  const photoUploadMedia = readyMediaSeed(
    photoEvent.id,
    new Date(activatedAt.getTime() + 750),
    'upload completion',
  );
  const photoStressMedia = Array.from({ length: 12 }, (_, index) =>
    readyMediaSeed(
      photoStressEvent.id,
      new Date(activatedAt.getTime() + 500 + index),
      `bounded loader ${index + 1}`,
    ),
  );
  const photoStressMiddleMedia = photoStressMedia[5];
  const photoStressOldestMedia = photoStressMedia[0];
  const photoStressSecondMedia = photoStressMedia[1];
  if (
    photoStressMiddleMedia === undefined ||
    photoStressOldestMedia === undefined ||
    photoStressSecondMedia === undefined
  ) {
    throw new Error('The bounded private-photo fixture is incomplete.');
  }
  const redactedPhotoMedia = readyMediaSeed(
    redactedPhotoEvent.id,
    new Date(activatedAt.getTime() + 500),
    'redacted',
  );
  const photoEntry = JournalEntrySchema.parse({
    id: randomUUID(),
    eventId: photoEvent.id,
    sequence: 1,
    kind: 'photo',
    author: actor,
    source: 'web',
    serverTime: new Date(activatedAt.getTime() + 1_000).toISOString(),
    clientTime: null,
    payload: {
      mediaId: photoMedia.id,
      altText: 'Synthetic emergency operations scene; no people are shown.',
      caption: 'Synthetic authorized-photo rendering fixture.',
    },
    supersedes: null,
  });
  const photoStressEntries = photoStressMedia.map((media, index) => {
    const sequence = index + 1;
    return JournalEntrySchema.parse({
      id: randomUUID(),
      eventId: photoStressEvent.id,
      sequence,
      kind: 'photo',
      author: actor,
      source: 'web',
      serverTime: new Date(
        activatedAt.getTime() + sequence * 1_000,
      ).toISOString(),
      clientTime: null,
      payload: {
        mediaId: media.id,
        altText: `Synthetic bounded-loader private photo ${sequence}.`,
        caption: `Synthetic resource-bound fixture ${sequence}.`,
      },
      supersedes: null,
    });
  });
  const redactedPhotoEntry = JournalEntrySchema.parse({
    id: randomUUID(),
    eventId: redactedPhotoEvent.id,
    sequence: 1,
    kind: 'photo',
    author: actor,
    source: 'web',
    serverTime: new Date(activatedAt.getTime() + 1_000).toISOString(),
    clientTime: null,
    payload: {
      mediaId: redactedPhotoMedia.id,
      altText: 'Synthetic photo hidden by a later append-only redaction.',
      caption: null,
    },
    supersedes: null,
  });
  const photoRedactionEntry = JournalEntrySchema.parse({
    id: randomUUID(),
    eventId: redactedPhotoEvent.id,
    sequence: 2,
    kind: 'text',
    author: actor,
    source: 'web',
    serverTime: new Date(activatedAt.getTime() + 2_000).toISOString(),
    clientTime: null,
    payload: {
      text: '[Content redacted — original retained in journal]',
    },
    supersedes: {
      entryId: redactedPhotoEntry.id,
      entrySequence: redactedPhotoEntry.sequence,
      kind: 'redaction',
      reason: 'Synthetic privacy-safe photo redaction fixture.',
    },
  });
  const journal = [
    ...makeHistory(historyEvent, 105),
    ...makeHistory(concurrentDialogEvent, 3),
    ...makeHistory(invalidationEvent, 3),
    ...makeHistory(journalEvidenceEvent, 3),
    ...makeHistory(keyboardEvent, 3),
    ...makeHistory(recoveryEvent, 3),
    ...makeHistory(recoveryOwnerEvent, 3),
    ...makeHistory(lifecycleEvent, 3),
    ...makeHistory(continuationEvent, 3),
    ...makeHistory(stalePollEvent, 3),
    ...makeHistory(malformedLifecycleEvent, 3),
    ...makeHistory(mismatchedAllClearTransitionEvent, 3),
    ...makeHistory(mismatchedTransitionEvent, 3),
    ...makeHistory(newerPollEvent, 3),
    ...makeHistory(paginatedDialogEvent, 3),
    ...makeHistory(paginatedLifecycleEvent, 3),
    ...makeHistory(pendingDialogEvent, 3),
    ...makeHistory(previewRetryEvent, 3),
    ...makeHistory(rejectedDialogRaceEvent, 3),
    ...makeHistory(rejectedLifecycleDialogEvent, 3),
    ...makeHistory(staleLifecycleResponseEvent, 3),
    ...makeHistory(dialogFailureEvent, 3),
    ...makeHistory(stalledMutationEvent, 3),
    ...makeHistory(stalledPreviewEvent, 3),
    photoEntry,
    ...photoStressEntries,
    redactedPhotoEntry,
    photoRedactionEntry,
  ];

  await database.transaction(async (transaction) => {
    await transaction
      .update(channelConfigurations)
      .set({ enabled: true, changedAt: now })
      .where(
        inArray(channelConfigurations.integrationId, REQUIRED_INTEGRATIONS),
      );
    await transaction.insert(activationPreviews).values({
      id: preview.id,
      facilityId: preview.facilityId,
      kind: preview.kind,
      templateMode: preview.templateMode,
      eventTypeVersionId: preview.eventTypeVersion.id,
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: preview.rosterPopulation,
      audienceConfigId: preview.audienceConfig.id,
      audienceConfigVersion: preview.audienceConfig.version,
      recipientCount: preview.recipientCount,
      channels: preview.channels,
      sendReadiness: preview.sendReadiness,
      blockingReasonCodes: preview.blockingReasonCodes,
      activeEventIds: preview.activeEventIds,
      consequenceDigest: preview.consequenceDigest,
      createdAt: new Date(preview.createdAt),
      expiresAt: new Date(preview.expiresAt),
    });
    await transaction
      .insert(events)
      .values(
        [
          historyEvent,
          concurrentDialogEvent,
          invalidationEvent,
          journalEvidenceEvent,
          keyboardEvent,
          recoveryEvent,
          recoveryOwnerEvent,
          lifecycleEvent,
          continuationEvent,
          stalePollEvent,
          malformedLifecycleEvent,
          mismatchedAllClearTransitionEvent,
          mismatchedTransitionEvent,
          newerPollEvent,
          paginatedDialogEvent,
          paginatedLifecycleEvent,
          pendingDialogEvent,
          previewRetryEvent,
          rejectedDialogRaceEvent,
          rejectedLifecycleDialogEvent,
          staleLifecycleResponseEvent,
          dialogFailureEvent,
          stalledMutationEvent,
          stalledPreviewEvent,
          photoEvent,
          photoStressEvent,
          redactedPhotoEvent,
          realDraftEvent,
        ].map(eventInsert),
      );
    await transaction
      .insert(mediaUploadIntents)
      .values([
        photoMedia.uploadIntent,
        photoUploadMedia.uploadIntent,
        ...photoStressMedia.map((media) => media.uploadIntent),
        redactedPhotoMedia.uploadIntent,
      ]);
    await transaction
      .insert(mediaRecords)
      .values([
        photoMedia.record,
        photoUploadMedia.record,
        ...photoStressMedia.map((media) => media.record),
        redactedPhotoMedia.record,
      ]);
    await transaction.insert(journalEntries).values(journal.map(journalInsert));
  });

  return {
    sessionId: actor.sessionId,
    concurrentDialogEventId: concurrentDialogEvent.id,
    continuationEventId: continuationEvent.id,
    dialogFailureEventId: dialogFailureEvent.id,
    historyEventId: historyEvent.id,
    invalidationEventId: invalidationEvent.id,
    journalEvidenceEventId: journalEvidenceEvent.id,
    keyboardEventId: keyboardEvent.id,
    recoveryEventId: recoveryEvent.id,
    recoveryOwnerEventId: recoveryOwnerEvent.id,
    lifecycleEventId: lifecycleEvent.id,
    malformedLifecycleEventId: malformedLifecycleEvent.id,
    mismatchedAllClearTransitionEventId: mismatchedAllClearTransitionEvent.id,
    mismatchedTransitionEventId: mismatchedTransitionEvent.id,
    newerPollEventId: newerPollEvent.id,
    paginatedDialogEventId: paginatedDialogEvent.id,
    paginatedLifecycleEventId: paginatedLifecycleEvent.id,
    pendingDialogEventId: pendingDialogEvent.id,
    previewRetryEventId: previewRetryEvent.id,
    realDraftEventId: realDraftEvent.id,
    rejectedDialogRaceEventId: rejectedDialogRaceEvent.id,
    rejectedLifecycleDialogEventId: rejectedLifecycleDialogEvent.id,
    stalePollEventId: stalePollEvent.id,
    staleLifecycleResponseEventId: staleLifecycleResponseEvent.id,
    stalledMutationEventId: stalledMutationEvent.id,
    stalledPreviewEventId: stalledPreviewEvent.id,
    photoEventId: photoEvent.id,
    photoMediaId: photoMedia.id,
    photoUploadMediaId: photoUploadMedia.id,
    photoSanitizedSha256: photoMedia.sanitizedContentSha256,
    photoStressEventId: photoStressEvent.id,
    photoStressOldestMediaId: photoStressOldestMedia.id,
    photoStressSecondMediaId: photoStressSecondMedia.id,
    photoStressMiddleMediaId: photoStressMiddleMedia.id,
    redactedPhotoEventId: redactedPhotoEvent.id,
    redactedPhotoMediaId: redactedPhotoMedia.id,
  };
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const metadata = config.metadata as Readonly<Record<string, unknown>>;
  const context = requireEventRoomPlaywrightRunContext(metadata.eventRoomRun);
  await mkdir(context.runDirectory, { mode: 0o700, recursive: true });
  await createOwnedEventRoomPlaywrightDatabase(context);
  if (
    process.env.PSD_EOC_EVENT_ROOM_PLAYWRIGHT_SETUP_FAILURE_RUN_ID ===
    context.runId
  ) {
    throw new Error(
      'Synthetic event-room Playwright setup failure after database creation.',
    );
  }
  await prepareDatabase(context.databaseUrl);
  const created = createDatabaseClient({
    driver: 'postgres',
    url: context.databaseUrl,
    maxConnections: 2,
  });
  if (created.driver !== 'postgres') {
    throw new Error('Event-room Playwright requires PostgreSQL.');
  }
  try {
    const originalChannelConfigurations: readonly ChannelConfigurationState[] =
      await created.db
        .select({
          integrationId: channelConfigurations.integrationId,
          enabled: channelConfigurations.enabled,
          changedAt: channelConfigurations.changedAt,
        })
        .from(channelConfigurations)
        .where(
          inArray(channelConfigurations.integrationId, REQUIRED_INTEGRATIONS),
        )
        .then((rows) =>
          rows.map((row) => ({
            integrationId: row.integrationId,
            enabled: row.enabled,
            changedAt: row.changedAt.toISOString(),
          })),
        );
    if (
      originalChannelConfigurations.length !== REQUIRED_INTEGRATIONS.length ||
      originalChannelConfigurations.some((configuration) =>
        Boolean(configuration.enabled),
      )
    ) {
      throw new Error(
        'Event-room Playwright requires inert mocked channel configurations.',
      );
    }
    await writeFile(
      context.channelStatePath,
      JSON.stringify(originalChannelConfigurations),
      { encoding: 'utf8', mode: 0o600 },
    );
    try {
      const access = await prepareAccessEvidence(created);
      const actor = await issueSyntheticOperatorSession(
        created,
        access,
        context.storageStatePath,
      );
      await enableSyntheticNotificationFanout(created, actor);
      const fixture = await prepareEventFixtures(created, actor);
      await writeFile(context.fixturePath, JSON.stringify(fixture), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      await restoreChannelConfigurations(
        created,
        originalChannelConfigurations,
      );
      throw error;
    }
  } finally {
    await created.close();
  }
}
