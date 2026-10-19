import type { AgentGrantableCapabilityId } from '@psd-eoc/contracts';

/**
 * Per-key request budgets for the agent REST surface.
 *
 * The limiter is in-memory and per process. App Runner runs between two and
 * four instances of the server (`infra/src/stack/psd-eoc-stack.ts`), each
 * with its own limiter, so one key's effective ceiling is up to four times
 * each constant and a key refused on one instance may still be admitted on
 * another. That is deliberate: the budget bounds what one key can make one
 * instance do (the 2026-10-15 outage was an out-of-memory kill after request
 * bursts); it is not a precise meter. Restarting an instance resets its
 * windows.
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

interface SlidingWindow {
  /** Admission times (ms) still inside the window. */
  admitted: number[];
  /** Request kinds refused since the last admission. */
  readonly refused: Set<string>;
}

interface KeyWindows {
  readonly minute: SlidingWindow;
  readonly hour: SlidingWindow;
}

const ADMITTED: AgentRequestLimitDecision = Object.freeze({
  kind: 'admitted',
});

function validClock(nowValue: Date): number {
  const now = nowValue.getTime();
  if (!Number.isFinite(now)) {
    throw new TypeError('The agent request limiter requires a valid clock.');
  }
  return now;
}

function prune(window: SlidingWindow, cutoff: number): void {
  window.admitted = window.admitted.filter((timestamp) => timestamp > cutoff);
}

/**
 * Sliding-log decision for one window: admitted while fewer than the limit
 * of requests fall inside the trailing window. A refused request is not
 * counted, so a client that keeps retrying recovers as soon as the oldest
 * admitted request ages out rather than being locked out for as long as it
 * hammers.
 */
function decide(
  window: SlidingWindow,
  windowKind: AgentRequestLimitWindow,
  requestKind: string,
  limit: number,
  windowMs: number,
  now: number,
): AgentRequestLimitDecision {
  prune(window, now - windowMs);
  if (window.admitted.length < limit) {
    window.admitted.push(now);
    window.refused.clear();
    return ADMITTED;
  }
  const oldest = Math.min(...window.admitted);
  const firstRefusal = !window.refused.has(requestKind);
  window.refused.add(requestKind);
  return Object.freeze({
    kind: 'refused',
    window: windowKind,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((oldest + windowMs - now) / 1_000),
    ),
    firstRefusal,
  });
}

export function createAgentRequestLimiter(): AgentRequestLimiter {
  const keys = new Map<string, KeyWindows>();
  let sweptAt = Number.NEGATIVE_INFINITY;

  function windowsFor(apiKeyId: string, now: number): KeyWindows {
    if (now - sweptAt >= AGENT_RATE_LIMIT_HOUR_WINDOW_MS) {
      sweptAt = now;
      for (const [id, windows] of keys) {
        prune(windows.minute, now - AGENT_RATE_LIMIT_MINUTE_WINDOW_MS);
        prune(windows.hour, now - AGENT_RATE_LIMIT_HOUR_WINDOW_MS);
        if (
          windows.minute.admitted.length === 0 &&
          windows.hour.admitted.length === 0
        ) {
          keys.delete(id);
        }
      }
    }
    let windows = keys.get(apiKeyId);
    if (windows === undefined) {
      windows = {
        minute: { admitted: [], refused: new Set() },
        hour: { admitted: [], refused: new Set() },
      };
      keys.set(apiKeyId, windows);
    }
    return windows;
  }

  const limiter: AgentRequestLimiter = {
    admit(apiKeyId, nowValue, requestKind = 'request') {
      const now = validClock(nowValue);
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
      const now = validClock(nowValue);
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
