import { describe, expect, test } from 'bun:test';

import {
  defineCapability,
  type FanoutAuthorizationDecision,
} from '@psd-eoc/contracts';

import {
  FANOUT_CONTROL_WORKER_SERVICE_ID,
  createFanoutAuthorizationHandler,
  createFanoutControlAuthorizer,
  createFanoutControlRouteHandler,
  verifyFanoutControlWorkerToken,
  type FanoutAuthorizationCapabilityContext,
  type FanoutControlRouteRuntime,
} from './runtime';

const TOKEN = 'synthetic-fanout-worker-token-000001';
const INTENT = '00000000-0000-4000-8000-000000000009';
const EPOCH = '00000000-0000-4000-8000-000000000091';

function request(
  body: unknown = { intentId: INTENT },
  token: string = TOKEN,
): Request {
  return new Request('https://app.invalid/api/internal/fanout-control', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function runtime(
  decision: FanoutAuthorizationDecision,
  counters: { authorize: number; close: number },
): FanoutControlRouteRuntime {
  return {
    handler: createFanoutAuthorizationHandler({
      async authorize() {
        counters.authorize += 1;
        return decision;
      },
    }),
    authorizer: createFanoutControlAuthorizer(),
    async close() {
      counters.close += 1;
    },
  };
}

describe('internal fan-out authorization route', () => {
  test('executes the canonical worker-only capability and returns exact truth', async () => {
    const counters = { authorize: 0, close: 0 };
    const decision = { authorized: true, currentEpochId: EPOCH } as const;
    const handler = createFanoutControlRouteHandler({
      readExpectedBearerToken: () => TOKEN,
      createRuntime: async () => runtime(decision, counters),
    });
    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: decision });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(counters).toEqual({ authorize: 1, close: 1 });
  });

  test('preserves an epoch mismatch denial instead of releasing old work', async () => {
    const counters = { authorize: 0, close: 0 };
    const decision = {
      authorized: false,
      currentEpochId: EPOCH,
      reasonCode: 'ENABLE_EPOCH_MISMATCH',
    } as const;
    const handler = createFanoutControlRouteHandler({
      readExpectedBearerToken: () => TOKEN,
      createRuntime: async () => runtime(decision, counters),
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: decision });
    expect(counters.authorize).toBe(1);
  });

  test('authenticates before reading the body or opening persistence', async () => {
    let runtimes = 0;
    const handler = createFanoutControlRouteHandler({
      readExpectedBearerToken: () => TOKEN,
      createRuntime: async () => {
        runtimes += 1;
        throw new Error('must not open');
      },
    });
    const response = await handler(
      request({ intentId: INTENT }, 'wrong-token'),
    );
    expect(response.status).toBe(401);
    expect(runtimes).toBe(0);
    expect(await response.text()).not.toContain(TOKEN);
  });

  test('fails closed for missing configuration, invalid input, and runtime errors', async () => {
    const unavailable = createFanoutControlRouteHandler({
      readExpectedBearerToken: () => {
        throw new Error('missing');
      },
      createRuntime: async () => {
        throw new Error('unreachable');
      },
    });
    expect((await unavailable(request())).status).toBe(503);

    let runtimes = 0;
    const handler = createFanoutControlRouteHandler({
      readExpectedBearerToken: () => TOKEN,
      createRuntime: async () => {
        runtimes += 1;
        throw new Error('database unavailable');
      },
    });
    expect((await handler(request({ intentId: 'not-a-uuid' }))).status).toBe(
      400,
    );
    expect(runtimes).toBe(0);
    expect((await handler(request())).status).toBe(503);
    expect(runtimes).toBe(1);
  });

  test('rejects passive methods and compares worker credentials safely', async () => {
    const handler = createFanoutControlRouteHandler({
      readExpectedBearerToken: () => TOKEN,
      createRuntime: async () => {
        throw new Error('unreachable');
      },
    });
    const response = await handler(
      new Request('https://app.invalid/api/internal/fanout-control'),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(verifyFanoutControlWorkerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyFanoutControlWorkerToken(`Bearer ${TOKEN}x`, TOKEN)).toBe(
      false,
    );
  });

  test('authorizer binds the fixed system worker to the same intent', async () => {
    const authorizer = createFanoutControlAuthorizer();
    const context: FanoutAuthorizationCapabilityContext = {
      actor: { kind: 'system', serviceId: FANOUT_CONTROL_WORKER_SERVICE_ID },
      source: 'worker',
      transport: 'worker-execution',
      workerAuthenticated: true,
      intentId: INTENT,
    };
    const registration = createFanoutAuthorizationHandler({
      async authorize() {
        return { authorized: true, currentEpochId: EPOCH };
      },
    });
    expect(registration.id).toBe('authorize-notification-fanout');
    expect(() =>
      authorizer.authorize({
        definition: defineCapability('authorize-notification-fanout'),
        invocationPolicy: {
          principalKinds: ['system'],
          sources: ['worker'],
          agentGrantable: false,
        },
        input: { intentId: INTENT },
        humanActionRequirement: { actionIds: [], consequenceDigest: null },
        context,
      }),
    ).not.toThrow();
    expect(() =>
      authorizer.authorize({
        definition: defineCapability('authorize-notification-fanout'),
        invocationPolicy: {
          principalKinds: ['system'],
          sources: ['worker'],
          agentGrantable: false,
        },
        input: { intentId: '00000000-0000-4000-8000-000000000010' },
        humanActionRequirement: { actionIds: [], consequenceDigest: null },
        context,
      }),
    ).toThrow();
  });
});
