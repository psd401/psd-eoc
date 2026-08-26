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
  IntegrationStatusSchema,
  NotificationOutboxMessageSchema,
  SMS_TOTAL_LIFETIME_SECONDS,
  type DispatchBatch,
  type IntegrationStatus,
  type SmsWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';
import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedDatabase } from '../../db/seed';
import {
  channelAttempts,
  channelConfigurations,
  deliveryEvidence,
  dispatchBatches,
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
  createDrizzleSmsRuntimeStore,
  readSmsRuntimeStoreConfiguration,
  SmsRuntimeStoreError,
  type SmsRuntimeStore,
} from './sms-runtime-store';

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
const CREATED_AT = '2026-08-26T12:00:00.000Z';
const BATCH_CREATED_AT = '2026-08-26T12:00:00.500Z';
const VERIFIED_AT = '2026-08-26T11:59:00.000Z';
const SMS_AUTHORIZATION_REFERENCE = 'carrier:case:279';
const SMALL_ENDPOINT_COUNT = 1;
const PAGED_ENDPOINT_COUNT = 51;

const fixture = Object.freeze({
  userId: randomUUID(),
  sessionId: randomUUID(),
  groupSourceId: randomUUID(),
  rosterConfigurationId: randomUUID(),
  smallSnapshotId: randomUUID(),
  pagedSnapshotId: randomUUID(),
  smallRecipientId: randomUUID(),
  smallEndpointId: randomUUID(),
  pushStatusId: randomUUID(),
  emailStatusId: randomUUID(),
  smsStatusId: randomUUID(),
});

const pagedRecipients = Object.freeze(
  Array.from({ length: PAGED_ENDPOINT_COUNT }, (_, index) =>
    Object.freeze({
      recipientId: randomUUID(),
      endpointId: randomUUID(),
      phoneNumber: `+1202555${String(1_000 + index)}`,
      index,
    }),
  ),
);

interface NotificationBundle {
  readonly batch: DispatchBatch;
}

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
let currentTime = Date.parse(CREATED_AT) + 1_000;
let smallBundle: NotificationBundle | undefined;
let pagedBundle: NotificationBundle | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The SMS runtime PostgreSQL test connection is not open.');
  }
  return connection;
}

function installedSmallBundle(): NotificationBundle {
  if (smallBundle === undefined) {
    throw new Error('The singleton SMS runtime fixture was not installed.');
  }
  return smallBundle;
}

function installedPagedBundle(): NotificationBundle {
  if (pagedBundle === undefined) {
    throw new Error('The paged SMS runtime fixture was not installed.');
  }
  return pagedBundle;
}

function runtimeStore(
  overrides: Readonly<{
    registrationVerificationReference?: string;
    destinationCountryCode?: 'US' | 'CA';
    now?: () => number;
  }> = {},
): SmsRuntimeStore {
  return createDrizzleSmsRuntimeStore(databaseConnection().db, {
    registrationVerificationReference:
      overrides.registrationVerificationReference ?? 'carrier:case:279',
    destinationCountryCode: overrides.destinationCountryCode ?? 'US',
    now: overrides.now ?? (() => currentTime),
  });
}

function liveIntegrationStatus(
  integrationId: 'expo-push' | 'ses-email' | 'aws-eum-sms',
): IntegrationStatus {
  const authorizationReference =
    integrationId === 'aws-eum-sms'
      ? SMS_AUTHORIZATION_REFERENCE
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
      phoneNumber: string;
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
        googleSubject: `synthetic-sms-runtime-${input.version}-${recipient.index}`,
        staffEmail: `sms-runtime-${input.version}-${recipient.index}@example.invalid`,
        displayName: `Synthetic SMS Runtime Recipient ${recipient.index}`,
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
        channel: 'sms' as const,
        status: 'active' as const,
        capturedAt,
        platform: null,
        token: null,
        email: null,
        phoneNumber: recipient.phoneNumber,
      })),
    );
  });
}

async function installNotificationBundle(
  database: PostgresDatabase,
  snapshotId: string,
  smsEndpointCount: number,
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
      endpointCount: 1,
      renderedMessage: emailMessage,
      integrationStatus: integrationTruth.email,
    }),
    Object.freeze({
      channel: 'sms' as const,
      endpointCount: smsEndpointCount,
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
    channel: 'sms',
    renderedMessage: smsMessage,
    integrationStatus: integrationTruth.sms,
    sequence: 3,
    endpointCount: smsEndpointCount,
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
        endpointCount: 1,
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
        endpointCount: smsEndpointCount,
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
      channel: 'sms',
      renderedMessage: smsMessage,
      integrationStatusId: fixture.smsStatusId,
      integrationId: 'aws-eum-sms',
      integrationLabel: 'live-verified',
      sequence: 3,
      endpointCount: smsEndpointCount,
      createdAt: new Date(BATCH_CREATED_AT),
    });
  });

  return Object.freeze({ batch });
}

async function persistAttempt(
  database: PostgresDatabase,
  workItem: SmsWorkerAttemptWorkItem,
): Promise<void> {
  await database
    .insert(channelAttempts)
    .values({
      id: workItem.attempt.id,
      batchId: workItem.attempt.batchId,
      intentId: workItem.attempt.intentId,
      eventId: workItem.attempt.eventId,
      eventKind: workItem.attempt.eventKind,
      templateMode: workItem.attempt.templateMode,
      purpose: workItem.attempt.purpose,
      eventTypeVersionId: workItem.attempt.eventTypeVersion.id,
      rosterSnapshotId: workItem.attempt.rosterSnapshotId,
      rosterPopulation: workItem.attempt.rosterPopulation,
      recipientId: workItem.attempt.recipientId,
      endpointId: workItem.attempt.endpointId,
      channel: workItem.attempt.channel,
      attemptNumber: workItem.attempt.attemptNumber,
      attemptedAt: new Date(workItem.attempt.attemptedAt),
    })
    .onConflictDoNothing({ target: channelAttempts.id });
}

async function resolvedSmallWorkItem(
  store: SmsRuntimeStore = runtimeStore(),
): Promise<SmsWorkerAttemptWorkItem> {
  const bundle = installedSmallBundle();
  const resolution = await store.resolveBatch({
    operation: 'resolve-batch',
    batch: bundle.batch,
    enqueuedAt: new Date(Date.parse(CREATED_AT) + 1_000).toISOString(),
    cursor: 0,
  });
  if (resolution.kind !== 'ready' || resolution.items[0] === undefined) {
    throw new Error('The singleton SMS runtime work item was unavailable.');
  }
  return resolution.items[0];
}

async function expectStoreError(
  operation: () => Promise<unknown>,
  code: SmsRuntimeStoreError['code'],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SmsRuntimeStoreError);
    expect((error as SmsRuntimeStoreError).code).toBe(code);
    return;
  }
  throw new Error(`Expected SMS runtime store error ${code}.`);
}

function optOutInput(workItem: SmsWorkerAttemptWorkItem, suffix: string) {
  return {
    operation: 'record-sms-opt-out' as const,
    context: {
      actor: {
        kind: 'system' as const,
        serviceId: 'sms-worker' as const,
      },
      source: 'worker' as const,
      transport: 'sqs' as const,
      requestId: randomUUID(),
      authenticated: true as const,
    },
    input: {
      rosterSnapshotId: workItem.attempt.rosterSnapshotId,
      recipientId: workItem.attempt.recipientId,
      endpointId: workItem.attempt.endpointId,
      provider: 'aws-eum-sms' as const,
      providerReference: `synthetic-stop-${suffix}`,
      providerOccurredAt: new Date(
        Date.parse(CREATED_AT) + 2_000,
      ).toISOString(),
    },
  };
}

describe('SMS runtime store configuration', () => {
  test('treats carrier registration evidence as readiness configuration only', () => {
    expect(
      readSmsRuntimeStoreConfiguration({
        PSD_EOC_SMS_REGISTRATION_VERIFICATION_REFERENCE: 'carrier:case:279',
        PSD_EOC_SMS_DESTINATION_COUNTRY_CODE: 'US',
      }),
    ).toEqual({
      registrationVerificationReference: 'carrier:case:279',
      destinationCountryCode: 'US',
    });
  });
});

describeWithDatabase('PostgreSQL SMS runtime store', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for SMS runtime tests.');
    }
    const owned = await createDisposableDatabase(
      'psd_eoc_sms_runtime',
      baseTestDatabaseUrl,
    );
    ownedDatabase = owned;
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: owned.url,
      maxConnections: 4,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('The SMS runtime integration test requires PostgreSQL.');
    }
    connection = opened;
    try {
      await migrateDatabase(opened);
      await seedDatabase(opened.db);
      await opened.db.transaction(async (transaction) => {
        await transaction.insert(users).values({
          id: fixture.userId,
          googleSubject: `synthetic-sms-runtime-${fixture.userId}`,
          email: `sms-runtime-${fixture.userId}@example.invalid`,
          displayName: 'Synthetic SMS Runtime Verifier',
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
            statusId: fixture.smsStatusId,
            statusLabel: 'live-verified',
            changedAt: new Date(VERIFIED_AT),
          })
          .where(eq(channelConfigurations.integrationId, 'aws-eum-sms'));
        await transaction.insert(groupSources).values({
          id: fixture.groupSourceId,
          kind: 'google-group',
          purpose: 'building',
          facilityId: FACILITY_ID,
          displayName: 'Synthetic SMS Runtime Staff',
          active: true,
          grantedRole: null,
          membersCapturedAt: new Date(VERIFIED_AT),
          googleGroupId: `synthetic-sms-runtime-${fixture.groupSourceId}`,
          email: `sms-runtime-group-${fixture.groupSourceId}@example.invalid`,
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
        snapshotId: fixture.smallSnapshotId,
        version: 1,
        recipients: [
          {
            recipientId: fixture.smallRecipientId,
            endpointId: fixture.smallEndpointId,
            phoneNumber: '+12025550100',
            index: 0,
          },
        ],
      });
      await installStaffRoster(opened.db, {
        snapshotId: fixture.pagedSnapshotId,
        version: 2,
        recipients: pagedRecipients,
      });
      smallBundle = await installNotificationBundle(
        opened.db,
        fixture.smallSnapshotId,
        SMALL_ENDPOINT_COUNT,
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
    smallBundle = undefined;
    pagedBundle = undefined;
    await closeAndDropDisposableDatabase(
      opened === undefined ? undefined : () => opened.close(),
      owned,
    );
  });

  test('durably claims, completes, replays, and rejects conflicting provider I/O', async () => {
    currentTime = Date.parse(CREATED_AT) + 1_000;
    const workItem = await resolvedSmallWorkItem();
    await persistAttempt(databaseConnection().db, workItem);
    const fingerprint = 'a'.repeat(64);
    const completion = Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        state: 'provider-accepted' as const,
        provider: 'aws-eum-sms',
        providerReference: 'synthetic-provider-reference-279',
        proof: null,
        reasonCode: null,
        diagnosticDigest: null,
      }),
    });
    const store = runtimeStore();

    await expect(
      store.lookupProviderIo({
        attemptId: workItem.attempt.id,
        workFingerprint: fingerprint,
      }),
    ).resolves.toEqual({ kind: 'missing' });
    const claim = await store.claimProviderIo({
      attemptId: workItem.attempt.id,
      workFingerprint: fingerprint,
    });
    if (claim.kind !== 'acquired') {
      throw new Error('The SMS provider-I/O claim was not acquired.');
    }
    await expect(
      runtimeStore().claimProviderIo({
        attemptId: workItem.attempt.id,
        workFingerprint: fingerprint,
      }),
    ).resolves.toEqual({ kind: 'indeterminate' });

    await store.completeProviderIo({
      attemptId: workItem.attempt.id,
      workFingerprint: fingerprint,
      claimToken: claim.claimToken,
      completion,
    });
    await runtimeStore().completeProviderIo({
      attemptId: workItem.attempt.id,
      workFingerprint: fingerprint,
      claimToken: claim.claimToken,
      completion,
    });
    await expect(
      runtimeStore().lookupProviderIo({
        attemptId: workItem.attempt.id,
        workFingerprint: fingerprint,
      }),
    ).resolves.toEqual({ kind: 'completed', completion });
    await expect(
      runtimeStore().claimProviderIo({
        attemptId: workItem.attempt.id,
        workFingerprint: fingerprint,
      }),
    ).resolves.toEqual({ kind: 'completed', completion });

    await expectStoreError(
      () =>
        runtimeStore().lookupProviderIo({
          attemptId: workItem.attempt.id,
          workFingerprint: 'b'.repeat(64),
        }),
      'PROVIDER_IO_CONFLICT',
    );
    await expectStoreError(
      () =>
        runtimeStore().completeProviderIo({
          attemptId: workItem.attempt.id,
          workFingerprint: fingerprint,
          claimToken: claim.claimToken,
          completion: {
            kind: 'provider-error',
            code: 'SYNTHETIC_CONFLICT',
            disposition: 'terminal-failure',
            diagnosticDigest: null,
          },
        }),
      'PROVIDER_IO_COMPLETION_CONFLICT',
    );
  });

  test('persists deterministic retry replay and resolves not-before, ready, conflict, and expiry', async () => {
    currentTime = Date.parse(CREATED_AT) + 1_000;
    const workItem = await resolvedSmallWorkItem();
    await persistAttempt(databaseConnection().db, workItem);
    const request = {
      operation: 'schedule-retry' as const,
      sourceAttempt: workItem.attempt,
      sourceFingerprint: 'c'.repeat(64),
      nextAttemptNumber: 2,
      delayMilliseconds: 60_000,
      reasonCode: 'SMS_SYNTHETIC_RETRY',
    };
    const first = await runtimeStore().scheduleRetry(request);
    const replay = await runtimeStore().scheduleRetry(request);
    expect(replay).toEqual(first);
    if (first.kind !== 'scheduled') {
      throw new Error('The SMS retry was not scheduled.');
    }

    await expect(runtimeStore().resolveRetry(first.attemptId)).resolves.toEqual(
      {
        kind: 'not-before',
        retryAt: first.retryAt,
      },
    );
    await expectStoreError(
      () =>
        runtimeStore().scheduleRetry({
          ...request,
          reasonCode: 'SMS_DIFFERENT_RETRY',
        }),
      'RETRY_CONFLICT',
    );

    currentTime = Date.parse(first.retryAt) + 1;
    const ready = await runtimeStore().resolveRetry(first.attemptId);
    expect(ready).toMatchObject({
      kind: 'ready',
      workItem: {
        attempt: {
          id: first.attemptId,
          attemptNumber: 2,
          recipientId: workItem.attempt.recipientId,
          endpointId: workItem.attempt.endpointId,
        },
      },
    });

    currentTime =
      Date.parse(BATCH_CREATED_AT) + SMS_TOTAL_LIFETIME_SECONDS * 1_000;
    await expect(runtimeStore().resolveRetry(first.attemptId)).resolves.toEqual(
      {
        kind: 'expired',
      },
    );
    await expect(runtimeStore().scheduleRetry(request)).resolves.toEqual({
      kind: 'expired',
    });
  });

  test('binds unknown receipt recovery to the provider claim and correlates repeated MessageId evidence once', async () => {
    currentTime = Date.parse(CREATED_AT) + 1_000;
    const resolution = await runtimeStore().resolveBatch({
      operation: 'resolve-batch',
      batch: installedPagedBundle().batch,
      enqueuedAt: new Date(currentTime).toISOString(),
      cursor: 0,
    });
    if (resolution.kind !== 'ready' || resolution.items[0] === undefined) {
      throw new Error('The receipt-correlation work item was unavailable.');
    }
    const workItem = resolution.items[0];
    await persistAttempt(databaseConnection().db, workItem);
    const claim = await runtimeStore().claimProviderIo({
      attemptId: workItem.attempt.id,
      workFingerprint: 'e'.repeat(64),
    });
    if (claim.kind !== 'acquired') {
      throw new Error(
        'The receipt-correlation provider claim was unavailable.',
      );
    }
    const attemptedId = randomUUID();
    const unknownId = randomUUID();
    const acceptedId = randomUUID();
    const providerReference = 'synthetic-repeated-message-id-279';
    await databaseConnection()
      .db.insert(deliveryEvidence)
      .values({
        id: attemptedId,
        subjectKind: 'attempt',
        subjectId: workItem.attempt.id,
        intentId: null,
        attemptId: workItem.attempt.id,
        sequence: 1,
        previousEvidenceId: null,
        state: 'attempted',
        recordedAt: new Date(currentTime),
        provider: null,
        providerReference: null,
        proof: null,
        reasonCode: null,
        diagnosticDigest: null,
      });
    await expect(
      runtimeStore().loadUnknownAttempt(workItem.attempt.id, claim.claimToken),
    ).resolves.toBeNull();
    await expect(
      runtimeStore().loadUnknownAttempt(workItem.attempt.id, randomUUID()),
    ).resolves.toBeNull();

    await databaseConnection()
      .db.insert(deliveryEvidence)
      .values([
        {
          id: unknownId,
          subjectKind: 'attempt',
          subjectId: workItem.attempt.id,
          intentId: null,
          attemptId: workItem.attempt.id,
          sequence: 2,
          previousEvidenceId: attemptedId,
          state: 'unknown',
          recordedAt: new Date(currentTime + 1_000),
          provider: 'aws-eum-sms',
          providerReference: null,
          proof: null,
          reasonCode: 'AWS_SEND_AMBIGUOUS',
          diagnosticDigest: null,
        },
      ]);
    await expect(
      runtimeStore().loadUnknownAttempt(workItem.attempt.id, claim.claimToken),
    ).resolves.toMatchObject({ id: workItem.attempt.id });

    await databaseConnection()
      .db.insert(deliveryEvidence)
      .values([
        {
          id: acceptedId,
          subjectKind: 'attempt',
          subjectId: workItem.attempt.id,
          intentId: null,
          attemptId: workItem.attempt.id,
          sequence: 3,
          previousEvidenceId: unknownId,
          state: 'provider-accepted',
          recordedAt: new Date(currentTime + 2_000),
          provider: 'aws-eum-sms',
          providerReference,
          proof: null,
          reasonCode: null,
          diagnosticDigest: null,
        },
        {
          id: randomUUID(),
          subjectKind: 'attempt',
          subjectId: workItem.attempt.id,
          intentId: null,
          attemptId: workItem.attempt.id,
          sequence: 4,
          previousEvidenceId: acceptedId,
          state: 'delivered',
          recordedAt: new Date(currentTime + 3_000),
          provider: 'aws-eum-sms',
          providerReference,
          proof: {
            kind: 'provider-delivery-receipt',
            provider: 'aws-eum-sms',
            receiptId: 'synthetic-receipt-279',
            deliveredAt: new Date(currentTime + 2_500).toISOString(),
          },
          reasonCode: null,
          diagnosticDigest: null,
        },
      ]);
    await expect(
      runtimeStore().loadAttemptByProviderReference(providerReference),
    ).resolves.toMatchObject({ id: workItem.attempt.id });
    await expect(
      runtimeStore().loadUnknownAttempt(workItem.attempt.id, claim.claimToken),
    ).resolves.toBeNull();
  });

  test('rejects stale batch identity and enqueue time while expiring the exact retained batch', async () => {
    currentTime = Date.parse(CREATED_AT) + 1_000;
    const bundle = installedSmallBundle();
    await expectStoreError(
      () =>
        runtimeStore().resolveBatch({
          operation: 'resolve-batch',
          batch: { ...bundle.batch, endpointCount: 2 },
          enqueuedAt: new Date(Date.parse(CREATED_AT) + 1_000).toISOString(),
          cursor: 0,
        }),
      'BATCH_CONFLICT',
    );
    await expectStoreError(
      () =>
        runtimeStore().resolveBatch({
          operation: 'resolve-batch',
          batch: bundle.batch,
          enqueuedAt: new Date(Date.parse(CREATED_AT) - 1).toISOString(),
          cursor: 0,
        }),
      'BATCH_CONFLICT',
    );
    await expect(
      runtimeStore({
        now: () =>
          Date.parse(BATCH_CREATED_AT) + SMS_TOTAL_LIFETIME_SECONDS * 1_000,
      }).resolveBatch({
        operation: 'resolve-batch',
        batch: bundle.batch,
        enqueuedAt: new Date(Date.parse(CREATED_AT) + 1_000).toISOString(),
        cursor: 0,
      }),
    ).resolves.toEqual({ kind: 'expired' });
  });

  test('authorizes only the exact provider reference, destination country, and currently eligible endpoint', async () => {
    currentTime = Date.parse(CREATED_AT) + 1_000;
    const workItem = await resolvedSmallWorkItem();
    await persistAttempt(databaseConnection().db, workItem);
    const liveContext = {
      attemptId: workItem.attempt.id,
      batchId: workItem.batch.id,
      eventId: workItem.batch.eventId,
      eventKind: workItem.batch.eventKind,
      templateMode: workItem.batch.templateMode,
      purpose: workItem.batch.purpose,
      requestId: workItem.batch.requestId,
      authorizationKind: workItem.batch.authorization.kind,
      integrationAuthorizationReference: SMS_AUTHORIZATION_REFERENCE,
    };

    await expect(
      runtimeStore().authorizeProviderSend(workItem),
    ).resolves.toEqual({ authorized: true, timeToLiveSeconds: 299 });
    await expect(
      runtimeStore({
        registrationVerificationReference: 'carrier:case:different',
      }).authorizeProviderSend(workItem),
    ).resolves.toEqual({ authorized: true, timeToLiveSeconds: 299 });
    await expect(
      runtimeStore({ destinationCountryCode: 'CA' }).authorizeProviderSend(
        workItem,
      ),
    ).resolves.toEqual({ authorized: false });
    await expect(runtimeStore().authorizeLiveSend(liveContext)).resolves.toBe(
      true,
    );
    await expect(
      runtimeStore().authorizeLiveSend({
        ...liveContext,
        integrationAuthorizationReference: 'carrier:case:different',
      }),
    ).resolves.toBe(false);

    currentTime =
      Date.parse(BATCH_CREATED_AT) + (SMS_TOTAL_LIFETIME_SECONDS - 5) * 1_000;
    await expect(
      runtimeStore().authorizeProviderSend(workItem),
    ).resolves.toEqual({ authorized: true, timeToLiveSeconds: 5 });
    currentTime += 1;
    await expect(
      runtimeStore().authorizeProviderSend(workItem),
    ).resolves.toEqual({ authorized: false });
    currentTime = Date.parse(CREATED_AT) + 1_000;

    await runtimeStore().executeLifecycle(optOutInput(workItem, 'eligibility'));
    await expect(
      runtimeStore().authorizeProviderSend(workItem),
    ).resolves.toEqual({ authorized: false });
  });

  test('keeps the immutable 50-row cursor stable when current eligibility changes between pages', async () => {
    currentTime = Date.parse(CREATED_AT) + 1_000;
    const store = runtimeStore();
    const bundle = installedPagedBundle();
    const request = {
      operation: 'resolve-batch' as const,
      batch: bundle.batch,
      enqueuedAt: new Date(Date.parse(CREATED_AT) + 1_000).toISOString(),
    };
    const first = await store.resolveBatch({ ...request, cursor: 0 });
    if (
      first.kind !== 'ready' ||
      first.nextCursor !== 50 ||
      first.items[0] === undefined
    ) {
      throw new Error('The first stable SMS runtime page was unavailable.');
    }
    expect(first.items).toHaveLength(50);

    await store.executeLifecycle(optOutInput(first.items[0], 'between-pages'));
    const second = await store.resolveBatch({ ...request, cursor: 50 });
    if (second.kind !== 'ready') {
      throw new Error('The second stable SMS runtime page was unavailable.');
    }
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.items, ...second.items].map(
          (item) => item.attempt.endpointId,
        ),
      ).size,
    ).toBe(PAGED_ENDPOINT_COUNT);

    const replayedFirst = await store.resolveBatch({ ...request, cursor: 0 });
    expect(replayedFirst).toMatchObject({
      kind: 'ready',
      nextCursor: 50,
    });
    if (replayedFirst.kind !== 'ready') {
      throw new Error('The replayed first SMS runtime page was unavailable.');
    }
    expect(replayedFirst.items).toHaveLength(49);
  });

  test('denies an eligible queued activation after its event leaves the authorized lifecycle', async () => {
    currentTime = Date.parse(CREATED_AT) + 1_000;
    const resolution = await runtimeStore().resolveBatch({
      operation: 'resolve-batch',
      batch: installedPagedBundle().batch,
      enqueuedAt: new Date(currentTime).toISOString(),
      cursor: 0,
    });
    if (resolution.kind !== 'ready' || resolution.items[0] === undefined) {
      throw new Error('The lifecycle authorization work item was unavailable.');
    }
    const workItem = resolution.items[0];
    await persistAttempt(databaseConnection().db, workItem);
    await databaseConnection()
      .db.update(events)
      .set({ status: 'all-clear', allClearAt: new Date(currentTime) })
      .where(eq(events.id, workItem.batch.eventId));

    await expect(
      runtimeStore().authorizeProviderSend(workItem),
    ).resolves.toEqual({ authorized: false });
    await expect(
      runtimeStore().authorizeLiveSend({
        attemptId: workItem.attempt.id,
        batchId: workItem.batch.id,
        eventId: workItem.batch.eventId,
        eventKind: workItem.batch.eventKind,
        templateMode: workItem.batch.templateMode,
        purpose: workItem.batch.purpose,
        requestId: workItem.batch.requestId,
        authorizationKind: workItem.batch.authorization.kind,
        integrationAuthorizationReference: SMS_AUTHORIZATION_REFERENCE,
      }),
    ).resolves.toBe(false);
  });
});
