import { sql } from 'drizzle-orm';

import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  rosterPopulationEnum,
  endpointStatusEnum,
  notificationChannelEnum,
  eventKindEnum,
  templateModeEnum,
  notificationPurposeEnum,
  classificationMarkerEnum,
  invocationSourceEnum,
  deliveryTruthStateEnum,
  deliveryEvidenceSubjectKindEnum,
  outboxStatusEnum,
  humanConfirmationStatusEnum,
} from './enums';

import { auditCode, digest, occurredAt } from './shared';

import { sessions, humanConfirmationRecords } from './identity';

import { rosterSnapshots, rosterEndpoints } from './roster';

import { eventTypeVersions } from './event-types';

import { activationPreviews, events } from './events';
/** Immutable, transactionally recorded notification send intents. */
export const notificationIntents = pgTable(
  'notification_intents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull(),
    eventKind: eventKindEnum('event_kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    createdBy: jsonb('created_by').notNull(),
    source: invocationSourceEnum('source').notNull(),
    requestId: uuid('request_id').notNull(),
    authorization: jsonb('authorization').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('notification_intents_request_uq').on(table.requestId),
    unique('notification_intents_identity_classification_uq').on(
      table.id,
      table.eventKind,
      table.templateMode,
      table.purpose,
    ),
    unique('notification_intents_channel_anchor_uq').on(
      table.id,
      table.eventKind,
      table.templateMode,
      table.purpose,
      table.rosterPopulation,
    ),
    unique('notification_intents_attempt_anchor_uq').on(
      table.id,
      table.eventId,
      table.eventKind,
      table.templateMode,
      table.purpose,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
    ),
    unique('notification_intents_worker_anchor_uq').on(
      table.id,
      table.eventId,
      table.eventKind,
      table.templateMode,
      table.purpose,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
      table.requestId,
      table.authorization,
    ),
    foreignKey({
      columns: [
        table.eventId,
        table.eventKind,
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
      name: 'notification_intents_event_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'notification_intents_event_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'notification_intents_roster_population_fk',
    }).onDelete('restrict'),
    check(
      'notification_intents_classification',
      sql`(
        ${table.eventKind} = 'incident' and ${table.templateMode} = 'real'
        and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.eventKind} = 'drill' and ${table.templateMode} = 'drill'
      ) or (
        ${table.eventKind} = 'test' and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
    check(
      'notification_intents_authorization_truth',
      sql`(
        ${table.authorization} ->> 'requestId' is not distinct from ${table.requestId}::text
      ) and case
        when ${table.purpose} = 'activation' and ${table.rosterPopulation} = 'staff' then
          ${table.authorization} ->> 'kind' is not distinct from 'human-confirmed'
          and ${table.createdBy} ->> 'kind' is not distinct from 'human'
        when ${table.purpose} = 'activation' and ${table.rosterPopulation} = 'synthetic' then
          ${table.authorization} ->> 'kind' is not distinct from 'synthetic-training'
        when ${table.purpose} <> 'activation' and ${table.rosterPopulation} = 'staff' then
          ${table.authorization} ->> 'kind' is not distinct from 'human-confirmed-lifecycle'
          and ${table.authorization} ->> 'purpose' is not distinct from ${table.purpose}::text
          and ${table.createdBy} ->> 'kind' is not distinct from 'human'
        when ${table.purpose} <> 'activation' and ${table.rosterPopulation} = 'synthetic' then
          ${table.authorization} ->> 'kind' is not distinct from 'synthetic-lifecycle'
          and ${table.authorization} ->> 'purpose' is not distinct from ${table.purpose}::text
        else false
      end`,
    ),
    check(
      'notification_intents_actor_source',
      sql`case ${table.createdBy} ->> 'kind'
        when 'human' then ${table.source} in ('web', 'mobile')
        when 'agent' then ${table.source} in ('agent-rest', 'mcp')
        when 'system' then ${table.source} in ('worker', 'scheduled-job', 'webhook')
        else false
      end`,
    ),
  ],
);

/** Exact channel plan and rendered copy pinned by a notification intent. */
export const notificationIntentChannels = pgTable(
  'notification_intent_channels',
  {
    intentId: uuid('intent_id')
      .notNull()
      .references(() => notificationIntents.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    eventKind: eventKindEnum('event_kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    classificationMarker: classificationMarkerEnum(
      'classification_marker',
    ).notNull(),
    endpointCount: integer('endpoint_count').notNull(),
    renderedMessage: jsonb('rendered_message').notNull(),
    integrationId: varchar('integration_id', { length: 100 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.intentId, table.channel] }),
    unique('notification_intent_channels_sequence_uq').on(
      table.intentId,
      table.sequence,
    ),
    foreignKey({
      columns: [
        table.intentId,
        table.eventKind,
        table.templateMode,
        table.purpose,
        table.rosterPopulation,
      ],
      foreignColumns: [
        notificationIntents.id,
        notificationIntents.eventKind,
        notificationIntents.templateMode,
        notificationIntents.purpose,
        notificationIntents.rosterPopulation,
      ],
      name: 'notification_intent_channels_intent_truth_fk',
    }).onDelete('restrict'),
    check(
      'notification_intent_channels_sequence_positive',
      sql`${table.sequence} > 0`,
    ),
    check(
      'notification_intent_channels_endpoint_count',
      sql`${table.endpointCount} between 0 and 12000`,
    ),
    check(
      'notification_intent_channels_classification',
      sql`(
        ${table.eventKind} = 'incident'
        and ${table.templateMode} = 'real'
        and ${table.classificationMarker} = 'INCIDENT'
      ) or (
        ${table.eventKind} in ('drill', 'test')
        and ${table.templateMode} = 'drill'
        and ${table.classificationMarker} = 'DRILL'
      )`,
    ),
    check(
      'notification_intent_channels_rendered_truth',
      sql`jsonb_typeof(${table.renderedMessage}) is not distinct from 'object'
        and ${table.renderedMessage} ->> 'channel' is not distinct from ${table.channel}::text
        and ${table.renderedMessage} ->> 'eventKind' is not distinct from ${table.eventKind}::text
        and ${table.renderedMessage} ->> 'templateMode' is not distinct from ${table.templateMode}::text
        and ${table.renderedMessage} ->> 'purpose' is not distinct from ${table.purpose}::text
        and ${table.renderedMessage} ->> 'classificationMarker' is not distinct from ${table.classificationMarker}::text`,
    ),
    check(
      'notification_intent_channels_integration_channel',
      sql`(
        ${table.channel} = 'push'
        and ${table.integrationId} in ('expo-push', 'mobile-push')
      ) or (
        ${table.channel} = 'email' and ${table.integrationId} = 'ses-email'
      ) or (
        ${table.channel} = 'sms' and ${table.integrationId} = 'aws-eum-sms'
      )`,
    ),
  ],
);

/** Retained transactional outbox; published means durable queue handoff only. */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageVersion: integer('message_version').notNull(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => notificationIntents.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id').notNull(),
    eventKind: eventKindEnum('event_kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    requestId: uuid('request_id').notNull(),
    authorization: jsonb('authorization').notNull(),
    channels: jsonb('channels').notNull(),
    message: jsonb('message').notNull(),
    status: outboxStatusEnum('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: occurredAt('available_at').defaultNow().notNull(),
    lockedUntil: occurredAt('locked_until'),
    publishedAt: occurredAt('published_at'),
    failedAt: occurredAt('failed_at'),
    lastErrorCode: auditCode('last_error_code'),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('outbox_intent_uq').on(table.intentId),
    foreignKey({
      columns: [
        table.intentId,
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.purpose,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
        table.requestId,
        table.authorization,
      ],
      foreignColumns: [
        notificationIntents.id,
        notificationIntents.eventId,
        notificationIntents.eventKind,
        notificationIntents.templateMode,
        notificationIntents.purpose,
        notificationIntents.eventTypeVersionId,
        notificationIntents.rosterSnapshotId,
        notificationIntents.rosterPopulation,
        notificationIntents.requestId,
        notificationIntents.authorization,
      ],
      name: 'outbox_notification_intent_truth_fk',
    }).onDelete('restrict'),
    unique('outbox_worker_anchor_uq').on(
      table.id,
      table.intentId,
      table.eventId,
      table.eventKind,
      table.templateMode,
      table.purpose,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
      table.requestId,
      table.authorization,
    ),
    foreignKey({
      columns: [
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.rosterPopulation,
      ],
      foreignColumns: [
        events.id,
        events.kind,
        events.templateMode,
        events.rosterPopulation,
      ],
      name: 'outbox_event_targeting_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'outbox_event_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'outbox_roster_population_fk',
    }).onDelete('restrict'),
    index('outbox_claim_idx').on(table.status, table.availableAt),
    check('outbox_message_version', sql`${table.messageVersion} in (1, 2)`),
    check('outbox_attempts', sql`${table.attempts} between 0 and 100`),
    check(
      'outbox_classification',
      sql`(
        ${table.eventKind} = 'incident' and ${table.templateMode} = 'real'
        and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.eventKind} = 'drill' and ${table.templateMode} = 'drill'
      ) or (
        ${table.eventKind} = 'test' and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
    check(
      'outbox_message_truth',
      sql`jsonb_typeof(${table.message}) is not distinct from 'object'
        and ${table.message} ->> 'outboxId' is not distinct from ${table.id}::text
        and ${table.message} ->> 'intentId' is not distinct from ${table.intentId}::text
        and ${table.message} ->> 'eventId' is not distinct from ${table.eventId}::text
        and ${table.message} ->> 'eventKind' is not distinct from ${table.eventKind}::text
        and ${table.message} ->> 'templateMode' is not distinct from ${table.templateMode}::text
        and ${table.message} ->> 'purpose' is not distinct from ${table.purpose}::text
        and ${table.message} -> 'eventTypeVersion' ->> 'id' is not distinct from ${table.eventTypeVersionId}::text
        and ${table.message} -> 'eventTypeVersion' ->> 'templateMode' is not distinct from ${table.templateMode}::text
        and ${table.message} ->> 'rosterSnapshotId' is not distinct from ${table.rosterSnapshotId}::text
        and ${table.message} ->> 'rosterPopulation' is not distinct from ${table.rosterPopulation}::text
        and ${table.message} ->> 'requestId' is not distinct from ${table.requestId}::text
        and (${table.message} ->> 'version')::integer is not distinct from ${table.messageVersion}
        and (
          (
            ${table.messageVersion} = 1
            and not (${table.message} ? 'facilityId')
          ) or (
            ${table.messageVersion} = 2
            and jsonb_typeof(${table.message} -> 'facilityId') is not distinct from 'string'
            and ${table.message} ->> 'facilityId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
        )
        and (${table.message} ->> 'createdAt')::timestamptz is not distinct from ${table.createdAt}
        and ${table.message} -> 'authorization' is not distinct from ${table.authorization}
        and ${table.message} -> 'channels' is not distinct from ${table.channels}`,
    ),
    check(
      'outbox_channel_plan_shape',
      sql`case
        when jsonb_typeof(${table.channels}) = 'array' then
          jsonb_array_length(${table.channels}) between 2 and 3
          and jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.channel == "push" && @.renderedMessage.channel == "push" && (@.integrationId == "expo-push" || @.integrationId == "mobile-push"))'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.channel == "email" && @.renderedMessage.channel == "email" && @.integrationId == "ses-email")'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationId == "aws-eum-sms")'
          )) <= 1
          and jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.channel == "push" || @.channel == "email" || @.channel == "sms")'
          )) = jsonb_array_length(${table.channels})
        else false
      end`,
    ),
    check(
      'outbox_channel_plan_classification',
      sql`case
        when ${table.eventKind} = 'incident' and ${table.templateMode} = 'real' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.renderedMessage.eventKind == "incident" && @.renderedMessage.templateMode == "real" && @.renderedMessage.classificationMarker == "INCIDENT")'
          )) = jsonb_array_length(${table.channels})
        when ${table.eventKind} = 'drill' and ${table.templateMode} = 'drill' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.renderedMessage.eventKind == "drill" && @.renderedMessage.templateMode == "drill" && @.renderedMessage.classificationMarker == "DRILL")'
          )) = jsonb_array_length(${table.channels})
        when ${table.eventKind} = 'test' and ${table.templateMode} = 'drill' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.renderedMessage.eventKind == "test" && @.renderedMessage.templateMode == "drill" && @.renderedMessage.classificationMarker == "DRILL")'
          )) = jsonb_array_length(${table.channels})
        else false
      end`,
    ),
    check(
      'outbox_channel_plan_purpose',
      sql`case
        when ${table.purpose} = 'activation' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.renderedMessage.purpose == "activation")'
          )) = jsonb_array_length(${table.channels})
        when ${table.purpose} = 'all-clear' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.renderedMessage.purpose == "all-clear")'
          )) = jsonb_array_length(${table.channels})
        when ${table.purpose} = 'reactivation' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.renderedMessage.purpose == "reactivation")'
          )) = jsonb_array_length(${table.channels})
        else false
      end`,
    ),
    check(
      'outbox_lock_state',
      sql`(${table.status} = 'processing') = (${table.lockedUntil} is not null)`,
    ),
    check(
      'outbox_published_state',
      sql`(${table.status} = 'published') = (${table.publishedAt} is not null)`,
    ),
    check(
      'outbox_failed_state',
      sql`(${table.status} = 'failed') = (${table.failedAt} is not null)
        and (${table.status} <> 'failed' or ${table.lastErrorCode} is not null)`,
    ),
    check(
      'outbox_operational_times',
      sql`${table.availableAt} >= ${table.createdAt}
        and (${table.lockedUntil} is null or ${table.lockedUntil} >= ${table.createdAt})
        and (${table.publishedAt} is null or ${table.publishedAt} >= ${table.createdAt})
        and (${table.failedAt} is null or ${table.failedAt} >= ${table.createdAt})`,
    ),
    check(
      'outbox_last_error_code_format',
      sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[A-Z0-9_]+$'`,
    ),
  ],
);

/** Immutable per-channel batches emitted from one retained outbox record. */
export const dispatchBatches = pgTable(
  'dispatch_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    outboxId: uuid('outbox_id')
      .notNull()
      .references(() => outbox.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => notificationIntents.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id').notNull(),
    eventKind: eventKindEnum('event_kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    requestId: uuid('request_id').notNull(),
    authorization: jsonb('authorization').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    renderedMessage: jsonb('rendered_message').notNull(),
    integrationId: varchar('integration_id', { length: 100 }).notNull(),
    sequence: integer('sequence').notNull(),
    endpointCount: integer('endpoint_count').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('dispatch_batches_intent_channel_uq').on(
      table.intentId,
      table.channel,
    ),
    unique('dispatch_batches_intent_sequence_uq').on(
      table.intentId,
      table.sequence,
    ),
    unique('dispatch_batches_attempt_anchor_uq').on(
      table.id,
      table.intentId,
      table.eventId,
      table.eventKind,
      table.templateMode,
      table.purpose,
      table.eventTypeVersionId,
      table.rosterSnapshotId,
      table.rosterPopulation,
      table.channel,
    ),
    foreignKey({
      columns: [
        table.intentId,
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.purpose,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
        table.requestId,
        table.authorization,
      ],
      foreignColumns: [
        notificationIntents.id,
        notificationIntents.eventId,
        notificationIntents.eventKind,
        notificationIntents.templateMode,
        notificationIntents.purpose,
        notificationIntents.eventTypeVersionId,
        notificationIntents.rosterSnapshotId,
        notificationIntents.rosterPopulation,
        notificationIntents.requestId,
        notificationIntents.authorization,
      ],
      name: 'dispatch_batches_notification_intent_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.outboxId,
        table.intentId,
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.purpose,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
        table.requestId,
        table.authorization,
      ],
      foreignColumns: [
        outbox.id,
        outbox.intentId,
        outbox.eventId,
        outbox.eventKind,
        outbox.templateMode,
        outbox.purpose,
        outbox.eventTypeVersionId,
        outbox.rosterSnapshotId,
        outbox.rosterPopulation,
        outbox.requestId,
        outbox.authorization,
      ],
      name: 'dispatch_batches_outbox_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.rosterPopulation,
      ],
      foreignColumns: [
        events.id,
        events.kind,
        events.templateMode,
        events.rosterPopulation,
      ],
      name: 'dispatch_batches_event_targeting_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'dispatch_batches_event_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'dispatch_batches_roster_population_fk',
    }).onDelete('restrict'),
    check('dispatch_batches_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'dispatch_batches_endpoint_count',
      sql`${table.endpointCount} between 0 and 12000`,
    ),
    check(
      'dispatch_batches_classification',
      sql`(
        ${table.eventKind} = 'incident' and ${table.templateMode} = 'real'
        and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.eventKind} = 'drill' and ${table.templateMode} = 'drill'
      ) or (
        ${table.eventKind} = 'test' and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
    check(
      'dispatch_batches_rendered_truth',
      sql`jsonb_typeof(${table.renderedMessage}) is not distinct from 'object'
        and ${table.renderedMessage} ->> 'channel' is not distinct from ${table.channel}::text
        and ${table.renderedMessage} ->> 'eventKind' is not distinct from ${table.eventKind}::text
        and ${table.renderedMessage} ->> 'templateMode' is not distinct from ${table.templateMode}::text
        and ${table.renderedMessage} ->> 'purpose' is not distinct from ${table.purpose}::text
        and ${table.renderedMessage} ->> 'classificationMarker' is not distinct from case
          when ${table.templateMode} = 'real' then 'INCIDENT'
          else 'DRILL'
        end`,
    ),
    check(
      'dispatch_batches_integration_channel',
      sql`(
        ${table.channel} = 'push'
        and ${table.integrationId} in ('expo-push', 'mobile-push')
      ) or (
        ${table.channel} = 'email' and ${table.integrationId} = 'ses-email'
      ) or (
        ${table.channel} = 'sms' and ${table.integrationId} = 'aws-eum-sms'
      )`,
    ),
  ],
);

/** Immutable endpoint attempts; provider results append separate evidence. */
export const channelAttempts = pgTable(
  'channel_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => dispatchBatches.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => notificationIntents.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id').notNull(),
    eventKind: eventKindEnum('event_kind').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    attemptedAt: occurredAt('attempted_at').defaultNow().notNull(),
  },
  (table) => [
    unique('channel_attempts_endpoint_attempt_uq').on(
      table.batchId,
      table.endpointId,
      table.attemptNumber,
    ),
    foreignKey({
      columns: [
        table.intentId,
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.purpose,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
      ],
      foreignColumns: [
        notificationIntents.id,
        notificationIntents.eventId,
        notificationIntents.eventKind,
        notificationIntents.templateMode,
        notificationIntents.purpose,
        notificationIntents.eventTypeVersionId,
        notificationIntents.rosterSnapshotId,
        notificationIntents.rosterPopulation,
      ],
      name: 'channel_attempts_notification_intent_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.batchId,
        table.intentId,
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.purpose,
        table.eventTypeVersionId,
        table.rosterSnapshotId,
        table.rosterPopulation,
        table.channel,
      ],
      foreignColumns: [
        dispatchBatches.id,
        dispatchBatches.intentId,
        dispatchBatches.eventId,
        dispatchBatches.eventKind,
        dispatchBatches.templateMode,
        dispatchBatches.purpose,
        dispatchBatches.eventTypeVersionId,
        dispatchBatches.rosterSnapshotId,
        dispatchBatches.rosterPopulation,
        dispatchBatches.channel,
      ],
      name: 'channel_attempts_dispatch_batch_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.eventId,
        table.eventKind,
        table.templateMode,
        table.rosterPopulation,
      ],
      foreignColumns: [
        events.id,
        events.kind,
        events.templateMode,
        events.rosterPopulation,
      ],
      name: 'channel_attempts_event_targeting_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'channel_attempts_event_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'channel_attempts_roster_population_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.rosterSnapshotId,
        table.recipientId,
        table.endpointId,
        table.rosterPopulation,
        table.channel,
      ],
      foreignColumns: [
        rosterEndpoints.rosterSnapshotId,
        rosterEndpoints.recipientId,
        rosterEndpoints.id,
        rosterEndpoints.population,
        rosterEndpoints.channel,
      ],
      name: 'channel_attempts_endpoint_fk',
    }).onDelete('restrict'),
    index('channel_attempts_intent_idx').on(table.intentId),
    check('channel_attempts_attempt_positive', sql`${table.attemptNumber} > 0`),
    check(
      'channel_attempts_classification',
      sql`(
        ${table.eventKind} = 'incident' and ${table.templateMode} = 'real'
        and ${table.rosterPopulation} = 'staff'
      ) or (
        ${table.eventKind} = 'drill' and ${table.templateMode} = 'drill'
      ) or (
        ${table.eventKind} = 'test' and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'synthetic'
      )`,
    ),
  ],
);

/**
 * The lease and outcome for one channel attempt's provider call.
 *
 * `channel_attempts` records that an attempt exists, and is immutable. This
 * records who currently holds permission to call the provider for that attempt
 * and what the call returned, which is mutable by nature: a lease expires, a
 * worker that dies mid-send has to become reclaimable, and a retry decision
 * supersedes an earlier one.
 *
 * Keyed by the attempt id, but deliberately without a foreign key to
 * `channel_attempts`. A worker claims execution before it writes attempted
 * evidence, so the attempt row is not guaranteed to exist yet at claim time; a
 * foreign key would reject the very claim that makes the send safe.
 *
 * `fingerprint` is the caller's identity for the work it believes it is doing.
 * A claim whose fingerprint disagrees with the stored one is a programming
 * error rather than contention, and is refused rather than reconciled.
 */
export const channelAttemptExecutions = pgTable(
  'channel_attempt_executions',
  {
    // The worker claims this outer lease before it appends the canonical
    // attempted evidence that creates channel_attempts. A foreign key here
    // would make every first attempt impossible; later provider-I/O state is
    // separately tied to the canonical attempt after that append succeeds.
    attemptId: uuid('attempt_id').primaryKey(),
    fingerprint: varchar('fingerprint', { length: 200 }).notNull(),
    leaseToken: uuid('lease_token').notNull(),
    leaseExpiresAt: occurredAt('lease_expires_at').notNull(),
    completion: jsonb('completion'),
    completedAt: occurredAt('completed_at'),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'channel_attempt_executions_completion_pairing',
      sql`(${table.completion} is null) = (${table.completedAt} is null)`,
    ),
    check(
      'channel_attempt_executions_fingerprint_nonempty',
      sql`${table.fingerprint} = btrim(${table.fingerprint})
        and length(${table.fingerprint}) > 0`,
    ),
    index('channel_attempt_executions_reclaimable_idx')
      .on(table.leaseExpiresAt)
      .where(sql`${table.completion} is null`),
  ],
);

/**
 * Irreversible permit for one Expo provider-I/O call.
 *
 * Unlike the outer attempt lease, this permit never expires: a process can die
 * after Expo accepted bytes but before it records the response. Reissuing the
 * permit would create a duplicate notification, so an unfinished row remains
 * explicitly uncertain until an operator reconciles it.
 */
export const expoPushProviderIo = pgTable(
  'expo_push_provider_io',
  {
    attemptId: uuid('attempt_id')
      .primaryKey()
      .references(() => channelAttempts.id, { onDelete: 'restrict' }),
    workFingerprint: digest('work_fingerprint').notNull(),
    claimToken: uuid('claim_token').defaultRandom().notNull(),
    completion: jsonb('completion'),
    claimedAt: occurredAt('claimed_at').defaultNow().notNull(),
    completedAt: occurredAt('completed_at'),
  },
  (table) => [
    check(
      'expo_push_provider_io_completion_pairing',
      sql`(${table.completion} is null) = (${table.completedAt} is null)`,
    ),
    check(
      'expo_push_provider_io_completion_object',
      sql`${table.completion} is null or jsonb_typeof(${table.completion}) = 'object'`,
    ),
  ],
);

/**
 * Irreversible permit for one AWS End User Messaging SMS provider call.
 *
 * An unfinished row is intentionally permanent uncertainty. A worker may die
 * after AWS accepted the message but before it stores the response, and a
 * replacement worker must never turn that gap into a duplicate alert.
 */
export const smsProviderIo = pgTable(
  'sms_provider_io',
  {
    attemptId: uuid('attempt_id')
      .primaryKey()
      .references(() => channelAttempts.id, { onDelete: 'restrict' }),
    workFingerprint: digest('work_fingerprint').notNull(),
    claimToken: uuid('claim_token').defaultRandom().notNull(),
    completion: jsonb('completion'),
    claimedAt: occurredAt('claimed_at').defaultNow().notNull(),
    completedAt: occurredAt('completed_at'),
  },
  (table) => [
    check(
      'sms_provider_io_completion_pairing',
      sql`(${table.completion} is null) = (${table.completedAt} is null)`,
    ),
    check(
      'sms_provider_io_completion_object',
      sql`${table.completion} is null or jsonb_typeof(${table.completion}) = 'object'`,
    ),
  ],
);

/**
 * Irreversible permit for one SES provider-I/O call.
 *
 * SES does not accept a caller idempotency key. An unfinished claim therefore
 * never expires: the worker may have lost the response after SES accepted the
 * message, and retrying that call would risk a duplicate email.
 */
export const sesEmailProviderIo = pgTable(
  'ses_email_provider_io',
  {
    attemptId: uuid('attempt_id')
      .primaryKey()
      .references(() => channelAttempts.id, { onDelete: 'restrict' }),
    requestFingerprint: digest('request_fingerprint').notNull(),
    claimToken: uuid('claim_token').defaultRandom().notNull(),
    outcome: jsonb('outcome'),
    claimedAt: occurredAt('claimed_at').defaultNow().notNull(),
    completedAt: occurredAt('completed_at'),
  },
  (table) => [
    check(
      'ses_email_provider_io_completion_pairing',
      sql`(${table.outcome} is null) = (${table.completedAt} is null)`,
    ),
    check(
      'ses_email_provider_io_outcome_object',
      sql`${table.outcome} is null or jsonb_typeof(${table.outcome}) = 'object'`,
    ),
  ],
);

/** Durable receipt polling state; targets contain no push token. */
export const expoPushReceiptPolls = pgTable(
  'expo_push_receipt_polls',
  {
    attemptId: uuid('attempt_id')
      .primaryKey()
      .references(() => channelAttempts.id, { onDelete: 'restrict' }),
    receiptId: varchar('receipt_id', { length: 500 }).notNull(),
    fingerprint: digest('fingerprint').notNull(),
    target: jsonb('target').notNull(),
    firstPollAt: occurredAt('first_poll_at').notNull(),
    horizonAt: occurredAt('horizon_at').notNull(),
    dueAt: occurredAt('due_at').notNull(),
    pollAttemptNumber: integer('poll_attempt_number').default(1).notNull(),
    lastReasonCode: auditCode('last_reason_code'),
    receiptReferenceState: varchar('receipt_reference_state', { length: 16 })
      .default('unique')
      .notNull(),
    pendingAction: jsonb('pending_action'),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: occurredAt('lease_expires_at'),
    lastDecision: jsonb('last_decision'),
    terminalDecision: jsonb('terminal_decision'),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    updatedAt: occurredAt('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('expo_push_receipt_polls_due_idx')
      .on(table.dueAt, table.attemptId)
      .where(sql`${table.terminalDecision} is null`),
    index('expo_push_receipt_polls_receipt_idx').on(
      table.receiptId,
      table.attemptId,
    ),
    check(
      'expo_push_receipt_polls_window',
      sql`${table.firstPollAt} <= ${table.dueAt}
        and ${table.dueAt} <= ${table.horizonAt}`,
    ),
    check(
      'expo_push_receipt_polls_attempt_positive',
      sql`${table.pollAttemptNumber} between 1 and 10000`,
    ),
    check(
      'expo_push_receipt_polls_reference_state',
      sql`${table.receiptReferenceState} in ('unique', 'conflict')`,
    ),
    check(
      'expo_push_receipt_polls_lease_pairing',
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      'expo_push_receipt_polls_json_objects',
      sql`jsonb_typeof(${table.target}) = 'object'
        and (${table.pendingAction} is null or jsonb_typeof(${table.pendingAction}) = 'object')
        and (${table.lastDecision} is null or jsonb_typeof(${table.lastDecision}) = 'object')
        and (${table.terminalDecision} is null or jsonb_typeof(${table.terminalDecision}) = 'object')`,
    ),
  ],
);

/**
 * Idempotent destination-free schedule for the immutable attempt after a
 * safe-to-retry send failure or receipt-directed resend.
 */
export const expoPushRetrySchedules = pgTable(
  'expo_push_retry_schedules',
  {
    sourceAttemptId: uuid('source_attempt_id')
      .primaryKey()
      .references(() => channelAttempts.id, { onDelete: 'restrict' }),
    sourceFingerprint: digest('source_fingerprint').notNull(),
    receiptId: varchar('receipt_id', { length: 500 }),
    nextAttemptId: uuid('next_attempt_id').defaultRandom().notNull(),
    nextAttemptNumber: integer('next_attempt_number').notNull(),
    delayMilliseconds: integer('delay_milliseconds').notNull(),
    retryAt: occurredAt('retry_at').notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
    reasonCode: auditCode('reason_code').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('expo_push_retry_schedules_next_attempt_uq').on(table.nextAttemptId),
    index('expo_push_retry_schedules_retry_at_idx').on(table.retryAt),
    check(
      'expo_push_retry_schedules_attempt_positive',
      sql`${table.nextAttemptNumber} between 2 and 10`,
    ),
    check(
      'expo_push_retry_schedules_delay',
      sql`${table.delayMilliseconds} between 1 and 3600000`,
    ),
    check(
      'expo_push_retry_schedules_window',
      sql`${table.retryAt} < ${table.expiresAt}`,
    ),
    check(
      'expo_push_retry_schedules_receipt_reason',
      sql`${table.receiptId} is null
        or ${table.reasonCode} = 'EXPO_MESSAGE_RATE_EXCEEDED'`,
    ),
  ],
);

/** Idempotent, destination-free schedule for one immutable SMS retry. */
export const smsRetrySchedules = pgTable(
  'sms_retry_schedules',
  {
    sourceAttemptId: uuid('source_attempt_id')
      .primaryKey()
      .references(() => channelAttempts.id, { onDelete: 'restrict' }),
    sourceFingerprint: digest('source_fingerprint').notNull(),
    nextAttemptId: uuid('next_attempt_id').defaultRandom().notNull(),
    nextAttemptNumber: integer('next_attempt_number').notNull(),
    delayMilliseconds: integer('delay_milliseconds').notNull(),
    retryAt: occurredAt('retry_at').notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
    reasonCode: auditCode('reason_code').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('sms_retry_schedules_next_attempt_uq').on(table.nextAttemptId),
    index('sms_retry_schedules_retry_at_idx').on(table.retryAt),
    check(
      'sms_retry_schedules_attempt_positive',
      sql`${table.nextAttemptNumber} between 2 and 10`,
    ),
    check(
      'sms_retry_schedules_delay',
      sql`${table.delayMilliseconds} between 1 and 3600000`,
    ),
    check(
      'sms_retry_schedules_window',
      sql`${table.retryAt} < ${table.expiresAt}`,
    ),
  ],
);

/** Append-only, evidence-honest notification delivery facts. */
export const deliveryEvidence = pgTable(
  'delivery_evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subjectKind: deliveryEvidenceSubjectKindEnum('subject_kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    intentId: uuid('intent_id').references(() => notificationIntents.id, {
      onDelete: 'restrict',
    }),
    attemptId: uuid('attempt_id').references(() => channelAttempts.id, {
      onDelete: 'restrict',
    }),
    sequence: integer('sequence').notNull(),
    previousEvidenceId: uuid('previous_evidence_id'),
    state: deliveryTruthStateEnum('state').notNull(),
    recordedAt: occurredAt('recorded_at').defaultNow().notNull(),
    provider: varchar('provider', { length: 100 }),
    providerReference: varchar('provider_reference', { length: 500 }),
    providerOccurredAt: occurredAt('provider_occurred_at'),
    proof: jsonb('proof'),
    reasonCode: auditCode('reason_code'),
    diagnosticDigest: digest('diagnostic_digest'),
  },
  (table) => [
    unique('delivery_evidence_subject_sequence_uq').on(
      table.subjectKind,
      table.subjectId,
      table.sequence,
    ),
    unique('delivery_evidence_identity_subject_uq').on(
      table.id,
      table.subjectKind,
      table.subjectId,
    ),
    foreignKey({
      columns: [table.previousEvidenceId, table.subjectKind, table.subjectId],
      foreignColumns: [table.id, table.subjectKind, table.subjectId],
      name: 'delivery_evidence_previous_same_subject_fk',
    }).onDelete('restrict'),
    index('delivery_evidence_subject_idx').on(
      table.subjectKind,
      table.intentId,
      table.attemptId,
    ),
    check('delivery_evidence_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'delivery_evidence_provider_time',
      sql`${table.providerOccurredAt} is null
        or ${table.providerOccurredAt} <= ${table.recordedAt} + interval '5 minutes'`,
    ),
    check(
      'delivery_evidence_apns_unregistered_time',
      sql`(
        ${table.reasonCode} is distinct from 'APNS_UNREGISTERED'
        and ${table.providerOccurredAt} is null
      ) or (
        ${table.state} = 'failed'
        and ${table.provider} = 'apns-direct'
        and ${table.reasonCode} = 'APNS_UNREGISTERED'
        and ${table.providerOccurredAt} is not null
      )`,
    ),
    check(
      'delivery_evidence_subject',
      sql`(
        ${table.subjectKind} = 'intent'
        and ${table.intentId} is not null
        and ${table.subjectId} = ${table.intentId}
        and ${table.attemptId} is null
        and ${table.state} in ('accepted', 'recorded')
      ) or (
        ${table.subjectKind} = 'attempt'
        and ${table.intentId} is null
        and ${table.attemptId} is not null
        and ${table.subjectId} = ${table.attemptId}
        and ${table.state} in (
          'attempted', 'provider-accepted', 'delivered', 'failed', 'expired', 'unknown'
        )
      )`,
    ),
    check(
      'delivery_evidence_previous_sequence',
      sql`(${table.sequence} = 1) = (${table.previousEvidenceId} is null)
        and (${table.previousEvidenceId} is null or ${table.previousEvidenceId} <> ${table.id})`,
    ),
    check(
      'delivery_evidence_provider_truth',
      sql`${table.state} not in ('provider-accepted', 'delivered') or (
        ${table.provider} is not null and ${table.providerReference} is not null
      )`,
    ),
    check(
      'delivery_evidence_proof_truth',
      sql`(${table.state} = 'delivered') = (${table.proof} is not null)`,
    ),
    check(
      'delivery_evidence_reason_truth',
      sql`(${table.state} in ('failed', 'expired', 'unknown')) = (${table.reasonCode} is not null)
        and (${table.diagnosticDigest} is null or ${table.reasonCode} is not null)`,
    ),
  ],
);

/** Append-only lifecycle facts that supersede a snapshotted endpoint state. */
export const endpointStatusRecords = pgTable(
  'endpoint_status_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sequence: integer('sequence').generatedAlwaysAsIdentity(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    status: endpointStatusEnum('status').notNull(),
    reasonCode: auditCode('reason_code').notNull(),
    provider: varchar('provider', { length: 100 }),
    providerReference: varchar('provider_reference', { length: 500 }),
    providerOccurredAt: occurredAt('provider_occurred_at'),
    recordedAt: occurredAt('recorded_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.rosterSnapshotId,
        table.recipientId,
        table.endpointId,
        table.population,
        table.channel,
      ],
      foreignColumns: [
        rosterEndpoints.rosterSnapshotId,
        rosterEndpoints.recipientId,
        rosterEndpoints.id,
        rosterEndpoints.population,
        rosterEndpoints.channel,
      ],
      name: 'endpoint_status_records_endpoint_fk',
    }).onDelete('restrict'),
    check(
      'endpoint_status_records_lifecycle_status',
      sql`${table.status} in ('active', 'invalid', 'disabled')`,
    ),
    check(
      'endpoint_status_records_provider_identity',
      sql`(${table.provider} is null) = (${table.providerReference} is null)
        and (${table.provider} is null) = (${table.providerOccurredAt} is null)
        and (${table.provider} is null or (
          ${table.channel} = 'sms'
          and ${table.provider} = 'aws-eum-sms'
          and (
            (${table.status} = 'active' and ${table.reasonCode} = 'SMS_OPT_IN_PROVIDER_VERIFIED')
            or (${table.status} = 'disabled' and ${table.reasonCode} = 'SMS_OPTED_OUT')
          )
        ))`,
    ),
    check(
      'endpoint_status_records_provider_format',
      sql`${table.provider} is null or (
        ${table.provider} = btrim(${table.provider})
        and ${table.providerReference} = btrim(${table.providerReference})
        and length(${table.provider}) between 1 and 100
        and length(${table.providerReference}) between 1 and 500
      )`,
    ),
    check(
      'endpoint_status_records_verified_active',
      sql`(${table.status} = 'active') = (
        ${table.channel} = 'sms'
        and ${table.reasonCode} = 'SMS_OPT_IN_PROVIDER_VERIFIED'
        and ${table.provider} = 'aws-eum-sms'
        and ${table.providerReference} is not null
        and ${table.providerOccurredAt} is not null
      )`,
    ),
    check(
      'endpoint_status_records_managed_sms_opt_out',
      sql`(${table.reasonCode} = 'SMS_OPTED_OUT') = (
        ${table.channel} = 'sms'
        and ${table.status} = 'disabled'
        and ${table.provider} = 'aws-eum-sms'
        and ${table.providerReference} is not null
        and ${table.providerOccurredAt} is not null
      )`,
    ),
    check(
      'endpoint_status_records_provider_time',
      sql`${table.providerOccurredAt} is null
        or ${table.providerOccurredAt} <= ${table.recordedAt} + interval '5 minutes'`,
    ),
    check(
      'endpoint_status_records_reason_format',
      sql`${table.reasonCode} ~ '^[A-Z0-9_]+$'`,
    ),
    uniqueIndex('endpoint_status_records_sequence_uq').on(table.sequence),
    uniqueIndex('endpoint_status_records_provider_reference_uq').on(
      table.rosterSnapshotId,
      table.recipientId,
      table.endpointId,
      table.provider,
      table.providerReference,
    ),
    index('endpoint_status_records_latest_idx').on(
      table.rosterSnapshotId,
      table.recipientId,
      table.endpointId,
      table.sequence.desc(),
    ),
    index('endpoint_status_records_sms_lifecycle_idx')
      .on(
        table.rosterSnapshotId,
        table.recipientId,
        table.endpointId,
        table.providerOccurredAt.desc(),
        table.sequence.desc(),
      )
      .where(
        sql`${table.channel} = 'sms' and ${table.reasonCode} in ('SMS_OPTED_OUT', 'SMS_OPT_IN_PROVIDER_VERIFIED')`,
      ),
  ],
);

/** Retained SMS opt-out facts without copying destination phone numbers. */
export const smsOptOutRecords = pgTable(
  'sms_opt_out_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    provider: varchar('provider', { length: 100 }).notNull(),
    providerReference: varchar('provider_reference', { length: 500 }).notNull(),
    providerOccurredAt: occurredAt('provider_occurred_at'),
    recordedAt: occurredAt('recorded_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.rosterSnapshotId,
        table.recipientId,
        table.endpointId,
        table.population,
        table.channel,
      ],
      foreignColumns: [
        rosterEndpoints.rosterSnapshotId,
        rosterEndpoints.recipientId,
        rosterEndpoints.id,
        rosterEndpoints.population,
        rosterEndpoints.channel,
      ],
      name: 'sms_opt_out_records_endpoint_fk',
    }).onDelete('restrict'),
    check('sms_opt_out_records_sms_only', sql`${table.channel} = 'sms'`),
    check(
      'sms_opt_out_records_provider_time_required',
      sql`${table.providerOccurredAt} is not null`,
    ),
    check(
      'sms_opt_out_records_provider_time',
      sql`${table.providerOccurredAt} <= ${table.recordedAt} + interval '5 minutes'`,
    ),
    uniqueIndex('sms_opt_out_records_provider_reference_uq')
      .on(
        table.rosterSnapshotId,
        table.recipientId,
        table.endpointId,
        table.provider,
        table.providerReference,
      )
      .where(sql`${table.providerOccurredAt} is not null`),
  ],
);
