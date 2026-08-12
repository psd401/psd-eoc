import { z } from 'zod';

import {
  ActorSchema,
  InvocationSourceSchema,
  isActorSourceCompatible,
} from './capability';
import { AudienceConfigRefSchema } from './facility';
import { IntegrationStatusSchema } from './integration';
import {
  ActivationAuthorizationSchema,
  EventIdSchema,
  EventKindSchema,
  EventTargetingSchema,
  LifecycleActionAuthorizationSchema,
  type EventKind,
} from './event';
import {
  ChannelConsequencePreviewSchema,
  EventTypeVersionRefSchema,
  NotificationChannelSchema,
  NotificationPurposeSchema,
  RenderedMessageSchema,
  TemplateModeSchema,
  type NotificationPurpose,
  type TemplateMode,
} from './event-type';
import {
  EndpointIdSchema,
  RecipientIdSchema,
  RosterPopulationSchema,
  RosterSnapshotIdSchema,
  type RosterPopulation,
} from './roster';
import { isAtOrAfter, TimestampSchema, UuidSchema } from './shared';

/**
 * Owns the evidence-honest delivery state vocabulary. Provider acceptance and
 * provable delivery are distinct, and `unknown` is an ordinary truth state
 * rather than an omitted or overstated result.
 */
export const DeliveryTruthStateSchema = z.enum([
  'accepted',
  'recorded',
  'attempted',
  'provider-accepted',
  'delivered',
  'failed',
  'expired',
  'unknown',
]);

/** Evidence-honest delivery state inferred from its schema. */
export type DeliveryTruthState = z.infer<typeof DeliveryTruthStateSchema>;

/**
 * Owns endpoint-attempt states that may appear in latest-state projections.
 * Intent-level accepted/recorded facts remain evidence but are never counted
 * as recipient endpoint outcomes.
 */
export const AttemptDeliveryTruthStateSchema = z.enum([
  'attempted',
  'provider-accepted',
  'delivered',
  'failed',
  'expired',
  'unknown',
]);

/** Endpoint-attempt delivery truth state inferred from its schema. */
export type AttemptDeliveryTruthState = z.infer<
  typeof AttemptDeliveryTruthStateSchema
>;

/**
 * Owns the stable identifier for an immutable notification fan-out intent.
 * The event transaction creates this record before dispatch begins.
 */
export const NotificationIntentIdSchema = UuidSchema;

/** Notification intent identifier inferred from its schema. */
export type NotificationIntentId = z.infer<typeof NotificationIntentIdSchema>;

/**
 * Owns the stable identifier for one immutable channel dispatch batch. Batch
 * retries reference this identity rather than replacing historical evidence.
 */
export const DispatchBatchIdSchema = UuidSchema;

/** Dispatch batch identifier inferred from its schema. */
export type DispatchBatchId = z.infer<typeof DispatchBatchIdSchema>;

/**
 * Owns the stable identifier for one immutable channel attempt. Later
 * provider facts append delivery evidence instead of updating this row.
 */
export const ChannelAttemptIdSchema = UuidSchema;

/** Channel attempt identifier inferred from its schema. */
export type ChannelAttemptId = z.infer<typeof ChannelAttemptIdSchema>;

/**
 * Owns immutable notification authorization for either initial activation or
 * a fresh all-clear/reactivation transition. Lifecycle sends can never reuse
 * the original activation confirmation.
 */
export const NotificationAuthorizationSchema = z
  .union([ActivationAuthorizationSchema, LifecycleActionAuthorizationSchema])
  .readonly();

/** Immutable notification authorization inferred from its schema. */
export type NotificationAuthorization = z.infer<
  typeof NotificationAuthorizationSchema
>;

function addNotificationTargetingIssues(
  value: {
    readonly eventKind: EventKind;
    readonly templateMode: TemplateMode;
    readonly rosterPopulation: RosterPopulation;
    readonly purpose: NotificationPurpose;
  },
  context: z.RefinementCtx,
): void {
  if (
    !EventTargetingSchema.safeParse({
      kind: value.eventKind,
      templateMode: value.templateMode,
      rosterPopulation: value.rosterPopulation,
    }).success
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Notification targeting classification is incompatible.',
      path: ['rosterPopulation'],
    });
  }
}

function addChannelPlanIssues(
  value: {
    readonly eventKind: EventKind;
    readonly templateMode: TemplateMode;
    readonly rosterPopulation: RosterPopulation;
    readonly purpose: NotificationPurpose;
    readonly channels: readonly z.infer<
      typeof ChannelConsequencePreviewSchema
    >[];
  },
  context: z.RefinementCtx,
): void {
  const names = value.channels.map((channel) => channel.channel);
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: 'custom',
      message: 'Notification channel plan must be unique.',
      path: ['channels'],
    });
  }
  if (!names.includes('push') || !names.includes('email')) {
    context.addIssue({
      code: 'custom',
      message: 'Notification channel plan requires push and email.',
      path: ['channels'],
    });
  }
  value.channels.forEach((channel, index) => {
    if (
      channel.renderedMessage.eventKind !== value.eventKind ||
      channel.renderedMessage.templateMode !== value.templateMode ||
      channel.renderedMessage.purpose !== value.purpose
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Rendered channel plan classification must match intent.',
        path: ['channels', index, 'renderedMessage'],
      });
    }
    const expectedLabel =
      value.rosterPopulation === 'synthetic' ? 'mocked' : 'live-verified';
    if (channel.integrationStatus.label !== expectedLabel) {
      context.addIssue({
        code: 'custom',
        message:
          'Staff sends require live verification; synthetic sends require mocks.',
        path: ['channels', index, 'integrationStatus', 'label'],
      });
    }
  });
}

function addNotificationAuthorizationIssues(
  value: {
    readonly purpose: NotificationPurpose;
    readonly eventKind: EventKind;
    readonly templateMode: TemplateMode;
    readonly rosterPopulation: RosterPopulation;
    readonly requestId: string;
    readonly authorization: NotificationAuthorization;
  },
  context: z.RefinementCtx,
): void {
  const authorization = value.authorization;
  if (authorization.requestId !== value.requestId) {
    context.addIssue({
      code: 'custom',
      message: 'Notification authorization must bind the creating request.',
      path: ['authorization', 'requestId'],
    });
  }
  if (value.purpose === 'activation') {
    const expectedKind =
      value.rosterPopulation === 'synthetic'
        ? 'synthetic-training'
        : 'human-confirmed';
    if (authorization.kind !== expectedKind) {
      context.addIssue({
        code: 'custom',
        message:
          'Activation notification requires matching activation authorization.',
        path: ['authorization'],
      });
    }
    return;
  }
  const expectedKind =
    value.rosterPopulation === 'synthetic'
      ? 'synthetic-lifecycle'
      : 'human-confirmed-lifecycle';
  if (
    authorization.kind !== expectedKind ||
    !('purpose' in authorization) ||
    authorization.purpose !== value.purpose
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'Lifecycle notification requires fresh matching lifecycle authorization.',
      path: ['authorization'],
    });
    return;
  }
  if (
    authorization.targeting.kind !== value.eventKind ||
    authorization.targeting.templateMode !== value.templateMode ||
    authorization.targeting.rosterPopulation !== value.rosterPopulation
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Notification authorization targeting must match the send.',
      path: ['authorization', 'targeting'],
    });
  }
}

/**
 * Owns the immutable, transactionally recorded fan-out intent. It pins event,
 * type, roster, and audience versions and repeats classification before work
 * crosses the outbox boundary.
 */
export const NotificationIntentSchema = z
  .object({
    id: NotificationIntentIdSchema,
    eventId: EventIdSchema,
    eventKind: EventKindSchema,
    templateMode: TemplateModeSchema,
    purpose: NotificationPurposeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    rosterPopulation: RosterPopulationSchema,
    audienceConfig: AudienceConfigRefSchema,
    createdBy: ActorSchema,
    source: InvocationSourceSchema,
    requestId: UuidSchema,
    authorization: NotificationAuthorizationSchema,
    channels: z.array(ChannelConsequencePreviewSchema).min(2).max(3).readonly(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    addNotificationTargetingIssues(intent, context);
    addChannelPlanIssues(intent, context);
    addNotificationAuthorizationIssues(intent, context);
    if (intent.eventTypeVersion.templateMode !== intent.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Notification intent type mode must match its template mode.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
    if (
      intent.rosterPopulation === 'staff' &&
      intent.createdBy.kind !== 'human'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Every staff-targeting notification intent requires a human.',
        path: ['createdBy'],
      });
    }
    if (!isActorSourceCompatible(intent.createdBy, intent.source)) {
      context.addIssue({
        code: 'custom',
        message: 'Notification author and invocation source are incompatible.',
        path: ['source'],
      });
    }
  })
  .readonly();

/** Immutable fan-out intent inferred from its schema. */
export type NotificationIntent = z.infer<typeof NotificationIntentSchema>;

/**
 * Owns an immutable channel batch produced from one intent. Event type,
 * roster snapshot, classification, and population repeat across the worker
 * boundary so composite database keys can prove continuity.
 */
export const DispatchBatchSchema = z
  .object({
    id: DispatchBatchIdSchema,
    intentId: NotificationIntentIdSchema,
    eventId: EventIdSchema,
    eventKind: EventKindSchema,
    templateMode: TemplateModeSchema,
    purpose: NotificationPurposeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    rosterPopulation: RosterPopulationSchema,
    audienceConfig: AudienceConfigRefSchema,
    requestId: UuidSchema,
    authorization: NotificationAuthorizationSchema,
    channel: NotificationChannelSchema,
    renderedMessage: RenderedMessageSchema,
    integrationStatus: IntegrationStatusSchema,
    sequence: z.number().int().positive(),
    endpointCount: z.number().int().nonnegative().max(12_000),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((batch, context) => {
    addNotificationTargetingIssues(batch, context);
    addNotificationAuthorizationIssues(batch, context);
    if (batch.eventTypeVersion.templateMode !== batch.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatch type mode must match its template mode.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
    if (
      batch.renderedMessage.channel !== batch.channel ||
      batch.renderedMessage.eventKind !== batch.eventKind ||
      batch.renderedMessage.templateMode !== batch.templateMode ||
      batch.renderedMessage.purpose !== batch.purpose
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatch rendered payload must match batch classification.',
        path: ['renderedMessage'],
      });
    }
    if (
      !ChannelConsequencePreviewSchema.safeParse({
        channel: batch.channel,
        endpointCount: batch.endpointCount,
        renderedMessage: batch.renderedMessage,
        integrationStatus: batch.integrationStatus,
      }).success
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatch batch channel plan is internally inconsistent.',
        path: ['integrationStatus'],
      });
    }
    const expectedLabel =
      batch.rosterPopulation === 'synthetic' ? 'mocked' : 'live-verified';
    if (batch.integrationStatus.label !== expectedLabel) {
      context.addIssue({
        code: 'custom',
        message:
          'Dispatch integration truth must match staff or synthetic population.',
        path: ['integrationStatus', 'label'],
      });
    }
  })
  .readonly();

/** Immutable channel dispatch batch inferred from its schema. */
export type DispatchBatch = z.infer<typeof DispatchBatchSchema>;

/**
 * Owns one immutable attempt to hand a recipient endpoint to a provider.
 * Attempt numbers and repeated version/classification data support idempotent
 * processing; provider results append separate evidence.
 */
export const ChannelAttemptSchema = z
  .object({
    id: ChannelAttemptIdSchema,
    batchId: DispatchBatchIdSchema,
    intentId: NotificationIntentIdSchema,
    eventId: EventIdSchema,
    eventKind: EventKindSchema,
    templateMode: TemplateModeSchema,
    purpose: NotificationPurposeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    rosterPopulation: RosterPopulationSchema,
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    channel: NotificationChannelSchema,
    attemptNumber: z.number().int().positive(),
    attemptedAt: TimestampSchema,
  })
  .strict()
  .superRefine((attempt, context) => {
    addNotificationTargetingIssues(attempt, context);
    if (attempt.eventTypeVersion.templateMode !== attempt.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Attempt type mode must match its template mode.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
  })
  .readonly();

/** Immutable channel attempt inferred from its schema. */
export type ChannelAttempt = z.infer<typeof ChannelAttemptSchema>;

/**
 * Owns the persisted discriminator for intent-level versus attempt-level
 * append-only delivery evidence.
 */
export const DeliveryEvidenceSubjectKindSchema = z.enum(['intent', 'attempt']);

/** Delivery-evidence subject kind inferred from its schema. */
export type DeliveryEvidenceSubjectKind = z.infer<
  typeof DeliveryEvidenceSubjectKindSchema
>;

/**
 * Owns the subject for pre-attempt accepted/recorded facts. These states exist
 * before any provider attempt and therefore attach to the durable intent.
 */
export const IntentDeliverySubjectSchema = z
  .object({
    kind: z.literal('intent'),
    intentId: NotificationIntentIdSchema,
  })
  .strict()
  .readonly();

/** Intent-level delivery-evidence subject inferred from its schema. */
export type IntentDeliverySubject = z.infer<typeof IntentDeliverySubjectSchema>;

/**
 * Owns the subject for attempted and provider-result facts. These states attach
 * to one immutable channel attempt rather than retroactively fabricating it.
 */
export const AttemptDeliverySubjectSchema = z
  .object({
    kind: z.literal('attempt'),
    attemptId: ChannelAttemptIdSchema,
  })
  .strict()
  .readonly();

/** Attempt-level delivery-evidence subject inferred from its schema. */
export type AttemptDeliverySubject = z.infer<
  typeof AttemptDeliverySubjectSchema
>;

/**
 * Owns the intent-or-attempt evidence subject union. State validation below
 * guarantees each lifecycle fact appears at the level where it actually
 * becomes knowable.
 */
export const DeliveryEvidenceSubjectSchema = z
  .union([IntentDeliverySubjectSchema, AttemptDeliverySubjectSchema])
  .readonly();

/** Delivery-evidence subject inferred from its schema. */
export type DeliveryEvidenceSubject = z.infer<
  typeof DeliveryEvidenceSubjectSchema
>;

/**
 * Owns verifiable provider-delivery proof. It is present only when the
 * provider supplies a delivery-specific receipt; acceptance receipts do not
 * satisfy this contract.
 */
export const DeliveryProofSchema = z
  .object({
    kind: z.literal('provider-delivery-receipt'),
    provider: z.string().trim().min(1).max(100),
    receiptId: z.string().trim().min(1).max(500),
    deliveredAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Verifiable provider-delivery proof inferred from its schema. */
export type DeliveryProof = z.infer<typeof DeliveryProofSchema>;

/** Stable identifier for one append-only delivery evidence fact. */
export const DeliveryEvidenceIdSchema = UuidSchema;

/** Delivery-evidence identifier inferred from its schema. */
export type DeliveryEvidenceId = z.infer<typeof DeliveryEvidenceIdSchema>;

/**
 * Owns one append-only delivery fact. Accepted and recorded facts attach to an
 * intent; later facts attach to an attempt. Delivered requires matching proof,
 * provider acceptance remains distinct, and terminal uncertainty is explicit.
 */
export const DeliveryEvidenceSchema = z
  .object({
    id: DeliveryEvidenceIdSchema,
    subject: DeliveryEvidenceSubjectSchema,
    sequence: z.number().int().positive(),
    previousEvidenceId: DeliveryEvidenceIdSchema.nullable(),
    state: DeliveryTruthStateSchema,
    recordedAt: TimestampSchema,
    provider: z.string().trim().min(1).max(100).nullable(),
    providerReference: z.string().trim().min(1).max(500).nullable(),
    proof: DeliveryProofSchema.nullable(),
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
    diagnosticDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if ((evidence.sequence === 1) !== (evidence.previousEvidenceId === null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Only the first fact for a delivery subject may omit prior evidence.',
        path: ['previousEvidenceId'],
      });
    }
    if (evidence.previousEvidenceId === evidence.id) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery evidence cannot point to itself.',
        path: ['previousEvidenceId'],
      });
    }
    const isIntentState = ['accepted', 'recorded'].includes(evidence.state);
    if (isIntentState !== (evidence.subject.kind === 'intent')) {
      context.addIssue({
        code: 'custom',
        message:
          'Accepted/recorded facts belong to intents; later facts belong to attempts.',
        path: ['subject'],
      });
    }
    if (evidence.state === 'delivered' && evidence.proof === null) {
      context.addIssue({
        code: 'custom',
        message: 'Delivered state requires explicit provider delivery proof.',
        path: ['proof'],
      });
    }
    if (evidence.state !== 'delivered' && evidence.proof !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery proof may accompany only delivered state.',
        path: ['proof'],
      });
    }
    if (
      evidence.state === 'delivered' &&
      (evidence.provider === null || evidence.providerReference === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivered state requires provider reference evidence.',
        path: ['providerReference'],
      });
    }
    if (evidence.proof && evidence.provider !== evidence.proof.provider) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery proof provider must match the evidence provider.',
        path: ['proof', 'provider'],
      });
    }
    if (
      evidence.proof &&
      !isAtOrAfter(evidence.recordedAt, evidence.proof.deliveredAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery proof cannot postdate evidence recording.',
        path: ['proof', 'deliveredAt'],
      });
    }
    if (
      evidence.state === 'provider-accepted' &&
      (evidence.provider === null || evidence.providerReference === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provider acceptance requires provider reference evidence.',
        path: ['providerReference'],
      });
    }
    const requiresReasonCode = ['failed', 'expired', 'unknown'].includes(
      evidence.state,
    );
    if (requiresReasonCode !== (evidence.reasonCode !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Failed, expired, or unknown evidence requires exactly one safe reason code.',
        path: ['reasonCode'],
      });
    }
    if (evidence.diagnosticDigest !== null && evidence.reasonCode === null) {
      context.addIssue({
        code: 'custom',
        message: 'Diagnostic digests require a safe reason code.',
        path: ['diagnosticDigest'],
      });
    }
  })
  .readonly();

/** Append-only delivery fact inferred from its schema. */
export type DeliveryEvidence = z.infer<typeof DeliveryEvidenceSchema>;

const allowedDeliveryTransitions = new Set([
  'intent:accepted:recorded',
  'attempt:attempted:provider-accepted',
  'attempt:attempted:delivered',
  'attempt:attempted:failed',
  'attempt:attempted:expired',
  'attempt:attempted:unknown',
  'attempt:provider-accepted:delivered',
  'attempt:provider-accepted:failed',
  'attempt:provider-accepted:expired',
  'attempt:provider-accepted:unknown',
  'attempt:unknown:provider-accepted',
  'attempt:unknown:delivered',
  'attempt:unknown:failed',
]);

/**
 * Owns the canonical monotonic delivery transition policy. Late provider
 * proof may supersede `unknown`, while delivered, failed, and expired remain
 * terminal; writers append evidence and never rewrite an earlier state.
 */
export const DeliveryTruthTransitionSchema = z
  .object({
    subjectKind: DeliveryEvidenceSubjectKindSchema,
    from: DeliveryTruthStateSchema,
    to: DeliveryTruthStateSchema,
  })
  .strict()
  .superRefine((transition, context) => {
    if (
      !allowedDeliveryTransitions.has(
        `${transition.subjectKind}:${transition.from}:${transition.to}`,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery truth transition is not allowed.',
        path: ['to'],
      });
    }
  })
  .readonly();

/** Canonical delivery truth transition inferred from its schema. */
export type DeliveryTruthTransition = z.infer<
  typeof DeliveryTruthTransitionSchema
>;

/**
 * Owns the stable identifier for a retained transactional outbox record.
 * Published rows remain stored and are never deleted as a cleanup shortcut.
 */
export const OutboxIdSchema = UuidSchema;

/** Stable outbox identifier inferred from its schema. */
export type OutboxId = z.infer<typeof OutboxIdSchema>;

/**
 * Owns the dispatcher lifecycle vocabulary. `published` means durable SQS
 * handoff only; it never claims provider delivery or human receipt.
 */
export const OutboxStatusSchema = z.enum([
  'pending',
  'processing',
  'published',
  'failed',
]);

/** Transactional outbox lifecycle state inferred from its schema. */
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

/**
 * Owns the versioned, destination-free worker-boundary payload stored in the
 * outbox. Rendered copy may contain staff-visible event context, but workers
 * resolve contact destinations only from the pinned immutable roster.
 * Workers resolve recipients only through the pinned immutable intent and
 * roster snapshot; no contact destination appears in this message.
 */
export const NotificationOutboxMessageSchema = z
  .object({
    version: z.literal(1),
    outboxId: OutboxIdSchema,
    intentId: NotificationIntentIdSchema,
    eventId: EventIdSchema,
    eventKind: EventKindSchema,
    templateMode: TemplateModeSchema,
    purpose: NotificationPurposeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    rosterPopulation: RosterPopulationSchema,
    audienceConfig: AudienceConfigRefSchema,
    requestId: UuidSchema,
    authorization: NotificationAuthorizationSchema,
    channels: z.array(ChannelConsequencePreviewSchema).min(2).max(3).readonly(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((message, context) => {
    addNotificationTargetingIssues(message, context);
    addChannelPlanIssues(message, context);
    addNotificationAuthorizationIssues(message, context);
    if (message.eventTypeVersion.templateMode !== message.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Outbox type mode must match its template mode.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
  })
  .readonly();

/** Versioned destination-free outbox message inferred from its schema. */
export type NotificationOutboxMessage = z.infer<
  typeof NotificationOutboxMessageSchema
>;

/**
 * Owns one retained outbox record with claim/retry metadata. Only operational
 * dispatcher fields evolve; the nested message and classification are
 * immutable, and successful publication never means delivery.
 */
export const OutboxRecordSchema = z
  .object({
    id: OutboxIdSchema,
    message: NotificationOutboxMessageSchema,
    status: OutboxStatusSchema,
    attempts: z.number().int().nonnegative().max(100),
    availableAt: TimestampSchema,
    lockedUntil: TimestampSchema.nullable(),
    publishedAt: TimestampSchema.nullable(),
    failedAt: TimestampSchema.nullable(),
    lastErrorCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.id !== record.message.outboxId) {
      context.addIssue({
        code: 'custom',
        message: 'Outbox record and message IDs must match.',
        path: ['message', 'outboxId'],
      });
    }
    if (record.status === 'processing' && record.lockedUntil === null) {
      context.addIssue({
        code: 'custom',
        message: 'Processing outbox records require a claim expiry.',
        path: ['lockedUntil'],
      });
    }
    if (record.status !== 'processing' && record.lockedUntil !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Only processing outbox records may remain locked.',
        path: ['lockedUntil'],
      });
    }
    if ((record.status === 'published') !== (record.publishedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only published outbox records have a publication time.',
        path: ['publishedAt'],
      });
    }
    if ((record.status === 'failed') !== (record.failedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed outbox records have a failure time.',
        path: ['failedAt'],
      });
    }
    if (record.status === 'failed' && record.lastErrorCode === null) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal outbox failure requires a safe error code.',
        path: ['lastErrorCode'],
      });
    }
    for (const [field, timestamp] of [
      ['availableAt', record.availableAt],
      ['lockedUntil', record.lockedUntil],
      ['publishedAt', record.publishedAt],
      ['failedAt', record.failedAt],
    ] as const) {
      if (timestamp && !isAtOrAfter(timestamp, record.message.createdAt)) {
        context.addIssue({
          code: 'custom',
          message: 'Outbox operational time cannot precede message creation.',
          path: [field],
        });
      }
    }
  })
  .readonly();

/** Retained transactional outbox record inferred from its schema. */
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;

/** Owns a dispatcher request to claim and publish one retained outbox row. */
export const DispatchOutboxInputSchema = z
  .object({
    outboxId: OutboxIdSchema,
  })
  .strict()
  .readonly();

/** Outbox dispatch input inferred from its schema. */
export type DispatchOutboxInput = z.infer<typeof DispatchOutboxInputSchema>;

/**
 * Owns one durable outbox-dispatch result. `published` means queue handoff;
 * the immutable batches carry no claim of provider or human delivery.
 */
export const DispatchOutboxResultSchema = z
  .object({
    outboxRecord: OutboxRecordSchema,
    batches: z.array(DispatchBatchSchema).min(2).max(3).readonly(),
  })
  .strict()
  .superRefine((result, context) => {
    const message = result.outboxRecord.message;
    const channels = result.batches.map((batch) => batch.channel);
    const plannedChannels = message.channels.map((channel) => channel.channel);
    if (
      new Set(channels).size !== channels.length ||
      channels.length !== plannedChannels.length ||
      channels.some((channel) => !plannedChannels.includes(channel))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Outbox dispatch must produce exactly one batch for every planned channel.',
        path: ['batches'],
      });
    }
    const sequences = [...result.batches]
      .map((batch) => batch.sequence)
      .sort((left, right) => left - right);
    if (sequences.some((sequence, index) => sequence !== index + 1)) {
      context.addIssue({
        code: 'custom',
        message: 'Outbox dispatch batch sequences must be contiguous from one.',
        path: ['batches'],
      });
    }
    result.batches.forEach((batch, index) => {
      const plannedChannel = message.channels.find(
        (channel) => channel.channel === batch.channel,
      );
      if (
        batch.intentId !== message.intentId ||
        batch.eventId !== message.eventId ||
        batch.eventKind !== message.eventKind ||
        batch.templateMode !== message.templateMode ||
        batch.purpose !== message.purpose ||
        batch.eventTypeVersion.id !== message.eventTypeVersion.id ||
        batch.eventTypeVersion.templateMode !==
          message.eventTypeVersion.templateMode ||
        batch.rosterSnapshotId !== message.rosterSnapshotId ||
        batch.rosterPopulation !== message.rosterPopulation ||
        batch.audienceConfig.id !== message.audienceConfig.id ||
        batch.audienceConfig.version !== message.audienceConfig.version ||
        batch.requestId !== message.requestId ||
        JSON.stringify(batch.authorization) !==
          JSON.stringify(message.authorization) ||
        plannedChannel === undefined ||
        batch.endpointCount !== plannedChannel.endpointCount ||
        JSON.stringify(batch.renderedMessage) !==
          JSON.stringify(plannedChannel.renderedMessage) ||
        JSON.stringify(batch.integrationStatus) !==
          JSON.stringify(plannedChannel.integrationStatus)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Dispatch batches must exactly preserve outbox classification, authorization, audience, and channel plan truth.',
          path: ['batches', index],
        });
      }
    });
  })
  .readonly();

/** Durable outbox-dispatch result inferred from its schema. */
export type DispatchOutboxResult = z.infer<typeof DispatchOutboxResultSchema>;

/**
 * Owns validated provider or persistence facts submitted for append-only
 * delivery evidence. Sequence, previous-evidence link, ID, and record time
 * are derived by the server and cannot be supplied by a worker or provider.
 */
export const RecordDeliveryEvidenceInputSchema = z
  .object({
    subject: DeliveryEvidenceSubjectSchema,
    state: DeliveryTruthStateSchema,
    provider: z.string().trim().min(1).max(100).nullable(),
    providerReference: z.string().trim().min(1).max(500).nullable(),
    proof: DeliveryProofSchema.nullable(),
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
    diagnosticDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    const isIntentState = ['accepted', 'recorded'].includes(input.state);
    if (isIntentState !== (input.subject.kind === 'intent')) {
      context.addIssue({
        code: 'custom',
        message:
          'Accepted/recorded facts belong to intents; later facts belong to attempts.',
        path: ['subject'],
      });
    }
    if ((input.state === 'delivered') !== (input.proof !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only delivered evidence carries provider delivery proof.',
        path: ['proof'],
      });
    }
    if (
      ['provider-accepted', 'delivered'].includes(input.state) &&
      (input.provider === null || input.providerReference === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provider success evidence requires provider references.',
        path: ['providerReference'],
      });
    }
    if (input.proof && input.proof.provider !== input.provider) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery proof provider must match the evidence provider.',
        path: ['proof', 'provider'],
      });
    }
    if (
      ['failed', 'expired', 'unknown'].includes(input.state) !==
      (input.reasonCode !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Failed, expired, or unknown evidence requires a bounded safe reason.',
        path: ['reasonCode'],
      });
    }
    if (input.diagnosticDigest !== null && input.reasonCode === null) {
      context.addIssue({
        code: 'custom',
        message: 'Diagnostic digests require a safe reason code.',
        path: ['diagnosticDigest'],
      });
    }
  })
  .readonly();

/** Append-only delivery-evidence input inferred from its schema. */
export type RecordDeliveryEvidenceInput = z.infer<
  typeof RecordDeliveryEvidenceInputSchema
>;

/** Owns a bounded request to reconcile nonterminal delivery attempts. */
export const ReconcileDeliveryAttemptsInputSchema = z
  .object({
    intentId: NotificationIntentIdSchema.nullable(),
    limit: z.number().int().positive().max(500),
  })
  .strict()
  .readonly();

/** Delivery-attempt reconciliation input inferred from its schema. */
export type ReconcileDeliveryAttemptsInput = z.infer<
  typeof ReconcileDeliveryAttemptsInputSchema
>;

/** Owns append-only evidence produced by one bounded reconciliation pass. */
export const ReconcileDeliveryAttemptsResultSchema = z
  .object({
    examinedAttemptCount: z.number().int().nonnegative().max(500),
    appendedEvidence: z.array(DeliveryEvidenceSchema).max(500).readonly(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.appendedEvidence.length > result.examinedAttemptCount) {
      context.addIssue({
        code: 'custom',
        message: 'Reconciliation cannot append more facts than attempts read.',
        path: ['appendedEvidence'],
      });
    }
  })
  .readonly();

/** Delivery-attempt reconciliation result inferred from its schema. */
export type ReconcileDeliveryAttemptsResult = z.infer<
  typeof ReconcileDeliveryAttemptsResultSchema
>;

/** Canonical SMS endpoint lifecycle reasons carried by append-only facts. */
export const SMS_LIFECYCLE_PROVIDER = 'aws-eum-sms' as const;
export const SMS_OPT_OUT_REASON_CODE = 'SMS_OPTED_OUT' as const;
export const SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE =
  'SMS_OPT_IN_PROVIDER_VERIFIED' as const;

/**
 * Trusted, transport-derived context for the system-only SMS lifecycle
 * capabilities. The discriminated variants prevent a worker, schedule, or
 * provider webhook from claiming another producer's service identity.
 */
export const SmsLifecycleCapabilityContextSchema = z
  .discriminatedUnion('source', [
    z
      .object({
        actor: z
          .object({
            kind: z.literal('system'),
            serviceId: z.literal('sms-worker'),
          })
          .strict()
          .readonly(),
        source: z.literal('worker'),
        transport: z.literal('sqs'),
        requestId: UuidSchema,
        authenticated: z.literal(true),
      })
      .strict()
      .readonly(),
    z
      .object({
        actor: z
          .object({
            kind: z.literal('system'),
            serviceId: z.literal('sms-opt-out-reconciler'),
          })
          .strict()
          .readonly(),
        source: z.literal('scheduled-job'),
        transport: z.literal('scheduled-execution'),
        requestId: UuidSchema,
        authenticated: z.literal(true),
      })
      .strict()
      .readonly(),
    z
      .object({
        actor: z
          .object({
            kind: z.literal('system'),
            serviceId: z.literal('sms-opt-in-webhook'),
          })
          .strict()
          .readonly(),
        source: z.literal('webhook'),
        transport: z.literal('provider-webhook'),
        requestId: UuidSchema,
        authenticated: z.literal(true),
      })
      .strict()
      .readonly(),
  ])
  .readonly();

/** Trusted SMS lifecycle capability context inferred from its schema. */
export type SmsLifecycleCapabilityContext = z.infer<
  typeof SmsLifecycleCapabilityContextSchema
>;

const SmsLifecycleProviderReferenceSchema = z.string().trim().min(1).max(500);
const EndpointLifecycleReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_]+$/u);
const NonProviderEndpointLifecycleReasonSchema =
  EndpointLifecycleReasonSchema.refine(
    (reasonCode) =>
      reasonCode !== SMS_OPT_OUT_REASON_CODE &&
      reasonCode !== SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
    'SMS lifecycle reasons require exact provider provenance.',
  );

function addProviderOccurrenceIssues(
  record: Readonly<{
    providerOccurredAt: string;
    recordedAt: string;
  }>,
  context: z.RefinementCtx,
): void {
  if (
    Date.parse(record.providerOccurredAt) >
    Date.parse(record.recordedAt) + 300_000
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Provider occurrence time cannot be materially in the future.',
      path: ['providerOccurredAt'],
    });
  }
}

const EndpointStatusIdentityShape = {
  rosterSnapshotId: RosterSnapshotIdSchema,
  recipientId: RecipientIdSchema,
  endpointId: EndpointIdSchema,
} as const;

const NonProviderEndpointStatusShape = {
  ...EndpointStatusIdentityShape,
  status: z.enum(['invalid', 'disabled']),
  reasonCode: NonProviderEndpointLifecycleReasonSchema,
  provider: z.never().optional(),
  providerReference: z.never().optional(),
  providerOccurredAt: z.never().optional(),
} as const;

const SmsEndpointLifecycleProviderShape = {
  provider: z.literal(SMS_LIFECYCLE_PROVIDER),
  providerReference: SmsLifecycleProviderReferenceSchema,
  providerOccurredAt: TimestampSchema,
} as const;

const ProviderVerifiedSmsOptInShape = {
  ...EndpointStatusIdentityShape,
  status: z.literal('active'),
  reasonCode: z.literal(SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE),
  ...SmsEndpointLifecycleProviderShape,
} as const;

const ManagedSmsOptOutShape = {
  ...EndpointStatusIdentityShape,
  status: z.literal('disabled'),
  reasonCode: z.literal(SMS_OPT_OUT_REASON_CODE),
  ...SmsEndpointLifecycleProviderShape,
} as const;

/**
 * Owns a request to append endpoint lifecycle evidence. It references the
 * pinned endpoint rather than accepting a contact destination from a provider.
 * `active` is an append-only supersession fact; it never mutates or erases a
 * prior invalid/disabled fact.
 */
export const RecordEndpointStatusInputSchema = z
  .union([
    z.object(NonProviderEndpointStatusShape).strict().readonly(),
    z.object(ProviderVerifiedSmsOptInShape).strict().readonly(),
    z.object(ManagedSmsOptOutShape).strict().readonly(),
  ])
  .readonly();

/** Endpoint-status evidence input inferred from its schema. */
export type RecordEndpointStatusInput = z.infer<
  typeof RecordEndpointStatusInputSchema
>;

/** Owns one append-only endpoint lifecycle fact. */
export const EndpointStatusRecordSchema = z
  .union([
    z
      .object({
        id: UuidSchema,
        ...NonProviderEndpointStatusShape,
        recordedAt: TimestampSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        id: UuidSchema,
        ...ProviderVerifiedSmsOptInShape,
        recordedAt: TimestampSchema,
      })
      .strict()
      .superRefine(addProviderOccurrenceIssues)
      .readonly(),
    z
      .object({
        id: UuidSchema,
        ...ManagedSmsOptOutShape,
        recordedAt: TimestampSchema,
      })
      .strict()
      .superRefine(addProviderOccurrenceIssues)
      .readonly(),
  ])
  .readonly();

/** Append-only endpoint lifecycle fact inferred from its schema. */
export type EndpointStatusRecord = z.infer<typeof EndpointStatusRecordSchema>;

/**
 * Owns an SMS opt-out callback after the provider adapter has resolved a
 * destination to a retained endpoint. Raw phone numbers never enter this
 * capability input or the resulting append-only fact.
 */
export const RecordSmsOptOutInputSchema = z
  .object({
    rosterSnapshotId: RosterSnapshotIdSchema,
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    provider: z.string().trim().min(1).max(100),
    providerReference: z.string().trim().min(1).max(500),
    providerOccurredAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** SMS opt-out input inferred from its schema. */
export type RecordSmsOptOutInput = z.infer<typeof RecordSmsOptOutInputSchema>;

/** Owns one retained SMS opt-out fact without copying a phone number. */
export const SmsOptOutRecordSchema = z
  .object({
    id: UuidSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    provider: z.string().trim().min(1).max(100),
    providerReference: z.string().trim().min(1).max(500),
    providerOccurredAt: TimestampSchema,
    recordedAt: TimestampSchema,
  })
  .strict()
  .superRefine(addProviderOccurrenceIssues)
  .readonly();

/** Retained SMS opt-out fact inferred from its schema. */
export type SmsOptOutRecord = z.infer<typeof SmsOptOutRecordSchema>;

/** Owns a status read for one immutable notification intent. */
export const GetNotificationStatusInputSchema = z
  .object({
    intentId: NotificationIntentIdSchema,
  })
  .strict()
  .readonly();

/** Notification-status read input inferred from its schema. */
export type GetNotificationStatusInput = z.infer<
  typeof GetNotificationStatusInputSchema
>;

/** Owns an evidence-honest count for one delivery truth state. */
export const DeliveryStateCountSchema = z
  .object({
    state: AttemptDeliveryTruthStateSchema,
    count: z.number().int().nonnegative().max(12_000),
  })
  .strict()
  .readonly();

/** Evidence-honest delivery-state count inferred from its schema. */
export type DeliveryStateCount = z.infer<typeof DeliveryStateCountSchema>;

/**
 * Owns a destination-free notification status projection. Provider
 * acceptance and delivered counts remain separate and unknown is explicit.
 */
export const NotificationStatusSchema = z
  .object({
    intent: NotificationIntentSchema,
    batches: z.array(DispatchBatchSchema).max(3).readonly(),
    stateCounts: z.array(DeliveryStateCountSchema).max(8).readonly(),
    generatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (
      new Set(status.stateCounts.map((count) => count.state)).size !==
      status.stateCounts.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Notification state-count rows must be unique.',
        path: ['stateCounts'],
      });
    }
    const totalPlannedEndpoints = status.intent.channels.reduce(
      (total, channel) => total + channel.endpointCount,
      0,
    );
    const countedEndpoints = status.stateCounts.reduce(
      (total, row) => total + row.count,
      0,
    );
    if (countedEndpoints > totalPlannedEndpoints) {
      context.addIssue({
        code: 'custom',
        message:
          'Latest delivery-state counts cannot exceed planned recipient endpoints.',
        path: ['stateCounts'],
      });
    }
    const batchChannels = status.batches.map((batch) => batch.channel);
    if (new Set(batchChannels).size !== batchChannels.length) {
      context.addIssue({
        code: 'custom',
        message: 'Notification status batches must be unique by channel.',
        path: ['batches'],
      });
    }
    status.batches.forEach((batch, index) => {
      const plannedChannelIndex = status.intent.channels.findIndex(
        (channel) => channel.channel === batch.channel,
      );
      const plannedChannel = status.intent.channels[plannedChannelIndex];
      if (
        batch.intentId !== status.intent.id ||
        batch.eventId !== status.intent.eventId ||
        batch.eventKind !== status.intent.eventKind ||
        batch.templateMode !== status.intent.templateMode ||
        batch.purpose !== status.intent.purpose ||
        batch.eventTypeVersion.id !== status.intent.eventTypeVersion.id ||
        batch.eventTypeVersion.templateMode !==
          status.intent.eventTypeVersion.templateMode ||
        batch.rosterSnapshotId !== status.intent.rosterSnapshotId ||
        batch.rosterPopulation !== status.intent.rosterPopulation ||
        batch.audienceConfig.id !== status.intent.audienceConfig.id ||
        batch.audienceConfig.version !== status.intent.audienceConfig.version ||
        batch.requestId !== status.intent.requestId ||
        JSON.stringify(batch.authorization) !==
          JSON.stringify(status.intent.authorization) ||
        plannedChannel === undefined ||
        batch.sequence !== plannedChannelIndex + 1 ||
        batch.endpointCount !== plannedChannel.endpointCount ||
        JSON.stringify(batch.renderedMessage) !==
          JSON.stringify(plannedChannel.renderedMessage) ||
        JSON.stringify(batch.integrationStatus) !==
          JSON.stringify(plannedChannel.integrationStatus) ||
        !isAtOrAfter(batch.createdAt, status.intent.createdAt)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Notification status batches must exactly preserve their intent and planned channel truth.',
          path: ['batches', index],
        });
      }
    });
  })
  .readonly();

/** Destination-free notification status inferred from its schema. */
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;
