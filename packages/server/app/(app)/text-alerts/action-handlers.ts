import {
  normalizeNorthAmericanMobileNumber,
  RecordSmsConsentInputSchema,
  WithdrawSmsConsentInputSchema,
  type SmsConsentReceipt,
  type SmsConsentWithdrawalReceipt,
} from '@psd-eoc/contracts';

import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import type { TextAlertsState } from './text-alerts-view';

/** Everything the handlers touch, so a test needs no session or database. */
export interface TextAlertsActionDependencies {
  recordConsent(input: {
    readonly phoneNumber: string;
    readonly disclosureVersion: string;
    readonly idempotencyKey: string;
  }): Promise<SmsConsentReceipt>;
  withdrawConsent(input: {
    readonly idempotencyKey: string;
  }): Promise<SmsConsentWithdrawalReceipt>;
  createIdempotencyKey(): string;
  revalidate(): void;
}

/**
 * Never repeats the submitted number back to the browser.
 *
 * The failure path is the one most likely to be screenshotted into a ticket,
 * and a rejected form still holds a real mobile number.
 */
function failure(
  dependencies: TextAlertsActionDependencies,
  message: string,
): TextAlertsState {
  return {
    notice: { kind: 'error', message },
    // A fresh key: the previous submission never reached a capability, so
    // reusing its key would make the retry look like a replay of nothing.
    idempotencyKey: dependencies.createIdempotencyKey(),
  };
}

function engineMessage(error: unknown, fallback: string): string {
  return error instanceof CapabilityEngineError ? error.message : fallback;
}

/** Validates the form, then records consent for the authenticated caller. */
export async function handleRecordSmsConsentAction(
  previousState: TextAlertsState,
  formData: FormData,
  dependencies: TextAlertsActionDependencies,
): Promise<TextAlertsState> {
  const rawNumber = formData.get('phoneNumber');
  const disclosureVersion = formData.get('disclosureVersion');
  // A checkbox absent from the payload is an unticked box, which is the whole
  // point of the control: only a literal true is consent.
  const agreed = formData.get('agreed') === 'yes';
  if (typeof rawNumber !== 'string' || typeof disclosureVersion !== 'string') {
    return failure(dependencies, 'The form was incomplete. Try again.');
  }
  if (!agreed) {
    return failure(
      dependencies,
      'Tick the box to agree before signing up for texts.',
    );
  }
  const phoneNumber = normalizeNorthAmericanMobileNumber(rawNumber);
  if (phoneNumber === null) {
    return failure(
      dependencies,
      'Enter a US mobile number, for example (253) 555-0123.',
    );
  }
  const parsed = RecordSmsConsentInputSchema.safeParse({
    phoneNumber,
    disclosureVersion,
    agreed: true,
  });
  if (!parsed.success) {
    return failure(dependencies, 'Enter a US mobile number that can text.');
  }
  try {
    await dependencies.recordConsent({
      phoneNumber: parsed.data.phoneNumber,
      disclosureVersion: parsed.data.disclosureVersion,
      idempotencyKey: previousState.idempotencyKey,
    });
  } catch (error) {
    return failure(
      dependencies,
      engineMessage(error, 'The number could not be saved. Try again.'),
    );
  }
  dependencies.revalidate();
  return {
    notice: {
      kind: 'success',
      message: 'Saved. You will get emergency texts at this number.',
    },
    idempotencyKey: dependencies.createIdempotencyKey(),
  };
}

/** Withdraws the caller's live consent; the record survives as evidence. */
export async function handleWithdrawSmsConsentAction(
  previousState: TextAlertsState,
  _formData: FormData,
  dependencies: TextAlertsActionDependencies,
): Promise<TextAlertsState> {
  WithdrawSmsConsentInputSchema.parse({});
  try {
    await dependencies.withdrawConsent({
      idempotencyKey: previousState.idempotencyKey,
    });
  } catch (error) {
    return failure(
      dependencies,
      engineMessage(error, 'The change could not be saved. Try again.'),
    );
  }
  dependencies.revalidate();
  return {
    notice: {
      kind: 'success',
      message: 'Stopped. PSD EOC will no longer text you.',
    },
    idempotencyKey: dependencies.createIdempotencyKey(),
  };
}
