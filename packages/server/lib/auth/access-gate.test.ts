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
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  userRoles,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import { createDrizzleAccessGateStore } from './access-gate';

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
    throw new Error('The access-gate integration database is not open.');
  }
  return connection;
}

describeWithDatabase('PostgreSQL access-gate evidence projection', () => {
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
      throw new Error('Access-gate integration tests require PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('maps expected and completed rows to strict canonical group refs', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const groupSourceId = randomUUID();
    const userId = randomUUID();
    const snapshotId = randomUUID();
    const googleSubject = `issue-26-access-gate-${suffix}`;
    const snapshotVersion =
      2_000_000_000 + Number.parseInt(suffix.slice(0, 6), 16);
    const now = new Date();

    await database.insert(groupSources).values({
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: `Issue 26 access gate ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-26-access-gate-${suffix}`,
      email: `issue-26-access-gate-${suffix}@example.invalid`,
      fixtureKey: null,
      createdAt: now,
    });
    await database.insert(users).values({
      id: userId,
      googleSubject,
      email: `issue-26-access-gate-${suffix}@psd401.net`,
      displayName: `Issue 26 access member ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
      createdAt: now,
    });
    await database.insert(userRoles).values({ userId, role: 'staff' });
    await database.insert(accessMembershipSnapshots).values({
      id: snapshotId,
      version: snapshotVersion,
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

    const evidence =
      await createDrizzleAccessGateStore(database).loadEvidence(googleSubject);
    const expectedRef = {
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
    } as const;
    expect(evidence.user?.roles).toEqual(['staff']);
    expect(evidence.snapshot?.expectedAccessGroupSourceRefs).toEqual([
      expectedRef,
    ]);
    expect(evidence.snapshot?.completedAccessGroupSourceRefs).toEqual([
      expectedRef,
    ]);
    expect(evidence.snapshot?.member?.accessGroupSourceRefs).toEqual([
      expectedRef,
    ]);
    expect(
      Reflect.has(
        evidence.snapshot?.expectedAccessGroupSourceRefs[0] ?? {},
        'completionKind',
      ),
    ).toBe(false);
  });
});
