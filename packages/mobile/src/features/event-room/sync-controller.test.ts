import { describe, expect, test } from 'bun:test';
import {
  EventRoomSyncResultSchema,
  JournalEntryReadProjectionSchema,
  type EventRoomSyncResult,
} from '@psd-eoc/contracts';

import {
  ANNOUNCEMENT_THROTTLE_MILLISECONDS,
  POLL_INTERVAL_MILLISECONDS,
  type AnnouncementScheduler,
} from './model';
import {
  EventRoomSyncController,
  type EventRoomPollScheduler,
  type EventRoomSyncPort,
} from './sync-controller';
import { AuthenticatedRequestFailure } from '../../lib/api';

const IDS = Object.freeze({
  event: '00000000-0000-4000-8000-000000000401',
  facility: '00000000-0000-4000-8000-000000000402',
  eventType: '00000000-0000-4000-8000-000000000403',
  roster: '00000000-0000-4000-8000-000000000404',
  user: '00000000-0000-4000-8000-000000000405',
  session: '00000000-0000-4000-8000-000000000406',
  preview: '00000000-0000-4000-8000-000000000407',
  confirmation: '00000000-0000-4000-8000-000000000408',
  request: '00000000-0000-4000-8000-000000000409',
});

const EVENT = Object.freeze({
  id: IDS.event,
  facilityId: IDS.facility,
  kind: 'drill' as const,
  templateMode: 'drill' as const,
  eventTypeVersion: { id: IDS.eventType, templateMode: 'drill' as const },
  status: 'active' as const,
  rosterSnapshotId: IDS.roster,
  rosterPopulation: 'staff' as const,
  createdBy: {
    kind: 'human' as const,
    userId: IDS.user,
    sessionId: IDS.session,
  },
  createdAt: '2026-08-11T18:00:00.000Z',
  activatedAt: '2026-08-11T18:00:01.000Z',
  allClearAt: null,
  reactivatedAt: null,
  closedAt: null,
  correctionOfEventId: null,
  correctionReason: null,
  activationAuthorization: {
    kind: 'human-confirmed' as const,
    activationPreviewId: IDS.preview,
    preparedActivationId: null,
    confirmationId: IDS.confirmation,
    consequenceDigest: 'a'.repeat(64),
    requestId: IDS.request,
  },
});

const HEADER = Object.freeze({
  facility: { id: IDS.facility, code: 'SYN', name: 'Synthetic School' },
  eventType: {
    id: IDS.eventType,
    name: 'Synthetic safety drill',
    templateMode: 'drill' as const,
  },
});

function entry(sequence: number) {
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'visible',
    entry: {
      id: `00000000-0000-4000-8000-${String(500 + sequence).padStart(12, '0')}`,
      eventId: IDS.event,
      sequence,
      kind: 'text',
      author: EVENT.createdBy,
      authorDisplayName: null,
      source: 'mobile',
      serverTime: `2026-08-11T18:00:${String(sequence).padStart(2, '0')}.000Z`,
      clientTime: null,
      payload: { text: `Update ${sequence}` },
      supersedes: null,
    },
  });
}

function page(
  entries: readonly ReturnType<typeof entry>[],
  cursor: string,
  hasMore: boolean,
  event: typeof EVENT | null,
): EventRoomSyncResult {
  return EventRoomSyncResultSchema.parse({
    eventId: IDS.event,
    header: HEADER,
    event,
    entries,
    cursor,
    hasMore,
    snapshotSequence: entries.at(-1)?.entry.sequence ?? 0,
  });
}

function manualScheduler() {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const scheduler: EventRoomPollScheduler = {
    schedule(callback, delay) {
      callbacks.push(callback);
      delays.push(delay);
      return callback;
    },
    cancel(handle) {
      const index = callbacks.indexOf(handle as () => void);
      if (index >= 0) callbacks.splice(index, 1);
    },
  };
  return { callbacks, delays, scheduler };
}

function manualAnnouncementScheduler() {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const scheduler: AnnouncementScheduler = {
    schedule(callback, delay) {
      callbacks.push(callback);
      delays.push(delay);
      return callback;
    },
    cancel(handle) {
      const index = callbacks.indexOf(handle as () => void);
      if (index >= 0) callbacks.splice(index, 1);
    },
  };
  return { callbacks, delays, scheduler };
}

describe('event-room sync controller', () => {
  test('serially drains full late-join history before polling', async () => {
    const calls: Array<string | null> = [];
    const pages = [
      page([entry(1)], 'cursor_1', true, EVENT),
      page([entry(2)], 'cursor_2', false, null),
    ];
    const api: EventRoomSyncPort = {
      async sync(_eventId, cursor) {
        calls.push(cursor);
        const next = pages.shift();
        if (next === undefined) throw new Error('unexpected sync');
        return next;
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      () => {},
      timer.scheduler,
    );

    await controller.start();

    expect(calls).toEqual([null, 'cursor_1']);
    expect(
      controller.getSnapshot().model.entries.map(({ entry }) => entry.sequence),
    ).toEqual([1, 2]);
    expect(controller.getSnapshot().model.historyComplete).toBe(true);
    expect(controller.getSnapshot().phase).toBe('live');
    expect(timer.delays).toEqual([POLL_INTERVAL_MILLISECONDS]);
    controller.stop();
  });

  test('coalesces refresh with an in-flight poll and anchors away from live edge', async () => {
    let resolvePoll: ((value: EventRoomSyncResult) => void) | null = null;
    let concurrent = 0;
    let maximumConcurrent = 0;
    let callCount = 0;
    const api: EventRoomSyncPort = {
      async sync() {
        callCount += 1;
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        try {
          if (callCount === 1) return page([], 'cursor_0', false, EVENT);
          return await new Promise<EventRoomSyncResult>((resolve) => {
            resolvePoll = resolve;
          });
        } finally {
          concurrent -= 1;
        }
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      () => {},
      timer.scheduler,
    );
    await controller.start();
    controller.setNearLiveEdge(false);
    timer.callbacks.shift()?.();
    await Promise.resolve();

    const refresh = controller.refresh();
    expect(callCount).toBe(2);
    expect(maximumConcurrent).toBe(1);
    const finishPoll = resolvePoll as
      | ((value: EventRoomSyncResult) => void)
      | null;
    if (finishPoll === null) throw new Error('poll did not start');
    finishPoll(page([entry(1)], 'cursor_1', false, null));
    await refresh;

    expect(controller.getSnapshot().model.unseenUpdateCount).toBe(1);
    expect(controller.getSnapshot().refreshing).toBe(false);
    expect(maximumConcurrent).toBe(1);
    controller.stop();
  });

  test('aborts and retains the immutable model when paused', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    let callCount = 0;
    const api: EventRoomSyncPort = {
      async sync(_eventId, _cursor, signal) {
        callCount += 1;
        if (callCount === 1) return page([entry(1)], 'cursor_1', false, EVENT);
        captured.signal = signal ?? null;
        return new Promise<EventRoomSyncResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('synthetic abort')),
            { once: true },
          );
        });
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      () => {},
      timer.scheduler,
    );
    await controller.start();
    timer.callbacks.shift()?.();
    await Promise.resolve();
    controller.pause();

    expect(captured.signal?.aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(controller.getSnapshot().model.entries).toHaveLength(1);
  });

  test('resumes incomplete catch-up silently after a partial failure', async () => {
    const calls: Array<string | null> = [];
    let callCount = 0;
    const announcements: string[] = [];
    const api: EventRoomSyncPort = {
      async sync(_eventId, cursor) {
        calls.push(cursor);
        callCount += 1;
        if (callCount === 1) {
          return page([entry(1)], 'cursor_1', true, EVENT);
        }
        if (callCount === 2) throw new Error('synthetic page outage');
        return page([entry(2)], 'cursor_2', false, null);
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      (message) => announcements.push(message),
      timer.scheduler,
    );

    await controller.start();
    expect(controller.getSnapshot().model.historyComplete).toBe(false);
    expect(controller.getSnapshot().phase).toBe('error');
    await controller.refresh();

    expect(calls).toEqual([null, 'cursor_1', 'cursor_1']);
    expect(controller.getSnapshot().model.historyComplete).toBe(true);
    expect(
      controller.getSnapshot().model.entries.map(({ entry }) => entry.sequence),
    ).toEqual([1, 2]);
    expect(announcements).toEqual([]);
    controller.stop();
  });

  test('tells the operator to update when it cannot read the response', async () => {
    const api: EventRoomSyncPort = {
      async sync() {
        throw new AuthenticatedRequestFailure(
          'invalid-response',
          'PSD EOC returned a response this app cannot read.',
          200,
        );
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      () => {},
      timer.scheduler,
    );

    await controller.start();

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('error');
    // A body this build cannot parse fails identically on every poll, so
    // "reconnect and pull to refresh" would send the operator into a loop.
    expect(snapshot.error).toContain('Update the PSD EOC app');
    controller.stop();
  });

  test('still reports a recoverable interruption as temporarily unavailable', async () => {
    const api: EventRoomSyncPort = {
      async sync() {
        throw new AuthenticatedRequestFailure('network', 'Network failure.');
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      () => {},
      timer.scheduler,
    );

    await controller.start();

    expect(controller.getSnapshot().error).toContain(
      'temporarily unavailable',
    );
    controller.stop();
  });

  test('fails closed instead of looping on a non-progressing cursor', async () => {
    let callCount = 0;
    const api: EventRoomSyncPort = {
      async sync() {
        callCount += 1;
        return callCount === 1
          ? page([entry(1)], 'cursor_1', true, EVENT)
          : page([entry(2)], 'cursor_1', true, null);
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      () => {},
      timer.scheduler,
    );

    await controller.start();

    expect(callCount).toBe(2);
    expect(controller.getSnapshot().phase).toBe('error');
    expect(controller.getSnapshot().model.historyComplete).toBe(false);
    controller.stop();
  });

  test('waits for an aborted poll then immediately synchronizes on resume', async () => {
    let callCount = 0;
    const api: EventRoomSyncPort = {
      async sync(_eventId, _cursor, signal) {
        callCount += 1;
        if (callCount === 1) return page([entry(1)], 'cursor_1', false, EVENT);
        if (callCount === 2) {
          return new Promise<EventRoomSyncResult>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('synthetic abort')),
              { once: true },
            );
          });
        }
        return page([entry(2)], 'cursor_2', false, null);
      },
    };
    const timer = manualScheduler();
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      () => {},
      timer.scheduler,
    );
    await controller.start();
    timer.callbacks.shift()?.();
    await Promise.resolve();

    controller.pause();
    await controller.start();

    expect(callCount).toBe(3);
    expect(controller.getSnapshot().phase).toBe('live');
    expect(controller.getSnapshot().model.entries).toHaveLength(2);
    controller.stop();
  });

  test('announces resume and manual-refresh updates only after history is complete', async () => {
    const pages = [
      page([], 'cursor_0', false, EVENT),
      page([entry(1)], 'cursor_1', false, null),
      page([entry(2)], 'cursor_2', false, null),
    ];
    const api: EventRoomSyncPort = {
      async sync() {
        const next = pages.shift();
        if (next === undefined) throw new Error('unexpected sync');
        return next;
      },
    };
    const poll = manualScheduler();
    const announcement = manualAnnouncementScheduler();
    const messages: string[] = [];
    const controller = new EventRoomSyncController(
      IDS.event,
      api,
      (message) => messages.push(message),
      poll.scheduler,
      announcement.scheduler,
    );

    await controller.start();
    expect(announcement.callbacks).toHaveLength(0);
    controller.pause();
    await controller.start();
    expect(announcement.delays).toEqual([ANNOUNCEMENT_THROTTLE_MILLISECONDS]);
    announcement.callbacks.shift()?.();
    expect(messages).toEqual(['1 new timeline update. Latest: Update 1']);

    await controller.refresh();
    announcement.callbacks.shift()?.();
    expect(messages).toEqual([
      '1 new timeline update. Latest: Update 1',
      '1 new timeline update. Latest: Update 2',
    ]);
    controller.stop();
  });
});
