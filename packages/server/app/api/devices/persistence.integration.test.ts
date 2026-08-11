import { randomInt, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../(admin)/facilities/owned-database-lifecycle';
import { requireSyntheticTestDatabaseUrl } from '../../(admin)/event-types/test-database';
import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import { seedDatabase } from '../../../db/seed';
import {
  accessMembershipMembers,
  accessMembershipSnapshots,
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  groupSources,
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
import type { TrustedCapabilityInvocation } from '../../../lib/capabilities/engine';
import {
  createDrizzleDeviceCapabilityStore,
  EXPO_DEVICE_NOT_REGISTERED_REASON,
  executeDeviceCapability,
  PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
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
  recipientId: randomUUID(),
  rosterVersion: randomInt(100_000_000, 900_000_000),
  membershipVersion: randomInt(100_000_000, 900_000_000),
});
const fixtureSuffix = fixture.userId.replaceAll('-', '');
const googleSubject = `synthetic-device-${fixtureSuffix}`;
const firstToken = `ExponentPushToken[synthetic-${fixtureSuffix}-first]`;
const replacementToken = `ExponentPushToken[synthetic-${fixtureSuffix}-replacement]`;
const contendedToken = `ExponentPushToken[synthetic-${fixtureSuffix}-contended]`;
const revokedSessionToken = `ExponentPushToken[synthetic-${fixtureSuffix}-revoked]`;
const facilityId = '00000000-0000-4000-8000-000000000001';

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
      email: `synthetic-device-${fixtureSuffix}@psd401.net`,
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
    await transaction.insert(accessMembershipMembers).values({
      snapshotId: fixture.membershipSnapshotId,
      userId: fixture.userId,
      googleSubject,
      facilityScopeKind: 'district',
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
): Promise<void> {
  const capturedAt = new Date();
  const syncStartedAt = new Date(capturedAt.getTime() - 60_000);
  await database.transaction(async (transaction) => {
    await transaction.insert(rosterSnapshots).values({
      id: fixture.rosterSnapshotId,
      version: fixture.rosterVersion,
      population: 'staff',
      complete: true,
      sourceConfigurationId: fixture.rosterConfigurationId,
      sourceConfigurationVersion: 1,
      syncStartedAt,
      capturedAt,
    });
    await transaction.insert(rosterSnapshotFacilities).values({
      rosterSnapshotId: fixture.rosterSnapshotId,
      facilityId,
    });
    await transaction.insert(rosterSnapshotSources).values([
      {
        rosterSnapshotId: fixture.rosterSnapshotId,
        population: 'staff',
        groupSourceId: fixture.groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'expected',
      },
      {
        rosterSnapshotId: fixture.rosterSnapshotId,
        population: 'staff',
        groupSourceId: fixture.groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(rosterRecipients).values({
      id: fixture.recipientId,
      rosterSnapshotId: fixture.rosterSnapshotId,
      population: 'staff',
      googleSubject,
      displayName: 'Synthetic Device Integration Recipient',
    });
    await transaction.insert(rosterRecipientGroupSources).values({
      rosterSnapshotId: fixture.rosterSnapshotId,
      recipientId: fixture.recipientId,
      population: 'staff',
      groupSourceId: fixture.groupSourceId,
      groupSourceKind: 'google-group',
      groupPurpose: 'building',
    });
    await transaction.insert(rosterEndpoints).values({
      id: registration.id,
      rosterSnapshotId: fixture.rosterSnapshotId,
      recipientId: fixture.recipientId,
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

  test('serializes registration and terminal invalidation without resurrecting a token', async () => {
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

    const rosterStore = createDrizzleRosterSyncStore(database);
    const beforeInvalidation = await rosterStore.loadLocalContacts([
      googleSubject,
    ]);
    expect(beforeInvalidation[0]?.pushEndpoints).toEqual([
      { id: active.id, platform: 'ios', token: replacementToken },
    ]);

    await executeDeviceCapability(
      'unregister-push-token',
      { deviceEnrollmentId: fixture.deviceId },
      humanInvocation('pre-invalidation-unregister'),
      store,
    );
    expect(
      await activeRegistrationsForToken(database, replacementToken),
    ).toEqual([]);

    const invalidationInput = {
      rosterSnapshotId: fixture.rosterSnapshotId,
      recipientId: fixture.recipientId,
      endpointId: active.id,
      status: 'invalid' as const,
      reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
    };
    const [registrationRace, invalidationRace] = await Promise.allSettled([
      executeDeviceCapability(
        'register-push-token',
        {
          deviceEnrollmentId: fixture.deviceId,
          platform: 'ios',
          token: replacementToken,
        },
        humanInvocation('concurrent-terminal-token-reregistration'),
        store,
      ),
      executeDeviceCapability(
        'record-endpoint-status',
        invalidationInput,
        workerInvocation('first'),
        store,
      ),
    ]);
    expect(invalidationRace.status).toBe('fulfilled');
    if (invalidationRace.status !== 'fulfilled') {
      throw new Error('The terminal token invalidation did not complete.');
    }
    const firstInvalidation = invalidationRace.value;
    expect(['fulfilled', 'rejected']).toContain(registrationRace.status);
    if (registrationRace.status === 'rejected') {
      expect(registrationRace.reason).toMatchObject({
        status: 409,
        reasonCode: 'PERSISTENCE_CONFLICT',
        message: 'The push token cannot be registered.',
      });
    }
    expect(JSON.stringify(registrationRace)).not.toContain(replacementToken);

    const repeatedInvalidation = await executeDeviceCapability(
      'record-endpoint-status',
      invalidationInput,
      workerInvocation('semantic-repeat'),
      store,
    );
    expect(repeatedInvalidation.id).toBe(firstInvalidation.id);

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
              fixture.rosterSnapshotId,
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
      tokenRegistrationRows.every(
        (registration) => registration.unregistrationId !== null,
      ),
    ).toBe(true);
    expect(afterInvalidation[0]?.pushEndpoints).toEqual([]);
    expect(await activeRegistrations(database)).toEqual([]);
    expect(
      await activeRegistrationsForToken(database, replacementToken),
    ).toEqual([]);

    const [terminalReregistration] = await Promise.allSettled([
      executeDeviceCapability(
        'register-push-token',
        {
          deviceEnrollmentId: fixture.deviceId,
          platform: 'ios',
          token: replacementToken,
        },
        humanInvocation('terminal-token-reregistration-denied'),
        store,
      ),
    ]);
    expect(terminalReregistration).toMatchObject({
      status: 'rejected',
      reason: {
        status: 409,
        reasonCode: 'PERSISTENCE_CONFLICT',
        message: 'The push token cannot be registered.',
      },
    });
    expect(JSON.stringify(terminalReregistration)).not.toContain(
      replacementToken,
    );
    expect(
      await activeRegistrationsForToken(database, replacementToken),
    ).toEqual([]);
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
