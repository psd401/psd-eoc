import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  EndpointSchema,
  type Endpoint,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import { attemptFor, realBatch, TIMES } from '../shared/test-fixtures';
import { FcmOAuthCredential } from './fcm-credentials';
import { FcmOAuthTokenSourceError } from './provider-clients';
import {
  FCM_API_ORIGIN,
  FcmPushTransport,
  classifyFcmResponse,
  type FcmPushFetch,
} from './fcm-transport';
import type { DirectPushTransport } from './direct-protocol';

const DEVICE_TOKEN = `synthetic-fcm-token-${'a'.repeat(64)}`;

function directBatch() {
  const batch = realBatch();
  return DispatchBatchSchema.parse({
    ...batch,
    integrationStatus: {
      ...batch.integrationStatus,
      integrationId: 'mobile-push',
    },
  });
}

function fcmWork(
  environment: 'development' | 'production' = 'production',
): WorkerAttemptWorkItem {
  const batch = directBatch();
  const endpoint: Endpoint = EndpointSchema.parse({
    id: '00000000-0000-4000-8000-000000000012',
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'push',
    platform: 'android',
    provider: 'fcm',
    serviceEnvironment: environment,
    token: DEVICE_TOKEN,
  });
  return Object.freeze({ batch, attempt: attemptFor(batch), endpoint });
}

function credential(projectId = 'synthetic-project-1') {
  return new FcmOAuthCredential({
    projectId,
    clock: () => TIMES.attempted,
    tokenSource: (request) => ({
      projectId: request.projectId,
      accessToken: 'synthetic-access-token-0001',
      expiresAt: Date.parse(TIMES.attempted) + 60 * 60_000,
    }),
  });
}

function fcmError(
  status: string,
  errorCode: string,
  httpStatus: number,
): Response {
  return Response.json(
    {
      error: {
        code: httpStatus,
        message: 'bounded synthetic provider message',
        status,
        details: [
          {
            '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            errorCode,
          },
        ],
      },
    },
    { status: httpStatus },
  );
}

async function sendPrepared(
  transport: DirectPushTransport,
  workItem: WorkerAttemptWorkItem,
) {
  const preparation = await transport.prepare(workItem);
  if (preparation.kind === 'outcome') return preparation.outcome;
  return preparation.send();
}

describe('fcm-contract: direct FCM HTTP v1 transport', () => {
  test('pins project URL, short-lived OAuth, expiration, and canonical incident payload', async () => {
    const calls: Array<Readonly<{ input: string; init: RequestInit }>> = [];
    const fetch: FcmPushFetch = (input, init = {}) => {
      calls.push({ input: String(input), init });
      return Promise.resolve(
        Response.json({
          name: 'projects/synthetic-project-1/messages/abc:123',
        }),
      );
    };
    const transport = new FcmPushTransport({
      projectId: 'synthetic-project-1',
      serviceEnvironment: 'production',
      credential: credential(),
      fetch,
      authorizeLiveTransport: () => true,
      clock: () => TIMES.attempted,
    });

    await expect(sendPrepared(transport, fcmWork())).resolves.toMatchObject({
      kind: 'provider-accepted',
      providerReference: expect.stringMatching(/^fcm-[a-f0-9]{64}$/u),
    });
    expect(calls[0]?.input).toBe(
      `${FCM_API_ORIGIN}/v1/projects/synthetic-project-1/messages:send`,
    );
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer synthetic-access-token-0001',
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      message: {
        token: DEVICE_TOKEN,
        notification: { title: '[INCIDENT] Lockdown' },
        data: { eventKind: 'incident', templateMode: 'real' },
        android: { priority: 'high', ttl: '3599s' },
        apns: {
          headers: {
            'apns-expiration': String(
              Date.parse(TIMES.created) / 1_000 + 3_600,
            ),
          },
        },
      },
    });
  });

  test('rejects project mismatch before construction', () => {
    expect(
      () =>
        new FcmPushTransport({
          projectId: 'synthetic-project-1',
          serviceEnvironment: 'production',
          credential: credential('different-project-1'),
          fetch: () => Promise.reject(new Error('must not run')),
        }),
    ).toThrow('FCM credential project does not match transport.');
  });

  test('rejects a success name from a different project', async () => {
    for (const name of [
      'projects/different-project-1/messages/abc',
      'projects/synthetic-project-1/messages/',
      'projects/synthetic-project-1/messages/abc/extra',
      'projects/synthetic-project-1/messages/invalid value',
      `projects/synthetic-project-1/messages/${'a'.repeat(513)}`,
    ]) {
      await expect(
        classifyFcmResponse(
          Response.json({ name }),
          true,
          'synthetic-project-1',
        ),
      ).resolves.toMatchObject({
        kind: 'unknown',
        reasonCode: 'FCM_RESPONSE_INVALID',
      });
    }
  });

  test('classifies UNREGISTERED, payload-sensitive INVALID_ARGUMENT, throttle, and malformed responses', async () => {
    await expect(
      classifyFcmResponse(fcmError('NOT_FOUND', 'UNREGISTERED', 404), true),
    ).resolves.toMatchObject({
      kind: 'endpoint-invalidating-failure',
      reasonCode: 'FCM_UNREGISTERED',
    });
    await expect(
      classifyFcmResponse(
        fcmError('INVALID_ARGUMENT', 'INVALID_ARGUMENT', 400),
        true,
      ),
    ).resolves.toMatchObject({
      kind: 'endpoint-invalidating-failure',
      reasonCode: 'FCM_INVALID_ARGUMENT',
    });
    await expect(
      classifyFcmResponse(
        fcmError('INVALID_ARGUMENT', 'INVALID_ARGUMENT', 400),
        false,
      ),
    ).resolves.toMatchObject({
      kind: 'terminal-failure',
      reasonCode: 'FCM_PAYLOAD_INVALID',
    });
    await expect(
      classifyFcmResponse(
        fcmError('RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 429),
        true,
      ),
    ).resolves.toMatchObject({
      kind: 'retryable-failure',
      reasonCode: 'FCM_THROTTLED',
    });
    await expect(
      classifyFcmResponse(new Response('{', { status: 500 }), true),
    ).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'FCM_RESPONSE_INVALID',
    });

    for (const [status, canonicalStatus, reasonCode] of [
      [429, 'RESOURCE_EXHAUSTED', 'FCM_THROTTLED'],
      [503, 'UNAVAILABLE', 'FCM_SERVER_ERROR'],
      [401, 'UNAUTHENTICATED', 'FCM_AUTHENTICATION_FAILED'],
    ] as const) {
      await expect(
        classifyFcmResponse(
          Response.json(
            {
              error: {
                code: status,
                message: 'bounded synthetic provider message',
                status: canonicalStatus,
              },
            },
            { status },
          ),
          true,
        ),
      ).resolves.toMatchObject({ reasonCode });
    }
  });

  test('classifies a retryable invalid OAuth response before provider-send preparation', async () => {
    let fetchCalls = 0;
    const transport = new FcmPushTransport({
      projectId: 'synthetic-project-1',
      serviceEnvironment: 'production',
      credential: new FcmOAuthCredential({
        projectId: 'synthetic-project-1',
        tokenSource: () => {
          throw new FcmOAuthTokenSourceError(
            'FCM_OAUTH_RESPONSE_INVALID',
            true,
            200,
          );
        },
      }),
      fetch: () => {
        fetchCalls += 1;
        return Promise.reject(new Error('must not run'));
      },
      authorizeLiveTransport: () => true,
      clock: () => TIMES.attempted,
    });
    await expect(sendPrepared(transport, fcmWork())).resolves.toMatchObject({
      kind: 'retryable-failure',
      reasonCode: 'FCM_AUTHENTICATION_UNAVAILABLE',
    });
    expect(fetchCalls).toBe(0);
  });

  test('expires before I/O and makes timeout after fetch invocation unknown', async () => {
    let calls = 0;
    const fetch: FcmPushFetch = async (_input, init) => {
      calls += 1;
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('synthetic timeout')),
        );
      });
      throw new Error('unreachable');
    };
    const expired = new FcmPushTransport({
      projectId: 'synthetic-project-1',
      serviceEnvironment: 'production',
      credential: credential(),
      fetch,
      authorizeLiveTransport: () => true,
      timeoutMilliseconds: 100,
      clock: () => Date.parse(TIMES.created) + 3_600_000,
    });
    await expect(sendPrepared(expired, fcmWork())).resolves.toMatchObject({
      kind: 'expired',
      reasonCode: 'FCM_NOTIFICATION_EXPIRED',
    });
    expect(calls).toBe(0);

    const ambiguous = new FcmPushTransport({
      projectId: 'synthetic-project-1',
      serviceEnvironment: 'production',
      credential: credential(),
      fetch,
      authorizeLiveTransport: () => true,
      timeoutMilliseconds: 100,
      clock: () => TIMES.attempted,
    });
    await expect(sendPrepared(ambiguous, fcmWork())).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'FCM_NETWORK_OUTCOME_AMBIGUOUS',
    });
    expect(calls).toBe(1);
  });
});
