import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import { ActorSchema } from './capability';
import { IntegrationIdSchema } from './integration';
import { TimestampSchema, UuidSchema, VersionSchema } from './shared';

/**
 * Owns the top-level operational event classification used by event records,
 * rendered channel payloads, notifications, and outbox messages.
 */
export const EventKindSchema = z.enum(['incident', 'drill', 'test']);

/** Operational event kind inferred from its schema. */
export type EventKind = z.infer<typeof EventKindSchema>;

/**
 * Owns the immutable real-versus-drill classification used by event types,
 * templates, events, notification records, and worker payloads. `test` events
 * intentionally use drill-mode rendering.
 */
export const TemplateModeSchema = z.enum(['real', 'drill']);

/** Immutable template classification inferred from its schema. */
export type TemplateMode = z.infer<typeof TemplateModeSchema>;

/**
 * Owns the release-one notification channel vocabulary shared by roster
 * endpoints, templates, dispatch batches, and delivery evidence.
 */
export const NotificationChannelSchema = z.enum(['push', 'email', 'sms']);

/** Notification channel inferred from its schema. */
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

/**
 * Owns the semantic purpose of rendered notification copy. Activation,
 * all-clear, and reactivation payloads remain distinct even when they share
 * the same event classification and recipients.
 */
export const NotificationPurposeSchema = z.enum([
  'activation',
  'all-clear',
  'reactivation',
]);

/** Notification message purpose inferred from its schema. */
export type NotificationPurpose = z.infer<typeof NotificationPurposeSchema>;

/** Owns lifecycle notification purposes that follow initial activation. */
export const LifecycleNotificationPurposeSchema = z.enum([
  'all-clear',
  'reactivation',
]);

/** Post-activation notification purpose inferred from its schema. */
export type LifecycleNotificationPurpose = z.infer<
  typeof LifecycleNotificationPurposeSchema
>;

/**
 * Owns the non-editable classification marker that renderers place outside
 * administrator-editable wording. Drill output can therefore never lose its
 * unmistakable marker through a template edit.
 */
export const ClassificationMarkerSchema = z.enum(['INCIDENT', 'DRILL']);

/** Renderer-owned classification marker inferred from its schema. */
export type ClassificationMarker = z.infer<typeof ClassificationMarkerSchema>;

/**
 * Owns the complete renderer-variable vocabulary available to administrator-
 * editable message wording. New variables require a contracts revision so
 * every channel renderer remains consistent.
 */
export const TemplateVariableSchema = z.enum([
  'site',
  'eventType',
  'threat',
  'startTime',
  'initiator',
]);

/** Renderer variable name inferred from its schema. */
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;

/**
 * Owns the exact token syntax accepted in message templates. Renderers replace
 * these tokens from trusted structured values and escape output per channel.
 */
export const TemplateTokenSchema = z.enum([
  '{{site}}',
  '{{eventType}}',
  '{{threat}}',
  '{{startTime}}',
  '{{initiator}}',
]);

/** Allowed renderer token inferred from its schema. */
export type TemplateToken = z.infer<typeof TemplateTokenSchema>;

const allowedTemplateTokens = new Set<string>(TemplateTokenSchema.options);

function isUnsafeVisibleTextCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x09 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

function addSafeVisibleTextIssues(
  text: string,
  context: z.RefinementCtx,
): void {
  if (
    [...text].some((character) =>
      isUnsafeVisibleTextCodePoint(character.codePointAt(0) ?? 0),
    )
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'Visible message text cannot contain bidi, zero-width, or unsafe control characters.',
    });
  }
  if (text !== text.normalize('NFC')) {
    context.addIssue({
      code: 'custom',
      message: 'Visible message text must use canonical NFC normalization.',
    });
  }
}

function messageTemplateTextSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .superRefine((text, context) => {
      addSafeVisibleTextIssues(text, context);
      for (const token of text.match(/\{\{[^{}]*\}\}/gu) ?? []) {
        if (!allowedTemplateTokens.has(token)) {
          context.addIssue({
            code: 'custom',
            message: `Unsupported message-template token: ${token}`,
          });
        }
      }
      const withoutValidTokens = TemplateTokenSchema.options.reduce(
        (remaining, token) => remaining.replaceAll(token, ''),
        text,
      );
      if (
        withoutValidTokens.includes('{{') ||
        withoutValidTokens.includes('}}')
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Message template contains a malformed token.',
        });
      }
    });
}

function renderedVisibleTextSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .superRefine(addSafeVisibleTextIssues);
}

/**
 * Owns the short description an operator types when a threat or response
 * catalog entry requires one ("Other"). It is a rendered value, never a
 * template: it obeys the same visible-text rules as message copy and any
 * token-looking text inside it is shown literally.
 */
export const OperatorDetailSchema = renderedVisibleTextSchema(200);

/** Operator-typed choice description inferred from its schema. */
export type OperatorDetail = z.infer<typeof OperatorDetailSchema>;

/**
 * Owns the stable identity for one selectable real or drill event type.
 * Vocabulary changes create new versions without changing this identity's
 * mode.
 */
export const EventTypeIdSchema = UuidSchema;

/** Stable event-type identity inferred from its schema. */
export type EventTypeId = z.infer<typeof EventTypeIdSchema>;

/**
 * Owns the stable identity for one immutable event-type version. Historical
 * events pin this value and never resolve through a mutable latest pointer.
 */
export const EventTypeVersionIdSchema = UuidSchema;

/** Stable event-type-version identifier inferred from its schema. */
export type EventTypeVersionId = z.infer<typeof EventTypeVersionIdSchema>;

/**
 * Owns a selectable event-type identity. Real and drill variants are separate
 * identities within the same family, so mode cannot change in place.
 */
export const EventTypeSchema = z
  .object({
    id: EventTypeIdSchema,
    key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    familyKey: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    templateMode: TemplateModeSchema,
    /**
     * True for a response such as "Other" that an operator cannot choose
     * without typing what the response is. Part of the immutable identity so
     * a real and a drill variant of one family agree.
     */
    requiresDetail: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Selectable event-type identity inferred from its schema. */
export type EventType = z.infer<typeof EventTypeSchema>;

const templateCommonShape = {
  templateMode: TemplateModeSchema,
  purpose: NotificationPurposeSchema,
  classificationMarker: ClassificationMarkerSchema,
};

function addClassificationMarkerIssue(
  value: {
    readonly templateMode: TemplateMode;
    readonly classificationMarker: ClassificationMarker;
  },
  context: z.RefinementCtx,
): void {
  const expected = value.templateMode === 'real' ? 'INCIDENT' : 'DRILL';
  if (value.classificationMarker !== expected) {
    context.addIssue({
      code: 'custom',
      message: `${value.templateMode} templates require the ${expected} marker.`,
      path: ['classificationMarker'],
    });
  }
}

/**
 * Owns immutable administrator wording for a push channel version while the
 * classification marker remains renderer-controlled.
 */
export const PushMessageTemplateSchema = z
  .object({
    ...templateCommonShape,
    channel: z.literal('push'),
    title: messageTemplateTextSchema(120),
    body: messageTemplateTextSchema(500),
  })
  .strict()
  .superRefine(addClassificationMarkerIssue)
  .readonly();

/** Immutable push message template inferred from its schema. */
export type PushMessageTemplate = z.infer<typeof PushMessageTemplateSchema>;

/**
 * Owns immutable administrator plaintext for email while preserving a
 * renderer-controlled classification. The renderer escapes this text and
 * generates accessible HTML; raw administrator HTML is never stored.
 */
export const EmailMessageTemplateSchema = z
  .object({
    ...templateCommonShape,
    channel: z.literal('email'),
    subject: messageTemplateTextSchema(200),
    textBody: messageTemplateTextSchema(10_000),
  })
  .strict()
  .superRefine(addClassificationMarkerIssue)
  .readonly();

/** Immutable email message template inferred from its schema. */
export type EmailMessageTemplate = z.infer<typeof EmailMessageTemplateSchema>;

/**
 * Owns immutable administrator wording for the length-constrained SMS channel
 * while preserving a renderer-controlled classification.
 */
export const SmsMessageTemplateSchema = z
  .object({
    ...templateCommonShape,
    channel: z.literal('sms'),
    body: messageTemplateTextSchema(1_000),
  })
  .strict()
  .superRefine(addClassificationMarkerIssue)
  .readonly();

/** Immutable SMS message template inferred from its schema. */
export type SmsMessageTemplate = z.infer<typeof SmsMessageTemplateSchema>;

/**
 * Owns the complete per-version channel template set. Exactly one template
 * per release-one channel is required and all three repeat the same immutable
 * mode for defense in depth.
 */
export const MessageTemplateSetSchema = z
  .object({
    templateMode: TemplateModeSchema,
    purpose: NotificationPurposeSchema,
    push: PushMessageTemplateSchema,
    email: EmailMessageTemplateSchema,
    sms: SmsMessageTemplateSchema,
  })
  .strict()
  .superRefine((templates, context) => {
    (['push', 'email', 'sms'] as const).forEach((channel) => {
      if (templates[channel].templateMode !== templates.templateMode) {
        context.addIssue({
          code: 'custom',
          message: `${channel} template mode must match the template set.`,
          path: [channel, 'templateMode'],
        });
      }
      if (templates[channel].purpose !== templates.purpose) {
        context.addIssue({
          code: 'custom',
          message: `${channel} template purpose must match the template set.`,
          path: [channel, 'purpose'],
        });
      }
    });
  })
  .readonly();

/** Complete immutable channel template set inferred from its schema. */
export type MessageTemplateSet = z.infer<typeof MessageTemplateSetSchema>;

/**
 * Owns the complete purpose-specific template catalog for one immutable event
 * type version. A lifecycle send must select its matching catalog entry and
 * cannot silently reuse activation wording.
 */
export const MessageTemplateCatalogSchema = z
  .object({
    activation: MessageTemplateSetSchema,
    'all-clear': MessageTemplateSetSchema,
    reactivation: MessageTemplateSetSchema,
  })
  .strict()
  .superRefine((catalog, context) => {
    (['activation', 'all-clear', 'reactivation'] as const).forEach(
      (purpose) => {
        if (catalog[purpose].purpose !== purpose) {
          context.addIssue({
            code: 'custom',
            message: 'Template catalog key must match its message purpose.',
            path: [purpose, 'purpose'],
          });
        }
      },
    );
    const modes = Object.values(catalog).map((set) => set.templateMode);
    if (new Set(modes).size !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Every purpose-specific template set must use one mode.',
        path: ['activation', 'templateMode'],
      });
    }
  })
  .readonly();

/** Purpose-specific immutable template catalog inferred from its schema. */
export type MessageTemplateCatalog = z.infer<
  typeof MessageTemplateCatalogSchema
>;

const renderedMessageCommonShape = {
  eventKind: EventKindSchema,
  templateMode: TemplateModeSchema,
  purpose: NotificationPurposeSchema,
  classificationMarker: ClassificationMarkerSchema,
};

function addRenderedMessageIssues(
  message: {
    readonly eventKind: EventKind;
    readonly templateMode: TemplateMode;
    readonly classificationMarker: ClassificationMarker;
    readonly channel: NotificationChannel;
    readonly title?: string;
    readonly subject?: string;
    readonly textBody?: string;
    readonly body?: string;
  },
  context: z.RefinementCtx,
): void {
  const expectedMode = message.eventKind === 'incident' ? 'real' : 'drill';
  const expectedMarker = expectedMode === 'real' ? 'INCIDENT' : 'DRILL';
  if (message.templateMode !== expectedMode) {
    context.addIssue({
      code: 'custom',
      message: 'Rendered event kind and template mode are incompatible.',
      path: ['templateMode'],
    });
  }
  if (message.classificationMarker !== expectedMarker) {
    context.addIssue({
      code: 'custom',
      message: 'Rendered classification marker does not match message mode.',
      path: ['classificationMarker'],
    });
  }
  const prefix = `[${expectedMarker}]`;
  const forbiddenMarker =
    expectedMarker === 'INCIDENT' ? '[DRILL]' : '[INCIDENT]';
  const visibleFields = (() => {
    switch (message.channel) {
      case 'push':
        return [message.title, message.body];
      case 'email':
        return [message.subject, message.textBody];
      case 'sms':
        return [message.body];
    }
  })();
  visibleFields.forEach((field, index) => {
    const fieldPath =
      index === 0
        ? message.channel === 'email'
          ? 'subject'
          : message.channel === 'push'
            ? 'title'
            : 'body'
        : message.channel === 'push'
          ? 'body'
          : 'textBody';
    if (!field?.startsWith(prefix)) {
      context.addIssue({
        code: 'custom',
        message: `Rendered ${message.channel} output must visibly begin with ${prefix}.`,
        path: [fieldPath],
      });
    }
    if (field?.includes(forbiddenMarker)) {
      context.addIssue({
        code: 'custom',
        message: `Rendered ${message.channel} output cannot contain the opposite ${forbiddenMarker} marker.`,
        path: [fieldPath],
      });
    }
  });
}

/**
 * Owns the exact rendered channel payload handed to notification workers.
 * Every visible channel field begins with a renderer-controlled INCIDENT or
 * DRILL marker, preventing editable wording from hiding classification.
 */
export const RenderedMessageSchema = z
  .union([
    z
      .object({
        ...renderedMessageCommonShape,
        channel: z.literal('push'),
        title: renderedVisibleTextSchema(120),
        body: renderedVisibleTextSchema(500),
      })
      .strict(),
    z
      .object({
        ...renderedMessageCommonShape,
        channel: z.literal('email'),
        subject: renderedVisibleTextSchema(200),
        textBody: renderedVisibleTextSchema(10_000),
      })
      .strict(),
    z
      .object({
        ...renderedMessageCommonShape,
        channel: z.literal('sms'),
        body: renderedVisibleTextSchema(1_000),
      })
      .strict(),
  ])
  .superRefine(addRenderedMessageIssues)
  .readonly();

/** Exact rendered worker payload inferred from its schema. */
export type RenderedMessage = z.infer<typeof RenderedMessageSchema>;

/**
 * Owns one channel row in a consequence preview: exact rendered output,
 * endpoint count, and truthful integration readiness observed for that send.
 */
export const ChannelConsequencePreviewSchema = z
  .object({
    channel: NotificationChannelSchema,
    endpointCount: z.number().int().nonnegative().max(12_000),
    renderedMessage: RenderedMessageSchema,
    integrationId: IntegrationIdSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    if (preview.renderedMessage.channel !== preview.channel) {
      context.addIssue({
        code: 'custom',
        message: 'Preview channel must match its rendered message.',
        path: ['renderedMessage', 'channel'],
      });
    }
    const integrationsByChannel = {
      push: ['expo-push', 'mobile-push'],
      email: ['ses-email'],
      sms: ['aws-eum-sms'],
    } as const;
    if (
      !(integrationsByChannel[preview.channel] as readonly string[]).includes(
        preview.integrationId,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Integration identity must match the selected channel.',
        path: ['integrationId'],
      });
    }
  })
  .readonly();

/** Consequence-preview channel row inferred from its schema. */
export type ChannelConsequencePreview = z.infer<
  typeof ChannelConsequencePreviewSchema
>;

/**
 * Owns publication approval provenance for selectable event-type versions.
 * Humans approve ordinary publications; the initial repository seed uses a
 * reviewed change reference and a narrowly named seed service.
 */
export const EventTypePublicationAuthorizationSchema = z
  .union([
    z
      .object({
        kind: z.literal('human-admin'),
        approvedByUserId: UuidSchema,
        approvalReference: z.string().trim().min(1).max(255),
      })
      .strict(),
    z
      .object({
        kind: z.literal('agent-configuration'),
        agentId: UuidSchema,
        apiKeyId: UuidSchema,
        authorizationReference: z.string().trim().min(1).max(255),
      })
      .strict(),
    z
      .object({
        kind: z.literal('repository-seed'),
        approvalReference: z.string().trim().min(1).max(255),
      })
      .strict(),
  ])
  .readonly();

/** Event-type publication approval inferred from its schema. */
export type EventTypePublicationAuthorization = z.infer<
  typeof EventTypePublicationAuthorizationSchema
>;

/**
 * Owns one immutable, administrator-created event-type revision. Editing a
 * name, availability flag, or any channel wording creates a later version;
 * existing events retain their pinned version.
 */
export const EventTypeVersionSchema = z
  .object({
    id: EventTypeVersionIdSchema,
    eventTypeId: EventTypeIdSchema,
    version: VersionSchema,
    templateMode: TemplateModeSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1_000).nullable(),
    enabled: z.boolean(),
    templates: MessageTemplateCatalogSchema,
    supersedesVersionId: EventTypeVersionIdSchema.nullable(),
    createdBy: ActorSchema,
    publicationAuthorization: EventTypePublicationAuthorizationSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((version, context) => {
    Object.entries(version.templates).forEach(([purpose, templates]) => {
      if (templates.templateMode !== version.templateMode) {
        context.addIssue({
          code: 'custom',
          message: 'Template set mode must match the event-type version.',
          path: ['templates', purpose, 'templateMode'],
        });
      }
    });
    if (version.supersedesVersionId === version.id) {
      context.addIssue({
        code: 'custom',
        message: 'An event-type version cannot supersede itself.',
        path: ['supersedesVersionId'],
      });
    }
    if (
      version.createdBy.kind === 'human' &&
      (version.publicationAuthorization.kind !== 'human-admin' ||
        version.publicationAuthorization.approvedByUserId !==
          version.createdBy.userId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Human publication requires matching admin approval.',
        path: ['publicationAuthorization'],
      });
    }
    if (
      version.createdBy.kind === 'agent' &&
      (version.publicationAuthorization.kind !== 'agent-configuration' ||
        version.publicationAuthorization.agentId !==
          version.createdBy.agentId ||
        version.publicationAuthorization.apiKeyId !==
          version.createdBy.apiKeyId)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Agent publication requires matching, authorized configuration provenance.',
        path: ['publicationAuthorization'],
      });
    }
    if (
      version.createdBy.kind === 'system' &&
      (version.createdBy.serviceId !== 'database-seed' ||
        version.version !== 1 ||
        version.publicationAuthorization.kind !== 'repository-seed')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'System publication is limited to reviewed initial database seeds.',
        path: ['publicationAuthorization'],
      });
    }
  })
  .readonly();

/** Immutable event-type revision inferred from its schema. */
export type EventTypeVersion = z.infer<typeof EventTypeVersionSchema>;

/** Stable identifier for an unpublished event-type configuration draft. */
export const EventTypeVersionDraftIdSchema = UuidSchema;

/** Unpublished event-type draft identifier inferred from its schema. */
export type EventTypeVersionDraftId = z.infer<
  typeof EventTypeVersionDraftIdSchema
>;

/**
 * Owns the opaque server-derived SHA-256 token for one exact draft revision.
 * Clients echo this value as an optimistic-concurrency precondition and never
 * calculate or interpret it.
 */
export const EventTypeDraftRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Exact event-type draft revision token inferred from its schema. */
export type EventTypeDraftRevision = z.infer<
  typeof EventTypeDraftRevisionSchema
>;

/**
 * Owns an unpublished event-type revision proposal. Human and agent authors
 * may prepare exact wording and desired availability, but the proposal has no
 * published version identity and cannot be selected by an activation until an
 * authorized publication flow succeeds.
 */
export const EventTypeVersionDraftSchema = z
  .object({
    id: EventTypeVersionDraftIdSchema,
    eventTypeId: EventTypeIdSchema,
    status: z.literal('draft'),
    templateMode: TemplateModeSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1_000).nullable(),
    baseVersionId: EventTypeVersionIdSchema.nullable(),
    enabled: z.boolean(),
    templates: MessageTemplateCatalogSchema,
    draftedBy: ActorSchema,
    draftRevision: EventTypeDraftRevisionSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((draft, context) => {
    Object.entries(draft.templates).forEach(([purpose, templates]) => {
      if (templates.templateMode !== draft.templateMode) {
        context.addIssue({
          code: 'custom',
          message: 'Draft template set mode must match the proposed mode.',
          path: ['templates', purpose, 'templateMode'],
        });
      }
    });
    if (draft.draftedBy.kind === 'system') {
      context.addIssue({
        code: 'custom',
        message: 'Only humans or agents may author configuration drafts.',
        path: ['draftedBy'],
      });
    }
  })
  .readonly();

/** Unpublished event-type revision proposal inferred from its schema. */
export type EventTypeVersionDraft = z.infer<typeof EventTypeVersionDraftSchema>;

/**
 * Owns the compact pinned reference carried by events and notifications. The
 * repeated mode lets contracts and composite database keys reject cross-mode
 * references rather than trusting an ID alone.
 */
export const EventTypeVersionRefSchema = z
  .object({
    id: EventTypeVersionIdSchema,
    templateMode: TemplateModeSchema,
  })
  .strict()
  .readonly();

/** Pinned event-type-version reference inferred from its schema. */
export type EventTypeVersionRef = z.infer<typeof EventTypeVersionRefSchema>;

/** Owns bounded event-type list filters for operational and admin surfaces. */
export const ListEventTypesInputSchema = z
  .object({
    templateMode: TemplateModeSchema.nullable(),
    enabled: z.boolean().nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Event-type list input inferred from its schema. */
export type ListEventTypesInput = z.infer<typeof ListEventTypesInputSchema>;

/** Owns one selectable event-type row and its latest immutable version. */
export const EventTypeListItemSchema = z
  .object({
    eventType: EventTypeSchema,
    latestVersion: EventTypeVersionSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.latestVersion.eventTypeId !== item.eventType.id ||
      item.latestVersion.templateMode !== item.eventType.templateMode
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Latest event-type version must match its identity and mode.',
        path: ['latestVersion'],
      });
    }
  })
  .readonly();

/** Selectable event-type list row inferred from its schema. */
export type EventTypeListItem = z.infer<typeof EventTypeListItemSchema>;

/** Owns a bounded page of selectable event types. */
export const EventTypePageSchema = paginatedSchema(EventTypeListItemSchema);

/** Selectable event-type page inferred from its schema. */
export type EventTypePage = z.infer<typeof EventTypePageSchema>;

/** Owns a read of one exact immutable event-type version. */
export const GetEventTypeVersionInputSchema = z
  .object({
    eventTypeVersionId: EventTypeVersionIdSchema,
  })
  .strict()
  .readonly();

/** Exact event-type-version read input inferred from its schema. */
export type GetEventTypeVersionInput = z.infer<
  typeof GetEventTypeVersionInputSchema
>;

/** Owns a read of one unpublished event-type draft. */
export const GetEventTypeDraftInputSchema = z
  .object({
    draftId: EventTypeVersionDraftIdSchema,
  })
  .strict()
  .readonly();

/** Event-type draft read input inferred from its schema. */
export type GetEventTypeDraftInput = z.infer<
  typeof GetEventTypeDraftInputSchema
>;

/**
 * Owns a non-mutating rendering-preview request. Sample variable values are
 * server-owned so a preview cannot inject caller content into trusted admin
 * output or claim an event time that has not occurred.
 */
export const PreviewEventTypeRenderingInputSchema = z
  .object({
    draftId: EventTypeVersionDraftIdSchema,
    expectedDraftRevision: EventTypeDraftRevisionSchema,
    eventKind: EventKindSchema,
    purpose: NotificationPurposeSchema,
  })
  .strict()
  .readonly();

/** Event-type rendering-preview input inferred from its schema. */
export type PreviewEventTypeRenderingInput = z.infer<
  typeof PreviewEventTypeRenderingInputSchema
>;

/** Owns the exact three-channel rendering preview for an unpublished draft. */
export const EventTypeRenderingPreviewSchema = z
  .object({
    draftId: EventTypeVersionDraftIdSchema,
    draftRevision: EventTypeDraftRevisionSchema,
    eventKind: EventKindSchema,
    templateMode: TemplateModeSchema,
    purpose: NotificationPurposeSchema,
    messages: z.array(RenderedMessageSchema).length(3).readonly(),
  })
  .strict()
  .superRefine((preview, context) => {
    const expectedMode = preview.eventKind === 'incident' ? 'real' : 'drill';
    if (preview.templateMode !== expectedMode) {
      context.addIssue({
        code: 'custom',
        message: 'Rendering preview kind and mode must agree.',
        path: ['templateMode'],
      });
    }
    const channels = preview.messages.map((message) => message.channel);
    if (
      new Set(channels).size !== 3 ||
      !(['push', 'email', 'sms'] as const).every((channel) =>
        channels.includes(channel),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Rendering preview requires exactly one message per channel.',
        path: ['messages'],
      });
    }
    preview.messages.forEach((message, index) => {
      if (
        message.eventKind !== preview.eventKind ||
        message.templateMode !== preview.templateMode ||
        message.purpose !== preview.purpose
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Rendered preview messages must match requested semantics.',
          path: ['messages', index],
        });
      }
    });
  })
  .readonly();

/** Exact event-type rendering preview inferred from its schema. */
export type EventTypeRenderingPreview = z.infer<
  typeof EventTypeRenderingPreviewSchema
>;

/**
 * Owns the target identity for an event-type draft. A new identity supplies
 * immutable keys and mode; an existing identity is referenced only by ID.
 */
export const EventTypeDraftTargetSchema = z
  .union([
    z
      .object({
        kind: z.literal('new-event-type'),
        key: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
        familyKey: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
        templateMode: TemplateModeSchema,
        requiresDetail: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('existing-event-type'),
        eventTypeId: EventTypeIdSchema,
        baseVersionId: EventTypeVersionIdSchema,
      })
      .strict(),
  ])
  .readonly();

/** Event-type draft identity target inferred from its schema. */
export type EventTypeDraftTarget = z.infer<typeof EventTypeDraftTargetSchema>;

/**
 * Owns an unpublished event-type draft creation request. Actor and server time
 * come from the capability envelope and are absent from caller-owned content.
 */
export const CreateEventTypeDraftInputSchema = z
  .object({
    target: EventTypeDraftTargetSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1_000).nullable(),
    enabled: z.boolean(),
    templates: MessageTemplateCatalogSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.target.kind !== 'new-event-type') {
      return;
    }
    const targetMode = input.target.templateMode;
    if (
      Object.values(input.templates).some(
        (templates) => templates.templateMode !== targetMode,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'New event-type templates must match the immutable mode.',
        path: ['templates'],
      });
    }
  })
  .readonly();

/** Event-type draft creation input inferred from its schema. */
export type CreateEventTypeDraftInput = z.infer<
  typeof CreateEventTypeDraftInputSchema
>;

/** Owns a compare-and-swap replacement of one exact draft revision. */
export const UpdateEventTypeDraftInputSchema = z
  .object({
    draftId: EventTypeVersionDraftIdSchema,
    expectedDraftRevision: EventTypeDraftRevisionSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1_000).nullable(),
    enabled: z.boolean(),
    templates: MessageTemplateCatalogSchema,
  })
  .strict()
  .readonly();

/** Event-type draft replacement input inferred from its schema. */
export type UpdateEventTypeDraftInput = z.infer<
  typeof UpdateEventTypeDraftInputSchema
>;

/**
 * Owns a request to publish one exact reviewed draft revision. Admin
 * authorization, publisher identity, exact server time, bound base version,
 * desired availability, and publication provenance remain server-derived from
 * the persisted draft and capability context.
 */
export const PublishEventTypeVersionInputSchema = z
  .object({
    draftId: EventTypeVersionDraftIdSchema,
    expectedDraftRevision: EventTypeDraftRevisionSchema,
  })
  .strict()
  .readonly();

/** Event-type publication input inferred from its schema. */
export type PublishEventTypeVersionInput = z.infer<
  typeof PublishEventTypeVersionInputSchema
>;
