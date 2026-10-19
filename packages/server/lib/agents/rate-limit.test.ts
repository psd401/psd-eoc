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
      expect(
        limiter.admit(KEYS.first, 'list-active-events', at(index * 100)),
      ).toEqual({ kind: 'admitted' });
    }

    const refused = limiter.admit(KEYS.first, 'list-active-events', at(6_000));
    expect(refused).toEqual({
      kind: 'refused',
      window: 'per-minute',
      retryAfterSeconds: 54,
    });

    // Hammering while refused does not extend the lockout: the first request
    // ages out exactly one window after it was admitted.
    expect(
      limiter.admit(KEYS.first, 'list-active-events', at(59_999)).kind,
    ).toBe('refused');
    expect(
      limiter.admit(
        KEYS.first,
        'list-active-events',
        at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS),
      ),
    ).toEqual({ kind: 'admitted' });
    expect(
      limiter.admit(
        KEYS.first,
        'list-active-events',
        at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS + 1),
      ).kind,
    ).toBe('refused');
  });

  test('reports at least one second so Retry-After is never zero', () => {
    const limiter = createAgentRequestLimiter();
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      index += 1
    ) {
      limiter.admit(KEYS.first, 'get-event', at(0));
    }
    expect(
      limiter.admit(
        KEYS.first,
        'get-event',
        at(AGENT_RATE_LIMIT_MINUTE_WINDOW_MS - 1),
      ),
    ).toEqual({ kind: 'refused', window: 'per-minute', retryAfterSeconds: 1 });
  });

  test('caps costly calls per hour for one key without touching another key', () => {
    const limiter = createAgentRequestLimiter();

    for (const capabilityId of AGENT_RATE_LIMIT_COSTLY_CAPABILITY_IDS) {
      const scoped = createAgentRequestLimiter();
      for (
        let index = 0;
        index < AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
        index += 1
      ) {
        // Spread across minutes so the per-minute budget is never the reason.
        expect(
          scoped.admit(KEYS.first, capabilityId, at(index * 120_000)).kind,
        ).toBe('admitted');
      }
      expect(
        scoped.admit(
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
      });
    }

    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
      index += 1
    ) {
      limiter.admit(KEYS.first, 'export-event-summary', at(index * 1_000));
    }
    expect(
      limiter.admit(KEYS.first, 'export-event-summary', at(30_000)).kind,
    ).toBe('refused');
    expect(
      limiter.admit(KEYS.second, 'export-event-summary', at(30_000)),
    ).toEqual({ kind: 'admitted' });
    // The exhausted key may still make ordinary reads.
    expect(limiter.admit(KEYS.first, 'list-active-events', at(30_000))).toEqual(
      { kind: 'admitted' },
    );
  });

  test('releases the hourly budget one window after the oldest costly call', () => {
    const limiter = createAgentRequestLimiter();
    for (
      let index = 0;
      index < AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
      index += 1
    ) {
      limiter.admit(KEYS.first, 'create-activation-preview', at(index * 1_000));
    }
    expect(
      limiter.admit(
        KEYS.first,
        'create-activation-preview',
        at(AGENT_RATE_LIMIT_HOUR_WINDOW_MS - 1),
      ).kind,
    ).toBe('refused');
    expect(
      limiter.admit(
        KEYS.first,
        'create-activation-preview',
        at(AGENT_RATE_LIMIT_HOUR_WINDOW_MS),
      ),
    ).toEqual({ kind: 'admitted' });
  });

  test('rejects an invalid clock instead of admitting unbounded requests', () => {
    const limiter = createAgentRequestLimiter();
    expect(() =>
      limiter.admit(KEYS.first, 'list-active-events', new Date(Number.NaN)),
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
