const STATUS_MESSAGES = Object.freeze({
  'channel-updated': 'The notification channel configuration was updated.',
} as const);

export interface IntegrationsAdminSearchParameters {
  readonly status?: string | readonly string[];
}

/** Maps only one own allowlisted status key; repeats and prototypes are inert. */
export function integrationsAdminStatusMessage(
  value: string | readonly string[] | undefined,
): string | null {
  return typeof value === 'string' && Object.hasOwn(STATUS_MESSAGES, value)
    ? STATUS_MESSAGES[value as keyof typeof STATUS_MESSAGES]
    : null;
}
