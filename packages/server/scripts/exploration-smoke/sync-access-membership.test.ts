import { describe, expect, test } from 'bun:test';

import {
  accessMembershipSyncSummary,
  readAccessMembershipSyncEnvironment,
} from './sync-access-membership';

const SOURCE_SHA = 'a'.repeat(40);

describe('protected access-membership sync task boundary', () => {
  test('emits only aggregate direct-membership publication evidence', () => {
    const summary = accessMembershipSyncSummary(SOURCE_SHA, {
      phase: 'stage',
      snapshotId: '00000000-0000-4000-8000-000000000501',
      snapshotVersion: 8,
      capturedAt: '2026-08-17T12:00:00.000Z',
      designatedSourceId: '00000000-0000-4000-8000-000000000502',
      activeAccessGroupCount: 2,
      evaluatedMembershipCount: 3,
      membershipDigest: 'b'.repeat(64),
      providerGroupIdDigest: 'c'.repeat(64),
      proofKind: 'initial-selector-match',
      auditEntryHash: null,
      publication: 'created',
    });

    expect(summary).toMatchObject({
      event: 'access-membership-sync-complete',
      phase: 'stage',
      sourceSha: SOURCE_SHA,
      proofKind: 'initial-selector-match',
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
        ACCESS_SYNC_PHASE: 'stage',
        ACCESS_SYNC_REQUEST_ID: '00000000-0000-4000-8000-000000000503',
        ACCESS_SYNC_IDEMPOTENCY_KEY: 'access-sync:run-32000000000:1',
        PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256: 'd'.repeat(64),
        SOURCE_SHA,
      }),
    ).toEqual({
      requestId: '00000000-0000-4000-8000-000000000503',
      idempotencyKey: 'access-sync:run-32000000000:1',
      phase: 'stage',
      initialMobileTransitionEmailDigest: 'd'.repeat(64),
      mobileSessionId: undefined,
      membershipSnapshotId: undefined,
      sourceSha: SOURCE_SHA,
    });
    expect(
      readAccessMembershipSyncEnvironment({
        ACCESS_SYNC_PHASE: 'finalize',
        ACCESS_SYNC_REQUEST_ID: '00000000-0000-4000-8000-000000000503',
        ACCESS_SYNC_IDEMPOTENCY_KEY: 'access-sync:run-32000000000:2',
        ACCESS_SYNC_MOBILE_SESSION_ID: '00000000-0000-4000-8000-000000000504',
        ACCESS_SYNC_MEMBERSHIP_SNAPSHOT_ID:
          '00000000-0000-4000-8000-000000000505',
        PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256: 'd'.repeat(64),
        SOURCE_SHA,
      }),
    ).toMatchObject({
      phase: 'finalize',
      mobileSessionId: '00000000-0000-4000-8000-000000000504',
      membershipSnapshotId: '00000000-0000-4000-8000-000000000505',
    });
    expect(() => readAccessMembershipSyncEnvironment({})).toThrow(
      'Invalid protected access-sync run identity',
    );
  });
});
