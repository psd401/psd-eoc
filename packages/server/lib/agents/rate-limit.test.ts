import { describe, expect, test } from 'bun:test';

import {
  AGENT_RATE_LIMIT_COSTLY_CAPABILITY_IDS,
  AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR,
  AGENT_RATE_LIMIT_HOUR_WINDOW_MS,
  AGENT_RATE_LIMIT_MINUTE_WINDOW_MS,
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
  AgentGatewayRateLimitError,
  createAgentRequestLimiter,
} from './rate-limit';

const KEYS = Object.freeze({
  first: '00000000-0000-4000-8000-000000000601',
  second: '00000000-0000-4000-8000-000000000602',
});

const START = Date.parse('2026-10-18T18:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(START + offsetMs);
}

describe('agent request limiter', () => {
  test('admits the per-minute budget and refuses the next request until the oldest ages out', () => {
    const limiter = createAgentRequestLimiter();

    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      index += 1
    ) {
      expect(limiter.admit(KEYS.first, at(index * 100))).toEqual({
        kind: 'admitted',
      });
    }

    expect(limiter.admit(KEYS.first, at(6_000))).toEqual({
      kind: 'refused',
      window: 'per-minute',
      retryAfterSeconds: 54,
      firstRefusal: true,
    });

    // Hammering while refused does not extend the lockout: the first request
    // ages out exactly one window after it was admitted.
    expect(limiter.admit(KEYS.first, at(59_999)).kind).toBe('refused');
    expect(
      limiter.admit(KEYS.first, at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS)),
    ).toEqual({ kind: 'admitted' });
    expect(
      limiter.admit(KEYS.first, at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS + 1)).kind,
    ).toBe('refused');
  });

  test('flags only the first refusal of each lockout', () => {
    const limiter = createAgentRequestLimiter();
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      index += 1
    ) {
      limiter.admit(KEYS.first, at(0));
    }
    expect(limiter.admit(KEYS.first, at(1))).toMatchObject({
      kind: 'refused',
      firstRefusal: true,
    });
    expect(limiter.admit(KEYS.first, at(2))).toMatchObject({
      kind: 'refused',
      firstRefusal: false,
    });
    expect(limiter.admit(KEYS.first, at(3))).toMatchObject({
      kind: 'refused',
      firstRefusal: false,
    });

    // After the window the budget refills; the next lockout is a fresh one.
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      index += 1
    ) {
      expect(
        limiter.admit(KEYS.first, at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS)).kind,
      ).toBe('admitted');
    }
    expect(
      limiter.admit(KEYS.first, at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS)),
    ).toMatchObject({ kind: 'refused', firstRefusal: true });
  });

  test('reports at least one second so Retry-After is never zero', () => {
    const limiter = createAgentRequestLimiter();
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      index += 1
    ) {
      limiter.admit(KEYS.first, at(0));
    }
    expect(
      limiter.admit(KEYS.first, at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS - 1)),
    ).toMatchObject({
      kind: 'refused',
      window: 'per-minute',
      retryAfterSeconds: 1,
    });
  });

  test('caps costly calls per hour for one key without touching another key', () => {
    for (const capabilityId of AGENT_RATE_LIMIT_COSTLY_CAPABILITY_IDS) {
      const scoped = createAgentRequestLimiter();
      for (
        let index = 0;
        index < AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
        index += 1
      ) {
        expect(
          scoped.admitCostly(KEYS.first, capabilityId, at(index * 120_000))
            .kind,
        ).toBe('admitted');
      }
      expect(
        scoped.admitCostly(
          KEYS.first,
          capabilityId,
          at(AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR * 120_000),
        ),
      ).toEqual({
        kind: 'refused',
        window: 'per-hour',
        retryAfterSeconds:
          (AGENT_RATE_LIMIT_HOUR_WINDOW_MS -
            AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR * 120_000) /
          1_000,
        firstRefusal: true,
      });
    }

    const limiter = createAgentRequestLimiter();
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
      index += 1
    ) {
      limiter.admitCostly(
        KEYS.first,
        'export-event-summary',
        at(index * 1_000),
      );
    }
    expect(
      limiter.admitCostly(KEYS.first, 'export-drill-records', at(30_000)),
    ).toMatchObject({ kind: 'refused', firstRefusal: true });
    expect(
      limiter.admitCostly(KEYS.first, 'export-event-summary', at(31_000)),
    ).toMatchObject({ kind: 'refused', firstRefusal: false });
    expect(
      limiter.admitCostly(KEYS.second, 'export-event-summary', at(30_000)),
    ).toEqual({ kind: 'admitted' });
  });

  test('admits ordinary capabilities at dispatch without counting them', () => {
    const limiter = createAgentRequestLimiter();
    for (let index = 0; index < 500; index += 1) {
      expect(
        limiter.admitCostly(KEYS.first, 'list-active-events', at(0)),
      ).toEqual({ kind: 'admitted' });
    }
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
      index += 1
    ) {
      expect(
        limiter.admitCostly(KEYS.first, 'create-activation-preview', at(0))
          .kind,
      ).toBe('admitted');
    }
    expect(
      limiter.admitCostly(KEYS.first, 'create-activation-preview', at(0)).kind,
    ).toBe('refused');
  });

  test('keeps the two budgets independent', () => {
    const limiter = createAgentRequestLimiter();
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      index += 1
    ) {
      limiter.admit(KEYS.first, at(0));
    }
    expect(limiter.admit(KEYS.first, at(0)).kind).toBe('refused');
    expect(
      limiter.admitCostly(KEYS.first, 'export-event-summary', at(0)),
    ).toEqual({ kind: 'admitted' });
  });

  test('releases the hourly budget one window after the oldest costly call', () => {
    const limiter = createAgentRequestLimiter();
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
      index += 1
    ) {
      limiter.admitCostly(
        KEYS.first,
        'create-activation-preview',
        at(index * 1_000),
      );
    }
    expect(
      limiter.admitCostly(
        KEYS.first,
        'create-activation-preview',
        at(AGENT_RATE_LIMIT_HOUR_WINDOW_MS - 1),
      ).kind,
    ).toBe('refused');
    expect(
      limiter.admitCostly(
        KEYS.first,
        'create-activation-preview',
        at(AGENT_RATE_LIMIT_HOUR_WINDOW_MS),
      ),
    ).toEqual({ kind: 'admitted' });
  });

  test('rejects an invalid clock instead of admitting unbounded requests', () => {
    const limiter = createAgentRequestLimiter();
    expect(() => limiter.admit(KEYS.first, new Date(Number.NaN))).toThrow(
      TypeError,
    );
    expect(() =>
      limiter.admitCostly(
        KEYS.first,
        'export-event-summary',
        new Date(Number.NaN),
      ),
    ).toThrow(TypeError);
  });

  test('maps a refusal to the public 429 shape', () => {
    const error = new AgentGatewayRateLimitError('per-hour', 90);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
      reasonCode: 'RATE_LIMITED',
      retryAfterSeconds: 90,
    });
    expect(error.message).not.toMatch(/\d/u);
  });
});
