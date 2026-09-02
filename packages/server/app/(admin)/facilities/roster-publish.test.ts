import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { AdminFormError } from './admin-request';
import { publishAfterManualMembersSave } from './roster-publish';

function administrator(): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: randomUUID(), sessionId: randomUUID() },
    source: 'web',
    roles: ['admin'],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: randomUUID() } },
  } as unknown as AuthenticatedSession;
}

describe('publishing after a manual source is saved', () => {
  test('a failure before the publication can start still says the people were saved', async () => {
    // The save has committed by the time this runs. Whatever goes wrong
    // afterwards, including the lookup of which configuration to publish,
    // the administrator must be told the people were saved and the roster
    // was not published; the generic "nothing was changed" page would be
    // false. The failure detail from underneath is not echoed.
    const database = {
      select() {
        throw new Error('connection reset by peer: internal detail');
      },
    } as unknown as NonNullable<
      Parameters<typeof publishAfterManualMembersSave>[0]['database']
    >;

    const outcome = await publishAfterManualMembersSave({
      authenticated: administrator(),
      idempotencyKey: `publish-after-save-${randomUUID()}`,
      database,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AdminFormError);
    const message = (outcome as Error).message;
    expect(message.startsWith('The people were saved. ')).toBe(true);
    expect(message).toContain('PUBLISH_FAILED');
    expect(message).toContain('Publish the roster');
    expect(message).not.toContain('connection reset');
    expect(message).not.toContain('internal detail');
  });
});
