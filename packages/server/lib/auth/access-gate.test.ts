import { createHash, randomUUID } from 'node:crypto';

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
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  deviceEnrollments,
  facilities,
  groupSources,
  sessions,
  securityAuditEntries,
  userFacilityScopes,
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
  createDrizzleInitialWebSessionStore,
  type PersistInitialWebSessionRequest,
} from './session-cookie';
import {
  ACCESS_GATE_AUDIT_LOCK_SQL,
  AccessGateConfigurationError,
  checkAccessGate,
  createDrizzleAccessGateAuditSink,
  createDrizzleAccessGateStore,
  type AccessGateEvidence,
} from './access-gate';
import {
  loadAccessConfigurationSnapshotState,
  loadEffectiveAdministratorUserIds,
} from './role-state';

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

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
        await dropOwnedDatabase(createdContext);
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

describe('strict access-gate snapshot projection', () => {
  test('ignores audit chronology but rejects duplicated or noncanonical access refs', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    const snapshotId = '10000000-0000-4000-8000-000000000002';
    const groupSourceId = '10000000-0000-4000-8000-000000000003';
    const googleSubject = 'synthetic-strict-access-subject';
    const ref = Object.freeze({
      id: groupSourceId,
      kind: 'google-group' as const,
      purpose: 'access' as const,
      facilityId: null,
    });
    const evidence: AccessGateEvidence = Object.freeze({
      user: Object.freeze({
        id: userId,
        googleSubject,
        email: 'synthetic.strict.access@psd401.net',
        displayName: 'Synthetic Strict Access',
        roles: Object.freeze(['staff'] as const),
        facilityScope: Object.freeze({ kind: 'district' as const }),
        createdAt: '2026-08-10T18:00:00.000Z',
        disabledAt: null,
      }),
      activeAccessGroupSourceRefs: Object.freeze([ref]),
      // A completed replay can append a later audit fact, but it does not
      // create a new access-configuration generation.
      latestSuccessfulGroupSourceUpdateAt: '2026-08-10T18:30:00.000Z',
      snapshot: Object.freeze({
        id: snapshotId,
        version: 1,
        syncStartedAt: '2026-08-10T18:05:00.000Z',
        capturedAt: '2026-08-10T18:06:00.000Z',
        expectedAccessGroupSourceRefs: Object.freeze([ref]),
        completedAccessGroupSourceRefs: Object.freeze([ref]),
        member: Object.freeze({
          userId,
          googleSubject,
          accessGroupSourceRefs: Object.freeze([ref]),
          facilityScope: Object.freeze({ kind: 'district' as const }),
        }),
      }),
    });
    const audit = Object.freeze({
      async append() {
        return {} as never;
      },
    });
    const input = {
      googleSubject,
      subjectDigest: 'a'.repeat(64),
      requestId: randomUUID(),
      checkedAt: '2026-08-10T18:31:00.000Z',
      source: 'web' as const,
    };

    expect(
      await checkAccessGate(input, {
        store: { loadEvidence: async () => evidence },
        audit,
        bootstrapAdminSubjects: new Set(),
      }),
    ).toMatchObject({ granted: true });

    const duplicated = Object.freeze({
      ...evidence,
      snapshot: Object.freeze({
        ...evidence.snapshot,
        expectedAccessGroupSourceRefs: Object.freeze([ref, ref]),
      }),
    }) as AccessGateEvidence;
    expect(
      await checkAccessGate(
        { ...input, requestId: randomUUID() },
        {
          store: { loadEvidence: async () => duplicated },
          audit,
          bootstrapAdminSubjects: new Set(),
        },
      ),
    ).toEqual({
      granted: false,
      reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
    });

    const noncanonical = Object.freeze({
      ...evidence,
      snapshot: Object.freeze({
        ...evidence.snapshot,
        completedAccessGroupSourceRefs: Object.freeze([
          { ...ref, completionKind: 'completed' },
        ]),
      }),
    }) as unknown as AccessGateEvidence;
    expect(
      await checkAccessGate(
        { ...input, requestId: randomUUID() },
        {
          store: { loadEvidence: async () => noncanonical },
          audit,
          bootstrapAdminSubjects: new Set(),
        },
      ),
    ).toEqual({
      granted: false,
      reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED',
    });
  });
});

describeWithDatabase('PostgreSQL access-gate evidence projection', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      databaseCreated = true;
      await createOwnedDatabase(context);
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
    const backupGroupSourceId = randomUUID();
    const userId = randomUUID();
    const backupUserId = randomUUID();
    const snapshotId = randomUUID();
    const googleSubject = `issue-26-access-gate-${suffix}`;
    const backupGoogleSubject = `issue-26-access-backup-${suffix}`;
    const snapshotVersion =
      2_000_000_000 + Number.parseInt(suffix.slice(0, 6), 16);
    const now = new Date(Date.now() + 60_000);

    await database.insert(groupSources).values([
      {
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
      },
      {
        id: backupGroupSourceId,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: `Issue 26 backup access ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-backup-${suffix}`,
        email: `issue-26-access-backup-${suffix}@example.invalid`,
        fixtureKey: null,
        createdAt: now,
      },
    ]);
    await database.insert(users).values([
      {
        id: userId,
        googleSubject,
        email: `issue-26-access-gate-${suffix}@psd401.net`,
        displayName: `Issue 26 access member ${suffix.slice(0, 8)}`,
        facilityScopeKind: 'district',
        createdAt: now,
      },
      {
        id: backupUserId,
        googleSubject: backupGoogleSubject,
        email: `issue-26-access-backup-${suffix}@psd401.net`,
        displayName: `Issue 26 backup admin ${suffix.slice(0, 8)}`,
        facilityScopeKind: 'district',
        createdAt: now,
      },
    ]);
    await database.insert(userRoles).values([
      { userId, role: 'staff' },
      { userId: backupUserId, role: 'admin' },
    ]);
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: snapshotVersion,
        complete: true,
        syncStartedAt: now,
        capturedAt: now,
      });
      await transaction.insert(accessMembershipSnapshotGroups).values(
        [groupSourceId, backupGroupSourceId].flatMap((sourceId) => [
          {
            snapshotId,
            groupSourceId: sourceId,
            groupSourceKind: 'google-group' as const,
            groupPurpose: 'access' as const,
            completionKind: 'expected' as const,
          },
          {
            snapshotId,
            groupSourceId: sourceId,
            groupSourceKind: 'google-group' as const,
            groupPurpose: 'access' as const,
            completionKind: 'completed' as const,
          },
        ]),
      );
      await transaction.insert(accessMembershipMembers).values([
        {
          snapshotId,
          userId,
          googleSubject,
          facilityScopeKind: 'district',
        },
        {
          snapshotId,
          userId: backupUserId,
          googleSubject: backupGoogleSubject,
          facilityScopeKind: 'district',
        },
      ]);
      await transaction.insert(accessMembershipMemberGroups).values([
        {
          snapshotId,
          userId,
          groupSourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
        {
          snapshotId,
          userId: backupUserId,
          groupSourceId: backupGroupSourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
      ]);
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
    const backupRef = {
      id: backupGroupSourceId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
    } as const;
    const expectedRefs = [expectedRef, backupRef].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    expect(evidence.user?.roles).toEqual(['admin']);
    expect(evidence.snapshot?.expectedAccessGroupSourceRefs).toEqual(
      expectedRefs,
    );
    expect(evidence.snapshot?.completedAccessGroupSourceRefs).toEqual(
      expectedRefs,
    );
    expect(evidence.snapshot?.member?.accessGroupSourceRefs).toEqual([
      expectedRef,
    ]);
    expect(
      Reflect.has(
        evidence.snapshot?.expectedAccessGroupSourceRefs[0] ?? {},
        'completionKind',
      ),
    ).toBe(false);
    const initialAccessState =
      await loadAccessConfigurationSnapshotState(database);
    expect(initialAccessState).toEqual({
      snapshotId,
      snapshotVersion,
      activeAccessGroupSourceIds: [groupSourceId, backupGroupSourceId].sort(),
    });
    if (initialAccessState === null) {
      throw new Error('The initial access snapshot must be exact.');
    }
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: initialAccessState,
      }),
    ).toEqual([userId, backupUserId].sort());

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
    const buildingUpdateIdempotencyKey = `issue-26-gate-building-v2-${suffix}`;
    const buildingUpdateCommand = {
      id: building.id,
      kind: 'google-group',
      purpose: 'building',
      facilityId: facility.id,
      displayName: `Corrected access gate building ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-26-gate-building-v2-${suffix}`,
      email: `issue-26-gate-building-v2-${suffix}@example.invalid`,
    } as const;
    const buildingReplacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store: adminStore,
      command: buildingUpdateCommand,
      metadata: {
        idempotencyKey: buildingUpdateIdempotencyKey,
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

    const buildingReplayRequestId = randomUUID();
    const buildingReplay = await executeUpdateGroupSourceCapability({
      authenticated,
      store: adminStore,
      command: buildingUpdateCommand,
      metadata: {
        idempotencyKey: buildingUpdateIdempotencyKey,
        requestId: buildingReplayRequestId,
        now: new Date(now.getTime() + 1_250),
      },
    });
    expect(buildingReplay).toEqual(buildingReplacement);
    const [buildingReplayAudit] = await database
      .select({
        targetKind: securityAuditEntries.targetKind,
        targetId: securityAuditEntries.targetId,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, buildingReplayRequestId))
      .limit(1);
    expect(buildingReplayAudit).toEqual({
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

    if (
      evidence.user === null ||
      evidence.snapshot === null ||
      evidence.snapshot.member === null
    ) {
      throw new Error('The exact access evidence is required for issuance.');
    }
    const issuanceCreatedAt = new Date(now.getTime() + 1_750);
    const responseDigest = digest(`building-update-response:${suffix}`);
    const principal = {
      kind: 'oidc-callback' as const,
      subjectDigest: digest(googleSubject),
      responseDigest,
    };
    const issuanceRequest: PersistInitialWebSessionRequest = Object.freeze({
      user: evidence.user,
      membershipSnapshot: Object.freeze({
        id: snapshotId,
        version: snapshotVersion,
        complete: true as const,
        syncStartedAt: now.toISOString(),
        capturedAt: now.toISOString(),
      }),
      membershipMember: evidence.snapshot.member,
      device: Object.freeze({
        platform: 'web' as const,
        unlockMethod: 'secure-session-cookie' as const,
        installationId: `issue-26-building-issuance-${suffix}`,
      }),
      credentialDigest: digest(`building-update-credential:${suffix}`),
      createdAt: issuanceCreatedAt,
      expiresAt: new Date(issuanceCreatedAt.getTime() + 3 * 60 * 60 * 1_000),
      membershipValidUntil: new Date(
        issuanceCreatedAt.getTime() + 60 * 60 * 1_000,
      ),
      membershipGraceUntil: new Date(
        issuanceCreatedAt.getTime() + 2 * 60 * 60 * 1_000,
      ),
      grantBootstrapAdmin: false,
      requestId: randomUUID(),
      idempotency: Object.freeze({
        key: `oidc:${responseDigest}`,
        principal,
        principalDigest: digest(JSON.stringify(principal)),
        requestDigest: digest(`building-update-request:${suffix}`),
      }),
    });
    const issuedAfterUnrelatedUpdate =
      await createDrizzleInitialWebSessionStore(database).persist(
        issuanceRequest,
      );
    expect(issuedAfterUnrelatedUpdate.user.id).toBe(userId);

    const invalidResponseDigest = digest(
      `noncanonical-membership-response:${suffix}`,
    );
    const invalidPrincipal = {
      kind: 'oidc-callback' as const,
      subjectDigest: digest(googleSubject),
      responseDigest: invalidResponseDigest,
    };
    await expect(
      createDrizzleInitialWebSessionStore(database).persist({
        ...issuanceRequest,
        credentialDigest: digest(
          `noncanonical-membership-credential:${suffix}`,
        ),
        requestId: randomUUID(),
        membershipMember: {
          ...evidence.snapshot.member,
          accessGroupSourceRefs:
            evidence.snapshot.member.accessGroupSourceRefs.map((source) => ({
              ...source,
              completionKind: 'completed',
            })),
        } as unknown as PersistInitialWebSessionRequest['membershipMember'],
        idempotency: Object.freeze({
          key: `oidc:${invalidResponseDigest}`,
          principal: invalidPrincipal,
          principalDigest: digest(JSON.stringify(invalidPrincipal)),
          requestDigest: digest(`noncanonical-membership-request:${suffix}`),
        }),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_PERSISTENCE_REJECTED' });

    const accessUpdateRequestId = randomUUID();
    const accessUpdatedAt = new Date(now.getTime() + 2_000);
    const accessUpdateIdempotencyKey = `issue-26-gate-access-v2-${suffix}`;
    const accessReplacement = await executeUpdateGroupSourceCapability({
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
        idempotencyKey: accessUpdateIdempotencyKey,
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
      targetId: accessReplacement.id,
    });
    expect(accessReplacement.id).not.toBe(groupSourceId);
    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();
    expect(await loadEffectiveAdministratorUserIds(database)).toEqual([]);
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
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: replacementSnapshotId,
        version: snapshotVersion + 1,
        complete: true,
        syncStartedAt: replacementCapturedAt,
        capturedAt: replacementCapturedAt,
      });
      await transaction.insert(accessMembershipSnapshotGroups).values(
        [groupSourceId, accessReplacement.id, backupGroupSourceId].flatMap(
          (sourceId) => [
            {
              snapshotId: replacementSnapshotId,
              groupSourceId: sourceId,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
              completionKind: 'expected' as const,
            },
            {
              snapshotId: replacementSnapshotId,
              groupSourceId: sourceId,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
              completionKind: 'completed' as const,
            },
          ],
        ),
      );
      await transaction.insert(accessMembershipMembers).values([
        {
          snapshotId: replacementSnapshotId,
          userId,
          googleSubject,
          facilityScopeKind: 'district',
        },
        {
          snapshotId: replacementSnapshotId,
          userId: backupUserId,
          googleSubject: backupGoogleSubject,
          facilityScopeKind: 'district',
        },
      ]);
      await transaction.insert(accessMembershipMemberGroups).values([
        {
          snapshotId: replacementSnapshotId,
          userId,
          groupSourceId: accessReplacement.id,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
        {
          snapshotId: replacementSnapshotId,
          userId: backupUserId,
          groupSourceId: backupGroupSourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
      ]);
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

    const completedReplayRequestId = randomUUID();
    const completedReplay = await executeUpdateGroupSourceCapability({
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
        idempotencyKey: accessUpdateIdempotencyKey,
        requestId: completedReplayRequestId,
        now: new Date(now.getTime() + 4_750),
      },
    });
    expect(completedReplay).toEqual(accessReplacement);
    const [completedReplayAudit] = await database
      .select({
        targetKind: securityAuditEntries.targetKind,
        targetId: securityAuditEntries.targetId,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, completedReplayRequestId))
      .limit(1);
    expect(completedReplayAudit).toEqual({
      targetKind: 'configuration',
      targetId: accessReplacement.id,
    });
    const afterCompletedReplay = await checkAccessGate(
      {
        googleSubject,
        subjectDigest: 'e'.repeat(64),
        requestId: randomUUID(),
        checkedAt: new Date(now.getTime() + 4_900).toISOString(),
        source: 'web',
      },
      {
        store: gateStore,
        audit: auditSink,
        bootstrapAdminSubjects: new Set(),
      },
    );
    expect(afterCompletedReplay.granted).toBe(true);

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
    expect(afterLegacyAccessCorrection.granted).toBe(true);

    await database
      .update(users)
      .set({ disabledAt: new Date(now.getTime() + 6_250) })
      .where(eq(users.id, backupUserId));
    const remainingAccessGroupId = randomUUID();
    await database.insert(groupSources).values({
      id: remainingAccessGroupId,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: `Issue 26 remaining access ${suffix.slice(0, 8)}`,
      active: true,
      googleGroupId: `issue-26-remaining-access-${suffix}`,
      email: `issue-26-remaining-access-${suffix}@example.invalid`,
      fixtureKey: null,
      createdAt: new Date(now.getTime() + 6_500),
    });
    expect(await loadAccessConfigurationSnapshotState(database)).toBeNull();
    expect(await loadEffectiveAdministratorUserIds(database)).toEqual([]);

    const exactFourGroupSnapshotId = randomUUID();
    const exactFourGroupSnapshotAt = new Date(now.getTime() + 7_000);
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: exactFourGroupSnapshotId,
        version: snapshotVersion + 2,
        complete: true,
        syncStartedAt: exactFourGroupSnapshotAt,
        capturedAt: exactFourGroupSnapshotAt,
      });
      await transaction.insert(accessMembershipSnapshotGroups).values(
        [
          groupSourceId,
          accessReplacement.id,
          backupGroupSourceId,
          remainingAccessGroupId,
        ].flatMap((sourceId) => [
          {
            snapshotId: exactFourGroupSnapshotId,
            groupSourceId: sourceId,
            groupSourceKind: 'google-group' as const,
            groupPurpose: 'access' as const,
            completionKind: 'expected' as const,
          },
          {
            snapshotId: exactFourGroupSnapshotId,
            groupSourceId: sourceId,
            groupSourceKind: 'google-group' as const,
            groupPurpose: 'access' as const,
            completionKind: 'completed' as const,
          },
        ]),
      );
      await transaction.insert(accessMembershipMembers).values([
        {
          snapshotId: exactFourGroupSnapshotId,
          userId,
          googleSubject,
          facilityScopeKind: 'district',
        },
        {
          snapshotId: exactFourGroupSnapshotId,
          userId: backupUserId,
          googleSubject: backupGoogleSubject,
          facilityScopeKind: 'district',
        },
      ]);
      await transaction.insert(accessMembershipMemberGroups).values([
        {
          snapshotId: exactFourGroupSnapshotId,
          userId,
          groupSourceId: accessReplacement.id,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
        {
          snapshotId: exactFourGroupSnapshotId,
          userId: backupUserId,
          groupSourceId: backupGroupSourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
      ]);
    });

    const exactFourGroupState =
      await loadAccessConfigurationSnapshotState(database);
    expect(exactFourGroupState).toEqual({
      snapshotId: exactFourGroupSnapshotId,
      snapshotVersion: snapshotVersion + 2,
      activeAccessGroupSourceIds: [
        groupSourceId,
        accessReplacement.id,
        backupGroupSourceId,
        remainingAccessGroupId,
      ].sort(),
    });
    if (exactFourGroupState === null) {
      throw new Error('The four-group access snapshot must be exact.');
    }
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: exactFourGroupState,
      }),
    ).toEqual([userId]);
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: exactFourGroupState,
        eligibleAccessGroupSourceIds: [remainingAccessGroupId],
      }),
    ).toEqual([]);
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: exactFourGroupState,
        eligibleAccessGroupSourceIds: [backupGroupSourceId],
      }),
    ).toEqual([]);
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        accessState: exactFourGroupState,
        eligibleAccessGroupSourceIds: [accessReplacement.id],
      }),
    ).toEqual([userId]);
  });

  test('rejects contradictory district scopes and excludes them from reachable administrators', async () => {
    const database = databaseConnection().db;
    const suffix = randomUUID();
    const facilityId = randomUUID();
    const validUserId = randomUUID();
    const persistedScopeUserId = randomUUID();
    const membershipScopeUserId = randomUUID();
    const validGoogleSubject = `issue-26-valid-admin-${suffix}`;
    const persistedScopeGoogleSubject = `issue-26-user-scope-${suffix}`;
    const membershipScopeGoogleSubject = `issue-26-member-scope-${suffix}`;
    const snapshotId = randomUUID();
    const capturedAt = new Date(Date.now() + 120_000);

    await database.insert(facilities).values({
      id: facilityId,
      code: `I26-${suffix.slice(0, 8).toUpperCase()}`,
      name: `Issue 26 contradictory scope ${suffix.slice(0, 8)}`,
      active: true,
      createdAt: capturedAt,
    });
    await database.insert(users).values([
      {
        id: validUserId,
        googleSubject: validGoogleSubject,
        email: `issue-26-valid-admin-${suffix}@psd401.net`,
        displayName: `Issue 26 valid admin ${suffix.slice(0, 8)}`,
        facilityScopeKind: 'district',
        createdAt: capturedAt,
      },
      {
        id: persistedScopeUserId,
        googleSubject: persistedScopeGoogleSubject,
        email: `issue-26-user-scope-${suffix}@psd401.net`,
        displayName: `Issue 26 contradictory user ${suffix.slice(0, 8)}`,
        facilityScopeKind: 'district',
        createdAt: capturedAt,
      },
      {
        id: membershipScopeUserId,
        googleSubject: membershipScopeGoogleSubject,
        email: `issue-26-member-scope-${suffix}@psd401.net`,
        displayName: `Issue 26 contradictory member ${suffix.slice(0, 8)}`,
        facilityScopeKind: 'district',
        createdAt: capturedAt,
      },
    ]);
    await database
      .insert(userRoles)
      .values(
        [validUserId, persistedScopeUserId, membershipScopeUserId].map(
          (userId) => ({ userId, role: 'admin' as const }),
        ),
      );
    await database.insert(userFacilityScopes).values({
      userId: persistedScopeUserId,
      facilityId,
    });

    const activeAccessGroups = await database
      .select({
        id: groupSources.id,
        kind: groupSources.kind,
        purpose: groupSources.purpose,
      })
      .from(groupSources)
      .where(eq(groupSources.active, true));
    const accessGroup = activeAccessGroups.find(
      (group) => group.kind === 'google-group' && group.purpose === 'access',
    );
    if (accessGroup === undefined) {
      throw new Error('A synthetic active access group must be available.');
    }

    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: snapshotId,
        version: 2_100_000_000,
        complete: true,
        syncStartedAt: capturedAt,
        capturedAt,
      });
      await transaction.insert(accessMembershipSnapshotGroups).values(
        activeAccessGroups
          .filter(
            (group) =>
              group.kind === 'google-group' && group.purpose === 'access',
          )
          .flatMap((group) => [
            {
              snapshotId,
              groupSourceId: group.id,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
              completionKind: 'expected' as const,
            },
            {
              snapshotId,
              groupSourceId: group.id,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
              completionKind: 'completed' as const,
            },
          ]),
      );
      await transaction.insert(accessMembershipMembers).values([
        {
          snapshotId,
          userId: validUserId,
          googleSubject: validGoogleSubject,
          facilityScopeKind: 'district',
        },
        {
          snapshotId,
          userId: persistedScopeUserId,
          googleSubject: persistedScopeGoogleSubject,
          facilityScopeKind: 'district',
        },
        {
          snapshotId,
          userId: membershipScopeUserId,
          googleSubject: membershipScopeGoogleSubject,
          facilityScopeKind: 'district',
        },
      ]);
      await transaction.insert(accessMembershipMemberGroups).values(
        [validUserId, persistedScopeUserId, membershipScopeUserId].map(
          (userId) => ({
            snapshotId,
            userId,
            groupSourceId: accessGroup.id,
            groupSourceKind: 'google-group' as const,
            groupPurpose: 'access' as const,
          }),
        ),
      );
      await transaction.insert(accessMembershipMemberFacilities).values({
        snapshotId,
        userId: membershipScopeUserId,
        facilityId,
      });
    });

    const accessState = await loadAccessConfigurationSnapshotState(database);
    expect(accessState?.snapshotId).toBe(snapshotId);
    if (accessState === null) {
      throw new Error('The contradictory-scope snapshot must be exact.');
    }
    expect(
      await loadEffectiveAdministratorUserIds(database, { accessState }),
    ).toEqual([validUserId]);

    const store = createDrizzleAccessGateStore(database);
    await expect(
      store.loadEvidence(persistedScopeGoogleSubject),
    ).rejects.toBeInstanceOf(AccessGateConfigurationError);
    await expect(
      store.loadEvidence(membershipScopeGoogleSubject),
    ).rejects.toBeInstanceOf(AccessGateConfigurationError);
    expect(
      (await store.loadEvidence(validGoogleSubject)).snapshot?.member
        ?.facilityScope,
    ).toEqual({ kind: 'district' });
  });
});
