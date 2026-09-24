import { describe, expect, test } from 'bun:test';

import {
  FacilityPageSchema,
  type SecurityAuditEntry,
} from '@psd-eoc/contracts';

import type { SecurityAuditFact } from '../audit/model';
import type { AgentApiKeyAdministrationAccess } from './admin-capabilities';
import {
  AgentAdministrationFacilityCapabilities,
  type AgentAdministrationFacilityStore,
} from './admin-facilities';

const ids = {
  user: '40000000-0000-4000-8000-000000000001',
  session: '40000000-0000-4000-8000-000000000002',
  epoch: '40000000-0000-4000-8000-000000000003',
  facility: '40000000-0000-4000-8000-000000000004',
  request: '40000000-0000-4000-8000-000000000005',
  agent: '40000000-0000-4000-8000-000000000006',
  apiKey: '40000000-0000-4000-8000-000000000007',
} as const;

const page = FacilityPageSchema.parse({
  items: [
    {
      id: ids.facility,
      code: 'HRH',
      name: 'Cedar Valley High School',
      active: true,
      createdAt: '2026-08-10T20:00:00.000Z',
    },
  ],
  pageInfo: { hasMore: false, nextCursor: null },
});

function access(
  overrides: Partial<AgentApiKeyAdministrationAccess> = {},
): AgentApiKeyAdministrationAccess {
  return {
    actor: { kind: 'human', userId: ids.user, sessionId: ids.session },
    source: 'web',
    roles: ['staff', 'admin'],
    capabilityGrants: [],
    scope: { facilityScope: { kind: 'district' } },
    connectivityEpochId: ids.epoch,
    ...overrides,
  };
}

function harness() {
  let calls = 0;
  const store: AgentAdministrationFacilityStore = {
    async list() {
      calls += 1;
      return page;
    },
  };
  const auditFacts: SecurityAuditFact[] = [];
  const capabilities = new AgentAdministrationFacilityCapabilities(store, {
    async append(fact) {
      auditFacts.push(fact as SecurityAuditFact);
      return undefined as unknown as SecurityAuditEntry;
    },
  });
  return { capabilities, auditFacts, calls: () => calls };
}

describe('canonical agent-administration facility read', () => {
  test('returns the contract page and appends minimized success evidence', async () => {
    const { capabilities, auditFacts, calls } = harness();

    await expect(
      capabilities.list({
        access: access(),
        value: { includeInactive: true, cursor: null, limit: 200 },
        requestId: ids.request,
        now: new Date('2026-08-10T20:00:00.000Z'),
      }),
    ).resolves.toEqual(page);

    expect(calls()).toBe(1);
    expect(auditFacts).toHaveLength(1);
    expect(auditFacts[0]).toMatchObject({
      category: 'agent-access',
      action: 'list-facilities',
      outcome: 'success',
      principal: { kind: 'human', userId: ids.user },
      target: { kind: 'capability', id: 'list-facilities' },
      reasonCode: null,
    });
  });

  test('denies a non-admin before storage and audits the denial', async () => {
    const { capabilities, auditFacts, calls } = harness();

    await expect(
      capabilities.list({
        access: access({ roles: ['staff'] }),
        value: { includeInactive: true, cursor: null, limit: 200 },
      }),
    ).rejects.toThrow('District administration capability access is required.');

    expect(calls()).toBe(0);
    expect(auditFacts).toHaveLength(1);
    expect(auditFacts[0]).toMatchObject({
      action: 'list-facilities',
      outcome: 'denied',
      reasonCode: 'AGENT_FACILITY_LIST_FORBIDDEN',
    });
  });

  test('allows an explicitly granted district agent and audits its identity', async () => {
    const { capabilities, auditFacts, calls } = harness();

    await expect(
      capabilities.list({
        access: access({
          actor: {
            kind: 'agent',
            agentId: ids.agent,
            apiKeyId: ids.apiKey,
          },
          source: 'agent-rest',
          roles: [],
          capabilityGrants: ['list-facilities'],
          connectivityEpochId: null,
        }),
        value: { includeInactive: false, cursor: null, limit: 100 },
        requestId: ids.request,
        now: new Date('2026-08-10T20:00:00.000Z'),
      }),
    ).resolves.toEqual(page);

    expect(calls()).toBe(1);
    expect(auditFacts).toHaveLength(1);
    expect(auditFacts[0]).toMatchObject({
      action: 'list-facilities',
      outcome: 'success',
      principal: {
        kind: 'agent',
        agentId: ids.agent,
        apiKeyId: ids.apiKey,
      },
    });
  });

  test('denies an ungranted or facility-scoped agent before storage', async () => {
    const { capabilities, auditFacts, calls } = harness();
    const agent = access({
      actor: {
        kind: 'agent',
        agentId: ids.agent,
        apiKeyId: ids.apiKey,
      },
      source: 'agent-rest',
      roles: [],
      capabilityGrants: [],
      connectivityEpochId: null,
    });

    for (const deniedAccess of [
      agent,
      {
        ...agent,
        capabilityGrants: ['list-facilities'] as const,
        scope: {
          facilityScope: {
            kind: 'facilities' as const,
            facilityIds: [ids.facility],
          },
        },
      },
    ]) {
      await expect(
        capabilities.list({
          access: deniedAccess,
          value: { includeInactive: false, cursor: null, limit: 100 },
        }),
      ).rejects.toThrow(
        'District administration capability access is required.',
      );
    }

    expect(calls()).toBe(0);
    expect(auditFacts).toHaveLength(2);
    expect(auditFacts.every((fact) => fact.outcome === 'denied')).toBe(true);
  });
});
