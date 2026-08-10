import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  DeliveryTruthTransitionSchema,
  type CapabilityAuthorizationRequest,
  type ChannelAttempt,
  type DeliveryEvidence,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';

import {
  DeliveryStateError,
  createDeliveryStateAuthorizer,
  createDeliveryStateRouteHandler,
  createRecordDeliveryEvidenceHandler,
  type AttemptEvidenceInput,
  type DeliveryEvidenceCapabilityContext,
  type DeliveryEvidenceStore,
  type DeliveryStateRouteDependencies,
  type DeliveryStateRouteRuntime,
  type DeliveryStateWriteRequest,
} from '../../packages/server/app/api/internal/delivery-state/route';
import { attemptFor, syntheticBatch } from './test-fixtures';

const WORKER_TOKEN = 'synthetic-delivery-state-worker-token-0001';

function evidenceId(sequence: number): string {
  return `90000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function sameEvidenceInput(
  evidence: DeliveryEvidence,
  input: AttemptEvidenceInput,
): boolean {
  return (
    evidence.subject.kind === 'attempt' &&
    evidence.subject.attemptId === input.subject.attemptId &&
    evidence.state === input.state &&
    evidence.provider === input.provider &&
    evidence.providerReference === input.providerReference &&
    JSON.stringify(evidence.proof) === JSON.stringify(input.proof) &&
    evidence.reasonCode === input.reasonCode &&
    evidence.diagnosticDigest === input.diagnosticDigest
  );
}

class MemoryDeliveryEvidenceStore implements DeliveryEvidenceStore {
  readonly #attempts = new Map<string, ChannelAttempt>();
  readonly #evidence = new Map<string, DeliveryEvidence[]>();
  public calls = 0;
  public appends = 0;

  public evidenceFor(attemptId: string): readonly DeliveryEvidence[] {
    return this.#evidence.get(attemptId) ?? [];
  }

  public async recordAttemptEvidence(
    request: DeliveryStateWriteRequest,
  ): Promise<DeliveryEvidence> {
    this.calls += 1;
    const existingAttempt = this.#attempts.get(request.attempt.id);
    const existingEvidence = this.#evidence.get(request.attempt.id) ?? [];
    if (existingAttempt === undefined) {
      if (request.evidence.state !== 'attempted') {
        throw new DeliveryStateError(
          'INITIAL_ATTEMPT_EVIDENCE_REQUIRED',
          409,
          'An immutable attempt must begin with attempted evidence.',
        );
      }
      this.#attempts.set(request.attempt.id, request.attempt);
    } else if (
      JSON.stringify(existingAttempt) !== JSON.stringify(request.attempt)
    ) {
      throw new DeliveryStateError(
        'ATTEMPT_CONFLICT',
        409,
        'The immutable attempt does not match persisted state.',
      );
    }

    const first = existingEvidence[0];
    if (request.evidence.state === 'attempted' && first !== undefined) {
      if (!sameEvidenceInput(first, request.evidence)) {
        throw new DeliveryStateError(
          'DELIVERY_STATE_PERSISTENCE_INVALID',
          503,
          'Initial evidence was invalid.',
        );
      }
      return first;
    }

    const latest = existingEvidence.at(-1);
    if (latest !== undefined && sameEvidenceInput(latest, request.evidence)) {
      return latest;
    }
    if (
      latest !== undefined &&
      !DeliveryTruthTransitionSchema.safeParse({
        subjectKind: 'attempt',
        from: latest.state,
        to: request.evidence.state,
      }).success
    ) {
      const matching = existingEvidence.find((item) =>
        sameEvidenceInput(item, request.evidence),
      );
      if (matching !== undefined) {
        return matching;
      }
      throw new DeliveryStateError(
        'INVALID_DELIVERY_TRANSITION',
        409,
        'The requested delivery-state transition is not allowed.',
      );
    }

    const sequence = existingEvidence.length + 1;
    const evidence = DeliveryEvidenceSchema.parse({
      id: evidenceId(sequence),
      subject: request.evidence.subject,
      sequence,
      previousEvidenceId: latest?.id ?? null,
      state: request.evidence.state,
      recordedAt: new Date(
        Date.parse('2026-08-10T16:00:10.000Z') + sequence * 1_000,
      ).toISOString(),
      provider: request.evidence.provider,
      providerReference: request.evidence.providerReference,
      proof: request.evidence.proof,
      reasonCode: request.evidence.reasonCode,
      diagnosticDigest: request.evidence.diagnosticDigest,
    });
    existingEvidence.push(evidence);
    this.#evidence.set(request.attempt.id, existingEvidence);
    this.appends += 1;
    return evidence;
  }
}

interface HarnessStats {
  readonly runtimeCreates: number;
  readonly closes: number;
  readonly authorizerCalls: number;
  readonly contexts: readonly DeliveryEvidenceCapabilityContext[];
}

function createHarness(store = new MemoryDeliveryEvidenceStore()) {
  let runtimeCreates = 0;
  let closes = 0;
  let authorizerCalls = 0;
  const contexts: DeliveryEvidenceCapabilityContext[] = [];
  const canonicalAuthorizer = createDeliveryStateAuthorizer();
  const dependencies: DeliveryStateRouteDependencies = {
    readExpectedBearerToken: () => WORKER_TOKEN,
    async createRuntime(): Promise<DeliveryStateRouteRuntime> {
      runtimeCreates += 1;
      return {
        handler: createRecordDeliveryEvidenceHandler(store),
        authorizer: {
          async authorize(
            request: CapabilityAuthorizationRequest<
              RegisteredCapabilityId,
              DeliveryEvidenceCapabilityContext
            >,
          ): Promise<void> {
            authorizerCalls += 1;
            contexts.push(request.context);
            await canonicalAuthorizer.authorize(request);
          },
        },
        async close(): Promise<void> {
          closes += 1;
        },
      };
    },
  };
  return {
    route: createDeliveryStateRouteHandler(dependencies),
    store,
    stats(): HarnessStats {
      return { runtimeCreates, closes, authorizerCalls, contexts };
    },
  };
}

function attemptedInput(attempt: ChannelAttempt): AttemptEvidenceInput {
  return {
    subject: { kind: 'attempt', attemptId: attempt.id },
    state: 'attempted',
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  };
}

function requestFor(
  body: unknown,
  options: Readonly<{
    method?: string;
    token?: string | null;
    contentType?: string;
  }> = {},
): Request {
  const method = options.method ?? 'POST';
  const token = options.token === undefined ? WORKER_TOKEN : options.token;
  return new Request(
    'https://eoc.example.invalid/api/internal/delivery-state',
    {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        'content-type': options.contentType ?? 'application/json',
      },
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    },
  );
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

describe('delivery-state worker route', () => {
  test('rejects non-POST methods and authenticates before reading a body or opening a runtime', async () => {
    const methods = createHarness();
    const methodResponse = await methods.route(
      requestFor('', { method: 'GET', token: null }),
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('POST');
    expect(methods.stats()).toMatchObject({
      runtimeCreates: 0,
      closes: 0,
      authorizerCalls: 0,
    });

    const auth = createHarness();
    const authResponse = await auth.route(
      requestFor('{not-json', {
        token: 'incorrect-delivery-state-token-0001',
        contentType: 'text/plain',
      }),
    );
    expect(authResponse.status).toBe(401);
    expect(authResponse.headers.get('www-authenticate')).toContain('Bearer');
    expect(auth.stats()).toMatchObject({
      runtimeCreates: 0,
      closes: 0,
      authorizerCalls: 0,
    });
  });

  test('uses the exact canonical capability path and idempotently returns immutable attempted evidence', async () => {
    const harness = createHarness();
    const attempt = attemptFor(syntheticBatch());
    const body = { attempt, evidence: attemptedInput(attempt) };

    const first = await harness.route(requestFor(body));
    const replay = await harness.route(requestFor(body));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await responseBody(replay)).toEqual(await responseBody(first));
    expect(harness.store.calls).toBe(2);
    expect(harness.store.appends).toBe(1);
    expect(harness.store.evidenceFor(attempt.id)).toHaveLength(1);
    expect(harness.stats()).toMatchObject({
      runtimeCreates: 2,
      closes: 2,
      authorizerCalls: 2,
    });
    for (const context of harness.stats().contexts) {
      expect(context).toMatchObject({
        actor: {
          kind: 'system',
          serviceId: 'notification-delivery-worker',
        },
        source: 'worker',
        transport: 'worker-execution',
        workerAuthenticated: true,
        requestId: attempt.id,
      });
    }
  });

  test('rejects transport additions, immutable-attempt drift, and terminal truth regressions', async () => {
    const strict = createHarness();
    const attempt = attemptFor(syntheticBatch());
    const strictResponse = await strict.route(
      requestFor({
        attempt,
        evidence: attemptedInput(attempt),
        eventMutation: { status: 'closed' },
      }),
    );
    expect(strictResponse.status).toBe(400);
    expect(strict.stats().runtimeCreates).toBe(0);

    const harness = createHarness();
    expect(
      (
        await harness.route(
          requestFor({ attempt, evidence: attemptedInput(attempt) }),
        )
      ).status,
    ).toBe(200);
    const driftedAttempt = {
      ...attempt,
      attemptedAt: '2026-08-10T16:00:03.000Z',
    };
    expect(
      (
        await harness.route(
          requestFor({
            attempt: driftedAttempt,
            evidence: attemptedInput(attempt),
          }),
        )
      ).status,
    ).toBe(409);

    const providerAccepted: AttemptEvidenceInput = {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'provider-accepted',
      provider: 'synthetic-provider',
      providerReference: 'synthetic-acceptance-1',
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    };
    const acceptedResponse = await harness.route(
      requestFor({ attempt, evidence: providerAccepted }),
    );
    expect(acceptedResponse.status).toBe(200);
    const acceptedBody = await responseBody(acceptedResponse);

    const delivered: AttemptEvidenceInput = {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'delivered',
      provider: 'synthetic-provider',
      providerReference: 'synthetic-receipt-1',
      proof: {
        kind: 'provider-delivery-receipt',
        provider: 'synthetic-provider',
        receiptId: 'synthetic-receipt-1',
        deliveredAt: '2026-08-10T16:00:02.000Z',
      },
      reasonCode: null,
      diagnosticDigest: null,
    };
    expect(
      (await harness.route(requestFor({ attempt, evidence: delivered })))
        .status,
    ).toBe(200);
    const replayedAcceptance = await harness.route(
      requestFor({ attempt, evidence: providerAccepted }),
    );
    expect(replayedAcceptance.status).toBe(200);
    expect(await responseBody(replayedAcceptance)).toEqual(acceptedBody);
    const regression: AttemptEvidenceInput = {
      subject: { kind: 'attempt', attemptId: attempt.id },
      state: 'failed',
      provider: 'synthetic-provider',
      providerReference: null,
      proof: null,
      reasonCode: 'PROVIDER_REPORTED_FAILURE',
      diagnosticDigest: null,
    };
    const regressionResponse = await harness.route(
      requestFor({ attempt, evidence: regression }),
    );
    expect(regressionResponse.status).toBe(409);
    expect(await responseBody(regressionResponse)).toEqual({
      error: {
        code: 'INVALID_DELIVERY_TRANSITION',
        message: 'The requested delivery-state transition is not allowed.',
      },
    });
    expect(harness.store.evidenceFor(attempt.id)).toHaveLength(3);
  });
});
