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
import { describeFailure, singleLine } from './failure-diagnostics';

const MAX_STATEMENT_ROWS = 32;
const MAX_DRIVER_FIELD_CHARS = 64;
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

/**
 * The fields of a driver error that carry no caller data.
 *
 * `message`, `detail`, `hint`, and `where` can echo a rejected value, and
 * postgres.js hangs the complete statement text on `query` — which for the role
 * DDL is the application password literal. This is an allowlist for that
 * reason: `PostgresError` copies every field the server sent onto itself, so
 * anything not named here must be assumed to carry a value.
 */
const SAFE_DRIVER_ERROR_FIELDS = Object.freeze([
  'code',
  'severity',
  'routine',
  'schema',
  'table',
  'column',
  'constraint',
] as const);

/**
 * The leading bare keywords of a statement, which say which step failed without
 * quoting it. A literal can never survive the identifier test, so the password
 * in the role DDL cannot reach a log through here.
 */
function describeStatement(statement: string): string {
  const words = statement
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .filter((word) => /^[A-Za-z_]+$/u.test(word));
  return words.length > 0 ? words.join(' ').toUpperCase() : 'UNKNOWN';
}

/** Reduces a driver error to its allowlisted, bounded fields. */
function describeDriverError(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  return SAFE_DRIVER_ERROR_FIELDS.map((field) => {
    const value = Reflect.get(error, field);
    return typeof value === 'string' && value.length > 0
      ? ` ${field}=${singleLine(value, MAX_DRIVER_FIELD_CHARS)}`
      : '';
  }).join('');
}

/** Treats an unserializable result as oversized rather than letting it escape. */
function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createRoleStatementExecutor(
  connection: PostgresDatabaseConnection,
): RoleStatementExecutor {
  return Object.freeze({
    async execute(
      statement: string,
    ): Promise<readonly Readonly<Record<string, unknown>>[]> {
      let result: unknown;
      try {
        result = await connection.db.execute(sql.raw(statement));
      } catch (error) {
        // Naming the step and the SQLSTATE is what separates a missing
        // migration from a revoked grant from an unreachable writer. Collapsing
        // all three into one sentence is why a failed run used to be
        // undiagnosable from its logs alone.
        throw new Error(
          `A native database bootstrap statement failed. statement=${describeStatement(
            statement,
          )}${describeDriverError(error)}`,
        );
      }
      if (
        !Array.isArray(result) ||
        result.length > MAX_STATEMENT_ROWS ||
        result.some(
          (row) =>
            typeof row !== 'object' || row === null || Array.isArray(row),
        ) ||
        serializedByteLength(result) > MAX_STATEMENT_RESULT_BYTES
      ) {
        throw new Error(
          'A native database bootstrap statement returned an unusable result. ' +
            `statement=${describeStatement(statement)}`,
        );
      }
      return Object.freeze(
        result.map((row) =>
          Object.freeze(row as Readonly<Record<string, unknown>>),
        ),
      );
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

export const BOOTSTRAP_FAILURE_PREFIX = 'Database bootstrap failed closed.';

/** Fail-closed diagnostic for the bootstrap entry point. */
export function describeBootstrapFailure(error: unknown): string {
  return describeFailure(BOOTSTRAP_FAILURE_PREFIX, error);
}

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch (error) {
    console.error(describeBootstrapFailure(error));
    process.exitCode = 1;
  }
}
