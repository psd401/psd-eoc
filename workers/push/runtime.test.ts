import { describe, expect, test } from 'bun:test';

import { IDS, TIMES, syntheticBatch, workItem } from '../shared/test-fixtures';
import {
  ExpoPushRuntime,
  ExpoPushRuntimeError,
  ExpoReceiptQueueResendScheduler,
} from './runtime';
import type { ExpoReceiptLifecycle } from './receipt-lifecycle';
import type { ExpoPushRuntimeClient } from './state-client';
import type { ExpoPushWorker } from './worker';

const NOW = Date.parse('2026-08-10T16:00:10.000Z');

function completedResult() {
  return {
    kind: 'completed' as const,
    replayed: false,
    outcome: {
      state: 'provider-accepted' as const,
      provider: 'expo',
      providerReference: 'ticket-reference',
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    },
    attemptedEvidence: {},
    outcomeEvidence: { recordedAt: new Date(NOW).toISOString() },
  };
}

function runtimeFixture(
  options: Readonly<{
    process?: (item: unknown) => Promise<unknown>;
    resolveBatch?: (
      cursor: number,
    ) => Promise<{ items: readonly unknown[]; nextCursor: number | null }>;
    resolveRetry?: (attemptId: string) => Promise<unknown>;
    scheduleRetry?: (request: unknown) => Promise<unknown>;
    publishAttemptReference?: (
      attemptId: string,
      delaySeconds: number,
    ) => Promise<void>;
    clock?: () => number;
  }> = {},
) {
  const processed: unknown[] = [];
  const scheduled: unknown[] = [];
  const published: unknown[] = [];
  const worker = {
    process(item: unknown) {
      processed.push(item);
      return options.process?.(item) ?? Promise.resolve(completedResult());
    },
  } as unknown as ExpoPushWorker;
  const state = {
    resolveBatch(_batch: unknown, _enqueuedAt: string, cursor: number) {
      return (
        options.resolveBatch?.(cursor) ??
        Promise.resolve({
          items: cursor === 0 ? [workItem()] : [],
          nextCursor: null,
        })
      );
    },
    resolveRetry(attemptId: string) {
      return (
        options.resolveRetry?.(attemptId) ??
        Promise.resolve({ kind: 'expired' })
      );
    },
    scheduleRetry(request: unknown) {
      scheduled.push(request);
      return (
        options.scheduleRetry?.(request) ??
        Promise.resolve({
          kind: 'scheduled',
          attemptId: IDS.secondAttempt,
          retryAt: new Date(NOW + 30_000).toISOString(),
        })
      );
    },
  } as unknown as ExpoPushRuntimeClient;
  const queue = {
    publishAttemptReference(attemptId: string, delaySeconds: number) {
      published.push({ attemptId, delaySeconds });
      return (
        options.publishAttemptReference?.(attemptId, delaySeconds) ??
        Promise.resolve()
      );
    },
  };
  const receipts = {
    runDue: () => Promise.resolve([]),
  } as unknown as ExpoReceiptLifecycle;
  return {
    processed,
    published,
    scheduled,
    runtime: new ExpoPushRuntime({
      worker,
      state,
      queue,
      receipts,
      clock: options.clock ?? (() => NOW),
    }),
  };
}

describe('Expo push SQS runtime', () => {
  test('materializes every server-owned page before completing the queue item', async () => {
    const item = workItem();
    const fixture = runtimeFixture({
      resolveBatch: (cursor) =>
        Promise.resolve(
          cursor === 0
            ? { items: [item], nextCursor: 1 }
            : { items: [item], nextCursor: null },
        ),
    });
    await expect(
      fixture.runtime.processQueueMessage(
        JSON.stringify(syntheticBatch()),
        TIMES.created,
      ),
    ).resolves.toEqual({
      kind: 'completed',
      outboxCreatedAt: TIMES.created,
      acceptedCount: 2,
      incompleteCount: 0,
    });
    expect(fixture.processed).toEqual([item, item]);
  });

  test('persists a retry before publishing only its opaque attempt ID', async () => {
    const fixture = runtimeFixture({
      process: () =>
        Promise.resolve({
          ...completedResult(),
          kind: 'retry',
          delayMilliseconds: 30_000,
          nextAttemptNumber: 2,
          reasonCode: 'EXPO_HTTP_RATE_LIMITED',
        }),
    });
    await expect(
      fixture.runtime.processQueueMessage(
        JSON.stringify(syntheticBatch()),
        TIMES.created,
      ),
    ).resolves.toEqual({
      kind: 'completed',
      outboxCreatedAt: TIMES.created,
      acceptedCount: 0,
      incompleteCount: 1,
    });
    expect(fixture.scheduled).toEqual([
      expect.objectContaining({
        sourceAttempt: workItem().attempt,
        receiptId: null,
        nextAttemptNumber: 2,
        delayMilliseconds: 30_000,
        retryAt: new Date(NOW + 30_000).toISOString(),
      }),
    ]);
    expect(fixture.published).toEqual([
      { attemptId: IDS.secondAttempt, delaySeconds: 30 },
    ]);
    expect(JSON.stringify(fixture.published)).not.toContain(
      'ExponentPushToken',
    );
  });

  test('republishes a durable retry after a publication crash without moving its absolute schedule', async () => {
    let now = NOW;
    let persistedRequest: string | undefined;
    let publicationCount = 0;
    const fixture = runtimeFixture({
      clock: () => now,
      process: () =>
        Promise.resolve({
          ...completedResult(),
          kind: 'retry',
          delayMilliseconds: 30_000,
          nextAttemptNumber: 2,
          reasonCode: 'EXPO_HTTP_RATE_LIMITED',
        }),
      scheduleRetry: (request) => {
        const serialized = JSON.stringify(request);
        if (persistedRequest !== undefined && persistedRequest !== serialized) {
          return Promise.reject(new Error('RETRY_CONFLICT'));
        }
        persistedRequest = serialized;
        return Promise.resolve({
          kind: 'scheduled',
          attemptId: IDS.secondAttempt,
          retryAt: (request as { retryAt: string }).retryAt,
        });
      },
      publishAttemptReference: () => {
        publicationCount += 1;
        return publicationCount === 1
          ? Promise.reject(new Error('ambiguous SQS publication'))
          : Promise.resolve();
      },
    });
    const body = JSON.stringify(syntheticBatch());

    await expect(
      fixture.runtime.processQueueMessage(body, TIMES.created),
    ).rejects.toEqual(expect.objectContaining({ code: 'ATTEMPT_FAILED' }));
    now += 5 * 60_000;
    await expect(
      fixture.runtime.processQueueMessage(body, TIMES.created),
    ).resolves.toEqual({
      kind: 'completed',
      outboxCreatedAt: TIMES.created,
      acceptedCount: 0,
      incompleteCount: 1,
    });

    expect(fixture.scheduled).toHaveLength(2);
    expect(fixture.scheduled[1]).toEqual(fixture.scheduled[0]);
    expect(fixture.scheduled[0]).toEqual(
      expect.objectContaining({
        retryAt: new Date(NOW + 30_000).toISOString(),
      }),
    );
    expect(fixture.published).toEqual([
      { attemptId: IDS.secondAttempt, delaySeconds: 30 },
      { attemptId: IDS.secondAttempt, delaySeconds: 0 },
    ]);
  });

  test('does not resolve retry work early and drops expired or ineligible refs', async () => {
    const notBefore = runtimeFixture({
      resolveRetry: () =>
        Promise.resolve({
          kind: 'not-before',
          retryAt: new Date(NOW + 42_000).toISOString(),
        }),
    });
    await expect(
      notBefore.runtime.processQueueMessage(
        JSON.stringify({
          kind: 'expo-push-attempt-reference',
          attemptId: IDS.secondAttempt,
        }),
        TIMES.created,
      ),
    ).resolves.toEqual({ kind: 'retry-later', delaySeconds: 42 });
    expect(notBefore.processed).toHaveLength(0);

    for (const kind of ['expired', 'ineligible'] as const) {
      const fixture = runtimeFixture({
        resolveRetry: () => Promise.resolve({ kind }),
      });
      await expect(
        fixture.runtime.processQueueMessage(
          JSON.stringify({
            kind: 'expo-push-attempt-reference',
            attemptId: IDS.secondAttempt,
          }),
          TIMES.created,
        ),
      ).resolves.toEqual({
        kind: 'completed',
        outboxCreatedAt: new Date(NOW).toISOString(),
        acceptedCount: 0,
        incompleteCount: 1,
      });
      expect(fixture.processed).toHaveLength(0);
    }
  });

  test('retains the queue item on in-progress, worker, or malformed work', async () => {
    for (const process of [
      () =>
        Promise.resolve({
          kind: 'in-progress',
          retryAfterMilliseconds: 1_000,
        }),
      () => Promise.reject(new Error('provider detail must not escape')),
      () => Promise.resolve({ ...completedResult(), kind: 'dlq' }),
    ]) {
      const fixture = runtimeFixture({
        process,
      });
      await expect(
        fixture.runtime.processQueueMessage(
          JSON.stringify(syntheticBatch()),
          TIMES.created,
        ),
      ).rejects.toBeInstanceOf(ExpoPushRuntimeError);
    }
    await expect(
      runtimeFixture().runtime.processQueueMessage(
        JSON.stringify({ ...syntheticBatch(), destination: 'forbidden' }),
        TIMES.created,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_QUEUE_MESSAGE' }),
    );
  });
});

describe('receipt-triggered resend persistence', () => {
  test('publishes only after a durable retry schedule succeeds', async () => {
    const calls: string[] = [];
    const state = {
      scheduleRetry: () => {
        calls.push('persist');
        return Promise.resolve({
          kind: 'scheduled',
          attemptId: IDS.secondAttempt,
          retryAt: new Date(NOW + 10_000).toISOString(),
        });
      },
    } as unknown as ExpoPushRuntimeClient;
    const scheduler = new ExpoReceiptQueueResendScheduler(state, {
      publishAttemptReference: () => {
        calls.push('publish');
        return Promise.resolve();
      },
    });
    await scheduler.scheduleReceiptRetry({
      sourceAttempt: workItem().attempt,
      sourceFingerprint: 'a'.repeat(64),
      receiptId: 'receipt-ref',
      nextAttemptNumber: 2,
      delayMilliseconds: 10_000,
      retryAt: new Date(NOW + 10_000).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
    });
    expect(calls).toEqual(['persist', 'publish']);
  });
});
