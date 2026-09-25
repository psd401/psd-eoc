import { beforeEach, describe, expect, mock, test } from 'bun:test';

const SecurityLevel = Object.freeze({
  NONE: 0,
  SECRET: 1,
  BIOMETRIC_WEAK: 2,
  BIOMETRIC_STRONG: 3,
});

let enrolledLevel: number = SecurityLevel.SECRET;
let result: unknown = { success: true };
let prompts = 0;

mock.module('expo-local-authentication', () => ({
  SecurityLevel,
  getEnrolledLevelAsync: async () => enrolledLevel,
  authenticateAsync: async () => {
    prompts += 1;
    return result;
  },
}));

const { createLocalAuthenticator } = await import('./local-authenticator');

beforeEach(() => {
  enrolledLevel = SecurityLevel.SECRET;
  result = { success: true };
  prompts = 0;
});

describe('device unlock', () => {
  test('asks a device with a screen lock for it', async () => {
    expect(await createLocalAuthenticator().authenticate()).toEqual({
      success: true,
    });
    expect(prompts).toBe(1);
  });

  test('keeps a device with a screen lock locked when the person cancels', async () => {
    result = { success: false, error: 'user_cancel' };
    const outcome = await createLocalAuthenticator().authenticate();
    expect(outcome.success).toBe(false);
  });

  test('lets a device with no screen lock through without a prompt', async () => {
    // A store reviewer's test phone: signing in used to succeed and then be
    // thrown away here, because there was no lock for the system to check.
    enrolledLevel = SecurityLevel.NONE;
    expect(await createLocalAuthenticator().authenticate()).toEqual({
      success: true,
    });
    expect(prompts).toBe(0);
  });

  test('lets a device through when the system reports it has no lock', async () => {
    for (const error of ['passcode_not_set', 'not_enrolled']) {
      result = { success: false, error };
      expect(await createLocalAuthenticator().authenticate()).toEqual({
        success: true,
      });
    }
  });
});
