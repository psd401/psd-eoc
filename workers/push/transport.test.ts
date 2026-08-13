import { describe, expect, test } from 'bun:test';

import { ProviderDispatchError } from '../shared/retry';
import { realBatch, workItem } from '../shared/test-fixtures';
import {
  PushEndpointEligibilityError,
  type PushEndpointEligibilityChecker,
} from './eligibility';
import {
  EXPO_EMERGENCY_TTL_SECONDS,
  EXPO_RECEIPTS_URL,
  EXPO_SEND_URL,
  type ExpoPushMessage,
} from './protocol';
import { ExpoPushHttpTransport, type ExpoPushFetch } from './transport';

const ACCESS_TOKEN = 'synthetic-expo-access-token-0000001';
const ALLOWING_ENDPOINT_ELIGIBILITY: PushEndpointEligibilityChecker =
  Object.freeze({
    isEligible: () => Promise.resolve(true),
  });

function ticketResponse(count: number, sequence: number): Response {
  return Response.json({
    data: Array.from({ length: count }, (_unused, index) => ({
      status: 'ok',
      id: `ticket-${sequence}-${index}`,
    })),
  });
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

describe('Expo native-fetch transport', () => {
  test('requires endpoint eligibility and proves exact checker identity', () => {
    const checker: PushEndpointEligibilityChecker = {
      isEligible: () => Promise.resolve(true),
    };
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      authorizeLiveTransport: () => true,
      endpointEligibility: checker,
    });

    expect(
      ExpoPushHttpTransport.usesEndpointEligibility(transport, checker),
    ).toBe(true);
    expect(
      ExpoPushHttpTransport.usesEndpointEligibility(transport, {
        isEligible: checker.isEligible,
      }),
    ).toBe(false);
    expect(
      ExpoPushHttpTransport.usesEndpointEligibility(
        new Proxy(transport, {}),
        checker,
      ),
    ).toBe(false);
    expect(
      () =>
        new ExpoPushHttpTransport({
          accessToken: ACCESS_TOKEN,
          authorizeLiveTransport: () => true,
        } as never),
    ).toThrow('Expo endpoint eligibility checker is invalid.');
    expect(
      () =>
        new ExpoPushHttpTransport({
          accessToken: ACCESS_TOKEN,
          authorizeLiveTransport: () => true,
          endpointEligibility: { isEligible: true },
        } as never),
    ).toThrow('Expo endpoint eligibility checker is invalid.');
  });

  test('sends only singleton provider requests with canonical bodies', async () => {
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
      endpointEligibility: ALLOWING_ENDPOINT_ELIGIBILITY,
      clock: () => realBatch().createdAt,
    });
    const outcomes = await transport.sendAll(
      Array.from({ length: 201 }, () => workItem(realBatch())),
    );

    expect(calls).toHaveLength(201);
    expect(calls.every((call) => call.messages.length === 1)).toBe(true);
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
      endpointEligibility: ALLOWING_ENDPOINT_ELIGIBILITY,
      clock: () => freshBatch.createdAt,
      fetch: (_input, init) => {
        const messages = JSON.parse(String(init?.body)) as ExpoPushMessage[];
        calls.push(messages);
        return Promise.resolve(ticketResponse(messages.length, calls.length));
      },
    });

    const outcomes = await transport.sendAll([
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
      endpointEligibility: ALLOWING_ENDPOINT_ELIGIBILITY,
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

  test('rejects multi-item send chunks before authorization, eligibility, or network access', async () => {
    let authorizationCalls = 0;
    let eligibilityCalls = 0;
    let fetchCalls = 0;
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      authorizeLiveTransport: () => {
        authorizationCalls += 1;
        return true;
      },
      endpointEligibility: {
        isEligible: () => {
          eligibilityCalls += 1;
          return Promise.resolve(true);
        },
      },
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(ticketResponse(1, 1));
      },
      clock: () => realBatch().createdAt,
    });

    await expect(
      transport.sendChunk([workItem(realBatch()), workItem(realBatch())]),
    ).rejects.toMatchObject({
      code: 'EXPO_LIVE_TRANSPORT_DISABLED',
      disposition: 'terminal-failure',
    });
    expect(authorizationCalls).toBe(0);
    expect(eligibilityCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test('checks endpoint eligibility after deferred live authorization and blocks a newly revoked endpoint', async () => {
    const authorizationGate = deferred<boolean>();
    const authorizationEntered = deferred<void>();
    let eligible = true;
    let eligibilityCalls = 0;
    let fetchCalls = 0;
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      authorizeLiveTransport: () => {
        authorizationEntered.resolve();
        return authorizationGate.promise;
      },
      endpointEligibility: {
        isEligible: () => {
          eligibilityCalls += 1;
          return Promise.resolve(eligible);
        },
      },
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(ticketResponse(1, 1));
      },
      clock: () => realBatch().createdAt,
    });

    const pending = transport.sendChunk([workItem(realBatch())]);
    await authorizationEntered.promise;
    eligible = false;
    authorizationGate.resolve(true);

    await expect(pending).rejects.toMatchObject({
      code: 'EXPO_ENDPOINT_INELIGIBLE',
      disposition: 'terminal-failure',
      diagnosticDigest: null,
    });
    expect(eligibilityCalls).toBe(1);
    expect(fetchCalls).toBe(0);
  });

  test('fails closed for unavailable, hostile, and malformed eligibility without leaking endpoint data', async () => {
    const item = workItem(realBatch());
    if (item.endpoint.channel !== 'push') throw new Error('Fixture mismatch.');
    const hostileDetail = `raw policy failure for ${item.endpoint.token}`;
    const cases = [
      {
        name: 'retryable eligibility outage',
        expectedCode: 'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE',
        expectedDisposition: 'safe-to-retry',
        isEligible: () =>
          Promise.reject(
            new PushEndpointEligibilityError('REQUEST_FAILED', true),
          ),
      },
      {
        name: 'hostile unbranded rejection',
        expectedCode: 'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
        expectedDisposition: 'terminal-failure',
        isEligible: () => Promise.reject(new Error(hostileDetail)),
      },
      {
        name: 'non-boolean response',
        expectedCode: 'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
        expectedDisposition: 'terminal-failure',
        isEligible: () => Promise.resolve('eligible' as never),
      },
    ] as const;

    for (const testCase of cases) {
      let fetchCalls = 0;
      const transport = new ExpoPushHttpTransport({
        accessToken: ACCESS_TOKEN,
        authorizeLiveTransport: () => true,
        endpointEligibility: { isEligible: testCase.isEligible },
        fetch: () => {
          fetchCalls += 1;
          return Promise.resolve(ticketResponse(1, 1));
        },
        clock: () => realBatch().createdAt,
      });

      const error = await transport
        .sendChunk([item])
        .catch((caught: unknown) => caught);
      expect(error, testCase.name).toMatchObject({
        code: testCase.expectedCode,
        disposition: testCase.expectedDisposition,
        diagnosticDigest: null,
      });
      const safeError = `${String(error)} ${JSON.stringify(error)}`;
      expect(safeError, testCase.name).not.toContain(item.endpoint.token);
      expect(safeError, testCase.name).not.toContain(hostileDetail);
      expect(fetchCalls, testCase.name).toBe(0);
    }
  });

  test('calls authorization then eligibility then fetch with no asynchronous eligibility gap', async () => {
    const order: string[] = [];
    let eligible = true;
    const item = workItem(realBatch());
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      authorizeLiveTransport: () => {
        order.push('authorize');
        return true;
      },
      endpointEligibility: {
        isEligible: () => {
          order.push('eligibility');
          return Promise.resolve(eligible);
        },
      },
      fetch: (_input, init) => {
        order.push('fetch');
        const messages = JSON.parse(String(init?.body)) as ExpoPushMessage[];
        expect(messages).toHaveLength(1);
        eligible = false;
        return Promise.resolve(ticketResponse(1, 1));
      },
      clock: () => item.batch.createdAt,
    });

    await expect(transport.sendChunk([item])).resolves.toEqual([
      expect.objectContaining({ state: 'provider-accepted' }),
    ]);
    expect(order).toEqual(['authorize', 'eligibility', 'fetch']);
    expect(eligible).toBe(false);
  });

  test('rechecks expiration after delayed eligibility and skips provider fetch', async () => {
    const item = workItem(realBatch());
    const expiresAt =
      Date.parse(item.batch.createdAt) + EXPO_EMERGENCY_TTL_SECONDS * 1_000;
    const eligibilityGate = deferred<boolean>();
    const eligibilityEntered = deferred<void>();
    let now = expiresAt - 1;
    let fetchCalls = 0;
    const transport = new ExpoPushHttpTransport({
      accessToken: ACCESS_TOKEN,
      authorizeLiveTransport: () => true,
      endpointEligibility: {
        isEligible: () => {
          eligibilityEntered.resolve();
          return eligibilityGate.promise;
        },
      },
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(ticketResponse(1, 1));
      },
      clock: () => now,
    });

    const pending = transport.sendChunk([item]);
    await eligibilityEntered.promise;
    now = expiresAt;
    eligibilityGate.resolve(true);

    await expect(pending).resolves.toEqual([
      expect.objectContaining({
        state: 'expired',
        reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
      }),
    ]);
    expect(fetchCalls).toBe(0);
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
        endpointEligibility: ALLOWING_ENDPOINT_ELIGIBILITY,
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
        endpointEligibility: ALLOWING_ENDPOINT_ELIGIBILITY,
        clock: () => realBatch().createdAt,
      });
      await expect(
        transport.sendChunk([workItem(realBatch())]),
      ).rejects.toMatchObject({ code, disposition: 'terminal-failure' });
    }
  });

  test('validates receipt IDs before I/O and chunks valid queries at 1000', async () => {
    const calls: string[][] = [];
    let eligibilityCalls = 0;
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
      endpointEligibility: {
        isEligible: () => {
          eligibilityCalls += 1;
          return Promise.resolve(false);
        },
      },
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
    expect(eligibilityCalls).toBe(0);
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
      endpointEligibility: ALLOWING_ENDPOINT_ELIGIBILITY,
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
