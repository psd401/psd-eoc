import { z } from 'zod';

import { PaginationCursorSchema } from './api';
import { ActorSchema, InvocationSourceSchema } from './capability';
import { EventIdSchema, EventSchema, type Event } from './event';
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

/**
 * Serializes only the immutable identity and classification fields of an
 * event. Lifecycle timestamps and status intentionally remain outside this
 * projection because they advance while an event room is open.
 */
export function immutableEventIdentity(event: Event): string {
  return JSON.stringify({
    id: event.id,
    facilityId: event.facilityId,
    kind: event.kind,
    templateMode: event.templateMode,
    eventTypeVersion: event.eventTypeVersion,
    rosterSnapshotId: event.rosterSnapshotId,
    rosterPopulation: event.rosterPopulation,
    createdBy: event.createdBy,
    createdAt: event.createdAt,
    correctionOfEventId: event.correctionOfEventId,
    correctionReason: event.correctionReason,
    activationAuthorization: event.activationAuthorization,
  });
}

/** True when two projections identify the same immutable event room. */
export function hasSameImmutableEventIdentity(
  left: Event,
  right: Event,
): boolean {
  return immutableEventIdentity(left) === immutableEventIdentity(right);
}

/** Canonical sequence-first ordering for every event-room client. */
export function compareJournalEntryReadProjections(
  left: JournalEntryReadProjection,
  right: JournalEntryReadProjection,
): number {
  const sequenceDifference = left.entry.sequence - right.entry.sequence;
  return sequenceDifference !== 0
    ? sequenceDifference
    : left.entry.id.localeCompare(right.entry.id);
}

function projectJournalReadMetadata(
  entry: JournalEntryReadProjection['entry'],
): z.infer<typeof journalReadMetadataSchema> {
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
  return {
    id,
    eventId,
    sequence,
    kind,
    author,
    source,
    serverTime,
    clientTime,
    supersedes,
  };
}

function redactProjection(
  projection: JournalEntryReadProjection,
): JournalEntryReadProjection {
  if (projection.visibility === 'redacted') return projection;
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'redacted',
    entry: projectJournalReadMetadata(projection.entry),
  });
}

/**
 * Merges append-only journal projections without permitting an already-read
 * fact to change. The sole allowed projection change is visible-to-redacted,
 * which can arrive either directly or through an append-only redaction entry.
 */
export function mergeJournalEntryReadProjections(
  existing: readonly JournalEntryReadProjection[],
  incoming: readonly JournalEntryReadProjection[],
): readonly JournalEntryReadProjection[] {
  const byId = new Map(
    existing.map((projection) => {
      const parsed = JournalEntryReadProjectionSchema.parse(projection);
      return [parsed.entry.id, parsed] as const;
    }),
  );
  for (const projection of incoming) {
    const parsed = JournalEntryReadProjectionSchema.parse(projection);
    const prior = byId.get(parsed.entry.id);
    if (
      prior !== undefined &&
      JSON.stringify(prior) !== JSON.stringify(parsed)
    ) {
      const visibleToRedacted =
        prior.visibility === 'visible' &&
        parsed.visibility === 'redacted' &&
        JSON.stringify(redactProjection(prior)) === JSON.stringify(parsed);
      if (!visibleToRedacted) {
        throw new Error(
          'An immutable timeline entry changed after it was read.',
        );
      }
    }
    byId.set(parsed.entry.id, parsed);
  }

  // A live delta carries the append-only redaction fact, not a rewritten
  // target row. Hide the target as soon as that provenance arrives.
  for (const projection of byId.values()) {
    const supersession = projection.entry.supersedes;
    if (supersession?.kind !== 'redaction') continue;
    const target = byId.get(supersession.entryId);
    if (
      target === undefined ||
      target.entry.sequence !== supersession.entrySequence
    ) {
      continue;
    }
    byId.set(target.entry.id, redactProjection(target));
  }

  const merged = [...byId.values()].sort(compareJournalEntryReadProjections);
  for (let index = 1; index < merged.length; index += 1) {
    const previous = merged[index - 1];
    const current = merged[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.entry.sequence === current.entry.sequence
    ) {
      throw new Error('The event timeline contains a duplicate sequence.');
    }
  }
  return Object.freeze(merged);
}

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
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'redacted',
    entry: projectJournalReadMetadata(entry),
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
