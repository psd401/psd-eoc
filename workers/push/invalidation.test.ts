import { describe, expect, test } from 'bun:test';

import { IDS, TIMES } from '../shared/test-fixtures';
import {
  PUSH_TOKEN_INVALIDATION_PATH,
  PushEndpointInvalidationClient,
  PushEndpointInvalidationError,
  type PushInvalidationFetch,
} from './invalidation';

const WORKER_TOKEN = 'synthetic-push-invalidation-worker-token-0001';
const input = Object.freeze({
  rosterSnapshotId: IDS.roster,
  recipientId: IDS.recipient,
  endpointId: IDS.endpoint,
  status: 'invalid' as const,
  reasonCode: 'EXPO_DEVICE_NOT_REGISTERED' as const,
});
const result = Object.freeze({
  id: '00000000-0000-4000-8000-000000000099',
  ...input,
  recordedAt: TIMES.recorded,
});

describe('push endpoint invalidation writeback', () => {
  test('rejects bearer tokens containing internal whitespace before I/O', () => {
    let calls = 0;

    expect(
      () =>
        new PushEndpointInvalidationClient({
          serviceOrigin: 'https://eoc.example.invalid',
          bearerToken: 'synthetic-push-invalidation token-0001',
          fetch: () => {
            calls += 1;
            return Promise.resolve(Response.json(result));
          },
        }),
    ).toThrow(PushEndpointInvalidationError);
    expect(calls).toBe(0);
  });

  test('posts only the canonical token-free contract and verifies the result', async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const fetch: PushInvalidationFetch = (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return Promise.resolve(Response.json(result));
    };
    const client = new PushEndpointInvalidationClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: WORKER_TOKEN,
      fetch,
    });

    await expect(client.invalidate(input)).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        url: `https://eoc.example.invalid${PUSH_TOKEN_INVALIDATION_PATH}`,
        authorization: `Bearer ${WORKER_TOKEN}`,
        body: input,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('ExponentPushToken');
  });

  test('rejects mismatched successful responses as retryable unknown state', async () => {
    const client = new PushEndpointInvalidationClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: WORKER_TOKEN,
      fetch: () =>
        Promise.resolve(
          Response.json({ ...result, endpointId: IDS.secondAttempt }),
        ),
    });

    await expect(client.invalidate(input)).rejects.toEqual(
      expect.objectContaining({
        code: 'INVALID_RESPONSE',
        retryable: true,
      }),
    );
  });

  test('accepts only canonical Expo, APNs, and FCM invalidation reasons', async () => {
    let calls = 0;
    const client = new PushEndpointInvalidationClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: WORKER_TOKEN,
      fetch: (_url, init) => {
        calls += 1;
        const request = JSON.parse(String(init?.body)) as typeof input;
        return Promise.resolve(
          Response.json({ ...result, reasonCode: request.reasonCode }),
        );
      },
    });

    for (const reasonCode of [
      'EXPO_DEVICE_NOT_REGISTERED',
      'APNS_BAD_DEVICE_TOKEN',
      'APNS_UNREGISTERED',
      'FCM_INVALID_ARGUMENT',
      'FCM_UNREGISTERED',
    ] as const) {
      const request =
        reasonCode === 'APNS_UNREGISTERED'
          ? { ...input, reasonCode, providerOccurredAt: TIMES.attempted }
          : { ...input, reasonCode };
      await expect(client.invalidate(request)).resolves.toBeUndefined();
    }

    await expect(
      client.invalidate({ ...input, reasonCode: 'OTHER_REASON' }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_INPUT', retryable: false }),
    );
    expect(calls).toBe(5);
  });

  test('cancels oversized untrusted success bodies', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20_000));
        controller.enqueue(new Uint8Array(20_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new PushEndpointInvalidationClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: WORKER_TOKEN,
      fetch: () => Promise.resolve(new Response(stream, { status: 200 })),
    });

    await expect(client.invalidate(input)).rejects.toBeInstanceOf(
      PushEndpointInvalidationError,
    );
    expect(cancelled).toBe(true);
  });
});
