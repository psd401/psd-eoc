import {
  tenantGcpBillingAccount,
  tenantString,
} from '../../src/tenant-context';

/**
 * Every district-specific value the GCP operator tooling needs, read once from
 * the git-ignored infra/cdk.local.json. None has a fallback: these helpers
 * mutate live Google Cloud and AWS resources, so they refuse to run until the
 * tenant is configured rather than guess a target.
 */

const HOSTNAME = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u;

/** Escapes a literal so it matches only itself inside a RegExp source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Google Cloud project ID dedicated to PSD EOC. */
export const PROJECT_ID = tenantString(
  'psdEoc:gcpProjectId',
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u,
);
/** Numeric Google Cloud organization ID that parents the project. */
export const ORGANIZATION_ID = tenantString(
  'psdEoc:gcpOrganizationId',
  /^[1-9][0-9]{0,19}$/u,
);
/** Google Cloud billing account in the canonical 6-6-6 form. */
export const BILLING_ACCOUNT = tenantGcpBillingAccount();
/** Private bucket that holds the main root's Terraform state. */
export const STATE_BUCKET = tenantString(
  'psdEoc:gcpTerraformStateBucket',
  /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/u,
);
/** Google Workspace domain of every staff account and group. */
export const HOSTED_DOMAIN = tenantString('psdEoc:hostedDomain', HOSTNAME);
/** Lowercase email pattern for an account or group in the hosted domain. */
export const STAFF_EMAIL_PATTERN = new RegExp(
  `^[a-z0-9._%+-]+@${escapeRegExp(HOSTED_DOMAIN)}$`,
  'u',
);
/** The one human administrator who runs Terraform and the operator helpers. */
export const TERRAFORM_ADMIN = tenantString(
  'psdEoc:gcpTerraformAdminEmail',
  STAFF_EMAIL_PATTERN,
);
/**
 * IAM Identity Center user name of the administrator, which AWS reports as
 * the assumed-role session name. It is the local part of the administrator's
 * Workspace address.
 */
export const TERRAFORM_ADMIN_USERNAME = TERRAFORM_ADMIN.slice(
  0,
  TERRAFORM_ADMIN.indexOf('@'),
);
/** Named AWS CLI profile the helpers use for the production account. */
export const AWS_PROFILE = tenantString(
  'psdEoc:awsOperatorProfile',
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
);
/** IAM Identity Center start URL of that profile's SSO session. */
export const AWS_SSO_START_URL = tenantString(
  'psdEoc:awsSsoStartUrl',
  /^https:\/\/[a-z0-9][a-z0-9-]*\.awsapps\.com\/start$/u,
);
/** Exact production web origin registered on the Google web OAuth client. */
export const WEB_ORIGIN = tenantString(
  'psdEoc:applicationOrigin',
  /^https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u,
);
/** Exact production callback registered on the Google web OAuth client. */
export const WEB_OAUTH_REDIRECT_URI = `${WEB_ORIGIN}/auth/callback`;
/** iOS bundle ID and Android package name shared by both mobile clients. */
export const MOBILE_APPLICATION_ID = tenantString(
  'psdEoc:iosBundleId',
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u,
);
/** The Terraform-managed roster-sync reader service account. */
export const ROSTER_READER_EMAIL = `roster-sync-reader@${PROJECT_ID}.iam.gserviceaccount.com`;

/**
 * Input variables each Terraform root declares without a default. `plan` and
 * `import` evaluate the configuration and need them; a saved-plan `apply`
 * refuses -var, and state, output, and workspace commands never read them.
 */
export function terraformVariableArguments(
  root: 'bootstrap' | 'main',
): readonly string[] {
  const shared = [
    `-var=project_id=${PROJECT_ID}`,
    `-var=organization_id=${ORGANIZATION_ID}`,
    `-var=billing_account=${BILLING_ACCOUNT}`,
    `-var=terraform_state_bucket=${STATE_BUCKET}`,
    `-var=terraform_admin_email=${TERRAFORM_ADMIN}`,
  ];
  if (root === 'bootstrap') return shared;
  return [
    ...shared,
    `-var=authorized_domain=${HOSTED_DOMAIN}`,
    `-var=aws_operator_profile=${AWS_PROFILE}`,
    `-var=web_origin=${WEB_ORIGIN}`,
    `-var=web_oauth_redirect_uri=${WEB_OAUTH_REDIRECT_URI}`,
    `-var=mobile_application_id=${MOBILE_APPLICATION_ID}`,
  ];
}

/**
 * The main root's backend block names a deliberately unusable bucket; every
 * `terraform init` of that root supplies the tenant's state bucket here.
 */
export function terraformBackendArguments(): readonly string[] {
  return [`-backend-config=bucket=${STATE_BUCKET}`];
}
