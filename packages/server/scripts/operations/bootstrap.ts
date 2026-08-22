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
  bootstrapFacilities,
  bootstrapNeighborhoods,
  describeFacilityOutcome,
  describeNeighborhoodOutcome,
} from '../../db/bootstrap-facilities';
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
import {
  describeFailure,
  describeQueryFailure,
  withReducedDriverErrors,
} from './failure-diagnostics';

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
  /** Creates the district's configured facilities and neighborhoods. */
  bootstrapDistrict(config: BootstrapConfig): Promise<DistrictBootstrapOutcome>;
  verifyApplicationLogin(config: BootstrapConfig): Promise<void>;
  verifyApplicationTls(): Promise<void>;
}

/**
 * What the district-configuration step found and what it had to create.
 *
 * The counts are split deliberately: `configured` is what the deployment
 * declares and is identical on every run, while `created` is what a given run
 * actually had to write and is necessarily zero once the rows exist. The
 * idempotence check relies on that distinction.
 */
export interface DistrictBootstrapOutcome {
  readonly facilitiesConfigured: number;
  readonly facilitiesCreated: number;
  readonly neighborhoodsConfigured: number;
  readonly neighborhoodsCreated: number;
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
  /** What the district's facilities and neighborhoods needed. */
  readonly district: DistrictBootstrapOutcome;
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
  /** What the district's facilities and neighborhoods needed. */
  readonly district: DistrictBootstrapOutcome;
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

  // The district's own schools and campuses. Like the access group, these were
  // only ever creatable through the admin UI, so a rebuilt deployment came up
  // with none. Matched on the district's own codes, so re-running creates
  // nothing and never disturbs an edit somebody made in the app.
  const district = await dependencies.bootstrapDistrict(config);

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
    district,
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

    // Idempotence is "the second run changed nothing", not "both runs said the
    // same thing". Those are different claims, and the second one is false for
    // any deployment that has something to create: a first run reports
    // accessBootstrap 'created' and a facility count, the run after it reports
    // 'already-configured' and zero, and a deep equality over the whole
    // summary therefore fails on exactly the fresh database this bootstrap
    // exists to stand up. It did, on 2026-08-21, with the failure surfacing
    // only as a non-zero exit.
    //
    // So the convergent fields are compared, and the creating fields are
    // asserted to be no-ops on the second run — which is the stronger check.
    const convergent = (run: BootstrapRunSummary) =>
      Object.freeze({
        mode: run.mode,
        database: run.database,
        referenceSeed: run.referenceSeed,
        integrations: run.integrations,
      });
    if (!isDeepStrictEqual(convergent(first), convergent(second))) {
      throw new Error('The native bootstrap was not idempotent.');
    }
    if (second.accessBootstrap === 'created') {
      throw new Error(
        'The native bootstrap created an access group twice; it is not idempotent.',
      );
    }
    if (
      second.district.facilitiesCreated !== 0 ||
      second.district.neighborhoodsCreated !== 0
    ) {
      throw new Error(
        'The native bootstrap created district configuration twice; it is not idempotent.',
      );
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
      accessBootstrap: first.accessBootstrap,
      district: first.district,
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
          )}${describeQueryFailure(error)}`,
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

/**
 * Wires the bootstrap steps to two live connections.
 *
 * Exported so each step's failure handling can be exercised without a database.
 * The steps that issue SQL outside the statement executor have to reduce a
 * driver error where it is raised, and only a test that drives these proves the
 * wiring rather than the reducer in isolation.
 */
export function createBootstrapDependencies(
  config: BootstrapConfig,
  administratorConnection: PostgresDatabaseConnection,
  applicationConnection: PostgresDatabaseConnection,
): BootstrapDependencies {
  const administratorExecutor = createRoleStatementExecutor(
    administratorConnection,
  );
  const applicationExecutor = createRoleStatementExecutor(
    applicationConnection,
  );
  return Object.freeze({
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
      await withReducedDriverErrors('migration', () =>
        migrateDatabase(administratorConnection),
      );
    },
    async configureApplicationRole() {
      return configureAndVerifyApplicationRole({
        executor: administratorExecutor,
        password: config.databaseApplicationPassword,
      });
    },
    async seedReference() {
      return withReducedDriverErrors('reference seed', () =>
        seedReferenceData(administratorConnection.db),
      );
    },
    async bootstrapAccess() {
      const outcome = await withReducedDriverErrors('access bootstrap', () =>
        bootstrapAccessConfiguration(administratorConnection.db),
      );
      console.info(describeBootstrapOutcome(outcome));
      return outcome;
    },
    async bootstrapDistrict(): Promise<DistrictBootstrapOutcome> {
      // Facilities before neighborhoods: a campus names its schools by the
      // district's own codes and is refused if one of them is not there yet.
      //
      // Both go through the drizzle handle rather than the executor, so they
      // are a driver-error bypass path and need the same wrapper the steps
      // above use — without it a failure logs the statement text and its bound
      // parameters, which here are facility codes and campus names.
      const facilities = await withReducedDriverErrors(
        'facility bootstrap',
        () => bootstrapFacilities(administratorConnection.db),
      );
      console.info(describeFacilityOutcome(facilities));
      const neighborhoods = await withReducedDriverErrors(
        'neighborhood bootstrap',
        () => bootstrapNeighborhoods(administratorConnection.db),
      );
      console.info(describeNeighborhoodOutcome(neighborhoods));
      return Object.freeze({
        facilitiesConfigured: facilities.configured,
        facilitiesCreated: facilities.created.length,
        neighborhoodsConfigured: neighborhoods.configured,
        neighborhoodsCreated: neighborhoods.created.length,
      });
    },
    async verifyApplicationLogin(): Promise<void> {
      await verifyApplicationLogin({ executor: applicationExecutor });
    },
    async verifyApplicationTls(): Promise<void> {
      await verifyDatabaseTls({ executor: applicationExecutor });
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
  try {
    const summary = await runBootstrap(
      config,
      createBootstrapDependencies(
        config,
        administratorConnection,
        applicationConnection,
      ),
    );
    console.info(JSON.stringify(summary));
  } finally {
    await Promise.all([
      applicationConnection.close(),
      administratorConnection.close(),
    ]);
  }
}

const BOOTSTRAP_FAILURE_PREFIX = 'Database bootstrap failed closed.';

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch (error) {
    console.error(describeFailure(BOOTSTRAP_FAILURE_PREFIX, error));
    process.exitCode = 1;
  }
}
