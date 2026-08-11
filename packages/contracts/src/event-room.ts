import { z } from 'zod';

import { PaginationCursorSchema } from './api';
import { EventIdSchema, EventSchema } from './event';
import { JournalEntrySchema } from './journal';

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
 * Owns one coherent event-room snapshot and ordered journal delta. A null
 * event means the caller's already-rendered event projection remains current
 * for this page; it never means that authorization or event existence was
 * inferred client-side. `snapshotSequence` is the journal head observed in
 * the same database snapshot as the event projection and returned entries.
 */
export const EventRoomSyncResultSchema = z
  .object({
    eventId: EventIdSchema,
    event: EventSchema.nullable(),
    entries: z.array(JournalEntrySchema).max(200).readonly(),
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

    let previousSequence = 0;
    result.entries.forEach((entry, index) => {
      if (entry.eventId !== result.eventId) {
        context.addIssue({
          code: 'custom',
          message: 'Event-room entries must belong to the synchronized event.',
          path: ['entries', index, 'eventId'],
        });
      }
      if (entry.sequence <= previousSequence) {
        context.addIssue({
          code: 'custom',
          message: 'Event-room entries must be strictly sequence ordered.',
          path: ['entries', index, 'sequence'],
        });
      }
      if (entry.sequence > result.snapshotSequence) {
        context.addIssue({
          code: 'custom',
          message: 'Event-room entries cannot exceed their snapshot head.',
          path: ['entries', index, 'sequence'],
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
