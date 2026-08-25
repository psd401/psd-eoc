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
  IntegrationTruthLabelSchema,
  InvocationSourceSchema,
  JournalEntryKindSchema,
  JournalSupersessionKindSchema,
  MediaContentTypeSchema,
  MonthlyDeliveryTestReportStatusSchema,
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
export const deliveryTestReportStatusEnum = contractPgEnum(
  'delivery_test_report_status',
  contractEnumValues(MonthlyDeliveryTestReportStatusSchema.options),
);
export const outboxStatusEnum = contractPgEnum(
  'outbox_status',
  contractEnumValues(OutboxStatusSchema.options),
);
export const integrationTruthLabelEnum = contractPgEnum(
  'integration_truth_label',
  contractEnumValues(IntegrationTruthLabelSchema.options),
);
export const securityAuditCategoryEnum = contractPgEnum(
  'security_audit_category',
  contractEnumValues(SecurityAuditCategorySchema.options),
);
export const securityAuditOutcomeEnum = contractPgEnum(
  'security_audit_outcome',
  contractEnumValues(SecurityAuditOutcomeSchema.options),
);
export const agentCapabilityGrantEnum = contractPgEnum(
  'agent_capability_grant',
  AGENT_GRANTABLE_CAPABILITY_IDS,
);
export const mutationCapabilityEnum = contractPgEnum(
  'mutation_capability',
  MUTATION_CAPABILITY_IDS,
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
