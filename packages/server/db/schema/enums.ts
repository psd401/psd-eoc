import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  ActorKindSchema,
  ClassificationMarkerSchema,
  DeliveryEvidenceSubjectKindSchema,
  DeliveryTruthStateSchema,
  DevicePlatformSchema,
  DeviceUnlockMethodSchema,
  EndpointStatusSchema,
  EventKindSchema,
  EventStatusSchema,
  EventTransitionKindSchema,
  FacilityScopeKindSchema,
  GroupCompletionKindSchema,
  GroupPurposeSchema,
  GroupSourceKindSchema,
  HUMAN_ONLY_ACTION_IDS,
  HumanConfirmationStatusSchema,
  IdempotencyStatusSchema,
  InvocationSourceSchema,
  JournalEntryKindSchema,
  JournalSupersessionKindSchema,
  MediaContentTypeSchema,
  MUTATION_CAPABILITY_IDS,
  NotificationChannelSchema,
  NotificationPurposeSchema,
  OutboxStatusSchema,
  PushPlatformSchema,
  RoleSchema,
  RosterPopulationSchema,
  RosterSyncOutcomeSchema,
  SecurityAuditCategorySchema,
  SecurityAuditOutcomeSchema,
  TemplateModeSchema,
} from '@psd-eoc/contracts';

import { pgEnum } from 'drizzle-orm/pg-core';
function contractEnumValues<Value extends string>(
  values: readonly Value[],
): readonly [Value, ...Value[]] {
  if (values.length === 0) {
    throw new Error('Contract enum values must be non-empty.');
  }
  return values as [Value, ...Value[]];
}

export interface ContractDerivedDatabaseEnum {
  readonly enumName: string;
  readonly enumValues: readonly string[];
}

const contractDerivedDatabaseEnums: ContractDerivedDatabaseEnum[] = [];

function contractPgEnum<Value extends string>(
  enumName: string,
  values: readonly [Value, ...Value[]],
) {
  const definition = pgEnum(enumName, values);
  contractDerivedDatabaseEnums.push(definition);
  return definition;
}

/**
 * PostgreSQL cannot drop a value from an enum type. When a capability leaves
 * the catalog its value stays in the type so rows written under it remain
 * valid, and the persisted order stays the type's order. A current value that
 * the persisted list lacks is a contracts-first change that needs a migration
 * adding it; a persisted value that is neither current nor retired is drift.
 */
function withRetiredValues<Value extends string>(
  current: readonly Value[],
  persisted: readonly [string, ...string[]],
  retired: readonly string[],
): readonly [string, ...string[]] {
  const persistedSet = new Set<string>(persisted);
  for (const value of current) {
    if (!persistedSet.has(value)) {
      throw new Error(`Enum value ${value} needs a migration adding it.`);
    }
  }
  const expected = new Set<string>([...current, ...retired]);
  for (const value of persisted) {
    if (!expected.has(value)) {
      throw new Error(`Enum value ${value} is neither current nor retired.`);
    }
  }
  if (persisted.length !== expected.size) {
    throw new Error('Enum values must be unique.');
  }
  return persisted;
}

/** Complete database vocabulary registry used by exhaustive drift tests. */
export function listContractDerivedDatabaseEnums(): readonly ContractDerivedDatabaseEnum[] {
  return Object.freeze([...contractDerivedDatabaseEnums]);
}

/**
 * PostgreSQL persists the same closed vocabularies owned by
 * `@psd-eoc/contracts`. Changing an enum is therefore a contracts-first
 * migration, never an ad-hoc database edit.
 */
export const actorKindEnum = contractPgEnum(
  'actor_kind',
  contractEnumValues(ActorKindSchema.options),
);
export const roleEnum = contractPgEnum(
  'role',
  contractEnumValues(RoleSchema.options),
);
export const facilityScopeKindEnum = contractPgEnum(
  'facility_scope_kind',
  contractEnumValues(FacilityScopeKindSchema.options),
);
export const devicePlatformEnum = contractPgEnum(
  'device_platform',
  contractEnumValues(DevicePlatformSchema.options),
);
export const deviceUnlockMethodEnum = contractPgEnum(
  'device_unlock_method',
  contractEnumValues(DeviceUnlockMethodSchema.options),
);
export const groupSourceKindEnum = contractPgEnum(
  'group_source_kind',
  contractEnumValues(GroupSourceKindSchema.options),
);
export const groupPurposeEnum = contractPgEnum(
  'group_purpose',
  contractEnumValues(GroupPurposeSchema.options),
);
export const groupCompletionKindEnum = contractPgEnum(
  'group_completion_kind',
  contractEnumValues(GroupCompletionKindSchema.options),
);
export const rosterPopulationEnum = contractPgEnum(
  'roster_population',
  contractEnumValues(RosterPopulationSchema.options),
);
export const endpointStatusEnum = contractPgEnum(
  'endpoint_status',
  contractEnumValues(EndpointStatusSchema.options),
);
export const notificationChannelEnum = contractPgEnum(
  'notification_channel',
  contractEnumValues(NotificationChannelSchema.options),
);
export const pushPlatformEnum = contractPgEnum(
  'push_platform',
  contractEnumValues(PushPlatformSchema.options),
);
export const eventKindEnum = contractPgEnum(
  'event_kind',
  contractEnumValues(EventKindSchema.options),
);
export const templateModeEnum = contractPgEnum(
  'template_mode',
  contractEnumValues(TemplateModeSchema.options),
);
export const notificationPurposeEnum = contractPgEnum(
  'notification_purpose',
  contractEnumValues(NotificationPurposeSchema.options),
);
export const classificationMarkerEnum = contractPgEnum(
  'classification_marker',
  contractEnumValues(ClassificationMarkerSchema.options),
);
export const eventStatusEnum = contractPgEnum(
  'event_status',
  contractEnumValues(EventStatusSchema.options),
);
export const eventTransitionKindEnum = contractPgEnum(
  'event_transition_kind',
  contractEnumValues(EventTransitionKindSchema.options),
);
export const invocationSourceEnum = contractPgEnum(
  'invocation_source',
  contractEnumValues(InvocationSourceSchema.options),
);
export const journalEntryKindEnum = contractPgEnum(
  'journal_entry_kind',
  contractEnumValues(JournalEntryKindSchema.options),
);
export const journalSupersessionKindEnum = contractPgEnum(
  'journal_supersession_kind',
  contractEnumValues(JournalSupersessionKindSchema.options),
);
export const mediaContentTypeEnum = contractPgEnum(
  'media_content_type',
  contractEnumValues(MediaContentTypeSchema.options),
);
export const deliveryTruthStateEnum = contractPgEnum(
  'delivery_truth_state',
  contractEnumValues(DeliveryTruthStateSchema.options),
);
export const deliveryEvidenceSubjectKindEnum = contractPgEnum(
  'delivery_evidence_subject_kind',
  contractEnumValues(DeliveryEvidenceSubjectKindSchema.options),
);
export const outboxStatusEnum = contractPgEnum(
  'outbox_status',
  contractEnumValues(OutboxStatusSchema.options),
);
export const securityAuditCategoryEnum = contractPgEnum(
  'security_audit_category',
  contractEnumValues(SecurityAuditCategorySchema.options),
);
export const securityAuditOutcomeEnum = contractPgEnum(
  'security_audit_outcome',
  contractEnumValues(SecurityAuditOutcomeSchema.options),
);
/** Grants the catalog no longer offers; the type keeps them for old rows. */
export const RETIRED_AGENT_CAPABILITY_GRANT_IDS = Object.freeze([
  'list-delivery-test-reports',
] as const);

/** Mutations the catalog no longer offers; the type keeps them for old rows. */
export const RETIRED_MUTATION_CAPABILITY_IDS = Object.freeze([
  'record-delivery-test-canary-eligibility',
  'create-delivery-test-target-set-version',
  'finalize-delivery-test-report',
  'verify-email-integration',
] as const);

const PERSISTED_AGENT_CAPABILITY_GRANT_ORDER = [
  'sync-roster',
  'prepare-activation',
  'start-event',
  'join-event',
  'all-clear-event',
  'reactivate-event',
  'close-event',
  'reopen-as-correction',
  'append-journal-entry',
  'correct-journal-entry',
  'redact-journal-entry',
  'create-media-upload-intent',
  'complete-media-upload',
  'create-event-type-draft',
  'update-event-type-draft',
  'publish-event-type-version',
  'create-facility',
  'update-facility',
  'create-neighborhood-version',
  'create-group-source',
  'update-group-source',
  'set-manual-roster-members',
  'set-channel-enabled',
  'create-activation-preview',
  'create-lifecycle-consequence-preview',
  'get-prepared-activation',
  'get-roster-snapshot',
  'list-group-sources',
  'get-roster-health',
  'get-stale-roster-report',
  'list-active-events',
  'get-event',
  'list-journal-entries',
  'search-journal-entries',
  'get-media-read-grant',
  'list-event-types',
  'get-event-type-version',
  'get-event-type-draft',
  'preview-event-type-rendering',
  'get-notification-status',
  'run-delivery-report',
  'list-delivery-test-reports',
  'get-integration-health',
  'list-facilities',
  'list-threats',
  'get-facility',
  'list-neighborhoods',
  'list-neighborhood-versions',
  'get-neighborhood-version',
  'list-users',
  'list-agent-api-keys',
  'list-drill-records',
  'export-drill-records',
  'export-event-summary',
  'query-security-audit',
  'verify-security-audit-chain',
  'set-user-facility-scope',
] as const;

const PERSISTED_MUTATION_CAPABILITY_ORDER = [
  'complete-oidc-sign-in',
  'refresh-session',
  'revoke-session',
  'sync-roster',
  'sync-access-membership',
  'record-delivery-test-canary-eligibility',
  'create-delivery-test-target-set-version',
  'prepare-activation',
  'start-event',
  'join-event',
  'append-journal-entry',
  'correct-journal-entry',
  'redact-journal-entry',
  'all-clear-event',
  'reactivate-event',
  'close-event',
  'reopen-as-correction',
  'create-media-upload-intent',
  'complete-media-upload',
  'create-event-type-draft',
  'update-event-type-draft',
  'publish-event-type-version',
  'dispatch-outbox',
  'record-delivery-evidence',
  'reconcile-delivery-attempts',
  'record-endpoint-status',
  'record-sms-opt-out',
  'finalize-delivery-test-report',
  'register-push-token',
  'unregister-push-token',
  'record-sms-consent',
  'withdraw-sms-consent',
  'create-facility',
  'update-facility',
  'create-neighborhood-version',
  'create-group-source',
  'update-group-source',
  'set-manual-roster-members',
  'set-channel-enabled',
  'verify-email-integration',
  'issue-agent-api-key',
  'revoke-agent-api-key',
  'create-lifecycle-consequence-preview',
  'set-user-facility-scope',
  'admit-account',
  'revoke-admitted-account',
] as const;

export const agentCapabilityGrantEnum = contractPgEnum(
  'agent_capability_grant',
  withRetiredValues(
    AGENT_GRANTABLE_CAPABILITY_IDS,
    PERSISTED_AGENT_CAPABILITY_GRANT_ORDER,
    RETIRED_AGENT_CAPABILITY_GRANT_IDS,
  ),
);
export const mutationCapabilityEnum = contractPgEnum(
  'mutation_capability',
  withRetiredValues(
    MUTATION_CAPABILITY_IDS,
    PERSISTED_MUTATION_CAPABILITY_ORDER,
    RETIRED_MUTATION_CAPABILITY_IDS,
  ),
);
export const humanOnlyActionEnum = contractPgEnum(
  'human_only_action',
  HUMAN_ONLY_ACTION_IDS,
);
export const idempotencyStatusEnum = contractPgEnum(
  'idempotency_status',
  contractEnumValues(IdempotencyStatusSchema.options),
);
export const humanConfirmationStatusEnum = contractPgEnum(
  'human_confirmation_status',
  contractEnumValues(HumanConfirmationStatusSchema.options),
);
export const rosterSyncOutcomeEnum = contractPgEnum(
  'roster_sync_outcome',
  contractEnumValues(RosterSyncOutcomeSchema.options),
);
