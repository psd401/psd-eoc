import { randomUUID } from 'node:crypto';

import {
  MediaRecordSchema,
  SecurityAuditEntrySchema,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

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
import { ACCESS_GATE_AUDIT_LOCK_SQL } from '../auth/access-gate';
import {
  digestCapabilityValue,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
} from '../capabilities/engine';
import { mediaConflict, mediaRateLimited, mediaUnavailable } from './errors';
import type {
  CompleteMediaRecord,
  MediaBudgetPrincipal,
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
export interface MediaCapabilityTransaction
  extends CapabilityEngineTransaction {
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

interface PrincipalRollingUsageRow extends Record<string, unknown> {
  readonly rollingIntents: number | string;
  readonly rollingBytes: number | string;
}

interface ScopedUploadUsageRow extends Record<string, unknown> {
  readonly activeIntents: number | string;
  readonly activeBytes: number | string;
  readonly rollingIntents: number | string;
  readonly rollingBytes: number | string;
}

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

function mediaBudgetPrincipalPredicate(principal: MediaBudgetPrincipal) {
  switch (principal.kind) {
    case 'human':
      return sql`${idempotencyRecords.principal} ->> 'kind' = 'human'
        and ${idempotencyRecords.principal} ->> 'userId' = ${principal.userId}`;
    case 'agent':
      return sql`${idempotencyRecords.principal} ->> 'kind' = 'agent'
        and ${idempotencyRecords.principal} ->> 'agentId' = ${principal.agentId}`;
    case 'system':
      return sql`${idempotencyRecords.principal} ->> 'kind' = 'system'
        and ${idempotencyRecords.principal} ->> 'serviceId' = ${principal.serviceId}`;
  }
}

async function readMediaUploadResourceUsage(
  database: MediaQueryDatabase,
  input: NewMediaUploadIntent,
  currentTime: Date,
): Promise<MediaUploadResourceUsage> {
  const windowStart = new Date(
    currentTime.getTime() - MEDIA_UPLOAD_BUDGET_WINDOW_SECONDS * 1_000,
  );
  const currentTimeIso = currentTime.toISOString();
  const windowStartIso = windowStart.toISOString();
  const principalPredicate = mediaBudgetPrincipalPredicate(
    input.budgetPrincipal,
  );
  const [principal] = await database.execute<PrincipalRollingUsageRow>(sql`
    select
      count(*)::integer as "rollingIntents",
      coalesce(sum(${mediaUploadIntents.byteLength}), 0)::bigint as "rollingBytes"
    from ${idempotencyRecords}
    left join ${mediaUploadIntents}
      on ${idempotencyRecords.resultReference} = ${mediaUploadIntents.id}::text
    where ${idempotencyRecords.capabilityId} = 'create-media-upload-intent'
      and ${principalPredicate}
      and ${idempotencyRecords.status} = 'completed'
      and ${idempotencyRecords.createdAt} >= ${windowStartIso}::timestamptz
  `);
  const [event] = await database.execute<ScopedUploadUsageRow>(sql`
    select
      count(*) filter (
        where ${mediaUploadIntents.status} = 'pending-upload'
          and ${mediaUploadIntents.expiresAt} > ${currentTimeIso}::timestamptz
      )::integer as "activeIntents",
      coalesce(sum(${mediaUploadIntents.byteLength}) filter (
        where ${mediaUploadIntents.status} = 'pending-upload'
          and ${mediaUploadIntents.expiresAt} > ${currentTimeIso}::timestamptz
      ), 0)::bigint as "activeBytes",
      count(*) filter (
        where ${mediaUploadIntents.createdAt} >= ${windowStartIso}::timestamptz
      )::integer as "rollingIntents",
      coalesce(sum(${mediaUploadIntents.byteLength}) filter (
        where ${mediaUploadIntents.createdAt} >= ${windowStartIso}::timestamptz
      ), 0)::bigint as "rollingBytes"
    from ${mediaUploadIntents}
    where ${mediaUploadIntents.eventId} = ${input.eventId}
  `);
  const [facility] = await database.execute<ScopedUploadUsageRow>(sql`
    select
      count(*) filter (
        where ${mediaUploadIntents.status} = 'pending-upload'
          and ${mediaUploadIntents.expiresAt} > ${currentTimeIso}::timestamptz
      )::integer as "activeIntents",
      coalesce(sum(${mediaUploadIntents.byteLength}) filter (
        where ${mediaUploadIntents.status} = 'pending-upload'
          and ${mediaUploadIntents.expiresAt} > ${currentTimeIso}::timestamptz
      ), 0)::bigint as "activeBytes",
      count(*) filter (
        where ${mediaUploadIntents.createdAt} >= ${windowStartIso}::timestamptz
      )::integer as "rollingIntents",
      coalesce(sum(${mediaUploadIntents.byteLength}) filter (
        where ${mediaUploadIntents.createdAt} >= ${windowStartIso}::timestamptz
      ), 0)::bigint as "rollingBytes"
    from ${mediaUploadIntents}
    inner join ${events}
      on ${events.id} = ${mediaUploadIntents.eventId}
    where ${events.facilityId} = ${input.facilityId}
  `);
  if (
    principal === undefined ||
    event === undefined ||
    facility === undefined
  ) {
    throw mediaUnavailable();
  }
  return Object.freeze({
    principalRollingIntents: resourceUsageValue(principal.rollingIntents),
    principalRollingBytes: resourceUsageValue(principal.rollingBytes),
    eventActiveIntents: resourceUsageValue(event.activeIntents),
    eventActiveBytes: resourceUsageValue(event.activeBytes),
    eventRollingIntents: resourceUsageValue(event.rollingIntents),
    eventRollingBytes: resourceUsageValue(event.rollingBytes),
    facilityActiveIntents: resourceUsageValue(facility.activeIntents),
    facilityActiveBytes: resourceUsageValue(facility.activeBytes),
    facilityRollingIntents: resourceUsageValue(facility.rollingIntents),
    facilityRollingBytes: resourceUsageValue(facility.rollingBytes),
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

async function resolveReadyMedia(
  database: MediaQueryDatabase,
  eventId: string,
  mediaId: string,
): Promise<ResolvedReadyMedia | null> {
  const [row] = await database
    .select({ record: mediaRecords, facilityId: events.facilityId })
    .from(mediaRecords)
    .innerJoin(events, eq(events.id, mediaRecords.eventId))
    .where(and(eq(mediaRecords.id, mediaId), eq(mediaRecords.eventId, eventId)))
    .limit(1);
  return row === undefined
    ? null
    : Object.freeze({
        facilityId: row.facilityId,
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
): MediaCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
    resolveEventFacilityId: (eventId) =>
      resolveEventFacilityId(database, eventId),
    resolveUploadIntent: (uploadIntentId, lock) =>
      resolveUploadIntent(database, uploadIntentId, lock),
    resolveReadyMedia: (eventId, mediaId) =>
      resolveReadyMedia(database, eventId, mediaId),
    async insertUploadIntent(intent) {
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
    transaction<Result>(
      operation: (transaction: MediaCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) =>
        operation(createTransaction(queryDatabase(transaction))),
      );
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
