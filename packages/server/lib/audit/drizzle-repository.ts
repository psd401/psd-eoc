import {
  FacilityScopeSchema,
  SecurityAuditEntrySchema,
  SecurityAuditHashSchema,
  SecurityAuditPageSchema,
  SecurityAuditQuerySchema,
  type FacilityScope,
  type SecurityAuditEntry,
  type SecurityAuditPage,
  type SecurityAuditPrincipalFilter,
  type SecurityAuditQuery,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  gt,
  inArray,
  lt,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../../db/client';
import { securityAuditEntries } from '../../db/schema';
import { ACCESS_GATE_AUDIT_LOCK_SQL } from '../auth/access-gate';
import {
  calculateCanonicalSecurityAuditDigest,
  canonicalSecurityAuditJson,
} from './canonical';
import { buildSecurityAuditEntry } from './entry';
import {
  parseSecurityAuditFact,
  securityAuditFactFromEntry,
  type SecurityAuditFact,
} from './model';
import {
  SecurityAuditCursorError,
  SecurityAuditRequestConflictError,
  SecurityAuditScopeError,
  type SecurityAuditChainPage,
  type SecurityAuditChainPageInput,
  type SecurityAuditRepository,
} from './repository';

/** Same PostgreSQL transaction lock used by the existing sign-in writer. */
export const SECURITY_AUDIT_APPEND_LOCK_SQL = ACCESS_GATE_AUDIT_LOCK_SQL;

const AuditCursorSchema = z
  .object({
    version: z.literal(1),
    beforeSequence: z.number().int().positive(),
    queryFingerprint: SecurityAuditHashSchema,
  })
  .strict();

const rowSelection = {
  id: securityAuditEntries.id,
  sequence: securityAuditEntries.sequence,
  previousHash: securityAuditEntries.previousHash,
  entryHash: securityAuditEntries.entryHash,
  category: securityAuditEntries.category,
  action: securityAuditEntries.action,
  actionIds: securityAuditEntries.actionIds,
  confirmationId: securityAuditEntries.confirmationId,
  outcome: securityAuditEntries.outcome,
  principalKind: securityAuditEntries.principalKind,
  principal: securityAuditEntries.principal,
  source: securityAuditEntries.source,
  facilityId: securityAuditEntries.facilityId,
  targetKind: securityAuditEntries.targetKind,
  targetId: securityAuditEntries.targetId,
  requestId: securityAuditEntries.requestId,
  reasonCode: securityAuditEntries.reasonCode,
  occurredAt: securityAuditEntries.occurredAt,
} as const;

type SecurityAuditRow = typeof securityAuditEntries.$inferSelect;

function rowToEntry(row: SecurityAuditRow): SecurityAuditEntry {
  if (
    typeof row.principal !== 'object' ||
    row.principal === null ||
    row.principalKind !== Reflect.get(row.principal, 'kind')
  ) {
    throw new TypeError('Security audit principal columns disagree.');
  }
  if ((row.targetKind === null) !== (row.targetId === null)) {
    throw new TypeError('Security audit target columns disagree.');
  }

  const entry = SecurityAuditEntrySchema.parse({
    id: row.id,
    sequence: row.sequence,
    previousHash: row.previousHash,
    entryHash: row.entryHash,
    category: row.category,
    action: row.action,
    actionIds: row.actionIds,
    confirmationId: row.confirmationId,
    outcome: row.outcome,
    principal: row.principal,
    source: row.source,
    facilityId: row.facilityId,
    target:
      row.targetKind === null || row.targetId === null
        ? null
        : { kind: row.targetKind, id: row.targetId },
    requestId: row.requestId,
    reasonCode: row.reasonCode,
    occurredAt: row.occurredAt.toISOString(),
  });
  parseSecurityAuditFact(securityAuditFactFromEntry(entry));
  return entry;
}

function rowToVerificationCandidate(row: SecurityAuditRow): unknown {
  const principalKind =
    typeof row.principal === 'object' && row.principal !== null
      ? Reflect.get(row.principal, 'kind')
      : undefined;
  const targetPairValid = (row.targetKind === null) === (row.targetId === null);
  const candidate = {
    id: row.id,
    sequence: row.sequence,
    previousHash: row.previousHash,
    entryHash: row.entryHash,
    category: row.category,
    action: row.action,
    actionIds: row.actionIds,
    confirmationId: row.confirmationId,
    outcome: row.outcome,
    principal: row.principal,
    source: row.source,
    facilityId: row.facilityId,
    target:
      row.targetKind === null || row.targetId === null
        ? null
        : { kind: row.targetKind, id: row.targetId },
    requestId: row.requestId,
    reasonCode: row.reasonCode,
    occurredAt: row.occurredAt.toISOString(),
  };
  if (principalKind !== row.principalKind || !targetPairValid) {
    return {
      ...candidate,
      persistedPrincipalKind: row.principalKind,
      persistedTargetKind: row.targetKind,
      persistedTargetId: row.targetId,
    };
  }
  return candidate;
}

/** Maps a validated entry to the sole permitted database mutation: INSERT. */
export function toSecurityAuditInsertValues(
  entry: SecurityAuditEntry,
): typeof securityAuditEntries.$inferInsert {
  return {
    id: entry.id,
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    entryHash: entry.entryHash,
    category: entry.category,
    action: entry.action,
    actionIds: entry.actionIds,
    confirmationId: entry.confirmationId,
    outcome: entry.outcome,
    principalKind: entry.principal.kind,
    principal: entry.principal,
    source: entry.source,
    facilityId: entry.facilityId,
    targetKind: entry.target?.kind ?? null,
    targetId: entry.target?.id ?? null,
    requestId: entry.requestId,
    reasonCode: entry.reasonCode,
    occurredAt: new Date(entry.occurredAt),
  };
}

function principalCondition(principal: SecurityAuditPrincipalFilter): SQL {
  switch (principal.kind) {
    case 'human':
      return sql`${securityAuditEntries.principal} ->> 'userId' = ${principal.userId}`;
    case 'agent':
      return sql`${securityAuditEntries.principal} ->> 'agentId' = ${principal.agentId}`;
    case 'system':
      return sql`${securityAuditEntries.principal} ->> 'serviceId' = ${principal.serviceId}`;
    case 'unauthenticated':
      return sql`${securityAuditEntries.principal} ->> 'subjectDigest' = ${principal.subjectDigest}`;
  }
}

function scopedFacilityConditions(
  query: SecurityAuditQuery,
  scopeValue: FacilityScope,
): readonly SQL[] {
  const scope = FacilityScopeSchema.parse(scopeValue);
  if (scope.kind === 'district') {
    return query.facilityId === null
      ? []
      : [eq(securityAuditEntries.facilityId, query.facilityId)];
  }

  if (
    query.facilityId !== null &&
    !scope.facilityIds.includes(query.facilityId)
  ) {
    throw new SecurityAuditScopeError();
  }

  return [
    query.facilityId === null
      ? inArray(securityAuditEntries.facilityId, scope.facilityIds)
      : eq(securityAuditEntries.facilityId, query.facilityId),
  ];
}

function cursorFingerprint(
  query: SecurityAuditQuery,
  facilityScope: FacilityScope,
): string {
  const scope =
    facilityScope.kind === 'district'
      ? facilityScope
      : {
          kind: facilityScope.kind,
          facilityIds: [...facilityScope.facilityIds].sort(),
        };
  return calculateCanonicalSecurityAuditDigest({
    query: { ...query, cursor: null, limit: 1 },
    scope,
  });
}

function decodeCursor(cursor: string, expectedFingerprint: string): number {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    const parsed = AuditCursorSchema.parse(decoded);
    if (parsed.queryFingerprint !== expectedFingerprint) {
      throw new SecurityAuditCursorError();
    }
    return parsed.beforeSequence;
  } catch (error) {
    if (error instanceof SecurityAuditCursorError) {
      throw error;
    }
    throw new SecurityAuditCursorError();
  }
}

function encodeCursor(
  beforeSequence: number,
  queryFingerprint: string,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, beforeSequence, queryFingerprint }),
    'utf8',
  ).toString('base64url');
}

function queryConditions(
  query: SecurityAuditQuery,
  facilityScope: FacilityScope,
): readonly SQL[] {
  const conditions: SQL[] = [...scopedFacilityConditions(query, facilityScope)];
  if (query.actorKind !== null) {
    conditions.push(eq(securityAuditEntries.principalKind, query.actorKind));
  }
  if (query.principal !== null) {
    conditions.push(principalCondition(query.principal));
  }
  if (query.category !== null) {
    conditions.push(eq(securityAuditEntries.category, query.category));
  }
  if (query.outcome !== null) {
    conditions.push(eq(securityAuditEntries.outcome, query.outcome));
  }
  if (query.action !== null) {
    conditions.push(eq(securityAuditEntries.action, query.action));
  }
  if (query.occurredFrom !== null) {
    conditions.push(
      gte(securityAuditEntries.occurredAt, new Date(query.occurredFrom)),
    );
  }
  if (query.occurredThrough !== null) {
    conditions.push(
      lte(securityAuditEntries.occurredAt, new Date(query.occurredThrough)),
    );
  }

  const fingerprint = cursorFingerprint(query, facilityScope);
  if (query.cursor !== null) {
    conditions.push(
      lt(
        securityAuditEntries.sequence,
        decodeCursor(query.cursor, fingerprint),
      ),
    );
  }
  return conditions;
}

/** Creates the production serialized writer, scoped query, and verifier store. */
export function createDrizzleSecurityAuditRepository(
  database: Database,
): SecurityAuditRepository {
  return Object.freeze({
    async append(factValue: SecurityAuditFact | unknown) {
      const fact = parseSecurityAuditFact(factValue);
      return database.transaction(async (transaction) => {
        await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);

        const existingRows = await transaction
          .select(rowSelection)
          .from(securityAuditEntries)
          .where(eq(securityAuditEntries.requestId, fact.requestId))
          .limit(1);
        const existingRow = existingRows[0];
        if (existingRow !== undefined) {
          const existing = rowToEntry(existingRow);
          if (
            canonicalSecurityAuditJson(securityAuditFactFromEntry(existing)) ===
            canonicalSecurityAuditJson(fact)
          ) {
            return existing;
          }
          throw new SecurityAuditRequestConflictError();
        }

        const previousRows = await transaction
          .select({
            sequence: securityAuditEntries.sequence,
            entryHash: securityAuditEntries.entryHash,
          })
          .from(securityAuditEntries)
          .orderBy(desc(securityAuditEntries.sequence))
          .limit(1);
        const entry = buildSecurityAuditEntry(fact, previousRows[0] ?? null);
        await transaction
          .insert(securityAuditEntries)
          .values(toSecurityAuditInsertValues(entry));
        return entry;
      });
    },

    async query(
      queryValue: SecurityAuditQuery,
      facilityScopeValue: FacilityScope,
    ): Promise<SecurityAuditPage> {
      const query = SecurityAuditQuerySchema.parse(queryValue);
      const facilityScope = FacilityScopeSchema.parse(facilityScopeValue);
      const conditions = queryConditions(query, facilityScope);
      const rows = await database
        .select(rowSelection)
        .from(securityAuditEntries)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(securityAuditEntries.sequence))
        .limit(query.limit + 1);
      const hasMore = rows.length > query.limit;
      const visibleRows = rows.slice(0, query.limit);
      const items = visibleRows.map(rowToEntry);
      const lastItem = items.at(-1);
      const fingerprint = cursorFingerprint(query, facilityScope);

      return SecurityAuditPageSchema.parse({
        items,
        pageInfo: {
          hasMore,
          nextCursor:
            hasMore && lastItem !== undefined
              ? encodeCursor(lastItem.sequence, fingerprint)
              : null,
        },
      });
    },

    async readChainPage(
      input: SecurityAuditChainPageInput,
    ): Promise<SecurityAuditChainPage> {
      if (
        !Number.isSafeInteger(input.afterSequence) ||
        input.afterSequence < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 200
      ) {
        throw new TypeError('Security audit verification page is invalid.');
      }
      const conditions = [
        gt(securityAuditEntries.sequence, input.afterSequence),
      ];
      if (input.throughSequence !== null) {
        conditions.push(
          lte(securityAuditEntries.sequence, input.throughSequence),
        );
      }
      const rows = await database
        .select(rowSelection)
        .from(securityAuditEntries)
        .where(and(...conditions))
        .orderBy(asc(securityAuditEntries.sequence))
        .limit(input.limit + 1);
      const visibleRows = rows.slice(0, input.limit);
      return Object.freeze({
        entries: Object.freeze(visibleRows.map(rowToVerificationCandidate)),
        lastSequence: visibleRows.at(-1)?.sequence ?? null,
        hasMore: rows.length > input.limit,
      });
    },
  });
}
