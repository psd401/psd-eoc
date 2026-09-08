import { describe, expect, test } from 'bun:test';

import {
  SmsRuntimeStoreError,
  type SmsRuntimeStore,
} from '../../../../lib/notify/sms-runtime-store';
import {
  createSmsRuntimeRouteHandler,
  readSmsRuntimeWorkerToken,
  SMS_RUNTIME_MAX_BODY_BYTES,
  verifySmsRuntimeWorkerToken,
} from './runtime';

const TOKEN = 'sms-runtime-worker-token-'.padEnd(48, 'x');
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000279';
const FINGERPRINT = 'a'.repeat(64);

function fixture(overrides: Partial<SmsRuntimeStore> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const store: SmsRuntimeStore = {
    lookupProviderIo(input) {
      calls.push({ method: 'lookupProviderIo', input });
      return Promise.resolve({ kind: 'missing' });
    },
    claimProviderIo(input) {
      calls.push({ method: 'claimProviderIo', input });
      return Promise.resolve({ kind: 'indeterminate' });
    },
    completeProviderIo(input) {
      calls.push({ method: 'completeProviderIo', input });
      return Promise.resolve();
    },
    scheduleRetry(input) {
      calls.push({ method: 'scheduleRetry', input });
      return Promise.resolve({
        kind: 'scheduled',
        attemptId: ATTEMPT_ID,
        retryAt: '2026-08-26T12:00:00.000Z',
      });
    },
    resolveBatch(input) {
      calls.push({ method: 'resolveBatch', input });
      return Promise.resolve({ kind: 'ready', items: [], nextCursor: null });
    },
    resolveRetry(input) {
      calls.push({ method: 'resolveRetry', input });
      return Promise.resolve({ kind: 'expired' });
    },
    authorizeProviderSend(input) {
      calls.push({ method: 'authorizeProviderSend', input });
      return Promise.resolve({ authorized: false });
    },
    executeLifecycle(input) {
      calls.push({ method: 'executeLifecycle', input });
      return Promise.resolve({});
    },
    resolveSmsDestination(input) {
      calls.push({ method: 'resolveSmsDestination', input });
      return Promise.resolve(null);
    },
    loadAttemptByProviderReference(input) {
      calls.push({ method: 'loadAttemptByProviderReference', input });
      return Promise.resolve(null);
    },
    loadUnknownAttempt(input, correlationToken) {
      calls.push({
        method: 'loadUnknownAttempt',
        input: { attemptId: input, correlationToken },
      });
      return Promise.resolve(null);
    },
    listCurrentRosterSnapshots() {
      calls.push({ method: 'listCurrentRosterSnapshots', input: null });
      return Promise.resolve([]);
    },
    ...overrides,
  };
  let opens = 0;
  return {
    calls,
    opens: () => opens,
    handler: createSmsRuntimeRouteHandler({
      readExpectedBearerToken: () => TOKEN,
      openStore: () => {
        opens += 1;
        return store;
      },
    }),
  };
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
    'https://eoc.example.invalid/api/internal/aws-eum-sms-runtime',
    { method: 'POST', headers, body: JSON.stringify(body) },
  );
}

describe('AWS End User Messaging SMS runtime route', () => {
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

  test('exposes only strict provider ledger, retry, and destination-free snapshot operations', async () => {
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

    const snapshots = await run.handler(
      post({ operation: 'list-current-roster-snapshots' }),
    );
    expect(snapshots.status).toBe(200);
    expect(await snapshots.json()).toEqual({ snapshots: [] });
    expect(run.calls).toEqual([
      {
        method: 'lookupProviderIo',
        input: {
          operation: 'lookup-provider-io',
          attemptId: ATTEMPT_ID,
          workFingerprint: FINGERPRINT,
        },
      },
      { method: 'listCurrentRosterSnapshots', input: null },
    ]);
  });

  test('rejects lifecycle side doors, destinations on ledger calls, and malformed media', async () => {
    const run = fixture();
    for (const body of [
      { operation: 'start-event', attemptId: ATTEMPT_ID },
      { operation: 'record-endpoint-status' },
      {
        operation: 'lookup-provider-io',
        attemptId: ATTEMPT_ID,
        workFingerprint: FINGERPRINT,
        phoneNumber: '+12025550123',
      },
      { operation: 'resolve-retry', attemptId: 'not-a-uuid' },
    ]) {
      expect((await run.handler(post(body))).status).toBe(400);
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

  test('stops reading an oversized chunked body before opening durable state', async () => {
    const run = fixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"padding":"'));
        controller.enqueue(new Uint8Array(SMS_RUNTIME_MAX_BODY_BYTES));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(
      'https://eoc.example.invalid/api/internal/aws-eum-sms-runtime',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body,
      },
    );

    expect(request.headers.has('content-length')).toBe(false);
    const response = await run.handler(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request body is larger than this endpoint accepts.',
      },
    });
    expect(cancelled).toBe(true);
    expect(run.opens()).toBe(0);
    expect(run.calls).toHaveLength(0);
  });

  test('maps conflicts safely and hides unexpected database details', async () => {
    const conflict = fixture({
      resolveRetry: () =>
        Promise.reject(new SmsRuntimeStoreError('RETRY_CONFLICT')),
    });
    const response = await conflict.handler(
      post({ operation: 'resolve-retry', attemptId: ATTEMPT_ID }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'RETRY_CONFLICT',
        message: 'SMS runtime state could not be handled safely.',
      },
    });

    const failed = fixture({
      resolveRetry: () =>
        Promise.reject(new Error('database password=forbidden')),
    });
    const failedResponse = await failed.handler(
      post({ operation: 'resolve-retry', attemptId: ATTEMPT_ID }),
    );
    expect(failedResponse.status).toBe(503);
    expect(JSON.stringify(await failedResponse.json())).not.toContain(
      'password',
    );
  });
});

describe('SMS runtime worker credential', () => {
  test('accepts only a full whitespace-free bearer value', () => {
    for (const value of [undefined, '', 'short', `${TOKEN} `, 'x'.repeat(31)]) {
      expect(() =>
        readSmsRuntimeWorkerToken(
          value === undefined
            ? {}
            : { PSD_EOC_SMS_RUNTIME_WORKER_TOKEN: value },
        ),
      ).toThrow();
    }
    expect(
      readSmsRuntimeWorkerToken({
        PSD_EOC_SMS_RUNTIME_WORKER_TOKEN: TOKEN,
      }),
    ).toBe(TOKEN);
    expect(verifySmsRuntimeWorkerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifySmsRuntimeWorkerToken(TOKEN, TOKEN)).toBe(false);
  });
});
