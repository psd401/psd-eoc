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
  serial,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  roleEnum,
  facilityScopeKindEnum,
  devicePlatformEnum,
  deviceUnlockMethodEnum,
  agentCapabilityGrantEnum,
  mutationCapabilityEnum,
  humanOnlyActionEnum,
  idempotencyStatusEnum,
  humanConfirmationStatusEnum,
  invocationSourceEnum,
} from './enums';

import { auditCode, digest, occurredAt } from './shared';

import { facilities } from './configuration';
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
    check(
      'users_normalized_email',
      sql`${table.email} = lower(${table.email})
        and ${table.email} = btrim(${table.email})
        and length(${table.email}) between 3 and 320
        and ${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$'`,
    ),
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

/**
 * Addresses admitted to sign in without a designated Google group.
 *
 * One active admission per address; a revoked row stays, with who ended it
 * and when, so admission history is never rewritten. Admission grants staff
 * only; nothing here can make an administrator.
 */
export const admittedAccounts = pgTable(
  'admitted_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    note: varchar('note', { length: 240 }).default('').notNull(),
    admittedAt: occurredAt('admitted_at').defaultNow().notNull(),
    admittedByUserId: uuid('admitted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    revokedAt: occurredAt('revoked_at'),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    uniqueIndex('admitted_accounts_active_email_uq')
      .on(table.email)
      .where(sql`${table.revokedAt} is null`),
    index('admitted_accounts_email_idx').on(table.email),
    check(
      'admitted_accounts_normalized_email',
      sql`${table.email} = lower(${table.email})
        and ${table.email} = btrim(${table.email})
        and length(${table.email}) between 3 and 320
        and ${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$'`,
    ),
    check(
      'admitted_accounts_revocation_complete',
      sql`(${table.revokedAt} is null) = (${table.revokedByUserId} is null)`,
    ),
    check(
      'admitted_accounts_revoked_after_admission',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.admittedAt}`,
    ),
  ],
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
    // An installation is not owned by the first account that signed in on
    // it. Whoever the access decision admits may enroll it, and a revoked
    // enrollment never blocks a fresh one: one active enrollment per
    // installation and account.
    uniqueIndex('device_enrollments_installation_user_active_uq')
      .on(table.installationId, table.userId)
      .where(sql`${table.revokedAt} is null`),
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
    /** Which groups the run covered: the sign-in groups, or the roster groups. */
    scope: text('scope').notNull().default('access'),
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
    check(
      'access_membership_snapshots_scope_valid',
      sql`${table.scope} in ('access', 'roster')`,
    ),
  ],
);

/** Expected and completed designated access groups for a complete snapshot. */
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
    // Legacy. Sessions issued before the trusted-group cutover carry the
    // generation they were pinned to; nothing reads it any more.
    membershipSnapshotId: uuid('membership_snapshot_id'),
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
    provider: varchar('provider', { length: 32 }).default('expo').notNull(),
    serviceEnvironment: varchar('service_environment', { length: 32 })
      .default('production')
      .notNull(),
    supersedesRegistrationId: uuid('supersedes_registration_id'),
    applicationId: varchar('application_id', { length: 255 }),
    applicationVersion: varchar('application_version', {
      length: 64,
    }),
    nativeBuildVersion: varchar('native_build_version', {
      length: 32,
    }),
    expoProjectId: uuid('expo_project_id'),
    updateMode: varchar('update_mode', { length: 32 }),
    token: text('token').notNull(),
    registeredAt: occurredAt('registered_at').defaultNow().notNull(),
  },
  (table) => [
    unique('device_push_token_registrations_identity_device_uq').on(
      table.id,
      table.deviceEnrollmentId,
    ),
    unique('device_push_token_registrations_supersedes_uq').on(
      table.supersedesRegistrationId,
    ),
    foreignKey({
      columns: [table.deviceEnrollmentId, table.platform],
      foreignColumns: [deviceEnrollments.id, deviceEnrollments.platform],
      name: 'device_push_token_registrations_device_platform_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supersedesRegistrationId, table.deviceEnrollmentId],
      foreignColumns: [table.id, table.deviceEnrollmentId],
      name: 'device_push_token_registrations_supersedes_device_fk',
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
      'device_push_token_registrations_provider',
      sql`${table.provider} in ('expo', 'apns', 'fcm')`,
    ),
    check(
      'device_push_token_registrations_service_environment',
      sql`${table.serviceEnvironment} in ('development', 'production')`,
    ),
    check(
      'device_push_token_registrations_provider_platform',
      sql`${table.provider} = 'expo'
        or (${table.provider} = 'apns' and ${table.platform} = 'ios')
        or (${table.provider} = 'fcm' and ${table.platform} = 'android')`,
    ),
    check(
      'device_push_token_registrations_not_self_superseding',
      sql`${table.supersedesRegistrationId} is null
        or ${table.supersedesRegistrationId} <> ${table.id}`,
    ),
    check(
      'device_push_token_registrations_application_id_format',
      sql`${table.applicationId} ~ '^[A-Za-z0-9]+([._-][A-Za-z0-9]+)+$'`,
    ),
    check(
      'device_push_token_registrations_application_version_format',
      sql`${table.applicationVersion} ~ '^[0-9]+[.][0-9]+[.][0-9]+$'`,
    ),
    check(
      'device_push_token_registrations_native_build_version_format',
      sql`${table.nativeBuildVersion} ~ '^[1-9][0-9]{0,17}$'`,
    ),
    check(
      'device_push_token_registrations_embedded_only',
      sql`${table.updateMode} = 'embedded-only'`,
    ),
    check(
      'device_push_token_registrations_build_identity_pairing',
      sql`num_nonnulls(
          ${table.applicationId},
          ${table.applicationVersion},
          ${table.nativeBuildVersion},
          ${table.expoProjectId},
          ${table.updateMode}
        ) in (0, 5)`,
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

/**
 * A staff member's affirmative agreement to receive emergency SMS.
 *
 * Append-only. A carrier reviewing a toll-free or 10DLC registration asks what
 * the person was shown when they agreed, and a district has to be able to
 * produce that for any number it sends to. Rewriting or deleting a consent
 * would destroy the only evidence that the send was permitted.
 *
 * One live consent per staff member, enforced by the partial unique index
 * below: a new number supersedes the previous one rather than adding a second,
 * because notifying two numbers for one employee is a carrier complaint.
 */
export const staffSmsConsents = pgTable(
  'staff_sms_consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    phoneNumber: varchar('phone_number', { length: 16 }).notNull(),
    disclosureVersion: varchar('disclosure_version', { length: 10 }).notNull(),
    source: invocationSourceEnum('source').notNull(),
    supersedesConsentId: uuid('supersedes_consent_id'),
    withdrawnAt: occurredAt('withdrawn_at'),
    consentedAt: occurredAt('consented_at').defaultNow().notNull(),
  },
  (table) => [
    unique('staff_sms_consents_supersedes_uq').on(table.supersedesConsentId),
    foreignKey({
      columns: [table.supersedesConsentId],
      foreignColumns: [table.id],
      name: 'staff_sms_consents_supersedes_fk',
    }).onDelete('restrict'),
    // One live consent per person. A withdrawn record stays for evidence and
    // is excluded here so the same person can consent again later.
    uniqueIndex('staff_sms_consents_one_live_per_user_uq')
      .on(table.userId)
      .where(sql`${table.withdrawnAt} is null`),
    index('staff_sms_consents_user_idx').on(table.userId, table.consentedAt),
    check(
      'staff_sms_consents_e164',
      sql`${table.phoneNumber} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    check(
      'staff_sms_consents_disclosure_version',
      sql`${table.disclosureVersion} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    check(
      'staff_sms_consents_withdrawal_not_before_consent',
      sql`${table.withdrawnAt} is null or ${table.withdrawnAt} >= ${table.consentedAt}`,
    ),
  ],
);
