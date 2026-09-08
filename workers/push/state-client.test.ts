import { describe, expect, test } from 'bun:test';

import { workerAttemptFingerprint } from '../shared/attempt';
import { IDS, TIMES, syntheticBatch, workItem } from '../shared/test-fixtures';
import { EXPO_PUSH_RUNTIME_PATH, ExpoPushRuntimeClient } from './state-client';

const TOKEN = 'synthetic-worker-credential-000000000278';

describe('Expo push runtime HTTP client', () => {
  test('uses the fixed authenticated route for strict provider and batch state', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new ExpoPushRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url: String(url), body });
        if (body.operation === 'lookup-provider-io') {
          return Response.json({ kind: 'missing' });
        }
        if (body.operation === 'read-stuck-outbox-count') {
          return Response.json({ count: 2 });
        }
        return Response.json({ items: [workItem()], nextCursor: null });
      }) as unknown as typeof fetch,
    });
    const fingerprint = workerAttemptFingerprint(workItem());

    await expect(
      client.lookupProviderIo({
        attemptId: IDS.attempt,
        workFingerprint: fingerprint,
      }),
    ).resolves.toEqual({ kind: 'missing' });
    await expect(
      client.resolveBatch(syntheticBatch(), TIMES.created, 0),
    ).resolves.toEqual({ items: [workItem()], nextCursor: null });
    await expect(client.readStuckOutboxCount()).resolves.toBe(2);
    expect(calls.map(({ url }) => url)).toEqual([
      `https://eoc.example.invalid${EXPO_PUSH_RUNTIME_PATH}`,
      `https://eoc.example.invalid${EXPO_PUSH_RUNTIME_PATH}`,
      `https://eoc.example.invalid${EXPO_PUSH_RUNTIME_PATH}`,
    ]);
    expect(calls.map(({ body }) => body)).toEqual([
      {
        operation: 'lookup-provider-io',
        attemptId: IDS.attempt,
        workFingerprint: fingerprint,
      },
      {
        operation: 'resolve-batch',
        batch: syntheticBatch(),
        enqueuedAt: TIMES.created,
        cursor: 0,
      },
      { operation: 'read-stuck-outbox-count' },
    ]);
  });

  test('rejects invalid input and hostile response shapes', async () => {
    let calls = 0;
    const client = new ExpoPushRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () => {
        calls += 1;
        return Response.json({ kind: 'missing' });
      }) as unknown as typeof fetch,
    });
    await expect(client.resolveRetry('not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(calls).toBe(0);

    const unauthorized = new ExpoPushRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () =>
        new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(
      unauthorized.resolveRetry(IDS.secondAttempt),
    ).rejects.toMatchObject({
      code: 'REQUEST_UNAUTHORIZED',
      // Retryable: an unauthorized answer is deployment skew, and a worker
      // presenting a reference the deployment moved past is replaced rather
      // than right. Terminal here would dead-letter live notifications for
      // the length of a deploy.
      retryable: true,
      status: 401,
    });

    const extra = new ExpoPushRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () =>
        Response.json({
          kind: 'expired',
          extra: true,
        })) as unknown as typeof fetch,
    });
    await expect(extra.resolveRetry(IDS.secondAttempt)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  test('requires credential-safe HTTPS configuration', () => {
    for (const options of [
      { serviceOrigin: 'http://eoc.example.invalid', bearerToken: TOKEN },
      { serviceOrigin: 'https://eoc.example.invalid/path', bearerToken: TOKEN },
      { serviceOrigin: 'https://eoc.example.invalid', bearerToken: 'short' },
    ]) {
      expect(() => new ExpoPushRuntimeClient(options)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
  });
});
