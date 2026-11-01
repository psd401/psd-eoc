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
 * Every passkey attempt has its own budget, separate from the code's (#599).
 *
 * This is not tidiness. A budget keyed to an address is something anyone who
 * knows that address can spend, because an attempt is charged before it is
 * known to be genuine — that is what makes it a budget. So a shared budget
 * would mean anyone who knows a partner's address could exhaust it with
 * rejected passkey assertions and leave that partner unable to sign in with
 * an emailed code either. In an emergency tool the code is the fallback that
 * must survive everything, so the two factors never spend each other's
 * allowance: burning the passkey budget costs a partner their passkey for a
 * quarter of an hour and nothing else.
 *
 * Starting a passkey sign-in asks the pool what a partner could use, which
 * is documented to send nothing, so it must not spend the budget that bounds
 * how much a partner's inbox can be made to receive: a passkey attempt that
 * fell back to a code would otherwise cost two sends and halve the real
 * budget. Documented, not proved — this has never run against a real pool.
 * So the provider reports when the pool mailed anyway: the send budget is
 * charged for that mail even past its limit, and once a pool has been seen
 * doing it, a probe for an address with no send left stops asking the pool
 * at all. Recording a send does not un-send it; not asking again is what
 * bounds the mail.
 *
 * Enrolling needs a budget for a different reason. It is already behind the
 * sealed hand-off from a completed sign-in, so it is not anonymous, but each
 * attempt is still a call to the pool and nothing else bounds how many a
 * script could make inside the hand-off's ten minutes. One enrollment spends
 * two of it, because a ceremony is two calls, so the budget is twice the
 * number of attempts a partner is actually allowed: cancelling the device
 * prompt and trying again is ordinary, not abuse.
 */
export const PARTNER_PASSKEY_STARTS_PER_EMAIL = 10;
export const PARTNER_PASSKEY_STARTS_PER_CLIENT = 40;
export const PARTNER_PASSKEY_VERIFIES_PER_EMAIL = 10;
export const PARTNER_PASSKEY_VERIFIES_PER_CLIENT = 40;
export const PARTNER_PASSKEY_REGISTRATIONS_PER_EMAIL = 20;
export const PARTNER_PASSKEY_REGISTRATIONS_PER_CLIENT = 60;
export const PARTNER_OTP_WINDOW_MS = WINDOW_MS;

export type PartnerOtpAttemptKind =
  'send' | 'verify' | 'passkey-start' | 'passkey-verify' | 'passkey-register';

export type PartnerOtpLimitDecision =
  | Readonly<{ admitted: true }>
  | Readonly<{ admitted: false; retryAfterSeconds: number }>;

export interface PartnerOtpAttempt {
  readonly kind: PartnerOtpAttemptKind;
  readonly email: string;
  readonly client: string | null;
}

export interface PartnerOtpLimiter {
  /**
   * Charges one attempt against both budgets. `client` is the caller's
   * address as the server resolved it, which may be absent behind a proxy
   * that does not say; an absent client still charges the shared bucket, so
   * it is never a way to escape the per-client budget.
   */
  admit(input: PartnerOtpAttempt, now: Date): PartnerOtpLimitDecision;
  /** Whether an attempt would be admitted, charging nothing either way. */
  allows(input: PartnerOtpAttempt, now: Date): boolean;
  /**
   * Records an attempt that has already happened, full window or not.
   *
   * `admit` charges nothing once a budget is spent, because by then it is
   * refusing. Something that cannot be refused — mail a provider has already
   * sent — must be counted anyway, or the budget stops describing what
   * actually reached the person it exists to protect.
   */
  charge(input: PartnerOtpAttempt, now: Date): void;
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

  const PER_EMAIL: Readonly<Record<PartnerOtpAttemptKind, number>> = {
    send: PARTNER_OTP_SENDS_PER_EMAIL,
    verify: PARTNER_OTP_VERIFIES_PER_EMAIL,
    'passkey-start': PARTNER_PASSKEY_STARTS_PER_EMAIL,
    'passkey-verify': PARTNER_PASSKEY_VERIFIES_PER_EMAIL,
    'passkey-register': PARTNER_PASSKEY_REGISTRATIONS_PER_EMAIL,
  };
  const PER_CLIENT: Readonly<Record<PartnerOtpAttemptKind, number>> = {
    send: PARTNER_OTP_SENDS_PER_CLIENT,
    verify: PARTNER_OTP_VERIFIES_PER_CLIENT,
    'passkey-start': PARTNER_PASSKEY_STARTS_PER_CLIENT,
    'passkey-verify': PARTNER_PASSKEY_VERIFIES_PER_CLIENT,
    'passkey-register': PARTNER_PASSKEY_REGISTRATIONS_PER_CLIENT,
  };

  /** The two windows one attempt is measured against, with their limits. */
  function budgetsFor(
    input: PartnerOtpAttempt,
    now: number,
  ): readonly Readonly<{ window: SlidingWindow; limit: number }>[] {
    const email = input.email.trim().toLowerCase();
    const client = input.client?.trim() ?? '';
    return [
      {
        window: windowFor(keyDigest(`email-${input.kind}`, email), now),
        limit: PER_EMAIL[input.kind],
      },
      {
        window: windowFor(keyDigest(`client-${input.kind}`, client), now),
        limit: PER_CLIENT[input.kind],
      },
    ];
  }

  /** The first budget with no room left, after pruning both. */
  function exhaustedBudget(
    budgets: readonly Readonly<{ window: SlidingWindow; limit: number }>[],
    now: number,
  ): Readonly<{ window: SlidingWindow; limit: number }> | undefined {
    return budgets.find((budget) => {
      pruneSlidingWindow(budget.window, now - WINDOW_MS);
      return budget.window.admitted.length >= budget.limit;
    });
  }

  const limiter: PartnerOtpLimiter = {
    admit(input, nowValue): PartnerOtpLimitDecision {
      const now = slidingWindowClock(nowValue, 'The partner sign-in limiter');
      // Both budgets are decided before either is charged, so a refusal on
      // one does not spend the other's allowance.
      const budgets = budgetsFor(input, now);
      const exhausted = exhaustedBudget(budgets, now);
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
      for (const budget of budgets) {
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

    allows(input, nowValue): boolean {
      const now = slidingWindowClock(nowValue, 'The partner sign-in limiter');
      return exhaustedBudget(budgetsFor(input, now), now) === undefined;
    },

    charge(input, nowValue): void {
      const now = slidingWindowClock(nowValue, 'The partner sign-in limiter');
      for (const budget of budgetsFor(input, now)) {
        pruneSlidingWindow(budget.window, now - WINDOW_MS);
        // Past the limit on purpose: this records something that already
        // happened, so the window has to carry it whether there was room or
        // not. A window over its limit simply refuses everything until the
        // entries age out, which is the intended effect.
        budget.window.admitted.push(now);
      }
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
