import { z } from 'zod';

import {
  ActorSchema,
  InvocationSourceSchema,
  isActorSourceCompatible,
  type Actor,
} from './capability';
import { EventIdSchema, EventTransitionSchema } from './event';
import { TimestampSchema, UuidSchema } from './shared';

/**
 * Owns the immutable journal-entry variant vocabulary. There are no update or
 * delete variants; corrections and redactions append a new superseding entry.
 */
export const JournalEntryKindSchema = z.enum([
  'text',
  'photo',
  'location',
  'system',
]);

/** Append-only journal-entry kind inferred from its schema. */
export type JournalEntryKind = z.infer<typeof JournalEntryKindSchema>;

/**
 * Owns the persisted correction-versus-redaction vocabulary for append-only
 * journal supersession records.
 */
export const JournalSupersessionKindSchema = z.enum([
  'correction',
  'redaction',
]);

/** Journal supersession kind inferred from its schema. */
export type JournalSupersessionKind = z.infer<
  typeof JournalSupersessionKindSchema
>;

/**
 * Owns explicit correction or redaction provenance. The referenced entry and
 * its earlier sequence are repeated so contracts and composite database keys
 * can reject cross-event or forward supersession.
 */
export const JournalSupersessionSchema = z
  .object({
    entryId: UuidSchema,
    entrySequence: z.number().int().positive(),
    kind: JournalSupersessionKindSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .readonly();

/** Append-only supersession provenance inferred from its schema. */
export type JournalSupersession = z.infer<typeof JournalSupersessionSchema>;

/**
 * Owns the three explicit location states. Coordinates are never inferred
 * from photo EXIF; ambiguous and unknown locations remain first-class truth.
 */
export const LocationPayloadSchema = z
  .union([
    z
      .object({
        state: z.literal('known'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracyMeters: z.number().finite().nonnegative(),
        label: z.string().trim().min(1).max(200).nullable(),
      })
      .strict(),
    z
      .object({
        state: z.literal('ambiguous'),
        label: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(1).max(500),
      })
      .strict(),
    z
      .object({
        state: z.literal('unknown'),
        reason: z.string().trim().min(1).max(500),
      })
      .strict(),
  ])
  .readonly();

/** Explicit journal location payload inferred from its schema. */
export type LocationPayload = z.infer<typeof LocationPayloadSchema>;

/**
 * Owns the bounded system-event vocabulary written to the operational
 * journal. Security audit events remain in their separate hash-chained log.
 */
export const SystemJournalCodeSchema = z.enum([
  'event-created',
  'event-activated',
  'participant-joined',
  'all-clear-issued',
  'event-reactivated',
  'event-closed',
  'correction-opened',
  'notification-intent-recorded',
]);

/** Operational system-journal code inferred from its schema. */
export type SystemJournalCode = z.infer<typeof SystemJournalCodeSchema>;

const systemJournalSummarySchema = z.string().trim().min(1).max(1_000);

/**
 * Owns server-authored operational journal payloads. Lifecycle entries embed
 * the complete validated transition that created them; informational entries
 * may reference a related immutable record but cannot impersonate lifecycle
 * truth with a free-form code and summary.
 */
export const SystemJournalPayloadSchema = z
  .union([
    z
      .object({
        code: z.enum([
          'event-created',
          'participant-joined',
          'notification-intent-recorded',
        ]),
        summary: systemJournalSummarySchema,
        relatedRecordId: UuidSchema.nullable(),
      })
      .strict(),
    z
      .object({
        code: z.literal('event-activated'),
        summary: systemJournalSummarySchema,
        transition: EventTransitionSchema,
      })
      .strict(),
    z
      .object({
        code: z.literal('all-clear-issued'),
        summary: systemJournalSummarySchema,
        transition: EventTransitionSchema,
      })
      .strict(),
    z
      .object({
        code: z.literal('event-reactivated'),
        summary: systemJournalSummarySchema,
        transition: EventTransitionSchema,
      })
      .strict(),
    z
      .object({
        code: z.literal('event-closed'),
        summary: systemJournalSummarySchema,
        transition: EventTransitionSchema,
      })
      .strict(),
    z
      .object({
        code: z.literal('correction-opened'),
        summary: systemJournalSummarySchema,
        transition: EventTransitionSchema,
      })
      .strict(),
  ])
  .superRefine((payload, context) => {
    if (!('transition' in payload)) {
      return;
    }
    const transitionByCode = {
      'event-activated': 'activate',
      'all-clear-issued': 'all-clear',
      'event-reactivated': 'reactivate',
      'event-closed': 'close',
      'correction-opened': 'reopen-as-correction',
    } as const;
    if (payload.transition.transition !== transitionByCode[payload.code]) {
      context.addIssue({
        code: 'custom',
        message: 'Lifecycle journal code must match its validated transition.',
        path: ['transition', 'transition'],
      });
    }
  })
  .readonly();

/** Server-authored operational journal payload inferred from its schema. */
export type SystemJournalPayload = z.infer<typeof SystemJournalPayloadSchema>;

const journalCommonShape = {
  id: UuidSchema,
  eventId: EventIdSchema,
  sequence: z.number().int().positive(),
  author: ActorSchema,
  /**
   * Who wrote this, by name, for whoever is reading the timeline.
   *
   * An actor identifies an account; it does not say who that is. During an
   * incident the person reading an update has to know immediately who sent it,
   * and "Authenticated staff member" on every entry does not answer that.
   *
   * Resolved when the entry is read rather than copied in when it is written,
   * so a corrected name is correct everywhere rather than frozen into history.
   * Null when there is no name to show -- the system actor, or an account that
   * no longer resolves -- and readers fall back to the actor's kind.
   */
  authorDisplayName: z.string().trim().min(1).max(200).nullable(),
  source: InvocationSourceSchema,
  serverTime: TimestampSchema,
  clientTime: TimestampSchema.nullable(),
  supersedes: JournalSupersessionSchema.nullable(),
};

function isSameActor(left: Actor, right: Actor): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'human':
      return (
        right.kind === 'human' &&
        left.userId === right.userId &&
        left.sessionId === right.sessionId
      );
    case 'agent':
      return (
        right.kind === 'agent' &&
        left.agentId === right.agentId &&
        left.apiKeyId === right.apiKeyId
      );
    case 'system':
      return right.kind === 'system' && left.serviceId === right.serviceId;
  }
}

/**
 * Owns the append-only operational journal entry. Variant payloads are strict,
 * server time is authoritative, client time remains evidence only, and any
 * correction or redaction points backward with complete provenance.
 */
export const JournalEntrySchema = z
  .union([
    z
      .object({
        ...journalCommonShape,
        kind: z.literal('text'),
        payload: z
          .object({ text: z.string().trim().min(1).max(10_000) })
          .strict()
          .readonly(),
      })
      .strict(),
    z
      .object({
        ...journalCommonShape,
        kind: z.literal('photo'),
        payload: z
          .object({
            mediaId: UuidSchema,
            altText: z.string().trim().min(1).max(500),
            caption: z.string().trim().min(1).max(2_000).nullable(),
          })
          .strict()
          .readonly(),
      })
      .strict(),
    z
      .object({
        ...journalCommonShape,
        kind: z.literal('location'),
        payload: LocationPayloadSchema,
      })
      .strict(),
    z
      .object({
        ...journalCommonShape,
        kind: z.literal('system'),
        payload: SystemJournalPayloadSchema,
      })
      .strict(),
  ])
  .superRefine((entry, context) => {
    if (!isActorSourceCompatible(entry.author, entry.source)) {
      context.addIssue({
        code: 'custom',
        message: 'Journal author and invocation source are incompatible.',
        path: ['source'],
      });
    }
    if (entry.supersedes) {
      if (entry.supersedes.entryId === entry.id) {
        context.addIssue({
          code: 'custom',
          message: 'A journal entry cannot supersede itself.',
          path: ['supersedes', 'entryId'],
        });
      }
      if (entry.supersedes.entrySequence >= entry.sequence) {
        context.addIssue({
          code: 'custom',
          message: 'A journal entry may supersede only an earlier sequence.',
          path: ['supersedes', 'entrySequence'],
        });
      }
    }
    if (entry.kind === 'system') {
      if (entry.supersedes !== null) {
        context.addIssue({
          code: 'custom',
          message: 'System lifecycle facts cannot supersede journal history.',
          path: ['supersedes'],
        });
      }
      if ('transition' in entry.payload) {
        const transitionEventId =
          entry.payload.transition.transition === 'reopen-as-correction'
            ? entry.payload.transition.correctionEventId
            : entry.payload.transition.eventId;
        if (transitionEventId !== entry.eventId) {
          context.addIssue({
            code: 'custom',
            message: 'Lifecycle transition must belong to the journal event.',
            path: ['payload', 'transition'],
          });
        }
        if (
          !isSameActor(entry.payload.transition.actor, entry.author) ||
          entry.payload.transition.source !== entry.source ||
          entry.payload.transition.occurredAt !== entry.serverTime
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Lifecycle journal provenance must match its validated transition.',
            path: ['payload', 'transition'],
          });
        }
      }
    }
  })
  .readonly();

/** Strict, frozen append-only journal entry inferred from its schema. */
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

const journalEntryInputCommonShape = {
  eventId: EventIdSchema,
  clientTime: TimestampSchema.nullable(),
  supersedes: JournalSupersessionSchema.nullable(),
};

/**
 * Owns externally accepted journal-write input. System entries are
 * deliberately absent: only trusted lifecycle and persistence code may build
 * a `JournalEntrySchema` system fact after validating its source transition.
 */
export const JournalEntryInputSchema = z
  .union([
    z
      .object({
        ...journalEntryInputCommonShape,
        kind: z.literal('text'),
        payload: z
          .object({ text: z.string().trim().min(1).max(10_000) })
          .strict()
          .readonly(),
      })
      .strict(),
    z
      .object({
        ...journalEntryInputCommonShape,
        kind: z.literal('photo'),
        payload: z
          .object({
            mediaId: UuidSchema,
            altText: z.string().trim().min(1).max(500),
            caption: z.string().trim().min(1).max(2_000).nullable(),
          })
          .strict()
          .readonly(),
      })
      .strict(),
    z
      .object({
        ...journalEntryInputCommonShape,
        kind: z.literal('location'),
        payload: LocationPayloadSchema,
      })
      .strict(),
  ])
  .readonly();

/** Externally accepted non-system journal-write input inferred from schema. */
export type JournalEntryInput = z.infer<typeof JournalEntryInputSchema>;
