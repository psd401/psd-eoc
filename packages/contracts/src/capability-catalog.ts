import { z } from 'zod';

import {
  SecurityAuditPageSchema,
  SecurityAuditQuerySchema,
  SecurityAuditVerificationSchema,
  VerifySecurityAuditChainInputSchema,
} from './audit';
import {
  CapabilityEnvelopeSchema,
  CapabilityIdSchema,
  CapabilitySafetyEffectSchema,
  CapabilitySafetyResolutionSchema,
  HumanActionRequirementSchema,
  InvocationSourceSchema,
  type CapabilitySafetyEffect,
  type CapabilitySafetyResolution,
  type CapabilitySafetyResolver,
  type CapabilityEnvelope,
  type HumanActionPolicy,
  type HumanActionRequirement,
  type HumanActionResolutionContext,
  type InvocationSource,
  type PreSessionOidcPrincipal,
} from './capability';
import { installCapabilityViews } from './capability-derived-registry';
import {
  EventRoomSyncResultSchema,
  JournalEntryReadProjectionSchema,
  SyncEventRoomInputSchema,
} from './event-room';
import {
  CreateEventTypeDraftInputSchema,
  EventTypePageSchema,
  EventTypeRenderingPreviewSchema,
  EventTypeVersionDraftSchema,
  EventTypeVersionSchema,
  GetEventTypeDraftInputSchema,
  GetEventTypeVersionInputSchema,
  ListEventTypesInputSchema,
  PreviewEventTypeRenderingInputSchema,
  PublishEventTypeVersionInputSchema,
  UpdateEventTypeDraftInputSchema,
} from './event-type';
import {
  ActivationPreviewSchema,
  AllClearEventInputSchema,
  CloseEventInputSchema,
  CreateActivationPreviewInputSchema,
  CreateLifecycleConsequencePreviewInputSchema,
  EventIdSchema,
  EventPageSchema,
  EventSchema,
  GetEventInputSchema,
  GetPreparedActivationInputSchema,
  JoinEventInputSchema,
  JoinEventResultSchema,
  LifecycleConsequencePreviewSchema,
  ListActiveEventsInputSchema,
  PrepareActivationInputSchema,
  PreparedActivationSchema,
  PreparedActivationConsumptionSchema,
  ReactivateEventInputSchema,
  ReopenAsCorrectionInputSchema,
  StartEventInputSchema,
  EventTransitionSchema,
} from './event';
import {
  CreateFacilityInputSchema,
  CreateNeighborhoodVersionInputSchema,
  FacilityPageSchema,
  FacilitySchema,
  GetFacilityInputSchema,
  GetNeighborhoodVersionInputSchema,
  ListFacilitiesInputSchema,
  ListNeighborhoodsInputSchema,
  ListNeighborhoodVersionsInputSchema,
  NeighborhoodPageSchema,
  NeighborhoodSchema,
  UpdateFacilityInputSchema,
} from './facility';
import {
  AdmitAccountInputSchema,
  AdmittedAccountListSchema,
  AdmittedAccountSchema,
  ListAdmittedAccountsInputSchema,
  RevokeAdmittedAccountInputSchema,
} from './admitted-account';
import { ListThreatsInputSchema, ThreatPageSchema } from './threat';
import {
  CreateGroupSourceInputSchema,
  GroupSourcePageSchema,
  GroupSourceSchema,
  ListGroupSourcesInputSchema,
  ManualRosterMembershipSchema,
  SetManualRosterMembersInputSchema,
  UpdateGroupSourceInputSchema,
} from './group';
import type { HumanOnlyActionId } from './human-only';
import {
  CompleteOidcSignInInputSchema,
  CurrentSessionResultSchema,
  DeviceEnrollmentPageSchema,
  DeviceSessionPageSchema,
  ListDeviceSessionsInputSchema,
  ListMyDevicesInputSchema,
  ListUsersInputSchema,
  PushTokenRegistrationReceiptSchema,
  PushTokenUnregistrationReceiptSchema,
  RefreshSessionInputSchema,
  RegisterPushTokenInputSchema,
  RevokeSessionInputSchema,
  SessionEstablishmentResultSchema,
  SessionRevocationSchema,
  SyncAccessMembershipInputSchema,
  SyncAccessMembershipResultSchema,
  UnregisterPushTokenInputSchema,
  RecordSmsConsentInputSchema,
  SmsConsentReceiptSchema,
  WithdrawSmsConsentInputSchema,
  SmsConsentWithdrawalReceiptSchema,
  MySmsConsentViewSchema,
  ReadMySmsConsentInputSchema,
  UserPageSchema,
  SetUserFacilityScopeInputSchema,
  UserSchema,
} from './identity';
import {
  GetIntegrationHealthInputSchema,
  IntegrationHealthSchema,
  SetChannelEnabledInputSchema,
  ChannelConfigurationSchema,
} from './integration';
import {
  JournalEntryInputSchema,
  JournalEntryKindSchema,
  JournalEntrySchema,
} from './journal';
import {
  CompleteMediaUploadInputSchema,
  CreateMediaUploadIntentInputSchema,
  GetMediaReadGrantInputSchema,
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
} from './media';
import {
  DispatchOutboxInputSchema,
  DispatchOutboxResultSchema,
  NotificationIntentSchema,
  EndpointStatusRecordSchema,
  DeliveryEvidenceSchema,
  GetNotificationStatusInputSchema,
  NotificationStatusSchema,
  ReconcileDeliveryAttemptsInputSchema,
  ReconcileDeliveryAttemptsResultSchema,
  RecordDeliveryEvidenceInputSchema,
  RecordEndpointStatusInputSchema,
  RecordSmsOptOutInputSchema,
  SmsOptOutRecordSchema,
} from './notification';
import { paginatedSchema, PaginationCursorSchema } from './api';
import {
  DeliveryReportSchema,
  DrillRecordPageSchema,
  EventRecordPageSchema,
  EventSummaryExportSchema,
  ExportDrillRecordsInputSchema,
  ExportEventSummaryInputSchema,
  ListDrillRecordsInputSchema,
  ListEventRecordsInputSchema,
  RecordsExportSchema,
  RunDeliveryReportInputSchema,
} from './report';
import {
  GetRosterSnapshotInputSchema,
  RosterHealthQuerySchema,
  RosterSnapshotSchema,
  RosterSyncResultSchema,
  StaleRosterReportSchema,
  SyncRosterInputSchema,
} from './roster';
import {
  AdminReadinessSchema,
  GetAdminReadinessInputSchema,
} from './readiness';
import {
  AgentApiKeyIssuanceSchema,
  AgentApiKeyPageSchema,
  AgentApiKeyRevocationSchema,
  IssueAgentApiKeyInputSchema,
  ListAgentApiKeysInputSchema,
  RevokeAgentApiKeyInputSchema,
} from './agent-api';
import { TimestampSchema } from './shared';

export { AgentGrantableCapabilityIdSchema } from './agent-api';

type CapabilityOperation = 'query' | 'mutation';

/**
 * Owns the authenticated principal classes that may reach a canonical
 * capability. Pre-session OIDC and current refresh credentials remain
 * disjoint from ordinary human, agent, and system actors.
 */
export const CapabilityPrincipalKindSchema = z.enum([
  'pre-session-oidc',
  'verified-refresh-credential',
  'human',
  'agent',
  'system',
]);

/** Canonical capability principal class inferred from its schema. */
export type CapabilityPrincipalKind = z.infer<
  typeof CapabilityPrincipalKindSchema
>;

const uniquePrincipalKindsSchema = z
  .array(CapabilityPrincipalKindSchema)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Capability principal kinds must be unique.',
  })
  .readonly();

const uniqueInvocationSourcesSchema = z
  .array(InvocationSourceSchema)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Capability invocation sources must be unique.',
  })
  .readonly();

/**
 * Owns transport exposure for one capability. The mandatory server
 * authorizer receives this policy and must match both authenticated principal
 * class and trusted invocation source before dispatch. Agent grantability is
 * explicit so internal worker/provider operations can never become API-key
 * permissions merely because their safety effect is `none`.
 */
export const CapabilityInvocationPolicySchema = z
  .object({
    principalKinds: uniquePrincipalKindsSchema,
    sources: uniqueInvocationSourcesSchema,
    agentGrantable: z.boolean(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.agentGrantable !== policy.principalKinds.includes('agent')) {
      context.addIssue({
        code: 'custom',
        message:
          'Agent grantability must exactly match whether agent principals are allowed.',
        path: ['agentGrantable'],
      });
    }
  })
  .readonly();

/** Canonical capability invocation policy inferred from its schema. */
export type CapabilityInvocationPolicy = z.infer<
  typeof CapabilityInvocationPolicySchema
>;

/**
 * Owns whether a successful capability execution is itself a security-audit
 * fact. Denials and failures are always audited; the narrower policy exists
 * only for explicitly cataloged high-frequency human polling.
 */
export const CapabilityAuditPolicySchema = z.enum([
  'all-outcomes',
  'denied-and-failed',
]);

/** Canonical security-audit policy inferred from its schema. */
export type CapabilityAuditPolicy = z.infer<typeof CapabilityAuditPolicySchema>;

type DerivedInvocationPolicy<
  PrincipalKinds extends readonly [
    CapabilityPrincipalKind,
    ...CapabilityPrincipalKind[],
  ],
  Sources extends readonly [InvocationSource, ...InvocationSource[]],
> = Readonly<{
  principalKinds: PrincipalKinds;
  sources: Sources;
  agentGrantable: 'agent' extends PrincipalKinds[number] ? true : false;
}>;

function invocationPolicy<
  const PrincipalKinds extends readonly [
    CapabilityPrincipalKind,
    ...CapabilityPrincipalKind[],
  ],
  const Sources extends readonly [InvocationSource, ...InvocationSource[]],
>(
  principalKinds: PrincipalKinds,
  sources: Sources,
): DerivedInvocationPolicy<PrincipalKinds, Sources> {
  return CapabilityInvocationPolicySchema.parse({
    principalKinds,
    sources,
    agentGrantable: principalKinds.includes('agent'),
  }) as DerivedInvocationPolicy<PrincipalKinds, Sources>;
}

const preSessionOidcInvocationPolicy = invocationPolicy(
  ['pre-session-oidc'],
  ['web', 'mobile'],
);
const verifiedRefreshInvocationPolicy = invocationPolicy(
  ['verified-refresh-credential'],
  ['web', 'mobile'],
);
const humanInteractiveInvocationPolicy = invocationPolicy(
  ['human'],
  ['web', 'mobile'],
);
const humanWebAdministrationInvocationPolicy = invocationPolicy(
  ['human'],
  ['web'],
);
const humanAgentInvocationPolicy = invocationPolicy(
  ['human', 'agent'],
  ['web', 'mobile', 'agent-rest', 'mcp'],
);
const humanAgentScheduledInvocationPolicy = invocationPolicy(
  ['human', 'agent', 'system'],
  ['web', 'mobile', 'agent-rest', 'mcp', 'scheduled-job'],
);
const humanAgentWorkerInvocationPolicy = invocationPolicy(
  ['human', 'agent', 'system'],
  ['web', 'mobile', 'agent-rest', 'mcp', 'worker'],
);
const systemWorkerScheduledInvocationPolicy = invocationPolicy(
  ['system'],
  ['worker', 'scheduled-job'],
);
const systemScheduledInvocationPolicy = invocationPolicy(
  ['system'],
  ['scheduled-job'],
);
const systemWorkerWebhookInvocationPolicy = invocationPolicy(
  ['system'],
  ['worker', 'webhook'],
);

/**
 * Owns one immutable catalog entry. Callers choose only the ID; operation,
 * safety effect, human-action policy, and both runtime schemas remain fixed by
 * this package and cannot be redeclared by a route, worker, REST adapter, or
 * MCP tool.
 */
export interface CanonicalCapabilityDefinition<
  Id extends string = string,
  Operation extends CapabilityOperation = CapabilityOperation,
  Effect extends CapabilitySafetyEffect = CapabilitySafetyEffect,
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
  AuditPolicy extends CapabilityAuditPolicy = CapabilityAuditPolicy,
  InvocationPolicy extends
    CapabilityInvocationPolicy = CapabilityInvocationPolicy,
> {
  readonly id: Id;
  readonly operation: Operation;
  readonly safetyEffect: Effect;
  readonly humanActionPolicy: HumanActionPolicy;
  readonly invocationPolicy: InvocationPolicy;
  readonly auditPolicy: AuditPolicy;
  /** Stable insertion point for the persisted PostgreSQL mutation enum. */
  readonly mutationOrderAfter?: string;
  /** Stable insertion point for the persisted PostgreSQL grant enum. */
  readonly agentGrantOrderAfter?: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
}

const noHumanActionPolicy = Object.freeze({ kind: 'none' as const });
const centralHumanActionPolicy = Object.freeze({ kind: 'central' as const });

function canonicalCapability<
  const Id extends string,
  const Operation extends CapabilityOperation,
  const Effect extends CapabilitySafetyEffect,
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
  const AuditPolicy extends CapabilityAuditPolicy = 'all-outcomes',
  const InvocationPolicy extends
    CapabilityInvocationPolicy = CapabilityInvocationPolicy,
>(definition: {
  readonly id: Id;
  readonly operation: Operation;
  readonly safetyEffect: Effect;
  readonly invocationPolicy: InvocationPolicy;
  readonly auditPolicy?: AuditPolicy;
  readonly mutationOrderAfter?: string;
  readonly agentGrantOrderAfter?: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
}): Readonly<
  CanonicalCapabilityDefinition<
    Id,
    Operation,
    Effect,
    InputSchema,
    OutputSchema,
    AuditPolicy,
    InvocationPolicy
  >
> {
  CapabilityIdSchema.parse(definition.id);
  CapabilitySafetyEffectSchema.parse(definition.safetyEffect);
  const parsedInvocationPolicy = CapabilityInvocationPolicySchema.parse(
    definition.invocationPolicy,
  ) as InvocationPolicy;
  if (definition.operation === 'query' && definition.safetyEffect !== 'none') {
    throw new Error('Query capabilities cannot have a mutation safety effect.');
  }
  const auditPolicy = CapabilityAuditPolicySchema.parse(
    definition.auditPolicy ?? 'all-outcomes',
  ) as AuditPolicy;
  if (definition.operation === 'mutation' && auditPolicy !== 'all-outcomes') {
    throw new Error('Mutation capabilities must audit every outcome.');
  }
  const humanActionPolicy =
    definition.safetyEffect === 'none'
      ? noHumanActionPolicy
      : centralHumanActionPolicy;
  return Object.freeze({
    ...definition,
    auditPolicy,
    humanActionPolicy,
    invocationPolicy: parsedInvocationPolicy,
  });
}

/**
 * Owns ordinary journal posting input. A caller with posting authority cannot
 * smuggle a correction or redaction through this capability; supersession has
 * separate IDs that can receive stricter authorization.
 */
export const AppendJournalEntryInputSchema = JournalEntryInputSchema.refine(
  (entry) => entry.supersedes === null,
  {
    message: 'Ordinary journal posts cannot supersede an earlier entry.',
    path: ['supersedes'],
  },
).readonly();

/** Ordinary non-superseding journal input inferred from its schema. */
export type AppendJournalEntryInput = z.infer<
  typeof AppendJournalEntryInputSchema
>;

/**
 * Owns append-only correction input. The replacement entry retains the exact
 * earlier entry and sequence provenance and can never parse as a redaction.
 */
export const CorrectJournalEntryInputSchema = JournalEntryInputSchema.refine(
  (entry) => entry.supersedes?.kind === 'correction',
  {
    message: 'Journal correction input requires correction provenance.',
    path: ['supersedes'],
  },
).readonly();

/** Append-only journal correction input inferred from its schema. */
export type CorrectJournalEntryInput = z.infer<
  typeof CorrectJournalEntryInputSchema
>;

/**
 * Owns append-only redaction input. Redaction remains a new retained entry
 * with reason and backward provenance; it never updates or deletes history.
 */
export const RedactJournalEntryInputSchema = JournalEntryInputSchema.refine(
  (entry) => entry.supersedes?.kind === 'redaction',
  {
    message: 'Journal redaction input requires redaction provenance.',
    path: ['supersedes'],
  },
).readonly();

/** Append-only journal redaction input inferred from its schema. */
export type RedactJournalEntryInput = z.infer<
  typeof RedactJournalEntryInputSchema
>;

/** Owns event-scoped cursor pagination input for the operational journal. */
export const ListJournalEntriesInputSchema = z
  .object({
    eventId: EventIdSchema,
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Event-scoped journal pagination input inferred from its schema. */
export type ListJournalEntriesInput = z.infer<
  typeof ListJournalEntriesInputSchema
>;

/**
 * Owns bounded facility-authorized journal search filters. Message search text
 * is accepted only as input and must never be copied into security audit data.
 * Implementations must exclude redacted originals before content matching so
 * search cannot become an oracle for content removed from outward reads.
 */
export const SearchJournalEntriesInputSchema = z
  .object({
    eventId: EventIdSchema.nullable(),
    kind: JournalEntryKindSchema.nullable(),
    query: z.string().trim().min(1).max(200).nullable(),
    occurredFrom: TimestampSchema.nullable(),
    occurredThrough: TimestampSchema.nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.occurredFrom &&
      input.occurredThrough &&
      Date.parse(input.occurredThrough) < Date.parse(input.occurredFrom)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Journal search end time cannot precede start time.',
        path: ['occurredThrough'],
      });
    }
  })
  .readonly();

/** Bounded journal search input inferred from its schema. */
export type SearchJournalEntriesInput = z.infer<
  typeof SearchJournalEntriesInputSchema
>;

/** Owns a stable cursor page of append-only operational journal entries. */
export const JournalEntryPageSchema = paginatedSchema(
  JournalEntryReadProjectionSchema,
);

/** Cursor page of operational journal entries inferred from its schema. */
export type JournalEntryPage = z.infer<typeof JournalEntryPageSchema>;

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * Owns the complete atomic result of an event lifecycle mutation. Transitions
 * that notify require their immutable intent, every result retains its system
 * journal evidence, and prepared-activation consumption can accompany only an
 * activation that names the same prepared record.
 */
export const EventLifecycleMutationResultSchema = z
  .object({
    event: EventSchema,
    transition: EventTransitionSchema,
    journalEntries: z.array(JournalEntrySchema).min(1).max(5).readonly(),
    notificationIntent: NotificationIntentSchema.nullable(),
    preparedActivationConsumption:
      PreparedActivationConsumptionSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const transitionEventId =
      result.transition.transition === 'reopen-as-correction'
        ? result.transition.correctionEventId
        : result.transition.eventId;
    if (transitionEventId !== result.event.id) {
      context.addIssue({
        code: 'custom',
        message: 'Lifecycle result event must match its transition.',
        path: ['event', 'id'],
      });
    }
    if (result.event.status !== result.transition.to) {
      context.addIssue({
        code: 'custom',
        message: 'Lifecycle result event status must match transition output.',
        path: ['event', 'status'],
      });
    }
    if (result.transition.transition === 'reopen-as-correction') {
      if (
        result.event.kind !== result.transition.targeting.kind ||
        result.event.templateMode !==
          result.transition.targeting.templateMode ||
        result.event.correctionOfEventId !== result.transition.sourceEventId ||
        result.event.correctionReason !== result.transition.reason ||
        !structurallyEqual(result.event.createdBy, result.transition.actor) ||
        result.event.createdAt !== result.transition.occurredAt
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Correction event must preserve the transition classification, source, reason, actor, and time.',
          path: ['event'],
        });
      }
    } else if (
      result.event.kind !== result.transition.targeting.kind ||
      result.event.templateMode !== result.transition.targeting.templateMode ||
      result.event.rosterPopulation !==
        result.transition.targeting.rosterPopulation
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Lifecycle result event classification must match transition targeting.',
        path: ['event'],
      });
    }
    switch (result.transition.transition) {
      case 'activate':
        if (
          result.event.createdAt !== result.transition.occurredAt ||
          result.event.activatedAt !== result.transition.occurredAt ||
          !structurallyEqual(result.event.createdBy, result.transition.actor) ||
          !structurallyEqual(
            result.event.activationAuthorization,
            result.transition.activationAuthorization,
          )
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Activated event must preserve exact transition actor, time, and authorization.',
            path: ['event'],
          });
        }
        break;
      case 'all-clear':
        if (result.event.allClearAt !== result.transition.occurredAt) {
          context.addIssue({
            code: 'custom',
            message: 'All-clear event time must match its transition.',
            path: ['event', 'allClearAt'],
          });
        }
        break;
      case 'reactivate':
        if (result.event.reactivatedAt !== result.transition.occurredAt) {
          context.addIssue({
            code: 'custom',
            message: 'Reactivation event time must match its transition.',
            path: ['event', 'reactivatedAt'],
          });
        }
        break;
      case 'close':
        if (result.event.closedAt !== result.transition.occurredAt) {
          context.addIssue({
            code: 'custom',
            message: 'Closed event time must match its transition.',
            path: ['event', 'closedAt'],
          });
        }
        break;
      case 'reopen-as-correction':
        break;
    }
    const sendsNotification = ['activate', 'all-clear', 'reactivate'].includes(
      result.transition.transition,
    );
    if (sendsNotification !== (result.notificationIntent !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Activation, all-clear, and reactivation results require exactly one send intent.',
        path: ['notificationIntent'],
      });
    }
    if (
      result.notificationIntent &&
      (result.notificationIntent.eventId !== result.event.id ||
        result.notificationIntent.requestId !== result.transition.requestId ||
        result.notificationIntent.createdAt !== result.transition.occurredAt ||
        result.notificationIntent.eventKind !==
          result.transition.targeting.kind ||
        result.notificationIntent.templateMode !==
          result.transition.targeting.templateMode ||
        result.notificationIntent.rosterPopulation !==
          result.transition.targeting.rosterPopulation)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Lifecycle notification intent must match the event and transition request.',
        path: ['notificationIntent'],
      });
    }
    const expectedNotificationAuthorization = (() => {
      switch (result.transition.transition) {
        case 'activate':
          return result.transition.activationAuthorization;
        case 'all-clear':
        case 'reactivate':
          return result.transition.notificationAuthorization;
        case 'close':
        case 'reopen-as-correction':
          return null;
      }
    })();
    if (
      result.notificationIntent &&
      (!structurallyEqual(
        result.notificationIntent.authorization,
        expectedNotificationAuthorization,
      ) ||
        !structurallyEqual(
          result.notificationIntent.createdBy,
          result.transition.actor,
        ) ||
        result.notificationIntent.source !== result.transition.source ||
        !structurallyEqual(
          result.notificationIntent.eventTypeVersion,
          result.event.eventTypeVersion,
        ) ||
        result.notificationIntent.rosterSnapshotId !==
          result.event.rosterSnapshotId)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Lifecycle notification must preserve exact transition authorization and provenance.',
        path: ['notificationIntent'],
      });
    }
    const expectedPurpose =
      result.transition.transition === 'activate'
        ? 'activation'
        : result.transition.transition === 'all-clear'
          ? 'all-clear'
          : result.transition.transition === 'reactivate'
            ? 'reactivation'
            : null;
    if (
      result.notificationIntent &&
      result.notificationIntent.purpose !== expectedPurpose
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Lifecycle notification purpose must match its transition.',
        path: ['notificationIntent', 'purpose'],
      });
    }
    const preparedActivationId =
      result.transition.transition === 'activate' &&
      result.transition.activationAuthorization.kind === 'human-confirmed'
        ? result.transition.activationAuthorization.preparedActivationId
        : null;
    if (
      (preparedActivationId !== null) !==
      (result.preparedActivationConsumption !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Prepared activation provenance requires exactly one consumption fact.',
        path: ['preparedActivationConsumption'],
      });
    } else if (
      preparedActivationId !== null &&
      result.preparedActivationConsumption?.preparedActivationId !==
        preparedActivationId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Prepared activation consumption must match authorization.',
        path: ['preparedActivationConsumption', 'preparedActivationId'],
      });
    }
    if (
      result.preparedActivationConsumption &&
      (result.preparedActivationConsumption.eventId !== result.event.id ||
        result.preparedActivationConsumption.requestId !==
          result.transition.requestId ||
        !structurallyEqual(
          result.preparedActivationConsumption.authorization,
          result.transition.transition === 'activate'
            ? result.transition.activationAuthorization
            : null,
        ) ||
        !structurallyEqual(
          result.preparedActivationConsumption.consumedBy,
          result.transition.actor,
        ) ||
        result.preparedActivationConsumption.consumedAt !==
          result.transition.occurredAt)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Prepared activation consumption must preserve the exact transition authorization and provenance.',
        path: ['preparedActivationConsumption'],
      });
    }
    const carriesTransitionJournal = result.journalEntries.some(
      (entry) =>
        entry.kind === 'system' &&
        'transition' in entry.payload &&
        structurallyEqual(entry.payload.transition, result.transition),
    );
    if (!carriesTransitionJournal) {
      context.addIssue({
        code: 'custom',
        message:
          'Lifecycle result must include the system journal entry for its transition.',
        path: ['journalEntries'],
      });
    }
  })
  .readonly();

/** Atomic event lifecycle mutation result inferred from its schema. */
export type EventLifecycleMutationResult = z.infer<
  typeof EventLifecycleMutationResultSchema
>;

/** Owns the exact atomic output of the start-event capability. */
export const StartEventResultSchema = EventLifecycleMutationResultSchema.refine(
  (result) => result.transition.transition === 'activate',
  {
    message: 'Start-event output requires an activation transition.',
    path: ['transition', 'transition'],
  },
).readonly();

/** Exact start-event result inferred from its schema. */
export type StartEventResult = z.infer<typeof StartEventResultSchema>;

/** Owns the exact atomic output of the all-clear-event capability. */
export const AllClearEventResultSchema =
  EventLifecycleMutationResultSchema.refine(
    (result) => result.transition.transition === 'all-clear',
    {
      message: 'All-clear output requires an all-clear transition.',
      path: ['transition', 'transition'],
    },
  )
    .superRefine((result, context) => {
      if (result.transition.transition !== 'all-clear') return;
      if (result.event.status !== 'all-clear') {
        context.addIssue({
          code: 'custom',
          message: 'All-clear output must expose all-clear event state.',
          path: ['event', 'status'],
        });
      }
      if (
        result.journalEntries.some((entry) => entry.eventId !== result.event.id)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'All-clear journal facts must belong to the result event.',
          path: ['journalEntries'],
        });
      }
      const allClearFacts = result.journalEntries.filter(
        (entry) =>
          entry.kind === 'system' &&
          entry.payload.code === 'all-clear-issued' &&
          structurallyEqual(entry.payload.transition, result.transition) &&
          structurallyEqual(entry.author, result.transition.actor) &&
          entry.source === result.transition.source &&
          entry.serverTime === result.transition.occurredAt,
      );
      if (allClearFacts.length !== 1) {
        context.addIssue({
          code: 'custom',
          message:
            'All-clear output requires exactly one matching all-clear journal fact.',
          path: ['journalEntries'],
        });
      }
      const intentId = result.notificationIntent?.id;
      const intentFacts = result.journalEntries.filter(
        (entry) =>
          entry.kind === 'system' &&
          entry.payload.code === 'notification-intent-recorded' &&
          entry.payload.relatedRecordId === intentId &&
          structurallyEqual(entry.author, result.transition.actor) &&
          entry.source === result.transition.source &&
          entry.serverTime === result.transition.occurredAt,
      );
      if (intentId === undefined || intentFacts.length !== 1) {
        context.addIssue({
          code: 'custom',
          message:
            'All-clear output must link its notification intent from exactly one journal fact.',
          path: ['journalEntries'],
        });
      }
      if (result.journalEntries.length !== 2) {
        context.addIssue({
          code: 'custom',
          message:
            'All-clear output must contain only its transition and notification-intent facts.',
          path: ['journalEntries'],
        });
      }
    })
    .readonly();

/** Exact all-clear result inferred from its schema. */
export type AllClearEventResult = z.infer<typeof AllClearEventResultSchema>;

/** Owns the exact atomic output of the reactivate-event capability. */
export const ReactivateEventResultSchema =
  EventLifecycleMutationResultSchema.refine(
    (result) => result.transition.transition === 'reactivate',
    {
      message: 'Reactivation output requires a reactivation transition.',
      path: ['transition', 'transition'],
    },
  ).readonly();

/** Exact event-reactivation result inferred from its schema. */
export type ReactivateEventResult = z.infer<typeof ReactivateEventResultSchema>;

/** Owns the exact atomic output of the close-event capability. */
export const CloseEventResultSchema = EventLifecycleMutationResultSchema.refine(
  (result) => result.transition.transition === 'close',
  {
    message: 'Close-event output requires a close transition.',
    path: ['transition', 'transition'],
  },
)
  .superRefine((result, context) => {
    if (result.transition.transition !== 'close') return;
    if (result.event.status !== 'closed') {
      context.addIssue({
        code: 'custom',
        message: 'Close-event output must expose closed event state.',
        path: ['event', 'status'],
      });
    }
    if (
      result.journalEntries.some((entry) => entry.eventId !== result.event.id)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Close-event journal facts must belong to the result event.',
        path: ['journalEntries'],
      });
    }
    const closeFacts = result.journalEntries.filter(
      (entry) =>
        entry.kind === 'system' &&
        entry.payload.code === 'event-closed' &&
        structurallyEqual(entry.payload.transition, result.transition) &&
        structurallyEqual(entry.author, result.transition.actor) &&
        entry.source === result.transition.source &&
        entry.serverTime === result.transition.occurredAt,
    );
    if (closeFacts.length !== 1) {
      context.addIssue({
        code: 'custom',
        message:
          'Close-event output requires exactly one matching close journal fact.',
        path: ['journalEntries'],
      });
    }
    if (result.notificationIntent !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Closing an event cannot create a notification intent.',
        path: ['notificationIntent'],
      });
    }
    if (result.journalEntries.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Close-event output must contain only its close fact.',
        path: ['journalEntries'],
      });
    }
  })
  .readonly();

/** Exact event-close result inferred from its schema. */
export type CloseEventResult = z.infer<typeof CloseEventResultSchema>;

/** Owns the exact atomic output of reopen-as-correction. */
export const ReopenAsCorrectionResultSchema =
  EventLifecycleMutationResultSchema.refine(
    (result) => result.transition.transition === 'reopen-as-correction',
    {
      message: 'Correction reopen output requires a correction transition.',
      path: ['transition', 'transition'],
    },
  ).readonly();

/** Exact correction-reopen result inferred from its schema. */
export type ReopenAsCorrectionResult = z.infer<
  typeof ReopenAsCorrectionResultSchema
>;

/**
 * Closed release-one capability catalog through issue #30. This is the
 * sole owner of callable IDs and their complete signatures. Provider adapters
 * may normalize untrusted input before invocation, but they may not substitute
 * a different operation, effect, policy, input schema, or output schema.
 */
const CAPABILITY_CATALOG_BASE = Object.freeze({
  'complete-oidc-sign-in': canonicalCapability({
    id: 'complete-oidc-sign-in',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: preSessionOidcInvocationPolicy,
    inputSchema: CompleteOidcSignInInputSchema,
    outputSchema: SessionEstablishmentResultSchema,
  }),
  'refresh-session': canonicalCapability({
    id: 'refresh-session',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: verifiedRefreshInvocationPolicy,
    inputSchema: RefreshSessionInputSchema,
    outputSchema: SessionEstablishmentResultSchema,
  }),
  'revoke-session': canonicalCapability({
    id: 'revoke-session',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: RevokeSessionInputSchema,
    outputSchema: SessionRevocationSchema,
  }),
  'sync-roster': canonicalCapability({
    id: 'sync-roster',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentScheduledInvocationPolicy,
    inputSchema: SyncRosterInputSchema,
    outputSchema: RosterSyncResultSchema,
  }),
  'sync-access-membership': canonicalCapability({
    id: 'sync-access-membership',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: systemScheduledInvocationPolicy,
    inputSchema: SyncAccessMembershipInputSchema,
    outputSchema: SyncAccessMembershipResultSchema,
  }),
  'prepare-activation': canonicalCapability({
    id: 'prepare-activation',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: PrepareActivationInputSchema,
    outputSchema: PreparedActivationSchema,
  }),
  'start-event': canonicalCapability({
    id: 'start-event',
    operation: 'mutation',
    safetyEffect: 'start-event',
    invocationPolicy: humanAgentScheduledInvocationPolicy,
    inputSchema: StartEventInputSchema,
    outputSchema: StartEventResultSchema,
  }),
  'join-event': canonicalCapability({
    id: 'join-event',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: JoinEventInputSchema,
    outputSchema: JoinEventResultSchema,
  }),
  'all-clear-event': canonicalCapability({
    id: 'all-clear-event',
    operation: 'mutation',
    safetyEffect: 'all-clear-event',
    invocationPolicy: humanAgentScheduledInvocationPolicy,
    inputSchema: AllClearEventInputSchema,
    outputSchema: AllClearEventResultSchema,
  }),
  'reactivate-event': canonicalCapability({
    id: 'reactivate-event',
    operation: 'mutation',
    safetyEffect: 'start-event',
    invocationPolicy: humanAgentScheduledInvocationPolicy,
    inputSchema: ReactivateEventInputSchema,
    outputSchema: ReactivateEventResultSchema,
  }),
  'close-event': canonicalCapability({
    id: 'close-event',
    operation: 'mutation',
    safetyEffect: 'close-event',
    invocationPolicy: humanAgentScheduledInvocationPolicy,
    inputSchema: CloseEventInputSchema,
    outputSchema: CloseEventResultSchema,
  }),
  'reopen-as-correction': canonicalCapability({
    id: 'reopen-as-correction',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ReopenAsCorrectionInputSchema,
    outputSchema: ReopenAsCorrectionResultSchema,
  }),
  'append-journal-entry': canonicalCapability({
    id: 'append-journal-entry',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    mutationOrderAfter: 'join-event',
    inputSchema: AppendJournalEntryInputSchema,
    outputSchema: JournalEntrySchema,
  }),
  'correct-journal-entry': canonicalCapability({
    id: 'correct-journal-entry',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    mutationOrderAfter: 'append-journal-entry',
    inputSchema: CorrectJournalEntryInputSchema,
    outputSchema: JournalEntrySchema,
  }),
  'redact-journal-entry': canonicalCapability({
    id: 'redact-journal-entry',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    mutationOrderAfter: 'correct-journal-entry',
    inputSchema: RedactJournalEntryInputSchema,
    outputSchema: JournalEntrySchema,
  }),
  'create-media-upload-intent': canonicalCapability({
    id: 'create-media-upload-intent',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: CreateMediaUploadIntentInputSchema,
    outputSchema: MediaUploadIntentSchema,
  }),
  'complete-media-upload': canonicalCapability({
    id: 'complete-media-upload',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentWorkerInvocationPolicy,
    inputSchema: CompleteMediaUploadInputSchema,
    outputSchema: MediaRecordSchema,
  }),
  'create-event-type-draft': canonicalCapability({
    id: 'create-event-type-draft',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: CreateEventTypeDraftInputSchema,
    outputSchema: EventTypeVersionDraftSchema,
  }),
  'update-event-type-draft': canonicalCapability({
    id: 'update-event-type-draft',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: UpdateEventTypeDraftInputSchema,
    outputSchema: EventTypeVersionDraftSchema,
  }),
  'publish-event-type-version': canonicalCapability({
    id: 'publish-event-type-version',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: PublishEventTypeVersionInputSchema,
    outputSchema: EventTypeVersionSchema,
  }),
  'dispatch-outbox': canonicalCapability({
    id: 'dispatch-outbox',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: systemWorkerScheduledInvocationPolicy,
    inputSchema: DispatchOutboxInputSchema,
    outputSchema: DispatchOutboxResultSchema,
  }),
  'record-delivery-evidence': canonicalCapability({
    id: 'record-delivery-evidence',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: systemWorkerWebhookInvocationPolicy,
    inputSchema: RecordDeliveryEvidenceInputSchema,
    outputSchema: DeliveryEvidenceSchema,
  }),
  'reconcile-delivery-attempts': canonicalCapability({
    id: 'reconcile-delivery-attempts',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: systemWorkerScheduledInvocationPolicy,
    inputSchema: ReconcileDeliveryAttemptsInputSchema,
    outputSchema: ReconcileDeliveryAttemptsResultSchema,
  }),
  'record-endpoint-status': canonicalCapability({
    id: 'record-endpoint-status',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: systemWorkerWebhookInvocationPolicy,
    inputSchema: RecordEndpointStatusInputSchema,
    outputSchema: EndpointStatusRecordSchema,
  }),
  'record-sms-opt-out': canonicalCapability({
    id: 'record-sms-opt-out',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: systemWorkerScheduledInvocationPolicy,
    inputSchema: RecordSmsOptOutInputSchema,
    outputSchema: SmsOptOutRecordSchema,
  }),
  'register-push-token': canonicalCapability({
    id: 'register-push-token',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: RegisterPushTokenInputSchema,
    outputSchema: PushTokenRegistrationReceiptSchema,
  }),
  'unregister-push-token': canonicalCapability({
    id: 'unregister-push-token',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: UnregisterPushTokenInputSchema,
    outputSchema: PushTokenUnregistrationReceiptSchema,
  }),
  'record-sms-consent': canonicalCapability({
    id: 'record-sms-consent',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: RecordSmsConsentInputSchema,
    outputSchema: SmsConsentReceiptSchema,
  }),
  'withdraw-sms-consent': canonicalCapability({
    id: 'withdraw-sms-consent',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: WithdrawSmsConsentInputSchema,
    outputSchema: SmsConsentWithdrawalReceiptSchema,
  }),
  'read-my-sms-consent': canonicalCapability({
    id: 'read-my-sms-consent',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: ReadMySmsConsentInputSchema,
    outputSchema: MySmsConsentViewSchema,
  }),
  'create-facility': canonicalCapability({
    id: 'create-facility',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: CreateFacilityInputSchema,
    outputSchema: FacilitySchema,
  }),
  'update-facility': canonicalCapability({
    id: 'update-facility',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: UpdateFacilityInputSchema,
    outputSchema: FacilitySchema,
  }),
  'set-user-facility-scope': canonicalCapability({
    id: 'set-user-facility-scope',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: SetUserFacilityScopeInputSchema,
    outputSchema: UserSchema,
  }),
  'create-neighborhood-version': canonicalCapability({
    id: 'create-neighborhood-version',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: CreateNeighborhoodVersionInputSchema,
    outputSchema: NeighborhoodSchema,
  }),
  'create-group-source': canonicalCapability({
    id: 'create-group-source',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: CreateGroupSourceInputSchema,
    outputSchema: GroupSourceSchema,
  }),
  'update-group-source': canonicalCapability({
    id: 'update-group-source',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: UpdateGroupSourceInputSchema,
    outputSchema: GroupSourceSchema,
  }),
  'set-manual-roster-members': canonicalCapability({
    id: 'set-manual-roster-members',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: SetManualRosterMembersInputSchema,
    outputSchema: ManualRosterMembershipSchema,
  }),
  'set-channel-enabled': canonicalCapability({
    id: 'set-channel-enabled',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: SetChannelEnabledInputSchema,
    outputSchema: ChannelConfigurationSchema,
  }),
  'create-activation-preview': canonicalCapability({
    id: 'create-activation-preview',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: CreateActivationPreviewInputSchema,
    outputSchema: ActivationPreviewSchema,
  }),
  'create-lifecycle-consequence-preview': canonicalCapability({
    id: 'create-lifecycle-consequence-preview',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: CreateLifecycleConsequencePreviewInputSchema,
    outputSchema: LifecycleConsequencePreviewSchema,
  }),
  'get-prepared-activation': canonicalCapability({
    id: 'get-prepared-activation',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetPreparedActivationInputSchema,
    outputSchema: PreparedActivationSchema,
  }),
  'get-current-session': canonicalCapability({
    id: 'get-current-session',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: z.object({}).strict().readonly(),
    outputSchema: CurrentSessionResultSchema,
  }),
  'list-device-sessions': canonicalCapability({
    id: 'list-device-sessions',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: ListDeviceSessionsInputSchema,
    outputSchema: DeviceSessionPageSchema,
  }),
  'get-roster-snapshot': canonicalCapability({
    id: 'get-roster-snapshot',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetRosterSnapshotInputSchema,
    outputSchema: RosterSnapshotSchema,
  }),
  'list-group-sources': canonicalCapability({
    id: 'list-group-sources',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListGroupSourcesInputSchema,
    outputSchema: GroupSourcePageSchema,
  }),
  'get-roster-health': canonicalCapability({
    id: 'get-roster-health',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: RosterHealthQuerySchema,
    outputSchema: StaleRosterReportSchema,
  }),
  'get-stale-roster-report': canonicalCapability({
    id: 'get-stale-roster-report',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: RosterHealthQuerySchema,
    outputSchema: StaleRosterReportSchema,
  }),
  'list-active-events': canonicalCapability({
    id: 'list-active-events',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListActiveEventsInputSchema,
    outputSchema: EventPageSchema,
  }),
  'get-event': canonicalCapability({
    id: 'get-event',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetEventInputSchema,
    outputSchema: EventSchema,
  }),
  'sync-event-room': canonicalCapability({
    id: 'sync-event-room',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    // Binding issue #77 operational sign-off: this human-interactive,
    // read-only high-frequency sync omits successful chain writes so 1,200
    // pollers do not serialize incident mutations. Denials/failures remain
    // audited, and the catalog invariants below prohibit this policy for
    // agents, non-interactive sources, and mutations.
    auditPolicy: 'denied-and-failed',
    inputSchema: SyncEventRoomInputSchema,
    outputSchema: EventRoomSyncResultSchema,
  }),
  'list-journal-entries': canonicalCapability({
    id: 'list-journal-entries',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListJournalEntriesInputSchema,
    outputSchema: JournalEntryPageSchema,
  }),
  'search-journal-entries': canonicalCapability({
    id: 'search-journal-entries',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: SearchJournalEntriesInputSchema,
    outputSchema: JournalEntryPageSchema,
  }),
  'get-media-read-grant': canonicalCapability({
    id: 'get-media-read-grant',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetMediaReadGrantInputSchema,
    outputSchema: MediaReadGrantSchema,
  }),
  'list-event-types': canonicalCapability({
    id: 'list-event-types',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListEventTypesInputSchema,
    outputSchema: EventTypePageSchema,
  }),
  'get-event-type-version': canonicalCapability({
    id: 'get-event-type-version',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetEventTypeVersionInputSchema,
    outputSchema: EventTypeVersionSchema,
  }),
  'get-event-type-draft': canonicalCapability({
    id: 'get-event-type-draft',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetEventTypeDraftInputSchema,
    outputSchema: EventTypeVersionDraftSchema,
  }),
  'preview-event-type-rendering': canonicalCapability({
    id: 'preview-event-type-rendering',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: PreviewEventTypeRenderingInputSchema,
    outputSchema: EventTypeRenderingPreviewSchema,
  }),
  'get-notification-status': canonicalCapability({
    id: 'get-notification-status',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetNotificationStatusInputSchema,
    outputSchema: NotificationStatusSchema,
  }),
  'run-delivery-report': canonicalCapability({
    id: 'run-delivery-report',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: RunDeliveryReportInputSchema,
    outputSchema: DeliveryReportSchema,
  }),
  'get-integration-health': canonicalCapability({
    id: 'get-integration-health',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentScheduledInvocationPolicy,
    inputSchema: GetIntegrationHealthInputSchema,
    outputSchema: IntegrationHealthSchema,
  }),
  'get-admin-readiness': canonicalCapability({
    id: 'get-admin-readiness',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanWebAdministrationInvocationPolicy,
    inputSchema: GetAdminReadinessInputSchema,
    outputSchema: AdminReadinessSchema,
  }),
  'list-my-devices': canonicalCapability({
    id: 'list-my-devices',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: ListMyDevicesInputSchema,
    outputSchema: DeviceEnrollmentPageSchema,
  }),
  'list-facilities': canonicalCapability({
    id: 'list-facilities',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListFacilitiesInputSchema,
    outputSchema: FacilityPageSchema,
  }),
  'list-threats': canonicalCapability({
    id: 'list-threats',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListThreatsInputSchema,
    outputSchema: ThreatPageSchema,
  }),
  'get-facility': canonicalCapability({
    id: 'get-facility',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetFacilityInputSchema,
    outputSchema: FacilitySchema,
  }),
  'list-neighborhoods': canonicalCapability({
    id: 'list-neighborhoods',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListNeighborhoodsInputSchema,
    outputSchema: NeighborhoodPageSchema,
  }),
  'list-neighborhood-versions': canonicalCapability({
    id: 'list-neighborhood-versions',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListNeighborhoodVersionsInputSchema,
    outputSchema: NeighborhoodPageSchema,
  }),
  'get-neighborhood-version': canonicalCapability({
    id: 'get-neighborhood-version',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: GetNeighborhoodVersionInputSchema,
    outputSchema: NeighborhoodSchema,
  }),
  'list-users': canonicalCapability({
    id: 'list-users',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListUsersInputSchema,
    outputSchema: UserPageSchema,
  }),
  // Admission is a sign-in decision made by a person on the web: an admitted
  // address may sign in as staff without a designated group. Never offered
  // to agents.
  'admit-account': canonicalCapability({
    id: 'admit-account',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanWebAdministrationInvocationPolicy,
    inputSchema: AdmitAccountInputSchema,
    outputSchema: AdmittedAccountSchema,
  }),
  'revoke-admitted-account': canonicalCapability({
    id: 'revoke-admitted-account',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanWebAdministrationInvocationPolicy,
    inputSchema: RevokeAdmittedAccountInputSchema,
    outputSchema: AdmittedAccountSchema,
  }),
  'list-admitted-accounts': canonicalCapability({
    id: 'list-admitted-accounts',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanWebAdministrationInvocationPolicy,
    inputSchema: ListAdmittedAccountsInputSchema,
    outputSchema: AdmittedAccountListSchema,
  }),
  'list-drill-records': canonicalCapability({
    id: 'list-drill-records',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ListDrillRecordsInputSchema,
    outputSchema: DrillRecordPageSchema,
  }),
  'list-event-records': canonicalCapability({
    id: 'list-event-records',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanInteractiveInvocationPolicy,
    inputSchema: ListEventRecordsInputSchema,
    outputSchema: EventRecordPageSchema,
  }),
  'export-drill-records': canonicalCapability({
    id: 'export-drill-records',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ExportDrillRecordsInputSchema,
    outputSchema: RecordsExportSchema,
  }),
  'export-event-summary': canonicalCapability({
    id: 'export-event-summary',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: ExportEventSummaryInputSchema,
    outputSchema: EventSummaryExportSchema,
  }),
  'query-security-audit': canonicalCapability({
    id: 'query-security-audit',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    inputSchema: SecurityAuditQuerySchema,
    outputSchema: SecurityAuditPageSchema,
  }),
  'verify-security-audit-chain': canonicalCapability({
    id: 'verify-security-audit-chain',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentScheduledInvocationPolicy,
    inputSchema: VerifySecurityAuditChainInputSchema,
    outputSchema: SecurityAuditVerificationSchema,
  }),
});

/*
 * Agent-key schemas contain the grant enum derived from capability policy.
 * Keep their policy metadata independent of those schemas so the exact grant
 * type can be established before the schemas consume it.
 */
const AGENT_API_CAPABILITY_METADATA = Object.freeze({
  'issue-agent-api-key': Object.freeze({
    id: 'issue-agent-api-key',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanWebAdministrationInvocationPolicy,
    mutationOrderAfter: 'set-channel-enabled',
  }),
  'revoke-agent-api-key': Object.freeze({
    id: 'revoke-agent-api-key',
    operation: 'mutation',
    safetyEffect: 'none',
    invocationPolicy: humanWebAdministrationInvocationPolicy,
    mutationOrderAfter: 'issue-agent-api-key',
  }),
  'list-agent-api-keys': Object.freeze({
    id: 'list-agent-api-keys',
    operation: 'query',
    safetyEffect: 'none',
    invocationPolicy: humanAgentInvocationPolicy,
    agentGrantOrderAfter: 'list-users',
  }),
});

type GrantableCapabilityId<Catalog> = {
  [Id in Extract<keyof Catalog, string>]: Catalog[Id] extends {
    readonly invocationPolicy: { readonly agentGrantable: true };
  }
    ? Id
    : never;
}[Extract<keyof Catalog, string>];

/** Capability IDs whose canonical invocation policy admits agent principals. */
export type AgentGrantableCapabilityId =
  | GrantableCapabilityId<typeof CAPABILITY_CATALOG_BASE>
  | GrantableCapabilityId<typeof AGENT_API_CAPABILITY_METADATA>;

const AGENT_API_CAPABILITY_CATALOG = Object.freeze({
  'issue-agent-api-key': canonicalCapability({
    ...AGENT_API_CAPABILITY_METADATA['issue-agent-api-key'],
    inputSchema: IssueAgentApiKeyInputSchema,
    outputSchema: AgentApiKeyIssuanceSchema,
  }),
  'revoke-agent-api-key': canonicalCapability({
    ...AGENT_API_CAPABILITY_METADATA['revoke-agent-api-key'],
    inputSchema: RevokeAgentApiKeyInputSchema,
    outputSchema: AgentApiKeyRevocationSchema,
  }),
  'list-agent-api-keys': canonicalCapability({
    ...AGENT_API_CAPABILITY_METADATA['list-agent-api-keys'],
    inputSchema: ListAgentApiKeysInputSchema,
    outputSchema: AgentApiKeyPageSchema,
  }),
} satisfies Readonly<
  Record<
    keyof typeof AGENT_API_CAPABILITY_METADATA,
    CanonicalCapabilityDefinition
  >
>);

export const CAPABILITY_CATALOG = Object.freeze({
  ...CAPABILITY_CATALOG_BASE,
  ...AGENT_API_CAPABILITY_CATALOG,
});

/** Stable callable capability identifier inferred from the closed catalog. */
export type RegisteredCapabilityId = keyof typeof CAPABILITY_CATALOG;

/** Exact public grant type derived from the canonical catalog policy. */
export type AgentCapabilityGrant = AgentGrantableCapabilityId;

type CanonicalMutationSafetyManifest = Readonly<{
  [Id in RegisteredCapabilityId as (typeof CAPABILITY_CATALOG)[Id]['operation'] extends 'mutation'
    ? Id
    : never]: (typeof CAPABILITY_CATALOG)[Id]['safetyEffect'];
}>;

type CanonicalQueryManifest = Readonly<{
  [Id in RegisteredCapabilityId as (typeof CAPABILITY_CATALOG)[Id]['operation'] extends 'query'
    ? Id
    : never]: 'none';
}>;

type CanonicalInvocationPolicyMap = Readonly<{
  [Id in RegisteredCapabilityId]: (typeof CAPABILITY_CATALOG)[Id]['invocationPolicy'];
}>;

type CanonicalAuditPolicyMap = Readonly<{
  [Id in RegisteredCapabilityId]: (typeof CAPABILITY_CATALOG)[Id]['auditPolicy'];
}>;

type AnyCanonicalCapabilityDefinition = CanonicalCapabilityDefinition<
  string,
  CapabilityOperation,
  CapabilitySafetyEffect,
  z.ZodType,
  z.ZodType,
  CapabilityAuditPolicy
>;

type CatalogKey<Catalog> = Extract<keyof Catalog, string>;

interface DerivedOrderedEntry<Value> {
  readonly id: string;
  readonly value: Value;
  readonly orderAfter: string | undefined;
}

function applyDerivedOrder<Value>(
  entries: readonly DerivedOrderedEntry<Value>[],
): readonly DerivedOrderedEntry<Value>[] {
  const ordered = entries.filter((entry) => entry.orderAfter === undefined);
  for (const entry of entries) {
    if (entry.orderAfter === undefined) continue;
    const targetIndex = ordered.findIndex(
      (candidate) => candidate.id === entry.orderAfter,
    );
    if (targetIndex === -1) {
      throw new Error(
        `Derived capability order target ${entry.orderAfter} is missing.`,
      );
    }
    ordered.splice(targetIndex + 1, 0, entry);
  }
  return ordered;
}

export type CapabilityDerivedViews<
  Catalog extends Readonly<Record<string, AnyCanonicalCapabilityDefinition>>,
> = Readonly<{
  registeredCapabilityIds: readonly CatalogKey<Catalog>[];
  mutationSafetyManifest: Readonly<{
    [Id in CatalogKey<Catalog> as Catalog[Id]['operation'] extends 'mutation'
      ? Id
      : never]: Catalog[Id]['safetyEffect'];
  }>;
  queryManifest: Readonly<{
    [Id in CatalogKey<Catalog> as Catalog[Id]['operation'] extends 'query'
      ? Id
      : never]: 'none';
  }>;
  invocationPolicy: Readonly<{
    [Id in CatalogKey<Catalog>]: Catalog[Id]['invocationPolicy'];
  }>;
  auditPolicy: Readonly<{
    [Id in CatalogKey<Catalog>]: Catalog[Id]['auditPolicy'];
  }>;
  agentGrantableCapabilityIds: readonly {
    [Id in CatalogKey<Catalog>]: Catalog[Id]['invocationPolicy']['agentGrantable'] extends true
      ? Id
      : never;
  }[CatalogKey<Catalog>][];
}>;

/** Derives every public policy and manifest from one immutable catalog. */
export function deriveCapabilityViews<
  const Catalog extends Readonly<
    Record<string, AnyCanonicalCapabilityDefinition>
  >,
>(catalog: Catalog): CapabilityDerivedViews<Catalog> {
  const registeredCapabilityIds: string[] = [];
  const mutationEntries: DerivedOrderedEntry<CapabilitySafetyEffect>[] = [];
  const queryManifest: Record<string, 'none'> = {};
  const invocationPolicies: Record<string, CapabilityInvocationPolicy> = {};
  const auditPolicies: Record<string, CapabilityAuditPolicy> = {};
  const agentGrantableEntries: DerivedOrderedEntry<null>[] = [];

  for (const [key, definition] of Object.entries(catalog)) {
    if (key !== definition.id) {
      throw new Error(`Capability catalog key must match ${definition.id}.`);
    }
    registeredCapabilityIds.push(definition.id);
    invocationPolicies[definition.id] = definition.invocationPolicy;
    auditPolicies[definition.id] = definition.auditPolicy;
    if (definition.operation === 'mutation') {
      mutationEntries.push({
        id: definition.id,
        value: definition.safetyEffect,
        orderAfter: definition.mutationOrderAfter,
      });
    } else {
      queryManifest[definition.id] = 'none';
    }
    if (definition.invocationPolicy.agentGrantable) {
      agentGrantableEntries.push({
        id: definition.id,
        value: null,
        orderAfter: definition.agentGrantOrderAfter,
      });
    }
  }

  const mutationSafetyManifest: Record<string, CapabilitySafetyEffect> = {};
  for (const entry of applyDerivedOrder(mutationEntries)) {
    mutationSafetyManifest[entry.id] = entry.value;
  }
  const agentGrantableCapabilityIds = applyDerivedOrder(
    agentGrantableEntries,
  ).map((entry) => entry.id);

  return Object.freeze({
    registeredCapabilityIds: Object.freeze(registeredCapabilityIds),
    mutationSafetyManifest: Object.freeze(mutationSafetyManifest),
    queryManifest: Object.freeze(queryManifest),
    invocationPolicy: Object.freeze(invocationPolicies),
    auditPolicy: Object.freeze(auditPolicies),
    agentGrantableCapabilityIds: Object.freeze(agentGrantableCapabilityIds),
  }) as CapabilityDerivedViews<Catalog>;
}

const CAPABILITY_VIEWS = deriveCapabilityViews(CAPABILITY_CATALOG);

export const CAPABILITY_MUTATION_SAFETY_MANIFEST =
  CAPABILITY_VIEWS.mutationSafetyManifest as CanonicalMutationSafetyManifest;
export const CAPABILITY_QUERY_MANIFEST =
  CAPABILITY_VIEWS.queryManifest as CanonicalQueryManifest;
export const CAPABILITY_INVOCATION_POLICY =
  CAPABILITY_VIEWS.invocationPolicy as CanonicalInvocationPolicyMap;
export const CAPABILITY_AUDIT_POLICY =
  CAPABILITY_VIEWS.auditPolicy as CanonicalAuditPolicyMap;
export const MUTATION_CAPABILITY_IDS = Object.freeze(
  Object.keys(CAPABILITY_MUTATION_SAFETY_MANIFEST),
) as readonly [
  RegisteredMutationCapabilityId,
  ...RegisteredMutationCapabilityId[],
];
export const AGENT_GRANTABLE_CAPABILITY_IDS =
  CAPABILITY_VIEWS.agentGrantableCapabilityIds as readonly [
    AgentGrantableCapabilityId,
    ...AgentGrantableCapabilityId[],
  ];

const agentGrantableCapabilityIdSet = new Set<string>(
  AGENT_GRANTABLE_CAPABILITY_IDS,
);

/** Returns true only for IDs derived as grantable to agent API keys. */
export function isAgentGrantableCapabilityId(
  value: unknown,
): value is AgentGrantableCapabilityId {
  return typeof value === 'string' && agentGrantableCapabilityIdSet.has(value);
}

installCapabilityViews(CAPABILITY_VIEWS);

/** Returns the immutable principal/source policy for one canonical ID. */
export function getCapabilityInvocationPolicy<
  Id extends RegisteredCapabilityId,
>(id: Id): (typeof CAPABILITY_INVOCATION_POLICY)[Id] {
  return CAPABILITY_INVOCATION_POLICY[id]!;
}

const registeredCapabilityIds = CAPABILITY_VIEWS.registeredCapabilityIds as [
  RegisteredCapabilityId,
  ...RegisteredCapabilityId[],
];

/**
 * Owns the exact callable release-one capability-ID vocabulary. Human-only
 * action IDs are intentionally absent because they are derived requirements,
 * never independently callable operations.
 */
export const RegisteredCapabilityIdSchema = z.enum(registeredCapabilityIds);

/** Query-only identifier inferred from each catalog entry's operation. */
export type RegisteredQueryCapabilityId = {
  [Id in RegisteredCapabilityId]: (typeof CAPABILITY_CATALOG)[Id]['operation'] extends 'query'
    ? Id
    : never;
}[RegisteredCapabilityId];

/** Mutation-only identifier inferred from each catalog entry's operation. */
export type RegisteredMutationCapabilityId = {
  [Id in RegisteredCapabilityId]: (typeof CAPABILITY_CATALOG)[Id]['operation'] extends 'mutation'
    ? Id
    : never;
}[RegisteredCapabilityId];

/** Canonical immutable definition for one registered capability ID. */
export type CapabilityDefinitionFor<Id extends RegisteredCapabilityId> =
  (typeof CAPABILITY_CATALOG)[Id];

/** Parsed input type for one registered capability ID. */
export type CapabilityInput<Id extends RegisteredCapabilityId> = z.output<
  CapabilityDefinitionFor<Id>['inputSchema']
>;

/** Parsed output type for one registered capability ID. */
export type CapabilityOutput<Id extends RegisteredCapabilityId> = z.output<
  CapabilityDefinitionFor<Id>['outputSchema']
>;

/**
 * Trusted base envelope narrowed to one registered ID, its canonical
 * operation, and its parsed per-capability input.
 */
export type RegisteredCapabilityEnvelope<
  Id extends RegisteredCapabilityId = RegisteredCapabilityId,
> = CapabilityEnvelope & {
  readonly capabilityId: Id;
  readonly operation: CapabilityDefinitionFor<Id>['operation'];
  readonly input: CapabilityInput<Id>;
};

/** Returns true only for IDs present in the closed release-one catalog. */
export function isRegisteredCapabilityId(
  value: unknown,
): value is RegisteredCapabilityId {
  return (
    typeof value === 'string' &&
    CapabilityIdSchema.safeParse(value).success &&
    Object.hasOwn(CAPABILITY_CATALOG, value)
  );
}

/**
 * Returns the canonical definition for an ID. Callers cannot supply any
 * signature or safety metadata, eliminating route- and tool-local drift.
 */
export function defineCapability<Id extends RegisteredCapabilityId>(
  id: Id,
): CapabilityDefinitionFor<Id> {
  RegisteredCapabilityIdSchema.parse(id);
  return CAPABILITY_CATALOG[id];
}

/** Parses untrusted capability input through the ID's canonical schema. */
export function parseCapabilityInput<Id extends RegisteredCapabilityId>(
  id: Id,
  input: unknown,
): CapabilityInput<Id> {
  return defineCapability(id).inputSchema.parse(input) as CapabilityInput<Id>;
}

/** Parses a handler result through the ID's canonical output schema. */
export function parseCapabilityOutput<Id extends RegisteredCapabilityId>(
  id: Id,
  output: unknown,
): CapabilityOutput<Id> {
  return defineCapability(id).outputSchema.parse(
    output,
  ) as CapabilityOutput<Id>;
}

function getEnvelopePrincipalKind(
  envelope: CapabilityEnvelope,
): CapabilityPrincipalKind {
  if (
    'principal' in envelope &&
    envelope.capabilityId === 'complete-oidc-sign-in'
  ) {
    return 'pre-session-oidc';
  }
  if (envelope.capabilityId === 'refresh-session') {
    return 'verified-refresh-credential';
  }
  if ('actor' in envelope) {
    return envelope.actor.kind;
  }
  throw new Error('Capability envelope has no recognized trusted principal.');
}

function assertCapabilityInvocationAllowed(
  capabilityId: RegisteredCapabilityId,
  envelope: CapabilityEnvelope,
): void {
  const policy = getCapabilityInvocationPolicy(capabilityId);
  const principalKinds = new Set<CapabilityPrincipalKind>(
    policy.principalKinds,
  );
  const sources = new Set<InvocationSource>(policy.sources);
  z.object({
    principalKind: CapabilityPrincipalKindSchema.refine(
      (principalKind) => principalKinds.has(principalKind),
      {
        message: `${capabilityId} rejects this authenticated principal class.`,
      },
    ),
    source: InvocationSourceSchema.refine((source) => sources.has(source), {
      message: `${capabilityId} rejects this invocation source.`,
    }),
  })
    .strict()
    .parse({
      principalKind: getEnvelopePrincipalKind(envelope),
      source: envelope.source,
    });
}

function assertOidcPrincipalMatchesInput(
  principal: PreSessionOidcPrincipal,
  input: CapabilityInput<'complete-oidc-sign-in'>,
): void {
  z.object({
    issuer: z.literal(principal.issuer),
    audience: z.literal(principal.audience),
    subject: z.literal(principal.subject),
    subjectDigest: z.literal(principal.subjectDigest),
    claimsDigest: z.literal(principal.claimsDigest),
    hostedDomain: z.literal(principal.hostedDomain),
    email: z.literal(principal.email),
    emailVerified: z.literal(principal.emailVerified),
    displayName: z.literal(principal.displayName),
  })
    .strict()
    .parse(input.claims);
}

/**
 * Parses one invocation through both the trusted provenance envelope and the
 * selected catalog entry. Closed-ID and operation checks occur before the
 * canonical per-ID input schema, so adapters cannot supply route-local input
 * contracts or execute a mutation under a query ID.
 */
export function parseRegisteredCapabilityEnvelope(
  value: unknown,
): RegisteredCapabilityEnvelope {
  const envelope = CapabilityEnvelopeSchema.parse(value);
  const capabilityId = RegisteredCapabilityIdSchema.parse(
    envelope.capabilityId,
  );
  const definition = defineCapability(capabilityId);
  z.literal(definition.operation).parse(envelope.operation);
  assertCapabilityInvocationAllowed(capabilityId, envelope);
  const input = parseCapabilityInput(capabilityId, envelope.input);
  if (
    'principal' in envelope &&
    envelope.capabilityId === 'complete-oidc-sign-in' &&
    envelope.principal.kind === 'verified-oidc-claims'
  ) {
    assertOidcPrincipalMatchesInput(
      envelope.principal,
      input as CapabilityInput<'complete-oidc-sign-in'>,
    );
  }
  return Object.freeze({
    ...envelope,
    capabilityId,
    operation: definition.operation,
    input,
  }) as RegisteredCapabilityEnvelope;
}

/**
 * Parses one invocation for an expected registered ID and returns its exact
 * input type. This is the route/tool adapter boundary used after dispatch has
 * selected a canonical capability.
 */
export function parseCapabilityEnvelopeFor<Id extends RegisteredCapabilityId>(
  id: Id,
  value: unknown,
): RegisteredCapabilityEnvelope<Id> {
  const envelope = parseRegisteredCapabilityEnvelope(value);
  z.literal(id).parse(envelope.capabilityId);
  return envelope as RegisteredCapabilityEnvelope<Id>;
}

/** Alias for the complete registered capability-envelope parser. */
export const parseCapabilityEnvelope = parseRegisteredCapabilityEnvelope;

export function deriveHumanOnlyActionIds(
  safetyEffect: CapabilitySafetyEffect,
  resolution: CapabilitySafetyResolution,
): HumanOnlyActionId[] {
  const actionIds: HumanOnlyActionId[] = [];
  switch (safetyEffect) {
    case 'none':
      break;
    case 'start-event':
      if (resolution.rosterPopulation === 'staff') {
        if (resolution.eventKind === 'incident') {
          actionIds.push('start-real-incident');
        }
        actionIds.push('send-real-notification');
      }
      break;
    case 'send-notification':
      if (resolution.rosterPopulation === 'staff') {
        actionIds.push('send-real-notification');
      }
      break;
    case 'all-clear-event':
      if (resolution.rosterPopulation === 'staff') {
        actionIds.push('all-clear', 'send-real-notification');
      }
      break;
    case 'close-event':
      if (
        resolution.rosterPopulation === 'staff' &&
        resolution.eventKind === 'incident'
      ) {
        actionIds.push('close-real-event');
      }
      break;
  }
  return actionIds;
}

/**
 * Resolves the exact protected-action requirement for a canonical capability.
 * The central resolver, not the handler, classifies authoritative event and
 * roster state. Staff-targeting lifecycle mutations reject every non-human
 * actor even when the particular transition needs no named protected action.
 */
export async function resolveHumanActionRequirement<
  Id extends RegisteredCapabilityId,
>(
  id: Id,
  input: unknown,
  context: HumanActionResolutionContext,
  safetyResolver: CapabilitySafetyResolver,
): Promise<HumanActionRequirement> {
  const definition = defineCapability(id);
  const parsedInput = parseCapabilityInput(id, input);
  if (definition.humanActionPolicy.kind === 'none') {
    return HumanActionRequirementSchema.parse({
      actionIds: [],
      consequenceDigest: null,
    });
  }
  if (definition.safetyEffect === 'none') {
    throw new Error('Central human-action policy requires a safety effect.');
  }
  const resolution = CapabilitySafetyResolutionSchema.parse(
    await safetyResolver.resolve({
      capabilityId: definition.id,
      safetyEffect: definition.safetyEffect,
      input: parsedInput,
      context,
    }),
  );
  if (
    resolution.rosterPopulation === 'staff' &&
    context.actor.kind !== 'human'
  ) {
    throw new Error(
      'Only a human may execute lifecycle capabilities against a staff roster.',
    );
  }

  const actionIds = deriveHumanOnlyActionIds(
    definition.safetyEffect,
    resolution,
  );
  return HumanActionRequirementSchema.parse({
    actionIds,
    consequenceDigest:
      actionIds.length > 0 ? resolution.consequenceDigest : null,
  });
}

/** Typed handler for one canonical capability and server-owned context. */
export type CapabilityHandler<
  Id extends RegisteredCapabilityId,
  Context = unknown,
> = (
  input: CapabilityInput<Id>,
  context: Context,
) => CapabilityOutput<Id> | Promise<CapabilityOutput<Id>>;

/**
 * Immutable typed handler registration. It carries only an ID and function;
 * all signature and safety metadata are retrieved from the catalog.
 */
export interface RegisteredCapabilityHandler<
  Id extends RegisteredCapabilityId,
  Context = unknown,
> {
  readonly id: Id;
  readonly handler: CapabilityHandler<Id, Context>;
}

/** Registers a handler by canonical ID without accepting alternate metadata. */
export function registerCapabilityHandler<
  Id extends RegisteredCapabilityId,
  Context = unknown,
>(
  id: Id,
  handler: CapabilityHandler<Id, Context>,
): Readonly<RegisteredCapabilityHandler<Id, Context>> {
  defineCapability(id);
  return Object.freeze({ id, handler });
}

/** Authorization request emitted before a registered handler can execute. */
export interface CapabilityAuthorizationRequest<
  Id extends RegisteredCapabilityId,
  Context,
> {
  readonly definition: CapabilityDefinitionFor<Id>;
  readonly invocationPolicy: CapabilityInvocationPolicy;
  readonly input: CapabilityInput<Id>;
  readonly humanActionRequirement: HumanActionRequirement;
  readonly context: Context;
}

/**
 * Mandatory server-side authorization gate used by canonical execution. It
 * validates actor, role, facility scope, transport, idempotency, and any human
 * confirmation before the handler runs.
 */
export interface CapabilityExecutionAuthorizer<Context> {
  readonly authorize: (
    request: CapabilityAuthorizationRequest<RegisteredCapabilityId, Context>,
  ) => void | Promise<void>;
}

/** Dependencies required to execute through the canonical safety boundary. */
export interface CapabilityExecutionDependencies<Context> {
  readonly context: Context;
  readonly humanActionResolutionContext: HumanActionResolutionContext | null;
  readonly safetyResolver: CapabilitySafetyResolver | null;
  readonly authorizer: CapabilityExecutionAuthorizer<Context>;
}

/**
 * Parses input, centrally resolves protected actions, invokes the mandatory
 * server authorizer, executes exactly one registered handler, and parses its
 * output. There is no overload that omits authorization.
 */
export async function invokeAuthorizedCapabilityHandler<
  Id extends RegisteredCapabilityId,
  Context,
>(
  registration: RegisteredCapabilityHandler<Id, Context>,
  input: unknown,
  dependencies: CapabilityExecutionDependencies<Context>,
): Promise<CapabilityOutput<Id>> {
  const definition = defineCapability(registration.id);
  const parsedInput = parseCapabilityInput(registration.id, input);
  const humanActionRequirement = (() => {
    if (definition.humanActionPolicy.kind === 'none') {
      return Promise.resolve(
        HumanActionRequirementSchema.parse({
          actionIds: [],
          consequenceDigest: null,
        }),
      );
    }
    if (
      dependencies.humanActionResolutionContext === null ||
      dependencies.safetyResolver === null
    ) {
      throw new Error(
        'Protected capabilities require the central safety resolver and trusted context.',
      );
    }
    return resolveHumanActionRequirement(
      registration.id,
      parsedInput,
      dependencies.humanActionResolutionContext,
      dependencies.safetyResolver,
    );
  })();
  const resolvedRequirement = await humanActionRequirement;
  await dependencies.authorizer.authorize({
    definition,
    invocationPolicy: getCapabilityInvocationPolicy(registration.id),
    input: parsedInput,
    humanActionRequirement: resolvedRequirement,
    context: dependencies.context,
  });
  return parseCapabilityOutput(
    registration.id,
    await registration.handler(parsedInput, dependencies.context),
  );
}

function assertCanonicalAuditPolicies(): void {
  const catalogIds = Object.keys(CAPABILITY_CATALOG).sort();
  catalogIds.forEach((id) => {
    const capabilityId = RegisteredCapabilityIdSchema.parse(id);
    const definition = defineCapability(capabilityId);
    const policy = definition.invocationPolicy;
    if (
      definition.auditPolicy === 'denied-and-failed' &&
      (capabilityId !== 'sync-event-room' ||
        definition.operation !== 'query' ||
        policy.agentGrantable ||
        policy.principalKinds.length !== 1 ||
        policy.principalKinds[0] !== 'human' ||
        policy.sources.length !== 2 ||
        !policy.sources.some((source) => source === 'web') ||
        !policy.sources.some((source) => source === 'mobile'))
    ) {
      throw new Error(
        `Reduced success auditing is not permitted for ${capabilityId}.`,
      );
    }
    if (
      (definition.operation === 'mutation' || policy.agentGrantable) &&
      definition.auditPolicy !== 'all-outcomes'
    ) {
      throw new Error(
        `Mutations and agent capabilities must audit every outcome for ${capabilityId}.`,
      );
    }
  });

  const reducedAuditIds = catalogIds.filter(
    (id) =>
      defineCapability(RegisteredCapabilityIdSchema.parse(id)).auditPolicy ===
      'denied-and-failed',
  );
  if (
    reducedAuditIds.length !== 1 ||
    reducedAuditIds[0] !== 'sync-event-room'
  ) {
    throw new Error(
      'Only sync-event-room may omit successful security-audit entries.',
    );
  }
}

assertCanonicalAuditPolicies();
