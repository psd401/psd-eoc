import { describe, expect, test } from 'bun:test';

import {
  DISABLED_EXPO_AUTO_REGISTRATION_INFO,
  disableExpoAutoRegistration,
} from './expo-auto-registration';

describe('Expo automatic registration boundary', () => {
  test('persists an explicit disabled record without passing null', async () => {
    const writes: string[] = [];

    await disableExpoAutoRegistration({
      async setRegistrationInfoAsync(registrationInfo) {
        writes.push(registrationInfo);
      },
    });

    expect(writes).toEqual(['{"isEnabled":false}']);
    expect(JSON.parse(DISABLED_EXPO_AUTO_REGISTRATION_INFO)).toEqual({
      isEnabled: false,
    });
  });

  test('fails closed when native persistence is unavailable', async () => {
    await expect(disableExpoAutoRegistration(null)).rejects.toThrow(
      'server-registration storage is unavailable',
    );
    await expect(disableExpoAutoRegistration({})).rejects.toThrow(
      'server-registration storage is unavailable',
    );
  });
});
