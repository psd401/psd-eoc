import { describe, expect, test } from 'bun:test';

import { resolveIosServiceEnvironment } from './service-environment';

describe('APNs service environment', () => {
  test('trusts the entitlement when the build carries one', () => {
    // A development or ad-hoc build embeds a provisioning profile, so the
    // entitlement is present and decides on its own.
    expect(resolveIosServiceEnvironment('development', 3)).toBe('development');
    expect(resolveIosServiceEnvironment('production', 4)).toBe('production');
  });

  test('a store build has no entitlement and is production', () => {
    // This is the defect. Apple strips embedded.mobileprovision from App Store
    // builds, so every TestFlight and App Store install reports null here, and
    // treating that as a failure made push registration impossible on the only
    // channel this application ships through.
    expect(resolveIosServiceEnvironment(null, 5)).toBe('production');
    expect(resolveIosServiceEnvironment(undefined, 5)).toBe('production');
    expect(resolveIosServiceEnvironment(null, 2)).toBe('production');
  });

  test('refuses to guess for a simulator or an unknown build', () => {
    // Neither can register with APNs, and guessing an environment would
    // register a token against the wrong one.
    expect(resolveIosServiceEnvironment(null, 1)).toBeNull();
    expect(resolveIosServiceEnvironment(null, 0)).toBeNull();
    expect(resolveIosServiceEnvironment(null, undefined)).toBeNull();
  });

  test('does not treat a development release type as a store build', () => {
    expect(resolveIosServiceEnvironment(null, 3)).toBeNull();
    expect(resolveIosServiceEnvironment(null, 4)).toBeNull();
  });
});
