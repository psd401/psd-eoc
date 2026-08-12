import { describe, expect, test } from 'bun:test';

import type { TrustedCapabilityInvocation } from '../../../lib/capabilities/engine';
import {
  EXPO_DEVICE_NOT_REGISTERED_REASON,
  PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
} from '../../../lib/capabilities/devices';
import {
  DEVICE_IDEMPOTENCY_KEY_HEADER,
  handleListMyDevices,
  handlePushEndpointInvalidation,
  handleRegisterPushToken,
  handleUnregisterPushToken,
  readPushEndpointWorkerToken,
  verifyPushEndpointWorkerToken,
  type DeviceRouteInvocationRequest,
  type DeviceRouteRuntime,
  type PushEndpointInvalidationRouteDependencies,
} from './_lib/http';

const ids = {
  user: '00000000-0000-4000-8000-000000001221',
  session: '00000000-0000-4000-8000-000000001222',
  epoch: '00000000-0000-4000-8000-000000001223',
  request: '00000000-0000-4000-8000-000000001224',
  secondRequest: '00000000-0000-4000-8000-000000001230',
  device: '00000000-0000-4000-8000-000000001225',
  roster: '00000000-0000-4000-8000-000000001226',
  recipient: '00000000-0000-4000-8000-000000001227',
  endpoint: '00000000-0000-4000-8000-000000001228',
  status: '00000000-0000-4000-8000-000000001229',
} as const;

const now = new Date('2026-08-11T19:00:00.000Z');
const token = 'ExponentPushToken[synthetic-route-device]';
const workerBearer = 'synthetic-push-worker-token-0000000000000001';

interface ExecutionCall {
  readonly capabilityId: string;
  readonly input: unknown;
  readonly invocation: TrustedCapabilityInvocation;
}

function humanRouteRuntime() {
  const executions: ExecutionCall[] = [];
  const invocationRequests: DeviceRouteInvocationRequest[] = [];
  const runtime: DeviceRouteRuntime = {
    capabilities: {
      async execute(capabilityId, input, invocation) {
        executions.push({ capabilityId, input, invocation });
        if (capabilityId === 'list-my-devices') {
          return {
            items: [],
            pageInfo: { hasMore: false, nextCursor: null },
          };
        }
        return {
          deviceEnrollmentId: ids.device,
          status:
            capabilityId === 'register-push-token'
              ? 'registered'
              : 'unregistered',
          ...(capabilityId === 'register-push-token'
            ? { platform: 'ios' }
            : {}),
        };
      },
    },
    createRequestId: () => ids.request,
    now: () => now,
    async resolveInvocation(_request, input) {
      invocationRequests.push(input);
      return {
        actor: { kind: 'human', userId: ids.user, sessionId: ids.session },
        source: 'mobile',
        scope: { facilityScope: { kind: 'district' } },
        requestId: input.requestId,
        serverTime: input.serverTime,
        connectivityEpochId: ids.epoch,
        mutation:
          input.mutation === null
            ? null
            : {
                idempotencyKey: input.mutation.idempotencyKey,
                transport: {
                  kind: 'mobile-interactive',
                  interaction: 'explicit-user-submit',
                },
                humanConfirmationId: null,
              },
      };
    },
  };
  return { executions, invocationRequests, runtime };
}

function jsonMutationRequest(path: string, body: unknown): Request {
  return new Request(`https://eoc.example.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [DEVICE_IDEMPOTENCY_KEY_HEADER]: 'device-route-idempotency-0001',
    },
    body: JSON.stringify(body),
  });
}

function workerDependencies(
  expectedBearer = workerBearer,
): PushEndpointInvalidationRouteDependencies & {
  readonly calls: Array<{
    readonly input: unknown;
    readonly invocation: TrustedCapabilityInvocation;
  }>;
} {
  const calls: Array<{
    readonly input: unknown;
    readonly invocation: TrustedCapabilityInvocation;
  }> = [];
  return {
    calls,
    readExpectedBearerToken: () => expectedBearer,
    createRequestId: () => ids.request,
    now: () => now,
    async execute(input, invocation) {
      calls.push({ input, invocation });
      return {
        id: ids.status,
        ...(input as Record<string, unknown>),
        recordedAt: now.toISOString(),
      };
    },
  };
}

function pushInvalidationRequest(
  body: unknown,
  bearer = workerBearer,
): Request {
  return new Request(
    'https://eoc.example.test/api/devices/internal/push-token-invalidation',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

describe('authenticated human device routes', () => {
  test('normalizes register and unregister mutations through canonical execution', async () => {
    const { executions, invocationRequests, runtime } = humanRouteRuntime();
    const registerResponse = await handleRegisterPushToken(
      jsonMutationRequest('/api/devices/push-token', {
        deviceEnrollmentId: ids.device,
        platform: 'ios',
        token,
      }),
      runtime,
    );
    const unregisterResponse = await handleUnregisterPushToken(
      jsonMutationRequest('/api/devices/push-token/unregister', {
        deviceEnrollmentId: ids.device,
      }),
      runtime,
    );

    expect(registerResponse.status).toBe(200);
    expect(unregisterResponse.status).toBe(200);
    expect(registerResponse.headers.get('cache-control')).toBe('no-store');
    expect(executions).toHaveLength(2);
    expect(executions[0]).toMatchObject({
      capabilityId: 'register-push-token',
      input: { deviceEnrollmentId: ids.device, platform: 'ios', token },
      invocation: { actor: { sessionId: ids.session }, source: 'mobile' },
    });
    expect(executions[1]).toMatchObject({
      capabilityId: 'unregister-push-token',
      input: { deviceEnrollmentId: ids.device },
    });
    expect(invocationRequests.map((request) => request.mutation)).toEqual([
      { idempotencyKey: 'device-route-idempotency-0001' },
      { idempotencyKey: 'device-route-idempotency-0001' },
    ]);
    expect(await registerResponse.text()).not.toContain(token);
  });

  test('uses safe defaults for the credential-free current-user device page', async () => {
    const { executions, runtime } = humanRouteRuntime();
    const response = await handleListMyDevices(
      new Request('https://eoc.example.test/api/devices'),
      runtime,
    );

    expect(response.status).toBe(200);
    expect(executions[0]).toMatchObject({
      capabilityId: 'list-my-devices',
      input: { includeRevoked: false, cursor: null, limit: 50 },
      invocation: { mutation: null },
    });
  });

  test('rejects token registration without mutation idempotency metadata', async () => {
    const { executions, runtime } = humanRouteRuntime();
    const response = await handleRegisterPushToken(
      new Request('https://eoc.example.test/api/devices/push-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceEnrollmentId: ids.device,
          platform: 'ios',
          token,
        }),
      }),
      runtime,
    );

    expect(response.status).toBe(400);
    expect(executions).toHaveLength(0);
    expect(await response.text()).not.toContain(token);
  });
});

describe('push endpoint invalidation route', () => {
  const canonicalInput = Object.freeze({
    rosterSnapshotId: ids.roster,
    recipientId: ids.recipient,
    endpointId: ids.endpoint,
    status: 'invalid' as const,
    reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
  });

  test('authenticates before parsing and exposes only the fixed worker capability', async () => {
    const dependencies = workerDependencies();
    const unauthenticated = await handlePushEndpointInvalidation(
      new Request(
        'https://eoc.example.test/api/devices/internal/push-token-invalidation',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer wrong-worker-token',
            'content-type': 'application/json',
          },
          body: '{malformed',
        },
      ),
      dependencies,
    );

    expect(unauthenticated.status).toBe(401);
    expect(dependencies.calls).toHaveLength(0);

    const response = await handlePushEndpointInvalidation(
      pushInvalidationRequest(canonicalInput),
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(dependencies.calls).toHaveLength(1);
    expect(dependencies.calls[0]).toMatchObject({
      input: canonicalInput,
      invocation: {
        actor: {
          kind: 'system',
          serviceId: PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
        },
        source: 'worker',
        connectivityEpochId: null,
        mutation: {
          transport: { kind: 'worker-execution' },
          humanConfirmationId: null,
        },
      },
    });
    expect(dependencies.calls[0]?.invocation.mutation?.idempotencyKey).toMatch(
      /^push-endpoint-invalid:[a-f0-9]{64}$/u,
    );
  });

  test('reconciles repeated endpoint input as distinct authenticated deliveries', async () => {
    const base = workerDependencies();
    const requestIds = [ids.request, ids.secondRequest] as const;
    let requestIndex = 0;
    const dependencies: PushEndpointInvalidationRouteDependencies & {
      readonly calls: typeof base.calls;
    } = {
      ...base,
      createRequestId: () => requestIds[requestIndex++] ?? ids.secondRequest,
    };

    const first = await handlePushEndpointInvalidation(
      pushInvalidationRequest(canonicalInput),
      dependencies,
    );
    const second = await handlePushEndpointInvalidation(
      pushInvalidationRequest(canonicalInput),
      dependencies,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(dependencies.calls).toHaveLength(2);
    expect(dependencies.calls.map((call) => call.invocation.requestId)).toEqual(
      [...requestIds],
    );
    expect(
      new Set(
        dependencies.calls.map(
          (call) => call.invocation.mutation?.idempotencyKey,
        ),
      ).size,
    ).toBe(2);
  });

  test('rejects broader status writes and token-bearing request fields', async () => {
    const dependencies = workerDependencies();
    const broadResponse = await handlePushEndpointInvalidation(
      pushInvalidationRequest({
        ...canonicalInput,
        status: 'disabled',
        reasonCode: 'ARBITRARY_DISABLE',
      }),
      dependencies,
    );
    const tokenResponse = await handlePushEndpointInvalidation(
      pushInvalidationRequest({ ...canonicalInput, token }),
      dependencies,
    );

    expect(broadResponse.status).toBe(400);
    expect(tokenResponse.status).toBe(400);
    expect(dependencies.calls).toHaveLength(0);
    expect(await tokenResponse.text()).not.toContain(token);
  });

  test('reports bounded-body and media-type failures precisely', async () => {
    const dependencies = workerDependencies();
    const oversized = await handlePushEndpointInvalidation(
      new Request(
        'https://eoc.example.test/api/devices/internal/push-token-invalidation',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${workerBearer}`,
            'content-type': 'application/json',
            'content-length': '8193',
          },
          body: '{}',
        },
      ),
      dependencies,
    );
    const unsupported = await handlePushEndpointInvalidation(
      new Request(
        'https://eoc.example.test/api/devices/internal/push-token-invalidation',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${workerBearer}`,
            'content-type': 'text/plain',
          },
          body: JSON.stringify(canonicalInput),
        },
      ),
      dependencies,
    );

    expect(oversized.status).toBe(413);
    expect(unsupported.status).toBe(415);
    expect(dependencies.calls).toHaveLength(0);
  });

  test('fails closed for missing or unsafe route-specific credentials', () => {
    expect(() => readPushEndpointWorkerToken({})).toThrow();
    expect(() =>
      readPushEndpointWorkerToken({
        PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN: 'contains whitespace and is unsafe',
      }),
    ).toThrow();
    expect(
      verifyPushEndpointWorkerToken(`Bearer ${workerBearer}`, workerBearer),
    ).toBe(true);
    expect(
      verifyPushEndpointWorkerToken(
        'Bearer another-worker-token',
        workerBearer,
      ),
    ).toBe(false);
  });
});
