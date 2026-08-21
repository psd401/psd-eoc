import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  AttemptExecutionStoreError,
  type AttemptExecutionStore,
} from '../../../../lib/notify/attempt-execution-store';
import {
  createAttemptExecutionRouteHandler,
  readAttemptExecutionWorkerToken,
  verifyAttemptExecutionWorkerToken,
} from './runtime';

const TOKEN = 'a'.repeat(48);
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const LEASE_TOKEN = '00000000-0000-4000-8000-0000000000ff';
const FINGERPRINT = 'email:synthetic';
const OUTCOME = Object.freeze({ state: 'provider-accepted', provider: 'ses' });

function recordingStore(overrides: Partial<AttemptExecutionStore> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const store: AttemptExecutionStore = {
    claim: (request) => {
      calls.push({ method: 'claim', request });
      return Promise.resolve({ kind: 'acquired', leaseToken: LEASE_TOKEN });
    },
    complete: (request) => {
      calls.push({ method: 'complete', request });
      return Promise.resolve();
    },
    lookup: (request) => {
      calls.push({ method: 'lookup', request });
      return Promise.resolve({ kind: 'missing' });
    },
    release: (request) => {
      calls.push({ method: 'release', request });
      return Promise.resolve();
    },
    ...overrides,
  };
  const handler = createAttemptExecutionRouteHandler({
    openStore: () => store,
    readExpectedBearerToken: () => TOKEN,
  });
  return { calls, handler };
}

function post(
  body: unknown,
  init: Readonly<{ token?: string; contentType?: string }> = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': init.contentType ?? 'application/json',
  };
  if (init.token !== '') {
    headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  }
  return new Request(
    'https://eoc.example.invalid/api/internal/attempt-execution',
    {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers,
      method: 'POST',
    },
  );
}

describe('attempt execution route', () => {
  test('claims, completes, and releases through the store', async () => {
    const { calls, handler } = recordingStore();

    const claim = await handler(
      post({
        operation: 'claim',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        leaseMilliseconds: 60_000,
      }),
    );
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({
      kind: 'acquired',
      leaseToken: LEASE_TOKEN,
    });

    const complete = await handler(
      post({
        operation: 'complete',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        leaseToken: LEASE_TOKEN,
        completion: { kind: 'final', outcome: OUTCOME },
      }),
    );
    expect(complete.status).toBe(200);

    const release = await handler(
      post({
        operation: 'release',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        leaseToken: LEASE_TOKEN,
      }),
    );
    expect(release.status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual([
      'claim',
      'complete',
      'release',
    ]);
  });

  test('refuses every request without the exact bearer', async () => {
    const { calls, handler } = recordingStore();
    const body = {
      operation: 'lookup',
      attemptId: ATTEMPT,
      fingerprint: FINGERPRINT,
    };
    for (const token of ['', 'wrong', `${TOKEN}x`, TOKEN.slice(0, 47)]) {
      const response = await handler(post(body, { token }));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
    }
    // Authentication completes before the store is opened at all.
    expect(calls).toHaveLength(0);
  });

  test('rejects anything but POST and non-JSON bodies', async () => {
    const { handler } = recordingStore();

    const get = await handler(
      new Request(
        'https://eoc.example.invalid/api/internal/attempt-execution',
        {
          method: 'GET',
        },
      ),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const wrongType = await handler(
      post(
        { operation: 'lookup', attemptId: ATTEMPT, fingerprint: FINGERPRINT },
        { contentType: 'text/plain' },
      ),
    );
    expect(wrongType.status).toBe(415);

    const notJson = await handler(post('{ not json'));
    expect(notJson.status).toBe(400);
  });

  test('refuses a request that is not one of the four operations', async () => {
    const { calls, handler } = recordingStore();
    for (const body of [
      { operation: 'delete', attemptId: ATTEMPT, fingerprint: FINGERPRINT },
      { operation: 'claim', attemptId: 'not-a-uuid', fingerprint: FINGERPRINT },
      { operation: 'claim', attemptId: ATTEMPT, fingerprint: '' },
      // An unbounded lease would let one worker hold an attempt indefinitely.
      {
        operation: 'claim',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        leaseMilliseconds: 60 * 60 * 1_000,
      },
      // Extra keys are refused rather than ignored.
      {
        operation: 'lookup',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        eventId: randomUUID(),
      },
    ]) {
      const response = await handler(post(body));
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test('refuses a completion the store could not read back', async () => {
    const { calls, handler } = recordingStore();
    const response = await handler(
      post({
        operation: 'complete',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        leaseToken: LEASE_TOKEN,
        completion: { kind: 'final' },
      }),
    );
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('reports a lease or fingerprint conflict as the caller’s answer', async () => {
    const { handler } = recordingStore({
      claim: () =>
        Promise.reject(
          new AttemptExecutionStoreError('ATTEMPT_FINGERPRINT_CONFLICT'),
        ),
    });
    const response = await handler(
      post({
        operation: 'claim',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        leaseMilliseconds: 60_000,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'ATTEMPT_FINGERPRINT_CONFLICT',
        message: 'The channel attempt execution could not be recorded safely.',
      },
    });
  });

  test('never leaks an unexpected failure to the caller', async () => {
    const { handler } = recordingStore({
      claim: () => Promise.reject(new Error('connection to 10.0.4.2 refused')),
    });
    const response = await handler(
      post({
        operation: 'claim',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
        leaseMilliseconds: 60_000,
      }),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('10.0.4.2');
  });

  test('is unavailable rather than open when its credential is unusable', async () => {
    const handler = createAttemptExecutionRouteHandler({
      openStore: () => {
        throw new Error('the store must never be opened');
      },
      readExpectedBearerToken: () => {
        throw new Error('unconfigured');
      },
    });
    const response = await handler(
      post({
        operation: 'lookup',
        attemptId: ATTEMPT,
        fingerprint: FINGERPRINT,
      }),
    );
    expect(response.status).toBe(503);
  });
});

describe('attempt execution worker credential', () => {
  test('accepts only a long, whitespace-free token', () => {
    for (const value of [
      undefined,
      '',
      'short',
      `${TOKEN} `,
      `${TOKEN.slice(0, 40)} ${TOKEN.slice(41)}`,
      'b'.repeat(31),
    ]) {
      expect(() =>
        readAttemptExecutionWorkerToken(
          value === undefined
            ? {}
            : { PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: value },
        ),
      ).toThrow();
    }
    expect(
      readAttemptExecutionWorkerToken({
        PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: TOKEN,
      }),
    ).toBe(TOKEN);
  });

  test('compares the whole token and rejects a short one', () => {
    expect(verifyAttemptExecutionWorkerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(
      true,
    );
    expect(verifyAttemptExecutionWorkerToken(`Bearer ${TOKEN}`, 'short')).toBe(
      false,
    );
    expect(verifyAttemptExecutionWorkerToken(TOKEN, TOKEN)).toBe(false);
    expect(verifyAttemptExecutionWorkerToken(null, TOKEN)).toBe(false);
  });
});
