import { sql } from 'drizzle-orm';

import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  groupSourceKindEnum,
  groupPurposeEnum,
  groupCompletionKindEnum,
  rosterPopulationEnum,
  endpointStatusEnum,
  notificationChannelEnum,
  pushPlatformEnum,
  rosterSyncOutcomeEnum,
} from './enums';

import { auditCode, digest, occurredAt } from './shared';

import { facilities, groupSources } from './configuration';

import { sessions } from './identity';
/** Immutable versions of the expected staff or synthetic roster sources. */
export const rosterSourceConfigurations = pgTable(
  'roster_source_configurations',
  {
    id: uuid('id').notNull(),
    version: integer('version').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    unique('roster_source_configurations_identity_population_uq').on(
      table.id,
      table.version,
      table.population,
    ),
    check(
      'roster_source_configurations_version_positive',
      sql`${table.version} > 0`,
    ),
  ],
);

/** Facilities covered by one roster-source configuration version. */
export const rosterSourceConfigurationFacilities = pgTable(
  'roster_source_configuration_facilities',
  {
    configurationId: uuid('configuration_id').notNull(),
    configurationVersion: integer('configuration_version').notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.configurationId,
        table.configurationVersion,
        table.facilityId,
      ],
    }),
    foreignKey({
      columns: [table.configurationId, table.configurationVersion],
      foreignColumns: [
        rosterSourceConfigurations.id,
        rosterSourceConfigurations.version,
      ],
      name: 'roster_source_configuration_facilities_configuration_fk',
    }).onDelete('restrict'),
  ],
);

/** Group sources expected by one roster-source configuration version. */
export const rosterSourceConfigurationGroups = pgTable(
  'roster_source_configuration_groups',
  {
    configurationId: uuid('configuration_id').notNull(),
    configurationVersion: integer('configuration_version').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    groupSourceId: uuid('group_source_id').notNull(),
    groupSourceKind: groupSourceKindEnum('group_source_kind').notNull(),
    groupPurpose: groupPurposeEnum('group_purpose').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.configurationId,
        table.configurationVersion,
        table.groupSourceId,
      ],
    }),
    foreignKey({
      columns: [
        table.configurationId,
        table.configurationVersion,
        table.population,
      ],
      foreignColumns: [
        rosterSourceConfigurations.id,
        rosterSourceConfigurations.version,
        rosterSourceConfigurations.population,
      ],
      name: 'roster_source_configuration_groups_configuration_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.groupSourceId, table.groupSourceKind, table.groupPurpose],
      foreignColumns: [
        groupSources.id,
        groupSources.kind,
        groupSources.purpose,
      ],
      name: 'roster_source_configuration_groups_source_fk',
    }).onDelete('restrict'),
    check(
      'roster_source_configuration_groups_population_source',
      sql`(
        ${table.population} = 'staff'
        and ${table.groupSourceKind}::text in ('google-group', 'manual')
      ) or (
        ${table.population} = 'synthetic' and ${table.groupSourceKind} = 'synthetic'
      )`,
    ),
    check(
      'roster_source_configuration_groups_non_access',
      sql`${table.groupPurpose} in ('building', 'others')`,
    ),
  ],
);

/** Complete immutable roster snapshots; activations never call Google live. */
export const rosterSnapshots = pgTable(
  'roster_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    version: integer('version').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    complete: boolean('complete').notNull(),
    sourceConfigurationId: uuid('source_configuration_id').notNull(),
    sourceConfigurationVersion: integer(
      'source_configuration_version',
    ).notNull(),
    syncStartedAt: occurredAt('sync_started_at').notNull(),
    capturedAt: occurredAt('captured_at').notNull(),
  },
  (table) => [
    unique('roster_snapshots_version_population_uq').on(
      table.version,
      table.population,
    ),
    unique('roster_snapshots_identity_population_uq').on(
      table.id,
      table.population,
    ),
    foreignKey({
      columns: [
        table.sourceConfigurationId,
        table.sourceConfigurationVersion,
        table.population,
      ],
      foreignColumns: [
        rosterSourceConfigurations.id,
        rosterSourceConfigurations.version,
        rosterSourceConfigurations.population,
      ],
      name: 'roster_snapshots_configuration_population_fk',
    }).onDelete('restrict'),
    check('roster_snapshots_complete_true', sql`${table.complete} = true`),
    check('roster_snapshots_version_positive', sql`${table.version} > 0`),
    check(
      'roster_snapshots_capture_time',
      sql`${table.capturedAt} >= ${table.syncStartedAt}`,
    ),
  ],
);

/** Facilities included in one immutable roster snapshot. */
export const rosterSnapshotFacilities = pgTable(
  'roster_snapshot_facilities',
  {
    rosterSnapshotId: uuid('roster_snapshot_id')
      .notNull()
      .references(() => rosterSnapshots.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.rosterSnapshotId, table.facilityId] }),
    index('roster_snapshot_facilities_facility_idx').on(table.facilityId),
  ],
);

/** Expected and completed source sets retained with a roster snapshot. */
export const rosterSnapshotSources = pgTable(
  'roster_snapshot_sources',
  {
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    groupSourceId: uuid('group_source_id').notNull(),
    groupSourceKind: groupSourceKindEnum('group_source_kind').notNull(),
    groupPurpose: groupPurposeEnum('group_purpose').notNull(),
    completionKind: groupCompletionKindEnum('completion_kind').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.rosterSnapshotId,
        table.groupSourceId,
        table.completionKind,
      ],
    }),
    foreignKey({
      columns: [table.rosterSnapshotId, table.population],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'roster_snapshot_sources_snapshot_population_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.groupSourceId, table.groupSourceKind, table.groupPurpose],
      foreignColumns: [
        groupSources.id,
        groupSources.kind,
        groupSources.purpose,
      ],
      name: 'roster_snapshot_sources_source_fk',
    }).onDelete('restrict'),
    check(
      'roster_snapshot_sources_population_source',
      sql`(
        ${table.population} = 'staff'
        and ${table.groupSourceKind}::text in ('google-group', 'manual')
      ) or (
        ${table.population} = 'synthetic' and ${table.groupSourceKind} = 'synthetic'
      )`,
    ),
    check(
      'roster_snapshot_sources_non_access',
      sql`${table.groupPurpose} in ('building', 'others')`,
    ),
  ],
);

/**
 * Immutable fail-closed sync attempts. Failed or partial work never replaces
 * the last complete snapshot; only an exact complete source set may publish.
 */
export const rosterSyncResults = pgTable(
  'roster_sync_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceConfigurationId: uuid('source_configuration_id').notNull(),
    sourceConfigurationVersion: integer(
      'source_configuration_version',
    ).notNull(),
    population: rosterPopulationEnum('population').notNull(),
    outcome: rosterSyncOutcomeEnum('outcome').notNull(),
    startedAt: occurredAt('started_at').notNull(),
    completedAt: occurredAt('completed_at').notNull(),
    expectedSourceCount: integer('expected_source_count').notNull(),
    completedSourceCount: integer('completed_source_count').notNull(),
    groupFailureCount: integer('group_failure_count').notNull(),
    publishedSnapshotId: uuid('published_snapshot_id'),
  },
  (table) => [
    unique('roster_sync_results_identity_population_uq').on(
      table.id,
      table.population,
    ),
    foreignKey({
      columns: [
        table.sourceConfigurationId,
        table.sourceConfigurationVersion,
        table.population,
      ],
      foreignColumns: [
        rosterSourceConfigurations.id,
        rosterSourceConfigurations.version,
        rosterSourceConfigurations.population,
      ],
      name: 'roster_sync_results_configuration_population_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.publishedSnapshotId, table.population],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'roster_sync_results_published_snapshot_population_fk',
    }).onDelete('restrict'),
    check(
      'roster_sync_results_times',
      sql`${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      'roster_sync_results_counts',
      sql`${table.expectedSourceCount} between 1 and 500
        and ${table.completedSourceCount} between 0 and ${table.expectedSourceCount}
        and ${table.groupFailureCount} between 0 and 500`,
    ),
    check(
      'roster_sync_results_publish_truth',
      sql`(
        ${table.outcome} = 'complete'
        and ${table.publishedSnapshotId} is not null
        and ${table.completedSourceCount} = ${table.expectedSourceCount}
        and ${table.groupFailureCount} = 0
      ) or (
        ${table.outcome} in ('failed', 'partial-rejected')
        and ${table.publishedSnapshotId} is null
      )`,
    ),
  ],
);

/** Expected and completed source sets retained for one sync result. */
export const rosterSyncResultSources = pgTable(
  'roster_sync_result_sources',
  {
    syncResultId: uuid('sync_result_id').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    groupSourceId: uuid('group_source_id').notNull(),
    groupSourceKind: groupSourceKindEnum('group_source_kind').notNull(),
    groupPurpose: groupPurposeEnum('group_purpose').notNull(),
    setKind: groupCompletionKindEnum('set_kind').notNull(),
    expectedSetKind: groupCompletionKindEnum('expected_set_kind')
      .default('expected')
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.syncResultId,
        table.population,
        table.groupSourceId,
        table.groupSourceKind,
        table.groupPurpose,
        table.setKind,
      ],
    }),
    foreignKey({
      columns: [table.syncResultId, table.population],
      foreignColumns: [rosterSyncResults.id, rosterSyncResults.population],
      name: 'roster_sync_result_sources_result_population_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.groupSourceId, table.groupSourceKind, table.groupPurpose],
      foreignColumns: [
        groupSources.id,
        groupSources.kind,
        groupSources.purpose,
      ],
      name: 'roster_sync_result_sources_group_source_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.syncResultId,
        table.population,
        table.groupSourceId,
        table.groupSourceKind,
        table.groupPurpose,
        table.expectedSetKind,
      ],
      foreignColumns: [
        table.syncResultId,
        table.population,
        table.groupSourceId,
        table.groupSourceKind,
        table.groupPurpose,
        table.setKind,
      ],
      name: 'roster_sync_result_sources_completed_expected_fk',
    }).onDelete('restrict'),
    check(
      'roster_sync_result_sources_expected_marker',
      sql`${table.expectedSetKind} = 'expected'`,
    ),
    check(
      'roster_sync_result_sources_population_source',
      sql`(
        ${table.population} = 'staff'
        and ${table.groupSourceKind}::text in ('google-group', 'manual')
      ) or (
        ${table.population} = 'synthetic' and ${table.groupSourceKind} = 'synthetic'
      )`,
    ),
    check(
      'roster_sync_result_sources_non_access',
      sql`${table.groupPurpose} in ('building', 'others')`,
    ),
  ],
);

/** Sanitized, append-only group failures from an attempted roster sync. */
export const rosterSyncGroupFailures = pgTable(
  'roster_sync_group_failures',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    syncResultId: uuid('sync_result_id').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    groupSourceId: uuid('group_source_id').notNull(),
    groupSourceKind: groupSourceKindEnum('group_source_kind').notNull(),
    groupPurpose: groupPurposeEnum('group_purpose').notNull(),
    expectedSetKind: groupCompletionKindEnum('expected_set_kind')
      .default('expected')
      .notNull(),
    errorCode: auditCode('error_code').notNull(),
    attemptedAt: occurredAt('attempted_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.syncResultId,
        table.population,
        table.groupSourceId,
        table.groupSourceKind,
        table.groupPurpose,
        table.expectedSetKind,
      ],
      foreignColumns: [
        rosterSyncResultSources.syncResultId,
        rosterSyncResultSources.population,
        rosterSyncResultSources.groupSourceId,
        rosterSyncResultSources.groupSourceKind,
        rosterSyncResultSources.groupPurpose,
        rosterSyncResultSources.setKind,
      ],
      name: 'roster_sync_group_failures_expected_source_fk',
    }).onDelete('restrict'),
    check(
      'roster_sync_group_failures_expected_marker',
      sql`${table.expectedSetKind} = 'expected'`,
    ),
    check(
      'roster_sync_group_failures_error_format',
      sql`${table.errorCode} ~ '^[A-Z0-9_]+$'`,
    ),
  ],
);

/** Minimized staff or synthetic recipient facts within a pinned snapshot. */
export const rosterRecipients = pgTable(
  'roster_recipients',
  {
    id: uuid('id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id')
      .notNull()
      .references(() => rosterSnapshots.id, { onDelete: 'restrict' }),
    population: rosterPopulationEnum('population').notNull(),
    googleSubject: varchar('google_subject', { length: 255 }),
    staffEmail: varchar('staff_email', { length: 320 }),
    displayName: varchar('display_name', { length: 160 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rosterSnapshotId, table.id] }),
    unique('roster_recipients_snapshot_subject_uq').on(
      table.rosterSnapshotId,
      table.googleSubject,
    ),
    uniqueIndex('roster_recipients_snapshot_staff_email_uq')
      .on(table.rosterSnapshotId, sql`lower(${table.staffEmail})`)
      .where(sql`${table.staffEmail} is not null`),
    unique('roster_recipients_snapshot_identity_population_uq').on(
      table.rosterSnapshotId,
      table.id,
      table.population,
    ),
    foreignKey({
      columns: [table.rosterSnapshotId, table.population],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'roster_recipients_snapshot_population_fk',
    }).onDelete('restrict'),
    check(
      'roster_recipients_population_identity',
      sql`(
        ${table.population} = 'staff'
        and (${table.googleSubject} is not null or ${table.staffEmail} is not null)
      ) or (
        ${table.population} = 'synthetic'
        and ${table.googleSubject} is null
        and ${table.staffEmail} is null
      )`,
    ),
    check(
      'roster_recipients_staff_email_canonical',
      sql`${table.staffEmail} is null or (
        ${table.staffEmail} = lower(${table.staffEmail})
        and ${table.staffEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
      )`,
    ),
  ],
);

/** Group provenance for a recipient within its immutable snapshot. */
export const rosterRecipientGroupSources = pgTable(
  'roster_recipient_group_sources',
  {
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    groupSourceId: uuid('group_source_id').notNull(),
    groupSourceKind: groupSourceKindEnum('group_source_kind').notNull(),
    groupPurpose: groupPurposeEnum('group_purpose').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.rosterSnapshotId, table.recipientId, table.groupSourceId],
    }),
    foreignKey({
      columns: [table.rosterSnapshotId, table.recipientId, table.population],
      foreignColumns: [
        rosterRecipients.rosterSnapshotId,
        rosterRecipients.id,
        rosterRecipients.population,
      ],
      name: 'roster_recipient_group_sources_recipient_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.groupSourceId, table.groupSourceKind, table.groupPurpose],
      foreignColumns: [
        groupSources.id,
        groupSources.kind,
        groupSources.purpose,
      ],
      name: 'roster_recipient_group_sources_source_fk',
    }).onDelete('restrict'),
    check(
      'roster_recipient_group_sources_population_source',
      sql`(
        ${table.population} = 'staff'
        and ${table.groupSourceKind}::text in ('google-group', 'manual')
      ) or (
        ${table.population} = 'synthetic' and ${table.groupSourceKind} = 'synthetic'
      )`,
    ),
    check(
      'roster_recipient_group_sources_non_access',
      sql`${table.groupPurpose} in ('building', 'others')`,
    ),
  ],
);

/** Immutable channel-discriminated endpoint snapshots. */
export const rosterEndpoints = pgTable(
  'roster_endpoints',
  {
    id: uuid('id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    population: rosterPopulationEnum('population').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    status: endpointStatusEnum('status').notNull(),
    capturedAt: occurredAt('captured_at').notNull(),
    platform: pushPlatformEnum('platform'),
    provider: varchar('provider', { length: 32 }),
    serviceEnvironment: varchar('service_environment', { length: 32 }),
    token: text('token'),
    email: varchar('email', { length: 320 }),
    phoneNumber: varchar('phone_number', { length: 16 }),
  },
  (table) => [
    primaryKey({ columns: [table.rosterSnapshotId, table.id] }),
    unique('roster_endpoints_snapshot_recipient_identity_uq').on(
      table.rosterSnapshotId,
      table.recipientId,
      table.id,
    ),
    unique('roster_endpoints_attempt_anchor_uq').on(
      table.rosterSnapshotId,
      table.recipientId,
      table.id,
      table.population,
      table.channel,
    ),
    foreignKey({
      columns: [table.rosterSnapshotId, table.recipientId, table.population],
      foreignColumns: [
        rosterRecipients.rosterSnapshotId,
        rosterRecipients.id,
        rosterRecipients.population,
      ],
      name: 'roster_endpoints_recipient_fk',
    }).onDelete('restrict'),
    index('roster_endpoints_recipient_idx').on(
      table.rosterSnapshotId,
      table.recipientId,
    ),
    index('roster_endpoints_sms_phone_idx')
      .on(table.phoneNumber)
      .where(
        sql`${table.channel} = 'sms' and ${table.phoneNumber} is not null`,
      ),
    check(
      'roster_endpoints_valid_variant',
      sql`(
        ${table.channel} = 'push'
        and ${table.platform} is not null
        and ${table.provider} is not null
        and ${table.provider} in ('expo', 'apns', 'fcm')
        and ${table.serviceEnvironment} is not null
        and ${table.serviceEnvironment} in ('development', 'production')
        and (
          ${table.provider} = 'expo'
          or (${table.provider} = 'apns' and ${table.platform} = 'ios')
          or (${table.provider} = 'fcm' and ${table.platform} = 'android')
        )
        and ${table.token} is not null
        and length(btrim(${table.token})) between 16 and 4096
        and ${table.email} is null
        and ${table.phoneNumber} is null
      ) or (
        ${table.channel} = 'email'
        and ${table.platform} is null
        and ${table.provider} is null
        and ${table.serviceEnvironment} is null
        and ${table.token} is null
        and ${table.email} is not null
        and ${table.phoneNumber} is null
      ) or (
        ${table.channel} = 'sms'
        and ${table.platform} is null
        and ${table.provider} is null
        and ${table.serviceEnvironment} is null
        and ${table.token} is null
        and ${table.email} is null
        and ${table.phoneNumber} is not null
        and ${table.phoneNumber} ~ '^\\+[1-9][0-9]{7,14}$'
      )`,
    ),
    check(
      'roster_endpoints_synthetic_unroutable',
      sql`(
        ${table.population} = 'staff'
        and not (${table.channel} = 'sms' and ${table.phoneNumber} ~ '^\\+999')
      ) or (
        ${table.population} = 'synthetic'
        and (
        (${table.channel} = 'push' and ${table.token} like 'synthetic-unroutable:%')
        or (${table.channel} = 'email' and lower(${table.email}) like '%.invalid')
        or (${table.channel} = 'sms' and (
          ${table.phoneNumber} ~ '^\\+120255501[0-9]{2}$'
          or ${table.phoneNumber} ~ '^\\+999[0-9]{12}$'
        ))
        )
      )`,
    ),
  ],
);

/**
 * Independent append-only product-owner decisions about one controlled-canary
 * endpoint. Revocation is a superseding fact; destinations remain only in the
 * immutable roster and never enter this eligibility ledger.
 */
export const deliveryTestCanaryEligibilityFacts = pgTable(
  'delivery_test_canary_eligibility_facts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    supersedesFactId: uuid('supersedes_fact_id'),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population')
      .default('staff')
      .notNull(),
    recipientId: uuid('recipient_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    decision: varchar('decision', { length: 40 }).notNull(),
    optedInAt: occurredAt('opted_in_at').notNull(),
    decidedAt: occurredAt('decided_at').notNull(),
    decidedByUserId: uuid('decided_by_user_id').notNull(),
    decidedWithSessionId: uuid('decided_with_session_id').notNull(),
    authorizationReference: varchar('authorization_reference', {
      length: 255,
    }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.rosterSnapshotId, table.facilityId],
      foreignColumns: [
        rosterSnapshotFacilities.rosterSnapshotId,
        rosterSnapshotFacilities.facilityId,
      ],
      name: 'delivery_test_canary_eligibility_snapshot_facility_fk',
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
      name: 'delivery_test_canary_eligibility_roster_endpoint_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.decidedWithSessionId, table.decidedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'delivery_test_canary_eligibility_human_session_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supersedesFactId],
      foreignColumns: [table.id],
      name: 'delivery_test_canary_eligibility_supersedes_fk',
    }).onDelete('restrict'),
    unique('delivery_test_canary_eligibility_successor_uq').on(
      table.supersedesFactId,
    ),
    index('delivery_test_canary_eligibility_endpoint_idx').on(
      table.facilityId,
      table.rosterSnapshotId,
      table.recipientId,
      table.endpointId,
      table.channel,
      table.decidedAt.desc(),
    ),
    check(
      'delivery_test_canary_eligibility_staff_only',
      sql`${table.rosterPopulation} = 'staff'`,
    ),
    check(
      'delivery_test_canary_eligibility_decision',
      sql`${table.decision} in ('approved-synthetic-canary', 'revoked')`,
    ),
    check(
      'delivery_test_canary_eligibility_revocation_chain',
      sql`${table.decision} <> 'revoked' or ${table.supersedesFactId} is not null`,
    ),
    check(
      'delivery_test_canary_eligibility_not_self_superseding',
      sql`${table.supersedesFactId} is null or ${table.supersedesFactId} <> ${table.id}`,
    ),
    check(
      'delivery_test_canary_eligibility_times',
      sql`${table.decidedAt} >= ${table.optedInAt}`,
    ),
    check(
      'delivery_test_canary_eligibility_reference_format',
      sql`${table.authorizationReference} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'`,
    ),
  ],
);

/**
 * Immutable product-owner approvals for the exact staff endpoint references
 * that may participate in a monthly live delivery test. Destinations never
 * enter this table; endpoint IDs continue to resolve through the pinned roster.
 */
export const deliveryTestTargetSetVersions = pgTable(
  'delivery_test_target_set_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    version: integer('version').notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population')
      .default('staff')
      .notNull(),
    supersedesVersionId: uuid('supersedes_version_id'),
    endpointReferenceDigest: digest('endpoint_reference_digest').notNull(),
    idempotencyRequestId: uuid('idempotency_request_id').notNull(),
    approvedByUserId: uuid('approved_by_user_id').notNull(),
    approvedWithSessionId: uuid('approved_with_session_id').notNull(),
    approvedAt: occurredAt('approved_at').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('delivery_test_target_sets_identity_version_uq').on(
      table.id,
      table.version,
    ),
    unique('delivery_test_target_sets_roster_anchor_uq').on(
      table.id,
      table.version,
      table.rosterSnapshotId,
    ),
    unique('delivery_test_target_sets_request_uq').on(
      table.idempotencyRequestId,
    ),
    foreignKey({
      columns: [table.rosterSnapshotId, table.rosterPopulation],
      foreignColumns: [rosterSnapshots.id, rosterSnapshots.population],
      name: 'delivery_test_target_sets_roster_population_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.approvedWithSessionId, table.approvedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'delivery_test_target_sets_approver_session_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supersedesVersionId],
      foreignColumns: [table.id],
      name: 'delivery_test_target_sets_supersedes_fk',
    }).onDelete('restrict'),
    index('delivery_test_target_sets_facility_version_idx').on(
      table.facilityId,
      table.version.desc(),
    ),
    check(
      'delivery_test_target_sets_staff_only',
      sql`${table.rosterPopulation} = 'staff'`,
    ),
    check(
      'delivery_test_target_sets_version_positive',
      sql`${table.version} > 0`,
    ),
    check(
      'delivery_test_target_sets_version_chain',
      sql`(${table.version} = 1) = (${table.supersedesVersionId} is null)`,
    ),
    check(
      'delivery_test_target_sets_not_self_superseding',
      sql`${table.supersedesVersionId} is null or ${table.supersedesVersionId} <> ${table.id}`,
    ),
    check(
      'delivery_test_target_sets_digest_format',
      sql`${table.endpointReferenceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'delivery_test_target_sets_times',
      sql`${table.approvedAt} >= ${table.createdAt}`,
    ),
  ],
);

/** Destination-free endpoint references separately attested by the approver. */
export const deliveryTestTargetEndpoints = pgTable(
  'delivery_test_target_endpoints',
  {
    targetSetVersionId: uuid('target_set_version_id').notNull(),
    targetSetVersion: integer('target_set_version').notNull(),
    eligibilityFactId: uuid('eligibility_fact_id').notNull(),
    rosterSnapshotId: uuid('roster_snapshot_id').notNull(),
    rosterPopulation: rosterPopulationEnum('roster_population')
      .default('staff')
      .notNull(),
    recipientId: uuid('recipient_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    attestation: varchar('attestation', { length: 40 }).notNull(),
    optedInAt: occurredAt('opted_in_at').notNull(),
    attestedAt: occurredAt('attested_at').notNull(),
    attestedByUserId: uuid('attested_by_user_id').notNull(),
    authorizationReference: varchar('authorization_reference', {
      length: 255,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.targetSetVersionId,
        table.recipientId,
        table.endpointId,
        table.channel,
      ],
    }),
    foreignKey({
      columns: [table.eligibilityFactId],
      foreignColumns: [deliveryTestCanaryEligibilityFacts.id],
      name: 'delivery_test_target_endpoints_eligibility_fact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.targetSetVersionId,
        table.targetSetVersion,
        table.rosterSnapshotId,
      ],
      foreignColumns: [
        deliveryTestTargetSetVersions.id,
        deliveryTestTargetSetVersions.version,
        deliveryTestTargetSetVersions.rosterSnapshotId,
      ],
      name: 'delivery_test_target_endpoints_target_set_fk',
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
      name: 'delivery_test_target_endpoints_roster_endpoint_fk',
    }).onDelete('restrict'),
    index('delivery_test_target_endpoints_channel_idx').on(
      table.targetSetVersionId,
      table.channel,
    ),
    unique('delivery_test_target_endpoints_eligibility_fact_uq').on(
      table.targetSetVersionId,
      table.eligibilityFactId,
    ),
    check(
      'delivery_test_target_endpoints_attestation_literal',
      sql`${table.attestation} = 'approved-synthetic-canary'`,
    ),
    check(
      'delivery_test_target_endpoints_staff_only',
      sql`${table.rosterPopulation} = 'staff'`,
    ),
    check(
      'delivery_test_target_endpoints_attestation_after_opt_in',
      sql`${table.attestedAt} >= ${table.optedInAt}`,
    ),
    check(
      'delivery_test_target_endpoints_reference_format',
      sql`${table.authorizationReference} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'`,
    ),
  ],
);
