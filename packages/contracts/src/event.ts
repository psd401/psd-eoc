import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import {
  ActorSchema,
  HumanConfirmationIdSchema,
  IdempotencyKeySchema,
  InvocationSourceSchema,
  isActorSourceCompatible,
  type Actor,
} from './capability';
import { FacilityIdSchema } from './facility';
import {
  ChannelConsequencePreviewSchema,
  EventKindSchema,
  EventTypeVersionRefSchema,
  LifecycleNotificationPurposeSchema,
  TemplateModeSchema,
  type EventKind,
  type TemplateMode,
} from './event-type';
import {
  RosterPopulationSchema,
  RosterSnapshotIdSchema,
  type RosterPopulation,
} from './roster';
import { HumanOnlyActionIdSchema } from './human-only';
import {
  isAtOrAfter,
  TimestampSchema,
  UuidSchema,
  VersionSchema,
} from './shared';

export { EventKindSchema, type EventKind } from './event-type';

/**
 * Owns the append-only lifecycle states used by event capabilities and the
 * database state machine. Reopening creates a correction event rather than
 * rewriting a closed event.
 */
export const EventStatusSchema = z.enum([
  'draft',
  'active',
  'all-clear',
  'closed',
]);

/** Event lifecycle state inferred from its schema. */
export type EventStatus = z.infer<typeof EventStatusSchema>;

/**
 * Owns the only valid kind-and-template-mode pairs. No boolean aliases exist,
 * and tests deliberately share drill rendering rather than real rendering.
 */
export const EventClassificationSchema = z
  .union([
    z
      .object({
        kind: z.literal('incident'),
        templateMode: z.literal('real'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('drill'),
        templateMode: z.literal('drill'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('test'),
        templateMode: z.literal('drill'),
      })
      .strict(),
  ])
  .readonly();

/** Valid event classification inferred from its schema. */
export type EventClassification = z.infer<typeof EventClassificationSchema>;

/**
 * Visible, non-color-only treatment for each immutable classification. These
 * tokens are shared by web, mobile, records, exports, and delivery tests so a
 * surface cannot silently invent different real-versus-training language.
 */
export interface EventClassificationPresentation {
  readonly kind: EventKind;
  readonly templateMode: TemplateMode;
  readonly label: string;
  readonly explanation: string;
  readonly icon: Readonly<{ name: string; glyph: string }>;
  readonly colors: Readonly<{
    pageBackground: string;
    surface: string;
    textPrimary: string;
    textMuted: string;
    bannerBackground: string;
    onBanner: string;
    border: string;
  }>;
}

const REAL_CLASSIFICATION_COLORS = Object.freeze({
  pageBackground: '#FFF7F7',
  surface: '#FFFFFF',
  textPrimary: '#2B0B0E',
  textMuted: '#6F3137',
  bannerBackground: '#7A1020',
  onBanner: '#FFFFFF',
  border: '#B42332',
});

const TRAINING_CLASSIFICATION_COLORS = Object.freeze({
  pageBackground: '#F0F9FF',
  surface: '#FFFFFF',
  textPrimary: '#082F49',
  textMuted: '#334E68',
  bannerBackground: '#075985',
  onBanner: '#FFFFFF',
  border: '#0369A1',
});

const TEST_CLASSIFICATION_COLORS = Object.freeze({
  pageBackground: '#FFFBEB',
  surface: '#FFFFFF',
  textPrimary: '#3B2500',
  textMuted: '#765A00',
  bannerBackground: '#765A00',
  onBanner: '#FFFFFF',
  border: '#A16207',
});

export const EVENT_CLASSIFICATION_PRESENTATIONS = Object.freeze({
  incident: Object.freeze({
    kind: 'incident',
    templateMode: 'real',
    label: 'REAL INCIDENT',
    explanation:
      'This is a real incident. Staff notifications are not a drill.',
    icon: Object.freeze({ name: 'warning', glyph: '!' }),
    colors: REAL_CLASSIFICATION_COLORS,
  }),
  drill: Object.freeze({
    kind: 'drill',
    templateMode: 'drill',
    label: 'DRILL — TRAINING ONLY',
    explanation: 'This is a drill for training. It is not a real incident.',
    icon: Object.freeze({ name: 'practice-pencil', glyph: '✎' }),
    colors: TRAINING_CLASSIFICATION_COLORS,
  }),
  test: Object.freeze({
    kind: 'test',
    templateMode: 'drill',
    label: 'TEST — NOT A REAL INCIDENT',
    explanation:
      'This is a synthetic delivery test. It is not a real incident.',
    icon: Object.freeze({ name: 'synthetic-test', glyph: '◇' }),
    colors: TEST_CLASSIFICATION_COLORS,
  }),
} as const satisfies Readonly<
  Record<EventKind, EventClassificationPresentation>
>);

/** Exact visible label union used by export renderers and drift tests. */
export type EventClassificationLabel =
  (typeof EVENT_CLASSIFICATION_PRESENTATIONS)[EventKind]['label'];

/** Returns the canonical visible treatment after validating kind and mode. */
export function getEventClassificationPresentation(
  classificationValue: Readonly<{
    kind: EventKind;
    templateMode: TemplateMode;
  }>,
): EventClassificationPresentation {
  const classification = EventClassificationSchema.parse({
    kind: classificationValue.kind,
    templateMode: classificationValue.templateMode,
  });
  return EVENT_CLASSIFICATION_PRESENTATIONS[classification.kind];
}

/**
 * Owns every valid event, template, and roster-population triple. Staff
 * incidents and drills use live staff rosters; agent-exercisable drills and
 * tests use provably unroutable synthetic rosters.
 */
export const EventTargetingSchema = z
  .union([
    z
      .object({
        kind: z.literal('incident'),
        templateMode: z.literal('real'),
        rosterPopulation: z.literal('staff'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('drill'),
        templateMode: z.literal('drill'),
        rosterPopulation: z.literal('staff'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('drill'),
        templateMode: z.literal('drill'),
        rosterPopulation: z.literal('synthetic'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('test'),
        templateMode: z.literal('drill'),
        rosterPopulation: z.literal('synthetic'),
      })
      .strict(),
  ])
  .readonly();

/** Valid event targeting triple inferred from its schema. */
export type EventTargeting = z.infer<typeof EventTargetingSchema>;

/**
 * Owns the stable identifier for an operational event. Corrections reference
 * earlier events by ID while preserving both records.
 */
export const EventIdSchema = UuidSchema;

/** Stable event identifier inferred from its schema. */
export type EventId = z.infer<typeof EventIdSchema>;

/** Maximum lifetime, in seconds, of a server-issued activation preview. */
export const ACTIVATION_PREVIEW_MAX_AGE_SECONDS = 15 * 60;

/** Stable identifier for a short-lived, server-issued activation preview. */
export const ActivationPreviewIdSchema = UuidSchema;

/** Stable activation-preview identifier inferred from its schema. */
export type ActivationPreviewId = z.infer<typeof ActivationPreviewIdSchema>;

/** Stable reference to one immutable, approved canary target-set version. */
export const DeliveryTestTargetSetRefSchema = z
  .object({
    id: UuidSchema,
    version: VersionSchema,
  })
  .strict()
  .readonly();

/** Delivery-test target-set reference inferred from its schema. */
export type DeliveryTestTargetSetRef = z.infer<
  typeof DeliveryTestTargetSetRefSchema
>;

/**
 * Owns the destination-free canary-selection provenance repeated from the
 * activation preview through notification, outbox, batch, and attempt truth.
 */
export const DeliveryTestNotificationMetadataSchema = z
  .object({
    purpose: z.literal('monthly-live-delivery-test'),
    targetSet: DeliveryTestTargetSetRefSchema,
    endpointReferenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .readonly();

/** Delivery-test notification provenance inferred from its schema. */
export type DeliveryTestNotificationMetadata = z.infer<
  typeof DeliveryTestNotificationMetadataSchema
>;

/** Stable identifier for an agent- or human-prepared activation. */
export const PreparedActivationIdSchema = UuidSchema;

/** Stable prepared-activation identifier inferred from its schema. */
export type PreparedActivationId = z.infer<typeof PreparedActivationIdSchema>;

/**
 * Owns immutable activation authorization provenance. Staff-targeting events
 * pin the exact preview, optional prepared record, confirmation, digest, and
 * request; synthetic training pins its preview and request without pretending
 * a human confirmation occurred.
 */
export const ActivationAuthorizationSchema = z
  .union([
    z
      .object({
        kind: z.literal('human-confirmed'),
        activationPreviewId: ActivationPreviewIdSchema,
        preparedActivationId: PreparedActivationIdSchema.nullable(),
        confirmationId: HumanConfirmationIdSchema,
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        requestId: UuidSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('synthetic-training'),
        activationPreviewId: ActivationPreviewIdSchema,
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        requestId: UuidSchema,
      })
      .strict(),
  ])
  .readonly();

/** Immutable event-activation authorization inferred from its schema. */
export type ActivationAuthorization = z.infer<
  typeof ActivationAuthorizationSchema
>;

/** Stable identifier for a short-lived all-clear/reactivation preview. */
export const LifecycleConsequencePreviewIdSchema = UuidSchema;

/** Lifecycle consequence-preview identifier inferred from its schema. */
export type LifecycleConsequencePreviewId = z.infer<
  typeof LifecycleConsequencePreviewIdSchema
>;

/**
 * Owns fresh notification authorization for all-clear and reactivation.
 * Human variants pin the exact protected-action set confirmed; synthetic
 * variants retain preview/digest provenance without claiming confirmation.
 */
export const LifecycleActionAuthorizationSchema = z
  .union([
    z
      .object({
        kind: z.literal('human-confirmed-lifecycle'),
        purpose: LifecycleNotificationPurposeSchema,
        targeting: EventTargetingSchema,
        lifecyclePreviewId: LifecycleConsequencePreviewIdSchema,
        transitionId: UuidSchema,
        actionIds: z
          .array(HumanOnlyActionIdSchema)
          .min(1)
          .max(4)
          .refine((ids) => new Set(ids).size === ids.length, {
            message: 'Lifecycle authorization action IDs must be unique.',
          })
          .readonly(),
        confirmationId: HumanConfirmationIdSchema,
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        requestId: UuidSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('synthetic-lifecycle'),
        purpose: LifecycleNotificationPurposeSchema,
        targeting: EventTargetingSchema,
        lifecyclePreviewId: LifecycleConsequencePreviewIdSchema,
        transitionId: UuidSchema,
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        requestId: UuidSchema,
      })
      .strict(),
  ])
  .superRefine((authorization, context) => {
    const isStaff = authorization.targeting.rosterPopulation === 'staff';
    if (isStaff !== (authorization.kind === 'human-confirmed-lifecycle')) {
      context.addIssue({
        code: 'custom',
        message:
          'Staff lifecycle notifications require human authorization; synthetic notifications cannot claim it.',
        path: ['kind'],
      });
    }
    if (authorization.kind === 'human-confirmed-lifecycle') {
      const expectedActionIds = (() => {
        if (authorization.purpose === 'all-clear') {
          return ['all-clear', 'send-real-notification'] as const;
        }
        return authorization.targeting.kind === 'incident'
          ? (['start-real-incident', 'send-real-notification'] as const)
          : (['send-real-notification'] as const);
      })();
      const actual = [...authorization.actionIds].sort();
      const expected = [...expectedActionIds].sort();
      if (
        actual.length !== expected.length ||
        actual.some((actionId, index) => actionId !== expected[index])
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Lifecycle authorization must bind the exact protected-action set.',
          path: ['actionIds'],
        });
      }
    }
  })
  .readonly();

/** Fresh all-clear/reactivation authorization inferred from its schema. */
export type LifecycleActionAuthorization = z.infer<
  typeof LifecycleActionAuthorizationSchema
>;

function addClassificationIssues(
  value: {
    readonly kind: EventKind;
    readonly templateMode: TemplateMode;
    readonly rosterPopulation: RosterPopulation | null;
  },
  context: z.RefinementCtx,
): void {
  if (
    !EventClassificationSchema.safeParse({
      kind: value.kind,
      templateMode: value.templateMode,
    }).success
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Event kind and template mode are incompatible.',
      path: ['templateMode'],
    });
  }
  if (
    value.rosterPopulation !== null &&
    !EventTargetingSchema.safeParse({
      kind: value.kind,
      templateMode: value.templateMode,
      rosterPopulation: value.rosterPopulation,
    }).success
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Event classification and roster population are incompatible.',
      path: ['rosterPopulation'],
    });
  }
}

/**
 * Owns the immutable identity and current append-only-derived lifecycle view
 * of an event. Activated events pin roster and event-type versions; real/drill
 * classification is repeated and validated at every boundary.
 */
export const EventSchema = z
  .object({
    id: EventIdSchema,
    facilityId: FacilityIdSchema,
    kind: EventKindSchema,
    templateMode: TemplateModeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    status: EventStatusSchema,
    rosterSnapshotId: RosterSnapshotIdSchema.nullable(),
    rosterPopulation: RosterPopulationSchema.nullable(),
    createdBy: ActorSchema,
    createdAt: TimestampSchema,
    activatedAt: TimestampSchema.nullable(),
    allClearAt: TimestampSchema.nullable(),
    reactivatedAt: TimestampSchema.nullable(),
    closedAt: TimestampSchema.nullable(),
    correctionOfEventId: EventIdSchema.nullable(),
    correctionReason: z.string().trim().min(1).max(1_000).nullable(),
    activationAuthorization: ActivationAuthorizationSchema.nullable(),
  })
  .strict()
  .superRefine((event, context) => {
    addClassificationIssues(event, context);
    if (event.eventTypeVersion.templateMode !== event.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Pinned event-type version mode must match the event.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
    if (
      event.kind === 'incident' &&
      event.status !== 'draft' &&
      event.createdBy.kind !== 'human'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An incident event requires a human activator; agents prepare a separate activation record.',
        path: ['createdBy'],
      });
    }
    if (
      event.kind === 'drill' &&
      event.rosterPopulation === 'staff' &&
      event.createdBy.kind !== 'human'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A staff-targeting drill requires a human activator.',
        path: ['createdBy'],
      });
    }

    const isDraft = event.status === 'draft';
    if (isDraft) {
      if (event.rosterSnapshotId !== null || event.rosterPopulation !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Draft events do not pin a roster until activation.',
          path: ['rosterSnapshotId'],
        });
      }
      if (
        event.activatedAt !== null ||
        event.allClearAt !== null ||
        event.reactivatedAt !== null ||
        event.closedAt !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Draft events cannot carry lifecycle completion times.',
          path: ['activatedAt'],
        });
      }
      if (event.activationAuthorization !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Draft events cannot carry activation authorization.',
          path: ['activationAuthorization'],
        });
      }
    } else {
      if (event.rosterSnapshotId === null || event.rosterPopulation === null) {
        context.addIssue({
          code: 'custom',
          message:
            'Activated events must pin a roster snapshot and population.',
          path: ['rosterSnapshotId'],
        });
      }
      if (event.activatedAt === null) {
        context.addIssue({
          code: 'custom',
          message: 'Non-draft events require an activation time.',
          path: ['activatedAt'],
        });
      }
      if (event.activationAuthorization === null) {
        context.addIssue({
          code: 'custom',
          message: 'Activated events require immutable authorization evidence.',
          path: ['activationAuthorization'],
        });
      } else if (
        event.rosterPopulation === 'staff' &&
        event.activationAuthorization.kind !== 'human-confirmed'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Staff activation requires human-confirmed authorization.',
          path: ['activationAuthorization'],
        });
      } else if (
        event.rosterPopulation === 'synthetic' &&
        event.activationAuthorization.kind !== 'synthetic-training'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Synthetic training cannot claim human activation evidence.',
          path: ['activationAuthorization'],
        });
      }
    }

    if (event.status === 'active') {
      const isInitialActivation =
        event.allClearAt === null && event.reactivatedAt === null;
      const isReactivation =
        event.allClearAt !== null && event.reactivatedAt !== null;
      if (
        (!isInitialActivation && !isReactivation) ||
        event.closedAt !== null
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Active events carry either no prior all-clear or a complete reactivation pair, and cannot be closed.',
          path: ['reactivatedAt'],
        });
      }
    }
    if (event.status === 'all-clear') {
      if (event.allClearAt === null || event.closedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'All-clear events require only an all-clear time.',
          path: ['allClearAt'],
        });
      }
    }
    if (event.status === 'closed') {
      if (event.allClearAt === null || event.closedAt === null) {
        context.addIssue({
          code: 'custom',
          message: 'Closed events require all-clear and close times.',
          path: ['closedAt'],
        });
      }
    }
    if (event.reactivatedAt !== null && event.allClearAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'Reactivation requires retained all-clear history.',
        path: ['allClearAt'],
      });
    }

    const lifecycleTimes = (
      event.status === 'active' && event.reactivatedAt !== null
        ? [event.activatedAt, event.allClearAt, event.reactivatedAt]
        : [
            event.activatedAt,
            event.reactivatedAt,
            event.allClearAt,
            event.closedAt,
          ]
    ).filter((value): value is string => value !== null);
    let previous = event.createdAt;
    lifecycleTimes.forEach((time) => {
      if (!isAtOrAfter(time, previous)) {
        context.addIssue({
          code: 'custom',
          message: 'Event lifecycle times must be chronological.',
          path: ['status'],
        });
      }
      previous = time;
    });

    const hasCorrectionSource = event.correctionOfEventId !== null;
    const hasCorrectionReason = event.correctionReason !== null;
    if (hasCorrectionSource !== hasCorrectionReason) {
      context.addIssue({
        code: 'custom',
        message: 'Correction source and reason must appear together.',
        path: ['correctionOfEventId'],
      });
    }
    if (event.correctionOfEventId === event.id) {
      context.addIssue({
        code: 'custom',
        message: 'An event cannot correct itself.',
        path: ['correctionOfEventId'],
      });
    }
  })
  .readonly();

/** Reconstructable operational event view inferred from its schema. */
export type Event = z.infer<typeof EventSchema>;

/**
 * Owns the explicit join-existing choice shown when active events already
 * exist at a site. The subsequent mutation is a join, never a start request
 * carrying contradictory intent.
 */
export const JoinExistingDecisionSchema = z
  .object({
    decision: z.literal('join-existing'),
    eventId: EventIdSchema,
  })
  .strict()
  .readonly();

/** Explicit join-existing choice inferred from its schema. */
export type JoinExistingDecision = z.infer<typeof JoinExistingDecisionSchema>;

/**
 * Owns the explicit start-new choice after active events are displayed. The
 * seen IDs are retained as decision evidence; no time-window deduplication
 * prevents legitimate concurrent events.
 */
export const StartNewDecisionSchema = z
  .object({
    decision: z.literal('start-new'),
    activeEventIdsSeen: z
      .array(EventIdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Active event IDs must be unique.',
      })
      .readonly(),
  })
  .strict()
  .readonly();

/** Explicit start-new choice inferred from its schema. */
export type StartNewDecision = z.infer<typeof StartNewDecisionSchema>;

/**
 * Owns the mutually exclusive join-or-start-new decision returned by the
 * active-event chooser. Mutation inputs accept only their matching variant.
 */
export const JoinOrStartDecisionSchema = z
  .union([JoinExistingDecisionSchema, StartNewDecisionSchema])
  .readonly();

/** Explicit join-or-start-new choice inferred from its schema. */
export type JoinOrStartDecision = z.infer<typeof JoinOrStartDecisionSchema>;

/**
 * Owns the non-mutating selection used to create a server-bound activation
 * preview. The server resolves the latest roster version; the
 * client cannot choose those persistence IDs directly.
 */
export const CreateActivationPreviewInputSchema = z
  .object({
    facilityId: FacilityIdSchema,
    kind: EventKindSchema,
    templateMode: TemplateModeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    rosterPopulation: RosterPopulationSchema,
  })
  .strict()
  .superRefine((input, context) => {
    addClassificationIssues(input, context);
    if (input.eventTypeVersion.templateMode !== input.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Pinned event-type version mode must match activation mode.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
  })
  .readonly();

/** Non-mutating activation-preview selection inferred from its schema. */
export type CreateActivationPreviewInput = z.infer<
  typeof CreateActivationPreviewInputSchema
>;

/**
 * Owns a server-issued consequence preview that pins the latest roster,
 * event-type version, recipient count, and active-event set. The
 * digest is what a human confirmation signs; stale previews fail closed.
 */
const MultiChannelActivationPreviewPlanSchema = z
  .array(ChannelConsequencePreviewSchema)
  .min(2)
  .max(3)
  .readonly();

const ControlledEmailCanaryActivationPlanSchema = z
  .tuple([ChannelConsequencePreviewSchema])
  .superRefine(([channel], context) => {
    if (channel.channel !== 'email' || channel.endpointCount !== 1) {
      context.addIssue({
        code: 'custom',
        message:
          'A controlled email canary consequence must contain exactly one email endpoint.',
        path: [0],
      });
    }
  })
  .readonly();

export const ActivationPreviewSchema = z
  .object({
    id: ActivationPreviewIdSchema,
    facilityId: FacilityIdSchema,
    kind: EventKindSchema,
    templateMode: TemplateModeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    rosterPopulation: RosterPopulationSchema,
    recipientCount: z.number().int().nonnegative().max(1_200),
    channels: z.union([
      MultiChannelActivationPreviewPlanSchema,
      ControlledEmailCanaryActivationPlanSchema,
    ]),
    sendReadiness: z.enum(['ready', 'blocked']),
    blockingReasonCodes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Z0-9_]+$/u),
      )
      .max(20)
      .readonly(),
    activeEventIds: z
      .array(EventIdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Preview active-event IDs must be unique.',
      })
      .readonly(),
    deliveryTest: DeliveryTestNotificationMetadataSchema.nullish(),
    consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    addClassificationIssues(preview, context);
    if (preview.eventTypeVersion.templateMode !== preview.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Preview event-type version mode must match activation mode.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
    if (
      preview.deliveryTest != null &&
      (preview.kind !== 'drill' ||
        preview.templateMode !== 'drill' ||
        preview.rosterPopulation !== 'staff')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Monthly live delivery tests must remain drill-classified and target the approved staff routing class.',
        path: ['deliveryTest'],
      });
    }
    if (!isAtOrAfter(preview.expiresAt, preview.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Activation preview expiry cannot precede creation.',
        path: ['expiresAt'],
      });
    }
    if (
      Date.parse(preview.expiresAt) - Date.parse(preview.createdAt) >
      ACTIVATION_PREVIEW_MAX_AGE_SECONDS * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Activation preview lifetime exceeds the safe maximum.',
        path: ['expiresAt'],
      });
    }
    const channelNames = preview.channels.map((channel) => channel.channel);
    if (new Set(channelNames).size !== channelNames.length) {
      context.addIssue({
        code: 'custom',
        message: 'Activation preview channels must be unique.',
        path: ['channels'],
      });
    }
    const controlledEmailCanary =
      channelNames.length === 1 &&
      channelNames[0] === 'email' &&
      preview.channels[0]?.endpointCount === 1;
    if (
      controlledEmailCanary &&
      (preview.deliveryTest == null ||
        preview.kind !== 'drill' ||
        preview.templateMode !== 'drill' ||
        preview.rosterPopulation !== 'staff' ||
        preview.recipientCount !== 1)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A one-email consequence is limited to one delivery-test staff recipient and DRILL classification.',
        path: ['channels'],
      });
    }
    if (
      !controlledEmailCanary &&
      (!channelNames.includes('push') || !channelNames.includes('email'))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Activation previews require the launch-floor push and email channels.',
        path: ['channels'],
      });
    }
    preview.channels.forEach((channel, index) => {
      if (
        channel.renderedMessage.eventKind !== preview.kind ||
        channel.renderedMessage.templateMode !== preview.templateMode ||
        channel.renderedMessage.purpose !== 'activation'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Rendered preview classification must match activation.',
          path: ['channels', index, 'renderedMessage'],
        });
      }
      if (channel.endpointCount > preview.recipientCount * 10) {
        context.addIssue({
          code: 'custom',
          message:
            'Preview endpoint count cannot exceed the roster endpoint bound.',
          path: ['channels', index, 'endpointCount'],
        });
      }
    });
    const integrationsReady = preview.channels.every((channel) =>
      preview.rosterPopulation === 'synthetic'
        ? channel.integrationStatus.label === 'mocked'
        : channel.integrationStatus.label === 'live-verified',
    );
    const isReady = preview.sendReadiness === 'ready';
    const requiredChannelsHaveEndpoints = controlledEmailCanary
      ? preview.channels[0]?.endpointCount === 1
      : preview.channels
          .filter((channel) => ['push', 'email'].includes(channel.channel))
          .every((channel) => channel.endpointCount > 0);
    if (
      isReady &&
      (!integrationsReady ||
        preview.recipientCount === 0 ||
        !requiredChannelsHaveEndpoints)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Ready sends require recipients, required endpoints, and ready integrations.',
        path: ['sendReadiness'],
      });
    }
    if (isReady !== (preview.blockingReasonCodes.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'Blocked previews require safe blocking reason codes.',
        path: ['blockingReasonCodes'],
      });
    }
  })
  .readonly();

/** Server-issued activation consequence preview inferred from its schema. */
export type ActivationPreview = z.infer<typeof ActivationPreviewSchema>;

/**
 * Owns a short-lived all-clear/reactivation consequence preview. It pins the
 * exact immutable event, roster, rendered purpose-specific copy, recipients,
 * integrations, and digest before a human confirms.
 */
export const LifecycleConsequencePreviewSchema = z
  .object({
    id: LifecycleConsequencePreviewIdSchema,
    eventId: EventIdSchema,
    purpose: LifecycleNotificationPurposeSchema,
    kind: EventKindSchema,
    templateMode: TemplateModeSchema,
    eventTypeVersion: EventTypeVersionRefSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    rosterPopulation: RosterPopulationSchema,
    recipientCount: z.number().int().nonnegative().max(1_200),
    channels: z.array(ChannelConsequencePreviewSchema).min(2).max(3).readonly(),
    sendReadiness: z.enum(['ready', 'blocked']),
    blockingReasonCodes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Z0-9_]+$/u),
      )
      .max(20)
      .readonly(),
    consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    addClassificationIssues(preview, context);
    if (preview.eventTypeVersion.templateMode !== preview.templateMode) {
      context.addIssue({
        code: 'custom',
        message: 'Lifecycle preview event-type mode must match the event.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
    if (
      !isAtOrAfter(preview.expiresAt, preview.createdAt) ||
      Date.parse(preview.expiresAt) - Date.parse(preview.createdAt) >
        ACTIVATION_PREVIEW_MAX_AGE_SECONDS * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Lifecycle preview must have a current, bounded lifetime.',
        path: ['expiresAt'],
      });
    }
    const channelNames = preview.channels.map((channel) => channel.channel);
    if (
      new Set(channelNames).size !== channelNames.length ||
      !channelNames.includes('push') ||
      !channelNames.includes('email')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Lifecycle previews require unique launch-floor push and email channels.',
        path: ['channels'],
      });
    }
    preview.channels.forEach((channel, index) => {
      if (
        channel.renderedMessage.eventKind !== preview.kind ||
        channel.renderedMessage.templateMode !== preview.templateMode ||
        channel.renderedMessage.purpose !== preview.purpose
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Lifecycle preview rendered copy must match classification and purpose.',
          path: ['channels', index, 'renderedMessage'],
        });
      }
      if (channel.endpointCount > preview.recipientCount * 10) {
        context.addIssue({
          code: 'custom',
          message:
            'Lifecycle endpoint count cannot exceed the roster endpoint bound.',
          path: ['channels', index, 'endpointCount'],
        });
      }
    });
    const integrationsReady = preview.channels.every((channel) =>
      preview.rosterPopulation === 'synthetic'
        ? channel.integrationStatus.label === 'mocked'
        : channel.integrationStatus.label === 'live-verified',
    );
    const requiredChannelsHaveEndpoints = preview.channels
      .filter((channel) => ['push', 'email'].includes(channel.channel))
      .every((channel) => channel.endpointCount > 0);
    const isReady = preview.sendReadiness === 'ready';
    if (
      isReady &&
      (!integrationsReady ||
        preview.recipientCount === 0 ||
        !requiredChannelsHaveEndpoints)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Ready lifecycle sends require recipients, endpoints, and ready integrations.',
        path: ['sendReadiness'],
      });
    }
    if (isReady !== (preview.blockingReasonCodes.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'Blocked lifecycle previews require safe reason codes.',
        path: ['blockingReasonCodes'],
      });
    }
  })
  .readonly();

/** Server-issued all-clear/reactivation preview inferred from its schema. */
export type LifecycleConsequencePreview = z.infer<
  typeof LifecycleConsequencePreviewSchema
>;

/**
 * Owns an activation prepared for one-tap human confirmation. Agents may
 * author this separate record, but only a fresh human-confirmed start consumes
 * it to create an actual incident or staff drill and send intent.
 */
export const PreparedActivationSchema = z
  .object({
    id: PreparedActivationIdSchema,
    preview: ActivationPreviewSchema,
    preparedBy: ActorSchema,
    preparedAt: TimestampSchema,
  })
  .strict()
  .superRefine((prepared, context) => {
    if (prepared.preparedBy.kind === 'system') {
      context.addIssue({
        code: 'custom',
        message: 'Scheduled or system actors cannot prepare activations.',
        path: ['preparedBy'],
      });
    }
    if (prepared.preview.rosterPopulation !== 'staff') {
      context.addIssue({
        code: 'custom',
        message: 'Prepared activations are reserved for staff-targeting flows.',
        path: ['preview', 'rosterPopulation'],
      });
    }
    if (prepared.preview.deliveryTest != null) {
      context.addIssue({
        code: 'custom',
        message:
          'Monthly live delivery-test previews cannot enter a prepared activation workflow.',
        path: ['preview', 'deliveryTest'],
      });
    }
    if (!isAtOrAfter(prepared.preparedAt, prepared.preview.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Preparation time cannot precede preview creation.',
        path: ['preparedAt'],
      });
    }
    if (!isAtOrAfter(prepared.preview.expiresAt, prepared.preparedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Preparation time cannot follow preview expiry.',
        path: ['preparedAt'],
      });
    }
  })
  .readonly();

/** Agent- or human-prepared activation inferred from its schema. */
export type PreparedActivation = z.infer<typeof PreparedActivationSchema>;

/**
 * Owns the append-only single-use consumption fact for a prepared activation.
 * A uniqueness constraint on preparedActivationId prevents replay; the event
 * pins the same confirmation and request in activation authorization.
 */
export const PreparedActivationConsumptionSchema = z
  .object({
    preparedActivationId: PreparedActivationIdSchema,
    eventId: EventIdSchema,
    authorization: ActivationAuthorizationSchema,
    requestId: UuidSchema,
    consumedBy: ActorSchema,
    consumedAt: TimestampSchema,
  })
  .strict()
  .superRefine((consumption, context) => {
    if (consumption.consumedBy.kind !== 'human') {
      context.addIssue({
        code: 'custom',
        message: 'Only a human may consume a prepared activation.',
        path: ['consumedBy'],
      });
    }
    if (
      consumption.authorization.kind === 'synthetic-training' ||
      consumption.authorization.preparedActivationId !==
        consumption.preparedActivationId ||
      consumption.authorization.requestId !== consumption.requestId
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Prepared consumption must carry matching staff authorization provenance.',
        path: ['authorization'],
      });
    }
  })
  .readonly();

/** Prepared-activation single-use fact inferred from its schema. */
export type PreparedActivationConsumption = z.infer<
  typeof PreparedActivationConsumptionSchema
>;

/**
 * Owns the start mutation's reference to a server-issued preview or prepared
 * activation plus the explicit start-new decision. The capability envelope is
 * the single owner of idempotency and server-derived protected-action IDs.
 */
export const StartEventInputSchema = z
  .union([
    z
      .object({
        source: z.literal('activation-preview'),
        activationPreviewId: ActivationPreviewIdSchema,
        activeEventDecision: StartNewDecisionSchema,
      })
      .strict(),
    z
      .object({
        source: z.literal('prepared-activation'),
        preparedActivationId: PreparedActivationIdSchema,
        activeEventDecision: StartNewDecisionSchema,
      })
      .strict(),
  ])
  .readonly();

/** Server-bound event activation input inferred from its schema. */
export type StartEventInput = z.infer<typeof StartEventInputSchema>;

/**
 * Owns an idempotent participant join mutation. Joining never silently starts
 * a new event or sends notifications.
 */
export const JoinEventInputSchema = z
  .object({
    eventId: EventIdSchema,
  })
  .strict()
  .readonly();

/** Idempotent event join input inferred from its schema. */
export type JoinEventInput = z.infer<typeof JoinEventInputSchema>;

/**
 * Owns an idempotent all-clear mutation request. The capability engine resolves
 * event classification server-side before choosing the human-only action path.
 */
export const AllClearEventInputSchema = z
  .object({
    eventId: EventIdSchema,
    lifecyclePreviewId: LifecycleConsequencePreviewIdSchema,
  })
  .strict()
  .readonly();

/** Idempotent all-clear input inferred from its schema. */
export type AllClearEventInput = z.infer<typeof AllClearEventInputSchema>;

/**
 * Owns an idempotent request to re-activate an event after a mistaken
 * all-clear. The prior all-clear remains in the transition journal and current
 * event view; the capability engine derives fresh human/send requirements.
 */
export const ReactivateEventInputSchema = z
  .object({
    eventId: EventIdSchema,
    lifecyclePreviewId: LifecycleConsequencePreviewIdSchema,
  })
  .strict()
  .readonly();

/** Idempotent event reactivation input inferred from its schema. */
export type ReactivateEventInput = z.infer<typeof ReactivateEventInputSchema>;

/**
 * Owns an idempotent close mutation request. Closing appends lifecycle truth;
 * it never deletes the event or its journal.
 */
export const CloseEventInputSchema = z
  .object({
    eventId: EventIdSchema,
  })
  .strict()
  .readonly();

/** Idempotent event close input inferred from its schema. */
export type CloseEventInput = z.infer<typeof CloseEventInputSchema>;

/**
 * Owns an idempotent request to create a new correction event from a closed
 * source event. The original event remains immutable and retained.
 */
export const ReopenAsCorrectionInputSchema = z
  .object({
    sourceEventId: EventIdSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .readonly();

/** Idempotent correction-event request inferred from its schema. */
export type ReopenAsCorrectionInput = z.infer<
  typeof ReopenAsCorrectionInputSchema
>;

/**
 * Owns the only allowed lifecycle transition evidence. Correction reopening
 * names distinct source and result event IDs, preventing a rewrite of the
 * closed source row.
 */
export const EventTransitionKindSchema = z.enum([
  'activate',
  'all-clear',
  'reactivate',
  'close',
  'reopen-as-correction',
]);

/** Append-only lifecycle transition kind inferred from its schema. */
export type EventTransitionKind = z.infer<typeof EventTransitionKindSchema>;

const eventTransitionCommonShape = {
  id: UuidSchema,
  sequence: z.number().int().positive(),
  actor: ActorSchema,
  source: InvocationSourceSchema,
  occurredAt: TimestampSchema,
  requestId: UuidSchema,
  confirmationId: HumanConfirmationIdSchema.nullable(),
  consequenceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  targeting: EventTargetingSchema,
  idempotencyKey: IdempotencyKeySchema,
};

/**
 * Owns complete append-only event transition evidence, including fresh
 * activation or lifecycle notification authorization where a transition
 * starts sending notifications.
 */
export const EventTransitionSchema = z
  .union([
    z
      .object({
        ...eventTransitionCommonShape,
        transition: z.literal('activate'),
        eventId: EventIdSchema,
        from: z.literal('draft'),
        to: z.literal('active'),
        activationAuthorization: ActivationAuthorizationSchema,
      })
      .strict(),
    z
      .object({
        ...eventTransitionCommonShape,
        transition: z.literal('all-clear'),
        eventId: EventIdSchema,
        from: z.literal('active'),
        to: z.literal('all-clear'),
        notificationAuthorization: LifecycleActionAuthorizationSchema,
      })
      .strict(),
    z
      .object({
        ...eventTransitionCommonShape,
        transition: z.literal('reactivate'),
        eventId: EventIdSchema,
        from: z.literal('all-clear'),
        to: z.literal('active'),
        notificationAuthorization: LifecycleActionAuthorizationSchema,
      })
      .strict(),
    z
      .object({
        ...eventTransitionCommonShape,
        transition: z.literal('close'),
        eventId: EventIdSchema,
        from: z.literal('all-clear'),
        to: z.literal('closed'),
      })
      .strict(),
    z
      .object({
        ...eventTransitionCommonShape,
        transition: z.literal('reopen-as-correction'),
        sourceEventId: EventIdSchema,
        correctionEventId: EventIdSchema,
        from: z.literal('closed'),
        to: z.literal('draft'),
        reason: z.string().trim().min(1).max(1_000),
      })
      .strict()
      .superRefine((transition, context) => {
        if (transition.sourceEventId === transition.correctionEventId) {
          context.addIssue({
            code: 'custom',
            message: 'Correction reopening must create a distinct event.',
            path: ['correctionEventId'],
          });
        }
      }),
  ])
  .superRefine((transition, context) => {
    if (!isActorSourceCompatible(transition.actor, transition.source)) {
      context.addIssue({
        code: 'custom',
        message: 'Transition actor and invocation source are incompatible.',
        path: ['source'],
      });
    }
    const requiresConfirmation =
      (transition.transition === 'all-clear' &&
        transition.targeting.rosterPopulation === 'staff') ||
      (transition.transition === 'reactivate' &&
        transition.targeting.rosterPopulation === 'staff') ||
      (transition.transition === 'activate' &&
        transition.targeting.rosterPopulation === 'staff') ||
      (transition.transition === 'close' &&
        transition.targeting.kind === 'incident');
    const requiresHumanActor =
      requiresConfirmation ||
      (transition.transition === 'close' &&
        transition.targeting.rosterPopulation === 'staff');
    if (requiresHumanActor && transition.actor.kind !== 'human') {
      context.addIssue({
        code: 'custom',
        message: 'Protected event transitions require a human actor.',
        path: ['actor'],
      });
    }
    if (requiresConfirmation !== (transition.confirmationId !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Protected event transitions require exactly one human confirmation reference.',
        path: ['confirmationId'],
      });
    }
    if (requiresConfirmation !== (transition.consequenceDigest !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Protected event transitions require exactly one consequence digest.',
        path: ['consequenceDigest'],
      });
    }
    if (transition.transition === 'activate') {
      const expectedAuthorization =
        transition.targeting.rosterPopulation === 'staff'
          ? 'human-confirmed'
          : 'synthetic-training';
      if (transition.activationAuthorization.kind !== expectedAuthorization) {
        context.addIssue({
          code: 'custom',
          message:
            'Activation authorization must match staff or synthetic targeting.',
          path: ['activationAuthorization'],
        });
      }
      if (
        transition.activationAuthorization.requestId !== transition.requestId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Activation authorization must bind the transition request.',
          path: ['activationAuthorization', 'requestId'],
        });
      }
      if (
        transition.activationAuthorization.kind === 'human-confirmed' &&
        transition.activationAuthorization.confirmationId !==
          transition.confirmationId
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Activation transition and authorization confirmation must match.',
          path: ['confirmationId'],
        });
      }
      if (
        transition.activationAuthorization.kind === 'human-confirmed' &&
        transition.activationAuthorization.consequenceDigest !==
          transition.consequenceDigest
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Activation transition and authorization consequence must match.',
          path: ['consequenceDigest'],
        });
      }
      if (
        transition.activationAuthorization.kind === 'synthetic-training' &&
        (transition.confirmationId !== null ||
          transition.consequenceDigest !== null)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Synthetic activation cannot claim protected confirmation.',
          path: ['confirmationId'],
        });
      }
    }
    if (
      transition.transition === 'all-clear' ||
      transition.transition === 'reactivate'
    ) {
      const authorization = transition.notificationAuthorization;
      const expectedPurpose =
        transition.transition === 'all-clear' ? 'all-clear' : 'reactivation';
      if (authorization.purpose !== expectedPurpose) {
        context.addIssue({
          code: 'custom',
          message: 'Lifecycle authorization purpose must match the transition.',
          path: ['notificationAuthorization', 'purpose'],
        });
      }
      if (
        authorization.transitionId !== transition.id ||
        authorization.requestId !== transition.requestId
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Lifecycle authorization must bind the transition and request.',
          path: ['notificationAuthorization', 'transitionId'],
        });
      }
      if (
        authorization.targeting.kind !== transition.targeting.kind ||
        authorization.targeting.templateMode !==
          transition.targeting.templateMode ||
        authorization.targeting.rosterPopulation !==
          transition.targeting.rosterPopulation
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Lifecycle authorization targeting must match the transition.',
          path: ['notificationAuthorization', 'targeting'],
        });
      }
      if (
        authorization.kind === 'human-confirmed-lifecycle' &&
        (authorization.confirmationId !== transition.confirmationId ||
          authorization.consequenceDigest !== transition.consequenceDigest)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Lifecycle transition must retain matching human confirmation evidence.',
          path: ['notificationAuthorization', 'confirmationId'],
        });
      }
    }
  })
  .readonly();

/** Allowed append-only lifecycle transition evidence inferred from its schema. */
export type EventTransition = z.infer<typeof EventTransitionSchema>;

/** Returns true when an actor may activate the supplied targeting triple. */
export function canActorActivateEvent(
  actor: Actor,
  targeting: EventTargeting,
): boolean {
  return targeting.rosterPopulation === 'synthetic' || actor.kind === 'human';
}

/**
 * Owns the request to retain a short-lived activation preview for later
 * one-tap human review. Preparing it never activates an event or sends.
 */
export const PrepareActivationInputSchema = z
  .object({
    activationPreviewId: ActivationPreviewIdSchema,
  })
  .strict()
  .readonly();

/** Prepared-activation request inferred from its schema. */
export type PrepareActivationInput = z.infer<
  typeof PrepareActivationInputSchema
>;

/** Owns a scoped read of one retained prepared activation. */
export const GetPreparedActivationInputSchema = z
  .object({
    preparedActivationId: PreparedActivationIdSchema,
  })
  .strict()
  .readonly();

/** Prepared-activation read input inferred from its schema. */
export type GetPreparedActivationInput = z.infer<
  typeof GetPreparedActivationInputSchema
>;

/**
 * Owns the persisted mutation input for fresh purpose-specific all-clear or
 * reactivation consequences. The server resolves pinned event, roster,
 * integration, and rendered-copy truth before returning the preview.
 */
export const CreateLifecycleConsequencePreviewInputSchema = z
  .object({
    eventId: EventIdSchema,
    purpose: LifecycleNotificationPurposeSchema,
  })
  .strict()
  .readonly();

/** Lifecycle consequence-preview input inferred from its schema. */
export type CreateLifecycleConsequencePreviewInput = z.infer<
  typeof CreateLifecycleConsequencePreviewInputSchema
>;

/** Owns a facility-scoped read of one operational event. */
export const GetEventInputSchema = z
  .object({
    eventId: EventIdSchema,
  })
  .strict()
  .readonly();

/** Operational event read input inferred from its schema. */
export type GetEventInput = z.infer<typeof GetEventInputSchema>;

/**
 * Owns bounded active-event list filters used by the explicit join-or-start
 * chooser. Null facility means the caller's already-authorized scope, never
 * district-wide access by implication.
 */
export const ListActiveEventsInputSchema = z
  .object({
    facilityId: FacilityIdSchema.nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(100),
  })
  .strict()
  .readonly();

/** Active-event list input inferred from its schema. */
export type ListActiveEventsInput = z.infer<typeof ListActiveEventsInputSchema>;

/** Owns a bounded page of facility-authorized operational events. */
export const EventPageSchema = paginatedSchema(EventSchema);

/** Facility-authorized event page inferred from its schema. */
export type EventPage = z.infer<typeof EventPageSchema>;

/**
 * Owns the result of joining an existing event. It contains no notification
 * intent and therefore cannot be mistaken for an activation result.
 */
export const JoinEventResultSchema = z
  .object({
    event: EventSchema,
    participantId: UuidSchema,
    joined: z.literal(true),
  })
  .strict()
  .readonly();

/** Existing-event join result inferred from its schema. */
export type JoinEventResult = z.infer<typeof JoinEventResultSchema>;
