import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  deviceEnrollments,
  groupSources,
  sessions,
  securityAuditEntries,
  userRoleChanges,
  userRoles,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import { createDrizzleAdminCapabilityStore } from '../../app/(admin)/facilities/admin-core';
import {
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeUpdateGroupSourceCapability,
} from '../../app/(admin)/facilities/capabilities';
import type { AuthenticatedSession } from './sessions';
import {
  checkAccessGate,
  createDrizzleAccessGateAuditSink,
  createDrizzleAccessGateStore,
} from './access-gate';

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
    const now = new Date(Date.now() + 60_000);

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
    const deviceEnrollmentId = randomUUID();
    const sessionId = randomUUID();
    await database.insert(deviceEnrollments).values({
      id: deviceEnrollmentId,
      userId,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `issue-26-access-gate-${suffix}`,
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

    const evidence =
      await createDrizzleAccessGateStore(database).loadEvidence(googleSubject);
    const expectedRef = {
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
    } as const;
    expect(evidence.user?.roles).toEqual(['admin']);
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

    const authenticated = {
      actor: { kind: 'human', userId, sessionId },
      source: 'web',
      roles: ['admin'],
      scope: { facilityScope: { kind: 'district' } },
      membershipState: 'fresh',
      result: { connectivityEpoch: { id: randomUUID() } },
    } as unknown as AuthenticatedSession;
    const adminStore = createDrizzleAdminCapabilityStore(
      database,
      authenticated,
    );
    const facility = await executeCreateFacilityCapability({
      authenticated,
      store: adminStore,
      command: {
        code: `GATE-${suffix.slice(0, 8).toUpperCase()}`,
        name: `Access gate correction site ${suffix.slice(0, 8)}`,
      },
      metadata: {
        idempotencyKey: `issue-26-gate-facility-${suffix}`,
        requestId: randomUUID(),
        now,
      },
    });
    const building = await executeCreateGroupSourceCapability({
      authenticated,
      store: adminStore,
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `Access gate building ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-gate-building-${suffix}`,
        email: `issue-26-gate-building-${suffix}@example.invalid`,
      },
      metadata: {
        idempotencyKey: `issue-26-gate-building-${suffix}`,
        requestId: randomUUID(),
        now,
      },
    });
    const buildingUpdateRequestId = randomUUID();
    const buildingUpdatedAt = new Date(now.getTime() + 1_000);
    const buildingReplacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store: adminStore,
      command: {
        id: building.id,
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `Corrected access gate building ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-gate-building-v2-${suffix}`,
        email: `issue-26-gate-building-v2-${suffix}@example.invalid`,
      },
      metadata: {
        idempotencyKey: `issue-26-gate-building-v2-${suffix}`,
        requestId: buildingUpdateRequestId,
        now: buildingUpdatedAt,
      },
    });
    const [buildingUpdateAudit] = await database
      .select({
        targetKind: securityAuditEntries.targetKind,
        targetId: securityAuditEntries.targetId,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, buildingUpdateRequestId))
      .limit(1);
    expect(buildingUpdateAudit).toEqual({
      targetKind: 'configuration',
      targetId: `group-source:building:${buildingReplacement.id}`,
    });

    const gateStore = createDrizzleAccessGateStore(database);
    const auditSink = createDrizzleAccessGateAuditSink(database);
    const afterBuildingCorrection = await checkAccessGate(
      {
        googleSubject,
        subjectDigest: 'a'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date(now.getTime() + 1_500).toISOString(),
        source: 'web',
      },
      {
        store: gateStore,
        audit: auditSink,
        bootstrapAdminSubjects: new Set(),
      },
    );
    expect(afterBuildingCorrection.granted).toBe(true);

    const accessUpdateRequestId = randomUUID();
    const accessUpdatedAt = new Date(now.getTime() + 2_000);
    await executeUpdateGroupSourceCapability({
      authenticated,
      store: adminStore,
      command: {
        id: groupSourceId,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: `Corrected access gate ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-gate-v2-${suffix}`,
        email: `issue-26-access-gate-v2-${suffix}@example.invalid`,
      },
      metadata: {
        idempotencyKey: `issue-26-gate-access-v2-${suffix}`,
        requestId: accessUpdateRequestId,
        now: accessUpdatedAt,
      },
    });
    const [accessUpdateAudit] = await database
      .select({
        targetKind: securityAuditEntries.targetKind,
        targetId: securityAuditEntries.targetId,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, accessUpdateRequestId))
      .limit(1);
    expect(accessUpdateAudit).toEqual({
      targetKind: 'configuration',
      targetId: `group-source:access:${groupSourceId}`,
    });
    const afterAccessCorrection = await checkAccessGate(
      {
        googleSubject,
        subjectDigest: 'b'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date(now.getTime() + 3_000).toISOString(),
        source: 'web',
      },
      {
        store: gateStore,
        audit: auditSink,
        bootstrapAdminSubjects: new Set(),
      },
    );
    expect(afterAccessCorrection).toEqual({
      granted: false,
      reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
    });
  });
});
