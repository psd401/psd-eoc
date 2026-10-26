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
  ChannelAttemptSchema,
  PushEndpointSendEligibilityInputSchema,
  type ChannelAttempt,
  type DispatchBatch,
  type EmailWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  SesV2EmailAdapter,
  SES_PARTNER_CONFIGURATION_SET_NAME,
  type SesV2SendEmailInput,
} from '../../../../workers/email/ses-adapter';
import {
  createDatabaseClient,
  type Database,
  type DatabaseQuery,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  channelAttempts,
  channelConfigurations,
  connectivityEpochs,
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  eventTypes,
  eventTypeVersions,
  groupSources,
  humanConfirmationActions,
  humanConfirmationRecords,
  outbox,
  partnerAdmissionEndings,
  partnerAdmissions,
  partnerEndpoints,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshotSources,
  rosterSnapshots,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  sessions,
  staffSmsConsents,
  userRoles,
  users,
} from '../../db/schema';
import { facilityRows, seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import { createDrizzleDeliveryEvidenceStore } from '../../app/api/internal/delivery-state/runtime';
import {
  createDrizzleSesWebhookStore,
  createSesWebhookRouteHandler,
} from '../../app/api/webhooks/ses/runtime';
import {
  checkPushEndpointSendEligibility,
  createDrizzlePushEndpointSendEligibilityStore,
} from '../capabilities/devices';
import type { TrustedCapabilityInvocation } from '../capabilities/engine';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '../capabilities/events';
import { loadEventSummarySnapshot } from '../capabilities/records/snapshot';
import { createDrizzleStartFlowCapabilityStore } from '../capabilities/start';
import {
  createDrizzleOutboxDispatcherStore,
  createDrizzleEmailEndpointPolicyStore,
  dispatchOutbox,
  serializeDispatchQueueEntries,
  type DispatchBatchQueue,
} from '../notify/dispatcher';
import { createDrizzleEmailRuntimeStore } from '../notify/email-runtime-store';
import { createDrizzleExpoPushRuntimeStore } from '../notify/expo-push-runtime-store';
import { createDrizzleSmsRuntimeStore } from '../notify/sms-runtime-store';
import { SYNTHETIC_PARTNER_ISSUER } from '../testing/partner-session';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../testing/database';

/**
 * Fresh-database regression for partner delivery (#597): one live lockdown,
 * its partner slice through the outbox and dispatcher, then each channel's
 * runtime store, provider boundary, and provider fact. Providers are the
 * repository's fakes: a recording SES client behind the real SES adapter, a
 * signed-callback handler with signature checking stubbed, and provider
 * evidence written through the delivery-state store as a worker would.
 */

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const DAY = 24 * 60 * 60 * 1_000;
const TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:psd-eoc-email-events';
const CUTOVER = '{"version":1,"ios":"expo","android":"expo"}';
const OPERATOR = Object.freeze({
  kind: 'human' as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
});
const CONNECTIVITY_EPOCH_ID = randomUUID();
const DISTRICT_SCOPE = Object.freeze({
  facilityScope: { kind: 'district' as const },
});
const NORTH = facilityRows[0]!.id;
const WILDLIFE_THREAT = '00000000-0000-4000-8000-000000000700';
/**
 * A staff roster address that is also a partner's admitted address, so a
 * partner bounce can be shown not to reach staff mail.
 */
const SHARED_ADDRESS = 'shared-responder@agency.example.invalid';
const ALPHA_PHONE = '+12025550142';

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
let priorCutover: string | undefined;

const fixture = {
  snapshotId: '',
  staffRecipientId: '',
  staffEmailEndpointId: '',
  alpha: { admissionId: '', userId: '', phoneRegistrationId: '' },
  bravo: { admissionId: '' },
  charlie: { admissionId: '' },
  handedOnRegistrationId: '',
  alphaConsentId: '',
};
const run = {
  eventId: '',
  batches: new Map<string, DispatchBatch>(),
};

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

function batch(channel: 'email' | 'push' | 'sms'): DispatchBatch {
  const value = run.batches.get(channel);
  if (value === undefined) throw new Error(`No partner ${channel} batch.`);
  return value;
}

async function admit(email: string, admittedAt: Date): Promise<string> {
  const [row] = await database()
    .insert(partnerAdmissions)
    .values({
      email,
      displayName: 'Synthetic Responder',
      agency: 'Synthetic Fire District',
      invitedByUserId: OPERATOR.userId,
      admittedAt,
    })
    .returning({ id: partnerAdmissions.id });
  if (row === undefined) throw new Error('The admission was not written.');
  return row.id;
}

/** A partner's account: the admitted address under the partner issuer. */
async function partnerUser(email: string, at: Date): Promise<string> {
  const [row] = await database()
    .insert(users)
    .values({
      googleSubject: null,
      identityIssuer: SYNTHETIC_PARTNER_ISSUER,
      identitySubject: `partner-delivery-${randomUUID()}`,
      email,
      displayName: 'Synthetic Responder',
      facilityScopeKind: 'district',
      createdAt: at,
    })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('The partner user was not written.');
  await database()
    .insert(userRoles)
    .values({ userId: row.id, role: 'partner' });
  return row.id;
}

async function enrolledDevice(
  userId: string,
  platform: 'ios' | 'android',
  label: string,
  at: Date,
): Promise<string> {
  const enrollmentId = randomUUID();
  await database()
    .insert(deviceEnrollments)
    .values({
      id: enrollmentId,
      userId,
      platform,
      unlockMethod: 'biometric',
      installationId: `partner-delivery-${label}`,
      enrolledAt: at,
      lastSeenAt: at,
    });
  const registrationId = randomUUID();
  await database()
    .insert(devicePushTokenRegistrations)
    .values({
      id: registrationId,
      deviceEnrollmentId: enrollmentId,
      platform,
      provider: 'expo',
      serviceEnvironment: 'production',
      applicationId: 'org.example.eoc',
      applicationVersion: '1.0.0',
      nativeBuildVersion: '1',
      expoProjectId: '00000000-0000-4000-8000-0000000005e0',
      updateMode: 'embedded-only',
      token: `ExponentPushToken[synthetic-${label}]`,
      registeredAt: at,
    });
  return registrationId;
}

/** A one-person staff roster at North, plus the partners and their reach. */
async function seedFixture(now: Date): Promise<void> {
  const created = new Date(now.getTime() - 60_000);
  const operatorDeviceId = randomUUID();
  await database().insert(users).values({
    id: OPERATOR.userId,
    googleSubject: 'partner-delivery-operator',
    identityIssuer: 'https://accounts.google.com',
    identitySubject: 'partner-delivery-operator',
    email: 'partner-delivery-operator@district.example.invalid',
    displayName: 'Synthetic Partner Delivery Operator',
    facilityScopeKind: 'district',
    createdAt: created,
  });
  await database().insert(deviceEnrollments).values({
    id: operatorDeviceId,
    userId: OPERATOR.userId,
    platform: 'web',
    unlockMethod: 'secure-session-cookie',
    installationId: 'partner-delivery-operator-device',
    enrolledAt: created,
    lastSeenAt: now,
  });
  await database()
    .insert(sessions)
    .values({
      id: OPERATOR.sessionId,
      userId: OPERATOR.userId,
      deviceEnrollmentId: operatorDeviceId,
      membershipSnapshotId: null,
      membershipValidUntil: new Date(now.getTime() + 60 * 60_000),
      membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60_000),
      createdAt: created,
      expiresAt: new Date(now.getTime() + DAY),
    });
  await database().insert(connectivityEpochs).values({
    id: CONNECTIVITY_EPOCH_ID,
    sessionId: OPERATOR.sessionId,
    establishedAt: now,
  });

  // Alpha: email, a phone, a tablet later handed to someone else, and a
  // consented number. Bravo: email only. Charlie: admitted at activation and
  // disabled before anything is sent.
  fixture.alpha.admissionId = await admit(SHARED_ADDRESS, created);
  fixture.alpha.userId = await partnerUser(SHARED_ADDRESS, created);
  fixture.alpha.phoneRegistrationId = await enrolledDevice(
    fixture.alpha.userId,
    'ios',
    'alpha-phone',
    created,
  );
  fixture.handedOnRegistrationId = await enrolledDevice(
    fixture.alpha.userId,
    'android',
    'alpha-tablet',
    created,
  );
  const [consent] = await database()
    .insert(staffSmsConsents)
    .values({
      userId: fixture.alpha.userId,
      phoneNumber: ALPHA_PHONE,
      disclosureVersion: '2026-09-01',
      source: 'web',
      consentedAt: created,
    })
    .returning({ id: staffSmsConsents.id });
  fixture.alphaConsentId = consent!.id;
  fixture.bravo.admissionId = await admit(
    'bravo@agency.example.invalid',
    created,
  );
  fixture.charlie.admissionId = await admit(
    'charlie@agency.example.invalid',
    created,
  );
  const charlieUser = await partnerUser(
    'charlie@agency.example.invalid',
    created,
  );
  await enrolledDevice(charlieUser, 'ios', 'charlie-phone', created);

  const configurationId = randomUUID();
  fixture.snapshotId = randomUUID();
  fixture.staffRecipientId = randomUUID();
  fixture.staffEmailEndpointId = randomUUID();
  const sourceId = randomUUID();
  const groupRef = {
    population: 'staff' as const,
    groupSourceId: sourceId,
    groupSourceKind: 'google-group' as const,
    groupPurpose: 'building' as const,
  };
  await database().transaction(async (transaction) => {
    await transaction.insert(groupSources).values({
      id: sourceId,
      kind: 'google-group',
      purpose: 'building',
      facilityId: NORTH,
      displayName: 'Synthetic partner delivery staff group',
      active: true,
      googleGroupId: 'synthetic-partner-delivery-group',
      email: 'partner-delivery-group@example.invalid',
      createdAt: created,
    });
    await transaction.insert(rosterSourceConfigurations).values({
      id: configurationId,
      version: 1,
      population: 'staff',
      createdAt: created,
    });
    await transaction.insert(rosterSourceConfigurationFacilities).values({
      configurationId,
      configurationVersion: 1,
      facilityId: NORTH,
    });
    await transaction.insert(rosterSourceConfigurationGroups).values({
      configurationId,
      configurationVersion: 1,
      ...groupRef,
    });
    await transaction.insert(rosterSnapshots).values({
      id: fixture.snapshotId,
      version: 1,
      population: 'staff',
      complete: true,
      sourceConfigurationId: configurationId,
      sourceConfigurationVersion: 1,
      syncStartedAt: created,
      capturedAt: created,
    });
    await transaction.insert(rosterSnapshotFacilities).values({
      rosterSnapshotId: fixture.snapshotId,
      facilityId: NORTH,
    });
    await transaction.insert(rosterSnapshotSources).values([
      {
        rosterSnapshotId: fixture.snapshotId,
        ...groupRef,
        completionKind: 'expected',
      },
      {
        rosterSnapshotId: fixture.snapshotId,
        ...groupRef,
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(rosterRecipients).values({
      id: fixture.staffRecipientId,
      rosterSnapshotId: fixture.snapshotId,
      population: 'staff',
      googleSubject: 'partner-delivery-staff-target',
      displayName: 'Synthetic Staff Target',
    });
    await transaction.insert(rosterRecipientGroupSources).values({
      rosterSnapshotId: fixture.snapshotId,
      recipientId: fixture.staffRecipientId,
      ...groupRef,
    });
    await transaction.insert(rosterEndpoints).values([
      {
        id: randomUUID(),
        rosterSnapshotId: fixture.snapshotId,
        recipientId: fixture.staffRecipientId,
        population: 'staff',
        channel: 'push',
        status: 'active',
        capturedAt: created,
        platform: 'ios',
        provider: 'expo',
        serviceEnvironment: 'production',
        token: 'synthetic-unroutable:partner-delivery-staff',
        email: null,
        phoneNumber: null,
      },
      {
        id: fixture.staffEmailEndpointId,
        rosterSnapshotId: fixture.snapshotId,
        recipientId: fixture.staffRecipientId,
        population: 'staff',
        channel: 'email',
        status: 'active',
        capturedAt: created,
        platform: null,
        token: null,
        email: SHARED_ADDRESS,
        phoneNumber: null,
      },
    ]);
  });
  await database()
    .update(channelConfigurations)
    .set({ enabled: true, changedAt: now })
    .where(
      inArray(channelConfigurations.integrationId, [
        'mobile-push',
        'ses-email',
        'aws-eum-sms',
      ]),
    );
}

async function lockdownVersionId(): Promise<string> {
  const [row] = await database()
    .select({ id: eventTypeVersions.id })
    .from(eventTypeVersions)
    .innerJoin(eventTypes, eq(eventTypes.id, eventTypeVersions.eventTypeId))
    .where(eq(eventTypes.key, 'lockdown'))
    .limit(1);
  if (row === undefined) throw new Error('The seed has no lockdown version.');
  return row.id;
}

async function confirm(consequenceDigest: string): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await database()
    .insert(humanConfirmationRecords)
    .values({
      id,
      capabilityId: 'start-event',
      connectivityEpochId: CONNECTIVITY_EPOCH_ID,
      confirmedByUserId: OPERATOR.userId,
      confirmedWithSessionId: OPERATOR.sessionId,
      consequenceDigest,
      issuedAt: new Date(now - 1_000),
      expiresAt: new Date(now + 3 * 60_000),
      status: 'issued',
      consumedAt: null,
      consumedForRequestId: null,
      expiredAt: null,
    });
  await database()
    .insert(humanConfirmationActions)
    .values(
      (['start-real-incident', 'send-real-notification'] as const).map(
        (actionId) => ({ confirmationId: id, actionId }),
      ),
    );
  return id;
}

function invocation(humanConfirmationId: string): TrustedCapabilityInvocation {
  return {
    actor: OPERATOR,
    source: 'web',
    scope: DISTRICT_SCOPE,
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: {
      idempotencyKey: `partner-delivery-${randomUUID()}`,
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId,
    },
  };
}

class RecordingQueue implements DispatchBatchQueue {
  public readonly sent: DispatchBatch[] = [];

  public send(batches: readonly DispatchBatch[]) {
    this.sent.push(...batches);
    return Promise.resolve(
      serializeDispatchQueueEntries(batches).map((entry) => ({
        entryId: entry.id,
        messageId: randomUUID(),
      })),
    );
  }
}

/** The attempt a worker reserves before provider I/O (the delivery-state route). */
async function recordAttempted(attempt: ChannelAttempt): Promise<void> {
  await createDrizzleDeliveryEvidenceStore(
    database() as Database,
  ).recordAttemptEvidence({
    attempt,
    evidence: {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'attempted',
      provider: null,
      providerReference: null,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    },
  });
}

/** A worker's attempt and the provider's acceptance, as a fake provider. */
async function recordProviderFacts(
  attempt: ChannelAttempt,
  provider: string,
  providerReference: string,
): Promise<void> {
  await recordAttempted(attempt);
  await createDrizzleDeliveryEvidenceStore(
    database() as Database,
  ).recordAttemptEvidence({
    attempt,
    evidence: {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'provider-accepted',
      provider,
      providerReference,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    },
  });
}

async function boundPartnerEndpoint(attemptId: string): Promise<string | null> {
  const [row] = await database()
    .select({ partnerEndpointId: channelAttempts.partnerEndpointId })
    .from(channelAttempts)
    .where(eq(channelAttempts.id, attemptId));
  return row?.partnerEndpointId ?? null;
}

function emailStore() {
  return createDrizzleEmailRuntimeStore(database() as Database, {
    deploymentAuthorization: { workerEnabled: true },
  });
}

function smsStore() {
  return createDrizzleSmsRuntimeStore(database() as Database, {
    destinationCountryCode: 'US',
  });
}

function snsRequest(message: string): Request {
  const messageId = randomUUID();
  const envelope = {
    Type: 'Notification',
    MessageId: messageId,
    TopicArn: TOPIC_ARN,
    Message: message,
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    Signature: Buffer.from('synthetic-signature', 'utf8').toString('base64'),
    SigningCertURL:
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
  };
  return new Request('https://app.example.invalid/api/webhooks/ses', {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-amz-sns-message-type': envelope.Type,
      'x-amz-sns-message-id': envelope.MessageId,
      'x-amz-sns-topic-arn': envelope.TopicArn,
    },
    body: JSON.stringify(envelope),
  });
}

function sesCallback() {
  return createSesWebhookRouteHandler({
    readExpectedTopicArn: () => TOPIC_ARN,
    verifySignature: () => Promise.resolve(),
    confirmSubscription: () => Promise.resolve(),
    createStore: () =>
      Promise.resolve(createDrizzleSesWebhookStore(database() as Database)),
  });
}

describeWithDatabase('partner delivery from a live incident (#597)', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) throw new Error('no database');
    priorCutover = process.env.PSD_EOC_PUSH_PROVIDER_CUTOVER;
    process.env.PSD_EOC_PUSH_PROVIDER_CUTOVER = CUTOVER;
    ownedDatabase = await createDisposableDatabase(
      'psd_eoc_partner_delivery',
      baseTestDatabaseUrl,
    );
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 4,
    });
    if (opened.driver !== 'postgres') throw new Error('PostgreSQL only.');
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);
    await seedFixture(new Date());
  });

  afterAll(async () => {
    if (priorCutover === undefined) {
      delete process.env.PSD_EOC_PUSH_PROVIDER_CUTOVER;
    } else {
      process.env.PSD_EOC_PUSH_PROVIDER_CUTOVER = priorCutover;
    }
    await closeAndDropDisposableDatabase(connection?.close, ownedDatabase);
  });

  test('a live lockdown queues a partner slice for every channel', async () => {
    const versionId = await lockdownVersionId();
    const preview = await createDrizzleStartFlowCapabilityStore(
      database(),
    ).transaction((transaction) =>
      transaction.createActivationPreview(
        {
          facilityId: NORTH,
          kind: 'incident',
          templateMode: 'real',
          eventTypeVersion: { id: versionId, templateMode: 'real' },
          rosterPopulation: 'staff',
          threatId: WILDLIFE_THREAT,
          threatDetail: null,
          responseDetail: null,
        },
        OPERATOR,
        new Date(),
      ),
    );
    expect(preview.partnerRecipientCount).toBe(3);
    const started = await executeEventCapability(
      'start-event',
      {
        source: 'activation-preview',
        activationPreviewId: preview.id,
        activeEventDecision: {
          decision: 'start-new',
          activeEventIdsSeen: preview.activeEventIds,
        },
      },
      invocation(await confirm(preview.consequenceDigest)),
      createDrizzleEventCapabilityStore(database()),
    );
    run.eventId = started.event.id;

    // After activation: Charlie's admission is disabled, and Alpha's tablet
    // is handed to another account, which unregisters Alpha there (#498).
    await database().insert(partnerAdmissionEndings).values({
      partnerAdmissionId: fixture.charlie.admissionId,
      reason: 'disabled',
      endedByUserId: OPERATOR.userId,
      endedAt: new Date(),
    });

    const [partnerOutbox] = await database()
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.eventId, run.eventId),
          eq(outbox.rosterPopulation, 'partner'),
        ),
      );
    if (partnerOutbox === undefined) throw new Error('No partner outbox.');
    const queue = new RecordingQueue();
    const dispatched = await dispatchOutbox(partnerOutbox.id, {
      store: createDrizzleOutboxDispatcherStore(database() as Database),
      queue,
    });
    expect(dispatched.outboxRecord.status).toBe('published');
    for (const item of queue.sent) run.batches.set(item.channel, item);
    expect(
      queue.sent.map((item) => [
        item.channel,
        item.rosterPopulation,
        item.endpointCount,
      ]),
    ).toEqual([
      ['push', 'partner', 0],
      ['email', 'partner', 3],
      ['sms', 'partner', 0],
    ]);
  });

  test('email reaches each admitted partner under the partner set, and a bounce suppresses partner mail only', async () => {
    const store = emailStore();
    const page = (await store.resolveBatch({
      operation: 'resolve-batch',
      batch: batch('email'),
      enqueuedAt: new Date().toISOString(),
      cursor: 0,
    })) as Readonly<{
      items: readonly EmailWorkerAttemptWorkItem[];
      nextCursor: number | null;
      suppressedCount: number;
    }>;
    // Charlie was disabled after activation: a candidate, never sent to.
    expect(page.suppressedCount).toBe(1);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.attempt.recipientId).sort()).toEqual(
      [fixture.alpha.admissionId, fixture.bravo.admissionId].sort(),
    );
    const alpha = page.items.find(
      (item) => item.attempt.recipientId === fixture.alpha.admissionId,
    )!;
    expect(alpha.endpoint).toEqual(
      expect.objectContaining({ channel: 'email', email: SHARED_ADDRESS }),
    );
    const [alphaEndpoint] = await database()
      .select({ id: partnerEndpoints.id })
      .from(partnerEndpoints)
      .where(
        and(
          eq(partnerEndpoints.partnerAdmissionId, fixture.alpha.admissionId),
          eq(partnerEndpoints.channel, 'email'),
        ),
      );
    expect(alpha.endpoint.id).toBe(alphaEndpoint!.id);

    // The real SES adapter against a recording client: the send is claimed
    // through the runtime store, which re-checks the partner is still live.
    const sent: SesV2SendEmailInput[] = [];
    const messageId = `synthetic-partner-${randomUUID()}`;
    const adapter = new SesV2EmailAdapter({
      client: {
        sendEmail(input) {
          sent.push(input);
          return Promise.resolve({ MessageId: messageId });
        },
      },
      sendLedger: {
        durability: 'durable',
        claim: (request) =>
          store.claimProviderIo({
            operation: 'claim-provider-io',
            attemptId: request.attemptId,
            requestFingerprint: request.requestFingerprint,
            workItem: request.workItem as EmailWorkerAttemptWorkItem,
          }) as ReturnType<
            ConstructorParameters<
              typeof SesV2EmailAdapter
            >[0]['sendLedger']['claim']
          >,
        complete: (request) =>
          store.completeProviderIo({
            operation: 'complete-provider-io',
            attemptId: request.attemptId,
            requestFingerprint: request.requestFingerprint,
            leaseToken: request.leaseToken,
            outcome: request.outcome,
          }),
      },
      fromEmailAddress: 'alerts@district.example.invalid',
      branding: {
        organizationName: 'Synthetic School District',
        applicationOrigin: 'https://eoc.example.invalid',
        senderDisplayName: null,
      },
    });
    await recordAttempted(alpha.attempt);
    const outcome = await adapter.send({
      workItem: alpha,
      idempotencyKey: alpha.attempt.id,
    });
    expect(outcome.state).toBe('provider-accepted');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ConfigurationSetName).toBe(
      SES_PARTNER_CONFIGURATION_SET_NAME,
    );
    expect(sent[0]?.Destination.ToAddresses).toEqual([SHARED_ADDRESS]);
    // The attempt binds the partner endpoint (migration 0063).
    expect(await boundPartnerEndpoint(alpha.attempt.id)).toBe(
      alpha.endpoint.id,
    );

    // The provider reports a permanent bounce under the partner set.
    const tags = Object.fromEntries(
      sent[0]!.EmailTags.map((tag) => [tag.Name, [tag.Value]]),
    );
    const callback = sesCallback();
    const bounce = await callback(
      snsRequest(
        JSON.stringify({
          eventType: 'Bounce',
          mail: {
            timestamp: new Date().toISOString(),
            messageId,
            source: 'alerts@district.example.invalid',
            sendingAccountId: '000000000000',
            destination: [SHARED_ADDRESS],
            tags: {
              ...tags,
              'ses:configuration-set': [SES_PARTNER_CONFIGURATION_SET_NAME],
            },
          },
          bounce: {
            bounceType: 'Permanent',
            bounceSubType: 'General',
            timestamp: new Date().toISOString(),
          },
        }),
      ),
    );
    expect(bounce.status).toBe(204);
    const statuses = await database()
      .select({
        population: endpointStatusRecords.population,
        partnerEndpointId: endpointStatusRecords.partnerEndpointId,
        status: endpointStatusRecords.status,
      })
      .from(endpointStatusRecords)
      .where(eq(endpointStatusRecords.endpointId, alpha.endpoint.id));
    expect(statuses).toEqual([
      {
        population: 'partner',
        partnerEndpointId: alpha.endpoint.id,
        status: 'invalid',
      },
    ]);

    // Partner account mail shares the set and carries no alert tags: it is
    // acknowledged, and nothing is recorded.
    const accountMail = await callback(
      snsRequest(
        JSON.stringify({
          eventType: 'Bounce',
          mail: {
            timestamp: new Date().toISOString(),
            messageId: `synthetic-invitation-${randomUUID()}`,
            source: 'alerts@district.example.invalid',
            sendingAccountId: '000000000000',
            destination: ['bravo@agency.example.invalid'],
            tags: {
              'ses:configuration-set': [SES_PARTNER_CONFIGURATION_SET_NAME],
            },
          },
          bounce: {
            bounceType: 'Permanent',
            bounceSubType: 'General',
            timestamp: new Date().toISOString(),
          },
        }),
      ),
    );
    expect(accountMail.status).toBe(204);

    // A partner fact claiming the alert set is refused: partner mail goes
    // out under the partner set only.
    const misrouted = await callback(
      snsRequest(
        JSON.stringify({
          eventType: 'Delivery',
          mail: {
            timestamp: new Date().toISOString(),
            messageId,
            source: 'alerts@district.example.invalid',
            sendingAccountId: '000000000000',
            destination: [SHARED_ADDRESS],
            tags: {
              ...tags,
              'ses:configuration-set': ['psd-eoc-transactional'],
            },
          },
          delivery: { timestamp: new Date().toISOString() },
        }),
      ),
    );
    expect(misrouted.status).toBe(400);

    // The bounced partner address is no longer sent to...
    const after = (await store.resolveBatch({
      operation: 'resolve-batch',
      batch: batch('email'),
      enqueuedAt: new Date().toISOString(),
      cursor: 0,
    })) as Readonly<{ items: readonly EmailWorkerAttemptWorkItem[] }>;
    expect(after.items.map((item) => item.attempt.recipientId)).toEqual([
      fixture.bravo.admissionId,
    ]);
    // ...while the same address on the staff roster is untouched.
    expect(
      await createDrizzleEmailEndpointPolicyStore(
        database() as Database,
      ).loadEndpointPolicy({
        rosterSnapshotId: fixture.snapshotId,
        rosterPopulation: 'staff',
        endpointCount: 1,
        candidates: [
          {
            recipientId: fixture.staffRecipientId,
            endpointId: fixture.staffEmailEndpointId,
          },
        ],
      }),
    ).toEqual([
      {
        recipientId: fixture.staffRecipientId,
        endpointId: fixture.staffEmailEndpointId,
        status: 'active',
      },
    ]);
  });

  test('text reaches a partner at their own consented number until they withdraw', async () => {
    const store = smsStore();
    const resolve = () =>
      store.resolveBatch({
        operation: 'resolve-batch',
        batch: batch('sms'),
        enqueuedAt: new Date().toISOString(),
        cursor: 0,
      });
    const page = await resolve();
    if (page.kind !== 'ready') throw new Error('The SMS batch expired.');
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item!.attempt.recipientId).toBe(fixture.alpha.admissionId);
    expect(item!.endpoint.phoneNumber).toBe(ALPHA_PHONE);
    expect(await store.authorizeProviderSend(item!)).toEqual(
      expect.objectContaining({ authorized: true }),
    );
    await recordProviderFacts(
      item!.attempt,
      'aws-eum-sms',
      `sms-${randomUUID()}`,
    );
    expect(await boundPartnerEndpoint(item!.attempt.id)).toBe(
      item!.endpoint.id,
    );

    await database()
      .update(staffSmsConsents)
      .set({ withdrawnAt: new Date() })
      .where(eq(staffSmsConsents.id, fixture.alphaConsentId));
    const withdrawn = await resolve();
    if (withdrawn.kind !== 'ready') throw new Error('The SMS batch expired.');
    // Still a candidate, so no later partner shifts; no longer sent to.
    expect(withdrawn.items).toEqual([]);
    expect(withdrawn.nextCursor).toBeNull();
    expect(await store.authorizeProviderSend(item!)).toEqual({
      authorized: false,
    });
  });

  test('push reaches a partner’s own live device, and eligibility follows the admission', async () => {
    const store = createDrizzleExpoPushRuntimeStore(database() as Database);
    // The tablet changes hands after the batch was created (#498).
    const [tablet] = await database()
      .select({
        deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
      })
      .from(devicePushTokenRegistrations)
      .where(
        eq(devicePushTokenRegistrations.id, fixture.handedOnRegistrationId),
      );
    await database().insert(devicePushTokenUnregistrations).values({
      registrationId: fixture.handedOnRegistrationId,
      deviceEnrollmentId: tablet!.deviceEnrollmentId,
    });
    const resolve = () =>
      store.resolveBatch({
        operation: 'resolve-batch',
        batch: batch('push'),
        enqueuedAt: new Date().toISOString(),
        cursor: 0,
      });
    const page = await resolve();
    // Charlie's phone (admission disabled) and Alpha's handed-on tablet are
    // candidates and are not sent to; Alpha's phone is.
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item!.attempt.recipientId).toBe(fixture.alpha.admissionId);
    expect(item!.endpoint).toEqual(
      expect.objectContaining({
        channel: 'push',
        token: 'ExponentPushToken[synthetic-alpha-phone]',
      }),
    );
    const [binding] = await database()
      .select({ registrationId: partnerEndpoints.pushRegistrationId })
      .from(partnerEndpoints)
      .where(eq(partnerEndpoints.id, item!.endpoint.id));
    expect(binding?.registrationId).toBe(fixture.alpha.phoneRegistrationId);

    const endpoint = item!.endpoint;
    if (endpoint.channel !== 'push') throw new Error('Not a push endpoint.');
    const eligibilityInput = PushEndpointSendEligibilityInputSchema.parse({
      version: 1,
      rosterSnapshotId: item!.attempt.rosterSnapshotId,
      rosterPopulation: 'partner',
      recipientId: item!.attempt.recipientId,
      endpointId: endpoint.id,
      platform: endpoint.platform,
      provider: endpoint.provider,
      serviceEnvironment: endpoint.serviceEnvironment,
      tokenDigest: createHash('sha256')
        .update(endpoint.token, 'utf8')
        .digest('hex'),
      batchCreatedAt: batch('push').createdAt,
    });
    const eligibility = createDrizzlePushEndpointSendEligibilityStore(
      database() as Database,
    );
    expect(
      await checkPushEndpointSendEligibility(eligibilityInput, eligibility),
    ).toBe(true);
    // A registration that is not this partner's own is never vouched for.
    expect(
      await checkPushEndpointSendEligibility(
        { ...eligibilityInput, recipientId: fixture.bravo.admissionId },
        eligibility,
      ),
    ).toBe(false);
    await recordProviderFacts(
      ChannelAttemptSchema.parse(item!.attempt),
      'expo-push',
      `expo-ticket-${randomUUID()}`,
    );
    expect(await boundPartnerEndpoint(item!.attempt.id)).toBe(endpoint.id);

    // The admission ends: the device is no longer sent to.
    await database().insert(partnerAdmissionEndings).values({
      partnerAdmissionId: fixture.alpha.admissionId,
      reason: 'disabled',
      endedByUserId: OPERATOR.userId,
      endedAt: new Date(),
    });
    expect(
      await checkPushEndpointSendEligibility(eligibilityInput, eligibility),
    ).toBe(false);
    expect((await resolve()).items).toEqual([]);
  });

  test('the event record accounts for partner deliveries without refusing', async () => {
    const summary = await loadEventSummarySnapshot(
      database() as unknown as DatabaseQuery,
      run.eventId,
      new Date().toISOString(),
    );
    const partner = summary.delivery.find(
      (intent) => intent.rosterPopulation === 'partner',
    );
    expect(
      partner?.channels.map((channel) => [
        channel.channel,
        channel.plannedEndpointCount,
      ]),
    ).toEqual([
      ['push', 0],
      ['email', 3],
      ['sms', 0],
    ]);
  });

  test('the production application role resolves partner endpoints and cannot rewrite delivery facts', async () => {
    if (ownedDatabase === undefined) throw new Error('not migrated');
    const roleConnection = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 1,
    });
    if (roleConnection.driver !== 'postgres') throw new Error('postgres');
    try {
      await roleConnection.db.execute(sql`set role psd_eoc_app`);
      const bravoSecond = await admit(
        'bravo-second@agency.example.invalid',
        new Date(),
      );
      await roleConnection.db
        .insert(partnerEndpoints)
        .values({ partnerAdmissionId: bravoSecond, channel: 'email' })
        .onConflictDoNothing();
      const rows = await roleConnection.db
        .select({ id: partnerEndpoints.id })
        .from(partnerEndpoints)
        .where(eq(partnerEndpoints.partnerAdmissionId, bravoSecond));
      expect(rows).toHaveLength(1);
      const privileges = await roleConnection.db.execute<{
        attempts: boolean;
        statuses: boolean;
      }>(sql`
        select
          has_table_privilege('psd_eoc_app', 'public.channel_attempts', 'UPDATE') as attempts,
          has_table_privilege('psd_eoc_app', 'public.endpoint_status_records', 'UPDATE') as statuses
      `);
      expect([...privileges]).toEqual([{ attempts: false, statuses: false }]);
      const columns = await roleConnection.db.execute<{ bound: boolean }>(sql`
        select has_column_privilege(
          'psd_eoc_app', 'public.endpoint_status_records',
          'partner_endpoint_id', 'UPDATE'
        ) as bound
      `);
      expect([...columns]).toEqual([{ bound: false }]);
    } finally {
      await roleConnection.close();
    }
    const attempts = await database()
      .select({ channel: channelAttempts.channel })
      .from(channelAttempts)
      .where(eq(channelAttempts.rosterPopulation, 'partner'))
      .orderBy(asc(channelAttempts.channel));
    // Enum order.
    expect(attempts.map((row) => row.channel)).toEqual([
      'push',
      'email',
      'sms',
    ]);
  });
});
