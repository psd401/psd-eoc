import type { AgentGrantableCapabilityId } from '@psd-eoc/contracts';

import {
  createSlidingWindow,
  decideSlidingWindow,
  isSlidingWindowEmpty,
  pruneSlidingWindow,
  slidingWindowClock,
  type SlidingWindow,
} from '../http/sliding-window';

/**
 * Per-key request budgets for the agent REST surface.
 *
 * The budgets ride on the shared sliding-log window in
 * `lib/http/sliding-window.ts`, which documents why an in-process limiter is
 * the right bound here.
 *
 * The per-minute budget is charged as soon as the key is authenticated,
 * before the protected-action check, so a key looping on a human-only alias
 * is bounded like any other caller. The hourly budget for costly calls is
 * charged at dispatch, where the document is rendered or the row persisted:
 * a request refused for budget never reaches the capability. Charging at
 * dispatch also keeps the one-minute health canary clear of it, because the
 * canary authorizes `create-activation-preview` on a long-lived gateway but
 * executes it inside a per-run transactional gateway that is rolled back and
 * discarded.
 */
export const AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE = 60;
export const AGENT_RATE_LIMIT_MINUTE_WINDOW_MS = 60 * 1_000;

/** Calls that render a document or persist a row on every request. */
export const AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR = 20;
export const AGENT_RATE_LIMIT_HOUR_WINDOW_MS = 60 * 60 * 1_000;
export const AGENT_RATE_LIMIT_COSTLY_CAPABILITY_IDS = Object.freeze([
  'export-drill-records',
  'export-event-summary',
  'create-activation-preview',
] as const satisfies readonly AgentGrantableCapabilityId[]);

const costlyCapabilityIds = new Set<string>(
  AGENT_RATE_LIMIT_COSTLY_CAPABILITY_IDS,
);

export type AgentRequestLimitWindow = 'per-minute' | 'per-hour';

/**
 * What a refused request was trying to do. Refusals are audited once per
 * lockout and kind, so a refused protected-action attempt is always recorded
 * even when an ordinary read was refused first in the same lockout.
 */
export type AgentRequestKind = 'request' | 'protected-action';

export interface AgentRequestRefusal {
  readonly kind: 'refused';
  readonly window: AgentRequestLimitWindow;
  /** Whole seconds until the oldest counted request leaves the window. */
  readonly retryAfterSeconds: number;
  /**
   * True for the first refusal of this request kind since the key was last
   * admitted. The gateway audits only those, so a key that keeps sending past
   * its budget cannot grow the audit chain faster than its admitted budget.
   */
  readonly firstRefusal: boolean;
}

export type AgentRequestLimitDecision =
  Readonly<{ kind: 'admitted' }> | AgentRequestRefusal;

/** Decides, and when admitted records, one authenticated request. */
export interface AgentRequestLimiter {
  /** Per-minute budget, charged once the key is authenticated. */
  admit(
    apiKeyId: string,
    now: Date,
    requestKind?: AgentRequestKind,
  ): AgentRequestLimitDecision;
  /** Hourly costly budget, charged at dispatch; admits any other capability. */
  admitCostly(
    apiKeyId: string,
    capabilityId: AgentGrantableCapabilityId,
    now: Date,
  ): AgentRequestLimitDecision;
}

/** Public-safe refusal mapped to `429 RATE_LIMITED` by the REST layer. */
export class AgentGatewayRateLimitError extends Error {
  public readonly code = 'RATE_LIMITED' as const;
  public readonly status = 429 as const;
  public readonly retryable = true as const;
  public readonly reasonCode = 'RATE_LIMITED' as const;

  public constructor(
    public readonly window: AgentRequestLimitWindow,
    public readonly retryAfterSeconds: number,
  ) {
    super(
      window === 'per-minute'
        ? 'This agent key exceeded its request budget. Wait before retrying; nothing will retry automatically.'
        : 'This agent key exceeded its hourly budget for exports and activation previews. Wait before retrying; nothing will retry automatically.',
    );
    this.name = 'AgentGatewayRateLimitError';
  }
}

interface KeyWindows {
  readonly minute: SlidingWindow;
  readonly hour: SlidingWindow;
}

const ADMITTED: AgentRequestLimitDecision = Object.freeze({
  kind: 'admitted',
});

/** Restates one shared window decision in the agent limiter's vocabulary. */
function decide(
  window: SlidingWindow,
  windowKind: AgentRequestLimitWindow,
  requestKind: string,
  limit: number,
  windowMs: number,
  now: number,
): AgentRequestLimitDecision {
  const decision = decideSlidingWindow(
    window,
    requestKind,
    limit,
    windowMs,
    now,
  );
  return decision.admitted
    ? ADMITTED
    : Object.freeze({
        kind: 'refused' as const,
        window: windowKind,
        retryAfterSeconds: decision.retryAfterSeconds,
        firstRefusal: decision.firstRefusal,
      });
}

export function createAgentRequestLimiter(): AgentRequestLimiter {
  const keys = new Map<string, KeyWindows>();
  let sweptAt = Number.NEGATIVE_INFINITY;

  function windowsFor(apiKeyId: string, now: number): KeyWindows {
    if (now - sweptAt >= AGENT_RATE_LIMIT_HOUR_WINDOW_MS) {
      sweptAt = now;
      for (const [id, windows] of keys) {
        pruneSlidingWindow(
          windows.minute,
          now - AGENT_RATE_LIMIT_MINUTE_WINDOW_MS,
        );
        pruneSlidingWindow(windows.hour, now - AGENT_RATE_LIMIT_HOUR_WINDOW_MS);
        if (
          isSlidingWindowEmpty(windows.minute) &&
          isSlidingWindowEmpty(windows.hour)
        ) {
          keys.delete(id);
        }
      }
    }
    let windows = keys.get(apiKeyId);
    if (windows === undefined) {
      windows = {
        minute: createSlidingWindow(),
        hour: createSlidingWindow(),
      };
      keys.set(apiKeyId, windows);
    }
    return windows;
  }

  const limiter: AgentRequestLimiter = {
    admit(apiKeyId, nowValue, requestKind = 'request') {
      const now = slidingWindowClock(nowValue, 'The agent request limiter');
      return decide(
        windowsFor(apiKeyId, now).minute,
        'per-minute',
        requestKind,
        AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
        AGENT_RATE_LIMIT_MINUTE_WINDOW_MS,
        now,
      );
    },
    admitCostly(apiKeyId, capabilityId, nowValue) {
      const now = slidingWindowClock(nowValue, 'The agent request limiter');
      if (!costlyCapabilityIds.has(capabilityId)) return ADMITTED;
      return decide(
        windowsFor(apiKeyId, now).hour,
        'per-hour',
        'costly',
        AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR,
        AGENT_RATE_LIMIT_HOUR_WINDOW_MS,
        now,
      );
    },
  };
  return Object.freeze(limiter);
}
