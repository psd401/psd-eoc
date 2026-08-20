import { describe, expect, test } from 'bun:test';

import { SessionEstablishmentResultSchema } from '@psd-eoc/contracts';

import { sessionFixture } from './auth-test-fixtures';

/**
 * The guarantee that lets the server stop stamping a snapshot id.
 *
 * Sessions are no longer pinned to an access-membership generation: the server
 * asks the trusted groups about the present on every request, and
 * `membershipSnapshotId` is a record of which sync run was current when the
 * session was issued. It has been nullable in the contract since the trusted
 * group rewrite.
 *
 * The builds shipped on 2026-08-15 bundled the contract from before that, where
 * the field was required, so a null made them reject the entire authentication
 * response with a generic failure that named no field. The server has been
 * stamping the latest sync run purely to keep those builds working.
 *
 * This asserts that a build made from this source does not need that. When
 * every build in the field is at or past the release carrying this test, the
 * server-side shim in `session-cookie.ts` can go, and the snapshot tables with
 * it.
 */
describe('a session that is not pinned to a snapshot', () => {
  test('parses when the server sends no snapshot id', () => {
    const pinned = sessionFixture();
    const unpinned = {
      ...pinned,
      session: {
        ...pinned.session,
        authorization: {
          ...pinned.session.authorization,
          membershipSnapshotId: null,
        },
      },
    };

    const parsed = SessionEstablishmentResultSchema.parse(unpinned);
    expect(parsed.session.authorization.membershipSnapshotId).toBeNull();
    expect(parsed.session.authorization.kind).toBe('group-membership');
    expect(parsed.session.id).toBe(pinned.session.id);
  });

  test('still parses when the server sends one', () => {
    const parsed = SessionEstablishmentResultSchema.parse(sessionFixture());
    expect(parsed.session.authorization.membershipSnapshotId).not.toBeNull();
  });

  test('the app reads nothing from it', async () => {
    // Nothing in the app branches on the snapshot id, so a null cannot change
    // behaviour beyond parsing. If this ever fails, the shim removal needs a
    // second look.
    const sources = new Bun.Glob('**/*.{ts,tsx}');
    const offenders: string[] = [];
    for await (const file of sources.scan({
      cwd: new URL('../../', import.meta.url).pathname,
      absolute: true,
    })) {
      if (/auth-test-fixtures|unpinned-session|synthetic-fixture/u.test(file)) {
        continue;
      }
      const text = await Bun.file(file).text();
      if (text.includes('membershipSnapshotId')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
