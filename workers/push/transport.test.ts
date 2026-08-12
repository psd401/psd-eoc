import { describe, expect, test } from 'bun:test';

import { ProviderDispatchError } from '../shared/retry';
import { realBatch, workItem } from '../shared/test-fixtures';
import {
  EXPO_EMERGENCY_TTL_SECONDS,
  EXPO_RECEIPTS_URL,
  EXPO_SEND_URL,
  type ExpoPushMessage,
} from './protocol';
import { ExpoPushHttpTransport, type ExpoPushFetch } from './transport';

const ACCESS_TOKEN = 'synthetic-expo-access-token-0000001';

function ticketResponse(count: number, sequence: number): Response {
  return Response.json({
    data: Array.from({ length: count }, (_unused, index) => ({
      status: 'ok',
      id: `ticket-${sequence}-${index}`,
    })),
  });
}

describe('Expo native-fetch transport', () => {
  test('sends provider chunks of at most 100 with canonical bodies', async () => {
    const calls: Array<{
      url: string;
      messages: readonly ExpoPushMessage[];
      authorization: string | null;
    }> = [];
    const fetch: ExpoPushFetch = (input, init) => {
      const messages = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      calls.push({
        url: String(input),
        messages,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Promise.resolve(ticketResponse(messages.length, calls.length));
    };
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      fetch,
      authorizeLiveTransport: () => true,
      clock: () => realBatch().createdAt,
    });
    const outcomes = await transport.sendAll(
      Array.from({ length: 201 }, () => workItem(realBatch())),
    );

    expect(calls.map((call) => call.messages.length)).toEqual([100, 100, 1]);
    expect(calls.every((call) => call.url === EXPO_SEND_URL)).toBe(true);
    expect(
      calls.every((call) => call.authorization === `Bearer ${ACCESS_TOKEN}`),
    ).toBe(true);
    expect(outcomes).toHaveLength(201);
    expect(
      outcomes.every((outcome) => outcome.state === 'provider-accepted'),
    ).toBe(true);
  });

  test('expires stale items locally and preserves fresh siblings positionally', async () => {
    const freshBatch = realBatch();
    const staleBatch = {
      ...realBatch(),
      createdAt: new Date(
        Date.parse(freshBatch.createdAt) - 60 * 60_000,
      ).toISOString(),
    };
    const calls: ExpoPushMessage[][] = [];
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      authorizeLiveTransport: () => true,
      clock: () => freshBatch.createdAt,
      fetch: (_input, init) => {
        const messages = JSON.parse(String(init?.body)) as ExpoPushMessage[];
        calls.push(messages);
        return Promise.resolve(ticketResponse(messages.length, calls.length));
      },
    });

    const outcomes = await transport.sendChunk([
      workItem(staleBatch),
      workItem(freshBatch),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      ttl: EXPO_EMERGENCY_TTL_SECONDS,
      expiration:
        Date.parse(freshBatch.createdAt) / 1_000 + EXPO_EMERGENCY_TTL_SECONDS,
    });
    expect(outcomes).toEqual([
      expect.objectContaining({
        state: 'expired',
        reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
      }),
      expect.objectContaining({ state: 'provider-accepted' }),
    ]);
  });

  test('fails closed before network access without explicit authorization', async () => {
    let calls = 0;
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      fetch: () => {
        calls += 1;
        return Promise.resolve(ticketResponse(1, 1));
      },
    });

    await expect(transport.sendChunk([workItem(realBatch())])).rejects.toEqual(
      expect.objectContaining({ code: 'EXPO_LIVE_TRANSPORT_DISABLED' }),
    );
    expect(calls).toBe(0);
  });

  test('maps HTTP 429 and 5xx to explicitly retryable provider errors', async () => {
    for (const [status, code] of [
      [429, 'EXPO_HTTP_RATE_LIMITED'],
      [503, 'EXPO_HTTP_SERVER_ERROR'],
    ] as const) {
      const transport = new ExpoPushHttpTransport({
        accessToken: ACCESS_TOKEN,
        fetch: () => Promise.resolve(new Response('', { status })),
        authorizeLiveTransport: () => true,
        clock: () => realBatch().createdAt,
      });
      try {
        await transport.sendChunk([workItem(realBatch())]);
        throw new Error('Expected Expo transport failure.');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderDispatchError);
        expect(error).toMatchObject({
          code,
          disposition: 'safe-to-retry',
        });
      }
    }
  });

  test('classifies HTTP 400, 401, and 404 as terminal without retrying', async () => {
    for (const [status, code] of [
      [400, 'EXPO_HTTP_CLIENT_ERROR'],
      [401, 'EXPO_INVALID_CREDENTIALS'],
      [404, 'EXPO_HTTP_CLIENT_ERROR'],
    ] as const) {
      const transport = new ExpoPushHttpTransport({
        accessToken: ACCESS_TOKEN,
        fetch: () => Promise.resolve(new Response('', { status })),
        authorizeLiveTransport: () => true,
        clock: () => realBatch().createdAt,
      });
      await expect(
        transport.sendChunk([workItem(realBatch())]),
      ).rejects.toMatchObject({ code, disposition: 'terminal-failure' });
    }
  });

  test('validates receipt IDs before I/O and chunks valid queries at 1000', async () => {
    const calls: string[][] = [];
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      fetch: (input, init) => {
        expect(String(input)).toBe(EXPO_RECEIPTS_URL);
        const body = JSON.parse(String(init?.body)) as { ids: string[] };
        calls.push(body.ids);
        return Promise.resolve(
          Response.json({
            data: Object.fromEntries(
              body.ids.map((id) => [id, { status: 'ok' }]),
            ),
          }),
        );
      },
      authorizeLiveTransport: () => true,
    });

    await expect(
      transport.queryReceiptChunk(['ticket-1', 'ticket-1']),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);

    const ids = Array.from(
      { length: 1_001 },
      (_unused, index) => `ticket-${index}`,
    );
    const outcomes = await transport.queryAllReceipts(ids);
    expect(calls.map((call) => call.length)).toEqual([1_000, 1]);
    expect(outcomes).toHaveLength(1_001);
  });

  test('cancels oversized streamed responses without buffering beyond the cap', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300_000));
        controller.enqueue(new Uint8Array(300_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      fetch: () => Promise.resolve(new Response(stream, { status: 200 })),
      authorizeLiveTransport: () => true,
      clock: () => realBatch().createdAt,
    });

    await expect(transport.sendChunk([workItem(realBatch())])).rejects.toEqual(
      expect.objectContaining({
        code: 'EXPO_RESPONSE_TOO_LARGE',
        disposition: 'ambiguous',
      }),
    );
    expect(cancelled).toBe(true);
  });
});
