import { describe, expect, test } from 'bun:test';

import { createIdempotentSubmission } from './submission';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const IDEMPOTENCY_KEY = 'mobile-start-idempotency-0001';

describe('idempotent submission controller', () => {
  test('coalesces concurrent taps into one request and caches success', async () => {
    const pending = deferred<string>();
    const keys: string[] = [];
    const submission = createIdempotentSubmission(IDEMPOTENCY_KEY, (key) => {
      keys.push(key);
      return pending.promise;
    });

    const first = submission.submit();
    const second = submission.submit();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(keys).toEqual([IDEMPOTENCY_KEY]);
    expect(submission.getSnapshot()).toEqual({
      phase: 'submitting',
      idempotencyKey: IDEMPOTENCY_KEY,
      attemptCount: 1,
    });

    pending.resolve('accepted');
    await expect(first).resolves.toBe('accepted');
    await expect(submission.submit()).resolves.toBe('accepted');
    expect(keys).toEqual([IDEMPOTENCY_KEY]);
    expect(submission.getSnapshot()).toEqual({
      phase: 'succeeded',
      idempotencyKey: IDEMPOTENCY_KEY,
      attemptCount: 1,
      result: 'accepted',
    });
  });

  test('never retries automatically and reuses the same key on explicit retry', async () => {
    const keys: string[] = [];
    let attempt = 0;
    const submission = createIdempotentSubmission(
      IDEMPOTENCY_KEY,
      async (key) => {
        keys.push(key);
        attempt += 1;
        if (attempt === 1) {
          throw new Error('synthetic interruption');
        }
        return 'accepted';
      },
    );

    await expect(submission.submit()).rejects.toThrow('synthetic interruption');
    expect(keys).toEqual([IDEMPOTENCY_KEY]);
    expect(submission.getSnapshot()).toEqual({
      phase: 'failed',
      idempotencyKey: IDEMPOTENCY_KEY,
      attemptCount: 1,
    });
    await Promise.resolve();
    expect(keys).toEqual([IDEMPOTENCY_KEY]);

    await expect(submission.submit()).resolves.toBe('accepted');
    expect(keys).toEqual([IDEMPOTENCY_KEY, IDEMPOTENCY_KEY]);
    expect(submission.getSnapshot()).toEqual({
      phase: 'succeeded',
      idempotencyKey: IDEMPOTENCY_KEY,
      attemptCount: 2,
      result: 'accepted',
    });
  });

  test('notifies subscribers on each state transition', async () => {
    const phases: string[] = [];
    const submission = createIdempotentSubmission(
      IDEMPOTENCY_KEY,
      async () => 'accepted',
    );
    const unsubscribe = submission.subscribe(() => {
      phases.push(submission.getSnapshot().phase);
    });

    await submission.submit();
    unsubscribe();
    await submission.submit();

    expect(phases).toEqual(['submitting', 'succeeded']);
  });

  test('rejects an invalid idempotency key before an operation can exist', () => {
    expect(() =>
      createIdempotentSubmission('short', async () => null),
    ).toThrow();
  });
});
