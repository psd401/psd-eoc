import { createHash, randomUUID } from 'node:crypto';

import { IntegrationChannelChangeAuthorizationSchema } from '@psd-eoc/contracts';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  audienceConfigurations,
  channelConfigurations,
  deviceEnrollments,
  groupSources,
  integrationChannelChangeAuthorizations,
  integrationStatuses,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  rosterSnapshots,
  securityAuditEntries,
  sessions,
  userRoleChanges,
  userRoles,
  users,
} from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  createDrizzleInitialWebSessionStore,
  type PersistInitialWebSessionRequest,
} from '../../../lib/auth/session-cookie';
import { requireSyntheticTestDatabaseUrl } from '../event-types/test-database';
import {
  executeListUsersCapability,
  executeSetUserRolesCapability,
} from '../access/capabilities';
import {
  executeSetChannelEnabledCapability,
  liveChannelChangeAuthorizationCommitment,
  liveChannelChangeConsequenceDigest,
  liveChannelChangeRequestDigest,
} from '../integrations/capabilities';
import { executeRosterHealthProjection } from '../integrations/roster-health';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
} from './admin-core';
import {
  executeCreateAudienceConfigVersionCapability,
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeCreateNeighborhoodVersionCapability,
  executeGetAudienceConfigCapability,
  executeListGroupSourcesCapability,
  executeUpdateFacilityCapability,
  executeUpdateGroupSourceCapability,
} from './capabilities';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

let connection: PostgresDatabaseConnection | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The facilities integration database is not open.');
  }
  return connection;
}

function authenticatedAdministrator(): AuthenticatedSession {
  const userId = randomUUID();
  const sessionId = randomUUID();
  return {
    actor: { kind: 'human', userId, sessionId },
    source: 'web',
    roles: ['admin'],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: randomUUID() } },
  } as unknown as AuthenticatedSession;
}

function metadata(label: string, requestIds: string[]) {
  const requestId = randomUUID();
  requestIds.push(requestId);
  return {
    idempotencyKey: `issue-26-${label}-${randomUUID()}`,
    requestId,
    now: new Date(),
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function liveAuthorizationFor(input: {
  readonly authenticated: AuthenticatedSession;
  readonly integrationId: string;
  readonly integrationStatusId: string;
  readonly previousConfiguration: Readonly<{
    enabled: boolean;
    statusId: string;
  }> | null;
  readonly issuedAt: Date;
}) {
  if (input.authenticated.actor.kind !== 'human') {
    throw new Error('A live authorization requires a synthetic human actor.');
  }
  const base = {
    reference: `issue-26-live-race-${randomUUID()}`,
    integrationStatusId: input.integrationStatusId,
    integrationId: input.integrationId,
    desiredEnabled: true,
    requestDigest: '0'.repeat(64),
    consequenceDigest: '0'.repeat(64),
    authorizedByUserId: input.authenticated.actor.userId,
    authorizedWithSessionId: input.authenticated.actor.sessionId,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: new Date(
      input.issuedAt.getTime() + 15 * 60 * 1_000,
    ).toISOString(),
  } as const;
  return IntegrationChannelChangeAuthorizationSchema.parse({
    ...base,
    requestDigest: liveChannelChangeRequestDigest(base),
    consequenceDigest: liveChannelChangeConsequenceDigest({
      integrationId: input.integrationId,
      previousConfiguration: input.previousConfiguration,
      desiredEnabled: true,
      integrationStatusId: input.integrationStatusId,
    }),
  });
}

function bootstrapSessionRequest(input: {
  readonly label: string;
  readonly user: PersistInitialWebSessionRequest['user'];
  readonly membershipSnapshot: PersistInitialWebSessionRequest['membershipSnapshot'];
  readonly membershipMember: PersistInitialWebSessionRequest['membershipMember'];
  readonly createdAt: Date;
}): PersistInitialWebSessionRequest {
  const responseDigest = digest(`response:${input.label}`);
  const principal = {
    kind: 'oidc-callback' as const,
    subjectDigest: digest(input.user.googleSubject),
    responseDigest,
  };
  return Object.freeze({
    user: input.user,
    membershipSnapshot: input.membershipSnapshot,
    membershipMember: input.membershipMember,
    device: Object.freeze({
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `issue-26-bootstrap-${input.label}`,
    } as const),
    credentialDigest: digest(`credential:${input.label}`),
    createdAt: input.createdAt,
    expiresAt: new Date(input.createdAt.getTime() + 72 * 60 * 60 * 1_000),
    membershipValidUntil: new Date(
      input.createdAt.getTime() + 24 * 60 * 60 * 1_000,
    ),
    membershipGraceUntil: new Date(
      input.createdAt.getTime() + 48 * 60 * 60 * 1_000,
    ),
    grantBootstrapAdmin: true,
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digest(JSON.stringify(principal)),
      requestDigest: digest(`request:${input.label}`),
    },
  });
}

async function persistAuthenticatedAdministrator(
  database: PostgresDatabaseConnection['db'],
  authenticated: AuthenticatedSession,
  accessGroupId: string,
  suffix: string,
): Promise<void> {
  if (authenticated.actor.kind !== 'human') {
    throw new Error('The synthetic administrator must be human.');
  }
  const now = new Date();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  const graceUntil = new Date(now.getTime() + 48 * 60 * 60 * 1_000);
  const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1_000);
  const snapshotId = randomUUID();
  const deviceId = randomUUID();
  const snapshotVersion = Number.parseInt(suffix.slice(0, 7), 16) + 1;

  await database.insert(users).values({
    id: authenticated.actor.userId,
    googleSubject: `issue-26-admin-subject-${suffix}`,
    email: `issue-26-admin-${suffix}@psd401.net`,
    displayName: `Issue 26 synthetic administrator ${suffix.slice(0, 8)}`,
    facilityScopeKind: 'district',
    createdAt: now,
  });
  await database.insert(userRoles).values({
    userId: authenticated.actor.userId,
    role: 'admin',
  });
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
      groupSourceId: accessGroupId,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
      completionKind: 'expected',
    },
    {
      snapshotId,
      groupSourceId: accessGroupId,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
      completionKind: 'completed',
    },
  ]);
  await database.insert(accessMembershipMembers).values({
    snapshotId,
    userId: authenticated.actor.userId,
    googleSubject: `issue-26-admin-subject-${suffix}`,
    facilityScopeKind: 'district',
  });
  await database.insert(accessMembershipMemberGroups).values({
    snapshotId,
    userId: authenticated.actor.userId,
    groupSourceId: accessGroupId,
    groupSourceKind: 'google-group',
    groupPurpose: 'access',
  });
  await database.insert(deviceEnrollments).values({
    id: deviceId,
    userId: authenticated.actor.userId,
    platform: 'web',
    unlockMethod: 'secure-session-cookie',
    installationId: `issue-26-admin-device-${suffix}`,
    enrolledAt: now,
    lastSeenAt: now,
  });
  await database.insert(sessions).values({
    id: authenticated.actor.sessionId,
    userId: authenticated.actor.userId,
    deviceEnrollmentId: deviceId,
    membershipSnapshotId: snapshotId,
    membershipValidUntil: validUntil,
    membershipGraceUntil: graceUntil,
    createdAt: now,
    expiresAt,
  });
}

async function waitForAdvisoryWaiters(
  database: PostgresDatabaseConnection['db'],
  minimum: number,
  blockerPid?: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await database.execute<{ waiting: number }>(
      blockerPid === undefined
        ? sql`
            select count(*)::int as waiting
            from pg_locks
            where locktype = 'advisory'
              and granted = false
          `
        : sql`
            select count(distinct waiter.pid)::int as waiting
            from pg_locks as blocker
            inner join pg_locks as waiter
              on waiter.locktype = blocker.locktype
              and waiter.database is not distinct from blocker.database
              and waiter.classid is not distinct from blocker.classid
              and waiter.objid is not distinct from blocker.objid
              and waiter.objsubid is not distinct from blocker.objsubid
            where blocker.pid = ${blockerPid}
              and blocker.locktype = 'advisory'
              and blocker.granted = true
              and waiter.granted = false
          `,
    );
    if ((row?.waiting ?? 0) >= minimum) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${minimum} queued advisory-lock operations.`,
  );
}

describeWithDatabase('facilities administrator database flow', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 6,
    });
    if (created.driver !== 'postgres') {
      throw new Error('Facilities integration tests require PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
    await seedDatabase(created.db);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('configures a complete new site and records every mutation', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];

    const facilityMetadata = metadata('facility', requestIds);
    const facility = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: {
        code: `I26-${suffix.slice(0, 8).toUpperCase()}`,
        name: `Issue 26 synthetic site ${suffix.slice(0, 8)}`,
      },
      metadata: facilityMetadata,
    });
    const facilityReplay = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: { code: facility.code, name: facility.name },
      metadata: facilityMetadata,
    });
    expect(facilityReplay).toEqual(facility);

    const staffBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} staff`,
        active: true,
        googleGroupId: `issue-26-staff-${suffix}`,
        email: `issue-26-staff-${suffix}@example.invalid`,
      },
      metadata: metadata('staff-building', requestIds),
    });
    const syntheticBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'synthetic',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} synthetic staff`,
        active: true,
        fixtureKey: `issue-26-building-${suffix}`,
      },
      metadata: metadata('synthetic-building', requestIds),
    });
    const accessGroup = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: `Issue 26 access ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-access-${suffix}`,
        email: `issue-26-access-${suffix}@example.invalid`,
      },
      metadata: metadata('access-group', requestIds),
    });
    await persistAuthenticatedAdministrator(
      database,
      authenticated,
      accessGroup.id,
      suffix,
    );
    const others = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: `Issue 26 district others ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `issue-26-others-${suffix}`,
        email: `issue-26-others-${suffix}@example.invalid`,
      },
      metadata: metadata('others', requestIds),
    });
    const syntheticOthers = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
        displayName: `Issue 26 synthetic others ${suffix.slice(0, 8)}`,
        active: true,
        fixtureKey: `issue-26-others-${suffix}`,
      },
      metadata: metadata('synthetic-others', requestIds),
    });
    if (
      others.kind !== 'google-group' ||
      others.purpose !== 'others' ||
      others.facilityId !== null
    ) {
      throw new Error('The configured audience extension lost its purpose.');
    }
    if (
      syntheticOthers.kind !== 'synthetic' ||
      syntheticOthers.purpose !== 'others' ||
      syntheticOthers.facilityId !== null
    ) {
      throw new Error(
        'The configured synthetic audience extension lost its purpose.',
      );
    }
    const neighborhood = await executeCreateNeighborhoodVersionCapability({
      authenticated,
      store,
      command: {
        neighborhoodId: null,
        name: `Issue 26 neighborhood ${suffix.slice(0, 8)}`,
        facilityIds: [facility.id],
      },
      metadata: metadata('neighborhood', requestIds),
    });
    const audience = await executeCreateAudienceConfigVersionCapability({
      authenticated,
      store,
      command: {
        audienceConfigId: null,
        facilityId: facility.id,
        targets: [
          { kind: 'building', facilityId: facility.id },
          {
            kind: 'neighborhood',
            neighborhood: {
              id: neighborhood.id,
              version: neighborhood.version,
            },
          },
          {
            kind: 'others',
            groupSourceRef: {
              id: others.id,
              kind: others.kind,
              purpose: others.purpose,
              facilityId: others.facilityId,
            },
          },
        ],
      },
      metadata: metadata('audience', requestIds),
    });

    expect(
      await executeGetAudienceConfigCapability({
        authenticated,
        store,
        query: { facilityId: facility.id },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(audience);
    try {
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: audience.id,
          facilityId: facility.id,
          targets: [
            {
              kind: 'neighborhood',
              neighborhood: {
                id: neighborhood.id,
                version: neighborhood.version,
              },
            },
          ],
        },
        metadata: {
          idempotencyKey: `issue-26-missing-building-${randomUUID()}`,
          requestId: randomUUID(),
          now: new Date(),
        },
      });
      throw new Error('Expected an audience without its building to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    const mixedAudienceRequestId = randomUUID();
    try {
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: audience.id,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: others.id,
                kind: others.kind,
                purpose: others.purpose,
                facilityId: others.facilityId,
              },
            },
            {
              kind: 'others',
              groupSourceRef: {
                id: syntheticOthers.id,
                kind: syntheticOthers.kind,
                purpose: syntheticOthers.purpose,
                facilityId: syntheticOthers.facilityId,
              },
            },
          ],
        },
        metadata: {
          idempotencyKey: `issue-26-mixed-audience-${randomUUID()}`,
          requestId: mixedAudienceRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected a mixed-population audience to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }

    const roleTargetId = randomUUID();
    await database.insert(users).values({
      id: roleTargetId,
      googleSubject: `issue-26-subject-${suffix}`,
      email: `issue-26-role-${suffix}@psd401.net`,
      displayName: `Issue 26 synthetic staff ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
    });
    await database.insert(userRoles).values({
      userId: roleTargetId,
      role: 'staff',
    });
    const rolelessContactId = randomUUID();
    await database.insert(users).values({
      id: rolelessContactId,
      googleSubject: `issue-26-contact-${suffix}`,
      email: `issue-26-contact-${suffix}@psd401.net`,
      displayName: `Issue 26 synthetic contact ${suffix.slice(0, 8)}`,
      facilityScopeKind: 'district',
    });
    const [roleTargetRow] = await database
      .select()
      .from(users)
      .where(eq(users.id, roleTargetId))
      .limit(1);
    if (roleTargetRow === undefined) {
      throw new Error('The bootstrap-role target could not be reloaded.');
    }
    const activeAccessGroups = await database
      .select({
        id: groupSources.id,
        kind: groupSources.kind,
        purpose: groupSources.purpose,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      );
    const [latestAccessSnapshot] = await database
      .select({ version: accessMembershipSnapshots.version })
      .from(accessMembershipSnapshots)
      .orderBy(desc(accessMembershipSnapshots.version))
      .limit(1);
    const bootstrapSnapshotId = randomUUID();
    const bootstrapSnapshotAt = new Date(Date.now() + 60_000);
    const bootstrapSnapshotVersion = (latestAccessSnapshot?.version ?? 0) + 1;
    await database.insert(accessMembershipSnapshots).values({
      id: bootstrapSnapshotId,
      version: bootstrapSnapshotVersion,
      complete: true,
      syncStartedAt: bootstrapSnapshotAt,
      capturedAt: bootstrapSnapshotAt,
    });
    await database.insert(accessMembershipSnapshotGroups).values(
      activeAccessGroups.flatMap((group) => [
        {
          snapshotId: bootstrapSnapshotId,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
          completionKind: 'expected' as const,
        },
        {
          snapshotId: bootstrapSnapshotId,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
          completionKind: 'completed' as const,
        },
      ]),
    );
    await database.insert(accessMembershipMembers).values({
      snapshotId: bootstrapSnapshotId,
      userId: roleTargetId,
      googleSubject: roleTargetRow.googleSubject,
      facilityScopeKind: 'district',
    });
    await database.insert(accessMembershipMemberGroups).values({
      snapshotId: bootstrapSnapshotId,
      userId: roleTargetId,
      groupSourceId: accessGroup.id,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
    const bootstrapUser = {
      id: roleTargetRow.id,
      googleSubject: roleTargetRow.googleSubject,
      email: roleTargetRow.email,
      displayName: roleTargetRow.displayName,
      roles: ['staff'] as const,
      facilityScope: { kind: 'district' as const },
      createdAt: roleTargetRow.createdAt.toISOString(),
      disabledAt: null,
    };
    const bootstrapMembershipSnapshot = {
      id: bootstrapSnapshotId,
      version: bootstrapSnapshotVersion,
      complete: true as const,
      syncStartedAt: bootstrapSnapshotAt.toISOString(),
      capturedAt: bootstrapSnapshotAt.toISOString(),
    };
    const bootstrapMembershipMember = {
      userId: roleTargetId,
      googleSubject: roleTargetRow.googleSubject,
      accessGroupSourceRefs: [
        {
          id: accessGroup.id,
          kind: 'google-group' as const,
          purpose: 'access' as const,
          facilityId: null,
        },
      ],
      facilityScope: { kind: 'district' as const },
    };
    const initialSessionStore = createDrizzleInitialWebSessionStore(database);
    const firstBootstrapSession = await initialSessionStore.persist(
      bootstrapSessionRequest({
        label: `first-${suffix}`,
        user: bootstrapUser,
        membershipSnapshot: bootstrapMembershipSnapshot,
        membershipMember: bootstrapMembershipMember,
        createdAt: new Date(bootstrapSnapshotAt.getTime() + 1_000),
      }),
    );
    expect(firstBootstrapSession.user.roles).toEqual(['staff', 'admin']);

    const accessAccounts = await executeListUsersCapability({
      authenticated,
      store,
      query: {
        facilityId: null,
        includeDisabled: true,
        cursor: null,
        limit: 200,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(
      accessAccounts.items.some(({ id }) => id === rolelessContactId),
    ).toBe(false);
    const roleAssignmentMetadata = metadata('role-assignment', requestIds);
    const roleResult = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: roleTargetId, roles: ['staff', 'admin'] },
      metadata: roleAssignmentMetadata,
    });
    expect(roleResult.roles).toEqual(['staff', 'admin']);
    expect(
      await executeSetUserRolesCapability({
        authenticated,
        store,
        command: { userId: roleTargetId, roles: ['staff', 'admin'] },
        metadata: roleAssignmentMetadata,
      }),
    ).toEqual(roleResult);
    const selfDemotion = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: authenticated.actor.userId, roles: ['staff'] },
      metadata: metadata('self-demotion-with-backup', requestIds),
    });
    expect(selfDemotion.roles).toEqual(['staff']);
    const backupAdministrator = {
      ...authenticated,
      actor: {
        kind: 'human' as const,
        userId: roleTargetId,
        sessionId: firstBootstrapSession.session.id,
      },
      roles: ['admin'] as const,
    } as unknown as AuthenticatedSession;
    const backupStore = createDrizzleAdminCapabilityStore(
      database,
      backupAdministrator,
    );
    const restoredAdministrator = await executeSetUserRolesCapability({
      authenticated: backupAdministrator,
      store: backupStore,
      command: { userId: authenticated.actor.userId, roles: ['admin'] },
      metadata: metadata('restore-primary-admin', requestIds),
    });
    expect(restoredAdministrator.roles).toEqual(['admin']);
    const roleRemovalMetadata = metadata('role-removal', requestIds);
    const roleRemoval = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: roleTargetId, roles: ['staff'] },
      metadata: roleRemovalMetadata,
    });
    expect(roleRemoval.roles).toEqual(['staff']);
    const secondBootstrapSession = await initialSessionStore.persist(
      bootstrapSessionRequest({
        label: `after-revocation-${suffix}`,
        user: bootstrapUser,
        membershipSnapshot: bootstrapMembershipSnapshot,
        membershipMember: bootstrapMembershipMember,
        createdAt: new Date(bootstrapSnapshotAt.getTime() + 2_000),
      }),
    );
    expect(secondBootstrapSession.user.roles).toEqual(['staff']);
    const roleChanges = await database
      .select({
        role: userRoleChanges.role,
        granted: userRoleChanges.granted,
      })
      .from(userRoleChanges)
      .where(eq(userRoleChanges.userId, roleTargetId))
      .orderBy(userRoleChanges.sequence);
    expect(roleChanges).toEqual([
      { role: 'admin', granted: true },
      { role: 'admin', granted: false },
    ]);
    const baseRoleRows = await database
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, roleTargetId));
    expect(baseRoleRows).toEqual([{ role: 'staff' }]);

    const selfRemovalRequestId = randomUUID();
    try {
      await executeSetUserRolesCapability({
        authenticated,
        store,
        command: { userId: authenticated.actor.userId, roles: ['staff'] },
        metadata: {
          idempotencyKey: `issue-26-self-role-removal-${randomUUID()}`,
          requestId: selfRemovalRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected self-admin removal to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    const [selfRemovalAudit] = await database
      .select({
        action: securityAuditEntries.action,
        outcome: securityAuditEntries.outcome,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, selfRemovalRequestId))
      .limit(1);
    expect(selfRemovalAudit).toEqual({
      action: 'set-user-roles',
      outcome: 'failure',
    });

    const channelResult = await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: 'expo-push',
        enabled: false,
        authorization: null,
      },
      metadata: metadata('channel-state', requestIds),
    });
    expect(channelResult).toMatchObject({
      integrationId: 'expo-push',
      enabled: false,
      status: { label: 'mocked' },
    });
    if (authenticated.actor.kind !== 'human') {
      throw new Error('The synthetic administrator must be human.');
    }

    const transitioningIntegrationId = `synthetic-transition-${suffix}`;
    const mockedTransitionStatusId = randomUUID();
    const mockedTransitionObservedAt = new Date();
    await database.insert(integrationStatuses).values({
      id: mockedTransitionStatusId,
      integrationId: transitioningIntegrationId,
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: mockedTransitionObservedAt,
    });
    await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: transitioningIntegrationId,
        enabled: true,
        authorization: null,
      },
      metadata: metadata('mocked-transition-enable', requestIds),
    });
    const transitionLiveStatusId = randomUUID();
    const transitionIssuedAt = new Date(
      mockedTransitionObservedAt.getTime() + 1_000,
    );
    const transitionBase = {
      reference: `issue-26-transition-${randomUUID()}`,
      integrationStatusId: transitionLiveStatusId,
      integrationId: transitioningIntegrationId,
      desiredEnabled: true,
      requestDigest: '0'.repeat(64),
      consequenceDigest: '0'.repeat(64),
      authorizedByUserId: authenticated.actor.userId,
      authorizedWithSessionId: authenticated.actor.sessionId,
      issuedAt: transitionIssuedAt.toISOString(),
      expiresAt: new Date(
        transitionIssuedAt.getTime() + 15 * 60 * 1_000,
      ).toISOString(),
    } as const;
    const transitionAuthorization =
      IntegrationChannelChangeAuthorizationSchema.parse({
        ...transitionBase,
        requestDigest: liveChannelChangeRequestDigest(transitionBase),
        consequenceDigest: liveChannelChangeConsequenceDigest({
          integrationId: transitioningIntegrationId,
          previousConfiguration: {
            enabled: true,
            statusId: mockedTransitionStatusId,
          },
          desiredEnabled: true,
          integrationStatusId: transitionLiveStatusId,
        }),
      });
    await database.insert(integrationStatuses).values({
      id: transitionLiveStatusId,
      integrationId: transitioningIntegrationId,
      label: 'live-verified',
      verifiedAt: transitionIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: liveChannelChangeAuthorizationCommitment(
        transitionAuthorization,
      ),
      reasonCode: null,
      observedAt: transitionIssuedAt,
    });
    const [transitionedConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
        statusLabel: channelConfigurations.statusLabel,
      })
      .from(channelConfigurations)
      .where(
        eq(channelConfigurations.integrationId, transitioningIntegrationId),
      )
      .limit(1);
    expect(transitionedConfiguration).toEqual({
      enabled: false,
      statusId: transitionLiveStatusId,
      statusLabel: 'live-verified',
    });

    const oneTimeRaceIntegrationId = `synthetic-live-once-${suffix}`;
    const oneTimeRaceStatusId = randomUUID();
    const oneTimeRaceIssuedAt = new Date(Date.now() - 1_000);
    const oneTimeRaceAuthorization = liveAuthorizationFor({
      authenticated,
      integrationId: oneTimeRaceIntegrationId,
      integrationStatusId: oneTimeRaceStatusId,
      previousConfiguration: null,
      issuedAt: oneTimeRaceIssuedAt,
    });
    await database.insert(integrationStatuses).values({
      id: oneTimeRaceStatusId,
      integrationId: oneTimeRaceIntegrationId,
      label: 'live-verified',
      verifiedAt: oneTimeRaceIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: liveChannelChangeAuthorizationCommitment(
        oneTimeRaceAuthorization,
      ),
      reasonCode: null,
      observedAt: oneTimeRaceIssuedAt,
    });

    let releaseOneTimeRaceLock: (() => void) | undefined;
    const oneTimeRaceLockReleased = new Promise<void>((resolve) => {
      releaseOneTimeRaceLock = resolve;
    });
    let confirmOneTimeRaceLock: ((pid: number) => void) | undefined;
    const oneTimeRaceLockHeld = new Promise<number>((resolve) => {
      confirmOneTimeRaceLock = resolve;
    });
    const oneTimeRaceBlocker = database.transaction(async (transaction) => {
      const [lock] = await transaction.execute<{ pid: number }>(
        sql`
          select
            pg_backend_pid()::int as pid,
            pg_advisory_xact_lock(hashtextextended(${oneTimeRaceIntegrationId}, 0))
        `,
      );
      if (lock === undefined) {
        throw new Error('The one-time race advisory lock was not acquired.');
      }
      confirmOneTimeRaceLock?.(lock.pid);
      await oneTimeRaceLockReleased;
    });
    const oneTimeRaceBlockerPid = await oneTimeRaceLockHeld;

    const oneTimeRaceMetadata = [
      metadata('live-one-time-race-a', requestIds),
      metadata('live-one-time-race-b', requestIds),
    ] as const;
    const oneTimeRaceResultsPromise = Promise.allSettled(
      oneTimeRaceMetadata.map((raceMetadata) =>
        executeSetChannelEnabledCapability({
          authenticated,
          store,
          command: {
            integrationId: oneTimeRaceIntegrationId,
            enabled: true,
            authorization: oneTimeRaceAuthorization,
          },
          metadata: raceMetadata,
        }),
      ),
    );
    await waitForAdvisoryWaiters(database, 2, oneTimeRaceBlockerPid);
    releaseOneTimeRaceLock?.();
    await oneTimeRaceBlocker;

    const oneTimeRaceResults = await oneTimeRaceResultsPromise;
    const oneTimeRaceSuccesses = oneTimeRaceResults.filter(
      (result) => result.status === 'fulfilled',
    );
    const oneTimeRaceFailures = oneTimeRaceResults.filter(
      (result) => result.status === 'rejected',
    );
    expect(oneTimeRaceSuccesses).toHaveLength(1);
    expect(oneTimeRaceFailures).toHaveLength(1);
    expect(oneTimeRaceFailures[0]?.reason).toBeInstanceOf(AdminCapabilityError);
    expect(
      (oneTimeRaceFailures[0]?.reason as AdminCapabilityError).status,
    ).toBe(403);
    const oneTimeRaceAuthorizationRows = await database
      .select({
        reference: integrationChannelChangeAuthorizations.reference,
        requestId: integrationChannelChangeAuthorizations.consumedRequestId,
      })
      .from(integrationChannelChangeAuthorizations)
      .where(
        eq(
          integrationChannelChangeAuthorizations.integrationStatusId,
          oneTimeRaceStatusId,
        ),
      );
    expect(oneTimeRaceAuthorizationRows).toHaveLength(1);
    const [oneTimeRaceAuthorizationRow] = oneTimeRaceAuthorizationRows;
    if (oneTimeRaceAuthorizationRow === undefined) {
      throw new Error('The one-time authorization evidence row is missing.');
    }
    expect(oneTimeRaceAuthorizationRow.reference).toBe(
      oneTimeRaceAuthorization.reference,
    );
    const oneTimeRaceWinnerIndex = oneTimeRaceResults.findIndex(
      (result) => result.status === 'fulfilled',
    );
    const oneTimeRaceWinnerMetadata =
      oneTimeRaceMetadata[oneTimeRaceWinnerIndex];
    if (oneTimeRaceWinnerMetadata === undefined) {
      throw new Error('The one-time authorization race has no winner.');
    }
    expect(oneTimeRaceAuthorizationRow.requestId).toBe(
      oneTimeRaceWinnerMetadata.requestId,
    );

    const statusRaceIntegrationId = `synthetic-live-status-race-${suffix}`;
    const statusRaceLiveStatusId = randomUUID();
    const statusRaceIssuedAt = new Date(Date.now() - 1_000);
    const statusRaceAuthorization = liveAuthorizationFor({
      authenticated,
      integrationId: statusRaceIntegrationId,
      integrationStatusId: statusRaceLiveStatusId,
      previousConfiguration: null,
      issuedAt: statusRaceIssuedAt,
    });
    await database.insert(integrationStatuses).values({
      id: statusRaceLiveStatusId,
      integrationId: statusRaceIntegrationId,
      label: 'live-verified',
      verifiedAt: statusRaceIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: liveChannelChangeAuthorizationCommitment(
        statusRaceAuthorization,
      ),
      reasonCode: null,
      observedAt: statusRaceIssuedAt,
    });

    let releaseStatusRaceLock: (() => void) | undefined;
    const statusRaceLockReleased = new Promise<void>((resolve) => {
      releaseStatusRaceLock = resolve;
    });
    let confirmStatusRaceLock: ((pid: number) => void) | undefined;
    const statusRaceLockHeld = new Promise<number>((resolve) => {
      confirmStatusRaceLock = resolve;
    });
    const statusRaceBlocker = database.transaction(async (transaction) => {
      const [lock] = await transaction.execute<{ pid: number }>(
        sql`
          select
            pg_backend_pid()::int as pid,
            pg_advisory_xact_lock(hashtextextended(${statusRaceIntegrationId}, 0))
        `,
      );
      if (lock === undefined) {
        throw new Error('The status race advisory lock was not acquired.');
      }
      confirmStatusRaceLock?.(lock.pid);
      await statusRaceLockReleased;
    });
    const statusRaceBlockerPid = await statusRaceLockHeld;

    const statusRaceMutation = executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: statusRaceIntegrationId,
        enabled: true,
        authorization: statusRaceAuthorization,
      },
      metadata: metadata('live-status-race-enable', requestIds),
    });
    await waitForAdvisoryWaiters(database, 1, statusRaceBlockerPid);
    const statusRaceBlockedStatusId = randomUUID();
    const statusRaceBlockedObservedAt = new Date(
      Math.max(Date.now(), statusRaceIssuedAt.getTime() + 1),
    );
    const statusRaceStatusInsert = (async () => {
      await database.insert(integrationStatuses).values({
        id: statusRaceBlockedStatusId,
        integrationId: statusRaceIntegrationId,
        label: 'blocked',
        verifiedAt: null,
        verifiedByUserId: null,
        authorizationReference: null,
        reasonCode: 'PREREQUISITE_PENDING',
        observedAt: statusRaceBlockedObservedAt,
      });
    })();
    await waitForAdvisoryWaiters(database, 2, statusRaceBlockerPid);
    releaseStatusRaceLock?.();
    await statusRaceBlocker;

    const [statusRaceMutationResult, statusRaceInsertResult] =
      await Promise.allSettled([statusRaceMutation, statusRaceStatusInsert]);
    expect(statusRaceMutationResult.status).toBe('fulfilled');
    expect(statusRaceInsertResult.status).toBe('fulfilled');
    const [statusRaceConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
        statusLabel: channelConfigurations.statusLabel,
      })
      .from(channelConfigurations)
      .where(eq(channelConfigurations.integrationId, statusRaceIntegrationId))
      .limit(1);
    expect(statusRaceConfiguration).toEqual({
      enabled: false,
      statusId: statusRaceBlockedStatusId,
      statusLabel: 'blocked',
    });
    const statusRaceAuthorizationRows = await database
      .select({ id: integrationChannelChangeAuthorizations.id })
      .from(integrationChannelChangeAuthorizations)
      .where(
        eq(
          integrationChannelChangeAuthorizations.integrationStatusId,
          statusRaceLiveStatusId,
        ),
      );
    expect(statusRaceAuthorizationRows).toHaveLength(1);

    const liveIntegrationId = `synthetic-live-${suffix}`;
    const liveStatusId = randomUUID();
    const issuedAt = new Date(Date.now() - 1_000);
    const expiresAt = new Date(issuedAt.getTime() + 15 * 60 * 1_000);
    const issuedAtWithOffset = `${new Date(
      issuedAt.getTime() - 7 * 60 * 60 * 1_000,
    )
      .toISOString()
      .slice(0, -1)}-07:00`;
    const reference = `issue-26-live-${randomUUID()}`;
    const authorizationBase = {
      reference,
      integrationStatusId: liveStatusId,
      integrationId: liveIntegrationId,
      desiredEnabled: true,
      requestDigest: '0'.repeat(64),
      consequenceDigest: '0'.repeat(64),
      authorizedByUserId: authenticated.actor.userId,
      authorizedWithSessionId: authenticated.actor.sessionId,
      issuedAt: issuedAtWithOffset,
      expiresAt: expiresAt.toISOString(),
    } as const;
    const liveAuthorization = IntegrationChannelChangeAuthorizationSchema.parse(
      {
        ...authorizationBase,
        requestDigest: liveChannelChangeRequestDigest(authorizationBase),
        consequenceDigest: liveChannelChangeConsequenceDigest({
          integrationId: liveIntegrationId,
          previousConfiguration: null,
          desiredEnabled: true,
          integrationStatusId: liveStatusId,
        }),
      },
    );
    const authorizationCommitment =
      liveChannelChangeAuthorizationCommitment(liveAuthorization);
    await database.insert(integrationStatuses).values({
      id: liveStatusId,
      integrationId: liveIntegrationId,
      label: 'live-verified',
      verifiedAt: issuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference: authorizationCommitment,
      reasonCode: null,
      observedAt: issuedAt,
    });
    const liveMetadata = metadata('live-channel-state', requestIds);
    const liveChannelResult = await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: liveIntegrationId,
        enabled: true,
        authorization: liveAuthorization,
      },
      metadata: liveMetadata,
    });
    expect(liveChannelResult).toMatchObject({
      integrationId: liveIntegrationId,
      enabled: true,
      status: { label: 'live-verified' },
    });
    expect(
      await executeSetChannelEnabledCapability({
        authenticated,
        store,
        command: {
          integrationId: liveIntegrationId,
          enabled: true,
          authorization: liveAuthorization,
        },
        metadata: liveMetadata,
      }),
    ).toEqual(liveChannelResult);
    const authorizationRows = await database
      .select({
        reference: integrationChannelChangeAuthorizations.reference,
        requestId: integrationChannelChangeAuthorizations.consumedRequestId,
      })
      .from(integrationChannelChangeAuthorizations)
      .where(
        eq(
          integrationChannelChangeAuthorizations.integrationStatusId,
          liveStatusId,
        ),
      );
    expect(authorizationRows).toEqual([
      { reference, requestId: liveMetadata.requestId },
    ]);

    const copiedReferenceRequestId = randomUUID();
    try {
      await executeSetChannelEnabledCapability({
        authenticated,
        store,
        command: {
          integrationId: liveIntegrationId,
          enabled: true,
          authorization: liveAuthorization,
        },
        metadata: {
          idempotencyKey: `issue-26-live-reuse-${randomUUID()}`,
          requestId: copiedReferenceRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected live authorization reuse to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(403);
    }
    const [persistedLiveConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
      })
      .from(channelConfigurations)
      .where(eq(channelConfigurations.integrationId, liveIntegrationId))
      .limit(1);
    expect(persistedLiveConfiguration).toEqual({
      enabled: true,
      statusId: liveStatusId,
    });
    const blockedStatusId = randomUUID();
    const blockedObservedAt = new Date(
      Math.max(Date.now(), issuedAt.getTime() + 1),
    );
    await database.insert(integrationStatuses).values({
      id: blockedStatusId,
      integrationId: liveIntegrationId,
      label: 'blocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: 'PREREQUISITE_PENDING',
      observedAt: blockedObservedAt,
    });
    const [blockedConfiguration] = await database
      .select({
        enabled: channelConfigurations.enabled,
        statusId: channelConfigurations.statusId,
        statusLabel: channelConfigurations.statusLabel,
      })
      .from(channelConfigurations)
      .where(eq(channelConfigurations.integrationId, liveIntegrationId))
      .limit(1);
    expect(blockedConfiguration).toEqual({
      enabled: false,
      statusId: blockedStatusId,
      statusLabel: 'blocked',
    });
    await expect(
      database.insert(integrationStatuses).values({
        id: randomUUID(),
        integrationId: liveIntegrationId,
        label: 'configured-unverified',
        verifiedAt: null,
        verifiedByUserId: null,
        authorizationReference: null,
        reasonCode: null,
        observedAt: blockedObservedAt,
      }),
    ).rejects.toThrow();

    const agentAuthenticated = {
      ...authenticated,
      actor: { kind: 'agent', agentId: randomUUID() },
      source: 'agent-rest',
    } as unknown as AuthenticatedSession;
    try {
      await executeSetChannelEnabledCapability({
        authenticated: agentAuthenticated,
        store: createDrizzleAdminCapabilityStore(database, agentAuthenticated),
        command: {
          integrationId: liveIntegrationId,
          enabled: true,
          authorization: liveAuthorization,
        },
        metadata: {
          idempotencyKey: `issue-26-agent-live-${randomUUID()}`,
          requestId: randomUUID(),
          now: new Date(),
        },
      });
      throw new Error('Expected an agent live change to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(403);
    }

    const expiredIntegrationId = `synthetic-expired-${suffix}`;
    const expiredStatusId = randomUUID();
    const expiredIssuedAt = new Date(Date.now() - 20 * 60 * 1_000);
    const expiredExpiresAt = new Date(
      expiredIssuedAt.getTime() + 15 * 60 * 1_000,
    );
    const expiredBase = {
      reference: `issue-26-expired-${randomUUID()}`,
      integrationStatusId: expiredStatusId,
      integrationId: expiredIntegrationId,
      desiredEnabled: true,
      requestDigest: '0'.repeat(64),
      consequenceDigest: '0'.repeat(64),
      authorizedByUserId: authenticated.actor.userId,
      authorizedWithSessionId: authenticated.actor.sessionId,
      issuedAt: expiredIssuedAt.toISOString(),
      expiresAt: expiredExpiresAt.toISOString(),
    } as const;
    const expiredAuthorization =
      IntegrationChannelChangeAuthorizationSchema.parse({
        ...expiredBase,
        requestDigest: liveChannelChangeRequestDigest(expiredBase),
        consequenceDigest: liveChannelChangeConsequenceDigest({
          integrationId: expiredIntegrationId,
          previousConfiguration: null,
          desiredEnabled: true,
          integrationStatusId: expiredStatusId,
        }),
      });
    await database.insert(integrationStatuses).values({
      id: expiredStatusId,
      integrationId: expiredIntegrationId,
      label: 'live-verified',
      verifiedAt: expiredIssuedAt,
      verifiedByUserId: authenticated.actor.userId,
      authorizationReference:
        liveChannelChangeAuthorizationCommitment(expiredAuthorization),
      reasonCode: null,
      observedAt: expiredIssuedAt,
    });
    for (const authorization of [null, expiredAuthorization]) {
      try {
        await executeSetChannelEnabledCapability({
          authenticated,
          store,
          command: {
            integrationId: expiredIntegrationId,
            enabled: true,
            authorization,
          },
          metadata: {
            idempotencyKey: `issue-26-expired-live-${randomUUID()}`,
            requestId: randomUUID(),
            now: new Date(),
          },
        });
        throw new Error(
          'Expected missing or expired live authorization to fail closed.',
        );
      } catch (error) {
        expect(error).toBeInstanceOf(AdminCapabilityError);
        expect((error as AdminCapabilityError).status).toBe(403);
      }
    }
    expect(
      await database
        .select({ id: channelConfigurations.integrationId })
        .from(channelConfigurations)
        .where(eq(channelConfigurations.integrationId, expiredIntegrationId)),
    ).toEqual([]);

    await executeUpdateFacilityCapability({
      authenticated,
      store,
      command: {
        facilityId: facility.id,
        code: facility.code,
        name: `${facility.name} revised`,
        active: true,
      },
      metadata: metadata('facility-update', requestIds),
    });
    try {
      await executeCreateFacilityCapability({
        authenticated,
        store,
        command: { code: facility.code, name: facility.name },
        metadata: facilityMetadata,
      });
      throw new Error('Expected stale mutable replay to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }

    for (const source of [staffBuilding, syntheticBuilding]) {
      const population = source.kind === 'google-group' ? 'staff' : 'synthetic';
      const [configuration] = await database
        .select({
          id: rosterSourceConfigurations.id,
          version: rosterSourceConfigurations.version,
        })
        .from(rosterSourceConfigurations)
        .where(eq(rosterSourceConfigurations.population, population))
        .orderBy(desc(rosterSourceConfigurations.version))
        .limit(1);
      expect(configuration).toBeDefined();
      if (configuration === undefined) continue;
      const [facilityEvidence] = await database
        .select({ facilityId: rosterSourceConfigurationFacilities.facilityId })
        .from(rosterSourceConfigurationFacilities)
        .where(
          and(
            eq(
              rosterSourceConfigurationFacilities.configurationId,
              configuration.id,
            ),
            eq(
              rosterSourceConfigurationFacilities.configurationVersion,
              configuration.version,
            ),
            eq(rosterSourceConfigurationFacilities.facilityId, facility.id),
          ),
        )
        .limit(1);
      const [sourceEvidence] = await database
        .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
        .from(rosterSourceConfigurationGroups)
        .where(
          and(
            eq(
              rosterSourceConfigurationGroups.configurationId,
              configuration.id,
            ),
            eq(
              rosterSourceConfigurationGroups.configurationVersion,
              configuration.version,
            ),
            eq(rosterSourceConfigurationGroups.groupSourceId, source.id),
          ),
        )
        .limit(1);
      expect(facilityEvidence?.facilityId).toBe(facility.id);
      expect(sourceEvidence?.sourceId).toBe(source.id);
    }

    const auditRows = await database
      .select({
        requestId: securityAuditEntries.requestId,
        category: securityAuditEntries.category,
        outcome: securityAuditEntries.outcome,
      })
      .from(securityAuditEntries)
      .where(inArray(securityAuditEntries.requestId, requestIds));
    expect(auditRows).toHaveLength(requestIds.length);
    expect(
      auditRows.every(
        ({ category, outcome }) =>
          category === 'admin-change' && outcome === 'success',
      ),
    ).toBe(true);

    const missingFacilityRequestId = randomUUID();
    try {
      await executeRosterHealthProjection({
        authenticated,
        store,
        query: {
          population: 'staff',
          facilityId: randomUUID(),
          cursor: null,
          limit: 25,
        },
        metadata: { requestId: missingFacilityRequestId, now: new Date() },
      });
      throw new Error('Expected an unknown roster-health facility to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(404);
    }
    const [missingFacilityAudit] = await database
      .select({ requestId: securityAuditEntries.requestId })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, missingFacilityRequestId))
      .limit(1);
    expect(missingFacilityAudit?.requestId).toBe(missingFacilityRequestId);
  });

  test('replaces immutable roster sources with derived versions and rejects stale concurrent replacements', async () => {
    const database = databaseConnection().db;
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(database, authenticated);
    const suffix = randomUUID();
    const requestIds: string[] = [];

    const facility = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: {
        code: `RPL-${suffix.slice(0, 8).toUpperCase()}`,
        name: `Replacement test site ${suffix.slice(0, 8)}`,
      },
      metadata: metadata('replacement-facility', requestIds),
    });
    const originalBuilding = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} original staff`,
        active: true,
        googleGroupId: `replacement-original-${suffix}`,
        email: `replacement-original-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-building', requestIds),
    });
    const originalOthers = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: `Replacement others ${suffix.slice(0, 8)}`,
        active: true,
        googleGroupId: `replacement-others-${suffix}`,
        email: `replacement-others-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-others', requestIds),
    });
    const historicalAudience =
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: null,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: originalOthers.id,
                kind: 'google-group',
                purpose: 'others',
                facilityId: null,
              },
            },
          ],
        },
        metadata: metadata('replacement-audience', requestIds),
      });

    async function latestStaffConfiguration() {
      const [header] = await database
        .select({
          id: rosterSourceConfigurations.id,
          version: rosterSourceConfigurations.version,
        })
        .from(rosterSourceConfigurations)
        .where(eq(rosterSourceConfigurations.population, 'staff'))
        .orderBy(desc(rosterSourceConfigurations.version))
        .limit(1);
      if (header === undefined) {
        throw new Error('The staff roster configuration is missing.');
      }
      const groups = await database
        .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
        .from(rosterSourceConfigurationGroups)
        .where(
          and(
            eq(rosterSourceConfigurationGroups.configurationId, header.id),
            eq(
              rosterSourceConfigurationGroups.configurationVersion,
              header.version,
            ),
          ),
        )
        .orderBy(rosterSourceConfigurationGroups.groupSourceId);
      return { ...header, sourceIds: groups.map(({ sourceId }) => sourceId) };
    }

    const before = await latestStaffConfiguration();
    expect(before.sourceIds).toContain(originalBuilding.id);
    expect(before.sourceIds).toContain(originalOthers.id);
    const [latestStaffSnapshotBeforeReplacement] = await database
      .select({ version: rosterSnapshots.version })
      .from(rosterSnapshots)
      .where(eq(rosterSnapshots.population, 'staff'))
      .orderBy(desc(rosterSnapshots.version))
      .limit(1);
    const snapshotVersionBeforeReplacement =
      (latestStaffSnapshotBeforeReplacement?.version ?? 0) + 1;
    const snapshotBeforeReplacementAt = new Date();
    await database.insert(rosterSnapshots).values({
      id: randomUUID(),
      version: snapshotVersionBeforeReplacement,
      population: 'staff',
      complete: true,
      sourceConfigurationId: before.id,
      sourceConfigurationVersion: before.version,
      syncStartedAt: snapshotBeforeReplacementAt,
      capturedAt: snapshotBeforeReplacementAt,
    });
    const [originalRowBefore] = await database
      .select()
      .from(groupSources)
      .where(eq(groupSources.id, originalBuilding.id))
      .limit(1);

    const replacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: originalBuilding.id,
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} replacement staff`,
        active: true,
        googleGroupId: `replacement-next-${suffix}`,
        email: `replacement-next-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-first', requestIds),
    });
    expect(replacement.id).not.toBe(originalBuilding.id);

    const after = await latestStaffConfiguration();
    expect(after.id).toBe(before.id);
    expect(after.version).toBe(before.version + 1);
    expect(after.sourceIds).toEqual(
      before.sourceIds
        .filter((sourceId) => sourceId !== originalBuilding.id)
        .concat(replacement.id)
        .sort(),
    );
    const snapshotAfterReplacementAt = new Date();
    await expect(
      database.insert(rosterSnapshots).values({
        id: randomUUID(),
        version: snapshotVersionBeforeReplacement + 1,
        population: 'staff',
        complete: true,
        sourceConfigurationId: before.id,
        sourceConfigurationVersion: before.version,
        syncStartedAt: snapshotAfterReplacementAt,
        capturedAt: snapshotAfterReplacementAt,
      }),
    ).rejects.toThrow();
    await database.insert(rosterSnapshots).values({
      id: randomUUID(),
      version: snapshotVersionBeforeReplacement + 1,
      population: 'staff',
      complete: true,
      sourceConfigurationId: after.id,
      sourceConfigurationVersion: after.version,
      syncStartedAt: snapshotAfterReplacementAt,
      capturedAt: snapshotAfterReplacementAt,
    });
    const historicalGroups = await database
      .select({ sourceId: rosterSourceConfigurationGroups.groupSourceId })
      .from(rosterSourceConfigurationGroups)
      .where(
        and(
          eq(rosterSourceConfigurationGroups.configurationId, before.id),
          eq(
            rosterSourceConfigurationGroups.configurationVersion,
            before.version,
          ),
        ),
      )
      .orderBy(rosterSourceConfigurationGroups.groupSourceId);
    expect(historicalGroups.map(({ sourceId }) => sourceId)).toEqual(
      before.sourceIds,
    );
    const [originalRowAfter] = await database
      .select()
      .from(groupSources)
      .where(eq(groupSources.id, originalBuilding.id))
      .limit(1);
    expect(originalRowAfter).toEqual(originalRowBefore);

    const activeBuildingSources = await executeListGroupSourcesCapability({
      authenticated,
      store,
      query: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        active: true,
        cursor: null,
        limit: 500,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    const inactiveBuildingSources = await executeListGroupSourcesCapability({
      authenticated,
      store,
      query: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        active: false,
        cursor: null,
        limit: 500,
      },
      metadata: { requestId: randomUUID(), now: new Date() },
    });
    expect(activeBuildingSources.items.map(({ id }) => id)).toContain(
      replacement.id,
    );
    expect(activeBuildingSources.items.map(({ id }) => id)).not.toContain(
      originalBuilding.id,
    );
    expect(inactiveBuildingSources.items.map(({ id }) => id)).toContain(
      originalBuilding.id,
    );
    expect(
      inactiveBuildingSources.items.find(({ id }) => id === originalBuilding.id)
        ?.active,
    ).toBe(false);

    try {
      await executeUpdateGroupSourceCapability({
        authenticated,
        store,
        command: {
          id: originalBuilding.id,
          kind: 'google-group',
          purpose: 'building',
          facilityId: facility.id,
          displayName: 'Stale replacement must roll back',
          active: true,
          googleGroupId: `replacement-stale-${suffix}`,
          email: `replacement-stale-${suffix}@example.invalid`,
        },
        metadata: metadata('replacement-stale', requestIds),
      });
      throw new Error('Expected a stale source replacement to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    const [staleRow] = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(eq(groupSources.googleGroupId, `replacement-stale-${suffix}`))
      .limit(1);
    expect(staleRow).toBeUndefined();

    const concurrentCommands = [
      {
        id: replacement.id,
        kind: 'google-group' as const,
        purpose: 'building' as const,
        facilityId: facility.id,
        displayName: 'Concurrent replacement A',
        active: true,
        googleGroupId: `replacement-concurrent-a-${suffix}`,
        email: `replacement-concurrent-a-${suffix}@example.invalid`,
      },
      {
        id: replacement.id,
        kind: 'google-group' as const,
        purpose: 'building' as const,
        facilityId: facility.id,
        displayName: 'Concurrent replacement B',
        active: true,
        googleGroupId: `replacement-concurrent-b-${suffix}`,
        email: `replacement-concurrent-b-${suffix}@example.invalid`,
      },
    ];
    const concurrentResults = await Promise.allSettled(
      concurrentCommands.map((command, index) =>
        executeUpdateGroupSourceCapability({
          authenticated,
          store,
          command,
          metadata: metadata(`replacement-concurrent-${index}`, requestIds),
        }),
      ),
    );
    const fulfilled = concurrentResults.filter(
      (result) => result.status === 'fulfilled',
    );
    const rejected = concurrentResults.filter(
      (result) => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (fulfilled[0]?.status !== 'fulfilled') {
      throw new Error('The concurrent replacement winner is missing.');
    }
    expect(rejected[0]?.reason).toBeInstanceOf(AdminCapabilityError);
    expect((rejected[0]?.reason as AdminCapabilityError).status).toBe(409);
    const winner = fulfilled[0].value;
    const afterConcurrent = await latestStaffConfiguration();
    expect(afterConcurrent.version).toBe(after.version + 1);
    expect(afterConcurrent.sourceIds).toContain(winner.id);
    expect(afterConcurrent.sourceIds).not.toContain(replacement.id);
    const concurrentRows = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        inArray(
          groupSources.googleGroupId,
          concurrentCommands.map(({ googleGroupId }) => googleGroupId),
        ),
      );
    expect(concurrentRows).toEqual([{ id: winner.id }]);

    const othersReplacement = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: originalOthers.id,
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: 'Replacement others next',
        active: true,
        googleGroupId: `replacement-others-next-${suffix}`,
        email: `replacement-others-next-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-others-next', requestIds),
    });
    const afterOthers = await latestStaffConfiguration();
    expect(afterOthers.version).toBe(afterConcurrent.version + 1);
    expect(afterOthers.sourceIds).toContain(othersReplacement.id);
    expect(afterOthers.sourceIds).not.toContain(originalOthers.id);
    expect(afterOthers.sourceIds).toContain(winner.id);
    expect(afterOthers.sourceIds).not.toContain(originalBuilding.id);
    expect(afterOthers.sourceIds).not.toContain(replacement.id);

    const [audienceVersionCountBeforeRace] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(audienceConfigurations)
      .where(eq(audienceConfigurations.id, historicalAudience.id));
    let releaseRosterLock: (() => void) | undefined;
    const rosterLockReleased = new Promise<void>((resolve) => {
      releaseRosterLock = resolve;
    });
    let confirmRosterLock: (() => void) | undefined;
    const rosterLockHeld = new Promise<void>((resolve) => {
      confirmRosterLock = resolve;
    });
    const rosterLockBlocker = database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-roster-staff', 0))`,
      );
      confirmRosterLock?.();
      await rosterLockReleased;
    });
    await rosterLockHeld;

    const racingReplacement = executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: othersReplacement.id,
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: 'Replacement others race winner',
        active: true,
        googleGroupId: `replacement-others-race-${suffix}`,
        email: `replacement-others-race-${suffix}@example.invalid`,
      },
      metadata: metadata('replacement-others-race', requestIds),
    });
    await waitForAdvisoryWaiters(database, 1);
    const racingAudience = executeCreateAudienceConfigVersionCapability({
      authenticated,
      store,
      command: {
        audienceConfigId: historicalAudience.id,
        facilityId: facility.id,
        targets: [
          { kind: 'building', facilityId: facility.id },
          {
            kind: 'others',
            groupSourceRef: {
              id: othersReplacement.id,
              kind: 'google-group',
              purpose: 'others',
              facilityId: null,
            },
          },
        ],
      },
      metadata: metadata('replacement-audience-race', requestIds),
    });
    await waitForAdvisoryWaiters(database, 2);
    releaseRosterLock?.();
    await rosterLockBlocker;

    const [replacementRaceResult, audienceRaceResult] =
      await Promise.allSettled([racingReplacement, racingAudience]);
    expect(replacementRaceResult.status).toBe('fulfilled');
    expect(audienceRaceResult.status).toBe('rejected');
    if (audienceRaceResult.status !== 'rejected') {
      throw new Error('The stale racing audience unexpectedly committed.');
    }
    expect(audienceRaceResult.reason).toBeInstanceOf(AdminCapabilityError);
    expect((audienceRaceResult.reason as AdminCapabilityError).status).toBe(
      409,
    );
    const [audienceVersionCountAfterRace] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(audienceConfigurations)
      .where(eq(audienceConfigurations.id, historicalAudience.id));
    expect(audienceVersionCountAfterRace).toEqual(
      audienceVersionCountBeforeRace,
    );

    expect(
      await executeGetAudienceConfigCapability({
        authenticated,
        store,
        query: { facilityId: facility.id },
        metadata: { requestId: randomUUID(), now: new Date() },
      }),
    ).toEqual(historicalAudience);
    try {
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: historicalAudience.id,
          facilityId: facility.id,
          targets: [
            { kind: 'building', facilityId: facility.id },
            {
              kind: 'others',
              groupSourceRef: {
                id: originalOthers.id,
                kind: 'google-group',
                purpose: 'others',
                facilityId: null,
              },
            },
          ],
        },
        metadata: metadata('replacement-stale-audience', requestIds),
      });
      throw new Error(
        'Expected a superseded others source to be refused in a new audience version.',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
  });
});
