import { describe, expect, test } from 'bun:test';

import {
  parsePushProviderCutover,
  selectedPushProvider,
} from './push-provider-cutover';

describe('push provider cutover', () => {
  test('denies missing, malformed, partial, and mixed provider configuration', () => {
    expect(parsePushProviderCutover(undefined)).toBeNull();
    expect(parsePushProviderCutover('{')).toBeNull();
    expect(
      parsePushProviderCutover(JSON.stringify({ version: 1, ios: 'expo' })),
    ).toBeNull();
    expect(
      parsePushProviderCutover(
        JSON.stringify({ version: 1, ios: 'apns', android: 'fcm' }),
      ),
    ).toBeNull();
    expect(
      parsePushProviderCutover(
        JSON.stringify({
          version: 1,
          ios: 'expo',
          android: 'direct',
          token: 'forbidden',
        }),
      ),
    ).toBeNull();
  });

  test('selects Expo or the correct native provider independently by platform', () => {
    const cutover = parsePushProviderCutover(
      JSON.stringify({ version: 1, ios: 'direct', android: 'expo' }),
    );
    expect(cutover).not.toBeNull();
    if (cutover === null) throw new Error('Cutover did not parse.');
    expect(selectedPushProvider(cutover, 'ios')).toBe('apns');
    expect(selectedPushProvider(cutover, 'android')).toBe('expo');

    const inverse = parsePushProviderCutover(
      JSON.stringify({ version: 1, ios: 'expo', android: 'direct' }),
    );
    expect(inverse).not.toBeNull();
    if (inverse === null) throw new Error('Cutover did not parse.');
    expect(selectedPushProvider(inverse, 'ios')).toBe('expo');
    expect(selectedPushProvider(inverse, 'android')).toBe('fcm');
  });
});
