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
} from './enums';

import { occurredAt } from './shared';
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
    // Where the response sits in the list an operator chooses from. The
    // district reads its responses in a fixed order (Investigation first,
    // Other last), not alphabetically; a response added on the Responses
    // page takes the default and lists after the ordered ones, by key.
    displayOrder: integer('display_order').default(1000).notNull(),
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

/** Non-secret channel configuration: one enabled flag per channel. */
export const channelConfigurations = pgTable(
  'channel_configurations',
  {
    integrationId: varchar('integration_id', { length: 100 }).primaryKey(),
    enabled: boolean('enabled').notNull(),
    changedAt: occurredAt('changed_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'channel_configurations_id_format',
      sql`${table.integrationId} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
  ],
);
