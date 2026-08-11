import { z } from 'zod';

import { PaginationCursorSchema } from './api';
import { ActorSchema, InvocationSourceSchema } from './capability';
import { EventIdSchema, EventSchema } from './event';
import { EventTypeVersionIdSchema, TemplateModeSchema } from './event-type';
import { FacilityIdSchema } from './facility';
import {
  JournalEntryKindSchema,
  JournalEntrySchema,
  JournalSupersessionSchema,
  type JournalEntry,
} from './journal';
import { TimestampSchema, UuidSchema } from './shared';

const journalReadMetadataSchema = z
  .object({
    id: UuidSchema,
    eventId: EventIdSchema,
    sequence: z.number().int().positive(),
    kind: JournalEntryKindSchema,
    author: ActorSchema,
    source: InvocationSourceSchema,
    serverTime: TimestampSchema,
    clientTime: TimestampSchema.nullable(),
    supersedes: JournalSupersessionSchema.nullable(),
  })
  .strict()
  .readonly();

/**
 * Owns the outward read projection for immutable journal history. Visible
 * entries carry the canonical persisted entry. A redacted original retains
 * sequence, kind, actor, timing, and supersession provenance, but has no
 * payload field at all: text, media IDs, captions, coordinates, labels, and
 * payload reasons therefore cannot escape through web or agent read APIs.
 */
export const JournalEntryReadProjectionSchema = z
  .discriminatedUnion('visibility', [
    z
      .object({
        visibility: z.literal('visible'),
        entry: JournalEntrySchema,
      })
      .strict(),
    z
      .object({
        visibility: z.literal('redacted'),
        entry: journalReadMetadataSchema.refine(
          (entry) => entry.kind !== 'system',
          'System journal facts cannot be content-redacted.',
        ),
      })
      .strict(),
  ])
  .readonly();

/** Outward journal read projection inferred from its canonical schema. */
export type JournalEntryReadProjection = z.infer<
  typeof JournalEntryReadProjectionSchema
>;

/** Builds the only canonical outward projection of a persisted entry. */
export function projectJournalEntryForRead(
  entry: JournalEntry,
  redacted: boolean,
): JournalEntryReadProjection {
  if (!redacted) {
    return JournalEntryReadProjectionSchema.parse({
      visibility: 'visible',
      entry,
    });
  }
  const {
    id,
    eventId,
    sequence,
    kind,
    author,
    source,
    serverTime,
    clientTime,
    supersedes,
  } = entry;
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'redacted',
    entry: {
      id,
      eventId,
      sequence,
      kind,
      author,
      source,
      serverTime,
      clientTime,
      supersedes,
    },
  });
}

/**
 * Owns one bounded, event-scoped event-room synchronization request. The
 * cursor is opaque to clients and is decoded and event-bound by the server.
 */
export const SyncEventRoomInputSchema = z
  .object({
    eventId: EventIdSchema,
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Event-room synchronization input inferred from its canonical schema. */
export type SyncEventRoomInput = z.infer<typeof SyncEventRoomInputSchema>;

/**
 * Owns the trusted labels needed to render an event-room heading without a
 * second, mutable configuration lookup. The event-type ID is the immutable
 * version ID pinned by the event, not a latest-version pointer.
 */
export const EventRoomHeaderSchema = z
  .object({
    facility: z
      .object({
        id: FacilityIdSchema,
        code: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .regex(/^[A-Z0-9-]+$/u),
        name: z.string().trim().min(1).max(160),
      })
      .strict()
      .readonly(),
    eventType: z
      .object({
        id: EventTypeVersionIdSchema,
        name: z.string().trim().min(1).max(160),
        templateMode: TemplateModeSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

/** Trusted event-room heading inferred from its canonical schema. */
export type EventRoomHeader = z.infer<typeof EventRoomHeaderSchema>;

/**
 * Owns one coherent event-room snapshot and ordered journal delta. The trusted
 * header is present on every page and is read from the same database snapshot
 * as the event and entries. A null event means the caller's already-rendered
 * event projection remains current for this page; it never means that
 * authorization or event existence was inferred client-side.
 * `snapshotSequence` is the journal head observed in that same snapshot.
 * `cursor` is always the durable resume position (including at the live edge),
 * not nullable `pageInfo.nextCursor`; `hasMore` only controls immediate drain.
 */
export const EventRoomSyncResultSchema = z
  .object({
    eventId: EventIdSchema,
    header: EventRoomHeaderSchema,
    event: EventSchema.nullable(),
    entries: z.array(JournalEntryReadProjectionSchema).max(200).readonly(),
    cursor: PaginationCursorSchema,
    hasMore: z.boolean(),
    snapshotSequence: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.event !== null && result.event.id !== result.eventId) {
      context.addIssue({
        code: 'custom',
        message: 'Event-room projection must match the synchronized event.',
        path: ['event', 'id'],
      });
    }
    if (
      result.event !== null &&
      result.header.facility.id !== result.event.facilityId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Event-room facility heading must match the event.',
        path: ['header', 'facility', 'id'],
      });
    }
    if (
      result.event !== null &&
      result.header.eventType.id !== result.event.eventTypeVersion.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Event-room type heading must use the pinned event version.',
        path: ['header', 'eventType', 'id'],
      });
    }
    if (
      result.event !== null &&
      (result.header.eventType.templateMode !== result.event.templateMode ||
        result.header.eventType.templateMode !==
          result.event.eventTypeVersion.templateMode)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Event-room type heading must preserve event template mode.',
        path: ['header', 'eventType', 'templateMode'],
      });
    }

    let previousSequence = 0;
    result.entries.forEach((projection, index) => {
      const { entry } = projection;
      if (entry.eventId !== result.eventId) {
        context.addIssue({
          code: 'custom',
          message: 'Event-room entries must belong to the synchronized event.',
          path: ['entries', index, 'entry', 'eventId'],
        });
      }
      if (entry.sequence <= previousSequence) {
        context.addIssue({
          code: 'custom',
          message: 'Event-room entries must be strictly sequence ordered.',
          path: ['entries', index, 'entry', 'sequence'],
        });
      }
      if (entry.sequence > result.snapshotSequence) {
        context.addIssue({
          code: 'custom',
          message: 'Event-room entries cannot exceed their snapshot head.',
          path: ['entries', index, 'entry', 'sequence'],
        });
      }
      previousSequence = entry.sequence;
    });

    if (result.hasMore && result.entries.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A continued event-room page must return progress.',
        path: ['hasMore'],
      });
    }
  })
  .readonly();

/** Coherent event-room snapshot inferred from its canonical schema. */
export type EventRoomSyncResult = z.infer<typeof EventRoomSyncResultSchema>;
