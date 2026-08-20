export const AWS_ACCOUNT_ALIAS = 'psd401';
export const AWS_ACCOUNT = '<aws-account-id>';
export const AWS_REGION = 'us-west-2';
/**
 * The deployed CloudFormation stack's name.
 *
 * "ExplorationSmoke" is a leftover from this system's first week and means
 * nothing — it is not exploratory and it is not a smoke test, it serves
 * production traffic. The value cannot simply be corrected: CloudFormation
 * identifies a stack by name, so changing it does not rename anything, it
 * creates a second stack and orphans the first, including the Aurora cluster
 * holding the live data. The same is true of the physical names derived from
 * it throughout this file.
 *
 * Renaming them is a planned migration with downtime, tracked separately. Until
 * then this constant carries the old value deliberately, and every identifier
 * around it has been renamed so the misleading word stops spreading.
 */
export const STACK_NAME = 'PsdEocExplorationSmoke';

// Physical resource names remain stable while the deployed environment moves
// from the initial synthetic fixture to staff-only live operation.
export const EXPLORATION_SMOKE_ENVIRONMENT = 'live-pilot';
export const EXPLORATION_SMOKE_DATA_CLASSIFICATION = 'staff-minimized';
export const DATABASE_NAME = 'psd_eoc';
export const EXPLORATION_SMOKE_DATABASE_IDENTIFIER =
  'psd-eoc-exploration-smoke';
export const DATABASE_PORT = 5_432;
export const EXPLORATION_SMOKE_HEALTH_PATH = '/api/health';
export const EXPLORATION_SMOKE_REPOSITORY_NAME =
  'psd-eoc/exploration-smoke/server';
export const EXPLORATION_SMOKE_QUEUE_NAME = 'psd-eoc-exploration-smoke-health';
export const EXPLORATION_SMOKE_EMAIL_QUEUE_NAME = 'psd-eoc-email';
export const EXPLORATION_SMOKE_EMAIL_DEAD_LETTER_QUEUE_NAME =
  'psd-eoc-email-dlq';
export const EXPLORATION_SMOKE_EMAIL_WORKER_LOG_GROUP_NAME =
  '/psd-eoc/workers/email';
export const EXPLORATION_SMOKE_SES_IDENTITY_DOMAIN = 'psd401.net';
export const EXPLORATION_SMOKE_SES_FROM_ADDRESS = 'eoc-alerts@psd401.net';
export const EXPLORATION_SMOKE_SES_VERIFICATION_REFERENCE = 'UNVERIFIED';
export const EXPLORATION_SMOKE_BOOTSTRAP_LOG_GROUP_NAME =
  '/psd-eoc/exploration-smoke/bootstrap';
export const DATABASE_SSL_ROOT_CERT =
  '/app/packages/server/certs/aws-rds-global-bundle.pem';

export const EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL = `sha256:${'0'.repeat(64)}`;
