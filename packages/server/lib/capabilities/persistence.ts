import { SecurityAuditEntrySchema } from '@psd-eoc/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import { databaseExecuteRows, type DatabaseQuery } from '../../db/client';
import {
  idempotencyRecords,
  securityAuditChainAnchors,
  securityAuditEntries,
} from '../../db/schema';
import {
  buildSecurityAuditEntry,
  canonicalSecurityAuditJson,
  parseSecurityAuditFact,
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  securityAuditFactFromEntry,
  toSecurityAuditInsertValues,
} from '../audit';

import {
  CapabilityEngineError,
  type CapabilityAuditEvent,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
} from './engine';

/**
 * Idempotency, clock, and audit persistence shared by capability modules.
 *
 * Each existing capability module carries its own private copy of these four
 * functions. They are identical apart from the wording of the conflict they
 * raise, so this module takes that wording as an argument and lets a new module
 * reuse the behavior instead of adding another copy to keep in step.
 */
export interface SharedPersistenceContext {
  /** Names the domain in the conflict a caller sees, e.g. 'SMS consent'. */
  readonly subject: string;
}

function conflict(
  context: SharedPersistenceContext,
  message: string,
): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    `${context.subject} ${message}`,
    409,
  );
}

function dateIso(
  context: SharedPersistenceContext,
  value: Date | string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw conflict(context, 'read a persisted time that was invalid.');
  }
  return date.toISOString();
}

/** Reads the authoritative database clock after any preceding lock waits. */
export async function readSharedDatabaseTime(
  database: DatabaseQuery,
  context: SharedPersistenceContext,
): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw conflict(context, 'could not read the authoritative database clock.');
  }
  return new Date(dateIso(context, row.value));
}

/** Claims, or recognises a replay of, one durable idempotency record. */
export async function claimSharedIdempotency(
  database: DatabaseQuery,
  input: ClaimIdempotencyInput,
  context: SharedPersistenceContext,
): Promise<IdempotencyClaim> {
  const [inserted] = await database
    .insert(idempotencyRecords)
    .values({
      capabilityId: input.capabilityId,
      principal: input.actor,
      principalDigest: input.principalDigest,
      key: input.key,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.capabilityId,
        idempotencyRecords.principalDigest,
        idempotencyRecords.key,
      ],
    })
    .returning({ id: idempotencyRecords.id });
  if (inserted !== undefined) {
    return { kind: 'new', recordId: inserted.id };
  }
  const [existing] = await database
    .select({
      requestDigest: idempotencyRecords.requestDigest,
      status: idempotencyRecords.status,
      resultReference: idempotencyRecords.resultReference,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.capabilityId, input.capabilityId),
        eq(idempotencyRecords.principalDigest, input.principalDigest),
        eq(idempotencyRecords.key, input.key),
      ),
    )
    .for('update')
    .limit(1);
  if (existing === undefined) {
    throw conflict(context, 'could not resolve the request replay.');
  }
  if (existing.status === 'completed' && existing.resultReference !== null) {
    return {
      kind: 'completed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  if (existing.status === 'failed' && existing.resultReference !== null) {
    return {
      kind: 'failed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  return { kind: 'in-progress', requestDigest: existing.requestDigest };
}

/** Marks a claimed idempotency record complete and binds its result. */
export async function completeSharedIdempotency(
  database: DatabaseQuery,
  input: CompleteIdempotencyInput,
  context: SharedPersistenceContext,
): Promise<void> {
  const [updated] = await database
    .update(idempotencyRecords)
    .set({
      status: 'completed',
      completedAt: input.completedAt,
      resultReference: input.resultReference,
    })
    .where(
      and(
        eq(idempotencyRecords.id, input.recordId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (updated === undefined) {
    throw conflict(context, 'could not complete the request replay.');
  }
}

function securityAuditEntryFromRow(
  context: SharedPersistenceContext,
  row: typeof securityAuditEntries.$inferSelect,
) {
  return SecurityAuditEntrySchema.parse({
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
    occurredAt: dateIso(context, row.occurredAt),
  });
}

/** Appends one hash-chained capability audit entry, idempotent by request id. */
export async function appendSharedCapabilityAuditEntry(
  database: DatabaseQuery,
  event: CapabilityAuditEvent,
  context: SharedPersistenceContext,
): Promise<void> {
  const fact = parseSecurityAuditFact({
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability', id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  });
  await database.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
  const [existingRow] = await database
    .select()
    .from(securityAuditEntries)
    .where(eq(securityAuditEntries.requestId, fact.requestId))
    .limit(1)
    .for('share');
  if (existingRow !== undefined) {
    const existing = securityAuditEntryFromRow(context, existingRow);
    if (
      canonicalSecurityAuditJson(securityAuditFactFromEntry(existing)) ===
      canonicalSecurityAuditJson(fact)
    ) {
      return;
    }
    throw conflict(
      context,
      'bound the audit request id to different evidence already.',
    );
  }
  const [anchor] = await database
    .select({
      sequence: securityAuditChainAnchors.sequence,
      entryHash: securityAuditChainAnchors.entryHash,
    })
    .from(securityAuditChainAnchors)
    .orderBy(desc(securityAuditChainAnchors.sequence))
    .limit(1)
    .for('share');
  const entry = buildSecurityAuditEntry(
    fact,
    anchor === undefined ? null : anchor,
  );
  await database
    .insert(securityAuditEntries)
    .values(toSecurityAuditInsertValues(entry));
}
