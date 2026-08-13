import { describe, expect, test } from 'bun:test';

import {
  FANOUT_CONTROL_AUTHORIZATION_PATH,
  FanoutControlClient,
  FanoutControlClientError,
} from './fanout-control-client';
import { workItem } from './test-fixtures';

const TOKEN = 'synthetic-fanout-worker-token-000001';
const CURRENT_EPOCH = '00000000-0000-4000-8000-000000000091';

describe('fixed-path fan-out authorization client', () => {
  test('sends only the immutable intent identity and accepts current truth', async () => {
    const calls: Readonly<{ input: string; init: RequestInit }>[] = [];
    const client = new FanoutControlClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: async (input, init) => {
        calls.push({ input: String(input), init: init ?? {} });
        return Response.json({
          result: { authorized: true, currentEpochId: CURRENT_EPOCH },
        });
      },
    });

    const item = workItem();
    await expect(client.authorizeFanout(item)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      `https://internal.psd-eoc.invalid${FANOUT_CONTROL_AUTHORIZATION_PATH}`,
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      intentId: item.batch.intentId,
    });
    expect(calls[0]?.init.headers).toEqual(
      expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
    );
    expect('request' in client).toBe(false);
    expect('setFanoutControl' in client).toBe(false);
  });

  test('returns false for every explicit fail-closed decision', async () => {
    for (const decision of [
      {
        authorized: false,
        currentEpochId: null,
        reasonCode: 'CONTROL_STATE_MISSING',
      },
      {
        authorized: false,
        currentEpochId: null,
        reasonCode: 'CONTROL_STATE_UNREADABLE',
      },
      {
        authorized: false,
        currentEpochId: null,
        reasonCode: 'EMERGENCY_DISABLED',
      },
      {
        authorized: false,
        currentEpochId: CURRENT_EPOCH,
        reasonCode: 'ENABLE_EPOCH_MISMATCH',
      },
    ] as const) {
      const client = new FanoutControlClient({
        serviceOrigin: 'https://internal.psd-eoc.invalid',
        bearerToken: TOKEN,
        fetch: async () => Response.json({ result: decision }),
      });
      await expect(client.authorizeFanout(workItem())).resolves.toBe(false);
    }
  });

  test('throws safe denial on auth, transport, malformed, and oversized responses', async () => {
    for (const fetcher of [
      async () => new Response('{}', { status: 401 }),
      async () => {
        throw new Error('secret provider detail');
      },
      async () => Response.json({ result: { authorized: true } }),
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(16 * 1024));
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
        ),
    ]) {
      const client = new FanoutControlClient({
        serviceOrigin: 'https://internal.psd-eoc.invalid',
        bearerToken: TOKEN,
        fetch: fetcher,
      });
      await expect(client.authorizeFanout(workItem())).rejects.toBeInstanceOf(
        FanoutControlClientError,
      );
    }
  });

  test('requires credential-safe HTTPS configuration', () => {
    for (const options of [
      { serviceOrigin: 'http://internal.invalid', bearerToken: TOKEN },
      {
        serviceOrigin: 'https://internal.invalid/path',
        bearerToken: TOKEN,
      },
      {
        serviceOrigin: 'https://internal.invalid',
        bearerToken: 'too-short',
      },
      {
        serviceOrigin: 'https://internal.invalid',
        bearerToken: TOKEN,
        timeoutMilliseconds: 10,
      },
    ]) {
      expect(() => new FanoutControlClient(options)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
  });
});
