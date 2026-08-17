import { createHash, randomUUID } from 'node:crypto';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, asc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  accessMembershipEvaluatedMembers,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  idempotencyRecords,
  securityAuditChainAnchors,
  securityAuditEntries,
  sessionRevocations,
  sessions,
  userRoles,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../app/(admin)/facilities/owned-database-lifecycle';
import {
  createDrizzleAccessMembershipSyncStore,
  type AccessMembershipSyncReservation,
} from './access-membership-sync';
import { checkAccessGate, createDrizzleAccessGateStore } from './access-gate';
import {
  createDrizzleInitialWebSessionStore,
  type PersistInitialWebSessionRequest,
} from './session-cookie';
import {
  DESIGNATED_ACCESS_GROUP_EMAIL,
  type EvaluatedAccessMembershipSet,
} from './google-access-membership';
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

interface TestDatabaseContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i234_access_[a-f0-9]{32}_test$/u;
const BASELINE_SOURCE_ID = '00000000-0000-4000-8000-000000000521';
const BASELINE_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000522';
const USER_ID = '00000000-0000-4000-8000-000000000523';
const RECOVERY_EMAIL = 'recovery.admin@psd401.net';
const CANDIDATE_SUBJECT = 'synthetic-existing-transition-subject';
const TRANSITION_EMAIL = 'initial.mobile@psd401.net';
const TRANSITION_EMAIL_DIGEST = createHash('sha256')
  .update(TRANSITION_EMAIL, 'utf8')
  .digest('hex');
const BASELINE_TIME = new Date('2026-08-17T11:00:00.000Z');
const SYNC_TIME = '2026-08-17T12:00:00.000Z';
const PROVIDER_GROUP_ID = '01exactEngineering';

let context: TestDatabaseContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
let databaseCreated = false;

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function textDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildContext(baseUrl: string): TestDatabaseContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i234_access_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable access-sync database name is invalid.');
  }
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl: baseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-234:access-sync-test:${runId}`,
  });
}

function openConnection(
  url: string,
  maxConnections: number,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Access-sync integration tests require PostgreSQL.');
  }
  return opened;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readMarker(
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
    throw new Error('The disposable access-sync database is ambiguous.');
  }
  return rows[0]?.marker;
}

async function dropOwnedDatabase(target: TestDatabaseContext): Promise<void> {
  const admin = openConnection(target.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readMarker(admin, target.databaseName);
      if (marker !== undefined && marker !== target.marker) {
        throw new Error(
          'Refusing to drop an access-sync database without its exact ownership marker.',
        );
      }
      if (marker === target.marker) {
        await admin.db.execute(
          sql.raw(`drop database "${target.databaseName}" with (force)`),
        );
        expect(await readMarker(admin, target.databaseName)).toBeUndefined();
      }
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Access-sync database cleanup and connection close both failed.',
  });
}

async function createOwnedDatabase(target: TestDatabaseContext): Promise<void> {
  const admin = openConnection(target.baseDatabaseUrl, 1);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${target.databaseName}"`),
      );
      recordCreated();
      await admin.db.execute(
        sql.raw(
          `comment on database "${target.databaseName}" is ${quotedLiteral(target.marker)}`,
        ),
      );
      expect(await readMarker(admin, target.databaseName)).toBe(target.marker);
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(target),
    failureMessage:
      'Access-sync database creation, verification, or cleanup failed.',
  });
}

async function cleanup(): Promise<void> {
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
    throw new AggregateError(errors, 'Access-sync integration cleanup failed.');
  }
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The access-sync integration database is not open.');
  }
  return connection;
}

async function seedStrictBaseline(
  database: PostgresDatabaseConnection['db'],
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.insert(groupSources).values({
      id: BASELINE_SOURCE_ID,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'Retained recovery access',
      active: true,
      googleGroupId: 'retained_recovery_access',
      email: 'retained-recovery@psd401.net',
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    });
    await transaction.insert(users).values({
      id: USER_ID,
      googleSubject: 'synthetic-test-google-subject',
      email: RECOVERY_EMAIL,
      displayName: 'Synthetic Integration Administrator',
      facilityScopeKind: 'district',
      createdAt: BASELINE_TIME,
      disabledAt: null,
    });
    await transaction
      .insert(userRoles)
      .values({ userId: USER_ID, role: 'admin' });
    await transaction.insert(accessMembershipSnapshots).values({
      id: BASELINE_SNAPSHOT_ID,
      version: 1,
      complete: true,
      syncStartedAt: BASELINE_TIME,
      capturedAt: BASELINE_TIME,
    });
    await transaction.insert(accessMembershipSnapshotGroups).values([
      {
        snapshotId: BASELINE_SNAPSHOT_ID,
        groupSourceId: BASELINE_SOURCE_ID,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'expected',
      },
      {
        snapshotId: BASELINE_SNAPSHOT_ID,
        groupSourceId: BASELINE_SOURCE_ID,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(accessMembershipMembers).values({
      snapshotId: BASELINE_SNAPSHOT_ID,
      userId: USER_ID,
      googleSubject: 'synthetic-test-google-subject',
      facilityScopeKind: 'district',
    });
    await transaction.insert(accessMembershipMemberGroups).values({
      snapshotId: BASELINE_SNAPSHOT_ID,
      userId: USER_ID,
      groupSourceId: BASELINE_SOURCE_ID,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
    await transaction.insert(accessMembershipEvaluatedMembers).values({
      snapshotId: BASELINE_SNAPSHOT_ID,
      email: RECOVERY_EMAIL,
      groupSourceId: BASELINE_SOURCE_ID,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
  });
}

describeWithDatabase('access-membership atomic database publication', () => {
  beforeEach(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      databaseCreated = true;
      connection = openConnection(context.databaseUrl, 3);
      await migrateDatabase(connection);
      await seedStrictBaseline(connection.db);
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Access-sync integration setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterEach(async () => cleanup());

  test('stages exact provider evidence while preserving one reachable recovery administrator', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database, {
      initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
    });
    const idempotencyKey = 'access-sync:database-integration-0001';
    const requestDigest = 'd'.repeat(64);
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey,
      requestDigest,
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected a new access-sync reservation.');
    }
    const memberEmails = Object.freeze([
      TRANSITION_EMAIL,
      'other.staff@psd401.net',
    ]);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });
    const result = await store.stage(reservation.id, evaluation);
    expect(result).toMatchObject({
      snapshotVersion: 2,
      activeAccessGroupCount: 2,
      evaluatedMembershipCount: 2,
      membershipDigest: evaluation.membershipDigest,
      providerGroupIdDigest: evaluation.providerGroupIdDigest,
      publication: 'created',
    });

    const accessState = await loadAccessConfigurationSnapshotState(database);
    expect(accessState).toEqual({
      snapshotId: result.snapshotId,
      snapshotVersion: 2,
      activeAccessGroupSourceIds: expect.any(Array),
    });
    expect(accessState?.activeAccessGroupSourceIds).toEqual(
      [BASELINE_SOURCE_ID, result.designatedSourceId].sort(),
    );

    const [designatedSource] = await database
      .select()
      .from(groupSources)
      .where(eq(groupSources.id, result.designatedSourceId));
    expect(designatedSource).toMatchObject({
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      active: true,
      googleGroupId: PROVIDER_GROUP_ID,
      email: DESIGNATED_ACCESS_GROUP_EMAIL,
      fixtureKey: null,
    });
    const [recoverySource] = await database
      .select({ active: groupSources.active })
      .from(groupSources)
      .where(eq(groupSources.id, BASELINE_SOURCE_ID));
    expect(recoverySource).toEqual({ active: true });
    const generationRows = await database
      .select()
      .from(accessMembershipSnapshotGroups)
      .where(eq(accessMembershipSnapshotGroups.snapshotId, result.snapshotId));
    expect(generationRows).toHaveLength(4);
    expect(
      generationRows
        .filter(({ completionKind }) => completionKind === 'expected')
        .map(({ groupSourceId }) => groupSourceId)
        .sort(),
    ).toEqual(
      generationRows
        .filter(({ completionKind }) => completionKind === 'completed')
        .map(({ groupSourceId }) => groupSourceId)
        .sort(),
    );
    expect(
      new Set(generationRows.map(({ groupSourceId }) => groupSourceId)),
    ).toEqual(new Set([BASELINE_SOURCE_ID, result.designatedSourceId]));
    const evaluatedRows = await database
      .select({
        email: accessMembershipEvaluatedMembers.email,
        groupSourceId: accessMembershipEvaluatedMembers.groupSourceId,
      })
      .from(accessMembershipEvaluatedMembers)
      .where(eq(accessMembershipEvaluatedMembers.snapshotId, result.snapshotId))
      .orderBy(
        asc(accessMembershipEvaluatedMembers.groupSourceId),
        asc(accessMembershipEvaluatedMembers.email),
      );
    expect(evaluatedRows).toEqual(
      [
        {
          email: TRANSITION_EMAIL,
          groupSourceId: result.designatedSourceId,
        },
        {
          email: 'other.staff@psd401.net',
          groupSourceId: result.designatedSourceId,
        },
      ].sort((left, right) =>
        `${left.groupSourceId}:${left.email}`.localeCompare(
          `${right.groupSourceId}:${right.email}`,
        ),
      ),
    );
    expect(
      await database
        .select()
        .from(accessMembershipMembers)
        .where(eq(accessMembershipMembers.snapshotId, result.snapshotId)),
    ).toEqual([
      {
        snapshotId: result.snapshotId,
        userId: USER_ID,
        googleSubject: 'synthetic-test-google-subject',
        facilityScopeKind: 'district',
      },
    ]);
    expect(
      await database
        .select({
          userId: accessMembershipMemberGroups.userId,
          groupSourceId: accessMembershipMemberGroups.groupSourceId,
        })
        .from(accessMembershipMemberGroups)
        .where(eq(accessMembershipMemberGroups.snapshotId, result.snapshotId)),
    ).toEqual([{ userId: USER_ID, groupSourceId: BASELINE_SOURCE_ID }]);
    expect(await loadEffectiveAdministratorUserIds(database)).toEqual([
      USER_ID,
    ]);
    const mobileCandidate = await checkAccessGate(
      {
        googleSubject: CANDIDATE_SUBJECT,
        email: TRANSITION_EMAIL,
        displayName: 'Current independently verified Google profile',
        subjectDigest: textDigest(CANDIDATE_SUBJECT),
        requestId: randomUUID(),
        checkedAt: SYNC_TIME,
        source: 'mobile',
      },
      {
        store: createDrizzleAccessGateStore(database),
        initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
        audit: {
          async append(): Promise<never> {
            throw new Error(
              'The exact durable mobile candidate must not be denied.',
            );
          },
        },
      },
    );
    expect(mobileCandidate).toMatchObject({
      granted: true,
      user: { googleSubject: CANDIDATE_SUBJECT },
      firstLoginBinding: {
        userDisposition: 'create',
        sourceSnapshotId: result.snapshotId,
        sourceSnapshotVersion: result.snapshotVersion,
        normalizedEmail: TRANSITION_EMAIL,
      },
      bootstrapAdminEligible: true,
    });
    if (mobileCandidate.granted) {
      expect(mobileCandidate.user.id).not.toBe(USER_ID);
      expect(mobileCandidate.membership.accessGroupSourceRefs).toEqual([
        {
          id: result.designatedSourceId,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
        },
      ]);
    }
    expect(
      await database
        .select({ id: users.id })
        .from(users)
        .orderBy(asc(users.id)),
    ).toEqual([{ id: USER_ID }]);
    expect(
      await database
        .select()
        .from(accessMembershipSnapshots)
        .where(eq(accessMembershipSnapshots.id, BASELINE_SNAPSHOT_ID)),
    ).toHaveLength(1);
    const [idempotency] = await database
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.capabilityId, 'sync-access-membership'),
          eq(idempotencyRecords.key, idempotencyKey),
        ),
      );
    expect(idempotency).toMatchObject({
      status: 'completed',
      resultReference: `access-membership-snapshot:${result.snapshotId}`,
    });

    const replay: AccessMembershipSyncReservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey,
      requestDigest,
      startedAt: '2026-08-17T12:01:00.000Z',
    });
    expect(replay).toEqual({ kind: 'replay', result });

    if (
      !mobileCandidate.granted ||
      mobileCandidate.firstLoginBinding === null
    ) {
      throw new Error('Expected a protected first-login binding.');
    }
    const mobileCreatedAt = new Date('2026-08-17T12:01:00.000Z');
    const oidcResponseDigest = textDigest(
      'issue-234-synthetic-mobile-oidc-response',
    );
    const oidcPrincipal = Object.freeze({
      kind: 'oidc-callback' as const,
      subjectDigest: textDigest(mobileCandidate.user.googleSubject),
      responseDigest: oidcResponseDigest,
    });
    const mobilePersistenceRequest: PersistInitialWebSessionRequest =
      Object.freeze({
        user: mobileCandidate.user,
        membershipSnapshot: Object.freeze({
          id: mobileCandidate.membership.snapshotId,
          version: mobileCandidate.membership.snapshotVersion,
          complete: true as const,
          syncStartedAt: mobileCandidate.membership.syncStartedAt,
          capturedAt: mobileCandidate.membership.capturedAt,
        }),
        membershipMember: Object.freeze({
          userId: mobileCandidate.user.id,
          googleSubject: mobileCandidate.user.googleSubject,
          accessGroupSourceRefs:
            mobileCandidate.membership.accessGroupSourceRefs,
          facilityScope: mobileCandidate.user.facilityScope,
        }),
        firstLoginBinding: mobileCandidate.firstLoginBinding,
        device: Object.freeze({
          platform: 'ios' as const,
          unlockMethod: 'biometric' as const,
          installationId: 'ios.issue-234.synthetic-transition-device',
        }),
        credentialDigest: textDigest(
          'issue-234-synthetic-mobile-session-credential',
        ),
        createdAt: mobileCreatedAt,
        expiresAt: new Date(mobileCreatedAt.getTime() + 3 * 60 * 60 * 1_000),
        membershipValidUntil: new Date(
          mobileCreatedAt.getTime() + 60 * 60 * 1_000,
        ),
        membershipGraceUntil: new Date(
          mobileCreatedAt.getTime() + 2 * 60 * 60 * 1_000,
        ),
        grantBootstrapAdmin: mobileCandidate.bootstrapAdminEligible,
        requestId: randomUUID(),
        idempotency: Object.freeze({
          key: `oidc:${oidcResponseDigest}`,
          principal: oidcPrincipal,
          principalDigest: digest(oidcPrincipal),
          requestDigest: textDigest(
            'issue-234-synthetic-mobile-persistence-request',
          ),
        }),
      });
    const mobileResult = await createDrizzleInitialWebSessionStore(database, {
      initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
    }).persist(mobilePersistenceRequest);
    expect(mobileResult).toMatchObject({
      user: {
        id: mobileCandidate.user.id,
        googleSubject: CANDIDATE_SUBJECT,
        email: TRANSITION_EMAIL,
        roles: ['admin'],
      },
      session: {
        userId: mobileCandidate.user.id,
        authorization: {
          membershipSnapshotId:
            mobileCandidate.firstLoginBinding.successorSnapshotId,
        },
        revokedAt: null,
      },
      deviceEnrollment: {
        userId: mobileCandidate.user.id,
        platform: 'ios',
        unlockMethod: 'biometric',
        revokedAt: null,
      },
    });
    expect(mobileCandidate.user.id).not.toBe(USER_ID);
    expect(mobileResult.session.authorization.membershipSnapshotId).toBe(
      mobileCandidate.firstLoginBinding.successorSnapshotId,
    );
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        eligibleAccessGroupSourceIds: [result.designatedSourceId],
      }),
    ).toEqual([mobileCandidate.user.id]);
    expect(
      await loadEffectiveAdministratorUserIds(database, {
        eligibleAccessGroupSourceIds: [BASELINE_SOURCE_ID],
      }),
    ).toEqual([USER_ID]);

    const repeatedReservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-current-transition-0001',
      requestDigest: 'e'.repeat(64),
      startedAt: '2026-08-17T12:02:00.000Z',
    });
    if (repeatedReservation.kind !== 'reserved') {
      throw new Error('Expected a fresh transition replay reservation.');
    }
    const repeatedStage = await store.stage(repeatedReservation.id, {
      ...evaluation,
      syncStartedAt: '2026-08-17T12:02:00.000Z',
      capturedAt: '2026-08-17T12:02:00.000Z',
    });
    expect(repeatedStage).toMatchObject({
      phase: 'stage',
      snapshotId: mobileResult.session.authorization.membershipSnapshotId,
      snapshotVersion:
        mobileCandidate.firstLoginBinding.successorSnapshotVersion,
      designatedSourceId: result.designatedSourceId,
      activeAccessGroupCount: 2,
      evaluatedMembershipCount: evaluation.memberEmails.length,
      membershipDigest: evaluation.membershipDigest,
      providerGroupIdDigest: evaluation.providerGroupIdDigest,
      proofKind: 'initial-selector-match',
      auditEntryHash: null,
      publication: 'already-current',
    });
    expect(
      await database
        .select({
          userId: accessMembershipMemberGroups.userId,
          groupSourceId: accessMembershipMemberGroups.groupSourceId,
        })
        .from(accessMembershipMemberGroups)
        .where(
          eq(accessMembershipMemberGroups.snapshotId, repeatedStage.snapshotId),
        )
        .orderBy(
          asc(accessMembershipMemberGroups.userId),
          asc(accessMembershipMemberGroups.groupSourceId),
        ),
    ).toEqual(
      [
        {
          userId: USER_ID,
          groupSourceId: BASELINE_SOURCE_ID,
        },
        {
          userId: mobileCandidate.user.id,
          groupSourceId: result.designatedSourceId,
        },
      ].sort((left, right) =>
        `${left.userId}:${left.groupSourceId}`.localeCompare(
          `${right.userId}:${right.groupSourceId}`,
        ),
      ),
    );

    const invalidFinalizationReservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-invalid-finalization-0001',
      requestDigest: '1'.repeat(64),
      startedAt: '2026-08-17T12:03:00.000Z',
    });
    if (invalidFinalizationReservation.kind !== 'reserved') {
      throw new Error('Expected a tampered finalization reservation.');
    }
    await expect(
      store.finalize(invalidFinalizationReservation.id, {
        mobileSessionId: mobileResult.session.id,
        membershipSnapshotId: result.snapshotId,
        requestId: randomUUID(),
        completedAt: '2026-08-17T12:03:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'FINALIZATION_BASELINE_INVALID' });
    await store.failReservation(
      invalidFinalizationReservation.id,
      'FINALIZATION_BASELINE_INVALID',
      '2026-08-17T12:03:00.000Z',
    );
    expect(
      await database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, BASELINE_SOURCE_ID)),
    ).toEqual([{ active: true }]);

    const finalIdempotencyKey = 'access-sync:database-valid-finalization-0001';
    const finalRequestDigest = '2'.repeat(64);
    const finalRequestId = randomUUID();
    const finalReservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: finalIdempotencyKey,
      requestDigest: finalRequestDigest,
      startedAt: '2026-08-17T12:04:00.000Z',
    });
    if (finalReservation.kind !== 'reserved') {
      throw new Error('Expected a protected finalization reservation.');
    }
    const finalResult = await store.finalize(finalReservation.id, {
      mobileSessionId: mobileResult.session.id,
      membershipSnapshotId:
        mobileResult.session.authorization.membershipSnapshotId,
      requestId: finalRequestId,
      completedAt: '2026-08-17T12:04:00.000Z',
    });
    if (finalResult.phase !== 'finalize') {
      throw new Error('Expected a protected finalization result.');
    }
    expect(finalResult).toMatchObject({
      phase: 'finalize',
      snapshotVersion:
        mobileCandidate.firstLoginBinding.successorSnapshotVersion + 1,
      designatedSourceId: result.designatedSourceId,
      activeAccessGroupCount: 1,
      evaluatedMembershipCount: evaluation.memberEmails.length,
      membershipDigest: evaluation.membershipDigest,
      providerGroupIdDigest: evaluation.providerGroupIdDigest,
      proofKind: 'durable-ios-session',
      auditEntryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      publication: 'created',
    });
    expect(finalResult.snapshotId).not.toBe(repeatedStage.snapshotId);
    expect(
      await database
        .select({ id: groupSources.id, active: groupSources.active })
        .from(groupSources)
        .where(
          and(
            eq(groupSources.purpose, 'access'),
            eq(groupSources.active, true),
          ),
        ),
    ).toEqual([{ id: result.designatedSourceId, active: true }]);
    expect(
      await database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, BASELINE_SOURCE_ID)),
    ).toEqual([{ active: false }]);
    expect(
      await database
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, USER_ID)),
    ).toEqual([{ id: USER_ID, disabledAt: null }]);
    expect(
      await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, USER_ID)),
    ).toEqual([{ role: 'admin' }]);
    expect(
      await database
        .select({ id: sessions.id, revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.id, mobileResult.session.id)),
    ).toEqual([{ id: mobileResult.session.id, revokedAt: null }]);
    expect(
      await database
        .select({ id: sessionRevocations.id })
        .from(sessionRevocations)
        .where(eq(sessionRevocations.sessionId, mobileResult.session.id)),
    ).toEqual([]);
    expect(
      await database
        .select({
          snapshotId: accessMembershipMembers.snapshotId,
          userId: accessMembershipMembers.userId,
        })
        .from(accessMembershipMembers)
        .where(eq(accessMembershipMembers.snapshotId, finalResult.snapshotId)),
    ).toEqual([
      {
        snapshotId: finalResult.snapshotId,
        userId: mobileCandidate.user.id,
      },
    ]);
    const [finalAudit] = await database
      .select()
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, finalRequestId));
    if (finalAudit === undefined) {
      throw new Error('Expected a protected finalization audit entry.');
    }
    expect(finalAudit).toMatchObject({
      action: 'sync-access-membership',
      outcome: 'success',
      source: 'scheduled-job',
      targetKind: 'configuration',
      targetId: finalResult.snapshotId,
      entryHash: finalResult.auditEntryHash,
    });
    expect(
      await database
        .select({
          sequence: securityAuditChainAnchors.sequence,
          entryHash: securityAuditChainAnchors.entryHash,
        })
        .from(securityAuditChainAnchors)
        .where(eq(securityAuditChainAnchors.sequence, finalAudit.sequence)),
    ).toEqual([
      {
        sequence: finalAudit.sequence,
        entryHash: finalResult.auditEntryHash,
      },
    ]);

    const finalReplay = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: finalIdempotencyKey,
      requestDigest: finalRequestDigest,
      startedAt: '2026-08-17T12:05:00.000Z',
    });
    expect(finalReplay).toEqual({ kind: 'replay', result: finalResult });
    expect(
      await database
        .select({ id: users.id })
        .from(users)
        .orderBy(asc(users.id)),
    ).toEqual(
      [{ id: USER_ID }, { id: mobileCandidate.user.id }].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
  });

  test('rolls provider-source activation back when the protected selector is absent', async () => {
    const database = databaseConnection().db;
    const store = createDrizzleAccessMembershipSyncStore(database, {
      initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
    });
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-selector-absent-0001',
      requestDigest: 'a'.repeat(64),
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected a selector-absence test reservation.');
    }
    const memberEmails = Object.freeze(['other.staff@psd401.net']);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });

    await expect(store.stage(reservation.id, evaluation)).rejects.toMatchObject(
      {
        code: 'INITIAL_TRANSITION_SELECTOR_NOT_DIRECT_MEMBER',
      },
    );
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(eq(groupSources.googleGroupId, PROVIDER_GROUP_ID)),
    ).toEqual([]);
    expect(
      await database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, BASELINE_SOURCE_ID)),
    ).toEqual([{ active: true }]);
  });

  test('stages independently of unrelated durable evaluated users', async () => {
    const database = databaseConnection().db;
    const secondCandidateId = randomUUID();
    await database.insert(users).values({
      id: secondCandidateId,
      googleSubject: 'synthetic-second-designated-subject',
      email: 'other.staff@psd401.net',
      displayName: 'Synthetic Second Designated Candidate',
      facilityScopeKind: 'district',
      createdAt: BASELINE_TIME,
      disabledAt: null,
    });
    const store = createDrizzleAccessMembershipSyncStore(database, {
      initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
    });
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-unrelated-user-0001',
      requestDigest: 'b'.repeat(64),
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected an unrelated-user test reservation.');
    }
    const memberEmails = Object.freeze([
      TRANSITION_EMAIL,
      'other.staff@psd401.net',
    ]);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });

    const result = await store.stage(reservation.id, evaluation);
    expect(result).toMatchObject({
      phase: 'stage',
      activeAccessGroupCount: 2,
      proofKind: 'initial-selector-match',
    });
    expect(
      await database
        .select({ id: users.id, email: users.email })
        .from(users)
        .orderBy(asc(users.id)),
    ).toEqual(
      [
        { id: USER_ID, email: RECOVERY_EMAIL },
        { id: secondCandidateId, email: 'other.staff@psd401.net' },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
  });

  test('rolls provider-source activation back with zero bound recovery candidates', async () => {
    const database = databaseConnection().db;
    const emptyRecoverySnapshotId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.insert(accessMembershipSnapshots).values({
        id: emptyRecoverySnapshotId,
        version: 2,
        complete: true,
        syncStartedAt: new Date('2026-08-17T11:30:00.000Z'),
        capturedAt: new Date('2026-08-17T11:30:00.000Z'),
      });
      await transaction.insert(accessMembershipSnapshotGroups).values([
        {
          snapshotId: emptyRecoverySnapshotId,
          groupSourceId: BASELINE_SOURCE_ID,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
          completionKind: 'expected',
        },
        {
          snapshotId: emptyRecoverySnapshotId,
          groupSourceId: BASELINE_SOURCE_ID,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
          completionKind: 'completed',
        },
      ]);
    });
    const store = createDrizzleAccessMembershipSyncStore(database, {
      initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
    });
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-zero-recovery-0001',
      requestDigest: 'e'.repeat(64),
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected a zero-recovery test reservation.');
    }
    const memberEmails = Object.freeze([TRANSITION_EMAIL]);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });

    await expect(store.stage(reservation.id, evaluation)).rejects.toMatchObject(
      { code: 'RECOVERY_TRANSITION_BINDING_INVALID' },
    );
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(eq(groupSources.googleGroupId, PROVIDER_GROUP_ID)),
    ).toEqual([]);
    expect(
      await database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, BASELINE_SOURCE_ID)),
    ).toEqual([{ active: true }]);
  });

  test('rolls provider-source activation back with ambiguous recovery candidates', async () => {
    const database = databaseConnection().db;
    const secondUserId = randomUUID();
    const ambiguousRecoverySnapshotId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.insert(users).values({
        id: secondUserId,
        googleSubject: 'synthetic-second-recovery-subject',
        email: 'second.recovery@psd401.net',
        displayName: 'Synthetic Second Recovery Administrator',
        facilityScopeKind: 'district',
        createdAt: BASELINE_TIME,
        disabledAt: null,
      });
      await transaction.insert(userRoles).values({
        userId: secondUserId,
        role: 'admin',
      });
      await transaction.insert(accessMembershipSnapshots).values({
        id: ambiguousRecoverySnapshotId,
        version: 2,
        complete: true,
        syncStartedAt: new Date('2026-08-17T11:30:00.000Z'),
        capturedAt: new Date('2026-08-17T11:30:00.000Z'),
      });
      await transaction.insert(accessMembershipSnapshotGroups).values([
        {
          snapshotId: ambiguousRecoverySnapshotId,
          groupSourceId: BASELINE_SOURCE_ID,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
          completionKind: 'expected',
        },
        {
          snapshotId: ambiguousRecoverySnapshotId,
          groupSourceId: BASELINE_SOURCE_ID,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
          completionKind: 'completed',
        },
      ]);
      await transaction.insert(accessMembershipMembers).values([
        {
          snapshotId: ambiguousRecoverySnapshotId,
          userId: USER_ID,
          googleSubject: 'synthetic-test-google-subject',
          facilityScopeKind: 'district',
        },
        {
          snapshotId: ambiguousRecoverySnapshotId,
          userId: secondUserId,
          googleSubject: 'synthetic-second-recovery-subject',
          facilityScopeKind: 'district',
        },
      ]);
      await transaction.insert(accessMembershipMemberGroups).values([
        {
          snapshotId: ambiguousRecoverySnapshotId,
          userId: USER_ID,
          groupSourceId: BASELINE_SOURCE_ID,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
        {
          snapshotId: ambiguousRecoverySnapshotId,
          userId: secondUserId,
          groupSourceId: BASELINE_SOURCE_ID,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        },
      ]);
    });
    const store = createDrizzleAccessMembershipSyncStore(database, {
      initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
    });
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-ambiguous-recovery-0001',
      requestDigest: 'f'.repeat(64),
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected an ambiguous-recovery test reservation.');
    }
    const memberEmails = Object.freeze([TRANSITION_EMAIL]);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });

    await expect(store.stage(reservation.id, evaluation)).rejects.toMatchObject(
      { code: 'RECOVERY_TRANSITION_BINDING_INVALID' },
    );
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(eq(groupSources.googleGroupId, PROVIDER_GROUP_ID)),
    ).toEqual([]);
    expect(
      await database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, BASELINE_SOURCE_ID)),
    ).toEqual([{ active: true }]);
  });

  test('rolls staged source activation back when the successor inventory cannot be published', async () => {
    const database = databaseConnection().db;
    const historicalSources = Array.from({ length: 99 }, (_, index) => ({
      id: randomUUID(),
      kind: 'google-group' as const,
      purpose: 'access' as const,
      facilityId: null,
      displayName: `Synthetic inactive history ${index}`,
      active: false,
      googleGroupId: `synthetic_inactive_history_${index}`,
      email: `synthetic.inactive.${index}@psd401.net`,
      fixtureKey: null,
      createdAt: BASELINE_TIME,
    }));
    await database.insert(groupSources).values(historicalSources);
    const store = createDrizzleAccessMembershipSyncStore(database, {
      initialMobileTransitionEmailDigest: TRANSITION_EMAIL_DIGEST,
    });
    const reservation = await store.reserve({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:database-rollback-0001',
      requestDigest: 'c'.repeat(64),
      startedAt: SYNC_TIME,
    });
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') {
      throw new Error('Expected a rollback-test reservation.');
    }
    const memberEmails = Object.freeze([TRANSITION_EMAIL]);
    const evaluation: EvaluatedAccessMembershipSet = Object.freeze({
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: PROVIDER_GROUP_ID,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        PROVIDER_GROUP_ID,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([PROVIDER_GROUP_ID]),
      syncStartedAt: SYNC_TIME,
      capturedAt: SYNC_TIME,
    });

    await expect(store.stage(reservation.id, evaluation)).rejects.toMatchObject(
      {
        code: 'ACTIVE_ACCESS_SOURCES_INVALID',
      },
    );
    expect(
      await database
        .select({ active: groupSources.active })
        .from(groupSources)
        .where(eq(groupSources.id, BASELINE_SOURCE_ID)),
    ).toEqual([{ active: true }]);
    expect(
      await database
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(eq(groupSources.googleGroupId, PROVIDER_GROUP_ID)),
    ).toEqual([]);

    await store.failReservation(
      reservation.id,
      'ACTIVE_ACCESS_SOURCES_INVALID',
      SYNC_TIME,
    );
  });
});
