'use server';

import { randomUUID } from 'node:crypto';

import {
  ReadMySmsConsentInputSchema,
  RecordSmsConsentInputSchema,
  WithdrawSmsConsentInputSchema,
  type SmsConsentReceipt,
  type SmsConsentWithdrawalReceipt,
} from '@psd-eoc/contracts';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { authenticateWebSession } from '../../../lib/auth/request-session';
import { WEB_SESSION_COOKIE_NAME } from '../../../lib/auth/sessions';
import { executeSmsConsentForSession } from '../../../lib/capabilities/sms-consent';
import {
  handleRecordSmsConsentAction,
  handleWithdrawSmsConsentAction,
  type TextAlertsActionDependencies,
} from './action-handlers';
import type { TextAlertsState } from './text-alerts-view';

export const TEXT_ALERTS_PATH = '/text-alerts';

async function authenticateTextAlertsSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required&returnTo=%2Ftext-alerts');
  }
  try {
    return await authenticateWebSession(token);
  } catch {
    redirect('/login?reason=session-expired&returnTo=%2Ftext-alerts');
  }
}

function bestEffortRevalidate(): void {
  try {
    revalidatePath(TEXT_ALERTS_PATH);
  } catch {
    // A revalidation failure must not lose a recorded consent. The page reads
    // current state on its next render regardless.
  }
}

async function textAlertsDependencies(): Promise<TextAlertsActionDependencies> {
  const authenticated = await authenticateTextAlertsSession();
  return {
    async recordConsent(input): Promise<SmsConsentReceipt> {
      return executeSmsConsentForSession({
        authenticated,
        capabilityId: 'record-sms-consent',
        command: RecordSmsConsentInputSchema.parse({
          phoneNumber: input.phoneNumber,
          disclosureVersion: input.disclosureVersion,
          agreed: true,
        }),
        metadata: { idempotencyKey: input.idempotencyKey },
      });
    },
    async withdrawConsent(input): Promise<SmsConsentWithdrawalReceipt> {
      return executeSmsConsentForSession({
        authenticated,
        capabilityId: 'withdraw-sms-consent',
        command: WithdrawSmsConsentInputSchema.parse({}),
        metadata: { idempotencyKey: input.idempotencyKey },
      });
    },
    createIdempotencyKey: randomUUID,
    revalidate: bestEffortRevalidate,
  };
}

/** Reads the signed-in staff member's own consent for the page render. */
export async function readMySmsConsentForPage() {
  const authenticated = await authenticateTextAlertsSession();
  return executeSmsConsentForSession({
    authenticated,
    capabilityId: 'read-my-sms-consent',
    command: ReadMySmsConsentInputSchema.parse({}),
  });
}

/** POST-backed affirmative consent. */
export async function recordSmsConsentAction(
  previousState: TextAlertsState,
  formData: FormData,
): Promise<TextAlertsState> {
  return handleRecordSmsConsentAction(
    previousState,
    formData,
    await textAlertsDependencies(),
  );
}

/** POST-backed withdrawal. The consent row survives as carrier evidence. */
export async function withdrawSmsConsentAction(
  previousState: TextAlertsState,
  formData: FormData,
): Promise<TextAlertsState> {
  return handleWithdrawSmsConsentAction(
    previousState,
    formData,
    await textAlertsDependencies(),
  );
}
