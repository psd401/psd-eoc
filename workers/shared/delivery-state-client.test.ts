import { describe, expect, test } from 'bun:test';

import {
  DELIVERY_STATE_WRITEBACK_PATH,
  DeliveryStateWritebackClient,
  DeliveryStateWritebackError,
  parseDeliveryStateWriteRequest,
  type AttemptEvidenceInput,
  type DeliveryStateWriteRequest,
} from './delivery-state-client';
import { IDS, TIMES, attemptFor, syntheticBatch } from './test-fixtures';

const TOKEN = 'synthetic-worker-credential-00000001';

function request(): DeliveryStateWriteRequest {
  const attempt = attemptFor(syntheticBatch());
  const evidence: AttemptEvidenceInput = {
    subject: { kind: 'attempt', attemptId: attempt.id },
    state: 'attempted',
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  };
  return { attempt, evidence };
}

function evidenceResult() {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    subject: { kind: 'attempt', attemptId: IDS.attempt },
    sequence: 1,
    previousEvidenceId: null,
    state: 'attempted',
    recordedAt: TIMES.recorded,
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  } as const;
}

describe('delivery-state writeback request', () => {
  test('strictly composes canonical attempt and evidence contracts', () => {
    expect(parseDeliveryStateWriteRequest(request())).toEqual(request());
    expect(() =>
      parseDeliveryStateWriteRequest({ ...request(), eventId: IDS.event }),
    ).toThrow(DeliveryStateWritebackError);
    expect(() =>
      parseDeliveryStateWriteRequest({
        ...request(),
        evidence: {
          ...request().evidence,
          subject: { kind: 'attempt', attemptId: IDS.secondAttempt },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});

describe('fixed-path delivery-state client', () => {
  test('POSTs only the strict request to the fixed internal path', async () => {
    const calls: Readonly<{ input: string; init: RequestInit }>[] = [];
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ input: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ result: evidenceResult() }), {
        status: 200,
      });
    };
    const client = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: fetcher,
    });

    await expect(client.recordAttemptEvidence(request())).resolves.toEqual(
      evidenceResult(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      `https://internal.psd-eoc.invalid${DELIVERY_STATE_WRITEBACK_PATH}`,
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(request());
    expect(calls[0]?.init.headers).toEqual(
      expect.objectContaining({
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      }),
    );
    expect('request' in client).toBe(false);
    expect('mutateEvent' in client).toBe(false);
  });

  test('accepts retained stronger truth only from the same provider lineage', async () => {
    const attempted = request();
    const providerAccepted: DeliveryStateWriteRequest = {
      attempt: attempted.attempt,
      evidence: {
        ...attempted.evidence,
        state: 'provider-accepted',
        provider: 'aws-ses-v2',
        providerReference: 'synthetic-provider-reference',
      },
    };
    const delivered = {
      ...evidenceResult(),
      id: '00000000-0000-4000-8000-000000000102',
      sequence: 3,
      previousEvidenceId: '00000000-0000-4000-8000-000000000101',
      state: 'delivered',
      provider: 'aws-ses-v2',
      providerReference: 'synthetic-provider-reference',
      proof: {
        kind: 'provider-delivery-receipt',
        provider: 'aws-ses-v2',
        receiptId: 'synthetic-receipt',
        deliveredAt: TIMES.recorded,
      },
    } as const;
    const client = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ result: delivered }), { status: 200 }),
        ),
    });

    await expect(
      client.recordAttemptEvidence(providerAccepted),
    ).resolves.toEqual(delivered);

    for (const mismatchedTerminal of [
      {
        ...delivered,
        providerReference: 'different-provider-reference',
      },
      {
        ...delivered,
        provider: 'different-provider',
        proof: { ...delivered.proof, provider: 'different-provider' },
      },
    ]) {
      const mismatchedLineageClient = new DeliveryStateWritebackClient({
        serviceOrigin: 'https://internal.psd-eoc.invalid',
        bearerToken: TOKEN,
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ result: mismatchedTerminal }), {
              status: 200,
            }),
          ),
      });
      await expect(
        mismatchedLineageClient.recordAttemptEvidence(providerAccepted),
      ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    }

    const referenceFreeUnknown: DeliveryStateWriteRequest = {
      attempt: attempted.attempt,
      evidence: {
        ...attempted.evidence,
        state: 'unknown',
        provider: 'aws-ses-v2',
        providerReference: null,
        reasonCode: 'SES_SEND_OUTCOME_UNKNOWN',
        diagnosticDigest: 'a'.repeat(64),
      },
    };
    await expect(
      client.recordAttemptEvidence(referenceFreeUnknown),
    ).resolves.toEqual(delivered);

    const providerNeutralUnknown: DeliveryStateWriteRequest = {
      attempt: attempted.attempt,
      evidence: {
        ...referenceFreeUnknown.evidence,
        provider: null,
        reasonCode: 'RECONCILIATION_DEADLINE_EXCEEDED',
        diagnosticDigest: null,
      },
    };
    await expect(
      client.recordAttemptEvidence(providerNeutralUnknown),
    ).resolves.toEqual(delivered);

    const accepted = {
      ...evidenceResult(),
      id: '00000000-0000-4000-8000-000000000103',
      sequence: 2,
      previousEvidenceId: '00000000-0000-4000-8000-000000000101',
      state: 'provider-accepted',
      provider: 'aws-ses-v2',
      providerReference: 'synthetic-provider-reference',
    } as const;
    const acceptedClient = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ result: accepted }), { status: 200 }),
        ),
    });
    await expect(
      acceptedClient.recordAttemptEvidence(referenceFreeUnknown),
    ).resolves.toEqual(accepted);

    const mismatchedAcceptedClient = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              result: { ...accepted, provider: 'different-provider' },
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      mismatchedAcceptedClient.recordAttemptEvidence(referenceFreeUnknown),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_RESPONSE' }));

    const mismatchedUnknownClient = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              result: {
                ...delivered,
                provider: 'different-provider',
                proof: { ...delivered.proof, provider: 'different-provider' },
              },
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      mismatchedUnknownClient.recordAttemptEvidence(referenceFreeUnknown),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  test('does not transport intent evidence or mismatched attempts', async () => {
    let calls = 0;
    const client = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: async () => {
        calls += 1;
        return new Response('{}');
      },
    });
    await expect(
      client.recordAttemptEvidence({
        attempt: request().attempt,
        evidence: {
          subject: { kind: 'intent', intentId: IDS.intent },
          state: 'accepted',
          provider: null,
          providerReference: null,
          proof: null,
          reasonCode: null,
          diagnosticDigest: null,
        },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(calls).toBe(0);
  });

  test('fails closed on auth, retryable status, and response mismatch', async () => {
    for (const [status, code, retryable] of [
      [401, 'REQUEST_UNAUTHORIZED', false],
      [429, 'RETRYABLE_RESPONSE', true],
      [503, 'RETRYABLE_RESPONSE', true],
    ] as const) {
      const client = new DeliveryStateWritebackClient({
        serviceOrigin: 'https://internal.psd-eoc.invalid',
        bearerToken: TOKEN,
        fetch: async () => new Response('{}', { status }),
      });
      await expect(client.recordAttemptEvidence(request())).rejects.toEqual(
        expect.objectContaining({ code, retryable, status }),
      );
    }

    const mismatch = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: async () =>
        new Response(
          JSON.stringify({
            result: {
              ...evidenceResult(),
              subject: { kind: 'attempt', attemptId: IDS.secondAttempt },
            },
          }),
        ),
    });
    await expect(mismatch.recordAttemptEvidence(request())).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );

    const oversized = new DeliveryStateWritebackClient({
      serviceOrigin: 'https://internal.psd-eoc.invalid',
      bearerToken: TOKEN,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
        ),
    });
    await expect(oversized.recordAttemptEvidence(request())).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );
  });

  test('requires a 32-byte token and credential-safe HTTPS origin', () => {
    for (const options of [
      {
        serviceOrigin: 'http://internal.psd-eoc.invalid',
        bearerToken: TOKEN,
      },
      {
        serviceOrigin: 'https://internal.psd-eoc.invalid/event',
        bearerToken: TOKEN,
      },
      {
        serviceOrigin: 'https://internal.psd-eoc.invalid',
        bearerToken: 'too-short',
      },
    ]) {
      expect(() => new DeliveryStateWritebackClient(options)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
  });
});
