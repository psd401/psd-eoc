import {
  AttemptDeliveryTruthStateSchema,
  EventSchema,
  JournalEntrySchema,
  projectJournalEntryForRead,
  type AttemptDeliveryTruthState,
  type CapabilityInput,
  type Event,
  type JournalEntry,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';

import { databaseExecuteRows, type DatabaseQuery } from '../../../db/client';
import {
  deliveryEvidence,
  dispatchBatches,
  events,
  eventTypeVersions,
  facilities,
  journalEntries,
  mediaRecords,
  notificationIntentChannels,
  notificationIntents,
} from '../../../db/schema';
import { CapabilityEngineError } from '../engine';
import { activationThreatFromColumns } from '../start-preview';
import type { DrillRecordCsvRow } from './csv';
import type { EventSummarySnapshot } from './pdf';

export const MAX_DRILL_EXPORT_ROWS = 10_000;
export const MAX_EVENT_EXPORT_JOURNAL_ENTRIES = 2_000;
export const MAX_EVENT_EXPORT_NOTIFICATION_INTENTS = 100;

const ATTEMPT_STATES = AttemptDeliveryTruthStateSchema.options;

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function notFound(): CapabilityEngineError {
  return new CapabilityEngineError(
    'NOT_FOUND',
    'PERSISTENCE_CONFLICT',
    'The event was not found.',
    404,
  );
}

function safeCount(value: unknown, field: string, maximum = 100_000): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint' || typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw conflict(`The ${field} evidence is inconsistent.`);
  }
  return parsed;
}

function eventFromRow(row: typeof events.$inferSelect): Event {
  return EventSchema.parse({
    id: row.id,
    facilityId: row.facilityId,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    status: row.status,
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    threat: activationThreatFromColumns(row),
    responseDetail: row.responseDetail ?? null,
    createdBy: row.createdBy,
    createdAt: dateIso(row.createdAt),
    activatedAt: row.activatedAt === null ? null : dateIso(row.activatedAt),
    allClearAt: row.allClearAt === null ? null : dateIso(row.allClearAt),
    reactivatedAt:
      row.reactivatedAt === null ? null : dateIso(row.reactivatedAt),
    closedAt: row.closedAt === null ? null : dateIso(row.closedAt),
    correctionOfEventId: row.correctionOfEventId,
    correctionReason: row.correctionReason,
    activationAuthorization: row.activationAuthorization,
  });
}

function journalEntryFromRow(
  row: typeof journalEntries.$inferSelect,
): JournalEntry {
  return JournalEntrySchema.parse({
    id: row.id,
    eventId: row.eventId,
    sequence: row.sequence,
    kind: row.kind,
    author: row.author,
    authorDisplayName: null,
    source: row.source,
    serverTime: dateIso(row.serverTime),
    clientTime: row.clientTime === null ? null : dateIso(row.clientTime),
    payload: row.payload,
    supersedes:
      row.supersedesEntryId === null ||
      row.supersedesEntrySequence === null ||
      row.supersessionKind === null ||
      row.supersessionReason === null
        ? null
        : {
            entryId: row.supersedesEntryId,
            entrySequence: row.supersedesEntrySequence,
            kind: row.supersessionKind,
            reason: row.supersessionReason,
          },
  });
}

function drillExportConditions(
  input: CapabilityInput<'export-drill-records'>,
): readonly SQL[] {
  const conditions: SQL[] = [
    eq(events.facilityId, input.facilityId),
    inArray(events.kind, ['drill', 'test']),
    eq(events.templateMode, 'drill'),
    eq(eventTypeVersions.templateMode, 'drill'),
    ne(events.status, 'draft'),
    isNotNull(events.activatedAt),
    gte(events.activatedAt, new Date(input.startedFrom)),
    lte(events.activatedAt, new Date(input.startedThrough)),
  ];
  if (input.eventTypeId !== null) {
    conditions.push(eq(eventTypeVersions.eventTypeId, input.eventTypeId));
  }
  return conditions;
}

/**
 * Reads the complete, bounded CSV source set inside the caller's canonical
 * transaction. The SQL repeats the real/drill constraints even after schema
 * validation so a real incident can never be projected as a drill record.
 */
export async function loadDrillRecordsExportSnapshot(
  database: DatabaseQuery,
  input: CapabilityInput<'export-drill-records'>,
): Promise<readonly DrillRecordCsvRow[]> {
  const conditions = drillExportConditions(input);
  const rows = await database
    .select({
      eventId: events.id,
      kind: events.kind,
      status: events.status,
      startedAt: events.activatedAt,
      allClearAt: events.allClearAt,
      facilityName: facilities.name,
      facilityCode: facilities.code,
      eventType: eventTypeVersions.name,
      threatName: events.threatName,
      threatDetail: events.threatDetail,
      responseDetail: events.responseDetail,
    })
    .from(events)
    .innerJoin(facilities, eq(facilities.id, events.facilityId))
    .innerJoin(
      eventTypeVersions,
      and(
        eq(eventTypeVersions.id, events.eventTypeVersionId),
        eq(eventTypeVersions.templateMode, events.templateMode),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(events.activatedAt), asc(events.id))
    .limit(MAX_DRILL_EXPORT_ROWS + 1);

  if (rows.length > MAX_DRILL_EXPORT_ROWS) {
    throw conflict(
      'The drill export contains too many records; narrow the requested range.',
    );
  }

  const participantRows = await database
    .select({
      eventId: journalEntries.eventId,
      participantCount: sql<number>`count(distinct ${journalEntries.payload} ->> 'relatedRecordId')::integer`,
    })
    .from(journalEntries)
    .innerJoin(events, eq(events.id, journalEntries.eventId))
    .innerJoin(
      eventTypeVersions,
      and(
        eq(eventTypeVersions.id, events.eventTypeVersionId),
        eq(eventTypeVersions.templateMode, events.templateMode),
      ),
    )
    .where(
      and(
        ...conditions,
        eq(journalEntries.kind, 'system'),
        sql`${journalEntries.payload} ->> 'code' = 'participant-joined'`,
        sql`${journalEntries.payload} ->> 'relatedRecordId' is not null`,
      ),
    )
    .groupBy(journalEntries.eventId);
  const participantsByEvent = new Map(
    participantRows.map((row) => [
      row.eventId,
      safeCount(row.participantCount, 'recorded participant count', 12_000),
    ]),
  );

  return Object.freeze(
    rows.map((row): DrillRecordCsvRow => {
      if (
        (row.kind !== 'drill' && row.kind !== 'test') ||
        row.startedAt === null
      ) {
        throw conflict(
          'Persisted drill export classification is inconsistent.',
        );
      }
      const durationSeconds =
        row.status === 'active' || row.allClearAt === null
          ? null
          : Math.floor(
              (row.allClearAt.getTime() - row.startedAt.getTime()) / 1_000,
            );
      if (durationSeconds !== null && durationSeconds < 0) {
        throw conflict('Persisted drill duration is inconsistent.');
      }
      return Object.freeze({
        facilityName: row.facilityName,
        facilityCode: row.facilityCode,
        eventType: row.eventType,
        threatName: row.threatName,
        threatDetail: row.threatDetail,
        responseDetail: row.responseDetail ?? null,
        kind: row.kind,
        startedAt: dateIso(row.startedAt),
        durationSeconds,
        participantCount: participantsByEvent.get(row.eventId) ?? 0,
      });
    }),
  );
}

interface DeliveryAggregateRow extends Record<string, unknown> {
  readonly batchId: string;
  readonly attemptCount: number | string | bigint;
  readonly noEvidenceCount: number | string | bigint;
  readonly attemptedCount: number | string | bigint;
  readonly providerAcceptedCount: number | string | bigint;
  readonly deliveredCount: number | string | bigint;
  readonly failedCount: number | string | bigint;
  readonly expiredCount: number | string | bigint;
  readonly unknownCount: number | string | bigint;
}

interface ParsedDeliveryAggregate {
  readonly attemptCount: number;
  readonly noEvidenceCount: number;
  readonly stateCounts: Readonly<Record<AttemptDeliveryTruthState, number>>;
}

async function loadDeliveryAggregates(
  database: DatabaseQuery,
  eventId: string,
): Promise<ReadonlyMap<string, ParsedDeliveryAggregate>> {
  const rows = databaseExecuteRows(
    await database.execute<DeliveryAggregateRow>(sql`
      with latest_attempts as (
        select distinct on (attempt.batch_id, attempt.endpoint_id)
          attempt.id,
          attempt.batch_id
        from channel_attempts as attempt
        where attempt.event_id = ${eventId}::uuid
        order by
          attempt.batch_id,
          attempt.endpoint_id,
          attempt.attempt_number desc,
          attempt.attempted_at desc,
          attempt.id desc
      ),
      latest_evidence as (
        select distinct on (evidence.attempt_id)
          evidence.attempt_id,
          evidence.state
        from delivery_evidence as evidence
        inner join latest_attempts
          on latest_attempts.id = evidence.attempt_id
        where evidence.subject_kind = 'attempt'
        order by evidence.attempt_id, evidence.sequence desc
      )
      select
        latest_attempts.batch_id as "batchId",
        count(*)::integer as "attemptCount",
        count(*) filter (
          where latest_evidence.attempt_id is null
        )::integer as "noEvidenceCount",
        count(*) filter (
          where latest_evidence.state = 'attempted'
        )::integer as "attemptedCount",
        count(*) filter (
          where latest_evidence.state = 'provider-accepted'
        )::integer as "providerAcceptedCount",
        count(*) filter (
          where latest_evidence.state = 'delivered'
        )::integer as "deliveredCount",
        count(*) filter (
          where latest_evidence.state = 'failed'
        )::integer as "failedCount",
        count(*) filter (
          where latest_evidence.state = 'expired'
        )::integer as "expiredCount",
        count(*) filter (
          where latest_evidence.state = 'unknown'
        )::integer as "unknownCount"
      from latest_attempts
      left join latest_evidence
        on latest_evidence.attempt_id = latest_attempts.id
      group by latest_attempts.batch_id
    `),
  );

  return new Map(
    rows.map((row) => {
      const counts: Readonly<Record<AttemptDeliveryTruthState, number>> =
        Object.freeze({
          attempted: safeCount(row.attemptedCount, 'attempted count', 12_000),
          'provider-accepted': safeCount(
            row.providerAcceptedCount,
            'provider-accepted count',
            12_000,
          ),
          delivered: safeCount(row.deliveredCount, 'delivered count', 12_000),
          failed: safeCount(row.failedCount, 'failed count', 12_000),
          expired: safeCount(row.expiredCount, 'expired count', 12_000),
          unknown: safeCount(row.unknownCount, 'unknown count', 12_000),
        });
      return [
        row.batchId,
        Object.freeze({
          attemptCount: safeCount(row.attemptCount, 'attempt count', 12_000),
          noEvidenceCount: safeCount(
            row.noEvidenceCount,
            'attempt evidence gap count',
            12_000,
          ),
          stateCounts: counts,
        }),
      ] as const;
    }),
  );
}

/** Reads one complete event-report snapshot without recipient destinations. */
export async function loadEventSummarySnapshot(
  database: DatabaseQuery,
  eventId: string,
  generatedAt: string,
): Promise<EventSummarySnapshot> {
  const [header] = await database
    .select({
      event: events,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      eventTypeId: eventTypeVersions.id,
      eventTypeName: eventTypeVersions.name,
    })
    .from(events)
    .innerJoin(facilities, eq(facilities.id, events.facilityId))
    .innerJoin(
      eventTypeVersions,
      and(
        eq(eventTypeVersions.id, events.eventTypeVersionId),
        eq(eventTypeVersions.templateMode, events.templateMode),
      ),
    )
    .where(eq(events.id, eventId))
    .limit(1);
  if (header === undefined) throw notFound();
  const event = eventFromRow(header.event);

  const journalRows = await database
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.eventId, eventId))
    .orderBy(asc(journalEntries.sequence))
    .limit(MAX_EVENT_EXPORT_JOURNAL_ENTRIES + 1);
  if (journalRows.length > MAX_EVENT_EXPORT_JOURNAL_ENTRIES) {
    throw conflict(
      'The event journal is too large to export without truncating history.',
    );
  }
  const entries = journalRows.map(journalEntryFromRow);
  entries.forEach((entry, index) => {
    if (entry.sequence !== index + 1) {
      throw conflict('The event journal sequence is incomplete.');
    }
  });
  const entryKeys = new Set(
    entries.map((entry) => `${entry.id}:${entry.sequence}`),
  );
  const redactedKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.supersedes?.kind !== 'redaction') continue;
    const target = `${entry.supersedes.entryId}:${entry.supersedes.entrySequence}`;
    if (!entryKeys.has(target)) {
      throw conflict('The event journal supersession history is incomplete.');
    }
    redactedKeys.add(target);
  }
  const journal = Object.freeze(
    entries.map((entry) =>
      projectJournalEntryForRead(
        entry,
        redactedKeys.has(`${entry.id}:${entry.sequence}`),
      ),
    ),
  );

  const visiblePhotos = journal.flatMap((projection) =>
    projection.visibility === 'visible' && projection.entry.kind === 'photo'
      ? [projection.entry]
      : [],
  );
  const mediaIds = [
    ...new Set(visiblePhotos.map((entry) => entry.payload.mediaId)),
  ];
  const photoRows =
    mediaIds.length === 0
      ? []
      : await database
          .select({
            mediaId: mediaRecords.id,
            eventId: mediaRecords.eventId,
            sanitizedContentSha256: mediaRecords.sanitizedContentSha256,
            sanitizedByteLength: mediaRecords.sanitizedByteLength,
            detectedContentType: mediaRecords.detectedContentType,
          })
          .from(mediaRecords)
          .where(
            and(
              eq(mediaRecords.eventId, eventId),
              inArray(mediaRecords.id, mediaIds),
            ),
          );
  const photosByMediaId = new Map(photoRows.map((row) => [row.mediaId, row]));
  const photos = Object.freeze(
    visiblePhotos.map((entry) => {
      const row = photosByMediaId.get(entry.payload.mediaId);
      if (row === undefined || row.eventId !== eventId) {
        throw conflict(
          'A visible journal photo is missing sanitized evidence.',
        );
      }
      return Object.freeze({
        journalEntryId: entry.id,
        mediaId: row.mediaId,
        sanitizedContentSha256: row.sanitizedContentSha256,
        sanitizedByteLength: row.sanitizedByteLength,
        detectedContentType: row.detectedContentType,
      });
    }),
  );

  const recordedParticipantIds = new Set(
    entries.flatMap((entry) =>
      entry.kind === 'system' &&
      entry.payload.code === 'participant-joined' &&
      entry.payload.relatedRecordId !== null
        ? [entry.payload.relatedRecordId]
        : [],
    ),
  );

  const intentRows = await database
    .select({
      id: notificationIntents.id,
      purpose: notificationIntents.purpose,
      createdAt: notificationIntents.createdAt,
    })
    .from(notificationIntents)
    .where(eq(notificationIntents.eventId, eventId))
    .orderBy(asc(notificationIntents.createdAt), asc(notificationIntents.id))
    .limit(MAX_EVENT_EXPORT_NOTIFICATION_INTENTS + 1);
  if (intentRows.length > MAX_EVENT_EXPORT_NOTIFICATION_INTENTS) {
    throw conflict(
      'The event has too many notification intents to export without truncation.',
    );
  }
  const intentIds = intentRows.map((row) => row.id);
  const intentEvidenceRows =
    intentIds.length === 0
      ? []
      : await database
          .select({
            intentId: deliveryEvidence.intentId,
            state: deliveryEvidence.state,
            sequence: deliveryEvidence.sequence,
          })
          .from(deliveryEvidence)
          .where(
            and(
              eq(deliveryEvidence.subjectKind, 'intent'),
              inArray(deliveryEvidence.intentId, intentIds),
            ),
          )
          .orderBy(asc(deliveryEvidence.sequence));
  const explicitIntentState = new Map<string, 'accepted' | 'recorded'>();
  for (const evidence of intentEvidenceRows) {
    if (
      evidence.intentId === null ||
      (evidence.state !== 'accepted' && evidence.state !== 'recorded')
    ) {
      throw conflict('Notification intent evidence is inconsistent.');
    }
    explicitIntentState.set(evidence.intentId, evidence.state);
  }

  const channelPlanRows =
    intentIds.length === 0
      ? []
      : await database
          .select({
            intentId: notificationIntentChannels.intentId,
            channel: notificationIntentChannels.channel,
            sequence: notificationIntentChannels.sequence,
            endpointCount: notificationIntentChannels.endpointCount,
          })
          .from(notificationIntentChannels)
          .where(inArray(notificationIntentChannels.intentId, intentIds))
          .orderBy(
            asc(notificationIntentChannels.intentId),
            asc(notificationIntentChannels.sequence),
          );
  if (channelPlanRows.length > MAX_EVENT_EXPORT_NOTIFICATION_INTENTS * 3) {
    throw conflict('Notification channel evidence is inconsistent.');
  }

  const batchRows =
    intentIds.length === 0
      ? []
      : await database
          .select({
            id: dispatchBatches.id,
            intentId: dispatchBatches.intentId,
            channel: dispatchBatches.channel,
            sequence: dispatchBatches.sequence,
            endpointCount: dispatchBatches.endpointCount,
          })
          .from(dispatchBatches)
          .where(inArray(dispatchBatches.intentId, intentIds))
          .orderBy(
            asc(dispatchBatches.intentId),
            asc(dispatchBatches.sequence),
          );
  if (batchRows.length > channelPlanRows.length) {
    throw conflict('Notification dispatch evidence is inconsistent.');
  }
  const aggregates = await loadDeliveryAggregates(database, eventId);
  const plansByIntent = new Map<string, typeof channelPlanRows>();
  const planByKey = new Map<string, (typeof channelPlanRows)[number]>();
  for (const plan of channelPlanRows) {
    const key = `${plan.intentId}:${plan.channel}`;
    if (planByKey.has(key)) {
      throw conflict('Notification channel plan evidence is inconsistent.');
    }
    planByKey.set(key, plan);
    const retained = plansByIntent.get(plan.intentId) ?? [];
    retained.push(plan);
    plansByIntent.set(plan.intentId, retained);
  }
  const batchesByPlan = new Map<string, (typeof batchRows)[number]>();
  for (const batch of batchRows) {
    const key = `${batch.intentId}:${batch.channel}`;
    const plan = planByKey.get(key);
    if (
      plan === undefined ||
      plan.sequence !== batch.sequence ||
      plan.endpointCount !== batch.endpointCount ||
      batchesByPlan.has(key)
    ) {
      throw conflict('Notification dispatch evidence is inconsistent.');
    }
    batchesByPlan.set(key, batch);
  }

  const delivery = Object.freeze(
    intentRows.map((intent) => {
      const plans = plansByIntent.get(intent.id) ?? [];
      if (
        plans.length < 2 ||
        !plans.some((plan) => plan.channel === 'push') ||
        !plans.some((plan) => plan.channel === 'email') ||
        plans.some((plan, index) => plan.sequence !== index + 1)
      ) {
        throw conflict('Notification channel plan evidence is incomplete.');
      }
      return Object.freeze({
        purpose: intent.purpose,
        createdAt: dateIso(intent.createdAt),
        explicitIntentState: explicitIntentState.get(intent.id) ?? null,
        channels: Object.freeze(
          plans.map((plan) => {
            const batch = batchesByPlan.get(`${intent.id}:${plan.channel}`);
            if (
              batch !== undefined &&
              (batch.sequence !== plan.sequence ||
                batch.endpointCount !== plan.endpointCount)
            ) {
              throw conflict('Notification dispatch evidence is inconsistent.');
            }
            const aggregate =
              batch === undefined ? undefined : aggregates.get(batch.id);
            const retainedAggregate = aggregate ?? {
              attemptCount: 0,
              noEvidenceCount: 0,
              stateCounts: Object.freeze(
                Object.fromEntries(
                  ATTEMPT_STATES.map((state) => [state, 0]),
                ) as Record<AttemptDeliveryTruthState, number>,
              ),
            };
            if (
              retainedAggregate.attemptCount > plan.endpointCount ||
              retainedAggregate.noEvidenceCount > retainedAggregate.attemptCount
            ) {
              throw conflict('Notification attempt evidence is inconsistent.');
            }
            const countedStates = ATTEMPT_STATES.reduce(
              (total, state) => total + retainedAggregate.stateCounts[state],
              0,
            );
            if (
              countedStates + retainedAggregate.noEvidenceCount !==
              retainedAggregate.attemptCount
            ) {
              throw conflict('Notification state evidence is inconsistent.');
            }
            return Object.freeze({
              channel: plan.channel,
              plannedEndpointCount: plan.endpointCount,
              noAttemptRecordCount:
                plan.endpointCount - retainedAggregate.attemptCount,
              noEvidenceCount: retainedAggregate.noEvidenceCount,
              stateCounts: Object.freeze(
                ATTEMPT_STATES.map((state) =>
                  Object.freeze({
                    state,
                    count: retainedAggregate.stateCounts[state],
                  }),
                ),
              ),
            });
          }),
        ),
      });
    }),
  );

  return Object.freeze({
    generatedAt,
    event,
    facility: Object.freeze({
      code: header.facilityCode,
      name: header.facilityName,
    }),
    eventType: Object.freeze({
      id: header.eventTypeId,
      name: header.eventTypeName,
    }),
    threat: event.threat,
    responseDetail: event.responseDetail,
    recordedParticipantCount: recordedParticipantIds.size,
    journal,
    photos,
    delivery,
  });
}
