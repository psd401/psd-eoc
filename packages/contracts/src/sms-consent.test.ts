import { describe, expect, test } from 'bun:test';

import {
  normalizeNorthAmericanMobileNumber,
  RecordSmsConsentInputSchema,
  smsConsentDisclosure,
  SMS_CONSENT_DISCLOSURE_VERSION,
} from './identity';

const CONTEXT = Object.freeze({
  organizationName: 'Example School District',
  privacyPolicyUrl: 'https://eoc.example.invalid/privacy',
  supportEmail: 'servicecentral@example.invalid',
  supportPhone: '+12535550123',
});

describe('North American mobile normalization', () => {
  test.each([
    ['(253) 555-0123', '+12535550123'],
    ['253.555.0123', '+12535550123'],
    ['253 555 0123', '+12535550123'],
    ['2535550123', '+12535550123'],
    ['1 253 555 0123', '+12535550123'],
    ['12535550123', '+12535550123'],
    ['+12535550123', '+12535550123'],
    ['  +12535550123  ', '+12535550123'],
    // Already-E.164 non-US input is preserved rather than rewritten.
    ['+442071838750', '+442071838750'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeNorthAmericanMobileNumber(input)).toBe(expected);
  });

  test.each([
    ['', 'empty'],
    ['555-0123', 'too short'],
    ['253555012', 'nine digits'],
    ['25355501234', 'eleven digits not starting with 1'],
    ['0253555012', 'invalid NANP area code'],
    ['2531550123', 'invalid NANP exchange'],
    ['253-555-012x', 'non-digit'],
    ['+0123456789', 'invalid E.164 country digit'],
    // A mistyped foreign number must never be silently rewritten to +1.
    ['0044 20 7183 8750', 'foreign trunk prefix'],
  ])('refuses %p (%s)', (input) => {
    expect(normalizeNorthAmericanMobileNumber(input)).toBeNull();
  });

  test('every normalized value satisfies the consent input schema', () => {
    const normalized = normalizeNorthAmericanMobileNumber('(253) 555-0123');
    expect(
      RecordSmsConsentInputSchema.parse({
        phoneNumber: normalized,
        disclosureVersion: SMS_CONSENT_DISCLOSURE_VERSION,
        agreed: true,
      }).phoneNumber,
    ).toBe('+12535550123');
  });
});

describe('SMS consent disclosure', () => {
  test('names the organization and the support contact from configuration', () => {
    const disclosure = smsConsentDisclosure(CONTEXT);
    expect(disclosure.summary).toContain('Example School District');
    expect(disclosure.terms.join(' ')).toContain(
      'servicecentral@example.invalid',
    );
    expect(disclosure.terms.join(' ')).toContain('+12535550123');
  });

  test('carries every element a carrier registration requires', () => {
    const text = smsConsentDisclosure(CONTEXT).terms.join(' ');
    // A toll-free review rejects a program whose consent text omits any of
    // these, so they are asserted individually rather than as a snapshot.
    expect(text).toContain('PSD EOC');
    expect(text).toContain('frequency varies');
    expect(text).toContain('Message and data rates may apply.');
    expect(text).toContain('Reply STOP');
    expect(text).toContain('Reply HELP');
    expect(text).toContain('START or UNSTOP');
    expect(text).toContain('not sold or shared for marketing');
  });

  test('agreement wording is affirmative and names the sender', () => {
    const disclosure = smsConsentDisclosure(CONTEXT);
    expect(disclosure.agreementLabel).toContain('I agree');
    expect(disclosure.agreementLabel).toContain('PSD EOC');
  });

  test('reports the version a consent is recorded under', () => {
    expect(smsConsentDisclosure(CONTEXT).version).toBe(
      SMS_CONSENT_DISCLOSURE_VERSION,
    );
    expect(SMS_CONSENT_DISCLOSURE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  test('refuses a context missing the support contact', () => {
    expect(() =>
      smsConsentDisclosure({
        ...CONTEXT,
        supportPhone: '2535550123',
      }),
    ).toThrow();
  });
});
