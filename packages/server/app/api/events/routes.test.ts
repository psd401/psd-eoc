import { describe, expect, test } from 'bun:test';

import type { TrustedCapabilityInvocation } from '../../../lib/capabilities/engine';
import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import { SessionAccessError } from '../../../lib/auth/sessions';
import {
  handleGetEvent,
  handleJoinEvent,
  handleListEvents,
  HUMAN_CONFIRMATION_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  type EventRouteInvocationRequest,
  type EventRouteRuntime,
} from './_lib/http';

const ids = {
  user: '00000000-0000-4000-8000-000000000901',
  session: '00000000-0000-4000-8000-000000000902',
  epoch: '00000000-0000-4000-8000-000000000903',
  request: '00000000-0000-4000-8000-000000000904',
  facility: '00000000-0000-4000-8000-000000000905',
  event: '00000000-0000-4000-8000-000000000906',
  otherEvent: '00000000-0000-4000-8000-000000000907',
  confirmation: '00000000-0000-4000-8000-000000000909',
} as const;

const now = new Date('2026-08-08T18:00:00.000Z');
const idempotencyKey = 'event-route-idempotency-0001';

interface ExecutionCall {
  readonly capabilityId: string;
  readonly input: unknown;
  readonly invocation: TrustedCapabilityInvocation;
}

interface TestRuntimeOptions {
  readonly executeError?: unknown;
  readonly resolveError?: unknown;
}

function testRuntime(options: TestRuntimeOptions = {}) {
  const executions: ExecutionCall[] = [];
  const invocationRequests: EventRouteInvocationRequest[] = [];
  const runtime: EventRouteRuntime = {
    capabilities: {
      async execute(capabilityId, input, invocation) {
        executions.push({ capabilityId, input, invocation });
        if (options.executeError !== undefined) {
          throw options.executeError;
        }
        return { capabilityId, input };
      },
    },
    createRequestId: () => ids.request,
    now: () => now,
    async resolveInvocation(_request, input) {
      invocationRequests.push(input);
      if (options.resolveError !== undefined) {
        throw options.resolveError;
      }
      return {
        actor: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.session,
        },
        source: 'web',
        scope: { facilityScope: { kind: 'district' } },
        requestId: input.requestId,
        serverTime: input.serverTime,
        connectivityEpochId: ids.epoch,
        mutation:
          input.mutation === null
            ? null
            : {
                ...input.mutation,
                transport: {
                  kind: 'web-interactive',
                  method: 'POST',
                  interaction: 'explicit-user-submit',
                  csrfVerified: true,
                },
              },
      };
    },
  };
  return { executions, invocationRequests, runtime };
}

function eventMutationRequest(
  path: string,
  body: unknown,
  confirmationId: string | null = null,
): Request {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
  });
  if (confirmationId !== null) {
    headers.set(HUMAN_CONFIRMATION_ID_HEADER, confirmationId);
  }
  return new Request(`https://eoc.example.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('event REST handlers', () => {
  test('normalizes an authorized active-event list query', async () => {
    const { executions, invocationRequests, runtime } = testRuntime();
    const response = await handleListEvents(
      new Request(
        `https://eoc.example.test/api/events?facilityId=${ids.facility}&cursor=cursor_001&limit=25`,
      ),
      runtime,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      capabilityId: 'list-active-events',
      input: {
        facilityId: ids.facility,
        cursor: 'cursor_001',
        limit: 25,
      },
      invocation: {
        actor: { kind: 'human', userId: ids.user },
        source: 'web',
        mutation: null,
      },
    });
    expect(invocationRequests[0]?.mutation).toBeNull();
  });

  test('gets one event through a query invocation', async () => {
    const { executions, runtime } = testRuntime();
    const response = await handleGetEvent(
      new Request(`https://eoc.example.test/api/events/${ids.event}`),
      ids.event,
      runtime,
    );

    expect(response.status).toBe(200);
    expect(executions[0]).toMatchObject({
      capabilityId: 'get-event',
      input: { eventId: ids.event },
      invocation: { mutation: null },
    });
  });

  const mutationCases = [
    {
      name: 'joins an event',
      capabilityId: 'join-event',
      requestPath: `/api/events/${ids.event}/join`,
      requestBody: {},
      expectedInput: { eventId: ids.event },
      confirmationId: null,
      invoke: (request: Request, runtime: EventRouteRuntime) =>
        handleJoinEvent(request, ids.event, runtime),
    },
    {
      name: 'forwards a well-formed human confirmation header',
      capabilityId: 'join-event',
      requestPath: `/api/events/${ids.event}/join`,
      requestBody: {},
      expectedInput: { eventId: ids.event },
      confirmationId: ids.confirmation,
      invoke: (request: Request, runtime: EventRouteRuntime) =>
        handleJoinEvent(request, ids.event, runtime),
    },
  ] as const;

  for (const mutationCase of mutationCases) {
    test(mutationCase.name, async () => {
      const { executions, invocationRequests, runtime } = testRuntime();
      const response = await mutationCase.invoke(
        eventMutationRequest(
          mutationCase.requestPath,
          mutationCase.requestBody,
          mutationCase.confirmationId,
        ),
        runtime,
      );

      expect(response.status).toBe(200);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        capabilityId: mutationCase.capabilityId,
        input: mutationCase.expectedInput,
        invocation: {
          actor: { kind: 'human', userId: ids.user, sessionId: ids.session },
          source: 'web',
          connectivityEpochId: ids.epoch,
          mutation: {
            idempotencyKey,
            humanConfirmationId: mutationCase.confirmationId,
            transport: {
              kind: 'web-interactive',
              method: 'POST',
              interaction: 'explicit-user-submit',
              csrfVerified: true,
            },
          },
        },
      });
      expect(invocationRequests[0]?.mutation).toEqual({
        idempotencyKey,
        humanConfirmationId: mutationCase.confirmationId,
      });
    });
  }

  test('rejects missing idempotency and malformed confirmation headers', async () => {
    const first = testRuntime();
    const missingIdempotency = new Request(
      `https://eoc.example.test/api/events/${ids.event}/join`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const firstResponse = await handleJoinEvent(
      missingIdempotency,
      ids.event,
      first.runtime,
    );
    expect(firstResponse.status).toBe(400);
    expect(first.invocationRequests).toHaveLength(0);
    expect(first.executions).toHaveLength(0);

    const second = testRuntime();
    const malformedConfirmation = eventMutationRequest(
      `/api/events/${ids.event}/join`,
      {},
      'not-a-uuid',
    );
    const secondResponse = await handleJoinEvent(
      malformedConfirmation,
      ids.event,
      second.runtime,
    );
    expect(secondResponse.status).toBe(400);
    expect(second.invocationRequests).toHaveLength(0);
    expect(second.executions).toHaveLength(0);
  });

  test('rejects body event IDs and unsupported fields instead of overriding the path', async () => {
    const { executions, runtime } = testRuntime();
    const response = await handleJoinEvent(
      eventMutationRequest(
        `/api/events/${ids.event}/join`,
        { eventId: ids.otherEvent },
        ids.confirmation,
      ),
      ids.event,
      runtime,
    );

    expect(response.status).toBe(400);
    expect(executions).toHaveLength(0);
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      requestId: ids.request,
      retryable: false,
    });
  });

  test('rejects an oversized body before capability execution', async () => {
    const { executions, runtime } = testRuntime();
    const response = await handleJoinEvent(
      eventMutationRequest(`/api/events/${ids.event}/join`, {
        padding: 'x'.repeat(64 * 1_024),
      }),
      ids.event,
      runtime,
    );

    expect(response.status).toBe(400);
    expect(executions).toHaveLength(0);
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      requestId: ids.request,
      retryable: false,
    });
  });

  test('maps authentication and capability failures without exposing internals', async () => {
    const unauthenticated = testRuntime({
      resolveError: new SessionAccessError(
        'INVALID_CREDENTIAL',
        'A session credential is required.',
      ),
    });
    const unauthenticatedResponse = await handleJoinEvent(
      eventMutationRequest(`/api/events/${ids.event}/join`, {}),
      ids.event,
      unauthenticated.runtime,
    );
    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'A session credential is required.',
      retryable: false,
    });
    expect(unauthenticated.executions).toHaveLength(0);

    const conflict = testRuntime({
      executeError: new CapabilityEngineError(
        'IDEMPOTENCY_CONFLICT',
        'IDEMPOTENCY_REQUEST_MISMATCH',
        'The idempotency key was already used for a different request.',
        409,
      ),
    });
    const conflictResponse = await handleJoinEvent(
      eventMutationRequest(
        `/api/events/${ids.event}/join`,
        {},
        ids.confirmation,
      ),
      ids.event,
      conflict.runtime,
    );
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'The idempotency key was already used for a different request.',
      requestId: ids.request,
      retryable: false,
    });
  });
});
