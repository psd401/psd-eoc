export const DEPLOYMENT_ACCOUNT = '338414773271';
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

export const NOTIFICATION_CHANNELS = ['push', 'email', 'sms'] as const;
