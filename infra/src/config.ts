export const DEPLOYMENT_ACCOUNT = '<aws-account-id>';
export const DEPLOYMENT_REGION = 'us-west-2';
export const STACK_NAME = 'PsdEoc';

export const APP_RUNNER_HEALTH_CHECK_PATH = '/api/health';
export const SES_IDENTITY_DOMAIN = 'alerts.psd401.net';
export const SES_PARENT_HOSTED_ZONE_ID = 'Z2B9XR5HEMTG1R';
export const SES_PARENT_HOSTED_ZONE_NAME = 'psd401.net';
export const SES_MAIL_FROM_DOMAIN = `mail.${SES_IDENTITY_DOMAIN}`;
export const SES_CONFIGURATION_SET_NAME = 'psd-eoc-transactional';
export const SES_EVENT_DESTINATION_NAME = 'psd-eoc-email-events';
export const SES_EVENT_TOPIC_NAME = 'psd-eoc-email-events';
export const SES_EVENT_TYPES = [
  'SEND',
  'DELIVERY',
  'BOUNCE',
  'COMPLAINT',
  'REJECT',
  'RENDERING_FAILURE',
  'DELIVERY_DELAY',
] as const;

export const GITHUB_OWNER_ID = '1902994';
export const GITHUB_REPOSITORY = 'psd401/psd-eoc';
export const GITHUB_REPOSITORY_ID = '1326178900';
export const GITHUB_MAIN_REF = 'refs/heads/main';
export const GITHUB_OIDC_ISSUER = 'token.actions.githubusercontent.com';
export const GITHUB_DEPLOY_JOB_WORKFLOW_REF =
  'psd401/psd-eoc/.github/workflows/deploy-infrastructure.yml@refs/heads/main';
// GitHub's live repository OIDC settings report this immutable default prefix.
// Repositories created after July 15, 2026 include owner and repository IDs.
export const GITHUB_OIDC_SUBJECT =
  'repo:psd401@1902994/psd-eoc@1326178900:ref:refs/heads/main';

export const NOTIFICATION_CHANNELS = ['push', 'email', 'sms'] as const;
