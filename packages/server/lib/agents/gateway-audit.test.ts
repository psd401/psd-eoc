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
import {
  AgentApiKeyError,
  digestAgentApiKeyAuditSubject,
  digestAgentApiKeyCredential,
  type AuthenticatedAgentApiKey,
} from './keys';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000501',
  apiKey: '00000000-0000-4000-8000-000000000502',
  issuer: '00000000-0000-4000-8000-000000000503',
  facility: '00000000-0000-4000-8000-000000000504',
  request: '00000000-0000-4000-8000-000000000505',
  otherFacility: '00000000-0000-4000-8000-000000000506',
});

const CAPABILITY_IDS = Object.freeze([
  'start-event',
  'list-active-events',
] as const);

function authenticatedWithScope(
  facilityScope: AuthenticatedAgentApiKey['scope']['facilityScope'],
): AuthenticatedAgentApiKey {
  return Object.freeze({
    actor: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    scope: { facilityScope },
    capabilityIds: CAPABILITY_IDS,
    key: {
      id: IDS.apiKey,
      agentId: IDS.agent,
      displayName: 'Synthetic audit ownership agent',
      facilityScope,
      capabilityIds: CAPABILITY_IDS,
      keyPrefix: 'abcdefghijkl',
      issuedByUserId: IDS.issuer,
      issuedAt: '2026-08-10T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    },
  });
}

const authenticated = authenticatedWithScope({
  kind: 'facilities',
  facilityIds: [IDS.facility],
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
  agent: AuthenticatedAgentApiKey = authenticated,
): AgentRestGateway {
  return new AgentRestGateway({
    keys: {
      authenticate: async () => agent,
      authorizeCapability(_authenticated, capabilityId) {
        if (!agent.capabilityIds.includes(capabilityId as never)) {
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
  test('records invalid credentials with a minimized unauthenticated principal', async () => {
    const repository = new UniqueRequestAuditRepository();
    const credential = `psd_eoc_agent_v1_abcdefghijkl.${'A'.repeat(43)}`;
    const subjectDigest = digestAgentApiKeyAuditSubject(credential);
    const dispatcher: AgentCapabilityDispatcher = {
      auditOwnership: () => 'gateway',
      async execute() {
        throw new Error('Authentication denial must not dispatch.');
      },
    };
    const subject = new AgentRestGateway({
      keys: {
        async authenticate() {
          throw new AgentApiKeyError(
            'INVALID_CREDENTIAL',
            'The agent API key is invalid.',
          );
        },
        authorizeCapability() {
          throw new Error('Authentication denial must not authorize.');
        },
      },
      dispatcher,
      audit: createAgentGatewayAuditSink(repository),
    });

    await expect(
      subject.authorize({
        credential,
        capabilityId: 'list-active-events',
        requestId: IDS.request,
        serverTime: new Date('2026-08-10T18:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL', status: 401 });

    expect(subjectDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(subjectDigest).not.toBe(digestAgentApiKeyCredential(credential));
    expect(repository.retained.get(IDS.request)).toMatchObject({
      category: 'access-denial',
      action: 'list-active-events',
      actionIds: [],
      outcome: 'denied',
      principal: { kind: 'unauthenticated', subjectDigest },
      facilityId: null,
      reasonCode: 'INVALID_CREDENTIAL',
    });
    expect(JSON.stringify(repository.attempts)).not.toContain(credential);
    expect(JSON.stringify(repository.attempts)).not.toContain(
      digestAgentApiKeyCredential(credential),
    );
  });

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
      facilityId: IDS.facility,
    });
  });

  test('records an unambiguous parsed target for broad agent scopes', async () => {
    const dispatcher: AgentCapabilityDispatcher = {
      auditOwnership: () => 'canonical',
      async execute() {
        return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
      },
    };

    for (const agent of [
      authenticatedWithScope({ kind: 'district' }),
      authenticatedWithScope({
        kind: 'facilities',
        facilityIds: [IDS.facility, IDS.otherFacility],
      }),
    ]) {
      const repository = new UniqueRequestAuditRepository();
      await gateway(repository, dispatcher, agent).execute({
        credential: 'synthetic',
        capabilityId: 'list-active-events',
        input: { facilityId: IDS.otherFacility, cursor: null, limit: 25 },
        idempotencyKey: null,
        requestId: IDS.request,
        serverTime: new Date('2026-08-10T18:01:00.000Z'),
      });

      expect(repository.retained.get(IDS.request)?.facilityId).toBe(
        IDS.otherFacility,
      );
    }
  });

  test('keeps a genuinely district-wide call facility-neutral', async () => {
    const repository = new UniqueRequestAuditRepository();
    const districtAgent = authenticatedWithScope({ kind: 'district' });
    const dispatcher: AgentCapabilityDispatcher = {
      auditOwnership: () => 'gateway',
      async execute() {
        return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
      },
    };

    await gateway(repository, dispatcher, districtAgent).execute({
      credential: 'synthetic',
      capabilityId: 'list-active-events',
      input: { facilityId: null, cursor: null, limit: 25 },
      idempotencyKey: null,
      requestId: IDS.request,
      serverTime: new Date('2026-08-10T18:01:00.000Z'),
    });

    expect(repository.retained.get(IDS.request)?.facilityId).toBeNull();
  });
});
