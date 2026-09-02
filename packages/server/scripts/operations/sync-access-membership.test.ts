import { describe, expect, test } from 'bun:test';

import {
  ACCESS_SYNC_FAILURE_PREFIX,
  accessMembershipSyncSummary,
  readAccessMembershipSyncEnvironment,
  scheduledIdempotencyKey,
  SCHEDULED_SYNC_INTERVAL_MS,
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

  test('names the scope a run covered', () => {
    // The scheduled tick runs sign-in groups and roster groups separately;
    // the log line says which one it is describing.
    const access = accessMembershipSyncSummary(SOURCE_SHA, {
      snapshotId: '00000000-0000-4000-8000-000000000501',
      snapshotVersion: 8,
      capturedAt: '2026-08-17T12:00:00.000Z',
      activeAccessGroupCount: 2,
      evaluatedMembershipCount: 3,
      membershipDigest: 'b'.repeat(64),
      providerGroupIdDigest: 'c'.repeat(64),
      publication: 'created',
    });
    expect(access.scope).toBe('access');

    const roster = accessMembershipSyncSummary(
      SOURCE_SHA,
      {
        snapshotId: '00000000-0000-4000-8000-000000000502',
        snapshotVersion: 9,
        capturedAt: '2026-08-17T12:05:00.000Z',
        activeAccessGroupCount: 1,
        evaluatedMembershipCount: 2,
        membershipDigest: 'd'.repeat(64),
        providerGroupIdDigest: 'e'.repeat(64),
        publication: 'created',
      },
      'roster',
    );
    expect(roster).toMatchObject({
      scope: 'roster',
      evaluatedMembershipCount: 2,
    });
  });

  test('honors an explicitly pinned request and idempotency identity', () => {
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
  });

  test('generates a run identity the scheduler cannot supply', () => {
    // EventBridge cannot template a UUID into a container override, and a
    // schedule that cannot start the task is the outage this replaces.
    const run = readAccessMembershipSyncEnvironment(
      { SOURCE_SHA },
      () => new Date('2026-08-21T21:37:12.500Z'),
      () => '00000000-0000-4000-8000-000000000777',
    );

    expect(run).toEqual({
      requestId: '00000000-0000-4000-8000-000000000777',
      idempotencyKey: 'access-sync:scheduled:2026-08-21T20:00:00.000Z',
      sourceSha: SOURCE_SHA,
    });
  });

  test('still refuses a malformed identity instead of substituting one', () => {
    expect(() =>
      readAccessMembershipSyncEnvironment({
        ACCESS_SYNC_REQUEST_ID: 'not-a-uuid',
        SOURCE_SHA,
      }),
    ).toThrow('Invalid protected access-sync run identity');
    // SOURCE_SHA has no generated fallback and is still required.
    expect(() => readAccessMembershipSyncEnvironment({})).toThrow(
      'Invalid protected access-sync run identity',
    );
  });
});

describe('scheduled access-sync idempotency bucketing', () => {
  test('collapses a redelivered occurrence into one publication', () => {
    // EventBridge guarantees at-least-once delivery.
    const first = scheduledIdempotencyKey(new Date('2026-08-21T20:00:03.000Z'));
    const retry = scheduledIdempotencyKey(new Date('2026-08-21T21:59:59.999Z'));
    expect(retry).toBe(first);
  });

  test('separates consecutive occurrences so membership keeps refreshing', () => {
    const bucket = new Date('2026-08-21T20:00:00.000Z');
    const next = new Date(bucket.getTime() + SCHEDULED_SYNC_INTERVAL_MS);
    expect(scheduledIdempotencyKey(next)).not.toBe(
      scheduledIdempotencyKey(bucket),
    );
  });

  test('produces a key the capability contract accepts', () => {
    const key = scheduledIdempotencyKey(new Date('2026-08-21T20:00:00.000Z'));
    expect(key).toBe('access-sync:scheduled:2026-08-21T20:00:00.000Z');
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(/^[A-Za-z0-9._:-]+$/u.test(key)).toBe(true);
  });
});

describe('access-sync failure reporting', () => {
  test('writes the cause to stderr and still exits non-zero', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('./sync-access-membership.ts', import.meta.url).pathname,
      ],
      {
        env: { PATH: process.env.PATH ?? '', SOURCE_SHA: 'not-a-sha' },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(ACCESS_SYNC_FAILURE_PREFIX);
    expect(stderr).toContain(
      'message=Invalid protected access-sync run identity: sourceSha.',
    );
    // The refusal names the field, never the value it rejected.
    expect(stderr).not.toContain('not-a-sha');
  });
});
