import { isDeepStrictEqual } from 'node:util';

import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedDatabase, type SeedSummary } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  createDrizzleExplorationAccessFixtureStore,
  createExplorationAccessFixture,
  seedExplorationAccessFixture,
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

export interface ExplorationBootstrapDependencies {
  acquireAdvisoryLock(): Promise<void>;
  releaseAdvisoryLock(): Promise<void>;
  verifyAdministratorTls(): Promise<void>;
  migrate(config: ExplorationBootstrapConfig): Promise<void>;
  configureApplicationRole(
    config: ExplorationBootstrapConfig,
  ): Promise<ApplicationRoleVerification>;
  seedSynthetic(config: ExplorationBootstrapConfig): Promise<SeedSummary>;
  seedApprovedAccess(
    config: ExplorationBootstrapConfig,
  ): Promise<ExplorationAccessFixtureSummary>;
  verifyApplicationLogin(config: ExplorationBootstrapConfig): Promise<void>;
  verifyApplicationTls(): Promise<void>;
}

interface ExplorationBootstrapRunSummary {
  readonly database: Readonly<{
    migrationsApplied: true;
    applicationRole: ApplicationRoleVerification;
  }>;
  readonly syntheticSeed: SeedSummary;
  readonly approvedAccess: ExplorationAccessFixtureSummary;
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
  readonly syntheticSeed: SeedSummary;
  readonly approvedAccess: ExplorationAccessFixtureSummary;
  readonly integrations: ExplorationBootstrapRunSummary['integrations'];
}

async function runOneBootstrap(
  config: ExplorationBootstrapConfig,
  dependencies: ExplorationBootstrapDependencies,
): Promise<ExplorationBootstrapRunSummary> {
  await dependencies.verifyAdministratorTls();
  await dependencies.migrate(config);
  const applicationRole = await dependencies.configureApplicationRole(config);
  const syntheticSeed = await dependencies.seedSynthetic(config);
  const approvedAccess = await dependencies.seedApprovedAccess(config);
  await dependencies.verifyApplicationLogin(config);
  await dependencies.verifyApplicationTls();

  return Object.freeze({
    database: Object.freeze({
      migrationsApplied: true as const,
      applicationRole,
    }),
    syntheticSeed,
    approvedAccess,
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
      syntheticSeed: second.syntheticSeed,
      approvedAccess: second.approvedAccess,
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
  const fixture = createExplorationAccessFixture({
    googleSubject: config.approvedGoogleSubject,
    staffEmail: config.approvedStaffEmail,
    staffDisplayName: config.approvedStaffDisplayName,
  });

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
      async seedSynthetic() {
        return seedDatabase(administratorConnection.db);
      },
      async seedApprovedAccess() {
        return seedExplorationAccessFixture({ fixture, store: accessStore });
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
