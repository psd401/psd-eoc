import { describe, expect, test } from 'bun:test';

import {
  accessMembershipSyncSummary,
  readAccessMembershipSyncEnvironment,
} from './sync-access-membership';

const SOURCE_SHA = 'a'.repeat(40);

describe('protected access-membership sync task boundary', () => {
  test('emits only aggregate direct-membership publication evidence', () => {
    const summary = accessMembershipSyncSummary(SOURCE_SHA, {
      snapshotId: '00000000-0000-4000-8000-000000000501',
      snapshotVersion: 8,
      capturedAt: '2026-08-17T12:00:00.000Z',
      activeAccessGroupCount: 2,
      evaluatedMembershipCount: 3,
      membershipDigest: 'b'.repeat(64),
      providerGroupIdDigest: 'c'.repeat(64),
      publication: 'created',
    });

    expect(summary).toMatchObject({
      event: 'access-membership-sync-complete',
      sourceSha: SOURCE_SHA,
      activeAccessGroupCount: 2,
      evaluatedMembershipCount: 3,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('users/');
    expect(serialized).not.toContain('groups/');
    expect(serialized).not.toContain('token');
  });

  test('requires explicit protected request and idempotency identities', () => {
    expect(
      readAccessMembershipSyncEnvironment({
        ACCESS_SYNC_REQUEST_ID: '00000000-0000-4000-8000-000000000503',
        ACCESS_SYNC_IDEMPOTENCY_KEY: 'access-sync:run-32000000000:1',
        SOURCE_SHA,
      }),
    ).toEqual({
      requestId: '00000000-0000-4000-8000-000000000503',
      idempotencyKey: 'access-sync:run-32000000000:1',
      sourceSha: SOURCE_SHA,
    });
    expect(() => readAccessMembershipSyncEnvironment({})).toThrow(
      'Invalid protected access-sync run identity',
    );
  });
});
