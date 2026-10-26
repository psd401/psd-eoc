/** Where a partner signs in, named once so the page and its route agree. */
export const PARTNER_SIGN_IN_PATH = '/partner-sign-in';

/** The partner sign-in form's POST target. */
export const PARTNER_SIGN_IN_ACTION = '/auth/partner';

/**
 * Everything the partner sign-in page can say.
 *
 * There is exactly one refusal. An address with no admission, an ended or
 * expired admission, a district address, a disabled account, and a wrong code
 * all show `refused`, because any difference between them would answer a
 * question about who has access to someone who does not.
 */
export const PARTNER_SIGN_IN_STATUSES = Object.freeze([
  'code-sent',
  'refused',
  'expired',
  'rate-limited',
  'unavailable',
] as const);

export type PartnerSignInStatus = (typeof PARTNER_SIGN_IN_STATUSES)[number];

export function isPartnerSignInStatus(
  value: unknown,
): value is PartnerSignInStatus {
  return (
    typeof value === 'string' &&
    (PARTNER_SIGN_IN_STATUSES as readonly string[]).includes(value)
  );
}

export const PARTNER_SIGN_IN_MESSAGES: Readonly<
  Record<PartnerSignInStatus, string>
> = Object.freeze({
  'code-sent':
    'If that address has partner access, a sign-in code is on its way. Enter it below.',
  refused:
    'That sign-in could not be completed. Check the address and the code, then try again.',
  expired: 'That sign-in code expired. Request a new one.',
  'rate-limited':
    'Too many sign-in attempts. Wait a few minutes before trying again.',
  unavailable:
    'Partner sign-in is temporarily unavailable. No session was created.',
});
