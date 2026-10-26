const STATUS_MESSAGES = Object.freeze({
  'settings-saved': 'Partner alert settings were saved as a new version.',
} as const);

export interface PartnerAlertsSearchParameters {
  readonly status?: string | readonly string[];
}

/** Maps only one own allowlisted status key; repeats and prototypes are inert. */
export function partnerAlertsStatusMessage(
  value: string | readonly string[] | undefined,
): string | null {
  return typeof value === 'string' && Object.hasOwn(STATUS_MESSAGES, value)
    ? STATUS_MESSAGES[value as keyof typeof STATUS_MESSAGES]
    : null;
}
