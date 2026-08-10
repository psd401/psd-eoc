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
import { mediaConflict } from './errors';
import type {
  CompleteMediaRecord,
  NewMediaUploadIntent,
  PhotoChecksumExportProjection,
  StoredMediaRecord,
  StoredMediaUploadIntent,
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
      const [event] = await database
        .select({ id: events.id, status: events.status })
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
