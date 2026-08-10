import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  connectivityEpochs,
  deviceEnrollments,
  groupSources,
  sessions,
  userRoleChanges,
  userRoles,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { DrizzleSessionStore } from './sessions';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The session integration database is not open.');
  }
  return connection;
}

describeWithDatabase('PostgreSQL session effective-role projection', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 2,
    });
    if (created.driver !== 'postgres') {
      throw new Error('Session integration tests require PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('reloads a retained session with the latest grant and revocation facts', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const userId = randomUUID();
    const groupSourceId = randomUUID();
    const snapshotId = randomUUID();
    const deviceEnrollmentId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const googleSubject = `issue-26-session-${suffix}`;

    await database.insert(groupSources).values({
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: `Issue 26 session group ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-26-session-${suffix}`,
      email: `issue-26-session-${suffix}@example.invalid`,
      fixtureKey: null,
      createdAt: now,
    });
    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-session-${suffix}@psd401.net`,
      displayName: `Issue 26 session user ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: now,
    });
    await database.insert(userRoles).values({ userId, role: 'staff' });
    await database.insert(accessMembershipSnapshots).values({
      id: snapshotId,
      version: 2_100_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
      complete: true,
      syncStartedAt: now,
      capturedAt: now,
    });
    await database.insert(accessMembershipSnapshotGroups).values([
      {
        snapshotId,
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'expected',
      },
      {
        snapshotId,
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'completed',
      },
    ]);
    await database.insert(accessMembershipMembers).values({
      snapshotId,
      userId,
      googleSubject,
      facilityScopeKind: 'district',
    });
    await database.insert(accessMembershipMemberGroups).values({
      snapshotId,
      userId,
      groupSourceId,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
    await database.insert(deviceEnrollments).values({
      id: deviceEnrollmentId,
      userId,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `issue-26-session-${suffix}`,
      enrolledAt: now,
      lastSeenAt: now,
    });
    await database.insert(sessions).values({
      id: sessionId,
      userId,
      deviceEnrollmentId,
      membershipSnapshotId: snapshotId,
      membershipValidUntil: new Date(now.getTime() + 60 * 60 * 1_000),
      membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
    });
    await database.insert(connectivityEpochs).values({
      id: randomUUID(),
      sessionId,
      establishedAt: now,
    });
    await database.insert(userRoleChanges).values([
      {
        userId,
        role: 'admin',
        granted: true,
        changedByUserId: userId,
        changedWithSessionId: sessionId,
        requestId: randomUUID(),
        occurredAt: now,
      },
      {
        userId,
        role: 'staff',
        granted: false,
        changedByUserId: userId,
        changedWithSessionId: sessionId,
        requestId: randomUUID(),
        occurredAt: now,
      },
    ]);

    const context = await new DrizzleSessionStore(database).getSession(
      sessionId,
    );
    expect(context?.result.user.roles).toEqual(['admin']);
  });
});
