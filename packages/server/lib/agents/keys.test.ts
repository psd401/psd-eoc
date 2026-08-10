import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  AgentApiKeyRevocationSchema,
  AgentApiKeySchema,
  AgentApiKeySummarySchema,
  HUMAN_ONLY_ACTION_IDS,
  type AgentApiKey,
  type AgentApiKeyRevocation,
  type AgentApiKeySummary,
  type IssueAgentApiKeyInput,
} from '@psd-eoc/contracts';

import {
  AgentApiKeyRepositoryConflictError,
  AgentApiKeyRepositoryIdempotencyConflictError,
  type AgentApiKeyRepository,
  type AgentApiKeySummaryListQuery,
  type AgentApiKeySummaryListResult,
  type AppendAgentApiKeyRevocationResult,
  type PersistIssuedAgentApiKeyInput,
  type PersistIssuedAgentApiKeyResult,
} from './key-repository';
import {
  AGENT_API_KEY_CREDENTIAL_MARKER,
  AgentApiKeyIssuanceReplayError,
  AgentApiKeyService,
  digestAgentApiKeyAuditSubject,
  digestAgentApiKeyCredential,
  type AgentApiKeyError,
} from './keys';

const IDS = {
  issuer: '00000000-0000-4000-8000-000000000001',
  revoker: '00000000-0000-4000-8000-000000000002',
  issuerSession: '00000000-0000-4000-8000-000000000004',
  revokerSession: '00000000-0000-4000-8000-000000000005',
  existingAgent: '00000000-0000-4000-8000-000000000003',
  facilityA: '00000000-0000-4000-8000-000000000101',
  facilityB: '00000000-0000-4000-8000-000000000102',
  missingKey: '00000000-0000-4000-8000-000000000201',
} as const;

function mutation(userId: string, idempotencyKey = randomUUID()) {
  return {
    actor: {
      kind: 'human' as const,
      userId,
      sessionId: userId === IDS.issuer ? IDS.issuerSession : IDS.revokerSession,
    },
    idempotencyKey,
  };
}

function summary(key: AgentApiKey): AgentApiKeySummary {
  return AgentApiKeySummarySchema.parse({
    id: key.id,
    agentId: key.agentId,
    displayName: key.displayName,
    facilityScope: key.facilityScope,
    capabilityIds: key.capabilityIds,
    keyPrefix: key.keyPrefix,
    issuedByUserId: key.issuedByUserId,
    issuedAt: key.issuedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  });
}

class InMemoryAgentApiKeyRepository implements AgentApiKeyRepository {
  public readonly agents = new Set<string>();
  public readonly keys = new Map<string, AgentApiKey>();
  public readonly revocationHistory: AgentApiKeyRevocation[] = [];
  public lastPersistInput: PersistIssuedAgentApiKeyInput | null = null;
  private readonly idempotency = new Map<
    string,
    Readonly<{ requestDigest: string; resultId: string }>
  >();

  private idempotencyScope(
    input: PersistIssuedAgentApiKeyInput['idempotency'],
  ): string {
    return `${input.capabilityId}:${input.principalDigest}:${input.key}`;
  }

  public seedAgent(agentId: string): void {
    this.agents.add(agentId);
  }

  public async persistIssuedKey(
    input: PersistIssuedAgentApiKeyInput,
  ): Promise<PersistIssuedAgentApiKeyResult> {
    const key = AgentApiKeySchema.parse(input.key);
    this.lastPersistInput = input;
    const scope = this.idempotencyScope(input.idempotency);
    const existingIdempotency = this.idempotency.get(scope);
    if (existingIdempotency !== undefined) {
      if (
        existingIdempotency.requestDigest !== input.idempotency.requestDigest
      ) {
        throw new AgentApiKeyRepositoryIdempotencyConflictError();
      }
      const existing = this.keys.get(existingIdempotency.resultId);
      if (existing === undefined) throw new TypeError('Missing replay key.');
      return Object.freeze({ kind: 'replayed', key: existing });
    }
    if (
      this.keys.has(key.id) ||
      [...this.keys.values()].some(
        (candidate) =>
          candidate.keyPrefix === key.keyPrefix ||
          candidate.credentialDigest === key.credentialDigest,
      ) ||
      (input.createAgent
        ? this.agents.has(key.agentId)
        : !this.agents.has(key.agentId))
    ) {
      throw new AgentApiKeyRepositoryConflictError();
    }
    if (input.createAgent) this.agents.add(key.agentId);
    this.keys.set(key.id, key);
    this.idempotency.set(scope, {
      requestDigest: input.idempotency.requestDigest,
      resultId: key.id,
    });
    return Object.freeze({ kind: 'issued', key });
  }

  public async findVerifierByPrefix(
    keyPrefix: string,
  ): Promise<AgentApiKey | null> {
    return (
      [...this.keys.values()].find((key) => key.keyPrefix === keyPrefix) ?? null
    );
  }

  public async appendRevocation(
    input: Parameters<AgentApiKeyRepository['appendRevocation']>[0],
  ): Promise<AppendAgentApiKeyRevocationResult> {
    const revocation = AgentApiKeyRevocationSchema.parse(input.revocation);
    const scope = this.idempotencyScope(input.idempotency);
    const existingIdempotency = this.idempotency.get(scope);
    if (existingIdempotency !== undefined) {
      if (
        existingIdempotency.requestDigest !== input.idempotency.requestDigest
      ) {
        throw new AgentApiKeyRepositoryIdempotencyConflictError();
      }
      const existing = this.revocationHistory.find(
        (candidate) => candidate.id === existingIdempotency.resultId,
      );
      if (existing === undefined)
        throw new TypeError('Missing replay revocation.');
      return Object.freeze({ kind: 'replayed', revocation: existing });
    }
    const key = this.keys.get(revocation.apiKeyId);
    if (key === undefined) return Object.freeze({ kind: 'not-found' });
    if (key.revokedAt !== null) {
      return Object.freeze({ kind: 'already-revoked' });
    }
    this.revocationHistory.push(revocation);
    this.keys.set(
      key.id,
      AgentApiKeySchema.parse({ ...key, revokedAt: revocation.revokedAt }),
    );
    this.idempotency.set(scope, {
      requestDigest: input.idempotency.requestDigest,
      resultId: revocation.id,
    });
    return Object.freeze({ kind: 'appended', revocation });
  }

  public async listSummaries(
    query: AgentApiKeySummaryListQuery,
  ): Promise<AgentApiKeySummaryListResult> {
    const ordered = [...this.keys.values()]
      .filter(
        (key) =>
          (query.agentId === null || key.agentId === query.agentId) &&
          (query.includeRevoked || key.revokedAt === null),
      )
      .filter((key) => {
        if (query.before === null) return true;
        const timeDifference =
          Date.parse(key.issuedAt) - Date.parse(query.before.issuedAt);
        return (
          timeDifference < 0 ||
          (timeDifference === 0 && key.id < query.before.id)
        );
      })
      .sort((left, right) => {
        const timeDifference =
          Date.parse(right.issuedAt) - Date.parse(left.issuedAt);
        return timeDifference === 0
          ? right.id.localeCompare(left.id)
          : timeDifference;
      });
    return Object.freeze({
      items: Object.freeze(ordered.slice(0, query.limit).map(summary)),
      hasMore: ordered.length > query.limit,
    });
  }
}

function issueInput(
  overrides: Partial<IssueAgentApiKeyInput> = {},
): IssueAgentApiKeyInput {
  return {
    agentId: null,
    displayName: 'District reporting agent',
    facilityScope: {
      kind: 'facilities',
      facilityIds: [IDS.facilityA, IDS.facilityB],
    },
    capabilityIds: [
      'prepare-activation',
      'list-active-events',
      'run-delivery-report',
    ],
    expiresInSeconds: 3_600,
    ...overrides,
  };
}

function errorWith(code: AgentApiKeyError['code'], status: number) {
  return expect.objectContaining({
    name: 'AgentApiKeyError',
    code,
    status,
  });
}

describe('AgentApiKeyService', () => {
  test('issues a one-time high-entropy credential and persists only its digest', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    const now = new Date('2026-08-10T18:00:00.000Z');
    const service = new AgentApiKeyService({ repository, now: () => now });

    const issuance = await service.issue(
      issueInput(),
      IDS.issuer,
      mutation(IDS.issuer),
    );

    expect(issuance.oneTimeCredential).toMatch(
      /^psd_eoc_agent_v1_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/u,
    );
    expect(
      issuance.oneTimeCredential.startsWith(AGENT_API_KEY_CREDENTIAL_MARKER),
    ).toBe(true);
    expect('credentialDigest' in issuance.key).toBe(false);
    expect(issuance.key.issuedAt).toBe(now.toISOString());
    expect(issuance.key.expiresAt).toBe('2026-08-10T19:00:00.000Z');
    expect(repository.agents.has(issuance.key.agentId)).toBe(true);
    expect(repository.lastPersistInput?.createAgent).toBe(true);

    const persisted = repository.keys.get(issuance.key.id);
    expect(persisted?.credentialDigest).toBe(
      digestAgentApiKeyCredential(issuance.oneTimeCredential),
    );
    expect(persisted?.credentialDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(repository.lastPersistInput)).not.toContain(
      issuance.oneTimeCredential,
    );
  });

  test('reuses a stable agent identity while issuing an independently scoped key', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    repository.seedAgent(IDS.existingAgent);
    const service = new AgentApiKeyService({
      repository,
      now: () => new Date('2026-08-10T18:00:00.000Z'),
    });

    const issuance = await service.issue(
      issueInput({
        agentId: IDS.existingAgent,
        facilityScope: { kind: 'district' },
        capabilityIds: ['list-facilities'],
        expiresInSeconds: null,
      }),
      IDS.issuer,
      mutation(IDS.issuer),
    );

    expect(issuance.key.agentId).toBe(IDS.existingAgent);
    expect(issuance.key.facilityScope).toEqual({ kind: 'district' });
    expect(issuance.key.capabilityIds).toEqual(['list-facilities']);
    expect(issuance.key.expiresAt).toBeNull();
    expect(repository.lastPersistInput?.createAgent).toBe(false);
  });

  test('authenticates to the canonical actor and exact facility/capability scope', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    const service = new AgentApiKeyService({
      repository,
      now: () => new Date('2026-08-10T18:00:00.000Z'),
    });
    const issuance = await service.issue(
      issueInput(),
      IDS.issuer,
      mutation(IDS.issuer),
    );

    const authenticated = await service.authenticate(
      issuance.oneTimeCredential,
    );

    expect(authenticated.actor).toEqual({
      kind: 'agent',
      agentId: issuance.key.agentId,
      apiKeyId: issuance.key.id,
    });
    expect(authenticated.scope).toEqual({
      facilityScope: {
        kind: 'facilities',
        facilityIds: [IDS.facilityA, IDS.facilityB],
      },
    });
    expect(authenticated.capabilityIds).toEqual(issueInput().capabilityIds);
    expect('credentialDigest' in authenticated.key).toBe(false);
    expect(
      service.authorizeCapability(authenticated, 'prepare-activation'),
    ).toBe('prepare-activation');
  });

  test('uses one indistinguishable 401 for malformed, unknown, and mismatched credentials', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    const service = new AgentApiKeyService({
      repository,
      now: () => new Date('2026-08-10T18:00:00.000Z'),
    });
    const issuance = await service.issue(
      issueInput(),
      IDS.issuer,
      mutation(IDS.issuer),
    );
    const last = issuance.oneTimeCredential.at(-1);
    const wrongSecret = `${issuance.oneTimeCredential.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    const unknownPrefix = issuance.oneTimeCredential.replace(
      issuance.key.keyPrefix,
      'AAAAAAAAAAAA',
    );

    for (const credential of [
      '',
      'not-a-key',
      unknownPrefix,
      wrongSecret,
      `${issuance.oneTimeCredential}extra`,
    ]) {
      await expect(service.authenticate(credential)).rejects.toEqual(
        errorWith('INVALID_CREDENTIAL', 401),
      );
    }
  });

  test('derives audit correlation from the public prefix without hashing the bearer', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    const service = new AgentApiKeyService({
      repository,
      now: () => new Date('2026-08-10T18:00:00.000Z'),
    });
    const issuance = await service.issue(
      issueInput(),
      IDS.issuer,
      mutation(IDS.issuer),
    );
    const replacement = issuance.oneTimeCredential.endsWith('A') ? 'B' : 'A';
    const wrongSecret = `${issuance.oneTimeCredential.slice(0, -1)}${replacement}`;
    const subjectDigest = digestAgentApiKeyAuditSubject(
      issuance.oneTimeCredential,
    );

    expect(subjectDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestAgentApiKeyAuditSubject(wrongSecret)).toBe(subjectDigest);
    expect(subjectDigest).not.toBe(
      digestAgentApiKeyCredential(issuance.oneTimeCredential),
    );
    expect(digestAgentApiKeyAuditSubject('not-a-key')).toBeNull();
    expect(JSON.stringify({ subjectDigest })).not.toContain(
      issuance.oneTimeCredential,
    );
  });

  test('fails closed at the exact expiry boundary', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    let now = new Date('2026-08-10T18:00:00.000Z');
    const service = new AgentApiKeyService({ repository, now: () => now });
    const issuance = await service.issue(
      issueInput({ expiresInSeconds: 60 }),
      IDS.issuer,
      mutation(IDS.issuer),
    );

    now = new Date('2026-08-10T18:00:59.999Z');
    await expect(
      service.authenticate(issuance.oneTimeCredential),
    ).resolves.toBeDefined();
    now = new Date('2026-08-10T18:01:00.000Z');
    await expect(
      service.authenticate(issuance.oneTimeCredential),
    ).rejects.toEqual(errorWith('INVALID_CREDENTIAL', 401));
  });

  test('appends one revocation fact, updates the projection, and immediately denies the key', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    let now = new Date('2026-08-10T18:00:00.000Z');
    const service = new AgentApiKeyService({ repository, now: () => now });
    const issuance = await service.issue(
      issueInput(),
      IDS.issuer,
      mutation(IDS.issuer),
    );
    now = new Date('2026-08-10T18:05:00.000Z');
    const replayProtection = mutation(
      IDS.revoker,
      'revoke-agent-key:revocation-replay-test',
    );

    const revocation = await service.revoke(
      { apiKeyId: issuance.key.id, reasonCode: 'ADMIN_REVOKED' },
      IDS.revoker,
      replayProtection,
    );
    const replayedRevocation = await service.revoke(
      { apiKeyId: issuance.key.id, reasonCode: 'ADMIN_REVOKED' },
      IDS.revoker,
      replayProtection,
    );

    expect(revocation).toMatchObject({
      apiKeyId: issuance.key.id,
      revokedByUserId: IDS.revoker,
      reasonCode: 'ADMIN_REVOKED',
      revokedAt: now.toISOString(),
    });
    expect(repository.revocationHistory).toEqual([revocation]);
    expect(replayedRevocation).toEqual(revocation);
    expect(repository.keys.get(issuance.key.id)?.revokedAt).toBe(
      now.toISOString(),
    );
    await expect(
      service.authenticate(issuance.oneTimeCredential),
    ).rejects.toEqual(errorWith('INVALID_CREDENTIAL', 401));
    await expect(
      service.revoke(
        { apiKeyId: issuance.key.id, reasonCode: 'ADMIN_REVOKED_AGAIN' },
        IDS.revoker,
        mutation(IDS.revoker),
      ),
    ).rejects.toEqual(errorWith('KEY_ALREADY_REVOKED', 409));
    expect(repository.revocationHistory).toHaveLength(1);
  });

  test('returns a safe not-found error without fabricating revocation history', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    const service = new AgentApiKeyService({ repository });

    await expect(
      service.revoke(
        { apiKeyId: IDS.missingKey, reasonCode: 'ADMIN_REVOKED' },
        IDS.revoker,
        mutation(IDS.revoker),
      ),
    ).rejects.toEqual(errorWith('KEY_NOT_FOUND', 404));
    expect(repository.revocationHistory).toEqual([]);
  });

  test('rejects ungranted capabilities and every canonical human-only action with 403', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    const service = new AgentApiKeyService({ repository });
    const issuance = await service.issue(
      issueInput({ capabilityIds: ['prepare-activation'] }),
      IDS.issuer,
      mutation(IDS.issuer),
    );
    const authenticated = await service.authenticate(
      issuance.oneTimeCredential,
    );

    expect(() =>
      service.authorizeCapability(authenticated, 'list-active-events'),
    ).toThrow(errorWith('CAPABILITY_NOT_GRANTED', 403));
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(() =>
        service.authorizeCapability(authenticated, actionId),
      ).toThrow(errorWith('CAPABILITY_NOT_GRANTED', 403));
    }
  });

  test('lists digest-free summaries with filter-bound stable pagination', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    let now = new Date('2026-08-10T18:00:00.000Z');
    const service = new AgentApiKeyService({ repository, now: () => now });
    const first = await service.issue(
      issueInput(),
      IDS.issuer,
      mutation(IDS.issuer),
    );
    now = new Date('2026-08-10T18:01:00.000Z');
    const second = await service.issue(
      issueInput({ agentId: first.key.agentId, displayName: 'Second key' }),
      IDS.issuer,
      mutation(IDS.issuer),
    );
    now = new Date('2026-08-10T18:02:00.000Z');
    const third = await service.issue(
      issueInput({ displayName: 'Separate agent' }),
      IDS.issuer,
      mutation(IDS.issuer),
    );
    now = new Date('2026-08-10T18:03:00.000Z');
    await service.revoke(
      { apiKeyId: third.key.id, reasonCode: 'ADMIN_REVOKED' },
      IDS.revoker,
      mutation(IDS.revoker),
    );

    const pageOne = await service.list({
      agentId: null,
      includeRevoked: false,
      cursor: null,
      limit: 1,
    });
    expect(pageOne.items.map((item) => item.id)).toEqual([second.key.id]);
    expect(pageOne.pageInfo.hasMore).toBe(true);
    expect(pageOne.pageInfo.nextCursor).not.toBeNull();
    expect('credentialDigest' in pageOne.items[0]!).toBe(false);

    const pageTwo = await service.list({
      agentId: null,
      includeRevoked: false,
      cursor: pageOne.pageInfo.nextCursor,
      limit: 1,
    });
    expect(pageTwo.items.map((item) => item.id)).toEqual([first.key.id]);
    expect(pageTwo.pageInfo).toEqual({ hasMore: false, nextCursor: null });

    await expect(
      service.list({
        agentId: null,
        includeRevoked: true,
        cursor: pageOne.pageInfo.nextCursor,
        limit: 1,
      }),
    ).rejects.toEqual(errorWith('INVALID_CURSOR', 400));

    const revokedAgentKeys = await service.list({
      agentId: third.key.agentId,
      includeRevoked: true,
      cursor: null,
      limit: 20,
    });
    expect(revokedAgentKeys.items).toEqual([
      expect.objectContaining({
        id: third.key.id,
        revokedAt: now.toISOString(),
      }),
    ]);
  });

  test('maps repository conflicts to a bounded credential-free error', async () => {
    const repository: AgentApiKeyRepository = {
      persistIssuedKey: async () => {
        throw new AgentApiKeyRepositoryConflictError();
      },
      findVerifierByPrefix: async () => null,
      appendRevocation: async () => ({ kind: 'not-found' }),
      listSummaries: async () => ({ items: [], hasMore: false }),
    };
    const service = new AgentApiKeyService({ repository });

    await expect(
      service.issue(issueInput(), IDS.issuer, mutation(IDS.issuer)),
    ).rejects.toEqual(errorWith('PERSISTENCE_CONFLICT', 409));
  });

  test('persists at-most-once issuance without storing or re-emitting plaintext on replay', async () => {
    const repository = new InMemoryAgentApiKeyRepository();
    const service = new AgentApiKeyService({
      repository,
      now: () => new Date('2026-08-10T18:00:00.000Z'),
    });
    const replayProtection = mutation(
      IDS.issuer,
      'issue-agent-key:lost-response-replay-test',
    );

    const issuance = await service.issue(
      issueInput(),
      IDS.issuer,
      replayProtection,
    );
    let replayError: unknown;
    try {
      await service.issue(issueInput(), IDS.issuer, replayProtection);
    } catch (error) {
      replayError = error;
    }

    expect(replayError).toBeInstanceOf(AgentApiKeyIssuanceReplayError);
    expect(replayError).toMatchObject({
      code: 'ISSUANCE_ALREADY_COMMITTED',
      status: 409,
      key: { id: issuance.key.id, keyPrefix: issuance.key.keyPrefix },
    });
    expect(JSON.stringify(replayError)).not.toContain(
      issuance.oneTimeCredential,
    );
    expect(repository.keys.size).toBe(1);

    await expect(
      service.issue(
        issueInput({ displayName: 'Different request' }),
        IDS.issuer,
        replayProtection,
      ),
    ).rejects.toEqual(errorWith('IDEMPOTENCY_CONFLICT', 409));
    expect(repository.keys.size).toBe(1);
  });
});
