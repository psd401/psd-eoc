import { sql } from 'drizzle-orm';
import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  CAPABILITY_MUTATION_SAFETY_MANIFEST,
  HUMAN_ONLY_ACTION_IDS,
} from '@psd-eoc/contracts';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * PostgreSQL persists the same closed vocabularies owned by
 * `@psd-eoc/contracts`. Changing an enum is therefore a contracts-first
 * migration, never an ad-hoc database edit.
 */
export const actorKindEnum = pgEnum('actor_kind', ['human', 'agent', 'system']);
export const roleEnum = pgEnum('role', ['staff', 'admin']);
export const facilityScopeKindEnum = pgEnum('facility_scope_kind', [
  'district',
  'facilities',
]);
export const devicePlatformEnum = pgEnum('device_platform', [
  'web',
  'ios',
  'android',
]);
export const deviceUnlockMethodEnum = pgEnum('device_unlock_method', [
  'secure-session-cookie',
  'biometric',
]);
export const groupSourceKindEnum = pgEnum('group_source_kind', [
  'google-group',
  'synthetic',
]);
export const groupPurposeEnum = pgEnum('group_purpose', [
  'access',
  'building',
  'others',
]);
export const groupCompletionKindEnum = pgEnum('group_completion_kind', [
  'expected',
  'completed',
]);
export const rosterPopulationEnum = pgEnum('roster_population', [
  'staff',
  'synthetic',
]);
export const endpointStatusEnum = pgEnum('endpoint_status', [
  'active',
  'invalid',
  'disabled',
]);
export const notificationChannelEnum = pgEnum('notification_channel', [
  'push',
  'email',
  'sms',
]);
export const pushPlatformEnum = pgEnum('push_platform', ['ios', 'android']);
export const audienceTargetKindEnum = pgEnum('audience_target_kind', [
  'building',
  'neighborhood',
  'others',
]);
export const eventKindEnum = pgEnum('event_kind', [
  'incident',
  'drill',
  'test',
]);
export const templateModeEnum = pgEnum('template_mode', ['real', 'drill']);
export const notificationPurposeEnum = pgEnum('notification_purpose', [
  'activation',
  'all-clear',
  'reactivation',
]);
export const classificationMarkerEnum = pgEnum('classification_marker', [
  'INCIDENT',
  'DRILL',
]);
export const eventStatusEnum = pgEnum('event_status', [
  'draft',
  'active',
  'all-clear',
  'closed',
]);
export const eventTransitionKindEnum = pgEnum('event_transition_kind', [
  'activate',
  'all-clear',
  'reactivate',
  'close',
  'reopen-as-correction',
]);
export const invocationSourceEnum = pgEnum('invocation_source', [
  'web',
  'mobile',
  'agent-rest',
  'mcp',
  'worker',
  'scheduled-job',
  'webhook',
]);
export const journalEntryKindEnum = pgEnum('journal_entry_kind', [
  'text',
  'photo',
  'location',
  'system',
]);
export const journalSupersessionKindEnum = pgEnum('journal_supersession_kind', [
  'correction',
  'redaction',
]);
export const mediaContentTypeEnum = pgEnum('media_content_type', [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);
export const deliveryTruthStateEnum = pgEnum('delivery_truth_state', [
  'accepted',
  'recorded',
  'attempted',
  'provider-accepted',
  'delivered',
  'failed',
  'expired',
  'unknown',
]);
export const deliveryEvidenceSubjectKindEnum = pgEnum(
  'delivery_evidence_subject_kind',
  ['intent', 'attempt'],
);
export const deliveryTestReportStatusEnum = pgEnum(
  'delivery_test_report_status',
  ['succeeded', 'failed', 'incomplete'],
);
export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'processing',
  'published',
  'failed',
]);
export const fanoutControlModeEnum = pgEnum('fanout_control_mode', [
  'enabled',
  'emergency-disabled',
]);
export const integrationTruthLabelEnum = pgEnum('integration_truth_label', [
  'mocked',
  'configured-unverified',
  'live-verified',
  'blocked',
]);
export const securityAuditCategoryEnum = pgEnum('security_audit_category', [
  'sign-in',
  'access-denial',
  'admin-change',
  'agent-access',
  'session-revocation',
  'human-only-rejection',
  'capability-execution',
  'audit-query',
]);
export const securityAuditOutcomeEnum = pgEnum('security_audit_outcome', [
  'success',
  'denied',
  'failure',
]);
export const agentCapabilityGrantEnum = pgEnum(
  'agent_capability_grant',
  AGENT_GRANTABLE_CAPABILITY_IDS,
);
const mutationCapabilityIds = Object.keys(
  CAPABILITY_MUTATION_SAFETY_MANIFEST,
) as [
  keyof typeof CAPABILITY_MUTATION_SAFETY_MANIFEST,
  ...(keyof typeof CAPABILITY_MUTATION_SAFETY_MANIFEST)[],
];
export const mutationCapabilityEnum = pgEnum(
  'mutation_capability',
  mutationCapabilityIds,
);
export const humanOnlyActionEnum = pgEnum(
  'human_only_action',
  HUMAN_ONLY_ACTION_IDS,
);
export const idempotencyStatusEnum = pgEnum('idempotency_status', [
  'in-progress',
  'completed',
  'failed',
]);
export const humanConfirmationStatusEnum = pgEnum('human_confirmation_status', [
  'issued',
  'consumed',
  'expired',
]);
export const rosterSyncOutcomeEnum = pgEnum('roster_sync_outcome', [
  'complete',
  'failed',
  'partial-rejected',
]);

const auditCode = (name: string) => varchar(name, { length: 100 });
const digest = (name: string) => varchar(name, { length: 64 });
const occurredAt = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** Stable administrator-managed district facilities. */
export const facilities = pgTable(
  'facilities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('facilities_code_uq').on(table.code),
    check('facilities_code_format', sql`${table.code} ~ '^[A-Z0-9-]+$'`),
    check('facilities_name_nonempty', sql`length(btrim(${table.name})) > 0`),
  ],
);

/** Immutable versions of administrator-defined neighborhoods. */
export const neighborhoodVersions = pgTable(
  'neighborhood_versions',
  {
    id: uuid('id').notNull(),
    version: integer('version').notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    check('neighborhood_versions_version_positive', sql`${table.version} > 0`),
    check(
      'neighborhood_versions_name_nonempty',
      sql`length(btrim(${table.name})) > 0`,
    ),
  ],
);

/** Facility membership pinned to one immutable neighborhood version. */
export const neighborhoodFacilities = pgTable(
  'neighborhood_facilities',
  {
    neighborhoodId: uuid('neighborhood_id').notNull(),
    neighborhoodVersion: integer('neighborhood_version').notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.neighborhoodId,
        table.neighborhoodVersion,
        table.facilityId,
      ],
    }),
    foreignKey({
      columns: [table.neighborhoodId, table.neighborhoodVersion],
      foreignColumns: [neighborhoodVersions.id, neighborhoodVersions.version],
      name: 'neighborhood_facilities_version_fk',
    }).onDelete('restrict'),
    index('neighborhood_facilities_facility_idx').on(table.facilityId),
  ],
);

/** Purpose-bound Google Group or fail-closed synthetic source configuration. */
export const groupSources = pgTable(
  'group_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: groupSourceKindEnum('kind').notNull(),
    purpose: groupPurposeEnum('purpose').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id, {
      onDelete: 'restrict',
    }),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    active: boolean('active').default(true).notNull(),
    googleGroupId: varchar('google_group_id', { length: 255 }),
    email: varchar('email', { length: 320 }),
    fixtureKey: varchar('fixture_key', { length: 100 }),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('group_sources_identity_kind_purpose_uq').on(
      table.id,
      table.kind,
      table.purpose,
    ),
    unique('group_sources_google_group_id_uq').on(table.googleGroupId),
    unique('group_sources_fixture_key_uq').on(table.fixtureKey),
    index('group_sources_facility_idx').on(table.facilityId),
    check(
      'group_sources_valid_variant',
      sql`(
        ${table.kind} = 'google-group'
        and ${table.googleGroupId} is not null
        and ${table.email} is not null
        and ${table.fixtureKey} is null
        and (
          (${table.purpose} = 'building' and ${table.facilityId} is not null)
          or (${table.purpose} in ('access', 'others') and ${table.facilityId} is null)
        )
      ) or (
        ${table.kind} = 'synthetic'
        and ${table.googleGroupId} is null
        and ${table.email} is null
        and ${table.fixtureKey} is not null
        and ${table.purpose} in ('building', 'others')
        and (
          (${table.purpose} = 'building' and ${table.facilityId} is not null)
          or (${table.purpose} = 'others' and ${table.facilityId} is null)
        )
      )`,
    ),
    check(
      'group_sources_fixture_key_format',
      sql`${table.fixtureKey} is null or ${table.fixtureKey} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
  ],
);

/** Immutable versions of a facility's audience policy. */
export const audienceConfigurations = pgTable(
  'audience_configurations',
  {
    id: uuid('id').notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    unique('audience_configurations_identity_facility_uq').on(
      table.id,
      table.version,
      table.facilityId,
    ),
    check(
      'audience_configurations_version_positive',
      sql`${table.version} > 0`,
    ),
    index('audience_configurations_facility_idx').on(table.facilityId),
  ],
);

/** Normalized, explicit target components for an audience policy version. */
export const audienceTargets = pgTable(
  'audience_targets',
  {
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
    ordinal: integer('ordinal').notNull(),
    targetKind: audienceTargetKindEnum('target_kind').notNull(),
    targetFacilityId: uuid('target_facility_id').references(
      () => facilities.id,
      { onDelete: 'restrict' },
    ),
    neighborhoodId: uuid('neighborhood_id'),
    neighborhoodVersion: integer('neighborhood_version'),
    groupSourceId: uuid('group_source_id').references(() => groupSources.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.audienceConfigId,
        table.audienceConfigVersion,
        table.ordinal,
      ],
    }),
    foreignKey({
      columns: [table.audienceConfigId, table.audienceConfigVersion],
      foreignColumns: [
        audienceConfigurations.id,
        audienceConfigurations.version,
      ],
      name: 'audience_targets_configuration_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.neighborhoodId, table.neighborhoodVersion],
      foreignColumns: [neighborhoodVersions.id, neighborhoodVersions.version],
      name: 'audience_targets_neighborhood_fk',
    }).onDelete('restrict'),
    check('audience_targets_ordinal_positive', sql`${table.ordinal} > 0`),
    check(
      'audience_targets_valid_variant',
      sql`(
        ${table.targetKind} = 'building'
        and ${table.targetFacilityId} is not null
        and ${table.neighborhoodId} is null
        and ${table.neighborhoodVersion} is null
        and ${table.groupSourceId} is null
      ) or (
        ${table.targetKind} = 'neighborhood'
        and ${table.targetFacilityId} is null
        and ${table.neighborhoodId} is not null
        and ${table.neighborhoodVersion} is not null
        and ${table.groupSourceId} is null
      ) or (
        ${table.targetKind} = 'others'
        and ${table.targetFacilityId} is null
        and ${table.neighborhoodId} is null
        and ${table.neighborhoodVersion} is null
        and ${table.groupSourceId} is not null
      )`,
    ),
  ],
);

/** Minimized staff identities. There is deliberately no student identity table. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    googleSubject: varchar('google_subject', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    facilityScopeKind: facilityScopeKindEnum('facility_scope_kind').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    disabledAt: occurredAt('disabled_at'),
  },
  (table) => [
    uniqueIndex('users_google_subject_uq').on(table.googleSubject),
    uniqueIndex('users_email_lower_uq').on(sql`lower(${table.email})`),
    check('users_psd_email', sql`lower(${table.email}) like '%@psd401.net'`),
    check(
      'users_disabled_after_creation',
      sql`${table.disabledAt} is null or ${table.disabledAt} >= ${table.createdAt}`,
    ),
  ],
);

/** Normalized unique role grants for a user. */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: roleEnum('role').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

/** Explicit facility rows for users whose scope is not district-wide. */
export const userFacilityScopes = pgTable(
  'user_facility_scopes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.facilityId] }),
    index('user_facility_scopes_facility_idx').on(table.facilityId),
  ],
);

/** Device-bound enrollment metadata; no plaintext credential is stored. */
export const deviceEnrollments = pgTable(
  'device_enrollments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    platform: devicePlatformEnum('platform').notNull(),
    unlockMethod: deviceUnlockMethodEnum('unlock_method').notNull(),
    installationId: varchar('installation_id', { length: 255 }).notNull(),
    enrolledAt: occurredAt('enrolled_at').defaultNow().notNull(),
    lastSeenAt: occurredAt('last_seen_at').defaultNow().notNull(),
    revokedAt: occurredAt('revoked_at'),
  },
  (table) => [
    unique('device_enrollments_identity_user_uq').on(table.id, table.userId),
    unique('device_enrollments_identity_platform_uq').on(
      table.id,
      table.platform,
    ),
    uniqueIndex('device_enrollments_installation_uq').on(table.installationId),
    index('device_enrollments_user_idx').on(table.userId),
    check(
      'device_enrollments_unlock_platform',
      sql`(
        ${table.platform} = 'web' and ${table.unlockMethod} = 'secure-session-cookie'
      ) or (
        ${table.platform} in ('ios', 'android') and ${table.unlockMethod} = 'biometric'
      )`,
    ),
    check(
      'device_enrollments_times',
      sql`${table.lastSeenAt} >= ${table.enrolledAt}
        and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.enrolledAt})`,
    ),
  ],
);

/** Complete immutable Google access-membership snapshots. */
export const accessMembershipSnapshots = pgTable(
  'access_membership_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    version: integer('version').notNull(),
    complete: boolean('complete').notNull(),
    syncStartedAt: occurredAt('sync_started_at').notNull(),
    capturedAt: occurredAt('captured_at').notNull(),
  },
  (table) => [
    unique('access_membership_snapshots_version_uq').on(table.version),
    check(
      'access_membership_snapshots_complete_true',
      sql`${table.complete} = true`,
    ),
    check(
      'access_membership_snapshots_version_positive',
      sql`${table.version} > 0`,
    ),
    check(
      'access_membership_snapshots_times',
      sql`${table.capturedAt} >= ${table.syncStartedAt}`,
    ),
  ],
);

/** Expected and completed designated access groups for a complete snapshot. */
export const accessMembershipSnapshotGroups = pgTable(
  'access_membership_snapshot_groups',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => accessMembershipSnapshots.id, {
        onDelete: 'restrict',
      }),
    groupSourceId: uuid('group_source_id').notNull(),
    groupSourceKind: groupSourceKindEnum('group_source_kind').notNull(),
    groupPurpose: groupPurposeEnum('group_purpose').notNull(),
    completionKind: groupCompletionKindEnum('completion_kind').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.snapshotId, table.groupSourceId, table.completionKind],
    }),
    foreignKey({
      columns: [table.groupSourceId, table.groupSourceKind, table.groupPurpose],
      foreignColumns: [
        groupSources.id,
        groupSources.kind,
        groupSources.purpose,
      ],
      name: 'access_membership_snapshot_groups_access_source_fk',
    }).onDelete('restrict'),
    check(
      'access_membership_snapshot_groups_access_only',
      sql`${table.groupSourceKind} = 'google-group'
        and ${table.groupPurpose} = 'access'`,
    ),
  ],
);

/** Minimized staff membership facts in an immutable access snapshot. */
export const accessMembershipMembers = pgTable(
  'access_membership_members',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => accessMembershipSnapshots.id, {
        onDelete: 'restrict',
      }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    googleSubject: varchar('google_subject', { length: 255 }).notNull(),
    facilityScopeKind: facilityScopeKindEnum('facility_scope_kind').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.userId] }),
    unique('access_membership_members_subject_uq').on(
      table.snapshotId,
      table.googleSubject,
    ),
  ],
);

/** Access-group provenance for one snapshotted member. */
export const accessMembershipMemberGroups = pgTable(
  'access_membership_member_groups',
  {
    snapshotId: uuid('snapshot_id').notNull(),
    userId: uuid('user_id').notNull(),
    groupSourceId: uuid('group_source_id').notNull(),
    groupSourceKind: groupSourceKindEnum('group_source_kind').notNull(),
    groupPurpose: groupPurposeEnum('group_purpose').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.snapshotId, table.userId, table.groupSourceId],
    }),
    foreignKey({
      columns: [table.snapshotId, table.userId],
      foreignColumns: [
        accessMembershipMembers.snapshotId,
        accessMembershipMembers.userId,
      ],
      name: 'access_membership_member_groups_member_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.groupSourceId, table.groupSourceKind, table.groupPurpose],
      foreignColumns: [
        groupSources.id,
        groupSources.kind,
        groupSources.purpose,
      ],
      name: 'access_membership_member_groups_access_source_fk',
    }).onDelete('restrict'),
    check(
      'access_membership_member_groups_access_only',
      sql`${table.groupSourceKind} = 'google-group'
        and ${table.groupPurpose} = 'access'`,
    ),
  ],
);

/** Explicit facility scope captured with an access-member fact. */
export const accessMembershipMemberFacilities = pgTable(
  'access_membership_member_facilities',
  {
    snapshotId: uuid('snapshot_id').notNull(),
    userId: uuid('user_id').notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.userId, table.facilityId] }),
    foreignKey({
      columns: [table.snapshotId, table.userId],
      foreignColumns: [
        accessMembershipMembers.snapshotId,
        accessMembershipMembers.userId,
      ],
      name: 'access_membership_member_facilities_member_fk',
    }).onDelete('restrict'),
  ],
);

/** Long-lived device-bound application sessions. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    deviceEnrollmentId: uuid('device_enrollment_id')
      .notNull()
      .references(() => deviceEnrollments.id, { onDelete: 'restrict' }),
    membershipSnapshotId: uuid('membership_snapshot_id')
      .notNull()
      .references(() => accessMembershipSnapshots.id, {
        onDelete: 'restrict',
      }),
    membershipValidUntil: occurredAt('membership_valid_until').notNull(),
    membershipGraceUntil: occurredAt('membership_grace_until').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
    revokedAt: occurredAt('revoked_at'),
  },
  (table) => [
    unique('sessions_identity_user_uq').on(table.id, table.userId),
    foreignKey({
      columns: [table.deviceEnrollmentId, table.userId],
      foreignColumns: [deviceEnrollments.id, deviceEnrollments.userId],
      name: 'sessions_device_user_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.membershipSnapshotId, table.userId],
      foreignColumns: [
        accessMembershipMembers.snapshotId,
        accessMembershipMembers.userId,
      ],
      name: 'sessions_membership_user_fk',
    }).onDelete('restrict'),
    index('sessions_user_idx').on(table.userId),
    index('sessions_device_idx').on(table.deviceEnrollmentId),
    check(
      'sessions_lifecycle_times',
      sql`${table.expiresAt} >= ${table.createdAt}
        and ${table.membershipValidUntil} >= ${table.createdAt}
        and ${table.membershipGraceUntil} >= ${table.membershipValidUntil}
        and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})`,
    ),
  ],
);

/**
 * Append-only district-wide notification fan-out control history.
 *
 * Absence is deliberately interpreted as emergency-disabled by the shared
 * reader. An enabled record is valid only with a fresh epoch and retained
 * product-owner authorization reference.
 */
export const fanoutControlRecords = pgTable(
  'fanout_control_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revision: integer('revision').notNull(),
    previousRecordId: uuid('previous_record_id'),
    mode: fanoutControlModeEnum('mode').notNull(),
    enableEpochId: uuid('enable_epoch_id'),
    reason: varchar('reason', { length: 500 }).notNull(),
    productOwnerApprovalReference: varchar('product_owner_approval_reference', {
      length: 255,
    }),
    changedByUserId: uuid('changed_by_user_id').notNull(),
    changedWithSessionId: uuid('changed_with_session_id').notNull(),
    requestId: uuid('request_id').notNull(),
    changedAt: occurredAt('changed_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('fanout_control_records_revision_uq').on(table.revision),
    uniqueIndex('fanout_control_records_previous_uq')
      .on(table.previousRecordId)
      .where(sql`${table.previousRecordId} is not null`),
    uniqueIndex('fanout_control_records_enable_epoch_uq')
      .on(table.enableEpochId)
      .where(sql`${table.enableEpochId} is not null`),
    uniqueIndex('fanout_control_records_approval_reference_uq')
      .on(sql`lower(${table.productOwnerApprovalReference})`)
      .where(sql`${table.productOwnerApprovalReference} is not null`),
    uniqueIndex('fanout_control_records_request_uq').on(table.requestId),
    unique('fanout_control_records_enabled_anchor_uq').on(
      table.id,
      table.enableEpochId,
      table.mode,
    ),
    index('fanout_control_records_latest_idx').on(table.revision.desc()),
    foreignKey({
      columns: [table.previousRecordId],
      foreignColumns: [table.id],
      name: 'fanout_control_records_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.changedWithSessionId, table.changedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'fanout_control_records_changer_session_fk',
    }).onDelete('restrict'),
    check(
      'fanout_control_records_revision_positive',
      sql`${table.revision} > 0`,
    ),
    check(
      'fanout_control_records_root_revision',
      sql`(${table.revision} = 1) = (${table.previousRecordId} is null)`,
    ),
    check(
      'fanout_control_records_reason_nonempty',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) > 0`,
    ),
    check(
      'fanout_control_records_mode_evidence',
      sql`(
        ${table.mode} = 'enabled'
        and ${table.enableEpochId} is not null
        and ${table.productOwnerApprovalReference} is not null
        and ${table.productOwnerApprovalReference} = btrim(${table.productOwnerApprovalReference})
        and length(${table.productOwnerApprovalReference}) > 0
      ) or (
        ${table.mode} = 'emergency-disabled'
        and ${table.enableEpochId} is null
        and ${table.productOwnerApprovalReference} is null
      )`,
    ),
  ],
);

/** Append-only role grants and revocations ordered by one monotonic sequence. */
export const userRoleChanges = pgTable(
  'user_role_changes',
  {
    sequence: serial('sequence').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: roleEnum('role').notNull(),
    granted: boolean('granted').notNull(),
    changedByUserId: uuid('changed_by_user_id').notNull(),
    changedWithSessionId: uuid('changed_with_session_id').notNull(),
    requestId: uuid('request_id').notNull(),
    occurredAt: occurredAt('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    unique('user_role_changes_request_user_role_uq').on(
      table.requestId,
      table.userId,
      table.role,
    ),
    foreignKey({
      columns: [table.changedWithSessionId, table.changedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'user_role_changes_changer_session_fk',
    }).onDelete('restrict'),
    index('user_role_changes_effective_idx').on(
      table.userId,
      table.role,
      table.sequence.desc(),
    ),
    index('user_role_changes_changer_idx').on(
      table.changedByUserId,
      table.sequence.desc(),
    ),
    check('user_role_changes_sequence_positive', sql`${table.sequence} > 0`),
  ],
);

/** Server-issued online epoch; reconnection creates a new row. */
export const connectivityEpochs = pgTable(
  'connectivity_epochs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    establishedAt: occurredAt('established_at').defaultNow().notNull(),
  },
  (table) => [
    unique('connectivity_epochs_identity_session_uq').on(
      table.id,
      table.sessionId,
    ),
    index('connectivity_epochs_session_idx').on(table.sessionId),
  ],
);

/** Append-only connectivity invalidation facts. */
export const connectivityEpochInvalidations = pgTable(
  'connectivity_epoch_invalidations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    connectivityEpochId: uuid('connectivity_epoch_id')
      .notNull()
      .references(() => connectivityEpochs.id, { onDelete: 'restrict' }),
    reason: varchar('reason', { length: 32 }).notNull(),
    invalidatedAt: occurredAt('invalidated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('connectivity_epoch_invalidations_epoch_uq').on(
      table.connectivityEpochId,
    ),
    check(
      'connectivity_epoch_invalidations_reason',
      sql`${table.reason} in ('disconnected', 'reconnected', 'session-revoked')`,
    ),
  ],
);

/** Append-only initial refresh-token digest issuance. */
export const sessionTokenIssuances = pgTable(
  'session_token_issuances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    tokenDigest: digest('token_digest').notNull(),
    issuedAt: occurredAt('issued_at').defaultNow().notNull(),
  },
  (table) => [
    unique('session_token_issuances_session_uq').on(table.sessionId),
    unique('session_token_issuances_digest_uq').on(table.tokenDigest),
    check(
      'session_token_issuances_digest_format',
      sql`${table.tokenDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Append-only refresh-token rotations retaining digests only. */
export const sessionTokenRotations = pgTable(
  'session_token_rotations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    previousTokenDigest: digest('previous_token_digest').notNull(),
    nextTokenDigest: digest('next_token_digest').notNull(),
    rotatedAt: occurredAt('rotated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('session_token_rotations_identity_session_uq').on(
      table.id,
      table.sessionId,
    ),
    unique('session_token_rotations_previous_uq').on(table.previousTokenDigest),
    unique('session_token_rotations_next_uq').on(table.nextTokenDigest),
    index('session_token_rotations_session_idx').on(table.sessionId),
    check(
      'session_token_rotations_changed',
      sql`${table.previousTokenDigest} <> ${table.nextTokenDigest}`,
    ),
    check(
      'session_token_rotations_digest_format',
      sql`${table.previousTokenDigest} ~ '^[a-f0-9]{64}$'
        and ${table.nextTokenDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Append-only replay detections tied to the retired rotation. */
export const sessionTokenReplays = pgTable(
  'session_token_replays',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    rotationId: uuid('rotation_id').notNull(),
    detectedAt: occurredAt('detected_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.rotationId, table.sessionId],
      foreignColumns: [
        sessionTokenRotations.id,
        sessionTokenRotations.sessionId,
      ],
      name: 'session_token_replays_rotation_session_fk',
    }).onDelete('restrict'),
    index('session_token_replays_session_idx').on(table.sessionId),
  ],
);

/** Append-only session revocation provenance. */
export const sessionRevocations = pgTable(
  'session_revocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    revokedBy: jsonb('revoked_by').notNull(),
    reasonCode: auditCode('reason_code').notNull(),
    revokedAt: occurredAt('revoked_at').defaultNow().notNull(),
  },
  (table) => [
    index('session_revocations_session_idx').on(table.sessionId),
    check(
      'session_revocations_reason_format',
      sql`${table.reasonCode} ~ '^[A-Z0-9_]+$'`,
    ),
  ],
);

/**
 * Native push registrations are retained as contact records. The token is
 * never copied to logs or audit rows, and unregistration appends a separate
 * fact rather than deleting the registration.
 */
export const devicePushTokenRegistrations = pgTable(
  'device_push_token_registrations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    deviceEnrollmentId: uuid('device_enrollment_id').notNull(),
    platform: devicePlatformEnum('platform').notNull(),
    token: text('token').notNull(),
    registeredAt: occurredAt('registered_at').defaultNow().notNull(),
  },
  (table) => [
    unique('device_push_token_registrations_identity_device_uq').on(
      table.id,
      table.deviceEnrollmentId,
    ),
    foreignKey({
      columns: [table.deviceEnrollmentId, table.platform],
      foreignColumns: [deviceEnrollments.id, deviceEnrollments.platform],
      name: 'device_push_token_registrations_device_platform_fk',
    }).onDelete('restrict'),
    index('device_push_token_registrations_device_idx').on(
      table.deviceEnrollmentId,
      table.registeredAt,
    ),
    check(
      'device_push_token_registrations_native_only',
      sql`${table.platform} in ('ios', 'android')`,
    ),
    check(
      'device_push_token_registrations_token_length',
      sql`length(btrim(${table.token})) between 16 and 4096`,
    ),
  ],
);

/** Append-only push-token unregistration provenance. */
export const devicePushTokenUnregistrations = pgTable(
  'device_push_token_unregistrations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    registrationId: uuid('registration_id').notNull(),
    deviceEnrollmentId: uuid('device_enrollment_id').notNull(),
    unregisteredAt: occurredAt('unregistered_at').defaultNow().notNull(),
  },
  (table) => [
    unique('device_push_token_unregistrations_registration_uq').on(
      table.registrationId,
    ),
    foreignKey({
      columns: [table.registrationId, table.deviceEnrollmentId],
      foreignColumns: [
        devicePushTokenRegistrations.id,
        devicePushTokenRegistrations.deviceEnrollmentId,
      ],
      name: 'device_push_token_unregistrations_registration_device_fk',
    }).onDelete('restrict'),
  ],
);

/** Persisted replay protection for every registered mutation capability. */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: varchar('key', { length: 200 }).notNull(),
    capabilityId: mutationCapabilityEnum('capability_id').notNull(),
    principal: jsonb('principal').notNull(),
    principalDigest: digest('principal_digest').notNull(),
    requestDigest: digest('request_digest').notNull(),
    status: idempotencyStatusEnum('status').notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
    completedAt: occurredAt('completed_at'),
    resultReference: varchar('result_reference', { length: 500 }),
  },
  (table) => [
    unique('idempotency_records_scope_key_uq').on(
      table.capabilityId,
      table.principalDigest,
      table.key,
    ),
    check(
      'idempotency_records_key_format',
      sql`length(${table.key}) between 16 and 200
        and ${table.key} ~ '^[A-Za-z0-9._:-]+$'`,
    ),
    check(
      'idempotency_records_digest_format',
      sql`${table.principalDigest} ~ '^[a-f0-9]{64}$'
        and ${table.requestDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'idempotency_records_terminal_state',
      sql`(
        ${table.status} = 'in-progress'
        and ${table.completedAt} is null
        and ${table.resultReference} is null
      ) or (
        ${table.status} in ('completed', 'failed')
        and ${table.completedAt} is not null
        and ${table.completedAt} >= ${table.createdAt}
        and ${table.resultReference} is not null
      )`,
    ),
  ],
);

/** Single-use, short-lived human consequence confirmation records. */
export const humanConfirmationRecords = pgTable(
  'human_confirmation_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    capabilityId: mutationCapabilityEnum('capability_id').notNull(),
    connectivityEpochId: uuid('connectivity_epoch_id').notNull(),
    confirmedByUserId: uuid('confirmed_by_user_id').notNull(),
    confirmedWithSessionId: uuid('confirmed_with_session_id').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    issuedAt: occurredAt('issued_at').defaultNow().notNull(),
    expiresAt: occurredAt('expires_at').notNull(),
    status: humanConfirmationStatusEnum('status').notNull(),
    consumedAt: occurredAt('consumed_at'),
    consumedForRequestId: uuid('consumed_for_request_id'),
    expiredAt: occurredAt('expired_at'),
  },
  (table) => [
    unique('human_confirmation_records_consumption_anchor_uq').on(
      table.id,
      table.status,
      table.consumedForRequestId,
      table.consequenceDigest,
    ),
    unique('human_confirmation_records_consumed_request_uq').on(
      table.consumedForRequestId,
    ),
    foreignKey({
      columns: [table.connectivityEpochId, table.confirmedWithSessionId],
      foreignColumns: [connectivityEpochs.id, connectivityEpochs.sessionId],
      name: 'human_confirmation_records_epoch_session_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.confirmedWithSessionId, table.confirmedByUserId],
      foreignColumns: [sessions.id, sessions.userId],
      name: 'human_confirmation_records_session_user_fk',
    }).onDelete('restrict'),
    check(
      'human_confirmation_records_digest_format',
      sql`${table.consequenceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'human_confirmation_records_expiry_bound',
      sql`${table.expiresAt} >= ${table.issuedAt}
        and ${table.expiresAt} <= ${table.issuedAt} + interval '5 minutes'`,
    ),
    check(
      'human_confirmation_records_status',
      sql`(
        ${table.status} = 'issued'
        and ${table.consumedAt} is null
        and ${table.consumedForRequestId} is null
        and ${table.expiredAt} is null
      ) or (
        ${table.status} = 'consumed'
        and ${table.consumedAt} is not null
        and ${table.consumedAt} between ${table.issuedAt} and ${table.expiresAt}
        and ${table.consumedForRequestId} is not null
        and ${table.expiredAt} is null
      ) or (
        ${table.status} = 'expired'
        and ${table.consumedAt} is null
        and ${table.consumedForRequestId} is null
        and ${table.expiredAt} is not null
        and ${table.expiredAt} >= ${table.expiresAt}
      )`,
    ),
  ],
);

/** The exact protected-action set reviewed by a human confirmation. */
export const humanConfirmationActions = pgTable(
  'human_confirmation_actions',
  {
    confirmationId: uuid('confirmation_id')
      .notNull()
      .references(() => humanConfirmationRecords.id, {
        onDelete: 'restrict',
      }),
    actionId: humanOnlyActionEnum('action_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.confirmationId, table.actionId] })],
);

/** District agent principals. */
export const agents = pgTable('agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  displayName: varchar('display_name', { length: 160 }).notNull(),
  createdAt: occurredAt('created_at').defaultNow().notNull(),
});

/** Revocable agent API-key verifier metadata; plaintext keys never persist. */
export const agentApiKeys = pgTable(
  'agent_api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    facilityScopeKind: facilityScopeKindEnum('facility_scope_kind').notNull(),
    keyPrefix: varchar('key_prefix', { length: 24 }).notNull(),
    credentialDigest: digest('credential_digest').notNull(),
    issuedByUserId: uuid('issued_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    issuedAt: occurredAt('issued_at').defaultNow().notNull(),
    expiresAt: occurredAt('expires_at'),
    revokedAt: occurredAt('revoked_at'),
  },
  (table) => [
    uniqueIndex('agent_api_keys_prefix_uq').on(table.keyPrefix),
    uniqueIndex('agent_api_keys_digest_uq').on(table.credentialDigest),
    index('agent_api_keys_agent_idx').on(table.agentId),
    check(
      'agent_api_keys_lifecycle_times',
      sql`(${table.expiresAt} is null or ${table.expiresAt} >= ${table.issuedAt})
        and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.issuedAt})`,
    ),
    check(
      'agent_api_keys_digest_format',
      sql`${table.credentialDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Explicit facility scope for a non-district agent key. */
export const agentApiKeyFacilities = pgTable(
  'agent_api_key_facilities',
  {
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => agentApiKeys.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.apiKeyId, table.facilityId] })],
);

/** Closed capability grants carried by an agent API key. */
export const agentApiKeyGrants = pgTable(
  'agent_api_key_grants',
  {
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => agentApiKeys.id, { onDelete: 'restrict' }),
    capabilityId: agentCapabilityGrantEnum('capability_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.apiKeyId, table.capabilityId] })],
);

/** Append-only API-key revocation evidence. */
export const agentApiKeyRevocations = pgTable(
  'agent_api_key_revocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => agentApiKeys.id, { onDelete: 'restrict' }),
    revokedByUserId: uuid('revoked_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reasonCode: auditCode('reason_code').notNull(),
    revokedAt: occurredAt('revoked_at').defaultNow().notNull(),
  },
  (table) => [
    unique('agent_api_key_revocations_key_uq').on(table.apiKeyId),
    check(
      'agent_api_key_revocations_reason_format',
      sql`${table.reasonCode} ~ '^[A-Z0-9_]+$'`,
    ),
  ],
);

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
        ${table.population} = 'staff' and ${table.groupSourceKind} = 'google-group'
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
        ${table.population} = 'staff' and ${table.groupSourceKind} = 'google-group'
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
        ${table.population} = 'staff' and ${table.groupSourceKind} = 'google-group'
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
        and ${table.staffEmail} ~ '^[^@[:space:]]+@psd401[.]net$'
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
        ${table.population} = 'staff' and ${table.groupSourceKind} = 'google-group'
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
        and ${table.token} is not null
        and length(btrim(${table.token})) between 16 and 4096
        and ${table.email} is null
        and ${table.phoneNumber} is null
      ) or (
        ${table.channel} = 'email'
        and ${table.platform} is null
        and ${table.token} is null
        and ${table.email} is not null
        and ${table.phoneNumber} is null
      ) or (
        ${table.channel} = 'sms'
        and ${table.platform} is null
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

/** Stable selectable real or drill event-type identities. */
export const eventTypes = pgTable(
  'event_types',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: varchar('key', { length: 100 }).notNull(),
    familyKey: varchar('family_key', { length: 100 }).notNull(),
    templateMode: templateModeEnum('template_mode').notNull(),
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
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
    recipientCount: integer('recipient_count').notNull(),
    channels: jsonb('channels').notNull(),
    sendReadiness: varchar('send_readiness', { length: 16 }).notNull(),
    blockingReasonCodes: jsonb('blocking_reason_codes').notNull(),
    activeEventIds: jsonb('active_event_ids').notNull(),
    consequenceDigest: digest('consequence_digest').notNull(),
    deliveryTestTargetSetId: uuid('delivery_test_target_set_id'),
    deliveryTestTargetSetVersion: integer('delivery_test_target_set_version'),
    deliveryTestEndpointReferenceDigest: digest(
      'delivery_test_endpoint_reference_digest',
    ),
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
      table.audienceConfigId,
      table.audienceConfigVersion,
      table.consequenceDigest,
    ),
    unique('activation_previews_delivery_test_anchor_uq').on(
      table.id,
      table.deliveryTestTargetSetId,
      table.deliveryTestTargetSetVersion,
      table.deliveryTestEndpointReferenceDigest,
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
    foreignKey({
      columns: [table.audienceConfigId, table.audienceConfigVersion],
      foreignColumns: [
        audienceConfigurations.id,
        audienceConfigurations.version,
      ],
      name: 'activation_previews_audience_fk',
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
      name: 'activation_previews_delivery_test_target_set_fk',
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
      'activation_previews_delivery_test_truth',
      sql`(
        ${table.deliveryTestTargetSetId} is null
        and ${table.deliveryTestTargetSetVersion} is null
        and ${table.deliveryTestEndpointReferenceDigest} is null
      ) or (
        ${table.deliveryTestTargetSetId} is not null
        and ${table.deliveryTestTargetSetVersion} is not null
        and ${table.deliveryTestEndpointReferenceDigest} is not null
        and ${table.kind} = 'drill'
        and ${table.templateMode} = 'drill'
        and ${table.rosterPopulation} = 'staff'
      )`,
    ),
    check(
      'activation_previews_delivery_test_digest_format',
      sql`${table.deliveryTestEndpointReferenceDigest} is null
        or ${table.deliveryTestEndpointReferenceDigest} ~ '^[a-f0-9]{64}$'`,
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
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
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
      table.audienceConfigId,
      table.audienceConfigVersion,
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
        table.audienceConfigId,
        table.audienceConfigVersion,
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
        activationPreviews.audienceConfigId,
        activationPreviews.audienceConfigVersion,
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
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
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
    foreignKey({
      columns: [table.audienceConfigId, table.audienceConfigVersion],
      foreignColumns: [
        audienceConfigurations.id,
        audienceConfigurations.version,
      ],
      name: 'lifecycle_consequence_previews_audience_fk',
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
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
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
        table.audienceConfigId,
        table.audienceConfigVersion,
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
        preparedActivations.audienceConfigId,
        preparedActivations.audienceConfigVersion,
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

/** Immutable, transactionally recorded fan-out intents. */
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
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
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
      table.audienceConfigId,
      table.audienceConfigVersion,
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
      columns: [table.audienceConfigId, table.audienceConfigVersion],
      foreignColumns: [
        audienceConfigurations.id,
        audienceConfigurations.version,
      ],
      name: 'notification_intents_audience_fk',
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

/**
 * Immutable proof that one notification intent was admitted by the exact
 * enabled control epoch current in the lifecycle transaction.
 */
export const fanoutIntentAuthorizations = pgTable(
  'fanout_intent_authorizations',
  {
    intentId: uuid('intent_id')
      .primaryKey()
      .references(() => notificationIntents.id, { onDelete: 'restrict' }),
    controlRecordId: uuid('control_record_id').notNull(),
    enableEpochId: uuid('enable_epoch_id').notNull(),
    controlMode: fanoutControlModeEnum('control_mode')
      .default('enabled')
      .notNull(),
    authorizedAt: occurredAt('authorized_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.controlRecordId, table.enableEpochId, table.controlMode],
      foreignColumns: [
        fanoutControlRecords.id,
        fanoutControlRecords.enableEpochId,
        fanoutControlRecords.mode,
      ],
      name: 'fanout_intent_authorizations_enabled_control_fk',
    }).onDelete('restrict'),
    index('fanout_intent_authorizations_epoch_idx').on(table.enableEpochId),
    check(
      'fanout_intent_authorizations_enabled_only',
      sql`${table.controlMode} = 'enabled'`,
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
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
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
        table.audienceConfigId,
        table.audienceConfigVersion,
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
        notificationIntents.audienceConfigId,
        notificationIntents.audienceConfigVersion,
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
      table.audienceConfigId,
      table.audienceConfigVersion,
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
    foreignKey({
      columns: [table.audienceConfigId, table.audienceConfigVersion],
      foreignColumns: [
        audienceConfigurations.id,
        audienceConfigurations.version,
      ],
      name: 'outbox_audience_fk',
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
        and ${table.message} -> 'audienceConfig' ->> 'id' is not distinct from ${table.audienceConfigId}::text
        and (${table.message} -> 'audienceConfig' ->> 'version')::integer is not distinct from ${table.audienceConfigVersion}
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
    audienceConfigId: uuid('audience_config_id').notNull(),
    audienceConfigVersion: integer('audience_config_version').notNull(),
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
        table.audienceConfigId,
        table.audienceConfigVersion,
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
        notificationIntents.audienceConfigId,
        notificationIntents.audienceConfigVersion,
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
        table.audienceConfigId,
        table.audienceConfigVersion,
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
        outbox.audienceConfigId,
        outbox.audienceConfigVersion,
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
      columns: [table.audienceConfigId, table.audienceConfigVersion],
      foreignColumns: [
        audienceConfigurations.id,
        audienceConfigurations.version,
      ],
      name: 'dispatch_batches_audience_fk',
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

/** Separate append-only, hash-chained security audit log. */
export const securityAuditEntries = pgTable(
  'security_audit_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sequence: integer('sequence').notNull(),
    previousHash: digest('previous_hash'),
    entryHash: digest('entry_hash').notNull(),
    category: securityAuditCategoryEnum('category').notNull(),
    action: varchar('action', { length: 120 }).notNull(),
    actionIds: jsonb('action_ids').notNull(),
    confirmationId: uuid('confirmation_id').references(
      () => humanConfirmationRecords.id,
      { onDelete: 'restrict' },
    ),
    outcome: securityAuditOutcomeEnum('outcome').notNull(),
    principalKind: varchar('principal_kind', { length: 32 }).notNull(),
    principal: jsonb('principal').notNull(),
    source: invocationSourceEnum('source').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id, {
      onDelete: 'restrict',
    }),
    targetKind: varchar('target_kind', { length: 32 }),
    targetId: varchar('target_id', { length: 255 }),
    requestId: uuid('request_id').notNull(),
    reasonCode: auditCode('reason_code'),
    occurredAt: occurredAt('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('security_audit_entries_sequence_uq').on(table.sequence),
    uniqueIndex('security_audit_entries_hash_uq').on(table.entryHash),
    uniqueIndex('security_audit_entries_request_uq').on(table.requestId),
    index('security_audit_entries_query_idx').on(
      table.occurredAt,
      table.category,
      table.outcome,
    ),
    check(
      'security_audit_entries_sequence_positive',
      sql`${table.sequence} > 0`,
    ),
    check(
      'security_audit_entries_hash_chain',
      sql`(${table.sequence} = 1) = (${table.previousHash} is null)`,
    ),
    check(
      'security_audit_entries_hash_format',
      sql`${table.entryHash} ~ '^[a-f0-9]{64}$'
        and (${table.previousHash} is null or ${table.previousHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'security_audit_entries_action_format',
      sql`${table.action} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check(
      'security_audit_entries_principal_kind',
      sql`${table.principalKind} in ('human', 'agent', 'system', 'unauthenticated')`,
    ),
    check(
      'security_audit_entries_target_pair',
      sql`(${table.targetKind} is null) = (${table.targetId} is null)`,
    ),
    check(
      'security_audit_entries_outcome_reason',
      sql`(${table.outcome} = 'success') = (${table.reasonCode} is null)`,
    ),
  ],
);

/**
 * Append-only external anchors make deletion of the audit-chain tail
 * detectable. A database trigger, not application writers, owns inserts.
 */
export const securityAuditChainAnchors = pgTable(
  'security_audit_chain_anchors',
  {
    sequence: integer('sequence').primaryKey(),
    entryHash: digest('entry_hash').notNull(),
  },
  (table) => [
    unique('security_audit_chain_anchors_hash_uq').on(table.entryHash),
    check(
      'security_audit_chain_anchors_sequence_positive',
      sql`${table.sequence} > 0`,
    ),
    check(
      'security_audit_chain_anchors_hash_format',
      sql`${table.entryHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
