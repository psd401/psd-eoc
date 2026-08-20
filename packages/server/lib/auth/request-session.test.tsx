import { describe, expect, mock, test } from 'bun:test';

const authenticate = mock(async (token: string, surface: string) => ({
  result: { user: { email: `${token}@example.invalid` } },
  roles: ['staff'],
  actor: { sessionId: `session-${surface}` },
}));

// `mock.module` replaces the module for the whole process and stays replaced
// for every test file that runs after this one. A stub listing only what this
// file needs therefore deletes every other export from `./sessions` for
// everyone downstream, which surfaces later as an unrelated file failing to
// find `readSessionPolicy` or `WEB_CSRF_COOKIE_NAME`. Keep the real module and
// override only the seam under test.
const actualSessions = await import('./sessions');
mock.module('./sessions', () => ({
  ...actualSessions,
  getDefaultSessionService: () => ({ authenticate }),
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
    expect(session.result.user.email).toBe('a-token@example.invalid');
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
