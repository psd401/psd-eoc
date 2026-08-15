import {
  ExecuteStatementCommand,
  RDSDataClient,
  type ExecuteStatementCommandOutput,
} from '@aws-sdk/client-rds-data';

import { createDatabaseClient } from '../../db/client';
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
  type ApplicationRoleVerification,
  type RoleStatementExecutor,
} from './application-role';
import {
  getApplicationDatabaseSecret,
  type ApplicationDatabaseSecret,
  type TemporaryAwsCredentials,
} from './application-secret';
import {
  readExplorationBootstrapConfig,
  type ExplorationBootstrapConfig,
} from './config';

const MAX_FORMATTED_RECORDS_BYTES = 64 * 1_024;

export interface ExplorationBootstrapDependencies {
  readApplicationSecret(
    config: ExplorationBootstrapConfig,
  ): Promise<ApplicationDatabaseSecret>;
  migrate(config: ExplorationBootstrapConfig): Promise<void>;
  configureApplicationRole(
    config: ExplorationBootstrapConfig,
    password: string,
  ): Promise<ApplicationRoleVerification>;
  seedSynthetic(config: ExplorationBootstrapConfig): Promise<SeedSummary>;
  seedApprovedAccess(
    config: ExplorationBootstrapConfig,
  ): Promise<ExplorationAccessFixtureSummary>;
  verifyApplicationLogin(config: ExplorationBootstrapConfig): Promise<void>;
}

export interface ExplorationBootstrapSummary {
  readonly sourceSha: string;
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

/** Ordered bootstrap coordinator with injectable, test-only effect seams. */
export async function runExplorationBootstrap(
  config: ExplorationBootstrapConfig,
  dependencies: ExplorationBootstrapDependencies,
): Promise<ExplorationBootstrapSummary> {
  const applicationSecret = await dependencies.readApplicationSecret(config);
  await dependencies.migrate(config);
  const applicationRole = await dependencies.configureApplicationRole(
    config,
    applicationSecret.password,
  );
  const syntheticSeed = await dependencies.seedSynthetic(config);
  const approvedAccess = await dependencies.seedApprovedAccess(config);
  await dependencies.verifyApplicationLogin(config);

  return Object.freeze({
    sourceSha: config.sourceSha,
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

function formattedRows(
  output: ExecuteStatementCommandOutput,
): readonly Readonly<Record<string, unknown>>[] {
  if (output.formattedRecords === undefined) return Object.freeze([]);
  if (
    Buffer.byteLength(output.formattedRecords, 'utf8') >
    MAX_FORMATTED_RECORDS_BYTES
  ) {
    throw new Error('The database verification response was too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.formattedRecords) as unknown;
  } catch {
    throw new Error('The database verification response was invalid.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (row) => typeof row !== 'object' || row === null || Array.isArray(row),
    )
  ) {
    throw new Error('The database verification response was invalid.');
  }
  return Object.freeze(
    parsed.map((row) => Object.freeze(row as Record<string, unknown>)),
  );
}

function temporaryCredentials(
  value: Awaited<ReturnType<RDSDataClient['config']['credentials']>>,
): TemporaryAwsCredentials {
  if (value.sessionToken === undefined) {
    throw new Error('Bootstrap requires temporary AWS credentials.');
  }
  return Object.freeze({
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    sessionToken: value.sessionToken,
    ...(value.expiration === undefined ? {} : { expiration: value.expiration }),
  });
}

function createRoleStatementExecutor(
  client: RDSDataClient,
  config: ExplorationBootstrapConfig,
): RoleStatementExecutor {
  return Object.freeze({
    async execute(
      secretArn: string,
      sql: string,
    ): Promise<readonly Readonly<Record<string, unknown>>[]> {
      try {
        return formattedRows(
          await client.send(
            new ExecuteStatementCommand({
              continueAfterTimeout: false,
              database: config.databaseName,
              formatRecordsAs: 'JSON',
              includeResultMetadata: false,
              resourceArn: config.databaseResourceArn,
              secretArn,
              sql,
            }),
          ),
        );
      } catch {
        throw new Error('A database bootstrap statement failed.');
      }
    },
  });
}

async function runFromCommandLine(): Promise<void> {
  const config = readExplorationBootstrapConfig();
  const adminConnection = createDatabaseClient({
    driver: 'aws-data-api',
    region: config.region,
    database: config.databaseName,
    resourceArn: config.databaseResourceArn,
    secretArn: config.databaseAdminSecretArn,
  });
  if (adminConnection.driver !== 'aws-data-api') {
    throw new Error('Exploration bootstrap requires the AWS Data API.');
  }
  const dataApi = new RDSDataClient({ maxAttempts: 3, region: config.region });
  const roleExecutor = createRoleStatementExecutor(dataApi, config);
  const accessStore = createDrizzleExplorationAccessFixtureStore(
    adminConnection.db,
  );
  const fixture = createExplorationAccessFixture({
    googleSubject: config.approvedGoogleSubject,
    staffEmail: config.approvedStaffEmail,
    staffDisplayName: config.approvedStaffDisplayName,
  });

  try {
    const summary = await runExplorationBootstrap(config, {
      async readApplicationSecret(): Promise<ApplicationDatabaseSecret> {
        return getApplicationDatabaseSecret({
          credentials: temporaryCredentials(await dataApi.config.credentials()),
          region: config.region,
          secretArn: config.databaseApplicationSecretArn,
        });
      },
      async migrate(): Promise<void> {
        await migrateDatabase(adminConnection);
      },
      async configureApplicationRole(_config, password) {
        return configureAndVerifyApplicationRole({
          administratorSecretArn: config.databaseAdminSecretArn,
          executor: roleExecutor,
          password,
        });
      },
      async seedSynthetic() {
        return seedDatabase(adminConnection.db);
      },
      async seedApprovedAccess() {
        return seedExplorationAccessFixture({ fixture, store: accessStore });
      },
      async verifyApplicationLogin(): Promise<void> {
        await verifyApplicationLogin({
          applicationSecretArn: config.databaseApplicationSecretArn,
          executor: roleExecutor,
        });
      },
    });
    console.info(JSON.stringify(summary));
  } finally {
    dataApi.destroy();
    await adminConnection.close();
  }
}

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch {
    console.error('Exploration-smoke database bootstrap failed closed.');
    process.exitCode = 1;
  }
}
