/**
 * The sliding-log request budget shared by every in-process limiter.
 *
 * One window holds the admission times still inside it. A caller is admitted
 * while fewer than the limit fall inside the trailing window; a refused call
 * is never counted, so a client that keeps retrying recovers as soon as the
 * oldest admitted call ages out instead of being locked out for as long as it
 * hammers.
 *
 * Every limiter built on this is in-memory and per process. App Runner runs
 * between two and four instances of the server, each with its own windows, so
 * one caller's effective ceiling is up to four times each constant and a
 * caller refused on one instance may still be admitted on another. That is
 * deliberate: a budget bounds what one caller can make one instance do (the
 * 2026-10-15 outage was an out-of-memory kill after request bursts); it is
 * not a precise meter. Restarting an instance resets its windows.
 */

export interface SlidingWindow {
  /** Admission times (ms) still inside the window. */
  admitted: number[];
  /** Call kinds refused since the last admission. */
  readonly refused: Set<string>;
}

export type SlidingWindowDecision =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      /** Whole seconds until the oldest counted call leaves the window. */
      retryAfterSeconds: number;
      /**
       * True for the first refusal of this call kind since the caller was
       * last admitted, so a refusal can be audited once per lockout rather
       * than once per attempt.
       */
      firstRefusal: boolean;
    }>;

const ADMITTED: SlidingWindowDecision = Object.freeze({ admitted: true });

export function createSlidingWindow(): SlidingWindow {
  return { admitted: [], refused: new Set() };
}

export function pruneSlidingWindow(
  window: SlidingWindow,
  cutoff: number,
): void {
  window.admitted = window.admitted.filter((timestamp) => timestamp > cutoff);
}

export function isSlidingWindowEmpty(window: SlidingWindow): boolean {
  return window.admitted.length === 0;
}

/** Validates a clock the way every budget decision needs it validated. */
export function slidingWindowClock(nowValue: Date, subject: string): number {
  const now = nowValue.getTime();
  if (!Number.isFinite(now)) {
    throw new TypeError(`${subject} requires a valid clock.`);
  }
  return now;
}

/** Decides, and when admitted records, one call against one window. */
export function decideSlidingWindow(
  window: SlidingWindow,
  callKind: string,
  limit: number,
  windowMs: number,
  now: number,
): SlidingWindowDecision {
  pruneSlidingWindow(window, now - windowMs);
  if (window.admitted.length < limit) {
    window.admitted.push(now);
    window.refused.clear();
    return ADMITTED;
  }
  const oldest = Math.min(...window.admitted);
  const firstRefusal = !window.refused.has(callKind);
  window.refused.add(callKind);
  return Object.freeze({
    admitted: false as const,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((oldest + windowMs - now) / 1_000),
    ),
    firstRefusal,
  });
}
