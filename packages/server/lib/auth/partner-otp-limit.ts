import { createHash } from 'node:crypto';

import {
  createSlidingWindow,
  decideSlidingWindow,
  isSlidingWindowEmpty,
  pruneSlidingWindow,
  slidingWindowClock,
  type SlidingWindow,
} from '../http/sliding-window';

/**
 * Budgets for the partner sign-in form, on the same sliding-log window the
 * agent REST surface uses.
 *
 * Two budgets are charged for every attempt, and both must admit it. The
 * per-address budget bounds how much mail one partner's inbox can be made to
 * receive and how many codes can be guessed against one account; the
 * per-client budget bounds how many addresses one caller can work through.
 * Charging both means neither a single address nor a single caller can be
 * the cheap way around the other.
 *
 * Addresses are held as digests, never in plain text: this map lives for the
 * life of the process and a partner address is personal data.
 */

const WINDOW_MS = 15 * 60 * 1_000;

export const PARTNER_OTP_SENDS_PER_EMAIL = 5;
export const PARTNER_OTP_VERIFIES_PER_EMAIL = 10;
export const PARTNER_OTP_SENDS_PER_CLIENT = 20;
export const PARTNER_OTP_VERIFIES_PER_CLIENT = 40;
/**
 * Asking whether an address can use a passkey has its own budget (#599).
 *
 * It sends no mail, so it must not spend the budget that bounds how much a
 * partner's inbox can be made to receive: a passkey attempt that ends up
 * falling back to a code would otherwise cost two sends and halve the real
 * budget. It still needs a budget of its own, because each one is a call to
 * the pool. It is the more generous of the two, because the normal case is a
 * partner signing in without ever sending mail.
 */
export const PARTNER_PASSKEY_STARTS_PER_EMAIL = 10;
export const PARTNER_PASSKEY_STARTS_PER_CLIENT = 40;
export const PARTNER_OTP_WINDOW_MS = WINDOW_MS;

export type PartnerOtpAttemptKind = 'send' | 'verify' | 'passkey-start';

export type PartnerOtpLimitDecision =
  | Readonly<{ admitted: true }>
  | Readonly<{ admitted: false; retryAfterSeconds: number }>;

export interface PartnerOtpLimiter {
  /**
   * Charges one attempt against both budgets. `client` is the caller's
   * address as the server resolved it, which may be absent behind a proxy
   * that does not say; an absent client still charges the shared bucket, so
   * it is never a way to escape the per-client budget.
   */
  admit(
    input: Readonly<{
      kind: PartnerOtpAttemptKind;
      email: string;
      client: string | null;
    }>,
    now: Date,
  ): PartnerOtpLimitDecision;
}

function keyDigest(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function createPartnerOtpLimiter(): PartnerOtpLimiter {
  const windows = new Map<string, SlidingWindow>();
  let sweptAt = Number.NEGATIVE_INFINITY;

  function windowFor(key: string, now: number): SlidingWindow {
    if (now - sweptAt >= WINDOW_MS) {
      sweptAt = now;
      for (const [existingKey, window] of windows) {
        pruneSlidingWindow(window, now - WINDOW_MS);
        if (isSlidingWindowEmpty(window)) {
          windows.delete(existingKey);
        }
      }
    }
    let window = windows.get(key);
    if (window === undefined) {
      window = createSlidingWindow();
      windows.set(key, window);
    }
    return window;
  }

  const limiter: PartnerOtpLimiter = {
    admit(input, nowValue): PartnerOtpLimitDecision {
      const now = slidingWindowClock(nowValue, 'The partner sign-in limiter');
      const email = input.email.trim().toLowerCase();
      const client = input.client?.trim() ?? '';
      // Both budgets are decided before either is charged, so a refusal on
      // one does not spend the other's allowance.
      const perEmail: Readonly<Record<PartnerOtpAttemptKind, number>> = {
        send: PARTNER_OTP_SENDS_PER_EMAIL,
        verify: PARTNER_OTP_VERIFIES_PER_EMAIL,
        'passkey-start': PARTNER_PASSKEY_STARTS_PER_EMAIL,
      };
      const perClient: Readonly<Record<PartnerOtpAttemptKind, number>> = {
        send: PARTNER_OTP_SENDS_PER_CLIENT,
        verify: PARTNER_OTP_VERIFIES_PER_CLIENT,
        'passkey-start': PARTNER_PASSKEY_STARTS_PER_CLIENT,
      };
      const budgets = [
        {
          key: keyDigest(`email-${input.kind}`, email),
          limit: perEmail[input.kind],
        },
        {
          key: keyDigest(`client-${input.kind}`, client),
          limit: perClient[input.kind],
        },
      ] as const;
      const windowsToCharge = budgets.map((budget) => ({
        window: windowFor(budget.key, now),
        limit: budget.limit,
      }));
      const exhausted = windowsToCharge.find((budget) => {
        pruneSlidingWindow(budget.window, now - WINDOW_MS);
        return budget.window.admitted.length >= budget.limit;
      });
      if (exhausted !== undefined) {
        return Object.freeze({
          admitted: false as const,
          // The window was found full at this same instant, so the wait is
          // until its oldest counted call leaves it.
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (Math.min(...exhausted.window.admitted) + WINDOW_MS - now) /
                1_000,
            ),
          ),
        });
      }
      for (const budget of windowsToCharge) {
        decideSlidingWindow(
          budget.window,
          input.kind,
          budget.limit,
          WINDOW_MS,
          now,
        );
      }
      return Object.freeze({ admitted: true as const });
    },
  };
  return Object.freeze(limiter);
}

let processLimiter: PartnerOtpLimiter | null = null;

/** The one limiter this server process charges partner attempts against. */
export function getPartnerOtpLimiter(): PartnerOtpLimiter {
  processLimiter ??= createPartnerOtpLimiter();
  return processLimiter;
}
