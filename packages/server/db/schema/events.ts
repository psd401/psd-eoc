import { sql } from 'drizzle-orm';

import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  rosterPopulationEnum,
  eventKindEnum,
  templateModeEnum,
  notificationPurposeEnum,
  eventStatusEnum,
  eventTransitionKindEnum,
  invocationSourceEnum,
  journalEntryKindEnum,
  journalSupersessionKindEnum,
  mediaContentTypeEnum,
  humanConfirmationStatusEnum,
} from './enums';

import { digest, occurredAt } from './shared';

import { facilities, threats } from './configuration';

import { humanConfirmationRecords } from './identity';

import { rosterSnapshots } from './roster';

import { eventTypeVersions } from './event-types';
/** Short-lived, non-mutating activation consequence previews. */
export const activationPreviews = pgTable(
  'activation_previews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    kind: eventKindEnum('kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    // The threat is pinned by id and by the name shown when it was chosen.
    // Null only for a monthly delivery test, which has no threat scenario,
    // and for rows that predate the catalog.
    threatId: uuid('threat_id').references(() => threats.id, {
      onDelete: 'restrict',
    }),
    threatName: varchar('threat_name', { length: 160 }),
    threatDetail: varchar('threat_detail', { length: 200 }),
    responseDetail: varchar('response_detail', { length: 200 }),
    recipientCount: integer('recipient_count').notNull(),
    channels: jsonb('channels').notNull(),
    sendReadiness: varchar('send_readiness', { length: 16 }).notNull(),
    blockingReasonCodes: jsonb('blocking_reason_codes').notNull(),
    activeEventIds: jsonb('active_event_ids').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
  },
  (table) => [
    unique('activation_previews_preparation_anchor_uq').on(
      table.id,
      table.facilityId,
      table.kind,
      table.templateMode,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
      table.consequenceDigest,
    ),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'activation_previews_event_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'activation_previews_roster_population_fk',
    }).onDelete('restrict'),
    check(
      'activation_previews_classification',
      sql`(
        ${table.kind} = 'incident' and ${table.templateMode} = 'real'
        and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.kind} = 'drill' and ${table.templateMode} = 'drill'
      ) or (
        ${table.kind} = 'test' and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
    check(
      'activation_previews_count',
      sql`${table.recipientCount} between 0 and 1200`,
    ),
    check(
      'activation_previews_readiness',
      sql`${table.sendReadiness} in ('ready', 'blocked')`,
    ),
    check(
      'activation_previews_expiry',
      sql`${table.expiresAt} >= ${table.createdAt}
        and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
    check(
      'activation_previews_digest_format',
      sql`${table.consequenceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'activation_previews_threat_pair',
      sql`(${table.threatId} is null) = (${table.threatName} is null)
        and (${table.threatDetail} is null or ${table.threatId} is not null)`,
    ),
    check(
      'activation_previews_detail_nonempty',
      sql`(${table.threatDetail} is null or length(btrim(${table.threatDetail})) > 0)
        and (${table.responseDetail} is null or length(btrim(${table.responseDetail})) > 0)`,
    ),
  ],
);

/** Agent- or human-authored preparation that still requires human consumption. */
export const preparedActivations = pgTable(
  'prepared_activations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    activationPreviewId: uuid('activation_preview_id').notNull(),
    facilityId: uuid('facility_id').notNull(),
    kind: eventKindEnum('kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    preparedBy: jsonb('prepared_by').notNull(),
    preparedAt: occurredAt('prepared_at').defaultNow().notNull(),
  },
  (table) => [
    unique('prepared_activations_preview_uq').on(table.activationPreviewId),
    unique('prepared_activations_consumption_anchor_uq').on(
      table.id,
      table.facilityId,
      table.kind,
      table.templateMode,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
      table.consequenceDigest,
    ),
    foreignKey({
      columns: [
        table.activationPreviewId,
        table.facilityId,
        table.kind,
        table.templateMode,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
        table.consequenceDigest,
      ],
      foreignColumns: [
        activationPreviews.id,
        activationPreviews.facilityId,
        activationPreviews.kind,
        activationPreviews.templateMode,
        activationPreviews.eventTypeVersionId,
        activationPreviews.rosterSnapshotId,
        activationPreviews.rosterPopulation,
        activationPreviews.consequenceDigest,
      ],
      name: 'prepared_activations_preview_truth_fk',
    }).onDelete('restrict'),
    check(
      'prepared_activations_staff_only',
      sql`${table.rosterPopulation} = 'staff'`,
    ),
    check(
      'prepared_activations_non_system_actor',
      sql`(${table.preparedBy} ->> 'kind' in ('human', 'agent')) is true`,
    ),
  ],
);

/** Operational events with immutable real/drill classification. */
export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    kind: eventKindEnum('kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    status: eventStatusEnum('status').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id'),
    rosterPopulation: rosterPopulationEnum('roster_population'),
    // Copied from the consumed preview at activation. Null for events that
    // predate the threat catalog; the history is never backfilled.
    threatId: uuid('threat_id').references(() => threats.id, {
      onDelete: 'restrict',
    }),
    threatName: varchar('threat_name', { length: 160 }),
    threatDetail: varchar('threat_detail', { length: 200 }),
    responseDetail: varchar('response_detail', { length: 200 }),
    createdBy: jsonb('created_by').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    activatedAt: occurredAt('activated_at'),
    allClearAt: occurredAt('all_clear_at'),
    reactivatedAt: occurredAt('reactivated_at'),
    closedAt: occurredAt('closed_at'),
    correctionOfEventId: uuid('correction_of_event_id'),
    correctionReason: varchar('correction_reason', { length: 1000 }),
    activationAuthorization: jsonb('activation_authorization'),
  },
  (table) => [
    unique('events_identity_facility_uq').on(table.id, table.facilityId),
    unique('events_identity_classification_uq').on(
      table.id,
      table.kind,
      table.templateMode,
    ),
    unique('events_identity_targeting_uq').on(
      table.id,
      table.kind,
      table.templateMode,
      table.rosterPopulation,
    ),
    unique('events_notification_anchor_uq').on(
      table.id,
      table.kind,
      table.templateMode,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
    ),
    unique('events_prepared_activation_anchor_uq').on(
      table.id,
      table.facilityId,
      table.kind,
      table.templateMode,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
    ),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'events_event_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'events_roster_population_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.correctionOfEventId, table.kind, table.templateMode],
      foreignColumns: [table.id, table.kind, table.templateMode],
      name: 'events_correction_source_classification_fk',
    }).onDelete('restrict'),
    index('events_active_facility_idx').on(table.facilityId, table.status),
    check(
      'events_classification',
      sql`(
        ${table.kind} = 'incident' and ${table.templateMode} = 'real'
      ) or (
        ${table.kind} in ('drill', 'test') and ${table.templateMode} = 'drill'
      )`,
    ),
    check(
      'events_targeting',
      sql`${table.rosterPopulation} is null or (
        ${table.kind} = 'incident' and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.kind} = 'drill'
      ) or (
        ${table.kind} = 'test' and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
    check(
      'events_draft_or_activated',
      sql`(
        ${table.status} = 'draft'
        and ${table.rosterSnapshotId} is null
        and ${table.rosterPopulation} is null
        and ${table.activatedAt} is null
        and ${table.allClearAt} is null
        and ${table.reactivatedAt} is null
        and ${table.closedAt} is null
        and ${table.activationAuthorization} is null
      ) or (
        ${table.status} <> 'draft'
        and ${table.rosterSnapshotId} is not null
        and ${table.rosterPopulation} is not null
        and ${table.activatedAt} is not null
        and ${table.activationAuthorization} is not null
      )`,
    ),
    check(
      'events_activation_authorization_truth',
      sql`${table.status} = 'draft' or case
        when ${table.rosterPopulation} = 'staff' then
          ${table.createdBy} ->> 'kind' is not distinct from 'human'
          and ${table.activationAuthorization} ->> 'kind' is not distinct from 'human-confirmed'
        when ${table.rosterPopulation} = 'synthetic' then
          ${table.activationAuthorization} ->> 'kind' is not distinct from 'synthetic-training'
        else false
      end`,
    ),
    check(
      'events_lifecycle_state',
      sql`(
        ${table.status} = 'draft'
      ) or (
        ${table.status} = 'active'
        and ${table.closedAt} is null
        and (
          (${table.allClearAt} is null and ${table.reactivatedAt} is null)
          or (${table.allClearAt} is not null and ${table.reactivatedAt} is not null)
        )
      ) or (
        ${table.status} = 'all-clear'
        and ${table.allClearAt} is not null
        and ${table.closedAt} is null
      ) or (
        ${table.status} = 'closed'
        and ${table.allClearAt} is not null
        and ${table.closedAt} is not null
      )`,
    ),
    check(
      'events_correction_pair',
      sql`(${table.correctionOfEventId} is null) = (${table.correctionReason} is null)
        and (${table.correctionOfEventId} is null or ${table.correctionOfEventId} <> ${table.id})`,
    ),
    check(
      'events_threat_pair',
      sql`(${table.threatId} is null) = (${table.threatName} is null)
        and (${table.threatDetail} is null or ${table.threatId} is not null)`,
    ),
    check(
      'events_detail_nonempty',
      sql`(${table.threatDetail} is null or length(btrim(${table.threatDetail})) > 0)
        and (${table.responseDetail} is null or length(btrim(${table.responseDetail})) > 0)`,
    ),
  ],
);

/** Short-lived lifecycle consequence previews for all-clear/reactivation. */
export const lifecycleConsequencePreviews = pgTable(
  'lifecycle_consequence_previews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    kind: eventKindEnum('kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    recipientCount: integer('recipient_count').notNull(),
    channels: jsonb('channels').notNull(),
    sendReadiness: varchar('send_readiness', { length: 16 }).notNull(),
    blockingReasonCodes: jsonb('blocking_reason_codes').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.eventId,
        table.kind,
        table.templateMode,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
      ],
      foreignColumns: [
        events.id,
        events.kind,
        events.templateMode,
        events.eventTypeVersionId,
        events.rosterSnapshotId,
        events.rosterPopulation,
      ],
      name: 'lifecycle_consequence_previews_event_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'lifecycle_consequence_previews_event_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'lifecycle_consequence_previews_roster_population_fk',
    }).onDelete('restrict'),
    check(
      'lifecycle_consequence_previews_purpose',
      sql`${table.purpose} in ('all-clear', 'reactivation')`,
    ),
    check(
      'lifecycle_consequence_previews_classification',
      sql`(
        ${table.kind} = 'incident' and ${table.templateMode} = 'real'
        and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.kind} = 'drill' and ${table.templateMode} = 'drill'
      ) or (
        ${table.kind} = 'test' and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
    check(
      'lifecycle_consequence_previews_count',
      sql`${table.recipientCount} between 0 and 1200`,
    ),
    check(
      'lifecycle_consequence_previews_expiry',
      sql`${table.expiresAt} >= ${table.createdAt}
        and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
  ],
);

/** Append-only evidence for every allowed event lifecycle transition. */
export const eventTransitions = pgTable(
  'event_transitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sequence: integer('sequence').notNull(),
    transition: eventTransitionKindEnum('transition').notNull(),
    eventId: uuid('event_id'),
    sourceEventId: uuid('source_event_id'),
    correctionEventId: uuid('correction_event_id'),
    journalEventId: uuid('journal_event_id').notNull(),
    fromStatus: eventStatusEnum('from_status').notNull(),
    toStatus: eventStatusEnum('to_status').notNull(),
    kind: eventKindEnum('kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    actor: jsonb('actor').notNull(),
    source: invocationSourceEnum('source').notNull(),
    occurredAt: occurredAt('occurred_at').notNull(),
    requestId: uuid('request_id').notNull(),
    confirmationId: uuid('confirmation_id').references(
      () => humanConfirmationRecords.id,
      { onDelete: 'restrict' },
    ),
    confirmationStatus: humanConfirmationStatusEnum('confirmation_status'),
    consequenceDigest: digest('consequence_digest'),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    activationAuthorization: jsonb('activation_authorization'),
    notificationAuthorization: jsonb('notification_authorization'),
    correctionReason: varchar('correction_reason', { length: 1000 }),
  },
  (table) => [
    uniqueIndex('event_transitions_request_uq').on(table.requestId),
    uniqueIndex('event_transitions_idempotency_uq').on(table.idempotencyKey),
    unique('event_transitions_journal_event_uq').on(
      table.id,
      table.journalEventId,
    ),
    foreignKey({
      columns: [
        table.eventId,
        table.kind,
        table.templateMode,
        table.rosterPopulation,
      ],
      foreignColumns: [
        events.id,
        events.kind,
        events.templateMode,
        events.rosterPopulation,
      ],
      name: 'event_transitions_event_targeting_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.sourceEventId,
        table.kind,
        table.templateMode,
        table.rosterPopulation,
      ],
      foreignColumns: [
        events.id,
        events.kind,
        events.templateMode,
        events.rosterPopulation,
      ],
      name: 'event_transitions_source_event_targeting_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.correctionEventId, table.kind, table.templateMode],
      foreignColumns: [events.id, events.kind, events.templateMode],
      name: 'event_transitions_correction_event_classification_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.journalEventId],
      foreignColumns: [events.id],
      name: 'event_transitions_journal_event_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.confirmationId,
        table.confirmationStatus,
        table.requestId,
        table.consequenceDigest,
      ],
      foreignColumns: [
        humanConfirmationRecords.id,
        humanConfirmationRecords.status,
        humanConfirmationRecords.consumedForRequestId,
        humanConfirmationRecords.consequenceDigest,
      ],
      name: 'event_transitions_consumed_confirmation_fk',
    }).onDelete('restrict'),
    check('event_transitions_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'event_transitions_confirmation_status',
      sql`(
        ${table.confirmationId} is null
        and ${table.confirmationStatus} is null
        and ${table.consequenceDigest} is null
      ) or (
        ${table.confirmationId} is not null
        and ${table.confirmationStatus} = 'consumed'
        and ${table.consequenceDigest} is not null
      )`,
    ),
    check(
      'event_transitions_protected_human_boundary',
      sql`case
        when ${table.transition} in ('activate', 'all-clear', 'reactivate')
          and ${table.rosterPopulation} = 'staff' then
          ${table.confirmationId} is not null
          and (${table.actor} ->> 'kind' is not distinct from 'human')
        when ${table.transition} = 'close' and ${table.kind} = 'incident' then
          ${table.confirmationId} is not null
          and (${table.actor} ->> 'kind' is not distinct from 'human')
        when ${table.transition} = 'close'
          and ${table.rosterPopulation} = 'staff' then
          ${table.confirmationId} is null
          and (${table.actor} ->> 'kind' is not distinct from 'human')
        else ${table.confirmationId} is null
      end`,
    ),
    check(
      'event_transitions_actor_source',
      sql`case ${table.actor} ->> 'kind'
        when 'human' then ${table.source} in ('web', 'mobile')
        when 'agent' then ${table.source} in ('agent-rest', 'mcp')
        when 'system' then ${table.source} in ('worker', 'scheduled-job', 'webhook')
        else false
      end`,
    ),
    check(
      'event_transitions_classification',
      sql`(
        ${table.kind} = 'incident' and ${table.templateMode} = 'real'
        and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.kind} = 'drill' and ${table.templateMode} = 'drill'
      ) or (
        ${table.kind} = 'test' and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
    check(
      'event_transitions_variant',
      sql`(
        ${table.transition} = 'activate'
        and ${table.eventId} is not null
        and ${table.journalEventId} = ${table.eventId}
        and ${table.sourceEventId} is null
        and ${table.correctionEventId} is null
        and ${table.fromStatus} = 'draft'
        and ${table.toStatus} = 'active'
        and ${table.activationAuthorization} is not null
        and ${table.notificationAuthorization} is null
        and ${table.correctionReason} is null
      ) or (
        ${table.transition} = 'all-clear'
        and ${table.eventId} is not null
        and ${table.journalEventId} = ${table.eventId}
        and ${table.sourceEventId} is null
        and ${table.correctionEventId} is null
        and ${table.fromStatus} = 'active'
        and ${table.toStatus} = 'all-clear'
        and ${table.activationAuthorization} is null
        and ${table.notificationAuthorization} is not null
        and ${table.correctionReason} is null
      ) or (
        ${table.transition} = 'reactivate'
        and ${table.eventId} is not null
        and ${table.journalEventId} = ${table.eventId}
        and ${table.sourceEventId} is null
        and ${table.correctionEventId} is null
        and ${table.fromStatus} = 'all-clear'
        and ${table.toStatus} = 'active'
        and ${table.activationAuthorization} is null
        and ${table.notificationAuthorization} is not null
        and ${table.correctionReason} is null
      ) or (
        ${table.transition} = 'close'
        and ${table.eventId} is not null
        and ${table.journalEventId} = ${table.eventId}
        and ${table.sourceEventId} is null
        and ${table.correctionEventId} is null
        and ${table.fromStatus} = 'all-clear'
        and ${table.toStatus} = 'closed'
        and ${table.activationAuthorization} is null
        and ${table.notificationAuthorization} is null
        and ${table.correctionReason} is null
      ) or (
        ${table.transition} = 'reopen-as-correction'
        and ${table.eventId} is null
        and ${table.sourceEventId} is not null
        and ${table.correctionEventId} is not null
        and ${table.journalEventId} = ${table.correctionEventId}
        and ${table.sourceEventId} <> ${table.correctionEventId}
        and ${table.fromStatus} = 'closed'
        and ${table.toStatus} = 'draft'
        and ${table.activationAuthorization} is null
        and ${table.notificationAuthorization} is null
        and ${table.correctionReason} is not null
      )`,
    ),
  ],
);

/** Single-use, append-only human consumption of a prepared activation. */
export const preparedActivationConsumptions = pgTable(
  'prepared_activation_consumptions',
  {
    preparedActivationId: uuid('prepared_activation_id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    facilityId: uuid('facility_id').notNull(),
    kind: eventKindEnum('kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    authorization: jsonb('authorization').notNull(),
    requestId: uuid('request_id').notNull(),
    consumedBy: jsonb('consumed_by').notNull(),
    consumedAt: occurredAt('consumed_at').defaultNow().notNull(),
  },
  (table) => [
    unique('prepared_activation_consumptions_request_uq').on(table.requestId),
    foreignKey({
      columns: [
        table.preparedActivationId,
        table.facilityId,
        table.kind,
        table.templateMode,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
        table.consequenceDigest,
      ],
      foreignColumns: [
        preparedActivations.id,
        preparedActivations.facilityId,
        preparedActivations.kind,
        preparedActivations.templateMode,
        preparedActivations.eventTypeVersionId,
        preparedActivations.rosterSnapshotId,
        preparedActivations.rosterPopulation,
        preparedActivations.consequenceDigest,
      ],
      name: 'prepared_activation_consumptions_preparation_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.eventId,
        table.facilityId,
        table.kind,
        table.templateMode,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
      ],
      foreignColumns: [
        events.id,
        events.facilityId,
        events.kind,
        events.templateMode,
        events.eventTypeVersionId,
        events.rosterSnapshotId,
        events.rosterPopulation,
      ],
      name: 'prepared_activation_consumptions_event_truth_fk',
    }).onDelete('restrict'),
    check(
      'prepared_activation_consumptions_human_authorization',
      sql`(${table.consumedBy} ->> 'kind' = 'human'
        and ${table.authorization} ->> 'kind' = 'human-confirmed'
        and ${table.authorization} ->> 'preparedActivationId' = ${table.preparedActivationId}::text
        and ${table.authorization} ->> 'requestId' = ${table.requestId}::text
        and ${table.authorization} ->> 'consequenceDigest' = ${table.consequenceDigest}) is true`,
    ),
  ],
);

/** Private, bounded media upload intents. */
export const mediaUploadIntents = pgTable(
  'media_upload_intents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    /** Trusted event-derived anchor; clients never supply this value. */
    facilityId: uuid('facility_id').notNull(),
    /** Stable one-way identity shared across sessions and API-key rotations. */
    budgetPrincipalDigest: digest('budget_principal_digest').notNull(),
    /** False exists only for safely quarantined rows predating attribution. */
    budgetPrincipalAttributed: boolean('budget_principal_attributed')
      .default(true)
      .notNull(),
    byteLength: integer('byte_length').notNull(),
    contentSha256: digest('content_sha256').notNull(),
    declaredContentType: mediaContentTypeEnum(
      'declared_content_type',
    ).notNull(),
    storageKey: text('storage_key').notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
  },
  (table) => [
    unique('media_upload_intents_identity_event_uq').on(
      table.id,
      table.eventId,
    ),
    foreignKey({
      columns: [table.eventId, table.facilityId],
      foreignColumns: [events.id, events.facilityId],
      name: 'media_upload_intents_event_facility_fk',
    }).onDelete('restrict'),
    uniqueIndex('media_upload_intents_storage_key_uq').on(table.storageKey),
    index('media_upload_intents_budget_principal_created_idx').on(
      table.budgetPrincipalDigest,
      table.createdAt,
    ),
    index('media_upload_intents_unattributed_created_idx').on(
      table.budgetPrincipalAttributed,
      table.createdAt,
    ),
    index('media_upload_intents_event_active_idx').on(
      table.eventId,
      table.status,
      table.expiresAt,
    ),
    index('media_upload_intents_event_created_idx').on(
      table.eventId,
      table.createdAt,
    ),
    index('media_upload_intents_facility_active_idx').on(
      table.facilityId,
      table.status,
      table.expiresAt,
    ),
    index('media_upload_intents_facility_created_idx').on(
      table.facilityId,
      table.createdAt,
    ),
    check(
      'media_upload_intents_budget_principal_digest_format',
      sql`${table.budgetPrincipalDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'media_upload_intents_budget_principal_attribution',
      sql`(
        ${table.budgetPrincipalAttributed} = false
        and ${table.budgetPrincipalDigest} = repeat('0', 64)
      ) or (
        ${table.budgetPrincipalAttributed} = true
        and ${table.budgetPrincipalDigest} <> repeat('0', 64)
      )`,
    ),
    check(
      'media_upload_intents_size',
      sql`${table.byteLength} between 1 and 26214400`,
    ),
    check(
      'media_upload_intents_status',
      sql`${table.status} in ('pending-upload', 'completed', 'rejected', 'expired')`,
    ),
    check(
      'media_upload_intents_expiry',
      sql`${table.expiresAt} >= ${table.createdAt}
        and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
  ],
);

/** Validated, sanitized private image records; EXIF removal is mandatory. */
export const mediaRecords = pgTable(
  'media_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    uploadIntentId: uuid('upload_intent_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    status: varchar('status', { length: 16 }).notNull(),
    detectedContentType: mediaContentTypeEnum(
      'detected_content_type',
    ).notNull(),
    sanitizedByteLength: integer('sanitized_byte_length').notNull(),
    sanitizedContentSha256: digest('sanitized_content_sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    malwareScan: varchar('malware_scan', { length: 16 }).notNull(),
    exifStripped: boolean('exif_stripped').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('media_records_identity_event_uq').on(table.id, table.eventId),
    unique('media_records_upload_intent_uq').on(table.uploadIntentId),
    foreignKey({
      columns: [table.uploadIntentId, table.eventId],
      foreignColumns: [mediaUploadIntents.id, mediaUploadIntents.eventId],
      name: 'media_records_upload_intent_event_fk',
    }).onDelete('restrict'),
    uniqueIndex('media_records_storage_key_uq').on(table.storageKey),
    check('media_records_ready', sql`${table.status} = 'ready'`),
    check('media_records_scan_clean', sql`${table.malwareScan} = 'clean'`),
    check('media_records_exif_stripped', sql`${table.exifStripped} = true`),
    check(
      'media_records_size',
      sql`${table.sanitizedByteLength} between 1 and 26214400`,
    ),
  ],
);

/** Append-only operational journal; corrections append superseding rows. */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    kind: journalEntryKindEnum('kind').notNull(),
    author: jsonb('author').notNull(),
    source: invocationSourceEnum('source').notNull(),
    serverTime: occurredAt('server_time').defaultNow().notNull(),
    clientTime: occurredAt('client_time'),
    payload: jsonb('payload').notNull(),
    mediaId: uuid('media_id'),
    transitionId: uuid('transition_id'),
    supersedesEntryId: uuid('supersedes_entry_id'),
    supersedesEntrySequence: integer('supersedes_entry_sequence'),
    supersessionKind: journalSupersessionKindEnum('supersession_kind'),
    supersessionReason: varchar('supersession_reason', { length: 1000 }),
  },
  (table) => [
    unique('journal_entries_event_sequence_uq').on(
      table.eventId,
      table.sequence,
    ),
    unique('journal_entries_event_identity_sequence_uq').on(
      table.eventId,
      table.id,
      table.sequence,
    ),
    foreignKey({
      columns: [
        table.eventId,
        table.supersedesEntryId,
        table.supersedesEntrySequence,
      ],
      foreignColumns: [table.eventId, table.id, table.sequence],
      name: 'journal_entries_supersedes_same_event_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.mediaId, table.eventId],
      foreignColumns: [mediaRecords.id, mediaRecords.eventId],
      name: 'journal_entries_media_event_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.transitionId, table.eventId],
      foreignColumns: [eventTransitions.id, eventTransitions.journalEventId],
      name: 'journal_entries_transition_event_fk',
    }).onDelete('restrict'),
    index('journal_entries_event_time_idx').on(table.eventId, table.serverTime),
    index('journal_entries_event_media_idx')
      .on(table.eventId, table.mediaId, table.id, table.sequence)
      .where(sql`${table.kind} = 'photo'`),
    index('journal_entries_event_redaction_target_idx')
      .on(table.eventId, table.supersedesEntryId, table.supersedesEntrySequence)
      .where(sql`${table.supersessionKind} = 'redaction'`),
    check('journal_entries_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'journal_entries_payload_reference',
      sql`(
        ${table.kind} = 'photo' and ${table.mediaId} is not null
        and ${table.transitionId} is null
      ) or (
        ${table.kind} = 'system' and ${table.mediaId} is null
      ) or (
        ${table.kind} in ('text', 'location')
        and ${table.mediaId} is null and ${table.transitionId} is null
      )`,
    ),
    check(
      'journal_entries_supersession_complete',
      sql`(
        ${table.supersedesEntryId} is null
        and ${table.supersedesEntrySequence} is null
        and ${table.supersessionKind} is null
        and ${table.supersessionReason} is null
      ) or (
        ${table.kind} <> 'system'
        and ${table.supersedesEntryId} is not null
        and ${table.supersedesEntrySequence} is not null
        and ${table.supersedesEntrySequence} < ${table.sequence}
        and ${table.supersessionKind} is not null
        and ${table.supersessionReason} is not null
      )`,
    ),
  ],
);
