import { isDeepStrictEqual } from 'node:util';

import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { seedReferenceData, type ReferenceSeedSummary } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  bootstrapAccessConfiguration,
  describeBootstrapOutcome,
  type BootstrapAccessOutcome,
} from '../../db/bootstrap-access';
import {
  configureAndVerifyApplicationRole,
  verifyApplicationLogin,
  verifyDatabaseTls,
  type ApplicationRoleVerification,
  type RoleStatementExecutor,
} from './application-role';
import {
  readBootstrapConfig,
  type BootstrapConfig,
  type BootstrapMode,
} from './config';

const MAX_STATEMENT_ROWS = 32;
const MAX_STATEMENT_RESULT_BYTES = 64 * 1_024;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_lock(178401)';
const ADVISORY_UNLOCK_SQL = 'SELECT pg_advisory_unlock(178401) AS "unlocked"';

export interface BootstrapDependencies {
  acquireAdvisoryLock(): Promise<void>;
  releaseAdvisoryLock(): Promise<void>;
  verifyAdministratorTls(): Promise<void>;
  migrate(config: BootstrapConfig): Promise<void>;
  configureApplicationRole(
    config: BootstrapConfig,
  ): Promise<ApplicationRoleVerification>;
  seedReference(config: BootstrapConfig): Promise<ReferenceSeedSummary>;
  /** Creates the configured first trusted group when a deployment has none. */
  bootstrapAccess(config: BootstrapConfig): Promise<BootstrapAccessOutcome>;
  verifyApplicationLogin(config: BootstrapConfig): Promise<void>;
  verifyApplicationTls(): Promise<void>;
}

interface BootstrapRunSummary {
  readonly mode: BootstrapMode;
  readonly database: Readonly<{
    migrationsApplied: true;
    applicationRole: ApplicationRoleVerification;
  }>;
  readonly referenceSeed: ReferenceSeedSummary;
  /** What the initial-group configuration did, or did not, need to do. */
  readonly accessBootstrap: BootstrapAccessOutcome['kind'];
  readonly integrations: Readonly<{
    googleOidc: 'configured-unverified';
    googleGroups: 'mocked';
    messaging: 'disabled';
  }>;
}

export interface BootstrapSummary {
  readonly sourceSha: string;
  readonly mode: BootstrapMode;
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
  /** What the initial-group configuration did, or did not, need to do. */
  readonly accessBootstrap: BootstrapAccessOutcome['kind'];
  readonly integrations: BootstrapRunSummary['integrations'];
}

/**
 * The steps every mode runs. None of them write anything that decides who may
 * sign in, so a deploy can run this against a live stack without disturbing
 * the access-membership snapshot the access sync publishes.
 */
async function runSharedBootstrapSteps(
  config: BootstrapConfig,
  dependencies: BootstrapDependencies,
): Promise<
  Readonly<{
    applicationRole: ApplicationRoleVerification;
    referenceSeed: ReferenceSeedSummary;
  }>
> {
  await dependencies.verifyAdministratorTls();
  await dependencies.migrate(config);
  const applicationRole = await dependencies.configureApplicationRole(config);
  const referenceSeed = await dependencies.seedReference(config);
  return Object.freeze({ applicationRole, referenceSeed });
}

async function runOneBootstrap(
  config: BootstrapConfig,
  dependencies: BootstrapDependencies,
): Promise<BootstrapRunSummary> {
  const { applicationRole, referenceSeed } = await runSharedBootstrapSteps(
    config,
    dependencies,
  );

  // Safe on every deploy: it acts only when no access group exists at all, so
  // it can create the first one for a district standing this up and can never
  // touch a configuration that already decides who signs in. What it replaced
  // published a snapshot covering one synthetic group, superseding the real
  // one, and locked every administrator out of this stack on 2026-08-18.
  const accessBootstrap = (await dependencies.bootstrapAccess(config)).kind;

  await dependencies.verifyApplicationLogin(config);
  await dependencies.verifyApplicationTls();

  return Object.freeze({
    mode: config.mode,
    database: Object.freeze({
      migrationsApplied: true as const,
      applicationRole,
    }),
    referenceSeed,
    accessBootstrap,
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
export async function runBootstrap(
  config: BootstrapConfig,
  dependencies: BootstrapDependencies,
): Promise<BootstrapSummary> {
  await dependencies.acquireAdvisoryLock();
  try {
    const first = await runOneBootstrap(config, dependencies);
    const second = await runOneBootstrap(config, dependencies);
    if (!isDeepStrictEqual(first, second)) {
      throw new Error('The native bootstrap was not idempotent.');
    }

    return Object.freeze({
      sourceSha: config.sourceSha,
      mode: second.mode,
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
      accessBootstrap: second.accessBootstrap,
      integrations: second.integrations,
    });
  } finally {
    await dependencies.releaseAdvisoryLock();
  }
}

function createNativeConnection(
  config: BootstrapConfig,
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

/** Fails closed unless the exact canonical fixture is absent after bootstrap. */
async function runFromCommandLine(): Promise<void> {
  const config = readBootstrapConfig();
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
  try {
    const summary = await runBootstrap(config, {
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
      async bootstrapAccess() {
        const outcome = await bootstrapAccessConfiguration(
          administratorConnection.db,
        );
        console.info(describeBootstrapOutcome(outcome));
        return outcome;
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
    console.error('Database bootstrap failed closed.');
    process.exitCode = 1;
  }
}
