import { describe, expect, test } from 'bun:test';

import { PSD_EOC_LOCAL_AUTH_POLICY } from './local-auth-policy';

describe('local device authentication policy', () => {
  test('requires strong biometrics while retaining the OS passcode fallback', () => {
    expect(PSD_EOC_LOCAL_AUTH_POLICY.biometricsSecurityLevel).toBe('strong');
    expect(PSD_EOC_LOCAL_AUTH_POLICY.disableDeviceFallback).toBe(false);
    expect(PSD_EOC_LOCAL_AUTH_POLICY.fallbackLabel).toBe('Use Device Passcode');
  });
});
