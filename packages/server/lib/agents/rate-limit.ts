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

export type AgentRequestLimitDecision =
  | Readonly<{ kind: 'admitted' }>
  | Readonly<{
      kind: 'refused';
      window: AgentRequestLimitWindow;
      /** Whole seconds until the oldest counted request leaves the window. */
      retryAfterSeconds: number;
    }>;

/** Decides, and when admitted records, one authenticated request. */
export interface AgentRequestLimiter {
  admit(
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
  /** Admission times (ms) of every request inside the minute window. */
  all: number[];
  /** Admission times (ms) of costly requests inside the hour window. */
  costly: number[];
}

const ADMITTED: AgentRequestLimitDecision = Object.freeze({
  kind: 'admitted',
});

function withinWindow(timestamps: number[], cutoff: number): number[] {
  return timestamps.filter((timestamp) => timestamp > cutoff);
}

function refusal(
  window: AgentRequestLimitWindow,
  timestamps: readonly number[],
  windowMs: number,
  now: number,
): AgentRequestLimitDecision {
  const oldest = Math.min(...timestamps);
  const retryAfterMs = oldest + windowMs - now;
  return Object.freeze({
    kind: 'refused',
    window,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
  });
}

/**
 * Sliding-log limiter: a key is admitted while fewer than the limit of its
 * requests fall inside the trailing window. A refused request is not counted,
 * so a client that keeps retrying recovers as soon as the oldest admitted
 * request ages out rather than being locked out for as long as it hammers.
 */
export function createAgentRequestLimiter(): AgentRequestLimiter {
  const keys = new Map<string, KeyWindows>();
  let sweptAt = Number.NEGATIVE_INFINITY;

  function sweep(now: number): void {
    if (now - sweptAt < AGENT_RATE_LIMIT_HOUR_WINDOW_MS) return;
    sweptAt = now;
    for (const [apiKeyId, windows] of keys) {
      windows.all = withinWindow(
        windows.all,
        now - AGENT_RATE_LIMIT_MINUTE_WINDOW_MS,
      );
      windows.costly = withinWindow(
        windows.costly,
        now - AGENT_RATE_LIMIT_HOUR_WINDOW_MS,
      );
      if (windows.all.length === 0 && windows.costly.length === 0) {
        keys.delete(apiKeyId);
      }
    }
  }

  const limiter: AgentRequestLimiter = {
    admit(apiKeyId, capabilityId, nowValue) {
      const now = nowValue.getTime();
      if (!Number.isFinite(now)) {
        throw new TypeError(
          'The agent request limiter requires a valid clock.',
        );
      }
      sweep(now);
      const windows = keys.get(apiKeyId) ?? { all: [], costly: [] };
      windows.all = withinWindow(
        windows.all,
        now - AGENT_RATE_LIMIT_MINUTE_WINDOW_MS,
      );
      windows.costly = withinWindow(
        windows.costly,
        now - AGENT_RATE_LIMIT_HOUR_WINDOW_MS,
      );
      const costly = costlyCapabilityIds.has(capabilityId);

      let decision: AgentRequestLimitDecision = ADMITTED;
      if (windows.all.length >= AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE) {
        decision = refusal(
          'per-minute',
          windows.all,
          AGENT_RATE_LIMIT_MINUTE_WINDOW_MS,
          now,
        );
      } else if (
        costly &&
        windows.costly.length >= AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR
      ) {
        decision = refusal(
          'per-hour',
          windows.costly,
          AGENT_RATE_LIMIT_HOUR_WINDOW_MS,
          now,
        );
      } else {
        windows.all.push(now);
        if (costly) windows.costly.push(now);
      }

      if (windows.all.length === 0 && windows.costly.length === 0) {
        keys.delete(apiKeyId);
      } else {
        keys.set(apiKeyId, windows);
      }
      return decision;
    },
  };
  return Object.freeze(limiter);
}
