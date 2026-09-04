import {
  MySmsConsentViewSchema,
  RecordSmsConsentInputSchema,
  SmsConsentReceiptSchema,
  SmsConsentWithdrawalReceiptSchema,
  WithdrawSmsConsentInputSchema,
  type MySmsConsentView,
  type SmsConsentReceipt,
  type SmsConsentWithdrawalReceipt,
} from '@psd-eoc/contracts';

import type { JsonResponseSchema, RequestAuthenticated } from '../../lib/api';
import { parseIgnoringNewServerFields } from '../../lib/api/forward-compatible-parse';

function schema<Output>(
  parse: (value: unknown) => Output,
): JsonResponseSchema<Output> {
  return Object.freeze({ parse });
}

const consentViewSchema = schema<MySmsConsentView>((value) =>
  parseIgnoringNewServerFields(MySmsConsentViewSchema, value),
);

const consentReceiptSchema = schema<SmsConsentReceipt>((value) =>
  parseIgnoringNewServerFields(SmsConsentReceiptSchema, value),
);

const withdrawalReceiptSchema = schema<SmsConsentWithdrawalReceipt>((value) =>
  parseIgnoringNewServerFields(SmsConsentWithdrawalReceiptSchema, value),
);

/**
 * Reads the caller's own consent and the disclosure to render with it.
 *
 * The disclosure comes from the server so this app never carries its own copy
 * of district configuration, and the text a carrier sees in a screenshot is
 * the text the server would show on the web.
 */
export function readMySmsConsent(
  requestAuthenticated: RequestAuthenticated,
  signal?: AbortSignal,
): Promise<MySmsConsentView> {
  return requestAuthenticated({
    method: 'GET',
    path: '/api/sms-consent',
    schema: consentViewSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Records consent for a number the staff member typed on this device.
 *
 * The caller supplies the already-normalized E.164 number and the version of
 * the disclosure it actually rendered, so the stored evidence names the text
 * this device showed rather than whatever the current build would show.
 */
export function recordSmsConsent(
  requestAuthenticated: RequestAuthenticated,
  input: Readonly<{
    phoneNumber: string;
    disclosureVersion: string;
    idempotencyKey: string;
  }>,
): Promise<SmsConsentReceipt> {
  return requestAuthenticated({
    method: 'POST',
    path: '/api/sms-consent',
    body: RecordSmsConsentInputSchema.parse({
      phoneNumber: input.phoneNumber,
      disclosureVersion: input.disclosureVersion,
      agreed: true,
    }),
    idempotencyKey: input.idempotencyKey,
    schema: consentReceiptSchema,
  });
}

/** Withdraws the live consent. The record survives as carrier evidence. */
export function withdrawSmsConsent(
  requestAuthenticated: RequestAuthenticated,
  input: Readonly<{ idempotencyKey: string }>,
): Promise<SmsConsentWithdrawalReceipt> {
  return requestAuthenticated({
    method: 'POST',
    path: '/api/sms-consent/withdraw',
    body: WithdrawSmsConsentInputSchema.parse({}),
    idempotencyKey: input.idempotencyKey,
    schema: withdrawalReceiptSchema,
  });
}
