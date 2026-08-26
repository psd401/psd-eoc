import { describe, expect, test } from 'bun:test';

import {
  ExpoPushRuntimeStoreError,
  type ExpoPushRuntimeStore,
} from '../../../../lib/notify/expo-push-runtime-store';
import {
  createExpoPushRuntimeRouteHandler,
  readExpoPushRuntimeWorkerToken,
  verifyExpoPushRuntimeWorkerToken,
} from './runtime';

const TOKEN = 'runtime-worker-token-'.padEnd(48, 'x');
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000278';
const FINGERPRINT = 'a'.repeat(64);

function fixture(overrides: Partial<ExpoPushRuntimeStore> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const store: ExpoPushRuntimeStore = {
    countStuckOutbox() {
      calls.push({ method: 'countStuckOutbox', input: null });
      return Promise.resolve(3);
    },
    lookupProviderIo(input) {
      calls.push({ method: 'lookupProviderIo', input });
      return Promise.resolve({ kind: 'missing' });
    },
    claimProviderIo(input) {
      calls.push({ method: 'claimProviderIo', input });
      return Promise.resolve({
        kind: 'execute',
        claimToken: '00000000-0000-4000-8000-000000000279',
      });
    },
    completeProviderIo(input) {
      calls.push({ method: 'completeProviderIo', input });
      return Promise.resolve();
    },
    scheduleReceipt(input) {
      calls.push({ method: 'scheduleReceipt', input });
      return Promise.resolve();
    },
    claimDueReceipts(input) {
      calls.push({ method: 'claimDueReceipts', input });
      return Promise.resolve([]);
    },
    decideReceipt(input) {
      calls.push({ method: 'decideReceipt', input });
      return Promise.resolve();
    },
    scheduleRetry(input) {
      calls.push({ method: 'scheduleRetry', input });
      return Promise.resolve({ kind: 'expired' });
    },
    resolveBatch(input) {
      calls.push({ method: 'resolveBatch', input });
      return Promise.resolve({ items: [], nextCursor: null });
    },
    resolveRetry(attemptId) {
      calls.push({ method: 'resolveRetry', input: attemptId });
      return Promise.resolve({ kind: 'expired' });
    },
    ...overrides,
  };
  let opens = 0;
  const handler = createExpoPushRuntimeRouteHandler({
    readExpectedBearerToken: () => TOKEN,
    openStore: () => {
      opens += 1;
      return store;
    },
  });
  return { calls, handler, opens: () => opens };
}

function post(
  body: unknown,
  options: Readonly<{ token?: string; contentType?: string }> = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
  };
  if (options.token !== '') {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  }
  return new Request(
    'https://eoc.example.invalid/api/internal/expo-push-runtime',
    { method: 'POST', headers, body: JSON.stringify(body) },
  );
}

describe('Expo push runtime route', () => {
  test('authenticates before parsing a body or opening durable state', async () => {
    const run = fixture();
    for (const token of ['', 'short', `${TOKEN}x`]) {
      const response = await run.handler(
        post({ operation: 'delete-everything' }, { token }),
      );
      expect(response.status).toBe(401);
    }
    expect(run.opens()).toBe(0);
    expect(run.calls).toHaveLength(0);
  });

  test('exposes only the strict provider ledger and token-free retry operations', async () => {
    const run = fixture();
    const lookup = await run.handler(
      post({
        operation: 'lookup-provider-io',
        attemptId: ATTEMPT_ID,
        workFingerprint: FINGERPRINT,
      }),
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ kind: 'missing' });

    const retry = await run.handler(
      post({ operation: 'resolve-retry', attemptId: ATTEMPT_ID }),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ kind: 'expired' });
    const stuck = await run.handler(
      post({ operation: 'read-stuck-outbox-count' }),
    );
    expect(stuck.status).toBe(200);
    expect(await stuck.json()).toEqual({ count: 3 });
    expect(run.calls).toEqual([
      {
        method: 'lookupProviderIo',
        input: {
          operation: 'lookup-provider-io',
          attemptId: ATTEMPT_ID,
          workFingerprint: FINGERPRINT,
        },
      },
      { method: 'resolveRetry', input: ATTEMPT_ID },
      { method: 'countStuckOutbox', input: null },
    ]);
  });

  test('rejects lifecycle verbs, token fields, extra fields, and malformed media', async () => {
    const run = fixture();
    for (const body of [
      { operation: 'start-event', attemptId: ATTEMPT_ID },
      {
        operation: 'resolve-retry',
        attemptId: ATTEMPT_ID,
        token: 'ExponentPushToken[forbidden]',
      },
      { operation: 'resolve-retry', attemptId: 'not-a-uuid' },
    ]) {
      const response = await run.handler(post(body));
      expect(response.status).toBe(400);
    }
    expect(
      (
        await run.handler(
          post(
            { operation: 'resolve-retry', attemptId: ATTEMPT_ID },
            { contentType: 'text/plain' },
          ),
        )
      ).status,
    ).toBe(415);
    expect(run.opens()).toBe(0);
  });

  test('maps conflicts safely and hides unexpected database failures', async () => {
    const conflict = fixture({
      resolveRetry: () =>
        Promise.reject(new ExpoPushRuntimeStoreError('RETRY_CONFLICT')),
    });
    const conflictResponse = await conflict.handler(
      post({ operation: 'resolve-retry', attemptId: ATTEMPT_ID }),
    );
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toEqual({
      error: {
        code: 'RETRY_CONFLICT',
        message: 'Expo push runtime state could not be handled safely.',
      },
    });

    const unavailable = fixture({
      resolveRetry: () =>
        Promise.reject(new Error('database 10.0.0.4 password=forbidden')),
    });
    const unavailableResponse = await unavailable.handler(
      post({ operation: 'resolve-retry', attemptId: ATTEMPT_ID }),
    );
    expect(unavailableResponse.status).toBe(503);
    expect(JSON.stringify(await unavailableResponse.json())).not.toContain(
      'password',
    );
  });
});

describe('Expo push runtime worker credential', () => {
  test('accepts only a full whitespace-free bearer value', () => {
    for (const value of [undefined, '', 'short', `${TOKEN} `, 'x'.repeat(31)]) {
      expect(() =>
        readExpoPushRuntimeWorkerToken(
          value === undefined
            ? {}
            : { PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN: value },
        ),
      ).toThrow();
    }
    expect(
      readExpoPushRuntimeWorkerToken({
        PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN: TOKEN,
      }),
    ).toBe(TOKEN);
    expect(verifyExpoPushRuntimeWorkerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(
      true,
    );
    expect(verifyExpoPushRuntimeWorkerToken(TOKEN, TOKEN)).toBe(false);
  });
});
