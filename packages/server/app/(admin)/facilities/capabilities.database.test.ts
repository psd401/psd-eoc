import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  securityAuditEntries,
  userRoles,
  users,
} from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { requireSyntheticTestDatabaseUrl } from '../event-types/test-database';
import {
  executeListUsersCapability,
  executeSetUserRolesCapability,
} from '../access/capabilities';
import { executeSetChannelEnabledCapability } from '../integrations/capabilities';
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
  executeUpdateFacilityCapability,
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

describeWithDatabase('facilities administrator database flow', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 3,
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
    await executeCreateGroupSourceCapability({
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
    const roleResult = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: roleTargetId, roles: ['staff', 'admin'] },
      metadata: metadata('role-assignment', requestIds),
    });
    expect(roleResult.roles).toEqual(['staff', 'admin']);
    const roleRemovalRequestId = randomUUID();
    try {
      await executeSetUserRolesCapability({
        authenticated,
        store,
        command: { userId: roleTargetId, roles: ['staff'] },
        metadata: {
          idempotencyKey: `issue-26-role-removal-${randomUUID()}`,
          requestId: roleRemovalRequestId,
          now: new Date(),
        },
      });
      throw new Error('Expected retained role removal to fail closed.');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminCapabilityError);
      expect((error as AdminCapabilityError).status).toBe(409);
    }
    const [roleRemovalAudit] = await database
      .select({
        action: securityAuditEntries.action,
        outcome: securityAuditEntries.outcome,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, roleRemovalRequestId))
      .limit(1);
    expect(roleRemovalAudit).toEqual({
      action: 'set-user-roles',
      outcome: 'failure',
    });

    const channelResult = await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: 'expo-push',
        enabled: false,
        productOwnerApprovalReference: 'issue-26-synthetic-approval',
      },
      metadata: metadata('channel-state', requestIds),
    });
    expect(channelResult).toMatchObject({
      integrationId: 'expo-push',
      enabled: false,
      status: { label: 'mocked' },
    });

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
});
