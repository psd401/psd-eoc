import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { workItem } from '../shared/test-fixtures';
import {
  PUSH_ENDPOINT_ELIGIBILITY_PATH,
  PushEndpointEligibilityClient,
  PushEndpointEligibilityError,
  createProductionPushEndpointEligibilityClient,
} from './eligibility';

const bearer = 'synthetic-push-worker-token-eligibility-00000001';

describe('push endpoint send eligibility client', () => {
  test('sends only exact endpoint identities and a token digest', async () => {
    const item = workItem();
    if (item.endpoint.channel !== 'push') throw new Error('Fixture mismatch.');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new PushEndpointEligibilityClient({
      serviceOrigin: 'https://eoc.example.test',
      bearerToken: bearer,
      async fetch(input, init = {}) {
        calls.push({ url: String(input), init });
        return Response.json({ version: 1, eligible: true });
      },
    });

    await expect(client.isEligible(item)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://eoc.example.test${PUSH_ENDPOINT_ELIGIBILITY_PATH}`,
    );
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
    const body = String(calls[0]?.init.body);
    expect(body).not.toContain(item.endpoint.token);
    expect(JSON.parse(body)).toEqual({
      version: 1,
      rosterSnapshotId: item.attempt.rosterSnapshotId,
      rosterPopulation: item.attempt.rosterPopulation,
      recipientId: item.attempt.recipientId,
      endpointId: item.attempt.endpointId,
      platform: item.endpoint.platform,
      provider: item.endpoint.provider,
      serviceEnvironment: item.endpoint.serviceEnvironment,
      tokenDigest: createHash('sha256')
        .update(item.endpoint.token, 'utf8')
        .digest('hex'),
    });
  });

  test('returns an explicit current-policy denial without treating it as proof', async () => {
    const client = new PushEndpointEligibilityClient({
      serviceOrigin: 'https://eoc.example.test',
      bearerToken: bearer,
      fetch: () =>
        Promise.resolve(Response.json({ version: 1, eligible: false })),
    });

    await expect(client.isEligible(workItem())).resolves.toBe(false);
  });

  test.each([
    {
      name: 'malformed response',
      fetch: () => Promise.resolve(Response.json({ eligible: true })),
      code: 'INVALID_RESPONSE',
    },
    {
      name: 'unauthorized response',
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
      code: 'REQUEST_UNAUTHORIZED',
    },
    {
      name: 'policy store unavailable',
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
      code: 'RETRYABLE_RESPONSE',
    },
  ] as const)('fails closed for $name', async ({ fetch, code }) => {
    const client = new PushEndpointEligibilityClient({
      serviceOrigin: 'https://eoc.example.test',
      bearerToken: bearer,
      fetch,
    });

    const error = await client
      .isEligible(workItem())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PushEndpointEligibilityError);
    expect(error).toMatchObject({ code });
  });

  test('aborts a stalled policy request and fails closed', async () => {
    const client = new PushEndpointEligibilityClient({
      serviceOrigin: 'https://eoc.example.test',
      bearerToken: bearer,
      timeoutMilliseconds: 100,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error()), {
            once: true,
          });
        }),
    });

    const error = await client
      .isEligible(workItem())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'REQUEST_FAILED', retryable: true });
  });

  test('rejects unsafe origins and credentials before network access', () => {
    expect(
      () =>
        new PushEndpointEligibilityClient({
          serviceOrigin: 'http://eoc.example.test',
          bearerToken: bearer,
        }),
    ).toThrow(PushEndpointEligibilityError);
    expect(
      () =>
        new PushEndpointEligibilityClient({
          serviceOrigin: 'https://eoc.example.test',
          bearerToken: 'too-short',
        }),
    ).toThrow(PushEndpointEligibilityError);
  });

  test('builds production clients only from exact transport configuration', () => {
    expect(
      createProductionPushEndpointEligibilityClient({
        serviceOrigin: 'https://eoc.example.test',
        bearerToken: bearer,
        timeoutMilliseconds: 1_000,
      }),
    ).toBeInstanceOf(PushEndpointEligibilityClient);
    expect(() =>
      createProductionPushEndpointEligibilityClient({
        serviceOrigin: 'http://eoc.example.test',
        bearerToken: bearer,
      }),
    ).toThrow(PushEndpointEligibilityError);
    expect(() =>
      createProductionPushEndpointEligibilityClient({
        serviceOrigin: 'https://eoc.example.test',
        bearerToken: bearer,
        timeoutMilliseconds: 99,
      }),
    ).toThrow(PushEndpointEligibilityError);
    expect(() =>
      createProductionPushEndpointEligibilityClient({
        serviceOrigin: 'https://eoc.example.test',
        bearerToken: bearer,
        fetch: () =>
          Promise.resolve(Response.json({ version: 1, eligible: true })),
      } as unknown as Parameters<
        typeof createProductionPushEndpointEligibilityClient
      >[0]),
    ).toThrow(PushEndpointEligibilityError);
  });
});
