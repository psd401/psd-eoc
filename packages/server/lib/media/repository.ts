import { randomUUID } from 'node:crypto';

import {
  MediaRecordSchema,
  SecurityAuditEntrySchema,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  notExists,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type PostgresDatabase,
} from '../../db/client';
import {
  events,
  idempotencyRecords,
  journalEntries,
  mediaRecords,
  mediaUploadIntents,
  securityAuditEntries,
} from '../../db/schema';
import { ACCESS_GATE_AUDIT_LOCK_SQL } from '../auth/sign-in-audit';
import {
  digestCapabilityValue,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
} from '../capabilities/engine';
import {
  mediaConflict,
  mediaRateLimited,
  mediaUnavailable,
  TerminalMediaImageRejectionError,
} from './errors';
import type {
  CompleteMediaRecord,
  NewMediaUploadIntent,
  PhotoChecksumExportProjection,
  StoredMediaRecord,
  StoredMediaUploadIntent,
} from './model';
import {
  MEDIA_EVENT_ACTIVE_BYTE_LIMIT,
  MEDIA_EVENT_ACTIVE_INTENT_LIMIT,
  MEDIA_EVENT_ROLLING_BYTE_LIMIT,
  MEDIA_EVENT_ROLLING_INTENT_LIMIT,
  MEDIA_FACILITY_ACTIVE_BYTE_LIMIT,
  MEDIA_FACILITY_ACTIVE_INTENT_LIMIT,
  MEDIA_FACILITY_ROLLING_BYTE_LIMIT,
  MEDIA_FACILITY_ROLLING_INTENT_LIMIT,
  MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT,
  MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
  MEDIA_UPLOAD_BUDGET_WINDOW_SECONDS,
} from './model';

export interface ResolvedMediaUploadIntent {
  readonly facilityId: string;
  readonly intent: StoredMediaUploadIntent;
  readonly readyRecord: StoredMediaRecord | null;
}

export interface ResolvedReadyMedia {
  readonly facilityId: string;
  readonly record: StoredMediaRecord;
}

/** Media-specific persistence added to the shared capability engine contract. */
export interface MediaCapabilityTransaction extends CapabilityEngineTransaction {
  resolveEventFacilityId(eventId: string): Promise<string | null>;
  resolveUploadIntent(
    uploadIntentId: string,
    lock: boolean,
  ): Promise<ResolvedMediaUploadIntent | null>;
  resolveReadyMedia(
    eventId: string,
    mediaId: string,
  ): Promise<ResolvedReadyMedia | null>;
  insertUploadIntent(intent: NewMediaUploadIntent): Promise<void>;
  completeUpload(input: CompleteMediaRecord): Promise<void>;
  listPhotoChecksumExportProjection(
    eventId: string,
  ): Promise<readonly PhotoChecksumExportProjection[]>;
}

export type MediaCapabilityStore =
  CapabilityEngineStore<MediaCapabilityTransaction>;

type MediaQueryDatabase = PostgresDatabase;

export interface MediaUploadResourceUsage {
  readonly principalRollingIntents: number;
  readonly principalRollingBytes: number;
  readonly eventActiveIntents: number;
  readonly eventActiveBytes: number;
  readonly eventRollingIntents: number;
  readonly eventRollingBytes: number;
  readonly facilityActiveIntents: number;
  readonly facilityActiveBytes: number;
  readonly facilityRollingIntents: number;
  readonly facilityRollingBytes: number;
}

export type MediaUploadBudgetDimension =
  | 'principal-rolling-intents'
  | 'principal-rolling-bytes'
  | 'event-active-intents'
  | 'event-active-bytes'
  | 'event-rolling-intents'
  | 'event-rolling-bytes'
  | 'facility-active-intents'
  | 'facility-active-bytes'
  | 'facility-rolling-intents'
  | 'facility-rolling-bytes';

/**
 * Returns the first fixed allocation boundary a proposed grant would cross.
 * Counts describe already-durable grants; the proposed grant is added here so
 * every caller applies identical inclusive limits before persistence.
 */
export function mediaUploadBudgetViolation(
  usage: MediaUploadResourceUsage,
  proposedBytes: number,
): MediaUploadBudgetDimension | null {
  if (
    usage.principalRollingIntents + 1 >
    MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT
  ) {
    return 'principal-rolling-intents';
  }
  if (
    usage.principalRollingBytes + proposedBytes >
    MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT
  ) {
    return 'principal-rolling-bytes';
  }
  if (usage.eventActiveIntents + 1 > MEDIA_EVENT_ACTIVE_INTENT_LIMIT) {
    return 'event-active-intents';
  }
  if (usage.eventActiveBytes + proposedBytes > MEDIA_EVENT_ACTIVE_BYTE_LIMIT) {
    return 'event-active-bytes';
  }
  if (usage.eventRollingIntents + 1 > MEDIA_EVENT_ROLLING_INTENT_LIMIT) {
    return 'event-rolling-intents';
  }
  if (
    usage.eventRollingBytes + proposedBytes >
    MEDIA_EVENT_ROLLING_BYTE_LIMIT
  ) {
    return 'event-rolling-bytes';
  }
  if (usage.facilityActiveIntents + 1 > MEDIA_FACILITY_ACTIVE_INTENT_LIMIT) {
    return 'facility-active-intents';
  }
  if (
    usage.facilityActiveBytes + proposedBytes >
    MEDIA_FACILITY_ACTIVE_BYTE_LIMIT
  ) {
    return 'facility-active-bytes';
  }
  if (usage.facilityRollingIntents + 1 > MEDIA_FACILITY_ROLLING_INTENT_LIMIT) {
    return 'facility-rolling-intents';
  }
  if (
    usage.facilityRollingBytes + proposedBytes >
    MEDIA_FACILITY_ROLLING_BYTE_LIMIT
  ) {
    return 'facility-rolling-bytes';
  }
  return null;
}

function queryDatabase(database: unknown): MediaQueryDatabase {
  // Both configured Drizzle transports expose this schema-aware subset.
  return database as MediaQueryDatabase;
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function storedIntentFromRow(
  row: typeof mediaUploadIntents.$inferSelect,
): StoredMediaUploadIntent {
  return Object.freeze({
    id: row.id,
    eventId: row.eventId,
    byteLength: row.byteLength,
    contentSha256: row.contentSha256,
    declaredContentType: row.declaredContentType,
    storageKey: row.storageKey,
    status: row.status as StoredMediaUploadIntent['status'],
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

function storedRecordFromRow(
  row: typeof mediaRecords.$inferSelect,
): StoredMediaRecord {
  return Object.freeze({
    ...MediaRecordSchema.parse({
      id: row.id,
      uploadIntentId: row.uploadIntentId,
      eventId: row.eventId,
      status: row.status,
      detectedContentType: row.detectedContentType,
      sanitizedByteLength: row.sanitizedByteLength,
      sanitizedContentSha256: row.sanitizedContentSha256,
      malwareScan: row.malwareScan,
      exifStripped: row.exifStripped,
      createdAt: dateIso(row.createdAt),
    }),
    storageKey: row.storageKey,
  });
}

async function readDatabaseTime(database: MediaQueryDatabase): Promise<Date> {
  const [row] = await database.execute<{ value: Date | string }>(
    sql`select clock_timestamp() as value`,
  );
  if (row === undefined) {
    throw mediaConflict('The authoritative media clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

interface MediaUsageByteRow {
  readonly byteLength: number | string;
}

export const MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS = Object.freeze({
  principalRolling: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT + 1,
  eventActive: MEDIA_EVENT_ACTIVE_INTENT_LIMIT + 1,
  eventRolling: MEDIA_EVENT_ROLLING_INTENT_LIMIT + 1,
  facilityActive: MEDIA_FACILITY_ACTIVE_INTENT_LIMIT + 1,
  facilityRolling: MEDIA_FACILITY_ROLLING_INTENT_LIMIT + 1,
});

/** One indexed row is enough to fail closed on unattributed legacy history. */
export const MEDIA_UNATTRIBUTED_USAGE_QUERY_ROW_LIMIT = 1;

export const MEDIA_UPLOAD_ALLOCATION_STATEMENT_TIMEOUT_MILLISECONDS = 5_000;
export const MEDIA_UPLOAD_ALLOCATION_LOCK_TIMEOUT_MILLISECONDS = 1_000;

function resourceUsageValue(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw mediaUnavailable();
  }
  return parsed;
}

async function acquireMediaUploadBudgetLock(
  database: MediaQueryDatabase,
  scope: 'facility' | 'principal',
  stableId: string,
): Promise<void> {
  const lockKey = `psd-eoc:media-upload-budget:${scope}:${stableId}`;
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

/**
 * Bounds both allocation queries and lock waits inside the current database
 * transaction. A stricter database-level deadline is preserved; an unset or
 * looser deadline is clamped. PostgreSQL aborts the transaction on expiry, so
 * no upload grant can escape a timed-out budget check.
 */
export async function configureMediaUploadAllocationDeadline(
  database: Pick<MediaQueryDatabase, 'execute'>,
): Promise<void> {
  const statementTimeout = `${MEDIA_UPLOAD_ALLOCATION_STATEMENT_TIMEOUT_MILLISECONDS}ms`;
  const lockTimeout = `${MEDIA_UPLOAD_ALLOCATION_LOCK_TIMEOUT_MILLISECONDS}ms`;
  await database.execute(sql`
    select
      set_config(
        'statement_timeout',
        case
          when current_setting('statement_timeout')::interval = interval '0'
            or current_setting('statement_timeout')::interval > ${statementTimeout}::interval
          then ${statementTimeout}
          else current_setting('statement_timeout')
        end,
        true
      ),
      set_config(
        'lock_timeout',
        case
          when current_setting('lock_timeout')::interval = interval '0'
            or current_setting('lock_timeout')::interval > ${lockTimeout}::interval
          then ${lockTimeout}
          else current_setting('lock_timeout')
        end,
        true
      )
  `);
}

/**
 * Builds index-backed budget reads whose result sets stop as soon as the
 * corresponding request ceiling is known to be exceeded. The event/facility
 * anchors and stable pseudonymous principal digest live on each intent, so no
 * retained idempotency JSON scan or events join is needed while locks are held.
 * The one-row unattributed read fails closed for recent pre-migration history.
 */
export function buildBoundedMediaUploadUsageQueries(
  database: PostgresDatabase,
  input: Pick<
    NewMediaUploadIntent,
    'budgetPrincipal' | 'eventId' | 'facilityId'
  >,
  currentTime: Date,
) {
  const windowStart = new Date(
    currentTime.getTime() - MEDIA_UPLOAD_BUDGET_WINDOW_SECONDS * 1_000,
  );

  return Object.freeze({
    principalRolling: database
      .select({ byteLength: mediaUploadIntents.byteLength })
      .from(mediaUploadIntents)
      .where(
        and(
          eq(
            mediaUploadIntents.budgetPrincipalDigest,
            input.budgetPrincipal.digest,
          ),
          gte(mediaUploadIntents.createdAt, windowStart),
        ),
      )
      .orderBy(desc(mediaUploadIntents.createdAt))
      .limit(MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.principalRolling),
    unattributedRecent: database
      .select({ id: mediaUploadIntents.id })
      .from(mediaUploadIntents)
      .where(
        and(
          eq(mediaUploadIntents.budgetPrincipalAttributed, false),
          gte(mediaUploadIntents.createdAt, windowStart),
        ),
      )
      .orderBy(desc(mediaUploadIntents.createdAt))
      .limit(MEDIA_UNATTRIBUTED_USAGE_QUERY_ROW_LIMIT),
    eventActive: database
      .select({ byteLength: mediaUploadIntents.byteLength })
      .from(mediaUploadIntents)
      .where(
        and(
          eq(mediaUploadIntents.eventId, input.eventId),
          sql`${mediaUploadIntents.status} = 'pending-upload'`,
          gt(mediaUploadIntents.expiresAt, currentTime),
        ),
      )
      .orderBy(desc(mediaUploadIntents.expiresAt))
      .limit(MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.eventActive),
    eventRolling: database
      .select({ byteLength: mediaUploadIntents.byteLength })
      .from(mediaUploadIntents)
      .where(
        and(
          eq(mediaUploadIntents.eventId, input.eventId),
          gte(mediaUploadIntents.createdAt, windowStart),
        ),
      )
      .orderBy(desc(mediaUploadIntents.createdAt))
      .limit(MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.eventRolling),
    facilityActive: database
      .select({ byteLength: mediaUploadIntents.byteLength })
      .from(mediaUploadIntents)
      .where(
        and(
          eq(mediaUploadIntents.facilityId, input.facilityId),
          sql`${mediaUploadIntents.status} = 'pending-upload'`,
          gt(mediaUploadIntents.expiresAt, currentTime),
        ),
      )
      .orderBy(desc(mediaUploadIntents.expiresAt))
      .limit(MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.facilityActive),
    facilityRolling: database
      .select({ byteLength: mediaUploadIntents.byteLength })
      .from(mediaUploadIntents)
      .where(
        and(
          eq(mediaUploadIntents.facilityId, input.facilityId),
          gte(mediaUploadIntents.createdAt, windowStart),
        ),
      )
      .orderBy(desc(mediaUploadIntents.createdAt))
      .limit(MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.facilityRolling),
  });
}

function summarizeBoundedMediaUsage(
  rows: readonly MediaUsageByteRow[],
  maximumRows: number,
): Readonly<{ intents: number; bytes: number }> {
  if (rows.length > maximumRows) {
    throw mediaUnavailable();
  }
  let bytes = 0;
  for (const row of rows) {
    const byteLength = resourceUsageValue(row.byteLength);
    const nextBytes = bytes + byteLength;
    if (!Number.isSafeInteger(nextBytes)) {
      throw mediaUnavailable();
    }
    bytes = nextBytes;
  }
  return Object.freeze({ intents: rows.length, bytes });
}

async function readMediaUploadResourceUsage(
  database: MediaQueryDatabase,
  input: NewMediaUploadIntent,
  currentTime: Date,
): Promise<MediaUploadResourceUsage> {
  const queries = buildBoundedMediaUploadUsageQueries(
    database,
    input,
    currentTime,
  );
  if ((await queries.unattributedRecent).length !== 0) {
    throw mediaUnavailable();
  }
  const principalRows = await queries.principalRolling;
  const principal = summarizeBoundedMediaUsage(
    principalRows,
    MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.principalRolling,
  );
  const eventActive = summarizeBoundedMediaUsage(
    await queries.eventActive,
    MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.eventActive,
  );
  const eventRolling = summarizeBoundedMediaUsage(
    await queries.eventRolling,
    MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.eventRolling,
  );
  const facilityActive = summarizeBoundedMediaUsage(
    await queries.facilityActive,
    MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.facilityActive,
  );
  const facilityRolling = summarizeBoundedMediaUsage(
    await queries.facilityRolling,
    MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS.facilityRolling,
  );
  return Object.freeze({
    principalRollingIntents: principal.intents,
    principalRollingBytes: principal.bytes,
    eventActiveIntents: eventActive.intents,
    eventActiveBytes: eventActive.bytes,
    eventRollingIntents: eventRolling.intents,
    eventRollingBytes: eventRolling.bytes,
    facilityActiveIntents: facilityActive.intents,
    facilityActiveBytes: facilityActive.bytes,
    facilityRollingIntents: facilityRolling.intents,
    facilityRollingBytes: facilityRolling.bytes,
  });
}

async function claimIdempotency(
  database: MediaQueryDatabase,
  input: ClaimIdempotencyInput,
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
    throw mediaConflict('The media request replay could not be resolved.');
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

async function completeIdempotency(
  database: MediaQueryDatabase,
  input: CompleteIdempotencyInput,
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
    throw mediaConflict('The media request replay could not be completed.');
  }
}

interface MediaTransactionExecutionState {
  newlyClaimedIdempotency: Readonly<{
    capabilityId: ClaimIdempotencyInput['capabilityId'];
    recordId: string;
  }> | null;
  lockedUploadIntent: Readonly<{
    eventId: string;
    uploadIntentId: string;
  }> | null;
}

const TERMINAL_IMAGE_REJECTION_COMMITTED = Symbol(
  'terminal-media-image-rejection-committed',
);

function terminalImageRejectionReference(
  error: TerminalMediaImageRejectionError,
): string {
  return `terminal-image-rejection:${error.eventId}:${error.uploadIntentId}`;
}

async function persistTerminalImageRejection(
  database: MediaQueryDatabase,
  state: MediaTransactionExecutionState,
  error: TerminalMediaImageRejectionError,
): Promise<void> {
  const claim = state.newlyClaimedIdempotency;
  const lockedIntent = state.lockedUploadIntent;
  if (
    claim === null ||
    claim.capabilityId !== 'complete-media-upload' ||
    lockedIntent === null ||
    lockedIntent.eventId !== error.eventId ||
    lockedIntent.uploadIntentId !== error.uploadIntentId
  ) {
    throw mediaUnavailable();
  }

  const rejectedIntents = await database
    .update(mediaUploadIntents)
    .set({ status: 'rejected' })
    .where(
      and(
        eq(mediaUploadIntents.id, error.uploadIntentId),
        eq(mediaUploadIntents.eventId, error.eventId),
        eq(mediaUploadIntents.status, 'pending-upload'),
      ),
    )
    .returning({ id: mediaUploadIntents.id });
  if (rejectedIntents.length !== 1) {
    throw mediaUnavailable();
  }

  const failedClaims = await database
    .update(idempotencyRecords)
    .set({
      status: 'failed',
      completedAt: sql`greatest(clock_timestamp(), ${idempotencyRecords.createdAt})`,
      resultReference: terminalImageRejectionReference(error),
    })
    .where(
      and(
        eq(idempotencyRecords.id, claim.recordId),
        eq(idempotencyRecords.capabilityId, claim.capabilityId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (failedClaims.length !== 1) {
    throw mediaUnavailable();
  }
}

async function appendCapabilityAuditEntry(
  database: MediaQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  await database.execute(ACCESS_GATE_AUDIT_LOCK_SQL);
  const [previous] = await database
    .select({
      sequence: securityAuditEntries.sequence,
      entryHash: securityAuditEntries.entryHash,
    })
    .from(securityAuditEntries)
    .orderBy(desc(securityAuditEntries.sequence))
    .limit(1);
  const sequence = (previous?.sequence ?? 0) + 1;
  const previousHash = previous?.entryHash ?? null;
  const id = randomUUID();
  const hashPayload = {
    id,
    sequence,
    previousHash,
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability' as const, id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  };
  const entry = SecurityAuditEntrySchema.parse({
    ...hashPayload,
    entryHash: digestCapabilityValue(hashPayload),
  });
  await database.insert(securityAuditEntries).values({
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
  });
}

async function resolveEventFacilityId(
  database: MediaQueryDatabase,
  eventId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ facilityId: events.facilityId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row?.facilityId ?? null;
}

async function resolveUploadIntent(
  database: MediaQueryDatabase,
  uploadIntentId: string,
  lock: boolean,
): Promise<ResolvedMediaUploadIntent | null> {
  const base = database
    .select({
      intent: mediaUploadIntents,
      facilityId: events.facilityId,
    })
    .from(mediaUploadIntents)
    .innerJoin(events, eq(events.id, mediaUploadIntents.eventId))
    .where(eq(mediaUploadIntents.id, uploadIntentId));
  const rows = lock
    ? await base.for('update', { of: mediaUploadIntents }).limit(1)
    : await base.limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const [ready] = await database
    .select()
    .from(mediaRecords)
    .where(eq(mediaRecords.uploadIntentId, uploadIntentId))
    .limit(1);
  return Object.freeze({
    facilityId: row.facilityId,
    intent: storedIntentFromRow(row.intent),
    readyRecord: ready === undefined ? null : storedRecordFromRow(ready),
  });
}

/**
 * Locks the event row shared with journal writers before media visibility is
 * evaluated. This must remain a separate statement: after waiting for an
 * in-flight journal writer, PostgreSQL READ COMMITTED gives the following
 * statement a fresh snapshot containing that writer's redaction.
 */
export function buildMediaReadEventLockQuery(
  database: PostgresDatabase,
  eventId: string,
) {
  return database
    .select({ facilityId: events.facilityId })
    .from(events)
    .where(eq(events.id, eventId))
    .for('share', { of: events })
    .limit(1);
}

/**
 * Resolves only media with at least one visible same-event photo binding.
 * Redaction is exact on both immutable entry identity fields; corrections and
 * redactions of other entries therefore cannot hide the photo accidentally.
 */
export function buildAuthorizedReadyMediaQuery(
  database: PostgresDatabase,
  eventId: string,
  mediaId: string,
) {
  const redactions = alias(journalEntries, 'media_read_redactions');
  const visiblePhotoBinding = database
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.eventId, mediaRecords.eventId),
        eq(journalEntries.kind, 'photo'),
        eq(journalEntries.mediaId, mediaRecords.id),
        notExists(
          database
            .select({ id: redactions.id })
            .from(redactions)
            .where(
              and(
                eq(redactions.eventId, journalEntries.eventId),
                eq(redactions.supersedesEntryId, journalEntries.id),
                eq(redactions.supersedesEntrySequence, journalEntries.sequence),
                eq(redactions.supersessionKind, 'redaction'),
              ),
            ),
        ),
      ),
    );

  return database
    .select({ record: mediaRecords })
    .from(mediaRecords)
    .where(
      and(
        eq(mediaRecords.id, mediaId),
        eq(mediaRecords.eventId, eventId),
        exists(visiblePhotoBinding),
      ),
    )
    .limit(1);
}

async function resolveReadyMedia(
  database: MediaQueryDatabase,
  eventId: string,
  mediaId: string,
): Promise<ResolvedReadyMedia | null> {
  const [lockedEvent] = await buildMediaReadEventLockQuery(database, eventId);
  if (lockedEvent === undefined) {
    return null;
  }
  const [row] = await buildAuthorizedReadyMediaQuery(
    database,
    eventId,
    mediaId,
  );
  return row === undefined
    ? null
    : Object.freeze({
        facilityId: lockedEvent.facilityId,
        record: storedRecordFromRow(row.record),
      });
}

/**
 * Builds issue #27's checksum-bearing export projection from the same-event
 * journal/media relationship. Keeping this query here prevents export code
 * from reimplementing or weakening the binding.
 */
export function buildPhotoChecksumExportQuery(
  database: PostgresDatabase,
  eventId: string,
) {
  return database
    .select({
      journalEntryId: journalEntries.id,
      eventId: journalEntries.eventId,
      sequence: journalEntries.sequence,
      mediaId: mediaRecords.id,
      sanitizedContentSha256: mediaRecords.sanitizedContentSha256,
      sanitizedByteLength: mediaRecords.sanitizedByteLength,
      detectedContentType: mediaRecords.detectedContentType,
    })
    .from(journalEntries)
    .innerJoin(
      mediaRecords,
      and(
        eq(mediaRecords.id, journalEntries.mediaId),
        eq(mediaRecords.eventId, journalEntries.eventId),
      ),
    )
    .where(
      and(
        eq(journalEntries.eventId, eventId),
        eq(journalEntries.kind, 'photo'),
      ),
    )
    .orderBy(asc(journalEntries.sequence));
}

function createTransaction(
  database: MediaQueryDatabase,
  executionState?: MediaTransactionExecutionState,
): MediaCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    async claimIdempotency(input) {
      const claim = await claimIdempotency(database, input);
      if (claim.kind === 'new' && executionState !== undefined) {
        if (executionState.newlyClaimedIdempotency !== null) {
          throw mediaUnavailable();
        }
        executionState.newlyClaimedIdempotency = Object.freeze({
          capabilityId: input.capabilityId,
          recordId: claim.recordId,
        });
      }
      return claim;
    },
    completeIdempotency: (input) => completeIdempotency(database, input),
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
    resolveEventFacilityId: (eventId) =>
      resolveEventFacilityId(database, eventId),
    async resolveUploadIntent(uploadIntentId, lock) {
      const resolved = await resolveUploadIntent(
        database,
        uploadIntentId,
        lock,
      );
      if (lock && resolved !== null && executionState !== undefined) {
        executionState.lockedUploadIntent = Object.freeze({
          eventId: resolved.intent.eventId,
          uploadIntentId: resolved.intent.id,
        });
      }
      return resolved;
    },
    resolveReadyMedia: (eventId, mediaId) =>
      resolveReadyMedia(database, eventId, mediaId),
    async insertUploadIntent(intent) {
      await configureMediaUploadAllocationDeadline(database);
      // A fixed lock order makes fresh idempotency keys contend on both the
      // authenticated principal and facility before any durable allocation.
      await acquireMediaUploadBudgetLock(
        database,
        'principal',
        intent.budgetPrincipal.digest,
      );
      await acquireMediaUploadBudgetLock(
        database,
        'facility',
        intent.facilityId,
      );
      const [event] = await database
        .select({
          id: events.id,
          facilityId: events.facilityId,
          status: events.status,
        })
        .from(events)
        .where(eq(events.id, intent.eventId))
        .for('update')
        .limit(1);
      if (event === undefined) {
        throw mediaConflict('The event is unavailable for a photo upload.');
      }
      if (event.status === 'closed') {
        throw mediaConflict('Closed events cannot accept new photos.');
      }
      if (event.facilityId !== intent.facilityId) {
        throw mediaConflict(
          'The event facility changed before the photo upload was reserved.',
        );
      }
      const currentTime = await readDatabaseTime(database);
      const usage = await readMediaUploadResourceUsage(
        database,
        intent,
        currentTime,
      );
      if (mediaUploadBudgetViolation(usage, intent.byteLength) !== null) {
        throw mediaRateLimited();
      }
      await database.insert(mediaUploadIntents).values({
        id: intent.id,
        eventId: intent.eventId,
        facilityId: intent.facilityId,
        budgetPrincipalDigest: intent.budgetPrincipal.digest,
        budgetPrincipalAttributed: true,
        byteLength: intent.byteLength,
        contentSha256: intent.contentSha256,
        declaredContentType: intent.declaredContentType,
        storageKey: intent.storageKey,
        status: 'pending-upload',
        createdAt: intent.createdAt,
        expiresAt: intent.expiresAt,
      });
    },
    async completeUpload(input) {
      await database.insert(mediaRecords).values({
        id: input.record.id,
        uploadIntentId: input.record.uploadIntentId,
        eventId: input.record.eventId,
        status: input.record.status,
        detectedContentType: input.record.detectedContentType,
        sanitizedByteLength: input.record.sanitizedByteLength,
        sanitizedContentSha256: input.record.sanitizedContentSha256,
        storageKey: input.record.storageKey,
        malwareScan: input.record.malwareScan,
        exifStripped: input.record.exifStripped,
        createdAt: new Date(input.record.createdAt),
      });
      const [completed] = await database
        .update(mediaUploadIntents)
        .set({ status: 'completed' })
        .where(
          and(
            eq(mediaUploadIntents.id, input.record.uploadIntentId),
            eq(mediaUploadIntents.eventId, input.record.eventId),
            eq(mediaUploadIntents.status, input.expectedIntentStatus),
          ),
        )
        .returning({ id: mediaUploadIntents.id });
      if (completed === undefined) {
        throw mediaConflict(
          'The photo upload state changed before completion.',
        );
      }
    },
    async listPhotoChecksumExportProjection(eventId) {
      const rows = await buildPhotoChecksumExportQuery(database, eventId);
      return rows.map((row) => Object.freeze({ ...row }));
    },
  };
}

/** Creates the production one-transaction media capability store. */
export function createDrizzleMediaCapabilityStore(
  database: Database,
): MediaCapabilityStore {
  return {
    async transaction<Result>(
      operation: (transaction: MediaCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      let terminalError: TerminalMediaImageRejectionError | null = null;
      const result = await database.transaction(async (transaction) => {
        const query = queryDatabase(transaction);
        const executionState: MediaTransactionExecutionState = {
          newlyClaimedIdempotency: null,
          lockedUploadIntent: null,
        };
        try {
          return await operation(createTransaction(query, executionState));
        } catch (error) {
          if (!(error instanceof TerminalMediaImageRejectionError)) {
            throw error;
          }
          await persistTerminalImageRejection(query, executionState, error);
          terminalError = error;
          return TERMINAL_IMAGE_REJECTION_COMMITTED;
        }
      });

      if (result === TERMINAL_IMAGE_REJECTION_COMMITTED) {
        if (terminalError === null) {
          throw mediaUnavailable();
        }
        // This throw deliberately happens after the database transaction has
        // committed. If commit fails, that persistence error wins instead.
        throw terminalError;
      }
      return result;
    },
    appendCapabilityAudit(event) {
      return database.transaction((transaction) =>
        appendCapabilityAuditEntry(queryDatabase(transaction), event),
      );
    },
  };
}

export interface MediaRepositoryRuntime {
  readonly connection: DatabaseConnection;
  readonly store: MediaCapabilityStore;
}

export function createDefaultMediaRepositoryRuntime(): MediaRepositoryRuntime {
  const connection = createDatabaseClient(readDatabaseConfig());
  return Object.freeze({
    connection,
    store: createDrizzleMediaCapabilityStore(connection.db),
  });
}
