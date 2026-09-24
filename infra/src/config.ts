export const STACK_NAME = 'PsdEoc';

export const APP_RUNNER_HEALTH_CHECK_PATH = '/api/health';
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
