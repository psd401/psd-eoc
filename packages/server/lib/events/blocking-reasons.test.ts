import { describe, expect, test } from 'bun:test';

import { blockingReasonSentence } from './blocking-reasons';

describe('blocking reason sentences', () => {
  test('names the roster gap an administrator has to close', () => {
    expect(blockingReasonSentence('NO_RECIPIENTS')).toContain(
      'Add people to its building source',
    );
  });

  test('distinguishes a missing device from a missing address', () => {
    expect(blockingReasonSentence('NO_PUSH_ENDPOINTS')).toContain(
      'registered a device',
    );
    expect(blockingReasonSentence('NO_EMAIL_ENDPOINTS')).toContain(
      'email address',
    );
    expect(blockingReasonSentence('NO_SMS_ENDPOINTS')).toContain(
      'mobile number',
    );
  });

  test('points a switched-off channel at the screen that switches it on', () => {
    expect(blockingReasonSentence('EMAIL_DISABLED')).toBe(
      'Email is switched off. Turn it on under Notifications.',
    );
  });

  test('explains both directions of the truth-label requirement', () => {
    expect(blockingReasonSentence('PUSH_NOT_LIVE_VERIFIED')).toContain(
      'roster of real staff',
    );
    expect(blockingReasonSentence('EMAIL_NOT_MOCKED')).toContain(
      'training recipients',
    );
  });

  test('shows an unrecognised code rather than hiding it', () => {
    // A reason nobody can read still beats a reason nobody can see, and a new
    // code must never silently render as an empty bullet.
    expect(blockingReasonSentence('SOME_FUTURE_CODE')).toBe('SOME_FUTURE_CODE');
  });
});
