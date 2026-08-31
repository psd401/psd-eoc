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
  DeliveryEvidenceSchema,
  DispatchBatchSchema,
  EndpointSchema,
  NotificationOutboxMessageSchema,
  RosterSnapshotSchema,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../../lib/testing/owned-database-lifecycle';
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
  channelAttemptExecutions,
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
  rosterSnapshotWithLivePushTokens,
} from '../../../lib/capabilities/devices';
import { createDrizzleRosterSyncStore } from '../../../lib/roster/groups-sync';
import { loadRosterSnapshot } from '../../../lib/capabilities/start';
import { createDrizzleExpoPushRuntimeStore } from '../../../lib/notify/expo-push-runtime-store';
import { createDrizzleAttemptExecutionStore } from '../../../lib/notify/attempt-execution-store';
import { createPersistedExpoReceiptTarget } from '../../../../../workers/push/receipt-lifecycle';
import { workerAttemptFingerprint } from '../../../../../workers/shared/attempt';
import {
  WorkerAttemptProcessor,
  type AttemptExecutionStore as WorkerAttemptExecutionStore,
  type AttemptIdempotentProviderAdapter,
} from '../../../../../workers/shared/processor';

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
  runtimeRosterSnapshotId: randomUUID(),
  syntheticRosterSnapshotId: randomUUID(),
  recipientId: randomUUID(),
  runtimeRecipientId: randomUUID(),
  syntheticRecipientId: randomUUID(),
  runtimeEndpointId: randomUUID(),
  rosterVersion: randomInt(100_000_000, 900_000_000),
  runtimeRosterVersion: 2,
  syntheticRosterVersion: 3,
  membershipVersion: randomInt(100_000_000, 900_000_000),
});
const fixtureSuffix = fixture.userId.replaceAll('-', '');
const googleSubject = `synthetic-device-${fixtureSuffix}`;
const firstToken = `ExponentPushToken[synthetic-${fixtureSuffix}-first]`;
const replacementToken = `synthetic-unroutable:device-${fixtureSuffix}-replacement`;
const contendedToken = `ExponentPushToken[synthetic-${fixtureSuffix}-contended]`;
const revokedSessionToken = `ExponentPushToken[synthetic-${fixtureSuffix}-revoked]`;
const unrelatedToken = `synthetic-unroutable:device-${fixtureSuffix}-unrelated`;
const runtimeToken = `synthetic-unroutable:push-runtime-${fixture.runtimeEndpointId}`;
const pushBuild = Object.freeze({
  applicationId: 'example.synthetic.eoc',
  applicationVersion: '1.0.4',
  nativeBuildVersion: '7',
  expoProjectId: '00000000-0000-4000-8000-000000001299',
  updateMode: 'embedded-only' as const,
});
const registrationIdentity = Object.freeze({
  provider: 'expo' as const,
  serviceEnvironment: 'production' as const,
  build: pushBuild,
});
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

function deviceCapabilityStore(database: PostgresDatabase) {
  return createDrizzleDeviceCapabilityStore(database);
}

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
      provider: 'expo',
      serviceEnvironment: 'production',
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
  installSnapshot = true,
): Promise<void> {
  const capturedAt = new Date();
  const syncStartedAt = new Date(capturedAt.getTime() - 60_000);
  await database.transaction(async (transaction) => {
    if (installSnapshot) {
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
    }
    if (registrations.length > 0) {
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
          provider: 'expo' as const,
          serviceEnvironment: 'production' as const,
          token: registration.token,
          email: null,
          phoneNumber: null,
        })),
      );
    }
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
          provider: 'expo',
          serviceEnvironment: 'production',
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
  provider: 'expo-push' | 'mock-expo-push' | null,
  identity: Readonly<{
    rosterSnapshotId: string;
    recipientId: string;
  }> = {
    rosterSnapshotId: fixture.syntheticRosterSnapshotId,
    recipientId: fixture.syntheticRecipientId,
  },
) {
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
    rosterSnapshotId: identity.rosterSnapshotId,
    rosterPopulation: 'synthetic',
    requestId: ids.request,
    authorization,
    channels,
    createdAt: createdAt.toISOString(),
  });
  const batch = DispatchBatchSchema.parse({
    id: ids.batch,
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
    rosterSnapshotId: identity.rosterSnapshotId,
    rosterPopulation: 'synthetic',
    requestId: ids.request,
    authorization,
    channel: 'push',
    renderedMessage: pushMessage,
    integrationStatus: mockedIntegrationStatus('expo-push'),
    sequence: 1,
    endpointCount: 1,
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
      rosterSnapshotId: identity.rosterSnapshotId,
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
      rosterSnapshotId: identity.rosterSnapshotId,
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
      rosterSnapshotId: identity.rosterSnapshotId,
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
      rosterSnapshotId: identity.rosterSnapshotId,
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
    rosterSnapshotId: identity.rosterSnapshotId,
    rosterPopulation: 'synthetic',
    recipientId: identity.recipientId,
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
  const attemptedEvidence = await evidenceStore.recordAttemptEvidence({
    attempt,
    evidence: attempted,
  });
  if (provider !== null) {
    await evidenceStore.recordAttemptEvidence({ attempt, evidence: failed });
  }
  return Object.freeze({ attempt, attemptedAt, attemptedEvidence, batch });
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
      await publishSyntheticRosterEndpointFixture(
        connection.db,
        [{ id: fixture.runtimeEndpointId, token: runtimeToken }],
        {
          rosterSnapshotId: fixture.runtimeRosterSnapshotId,
          rosterVersion: fixture.runtimeRosterVersion,
          recipientId: fixture.runtimeRecipientId,
        },
      );
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

  test('atomically registers provider-scoped native and Expo fallback lineages', async () => {
    const database = databaseConnection().db;
    const expoToken = `ExponentPushToken[synthetic-${fixtureSuffix}-atomic]`;
    const nativeToken = `synthetic-apns-${fixtureSuffix}-atomic`;

    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.deviceId,
        platform: 'ios',
        provider: 'apns',
        serviceEnvironment: 'production',
        build: pushBuild,
        token: nativeToken,
        expoFallbackToken: expoToken,
      },
      humanInvocation('atomic-provider-generation'),
      deviceCapabilityStore(database),
    );

    const active = await database
      .select({
        provider: devicePushTokenRegistrations.provider,
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
      .orderBy(asc(devicePushTokenRegistrations.provider));
    expect(active).toEqual([
      { provider: 'apns', token: nativeToken },
      { provider: 'expo', token: expoToken },
    ]);

    const directRosterStore = createDrizzleRosterSyncStore(database, {
      version: 1,
      ios: 'direct',
      android: 'expo',
    });
    await expect(
      directRosterStore.loadLocalContacts([googleSubject]),
    ).resolves.toEqual([
      expect.objectContaining({
        pushEndpoints: [expect.objectContaining({ provider: 'apns' })],
      }),
    ]);

    const expoRosterStore = createDrizzleRosterSyncStore(database, {
      version: 1,
      ios: 'expo',
      android: 'expo',
    });
    await expect(
      expoRosterStore.loadLocalContacts([googleSubject]),
    ).resolves.toEqual([
      expect.objectContaining({
        pushEndpoints: [expect.objectContaining({ provider: 'expo' })],
      }),
    ]);

    const [expoRegistration] = await database
      .select({ id: devicePushTokenRegistrations.id })
      .from(devicePushTokenRegistrations)
      .where(
        and(
          eq(devicePushTokenRegistrations.deviceEnrollmentId, fixture.deviceId),
          eq(devicePushTokenRegistrations.provider, 'expo'),
          eq(devicePushTokenRegistrations.token, expoToken),
        ),
      )
      .limit(1);
    if (expoRegistration === undefined) {
      throw new Error('Atomic Expo fallback registration was not retained.');
    }
    await database.insert(devicePushTokenUnregistrations).values({
      registrationId: expoRegistration.id,
      deviceEnrollmentId: fixture.deviceId,
      unregisteredAt: new Date(),
    });
    await expect(
      expoRosterStore.loadLocalContacts([googleSubject]),
    ).rejects.toMatchObject({ code: 'DIRECT_PUSH_COVERAGE_INCOMPLETE' });

    await executeDeviceCapability(
      'unregister-push-token',
      { deviceEnrollmentId: fixture.deviceId },
      humanInvocation('atomic-provider-generation-cleanup'),
      deviceCapabilityStore(database),
    );

    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.deviceId,
        platform: 'ios',
        provider: 'expo',
        serviceEnvironment: 'production',
        build: pushBuild,
        token: expoToken,
      },
      humanInvocation('incomplete-direct-generation'),
      deviceCapabilityStore(database),
    );
    await expect(
      directRosterStore.loadLocalContacts([googleSubject]),
    ).rejects.toMatchObject({ code: 'DIRECT_PUSH_COVERAGE_INCOMPLETE' });
    await executeDeviceCapability(
      'unregister-push-token',
      { deviceEnrollmentId: fixture.deviceId },
      humanInvocation('incomplete-direct-generation-cleanup'),
      deviceCapabilityStore(database),
    );
  });

  test('allows exactly one active owner for a concurrently registered push token', async () => {
    const database = databaseConnection().db;
    const store = deviceCapabilityStore(database);
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
            ...registrationIdentity,
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

  test('durably fences provider I/O, receipts, and opaque retries', async () => {
    const database = databaseConnection().db;
    const endpointId = fixture.runtimeEndpointId;
    const token = runtimeToken;
    const runtimeIdentity = Object.freeze({
      rosterSnapshotId: fixture.runtimeRosterSnapshotId,
      recipientId: fixture.runtimeRecipientId,
    });
    const installed = await installDeviceNotRegisteredAttemptFixture(
      database,
      endpointId,
      null,
      runtimeIdentity,
    );
    const runtimeStore = createDrizzleExpoPushRuntimeStore(database);
    await expect(runtimeStore.countStuckOutbox()).resolves.toBe(0);
    const endpoint = EndpointSchema.parse({
      id: endpointId,
      status: 'active',
      capturedAt: installed.attempt.attemptedAt,
      channel: 'push',
      platform: 'ios',
      provider: 'expo',
      serviceEnvironment: 'production',
      token,
    });
    const workItem = Object.freeze({
      batch: installed.batch,
      attempt: installed.attempt,
      endpoint,
    });
    const fingerprint = workerAttemptFingerprint(workItem);

    const firstResolution = await runtimeStore.resolveBatch({
      operation: 'resolve-batch',
      batch: installed.batch,
      enqueuedAt: new Date(
        Date.parse(installed.batch.createdAt) + 1_000,
      ).toISOString(),
      cursor: 0,
    });
    const redeliveredResolution = await runtimeStore.resolveBatch({
      operation: 'resolve-batch',
      batch: installed.batch,
      enqueuedAt: new Date(
        Date.parse(installed.batch.createdAt) + 30_000,
      ).toISOString(),
      cursor: 0,
    });
    expect(redeliveredResolution).toEqual(firstResolution);
    expect(firstResolution.items[0]?.attempt.attemptedAt).toBe(
      installed.batch.createdAt,
    );

    const firstClaim = await runtimeStore.claimProviderIo({
      attemptId: installed.attempt.id,
      workFingerprint: fingerprint,
    });
    if (firstClaim.kind !== 'execute') {
      throw new Error('The first provider I/O claim was not acquired.');
    }
    const concurrentClaim = await runtimeStore.claimProviderIo({
      attemptId: installed.attempt.id,
      workFingerprint: fingerprint,
    });
    expect(concurrentClaim).toEqual({ kind: 'uncertain' });
    const completion = Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        state: 'provider-accepted' as const,
        provider: 'expo-push',
        providerReference: 'synthetic-ticket-reference',
        proof: null,
        reasonCode: null,
        diagnosticDigest: null,
      }),
    });
    await runtimeStore.completeProviderIo({
      attemptId: installed.attempt.id,
      workFingerprint: fingerprint,
      claimToken: firstClaim.claimToken,
      completion,
    });
    await expect(
      runtimeStore.lookupProviderIo({
        attemptId: installed.attempt.id,
        workFingerprint: fingerprint,
      }),
    ).resolves.toEqual({ kind: 'completed', completion });

    const providerAcceptedEvidence = DeliveryEvidenceSchema.parse({
      id: randomUUID(),
      subject: { kind: 'attempt', attemptId: installed.attempt.id },
      sequence: 2,
      previousEvidenceId: installed.attemptedEvidence.id,
      state: 'provider-accepted',
      recordedAt: new Date(
        installed.attemptedAt.getTime() + 1_000,
      ).toISOString(),
      provider: 'expo-push',
      providerReference: 'synthetic-ticket-reference',
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });
    const receiptTarget = createPersistedExpoReceiptTarget(
      workItem,
      providerAcceptedEvidence,
    );
    const firstPollAt = new Date().toISOString();
    await runtimeStore.scheduleReceipt({
      target: receiptTarget,
      firstPollAt,
      horizonAt: receiptTarget.expiresAt,
    });
    await runtimeStore.scheduleReceipt({
      target: receiptTarget,
      firstPollAt,
      horizonAt: receiptTarget.expiresAt,
    });
    const claims = await runtimeStore.claimDueReceipts({
      now: new Date().toISOString(),
      limit: 10,
      leaseMilliseconds: 60_000,
    });
    expect(claims).toHaveLength(1);
    const receiptClaim = claims[0];
    if (receiptClaim === undefined) throw new Error('Missing receipt claim.');
    await runtimeStore.decideReceipt({
      attemptId: installed.attempt.id,
      fingerprint: receiptTarget.fingerprint,
      leaseToken: receiptClaim.leaseToken,
      decision: {
        kind: 'complete',
        decidedAt: new Date().toISOString(),
        state: 'provider-accepted',
      },
    });
    await expect(
      runtimeStore.claimDueReceipts({
        now: new Date().toISOString(),
        limit: 10,
        leaseMilliseconds: 60_000,
      }),
    ).resolves.toEqual([]);

    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const retryRequest = {
      operation: 'schedule-retry' as const,
      sourceAttempt: installed.attempt,
      sourceFingerprint: fingerprint,
      receiptId: null,
      nextAttemptNumber: 2,
      delayMilliseconds: 60_000,
      retryAt,
      expiresAt: receiptTarget.expiresAt,
      reasonCode: 'EXPO_HTTP_RATE_LIMITED',
    };
    const scheduled = await runtimeStore.scheduleRetry(retryRequest);
    expect(scheduled).toEqual({
      kind: 'scheduled',
      attemptId: expect.any(String),
      retryAt,
    });
    await expect(runtimeStore.scheduleRetry(retryRequest)).resolves.toEqual(
      scheduled,
    );
    if (scheduled.kind !== 'scheduled') {
      throw new Error('The retry schedule unexpectedly expired.');
    }
    await expect(
      runtimeStore.resolveRetry(scheduled.attemptId),
    ).resolves.toEqual({ kind: 'not-before', retryAt });
  });

  test('reclaims an expired outer lease only after adapter-ledger recovery', async () => {
    const database = databaseConnection().db;
    const endpointId = fixture.runtimeEndpointId;
    const endpointToken = runtimeToken;
    const installed = await installDeviceNotRegisteredAttemptFixture(
      database,
      endpointId,
      null,
      {
        rosterSnapshotId: fixture.runtimeRosterSnapshotId,
        recipientId: fixture.runtimeRecipientId,
      },
    );
    const workItem = Object.freeze({
      batch: installed.batch,
      attempt: installed.attempt,
      endpoint: EndpointSchema.parse({
        id: endpointId,
        status: 'active',
        capturedAt: installed.attempt.attemptedAt,
        channel: 'push',
        platform: 'ios',
        provider: 'expo',
        serviceEnvironment: 'production',
        token: endpointToken,
      }),
    });
    const fingerprint = workerAttemptFingerprint(workItem);
    const executionStore = createDrizzleAttemptExecutionStore(database);
    expect(
      await executionStore.claim({
        attemptId: installed.attempt.id,
        fingerprint,
        leaseMilliseconds: 60_000,
      }),
    ).toMatchObject({ kind: 'acquired' });
    await database
      .update(channelAttemptExecutions)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(channelAttemptExecutions.attemptId, installed.attempt.id));
    const reclaimable = await executionStore.lookup({
      attemptId: installed.attempt.id,
      fingerprint,
    });
    expect(reclaimable).toEqual({ kind: 'reclaimable' });

    let recoveries = 0;
    let sends = 0;
    const adapter = Object.freeze({
      channel: 'push' as const,
      integrationId: 'expo-push',
      truthLabel: 'mocked' as const,
      provider: 'mock-expo',
      deliverySemantics: 'attempt-id-idempotent' as const,
      recover: () => {
        recoveries += 1;
        return Promise.resolve({ kind: 'missing' as const });
      },
      send: () => {
        sends += 1;
        return Promise.resolve({
          state: 'provider-accepted' as const,
          provider: 'mock-expo',
          providerReference: 'synthetic-expired-lease-ticket',
          proof: null,
          reasonCode: null,
          diagnosticDigest: null,
        });
      },
    }) satisfies AttemptIdempotentProviderAdapter;
    const processor = new WorkerAttemptProcessor({
      adapter,
      // The production boundary serializes the server store's opaque outcome
      // through the strict worker HTTP client. This test composes the same
      // methods directly so it can exercise the real transaction and lease.
      executionStore: executionStore as unknown as WorkerAttemptExecutionStore,
      evidenceWriter: createDrizzleDeliveryEvidenceStore(database),
    });

    await expect(processor.process(workItem)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: false }),
    );
    expect({ recoveries, sends }).toEqual({ recoveries: 1, sends: 1 });
    await expect(processor.process(workItem)).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', replayed: true }),
    );
    expect({ recoveries, sends }).toEqual({ recoveries: 1, sends: 1 });
  });

  test('rejects a stale unique receipt decision after a receipt collision', async () => {
    const database = databaseConnection().db;
    const runtimeStore = createDrizzleExpoPushRuntimeStore(database);
    const evidenceStore = createDrizzleDeliveryEvidenceStore(database);
    const sharedReceiptId = `synthetic-conflicted-receipt-${randomUUID()}`;
    const targets: ReturnType<typeof createPersistedExpoReceiptTarget>[] = [];
    for (const endpointId of [
      fixture.runtimeEndpointId,
      fixture.runtimeEndpointId,
    ]) {
      const endpointToken = runtimeToken;
      const installed = await installDeviceNotRegisteredAttemptFixture(
        database,
        endpointId,
        null,
        {
          rosterSnapshotId: fixture.runtimeRosterSnapshotId,
          recipientId: fixture.runtimeRecipientId,
        },
      );
      const accepted = await evidenceStore.recordAttemptEvidence({
        attempt: installed.attempt,
        evidence: {
          subject: { kind: 'attempt', attemptId: installed.attempt.id },
          state: 'provider-accepted',
          provider: 'expo-push',
          providerReference: sharedReceiptId,
          proof: null,
          reasonCode: null,
          diagnosticDigest: null,
        },
      });
      const item = Object.freeze({
        batch: installed.batch,
        attempt: installed.attempt,
        endpoint: EndpointSchema.parse({
          id: endpointId,
          status: 'active',
          capturedAt: installed.attempt.attemptedAt,
          channel: 'push',
          platform: 'ios',
          provider: 'expo',
          serviceEnvironment: 'production',
          token: endpointToken,
        }),
      });
      targets.push(createPersistedExpoReceiptTarget(item, accepted));
    }
    const first = targets[0];
    const second = targets[1];
    if (first === undefined || second === undefined) {
      throw new Error('The receipt collision fixtures were not created.');
    }
    const firstPollAt = new Date().toISOString();
    await runtimeStore.scheduleReceipt({
      target: first,
      firstPollAt,
      horizonAt: first.expiresAt,
    });
    const [staleUniqueClaim] = await runtimeStore.claimDueReceipts({
      now: new Date().toISOString(),
      limit: 1,
      leaseMilliseconds: 60_000,
    });
    if (staleUniqueClaim === undefined) {
      throw new Error('The unique receipt claim was not acquired.');
    }
    expect(staleUniqueClaim.receiptReferenceState).toBe('unique');
    await runtimeStore.scheduleReceipt({
      target: second,
      firstPollAt,
      horizonAt: second.expiresAt,
    });

    await expect(
      runtimeStore.decideReceipt({
        attemptId: first.attempt.id,
        fingerprint: first.fingerprint,
        leaseToken: staleUniqueClaim.leaseToken,
        decision: {
          kind: 'known-outcome-pending',
          decidedAt: new Date().toISOString(),
          action: {
            kind: 'terminal-failure',
            state: 'failed',
            reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
            invalidatesEndpoint: true,
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });

    const decidedAt = new Date().toISOString();
    await runtimeStore.decideReceipt({
      attemptId: first.attempt.id,
      fingerprint: first.fingerprint,
      leaseToken: staleUniqueClaim.leaseToken,
      decision: {
        kind: 'known-outcome-pending',
        decidedAt,
        action: {
          kind: 'terminal-unknown',
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
        },
      },
    });
    await expect(
      runtimeStore.decideReceipt({
        attemptId: first.attempt.id,
        fingerprint: first.fingerprint,
        leaseToken: staleUniqueClaim.leaseToken,
        decision: {
          kind: 'terminal-dlq',
          decidedAt,
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
        },
      }),
    ).resolves.toBeUndefined();
  });

  test('reconciles DNR evidence while allowing only a fresh same-device generation', async () => {
    const database = databaseConnection().db;
    const store = deviceCapabilityStore(database);
    const registrationInput = {
      deviceEnrollmentId: fixture.deviceId,
      platform: 'ios' as const,
      ...registrationIdentity,
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
    const staffPolicyQuery = Object.freeze({
      rosterSnapshotId: fixture.rosterSnapshotId,
      rosterPopulation: 'staff' as const,
      candidates: Object.freeze([
        Object.freeze({
          recipientId: fixture.recipientId,
          endpointId: active.id,
        }),
      ]),
    });
    // A complete, well-formed registration is eligible for a send. It is no
    // longer additionally required to match a hand-maintained list of exact
    // shipped builds.
    await expect(
      createDrizzlePushEndpointPolicyStore(database).loadEndpointPolicy(
        staffPolicyQuery,
      ),
    ).resolves.toEqual([
      {
        recipientId: fixture.recipientId,
        endpointId: active.id,
        status: 'active',
      },
    ]);
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

    const missingCutoverStore = createDrizzleRosterSyncStore(database, null);
    for (const identityKeys of [[], [googleSubject]] as const) {
      await expect(
        missingCutoverStore.loadLocalContacts(identityKeys),
      ).rejects.toMatchObject({
        code: 'LOCAL_CONTACT_CAPTURE_INVALID',
        message: 'Roster publication requires an exact push-provider cutover.',
      });
    }

    const rosterStore = createDrizzleRosterSyncStore(database, {
      version: 1,
      ios: 'expo',
      android: 'expo',
    });
    const beforeInvalidation = await rosterStore.loadLocalContacts([
      googleSubject,
    ]);
    expect(beforeInvalidation[0]?.pushEndpoints).toEqual([
      {
        id: active.id,
        platform: 'ios',
        provider: 'expo',
        serviceEnvironment: 'production',
        token: replacementToken,
      },
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

    const { attemptedAt } = await installDeviceNotRegisteredAttemptFixture(
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
          ...registrationIdentity,
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
        ...registrationIdentity,
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
        ...registrationIdentity,
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
        provider: 'expo',
        serviceEnvironment: 'production',
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
          ...registrationIdentity,
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
        ...registrationIdentity,
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
        ...registrationIdentity,
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
    // This snapshot names the same person by Google subject but carries an
    // unroutable copy of the token. A snapshot pins who is notified, not where:
    // the endpoint resolves against the recipient's live registration, so it is
    // deliverable, and it is deliverable to the live token rather than to the
    // frozen one. Refusing here is what used to drop a reinstalled device out
    // of push until somebody republished the roster.
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
    ).resolves.toEqual([
      {
        recipientId: crossBoundIdentity.recipientId,
        endpointId: recoveredRegistration.id,
        status: 'active',
      },
    ]);

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
    const store = deviceCapabilityStore(database);
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
          ...registrationIdentity,
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

  test('reaches a reinstalled device without republishing the roster', async () => {
    const database = databaseConnection().db;
    const store = deviceCapabilityStore(database);
    const supersededToken = `ExponentPushToken[synthetic-${fixtureSuffix}-preinstall]`;
    const reinstalledToken = `ExponentPushToken[synthetic-${fixtureSuffix}-reinstall]`;

    // The device the roster was published from.
    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.deviceId,
        platform: 'ios' as const,
        ...registrationIdentity,
        token: supersededToken,
      },
      humanInvocation('reinstall-original'),
      store,
    );
    const [published] = await activeRegistrationsForToken(
      database,
      supersededToken,
    );
    if (published === undefined) {
      throw new Error('The published registration was not retained.');
    }
    const snapshotIdentity = Object.freeze({
      rosterSnapshotId: randomUUID(),
      rosterVersion: fixture.rosterVersion + 2,
      recipientId: randomUUID(),
    });
    await publishRosterEndpointFixture(
      database,
      { id: published.id, token: supersededToken },
      snapshotIdentity,
    );

    // Reinstalling the app enrolls a new installation and mints a new
    // registration. It does not unregister the install it replaced -- that
    // install is simply gone -- so the superseded registration stays behind,
    // still marked active and no longer deliverable.
    await executeDeviceCapability(
      'register-push-token',
      {
        deviceEnrollmentId: fixture.otherDeviceId,
        platform: 'ios' as const,
        ...registrationIdentity,
        token: reinstalledToken,
      },
      humanInvocation(
        'reinstall-replacement',
        fixture.otherSessionId,
        fixture.otherConnectivityEpochId,
      ),
      store,
    );
    const [reinstalled] = await activeRegistrationsForToken(
      database,
      reinstalledToken,
    );
    if (reinstalled === undefined) {
      throw new Error('The reinstalled registration was not retained.');
    }
    expect(reinstalled.id).not.toBe(published.id);
    expect(reinstalled.deviceEnrollmentId).not.toBe(
      published.deviceEnrollmentId,
    );
    expect(
      await database
        .select({ id: devicePushTokenUnregistrations.id })
        .from(devicePushTokenUnregistrations)
        .where(eq(devicePushTokenUnregistrations.registrationId, published.id)),
    ).toEqual([]);

    // The endpoint the roster froze still resolves. Before this, the policy
    // matched the endpoint back to a registration by id and compared tokens,
    // so a reinstall silently produced zero push endpoints and nothing was
    // ever enqueued. Email kept working, because an address is stable, which
    // is exactly how this stayed hidden.
    const policyQuery = Object.freeze({
      rosterSnapshotId: snapshotIdentity.rosterSnapshotId,
      rosterPopulation: 'staff' as const,
      candidates: Object.freeze([
        Object.freeze({
          recipientId: snapshotIdentity.recipientId,
          endpointId: published.id,
        }),
      ]),
    });
    await expect(
      createDrizzlePushEndpointPolicyStore(database).loadEndpointPolicy(
        policyQuery,
      ),
    ).resolves.toEqual([
      {
        recipientId: snapshotIdentity.recipientId,
        endpointId: published.id,
        status: 'active',
      },
    ]);

    // Delivery reads the audience, not the policy evidence, so resolving the
    // policy is only half of it: the endpoint has to be sent to the token the
    // reinstalled device registered, not the one the snapshot remembers.
    const snapshot = await loadRosterSnapshot(
      database as unknown as Parameters<typeof loadRosterSnapshot>[0],
      'staff',
      facilityId,
      snapshotIdentity.rosterSnapshotId,
    );
    if (snapshot === null) {
      throw new Error('The published roster snapshot was not readable.');
    }
    expect(
      snapshot.recipients
        .flatMap((recipient) => recipient.endpoints)
        .filter((endpoint) => endpoint.channel === 'push')
        .map((endpoint) => endpoint.token),
    ).toEqual([supersededToken]);
    const live = await rosterSnapshotWithLivePushTokens(
      database as unknown as Parameters<
        typeof rosterSnapshotWithLivePushTokens
      >[0],
      snapshot,
    );
    expect(
      live.recipients
        .flatMap((recipient) => recipient.endpoints)
        .filter((endpoint) => endpoint.channel === 'push')
        .map((endpoint) => endpoint.token),
    ).toEqual([reinstalledToken]);
  });
});
