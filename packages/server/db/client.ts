import { readFileSync } from 'node:fs';

import { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  drizzle as drizzleAwsDataApi,
  type AwsDataApiPgDatabase,
} from 'drizzle-orm/aws-data-api/pg';
import {
  drizzle as drizzlePostgres,
  type PostgresJsDatabase,
} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';

import * as relations from './relations';
import * as tables from './schema';

const databaseSchema = { ...tables, ...relations };

const POSTGRES_DRIVER = 'postgres' as const;
const AWS_DATA_API_DRIVER = 'aws-data-api' as const;

const PostgreSqlUrlSchema = z
  .string()
  .trim()
  .min(1, 'must be set')
  .superRefine((value, context) => {
    try {
      const url = new URL(value);

      if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
        context.addIssue({
          code: 'custom',
          message: 'must use the postgres: or postgresql: protocol',
        });
      }

      if (url.hostname.length === 0 || url.pathname.length <= 1) {
        context.addIssue({
          code: 'custom',
          message: 'must include a host and database name',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'must be a valid PostgreSQL connection URL',
      });
    }
  });

const AwsRegionSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u,
    'must be a valid explicit AWS region',
  );

const RdsClusterArnSchema = z
  .string()
  .trim()
  .regex(
    /^arn:(?:aws|aws-cn|aws-us-gov):rds:[a-z0-9-]+:\d{12}:cluster:[A-Za-z0-9-]+$/u,
    'must be an RDS cluster ARN',
  );

const SecretsManagerArnSchema = z
  .string()
  .trim()
  .regex(
    /^arn:(?:aws|aws-cn|aws-us-gov):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/u,
    'must be a Secrets Manager secret ARN',
  );

const PostgresUrlDatabaseConfigSchema = z
  .object({
    driver: z.literal(POSTGRES_DRIVER),
    url: PostgreSqlUrlSchema,
    maxConnections: z.number().int().min(1).max(50).default(10),
    connectTimeoutSeconds: z.number().int().min(1).max(60).default(10),
    idleTimeoutSeconds: z.number().int().min(0).max(600).default(20),
  })
  .strict();

const PostgresComponentDatabaseConfigSchema = z
  .object({
    driver: z.literal(POSTGRES_DRIVER),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(
        /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u,
        'must be a DNS hostname',
      ),
    port: z.number().int().min(1).max(65_535).default(5_432),
    database: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_$]*$/u,
        'must be an unquoted PostgreSQL database name',
      ),
    username: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_$]*$/u,
        'must be an unquoted PostgreSQL role name',
      ),
    password: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\0\r\n]/u.test(value), {
        message: 'must be a single-line value',
      }),
    sslRootCertificatePath: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .regex(/^\//u, 'must be an absolute path'),
    maxConnections: z.literal(1).default(1),
    connectTimeoutSeconds: z.number().int().min(1).max(60).default(10),
    idleTimeoutSeconds: z.number().int().min(0).max(600).default(0),
  })
  .strict();

const AwsDataApiDatabaseConfigSchema = z
  .object({
    driver: z.literal(AWS_DATA_API_DRIVER),
    region: AwsRegionSchema,
    database: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_$]*$/u,
        'must be an unquoted PostgreSQL database name',
      ),
    resourceArn: RdsClusterArnSchema,
    secretArn: SecretsManagerArnSchema,
  })
  .strict();

const DatabaseConfigSchema = z.union([
  PostgresUrlDatabaseConfigSchema,
  PostgresComponentDatabaseConfigSchema,
  AwsDataApiDatabaseConfigSchema,
]);

const DatabaseDriverSchema = z.enum([POSTGRES_DRIVER, AWS_DATA_API_DRIVER]);

type ParsedDatabaseConfig = z.output<typeof DatabaseConfigSchema>;

/** Explicit local/test configuration for a direct PostgreSQL URL. */
export interface PostgresUrlDatabaseConfig {
  readonly driver: typeof POSTGRES_DRIVER;
  readonly url: string;
  readonly maxConnections?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
}

/**
 * Deployed PostgreSQL configuration assembled from individually injected
 * credential fields. TLS verification and a single-connection pool are
 * mandatory for this mode. Idle eviction defaults off because route processes
 * retain this max-one pool; one-off callers still close it explicitly.
 */
export interface PostgresComponentDatabaseConfig {
  readonly driver: typeof POSTGRES_DRIVER;
  readonly host: string;
  readonly port?: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly sslRootCertificatePath: string;
  readonly maxConnections?: 1;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
}

export type PostgresDatabaseConfig =
  PostgresUrlDatabaseConfig | PostgresComponentDatabaseConfig;

/**
 * Explicit configuration for Aurora through the RDS Data API.
 *
 * Credentials are deliberately absent. The AWS SDK must resolve short-lived
 * credentials from the runtime role or the standard developer credential
 * chain; callers cannot inject static access keys through this API.
 */
export interface AwsDataApiDatabaseConfig {
  readonly driver: typeof AWS_DATA_API_DRIVER;
  readonly region: string;
  readonly database: string;
  readonly resourceArn: string;
  readonly secretArn: string;
}

/** A fail-closed choice of exactly one supported database transport. */
export type DatabaseConfig = PostgresDatabaseConfig | AwsDataApiDatabaseConfig;

/** The schema-aware direct PostgreSQL Drizzle database. */
export type PostgresDatabase = PostgresJsDatabase<typeof databaseSchema>;

/** The schema-aware Aurora RDS Data API Drizzle database. */
export type AwsDataApiDatabase = AwsDataApiPgDatabase<typeof databaseSchema>;

/** A schema-aware database using either explicitly selected transport. */
export type Database = PostgresDatabase | AwsDataApiDatabase;

/**
 * Rows returned by a raw Drizzle PostgreSQL query.
 *
 * postgres-js returns its row list directly. The RDS Data API adapter retains
 * the AWS command response envelope and exposes mapped rows on `rows`.
 */
export type DatabaseExecuteResult<Row extends Record<string, unknown>> =
  Row[] | Readonly<{ rows: Row[] }>;

/**
 * Schema-aware query surface shared by both configured transports.
 *
 * Drizzle query builders normalize their results across transports. Raw
 * `execute`, however, has the transport-specific result shape modeled here.
 */
export type DatabaseQuery = Omit<PostgresDatabase, 'execute'> & {
  execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: Parameters<PostgresDatabase['execute']>[0],
  ): PromiseLike<DatabaseExecuteResult<Row>>;
};

/** Invalid or absent raw database result that cannot safely be normalized. */
export class DatabaseExecuteResultError extends Error {
  public constructor() {
    super('The database execute result did not contain a rows collection.');
    this.name = 'DatabaseExecuteResultError';
  }
}

/** Returns mapped rows from either supported raw Drizzle result shape. */
export function databaseExecuteRows<Row extends Record<string, unknown>>(
  result: DatabaseExecuteResult<Row> | null | undefined,
): readonly Row[] {
  if (Array.isArray(result)) return result;
  if (result === null || result === undefined || !Array.isArray(result.rows)) {
    throw new DatabaseExecuteResultError();
  }
  return result.rows;
}

/** A direct PostgreSQL connection and its idempotent lifecycle hook. */
export interface PostgresDatabaseConnection {
  readonly driver: typeof POSTGRES_DRIVER;
  readonly db: PostgresDatabase;
  /** Native driver seam used only where query cancellation is required. */
  readonly nativeClient?: ReturnType<typeof postgres>;
  close(): Promise<void>;
}

/** An RDS Data API connection and its idempotent lifecycle hook. */
export interface AwsDataApiDatabaseConnection {
  readonly driver: typeof AWS_DATA_API_DRIVER;
  readonly db: AwsDataApiDatabase;
  close(): Promise<void>;
}

/** A database connection that must be narrowed by its selected driver. */
export type DatabaseConnection =
  PostgresDatabaseConnection | AwsDataApiDatabaseConnection;

/**
 * Configuration failure whose message identifies fields but never includes
 * connection URLs, secret ARNs, or other supplied values.
 */
export class DatabaseConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const CONFIG_FIELD_TO_ENVIRONMENT_VARIABLE = {
  connectTimeoutSeconds: 'DATABASE_CONNECT_TIMEOUT_SECONDS',
  database: 'DATABASE_NAME',
  driver: 'DATABASE_DRIVER',
  host: 'DATABASE_HOST',
  idleTimeoutSeconds: 'DATABASE_IDLE_TIMEOUT_SECONDS',
  maxConnections: 'DATABASE_MAX_CONNECTIONS',
  password: 'DATABASE_PASSWORD',
  port: 'DATABASE_PORT',
  region: 'AWS_REGION',
  resourceArn: 'DATABASE_RESOURCE_ARN',
  secretArn: 'DATABASE_SECRET_ARN',
  sslRootCertificatePath: 'DATABASE_SSL_ROOT_CERT',
  url: 'DATABASE_URL',
  username: 'DATABASE_USERNAME',
} as const;

function hasEnvironmentValue(
  environment: Environment,
  variableName: string,
): boolean {
  const value = environment[variableName];
  return value !== undefined && value.trim().length > 0;
}

function assertEnvironmentVariablesAbsent(
  environment: Environment,
  selectedDriver: string,
  variableNames: readonly string[],
): void {
  const conflictingVariables = variableNames.filter((variableName) =>
    hasEnvironmentValue(environment, variableName),
  );

  if (conflictingVariables.length > 0) {
    throw new DatabaseConfigurationError(
      `DATABASE_DRIVER=${selectedDriver} conflicts with ${conflictingVariables.join(
        ', ',
      )}; remove configuration for the unselected transport`,
    );
  }
}

function parseOptionalInteger(
  environment: Environment,
  variableName: string,
): number | undefined {
  const value = environment[variableName];

  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  if (!/^\d+$/u.test(value.trim())) {
    throw new DatabaseConfigurationError(
      `${variableName} must be a non-negative integer`,
    );
  }

  return Number(value);
}

function parseDatabaseConfig(config: DatabaseConfig): ParsedDatabaseConfig {
  const result = DatabaseConfigSchema.safeParse(config);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const field = issue.path[0];
    const environmentVariable =
      typeof field === 'string' && field in CONFIG_FIELD_TO_ENVIRONMENT_VARIABLE
        ? CONFIG_FIELD_TO_ENVIRONMENT_VARIABLE[
            field as keyof typeof CONFIG_FIELD_TO_ENVIRONMENT_VARIABLE
          ]
        : 'database configuration';

    return `${environmentVariable}: ${issue.message}`;
  });

  throw new DatabaseConfigurationError(
    `Invalid database configuration (${issues.join('; ')})`,
  );
}

/**
 * Reads one explicitly selected database transport from environment values.
 *
 * `DATABASE_DRIVER` is mandatory. Local/test PostgreSQL may use
 * `DATABASE_URL`. Deployed PostgreSQL instead requires component fields and a
 * pinned TLS root certificate. RDS Data API requires `AWS_REGION`, `DATABASE_NAME`,
 * `DATABASE_RESOURCE_ARN`, and `DATABASE_SECRET_ARN`. Configuration for the
 * unselected transport is rejected so deployment mistakes cannot silently
 * change the connection path.
 */
export function readDatabaseConfig(
  environment: Environment = process.env,
): DatabaseConfig {
  const driverResult = DatabaseDriverSchema.safeParse(
    environment.DATABASE_DRIVER,
  );

  if (!driverResult.success) {
    throw new DatabaseConfigurationError(
      'DATABASE_DRIVER must be set to postgres or aws-data-api',
    );
  }

  if (driverResult.data === POSTGRES_DRIVER) {
    assertEnvironmentVariablesAbsent(environment, POSTGRES_DRIVER, [
      'DATABASE_RESOURCE_ARN',
      'DATABASE_SECRET_ARN',
    ]);

    const maxConnections = parseOptionalInteger(
      environment,
      'DATABASE_MAX_CONNECTIONS',
    );
    const connectTimeoutSeconds = parseOptionalInteger(
      environment,
      'DATABASE_CONNECT_TIMEOUT_SECONDS',
    );
    const idleTimeoutSeconds = parseOptionalInteger(
      environment,
      'DATABASE_IDLE_TIMEOUT_SECONDS',
    );

    if (hasEnvironmentValue(environment, 'DATABASE_URL')) {
      if (environment.NODE_ENV === 'production') {
        throw new DatabaseConfigurationError(
          'DATABASE_URL is limited to local development and tests.',
        );
      }
      assertEnvironmentVariablesAbsent(environment, POSTGRES_DRIVER, [
        'DATABASE_HOST',
        'DATABASE_PORT',
        'DATABASE_NAME',
        'DATABASE_USERNAME',
        'DATABASE_PASSWORD',
        'DATABASE_SSL_ROOT_CERT',
      ]);
      return parseDatabaseConfig({
        driver: POSTGRES_DRIVER,
        url: environment.DATABASE_URL ?? '',
        ...(maxConnections === undefined ? {} : { maxConnections }),
        ...(connectTimeoutSeconds === undefined
          ? {}
          : { connectTimeoutSeconds }),
        ...(idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds }),
      });
    }

    if (maxConnections !== undefined && maxConnections !== 1) {
      throw new DatabaseConfigurationError(
        'DATABASE_MAX_CONNECTIONS must be 1 for component PostgreSQL configuration.',
      );
    }
    const port = parseOptionalInteger(environment, 'DATABASE_PORT');
    return parseDatabaseConfig({
      driver: POSTGRES_DRIVER,
      host: environment.DATABASE_HOST ?? '',
      ...(port === undefined ? {} : { port }),
      database: environment.DATABASE_NAME ?? '',
      username: environment.DATABASE_USERNAME ?? '',
      password: environment.DATABASE_PASSWORD ?? '',
      sslRootCertificatePath: environment.DATABASE_SSL_ROOT_CERT ?? '',
      ...(maxConnections === undefined ? {} : { maxConnections }),
      ...(connectTimeoutSeconds === undefined ? {} : { connectTimeoutSeconds }),
      ...(idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds }),
    });
  }

  assertEnvironmentVariablesAbsent(environment, AWS_DATA_API_DRIVER, [
    'DATABASE_URL',
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
    'DATABASE_SSL_ROOT_CERT',
    'DATABASE_MAX_CONNECTIONS',
    'DATABASE_CONNECT_TIMEOUT_SECONDS',
    'DATABASE_IDLE_TIMEOUT_SECONDS',
  ]);

  return parseDatabaseConfig({
    driver: AWS_DATA_API_DRIVER,
    region: environment.AWS_REGION ?? '',
    database: environment.DATABASE_NAME ?? '',
    resourceArn: environment.DATABASE_RESOURCE_ARN ?? '',
    secretArn: environment.DATABASE_SECRET_ARN ?? '',
  });
}

function createIdempotentClose(
  close: () => void | Promise<void>,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;

  return () => {
    closePromise ??= Promise.resolve().then(close);
    return closePromise;
  };
}

function createSynchronousIdempotentClose(
  close: () => void | Promise<void>,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;

  return () => {
    if (closePromise !== undefined) return closePromise;
    try {
      closePromise = Promise.resolve(close());
    } catch (error) {
      closePromise = Promise.reject(error);
    }
    return closePromise;
  };
}

function createPostgresDatabaseConnection(
  config:
    | z.output<typeof PostgresUrlDatabaseConfigSchema>
    | z.output<typeof PostgresComponentDatabaseConfigSchema>,
): PostgresDatabaseConnection {
  const commonOptions = {
    connect_timeout: config.connectTimeoutSeconds,
    idle_timeout: config.idleTimeoutSeconds,
    // The pinned postgres-js patch makes an internally retired connection
    // generation terminal. Disable its random 30-60 minute life timer; every
    // client in this repository already owns an explicit close boundary.
    max_lifetime: 0,
    max: config.maxConnections,
  } as const;
  const client =
    'url' in config
      ? postgres(config.url, commonOptions)
      : postgres({
          ...commonOptions,
          database: config.database,
          host: config.host,
          password: config.password,
          port: config.port,
          ssl: {
            ca: readTrustedRootCertificate(config.sslRootCertificatePath),
            rejectUnauthorized: true,
            servername: config.host,
          },
          user: config.username,
        });

  return {
    driver: POSTGRES_DRIVER,
    db: drizzlePostgres(client, { schema: databaseSchema }),
    nativeClient: client,
    close: createSynchronousIdempotentClose(() => client.end({ timeout: 0 })),
  };
}

function readTrustedRootCertificate(path: string): string {
  let certificate: string;
  try {
    certificate = readFileSync(path, 'utf8');
  } catch {
    throw new DatabaseConfigurationError(
      'DATABASE_SSL_ROOT_CERT could not be read.',
    );
  }
  if (
    Buffer.byteLength(certificate, 'utf8') > 1_048_576 ||
    !certificate.includes('-----BEGIN CERTIFICATE-----') ||
    !certificate.includes('-----END CERTIFICATE-----') ||
    certificate.includes('-----BEGIN PRIVATE KEY-----')
  ) {
    throw new DatabaseConfigurationError(
      'DATABASE_SSL_ROOT_CERT did not contain a bounded public CA bundle.',
    );
  }
  return certificate;
}

function createAwsDataApiDatabaseConnection(
  config: z.output<typeof AwsDataApiDatabaseConfigSchema>,
): AwsDataApiDatabaseConnection {
  const client = new RDSDataClient({
    region: config.region,
    maxAttempts: 3,
  });

  return {
    driver: AWS_DATA_API_DRIVER,
    db: drizzleAwsDataApi(client, {
      database: config.database,
      resourceArn: config.resourceArn,
      schema: databaseSchema,
      secretArn: config.secretArn,
    }),
    close: createIdempotentClose(() => client.destroy()),
  };
}

/**
 * Creates the explicitly configured Drizzle connection without contacting the
 * alternate transport or falling back when configuration is incomplete.
 * Always call `close()` in a `finally` block for scripts and short-lived jobs.
 */
export function createDatabaseClient(
  config: DatabaseConfig,
): DatabaseConnection {
  const parsedConfig = parseDatabaseConfig(config);

  switch (parsedConfig.driver) {
    case POSTGRES_DRIVER:
      return createPostgresDatabaseConnection(parsedConfig);
    case AWS_DATA_API_DRIVER:
      return createAwsDataApiDatabaseConnection(parsedConfig);
  }
}
