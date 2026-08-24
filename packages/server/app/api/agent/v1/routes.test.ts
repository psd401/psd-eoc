import { describe, expect, test } from 'bun:test';

import {
  HUMAN_ONLY_ACTION_IDS,
  isAgentGrantableCapabilityId,
  type AgentGrantableCapabilityId,
  type FacilityScope,
} from '@psd-eoc/contracts';

import {
  SecurityAuditCursorError,
  SecurityAuditScopeError,
} from '../../../../lib/audit';
import { AgentApiKeyAdministrationError } from '../../../../lib/agents/admin-capabilities';
import { AgentCapabilityUnavailableError } from '../../../../lib/agents/dispatcher';
import {
  AgentRestGateway,
  type AgentCapabilityDispatcher,
  type AgentGatewayAuditEvent,
} from '../../../../lib/agents/gateway';
import {
  AgentApiKeyError,
  type AuthenticatedAgentApiKey,
} from '../../../../lib/agents/keys';
import {
  agentApiErrorResponse,
  handleAgentCapability,
  type AgentRestRouteRuntime,
} from './_lib/http';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000201',
  apiKey: '00000000-0000-4000-8000-000000000202',
  issuer: '00000000-0000-4000-8000-000000000203',
  facility: '00000000-0000-4000-8000-000000000204',
  otherFacility: '00000000-0000-4000-8000-000000000205',
  request: '00000000-0000-4000-8000-000000000206',
});

const CREDENTIAL =
  'psd_eoc_agent_v1_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno';

function authenticatedAgent(
  facilityScope: FacilityScope,
  capabilityIds: readonly AgentGrantableCapabilityId[] = ['list-active-events'],
): AuthenticatedAgentApiKey {
  return Object.freeze({
    actor: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    scope: { facilityScope },
    capabilityIds,
    key: {
      id: IDS.apiKey,
      agentId: IDS.agent,
      displayName: 'Synthetic route test agent',
      facilityScope,
      capabilityIds,
      keyPrefix: 'abcdefghijkl',
      issuedByUserId: IDS.issuer,
      issuedAt: '2026-08-10T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    },
  });
}

interface GatewayHarness {
  readonly runtime: AgentRestRouteRuntime;
  readonly audits: AgentGatewayAuditEvent[];
  readonly authenticationAttempts: string[];
  readonly dispatches: Array<{
    readonly capabilityId: string;
    readonly input: unknown;
    readonly invocation: unknown;
  }>;
}

function gatewayHarness(
  facilityScope: FacilityScope,
  capabilityIds: readonly AgentGrantableCapabilityId[] = ['list-active-events'],
  auditFailure: Error | null = null,
  dispatchFailure: Error | null = null,
): GatewayHarness {
  const authenticated = authenticatedAgent(facilityScope, capabilityIds);
  const audits: AgentGatewayAuditEvent[] = [];
  const authenticationAttempts: string[] = [];
  const dispatches: GatewayHarness['dispatches'][number][] = [];
  const dispatcher: AgentCapabilityDispatcher = {
    auditOwnership: () => 'gateway',
    async execute(capabilityId, input, invocation) {
      if (dispatchFailure !== null) throw dispatchFailure;
      dispatches.push({ capabilityId, input, invocation });
      if (capabilityId === 'list-active-events') {
        return {
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      }
      if (capabilityId === 'get-roster-health') {
        throw new AgentCapabilityUnavailableError(capabilityId);
      }
      if (capabilityId === 'get-event') {
        return { invalid: 'synthetic server output' };
      }
      throw new Error(
        'Synthetic dispatcher received an unexpected capability.',
      );
    },
  };
  const gateway = new AgentRestGateway({
    keys: {
      async authenticate(credential) {
        authenticationAttempts.push(String(credential));
        if (credential !== CREDENTIAL) {
          throw new AgentApiKeyError(
            'INVALID_CREDENTIAL',
            'The agent API key is invalid.',
          );
        }
        return authenticated;
      },
      authorizeCapability(resolved, capabilityId) {
        if (
          !isAgentGrantableCapabilityId(capabilityId) ||
          !resolved.capabilityIds.includes(capabilityId)
        ) {
          throw new AgentApiKeyError(
            'CAPABILITY_NOT_GRANTED',
            'The agent API key does not grant this capability.',
          );
        }
        return capabilityId;
      },
    },
    dispatcher,
    audit: {
      async append(event) {
        if (auditFailure !== null) throw auditFailure;
        audits.push(event);
      },
    },
  });
  return {
    audits,
    authenticationAttempts,
    dispatches,
    runtime: {
      gateway,
      createRequestId: () => IDS.request,
      now: () => new Date('2026-08-10T18:01:00.000Z'),
    },
  };
}

function agentRequest(
  capabilityId: string,
  body: unknown,
  input: Readonly<{
    authorization?: string | null;
    credential?: string;
    idempotencyKey?: string;
    humanConfirmationId?: string;
  }> = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  const authorization =
    input.authorization === undefined
      ? `Bearer ${input.credential ?? CREDENTIAL}`
      : input.authorization;
  if (authorization !== null) headers.set('authorization', authorization);
  if (input.idempotencyKey !== undefined) {
    headers.set('idempotency-key', input.idempotencyKey);
  }
  if (input.humanConfirmationId !== undefined) {
    headers.set('human-confirmation-id', input.humanConfirmationId);
  }
  return new Request(
    `https://eoc.example.test/api/agent/v1/capabilities/${capabilityId}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  );
}

describe('agent REST capability route', () => {
  const scopeCases = [
    { name: 'district scope', scope: { kind: 'district' } as const },
    {
      name: 'facility scope',
      scope: { kind: 'facilities', facilityIds: [IDS.facility] } as const,
    },
  ];

  for (const actionId of HUMAN_ONLY_ACTION_IDS) {
    for (const scopeCase of scopeCases) {
      test(`returns 403 for ${actionId} with ${scopeCase.name}`, async () => {
        const harness = gatewayHarness(scopeCase.scope);

        const response = await handleAgentCapability(
          agentRequest(actionId, {}),
          actionId,
          harness.runtime,
        );

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: 'FORBIDDEN',
          requestId: IDS.request,
          retryable: false,
        });
        expect(harness.dispatches).toEqual([]);
        expect(harness.audits).toHaveLength(1);
        expect(harness.audits[0]).toMatchObject({
          category: 'human-only-rejection',
          actionIds: [actionId],
          outcome: 'denied',
          actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
          source: 'agent-rest',
          reasonCode: 'HUMAN_ONLY_REQUIRED',
        });
      });
    }
  }

  test('passes only the authenticated agent identity and facility scope to reads', async () => {
    const scope = {
      kind: 'facilities' as const,
      facilityIds: [IDS.facility],
    };
    const harness = gatewayHarness(scope);
    const input = { facilityId: IDS.facility, cursor: null, limit: 25 };

    const response = await handleAgentCapability(
      agentRequest('list-active-events', input),
      'list-active-events',
      harness.runtime,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]).toMatchObject({
      capabilityId: 'list-active-events',
      input,
      invocation: {
        actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
        source: 'agent-rest',
        scope: { facilityScope: scope },
        requestId: IDS.request,
        connectivityEpochId: null,
        mutation: null,
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization');
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'agent-access',
        action: 'list-active-events',
        outcome: 'success',
        actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
        facilityId: IDS.facility,
        reasonCode: null,
      }),
    ]);
  });

  test('audits and returns 403 for a canonical capability outside the key grant', async () => {
    const harness = gatewayHarness(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['get-event'],
    );

    const response = await handleAgentCapability(
      agentRequest('list-active-events', {
        facilityId: IDS.facility,
        cursor: null,
        limit: 25,
      }),
      'list-active-events',
      harness.runtime,
    );

    expect(response.status).toBe(403);
    expect(harness.dispatches).toEqual([]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'access-denial',
        action: 'list-active-events',
        facilityId: IDS.facility,
        reasonCode: 'CAPABILITY_NOT_GRANTED',
      }),
    ]);
  });

  test('does not echo malformed credentials and advertises Bearer authentication', async () => {
    const harness = gatewayHarness({ kind: 'district' });
    const credential = 'malformed-secret-value';

    const response = await handleAgentCapability(
      agentRequest(
        'list-active-events',
        { facilityId: null, cursor: null, limit: 25 },
        { credential },
      ),
      'list-active-events',
      harness.runtime,
    );
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(responseText).not.toContain(credential);
    expect(harness.dispatches).toEqual([]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'access-denial',
        action: 'list-active-events',
        actionIds: [],
        outcome: 'denied',
        principal: { kind: 'unauthenticated', subjectDigest: null },
        facilityId: null,
        reasonCode: 'INVALID_CREDENTIAL',
      }),
    ]);
  });

  test('audits missing and malformed bearer headers through the gateway', async () => {
    for (const authorization of [null, 'Basic synthetic-not-a-bearer']) {
      const harness = gatewayHarness({ kind: 'district' });
      const response = await handleAgentCapability(
        agentRequest(
          'list-active-events',
          { facilityId: null, cursor: null, limit: 25 },
          { authorization },
        ),
        'list-active-events',
        harness.runtime,
      );

      expect(response.status).toBe(401);
      expect(harness.authenticationAttempts).toEqual(['']);
      expect(harness.dispatches).toEqual([]);
      expect(harness.audits).toEqual([
        expect.objectContaining({
          category: 'access-denial',
          action: 'list-active-events',
          principal: { kind: 'unauthenticated', subjectDigest: null },
          reasonCode: 'INVALID_CREDENTIAL',
        }),
      ]);
    }
  });

  test('fails closed when invalid-credential audit evidence cannot be retained', async () => {
    const credential = 'malformed-secret-value';
    const harness = gatewayHarness(
      { kind: 'district' },
      ['list-active-events'],
      new Error('Synthetic audit persistence failure.'),
    );

    const response = await handleAgentCapability(
      agentRequest(
        'list-active-events',
        { facilityId: null, cursor: null, limit: 25 },
        { credential },
      ),
      'list-active-events',
      harness.runtime,
    );
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain(credential);
    expect(harness.dispatches).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  test('never reflects an unexpected internal failure message', async () => {
    const internalSecret =
      'postgres://synthetic-user:synthetic-pass@db.invalid/eoc';
    const harness = gatewayHarness(
      { kind: 'district' },
      ['list-active-events'],
      null,
      new Error(`Synthetic driver failure at ${internalSecret}`),
    );

    const response = await handleAgentCapability(
      agentRequest('list-active-events', {
        facilityId: null,
        cursor: null,
        limit: 25,
      }),
      'list-active-events',
      harness.runtime,
    );
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain(internalSecret);
    expect(responseText).not.toContain('Synthetic driver failure');
    expect(responseText).toContain('The agent capability request failed.');
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'list-active-events',
        outcome: 'failure',
        reasonCode: 'AGENT_CAPABILITY_FAILED',
      }),
    ]);
  });

  test('returns a bounded 403 for district-only administration reads', async () => {
    const harness = gatewayHarness(
      {
        kind: 'facilities',
        facilityIds: [IDS.facility],
      },
      ['list-active-events'],
      null,
      new AgentApiKeyAdministrationError(),
    );

    const response = await handleAgentCapability(
      agentRequest('list-active-events', {
        facilityId: IDS.facility,
        cursor: null,
        limit: 25,
      }),
      'list-active-events',
      harness.runtime,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'District administration capability access is required.',
      retryable: false,
    });
    expect(harness.audits).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        reasonCode: 'CAPABILITY_INVOCATION_DENIED',
      }),
    ]);
  });

  test('rejects unregistered route IDs before they become authenticated agent calls', async () => {
    const harness = gatewayHarness({ kind: 'district' });

    const response = await handleAgentCapability(
      agentRequest('not-a-capability', {}),
      'not-a-capability',
      harness.runtime,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'NOT_FOUND',
      requestId: IDS.request,
      retryable: false,
    });
    expect(harness.dispatches).toEqual([]);
    expect(harness.audits).toEqual([]);
    expect(harness.authenticationAttempts).toEqual([]);
  });

  test('guards direct gateway callers from unregistered IDs before authentication', async () => {
    const harness = gatewayHarness({ kind: 'district' });

    await expect(
      harness.runtime.gateway.authorize({
        credential: CREDENTIAL,
        capabilityId: 'not-a-capability',
        requestId: IDS.request,
        serverTime: new Date('2026-08-10T18:01:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      retryable: false,
    });
    expect(harness.authenticationAttempts).toEqual([]);
    expect(harness.audits).toEqual([]);
    expect(harness.dispatches).toEqual([]);
  });

  test('rejects human confirmation metadata before capability dispatch', async () => {
    const harness = gatewayHarness({ kind: 'district' });
    const response = await handleAgentCapability(
      agentRequest(
        'list-active-events',
        { facilityId: null, cursor: null, limit: 25 },
        { humanConfirmationId: IDS.request },
      ),
      'list-active-events',
      harness.runtime,
    );

    expect(response.status).toBe(403);
    expect(harness.dispatches).toEqual([]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'access-denial',
        action: 'list-active-events',
        outcome: 'denied',
        reasonCode: 'HUMAN_ONLY_REQUIRED',
      }),
    ]);
  });

  test('requires canonical idempotency metadata for mutations', async () => {
    const harness = gatewayHarness({ kind: 'district' }, [
      'prepare-activation',
    ]);
    const response = await handleAgentCapability(
      agentRequest('prepare-activation', { activationPreviewId: IDS.request }),
      'prepare-activation',
      harness.runtime,
    );

    expect(response.status).toBe(400);
    expect(harness.dispatches).toEqual([]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'agent-access',
        action: 'prepare-activation',
        outcome: 'failure',
        reasonCode: 'AGENT_REQUEST_INVALID',
      }),
    ]);
  });

  test('audits malformed authenticated JSON before returning a bounded error', async () => {
    const harness = gatewayHarness({ kind: 'district' });
    const request = new Request(
      'https://eoc.example.test/api/agent/v1/capabilities/list-active-events',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CREDENTIAL}`,
          'content-type': 'application/json',
        },
        body: '{',
      },
    );

    const response = await handleAgentCapability(
      request,
      'list-active-events',
      harness.runtime,
    );

    expect(response.status).toBe(400);
    expect(harness.dispatches).toEqual([]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'agent-access',
        action: 'list-active-events',
        outcome: 'failure',
        reasonCode: 'AGENT_REQUEST_INVALID',
      }),
    ]);
  });

  test('reports malformed canonical output as a server failure, not client input', async () => {
    const harness = gatewayHarness({ kind: 'district' }, ['get-event']);

    const response = await handleAgentCapability(
      agentRequest('get-event', { eventId: IDS.request }),
      'get-event',
      harness.runtime,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      requestId: IDS.request,
      retryable: false,
    });
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'agent-access',
        action: 'get-event',
        outcome: 'failure',
        reasonCode: 'AGENT_CAPABILITY_OUTPUT_INVALID',
      }),
    ]);
  });

  test('reports unavailable contract capabilities truthfully and audits failure', async () => {
    const harness = gatewayHarness({ kind: 'district' }, ['get-roster-health']);

    const response = await handleAgentCapability(
      agentRequest('get-roster-health', {
        population: 'synthetic',
        facilityId: IDS.facility,
        cursor: null,
        limit: 50,
      }),
      'get-roster-health',
      harness.runtime,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
      requestId: IDS.request,
    });
    expect(harness.audits).toEqual([
      expect.objectContaining({
        category: 'agent-access',
        action: 'get-roster-health',
        outcome: 'failure',
        reasonCode: 'INTERNAL_ERROR',
      }),
    ]);
  });

  test('preserves bounded status truth for self-audited security-log failures', async () => {
    const cursorResponse = agentApiErrorResponse(
      new SecurityAuditCursorError(),
      IDS.request,
    );
    const scopeResponse = agentApiErrorResponse(
      new SecurityAuditScopeError(),
      IDS.request,
    );

    expect(cursorResponse.status).toBe(400);
    expect(await cursorResponse.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      requestId: IDS.request,
      retryable: false,
    });
    expect(scopeResponse.status).toBe(403);
    expect(await scopeResponse.json()).toMatchObject({
      code: 'FORBIDDEN',
      requestId: IDS.request,
      retryable: false,
    });
  });
});
