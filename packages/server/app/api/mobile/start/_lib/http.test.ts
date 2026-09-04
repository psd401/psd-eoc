import { describe, expect, test } from 'bun:test';

import type { CapabilityInput } from '@psd-eoc/contracts';

import { WEB_SESSION_COOKIE_NAME } from '../../../../../lib/auth/middleware';
import {
  SessionAccessError,
  type AuthenticatedSession,
  type SessionService,
} from '../../../../../lib/auth/sessions';
import type { TrustedCapabilityInvocation } from '../../../../../lib/capabilities/engine';
import {
  assertQueryHeaders,
  authenticateMobileStartRequest,
  handleListMobileStartFacilities,
  handleListMobileStartThreats,
  handleMobileActivateEvent,
  handleMobileActivationPreview,
  type MobileStartRouteRuntime,
} from './http';

const IDS = {
  user: '51000000-0000-4000-8000-000000000001',
  session: '51000000-0000-4000-8000-000000000002',
  epoch: '51000000-0000-4000-8000-000000000003',
  request: '51000000-0000-4000-8000-000000000004',
  facility: '51000000-0000-4000-8000-000000000005',
  preview: '51000000-0000-4000-8000-000000000006',
  eventType: '51000000-0000-4000-8000-000000000007',
  confirmation: '51000000-0000-4000-8000-000000000008',
  threat: '51000000-0000-4000-8000-000000000009',
} as const;

const NOW = new Date('2026-08-11T17:00:00.000Z');
const CONFIRMATION_TIME = new Date('2026-08-11T17:00:01.000Z');
const IDEMPOTENCY_KEY = 'mobile-start-idempotency-0001';
const SESSION_TOKEN = 'A'.repeat(43);

function authenticated(
  source: AuthenticatedSession['source'] = 'mobile',
): AuthenticatedSession {
  return {
    actor: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    source,
    roles: ['staff'],
    scope: {
      facilityScope: { kind: 'facilities', facilityIds: [IDS.facility] },
    },
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
  }> = {},
) {
  const authentications: Readonly<{
    kind: 'query' | 'post';
    request: Request;
  }>[] = [];
  const confirmations: unknown[] = [];
  const executions: ExecutionCall[] = [];
  const runtime: MobileStartRouteRuntime = {
    createRequestId: () => IDS.request,
    now: () => NOW,
    async authenticate(request) {
      authentications.push({ kind: 'post', request });
      if (options.authenticationError !== undefined) {
        throw options.authenticationError;
      }
      return authenticated();
    },
    async authenticateQuery(request) {
      authentications.push({ kind: 'query', request });
      if (options.authenticationError !== undefined) {
        throw options.authenticationError;
      }
      return authenticated();
    },
    async issueConfirmation(input) {
      confirmations.push(input);
      return {
        confirmationId: IDS.confirmation,
        confirmationIssuedAt: CONFIRMATION_TIME,
        executionTime: CONFIRMATION_TIME,
      };
    },
    async executeFacilities(input, invocation) {
      executions.push({
        capabilityId: 'list-facilities',
        input,
        invocation,
      });
      return {
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      };
    },
    async executeThreats(input, invocation) {
      executions.push({
        capabilityId: 'list-threats',
        input,
        invocation,
      });
      return {
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      };
    },
    async executePreview(input, invocation) {
      executions.push({
        capabilityId: 'create-activation-preview',
        input,
        invocation,
      });
      return { previewId: IDS.preview };
    },
    async executeEvent(capabilityId, input, invocation) {
      executions.push({ capabilityId, input, invocation });
      return { eventId: IDS.preview };
    },
  };
  return { authentications, confirmations, executions, runtime };
}

function postRequest(
  path: '/api/mobile/start/activate' | '/api/mobile/start/preview',
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(`https://eoc.example.test${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SESSION_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function previewInput(): CapabilityInput<'create-activation-preview'> {
  return {
    facilityId: IDS.facility,
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: {
      id: IDS.eventType,
      templateMode: 'drill',
    },
    rosterPopulation: 'staff',
    threatId: IDS.threat,
    threatDetail: null,
    responseDetail: null,
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

describe('mobile start authentication', () => {
  test('accepts a bearer only as a mobile session source', async () => {
    const calls: unknown[] = [];
    const sessions = {
      async authenticate(token: string, source: string, now: Date) {
        calls.push({ token, source, now });
        return authenticated(source as AuthenticatedSession['source']);
      },
    } as unknown as SessionService;
    const request = new Request(
      'https://eoc.example.test/api/mobile/start/facilities',
      { headers: { authorization: `Bearer ${SESSION_TOKEN}` } },
    );

    await expect(
      authenticateMobileStartRequest(
        request,
        sessions,
        { mutation: false },
        NOW,
      ),
    ).resolves.toMatchObject({ source: 'mobile' });
    expect(calls).toEqual([
      { token: SESSION_TOKEN, source: 'mobile', now: NOW },
    ]);
  });

  test('rejects cookie-authenticated web sessions', async () => {
    const sessions = {
      async authenticate() {
        return authenticated('web');
      },
    } as unknown as SessionService;
    const request = new Request(
      'https://eoc.example.test/api/mobile/start/facilities',
      {
        headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      },
    );

    await expect(
      authenticateMobileStartRequest(
        request,
        sessions,
        { mutation: false },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

describe('mobile start route handlers', () => {
  test('lists authorized facilities for naming while preserving mobile scope', async () => {
    const { authentications, executions, runtime } = testRuntime();
    const request = new Request(
      'https://eoc.example.test/api/mobile/start/facilities?cursor=cursor_1&limit=25',
      { headers: { authorization: `Bearer ${SESSION_TOKEN}` } },
    );

    const response = await handleListMobileStartFacilities(request, runtime);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(authentications).toEqual([
      expect.objectContaining({ kind: 'query', request }),
    ]);
    expect(executions).toEqual([
      {
        capabilityId: 'list-facilities',
        input: {
          includeInactive: true,
          cursor: 'cursor_1',
          limit: 25,
        },
        invocation: expect.objectContaining({
          source: 'mobile',
          scope: {
            facilityScope: {
              kind: 'facilities',
              facilityIds: [IDS.facility],
            },
          },
          mutation: null,
        }),
      },
    ]);
  });

  test('rejects unsupported facility query input before capability execution', async () => {
    for (const path of [
      '/api/mobile/start/facilities?includeInactive=true',
      '/api/mobile/start/facilities?includeInactive=false',
      '/api/mobile/start/facilities?limit=201',
      '/api/mobile/start/facilities?limit=10&limit=20',
    ]) {
      const { executions, runtime } = testRuntime();
      const response = await handleListMobileStartFacilities(
        new Request(`https://eoc.example.test${path}`, {
          headers: { authorization: `Bearer ${SESSION_TOKEN}` },
        }),
        runtime,
      );

      expect(response.status).toBe(400);
      expect(executions).toEqual([]);
    }
  });

  test('lists selectable threats as a mobile query without facility scope', async () => {
    const { authentications, executions, runtime } = testRuntime();
    const request = new Request(
      'https://eoc.example.test/api/mobile/start/threats?cursor=cursor_1&limit=25',
      { headers: { authorization: `Bearer ${SESSION_TOKEN}` } },
    );

    const response = await handleListMobileStartThreats(request, runtime);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(authentications).toEqual([
      expect.objectContaining({ kind: 'query', request }),
    ]);
    expect(executions).toEqual([
      {
        capabilityId: 'list-threats',
        input: {
          includeInactive: false,
          cursor: 'cursor_1',
          limit: 25,
        },
        invocation: expect.objectContaining({
          source: 'mobile',
          mutation: null,
        }),
      },
    ]);
  });

  test('rejects unsupported threat query input before capability execution', async () => {
    for (const path of [
      '/api/mobile/start/threats?includeInactive=true',
      '/api/mobile/start/threats?limit=201',
      '/api/mobile/start/threats?limit=10&limit=20',
    ]) {
      const { executions, runtime } = testRuntime();
      const response = await handleListMobileStartThreats(
        new Request(`https://eoc.example.test${path}`, {
          headers: { authorization: `Bearer ${SESSION_TOKEN}` },
        }),
        runtime,
      );

      expect(response.status).toBe(400);
      expect(executions).toEqual([]);
    }
  });

  test('names the route that refused a read carrying mutation metadata', () => {
    // The client only ever sees the generic invalid-request body, so this
    // message exists for the server log. One shared helper naming the
    // facilities route sent a threats problem looking at the wrong endpoint.
    const carrying = new Request('https://eoc.example.test/api/mobile/start', {
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
    });
    expect(() => {
      assertQueryHeaders(carrying, 'Threat queries');
    }).toThrow('Threat queries cannot carry mutation metadata.');
    expect(() => {
      assertQueryHeaders(carrying, 'Facility queries');
    }).toThrow('Facility queries cannot carry mutation metadata.');
    expect(() => {
      assertQueryHeaders(
        new Request('https://eoc.example.test/api/mobile/start'),
        'Threat queries',
      );
    }).not.toThrow();
  });

  test('creates a drill preview as a non-mutating mobile capability query', async () => {
    const { confirmations, executions, runtime } = testRuntime();
    const response = await handleMobileActivationPreview(
      postRequest('/api/mobile/start/preview', previewInput(), {
        'idempotency-key': IDEMPOTENCY_KEY,
      }),
      runtime,
    );

    expect(response.status).toBe(200);
    expect(confirmations).toEqual([]);
    expect(executions).toEqual([
      expect.objectContaining({
        capabilityId: 'create-activation-preview',
        input: previewInput(),
        invocation: expect.objectContaining({
          source: 'mobile',
          connectivityEpochId: IDS.epoch,
          mutation: null,
        }),
      }),
    ]);
  });

  test('rejects a missing preview transport key before capability execution', async () => {
    const { confirmations, executions, runtime } = testRuntime();
    const response = await handleMobileActivationPreview(
      postRequest('/api/mobile/start/preview', previewInput()),
      runtime,
    );

    expect(response.status).toBe(400);
    expect(confirmations).toEqual([]);
    expect(executions).toEqual([]);
  });

  test('keeps confirmation server-side and executes a mobile-interactive start', async () => {
    const { confirmations, executions, runtime } = testRuntime();
    const response = await handleMobileActivateEvent(
      postRequest('/api/mobile/start/activate', startInput(), {
        'idempotency-key': IDEMPOTENCY_KEY,
      }),
      runtime,
    );

    expect(response.status).toBe(200);
    expect(confirmations).toEqual([
      expect.objectContaining({
        authenticated: expect.objectContaining({ source: 'mobile' }),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      }),
    ]);
    expect(executions).toEqual([
      expect.objectContaining({
        capabilityId: 'start-event',
        input: startInput(),
        invocation: expect.objectContaining({
          source: 'mobile',
          serverTime: CONFIRMATION_TIME,
          mutation: {
            idempotencyKey: IDEMPOTENCY_KEY,
            humanConfirmationId: IDS.confirmation,
            transport: {
              kind: 'mobile-interactive',
              interaction: 'explicit-user-submit',
            },
          },
        }),
      }),
    ]);
    expect(await response.text()).not.toContain(IDS.confirmation);
  });

  test('rejects client confirmation metadata before issuance or execution', async () => {
    const { confirmations, executions, runtime } = testRuntime();
    const response = await handleMobileActivateEvent(
      postRequest('/api/mobile/start/activate', startInput(), {
        'human-confirmation-id': IDS.confirmation,
        'idempotency-key': IDEMPOTENCY_KEY,
      }),
      runtime,
    );

    expect(response.status).toBe(400);
    expect(confirmations).toEqual([]);
    expect(executions).toEqual([]);
  });

  test('maps mobile authentication denial without invoking a capability', async () => {
    const { executions, runtime } = testRuntime({
      authenticationError: new SessionAccessError(
        'INVALID_CREDENTIAL',
        'A current mobile session is required.',
      ),
    });
    const response = await handleMobileActivationPreview(
      postRequest('/api/mobile/start/preview', previewInput(), {
        'idempotency-key': IDEMPOTENCY_KEY,
      }),
      runtime,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      requestId: expect.any(String),
    });
    expect(executions).toEqual([]);
  });
});
