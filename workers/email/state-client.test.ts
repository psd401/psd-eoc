import { describe, expect, test } from 'bun:test';

import { EmailRuntimeClient, EmailRuntimeClientError } from './state-client';
import { IDS, emailDeliveryTestWorkItem } from '../shared/test-fixtures';

const TOKEN = 'email-worker-token-'.padEnd(48, 'x');
const ATTEMPT_ID = IDS.attempt;
const VERIFICATION_REFERENCE = 'deployment:commit-277';

describe('email runtime HTTP client', () => {
  test('authenticates a strict durable provider-I/O claim', async () => {
    const requests: Array<{
      readonly url: string;
      readonly authorization: string | null;
      readonly body: string | null;
    }> = [];
    const fetchMock = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return Response.json({ kind: 'in-progress' });
    }) as unknown as typeof globalThis.fetch;
    const client = new EmailRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      verificationReference: VERIFICATION_REFERENCE,
      fetch: fetchMock,
    });
    const workItem = emailDeliveryTestWorkItem();
    await expect(
      client.claim({
        attemptId: ATTEMPT_ID,
        requestFingerprint: 'a'.repeat(64),
        workItem,
      }),
    ).resolves.toEqual({ kind: 'in-progress' });
    expect(requests[0]?.url).toBe(
      'https://eoc.example.invalid/api/internal/email-runtime',
    );
    expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      operation: 'claim-provider-io',
      verificationReference: VERIFICATION_REFERENCE,
      attemptId: ATTEMPT_ID,
      requestFingerprint: 'a'.repeat(64),
      workItem,
    });
  });

  test('fails closed on malformed responses and unsafe configuration', async () => {
    expect(
      () =>
        new EmailRuntimeClient({
          serviceOrigin: 'http://eoc.example.invalid',
          bearerToken: TOKEN,
          verificationReference: VERIFICATION_REFERENCE,
        }),
    ).toThrow(EmailRuntimeClientError);
    const client = new EmailRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      verificationReference: VERIFICATION_REFERENCE,
      fetch: (() =>
        Promise.resolve(
          Response.json({ kind: 'acquired', leaseToken: 'bad' }),
        )) as unknown as typeof globalThis.fetch,
    });
    const workItem = emailDeliveryTestWorkItem();
    await expect(
      client.claim({
        attemptId: ATTEMPT_ID,
        requestFingerprint: 'a'.repeat(64),
        workItem,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  test('cancels a chunked runtime response at the byte limit', async () => {
    let cancelled = false;
    const client = new EmailRuntimeClient({
      serviceOrigin: 'https://eoc.example.invalid',
      bearerToken: TOKEN,
      verificationReference: VERIFICATION_REFERENCE,
      fetch: (() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(300 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200 },
          ),
        )) as unknown as typeof globalThis.fetch,
    });

    await expect(client.resolveRetry(ATTEMPT_ID)).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );
    expect(cancelled).toBe(true);
  });

  test('rejects a stale-shaped verification reference before networking', () => {
    expect(
      () =>
        new EmailRuntimeClient({
          serviceOrigin: 'https://eoc.example.invalid',
          bearerToken: TOKEN,
          verificationReference: 'stale',
        }),
    ).toThrow(EmailRuntimeClientError);
  });
});
