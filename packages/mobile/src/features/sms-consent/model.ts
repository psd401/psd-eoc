import {
  normalizeNorthAmericanMobileNumber,
  type SmsConsentState,
} from '@psd-eoc/contracts';

export type SmsConsentSubmission =
  | Readonly<{ kind: 'ready'; phoneNumber: string }>
  | Readonly<{ kind: 'blocked'; message: string }>;

/**
 * Decides whether a typed number and an agreement box can be submitted.
 *
 * Kept out of the screen so the rules that matter -- an unticked box is never
 * consent, and a number is stored in exactly one form -- are provable without
 * mounting React or a device.
 */
export function resolveSmsConsentSubmission(
  input: Readonly<{ typedNumber: string; agreed: boolean }>,
): SmsConsentSubmission {
  if (!input.agreed) {
    return {
      kind: 'blocked',
      message: 'Tick the box to agree before signing up for texts.',
    };
  }
  const phoneNumber = normalizeNorthAmericanMobileNumber(input.typedNumber);
  if (phoneNumber === null) {
    return {
      kind: 'blocked',
      // Never repeats what was typed: this string is rendered on screen and
      // read by the screen reader, and the typed value is a real number.
      message: 'Enter a US mobile number, for example (253) 555-0123.',
    };
  }
  return { kind: 'ready', phoneNumber };
}

/** The one-line summary the screen shows above the form. */
export function smsConsentSummary(consent: SmsConsentState): string {
  return consent.status === 'consented'
    ? `Emergency texts go to the number ending in ${consent.lastFourDigits}.`
    : 'You are not signed up for emergency texts. You will still get email and app notifications.';
}
