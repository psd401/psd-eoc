import { describe, expect, test } from 'bun:test';

import type { CapabilityInput } from '@psd-eoc/contracts';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
} from '../../../../lib/auth/middleware';
import {
  SessionAccessError,
  type AuthenticatedSession,
  type SessionService,
} from '../../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  authenticateStartFlowWebRequest,
  handleActivateEvent,
  handleCreateActivationPreview,
  handleJoinExistingEvent,
  START_FLOW_CONFIRMATION_HEADER,
  START_FLOW_IDEMPOTENCY_HEADER,
  type StartFlowRouteRuntime,
} from '../_lib/http';

const IDS = {
  user: '30000000-0000-4000-8000-000000000001',
  session: '30000000-0000-4000-8000-000000000002',
  epoch: '30000000-0000-4000-8000-000000000003',
  request: '30000000-0000-4000-8000-000000000004',
  facility: '30000000-0000-4000-8000-000000000005',
  preview: '30000000-0000-4000-8000-000000000006',
  eventType: '30000000-0000-4000-8000-000000000007',
  event: '30000000-0000-4000-8000-000000000008',
  confirmation: '30000000-0000-4000-8000-000000000009',
} as const;

const NOW = new Date('2026-08-10T18:00:00.000Z');
const CONFIRMATION_ISSUED_AT = new Date('2026-08-10T18:00:01.000Z');
const EXECUTION_TIME = new Date('2026-08-10T18:00:02.000Z');
const IDEMPOTENCY_KEY = 'start-flow-idempotency-0001';

function authenticated(source: 'mobile' | 'web' = 'web') {
  return {
    actor: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    source,
    roles: ['staff'],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: {
      session: { id: IDS.session },
      connectivityEpoch: { id: IDS.epoch },
    },
  } as unknown as AuthenticatedSession;
}

interface ExecutionCall {
  readonly capabilityId: string;
  readonly input: unknown;
  readonly invocation: TrustedCapabilityInvocation;
}

function testRuntime(
  options: Readonly<{
    authenticationError?: unknown;
    confirmationError?: unknown;
    executionError?: unknown;
    confirmationIssuedAt?: Date;
    executionTime?: Date;
  }> = {},
) {
  const authentications: Request[] = [];
  const confirmations: unknown[] = [];
  const executions: ExecutionCall[] = [];
  const runtime: StartFlowRouteRuntime = {
    createRequestId: () => IDS.request,
    now: () => NOW,
    async authenticate(request) {
      authentications.push(request);
      if (options.authenticationError !== undefined) {
        throw options.authenticationError;
      }
      return authenticated();
    },
    async issueConfirmation(input) {
      confirmations.push(input);
      if (options.confirmationError !== undefined) {
        throw options.confirmationError;
      }
      return {
        confirmationId: IDS.confirmation,
        confirmationIssuedAt:
          options.confirmationIssuedAt ?? CONFIRMATION_ISSUED_AT,
        executionTime: options.executionTime ?? EXECUTION_TIME,
      };
    },
    async executePreview(input, invocation) {
      executions.push({
        capabilityId: 'create-activation-preview',
        input,
        invocation,
      });
      if (options.executionError !== undefined) {
        throw options.executionError;
      }
      return { accepted: true };
    },
    async executeEvent(capabilityId, input, invocation) {
      executions.push({ capabilityId, input, invocation });
      if (options.executionError !== undefined) {
        throw options.executionError;
      }
      return { accepted: true };
    },
  };
  return { authentications, confirmations, executions, runtime };
}

function postRequest(
  path: string,
  body: unknown,
  options: Readonly<{
    confirmationId?: string;
    idempotencyKey?: string | null;
  }> = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.idempotencyKey !== null) {
    headers.set(
      START_FLOW_IDEMPOTENCY_HEADER,
      options.idempotencyKey ?? IDEMPOTENCY_KEY,
    );
  }
  if (options.confirmationId !== undefined) {
    headers.set(START_FLOW_CONFIRMATION_HEADER, options.confirmationId);
  }
  return new Request(`https://eoc.example.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function previewInput(): CapabilityInput<'create-activation-preview'> {
  return {
    facilityId: IDS.facility,
    kind: 'incident',
    templateMode: 'real',
    eventTypeVersion: { id: IDS.eventType, templateMode: 'real' },
    rosterPopulation: 'staff',
  };
}

function startInput() {
  return {
    source: 'activation-preview' as const,
    activationPreviewId: IDS.preview,
    activeEventDecision: {
      decision: 'start-new' as const,
      activeEventIdsSeen: [],
    },
  };
}

describe('start-flow route handlers', () => {
  test('executes preview as a query after authenticating the POST', async () => {
    const { authentications, confirmations, executions, runtime } =
      testRuntime();
    const response = await handleCreateActivationPreview(
      postRequest('/start/api/preview', previewInput(), {
        idempotencyKey: null,
      }),
      runtime,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(authentications).toHaveLength(1);
    expect(confirmations).toEqual([]);
    expect(executions).toEqual([
      expect.objectContaining({
        capabilityId: 'create-activation-preview',
        input: previewInput(),
        invocation: expect.objectContaining({
          actor: { kind: 'human', userId: IDS.user, sessionId: IDS.session },
          source: 'web',
          connectivityEpochId: IDS.epoch,
          mutation: null,
        }),
      }),
    ]);
  });

  test('keeps confirmation private and immediately executes start-event', async () => {
    const { confirmations, executions, runtime } = testRuntime();
    const response = await handleActivateEvent(
      postRequest('/start/api/activate', startInput()),
      runtime,
    );

    expect(response.status).toBe(200);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      startInput: startInput(),
    });
    expect(executions).toEqual([
      expect.objectContaining({
        capabilityId: 'start-event',
        input: startInput(),
        invocation: expect.objectContaining({
          serverTime: EXECUTION_TIME,
          mutation: expect.objectContaining({
            idempotencyKey: IDEMPOTENCY_KEY,
            humanConfirmationId: IDS.confirmation,
            transport: expect.objectContaining({
              kind: 'web-interactive',
              interaction: 'explicit-user-submit',
              csrfVerified: true,
            }),
          }),
        }),
      }),
    ]);
    expect(await response.text()).not.toContain(IDS.confirmation);
  });

  test('fails closed when execution time predates DB confirmation issuance', async () => {
    const { confirmations, executions, runtime } = testRuntime({
      executionTime: new Date(CONFIRMATION_ISSUED_AT.getTime() - 1),
    });
    const response = await handleActivateEvent(
      postRequest('/start/api/activate', startInput()),
      runtime,
    );

    expect(response.status).toBe(503);
    expect(confirmations).toHaveLength(1);
    expect(executions).toEqual([]);
  });

  test('does not execute when the boundary rejects a synthetic preview', async () => {
    const { confirmations, executions, runtime } = testRuntime({
      confirmationError: new CapabilityEngineError(
        'VALIDATION_ERROR',
        'MUTATION_METADATA_INVALID',
        'The browser activation flow supports staff roster previews only.',
        400,
      ),
    });
    const response = await handleActivateEvent(
      postRequest('/start/api/activate', startInput()),
      runtime,
    );

    expect(response.status).toBe(400);
    expect(confirmations).toHaveLength(1);
    expect(executions).toEqual([]);
  });

  test('joins explicitly through join-event with no confirmation', async () => {
    const { confirmations, executions, runtime } = testRuntime();
    const response = await handleJoinExistingEvent(
      postRequest('/start/api/join', { eventId: IDS.event }),
      runtime,
    );

    expect(response.status).toBe(200);
    expect(confirmations).toEqual([]);
    expect(executions[0]).toMatchObject({
      capabilityId: 'join-event',
      input: { eventId: IDS.event },
      invocation: {
        mutation: {
          idempotencyKey: IDEMPOTENCY_KEY,
          humanConfirmationId: null,
        },
      },
    });
  });

  test('rejects every client attempt to supply confirmation metadata', async () => {
    const { confirmations, executions, runtime } = testRuntime();
    const response = await handleActivateEvent(
      postRequest('/start/api/activate', startInput(), {
        confirmationId: IDS.confirmation,
      }),
      runtime,
    );

    expect(response.status).toBe(400);
    expect(confirmations).toEqual([]);
    expect(executions).toEqual([]);
  });

  test('rejects prepared sources and unsupported body fields', async () => {
    for (const body of [
      {
        source: 'prepared-activation',
        preparedActivationId: IDS.preview,
        activeEventDecision: {
          decision: 'start-new',
          activeEventIdsSeen: [],
        },
      },
      { ...startInput(), actionIds: ['start-real-incident'] },
      { ...startInput(), consequenceDigest: 'b'.repeat(64) },
      { ...startInput(), humanConfirmationId: IDS.confirmation },
    ]) {
      const { confirmations, executions, runtime } = testRuntime();
      const response = await handleActivateEvent(
        postRequest('/start/api/activate', body),
        runtime,
      );
      expect(response.status).toBe(400);
      expect(confirmations).toEqual([]);
      expect(executions).toEqual([]);
    }
  });

  test('rejects mutation metadata on previews and missing keys on mutations', async () => {
    const previewRuntime = testRuntime();
    const previewResponse = await handleCreateActivationPreview(
      postRequest('/start/api/preview', previewInput()),
      previewRuntime.runtime,
    );
    expect(previewResponse.status).toBe(400);
    expect(previewRuntime.executions).toEqual([]);

    const mutationRuntime = testRuntime();
    const mutationResponse = await handleActivateEvent(
      postRequest('/start/api/activate', startInput(), {
        idempotencyKey: null,
      }),
      mutationRuntime.runtime,
    );
    expect(mutationResponse.status).toBe(400);
    expect(mutationRuntime.confirmations).toEqual([]);
    expect(mutationRuntime.executions).toEqual([]);
  });

  test('bounds JSON and never exposes unexpected error details', async () => {
    const oversized = testRuntime();
    const oversizedResponse = await handleJoinExistingEvent(
      postRequest('/start/api/join', {
        eventId: IDS.event,
        padding: 'x'.repeat(17 * 1_024),
      }),
      oversized.runtime,
    );
    expect(oversizedResponse.status).toBe(400);
    expect(oversized.executions).toEqual([]);

    const failed = testRuntime({
      executionError: new Error('recipient secret must stay private'),
    });
    const failedResponse = await handleJoinExistingEvent(
      postRequest('/start/api/join', { eventId: IDS.event }),
      failed.runtime,
    );
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.text()).not.toContain('recipient secret');
  });

  test('authentication failure prevents confirmation and capability work', async () => {
    const { confirmations, executions, runtime } = testRuntime({
      authenticationError: new SessionAccessError(
        'FORBIDDEN',
        'The browser request failed CSRF verification.',
      ),
    });
    const response = await handleActivateEvent(
      postRequest('/start/api/activate', startInput()),
      runtime,
    );

    expect(response.status).toBe(403);
    expect(confirmations).toEqual([]);
    expect(executions).toEqual([]);
  });

  test('rate-limit denial returns 429 and prevents start-event execution', async () => {
    const { confirmations, executions, runtime } = testRuntime({
      confirmationError: new CapabilityEngineError(
        'RATE_LIMITED',
        'PERSISTENCE_CONFLICT',
        'Too many fresh activation submissions were made for this facility.',
        429,
        true,
      ),
    });
    const response = await handleActivateEvent(
      postRequest('/start/api/activate', startInput()),
      runtime,
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(confirmations).toHaveLength(1);
    expect(executions).toEqual([]);
  });
});

describe('start-flow browser authentication', () => {
  const token = 'A'.repeat(43);
  const csrf = 'synthetic-csrf-token';

  function sessionsFor(result: AuthenticatedSession) {
    let calls = 0;
    const sessions = {
      async authenticate() {
        calls += 1;
        return result;
      },
    } as unknown as SessionService;
    return { calls: () => calls, sessions };
  }

  function browserRequest(origin: string, csrfHeader: string | null) {
    const headers = new Headers({
      cookie: `${WEB_SESSION_COOKIE_NAME}=${token}; ${WEB_CSRF_COOKIE_NAME}=${csrf}`,
      origin,
    });
    if (csrfHeader !== null) {
      headers.set('x-psd-eoc-csrf', csrfHeader);
    }
    return new Request('https://eoc.example.test/start/api/preview', {
      method: 'POST',
      headers,
      body: '{}',
    });
  }

  test('accepts only same-origin double-submit CSRF browser requests', async () => {
    const accepted = sessionsFor(authenticated());
    await expect(
      authenticateStartFlowWebRequest(
        browserRequest('https://eoc.example.test', csrf),
        accepted.sessions,
        NOW,
      ),
    ).resolves.toMatchObject({ source: 'web' });
    expect(accepted.calls()).toBe(1);

    for (const request of [
      browserRequest('https://attacker.example.test', csrf),
      browserRequest('https://eoc.example.test', null),
      browserRequest('https://eoc.example.test', 'wrong-token'),
    ]) {
      const rejected = sessionsFor(authenticated());
      await expect(
        authenticateStartFlowWebRequest(request, rejected.sessions, NOW),
      ).rejects.toBeInstanceOf(SessionAccessError);
      expect(rejected.calls()).toBe(0);
    }
  });

  test('rejects bearer/mobile sessions on the web-only endpoints', async () => {
    const mobile = sessionsFor(authenticated('mobile'));
    const request = new Request('https://eoc.example.test/start/api/preview', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}',
    });

    await expect(
      authenticateStartFlowWebRequest(request, mobile.sessions, NOW),
    ).rejects.toMatchObject({ status: 403 });
  });
});
