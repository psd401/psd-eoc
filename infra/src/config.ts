export const STACK_NAME = 'PsdEoc';

export const APP_RUNNER_HEALTH_CHECK_PATH = '/api/health';
export const SES_CONFIGURATION_SET_NAME = 'psd-eoc-transactional';
export const SES_EVENT_DESTINATION_NAME = 'psd-eoc-email-events';
export const SES_EVENT_TOPIC_NAME = 'psd-eoc-email-events';
/**
 * Partner account mail's own configuration set (psd-dev-standards 17 rule 7).
 * Never the transactional set: its callback refuses mail without alert tags.
 * The environment segment matches the partner pool's `psd-eoc-production-
 * cognito` set in `infra/terraform/stateful`.
 */
export const SES_PARTNER_CONFIGURATION_SET_NAME = 'psd-eoc-production-partner';
export const SES_PARTNER_EVENT_DESTINATION_NAME = 'owner-alert';
export const SES_PARTNER_EVENT_TOPIC_NAME = `${SES_PARTNER_CONFIGURATION_SET_NAME}-email-events`;
export const SES_PARTNER_EVENT_TYPES = [
  'BOUNCE',
  'COMPLAINT',
  'REJECT',
] as const;
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
