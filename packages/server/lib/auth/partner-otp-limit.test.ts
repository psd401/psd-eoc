import { describe, expect, test } from 'bun:test';

import {
  createPartnerOtpLimiter,
  PARTNER_OTP_SENDS_PER_CLIENT,
  PARTNER_OTP_SENDS_PER_EMAIL,
  PARTNER_OTP_VERIFIES_PER_EMAIL,
  PARTNER_OTP_WINDOW_MS,
} from './partner-otp-limit';

/**
 * Issue #593. Both budgets are charged for every attempt, so neither a single
 * address nor a single caller is the cheap way around the other.
 */

const START = new Date('2026-10-25T12:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(START.getTime() + offsetMs);
}

describe('the partner sign-in limiter', () => {
  test('bounds how much mail one address can be made to receive', () => {
    const limiter = createPartnerOtpLimiter();
    const attempt = (index: number) =>
      limiter.admit(
        {
          kind: 'send',
          email: 'responder@agency.example.invalid',
          client: `198.51.100.${String(index)}`,
        },
        at(index * 1_000),
      );
    for (let index = 0; index < PARTNER_OTP_SENDS_PER_EMAIL; index += 1) {
      expect(attempt(index).admitted).toBe(true);
    }
    // A different caller each time, so only the address's budget is spent.
    const refused = attempt(PARTNER_OTP_SENDS_PER_EMAIL);
    expect(refused.admitted).toBe(false);
    expect(refused.admitted ? 0 : refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('bounds how many addresses one caller can work through', () => {
    const limiter = createPartnerOtpLimiter();
    const attempt = (index: number) =>
      limiter.admit(
        {
          kind: 'send',
          email: `responder-${String(index)}@agency.example.invalid`,
          client: '198.51.100.7',
        },
        at(index * 1_000),
      );
    for (let index = 0; index < PARTNER_OTP_SENDS_PER_CLIENT; index += 1) {
      expect(attempt(index).admitted).toBe(true);
    }
    expect(attempt(PARTNER_OTP_SENDS_PER_CLIENT).admitted).toBe(false);
  });

  test('sends and verifies have separate budgets', () => {
    const limiter = createPartnerOtpLimiter();
    const email = 'responder@agency.example.invalid';
    for (let index = 0; index < PARTNER_OTP_SENDS_PER_EMAIL; index += 1) {
      expect(
        limiter.admit({ kind: 'send', email, client: null }, at(index))
          .admitted,
      ).toBe(true);
    }
    expect(
      limiter.admit({ kind: 'send', email, client: null }, at(99)).admitted,
    ).toBe(false);
    // Exhausting the send budget must not lock a partner out of answering a
    // code they already received.
    expect(
      limiter.admit({ kind: 'verify', email, client: null }, at(100)).admitted,
    ).toBe(true);
  });

  test('a caller recovers as the window slides, not when it gives up', () => {
    const limiter = createPartnerOtpLimiter();
    const email = 'responder@agency.example.invalid';
    for (let index = 0; index < PARTNER_OTP_VERIFIES_PER_EMAIL; index += 1) {
      expect(
        limiter.admit({ kind: 'verify', email, client: null }, at(index))
          .admitted,
      ).toBe(true);
    }
    expect(
      limiter.admit({ kind: 'verify', email, client: null }, at(1_000))
        .admitted,
    ).toBe(false);
    // Hammering never extends the lockout: the oldest admitted attempt
    // leaving the window is what admits the next one.
    expect(
      limiter.admit(
        { kind: 'verify', email, client: null },
        at(PARTNER_OTP_WINDOW_MS + 1),
      ).admitted,
    ).toBe(true);
  });

  test('an unresolvable caller still charges a shared budget', () => {
    const limiter = createPartnerOtpLimiter();
    for (let index = 0; index < PARTNER_OTP_SENDS_PER_CLIENT; index += 1) {
      expect(
        limiter.admit(
          {
            kind: 'send',
            email: `responder-${String(index)}@agency.example.invalid`,
            client: null,
          },
          at(index),
        ).admitted,
      ).toBe(true);
    }
    expect(
      limiter.admit(
        {
          kind: 'send',
          email: 'one-more@agency.example.invalid',
          client: null,
        },
        at(500),
      ).admitted,
    ).toBe(false);
  });

  test('a refused attempt spends neither budget', () => {
    const limiter = createPartnerOtpLimiter();
    const client = '198.51.100.9';
    for (let index = 0; index < PARTNER_OTP_SENDS_PER_EMAIL; index += 1) {
      limiter.admit(
        { kind: 'send', email: 'busy@agency.example.invalid', client },
        at(index),
      );
    }
    // The address is exhausted; the caller's own budget still has room.
    expect(
      limiter.admit(
        { kind: 'send', email: 'busy@agency.example.invalid', client },
        at(100),
      ).admitted,
    ).toBe(false);
    expect(
      limiter.admit(
        { kind: 'send', email: 'quiet@agency.example.invalid', client },
        at(101),
      ).admitted,
    ).toBe(true);
  });

  test('an invalid clock is refused outright', () => {
    const limiter = createPartnerOtpLimiter();
    expect(() =>
      limiter.admit(
        {
          kind: 'send',
          email: 'responder@agency.example.invalid',
          client: null,
        },
        new Date(Number.NaN),
      ),
    ).toThrow(TypeError);
  });
});
