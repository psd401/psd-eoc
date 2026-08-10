import {
  ActorSchema,
  AgentApiKeyRevocationSchema,
  AgentApiKeySchema,
  AgentApiKeySummarySchema,
  FacilityScopeSchema,
  IdempotencyKeySchema,
  TimestampSchema,
  type AgentApiKey,
  type AgentApiKeyRevocation,
  type AgentApiKeySummary,
  type FacilityScope,
} from '@psd-eoc/contracts';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  agentApiKeyFacilities,
  agentApiKeyGrants,
  agentApiKeyRevocations,
  agentApiKeys,
  agents,
  idempotencyRecords,
} from '../../db/schema';
import {
  AgentApiKeyRepositoryConflictError,
  AgentApiKeyRepositoryIdempotencyConflictError,
  AgentApiKeyRepositoryIntegrityError,
  type AgentApiKeyMutationIdempotency,
  type AgentApiKeyRepository,
  type AgentApiKeySummaryListQuery,
  type AgentApiKeySummaryListResult,
  type AppendAgentApiKeyRevocationResult,
  type PersistIssuedAgentApiKeyInput,
  type PersistIssuedAgentApiKeyResult,
} from './key-repository';

const ISSUE_RESULT_PREFIX = 'agent-api-key';
const REVOCATION_RESULT_PREFIX = 'agent-api-key-revocation';
const IDEMPOTENCY_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const verifierSelection = {
  id: agentApiKeys.id,
  agentId: agentApiKeys.agentId,
  displayName: agentApiKeys.displayName,
  facilityScopeKind: agentApiKeys.facilityScopeKind,
  keyPrefix: agentApiKeys.keyPrefix,
  credentialDigest: agentApiKeys.credentialDigest,
  issuedByUserId: agentApiKeys.issuedByUserId,
  issuedAt: agentApiKeys.issuedAt,
  expiresAt: agentApiKeys.expiresAt,
  revokedAt: agentApiKeys.revokedAt,
} as const;

const summarySelection = {
  id: agentApiKeys.id,
  agentId: agentApiKeys.agentId,
  displayName: agentApiKeys.displayName,
  facilityScopeKind: agentApiKeys.facilityScopeKind,
  keyPrefix: agentApiKeys.keyPrefix,
  issuedByUserId: agentApiKeys.issuedByUserId,
  issuedAt: agentApiKeys.issuedAt,
  expiresAt: agentApiKeys.expiresAt,
  revokedAt: agentApiKeys.revokedAt,
} as const;

const revocationSelection = {
  id: agentApiKeyRevocations.id,
  apiKeyId: agentApiKeyRevocations.apiKeyId,
  revokedByUserId: agentApiKeyRevocations.revokedByUserId,
  reasonCode: agentApiKeyRevocations.reasonCode,
  revokedAt: agentApiKeyRevocations.revokedAt,
} as const;

type VerifierRow = Pick<
  typeof agentApiKeys.$inferSelect,
  keyof typeof verifierSelection
>;
type SummaryRow = Pick<
  typeof agentApiKeys.$inferSelect,
  keyof typeof summarySelection
>;

interface RelatedRows {
  readonly facilitiesByKey: ReadonlyMap<string, readonly string[]>;
  readonly grantsByKey: ReadonlyMap<
    string,
    readonly (typeof agentApiKeyGrants.$inferSelect)['capabilityId'][]
  >;
  readonly revocationsByKey: ReadonlyMap<
    string,
    readonly (typeof agentApiKeyRevocations.$inferSelect)[]
  >;
}

function timestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function buildFacilityScope(
  kind: (typeof agentApiKeys.$inferSelect)['facilityScopeKind'],
  facilityIds: readonly string[],
): FacilityScope {
  if (kind === 'district') {
    if (facilityIds.length !== 0) {
      throw new AgentApiKeyRepositoryIntegrityError();
    }
    return FacilityScopeSchema.parse({ kind: 'district' });
  }
  return FacilityScopeSchema.parse({ kind: 'facilities', facilityIds });
}

function projectedRevokedAt(
  rowRevokedAt: Date | null,
  revocations: readonly (typeof agentApiKeyRevocations.$inferSelect)[],
): string | null {
  if (revocations.length > 1) {
    throw new AgentApiKeyRepositoryIntegrityError();
  }
  const revocation = revocations[0];
  if (revocation === undefined) {
    if (rowRevokedAt !== null) {
      throw new AgentApiKeyRepositoryIntegrityError();
    }
    return null;
  }
  if (
    rowRevokedAt === null ||
    rowRevokedAt.getTime() !== revocation.revokedAt.getTime()
  ) {
    throw new AgentApiKeyRepositoryIntegrityError();
  }
  return revocation.revokedAt.toISOString();
}

function rowToVerifier(row: VerifierRow, related: RelatedRows): AgentApiKey {
  return AgentApiKeySchema.parse({
    id: row.id,
    agentId: row.agentId,
    displayName: row.displayName,
    facilityScope: buildFacilityScope(
      row.facilityScopeKind,
      related.facilitiesByKey.get(row.id) ?? [],
    ),
    capabilityIds: related.grantsByKey.get(row.id) ?? [],
    keyPrefix: row.keyPrefix,
    credentialDigest: row.credentialDigest,
    issuedByUserId: row.issuedByUserId,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: timestamp(row.expiresAt),
    revokedAt: projectedRevokedAt(
      row.revokedAt,
      related.revocationsByKey.get(row.id) ?? [],
    ),
  });
}

function rowToSummary(
  row: SummaryRow,
  related: RelatedRows,
): AgentApiKeySummary {
  return AgentApiKeySummarySchema.parse({
    id: row.id,
    agentId: row.agentId,
    displayName: row.displayName,
    facilityScope: buildFacilityScope(
      row.facilityScopeKind,
      related.facilitiesByKey.get(row.id) ?? [],
    ),
    capabilityIds: related.grantsByKey.get(row.id) ?? [],
    keyPrefix: row.keyPrefix,
    issuedByUserId: row.issuedByUserId,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: timestamp(row.expiresAt),
    revokedAt: projectedRevokedAt(
      row.revokedAt,
      related.revocationsByKey.get(row.id) ?? [],
    ),
  });
}

function groupValues<Value>(
  rows: readonly Readonly<{ apiKeyId: string; value: Value }>[],
): ReadonlyMap<string, readonly Value[]> {
  const grouped = new Map<string, Value[]>();
  for (const row of rows) {
    const values = grouped.get(row.apiKeyId) ?? [];
    values.push(row.value);
    grouped.set(row.apiKeyId, values);
  }
  return grouped;
}

async function loadRelatedRows(
  database: Pick<Database, 'select'>,
  apiKeyIds: readonly string[],
): Promise<RelatedRows> {
  if (apiKeyIds.length === 0) {
    return Object.freeze({
      facilitiesByKey: new Map(),
      grantsByKey: new Map(),
      revocationsByKey: new Map(),
    });
  }
  const facilityRows = await database
    .select({
      apiKeyId: agentApiKeyFacilities.apiKeyId,
      value: agentApiKeyFacilities.facilityId,
    })
    .from(agentApiKeyFacilities)
    .where(inArray(agentApiKeyFacilities.apiKeyId, [...apiKeyIds]));
  const grantRows = await database
    .select({
      apiKeyId: agentApiKeyGrants.apiKeyId,
      value: agentApiKeyGrants.capabilityId,
    })
    .from(agentApiKeyGrants)
    .where(inArray(agentApiKeyGrants.apiKeyId, [...apiKeyIds]));
  const revocationRows = await database
    .select()
    .from(agentApiKeyRevocations)
    .where(inArray(agentApiKeyRevocations.apiKeyId, [...apiKeyIds]));
  const revocationsByKey = new Map<
    string,
    (typeof agentApiKeyRevocations.$inferSelect)[]
  >();
  for (const row of revocationRows) {
    const values = revocationsByKey.get(row.apiKeyId) ?? [];
    values.push(row);
    revocationsByKey.set(row.apiKeyId, values);
  }
  return Object.freeze({
    facilitiesByKey: groupValues(facilityRows),
    grantsByKey: groupValues(grantRows),
    revocationsByKey,
  });
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) return false;
    if (Reflect.get(candidate, 'code') === code) return true;
    candidate = Reflect.get(candidate, 'cause');
  }
  return false;
}

function parseIdempotency(
  value: AgentApiKeyMutationIdempotency,
  capabilityId: AgentApiKeyMutationIdempotency['capabilityId'],
): AgentApiKeyMutationIdempotency {
  const actor = ActorSchema.parse(value.actor);
  if (
    value.capabilityId !== capabilityId ||
    actor.kind !== 'human' ||
    !IDEMPOTENCY_DIGEST_PATTERN.test(value.principalDigest) ||
    !IDEMPOTENCY_DIGEST_PATTERN.test(value.requestDigest)
  ) {
    throw new AgentApiKeyRepositoryIntegrityError();
  }
  return Object.freeze({
    capabilityId,
    actor,
    key: IdempotencyKeySchema.parse(value.key),
    principalDigest: value.principalDigest,
    requestDigest: value.requestDigest,
    createdAt: TimestampSchema.parse(value.createdAt),
  });
}

function sameHumanActor(
  value: unknown,
  expected: AgentApiKeyMutationIdempotency['actor'],
): boolean {
  const parsed = ActorSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.kind === 'human' &&
    parsed.data.userId === expected.userId &&
    parsed.data.sessionId === expected.sessionId
  );
}

function resultId(reference: string | null, prefix: string): string {
  const match = new RegExp(`^${prefix}:([0-9a-f-]{36})$`, 'u').exec(
    reference ?? '',
  );
  if (match?.[1] === undefined) {
    throw new AgentApiKeyRepositoryIntegrityError();
  }
  return match[1];
}

async function persistIssuedKey(
  database: Database,
  inputValue: PersistIssuedAgentApiKeyInput,
): Promise<PersistIssuedAgentApiKeyResult> {
  const key = AgentApiKeySchema.parse(inputValue.key);
  const idempotency = parseIdempotency(
    inputValue.idempotency,
    'issue-agent-api-key',
  );
  if (
    idempotency.actor.userId !== key.issuedByUserId ||
    idempotency.createdAt !== key.issuedAt
  ) {
    throw new AgentApiKeyRepositoryIntegrityError();
  }
  try {
    return await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${idempotency.capabilityId}:${idempotency.principalDigest}:${idempotency.key}`}, 4024))`,
      );
      const existingRows = await transaction
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, idempotency.capabilityId),
            eq(idempotencyRecords.principalDigest, idempotency.principalDigest),
            eq(idempotencyRecords.key, idempotency.key),
          ),
        )
        .limit(1)
        .for('share');
      const existing = existingRows[0];
      if (existing !== undefined) {
        if (
          existing.requestDigest !== idempotency.requestDigest ||
          existing.status !== 'completed' ||
          !sameHumanActor(existing.principal, idempotency.actor)
        ) {
          throw new AgentApiKeyRepositoryIdempotencyConflictError();
        }
        const replayedKeyId = resultId(
          existing.resultReference,
          ISSUE_RESULT_PREFIX,
        );
        const replayedRows = await transaction
          .select(verifierSelection)
          .from(agentApiKeys)
          .where(eq(agentApiKeys.id, replayedKeyId))
          .limit(1)
          .for('share');
        const replayedRow = replayedRows[0];
        if (replayedRow === undefined) {
          throw new AgentApiKeyRepositoryIntegrityError();
        }
        const related = await loadRelatedRows(transaction, [replayedRow.id]);
        return Object.freeze({
          kind: 'replayed' as const,
          key: rowToVerifier(replayedRow, related),
        });
      }

      const insertedIdempotency = await transaction
        .insert(idempotencyRecords)
        .values({
          key: idempotency.key,
          capabilityId: idempotency.capabilityId,
          principal: idempotency.actor,
          principalDigest: idempotency.principalDigest,
          requestDigest: idempotency.requestDigest,
          status: 'in-progress',
          createdAt: new Date(idempotency.createdAt),
        })
        .returning();
      const idempotencyId = insertedIdempotency[0]?.id;
      if (idempotencyId === undefined) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }

      if (inputValue.createAgent) {
        await transaction.insert(agents).values({
          id: key.agentId,
          displayName: key.displayName,
          createdAt: new Date(key.issuedAt),
        });
      } else {
        const existing = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, key.agentId))
          .limit(1)
          .for('share');
        if (existing.length === 0) {
          throw new AgentApiKeyRepositoryConflictError();
        }
      }

      await transaction.insert(agentApiKeys).values({
        id: key.id,
        agentId: key.agentId,
        displayName: key.displayName,
        facilityScopeKind: key.facilityScope.kind,
        keyPrefix: key.keyPrefix,
        credentialDigest: key.credentialDigest,
        issuedByUserId: key.issuedByUserId,
        issuedAt: new Date(key.issuedAt),
        expiresAt: key.expiresAt === null ? null : new Date(key.expiresAt),
        revokedAt: null,
      });
      if (key.facilityScope.kind === 'facilities') {
        await transaction.insert(agentApiKeyFacilities).values(
          key.facilityScope.facilityIds.map((facilityId) => ({
            apiKeyId: key.id,
            facilityId,
          })),
        );
      }
      await transaction.insert(agentApiKeyGrants).values(
        key.capabilityIds.map((capabilityId) => ({
          apiKeyId: key.id,
          capabilityId,
        })),
      );
      const completed = await transaction
        .update(idempotencyRecords)
        .set({
          status: 'completed',
          completedAt: new Date(key.issuedAt),
          resultReference: `${ISSUE_RESULT_PREFIX}:${key.id}`,
        })
        .where(
          and(
            eq(idempotencyRecords.id, idempotencyId),
            eq(idempotencyRecords.status, 'in-progress'),
          ),
        )
        .returning();
      if (completed.length !== 1) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }
      return Object.freeze({ kind: 'issued' as const, key });
    });
  } catch (error) {
    if (
      error instanceof AgentApiKeyRepositoryConflictError ||
      error instanceof AgentApiKeyRepositoryIdempotencyConflictError ||
      hasPostgresCode(error, '23503') ||
      hasPostgresCode(error, '23505')
    ) {
      if (error instanceof AgentApiKeyRepositoryIdempotencyConflictError) {
        throw error;
      }
      throw new AgentApiKeyRepositoryConflictError();
    }
    throw error;
  }
}

async function findVerifierByPrefix(
  database: Database,
  keyPrefix: string,
): Promise<AgentApiKey | null> {
  if (!/^[A-Za-z0-9_-]{8,24}$/u.test(keyPrefix)) return null;
  return database.transaction(
    async (transaction) => {
      const rows = await transaction
        .select(verifierSelection)
        .from(agentApiKeys)
        .where(eq(agentApiKeys.keyPrefix, keyPrefix))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      const related = await loadRelatedRows(transaction, [row.id]);
      return rowToVerifier(row, related);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function appendRevocation(
  database: Database,
  inputValue: Readonly<{
    revocation: AgentApiKeyRevocation;
    idempotency: AgentApiKeyMutationIdempotency;
  }>,
): Promise<AppendAgentApiKeyRevocationResult> {
  const revocation = AgentApiKeyRevocationSchema.parse(inputValue.revocation);
  const idempotency = parseIdempotency(
    inputValue.idempotency,
    'revoke-agent-api-key',
  );
  if (
    idempotency.actor.userId !== revocation.revokedByUserId ||
    idempotency.createdAt !== revocation.revokedAt
  ) {
    throw new AgentApiKeyRepositoryIntegrityError();
  }
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${idempotency.capabilityId}:${idempotency.principalDigest}:${idempotency.key}`}, 4024))`,
    );
    const existingIdempotencyRows = await transaction
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.capabilityId, idempotency.capabilityId),
          eq(idempotencyRecords.principalDigest, idempotency.principalDigest),
          eq(idempotencyRecords.key, idempotency.key),
        ),
      )
      .limit(1)
      .for('share');
    const existingIdempotency = existingIdempotencyRows[0];
    if (existingIdempotency !== undefined) {
      if (
        existingIdempotency.requestDigest !== idempotency.requestDigest ||
        existingIdempotency.status !== 'completed' ||
        !sameHumanActor(existingIdempotency.principal, idempotency.actor)
      ) {
        throw new AgentApiKeyRepositoryIdempotencyConflictError();
      }
      const replayedRevocationId = resultId(
        existingIdempotency.resultReference,
        REVOCATION_RESULT_PREFIX,
      );
      const replayedRows = await transaction
        .select(revocationSelection)
        .from(agentApiKeyRevocations)
        .where(eq(agentApiKeyRevocations.id, replayedRevocationId))
        .limit(1)
        .for('share');
      const replayed = replayedRows[0];
      if (replayed === undefined) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }
      return Object.freeze({
        kind: 'replayed' as const,
        revocation: AgentApiKeyRevocationSchema.parse({
          ...replayed,
          revokedAt: replayed.revokedAt.toISOString(),
        }),
      });
    }

    const keyRows = await transaction
      .select({ id: agentApiKeys.id, revokedAt: agentApiKeys.revokedAt })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, revocation.apiKeyId))
      .limit(1)
      .for('update');
    const key = keyRows[0];
    if (key === undefined) return Object.freeze({ kind: 'not-found' as const });

    const existingRows = await transaction
      .select()
      .from(agentApiKeyRevocations)
      .where(eq(agentApiKeyRevocations.apiKeyId, revocation.apiKeyId))
      .limit(1)
      .for('share');
    const existing = existingRows[0];
    if (key.revokedAt !== null || existing !== undefined) {
      if (
        key.revokedAt === null ||
        existing === undefined ||
        key.revokedAt.getTime() !== existing.revokedAt.getTime()
      ) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }
      return Object.freeze({ kind: 'already-revoked' as const });
    }

    const insertedIdempotency = await transaction
      .insert(idempotencyRecords)
      .values({
        key: idempotency.key,
        capabilityId: idempotency.capabilityId,
        principal: idempotency.actor,
        principalDigest: idempotency.principalDigest,
        requestDigest: idempotency.requestDigest,
        status: 'in-progress',
        createdAt: new Date(idempotency.createdAt),
      })
      .returning();
    const idempotencyId = insertedIdempotency[0]?.id;
    if (idempotencyId === undefined) {
      throw new AgentApiKeyRepositoryIntegrityError();
    }

    await transaction.insert(agentApiKeyRevocations).values({
      id: revocation.id,
      apiKeyId: revocation.apiKeyId,
      revokedByUserId: revocation.revokedByUserId,
      reasonCode: revocation.reasonCode,
      revokedAt: new Date(revocation.revokedAt),
    });
    await transaction
      .update(agentApiKeys)
      .set({ revokedAt: new Date(revocation.revokedAt) })
      .where(
        and(
          eq(agentApiKeys.id, revocation.apiKeyId),
          isNull(agentApiKeys.revokedAt),
        ),
      );
    const completed = await transaction
      .update(idempotencyRecords)
      .set({
        status: 'completed',
        completedAt: new Date(revocation.revokedAt),
        resultReference: `${REVOCATION_RESULT_PREFIX}:${revocation.id}`,
      })
      .where(
        and(
          eq(idempotencyRecords.id, idempotencyId),
          eq(idempotencyRecords.status, 'in-progress'),
        ),
      )
      .returning();
    if (completed.length !== 1) {
      throw new AgentApiKeyRepositoryIntegrityError();
    }
    return Object.freeze({ kind: 'appended' as const, revocation });
  });
}

function listConditions(query: AgentApiKeySummaryListQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.agentId !== null) {
    conditions.push(eq(agentApiKeys.agentId, query.agentId));
  }
  if (!query.includeRevoked) {
    conditions.push(
      isNull(agentApiKeys.revokedAt),
      isNull(agentApiKeyRevocations.id),
    );
  }
  if (query.before !== null) {
    const issuedAt = new Date(query.before.issuedAt);
    const keyset = or(
      lt(agentApiKeys.issuedAt, issuedAt),
      and(
        eq(agentApiKeys.issuedAt, issuedAt),
        lt(agentApiKeys.id, query.before.id),
      ),
    );
    if (keyset !== undefined) conditions.push(keyset);
  }
  return conditions;
}

async function listSummaries(
  database: Database,
  query: AgentApiKeySummaryListQuery,
): Promise<AgentApiKeySummaryListResult> {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 200
  ) {
    throw new AgentApiKeyRepositoryIntegrityError();
  }
  return database.transaction(
    async (transaction) => {
      const conditions = listConditions(query);
      const rows = await transaction
        .select(summarySelection)
        .from(agentApiKeys)
        .leftJoin(
          agentApiKeyRevocations,
          eq(agentApiKeyRevocations.apiKeyId, agentApiKeys.id),
        )
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(agentApiKeys.issuedAt), desc(agentApiKeys.id))
        .limit(query.limit + 1);
      const hasMore = rows.length > query.limit;
      const visibleRows = rows.slice(0, query.limit);
      const related = await loadRelatedRows(
        transaction,
        visibleRows.map((row) => row.id),
      );
      return Object.freeze({
        items: Object.freeze(
          visibleRows.map((row) => rowToSummary(row, related)),
        ),
        hasMore,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Creates the PostgreSQL/Aurora adapter for the scoped key lifecycle. */
export function createDrizzleAgentApiKeyRepository(
  database: Database,
): AgentApiKeyRepository {
  const repository: AgentApiKeyRepository = {
    persistIssuedKey: (input) => persistIssuedKey(database, input),
    findVerifierByPrefix: (keyPrefix) =>
      findVerifierByPrefix(database, keyPrefix),
    appendRevocation: (input) => appendRevocation(database, input),
    listSummaries: (query) => listSummaries(database, query),
  };
  return Object.freeze(repository);
}
