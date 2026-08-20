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
import {
  securityAuditChainAnchors,
  securityAuditEntries,
} from '../../db/schema';
import { ACCESS_GATE_AUDIT_LOCK_SQL } from '../auth/sign-in-audit';
import {
  calculateCanonicalSecurityAuditDigest,
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
  SecurityAuditRequestConflictError,
  SecurityAuditScopeError,
  type SecurityAuditChainAnchor,
  type SecurityAuditChainPage,
  type SecurityAuditChainPageInput,
  type SecurityAuditRepository,
  type SecurityAuditVerificationStore,
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

const anchorSelection = {
  sequence: securityAuditChainAnchors.sequence,
  entryHash: securityAuditChainAnchors.entryHash,
} as const;

type SecurityAuditRow = typeof securityAuditEntries.$inferSelect;

function parseChainAnchor(value: unknown): SecurityAuditChainAnchor {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Security audit chain anchor is malformed.');
  }
  const sequence = Reflect.get(value, 'sequence');
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
    throw new TypeError('Security audit chain anchor sequence is malformed.');
  }
  return Object.freeze({
    sequence: Number(sequence),
    entryHash: SecurityAuditHashSchema.parse(Reflect.get(value, 'entryHash')),
  });
}

function validateChainPageInput(input: SecurityAuditChainPageInput): void {
  if (
    !Number.isSafeInteger(input.afterSequence) ||
    input.afterSequence < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200
  ) {
    throw new TypeError('Security audit verification page is invalid.');
  }
}

function firstAnchorMismatchSequence(
  anchor: SecurityAuditChainAnchor | null,
  head: Pick<SecurityAuditEntry, 'sequence' | 'entryHash'> | null,
): number | null {
  if (anchor === null && head === null) return null;
  if (anchor === null) return 1;
  if (head === null) return 1;
  if (anchor.sequence !== head.sequence) {
    return Math.min(anchor.sequence, head.sequence) + 1;
  }
  return anchor.entryHash === head.entryHash ? null : anchor.sequence;
}

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

function rowToVerifiedEntry(row: SecurityAuditRow): SecurityAuditEntry {
  const entry = rowToEntry(row);
  if (
    calculateSecurityAuditHash(securityAuditHashPayload(entry)) !==
    entry.entryHash
  ) {
    throw new SecurityAuditIntegrityError(entry.sequence);
  }
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

function chainPageFromRows(
  anchorValues: readonly unknown[],
  rows: readonly SecurityAuditRow[],
  input: SecurityAuditChainPageInput,
): SecurityAuditChainPage {
  const visibleAnchors = anchorValues
    .slice(0, input.limit)
    .map(parseChainAnchor);
  const rowsBySequence = new Map(rows.map((row) => [row.sequence, row]));
  let expectedSequence = input.afterSequence + 1;
  let firstAnchorMismatchSequence: number | null = null;
  const visibleRows: SecurityAuditRow[] = [];

  for (const anchor of visibleAnchors) {
    if (
      firstAnchorMismatchSequence === null &&
      anchor.sequence !== expectedSequence
    ) {
      firstAnchorMismatchSequence = expectedSequence;
    }
    const row = rowsBySequence.get(anchor.sequence);
    if (row === undefined || row.entryHash !== anchor.entryHash) {
      firstAnchorMismatchSequence ??= anchor.sequence;
    } else {
      visibleRows.push(row);
    }
    expectedSequence = anchor.sequence + 1;
  }

  return Object.freeze({
    entries: Object.freeze(visibleRows.map(rowToVerificationCandidate)),
    lastSequence: visibleAnchors.at(-1)?.sequence ?? null,
    hasMore: anchorValues.length > input.limit,
    firstAnchorMismatchSequence,
  });
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

        const anchorRows = await transaction
          .select(anchorSelection)
          .from(securityAuditChainAnchors)
          .orderBy(desc(securityAuditChainAnchors.sequence))
          .limit(1)
          .for('share');
        const anchor =
          anchorRows[0] === undefined ? null : parseChainAnchor(anchorRows[0]);

        const headRows = await transaction
          .select(rowSelection)
          .from(securityAuditEntries)
          .orderBy(desc(securityAuditEntries.sequence))
          .limit(1)
          .for('share');
        const head =
          headRows[0] === undefined ? null : rowToVerifiedEntry(headRows[0]);
        const mismatchSequence = firstAnchorMismatchSequence(anchor, head);
        if (mismatchSequence !== null) {
          throw new SecurityAuditIntegrityError(mismatchSequence);
        }

        const existingRows = await transaction
          .select(rowSelection)
          .from(securityAuditEntries)
          .where(eq(securityAuditEntries.requestId, fact.requestId))
          .limit(1)
          .for('share');
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

        const entry = buildSecurityAuditEntry(fact, anchor);
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

    async readChainAnchor(throughSequence: number | null) {
      const rows = await database
        .select(anchorSelection)
        .from(securityAuditChainAnchors)
        .where(
          throughSequence === null
            ? undefined
            : eq(securityAuditChainAnchors.sequence, throughSequence),
        )
        .orderBy(desc(securityAuditChainAnchors.sequence))
        .limit(1);
      return rows[0] === undefined ? null : parseChainAnchor(rows[0]);
    },

    async readChainPage(
      input: SecurityAuditChainPageInput,
    ): Promise<SecurityAuditChainPage> {
      validateChainPageInput(input);
      const conditions = [
        gt(securityAuditChainAnchors.sequence, input.afterSequence),
      ];
      if (input.throughSequence !== null) {
        conditions.push(
          lte(securityAuditChainAnchors.sequence, input.throughSequence),
        );
      }
      const anchorRows = await database
        .select(anchorSelection)
        .from(securityAuditChainAnchors)
        .where(and(...conditions))
        .orderBy(asc(securityAuditChainAnchors.sequence))
        .limit(input.limit + 1);
      const visibleSequences = anchorRows
        .slice(0, input.limit)
        .map((anchor) => anchor.sequence);
      const rows =
        visibleSequences.length === 0
          ? []
          : await database
              .select(rowSelection)
              .from(securityAuditEntries)
              .where(inArray(securityAuditEntries.sequence, visibleSequences))
              .orderBy(asc(securityAuditEntries.sequence));
      return chainPageFromRows(anchorRows, rows, input);
    },

    async runVerificationSession<T>(
      operation: (store: SecurityAuditVerificationStore) => Promise<T>,
    ): Promise<T> {
      return database.transaction(
        async (transaction) => {
          const store: SecurityAuditVerificationStore = Object.freeze({
            async append(factValue: SecurityAuditFact | unknown) {
              const fact = parseSecurityAuditFact(factValue);
              if (
                fact.category !== 'audit-query' ||
                fact.action !== 'verify-security-audit-chain' ||
                (fact.outcome !== 'success' && fact.outcome !== 'failure')
              ) {
                throw new TypeError(
                  'Only a verification result may append in this transaction.',
                );
              }

              await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);

              const anchorRows = await transaction
                .select(anchorSelection)
                .from(securityAuditChainAnchors)
                .orderBy(desc(securityAuditChainAnchors.sequence))
                .limit(1)
                .for('share');
              const anchor =
                anchorRows[0] === undefined
                  ? null
                  : parseChainAnchor(anchorRows[0]);
              const headRows = await transaction
                .select(rowSelection)
                .from(securityAuditEntries)
                .orderBy(desc(securityAuditEntries.sequence))
                .limit(1)
                .for('share');
              const head =
                headRows[0] === undefined
                  ? null
                  : fact.outcome === 'success'
                    ? rowToVerifiedEntry(headRows[0])
                    : headRows[0];
              const mismatchSequence = firstAnchorMismatchSequence(
                anchor,
                head,
              );
              if (fact.outcome === 'success' && mismatchSequence !== null) {
                throw new SecurityAuditIntegrityError(mismatchSequence);
              }
              if (anchor === null && head !== null) {
                throw new SecurityAuditIntegrityError(1);
              }

              const existingRows = await transaction
                .select(rowSelection)
                .from(securityAuditEntries)
                .where(eq(securityAuditEntries.requestId, fact.requestId))
                .limit(1)
                .for('share');
              const existingRow = existingRows[0];
              if (existingRow !== undefined) {
                const existing = rowToEntry(existingRow);
                if (
                  canonicalSecurityAuditJson(
                    securityAuditFactFromEntry(existing),
                  ) === canonicalSecurityAuditJson(fact)
                ) {
                  return existing;
                }
                throw new SecurityAuditRequestConflictError();
              }

              const entry = buildSecurityAuditEntry(fact, anchor);
              await transaction
                .insert(securityAuditEntries)
                .values(toSecurityAuditInsertValues(entry));
              return entry;
            },

            async readChainAnchor(throughSequence: number | null) {
              const rows = await transaction
                .select(anchorSelection)
                .from(securityAuditChainAnchors)
                .where(
                  throughSequence === null
                    ? undefined
                    : eq(securityAuditChainAnchors.sequence, throughSequence),
                )
                .orderBy(desc(securityAuditChainAnchors.sequence))
                .limit(1)
                .for('share');
              return rows[0] === undefined ? null : parseChainAnchor(rows[0]);
            },

            async readChainPage(
              input: SecurityAuditChainPageInput,
            ): Promise<SecurityAuditChainPage> {
              validateChainPageInput(input);
              const conditions = [
                gt(securityAuditChainAnchors.sequence, input.afterSequence),
              ];
              if (input.throughSequence !== null) {
                conditions.push(
                  lte(
                    securityAuditChainAnchors.sequence,
                    input.throughSequence,
                  ),
                );
              }
              const anchorRows = await transaction
                .select(anchorSelection)
                .from(securityAuditChainAnchors)
                .where(and(...conditions))
                .orderBy(asc(securityAuditChainAnchors.sequence))
                .limit(input.limit + 1)
                .for('share');
              const visibleSequences = anchorRows
                .slice(0, input.limit)
                .map((anchor) => anchor.sequence);
              const rows =
                visibleSequences.length === 0
                  ? []
                  : await transaction
                      .select(rowSelection)
                      .from(securityAuditEntries)
                      .where(
                        inArray(
                          securityAuditEntries.sequence,
                          visibleSequences,
                        ),
                      )
                      .orderBy(asc(securityAuditEntries.sequence))
                      .for('share');
              return chainPageFromRows(anchorRows, rows, input);
            },
          });

          return operation(store);
        },
        { isolationLevel: 'read committed' },
      );
    },
  });
}
