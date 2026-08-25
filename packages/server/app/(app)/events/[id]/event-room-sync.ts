'use client';

import {
  RECENT_PRIVATE_PHOTO_WORKING_SET_SIZE,
  SELECTED_PRIVATE_PHOTO_RECENT_WORKING_SET_SIZE,
} from './event-room-media';
import {
  compareJournalEntryReadProjections as compareEntries,
  type Event,
  type JournalEntryReadProjection,
  mergeJournalEntryReadProjections,
} from '@psd-eoc/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  eventRoomPollDelay,
  EventRoomRequestError,
  type MutationResult,
  requestTimelinePage,
  type TimelineContinuation,
  waitForDocumentVisibility,
  waitForNextPoll,
} from './event-room-transport';

const ANNOUNCEMENT_BATCH_MILLISECONDS = 5_000;

export type ConnectionState =
  | 'loading'
  | 'connected'
  | 'reconnecting'
  | 'offline';

interface EventRoomSyncOptions {
  readonly event: Event;
  readonly initialEntries: readonly JournalEntryReadProjection[];
  readonly initialCursor: string | null;
  readonly initialSnapshotSequence: number;
  readonly initialHasMore: boolean;
  readonly apiUrl: string;
}

export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'loading':
      return 'Loading event history';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting';
    case 'offline':
      return 'Offline — updates may be delayed';
  }
}

export function useEventRoomSync({
  event,
  initialEntries,
  initialCursor,
  initialSnapshotSequence,
  initialHasMore,
  apiUrl,
}: EventRoomSyncOptions) {
  const [currentEvent, setCurrentEvent] = useState(event);
  const currentEventRef = useRef(event);
  const [entries, setEntries] = useState<readonly JournalEntryReadProjection[]>(
    () => [...initialEntries].sort(compareEntries),
  );
  const [selectedOlderPhotoEntryId, setSelectedOlderPhotoEntryId] = useState<
    string | null
  >(null);
  const [visibleLocationMapEntryId, setVisibleLocationMapEntryId] = useState<
    string | null
  >(null);
  const [pendingOlderPhotoEntryId, setPendingOlderPhotoEntryId] = useState<
    string | null
  >(null);
  const [connection, setConnection] = useState<ConnectionState>(() =>
    initialHasMore ? 'loading' : 'connected',
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(initialHasMore);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<Readonly<{
    id: number;
    message: string;
  }> | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const [pollRefreshVersion, setPollRefreshVersion] = useState(0);

  const cursorRef = useRef(initialCursor);
  const appliedSnapshotSequenceRef = useRef(initialSnapshotSequence);
  const requiredSyncSequenceRef = useRef<number | null>(null);
  const entriesRef = useRef(entries);
  const announcementCountRef = useRef(0);
  const announcementSequenceRef = useRef(0);
  const announcementTimerRef = useRef<number | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const pendingRef = useRef(false);

  const queueAnnouncement = useCallback((count: number) => {
    if (count <= 0) return;
    announcementCountRef.current += count;
    if (announcementTimerRef.current !== null) return;
    announcementTimerRef.current = window.setTimeout(() => {
      const total = announcementCountRef.current;
      announcementCountRef.current = 0;
      announcementTimerRef.current = null;
      announcementSequenceRef.current += 1;
      setAnnouncement({
        id: announcementSequenceRef.current,
        message: `${total} new timeline ${total === 1 ? 'update' : 'updates'} received.`,
      });
    }, ANNOUNCEMENT_BATCH_MILLISECONDS);
  }, []);

  useEffect(
    () => () => {
      if (announcementTimerRef.current !== null) {
        window.clearTimeout(announcementTimerRef.current);
      }
    },
    [],
  );

  const isNearTimelineEnd = useCallback((): boolean => {
    const region = timelineScrollRef.current;
    if (region === null) return true;
    return region.scrollHeight - region.scrollTop - region.clientHeight < 96;
  }, []);

  const mergeIncomingEntries = useCallback(
    (incoming: readonly JournalEntryReadProjection[], announce: boolean) => {
      const existing = entriesRef.current;
      const merged = mergeJournalEntryReadProjections(existing, incoming);
      const existingIds = new Set(existing.map(({ entry }) => entry.id));
      const addedCount = merged.filter(
        ({ entry }) => !existingIds.has(entry.id),
      ).length;
      entriesRef.current = merged;
      setEntries(merged);
      if (addedCount === 0) return;
      const nearEnd = isNearTimelineEnd();
      autoScrollRef.current = nearEnd;
      if (!nearEnd) setUnseenCount((count) => count + addedCount);
      if (announce) queueAnnouncement(addedCount);
    },
    [isNearTimelineEnd, queueAnnouncement],
  );

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      timelineEndRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries.length]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let drainInitialHistory = initialHasMore && pollRefreshVersion === 0;
    let loadImmediately = initialHasMore || pollRefreshVersion > 0;
    let consecutiveFailures = 0;
    let continuation: TimelineContinuation | null = null;

    async function poll(): Promise<void> {
      while (active && !controller.signal.aborted) {
        const wasHidden = document.visibilityState === 'hidden';
        const visible = await waitForDocumentVisibility(controller.signal);
        if (!visible) return;
        if (wasHidden) loadImmediately = true;
        if (!loadImmediately) {
          const continued = await waitForNextPoll(
            controller.signal,
            eventRoomPollDelay(consecutiveFailures),
          );
          if (!continued) return;
          if (document.visibilityState === 'hidden') continue;
        }
        loadImmediately = false;
        try {
          const requestedBaseCursor =
            continuation?.baseCursor ?? cursorRef.current;
          const requestedCursor = continuation?.cursor ?? cursorRef.current;
          const page = await requestTimelinePage(
            apiUrl,
            requestedCursor,
            event,
            controller.signal,
          );
          if (!active) return;
          const mayApplySnapshot =
            cursorRef.current === requestedBaseCursor &&
            page.snapshotSequence >= appliedSnapshotSequenceRef.current;
          const requiredSyncSequence = requiredSyncSequenceRef.current;
          const reachesRequiredSync =
            requiredSyncSequence === null ||
            page.snapshotSequence >= requiredSyncSequence;
          if (!mayApplySnapshot || !reachesRequiredSync) {
            const waitingForRequiredSync =
              requiredSyncSequence !== null && !reachesRequiredSync;
            const mustDrainBeforeShowingTimeline =
              requiredSyncSequence !== null ||
              drainInitialHistory ||
              continuation !== null ||
              page.hasMore ||
              page.entries.length > 0;
            continuation = null;
            setLoadingHistory(mustDrainBeforeShowingTimeline);
            consecutiveFailures =
              requiredSyncSequence === null ? 0 : consecutiveFailures + 1;
            setConnection(
              waitingForRequiredSync ? 'reconnecting' : 'connected',
            );
            setLastUpdatedAt(new Date().toISOString());
            setPollMessage(
              waitingForRequiredSync
                ? 'Waiting for the complete confirmed timeline projection.'
                : null,
            );
            loadImmediately =
              requiredSyncSequence === null && !pendingRef.current;
            continue;
          }

          if (
            continuation !== null &&
            (page.snapshotSequence < continuation.snapshotSequence ||
              page.entries.length === 0 ||
              page.entries[0]?.entry.sequence !==
                continuation.entries.at(-1)!.entry.sequence + 1)
          ) {
            throw new EventRoomRequestError(
              'PSD EOC returned a broken timeline continuation. Previously displayed state remains unchanged.',
              false,
            );
          }

          const completeEntries =
            continuation === null
              ? page.entries
              : [...continuation.entries, ...page.entries];
          consecutiveFailures = 0;
          setConnection('connected');
          setLastUpdatedAt(new Date().toISOString());
          setPollMessage(null);

          if (page.hasMore) {
            continuation = {
              baseCursor: requestedBaseCursor,
              cursor: page.cursor,
              entries: completeEntries,
              snapshotSequence: page.snapshotSequence,
            };
            setLoadingHistory(true);
            loadImmediately = true;
            continue;
          }

          cursorRef.current = page.cursor;
          appliedSnapshotSequenceRef.current = page.snapshotSequence;
          if (
            requiredSyncSequenceRef.current !== null &&
            page.snapshotSequence >= requiredSyncSequenceRef.current
          ) {
            requiredSyncSequenceRef.current = null;
          }
          if (page.event !== null) {
            currentEventRef.current = page.event;
            setCurrentEvent(page.event);
          }
          mergeIncomingEntries(completeEntries, !drainInitialHistory);
          continuation = null;
          if (drainInitialHistory) drainInitialHistory = false;
          setLoadingHistory(false);
        } catch (error) {
          if (controller.signal.aborted || !active) return;
          consecutiveFailures += 1;
          setConnection(consecutiveFailures > 1 ? 'offline' : 'reconnecting');
          setPollMessage(
            error instanceof Error
              ? error.message
              : 'Timeline updates are temporarily unavailable.',
          );
        }
      }
    }

    void poll();
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    apiUrl,
    event.id,
    initialHasMore,
    mergeIncomingEntries,
    pollRefreshVersion,
  ]);

  const supersessionsByEntry = useMemo(() => {
    const result = new Map<string, JournalEntryReadProjection[]>();
    for (const projection of entries) {
      const targetId = projection.entry.supersedes?.entryId;
      if (targetId === undefined) continue;
      const existing = result.get(targetId) ?? [];
      existing.push(projection);
      existing.sort(compareEntries);
      result.set(targetId, existing);
    }
    return result;
  }, [entries]);

  const visiblePrivatePhotoEntryIds = useMemo(
    () =>
      entries
        .filter(
          (projection) =>
            projection.visibility === 'visible' &&
            projection.entry.kind === 'photo' &&
            !(supersessionsByEntry.get(projection.entry.id) ?? []).some(
              (candidate) => candidate.entry.supersedes?.kind === 'redaction',
            ),
        )
        .map(({ entry }) => entry.id),
    [entries, supersessionsByEntry],
  );

  const automaticPrivatePhotoEntryIds = useMemo(() => {
    const recentCapacity =
      selectedOlderPhotoEntryId === null && pendingOlderPhotoEntryId === null
        ? RECENT_PRIVATE_PHOTO_WORKING_SET_SIZE
        : SELECTED_PRIVATE_PHOTO_RECENT_WORKING_SET_SIZE;
    return new Set(
      visiblePrivatePhotoEntryIds
        .filter((entryId) => entryId !== selectedOlderPhotoEntryId)
        .slice(-recentCapacity),
    );
  }, [
    pendingOlderPhotoEntryId,
    selectedOlderPhotoEntryId,
    visiblePrivatePhotoEntryIds,
  ]);

  useEffect(() => {
    if (pendingOlderPhotoEntryId === null) return;
    if (
      visiblePrivatePhotoEntryIds.includes(pendingOlderPhotoEntryId) &&
      !automaticPrivatePhotoEntryIds.has(pendingOlderPhotoEntryId)
    ) {
      setSelectedOlderPhotoEntryId(pendingOlderPhotoEntryId);
    }
    setPendingOlderPhotoEntryId(null);
  }, [
    automaticPrivatePhotoEntryIds,
    pendingOlderPhotoEntryId,
    visiblePrivatePhotoEntryIds,
  ]);

  useEffect(() => {
    if (selectedOlderPhotoEntryId === null) return;
    const selected = entries.find(
      ({ entry }) => entry.id === selectedOlderPhotoEntryId,
    );
    const redacted = (
      supersessionsByEntry.get(selectedOlderPhotoEntryId) ?? []
    ).some(({ entry }) => entry.supersedes?.kind === 'redaction');
    if (
      selected?.visibility !== 'visible' ||
      selected.entry.kind !== 'photo' ||
      redacted
    ) {
      setSelectedOlderPhotoEntryId(null);
    }
  }, [entries, selectedOlderPhotoEntryId, supersessionsByEntry]);

  const applyMutationResult = useCallback(
    (result: MutationResult): 'applied' | 'refreshing' => {
      const orderedEntries = [...result.entries].sort(compareEntries);
      const resultHead = orderedEntries.reduce(
        (head, projection) => Math.max(head, projection.entry.sequence),
        0,
      );
      // A poll can observe a later coherent lifecycle commit while this POST's
      // response is delayed. Journal sequence is monotonic, so never let an
      // older mutation projection regress that newer room state.
      const appliedHead = appliedSnapshotSequenceRef.current;
      if (resultHead <= appliedHead) return 'applied';
      const isContiguousSuffix = orderedEntries.every(
        ({ entry }, index) => entry.sequence === appliedHead + index + 1,
      );
      if (!isContiguousSuffix) {
        // Another operator committed one or more facts before this mutation.
        // Preserve the last coherent room until a complete durable-cursor sync.
        if (result.event !== null) currentEventRef.current = result.event;
        setLoadingHistory(true);
        setConnection('reconnecting');
        setPollMessage(
          'A concurrent timeline update is being synchronized before the confirmed result is shown.',
        );
        requiredSyncSequenceRef.current = Math.max(
          requiredSyncSequenceRef.current ?? 0,
          resultHead,
        );
        setPollRefreshVersion((version) => version + 1);
        return 'refreshing';
      }
      if (result.event !== null) {
        currentEventRef.current = result.event;
        setCurrentEvent(result.event);
      }
      appliedSnapshotSequenceRef.current = resultHead;
      autoScrollRef.current = true;
      setUnseenCount(0);
      mergeIncomingEntries(orderedEntries, false);
      return 'applied';
    },
    [mergeIncomingEntries],
  );

  const jumpToLatest = useCallback((): void => {
    autoScrollRef.current = true;
    setUnseenCount(0);
    timelineEndRef.current?.scrollIntoView({ block: 'end' });
    timelineEndRef.current?.focus();
  }, []);

  const acknowledgeVisibleTimelineEnd = useCallback((): void => {
    if (isNearTimelineEnd()) setUnseenCount(0);
  }, [isNearTimelineEnd]);

  return {
    currentEvent,
    currentEventRef,
    entries,
    connection,
    lastUpdatedAt,
    loadingHistory,
    pollMessage,
    announcement,
    unseenCount,
    timelineScrollRef,
    timelineEndRef,
    autoScrollRef,
    pendingRef,
    supersessionsByEntry,
    visiblePrivatePhotoEntryIds,
    automaticPrivatePhotoEntryIds,
    selectedOlderPhotoEntryId,
    setSelectedOlderPhotoEntryId,
    visibleLocationMapEntryId,
    setVisibleLocationMapEntryId,
    setPendingOlderPhotoEntryId,
    applyMutationResult,
    jumpToLatest,
    acknowledgeVisibleTimelineEnd,
  };
}
