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
  deliveryTestReportStatusEnum,
  outboxStatusEnum,
  integrationTruthLabelEnum,
  humanConfirmationStatusEnum,
} from './enums';

import { auditCode, digest, occurredAt } from './shared';

import { sessions, humanConfirmationRecords } from './identity';

import {
  rosterSnapshots,
  rosterEndpoints,
  deliveryTestTargetSetVersions,
} from './roster';

import { eventTypeVersions, integrationStatuses } from './event-types';

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
    deliveryTestTargetSetId: uuid('delivery_test_target_set_id'),
    deliveryTestTargetSetVersion: integer('delivery_test_target_set_version'),
    deliveryTestEndpointReferenceDigest: digest(
      'delivery_test_endpoint_reference_digest',
    ),
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
    unique('notification_intents_delivery_test_anchor_uq').on(
      table.id,
      table.eventId,
      table.requestId,
      table.deliveryTestTargetSetId,
      table.deliveryTestTargetSetVersion,
      table.deliveryTestEndpointReferenceDigest,
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
    foreignKey({
      columns: [
        table.deliveryTestTargetSetId,
        table.deliveryTestTargetSetVersion,
        table.rosterSnapshotId,
      ],
      foreignColumns: [
        deliveryTestTargetSetVersions.id,
        deliveryTestTargetSetVersions.version,
        deliveryTestTargetSetVersions.rosterSnapshotId,
      ],
      name: 'notification_intents_delivery_test_target_set_fk',
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
    check(
      'notification_intents_delivery_test_truth',
      sql`(
        ${table.deliveryTestTargetSetId} is null
        and ${table.deliveryTestTargetSetVersion} is null
        and ${table.deliveryTestEndpointReferenceDigest} is null
      ) or (
        ${table.deliveryTestTargetSetId} is not null
        and ${table.deliveryTestTargetSetVersion} is not null
        and ${table.deliveryTestEndpointReferenceDigest} is not null
        and ${table.eventKind} = 'drill'
        and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'staff'
        and ${table.purpose} = 'activation'
        and ${table.createdBy} ->> 'kind' is not distinct from 'human'
        and ${table.source} in ('web', 'mobile')
        and ${table.authorization} ->> 'kind' is not distinct from 'human-confirmed'
      )`,
    ),
    check(
      'notification_intents_delivery_test_digest_format',
      sql`${table.deliveryTestEndpointReferenceDigest} is null
        or ${table.deliveryTestEndpointReferenceDigest} ~ '^[a-f0-9]{64}$'`,
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
    integrationStatusId: uuid('integration_status_id').notNull(),
    integrationId: varchar('integration_id', { length: 100 }).notNull(),
    integrationLabel: integrationTruthLabelEnum('integration_label').notNull(),
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
    foreignKey({
      columns: [
        table.integrationStatusId,
        table.integrationId,
        table.integrationLabel,
      ],
      foreignColumns: [
        integrationStatuses.id,
        integrationStatuses.integrationId,
        integrationStatuses.label,
      ],
      name: 'notification_intent_channels_integration_truth_fk',
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
        ${table.channel} = 'push' and ${table.integrationId} = 'expo-push'
      ) or (
        ${table.channel} = 'email' and ${table.integrationId} = 'ses-email'
      ) or (
        ${table.channel} = 'sms' and ${table.integrationId} = 'aws-eum-sms'
      )`,
    ),
    check(
      'notification_intent_channels_integration_population',
      sql`(
        ${table.rosterPopulation} = 'staff'
        and ${table.integrationLabel} = 'live-verified'
      ) or (
        ${table.rosterPopulation} = 'synthetic'
        and ${table.integrationLabel} = 'mocked'
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
            ${table.channels}, '$[*] ? (@.channel == "push" && @.renderedMessage.channel == "push" && @.integrationStatus.integrationId == "expo-push")'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.channel == "email" && @.renderedMessage.channel == "email" && @.integrationStatus.integrationId == "ses-email")'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationStatus.integrationId == "aws-eum-sms")'
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
      'outbox_channel_plan_integration_truth',
      sql`case
        when ${table.rosterPopulation} = 'staff' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.integrationStatus.label == "live-verified")'
          )) = jsonb_array_length(${table.channels})
        when ${table.rosterPopulation} = 'synthetic' then
          jsonb_array_length(jsonb_path_query_array(
            ${table.channels}, '$[*] ? (@.integrationStatus.label == "mocked")'
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
    integrationStatusId: uuid('integration_status_id').notNull(),
    integrationId: varchar('integration_id', { length: 100 }).notNull(),
    integrationLabel: integrationTruthLabelEnum('integration_label').notNull(),
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
    foreignKey({
      columns: [
        table.integrationStatusId,
        table.integrationId,
        table.integrationLabel,
      ],
      foreignColumns: [
        integrationStatuses.id,
        integrationStatuses.integrationId,
        integrationStatuses.label,
      ],
      name: 'dispatch_batches_integration_truth_fk',
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
        ${table.channel} = 'push' and ${table.integrationId} = 'expo-push'
      ) or (
        ${table.channel} = 'email' and ${table.integrationId} = 'ses-email'
      ) or (
        ${table.channel} = 'sms' and ${table.integrationId} = 'aws-eum-sms'
      )`,
    ),
    check(
      'dispatch_batches_integration_population',
      sql`(
        ${table.rosterPopulation} = 'staff'
        and ${table.integrationLabel} = 'live-verified'
      ) or (
        ${table.rosterPopulation} = 'synthetic'
        and ${table.integrationLabel} = 'mocked'
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

/**
 * One authenticated-human monthly live delivery-test activation. This is
 * written in the same transaction as the canonical start-event lifecycle.
 */
export const deliveryTestRuns = pgTable(
  'delivery_test_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    activationPreviewId: uuid('activation_preview_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    notificationIntentId: uuid('notification_intent_id').notNull(),
    targetSetVersionId: uuid('target_set_version_id').notNull(),
    targetSetVersion: integer('target_set_version').notNull(),
    endpointReferenceDigest: digest('endpoint_reference_digest').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    confirmationId: uuid('confirmation_id').notNull(),
    confirmationStatus: humanConfirmationStatusEnum('confirmation_status')
      .default('consumed')
      .notNull(),
    requestId: uuid('request_id').notNull(),
    startedByUserId: uuid('started_by_user_id').notNull(),
    startedWithSessionId: uuid('started_with_session_id').notNull(),
    startedAt: occurredAt('started_at').notNull(),
  },
  (table) => [
    unique('delivery_test_runs_preview_uq').on(table.activationPreviewId),
    unique('delivery_test_runs_event_uq').on(table.eventId),
    unique('delivery_test_runs_intent_uq').on(table.notificationIntentId),
    unique('delivery_test_runs_confirmation_uq').on(table.confirmationId),
    unique('delivery_test_runs_request_uq').on(table.requestId),
    unique('delivery_test_runs_identity_start_uq').on(
      table.id,
      table.startedAt,
    ),
    foreignKey({
      columns: [
        table.activationPreviewId,
        table.targetSetVersionId,
        table.targetSetVersion,
        table.endpointReferenceDigest,
        table.consequenceDigest,
      ],
      foreignColumns: [
        activationPreviews.id,
        activationPreviews.deliveryTestTargetSetId,
        activationPreviews.deliveryTestTargetSetVersion,
        activationPreviews.deliveryTestEndpointReferenceDigest,
        activationPreviews.consequenceDigest,
      ],
      name: 'delivery_test_runs_activation_preview_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.notificationIntentId,
        table.eventId,
        table.requestId,
        table.targetSetVersionId,
        table.targetSetVersion,
        table.endpointReferenceDigest,
      ],
      foreignColumns: [
        notificationIntents.id,
        notificationIntents.eventId,
        notificationIntents.requestId,
        notificationIntents.deliveryTestTargetSetId,
        notificationIntents.deliveryTestTargetSetVersion,
        notificationIntents.deliveryTestEndpointReferenceDigest,
      ],
      name: 'delivery_test_runs_notification_intent_fk',
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
      name: 'delivery_test_runs_consumed_confirmation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.startedWithSessionId, table.startedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'delivery_test_runs_human_session_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.targetSetVersionId, table.targetSetVersion],
      foreignColumns: [
        deliveryTestTargetSetVersions.id,
        deliveryTestTargetSetVersions.version,
      ],
      name: 'delivery_test_runs_target_set_fk',
    }).onDelete('restrict'),
    index('delivery_test_runs_started_at_idx').on(table.startedAt.desc()),
    check(
      'delivery_test_runs_consumed_confirmation',
      sql`${table.confirmationStatus} = 'consumed'`,
    ),
    check(
      'delivery_test_runs_digest_format',
      sql`${table.endpointReferenceDigest} ~ '^[a-f0-9]{64}$'
        and ${table.consequenceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/**
 * Append-only report revisions. `incomplete` and `unknown` remain first-class
 * truth states; a later correction supersedes rather than rewrites a report.
 */
export const deliveryTestReports = pgTable(
  'delivery_test_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id').notNull(),
    runStartedAt: occurredAt('run_started_at').notNull(),
    sequence: integer('sequence').notNull(),
    supersedesReportId: uuid('supersedes_report_id'),
    status: deliveryTestReportStatusEnum('status').notNull(),
    channels: jsonb('channels').notNull(),
    generatedAt: occurredAt('generated_at').defaultNow().notNull(),
    finalizedBy: jsonb('finalized_by').notNull(),
    source: invocationSourceEnum('source').notNull(),
    reasonCode: auditCode('reason_code'),
  },
  (table) => [
    unique('delivery_test_reports_run_sequence_uq').on(
      table.runId,
      table.sequence,
    ),
    unique('delivery_test_reports_identity_run_uq').on(table.id, table.runId),
    foreignKey({
      columns: [table.runId, table.runStartedAt],
      foreignColumns: [deliveryTestRuns.id, deliveryTestRuns.startedAt],
      name: 'delivery_test_reports_run_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supersedesReportId, table.runId],
      foreignColumns: [table.id, table.runId],
      name: 'delivery_test_reports_supersedes_same_run_fk',
    }).onDelete('restrict'),
    index('delivery_test_reports_generated_at_idx').on(
      table.generatedAt.desc(),
    ),
    check(
      'delivery_test_reports_sequence_positive',
      sql`${table.sequence} > 0`,
    ),
    check(
      'delivery_test_reports_sequence_chain',
      sql`(${table.sequence} = 1) = (${table.supersedesReportId} is null)`,
    ),
    check(
      'delivery_test_reports_not_self_superseding',
      sql`${table.supersedesReportId} is null or ${table.supersedesReportId} <> ${table.id}`,
    ),
    check(
      'delivery_test_reports_channels_shape',
      sql`jsonb_typeof(${table.channels}) is not distinct from 'array'
        and jsonb_array_length(${table.channels}) between 2 and 3`,
    ),
    check(
      'delivery_test_reports_status_reason_truth',
      sql`(
        ${table.status} = 'succeeded' and ${table.reasonCode} is null
      ) or (
        ${table.status} in ('failed', 'incomplete')
        and ${table.reasonCode} is not null
      )`,
    ),
    check(
      'delivery_test_reports_reason_code_format',
      sql`${table.reasonCode} is null or ${table.reasonCode} ~ '^[A-Z0-9_]+$'`,
    ),
    check(
      'delivery_test_reports_system_finalizer',
      sql`${table.finalizedBy} ->> 'kind' is not distinct from 'system'
        and ${table.source} = 'worker'`,
    ),
    check(
      'delivery_test_reports_after_run',
      sql`${table.generatedAt} >= ${table.runStartedAt}`,
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
