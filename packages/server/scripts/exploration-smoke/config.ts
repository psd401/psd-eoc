import { z } from 'zod';

export const EXPLORATION_AWS_ACCOUNT_ID = '<aws-account-id>' as const;
export const EXPLORATION_AWS_REGION = 'us-west-2' as const;
export const EXPLORATION_DATABASE_LOGIN = 'psd_eoc_application' as const;
export const EXPLORATION_DATABASE_ROLE = 'psd_eoc_app' as const;

type Environment = Readonly<Record<string, string | undefined>>;

const normalizedValue = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim() && !/[\0\r\n]/u.test(value), {
      message: 'must be a normalized single-line value',
    });

const DatabaseNameSchema = normalizedValue(63).regex(
  /^[A-Za-z_][A-Za-z0-9_$]*$/u,
  'must be an unquoted PostgreSQL database name',
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
    DATABASE_NAME: DatabaseNameSchema,
    DATABASE_RESOURCE_ARN: normalizedValue(2_048),
    DATABASE_ADMIN_SECRET_ARN: normalizedValue(2_048),
    DATABASE_APPLICATION_SECRET_ARN: normalizedValue(2_048),
    APPROVED_GOOGLE_SUBJECT: GoogleSubjectSchema,
    APPROVED_STAFF_EMAIL: StaffEmailSchema,
    APPROVED_STAFF_DISPLAY_NAME: normalizedValue(160),
    SOURCE_SHA: SourceShaSchema,
  })
  .strict();

/** Fail-closed input for the one isolated exploration-smoke bootstrap. */
export interface ExplorationBootstrapConfig {
  readonly accountId: typeof EXPLORATION_AWS_ACCOUNT_ID;
  readonly region: typeof EXPLORATION_AWS_REGION;
  readonly databaseName: string;
  readonly databaseResourceArn: string;
  readonly databaseAdminSecretArn: string;
  readonly databaseApplicationSecretArn: string;
  readonly approvedGoogleSubject: string;
  readonly approvedStaffEmail: string;
  readonly approvedStaffDisplayName: string;
  readonly sourceSha: string;
}

/** Configuration error that names fields without reflecting sensitive values. */
export class ExplorationBootstrapConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ExplorationBootstrapConfigurationError';
  }
}

function assertArnScope(
  value: string,
  service: 'rds' | 'secretsmanager',
  resourcePattern: RegExp,
): void {
  const prefix = `arn:aws:${service}:${EXPLORATION_AWS_REGION}:${EXPLORATION_AWS_ACCOUNT_ID}:`;
  if (
    !value.startsWith(prefix) ||
    !resourcePattern.test(value.slice(prefix.length))
  ) {
    throw new ExplorationBootstrapConfigurationError(
      `The ${service} ARN is outside the exploration-smoke account, region, or resource namespace.`,
    );
  }
}

/**
 * Reads only the explicit bootstrap contract. Ambient AWS defaults cannot
 * redirect this operation to another account or region.
 */
export function readExplorationBootstrapConfig(
  environment: Environment = process.env,
): ExplorationBootstrapConfig {
  const parsed = BootstrapEnvironmentSchema.safeParse({
    AWS_ACCOUNT_ID: environment.AWS_ACCOUNT_ID,
    AWS_REGION: environment.AWS_REGION,
    DATABASE_NAME: environment.DATABASE_NAME,
    DATABASE_RESOURCE_ARN: environment.DATABASE_RESOURCE_ARN,
    DATABASE_ADMIN_SECRET_ARN: environment.DATABASE_ADMIN_SECRET_ARN,
    DATABASE_APPLICATION_SECRET_ARN:
      environment.DATABASE_APPLICATION_SECRET_ARN,
    APPROVED_GOOGLE_SUBJECT: environment.APPROVED_GOOGLE_SUBJECT,
    APPROVED_STAFF_EMAIL: environment.APPROVED_STAFF_EMAIL,
    APPROVED_STAFF_DISPLAY_NAME: environment.APPROVED_STAFF_DISPLAY_NAME,
    SOURCE_SHA: environment.SOURCE_SHA,
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
  assertArnScope(
    value.DATABASE_RESOURCE_ARN,
    'rds',
    /^cluster:psd-eoc-exploration-smoke(?:-[A-Za-z0-9-]+)?$/u,
  );
  assertArnScope(
    value.DATABASE_ADMIN_SECRET_ARN,
    'secretsmanager',
    /^secret:\/psd-eoc\/exploration-smoke\/database\/admin-[A-Za-z0-9]+$/u,
  );
  assertArnScope(
    value.DATABASE_APPLICATION_SECRET_ARN,
    'secretsmanager',
    /^secret:\/psd-eoc\/exploration-smoke\/database\/application-[A-Za-z0-9]+$/u,
  );
  if (
    value.DATABASE_ADMIN_SECRET_ARN === value.DATABASE_APPLICATION_SECRET_ARN
  ) {
    throw new ExplorationBootstrapConfigurationError(
      'The database administrator and application secrets must be distinct.',
    );
  }

  return Object.freeze({
    accountId: value.AWS_ACCOUNT_ID,
    region: value.AWS_REGION,
    databaseName: value.DATABASE_NAME,
    databaseResourceArn: value.DATABASE_RESOURCE_ARN,
    databaseAdminSecretArn: value.DATABASE_ADMIN_SECRET_ARN,
    databaseApplicationSecretArn: value.DATABASE_APPLICATION_SECRET_ARN,
    approvedGoogleSubject: value.APPROVED_GOOGLE_SUBJECT,
    approvedStaffEmail: value.APPROVED_STAFF_EMAIL,
    approvedStaffDisplayName: value.APPROVED_STAFF_DISPLAY_NAME,
    sourceSha: value.SOURCE_SHA,
  });
}
