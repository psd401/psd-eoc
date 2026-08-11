import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { desc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
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
import { calculateSecurityAuditHash } from '../audit/canonical';
import type { AuthenticatedSession } from './sessions';
import {
  ACCESS_GATE_AUDIT_LOCK_SQL,
  checkAccessGate,
  createDrizzleAccessGateAuditSink,
  createDrizzleAccessGateStore,
} from './access-gate';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface AccessGateTestContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i26_gate_[a-f0-9]{32}_test$/u;

let context: AccessGateTestContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
let databaseCreated = false;

function buildContext(baseDatabaseUrl: string): AccessGateTestContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i26_gate_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable access-gate database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-26:access-gate-test:${runId}`,
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
    throw new Error('Access-gate integration tests require PostgreSQL.');
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
    throw new Error(
      'The disposable access-gate database identity is ambiguous.',
    );
  }
  return rows[0]?.marker;
}

async function createOwnedDatabase(
  createdContext: AccessGateTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  let created = false;
  try {
    await admin.db.execute(
      sql.raw(`create database "${createdContext.databaseName}"`),
    );
    created = true;
    await admin.db.execute(
      sql.raw(
        `comment on database "${createdContext.databaseName}" is ${quotedLiteral(createdContext.marker)}`,
      ),
    );
    expect(await readDatabaseMarker(admin, createdContext.databaseName)).toBe(
      createdContext.marker,
    );
  } catch (error) {
    if (created) {
      try {
        await admin.db.execute(
          sql.raw(
            `drop database "${createdContext.databaseName}" with (force)`,
          ),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Disposable access-gate database creation and rollback both failed.',
        );
      }
    }
    throw error;
  } finally {
    await admin.close();
  }
}

async function dropOwnedDatabase(
  createdContext: AccessGateTestContext,
): Promise<void> {
  const admin = openPostgresConnection(createdContext.baseDatabaseUrl, 1);
  try {
    const marker = await readDatabaseMarker(admin, createdContext.databaseName);
    if (marker === undefined) return;
    if (marker !== createdContext.marker) {
      throw new Error(
        'Refusing to drop a database without the exact issue #26 access-gate ownership marker.',
      );
    }
    await admin.db.execute(
      sql.raw(`drop database "${createdContext.databaseName}" with (force)`),
    );
    expect(
      await readDatabaseMarker(admin, createdContext.databaseName),
    ).toBeUndefined();
  } finally {
    await admin.close();
  }
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
  if (databaseCreated && context !== undefined) {
    try {
      await dropOwnedDatabase(context);
      databaseCreated = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #26 access-gate integration test cleanup failed.',
    );
  }
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The access-gate integration database is not open.');
  }
  return connection;
}

async function appendLegacyAccessGroupUpdateAudit(input: {
  readonly authenticated: AuthenticatedSession;
  readonly groupSourceId: string;
  readonly occurredAt: Date;
}): Promise<void> {
  const database = databaseConnection().db;
  await database.transaction(async (transaction) => {
    await transaction.execute(ACCESS_GATE_AUDIT_LOCK_SQL);
    const [previous] = await transaction
      .select({
        sequence: securityAuditEntries.sequence,
        entryHash: securityAuditEntries.entryHash,
      })
      .from(securityAuditEntries)
      .orderBy(desc(securityAuditEntries.sequence))
      .limit(1);
    const payload = {
      id: randomUUID(),
      sequence: (previous?.sequence ?? 0) + 1,
      previousHash: previous?.entryHash ?? null,
      category: 'admin-change' as const,
      action: 'update-group-source',
      actionIds: [],
      confirmationId: null,
      outcome: 'success' as const,
      principal: input.authenticated.actor,
      source: 'web' as const,
      facilityId: null,
      target: {
        kind: 'configuration' as const,
        id: `group-source:access:${input.groupSourceId}`,
      },
      requestId: randomUUID(),
      reasonCode: null,
      occurredAt: input.occurredAt.toISOString(),
    } as const;
    await transaction.insert(securityAuditEntries).values({
      id: payload.id,
      sequence: payload.sequence,
      previousHash: payload.previousHash,
      entryHash: calculateSecurityAuditHash(payload),
      category: payload.category,
      action: payload.action,
      actionIds: [...payload.actionIds],
      confirmationId: payload.confirmationId,
      outcome: payload.outcome,
      principalKind: payload.principal.kind,
      principal: payload.principal,
      source: payload.source,
      facilityId: payload.facilityId,
      targetKind: payload.target.kind,
      targetId: payload.target.id,
      requestId: payload.requestId,
      reasonCode: payload.reasonCode,
      occurredAt: input.occurredAt,
    });
  });
}

describeWithDatabase('PostgreSQL access-gate evidence projection', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      databaseCreated = true;
      connection = openPostgresConnection(context.databaseUrl, 2);
      await migrateDatabase(connection);
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Access-gate database setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
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
      targetId: buildingReplacement.id,
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
      targetId: groupSourceId,
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

    const replacementSnapshotId = randomUUID();
    const replacementCapturedAt = new Date(now.getTime() + 4_000);
    await database.insert(accessMembershipSnapshots).values({
      id: replacementSnapshotId,
      version: snapshotVersion + 1,
      complete: true,
      syncStartedAt: replacementCapturedAt,
      capturedAt: replacementCapturedAt,
    });
    await database.insert(accessMembershipSnapshotGroups).values([
      {
        snapshotId: replacementSnapshotId,
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'expected',
      },
      {
        snapshotId: replacementSnapshotId,
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'completed',
      },
    ]);
    await database.insert(accessMembershipMembers).values({
      snapshotId: replacementSnapshotId,
      userId,
      googleSubject,
      facilityScopeKind: 'district',
    });
    await database.insert(accessMembershipMemberGroups).values({
      snapshotId: replacementSnapshotId,
      userId,
      groupSourceId,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
    const afterReplacementSync = await checkAccessGate(
      {
        googleSubject,
        subjectDigest: 'c'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date(now.getTime() + 4_500).toISOString(),
        source: 'web',
      },
      {
        store: gateStore,
        audit: auditSink,
        bootstrapAdminSubjects: new Set(),
      },
    );
    expect(afterReplacementSync.granted).toBe(true);

    await appendLegacyAccessGroupUpdateAudit({
      authenticated,
      groupSourceId,
      occurredAt: new Date(now.getTime() + 5_000),
    });
    const afterLegacyAccessCorrection = await checkAccessGate(
      {
        googleSubject,
        subjectDigest: 'd'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date(now.getTime() + 6_000).toISOString(),
        source: 'web',
      },
      {
        store: gateStore,
        audit: auditSink,
        bootstrapAdminSubjects: new Set(),
      },
    );
    expect(afterLegacyAccessCorrection).toEqual({
      granted: false,
      reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
    });
  });
});
