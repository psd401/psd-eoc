import { describe, expect, test } from 'bun:test';
import {
  EventRoomSyncResultSchema,
  JournalEntryReadProjectionSchema,
  type Event,
  type EventRoomHeader,
  type JournalEntryReadProjection,
} from '@psd-eoc/contracts';

import {
  ANNOUNCEMENT_LATEST_TEXT_LIMIT,
  ANNOUNCEMENT_THROTTLE_MILLISECONDS,
  EMPTY_EVENT_ROOM_MODEL,
  TimelineAnnouncementBatcher,
  adjustKnownLocation,
  applyConfirmedMutation,
  applyEventRoomPage,
  formatAccuracyRadius,
  formatLocationPayload,
  isEventComposerVisible,
  isNearLiveEdge,
  retainPendingTimelineFollow,
} from './model';

const ids = {
  event: '00000000-0000-4000-8000-000000000101',
  facility: '00000000-0000-4000-8000-000000000102',
  type: '00000000-0000-4000-8000-000000000103',
  roster: '00000000-0000-4000-8000-000000000104',
  user: '00000000-0000-4000-8000-000000000105',
  session: '00000000-0000-4000-8000-000000000106',
};

const event: Event = {
  id: ids.event,
  facilityId: ids.facility,
  kind: 'drill',
  templateMode: 'drill',
  eventTypeVersion: { id: ids.type, templateMode: 'drill' },
  status: 'active',
  rosterSnapshotId: ids.roster,
  rosterPopulation: 'staff',
  createdBy: {
    kind: 'human',
    userId: ids.user,
    sessionId: ids.session,
  },
  createdAt: '2026-08-11T18:00:00.000Z',
  activatedAt: '2026-08-11T18:00:01.000Z',
  allClearAt: null,
  reactivatedAt: null,
  closedAt: null,
  correctionOfEventId: null,
  correctionReason: null,
  activationAuthorization: {
    kind: 'human-confirmed',
    activationPreviewId: '00000000-0000-4000-8000-000000000107',
    preparedActivationId: null,
    confirmationId: '00000000-0000-4000-8000-000000000108',
    consequenceDigest: 'a'.repeat(64),
    requestId: '00000000-0000-4000-8000-000000000109',
  },
};

const header: EventRoomHeader = {
  facility: { id: ids.facility, code: 'SYN', name: 'Synthetic School' },
  eventType: { id: ids.type, name: 'Lockdown drill', templateMode: 'drill' },
};

const allClearEvent: Event = {
  ...event,
  status: 'all-clear',
  allClearAt: '2026-08-11T18:00:03.000Z',
};

const closedEvent: Event = {
  ...allClearEvent,
  status: 'closed',
  closedAt: '2026-08-11T18:00:04.000Z',
};

function textEntry(sequence: number): JournalEntryReadProjection {
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'visible',
    entry: {
      id: `00000000-0000-4000-8000-${String(200 + sequence).padStart(12, '0')}`,
      eventId: ids.event,
      sequence,
      kind: 'text',
      author: {
        kind: 'human',
        userId: ids.user,
        sessionId: ids.session,
      },
      source: 'mobile',
      serverTime: `2026-08-11T18:00:${String(sequence).padStart(2, '0')}.000Z`,
      clientTime: null,
      payload: { text: `Update ${sequence}` },
      supersedes: null,
    },
  });
}

function page(
  entries: readonly JournalEntryReadProjection[],
  hasMore: boolean,
  includeEvent: boolean,
) {
  return EventRoomSyncResultSchema.parse({
    eventId: ids.event,
    event: includeEvent ? event : null,
    header,
    entries,
    cursor: Buffer.from(
      `cursor-${entries.at(-1)?.entry.sequence ?? 0}`,
    ).toString('base64url'),
    hasMore,
    snapshotSequence: entries.at(-1)?.entry.sequence ?? 0,
  });
}

describe('event-room model', () => {
  test('drains late-join pages in order and deduplicates replayed entries', () => {
    const first = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1), textEntry(2)], true, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    expect(first.historyComplete).toBe(false);
    const second = applyEventRoomPage(
      first,
      page([textEntry(3), textEntry(4)], false, false),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    expect(second.entries.map(({ entry }) => entry.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(second.historyComplete).toBe(true);
    const replay = applyEventRoomPage(
      second,
      page([textEntry(4)], false, false),
      {
        initialCatchUp: false,
        nearLiveEdge: false,
      },
    );
    expect(replay.entries).toHaveLength(4);
    expect(replay.unseenUpdateCount).toBe(0);
  });

  test('accepts refreshed trusted labels without changing room identity', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const renamed = EventRoomSyncResultSchema.parse({
      ...page([textEntry(2)], false, false),
      header: {
        facility: {
          ...header.facility,
          code: 'SYN-2',
          name: 'Renamed Synthetic School',
        },
        eventType: { ...header.eventType, name: 'Updated lockdown label' },
      },
    });

    const updated = applyEventRoomPage(hydrated, renamed, {
      initialCatchUp: false,
      nearLiveEdge: true,
    });
    expect(updated.header).toEqual(renamed.header);

    const wrongIdentity = EventRoomSyncResultSchema.parse({
      ...page([], false, false),
      header: {
        ...header,
        facility: {
          ...header.facility,
          id: '00000000-0000-4000-8000-000000000999',
        },
      },
    });
    expect(() =>
      applyEventRoomPage(updated, wrongIdentity, {
        initialCatchUp: false,
        nearLiveEdge: true,
      }),
    ).toThrow('identity');
  });

  test('poll updates do not request auto-follow away from the live edge', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const updated = applyEventRoomPage(
      hydrated,
      page([textEntry(2), textEntry(3)], false, false),
      { initialCatchUp: false, nearLiveEdge: false },
    );
    expect(updated.unseenUpdateCount).toBe(2);
    expect(isNearLiveEdge(2_000, 600, 1_330)).toBe(true);
    expect(isNearLiveEdge(2_000, 600, 800)).toBe(false);
    expect(retainPendingTimelineFollow(true, false)).toBe(false);
    expect(retainPendingTimelineFollow(true, true)).toBe(true);
    expect(isEventComposerVisible('location', 'location', 'active')).toBe(true);
    expect(isEventComposerVisible('location', 'location', 'closed')).toBe(
      false,
    );
  });

  test('preserves reported GPS accuracy through pin correction', () => {
    const captured = {
      state: 'known' as const,
      latitude: 47.385,
      longitude: -122.62,
      accuracyMeters: 37.41,
      label: 'Synthetic hallway',
    };
    const adjusted = adjustKnownLocation(captured, 'north', 5);
    expect(adjusted.latitude).toBeGreaterThan(captured.latitude);
    expect(adjusted.accuracyMeters).toBe(37.41);
    expect(formatAccuracyRadius(37.41)).toBe('±37.5 metres');
    expect(formatLocationPayload(adjusted)).toContain(
      'GPS does not establish room-level location.',
    );
  });

  test('renders ambiguous and unknown location truth without coordinates', () => {
    expect(
      formatLocationPayload({
        state: 'ambiguous',
        label: 'Near the gym',
        reason: 'The caller could not identify which entrance',
      }),
    ).toContain('Coordinates and accuracy unavailable.');
    expect(
      formatLocationPayload({
        state: 'unknown',
        reason: 'No safe location information is available',
      }),
    ).toContain('Location unknown.');
  });

  test('coalesces a poll burst into one throttled announcement', () => {
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const announcements: string[] = [];
    const batcher = new TimelineAnnouncementBatcher(
      (message) => announcements.push(message),
      {
        schedule(callback, delay) {
          callbacks.push(callback);
          delays.push(delay);
          return callback;
        },
        cancel() {},
      },
    );
    batcher.enqueue([textEntry(1), textEntry(2)]);
    batcher.enqueue([textEntry(3)]);
    expect(delays).toEqual([ANNOUNCEMENT_THROTTLE_MILLISECONDS]);
    expect(announcements).toEqual([]);
    callbacks[0]?.();
    expect(announcements).toEqual(['3 new timeline updates. Latest: Update 3']);
  });

  test('bounds announcement text while leaving the append-only entry intact', () => {
    const callbacks: Array<() => void> = [];
    const announcements: string[] = [];
    const longEntry = JournalEntryReadProjectionSchema.parse({
      ...textEntry(1),
      entry: {
        ...textEntry(1).entry,
        payload: { text: 'A'.repeat(1_000) },
      },
    });
    const batcher = new TimelineAnnouncementBatcher(
      (message) => announcements.push(message),
      {
        schedule(callback) {
          callbacks.push(callback);
          return callback;
        },
        cancel() {},
      },
    );

    batcher.enqueue([longEntry]);
    callbacks[0]?.();

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toEndWith('…');
    expect(announcements[0]?.length).toBeLessThanOrEqual(
      '1 new timeline update. Latest: '.length + ANNOUNCEMENT_LATEST_TEXT_LIMIT,
    );
    if (longEntry.visibility !== 'visible' || longEntry.entry.kind !== 'text') {
      throw new Error('Synthetic long timeline entry lost its text shape.');
    }
    expect(longEntry.entry.payload).toEqual({ text: 'A'.repeat(1_000) });
  });

  test('hides a previously loaded payload when append-only redaction arrives', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const redaction = JournalEntryReadProjectionSchema.parse({
      visibility: 'visible',
      entry: {
        id: '00000000-0000-4000-8000-000000000299',
        eventId: ids.event,
        sequence: 2,
        kind: 'text',
        author: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.session,
        },
        source: 'mobile',
        serverTime: '2026-08-11T18:00:02.000Z',
        clientTime: null,
        payload: {
          text: '[Content redacted — original retained in journal]',
        },
        supersedes: {
          entryId: textEntry(1).entry.id,
          entrySequence: 1,
          kind: 'redaction',
          reason: 'Synthetic content was posted to the wrong event room',
        },
      },
    });
    const updated = applyEventRoomPage(
      hydrated,
      page([redaction], false, false),
      { initialCatchUp: false, nearLiveEdge: true },
    );

    expect(updated.entries[0]?.visibility).toBe('redacted');
    expect(JSON.stringify(updated.entries[0])).not.toContain('Update 1');
    expect(updated.entries[1]).toEqual(redaction);
  });

  test('retains unseen remote updates when applying a confirmed local post', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const remote = applyEventRoomPage(
      hydrated,
      page([textEntry(2)], false, false),
      { initialCatchUp: false, nearLiveEdge: false },
    );
    const posted = applyConfirmedMutation(remote, null, [textEntry(3)]);

    expect(posted.unseenUpdateCount).toBe(1);
    expect(posted.snapshotSequence).toBe(3);
    expect(posted.entries.map(({ entry }) => entry.sequence)).toEqual([
      1, 2, 3,
    ]);
  });

  test('does not let a delayed pre-all-clear poll regress confirmed status', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const confirmed = applyConfirmedMutation(hydrated, allClearEvent, [
      textEntry(3),
    ]);
    const delayedActivePage = EventRoomSyncResultSchema.parse({
      ...page([textEntry(2)], false, false),
      event,
      snapshotSequence: 2,
    });
    const afterDelay = applyEventRoomPage(confirmed, delayedActivePage, {
      initialCatchUp: false,
      nearLiveEdge: true,
    });

    expect(afterDelay.event?.status).toBe('all-clear');
    expect(afterDelay.snapshotSequence).toBe(3);
    expect(afterDelay.entries.map(({ entry }) => entry.sequence)).toEqual([
      1, 2, 3,
    ]);
  });

  test('does not let a delayed all-clear response regress a later close', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const closed = applyConfirmedMutation(hydrated, closedEvent, [
      textEntry(4),
    ]);
    const afterDelayedAllClear = applyConfirmedMutation(closed, allClearEvent, [
      textEntry(3),
    ]);

    expect(afterDelayedAllClear.event?.status).toBe('closed');
    expect(afterDelayedAllClear.snapshotSequence).toBe(4);
    expect(
      afterDelayedAllClear.entries.map(({ entry }) => entry.sequence),
    ).toEqual([1, 3, 4]);
  });

  test('accepts a terminal lifecycle projection after an eventless page observes its journal head', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const intermediate = EventRoomSyncResultSchema.parse({
      ...page([textEntry(2)], true, false),
      snapshotSequence: 3,
    });
    const afterIntermediate = applyEventRoomPage(hydrated, intermediate, {
      initialCatchUp: false,
      nearLiveEdge: true,
    });
    expect(afterIntermediate.event?.status).toBe('active');
    expect(afterIntermediate.snapshotSequence).toBe(3);
    expect(afterIntermediate.eventSnapshotSequence).toBe(1);

    const terminal = EventRoomSyncResultSchema.parse({
      ...page([textEntry(3)], false, false),
      event: allClearEvent,
      snapshotSequence: 3,
    });
    const complete = applyEventRoomPage(afterIntermediate, terminal, {
      initialCatchUp: false,
      nearLiveEdge: true,
    });

    expect(complete.event?.status).toBe('all-clear');
    expect(complete.eventSnapshotSequence).toBe(3);
  });

  test('rejects a continuation page for a different event', () => {
    const hydrated = applyEventRoomPage(
      EMPTY_EVENT_ROOM_MODEL,
      page([textEntry(1)], false, true),
      { initialCatchUp: true, nearLiveEdge: true },
    );
    const other = EventRoomSyncResultSchema.parse({
      eventId: '00000000-0000-4000-8000-000000000999',
      event: null,
      header,
      entries: [],
      cursor: 'other_event_cursor',
      hasMore: false,
      snapshotSequence: 0,
    });

    expect(() =>
      applyEventRoomPage(hydrated, other, {
        initialCatchUp: false,
        nearLiveEdge: true,
      }),
    ).toThrow('different event room');
  });
});
