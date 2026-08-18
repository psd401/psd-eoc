import { z } from 'zod';

export const EXPLORATION_AWS_ACCOUNT_ID = '<aws-account-id>' as const;
export const EXPLORATION_AWS_REGION = 'us-west-2' as const;
export const EXPLORATION_DATABASE_LOGIN = 'psd_eoc_application' as const;
export const EXPLORATION_DATABASE_ROLE = 'psd_eoc_app' as const;

/**
 * What a bootstrap run is allowed to do.
 *
 * `migrate` is the only mode a deploy runs. It brings the schema and the
 * reference catalog up to date and proves the application role still works.
 * It writes nothing that describes who may sign in.
 *
 * `seed-access-fixture` additionally publishes the synthetic access fixture:
 * one invented access group, one approved user, and an access-membership
 * snapshot covering only that group. That snapshot supersedes whatever the
 * access sync last published, so on a stack with real access groups it revokes
 * everybody's access until the sync runs again. It exists to make a brand new
 * stack reachable by one known human, and it must never run on a stack that
 * already has real access groups.
 */
export const EXPLORATION_BOOTSTRAP_MODES = Object.freeze([
  'migrate',
  'seed-access-fixture',
] as const);

export type ExplorationBootstrapMode =
  (typeof EXPLORATION_BOOTSTRAP_MODES)[number];

type Environment = Readonly<Record<string, string | undefined>>;

const normalizedValue = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim() && !/[\0\r\n]/u.test(value), {
      message: 'must be a normalized single-line value',
    });

const DatabaseIdentifierSchema = normalizedValue(63).regex(
  /^[A-Za-z_][A-Za-z0-9_$]*$/u,
  'must be an unquoted PostgreSQL identifier',
);

const DatabaseHostSchema = normalizedValue(253).regex(
  /^psd-eoc-exploration-smoke[.]cluster-[a-z0-9]+[.]us-west-2[.]rds[.]amazonaws[.]com$/u,
  'must be the exploration Aurora writer endpoint',
);

const DatabasePasswordSchema = z
  .string()
  .regex(/^[\x21-\x7e]{32,128}$/u, 'must be bounded printable ASCII');

const AbsolutePathSchema = normalizedValue(1_024).regex(
  /^\//u,
  'must be an absolute path',
);

const SourceShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/u, 'must be an exact lowercase Git commit SHA');

const GoogleSubjectSchema = normalizedValue(255).regex(
  /^[A-Za-z0-9_-]+$/u,
  'must be an immutable Google subject',
);

const StaffEmailSchema = normalizedValue(320)
  .email()
  .refine((value) => value === value.toLowerCase(), {
    message: 'must be lowercase',
  })
  .refine((value) => value.endsWith('@psd401.net'), {
    message: 'must use the psd401.net hosted domain',
  });

const BootstrapEnvironmentSchema = z
  .object({
    AWS_ACCOUNT_ID: z.literal(EXPLORATION_AWS_ACCOUNT_ID),
    AWS_REGION: z.literal(EXPLORATION_AWS_REGION),
    DATABASE_DRIVER: z.literal('postgres'),
    DATABASE_HOST: DatabaseHostSchema,
    DATABASE_PORT: z.literal('5432'),
    DATABASE_NAME: DatabaseIdentifierSchema,
    DATABASE_SSL_ROOT_CERT: AbsolutePathSchema,
    DATABASE_MAX_CONNECTIONS: z.literal('1'),
    DATABASE_CONNECT_TIMEOUT_SECONDS: z.literal('10'),
    DATABASE_IDLE_TIMEOUT_SECONDS: z.literal('20'),
    DATABASE_ADMIN_USERNAME: DatabaseIdentifierSchema,
    DATABASE_ADMIN_PASSWORD: DatabasePasswordSchema,
    DATABASE_APPLICATION_USERNAME: z.literal(EXPLORATION_DATABASE_LOGIN),
    DATABASE_APPLICATION_PASSWORD: DatabasePasswordSchema,
    APPROVED_GOOGLE_SUBJECT: GoogleSubjectSchema,
    APPROVED_STAFF_EMAIL: StaffEmailSchema,
    APPROVED_STAFF_DISPLAY_NAME: normalizedValue(160),
    SOURCE_SHA: SourceShaSchema,
    BOOTSTRAP_MODE: z.enum(EXPLORATION_BOOTSTRAP_MODES).default('migrate'),
  })
  .strict();

const FORBIDDEN_DATABASE_ENVIRONMENT = Object.freeze([
  'DATABASE_URL',
  'DATABASE_RESOURCE_ARN',
  'DATABASE_SECRET_ARN',
  'DATABASE_ADMIN_SECRET_ARN',
  'DATABASE_APPLICATION_SECRET_ARN',
] as const);

/** Fail-closed input for the one isolated exploration-smoke bootstrap. */
export interface ExplorationBootstrapConfig {
  readonly accountId: typeof EXPLORATION_AWS_ACCOUNT_ID;
  readonly region: typeof EXPLORATION_AWS_REGION;
  readonly databaseDriver: 'postgres';
  readonly databaseHost: string;
  readonly databasePort: 5432;
  readonly databaseName: string;
  readonly databaseSslRootCertificate: string;
  readonly databaseMaxConnections: 1;
  readonly databaseConnectTimeoutSeconds: 10;
  readonly databaseIdleTimeoutSeconds: 20;
  readonly databaseAdminUsername: string;
  readonly databaseAdminPassword: string;
  readonly databaseApplicationUsername: typeof EXPLORATION_DATABASE_LOGIN;
  readonly databaseApplicationPassword: string;
  readonly approvedGoogleSubject: string;
  readonly approvedStaffEmail: string;
  readonly approvedStaffDisplayName: string;
  readonly sourceSha: string;
  readonly mode: ExplorationBootstrapMode;
}

/** Configuration error that names fields without reflecting sensitive values. */
export class ExplorationBootstrapConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ExplorationBootstrapConfigurationError';
  }
}

function hasEnvironmentValue(environment: Environment, name: string): boolean {
  const value = environment[name];
  return value !== undefined && value.trim().length > 0;
}

/**
 * Reads only the explicit native bootstrap contract. Ambient AWS defaults
 * cannot redirect this operation, and no Data API configuration is accepted.
 */
export function readExplorationBootstrapConfig(
  environment: Environment = process.env,
): ExplorationBootstrapConfig {
  const forbidden = FORBIDDEN_DATABASE_ENVIRONMENT.filter((name) =>
    hasEnvironmentValue(environment, name),
  );
  if (forbidden.length > 0) {
    throw new ExplorationBootstrapConfigurationError(
      `Invalid exploration-smoke bootstrap configuration: ${forbidden.join(', ')}.`,
    );
  }

  const parsed = BootstrapEnvironmentSchema.safeParse({
    AWS_ACCOUNT_ID: environment.AWS_ACCOUNT_ID,
    AWS_REGION: environment.AWS_REGION,
    DATABASE_DRIVER: environment.DATABASE_DRIVER,
    DATABASE_HOST: environment.DATABASE_HOST,
    DATABASE_PORT: environment.DATABASE_PORT,
    DATABASE_NAME: environment.DATABASE_NAME,
    DATABASE_SSL_ROOT_CERT: environment.DATABASE_SSL_ROOT_CERT,
    DATABASE_MAX_CONNECTIONS: environment.DATABASE_MAX_CONNECTIONS,
    DATABASE_CONNECT_TIMEOUT_SECONDS:
      environment.DATABASE_CONNECT_TIMEOUT_SECONDS,
    DATABASE_IDLE_TIMEOUT_SECONDS: environment.DATABASE_IDLE_TIMEOUT_SECONDS,
    DATABASE_ADMIN_USERNAME: environment.DATABASE_ADMIN_USERNAME,
    DATABASE_ADMIN_PASSWORD: environment.DATABASE_ADMIN_PASSWORD,
    DATABASE_APPLICATION_USERNAME: environment.DATABASE_APPLICATION_USERNAME,
    DATABASE_APPLICATION_PASSWORD: environment.DATABASE_APPLICATION_PASSWORD,
    APPROVED_GOOGLE_SUBJECT: environment.APPROVED_GOOGLE_SUBJECT,
    APPROVED_STAFF_EMAIL: environment.APPROVED_STAFF_EMAIL,
    APPROVED_STAFF_DISPLAY_NAME: environment.APPROVED_STAFF_DISPLAY_NAME,
    SOURCE_SHA: environment.SOURCE_SHA,
    BOOTSTRAP_MODE: environment.BOOTSTRAP_MODE,
  });
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path[0])),
    ]
      .filter((field): field is string => typeof field === 'string')
      .sort();
    throw new ExplorationBootstrapConfigurationError(
      `Invalid exploration-smoke bootstrap configuration: ${fields.join(', ')}.`,
    );
  }

  const value = parsed.data;
  if (value.DATABASE_ADMIN_USERNAME === value.DATABASE_APPLICATION_USERNAME) {
    throw new ExplorationBootstrapConfigurationError(
      'The database administrator and application roles must be distinct.',
    );
  }

  return Object.freeze({
    accountId: value.AWS_ACCOUNT_ID,
    region: value.AWS_REGION,
    databaseDriver: value.DATABASE_DRIVER,
    databaseHost: value.DATABASE_HOST,
    databasePort: 5432 as const,
    databaseName: value.DATABASE_NAME,
    databaseSslRootCertificate: value.DATABASE_SSL_ROOT_CERT,
    databaseMaxConnections: 1 as const,
    databaseConnectTimeoutSeconds: 10 as const,
    databaseIdleTimeoutSeconds: 20 as const,
    databaseAdminUsername: value.DATABASE_ADMIN_USERNAME,
    databaseAdminPassword: value.DATABASE_ADMIN_PASSWORD,
    databaseApplicationUsername: value.DATABASE_APPLICATION_USERNAME,
    databaseApplicationPassword: value.DATABASE_APPLICATION_PASSWORD,
    approvedGoogleSubject: value.APPROVED_GOOGLE_SUBJECT,
    approvedStaffEmail: value.APPROVED_STAFF_EMAIL,
    approvedStaffDisplayName: value.APPROVED_STAFF_DISPLAY_NAME,
    sourceSha: value.SOURCE_SHA,
    mode: value.BOOTSTRAP_MODE,
  });
}
