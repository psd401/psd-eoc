import { describe, expect, test } from 'bun:test';

import {
  SecurityAuditPageSchema,
  SecurityAuditQuerySchema,
  type FacilityScope,
  type SecurityAuditEntry,
  type SecurityAuditPage,
  type SecurityAuditQuery,
} from '@psd-eoc/contracts';

import {
  executeQuerySecurityAuditCapability,
  executeVerifySecurityAuditChainCapability,
} from './capabilities';
import { buildSecurityAuditEntry } from './entry';
import { parseSecurityAuditFact, type SecurityAuditFact } from './model';
import {
  SecurityAuditCursorError,
  type SecurityAuditChainPage,
  type SecurityAuditChainPageInput,
  type SecurityAuditRepository,
} from './repository';
import {
  SecurityAuditService,
  isSecurityAuditForbiddenError,
  type SecurityAuditAccessContext,
} from './service';
import { runSecurityAuditVerificationJob } from './verification-job';

const FACILITY_A = '00000000-0000-4000-8000-000000000501';
const FACILITY_B = '00000000-0000-4000-8000-000000000502';
const HUMAN_ID = '00000000-0000-4000-8000-000000000503';
const SESSION_ID = '00000000-0000-4000-8000-000000000504';
const AGENT_ID = '00000000-0000-4000-8000-000000000505';
const API_KEY_ID = '00000000-0000-4000-8000-000000000506';
const OCCURRED_AT = '2026-08-08T13:00:00.000Z';

const BASE_QUERY = SecurityAuditQuerySchema.parse({
  actorKind: null,
  principal: null,
  category: null,
  outcome: null,
  action: null,
  facilityId: null,
  occurredFrom: null,
  occurredThrough: null,
  cursor: null,
  limit: 100,
});

class MemoryAuditRepository implements SecurityAuditRepository {
  public readonly entries: SecurityAuditEntry[] = [];
  public queryCalls = 0;
  public readChainCalls = 0;
  public queryError: Error | null = null;

  public async append(factValue: SecurityAuditFact | unknown) {
    const fact = parseSecurityAuditFact(factValue);
    const existing = this.entries.find(
      (entry) => entry.requestId === fact.requestId,
    );
    if (existing !== undefined) return existing;
    const entry = buildSecurityAuditEntry(fact, this.entries.at(-1) ?? null);
    this.entries.push(entry);
    return entry;
  }

  public async query(
    query: SecurityAuditQuery,
    scope: FacilityScope,
  ): Promise<SecurityAuditPage> {
    this.queryCalls += 1;
    if (this.queryError !== null) throw this.queryError;
    const items = this.entries
      .filter((entry) =>
        scope.kind === 'district'
          ? true
          : entry.facilityId !== null &&
            scope.facilityIds.includes(entry.facilityId),
      )
      .filter(
        (entry) =>
          query.facilityId === null || entry.facilityId === query.facilityId,
      )
      .filter(
        (entry) =>
          query.actorKind === null || entry.principal.kind === query.actorKind,
      )
      .filter((entry) => query.action === null || entry.action === query.action)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, query.limit);
    return SecurityAuditPageSchema.parse({
      items,
      pageInfo: { hasMore: false, nextCursor: null },
    });
  }

  public readChainPage(
    input: SecurityAuditChainPageInput,
  ): Promise<SecurityAuditChainPage> {
    this.readChainCalls += 1;
    const candidates = this.entries.filter(
      (entry) =>
        entry.sequence > input.afterSequence &&
        (input.throughSequence === null ||
          entry.sequence <= input.throughSequence),
    );
    const entries = candidates.slice(0, input.limit);
    return Promise.resolve({
      entries,
      lastSequence: entries.at(-1)?.sequence ?? null,
      hasMore: candidates.length > input.limit,
    });
  }

  public tamper(sequence: number): void {
    const index = this.entries.findIndex(
      (entry) => entry.sequence === sequence,
    );
    const entry = this.entries[index];
    if (entry !== undefined) {
      this.entries[index] = { ...entry, action: 'get-event' };
    }
  }
}

function humanAccess(
  facilityScope: FacilityScope,
  roles: readonly ('staff' | 'admin')[] = ['admin'],
): Omit<SecurityAuditAccessContext, 'requestId' | 'serverTime'> {
  return {
    actor: { kind: 'human', userId: HUMAN_ID, sessionId: SESSION_ID },
    source: 'web',
    facilityScope,
    roles,
    capabilityGrants: [],
  };
}

function agentAccess(
  grants: SecurityAuditAccessContext['capabilityGrants'],
): Omit<SecurityAuditAccessContext, 'requestId' | 'serverTime'> {
  return {
    actor: { kind: 'agent', agentId: AGENT_ID, apiKeyId: API_KEY_ID },
    source: 'agent-rest',
    facilityScope: { kind: 'district' },
    roles: [],
    capabilityGrants: grants,
  };
}

async function seed(repository: MemoryAuditRepository): Promise<void> {
  const facts: readonly SecurityAuditFact[] = [
    parseSecurityAuditFact({
      category: 'sign-in',
      action: 'complete-oidc-sign-in',
      actionIds: [],
      confirmationId: null,
      outcome: 'success',
      principal: { kind: 'human', userId: HUMAN_ID, sessionId: SESSION_ID },
      source: 'web',
      facilityId: null,
      target: { kind: 'session', id: SESSION_ID },
      requestId: '00000000-0000-4000-8000-000000000511',
      reasonCode: null,
      occurredAt: OCCURRED_AT,
    }),
    parseSecurityAuditFact({
      category: 'admin-change',
      action: 'update-facility',
      actionIds: [],
      confirmationId: null,
      outcome: 'success',
      principal: { kind: 'human', userId: HUMAN_ID, sessionId: SESSION_ID },
      source: 'web',
      facilityId: FACILITY_A,
      target: { kind: 'configuration', id: FACILITY_A },
      requestId: '00000000-0000-4000-8000-000000000512',
      reasonCode: null,
      occurredAt: OCCURRED_AT,
    }),
    parseSecurityAuditFact({
      category: 'agent-access',
      action: 'list-facilities',
      actionIds: [],
      confirmationId: null,
      outcome: 'success',
      principal: {
        kind: 'agent',
        agentId: AGENT_ID,
        apiKeyId: API_KEY_ID,
      },
      source: 'agent-rest',
      facilityId: FACILITY_B,
      target: { kind: 'capability', id: 'list-facilities' },
      requestId: '00000000-0000-4000-8000-000000000513',
      reasonCode: null,
      occurredAt: OCCURRED_AT,
    }),
  ];
  for (const fact of facts) await repository.append(fact);
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the security audit operation to reject.');
}

describe('security audit capabilities', () => {
  test('limits facility administrators and audits successful queries', async () => {
    const repository = new MemoryAuditRepository();
    await seed(repository);
    const page = await executeQuerySecurityAuditCapability({
      service: new SecurityAuditService(repository),
      access: humanAccess({ kind: 'facilities', facilityIds: [FACILITY_A] }),
      query: BASE_QUERY,
      requestId: '00000000-0000-4000-8000-000000000521',
      now: new Date('2026-08-08T13:01:00.000Z'),
    });

    expect(page.items.map((entry) => entry.facilityId)).toEqual([FACILITY_A]);
    expect(repository.entries.at(-1)).toMatchObject({
      category: 'audit-query',
      action: 'query-security-audit',
      outcome: 'success',
      facilityId: FACILITY_A,
      reasonCode: null,
    });
  });

  test('audits and denies explicit cross-facility queries before reading', async () => {
    const repository = new MemoryAuditRepository();
    const requestId = '00000000-0000-4000-8000-000000000522';
    const operation = executeQuerySecurityAuditCapability({
      service: new SecurityAuditService(repository),
      access: humanAccess({ kind: 'facilities', facilityIds: [FACILITY_A] }),
      query: { ...BASE_QUERY, facilityId: FACILITY_B },
      requestId,
      now: new Date('2026-08-08T13:02:00.000Z'),
    });

    expect(
      isSecurityAuditForbiddenError(await captureRejection(operation)),
    ).toBe(true);
    expect(repository.queryCalls).toBe(0);
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]).toMatchObject({
      category: 'audit-query',
      outcome: 'denied',
      requestId,
      reasonCode: 'AUDIT_QUERY_FORBIDDEN',
    });
  });

  test('requires admin role or the exact agent key grant', async () => {
    const repository = new MemoryAuditRepository();
    const service = new SecurityAuditService(repository);

    expect(
      isSecurityAuditForbiddenError(
        await captureRejection(
          executeQuerySecurityAuditCapability({
            service,
            access: humanAccess({ kind: 'district' }, ['staff']),
            query: BASE_QUERY,
            requestId: '00000000-0000-4000-8000-000000000523',
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isSecurityAuditForbiddenError(
        await captureRejection(
          executeQuerySecurityAuditCapability({
            service,
            access: agentAccess([]),
            query: BASE_QUERY,
            requestId: '00000000-0000-4000-8000-000000000524',
          }),
        ),
      ),
    ).toBe(true);
    const page = await executeQuerySecurityAuditCapability({
      service,
      access: agentAccess(['query-security-audit']),
      query: BASE_QUERY,
      requestId: '00000000-0000-4000-8000-000000000525',
    });

    expect(page.items).toHaveLength(2);
    expect(repository.entries.map((entry) => entry.outcome)).toEqual([
      'denied',
      'denied',
      'success',
    ]);
    expect(JSON.stringify(repository.entries)).not.toContain('messageContent');
    expect(JSON.stringify(repository.entries)).not.toContain('@psd401.net');
  });

  test('audits an invalid cursor as a denied query', async () => {
    const repository = new MemoryAuditRepository();
    const requestId = '00000000-0000-4000-8000-000000000528';
    repository.queryError = new SecurityAuditCursorError();

    await expect(
      executeQuerySecurityAuditCapability({
        service: new SecurityAuditService(repository),
        access: humanAccess({ kind: 'district' }),
        query: { ...BASE_QUERY, cursor: 'synthetic-invalid-cursor' },
        requestId,
      }),
    ).rejects.toBeInstanceOf(SecurityAuditCursorError);
    expect(repository.queryCalls).toBe(1);
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]).toMatchObject({
      category: 'audit-query',
      action: 'query-security-audit',
      outcome: 'denied',
      requestId,
      reasonCode: 'AUDIT_QUERY_INVALID',
    });
  });

  test('runs full-chain verification only with district authorization', async () => {
    const repository = new MemoryAuditRepository();
    await seed(repository);
    repository.tamper(2);
    const service = new SecurityAuditService(repository);

    expect(
      isSecurityAuditForbiddenError(
        await captureRejection(
          executeVerifySecurityAuditChainCapability({
            service,
            access: humanAccess({
              kind: 'facilities',
              facilityIds: [FACILITY_A],
            }),
            verification: { fromSequence: null, throughSequence: null },
            requestId: '00000000-0000-4000-8000-000000000526',
          }),
        ),
      ),
    ).toBe(true);

    const result = await executeVerifySecurityAuditChainCapability({
      service,
      access: {
        actor: { kind: 'system', serviceId: 'security-audit-verifier' },
        source: 'scheduled-job',
        facilityScope: { kind: 'district' },
        roles: [],
        capabilityGrants: [],
      },
      verification: { fromSequence: null, throughSequence: 3 },
      requestId: '00000000-0000-4000-8000-000000000527',
      now: new Date('2026-08-08T13:03:00.000Z'),
    });

    expect(result).toEqual({ valid: false, firstInvalidSequence: 2 });
    expect(repository.entries.at(-1)).toMatchObject({
      category: 'audit-query',
      action: 'verify-security-audit-chain',
      outcome: 'failure',
      reasonCode: 'AUDIT_CHAIN_INVALID',
    });
  });

  test('verifies long chains through bounded repository pages', async () => {
    const repository = new MemoryAuditRepository();
    for (let index = 1; index <= 205; index += 1) {
      await repository.append({
        category: 'agent-access',
        action: 'list-facilities',
        actionIds: [],
        confirmationId: null,
        outcome: 'success',
        principal: { kind: 'system', serviceId: 'synthetic-audit-seed' },
        source: 'scheduled-job',
        facilityId: null,
        target: { kind: 'capability', id: 'list-facilities' },
        requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        reasonCode: null,
        occurredAt: OCCURRED_AT,
      });
    }

    const result = await runSecurityAuditVerificationJob({
      service: new SecurityAuditService(repository),
      requestId: '00000000-0000-4000-8000-000000000529',
    });

    expect(result).toEqual({ valid: true, verifiedThroughSequence: 205 });
    expect(repository.readChainCalls).toBe(2);
    expect(repository.entries.at(-1)).toMatchObject({
      sequence: 206,
      action: 'verify-security-audit-chain',
      outcome: 'success',
    });
  });
});
