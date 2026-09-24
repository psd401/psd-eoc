import { z } from 'zod';

import {
  EmailMessageTemplateSchema,
  EventTypeDraftRevisionSchema,
  EventTypeIdSchema,
  EventTypeVersionDraftIdSchema,
  EventTypeVersionIdSchema,
  PushMessageTemplateSchema,
  SmsMessageTemplateSchema,
  TemplateModeSchema,
} from './event-type';
import { TimestampSchema } from './shared';

/**
 * Agent-facing name for the message lifecycle phase whose canonical internal
 * purpose is also a protected human-only action ID. `resolution` selects only
 * stored notification wording; it never authorizes or performs that action.
 */
export const McpMessagePhaseSchema = z.enum([
  'activation',
  'resolution',
  'reactivation',
]);

/** Safe agent-facing message phase inferred from its schema. */
export type McpMessagePhase = z.infer<typeof McpMessagePhaseSchema>;

// Built from each template's field schemas rather than `.pick()`: the
// templates carry refinements, which `.pick()` would silently drop (and zod
// 4.6 refuses to drop). The wording fields are validated here exactly as
// before; the templates' cross-field refinements never applied to a
// wording-only replacement.
const pushTemplateShape = PushMessageTemplateSchema.unwrap().shape;
const pushWordingSchema = z
  .object({
    title: pushTemplateShape.title,
    body: pushTemplateShape.body,
    channel: z.literal('push'),
  })
  .strict()
  .readonly();

const emailTemplateShape = EmailMessageTemplateSchema.unwrap().shape;
const emailWordingSchema = z
  .object({
    subject: emailTemplateShape.subject,
    textBody: emailTemplateShape.textBody,
    channel: z.literal('email'),
  })
  .strict()
  .readonly();

const smsTemplateShape = SmsMessageTemplateSchema.unwrap().shape;
const smsWordingSchema = z
  .object({
    body: smsTemplateShape.body,
    channel: z.literal('sms'),
  })
  .strict()
  .readonly();

/**
 * Owns one bounded wording replacement. Classification, lifecycle purpose,
 * and channel identity outside this discriminant remain server-derived from
 * the exact published version or draft being revised.
 */
export const McpMessageWordingSchema = z
  .discriminatedUnion('channel', [
    pushWordingSchema,
    emailWordingSchema,
    smsWordingSchema,
  ])
  .readonly();

/** Agent-authored channel wording inferred from its schema. */
export type McpMessageWording = z.infer<typeof McpMessageWordingSchema>;

/**
 * Selects either an immutable published version for a new draft or an exact
 * optimistic-concurrency revision of an existing unpublished draft.
 */
export const McpDraftMessageRevisionSourceSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('published-version'),
        baseVersionId: EventTypeVersionIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('existing-draft'),
        draftId: EventTypeVersionDraftIdSchema,
        expectedDraftRevision: EventTypeDraftRevisionSchema,
      })
      .strict(),
  ])
  .readonly();

/** Message-revision source inferred from its schema. */
export type McpDraftMessageRevisionSource = z.infer<
  typeof McpDraftMessageRevisionSourceSchema
>;

/**
 * Canonical MCP facade input for revising one message without serializing a
 * protected action ID into an agent-facing tool manifest.
 */
export const McpDraftMessageRevisionInputSchema = z
  .object({
    source: McpDraftMessageRevisionSourceSchema,
    phase: McpMessagePhaseSchema,
    wording: McpMessageWordingSchema,
  })
  .strict()
  .readonly();

/** MCP message-revision input inferred from its schema. */
export type McpDraftMessageRevisionInput = z.infer<
  typeof McpDraftMessageRevisionInputSchema
>;

/**
 * Bounded draft result returned to agents. It intentionally omits the full
 * canonical template catalog so protected action IDs cannot become manifest
 * or facade vocabulary.
 */
export const McpDraftMessageRevisionResultSchema = z
  .object({
    draftId: EventTypeVersionDraftIdSchema,
    draftRevision: EventTypeDraftRevisionSchema,
    eventTypeId: EventTypeIdSchema,
    baseVersionId: EventTypeVersionIdSchema.nullable(),
    templateMode: TemplateModeSchema,
    changedPhase: McpMessagePhaseSchema,
    changedChannel: z.enum(['push', 'email', 'sms']),
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Bounded MCP message-revision result inferred from its schema. */
export type McpDraftMessageRevisionResult = z.infer<
  typeof McpDraftMessageRevisionResultSchema
>;
