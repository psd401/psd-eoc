import { randomInt, randomUUID } from 'node:crypto';

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
  DispatchBatchSchema,
  NotificationOutboxMessageSchema,
  RosterSnapshotSchema,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../(admin)/facilities/owned-database-lifecycle';
import { requireSyntheticTestDatabaseUrl } from '../../../lib/testing/database';
import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import { seedDatabase } from '../../../db/seed';
import {
  accessMembershipSnapshots,
  dispatchBatches,
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  events,
  groupSources,
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
  sessionRevocations,
  sessions,
  users,
} from '../../../db/schema';
import { migrateDatabase } from '../../../drizzle/migrate';
import {
  createDrizzleDeliveryEvidenceStore,
  type AttemptEvidenceInput,
} from '../internal/delivery-state/runtime';
import type { TrustedCapabilityInvocation } from '../../../lib/capabilities/engine';
import {
  createDrizzleDeviceCapabilityStore,
  createDrizzlePushEndpointPolicyStore,
  EXPO_DEVICE_NOT_REGISTERED_REASON,
  executeDeviceCapability,
  PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
  resolvePushEndpoints,
} from '../../../lib/capabilities/devices';
import { createDrizzleRosterSyncStore } from '../../../lib/roster/groups-sync';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const fixture = Object.freeze({
  userId: randomUUID(),
  deviceId: randomUUID(),
  otherDeviceId: randomUUID(),
  sessionId: randomUUID(),
  otherSessionId: randomUUID(),
  revokedSessionId: randomUUID(),
  connectivityEpochId: randomUUID(),
  otherConnectivityEpochId: randomUUID(),
  revokedConnectivityEpochId: randomUUID(),
  membershipSnapshotId: randomUUID(),
  groupSourceId: randomUUID(),
  rosterConfigurationId: randomUUID(),
  rosterSnapshotId: randomUUID(),
  syntheticRosterSnapshotId: randomUUID(),
  recipientId: randomUUID(),
  syntheticRecipientId: randomUUID(),
  rosterVersion: randomInt(100_000_000, 900_000_000),
  syntheticRosterVersion: 2,
  membershipVersion: randomInt(100_000_000, 900_000_000),
});
const fixtureSuffix = fixture.userId.replaceAll('-', '');
const googleSubject = `synthetic-device-${fixtureSuffix}`;
const firstToken = `ExponentPushToken[synthetic-${fixtureSuffix}-first]`;
const replacementToken = `synthetic-unroutable:device-${fixtureSuffix}-replacement`;
const contendedToken = `ExponentPushToken[synthetic-${fixtureSuffix}-contended]`;
const revokedSessionToken = `ExponentPushToken[synthetic-${fixtureSuffix}-revoked]`;
const unrelatedToken = `synthetic-unroutable:device-${fixtureSuffix}-unrelated`;
const facilityId = '00000000-0000-4000-8000-000000000001';
const SEEDED = Object.freeze({
  audienceId: '00000000-0000-4000-8000-000000000020',
  facilitySouthId: '00000000-0000-4000-8000-000000000002',
  groupNorthId: '00000000-0000-4000-8000-000000000030',
  groupSouthId: '00000000-0000-4000-8000-000000000031',
  groupOthersId: '00000000-0000-4000-8000-000000000032',
  rosterConfigurationId: '00000000-0000-4000-8000-000000000040',
  eventTypeVersionId: '00000000-0000-4000-8000-000000000201',
  pushIntegrationStatusId: '00000000-0000-4000-8000-000000000301',
  emailIntegrationStatusId: '00000000-0000-4000-8000-000000000302',
  integrationObservedAt: '2026-08-06T12:00:00.000Z',
});

let connection: PostgresDatabaseConnection | undefined;
let disposableContext: DisposableDatabaseContext | undefined;
const databaseCleanupLatch: { created: boolean } = { created: false };

interface DisposableDatabaseContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

function buildDisposableContext(
  baseDatabaseUrl: string,
): DisposableDatabaseContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i12_devices_${runId.replaceAll('-', '')}_test`;
  if (!/^psd_eoc_i12_devices_[a-f0-9]{32}_test$/u.test(databaseName)) {
    throw new Error('The disposable device database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-12:device-test:${runId}`,
  });
}

function openPostgresConnection(
  url: string,
  maxConnections: number,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Device integration tests require PostgreSQL.');
  }
  return opened;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readDatabaseMarker(
  admin: PostgresDatabaseConnection,
  databaseName: string,
): Promise<string | null | undefined> {
  const rows = databaseExecuteRows<MarkerRow>(
    await admin.db.execute<MarkerRow>(sql`
      select shobj_description(oid, 'pg_database') as marker
      from pg_database
      where datname = ${databaseName}
    `),
  );
  if (rows.length > 1) {
    throw new Error('The disposable device database identity is ambiguous.');
  }
  return rows[0]?.marker;
}

function requireDatabaseOwnership(
  context: DisposableDatabaseContext,
  marker: string | null | undefined,
): void {
  if (marker !== context.marker) {
    throw new Error(
      'Refusing to drop a database without the exact issue #12 ownership marker.',
    );
  }
}

async function dropOwnedDatabase(
  context: DisposableDatabaseContext,
): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, context.databaseName);
      if (marker === undefined) return;
      requireDatabaseOwnership(context, marker);
      await admin.db.execute(
        sql.raw(`drop database "${context.databaseName}" with (force)`),
      );
      expect(
        await readDatabaseMarker(admin, context.databaseName),
      ).toBeUndefined();
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Disposable device database cleanup and connection close both failed.',
  });
}

async function createOwnedDatabase(
  context: DisposableDatabaseContext,
): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl, 1);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${context.databaseName}"`),
      );
      recordCreated();
      await admin.db.execute(
        sql.raw(
          `comment on database "${context.databaseName}" is ${quotedLiteral(context.marker)}`,
        ),
      );
      requireDatabaseOwnership(
        context,
        await readDatabaseMarker(admin, context.databaseName),
      );
      databaseCleanupLatch.created = true;
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(context),
    failureMessage:
      'Disposable device database creation or marker-owned rollback failed.',
  });
}

async function cleanupResources(): Promise<void> {
  const errors: unknown[] = [];
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      errors.push(error);
    } finally {
      connection = undefined;
    }
  }
  if (databaseCleanupLatch.created && disposableContext !== undefined) {
    try {
      await dropOwnedDatabase(disposableContext);
      databaseCleanupLatch.created = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #12 device integration cleanup failed.',
    );
  }
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The device integration database is not open.');
  }
  return connection;
}

function disposableDatabaseContext(): DisposableDatabaseContext {
  if (disposableContext === undefined) {
    throw new Error('The disposable device database context is unavailable.');
  }
  return disposableContext;
}

function humanInvocation(
  label: string,
  sessionId = fixture.sessionId,
  connectivityEpochId = fixture.connectivityEpochId,
): TrustedCapabilityInvocation {
  return {
    actor: {
      kind: 'human',
      userId: fixture.userId,
      sessionId,
    },
    source: 'mobile',
    scope: { facilityScope: { kind: 'district' } },
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId,
    mutation: {
      idempotencyKey: `device-persistence-${label}-${randomUUID()}`,
      transport: {
        kind: 'mobile-interactive',
        interaction: 'explicit-user-submit',
      },
      humanConfirmationId: null,
    },
  };
}

function workerInvocation(label: string): TrustedCapabilityInvocation {
  return {
    actor: {
      kind: 'system',
      serviceId: PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
    },
    source: 'worker',
    scope: { facilityScope: { kind: 'district' } },
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: null,
    mutation: {
      idempotencyKey: `push-invalidation-${label}-${randomUUID()}`,
      transport: { kind: 'worker-execution' },
      humanConfirmationId: null,
    },
  };
}

async function installFixture(database: PostgresDatabase): Promise<void> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000);
  const oneHourLater = new Date(now.getTime() + 60 * 60_000);
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60_000);
  const threeHoursLater = new Date(now.getTime() + 3 * 60 * 60_000);
  await database.transaction(async (transaction) => {
    await transaction.insert(users).values({
      id: fixture.userId,
      googleSubject,
      email: `synthetic-device-${fixtureSuffix}@example.invalid`,
      displayName: 'Synthetic Device Integration User',
      facilityScopeKind: 'district',
      createdAt: oneMinuteAgo,
    });
    await transaction.insert(accessMembershipSnapshots).values({
      id: fixture.membershipSnapshotId,
      version: fixture.membershipVersion,
      complete: true,
      syncStartedAt: oneMinuteAgo,
      capturedAt: now,
    });
    await transaction.insert(deviceEnrollments).values([
      {
        id: fixture.deviceId,
        userId: fixture.userId,
        platform: 'ios',
        unlockMethod: 'biometric',
        installationId: `synthetic-installation-${fixtureSuffix}-primary`,
        enrolledAt: oneMinuteAgo,
        lastSeenAt: now,
      },
      {
        id: fixture.otherDeviceId,
        userId: fixture.userId,
        platform: 'ios',
        unlockMethod: 'biometric',
        installationId: `synthetic-installation-${fixtureSuffix}-other`,
        enrolledAt: oneMinuteAgo,
        lastSeenAt: now,
      },
    ]);
    await transaction.insert(sessions).values([
      {
        id: fixture.sessionId,
        userId: fixture.userId,
        deviceEnrollmentId: fixture.deviceId,
        membershipSnapshotId: fixture.membershipSnapshotId,
        membershipValidUntil: oneHourLater,
        membershipGraceUntil: twoHoursLater,
        createdAt: now,
        expiresAt: threeHoursLater,
      },
      {
        id: fixture.otherSessionId,
        userId: fixture.userId,
        deviceEnrollmentId: fixture.otherDeviceId,
        membershipSnapshotId: fixture.membershipSnapshotId,
        membershipValidUntil: oneHourLater,
        membershipGraceUntil: twoHoursLater,
        createdAt: now,
        expiresAt: threeHoursLater,
      },
      {
        id: fixture.revokedSessionId,
        userId: fixture.userId,
        deviceEnrollmentId: fixture.deviceId,
        membershipSnapshotId: fixture.membershipSnapshotId,
        membershipValidUntil: oneHourLater,
        membershipGraceUntil: twoHoursLater,
        createdAt: now,
        expiresAt: threeHoursLater,
      },
    ]);
    await transaction.insert(groupSources).values({
      id: fixture.groupSourceId,
      kind: 'google-group',
      purpose: 'building',
      facilityId,
      displayName: 'Synthetic Device Integration Staff',
      active: true,
      googleGroupId: `synthetic-device-group-${fixtureSuffix}`,
      email: `synthetic-device-group-${fixtureSuffix}@example.invalid`,
      fixtureKey: null,
      createdAt: now,
    });
    await transaction.insert(rosterSourceConfigurations).values({
      id: fixture.rosterConfigurationId,
      version: 1,
      population: 'staff',
      createdAt: now,
    });
    await transaction.insert(rosterSourceConfigurationFacilities).values({
      configurationId: fixture.rosterConfigurationId,
      configurationVersion: 1,
      facilityId,
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
}

async function publishRosterEndpointFixture(
  database: PostgresDatabase,
  registration: Readonly<{ id: string; token: string }>,
  identity: Readonly<{
    rosterSnapshotId: string;
    rosterVersion: number;
    recipientId: string;
  }> = {
    rosterSnapshotId: fixture.rosterSnapshotId,
    rosterVersion: fixture.rosterVersion,
    recipientId: fixture.recipientId,
  },
): Promise<void> {
  const capturedAt = new Date();
  const syncStartedAt = new Date(capturedAt.getTime() - 60_000);
  await database.transaction(async (transaction) => {
    await transaction.insert(rosterSnapshots).values({
      id: identity.rosterSnapshotId,
      version: identity.rosterVersion,
      population: 'staff',
      complete: true,
      sourceConfigurationId: fixture.rosterConfigurationId,
      sourceConfigurationVersion: 1,
      syncStartedAt,
      capturedAt,
    });
    await transaction.insert(rosterSnapshotFacilities).values({
      rosterSnapshotId: identity.rosterSnapshotId,
      facilityId,
    });
    await transaction.insert(rosterSnapshotSources).values([
      {
        rosterSnapshotId: identity.rosterSnapshotId,
        population: 'staff',
        groupSourceId: fixture.groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'expected',
      },
      {
        rosterSnapshotId: identity.rosterSnapshotId,
        population: 'staff',
        groupSourceId: fixture.groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(rosterRecipients).values({
      id: identity.recipientId,
      rosterSnapshotId: identity.rosterSnapshotId,
      population: 'staff',
      googleSubject,
      displayName: 'Synthetic Device Integration Recipient',
    });
    await transaction.insert(rosterRecipientGroupSources).values({
      rosterSnapshotId: identity.rosterSnapshotId,
      recipientId: identity.recipientId,
      population: 'staff',
      groupSourceId: fixture.groupSourceId,
      groupSourceKind: 'google-group',
      groupPurpose: 'building',
    });
    await transaction.insert(rosterEndpoints).values({
      id: registration.id,
      rosterSnapshotId: identity.rosterSnapshotId,
      recipientId: identity.recipientId,
      population: 'staff',
      channel: 'push',
      status: 'active',
      capturedAt,
      platform: 'ios',
      token: registration.token,
      email: null,
      phoneNumber: null,
    });
  });
}

async function publishSyntheticRosterEndpointFixture(
  database: PostgresDatabase,
  registrations: readonly Readonly<{ id: string; token: string }>[],
  identity: Readonly<{
    rosterSnapshotId: string;
    rosterVersion: number;
    recipientId: string;
  }> = {
    rosterSnapshotId: fixture.syntheticRosterSnapshotId,
    rosterVersion: fixture.syntheticRosterVersion,
    recipientId: fixture.syntheticRecipientId,
  },
): Promise<void> {
  const capturedAt = new Date();
  const syncStartedAt = new Date(capturedAt.getTime() - 60_000);
  await database.transaction(async (transaction) => {
    await transaction.insert(rosterSnapshots).values({
      id: identity.rosterSnapshotId,
      version: identity.rosterVersion,
      population: 'synthetic',
      complete: true,
      sourceConfigurationId: SEEDED.rosterConfigurationId,
      sourceConfigurationVersion: 1,
      syncStartedAt,
      capturedAt,
    });
    await transaction.insert(rosterSnapshotFacilities).values([
      { rosterSnapshotId: identity.rosterSnapshotId, facilityId },
      {
        rosterSnapshotId: identity.rosterSnapshotId,
        facilityId: SEEDED.facilitySouthId,
      },
    ]);
    await transaction.insert(rosterSnapshotSources).values(
      [
        { id: SEEDED.groupNorthId, purpose: 'building' as const },
        { id: SEEDED.groupSouthId, purpose: 'building' as const },
        { id: SEEDED.groupOthersId, purpose: 'others' as const },
      ].flatMap((source) => [
        {
          rosterSnapshotId: identity.rosterSnapshotId,
          population: 'synthetic' as const,
          groupSourceId: source.id,
          groupSourceKind: 'synthetic' as const,
          groupPurpose: source.purpose,
          completionKind: 'expected' as const,
        },
        {
          rosterSnapshotId: identity.rosterSnapshotId,
          population: 'synthetic' as const,
          groupSourceId: source.id,
          groupSourceKind: 'synthetic' as const,
          groupPurpose: source.purpose,
          completionKind: 'completed' as const,
        },
      ]),
    );
    await transaction.insert(rosterRecipients).values({
      id: identity.recipientId,
      rosterSnapshotId: identity.rosterSnapshotId,
      population: 'synthetic',
      googleSubject: null,
      displayName: 'Synthetic Device Invalidation Recipient',
    });
    await transaction.insert(rosterRecipientGroupSources).values({
      rosterSnapshotId: identity.rosterSnapshotId,
      recipientId: identity.recipientId,
      population: 'synthetic',
      groupSourceId: SEEDED.groupNorthId,
      groupSourceKind: 'synthetic',
      groupPurpose: 'building',
    });
    await transaction.insert(rosterEndpoints).values(
      registrations.map((registration) => ({
        id: registration.id,
        rosterSnapshotId: identity.rosterSnapshotId,
        recipientId: identity.recipientId,
        population: 'synthetic' as const,
        channel: 'push' as const,
        status: 'active' as const,
        capturedAt,
        platform: 'ios' as const,
        token: registration.token,
        email: null,
        phoneNumber: null,
      })),
    );
  });
}

function mockedIntegrationStatus(integrationId: 'expo-push' | 'ses-email') {
  return Object.freeze({
    integrationId,
    label: 'mocked' as const,
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: SEEDED.integrationObservedAt,
  });
}

function pushResolutionFixture(
  registrations: readonly Readonly<{ id: string; token: string }>[],
  identity: Readonly<{
    rosterSnapshotId: string;
    rosterVersion: number;
    recipientId: string;
  }> = {
    rosterSnapshotId: fixture.syntheticRosterSnapshotId,
    rosterVersion: fixture.syntheticRosterVersion,
    recipientId: fixture.syntheticRecipientId,
  },
) {
  const group = Object.freeze({
    id: SEEDED.groupNorthId,
    kind: 'synthetic' as const,
    purpose: 'building' as const,
    facilityId,
  });
  const rosterSnapshot = RosterSnapshotSchema.parse({
    id: identity.rosterSnapshotId,
    version: identity.rosterVersion,
    population: 'synthetic',
    complete: true,
    sourceConfiguration: { id: SEEDED.rosterConfigurationId, version: 1 },
    facilityIds: [facilityId],
    expectedSourceGroupRefs: [group],
    sourceGroupRefs: [group],
    recipients: [
      {
        id: identity.recipientId,
        population: 'synthetic',
        googleSubject: null,
        displayName: 'Synthetic Device Invalidation Recipient',
        groupSourceRefs: [group],
        endpoints: registrations.map((registration) => ({
          id: registration.id,
          channel: 'push',
          status: 'active',
          capturedAt: SEEDED.integrationObservedAt,
          platform: 'ios',
          token: registration.token,
        })),
      },
    ],
    syncStartedAt: SEEDED.integrationObservedAt,
    capturedAt: SEEDED.integrationObservedAt,
  });
  const requestId = randomUUID();
  const batch = DispatchBatchSchema.parse({
    id: randomUUID(),
    intentId: randomUUID(),
    eventId: randomUUID(),
    facilityId,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: SEEDED.eventTypeVersionId,
      templateMode: 'drill',
    },
    rosterSnapshotId: identity.rosterSnapshotId,
    rosterPopulation: 'synthetic',
    requestId,
    authorization: {
      kind: 'synthetic-training',
      activationPreviewId: randomUUID(),
      consequenceDigest: 'e'.repeat(64),
      requestId,
    },
    channel: 'push',
    renderedMessage: {
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'push',
      title: '[DRILL] Device status overlay test',
      body: '[DRILL] Synthetic and unroutable test only.',
    },
    integrationStatus: mockedIntegrationStatus('expo-push'),
    sequence: 1,
    endpointCount: registrations.length,
    createdAt: SEEDED.integrationObservedAt,
  });
  return Object.freeze({
    batch,
    audience: Object.freeze({
      facilityId,
      rosterSnapshot,
    }),
  });
}

async function installDeviceNotRegisteredAttemptFixture(
  database: PostgresDatabase,
  endpointId: string,
  provider: 'expo-push' | 'mock-expo-push',
): Promise<Date> {
  const ids = Object.freeze({
    event: randomUUID(),
    intent: randomUUID(),
    outbox: randomUUID(),
    batch: randomUUID(),
    attempt: randomUUID(),
    request: randomUUID(),
    preview: randomUUID(),
  });
  const createdAt = new Date();
  const attemptedAt = new Date();
  const authorization = Object.freeze({
    kind: 'synthetic-training' as const,
    activationPreviewId: ids.preview,
    consequenceDigest: 'd'.repeat(64),
    requestId: ids.request,
  });
  const pushMessage = Object.freeze({
    eventKind: 'test' as const,
    templateMode: 'drill' as const,
    purpose: 'activation' as const,
    classificationMarker: 'DRILL' as const,
    channel: 'push' as const,
    title: '[DRILL] Device invalidation test',
    body: '[DRILL] Synthetic and unroutable test only.',
  });
  const emailMessage = Object.freeze({
    eventKind: 'test' as const,
    templateMode: 'drill' as const,
    purpose: 'activation' as const,
    classificationMarker: 'DRILL' as const,
    channel: 'email' as const,
    subject: '[DRILL] Device invalidation test',
    textBody: '[DRILL] Synthetic and unroutable test only.',
  });
  const channels = Object.freeze([
    Object.freeze({
      channel: 'push' as const,
      endpointCount: 1,
      renderedMessage: pushMessage,
      integrationStatus: mockedIntegrationStatus('expo-push'),
    }),
    Object.freeze({
      channel: 'email' as const,
      endpointCount: 1,
      renderedMessage: emailMessage,
      integrationStatus: mockedIntegrationStatus('ses-email'),
    }),
  ]);
  const message = NotificationOutboxMessageSchema.parse({
    version: 2,
    outboxId: ids.outbox,
    intentId: ids.intent,
    eventId: ids.event,
    facilityId,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: SEEDED.eventTypeVersionId,
      templateMode: 'drill',
    },
    rosterSnapshotId: fixture.syntheticRosterSnapshotId,
    rosterPopulation: 'synthetic',
    requestId: ids.request,
    authorization,
    channels,
    createdAt: createdAt.toISOString(),
  });

  await database.transaction(async (transaction) => {
    await transaction.insert(events).values({
      id: ids.event,
      facilityId,
      kind: 'test',
      templateMode: 'drill',
      eventTypeVersionId: SEEDED.eventTypeVersionId,
      status: 'active',
      rosterSnapshotId: fixture.syntheticRosterSnapshotId,
      rosterPopulation: 'synthetic',
      createdBy: {
        kind: 'system',
        serviceId: 'device-invalidation-database-test',
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
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.eventTypeVersionId,
      rosterSnapshotId: fixture.syntheticRosterSnapshotId,
      rosterPopulation: 'synthetic',
      createdBy: {
        kind: 'system',
        serviceId: 'device-invalidation-database-test',
      },
      source: 'scheduled-job',
      requestId: ids.request,
      authorization,
      createdAt,
    });
    await transaction.insert(notificationIntentChannels).values([
      {
        intentId: ids.intent,
        sequence: 1,
        channel: 'push',
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'synthetic',
        classificationMarker: 'DRILL',
        endpointCount: 1,
        renderedMessage: pushMessage,
        integrationStatusId: SEEDED.pushIntegrationStatusId,
        integrationId: 'expo-push',
        integrationLabel: 'mocked',
      },
      {
        intentId: ids.intent,
        sequence: 2,
        channel: 'email',
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'synthetic',
        classificationMarker: 'DRILL',
        endpointCount: 1,
        renderedMessage: emailMessage,
        integrationStatusId: SEEDED.emailIntegrationStatusId,
        integrationId: 'ses-email',
        integrationLabel: 'mocked',
      },
    ]);
    await transaction.insert(outbox).values({
      id: ids.outbox,
      messageVersion: 2,
      intentId: ids.intent,
      eventId: ids.event,
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.eventTypeVersionId,
      rosterSnapshotId: fixture.syntheticRosterSnapshotId,
      rosterPopulation: 'synthetic',
      requestId: ids.request,
      authorization,
      channels,
      message,
      status: 'pending',
      attempts: 0,
      availableAt: createdAt,
      lockedUntil: null,
      publishedAt: null,
      failedAt: null,
      lastErrorCode: null,
      createdAt,
    });
    await transaction.insert(dispatchBatches).values({
      id: ids.batch,
      outboxId: ids.outbox,
      intentId: ids.intent,
      eventId: ids.event,
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersionId: SEEDED.eventTypeVersionId,
      rosterSnapshotId: fixture.syntheticRosterSnapshotId,
      rosterPopulation: 'synthetic',
      requestId: ids.request,
      authorization,
      channel: 'push',
      renderedMessage: pushMessage,
      integrationStatusId: SEEDED.pushIntegrationStatusId,
      integrationId: 'expo-push',
      integrationLabel: 'mocked',
      sequence: 1,
      endpointCount: 1,
      createdAt,
    });
  });

  const attempt = ChannelAttemptSchema.parse({
    id: ids.attempt,
    batchId: ids.batch,
    intentId: ids.intent,
    eventId: ids.event,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: SEEDED.eventTypeVersionId,
      templateMode: 'drill',
    },
    rosterSnapshotId: fixture.syntheticRosterSnapshotId,
    rosterPopulation: 'synthetic',
    recipientId: fixture.syntheticRecipientId,
    endpointId,
    channel: 'push',
    attemptNumber: 1,
    attemptedAt: attemptedAt.toISOString(),
  });
  const attempted: AttemptEvidenceInput = {
    subject: { kind: 'attempt', attemptId: attempt.id },
    state: 'attempted',
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  };
  const failed: AttemptEvidenceInput = {
    subject: { kind: 'attempt', attemptId: attempt.id },
    state: 'failed',
    provider,
    providerReference: null,
    proof: null,
    reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
    diagnosticDigest: null,
  };
  const evidenceStore = createDrizzleDeliveryEvidenceStore(database);
  await evidenceStore.recordAttemptEvidence({ attempt, evidence: attempted });
  await evidenceStore.recordAttemptEvidence({ attempt, evidence: failed });
  return attemptedAt;
}

async function activeRegistrations(database: PostgresDatabase) {
  return database
    .select({
      id: devicePushTokenRegistrations.id,
      token: devicePushTokenRegistrations.token,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.deviceEnrollmentId, fixture.deviceId),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .orderBy(asc(devicePushTokenRegistrations.id));
}

async function activeRegistrationsForToken(
  database: PostgresDatabase,
  token: string,
) {
  return database
    .select({
      id: devicePushTokenRegistrations.id,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.token, token),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .orderBy(asc(devicePushTokenRegistrations.id));
}

describeWithDatabase('device push-token persistence', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    disposableContext = buildDisposableContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(disposableContext);
      connection = openPostgresConnection(disposableContext.databaseUrl, 4);
      await migrateDatabase(connection);
      await seedDatabase(connection.db);
      await installFixture(connection.db);
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Device integration setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
  });

  test('allows exactly one active owner for a concurrently registered push token', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleDeviceCapabilityStore(database);
    const candidates = [
      {
        deviceEnrollmentId: fixture.deviceId,
        sessionId: fixture.sessionId,
        connectivityEpochId: fixture.connectivityEpochId,
      },
      {
        deviceEnrollmentId: fixture.otherDeviceId,
        sessionId: fixture.otherSessionId,
        connectivityEpochId: fixture.otherConnectivityEpochId,
      },
    ] as const;

    const results = await Promise.allSettled(
      candidates.map((candidate, index) =>
        executeDeviceCapability(
          'register-push-token',
          {
            deviceEnrollmentId: candidate.deviceEnrollmentId,
            platform: 'ios',
            token: contendedToken,
          },
          humanInvocation(
            `cross-device-contender-${index}`,
            candidate.sessionId,
            candidate.connectivityEpochId,
          ),
          store,
        ),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        status: 409,
        reasonCode: 'PERSISTENCE_CONFLICT',
        message:
          'The push token is already bound to another device enrollment.',
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(contendedToken);

    const active = await activeRegistrationsForToken(database, contendedToken);
    expect(active).toHaveLength(1);
    const winnerIndex = results.findIndex(
      (result) => result.status === 'fulfilled',
    );
    const winner = candidates[winnerIndex];
    if (winner === undefined || active[0] === undefined) {
      throw new Error('The cross-device token winner was not retained.');
    }
    expect(active[0].deviceEnrollmentId).toBe(winner.deviceEnrollmentId);

    await executeDeviceCapability(
      'unregister-push-token',
      { deviceEnrollmentId: winner.deviceEnrollmentId },
      humanInvocation(
        'cross-device-winner-cleanup',
        winner.sessionId,
        winner.connectivityEpochId,
      ),
      store,
    );
    expect(await activeRegistrationsForToken(database, contendedToken)).toEqual(
      [],
    );
  });

  test('reconciles DNR evidence while allowing only a fresh same-device generation', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleDeviceCapabilityStore(database);
    const registrationInput = {
      deviceEnrollmentId: fixture.deviceId,
      platform: 'ios' as const,
      token: firstToken,
    };

    await Promise.all([
      executeDeviceCapability(
        'register-push-token',
        registrationInput,
        humanInvocation('concurrent-a'),
        store,
      ),
      executeDeviceCapability(
        'register-push-token',
        registrationInput,
        humanInvocation('concurrent-b'),
        store,
      ),
    ]);

    const initialRows = await database
      .select()
      .from(devicePushTokenRegistrations)
      .where(
        and(
          eq(devicePushTokenRegistrations.deviceEnrollmentId, fixture.deviceId),
          eq(devicePushTokenRegistrations.token, firstToken),
        ),
      );
    expect(initialRows).toHaveLength(1);
    const initialRegistration = initialRows[0];
    if (initialRegistration === undefined) {
      throw new Error('The initial registration was not retained.');
    }
    expect(await activeRegistrations(database)).toEqual([
      { id: initialRegistration.id, token: firstToken },
    ]);

    await expect(
      executeDeviceCapability(
        'register-push-token',
        { ...registrationInput, deviceEnrollmentId: fixture.otherDeviceId },
        humanInvocation('cross-device-denied'),
        store,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await database
        .select()
        .from(devicePushTokenRegistrations)
        .where(
          and(
            eq(
              devicePushTokenRegistrations.deviceEnrollmentId,
              fixture.otherDeviceId,
            ),
            eq(devicePushTokenRegistrations.token, firstToken),
          ),
        ),
    ).toHaveLength(0);

    await executeDeviceCapability(
      'register-push-token',
      { ...registrationInput, token: replacementToken },
      humanInvocation('replacement'),
      store,
    );
    const replacementActive = await activeRegistrations(database);
    expect(replacementActive).toHaveLength(1);
    expect(replacementActive[0]?.token).toBe(replacementToken);
    expect(replacementActive[0]?.id).not.toBe(initialRegistration.id);
    expect(
      await database
        .select()
        .from(devicePushTokenUnregistrations)
        .where(
          eq(
            devicePushTokenUnregistrations.registrationId,
            initialRegistration.id,
          ),
        ),
    ).toHaveLength(1);

    const active = replacementActive[0];
    if (active === undefined) {
      throw new Error('The replacement registration was not retained.');
    }
    await publishRosterEndpointFixture(database, active);
    await publishSyntheticRosterEndpointFixture(database, [active]);
    const pushResolution = pushResolutionFixture([active]);
    const pushPolicyStore = createDrizzlePushEndpointPolicyStore(database);
    await expect(
      resolvePushEndpoints(pushResolution, pushPolicyStore),
    ).resolves.toEqual([
      expect.objectContaining({
        rosterSnapshotId: fixture.syntheticRosterSnapshotId,
        recipientId: fixture.syntheticRecipientId,
        endpoint: expect.objectContaining({ id: active.id }),
      }),
    ]);

    const rosterStore = createDrizzleRosterSyncStore(database);
    const beforeInvalidation = await rosterStore.loadLocalContacts([
      googleSubject,
    ]);
    expect(beforeInvalidation[0]?.pushEndpoints).toEqual([
      { id: active.id, platform: 'ios', token: replacementToken },
    ]);

    const invalidationInput = {
      rosterSnapshotId: fixture.syntheticRosterSnapshotId,
      recipientId: fixture.syntheticRecipientId,
      endpointId: active.id,
      status: 'invalid' as const,
      reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
    };

    await installDeviceNotRegisteredAttemptFixture(
      database,
      active.id,
      'expo-push',
    );
    await expect(
      executeDeviceCapability(
        'record-endpoint-status',
        invalidationInput,
        workerInvocation('cross-truth-provider-evidence'),
        store,
      ),
    ).rejects.toMatchObject({
      status: 409,
      reasonCode: 'PERSISTENCE_CONFLICT',
      message:
        'Endpoint invalidation requires retained provider failure evidence.',
    });
    expect(
      await database
        .select()
        .from(endpointStatusRecords)
        .where(
          and(
            eq(
              endpointStatusRecords.rosterSnapshotId,
              fixture.syntheticRosterSnapshotId,
            ),
            eq(endpointStatusRecords.endpointId, active.id),
          ),
        ),
    ).toEqual([]);
    expect(
      await activeRegistrationsForToken(database, replacementToken),
    ).toEqual([{ id: active.id, deviceEnrollmentId: fixture.deviceId }]);

    const attemptedAt = await installDeviceNotRegisteredAttemptFixture(
      database,
      active.id,
      'mock-expo-push',
    );
    const applicationRoleConnection = openPostgresConnection(
      disposableDatabaseContext().databaseUrl,
      1,
    );
    await executeOperationWithCleanup({
      operation: async () => {
        await applicationRoleConnection.db.execute(sql`set role psd_eoc_app`);
        await expect(
          applicationRoleConnection.db.transaction(async (transaction) => {
            const applicationRoleStore =
              createDrizzleDeviceCapabilityStore(transaction);
            return executeDeviceCapability(
              'record-endpoint-status',
              invalidationInput,
              workerInvocation('application-role-dnr'),
              applicationRoleStore,
            );
          }),
        ).resolves.toMatchObject({
          endpointId: active.id,
          status: 'invalid',
          reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
        });
      },
      cleanup: () => applicationRoleConnection.close(),
      failureMessage:
        'Application-role invalidation and connection cleanup both failed.',
    });
    expect(
      await database
        .select()
        .from(devicePushTokenUnregistrations)
        .where(eq(devicePushTokenUnregistrations.registrationId, active.id)),
    ).toHaveLength(1);

    const sameDeviceRace = await Promise.allSettled([
      executeDeviceCapability(
        'register-push-token',
        { ...registrationInput, token: replacementToken },
        humanInvocation('same-device-dnr-race'),
        store,
      ),
      executeDeviceCapability(
        'record-endpoint-status',
        invalidationInput,
        workerInvocation('same-device-dnr-race'),
        store,
      ),
    ]);
    expect(sameDeviceRace.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    const afterSameDeviceRace = await activeRegistrationsForToken(
      database,
      replacementToken,
    );
    expect(afterSameDeviceRace).toHaveLength(1);
    expect(afterSameDeviceRace[0]).toMatchObject({
      deviceEnrollmentId: fixture.deviceId,
    });
    expect(afterSameDeviceRace[0]?.id).not.toBe(active.id);
    await expect(
      resolvePushEndpoints(pushResolution, pushPolicyStore),
    ).resolves.toEqual([]);
    expect(
      await database
        .select()
        .from(devicePushTokenUnregistrations)
        .where(eq(devicePushTokenUnregistrations.registrationId, active.id)),
    ).toHaveLength(1);
    await executeDeviceCapability(
      'unregister-push-token',
      { deviceEnrollmentId: fixture.deviceId },
      humanInvocation('provider-evidence-gap-unregister'),
      store,
    );
    const crossDeviceRace = await Promise.allSettled([
      executeDeviceCapability(
        'register-push-token',
        {
          deviceEnrollmentId: fixture.otherDeviceId,
          platform: 'ios',
          token: replacementToken,
        },
        humanInvocation(
          'provider-evidence-gap-cross-device-denied',
          fixture.otherSessionId,
          fixture.otherConnectivityEpochId,
        ),
        store,
      ),
      executeDeviceCapability(
        'record-endpoint-status',
        invalidationInput,
        workerInvocation('cross-device-dnr-race'),
        store,
      ),
    ]);
    expect(crossDeviceRace[0]).toMatchObject({
      status: 'rejected',
      reason: {
        status: 409,
        reasonCode: 'PERSISTENCE_CONFLICT',
        message: 'The push token cannot be registered.',
      },
    });
    expect(crossDeviceRace[1]).toMatchObject({ status: 'fulfilled' });
    expect(
      await activeRegistrationsForToken(database, replacementToken),
    ).toEqual([]);
    await Bun.sleep(5);
    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.deviceId,
        platform: 'ios',
        token: replacementToken,
      },
      humanInvocation('post-attempt-new-registration'),
      store,
    );
    const [newerRegistration] = await database
      .select({
        id: devicePushTokenRegistrations.id,
        registeredAt: devicePushTokenRegistrations.registeredAt,
      })
      .from(devicePushTokenRegistrations)
      .leftJoin(
        devicePushTokenUnregistrations,
        eq(
          devicePushTokenUnregistrations.registrationId,
          devicePushTokenRegistrations.id,
        ),
      )
      .where(
        and(
          eq(devicePushTokenRegistrations.token, replacementToken),
          isNull(devicePushTokenUnregistrations.id),
        ),
      );
    if (newerRegistration === undefined) {
      throw new Error('The post-attempt registration was not retained.');
    }
    expect(newerRegistration.id).not.toBe(active.id);
    expect(newerRegistration.registeredAt.getTime()).toBeGreaterThan(
      attemptedAt.getTime(),
    );
    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.deviceId,
        platform: 'ios',
        token: replacementToken,
      },
      humanInvocation('post-attempt-registration-replay'),
      store,
    );
    expect(
      await activeRegistrationsForToken(database, replacementToken),
    ).toEqual([
      { id: newerRegistration.id, deviceEnrollmentId: fixture.deviceId },
    ]);
    const firstInvalidation = await executeDeviceCapability(
      'record-endpoint-status',
      invalidationInput,
      workerInvocation('first-evidenced-invalidation'),
      store,
    );

    const repeatedInvalidation = await executeDeviceCapability(
      'record-endpoint-status',
      invalidationInput,
      workerInvocation('semantic-repeat'),
      store,
    );
    expect(repeatedInvalidation).toEqual(firstInvalidation);

    const [
      statusRows,
      unregistrationRows,
      tokenRegistrationRows,
      afterInvalidation,
    ] = await Promise.all([
      database
        .select()
        .from(endpointStatusRecords)
        .where(
          and(
            eq(
              endpointStatusRecords.rosterSnapshotId,
              fixture.syntheticRosterSnapshotId,
            ),
            eq(endpointStatusRecords.endpointId, active.id),
          ),
        ),
      database
        .select()
        .from(devicePushTokenUnregistrations)
        .where(eq(devicePushTokenUnregistrations.registrationId, active.id)),
      database
        .select({
          registrationId: devicePushTokenRegistrations.id,
          unregistrationId: devicePushTokenUnregistrations.id,
        })
        .from(devicePushTokenRegistrations)
        .leftJoin(
          devicePushTokenUnregistrations,
          eq(
            devicePushTokenUnregistrations.registrationId,
            devicePushTokenRegistrations.id,
          ),
        )
        .where(eq(devicePushTokenRegistrations.token, replacementToken)),
      rosterStore.loadLocalContacts([googleSubject]),
    ]);
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]).toMatchObject({
      status: 'invalid',
      reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
    });
    expect(unregistrationRows).toHaveLength(1);
    expect(tokenRegistrationRows.length).toBeGreaterThanOrEqual(1);
    expect(
      tokenRegistrationRows.find(
        (registration) => registration.registrationId === newerRegistration.id,
      )?.unregistrationId,
    ).toBeNull();
    expect(afterInvalidation[0]?.pushEndpoints).toEqual([
      {
        id: newerRegistration.id,
        platform: 'ios',
        token: replacementToken,
      },
    ]);
    expect(await activeRegistrations(database)).toEqual([
      { id: newerRegistration.id, token: replacementToken },
    ]);

    await executeDeviceCapability(
      'unregister-push-token',
      { deviceEnrollmentId: fixture.deviceId },
      humanInvocation('prepare-same-device-recovery'),
      store,
    );
    const crossDeviceRecovery = await Promise.allSettled([
      executeDeviceCapability(
        'register-push-token',
        {
          deviceEnrollmentId: fixture.otherDeviceId,
          platform: 'ios',
          token: replacementToken,
        },
        humanInvocation(
          'cross-device-terminal-token-recovery-denied',
          fixture.otherSessionId,
          fixture.otherConnectivityEpochId,
        ),
        store,
      ),
    ]);
    expect(crossDeviceRecovery[0]).toMatchObject({
      status: 'rejected',
      reason: {
        status: 409,
        reasonCode: 'PERSISTENCE_CONFLICT',
        message: 'The push token cannot be registered.',
      },
    });
    expect(JSON.stringify(crossDeviceRecovery)).not.toContain(replacementToken);
    await Bun.sleep(5);
    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.deviceId,
        platform: 'ios',
        token: replacementToken,
      },
      humanInvocation('same-device-terminal-token-recovery'),
      store,
    );
    const recovered = await activeRegistrations(database);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ token: replacementToken });
    expect(recovered[0]?.id).not.toBe(active.id);
    expect(recovered[0]?.id).not.toBe(newerRegistration.id);
    expect(
      await database
        .select()
        .from(endpointStatusRecords)
        .where(
          and(
            eq(
              endpointStatusRecords.rosterSnapshotId,
              fixture.syntheticRosterSnapshotId,
            ),
            eq(endpointStatusRecords.endpointId, active.id),
          ),
        ),
    ).toHaveLength(1);

    const recoveredRegistration = recovered[0];
    if (recoveredRegistration === undefined) {
      throw new Error('The recovered registration was not retained.');
    }
    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.otherDeviceId,
        platform: 'ios',
        token: unrelatedToken,
      },
      humanInvocation(
        'send-time-policy-unrelated',
        fixture.otherSessionId,
        fixture.otherConnectivityEpochId,
      ),
      store,
    );
    const [unrelatedRegistration] = await activeRegistrationsForToken(
      database,
      unrelatedToken,
    );
    if (unrelatedRegistration === undefined) {
      throw new Error('The unrelated registration was not retained.');
    }

    const crossBoundIdentity = Object.freeze({
      rosterSnapshotId: randomUUID(),
      rosterVersion: fixture.rosterVersion + 1,
      recipientId: randomUUID(),
    });
    await publishRosterEndpointFixture(
      database,
      {
        id: recoveredRegistration.id,
        token: 'synthetic-unroutable:cross-bound-registration',
      },
      crossBoundIdentity,
    );
    await expect(
      pushPolicyStore.loadEndpointPolicy({
        rosterSnapshotId: crossBoundIdentity.rosterSnapshotId,
        rosterPopulation: 'staff',
        candidates: [
          {
            recipientId: crossBoundIdentity.recipientId,
            endpointId: recoveredRegistration.id,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PUSH_ENDPOINT_POLICY' });

    const sendTimeIdentity = Object.freeze({
      rosterSnapshotId: randomUUID(),
      rosterVersion: fixture.syntheticRosterVersion + 1,
      recipientId: randomUUID(),
    });
    const sendTimeRegistrations = Object.freeze([
      recoveredRegistration,
      { id: unrelatedRegistration.id, token: unrelatedToken },
    ]);
    await publishSyntheticRosterEndpointFixture(
      database,
      sendTimeRegistrations,
      sendTimeIdentity,
    );
    const sendTimeResolution = pushResolutionFixture(
      sendTimeRegistrations,
      sendTimeIdentity,
    );
    const sendTimePolicyQuery = Object.freeze({
      rosterSnapshotId: sendTimeIdentity.rosterSnapshotId,
      rosterPopulation: 'synthetic' as const,
      candidates: Object.freeze([
        Object.freeze({
          recipientId: sendTimeIdentity.recipientId,
          endpointId: recoveredRegistration.id,
        }),
        Object.freeze({
          recipientId: sendTimeIdentity.recipientId,
          endpointId: unrelatedRegistration.id,
        }),
      ]),
    });
    const beforeUnregistrationPolicy =
      await pushPolicyStore.loadEndpointPolicy(sendTimePolicyQuery);
    expect(beforeUnregistrationPolicy).toEqual(
      expect.arrayContaining([
        {
          recipientId: sendTimeIdentity.recipientId,
          endpointId: recoveredRegistration.id,
          status: 'active',
        },
        {
          recipientId: sendTimeIdentity.recipientId,
          endpointId: unrelatedRegistration.id,
          status: 'active',
        },
      ]),
    );
    expect(JSON.stringify(beforeUnregistrationPolicy)).not.toContain(
      recoveredRegistration.token,
    );
    expect(JSON.stringify(beforeUnregistrationPolicy)).not.toContain(
      unrelatedToken,
    );
    await expect(
      resolvePushEndpoints(sendTimeResolution, pushPolicyStore),
    ).resolves.toHaveLength(2);

    await executeDeviceCapability(
      'unregister-push-token',
      { deviceEnrollmentId: fixture.deviceId },
      humanInvocation('send-time-policy-unregister'),
      store,
    );

    const afterUnregistrationPolicy =
      await pushPolicyStore.loadEndpointPolicy(sendTimePolicyQuery);
    expect(afterUnregistrationPolicy).toEqual(
      expect.arrayContaining([
        {
          recipientId: sendTimeIdentity.recipientId,
          endpointId: recoveredRegistration.id,
          status: 'disabled',
        },
        {
          recipientId: sendTimeIdentity.recipientId,
          endpointId: unrelatedRegistration.id,
          status: 'active',
        },
      ]),
    );
    expect(JSON.stringify(afterUnregistrationPolicy)).not.toContain(
      recoveredRegistration.token,
    );
    expect(JSON.stringify(afterUnregistrationPolicy)).not.toContain(
      unrelatedToken,
    );
    await expect(
      resolvePushEndpoints(sendTimeResolution, pushPolicyStore),
    ).resolves.toEqual([
      expect.objectContaining({
        endpoint: expect.objectContaining({ id: unrelatedRegistration.id }),
      }),
    ]);
    expect(
      await database
        .select({
          registrationId: devicePushTokenUnregistrations.registrationId,
          deviceEnrollmentId: devicePushTokenUnregistrations.deviceEnrollmentId,
        })
        .from(devicePushTokenUnregistrations)
        .where(
          inArray(devicePushTokenUnregistrations.registrationId, [
            recoveredRegistration.id,
            unrelatedRegistration.id,
          ]),
        )
        .orderBy(asc(devicePushTokenUnregistrations.registrationId)),
    ).toEqual([
      {
        registrationId: recoveredRegistration.id,
        deviceEnrollmentId: fixture.deviceId,
      },
    ]);
  });

  test('denies push-token mutation from an append-only revoked session', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleDeviceCapabilityStore(database);
    await database.insert(sessionRevocations).values({
      sessionId: fixture.revokedSessionId,
      revokedBy: {
        kind: 'human',
        userId: fixture.userId,
        sessionId: fixture.sessionId,
      },
      reasonCode: 'USER_REQUESTED_REVOCATION',
      revokedAt: new Date(),
    });

    await expect(
      executeDeviceCapability(
        'register-push-token',
        {
          deviceEnrollmentId: fixture.deviceId,
          platform: 'ios',
          token: revokedSessionToken,
        },
        humanInvocation(
          'revoked-session-denied',
          fixture.revokedSessionId,
          fixture.revokedConnectivityEpochId,
        ),
        store,
      ),
    ).rejects.toMatchObject({
      status: 403,
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
      message: 'The current session cannot manage this device enrollment.',
    });
    expect(
      await database
        .select({ id: devicePushTokenRegistrations.id })
        .from(devicePushTokenRegistrations)
        .where(eq(devicePushTokenRegistrations.token, revokedSessionToken)),
    ).toEqual([]);
  });
});
