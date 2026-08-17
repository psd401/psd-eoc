export const EXPLORATION_SMOKE_ACCOUNT_ALIAS = 'psd401';
export const EXPLORATION_SMOKE_ACCOUNT = '<aws-account-id>';
export const EXPLORATION_SMOKE_REGION = 'us-west-2';
export const EXPLORATION_SMOKE_STACK_NAME = 'PsdEocExplorationSmoke';

// Physical resource names remain stable while the deployed environment moves
// from synthetic exploration to a staff-only live pilot.
export const EXPLORATION_SMOKE_ENVIRONMENT = 'live-pilot';
export const EXPLORATION_SMOKE_DATA_CLASSIFICATION = 'staff-minimized';
export const EXPLORATION_SMOKE_DATABASE_NAME = 'psd_eoc';
export const EXPLORATION_SMOKE_DATABASE_IDENTIFIER =
  'psd-eoc-exploration-smoke';
export const EXPLORATION_SMOKE_DATABASE_PORT = 5_432;
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
export const EXPLORATION_SMOKE_DATABASE_SSL_ROOT_CERT =
  '/app/packages/server/certs/aws-rds-global-bundle.pem';

export const EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL = `sha256:${'0'.repeat(64)}`;
