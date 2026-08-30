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
  DispatchBatchSchema,
  EmailBatchResolutionPageSchema,
  IntegrationStatusSchema,
  NotificationOutboxMessageSchema,
  type DispatchBatch,
  type IntegrationStatus,
} from '@psd-eoc/contracts';
import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedDatabase } from '../../db/seed';
import {
  channelConfigurations,
  dispatchBatches,
  endpointStatusRecords,
  events,
  groupSources,
  integrationStatuses,
  notificationIntentChannels,
  notificationIntents,
  outbox,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../testing/database';
import {
  createDrizzleEmailRuntimeStore,
  type EmailRuntimeStore,
} from './email-runtime-store';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000201';
// Relative to the run, because the email store reads the database clock and
// refuses a batch older than its send horizon. Fixed dates would put every
// batch permanently past that horizon and resolve nothing.
const NOW = Date.now();
const CREATED_AT = new Date(NOW - 60_000).toISOString();
const BATCH_CREATED_AT = new Date(NOW - 59_500).toISOString();
const VERIFIED_AT = new Date(NOW - 300_000).toISOString();
const EMAIL_AUTHORIZATION_REFERENCE = 'ses:case:279';
const ORDINARY_ENDPOINT_COUNT = 3;
const PAGED_ENDPOINT_COUNT = 51;

const fixture = Object.freeze({
  userId: randomUUID(),
  sessionId: randomUUID(),
  groupSourceId: randomUUID(),
  rosterConfigurationId: randomUUID(),
  ordinarySnapshotId: randomUUID(),
  pagedSnapshotId: randomUUID(),
  pushStatusId: randomUUID(),
  emailStatusId: randomUUID(),
  smsStatusId: randomUUID(),
});

const ordinaryRecipients = Object.freeze(
  Array.from({ length: ORDINARY_ENDPOINT_COUNT }, (_, index) =>
    Object.freeze({
      recipientId: randomUUID(),
      endpointId: randomUUID(),
      email: `ordinary-${String(index).padStart(3, '0')}@example.invalid`,
      index,
    }),
  ),
);

const pagedRecipients = Object.freeze(
  Array.from({ length: PAGED_ENDPOINT_COUNT }, (_, index) =>
    Object.freeze({
      recipientId: randomUUID(),
      endpointId: randomUUID(),
      email: `paged-${String(index).padStart(3, '0')}@example.invalid`,
      index,
    }),
  ),
);

interface NotificationBundle {
  readonly batch: DispatchBatch;
}

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
let ordinaryBundle: NotificationBundle | undefined;
let pagedBundle: NotificationBundle | undefined;

/** The resolved endpoint is a channel union; these work items are always email. */
function emailAddress(endpoint: { channel: string }): string {
  if (endpoint.channel !== 'email' || !('email' in endpoint)) {
    throw new Error('An email work item resolved a non-email endpoint.');
  }
  return String((endpoint as { email: string }).email);
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error(
      'The email runtime PostgreSQL test connection is not open.',
    );
  }
  return connection;
}

function installedOrdinaryBundle(): NotificationBundle {
  if (ordinaryBundle === undefined) {
    throw new Error('The ordinary email runtime fixture was not installed.');
  }
  return ordinaryBundle;
}

function installedPagedBundle(): NotificationBundle {
  if (pagedBundle === undefined) {
    throw new Error('The paged email runtime fixture was not installed.');
  }
  return pagedBundle;
}

function runtimeStore(): EmailRuntimeStore {
  return createDrizzleEmailRuntimeStore(databaseConnection().db, {
    deploymentAuthorization: {
      workerEnabled: true,
      verificationReference: EMAIL_AUTHORIZATION_REFERENCE,
    },
  });
}

function liveIntegrationStatus(
  integrationId: 'expo-push' | 'ses-email' | 'aws-eum-sms',
): IntegrationStatus {
  const authorizationReference =
    integrationId === 'ses-email'
      ? EMAIL_AUTHORIZATION_REFERENCE
      : `synthetic:${integrationId}`;
  return IntegrationStatusSchema.parse({
    integrationId,
    label: 'live-verified',
    verifiedAt: VERIFIED_AT,
    verifiedByUserId: fixture.userId,
    authorizationReference,
    reasonCode: null,
    observedAt: VERIFIED_AT,
  });
}

const integrationTruth = Object.freeze({
  push: liveIntegrationStatus('expo-push'),
  email: liveIntegrationStatus('ses-email'),
  sms: liveIntegrationStatus('aws-eum-sms'),
});

function humanAuthorization(requestId: string) {
  return Object.freeze({
    kind: 'human-confirmed' as const,
    activationPreviewId: randomUUID(),
    preparedActivationId: null,
    confirmationId: randomUUID(),
    consequenceDigest: 'd'.repeat(64),
    requestId,
  });
}

const pushMessage = Object.freeze({
  eventKind: 'drill' as const,
  templateMode: 'drill' as const,
  purpose: 'activation' as const,
  classificationMarker: 'DRILL' as const,
  channel: 'push' as const,
  title: '[DRILL] Synthetic SMS runtime persistence test',
  body: '[DRILL] Synthetic test only.',
});

const emailMessage = Object.freeze({
  eventKind: 'drill' as const,
  templateMode: 'drill' as const,
  purpose: 'activation' as const,
  classificationMarker: 'DRILL' as const,
  channel: 'email' as const,
  subject: '[DRILL] Synthetic SMS runtime persistence test',
  textBody: '[DRILL] Synthetic test only.',
});

const smsMessage = Object.freeze({
  eventKind: 'drill' as const,
  templateMode: 'drill' as const,
  purpose: 'activation' as const,
  classificationMarker: 'DRILL' as const,
  channel: 'sms' as const,
  body: '[DRILL] Synthetic SMS runtime persistence test only.',
});

async function installStaffRoster(
  database: PostgresDatabase,
  input: Readonly<{
    snapshotId: string;
    version: number;
    recipients: readonly Readonly<{
      recipientId: string;
      endpointId: string;
      email: string;
      index: number;
    }>[];
  }>,
): Promise<void> {
  const capturedAt = new Date(VERIFIED_AT);
  await database.transaction(async (transaction) => {
    await transaction.insert(rosterSnapshots).values({
      id: input.snapshotId,
      version: input.version,
      population: 'staff',
      complete: true,
      sourceConfigurationId: fixture.rosterConfigurationId,
      sourceConfigurationVersion: 1,
      syncStartedAt: capturedAt,
      capturedAt,
    });
    await transaction.insert(rosterSnapshotFacilities).values({
      rosterSnapshotId: input.snapshotId,
      facilityId: FACILITY_ID,
    });
    await transaction.insert(rosterSnapshotSources).values([
      {
        rosterSnapshotId: input.snapshotId,
        population: 'staff',
        groupSourceId: fixture.groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'expected',
      },
      {
        rosterSnapshotId: input.snapshotId,
        population: 'staff',
        groupSourceId: fixture.groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(rosterRecipients).values(
      input.recipients.map((recipient) => ({
        id: recipient.recipientId,
        rosterSnapshotId: input.snapshotId,
        population: 'staff' as const,
        googleSubject: `synthetic-email-runtime-${input.version}-${recipient.index}`,
        staffEmail: `email-runtime-${input.version}-${recipient.index}@example.invalid`,
        displayName: `Synthetic Email Runtime Recipient ${recipient.index}`,
      })),
    );
    await transaction.insert(rosterRecipientGroupSources).values(
      input.recipients.map((recipient) => ({
        rosterSnapshotId: input.snapshotId,
        recipientId: recipient.recipientId,
        population: 'staff' as const,
        groupSourceId: fixture.groupSourceId,
        groupSourceKind: 'google-group' as const,
        groupPurpose: 'building' as const,
      })),
    );
    await transaction.insert(rosterEndpoints).values(
      input.recipients.map((recipient) => ({
        id: recipient.endpointId,
        rosterSnapshotId: input.snapshotId,
        recipientId: recipient.recipientId,
        population: 'staff' as const,
        channel: 'email' as const,
        status: 'active' as const,
        capturedAt,
        platform: null,
        token: null,
        email: recipient.email,
        phoneNumber: null,
      })),
    );
  });
}

async function installNotificationBundle(
  database: PostgresDatabase,
  snapshotId: string,
  emailEndpointCount: number,
): Promise<NotificationBundle> {
  const ids = Object.freeze({
    event: randomUUID(),
    intent: randomUUID(),
    outbox: randomUUID(),
    batch: randomUUID(),
    request: randomUUID(),
  });
  const createdAt = new Date(CREATED_AT);
  const authorization = humanAuthorization(ids.request);
  const channels = Object.freeze([
    Object.freeze({
      channel: 'push' as const,
      endpointCount: 1,
      renderedMessage: pushMessage,
      integrationStatus: integrationTruth.push,
    }),
    Object.freeze({
      channel: 'email' as const,
      endpointCount: emailEndpointCount,
      renderedMessage: emailMessage,
      integrationStatus: integrationTruth.email,
    }),
    Object.freeze({
      channel: 'sms' as const,
      endpointCount: 1,
      renderedMessage: smsMessage,
      integrationStatus: integrationTruth.sms,
    }),
  ]);
  const message = NotificationOutboxMessageSchema.parse({
    version: 2,
    facilityId: FACILITY_ID,
    outboxId: ids.outbox,
    intentId: ids.intent,
    eventId: ids.event,
    eventKind: 'drill',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: EVENT_TYPE_VERSION_ID,
      templateMode: 'drill',
    },
    rosterSnapshotId: snapshotId,
    rosterPopulation: 'staff',
    requestId: ids.request,
    authorization,
    channels,
    createdAt: CREATED_AT,
  });
  const batch = DispatchBatchSchema.parse({
    id: ids.batch,
    intentId: ids.intent,
    eventId: ids.event,
    facilityId: FACILITY_ID,
    eventKind: 'drill',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: EVENT_TYPE_VERSION_ID,
      templateMode: 'drill',
    },
    rosterSnapshotId: snapshotId,
    rosterPopulation: 'staff',
    requestId: ids.request,
    authorization,
    channel: 'email',
    renderedMessage: emailMessage,
    integrationStatus: integrationTruth.email,
    sequence: 2,
    endpointCount: emailEndpointCount,
    createdAt: BATCH_CREATED_AT,
  });

  await database.transaction(async (transaction) => {
    await transaction.insert(events).values({
      id: ids.event,
      facilityId: FACILITY_ID,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersionId: EVENT_TYPE_VERSION_ID,
      status: 'active',
      rosterSnapshotId: snapshotId,
      rosterPopulation: 'staff',
      createdBy: {
        kind: 'human',
        userId: fixture.userId,
        sessionId: fixture.sessionId,
      },
      createdAt,
      activatedAt: createdAt,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: authorization,
    });
    await transaction.insert(notificationIntents).values({
      id: ids.intent,
      eventId: ids.event,
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: EVENT_TYPE_VERSION_ID,
      rosterSnapshotId: snapshotId,
      rosterPopulation: 'staff',
      createdBy: {
        kind: 'human',
        userId: fixture.userId,
        sessionId: fixture.sessionId,
      },
      source: 'web',
      requestId: ids.request,
      authorization,
      createdAt,
    });
    await transaction.insert(notificationIntentChannels).values([
      {
        intentId: ids.intent,
        sequence: 1,
        channel: 'push',
        eventKind: 'drill',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'staff',
        classificationMarker: 'DRILL',
        endpointCount: 1,
        renderedMessage: pushMessage,
        integrationStatusId: fixture.pushStatusId,
        integrationId: 'expo-push',
        integrationLabel: 'live-verified',
      },
      {
        intentId: ids.intent,
        sequence: 2,
        channel: 'email',
        eventKind: 'drill',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'staff',
        classificationMarker: 'DRILL',
        endpointCount: emailEndpointCount,
        renderedMessage: emailMessage,
        integrationStatusId: fixture.emailStatusId,
        integrationId: 'ses-email',
        integrationLabel: 'live-verified',
      },
      {
        intentId: ids.intent,
        sequence: 3,
        channel: 'sms',
        eventKind: 'drill',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'staff',
        classificationMarker: 'DRILL',
        endpointCount: 1,
        renderedMessage: smsMessage,
        integrationStatusId: fixture.smsStatusId,
        integrationId: 'aws-eum-sms',
        integrationLabel: 'live-verified',
      },
    ]);
    await transaction.insert(outbox).values({
      id: ids.outbox,
      messageVersion: 2,
      intentId: ids.intent,
      eventId: ids.event,
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: EVENT_TYPE_VERSION_ID,
      rosterSnapshotId: snapshotId,
      rosterPopulation: 'staff',
      requestId: ids.request,
      authorization,
      channels,
      message,
      status: 'published',
      attempts: 1,
      availableAt: createdAt,
      lockedUntil: null,
      publishedAt: createdAt,
      failedAt: null,
      lastErrorCode: null,
      createdAt,
    });
    await transaction.insert(dispatchBatches).values({
      id: ids.batch,
      outboxId: ids.outbox,
      intentId: ids.intent,
      eventId: ids.event,
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: EVENT_TYPE_VERSION_ID,
      rosterSnapshotId: snapshotId,
      rosterPopulation: 'staff',
      requestId: ids.request,
      authorization,
      channel: 'email',
      renderedMessage: emailMessage,
      integrationStatusId: fixture.emailStatusId,
      integrationId: 'ses-email',
      integrationLabel: 'live-verified',
      sequence: 2,
      endpointCount: emailEndpointCount,
      createdAt: new Date(BATCH_CREATED_AT),
    });
  });

  return Object.freeze({ batch });
}

describeWithDatabase('PostgreSQL email runtime store', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for email runtime tests.');
    }
    const owned = await createDisposableDatabase(
      'psd_eoc_email_runtime',
      baseTestDatabaseUrl,
    );
    ownedDatabase = owned;
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: owned.url,
      maxConnections: 4,
    });
    if (opened.driver !== 'postgres') {
      throw new Error(
        'The email runtime integration test requires PostgreSQL.',
      );
    }
    connection = opened;
    try {
      await migrateDatabase(opened);
      await seedDatabase(opened.db);
      await opened.db.transaction(async (transaction) => {
        await transaction.insert(users).values({
          id: fixture.userId,
          googleSubject: `synthetic-email-runtime-${fixture.userId}`,
          email: `email-runtime-${fixture.userId}@example.invalid`,
          displayName: 'Synthetic Email Runtime Verifier',
          facilityScopeKind: 'district',
          createdAt: new Date(VERIFIED_AT),
          disabledAt: null,
        });
        await transaction.insert(integrationStatuses).values([
          {
            id: fixture.pushStatusId,
            ...integrationTruth.push,
            verifiedAt: new Date(integrationTruth.push.verifiedAt!),
            observedAt: new Date(integrationTruth.push.observedAt),
          },
          {
            id: fixture.emailStatusId,
            ...integrationTruth.email,
            verifiedAt: new Date(integrationTruth.email.verifiedAt!),
            observedAt: new Date(integrationTruth.email.observedAt),
          },
          {
            id: fixture.smsStatusId,
            ...integrationTruth.sms,
            verifiedAt: new Date(integrationTruth.sms.verifiedAt!),
            observedAt: new Date(integrationTruth.sms.observedAt),
          },
        ]);
        await transaction
          .update(channelConfigurations)
          .set({
            enabled: true,
            statusId: fixture.emailStatusId,
            statusLabel: 'live-verified',
            changedAt: new Date(VERIFIED_AT),
          })
          .where(eq(channelConfigurations.integrationId, 'ses-email'));
        await transaction.insert(groupSources).values({
          id: fixture.groupSourceId,
          kind: 'google-group',
          purpose: 'building',
          facilityId: FACILITY_ID,
          displayName: 'Synthetic SMS Runtime Staff',
          active: true,
          grantedRole: null,
          membersCapturedAt: new Date(VERIFIED_AT),
          googleGroupId: `synthetic-email-runtime-${fixture.groupSourceId}`,
          email: `email-runtime-group-${fixture.groupSourceId}@example.invalid`,
          fixtureKey: null,
          createdAt: new Date(VERIFIED_AT),
        });
        await transaction.insert(rosterSourceConfigurations).values({
          id: fixture.rosterConfigurationId,
          version: 1,
          population: 'staff',
          createdAt: new Date(VERIFIED_AT),
        });
        await transaction.insert(rosterSourceConfigurationFacilities).values({
          configurationId: fixture.rosterConfigurationId,
          configurationVersion: 1,
          facilityId: FACILITY_ID,
        });
        await transaction.insert(rosterSourceConfigurationGroups).values({
          configurationId: fixture.rosterConfigurationId,
          configurationVersion: 1,
          population: 'staff',
          groupSourceId: fixture.groupSourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        });
      });
      await installStaffRoster(opened.db, {
        snapshotId: fixture.ordinarySnapshotId,
        version: 1,
        recipients: ordinaryRecipients,
      });
      await installStaffRoster(opened.db, {
        snapshotId: fixture.pagedSnapshotId,
        version: 2,
        recipients: pagedRecipients,
      });
      ordinaryBundle = await installNotificationBundle(
        opened.db,
        fixture.ordinarySnapshotId,
        ORDINARY_ENDPOINT_COUNT,
      );
      pagedBundle = await installNotificationBundle(
        opened.db,
        fixture.pagedSnapshotId,
        PAGED_ENDPOINT_COUNT,
      );
    } catch (error) {
      await closeAndDropDisposableDatabase(() => opened.close(), ownedDatabase);
      connection = undefined;
      ownedDatabase = undefined;
      throw error;
    }
  });

  afterAll(async () => {
    const opened = connection;
    const owned = ownedDatabase;
    connection = undefined;
    ownedDatabase = undefined;
    ordinaryBundle = undefined;
    pagedBundle = undefined;
    await closeAndDropDisposableDatabase(
      opened === undefined ? undefined : () => opened.close(),
      owned,
    );
  });

  test('an ordinary activation reaches every recipient, not only a lone one', async () => {
    const store = runtimeStore();
    const { batch } = installedOrdinaryBundle();
    const page = EmailBatchResolutionPageSchema.parse(
      await store.resolveBatch({
        operation: 'resolve-batch',
        verificationReference: EMAIL_AUTHORIZATION_REFERENCE,
        batch,
        enqueuedAt: BATCH_CREATED_AT,
        cursor: 0,
      }),
    );

    // The regression this covers: resolveBatch used to return zero items for
    // any audience that was not exactly one address, and report the whole
    // send as suppressed. A drill to three staff reached nobody.
    expect(page.items).toHaveLength(ORDINARY_ENDPOINT_COUNT);
    expect(page.suppressedCount).toBe(0);
    expect(page.nextCursor).toBeNull();
    expect(
      page.items.map((item) => emailAddress(item.endpoint)).sort(),
    ).toEqual(ordinaryRecipients.map((r) => r.email).sort());
  });

  test('authorizes a send that is not the only endpoint in its batch', async () => {
    const store = runtimeStore();
    const { batch } = installedOrdinaryBundle();
    const page = EmailBatchResolutionPageSchema.parse(
      await store.resolveBatch({
        operation: 'resolve-batch',
        verificationReference: EMAIL_AUTHORIZATION_REFERENCE,
        batch,
        enqueuedAt: BATCH_CREATED_AT,
        cursor: 0,
      }),
    );

    // Authorization rebuilt the expected work item and required the batch to
    // hold exactly one endpoint, so every recipient of a multi-address send
    // was refused even once resolution returned them.
    for (const item of page.items) {
      expect(await store.authorizeProviderSend(item)).toBe(true);
    }
  });

  test('pages a large audience and stops at the end', async () => {
    const store = runtimeStore();
    const { batch } = installedPagedBundle();
    const first = EmailBatchResolutionPageSchema.parse(
      await store.resolveBatch({
        operation: 'resolve-batch',
        verificationReference: EMAIL_AUTHORIZATION_REFERENCE,
        batch,
        enqueuedAt: BATCH_CREATED_AT,
        cursor: 0,
      }),
    );
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe(50);

    const second = EmailBatchResolutionPageSchema.parse(
      await store.resolveBatch({
        operation: 'resolve-batch',
        verificationReference: EMAIL_AUTHORIZATION_REFERENCE,
        batch,
        enqueuedAt: BATCH_CREATED_AT,
        cursor: first.nextCursor!,
      }),
    );
    expect(second.items).toHaveLength(PAGED_ENDPOINT_COUNT - 50);
    expect(second.nextCursor).toBeNull();

    const reached = [...first.items, ...second.items].map((item) =>
      emailAddress(item.endpoint),
    );
    expect(new Set(reached).size).toBe(PAGED_ENDPOINT_COUNT);
  });

  test('keeps the cursor stable when an address is suppressed between pages', async () => {
    const store = runtimeStore();
    const { batch } = installedPagedBundle();
    const first = EmailBatchResolutionPageSchema.parse(
      await store.resolveBatch({
        operation: 'resolve-batch',
        verificationReference: EMAIL_AUTHORIZATION_REFERENCE,
        batch,
        enqueuedAt: BATCH_CREATED_AT,
        cursor: 0,
      }),
    );
    expect(first.nextCursor).toBe(50);

    // Suppress somebody after the first page was read. The cursor indexes the
    // pinned snapshot, not the eligible set, so the final page must still
    // cover exactly the one remaining candidate slot.
    //
    // Indexing the eligible set instead would leave cursor 50 past the end of
    // a now-50-long list, and the last person in the roster would be silently
    // skipped with nothing reporting it.
    const victim = pagedRecipients[3]!;
    await databaseConnection().db.insert(endpointStatusRecords).values({
      rosterSnapshotId: fixture.pagedSnapshotId,
      recipientId: victim.recipientId,
      endpointId: victim.endpointId,
      population: 'staff',
      channel: 'email',
      status: 'invalid',
      reasonCode: 'SYNTHETIC_SUPPRESSION',
      provider: null,
      providerReference: null,
      providerOccurredAt: null,
      recordedAt: new Date(),
    });

    const second = EmailBatchResolutionPageSchema.parse(
      await store.resolveBatch({
        operation: 'resolve-batch',
        verificationReference: EMAIL_AUTHORIZATION_REFERENCE,
        batch,
        enqueuedAt: BATCH_CREATED_AT,
        cursor: first.nextCursor!,
      }),
    );
    expect(second.items.length + second.suppressedCount).toBe(
      PAGED_ENDPOINT_COUNT - 50,
    );
    expect(second.nextCursor).toBeNull();

    // Nobody is reached twice, and the suppressed address is not sent to.
    const reached = [...first.items, ...second.items].map((item) =>
      emailAddress(item.endpoint),
    );
    expect(new Set(reached).size).toBe(reached.length);
    expect(
      second.items.map((item) => emailAddress(item.endpoint)),
    ).not.toContain(victim.email);
  });
});
