import { describe, expect, mock, test } from 'bun:test';

const authenticate = mock(async (token: string, surface: string) => ({
  result: { user: { email: `${token}@psd401.net` } },
  roles: ['staff'],
  actor: { sessionId: `session-${surface}` },
}));

mock.module('./sessions', () => ({
  getDefaultSessionService: () => ({ authenticate }),
  WEB_SESSION_COOKIE_NAME: '__Host-psd-eoc-session',
}));

const { authenticateWebSession } = await import('./request-session');

// What is asserted here is the contract every server-component reader now
// shares: one entry point, always the web surface, the service's result passed
// through untouched, and failures propagated rather than swallowed.
//
// The memoization itself is deliberately not asserted. React's `cache` needs
// the render scope that the App Router's Flight renderer establishes, and
// nothing available to this harness creates one: `react-dom/server` ships a
// passthrough `cache`, and under the `react-server` condition `react-dom/server`
// refuses to load at all. Both were measured — two identical calls invoke the
// service twice either way. Asserting a call count here would therefore encode
// the harness's limitation as if it were the product's behavior.
describe('web session reader', () => {
  test('always authenticates against the web surface', async () => {
    authenticate.mockClear();
    const session = await authenticateWebSession('a-token');

    expect(authenticate.mock.calls[0]).toEqual(['a-token', 'web']);
    expect(session.result.user.email).toBe('a-token@psd401.net');
    expect(session.actor.sessionId).toBe('session-web');
  });

  test('propagates a rejection instead of resolving to a partial session', async () => {
    authenticate.mockClear();
    authenticate.mockImplementationOnce(async () => {
      throw new Error('synthetic session failure');
    });

    await expect(authenticateWebSession('doomed-token')).rejects.toThrow(
      'synthetic session failure',
    );
  });
});
