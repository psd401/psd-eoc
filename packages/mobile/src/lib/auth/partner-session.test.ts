import { describe, expect, test } from 'bun:test';

import { partnerSessionFixture, sessionFixture } from './auth-test-fixtures';
import { isPartnerSession } from './partner-session';

describe('recognizing a partner session', () => {
  test('reads the role the server issued, not the sign-in surface', () => {
    expect(isPartnerSession(partnerSessionFixture())).toBe(true);
    expect(isPartnerSession(sessionFixture())).toBe(false);
  });

  test('nobody is a partner before a session exists', () => {
    // The sign-in screen renders with no session at all, and so does the
    // first frame after a sign-out.
    expect(isPartnerSession(null)).toBe(false);
  });

  test('a partner among other roles is still a partner', () => {
    const session = partnerSessionFixture();
    expect(
      isPartnerSession({
        ...session,
        user: { ...session.user, roles: ['partner'] },
      }),
    ).toBe(true);
    // And a staff member who holds no partner admission never is, however
    // many other roles they carry.
    const staff = sessionFixture();
    expect(
      isPartnerSession({
        ...staff,
        user: { ...staff.user, roles: ['staff', 'admin'] },
      }),
    ).toBe(false);
  });
});
