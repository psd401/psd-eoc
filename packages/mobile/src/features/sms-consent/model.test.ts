import { describe, expect, test } from 'bun:test';

import { resolveSmsConsentSubmission, smsConsentSummary } from './model';

describe('mobile SMS consent submission', () => {
  test('normalizes a typed number once the box is ticked', () => {
    expect(
      resolveSmsConsentSubmission({
        typedNumber: '(253) 555-0123',
        agreed: true,
      }),
    ).toEqual({ kind: 'ready', phoneNumber: '+12535550123' });
  });

  test('blocks an unticked box even with a valid number', () => {
    const result = resolveSmsConsentSubmission({
      typedNumber: '(253) 555-0123',
      agreed: false,
    });

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.message).toContain('Tick the box');
  });

  test('blocks a number that cannot receive US texts', () => {
    expect(
      resolveSmsConsentSubmission({ typedNumber: '555-0123', agreed: true })
        .kind,
    ).toBe('blocked');
  });

  test('never repeats the typed number in the blocked message', () => {
    const result = resolveSmsConsentSubmission({
      typedNumber: '360-555-0199x',
      agreed: true,
    });

    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.message).not.toContain('0199');
    expect(result.message).not.toContain('360');
  });

  test('summarizes consent by its last four digits only', () => {
    const summary = smsConsentSummary({
      status: 'consented',
      lastFourDigits: '0123',
      disclosureVersion: '2026-09-04',
      consentedAt: '2026-09-04T00:00:00.000Z',
    });

    expect(summary).toContain('0123');
    expect(summary).not.toContain('+1');
  });

  test('summarizes the absence of consent without implying failure', () => {
    expect(smsConsentSummary({ status: 'none' })).toContain('not signed up');
  });
});
