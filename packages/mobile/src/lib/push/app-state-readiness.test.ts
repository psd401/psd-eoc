import { describe, expect, test } from 'bun:test';

import {
  authChangeRouteReadiness,
  committedAuthRouteReadiness,
  decidePushAppStateReadiness,
  shouldFencePushRegistration,
} from './app-state-readiness';

describe('push AppState readiness', () => {
  test('closes synchronously for inactive and background transitions', () => {
    expect(decidePushAppStateReadiness(false, 'inactive', true)).toEqual({
      backgrounded: false,
      routeReady: false,
    });
    expect(decidePushAppStateReadiness(false, 'background', true)).toEqual({
      backgrounded: true,
      routeReady: false,
    });
  });

  test('keeps a background return closed until fresh protected-shell readiness', () => {
    expect(decidePushAppStateReadiness(true, 'active', true)).toEqual({
      backgrounded: false,
      routeReady: null,
    });
  });

  test('reopens an inactive-only interruption only for the current shell', () => {
    expect(decidePushAppStateReadiness(false, 'active', true)).toEqual({
      backgrounded: false,
      routeReady: true,
    });
    expect(decidePushAppStateReadiness(false, 'active', false)).toEqual({
      backgrounded: false,
      routeReady: false,
    });
  });

  test('fences token work only for a true background, not the iOS permission sheet', () => {
    expect(shouldFencePushRegistration('inactive')).toBe(false);
    expect(shouldFencePushRegistration('active')).toBe(false);
    expect(shouldFencePushRegistration('background')).toBe(true);
  });

  test('closes tap routing synchronously until an auth render commits', () => {
    expect(authChangeRouteReadiness()).toBe(false);
    expect(committedAuthRouteReadiness(false, 'active')).toBe(false);
    expect(committedAuthRouteReadiness(true, 'background')).toBe(false);
    expect(committedAuthRouteReadiness(true, 'active')).toBe(true);
  });
});
