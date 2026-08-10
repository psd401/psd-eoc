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
import {
  calculateSecurityAuditHash,
  canonicalSecurityAuditJson,
  securityAuditHashPayload,
} from './canonical';
import { buildSecurityAuditEntry } from './entry';
import {
  parseSecurityAuditFact,
  securityAuditFactFromEntry,
  type SecurityAuditFact,
} from './model';
import {
  SecurityAuditCursorError,
  SecurityAuditIntegrityError,
  type SecurityAuditChainAnchor,
  type SecurityAuditChainPage,
  type SecurityAuditChainPageInput,
  type SecurityAuditRepository,
  type SecurityAuditVerificationStore,
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
  public readonly anchors: SecurityAuditChainAnchor[] = [];
  public queryCalls = 0;
  public readChainCalls = 0;
  public verificationSessionReadCallsAtAppend: number | null = null;
  public onReadChainPage: (() => Promise<void>) | null = null;
  public onVerificationAppend: (() => Promise<void>) | null = null;
  public queryError: Error | null = null;

  private async appendFromAnchor(
    factValue: SecurityAuditFact | unknown,
    allowDamagedChain: boolean,
  ) {
    const fact = parseSecurityAuditFact(factValue);
    const anchor = this.anchors.at(-1) ?? null;
    const head = this.entries.at(-1) ?? null;
    if (
      (!allowDamagedChain || fact.outcome === 'success') &&
      ((anchor === null) !== (head === null) ||
        (anchor !== null &&
          head !== null &&
          (anchor.sequence !== head.sequence ||
            anchor.entryHash !== head.entryHash)))
    ) {
      throw new SecurityAuditIntegrityError(
        Math.min(anchor?.sequence ?? 1, head?.sequence ?? 1),
      );
    }
    const existing = this.entries.find(
      (entry) => entry.requestId === fact.requestId,
    );
    if (existing !== undefined) {
      if (
        canonicalSecurityAuditJson(securityAuditFactFromEntry(existing)) ===
        canonicalSecurityAuditJson(fact)
      ) {
        return existing;
      }
      throw new TypeError('Synthetic security audit request conflicts.');
    }
    const entry = buildSecurityAuditEntry(fact, anchor);
    this.entries.push(entry);
    this.anchors.push({
      sequence: entry.sequence,
      entryHash: entry.entryHash,
    });
    return entry;
  }

  public append(factValue: SecurityAuditFact | unknown) {
    return this.appendFromAnchor(factValue, false);
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

  public async readChainPage(
    input: SecurityAuditChainPageInput,
  ): Promise<SecurityAuditChainPage> {
    this.readChainCalls += 1;
    if (this.onReadChainPage !== null) {
      const hook = this.onReadChainPage;
      this.onReadChainPage = null;
      await hook();
    }
    const candidates = this.anchors.filter(
      (anchor) =>
        anchor.sequence > input.afterSequence &&
        (input.throughSequence === null ||
          anchor.sequence <= input.throughSequence),
    );
    const visibleAnchors = candidates.slice(0, input.limit);
    const entries: SecurityAuditEntry[] = [];
    let expectedSequence = input.afterSequence + 1;
    let firstAnchorMismatchSequence: number | null = null;
    for (const anchor of visibleAnchors) {
      if (
        firstAnchorMismatchSequence === null &&
        anchor.sequence !== expectedSequence
      ) {
        firstAnchorMismatchSequence = expectedSequence;
      }
      const entry = this.entries.find(
        (candidate) => candidate.sequence === anchor.sequence,
      );
      if (entry === undefined || entry.entryHash !== anchor.entryHash) {
        firstAnchorMismatchSequence ??= anchor.sequence;
      } else {
        entries.push(entry);
      }
      expectedSequence = anchor.sequence + 1;
    }
    return {
      entries,
      lastSequence: visibleAnchors.at(-1)?.sequence ?? null,
      hasMore: candidates.length > input.limit,
      firstAnchorMismatchSequence,
    };
  }

  public readChainAnchor(
    throughSequence: number | null,
  ): Promise<SecurityAuditChainAnchor | null> {
    const anchor =
      throughSequence === null
        ? (this.anchors.at(-1) ?? null)
        : (this.anchors.find(
            (candidate) => candidate.sequence === throughSequence,
          ) ?? null);
    return Promise.resolve(anchor);
  }

  public runVerificationSession<T>(
    operation: (store: SecurityAuditVerificationStore) => Promise<T>,
  ): Promise<T> {
    return operation({
      append: async (fact) => {
        if (this.onVerificationAppend !== null) {
          const hook = this.onVerificationAppend;
          this.onVerificationAppend = null;
          await hook();
        }
        this.verificationSessionReadCallsAtAppend = this.readChainCalls;
        return this.appendFromAnchor(fact, true);
      },
      readChainAnchor: (throughSequence) =>
        this.readChainAnchor(throughSequence),
      readChainPage: (input) => this.readChainPage(input),
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

  public deleteTailWithoutAnchor(): void {
    this.entries.pop();
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

  test('detects a tail deleted before the scheduled verification starts', async () => {
    const repository = new MemoryAuditRepository();
    await seed(repository);
    const deletedTail = repository.entries.at(-1);
    if (deletedTail === undefined)
      throw new Error('Synthetic tail is missing.');
    repository.deleteTailWithoutAnchor();

    const result = await runSecurityAuditVerificationJob({
      service: new SecurityAuditService(repository),
      requestId: '00000000-0000-4000-8000-000000000530',
    });

    expect(result).toEqual({
      valid: false,
      firstInvalidSequence: deletedTail.sequence,
    });
    expect(
      repository.entries.some(
        (entry) => entry.sequence === deletedTail.sequence,
      ),
    ).toBe(false);
    expect(repository.entries.at(-1)).toMatchObject({
      sequence: deletedTail.sequence + 1,
      previousHash: deletedTail.entryHash,
      action: 'verify-security-audit-chain',
      outcome: 'failure',
      reasonCode: 'AUDIT_CHAIN_INVALID',
    });
    expect(repository.anchors.at(-1)?.sequence).toBe(deletedTail.sequence + 1);
  });

  test('does not let an idempotent append hide a missing anchored tail', async () => {
    const repository = new MemoryAuditRepository();
    await seed(repository);
    const existing = repository.entries[0];
    if (existing === undefined) throw new Error('Synthetic entry is missing.');
    repository.deleteTailWithoutAnchor();

    await expect(
      repository.append(securityAuditFactFromEntry(existing)),
    ).rejects.toBeInstanceOf(SecurityAuditIntegrityError);
    expect(repository.entries).toHaveLength(2);
    expect(repository.anchors).toHaveLength(3);
  });

  test('rejects a hash-consistent rewritten tail that disagrees with its anchor', async () => {
    const repository = new MemoryAuditRepository();
    await seed(repository);
    const originalTail = repository.entries.at(-1);
    if (originalTail === undefined)
      throw new Error('Synthetic tail is missing.');
    const rewrittenPayload = {
      ...originalTail,
      facilityId: FACILITY_A,
    };
    repository.entries[repository.entries.length - 1] = {
      ...rewrittenPayload,
      entryHash: calculateSecurityAuditHash(
        securityAuditHashPayload(rewrittenPayload),
      ),
    };

    const result = await runSecurityAuditVerificationJob({
      service: new SecurityAuditService(repository),
      requestId: '00000000-0000-4000-8000-000000000531',
    });

    expect(result).toEqual({
      valid: false,
      firstInvalidSequence: originalTail.sequence,
    });
    expect(repository.entries.at(-1)).toMatchObject({
      sequence: originalTail.sequence + 1,
      previousHash: originalTail.entryHash,
      outcome: 'failure',
      reasonCode: 'AUDIT_CHAIN_INVALID',
    });
  });

  test('reports the first anchor mismatch in a coherently rewritten suffix', async () => {
    const repository = new MemoryAuditRepository();
    await seed(repository);
    const first = repository.entries[0];
    const second = repository.entries[1];
    const third = repository.entries[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Synthetic audit chain is incomplete.');
    }
    const rewrittenSecondPayload = {
      ...second,
      occurredAt: '2026-08-08T13:00:01.000Z',
    };
    const rewrittenSecond = {
      ...rewrittenSecondPayload,
      entryHash: calculateSecurityAuditHash(
        securityAuditHashPayload(rewrittenSecondPayload),
      ),
    };
    const rewrittenThirdPayload = {
      ...third,
      previousHash: rewrittenSecond.entryHash,
    };
    repository.entries[1] = rewrittenSecond;
    repository.entries[2] = {
      ...rewrittenThirdPayload,
      entryHash: calculateSecurityAuditHash(
        securityAuditHashPayload(rewrittenThirdPayload),
      ),
    };

    const result = await runSecurityAuditVerificationJob({
      service: new SecurityAuditService(repository),
      requestId: '00000000-0000-4000-8000-000000000532',
    });

    expect(result).toEqual({ valid: false, firstInvalidSequence: 2 });
    expect(repository.entries.at(-1)).toMatchObject({
      sequence: 4,
      previousHash: third.entryHash,
      outcome: 'failure',
      reasonCode: 'AUDIT_CHAIN_INVALID',
    });
  });

  test('does not hold the append critical section while scanning', async () => {
    const repository = new MemoryAuditRepository();
    await seed(repository);
    let concurrentEntry: SecurityAuditEntry | undefined;
    repository.onReadChainPage = async () => {
      concurrentEntry = await repository.append({
        category: 'agent-access',
        action: 'list-facilities',
        actionIds: [],
        confirmationId: null,
        outcome: 'success',
        principal: { kind: 'system', serviceId: 'concurrent-audit-writer' },
        source: 'scheduled-job',
        facilityId: null,
        target: { kind: 'capability', id: 'list-facilities' },
        requestId: '00000000-0000-4000-8000-000000000533',
        reasonCode: null,
        occurredAt: OCCURRED_AT,
      });
    };

    const result = await runSecurityAuditVerificationJob({
      service: new SecurityAuditService(repository),
      requestId: '00000000-0000-4000-8000-000000000534',
    });

    expect(result).toEqual({ valid: true, verifiedThroughSequence: 3 });
    expect(concurrentEntry).toMatchObject({ sequence: 4 });
    expect(repository.verificationSessionReadCallsAtAppend).toBe(1);
    expect(repository.entries.at(-1)).toMatchObject({
      sequence: 5,
      previousHash: concurrentEntry?.entryHash,
      action: 'verify-security-audit-chain',
      outcome: 'success',
    });
  });

  test('keeps an empty captured boundary stable across a concurrent genesis append', async () => {
    const repository = new MemoryAuditRepository();
    let genesisEntry: SecurityAuditEntry | undefined;
    repository.onVerificationAppend = async () => {
      genesisEntry = await repository.append({
        category: 'agent-access',
        action: 'list-facilities',
        actionIds: [],
        confirmationId: null,
        outcome: 'success',
        principal: { kind: 'system', serviceId: 'concurrent-genesis-writer' },
        source: 'scheduled-job',
        facilityId: null,
        target: { kind: 'capability', id: 'list-facilities' },
        requestId: '00000000-0000-4000-8000-000000000535',
        reasonCode: null,
        occurredAt: OCCURRED_AT,
      });
    };

    const result = await runSecurityAuditVerificationJob({
      service: new SecurityAuditService(repository),
      requestId: '00000000-0000-4000-8000-000000000536',
    });

    expect(result).toEqual({ valid: true, verifiedThroughSequence: 0 });
    expect(repository.readChainCalls).toBe(0);
    expect(genesisEntry).toMatchObject({ sequence: 1, previousHash: null });
    expect(repository.entries.at(-1)).toMatchObject({
      sequence: 2,
      previousHash: genesisEntry?.entryHash,
      action: 'verify-security-audit-chain',
      outcome: 'success',
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
    expect(repository.verificationSessionReadCallsAtAppend).toBe(2);
    expect(repository.entries.at(-1)).toMatchObject({
      sequence: 206,
      action: 'verify-security-audit-chain',
      outcome: 'success',
    });
  });
});
