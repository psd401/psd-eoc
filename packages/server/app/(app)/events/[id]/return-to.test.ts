import { describe, expect, test } from 'bun:test';

import { eventRoomSignInUrl } from './return-to';

const EVENT_ID = '10000000-0000-4000-8000-000000000077';

describe('event-room sign-in return path', () => {
  test('preserves the validated event room for required and expired sessions', () => {
    for (const reason of ['session-required', 'session-expired'] as const) {
      const result = new URL(
        eventRoomSignInUrl(EVENT_ID, reason),
        'https://eoc',
      );
      expect(result.pathname).toBe('/login');
      expect(result.searchParams.get('reason')).toBe(reason);
      expect(result.searchParams.get('returnTo')).toBe(`/events/${EVENT_ID}`);
    }
  });

  test('cannot construct a return target from an invalid event identifier', () => {
    expect(() => eventRoomSignInUrl('../api', 'session-required')).toThrow();
  });
});
