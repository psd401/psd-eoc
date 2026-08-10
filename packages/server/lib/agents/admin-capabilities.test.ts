import { describe, expect, test } from 'bun:test';

import {
  AgentApiKeyIssuanceSchema,
  AgentApiKeyPageSchema,
  AgentApiKeyRevocationSchema,
  type SecurityAuditEntry,
} from '@psd-eoc/contracts';

import type { SecurityAuditFact } from '../audit/model';
import {
  AgentApiKeyAdministration,
  AgentApiKeyAdministrationCommitError,
  AgentApiKeyAdministrationError,
  type AgentApiKeyAdministrationAccess,
} from './admin-capabilities';
import type { AgentApiKeyService } from './keys';

const ids = {
  user: '30000000-0000-4000-8000-000000000001',
  session: '30000000-0000-4000-8000-000000000002',
  epoch: '30000000-0000-4000-8000-000000000003',
  agent: '30000000-0000-4000-8000-000000000004',
  key: '30000000-0000-4000-8000-000000000005',
  revocation: '30000000-0000-4000-8000-000000000006',
  requestIssue: '30000000-0000-4000-8000-000000000007',
  requestRevoke: '30000000-0000-4000-8000-000000000008',
  requestList: '30000000-0000-4000-8000-000000000009',
  apiAgent: '30000000-0000-4000-8000-000000000010',
  apiAgentKey: '30000000-0000-4000-8000-000000000011',
} as const;

const now = new Date('2026-08-10T20:00:00.000Z');
const oneTimeCredential = `psd_eoc_agent_v1_abcdefghijkl.${'x'.repeat(43)}`;

const key = {
  id: ids.key,
  agentId: ids.agent,
  displayName: 'Facilities reporting agent',
  facilityScope: { kind: 'district' as const },
  capabilityIds: ['get-event' as const],
  keyPrefix: 'abcdefghijkl',
  issuedByUserId: ids.user,
  issuedAt: now.toISOString(),
  expiresAt: null,
  revokedAt: null,
};

const issuance = AgentApiKeyIssuanceSchema.parse({
  key,
  oneTimeCredential,
});
const revocation = AgentApiKeyRevocationSchema.parse({
  id: ids.revocation,
  apiKeyId: ids.key,
  revokedByUserId: ids.user,
  reasonCode: 'ADMIN_KEY_ROTATION',
  revokedAt: now.toISOString(),
});
const page = AgentApiKeyPageSchema.parse({
  items: [key],
  pageInfo: { hasMore: false, nextCursor: null },
});

function humanAccess(
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

function agentAccess(
  overrides: Partial<AgentApiKeyAdministrationAccess> = {},
): AgentApiKeyAdministrationAccess {
  return {
    actor: {
      kind: 'agent',
      agentId: ids.apiAgent,
      apiKeyId: ids.apiAgentKey,
    },
    source: 'agent-rest',
    roles: [],
    capabilityGrants: [],
    scope: { facilityScope: { kind: 'district' } },
    connectivityEpochId: null,
    ...overrides,
  };
}

function harness(options: Readonly<{ auditFails?: boolean }> = {}) {
  const calls = { issue: 0, revoke: 0, list: 0 };
  const keys: Pick<AgentApiKeyService, 'issue' | 'list' | 'revoke'> = {
    async issue() {
      calls.issue += 1;
      return issuance;
    },
    async revoke() {
      calls.revoke += 1;
      return revocation;
    },
    async list() {
      calls.list += 1;
      return page;
    },
  };
  const auditFacts: SecurityAuditFact[] = [];
  const administration = new AgentApiKeyAdministration({
    keys,
    audit: {
      async append(fact) {
        if (options.auditFails === true) {
          throw new Error('Synthetic audit outage.');
        }
        auditFacts.push(fact as SecurityAuditFact);
        return undefined as unknown as SecurityAuditEntry;
      },
    },
  });
  return { administration, calls, auditFacts };
}

describe('canonical agent API-key administration', () => {
  test('issues, revokes, and lists only through the district-admin authorizer and audits each result', async () => {
    const { administration, calls, auditFacts } = harness();
    const access = humanAccess();

    const issued = await administration.issue({
      access,
      value: {
        agentId: null,
        displayName: key.displayName,
        facilityScope: key.facilityScope,
        capabilityIds: key.capabilityIds,
        expiresInSeconds: null,
      },
      idempotencyKey: 'issue-key-administration-test',
      csrfVerified: true,
      requestId: ids.requestIssue,
      now,
    });
    await administration.revoke({
      access,
      value: {
        apiKeyId: ids.key,
        reasonCode: 'ADMIN_KEY_ROTATION',
      },
      idempotencyKey: 'revoke-key-administration-test',
      csrfVerified: true,
      requestId: ids.requestRevoke,
      now,
    });
    await administration.list({
      access,
      value: {
        agentId: null,
        includeRevoked: true,
        cursor: null,
        limit: 200,
      },
      requestId: ids.requestList,
      now,
    });

    expect(issued.oneTimeCredential).toBe(oneTimeCredential);
    expect(calls).toEqual({ issue: 1, revoke: 1, list: 1 });
    expect(
      auditFacts.map(({ action, category, outcome }) => ({
        action,
        category,
        outcome,
      })),
    ).toEqual([
      {
        action: 'issue-agent-api-key',
        category: 'admin-change',
        outcome: 'success',
      },
      {
        action: 'revoke-agent-api-key',
        category: 'admin-change',
        outcome: 'success',
      },
      {
        action: 'list-agent-api-keys',
        category: 'agent-access',
        outcome: 'success',
      },
    ]);
    const retainedAuditJson = JSON.stringify(auditFacts);
    expect(retainedAuditJson).not.toContain(oneTimeCredential);
    expect(retainedAuditJson).not.toContain('credentialDigest');
  });

  test.each([
    ['agent principal', agentAccess()],
    ['non-admin human', humanAccess({ roles: ['staff'] })],
    [
      'facility-scoped administrator',
      humanAccess({
        scope: {
          facilityScope: {
            kind: 'facilities',
            facilityIds: ['30000000-0000-4000-8000-000000000012'],
          },
        },
      }),
    ],
  ])(
    'denies %s before key issuance and appends evidence',
    async (_, access) => {
      const { administration, calls, auditFacts } = harness();

      await expect(
        administration.issue({
          access,
          value: {
            agentId: null,
            displayName: key.displayName,
            facilityScope: key.facilityScope,
            capabilityIds: key.capabilityIds,
            expiresInSeconds: null,
          },
          idempotencyKey: 'denied-key-administration-test',
          csrfVerified: true,
          now,
        }),
      ).rejects.toBeInstanceOf(AgentApiKeyAdministrationError);

      expect(calls.issue).toBe(0);
      expect(auditFacts).toHaveLength(1);
      expect(auditFacts[0]).toMatchObject({
        action: 'issue-agent-api-key',
        category: 'admin-change',
        outcome: 'denied',
        reasonCode: 'AGENT_KEY_ADMIN_FORBIDDEN',
      });
    },
  );

  test('allows only an explicitly granted district agent to list non-secret key metadata', async () => {
    const allowedHarness = harness();
    const allowed = agentAccess({
      capabilityGrants: ['list-agent-api-keys'],
    });

    await expect(
      allowedHarness.administration.list({
        access: allowed,
        value: {
          agentId: null,
          includeRevoked: true,
          cursor: null,
          limit: 200,
        },
        requestId: ids.requestList,
        now,
      }),
    ).resolves.toEqual(page);
    expect(allowedHarness.calls.list).toBe(1);
    expect(allowedHarness.auditFacts[0]).toMatchObject({
      action: 'list-agent-api-keys',
      outcome: 'success',
      principal: {
        kind: 'agent',
        agentId: ids.apiAgent,
        apiKeyId: ids.apiAgentKey,
      },
    });
    expect(JSON.stringify(allowedHarness.auditFacts)).not.toContain(
      oneTimeCredential,
    );

    for (const deniedAccess of [
      agentAccess(),
      agentAccess({
        capabilityGrants: ['list-agent-api-keys'],
        scope: {
          facilityScope: {
            kind: 'facilities',
            facilityIds: ['30000000-0000-4000-8000-000000000012'],
          },
        },
      }),
    ]) {
      const deniedHarness = harness();
      await expect(
        deniedHarness.administration.list({
          access: deniedAccess,
          value: {
            agentId: null,
            includeRevoked: true,
            cursor: null,
            limit: 200,
          },
          now,
        }),
      ).rejects.toBeInstanceOf(AgentApiKeyAdministrationError);
      expect(deniedHarness.calls.list).toBe(0);
      expect(deniedHarness.auditFacts[0]).toMatchObject({
        action: 'list-agent-api-keys',
        outcome: 'denied',
      });
    }
  });

  test('denies an unverified browser mutation before key issuance', async () => {
    const { administration, calls, auditFacts } = harness();

    await expect(
      administration.issue({
        access: humanAccess(),
        value: {
          agentId: null,
          displayName: key.displayName,
          facilityScope: key.facilityScope,
          capabilityIds: key.capabilityIds,
          expiresInSeconds: null,
        },
        idempotencyKey: 'unverified-browser-administration-test',
        csrfVerified: false,
        now,
      }),
    ).rejects.toBeInstanceOf(AgentApiKeyAdministrationError);

    expect(calls.issue).toBe(0);
    expect(auditFacts[0]).toMatchObject({
      action: 'issue-agent-api-key',
      outcome: 'denied',
      reasonCode: 'AGENT_KEY_ADMIN_FORBIDDEN',
    });
  });

  test('reports committed issuance truth without exposing its credential when audit append fails', async () => {
    const { administration, calls } = harness({ auditFails: true });
    let committedError: unknown;

    try {
      await administration.issue({
        access: humanAccess(),
        value: {
          agentId: null,
          displayName: key.displayName,
          facilityScope: key.facilityScope,
          capabilityIds: key.capabilityIds,
          expiresInSeconds: null,
        },
        idempotencyKey: 'audit-failure-issuance-test',
        csrfVerified: true,
        requestId: ids.requestIssue,
        now,
      });
    } catch (error) {
      committedError = error;
    }

    expect(calls.issue).toBe(1);
    expect(committedError).toBeInstanceOf(AgentApiKeyAdministrationCommitError);
    expect(committedError).toMatchObject({
      committed: { kind: 'issued', key: { id: key.id } },
    });
    expect(JSON.stringify(committedError)).not.toContain(oneTimeCredential);
  });

  test('reports committed revocation truth when audit append fails', async () => {
    const { administration, calls } = harness({ auditFails: true });

    await expect(
      administration.revoke({
        access: humanAccess(),
        value: {
          apiKeyId: ids.key,
          reasonCode: 'ADMIN_KEY_ROTATION',
        },
        idempotencyKey: 'audit-failure-revocation-test',
        csrfVerified: true,
        requestId: ids.requestRevoke,
        now,
      }),
    ).rejects.toMatchObject({
      committed: { kind: 'revoked', revocation: { apiKeyId: ids.key } },
    });
    expect(calls.revoke).toBe(1);
  });
});
