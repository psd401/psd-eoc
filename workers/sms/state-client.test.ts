import { describe, expect, test } from 'bun:test';

import { IDS } from '../shared/test-fixtures';
import { SMS_RUNTIME_PATH, SmsRuntimeClient } from './state-client';

const TOKEN = 'synthetic-sms-runtime-token-'.padEnd(48, 'x');

describe('SMS runtime HTTP client', () => {
  test('uses the fixed authenticated route for irreversible provider state and destination-free snapshots', async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const client = new SmsRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization'),
          body,
        });
        return body.operation === 'lookup-provider-io'
          ? Response.json({ kind: 'missing' })
          : Response.json({ snapshots: [] });
      }) as unknown as typeof fetch,
    });
    const fingerprint = 'a'.repeat(64);
    await expect(
      client.lookup({ attemptId: IDS.attempt, fingerprint }),
    ).resolves.toEqual({ kind: 'missing' });
    await expect(client.listCurrentRosterSnapshots()).resolves.toEqual([]);
    expect(calls).toEqual([
      {
        url: `https://eoc.example.invalid${SMS_RUNTIME_PATH}`,
        authorization: `Bearer ${TOKEN}`,
        body: {
          operation: 'lookup-provider-io',
          attemptId: IDS.attempt,
          workFingerprint: fingerprint,
        },
      },
      {
        url: `https://eoc.example.invalid${SMS_RUNTIME_PATH}`,
        authorization: `Bearer ${TOKEN}`,
        body: { operation: 'list-current-roster-snapshots' },
      },
    ]);
  });

  test('rejects invalid requests and hostile response shapes', async () => {
    let calls = 0;
    const client = new SmsRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () => {
        calls += 1;
        return Response.json({ kind: 'expired', extra: true });
      }) as unknown as typeof fetch,
    });
    await expect(client.resolveRetry('not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(calls).toBe(0);
    await expect(client.resolveRetry(IDS.secondAttempt)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  test('does not expose the endpoint re-enable capability through the worker bearer', async () => {
    let calls = 0;
    const client = new SmsRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () => {
        calls += 1;
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    await expect(
      client.execute({ capabilityId: 'record-endpoint-status' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toBe(0);
  });

  test('keeps the request timeout active while streaming the response body', async () => {
    const client = new SmsRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      timeoutMilliseconds: 100,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const delayedBody = setTimeout(() => {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify({ snapshots: [] })),
              );
              controller.close();
            }, 250);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(delayedBody);
                controller.error(new Error('Synthetic aborted response body.'));
              },
              { once: true },
            );
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await expect(client.listCurrentRosterSnapshots()).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      retryable: true,
    });
  });

  test('requires credential-safe HTTPS configuration', () => {
    for (const options of [
      { serviceOrigin: 'http://eoc.example.invalid', bearerToken: TOKEN },
      { serviceOrigin: 'https://eoc.example.invalid/path', bearerToken: TOKEN },
      { serviceOrigin: 'https://eoc.example.invalid', bearerToken: 'short' },
    ]) {
      expect(() => new SmsRuntimeClient(options)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
  });
});
