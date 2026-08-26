import { describe, expect, test } from 'bun:test';

import { workerAttemptFingerprint } from './attempt';
import {
  ATTEMPT_EXECUTION_PATH,
  AttemptExecutionClient,
} from './attempt-execution-client';
import { IDS, workItem } from './test-fixtures';

const TOKEN = 'synthetic-worker-credential-000000000278';

describe('attempt execution HTTP client', () => {
  test('uses the fixed authenticated route and strict claim contract', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new AttemptExecutionClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({
          kind: 'acquired',
          leaseToken: '00000000-0000-4000-8000-000000000279',
        });
      }) as unknown as typeof fetch,
    });
    const request = {
      attemptId: IDS.attempt,
      fingerprint: workerAttemptFingerprint(workItem()),
      leaseMilliseconds: 60_000,
    };

    await expect(client.claim(request)).resolves.toEqual({
      kind: 'acquired',
      leaseToken: '00000000-0000-4000-8000-000000000279',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://eoc.example.invalid${ATTEMPT_EXECUTION_PATH}`,
    );
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      operation: 'claim',
      ...request,
    });
  });

  test('preserves expired leases as reclaimable adapter-recovery work', async () => {
    const client = new AttemptExecutionClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () =>
        Response.json({ kind: 'reclaimable' })) as unknown as typeof fetch,
    });

    await expect(
      client.lookup({
        attemptId: IDS.attempt,
        fingerprint: workerAttemptFingerprint(workItem()),
      }),
    ).resolves.toEqual({ kind: 'reclaimable' });
  });

  test('fails closed before transport and on hostile responses', async () => {
    let calls = 0;
    const invalid = new AttemptExecutionClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () => {
        calls += 1;
        return Response.json({ kind: 'missing' });
      }) as unknown as typeof fetch,
    });
    await expect(
      invalid.lookup({ attemptId: IDS.attempt, fingerprint: 'bad' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    expect(calls).toBe(0);

    for (const [status, code, retryable] of [
      [401, 'REQUEST_UNAUTHORIZED', false],
      [429, 'RETRYABLE_RESPONSE', true],
      [503, 'RETRYABLE_RESPONSE', true],
    ] as const) {
      const client = new AttemptExecutionClient({
        serviceOrigin: 'https://eoc.example.invalid',
        bearerToken: TOKEN,
        fetch: (async () =>
          new Response('{}', { status })) as unknown as typeof fetch,
      });
      await expect(
        client.lookup({
          attemptId: IDS.attempt,
          fingerprint: workerAttemptFingerprint(workItem()),
        }),
      ).rejects.toMatchObject({ code, retryable, status });
    }

    const mismatch = new AttemptExecutionClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      fetch: (async () =>
        Response.json({
          kind: 'acquired',
          extra: true,
        })) as unknown as typeof fetch,
    });
    await expect(
      mismatch.lookup({
        attemptId: IDS.attempt,
        fingerprint: workerAttemptFingerprint(workItem()),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  test('requires credential-safe HTTPS configuration', () => {
    for (const options of [
      { serviceOrigin: 'http://eoc.example.invalid', bearerToken: TOKEN },
      { serviceOrigin: 'https://eoc.example.invalid/path', bearerToken: TOKEN },
      { serviceOrigin: 'https://eoc.example.invalid', bearerToken: 'short' },
    ]) {
      expect(() => new AttemptExecutionClient(options)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
  });
});
