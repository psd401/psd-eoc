import { sql } from 'drizzle-orm';

import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  notificationChannelEnum,
  templateModeEnum,
  notificationPurposeEnum,
  classificationMarkerEnum,
  integrationTruthLabelEnum,
} from './enums';

import { auditCode, digest, occurredAt } from './shared';

import { users, sessions } from './identity';
/** Stable selectable real or drill event-type identities. */
export const eventTypes = pgTable(
  'event_types',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: varchar('key', { length: 100 }).notNull(),
    familyKey: varchar('family_key', { length: 100 }).notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    // A response such as "Other" that an operator must describe in their own
    // words before it can be chosen.
    requiresDetail: boolean('requires_detail').default(false).notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('event_types_key_uq').on(table.key),
    unique('event_types_identity_mode_uq').on(table.id, table.templateMode),
    index('event_types_family_idx').on(table.familyKey),
    check(
      'event_types_key_format',
      sql`${table.key} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check(
      'event_types_family_key_format',
      sql`${table.familyKey} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
  ],
);

/** Immutable published revisions with complete publication provenance. */
export const eventTypeVersions = pgTable(
  'event_type_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventTypeId: uuid('event_type_id').notNull(),
    version: integer('version').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: varchar('description', { length: 1000 }),
    enabled: boolean('enabled').notNull(),
    supersedesVersionId: uuid('supersedes_version_id'),
    createdBy: jsonb('created_by').notNull(),
    publicationAuthorization: jsonb('publication_authorization').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('event_type_versions_type_version_uq').on(
      table.eventTypeId,
      table.version,
    ),
    unique('event_type_versions_identity_mode_uq').on(
      table.id,
      table.templateMode,
    ),
    foreignKey({
      columns: [table.eventTypeId, table.templateMode],
      foreignColumns: [eventTypes.id, eventTypes.templateMode],
      name: 'event_type_versions_type_mode_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supersedesVersionId, table.templateMode],
      foreignColumns: [table.id, table.templateMode],
      name: 'event_type_versions_supersedes_mode_fk',
    }).onDelete('restrict'),
    check('event_type_versions_version_positive', sql`${table.version} > 0`),
    check(
      'event_type_versions_not_self_superseding',
      sql`${table.supersedesVersionId} is null or ${table.supersedesVersionId} <> ${table.id}`,
    ),
    index('event_type_versions_enabled_idx').on(
      table.templateMode,
      table.enabled,
    ),
  ],
);

/** Purpose- and channel-specific templates for one immutable version. */
export const eventTypeTemplates = pgTable(
  'event_type_templates',
  {
    eventTypeVersionId: uuid('event_type_version_id').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    classificationMarker: classificationMarkerEnum(
      'classification_marker',
    ).notNull(),
    title: varchar('title', { length: 120 }),
    subject: varchar('subject', { length: 200 }),
    body: varchar('body', { length: 1000 }),
    textBody: text('text_body'),
  },
  (table) => [
    primaryKey({
      columns: [table.eventTypeVersionId, table.purpose, table.channel],
    }),
    foreignKey({
      columns: [table.eventTypeVersionId, table.templateMode],
      foreignColumns: [eventTypeVersions.id, eventTypeVersions.templateMode],
      name: 'event_type_templates_version_mode_fk',
    }).onDelete('restrict'),
    check(
      'event_type_templates_marker_matches_mode',
      sql`(
        ${table.templateMode} = 'real' and ${table.classificationMarker} = 'INCIDENT'
      ) or (
        ${table.templateMode} = 'drill' and ${table.classificationMarker} = 'DRILL'
      )`,
    ),
    check(
      'event_type_templates_channel_fields',
      sql`(
        ${table.channel} = 'push'
        and ${table.title} is not null
        and ${table.body} is not null
        and length(${table.body}) <= 500
        and ${table.subject} is null
        and ${table.textBody} is null
      ) or (
        ${table.channel} = 'email'
        and ${table.title} is null
        and ${table.body} is null
        and ${table.subject} is not null
        and ${table.textBody} is not null
        and length(${table.textBody}) <= 10000
      ) or (
        ${table.channel} = 'sms'
        and ${table.title} is null
        and ${table.body} is not null
        and ${table.subject} is null
        and ${table.textBody} is null
      )`,
    ),
  ],
);

/** Unpublished event-type configuration drafts. */
export const eventTypeVersionDrafts = pgTable(
  'event_type_version_drafts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventTypeId: uuid('event_type_id').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: varchar('description', { length: 1000 }),
    draftedBy: jsonb('drafted_by').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('event_type_version_drafts_identity_mode_uq').on(
      table.id,
      table.templateMode,
    ),
    foreignKey({
      columns: [table.eventTypeId, table.templateMode],
      foreignColumns: [eventTypes.id, eventTypes.templateMode],
      name: 'event_type_version_drafts_type_mode_fk',
    }).onDelete('restrict'),
  ],
);

/** Complete templates for an unpublished configuration draft. */
export const eventTypeDraftTemplates = pgTable(
  'event_type_draft_templates',
  {
    eventTypeVersionDraftId: uuid('event_type_version_draft_id').notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
    purpose: notificationPurposeEnum('purpose').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    classificationMarker: classificationMarkerEnum(
      'classification_marker',
    ).notNull(),
    title: varchar('title', { length: 120 }),
    subject: varchar('subject', { length: 200 }),
    body: varchar('body', { length: 1000 }),
    textBody: text('text_body'),
  },
  (table) => [
    primaryKey({
      columns: [table.eventTypeVersionDraftId, table.purpose, table.channel],
    }),
    foreignKey({
      columns: [table.eventTypeVersionDraftId, table.templateMode],
      foreignColumns: [
        eventTypeVersionDrafts.id,
        eventTypeVersionDrafts.templateMode,
      ],
      name: 'event_type_draft_templates_draft_mode_fk',
    }).onDelete('restrict'),
    check(
      'event_type_draft_templates_marker_matches_mode',
      sql`(
        ${table.templateMode} = 'real' and ${table.classificationMarker} = 'INCIDENT'
      ) or (
        ${table.templateMode} = 'drill' and ${table.classificationMarker} = 'DRILL'
      )`,
    ),
    check(
      'event_type_draft_templates_channel_fields',
      sql`(
        ${table.channel} = 'push'
        and ${table.title} is not null
        and ${table.body} is not null
        and length(${table.body}) <= 500
        and ${table.subject} is null
        and ${table.textBody} is null
      ) or (
        ${table.channel} = 'email'
        and ${table.title} is null
        and ${table.body} is null
        and ${table.subject} is not null
        and ${table.textBody} is not null
        and length(${table.textBody}) <= 10000
      ) or (
        ${table.channel} = 'sms'
        and ${table.title} is null
        and ${table.body} is not null
        and ${table.subject} is null
        and ${table.textBody} is null
      )`,
    ),
  ],
);

/** Truth-labeled, append-only observations of external integrations. */
export const integrationStatuses = pgTable(
  'integration_statuses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    integrationId: varchar('integration_id', { length: 100 }).notNull(),
    label: integrationTruthLabelEnum('label').notNull(),
    verifiedAt: occurredAt('verified_at'),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    authorizationReference: varchar('authorization_reference', {
      length: 255,
    }),
    reasonCode: auditCode('reason_code'),
    observedAt: occurredAt('observed_at').defaultNow().notNull(),
  },
  (table) => [
    unique('integration_statuses_identity_integration_label_uq').on(
      table.id,
      table.integrationId,
      table.label,
    ),
    unique('integration_statuses_channel_authorization_anchor_uq').on(
      table.id,
      table.integrationId,
      table.label,
      table.verifiedByUserId,
      table.authorizationReference,
      table.verifiedAt,
    ),
    index('integration_statuses_latest_idx').on(
      table.integrationId,
      table.observedAt,
    ),
    check(
      'integration_statuses_id_format',
      sql`${table.integrationId} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check(
      'integration_statuses_verification_truth',
      sql`(
        ${table.label} = 'live-verified'
        and ${table.verifiedAt} is not null
        and ${table.verifiedByUserId} is not null
        and ${table.authorizationReference} is not null
        and ${table.reasonCode} is null
      ) or (
        ${table.label} <> 'live-verified'
        and ${table.verifiedAt} is null
        and ${table.verifiedByUserId} is null
        and ${table.authorizationReference} is null
        and (
          (${table.label} = 'blocked' and ${table.reasonCode} is not null)
          or (${table.label} <> 'blocked' and ${table.reasonCode} is null)
        )
      )`,
    ),
    check(
      'integration_statuses_verified_before_observed',
      sql`${table.verifiedAt} is null or ${table.verifiedAt} <= ${table.observedAt}`,
    ),
  ],
);

/** Non-secret channel configuration pointing to its exact truth observation. */
export const channelConfigurations = pgTable(
  'channel_configurations',
  {
    integrationId: varchar('integration_id', { length: 100 }).primaryKey(),
    enabled: boolean('enabled').notNull(),
    statusId: uuid('status_id').notNull(),
    statusLabel: integrationTruthLabelEnum('status_label').notNull(),
    changedAt: occurredAt('changed_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.statusId, table.integrationId, table.statusLabel],
      foreignColumns: [
        integrationStatuses.id,
        integrationStatuses.integrationId,
        integrationStatuses.label,
      ],
      name: 'channel_configurations_status_truth_fk',
    }).onDelete('restrict'),
    check(
      'channel_configurations_id_format',
      sql`${table.integrationId} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check(
      'channel_configurations_blocked_disabled',
      sql`${table.statusLabel} <> 'blocked' or ${table.enabled} = false`,
    ),
  ],
);

/**
 * Immutable, single-use evidence that one fresh product-owner artifact was
 * consumed by its exact authorized human session for one live channel change.
 */
export const integrationChannelChangeAuthorizations = pgTable(
  'integration_channel_change_authorizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reference: varchar('reference', { length: 255 }).notNull(),
    authorizationCommitment: digest('authorization_commitment').notNull(),
    integrationStatusId: uuid('integration_status_id').notNull(),
    integrationId: varchar('integration_id', { length: 100 }).notNull(),
    statusLabel: integrationTruthLabelEnum('status_label').notNull(),
    desiredEnabled: boolean('desired_enabled').notNull(),
    requestDigest: digest('request_digest').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    authorizedByUserId: uuid('authorized_by_user_id').notNull(),
    authorizedWithSessionId: uuid('authorized_with_session_id').notNull(),
    issuedAt: occurredAt('issued_at').notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
    consumedByUserId: uuid('consumed_by_user_id').notNull(),
    consumedWithSessionId: uuid('consumed_with_session_id').notNull(),
    consumedRequestId: uuid('consumed_request_id').notNull(),
    consumedAt: occurredAt('consumed_at').notNull(),
  },
  (table) => [
    unique('channel_change_authorizations_reference_uq').on(table.reference),
    unique('channel_change_authorizations_status_uq').on(
      table.integrationStatusId,
    ),
    unique('channel_change_authorizations_commitment_uq').on(
      table.authorizationCommitment,
    ),
    unique('channel_change_authorizations_request_uq').on(
      table.consumedRequestId,
    ),
    index('channel_change_authorizations_integration_idx').on(
      table.integrationId,
      table.consumedAt.desc(),
    ),
    foreignKey({
      columns: [
        table.integrationStatusId,
        table.integrationId,
        table.statusLabel,
        table.authorizedByUserId,
        table.authorizationCommitment,
        table.issuedAt,
      ],
      foreignColumns: [
        integrationStatuses.id,
        integrationStatuses.integrationId,
        integrationStatuses.label,
        integrationStatuses.verifiedByUserId,
        integrationStatuses.authorizationReference,
        integrationStatuses.verifiedAt,
      ],
      name: 'channel_change_authorizations_status_truth_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.authorizedWithSessionId, table.authorizedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'channel_change_authorizations_authorizer_session_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.consumedWithSessionId, table.consumedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'channel_change_authorizations_consumer_session_fk',
    }).onDelete('restrict'),
    check(
      'channel_change_authorizations_live_status',
      sql`${table.statusLabel} = 'live-verified'`,
    ),
    check(
      'channel_change_authorizations_same_human_session',
      sql`${table.authorizedByUserId} = ${table.consumedByUserId}
        and ${table.authorizedWithSessionId} = ${table.consumedWithSessionId}`,
    ),
    check(
      'channel_change_authorizations_reference_format',
      sql`${table.reference} = btrim(${table.reference})
        and length(${table.reference}) between 1 and 255`,
    ),
    check(
      'channel_change_authorizations_integration_id_format',
      sql`${table.integrationId} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check(
      'channel_change_authorizations_digest_format',
      sql`${table.authorizationCommitment} ~ '^[a-f0-9]{64}$'
        and ${table.requestDigest} ~ '^[a-f0-9]{64}$'
        and ${table.consequenceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'channel_change_authorizations_timestamp_precision',
      sql`${table.issuedAt} = date_trunc('milliseconds', ${table.issuedAt})
        and ${table.expiresAt} = date_trunc('milliseconds', ${table.expiresAt})
        and ${table.consumedAt} = date_trunc('milliseconds', ${table.consumedAt})`,
    ),
    check(
      'channel_change_authorizations_expiry_bound',
      sql`${table.expiresAt} > ${table.issuedAt}
        and ${table.expiresAt} <= ${table.issuedAt} + interval '15 minutes'`,
    ),
    check(
      'channel_change_authorizations_consumption_time',
      sql`${table.consumedAt} between ${table.issuedAt} and ${table.expiresAt}`,
    ),
  ],
);
