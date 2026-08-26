import { describe, expect, test } from 'bun:test';

import type { EmailRuntimeStore } from '../../../../lib/notify/email-runtime-store';
import {
  EMAIL_RUNTIME_FIXTURE_ATTEMPT_ID,
  emailDeliveryTestWorkItem,
} from '../../../../lib/testing/email-runtime';
import {
  createEmailRuntimeRouteHandler,
  readEmailRuntimeWorkerToken,
  verifyEmailRuntimeWorkerToken,
} from './runtime';

const TOKEN = 'email-runtime-worker-token-'.padEnd(48, 'x');
const ATTEMPT_ID = EMAIL_RUNTIME_FIXTURE_ATTEMPT_ID;
const FINGERPRINT = 'a'.repeat(64);
const VERIFICATION_REFERENCE = 'deployment:commit-277';

function fixture(overrides: Partial<EmailRuntimeStore> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const store: EmailRuntimeStore = {
    claimProviderIo(input) {
      calls.push({ method: 'claimProviderIo', input });
      return Promise.resolve({ kind: 'in-progress' });
    },
    completeProviderIo(input) {
      calls.push({ method: 'completeProviderIo', input });
      return Promise.resolve();
    },
    resolveBatch(input) {
      calls.push({ method: 'resolveBatch', input });
      return Promise.resolve({
        items: [],
        nextCursor: null,
        suppressedCount: 0,
      });
    },
    resolveRetry(input) {
      calls.push({ method: 'resolveRetry', input });
      return Promise.resolve({ kind: 'expired' });
    },
    authorizeProviderSend(input) {
      calls.push({ method: 'authorizeProviderSend', input });
      return Promise.resolve(false);
    },
    ...overrides,
  };
  let opens = 0;
  return {
    calls,
    opens: () => opens,
    handler: createEmailRuntimeRouteHandler({
      readExpectedBearerToken: () => TOKEN,
      readExpectedVerificationReference: () => VERIFICATION_REFERENCE,
      openStore: () => {
        opens += 1;
        return store;
      },
    }),
  };
}

function post(body: unknown, token = TOKEN): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token !== '') headers.authorization = `Bearer ${token}`;
  return new Request('https://eoc.example.invalid/api/internal/email-runtime', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('email runtime route', () => {
  test('authenticates before parsing or opening durable state', async () => {
    const run = fixture();
    for (const token of ['', 'short', `${TOKEN}x`]) {
      expect(
        (await run.handler(post({ operation: 'delete-everything' }, token)))
          .status,
      ).toBe(401);
    }
    expect(run.opens()).toBe(0);
    expect(run.calls).toHaveLength(0);
  });

  test('exposes a strict irreversible SES claim operation', async () => {
    const run = fixture();
    const workItem = emailDeliveryTestWorkItem();
    const response = await run.handler(
      post({
        operation: 'claim-provider-io',
        verificationReference: VERIFICATION_REFERENCE,
        attemptId: ATTEMPT_ID,
        requestFingerprint: FINGERPRINT,
        workItem,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'in-progress' });
    expect(run.calls).toEqual([
      {
        method: 'claimProviderIo',
        input: {
          operation: 'claim-provider-io',
          verificationReference: VERIFICATION_REFERENCE,
          attemptId: ATTEMPT_ID,
          requestFingerprint: FINGERPRINT,
          workItem,
        },
      },
    ]);
  });

  test('rejects lifecycle verbs, destinations, and malformed digests', async () => {
    const run = fixture();
    for (const body of [
      { operation: 'start-event', attemptId: ATTEMPT_ID },
      {
        operation: 'claim-provider-io',
        verificationReference: VERIFICATION_REFERENCE,
        attemptId: ATTEMPT_ID,
        requestFingerprint: FINGERPRINT,
        email: 'forbidden@example.invalid',
      },
      {
        operation: 'claim-provider-io',
        verificationReference: VERIFICATION_REFERENCE,
        attemptId: ATTEMPT_ID,
        requestFingerprint: 'not-a-digest',
      },
    ]) {
      expect((await run.handler(post(body))).status).toBe(400);
    }
    expect(run.opens()).toBe(0);
  });

  test('rejects a stale task reference before opening durable state', async () => {
    const run = fixture();
    const response = await run.handler(
      post({
        operation: 'authorize-provider-send',
        verificationReference: 'deployment:commit-278',
        workItem: emailDeliveryTestWorkItem(),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'STALE_EMAIL_RUNTIME_AUTHORIZATION',
        message:
          'The email worker deployment authorization is no longer current.',
      },
    });
    expect(run.opens()).toBe(0);
    expect(run.calls).toHaveLength(0);
  });
});

describe('email runtime worker credential', () => {
  test('accepts only a full whitespace-free bearer value', () => {
    for (const value of [undefined, '', 'short', `${TOKEN} `, 'x'.repeat(31)]) {
      expect(() =>
        readEmailRuntimeWorkerToken(
          value === undefined
            ? {}
            : { PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN: value },
        ),
      ).toThrow();
    }
    expect(
      readEmailRuntimeWorkerToken({
        PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN: TOKEN,
      }),
    ).toBe(TOKEN);
    expect(verifyEmailRuntimeWorkerToken(`Bearer ${TOKEN}`, TOKEN)).toBeTrue();
    expect(verifyEmailRuntimeWorkerToken(TOKEN, TOKEN)).toBeFalse();
  });
});
