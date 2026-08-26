import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  EndpointSchema,
  type Endpoint,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import { attemptFor, realBatch, TIMES } from '../shared/test-fixtures';
import { ApnsJwtCredential } from './apns-credentials';
import {
  APNS_DEVELOPMENT_ORIGIN,
  APNS_MAX_PAYLOAD_BYTES,
  APNS_PRODUCTION_ORIGIN,
  ApnsPushTransport,
  classifyApnsResponse,
  type ApnsHttp2Client,
  type ApnsHttp2Request,
  type ApnsHttp2Response,
} from './apns-transport';
import type { DirectPushTransport } from './direct-protocol';

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(128)}\n-----END PRIVATE KEY-----`;
const DEVICE_TOKEN = 'a'.repeat(64);
const APNS_ID = '12345678-1234-1234-1234-123456789abc';

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

function apnsWork(
  environment: 'development' | 'production' = 'development',
): WorkerAttemptWorkItem {
  const batch = directBatch();
  const endpoint: Endpoint = EndpointSchema.parse({
    id: '00000000-0000-4000-8000-000000000012',
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'push',
    platform: 'ios',
    provider: 'apns',
    serviceEnvironment: environment,
    token: DEVICE_TOKEN,
  });
  return Object.freeze({ batch, attempt: attemptFor(batch), endpoint });
}

function response(
  status: number,
  body: unknown = null,
  id: string | undefined = APNS_ID,
): ApnsHttp2Response {
  return {
    status,
    headers: { 'apns-id': id },
    body:
      body === null
        ? new Uint8Array()
        : new TextEncoder().encode(JSON.stringify(body)),
  };
}

function credential() {
  return new ApnsJwtCredential({
    teamId: 'TEAMID1234',
    keyId: 'KEYID12345',
    privateKey: PRIVATE_KEY,
    signer: () => 'header.payload.signature',
    clock: () => TIMES.attempted,
  });
}

class CapturingClient implements ApnsHttp2Client {
  public readonly requests: ApnsHttp2Request[] = [];

  public constructor(private readonly result: ApnsHttp2Response | Error) {}

  public request(request: ApnsHttp2Request): Promise<ApnsHttp2Response> {
    this.requests.push(request);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

async function sendPrepared(
  transport: DirectPushTransport,
  workItem: WorkerAttemptWorkItem,
) {
  const preparation = await transport.prepare(workItem);
  if (preparation.kind === 'outcome') return preparation.outcome;
  return preparation.send();
}

describe('apns-contract: direct APNs HTTP/2 transport', () => {
  test('pins HTTP/2 TLS environment, topic, expiration, and canonical incident payload', async () => {
    const client = new CapturingClient(response(200));
    const transport = new ApnsPushTransport({
      topic: 'org.example.eoc',
      environment: 'development',
      credential: credential(),
      client,
      authorizeLiveTransport: () => true,
      clock: () => TIMES.attempted,
    });

    await expect(sendPrepared(transport, apnsWork())).resolves.toEqual({
      kind: 'provider-accepted',
      state: 'provider-accepted',
      providerReference: APNS_ID,
      reasonCode: null,
      invalidatesEndpoint: false,
      providerOccurredAt: null,
    });
    const request = client.requests[0];
    expect(request?.origin).toBe(APNS_DEVELOPMENT_ORIGIN);
    expect(request?.tls).toEqual({
      alpnProtocol: 'h2',
      minimumVersion: 'TLSv1.2',
      servername: 'api.sandbox.push.apple.com',
    });
    expect(request?.headers).toMatchObject({
      authorization: 'bearer header.payload.signature',
      'apns-topic': 'org.example.eoc',
      'apns-push-type': 'alert',
      'apns-expiration': String(Date.parse(TIMES.created) / 1_000 + 3_600),
    });
    expect(request?.body.byteLength).toBeLessThanOrEqual(
      APNS_MAX_PAYLOAD_BYTES,
    );
    const payload = JSON.parse(new TextDecoder().decode(request?.body));
    expect(payload).toMatchObject({
      aps: { alert: { title: '[INCIDENT] Lockdown' } },
      eventKind: 'incident',
      templateMode: 'real',
    });

    const productionClient = new CapturingClient(response(200));
    await sendPrepared(
      new ApnsPushTransport({
        topic: 'org.example.eoc',
        environment: 'production',
        credential: credential(),
        client: productionClient,
        authorizeLiveTransport: () => true,
        clock: () => TIMES.attempted,
      }),
      apnsWork('production'),
    );
    expect(productionClient.requests[0]?.origin).toBe(APNS_PRODUCTION_ORIGIN);
  });

  test('classifies documented rejection, invalidation, retry, and malformed boundaries', () => {
    expect(
      classifyApnsResponse(response(400, { reason: 'BadDeviceToken' })),
    ).toMatchObject({
      kind: 'endpoint-invalidating-failure',
      reasonCode: 'APNS_BAD_DEVICE_TOKEN',
      invalidatesEndpoint: true,
    });
    expect(
      classifyApnsResponse(
        response(410, { reason: 'Unregistered', timestamp: 1_777_777_777_000 }),
      ),
    ).toMatchObject({
      kind: 'endpoint-invalidating-failure',
      reasonCode: 'APNS_UNREGISTERED',
      providerOccurredAt: '2026-05-03T03:09:37.000Z',
    });
    expect(
      classifyApnsResponse(response(429, { reason: 'TooManyRequests' })),
    ).toMatchObject({
      kind: 'retryable-failure',
      reasonCode: 'APNS_THROTTLED',
    });
    expect(
      classifyApnsResponse(response(503, { reason: 'ServiceUnavailable' })),
    ).toMatchObject({ reasonCode: 'APNS_SERVER_ERROR' });
    expect(
      classifyApnsResponse(response(403, { reason: 'InvalidProviderToken' })),
    ).toMatchObject({
      kind: 'terminal-failure',
      reasonCode: 'APNS_AUTHENTICATION_FAILED',
    });
    expect(
      classifyApnsResponse(response(410, { reason: 'Unregistered' })),
    ).toMatchObject({
      kind: 'unknown',
      reasonCode: 'APNS_RESPONSE_INVALID',
    });
    expect(
      classifyApnsResponse({
        status: 400,
        headers: {},
        body: new Uint8Array(16_385),
      }),
    ).toMatchObject({ reasonCode: 'APNS_RESPONSE_INVALID' });
    for (const id of [
      'a---------------',
      '12345678123412341234123456789abc',
      '12345678-1234-1234-1234-123456789abz',
    ]) {
      expect(classifyApnsResponse(response(200, null, id))).toMatchObject({
        kind: 'unknown',
        reasonCode: 'APNS_RESPONSE_INVALID',
      });
    }
  });

  test('expires before I/O, rejects endpoint environment mismatch, and makes post-boundary timeout unknown', async () => {
    const client = new CapturingClient(response(200));
    const expired = new ApnsPushTransport({
      topic: 'org.example.eoc',
      environment: 'development',
      credential: credential(),
      client,
      authorizeLiveTransport: () => true,
      clock: () => Date.parse(TIMES.created) + 3_600_000,
    });
    await expect(sendPrepared(expired, apnsWork())).resolves.toMatchObject({
      kind: 'expired',
      reasonCode: 'APNS_NOTIFICATION_EXPIRED',
    });
    expect(client.requests).toHaveLength(0);

    await expect(
      sendPrepared(expired, apnsWork('production')),
    ).resolves.toMatchObject({
      reasonCode: 'APNS_ENDPOINT_INELIGIBLE',
    });
    expect(client.requests).toHaveLength(0);

    const failedClient = new CapturingClient(
      new Error('synthetic stream reset'),
    );
    const ambiguous = new ApnsPushTransport({
      topic: 'org.example.eoc',
      environment: 'development',
      credential: credential(),
      client: failedClient,
      authorizeLiveTransport: () => true,
      clock: () => TIMES.attempted,
    });
    await expect(sendPrepared(ambiguous, apnsWork())).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'APNS_NETWORK_OUTCOME_AMBIGUOUS',
    });
  });

  test('rechecks absolute expiration after credential and authorization delay', async () => {
    let now = Date.parse(TIMES.attempted);
    const client = new CapturingClient(response(200));
    const transport = new ApnsPushTransport({
      topic: 'org.example.eoc',
      environment: 'development',
      credential: credential(),
      client,
      authorizeLiveTransport: () => {
        now = Date.parse(TIMES.created) + 3_600_000;
        return true;
      },
      clock: () => now,
    });
    await expect(sendPrepared(transport, apnsWork())).resolves.toMatchObject({
      kind: 'expired',
      reasonCode: 'APNS_NOTIFICATION_EXPIRED',
    });
    expect(client.requests).toHaveLength(0);
  });
});
