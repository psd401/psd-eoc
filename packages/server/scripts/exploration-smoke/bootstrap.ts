import { isDeepStrictEqual } from 'node:util';

import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedReferenceData, type ReferenceSeedSummary } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  createDrizzleExplorationAccessFixtureStore,
  seedExplorationAccessFixture,
  type ExplorationAccessFixture,
  type ExplorationAccessFixtureSummary,
} from './access-fixture';
import {
  configureAndVerifyApplicationRole,
  verifyApplicationLogin,
  verifyDatabaseTls,
  type ApplicationRoleVerification,
  type RoleStatementExecutor,
} from './application-role';
import {
  readExplorationBootstrapConfig,
  type ExplorationBootstrapConfig,
} from './config';

const MAX_STATEMENT_ROWS = 32;
const MAX_STATEMENT_RESULT_BYTES = 64 * 1_024;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_lock(178401)';
const ADVISORY_UNLOCK_SQL = 'SELECT pg_advisory_unlock(178401) AS "unlocked"';

export interface CanonicalSyntheticRemovalSummary {
  readonly operationalRows: Readonly<{
    facilities: 0;
    neighborhoodVersions: 0;
    neighborhoodFacilities: 0;
    groupSources: 0;
    audienceConfigurations: 0;
    audienceTargets: 0;
    rosterSourceConfigurations: 0;
    rosterSourceConfigurationFacilities: 0;
    rosterSourceConfigurationGroups: 0;
    rosterSnapshots: 0;
    rosterSnapshotFacilities: 0;
    rosterSnapshotSources: 0;
    rosterRecipients: 0;
    rosterRecipientGroupSources: 0;
    rosterEndpoints: 0;
    total: 0;
  }>;
  readonly retainedTruth: Readonly<{
    facilityAnchors: 2;
    securityAuditEntries: 2;
    idempotencyRecords: 1;
  }>;
}

export interface ExplorationBootstrapDependencies {
  acquireAdvisoryLock(): Promise<void>;
  releaseAdvisoryLock(): Promise<void>;
  verifyAdministratorTls(): Promise<void>;
  migrate(config: ExplorationBootstrapConfig): Promise<void>;
  configureApplicationRole(
    config: ExplorationBootstrapConfig,
  ): Promise<ApplicationRoleVerification>;
  seedReference(
    config: ExplorationBootstrapConfig,
  ): Promise<ReferenceSeedSummary>;
  seedApprovedAccess(
    config: ExplorationBootstrapConfig,
  ): Promise<ExplorationAccessFixtureSummary>;
  verifyCanonicalSyntheticRemoval(
    config: ExplorationBootstrapConfig,
  ): Promise<CanonicalSyntheticRemovalSummary>;
  verifyApplicationLogin(config: ExplorationBootstrapConfig): Promise<void>;
  verifyApplicationTls(): Promise<void>;
}

interface ExplorationBootstrapRunSummary {
  readonly database: Readonly<{
    migrationsApplied: true;
    applicationRole: ApplicationRoleVerification;
  }>;
  readonly referenceSeed: ReferenceSeedSummary;
  readonly approvedAccess: ExplorationAccessFixtureSummary;
  readonly canonicalSyntheticRemoval: CanonicalSyntheticRemovalSummary;
  readonly integrations: Readonly<{
    googleOidc: 'configured-unverified';
    googleGroups: 'mocked';
    messaging: 'disabled';
  }>;
}

export interface ExplorationBootstrapSummary {
  readonly sourceSha: string;
  readonly database: Readonly<{
    transport: 'native-postgres';
    migrationsApplied: true;
    tlsVerified: true;
    applicationRole: ApplicationRoleVerification;
  }>;
  readonly idempotence: Readonly<{
    runs: 2;
    equivalent: true;
  }>;
  readonly referenceSeed: ReferenceSeedSummary;
  readonly approvedAccess: ExplorationAccessFixtureSummary;
  readonly canonicalSyntheticRemoval: CanonicalSyntheticRemovalSummary;
  readonly integrations: ExplorationBootstrapRunSummary['integrations'];
}

async function runOneBootstrap(
  config: ExplorationBootstrapConfig,
  dependencies: ExplorationBootstrapDependencies,
): Promise<ExplorationBootstrapRunSummary> {
  await dependencies.verifyAdministratorTls();
  await dependencies.migrate(config);
  const applicationRole = await dependencies.configureApplicationRole(config);
  const referenceSeed = await dependencies.seedReference(config);
  const approvedAccess = await dependencies.seedApprovedAccess(config);
  const canonicalSyntheticRemoval =
    await dependencies.verifyCanonicalSyntheticRemoval(config);
  await dependencies.verifyApplicationLogin(config);
  await dependencies.verifyApplicationTls();

  return Object.freeze({
    database: Object.freeze({
      migrationsApplied: true as const,
      applicationRole,
    }),
    referenceSeed,
    approvedAccess,
    canonicalSyntheticRemoval,
    integrations: Object.freeze({
      googleOidc: 'configured-unverified' as const,
      googleGroups: 'mocked' as const,
      messaging: 'disabled' as const,
    }),
  });
}

/**
 * Runs the complete native bootstrap twice under one PostgreSQL advisory lock.
 * Equality of the bounded summaries proves the migration and fixtures are
 * idempotent before App Runner can be updated to the candidate image.
 */
export async function runExplorationBootstrap(
  config: ExplorationBootstrapConfig,
  dependencies: ExplorationBootstrapDependencies,
): Promise<ExplorationBootstrapSummary> {
  await dependencies.acquireAdvisoryLock();
  try {
    const first = await runOneBootstrap(config, dependencies);
    const second = await runOneBootstrap(config, dependencies);
    if (!isDeepStrictEqual(first, second)) {
      throw new Error('The native bootstrap was not idempotent.');
    }

    return Object.freeze({
      sourceSha: config.sourceSha,
      database: Object.freeze({
        transport: 'native-postgres' as const,
        migrationsApplied: true as const,
        tlsVerified: true as const,
        applicationRole: second.database.applicationRole,
      }),
      idempotence: Object.freeze({
        runs: 2 as const,
        equivalent: true as const,
      }),
      referenceSeed: second.referenceSeed,
      approvedAccess: second.approvedAccess,
      canonicalSyntheticRemoval: second.canonicalSyntheticRemoval,
      integrations: second.integrations,
    });
  } finally {
    await dependencies.releaseAdvisoryLock();
  }
}

function createNativeConnection(
  config: ExplorationBootstrapConfig,
  username: string,
  password: string,
): PostgresDatabaseConnection {
  const connection = createDatabaseClient({
    driver: 'postgres',
    host: config.databaseHost,
    port: config.databasePort,
    database: config.databaseName,
    username,
    password,
    sslRootCertificatePath: config.databaseSslRootCertificate,
    maxConnections: config.databaseMaxConnections,
    connectTimeoutSeconds: config.databaseConnectTimeoutSeconds,
    idleTimeoutSeconds: config.databaseIdleTimeoutSeconds,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Exploration bootstrap requires native PostgreSQL.');
  }
  return connection;
}

function createRoleStatementExecutor(
  connection: PostgresDatabaseConnection,
): RoleStatementExecutor {
  return Object.freeze({
    async execute(
      statement: string,
    ): Promise<readonly Readonly<Record<string, unknown>>[]> {
      try {
        const result = await connection.db.execute(sql.raw(statement));
        if (
          !Array.isArray(result) ||
          result.length > MAX_STATEMENT_ROWS ||
          result.some(
            (row) =>
              typeof row !== 'object' || row === null || Array.isArray(row),
          ) ||
          Buffer.byteLength(JSON.stringify(result), 'utf8') >
            MAX_STATEMENT_RESULT_BYTES
        ) {
          throw new Error('invalid result');
        }
        return Object.freeze(
          result.map((row) =>
            Object.freeze(row as Readonly<Record<string, unknown>>),
          ),
        );
      } catch {
        throw new Error('A native database bootstrap statement failed.');
      }
    },
  });
}

const CANONICAL_SYNTHETIC_REMOVAL_SQL = `
select
  (select count(*)::integer from facilities where id in (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002'
  ) or code in ('SYN-NORTH', 'SYN-SOUTH')) as "facilities",
  (select count(*)::integer from neighborhood_versions where
    id = '00000000-0000-4000-8000-000000000010'
    or name = 'Synthetic Twin Campuses') as "neighborhoodVersions",
  (select count(*)::integer from neighborhood_facilities where
    neighborhood_id = '00000000-0000-4000-8000-000000000010'
    or facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )) as "neighborhoodFacilities",
  (select count(*)::integer from group_sources where
    id in (
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032'
    ) or facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    ) or fixture_key in (
      'synthetic-north-staff', 'synthetic-south-staff',
      'synthetic-district-support-staff'
    )) as "groupSources",
  (select count(*)::integer from audience_configurations where
    id in (
      '00000000-0000-4000-8000-000000000020',
      '00000000-0000-4000-8000-000000000021'
    ) or facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )) as "audienceConfigurations",
  (select count(*)::integer from audience_targets where
    audience_config_id in (
      '00000000-0000-4000-8000-000000000020',
      '00000000-0000-4000-8000-000000000021'
    ) or target_facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    ) or neighborhood_id = '00000000-0000-4000-8000-000000000010'
    or group_source_id in (
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032'
    )) as "audienceTargets",
  (select count(*)::integer from roster_source_configurations where
    id = '00000000-0000-4000-8000-000000000040')
    as "rosterSourceConfigurations",
  (select count(*)::integer from roster_source_configuration_facilities where
    configuration_id = '00000000-0000-4000-8000-000000000040'
    or facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )) as "rosterSourceConfigurationFacilities",
  (select count(*)::integer from roster_source_configuration_groups where
    configuration_id = '00000000-0000-4000-8000-000000000040'
    or group_source_id in (
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032'
    )) as "rosterSourceConfigurationGroups",
  (select count(*)::integer from roster_snapshots where
    id = '00000000-0000-4000-8000-000000000041'
    or source_configuration_id = '00000000-0000-4000-8000-000000000040')
    as "rosterSnapshots",
  (select count(*)::integer from roster_snapshot_facilities where
    roster_snapshot_id = '00000000-0000-4000-8000-000000000041'
    or facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )) as "rosterSnapshotFacilities",
  (select count(*)::integer from roster_snapshot_sources where
    roster_snapshot_id = '00000000-0000-4000-8000-000000000041'
    or group_source_id in (
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032'
    )) as "rosterSnapshotSources",
  (select count(*)::integer from roster_recipients where
    roster_snapshot_id = '00000000-0000-4000-8000-000000000041'
    or id in (
      '00000000-0000-4000-8000-000000000050',
      '00000000-0000-4000-8000-000000000051',
      '00000000-0000-4000-8000-000000000052',
      '00000000-0000-4000-8000-000000000053'
    )) as "rosterRecipients",
  (select count(*)::integer from roster_recipient_group_sources where
    roster_snapshot_id = '00000000-0000-4000-8000-000000000041'
    or recipient_id in (
      '00000000-0000-4000-8000-000000000050',
      '00000000-0000-4000-8000-000000000051',
      '00000000-0000-4000-8000-000000000052',
      '00000000-0000-4000-8000-000000000053'
    ) or group_source_id in (
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032'
    )) as "rosterRecipientGroupSources",
  (select count(*)::integer from roster_endpoints where
    roster_snapshot_id = '00000000-0000-4000-8000-000000000041'
    or recipient_id in (
      '00000000-0000-4000-8000-000000000050',
      '00000000-0000-4000-8000-000000000051',
      '00000000-0000-4000-8000-000000000052',
      '00000000-0000-4000-8000-000000000053'
    ) or id in (
      '00000000-0000-4000-8000-000000000060',
      '00000000-0000-4000-8000-000000000061',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000063',
      '00000000-0000-4000-8000-000000000064',
      '00000000-0000-4000-8000-000000000065',
      '00000000-0000-4000-8000-000000000066',
      '00000000-0000-4000-8000-000000000067',
      '00000000-0000-4000-8000-000000000068',
      '00000000-0000-4000-8000-000000000069',
      '00000000-0000-4000-8000-000000000070',
      '00000000-0000-4000-8000-000000000071'
    )) as "rosterEndpoints",
  (select count(*)::integer from security_audit_facility_anchors where
    facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )) as "facilityAnchors",
  (select count(*)::integer from security_audit_entries where
    facility_id in (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )) as "securityAuditEntries",
  (select count(*)::integer from security_audit_entries where
    (sequence = 56
      and facility_id = '00000000-0000-4000-8000-000000000001'
      and entry_hash = '8e7cd227e4b9b725834acdb718866e0156b47fbdd6184136c83eec7f4077b2da')
    or (sequence = 58
      and facility_id = '00000000-0000-4000-8000-000000000002'
      and entry_hash = '8e91c4c142960f5149d6a5375c4dc7d1546d7fd94fa4325dc2535b2fab4393ff'))
    as "reviewedSecurityAuditEntries",
  (select count(*)::integer from idempotency_records where
    id = '81ec2daa-83e7-4ded-a914-b72bdda54e8e'
    and capability_id = 'update-facility'
    and status = 'completed') as "idempotencyRecords"
`;

const OPERATIONAL_REMOVAL_KEYS = [
  'facilities',
  'neighborhoodVersions',
  'neighborhoodFacilities',
  'groupSources',
  'audienceConfigurations',
  'audienceTargets',
  'rosterSourceConfigurations',
  'rosterSourceConfigurationFacilities',
  'rosterSourceConfigurationGroups',
  'rosterSnapshots',
  'rosterSnapshotFacilities',
  'rosterSnapshotSources',
  'rosterRecipients',
  'rosterRecipientGroupSources',
  'rosterEndpoints',
] as const;

/** Fails closed unless the exact canonical fixture is absent after bootstrap. */
export async function verifyCanonicalSyntheticRemoval(input: {
  readonly executor: RoleStatementExecutor;
}): Promise<CanonicalSyntheticRemovalSummary> {
  const rows = await input.executor.execute(CANONICAL_SYNTHETIC_REMOVAL_SQL);
  if (rows.length !== 1) {
    throw new Error('Canonical synthetic removal readback failed.');
  }
  const row = rows[0];
  if (
    row === undefined ||
    OPERATIONAL_REMOVAL_KEYS.some((key) => row[key] !== 0) ||
    row.facilityAnchors !== 2 ||
    row.securityAuditEntries !== 2 ||
    row.reviewedSecurityAuditEntries !== 2 ||
    row.idempotencyRecords !== 1
  ) {
    throw new Error('Canonical synthetic removal readback failed.');
  }

  return Object.freeze({
    operationalRows: Object.freeze({
      facilities: 0 as const,
      neighborhoodVersions: 0 as const,
      neighborhoodFacilities: 0 as const,
      groupSources: 0 as const,
      audienceConfigurations: 0 as const,
      audienceTargets: 0 as const,
      rosterSourceConfigurations: 0 as const,
      rosterSourceConfigurationFacilities: 0 as const,
      rosterSourceConfigurationGroups: 0 as const,
      rosterSnapshots: 0 as const,
      rosterSnapshotFacilities: 0 as const,
      rosterSnapshotSources: 0 as const,
      rosterRecipients: 0 as const,
      rosterRecipientGroupSources: 0 as const,
      rosterEndpoints: 0 as const,
      total: 0 as const,
    }),
    retainedTruth: Object.freeze({
      facilityAnchors: 2 as const,
      securityAuditEntries: 2 as const,
      idempotencyRecords: 1 as const,
    }),
  });
}

async function runFromCommandLine(): Promise<void> {
  const config = readExplorationBootstrapConfig();
  const administratorConnection = createNativeConnection(
    config,
    config.databaseAdminUsername,
    config.databaseAdminPassword,
  );
  const applicationConnection = createNativeConnection(
    config,
    config.databaseApplicationUsername,
    config.databaseApplicationPassword,
  );
  const administratorExecutor = createRoleStatementExecutor(
    administratorConnection,
  );
  const applicationExecutor = createRoleStatementExecutor(
    applicationConnection,
  );
  const accessStore = createDrizzleExplorationAccessFixtureStore(
    administratorConnection.db,
  );
  const approvedIdentity = Object.freeze({
    googleSubject: config.approvedGoogleSubject,
    staffEmail: config.approvedStaffEmail,
    staffDisplayName: config.approvedStaffDisplayName,
  });
  let accessFixture: ExplorationAccessFixture | null = null;

  try {
    const summary = await runExplorationBootstrap(config, {
      async acquireAdvisoryLock(): Promise<void> {
        await administratorExecutor.execute(ADVISORY_LOCK_SQL);
      },
      async releaseAdvisoryLock(): Promise<void> {
        const rows = await administratorExecutor.execute(ADVISORY_UNLOCK_SQL);
        if (rows.length !== 1 || rows[0]?.unlocked !== true) {
          throw new Error('The native bootstrap advisory lock was not held.');
        }
      },
      async verifyAdministratorTls(): Promise<void> {
        await verifyDatabaseTls({ executor: administratorExecutor });
      },
      async migrate(): Promise<void> {
        await migrateDatabase(administratorConnection);
      },
      async configureApplicationRole() {
        return configureAndVerifyApplicationRole({
          executor: administratorExecutor,
          password: config.databaseApplicationPassword,
        });
      },
      async seedReference() {
        return seedReferenceData(administratorConnection.db);
      },
      async seedApprovedAccess() {
        const seeded = await seedExplorationAccessFixture({
          identity: approvedIdentity,
          replay: accessFixture,
          store: accessStore,
        });
        accessFixture = seeded.fixture;
        return seeded.summary;
      },
      async verifyCanonicalSyntheticRemoval() {
        return verifyCanonicalSyntheticRemoval({
          executor: administratorExecutor,
        });
      },
      async verifyApplicationLogin(): Promise<void> {
        await verifyApplicationLogin({ executor: applicationExecutor });
      },
      async verifyApplicationTls(): Promise<void> {
        await verifyDatabaseTls({ executor: applicationExecutor });
      },
    });
    console.info(JSON.stringify(summary));
  } finally {
    await Promise.all([
      applicationConnection.close(),
      administratorConnection.close(),
    ]);
  }
}

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch {
    console.error('Exploration-smoke native database bootstrap failed closed.');
    process.exitCode = 1;
  }
}
