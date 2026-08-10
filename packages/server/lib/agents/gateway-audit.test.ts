import { describe, expect, test } from 'bun:test';

import {
  SecurityAuditEntrySchema,
  type AgentGrantableCapabilityId,
  type SecurityAuditEntry,
} from '@psd-eoc/contracts';

import {
  SecurityAuditRequestConflictError,
  type SecurityAuditRepository,
} from '../audit/repository';
import { parseSecurityAuditFact, type SecurityAuditFact } from '../audit/model';
import { CapabilityEngineError } from '../capabilities/engine';
import { createAgentGatewayAuditSink } from './audit';
import { AgentRestGateway, type AgentCapabilityDispatcher } from './gateway';
import type { AuthenticatedAgentApiKey } from './keys';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000501',
  apiKey: '00000000-0000-4000-8000-000000000502',
  issuer: '00000000-0000-4000-8000-000000000503',
  facility: '00000000-0000-4000-8000-000000000504',
  request: '00000000-0000-4000-8000-000000000505',
});

const CAPABILITY_IDS = Object.freeze([
  'start-event',
  'list-active-events',
] as const);

const authenticated: AuthenticatedAgentApiKey = Object.freeze({
  actor: {
    kind: 'agent' as const,
    agentId: IDS.agent,
    apiKeyId: IDS.apiKey,
  },
  scope: {
    facilityScope: {
      kind: 'facilities' as const,
      facilityIds: [IDS.facility],
    },
  },
  capabilityIds: CAPABILITY_IDS,
  key: {
    id: IDS.apiKey,
    agentId: IDS.agent,
    displayName: 'Synthetic audit ownership agent',
    facilityScope: {
      kind: 'facilities' as const,
      facilityIds: [IDS.facility],
    },
    capabilityIds: CAPABILITY_IDS,
    keyPrefix: 'abcdefghijkl',
    issuedByUserId: IDS.issuer,
    issuedAt: '2026-08-10T18:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
  },
});

class UniqueRequestAuditRepository implements SecurityAuditRepository {
  public readonly attempts: SecurityAuditFact[] = [];
  public readonly retained = new Map<string, SecurityAuditFact>();

  public async append(value: unknown): Promise<SecurityAuditEntry> {
    const fact = parseSecurityAuditFact(value);
    this.attempts.push(fact);
    const existing = this.retained.get(fact.requestId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(fact)) {
        throw new SecurityAuditRequestConflictError();
      }
      return this.entry(existing);
    }
    this.retained.set(fact.requestId, fact);
    return this.entry(fact);
  }

  private entry(fact: SecurityAuditFact): SecurityAuditEntry {
    return SecurityAuditEntrySchema.parse({
      ...fact,
      id: IDS.request,
      sequence: 1,
      previousHash: null,
      entryHash: '0'.repeat(64),
    });
  }

  public async query(): Promise<never> {
    throw new Error('Unexpected audit query.');
  }

  public async readChainAnchor(): Promise<never> {
    throw new Error('Unexpected audit anchor read.');
  }

  public async readChainPage(): Promise<never> {
    throw new Error('Unexpected audit chain read.');
  }

  public async runVerificationSession(): Promise<never> {
    throw new Error('Unexpected audit verification.');
  }
}

function gateway(
  repository: UniqueRequestAuditRepository,
  dispatcher: AgentCapabilityDispatcher,
): AgentRestGateway {
  return new AgentRestGateway({
    keys: {
      authenticate: async () => authenticated,
      authorizeCapability(_authenticated, capabilityId) {
        if (!authenticated.capabilityIds.includes(capabilityId as never)) {
          throw new Error('Unexpected capability grant.');
        }
        return capabilityId as AgentGrantableCapabilityId;
      },
    },
    dispatcher,
    audit: createAgentGatewayAuditSink(repository),
  });
}

describe('agent gateway audit ownership', () => {
  test('preserves a canonical human-only 403 when the generic fact conflicts', async () => {
    const repository = new UniqueRequestAuditRepository();
    const dispatcher: AgentCapabilityDispatcher = {
      auditOwnership: () => 'canonical',
      async execute(capabilityId, _input, invocation) {
        await repository.append({
          category: 'human-only-rejection',
          action: capabilityId,
          actionIds: ['start-real-incident'],
          confirmationId: null,
          outcome: 'denied',
          principal: invocation.actor,
          source: invocation.source,
          facilityId: IDS.facility,
          target: { kind: 'capability', id: capabilityId },
          requestId: invocation.requestId,
          reasonCode: 'HUMAN_ONLY_REQUIRED',
          occurredAt: invocation.serverTime.toISOString(),
        });
        throw new CapabilityEngineError(
          'FORBIDDEN',
          'HUMAN_ONLY_REQUIRED',
          'This lifecycle action requires an authenticated human.',
          403,
        );
      },
    };

    await expect(
      gateway(repository, dispatcher).execute({
        credential: 'synthetic',
        capabilityId: 'start-event',
        input: {
          source: 'activation-preview',
          activationPreviewId: IDS.request,
          activeEventDecision: {
            decision: 'start-new',
            activeEventIdsSeen: [],
          },
        },
        idempotencyKey: 'canonical-human-only-conflict',
        requestId: IDS.request,
        serverTime: new Date('2026-08-10T18:01:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'HUMAN_ONLY_REQUIRED',
      status: 403,
    });

    expect(repository.attempts).toHaveLength(2);
    expect(repository.retained.get(IDS.request)).toMatchObject({
      category: 'human-only-rejection',
      actionIds: ['start-real-incident'],
      outcome: 'denied',
      reasonCode: 'HUMAN_ONLY_REQUIRED',
    });
  });

  test('writes the gateway fact when a canonical replay emitted no new audit', async () => {
    const repository = new UniqueRequestAuditRepository();
    const dispatcher: AgentCapabilityDispatcher = {
      auditOwnership: () => 'canonical',
      async execute() {
        return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
      },
    };

    const result = await gateway(repository, dispatcher).execute({
      credential: 'synthetic',
      capabilityId: 'list-active-events',
      input: { facilityId: IDS.facility, cursor: null, limit: 25 },
      idempotencyKey: null,
      requestId: IDS.request,
      serverTime: new Date('2026-08-10T18:01:00.000Z'),
    });

    expect(result).toEqual({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(repository.attempts).toHaveLength(1);
    expect(repository.retained.get(IDS.request)).toMatchObject({
      category: 'agent-access',
      action: 'list-active-events',
      outcome: 'success',
      principal: authenticated.actor,
    });
  });
});
