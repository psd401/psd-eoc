import { describe, expect, test } from 'bun:test';

import {
  isAgentGrantableCapabilityId,
  type AgentGrantableCapabilityId,
} from '@psd-eoc/contracts';

import {
  AgentRestGateway,
  type AgentCapabilityDispatcher,
  type AgentGatewayAuditEvent,
} from './gateway';
import { AgentApiKeyError, type AuthenticatedAgentApiKey } from './keys';
import {
  AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR,
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
} from './rate-limit';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000701',
  apiKey: '00000000-0000-4000-8000-000000000702',
  otherAgent: '00000000-0000-4000-8000-000000000703',
  otherApiKey: '00000000-0000-4000-8000-000000000704',
  issuer: '00000000-0000-4000-8000-000000000705',
  facility: '00000000-0000-4000-8000-000000000706',
  event: '00000000-0000-4000-8000-000000000707',
});

const CAPABILITY_IDS = Object.freeze([
  'list-active-events',
  'export-event-summary',
  'export-drill-records',
  'start-event',
] as const satisfies readonly AgentGrantableCapabilityId[]);

const CREDENTIALS = Object.freeze({
  first:
    'psd_eoc_agent_v1_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno',
  second:
    'psd_eoc_agent_v1_mnopqrstuvwx.abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno',
});

const SERVER_TIME = new Date('2026-10-18T18:00:00.000Z');

function authenticatedKey(
  agentId: string,
  apiKeyId: string,
  keyPrefix: string,
): AuthenticatedAgentApiKey {
  const facilityScope = { kind: 'district' as const };
  return Object.freeze({
    actor: { kind: 'agent' as const, agentId, apiKeyId },
    scope: { facilityScope },
    capabilityIds: CAPABILITY_IDS,
    key: {
      id: apiKeyId,
      agentId,
      displayName: 'Synthetic budget agent',
      facilityScope,
      capabilityIds: CAPABILITY_IDS,
      keyPrefix,
      issuedByUserId: IDS.issuer,
      issuedAt: '2026-08-10T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    },
  });
}

const firstKey = authenticatedKey(IDS.agent, IDS.apiKey, 'abcdefghijkl');
const secondKey = authenticatedKey(
  IDS.otherAgent,
  IDS.otherApiKey,
  'mnopqrstuvwx',
);

interface Harness {
  readonly gateway: AgentRestGateway;
  readonly audits: AgentGatewayAuditEvent[];
  readonly dispatches: string[];
}

function harness(): Harness {
  const audits: AgentGatewayAuditEvent[] = [];
  const dispatches: string[] = [];
  const dispatcher: AgentCapabilityDispatcher = {
    auditOwnership: () => 'gateway',
    async execute(capabilityId) {
      dispatches.push(capabilityId);
      return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
    },
  };
  const gateway = new AgentRestGateway({
    keys: {
      async authenticate(credential) {
        if (credential === CREDENTIALS.first) return firstKey;
        if (credential === CREDENTIALS.second) return secondKey;
        throw new AgentApiKeyError(
          'INVALID_CREDENTIAL',
          'The agent API key is invalid.',
        );
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
        audits.push(event);
      },
    },
  });
  return { gateway, audits, dispatches };
}

function requestId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

describe('agent gateway request budget', () => {
  test('refuses the request after the per-minute budget with 429, audits it, and never dispatches', async () => {
    const { gateway, audits, dispatches } = harness();
    const call = (sequence: number) =>
      gateway.execute({
        credential: CREDENTIALS.first,
        capabilityId: 'list-active-events',
        input: { facilityId: null, cursor: null, limit: 25 },
        idempotencyKey: null,
        requestId: requestId(sequence),
        serverTime: new Date(SERVER_TIME.getTime() + sequence * 10),
      });

    for (
      let sequence = 1;
      sequence <= AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      sequence += 1
    ) {
      await expect(call(sequence)).resolves.toEqual({
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    }
    expect(dispatches).toHaveLength(AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE);
    expect(audits).toHaveLength(AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE);

    const refusedSequence = AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE + 1;
    await expect(call(refusedSequence)).rejects.toMatchObject({
      name: 'AgentGatewayRateLimitError',
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
      reasonCode: 'RATE_LIMITED',
      retryAfterSeconds: 60,
    });

    expect(dispatches).toHaveLength(AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE);
    expect(audits).toHaveLength(refusedSequence);
    expect(audits.at(-1)).toMatchObject({
      category: 'access-denial',
      action: 'list-active-events',
      actionIds: [],
      outcome: 'denied',
      actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
      source: 'agent-rest',
      requestId: requestId(refusedSequence),
      reasonCode: 'RATE_LIMITED',
    });
  });

  test('caps exports per hour for one key while another key is still admitted', async () => {
    const { gateway, audits, dispatches } = harness();
    const authorize = (credential: string, sequence: number) =>
      gateway.authorize({
        credential,
        capabilityId: 'export-event-summary',
        requestId: requestId(sequence),
        // Two minutes apart, so only the hourly window can be the reason.
        serverTime: new Date(SERVER_TIME.getTime() + sequence * 120_000),
      });

    for (
      let sequence = 1;
      sequence <= AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
      sequence += 1
    ) {
      await expect(
        authorize(CREDENTIALS.first, sequence),
      ).resolves.toMatchObject({ capabilityId: 'export-event-summary' });
    }
    const refusedSequence = AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR + 1;
    await expect(
      authorize(CREDENTIALS.first, refusedSequence),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(audits).toEqual([
      expect.objectContaining({
        actor: firstKey.actor,
        action: 'export-event-summary',
        reasonCode: 'RATE_LIMITED',
      }),
    ]);

    // The other costly capability shares the same hourly budget for that key.
    await expect(
      gateway.authorize({
        credential: CREDENTIALS.first,
        capabilityId: 'export-drill-records',
        requestId: requestId(refusedSequence + 1),
        serverTime: new Date(
          SERVER_TIME.getTime() + (refusedSequence + 1) * 120_000,
        ),
      }),
    ).rejects.toMatchObject({ status: 429 });

    // A different key is unaffected, and the exhausted key may still read.
    await expect(
      authorize(CREDENTIALS.second, refusedSequence),
    ).resolves.toMatchObject({ authenticated: secondKey });
    await expect(
      gateway.execute({
        credential: CREDENTIALS.first,
        capabilityId: 'list-active-events',
        input: { facilityId: null, cursor: null, limit: 25 },
        idempotencyKey: null,
        requestId: requestId(refusedSequence + 2),
        serverTime: new Date(
          SERVER_TIME.getTime() + (refusedSequence + 2) * 120_000,
        ),
      }),
    ).resolves.toBeDefined();
    expect(dispatches).toEqual(['list-active-events']);
  });

  test('still audits a protected action attempt as human-only once the budget is spent', async () => {
    const { gateway, audits, dispatches } = harness();
    for (
      let sequence = 1;
      sequence <= AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      sequence += 1
    ) {
      await gateway.authorize({
        credential: CREDENTIALS.first,
        capabilityId: 'list-active-events',
        requestId: requestId(sequence),
        serverTime: SERVER_TIME,
      });
    }

    await expect(
      gateway.authorize({
        credential: CREDENTIALS.first,
        capabilityId: 'start-real-incident',
        requestId: requestId(AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE + 1),
        serverTime: SERVER_TIME,
      }),
    ).rejects.toMatchObject({ status: 403, reasonCode: 'HUMAN_ONLY_REQUIRED' });

    expect(audits).toEqual([
      expect.objectContaining({
        category: 'human-only-rejection',
        actionIds: ['start-real-incident'],
        reasonCode: 'HUMAN_ONLY_REQUIRED',
      }),
    ]);
    expect(dispatches).toEqual([]);
  });

  test('does not spend a key budget on an invalid credential', async () => {
    const { gateway } = harness();
    for (let sequence = 1; sequence <= 70; sequence += 1) {
      await expect(
        gateway.authorize({
          credential: 'psd_eoc_agent_v1_zzzzzzzzzzzz.' + 'z'.repeat(43),
          capabilityId: 'list-active-events',
          requestId: requestId(sequence),
          serverTime: SERVER_TIME,
        }),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      gateway.authorize({
        credential: CREDENTIALS.first,
        capabilityId: 'list-active-events',
        requestId: requestId(71),
        serverTime: SERVER_TIME,
      }),
    ).resolves.toMatchObject({ authenticated: firstKey });
  });
});
