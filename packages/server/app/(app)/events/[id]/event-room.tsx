'use client';

import {
  getEventClassificationPresentation,
  MediaContentTypeSchema,
  compareJournalEntryReadProjections as compareEntries,
  type Event,
  type JournalEntryReadProjection,
  mergeJournalEntryReadProjections,
} from '@psd-eoc/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import { DialogClassification } from './event-room-classification';
import { type DialogState, PreviewDetails } from './event-room-lifecycle';
import {
  EMPTY_LOCATION_DRAFT,
  type LocationDraft,
  locationDraftFromPayload,
  LocationEditor,
  locationPayloadFromDraft,
} from './event-room-location';
import {
  ACCEPTED_MEDIA_TYPES,
  completePhotoUpload,
  createPhotoUploadIntent,
  MAX_MEDIA_BYTES,
  MediaWorkflowError,
  PrivatePhotoLoadCoordinator,
  putPhotoBytes,
  RECENT_PRIVATE_PHOTO_WORKING_SET_SIZE,
  SELECTED_PRIVATE_PHOTO_RECENT_WORKING_SET_SIZE,
  validatePhotoFile,
} from './event-room-media';
import { readableDateTime, TimelineEntry } from './event-room-timeline';
import {
  clearMatchingPhotoCompletion,
  clearPendingPhotoCompletion,
  clearRetainedCommand,
  type CommandBody,
  commandLabel,
  type CommandOperation,
  eventRoomPollDelay,
  EventRoomRequestError,
  makePendingPhotoCompletion,
  makeRetainedCommand,
  type MutationResult,
  parseMutationResult,
  type PendingPhotoCompletion,
  photoCompletionStorageKey,
  postRetainedCommand,
  readPendingPhotoCompletion,
  readRetainedCommand,
  recordCompletedPhotoMedia,
  recoveryStorageKey,
  requestLifecyclePreview,
  requestTimelinePage,
  retainCommand,
  type RetainedCommand,
  type RetainedCommandDispatchOutcome,
  retainedPhotoCommandMatches,
  retainPendingPhotoCompletion,
  type TimelineContinuation,
  waitForDocumentVisibility,
  waitForNextPoll,
  webLifecycleCommandBody,
} from './event-room-transport';

const ANNOUNCEMENT_BATCH_MILLISECONDS = 5_000;

type ConnectionState = 'loading' | 'connected' | 'reconnecting' | 'offline';

export interface EventRoomProps {
  /** Canonical, facility-authorized event returned by the capability layer. */
  readonly event: Event;
  /** First chronological journal page; every item remains immutable. */
  readonly initialEntries: readonly JournalEntryReadProjection[];
  /** Durable opaque resume token supplied by sync-event-room. */
  readonly initialCursor: string | null;
  /** Journal head observed atomically with the server-rendered event. */
  readonly initialSnapshotSequence: number;
  /** True when the client must drain more history before announcing updates. */
  readonly initialHasMore: boolean;
  /** Authorized display label; never used for authorization or mutation input. */
  readonly facilityLabel: string;
  /** Pinned event-type-version label; never used as classification input. */
  readonly eventTypeLabel: string;
  /** Same-origin event-room endpoint for timeline reads and explicit commands. */
  readonly apiUrl: string;
  /** Same-origin, freshly authorized read-only event-summary export route. */
  readonly exportSummaryPath: string;
  /** Name of the readable double-submit CSRF cookie issued by the server. */
  readonly csrfCookieName: string;
  /** Server-authenticated session that owns the idempotency namespace. */
  readonly sessionId: string;
  /** Authenticated staff display name used only for the editable alt default. */
  readonly authorDisplayName: string;
  /** Configured IANA time zone used consistently during SSR and hydration. */
  readonly displayTimeZone: string;
}

function statusLabel(event: Event): string {
  switch (event.status) {
    case 'draft':
      return 'Draft';
    case 'active':
      return 'Active';
    case 'all-clear':
      return 'All-clear issued';
    case 'closed':
      return 'Closed';
  }
}

function eventAcceptsJournalPosts(event: Event): boolean {
  return event.status === 'active' || event.status === 'all-clear';
}

function connectionLabel(state: ConnectionState): string {
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

function formatElapsed(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (totalMinutes < 1) return 'Less than 1 minute';
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  }
  return parts.join(', ');
}

function useElapsedLabel(event: Event): string | null {
  const startedAt = event.activatedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null || event.closedAt !== null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [event.closedAt, startedAt]);
  if (startedAt === null) return null;
  const end = event.closedAt === null ? now : Date.parse(event.closedAt);
  return formatElapsed(end - Date.parse(startedAt));
}

export function EventRoom({
  event,
  initialEntries,
  initialCursor,
  initialSnapshotSequence,
  initialHasMore,
  facilityLabel,
  eventTypeLabel,
  apiUrl,
  exportSummaryPath,
  csrfCookieName,
  sessionId,
  authorDisplayName,
  displayTimeZone,
}: EventRoomProps) {
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
  const [postText, setPostText] = useState('');
  const [locationDraft, setLocationDraft] =
    useState<LocationDraft>(EMPTY_LOCATION_DRAFT);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoAltText, setPhotoAltText] = useState('');
  const [photoCaption, setPhotoCaption] = useState('');
  const [photoWorkflowBusy, setPhotoWorkflowBusy] = useState(false);
  const [photoStatus, setPhotoStatus] = useState('');
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [pendingPhotoCompletion, setPendingPhotoCompletion] =
    useState<PendingPhotoCompletion | null>(null);
  const [photoRecoveryBlocked, setPhotoRecoveryBlocked] = useState(false);
  const [mutationStatus, setMutationStatus] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] =
    useState<CommandOperation | null>(null);
  const [retainedCommand, setRetainedCommand] =
    useState<RetainedCommand | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogText, setDialogText] = useState('');
  const [dialogLocationDraft, setDialogLocationDraft] =
    useState<LocationDraft>(EMPTY_LOCATION_DRAFT);
  const [dialogReason, setDialogReason] = useState('');
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogWasOpenRef = useRef(false);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const dialogRequestAttemptedRef = useRef(false);
  const mutationErrorRef = useRef<HTMLDivElement>(null);
  const dialogMutationErrorRef = useRef<HTMLDivElement>(null);
  const photoErrorRef = useRef<HTMLDivElement>(null);
  const photoFileRef = useRef<HTMLInputElement>(null);
  const photoWorkflowRef = useRef(false);
  const photoLoadCoordinatorRef = useRef<PrivatePhotoLoadCoordinator | null>(
    null,
  );
  if (photoLoadCoordinatorRef.current === null) {
    photoLoadCoordinatorRef.current = new PrivatePhotoLoadCoordinator();
  }
  const photoLoadCoordinator = photoLoadCoordinatorRef.current;

  const elapsed = useElapsedLabel(currentEvent);
  const realEvent = event.templateMode === 'real';
  const classification = getEventClassificationPresentation(event);
  const classificationLabel = classification.label;

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
      previewControllerRef.current?.abort();
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
          if (drainInitialHistory) {
            drainInitialHistory = false;
          }
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

  useEffect(() => {
    try {
      const retained = readRetainedCommand(event.id, apiUrl, sessionId);
      if (retained !== null) {
        setRetainedCommand(retained);
        setMutationStatus(
          `A previous ${commandLabel(retained.operation)} has an unresolved result. It was not retried automatically.`,
        );
      }
    } catch {
      setRecoveryBlocked(true);
      setMutationError(
        'PSD EOC could not read the browser recovery record. This page load sent no new request; any prior request outcome remains unresolved. Verify the current timeline before clearing it.',
      );
    }
  }, [apiUrl, event.id, sessionId]);

  useEffect(() => {
    try {
      const pending = readPendingPhotoCompletion(event.id, sessionId);
      if (pending === null) return;
      const retained = readRetainedCommand(event.id, apiUrl, sessionId);
      if (retained !== null) {
        if (!retainedPhotoCommandMatches(retained, pending)) {
          throw new Error(
            'Conflicting browser recovery records require explicit review.',
          );
        }
        clearPendingPhotoCompletion(pending);
        setPhotoStatus(
          'A completed photo-validation handoff was reconciled to the exact retained timeline post. Nothing was retried automatically.',
        );
        return;
      }
      setPendingPhotoCompletion(pending);
      setPhotoAltText(pending.altText);
      setPhotoCaption(pending.caption ?? '');
      setPhotoError(
        'A previous private photo validation has an unresolved result. It was not retried automatically.',
      );
      setPhotoStatus(
        'Verify the timeline, then explicitly retry the exact validation request or clear it.',
      );
    } catch {
      setPhotoRecoveryBlocked(true);
      setPhotoError(
        'PSD EOC could not read the private photo recovery record. This page load sent no request. Verify the current timeline before clearing it.',
      );
      setPhotoStatus('No photo request was retried automatically.');
    }
  }, [apiUrl, event.id, sessionId]);

  useEffect(() => {
    const element = dialogRef.current;
    if (element === null) return;
    if (dialog !== null) {
      if (!element.open) element.showModal();
      dialogWasOpenRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        const target = element.querySelector<HTMLElement>(
          '[data-autofocus]:not(:disabled)',
        );
        target?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (element.open) element.close();
    if (dialogWasOpenRef.current) {
      dialogWasOpenRef.current = false;
      const opener = dialogOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      if (document.activeElement !== opener) {
        document.getElementById('main-content')?.focus();
      }
    }
  }, [dialog]);

  useEffect(() => {
    if (mutationError === null) return;
    const target =
      dialog === null
        ? mutationErrorRef.current
        : dialogMutationErrorRef.current;
    target?.focus();
  }, [dialog, mutationError]);

  useEffect(() => {
    if (photoError === null || dialog !== null) return;
    photoErrorRef.current?.focus();
  }, [dialog, photoError]);

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

  const correctionDialogProjection =
    dialog?.kind === 'correct'
      ? entries.find(({ entry }) => entry.id === dialog.entryId)
      : undefined;
  const correctionDialogEntry =
    !loadingHistory &&
    correctionDialogProjection?.visibility === 'visible' &&
    (correctionDialogProjection.entry.kind === 'text' ||
      correctionDialogProjection.entry.kind === 'location') &&
    (supersessionsByEntry.get(correctionDialogProjection.entry.id)?.length ??
      0) === 0
      ? correctionDialogProjection.entry
      : null;
  const redactionDialogProjection =
    dialog?.kind === 'redact'
      ? entries.find(({ entry }) => entry.id === dialog.entryId)
      : undefined;
  const redactionDialogEntry =
    !loadingHistory &&
    redactionDialogProjection?.visibility === 'visible' &&
    redactionDialogProjection.entry.kind !== 'system' &&
    !(supersessionsByEntry.get(redactionDialogProjection.entry.id) ?? []).some(
      ({ entry }) => entry.supersedes?.kind === 'redaction',
    )
      ? redactionDialogProjection.entry
      : null;

  useEffect(() => {
    const invalidatedSequence =
      dialog?.kind === 'correct' && correctionDialogEntry === null
        ? dialog.entrySequence
        : dialog?.kind === 'redact' && redactionDialogEntry === null
          ? dialog.entrySequence
          : null;
    if (invalidatedSequence === null) return;
    const requestWasAttempted = dialogRequestAttemptedRef.current;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    dialogRequestAttemptedRef.current = false;
    setDialog(null);
    setDialogText('');
    setDialogLocationDraft(EMPTY_LOCATION_DRAFT);
    setDialogReason('');
    if (
      !requestWasAttempted &&
      !pendingRef.current &&
      retainedCommand === null
    ) {
      setMutationError(null);
      setMutationStatus(
        loadingHistory
          ? 'Timeline synchronization began while the dialog was open. No request was sent; review the complete timeline before trying again.'
          : `Entry ${invalidatedSequence} changed while the dialog was open. No request was sent; review the current timeline before trying again.`,
      );
    }
  }, [
    correctionDialogEntry,
    dialog,
    loadingHistory,
    redactionDialogEntry,
    retainedCommand,
  ]);

  const baseCommandsBlocked =
    loadingHistory ||
    pendingOperation !== null ||
    retainedCommand !== null ||
    recoveryBlocked;
  const commandsBlocked = baseCommandsBlocked || photoWorkflowBusy;
  const lifecycleCommandsBlocked = baseCommandsBlocked;
  const retainedLifecycleCommand =
    retainedCommand?.operation === 'all-clear' ||
    retainedCommand?.operation === 'close';
  const retainedPhotoRecoveryConflict =
    retainedCommand?.operation === 'post-photo' && photoRecoveryBlocked;

  useEffect(() => {
    const lifecycleDialog =
      dialog?.kind === 'all-clear' || dialog?.kind === 'close';
    if (!lifecycleDialog || pendingRef.current) return;
    const eventStateChanged =
      (dialog.kind === 'all-clear' && currentEvent.status !== 'active') ||
      (dialog.kind === 'close' && currentEvent.status !== 'all-clear');
    if (
      !loadingHistory &&
      retainedCommand === null &&
      !recoveryBlocked &&
      !eventStateChanged
    ) {
      return;
    }
    const requestWasAttempted = dialogRequestAttemptedRef.current;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    dialogRequestAttemptedRef.current = false;
    setDialog(null);
    setDialogText('');
    setDialogReason('');
    if (!requestWasAttempted && loadingHistory) {
      setMutationError(null);
      setMutationStatus(
        'Timeline synchronization began while the lifecycle review was open. No lifecycle transition request was submitted; reopen the action after the complete timeline is visible.',
      );
    } else if (!requestWasAttempted && eventStateChanged) {
      setMutationError(null);
      setMutationStatus(
        'The event state changed while the lifecycle review was open. No lifecycle transition request was submitted from this dialog; review the current state before starting another action.',
      );
    }
  }, [
    currentEvent.status,
    dialog,
    loadingHistory,
    recoveryBlocked,
    retainedCommand,
  ]);

  function openDialog(next: DialogState, opener: HTMLElement): void {
    const openingLifecycleDialog =
      next.kind === 'all-clear' || next.kind === 'close';
    if (openingLifecycleDialog ? lifecycleCommandsBlocked : commandsBlocked) {
      return;
    }
    const correctionTarget =
      next.kind === 'correct'
        ? entries.find(({ entry }) => entry.id === next.entryId)
        : undefined;
    dialogOpenerRef.current = opener;
    dialogRequestAttemptedRef.current = false;
    setMutationError(null);
    setMutationStatus('');
    setDialogText(
      correctionTarget?.visibility === 'visible' &&
        correctionTarget.entry.kind === 'text'
        ? correctionTarget.entry.payload.text
        : '',
    );
    setDialogLocationDraft(
      correctionTarget?.visibility === 'visible' &&
        correctionTarget.entry.kind === 'location'
        ? locationDraftFromPayload(correctionTarget.entry.payload)
        : EMPTY_LOCATION_DRAFT,
    );
    setDialogReason('');
    setDialog(next);
  }

  function closeDialog(): void {
    if (pendingRef.current) return;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    dialogRequestAttemptedRef.current = false;
    setDialog(null);
    setDialogText('');
    setDialogLocationDraft(EMPTY_LOCATION_DRAFT);
    setDialogReason('');
  }

  async function loadAllClearPreview(idempotencyKey: string): Promise<void> {
    previewControllerRef.current?.abort();
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setDialog((current) =>
      current?.kind === 'all-clear'
        ? {
            kind: 'all-clear',
            idempotencyKey,
            loading: true,
            preview: null,
            error: null,
          }
        : current,
    );
    try {
      const preview = await requestLifecyclePreview(
        apiUrl,
        event,
        csrfCookieName,
        idempotencyKey,
        controller.signal,
      );
      setDialog((current) =>
        current?.kind === 'all-clear' &&
        current.idempotencyKey === idempotencyKey
          ? {
              kind: 'all-clear',
              idempotencyKey,
              loading: false,
              preview,
              error: null,
            }
          : current,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setDialog((current) =>
        current?.kind === 'all-clear' &&
        current.idempotencyKey === idempotencyKey
          ? {
              kind: 'all-clear',
              idempotencyKey,
              loading: false,
              preview: null,
              error:
                error instanceof Error
                  ? error.message
                  : 'The all-clear preview could not be loaded. No notification was sent.',
            }
          : current,
      );
    }
  }

  function beginAllClear(opener: HTMLElement): void {
    const idempotencyKey = `event-room-preview-${crypto.randomUUID()}`;
    openDialog(
      {
        kind: 'all-clear',
        idempotencyKey,
        loading: true,
        preview: null,
        error: null,
      },
      opener,
    );
    void loadAllClearPreview(idempotencyKey);
  }

  function applyMutationResult(
    result: MutationResult,
  ): 'applied' | 'refreshing' {
    const orderedEntries = [...result.entries].sort(compareEntries);
    const resultHead = orderedEntries.reduce(
      (head, projection) => Math.max(head, projection.entry.sequence),
      0,
    );
    // A poll can observe a later coherent lifecycle commit while this POST's
    // response is delayed. Journal sequence is monotonic, so never let an
    // older mutation projection regress that newer room state.
    const appliedHead = appliedSnapshotSequenceRef.current;
    if (resultHead <= appliedHead) {
      return 'applied';
    }
    const isContiguousSuffix = orderedEntries.every(
      ({ entry }, index) => entry.sequence === appliedHead + index + 1,
    );
    if (!isContiguousSuffix) {
      // Another operator committed one or more facts before this mutation.
      // Keep the last coherent room visible only after a complete sync from
      // the durable cursor; never show a lifecycle state with a sequence gap.
      // The canonical mutation response can still tighten the photo-post
      // safety gate immediately (notably after a confirmed close) without
      // exposing that incomplete projection in the UI.
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
  }

  function clearCommandAfterResult(command: RetainedCommand): boolean {
    try {
      const photoRecoveryReconciled = clearMatchingPhotoCompletion(command);
      clearRetainedCommand(command);
      setRetainedCommand(null);
      if (command.operation === 'post-photo') {
        if (photoRecoveryReconciled) {
          setPendingPhotoCompletion(null);
          setPhotoRecoveryBlocked(false);
        } else {
          setPhotoRecoveryBlocked(true);
          setPhotoError(
            'The timeline post was confirmed, but a conflicting private photo recovery record still needs explicit review and clearing.',
          );
        }
      }
      return true;
    } catch {
      setMutationError(
        'The server confirmed the request, but this browser could not clear its recovery record. Verify the timeline before using the explicit recovery controls.',
      );
      return false;
    }
  }

  async function sendRetainedCommand(
    command: RetainedCommand,
  ): Promise<RetainedCommandDispatchOutcome> {
    if (pendingRef.current) return 'not-sent';
    if (
      dialog !== null &&
      command.operation !== 'post-text' &&
      command.operation !== 'post-photo' &&
      command.operation !== 'post-location'
    ) {
      dialogRequestAttemptedRef.current = true;
    }
    pendingRef.current = true;
    setPendingOperation(command.operation);
    setMutationError(null);
    setMutationStatus(`Sending ${commandLabel(command.operation)}…`);
    try {
      const response = await postRetainedCommand(command, csrfCookieName);
      const result = parseMutationResult(command, response, event);
      const projectionState = applyMutationResult(result);
      const cleared = clearCommandAfterResult(command);
      setMutationStatus(
        cleared
          ? projectionState === 'refreshing'
            ? `${commandLabel(command.operation)} confirmed by the server. Synchronizing the complete timeline before showing the result.`
            : `${commandLabel(command.operation)} confirmed by the server.`
          : `${commandLabel(command.operation)} confirmed; browser recovery cleanup needs attention.`,
      );
      return 'confirmed';
    } catch (error) {
      const requestError =
        error instanceof EventRoomRequestError
          ? error
          : new EventRoomRequestError(
              'PSD EOC could not verify the request result.',
              true,
            );
      if (!requestError.ambiguous) {
        try {
          clearRetainedCommand(command);
          setRetainedCommand(null);
        } catch {
          setRecoveryBlocked(true);
        }
      }
      setMutationError(requestError.message);
      setMutationStatus(
        requestError.ambiguous
          ? 'The outcome is unresolved. The exact request is retained and will never replay automatically.'
          : 'The request was not accepted. No change was recorded by this attempt.',
      );
      if (requestError.ambiguous && dialog !== null) {
        setDialog(null);
        setDialogText('');
        setDialogReason('');
      }
      return requestError.ambiguous ? 'ambiguous' : 'rejected';
    } finally {
      pendingRef.current = false;
      setPendingOperation(null);
    }
  }

  function prepareNewCommand(
    body: CommandBody,
    options: Readonly<{
      fromPhotoWorkflow?: boolean;
      idempotencyKey?: string;
    }> = {},
  ): RetainedCommand | null {
    const lifecycleOperation =
      body.operation === 'all-clear' || body.operation === 'close';
    if (
      baseCommandsBlocked ||
      ((photoWorkflowBusy || photoWorkflowRef.current) &&
        !options.fromPhotoWorkflow &&
        !lifecycleOperation) ||
      pendingRef.current
    ) {
      return null;
    }
    const command = makeRetainedCommand(
      event.id,
      apiUrl,
      sessionId,
      body,
      options.idempotencyKey,
    );
    try {
      retainCommand(command);
      setRetainedCommand(command);
    } catch {
      setRecoveryBlocked(true);
      setMutationError(
        'This browser could not retain an exact recovery request, so PSD EOC did not send anything.',
      );
      setMutationStatus('No request was sent.');
      if (dialog !== null) {
        setDialog(null);
        setDialogText('');
        setDialogReason('');
      }
      return null;
    }
    return command;
  }

  async function executeNewCommand(
    body: CommandBody,
    options: Readonly<{
      fromPhotoWorkflow?: boolean;
      idempotencyKey?: string;
    }> = {},
  ): Promise<boolean> {
    const command = prepareNewCommand(body, options);
    if (command === null) return false;
    return (await sendRetainedCommand(command)) === 'confirmed';
  }

  async function submitPost(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const text = postText.trim();
    if (text.length === 0) return;
    const succeeded = await executeNewCommand({
      operation: 'post-text',
      text,
      clientTime: new Date().toISOString(),
    });
    if (succeeded) setPostText('');
  }

  async function submitLocation(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const payload = locationPayloadFromDraft(locationDraft);
    if (payload === null) return;
    const succeeded = await executeNewCommand({
      operation: 'post-location',
      payload,
      clientTime: new Date().toISOString(),
    });
    if (succeeded) setLocationDraft(EMPTY_LOCATION_DRAFT);
  }

  async function completeAndPostPhoto(
    pending: PendingPhotoCompletion,
    alreadyLocked = false,
  ): Promise<void> {
    let recoveryPending = pending;
    if (!alreadyLocked) {
      if (photoWorkflowRef.current) return;
      photoWorkflowRef.current = true;
    }
    setPhotoWorkflowBusy(true);
    setPhotoError(null);
    setPhotoStatus('Validating the private photo and removing metadata…');
    try {
      const record = await completePhotoUpload(pending, csrfCookieName);
      try {
        recoveryPending = recordCompletedPhotoMedia(pending, record.id);
        setPendingPhotoCompletion(recoveryPending);
      } catch {
        try {
          recoveryPending =
            readPendingPhotoCompletion(
              pending.eventId,
              pending.ownerSessionId,
            ) ?? pending;
        } catch {
          // The explicit recovery controls remain blocked below.
        }
        setPhotoRecoveryBlocked(true);
        throw new MediaWorkflowError(
          'The photo validation was confirmed, but this browser could not retain the exact media evidence needed for a safe timeline handoff. No post was sent; verify the timeline before clearing recovery.',
          true,
        );
      }
      if (!eventAcceptsJournalPosts(currentEventRef.current)) {
        throw new MediaWorkflowError(
          'The photo was validated, but the event no longer accepts photo posts. No timeline post was sent; verify the timeline before clearing this completed photo attempt.',
          true,
        );
      }
      setPhotoStatus('Photo validated. Appending the timeline entry…');
      const command = prepareNewCommand(
        {
          operation: 'post-photo',
          mediaId: record.id,
          altText: recoveryPending.altText,
          caption: recoveryPending.caption,
          clientTime: recoveryPending.clientTime,
        },
        {
          fromPhotoWorkflow: true,
          idempotencyKey: recoveryPending.postIdempotencyKey,
        },
      );
      if (command === null) {
        throw new MediaWorkflowError(
          'The photo was validated, but this browser could not retain the exact timeline post. The validation request remains available and no post was sent.',
          true,
        );
      }
      try {
        clearPendingPhotoCompletion(recoveryPending);
      } catch {
        try {
          clearRetainedCommand(command);
          setRetainedCommand(null);
        } catch {
          setRecoveryBlocked(true);
        }
        setPhotoRecoveryBlocked(true);
        throw new MediaWorkflowError(
          'The photo was validated, but this browser could not safely transition from validation recovery to timeline-post recovery. No post was sent. Verify the timeline before clearing recovery records.',
          true,
        );
      }
      setPendingPhotoCompletion(null);
      setPhotoRecoveryBlocked(false);
      const dispatchOutcome = await sendRetainedCommand(command);
      if (dispatchOutcome === 'confirmed') {
        setPhotoFile(null);
        setPhotoAltText('');
        setPhotoCaption('');
        if (photoFileRef.current !== null) photoFileRef.current.value = '';
        setPhotoStatus('Photo post confirmed by the server.');
      } else if (dispatchOutcome === 'ambiguous') {
        setPhotoStatus(
          'Photo validation was confirmed. The exact timeline post result is unresolved and retained in browser request recovery; it will not retry automatically.',
        );
      } else if (dispatchOutcome === 'rejected') {
        setPhotoStatus(
          'Photo validation was confirmed, but the timeline post request was rejected. No photo timeline entry was posted.',
        );
      } else {
        setPhotoStatus(
          'Photo validation was confirmed, but the timeline post was not sent. The exact request remains in browser recovery.',
        );
      }
    } catch (error) {
      let workflowError =
        error instanceof MediaWorkflowError
          ? error
          : new MediaWorkflowError(
              'PSD EOC could not safely verify photo validation. The exact completion request remains available for explicit retry.',
              true,
            );
      let keepCompletion = workflowError.keepCompletion;
      if (!keepCompletion) {
        try {
          clearPendingPhotoCompletion(recoveryPending);
          setPendingPhotoCompletion(null);
          setPhotoRecoveryBlocked(false);
        } catch {
          keepCompletion = true;
          setPhotoRecoveryBlocked(true);
          workflowError = new MediaWorkflowError(
            `${workflowError.message} The browser could not clear its recovery record; verify the timeline before explicitly clearing it.`,
            true,
          );
        }
      }
      if (keepCompletion) setPendingPhotoCompletion(recoveryPending);
      setPhotoError(workflowError.message);
      setPhotoStatus(
        keepCompletion
          ? recoveryPending.mediaId === null
            ? 'Photo validation is unresolved. It will not retry automatically.'
            : 'Photo validation was confirmed, but no timeline post was confirmed. It will not retry automatically.'
          : 'No photo timeline entry was posted.',
      );
    } finally {
      if (!alreadyLocked) {
        photoWorkflowRef.current = false;
        setPhotoWorkflowBusy(false);
      }
    }
  }

  async function submitPhoto(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (
      photoFile === null ||
      pendingPhotoCompletion !== null ||
      photoRecoveryBlocked ||
      commandsBlocked ||
      !canPost ||
      photoWorkflowRef.current
    ) {
      return;
    }
    const altText = photoAltText.trim();
    const caption = photoCaption.trim();
    if (altText.length === 0) return;
    photoWorkflowRef.current = true;
    setPhotoWorkflowBusy(true);
    setPhotoError(null);
    setPhotoStatus('Preparing a private photo upload…');
    try {
      validatePhotoFile(photoFile);
      const intent = await createPhotoUploadIntent(
        photoFile,
        event.id,
        csrfCookieName,
      );
      if (!eventAcceptsJournalPosts(currentEventRef.current)) {
        throw new MediaWorkflowError(
          'The event no longer accepts photo posts. No private upload or timeline post was started.',
          false,
        );
      }
      setPhotoStatus('Uploading directly to private quarantine storage…');
      await putPhotoBytes(photoFile, intent);
      if (!eventAcceptsJournalPosts(currentEventRef.current)) {
        throw new MediaWorkflowError(
          'The event no longer accepts photo posts. The private upload will remain quarantined and no validation or timeline post was started.',
          false,
        );
      }
      const pending = makePendingPhotoCompletion(
        event.id,
        sessionId,
        intent.id,
        altText,
        caption.length === 0 ? null : caption,
        new Date().toISOString(),
      );
      try {
        retainPendingPhotoCompletion(pending);
      } catch {
        setPhotoRecoveryBlocked(true);
        throw new MediaWorkflowError(
          'This browser could not retain the exact photo-validation retry, so no completion request was sent. Verify the timeline before clearing the browser recovery record.',
          false,
        );
      }
      setPendingPhotoCompletion(pending);
      setPhotoRecoveryBlocked(false);
      await completeAndPostPhoto(pending, true);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'PSD EOC could not start the private photo upload.';
      setPhotoError(message);
      setPhotoStatus('No photo timeline entry was posted.');
    } finally {
      photoWorkflowRef.current = false;
      setPhotoWorkflowBusy(false);
    }
  }

  function selectPhoto(file: File | null): void {
    setPhotoFile(file);
    setPhotoError(null);
    setPhotoStatus('');
    if (file === null) {
      setPhotoAltText('');
      return;
    }
    setPhotoAltText(
      `Photo by ${authorDisplayName} at ${readableDateTime(new Date().toISOString(), displayTimeZone)}. Visual details were not described.`,
    );
    try {
      validatePhotoFile(file);
      setPhotoStatus(
        'Photo selected. File contents will be scanned, decoded, and rewritten before posting.',
      );
    } catch (error) {
      setPhotoError(
        error instanceof Error ? error.message : 'The photo is not valid.',
      );
    }
  }

  function retryPhotoValidation(): void {
    if (
      pendingPhotoCompletion === null ||
      photoWorkflowBusy ||
      !canPost ||
      photoRecoveryBlocked ||
      photoWorkflowRef.current
    ) {
      return;
    }
    void completeAndPostPhoto(pendingPhotoCompletion);
  }

  function clearPendingPhotoAttempt(): void {
    if (photoWorkflowBusy || photoWorkflowRef.current) return;
    try {
      if (pendingPhotoCompletion === null) {
        window.sessionStorage.removeItem(photoCompletionStorageKey(event.id));
      } else {
        clearPendingPhotoCompletion(pendingPhotoCompletion);
      }
      setPendingPhotoCompletion(null);
      setPhotoRecoveryBlocked(false);
      setPhotoAltText('');
      setPhotoCaption('');
      setPhotoError(null);
      setPhotoStatus(
        'Pending photo attempt cleared after timeline verification. No request was sent.',
      );
    } catch {
      setPhotoRecoveryBlocked(true);
      setPhotoError(
        'The browser could not clear the private photo recovery record. No request was sent.',
      );
      setPhotoStatus('Photo recovery remains blocked and will not auto-retry.');
    }
  }

  async function submitCorrection(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (dialog?.kind !== 'correct' || correctionDialogEntry === null) return;
    const reason = dialogReason.trim();
    if (reason.length === 0) return;
    const succeeded =
      correctionDialogEntry.kind === 'location'
        ? await (async () => {
            const payload = locationPayloadFromDraft(dialogLocationDraft);
            if (payload === null) return false;
            return executeNewCommand({
              operation: 'correct-location',
              entryId: correctionDialogEntry.id,
              entrySequence: correctionDialogEntry.sequence,
              payload,
              reason,
              clientTime: new Date().toISOString(),
            });
          })()
        : await (async () => {
            const text = dialogText.trim();
            if (text.length === 0) return false;
            return executeNewCommand({
              operation: 'correct-text',
              entryId: correctionDialogEntry.id,
              entrySequence: correctionDialogEntry.sequence,
              text,
              reason,
              clientTime: new Date().toISOString(),
            });
          })();
    if (succeeded) closeDialog();
  }

  async function submitRedaction(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (dialog?.kind !== 'redact' || redactionDialogEntry === null) return;
    const reason = dialogReason.trim();
    if (reason.length === 0) return;
    const succeeded = await executeNewCommand({
      operation: 'redact-entry',
      entryId: redactionDialogEntry.id,
      entrySequence: redactionDialogEntry.sequence,
      reason,
      clientTime: new Date().toISOString(),
    });
    if (succeeded) closeDialog();
  }

  async function submitAllClear(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (
      dialog?.kind !== 'all-clear' ||
      dialog.preview === null ||
      dialog.preview.sendReadiness !== 'ready'
    ) {
      return;
    }
    const succeeded = await executeNewCommand(
      webLifecycleCommandBody({
        operation: 'all-clear',
        lifecyclePreviewId: dialog.preview.id,
      }),
    );
    if (succeeded) closeDialog();
  }

  async function submitClose(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (dialog?.kind !== 'close') {
      return;
    }
    const succeeded = await executeNewCommand(
      webLifecycleCommandBody({
        operation: 'close',
      }),
    );
    if (succeeded) closeDialog();
  }

  function retryRetained(): void {
    if (
      retainedCommand === null ||
      pendingRef.current ||
      retainedPhotoRecoveryConflict
    ) {
      return;
    }
    void sendRetainedCommand(retainedCommand);
  }

  function discardRecoveryRecord(): void {
    try {
      const photoRecoveryReconciled =
        retainedCommand === null
          ? true
          : clearMatchingPhotoCompletion(retainedCommand);
      if (retainedCommand === null) {
        window.sessionStorage.removeItem(recoveryStorageKey(event.id));
      } else {
        clearRetainedCommand(retainedCommand);
      }
      setRetainedCommand(null);
      setRecoveryBlocked(false);
      if (retainedCommand?.operation === 'post-photo') {
        if (photoRecoveryReconciled) {
          setPendingPhotoCompletion(null);
          setPhotoRecoveryBlocked(false);
        } else {
          setPhotoRecoveryBlocked(true);
          setPhotoError(
            'The timeline-post recovery was cleared, but a conflicting private photo recovery record still needs explicit review and clearing.',
          );
        }
      }
      setMutationError(null);
      setMutationStatus(
        'Browser recovery record cleared after explicit timeline verification. Clearing this browser record sent no new request; the prior outcome remains determined by the verified timeline and event status.',
      );
    } catch {
      setMutationError(
        'The browser recovery record could not be cleared. This cleanup attempt sent no new request; the prior request outcome remains unresolved.',
      );
    }
  }

  function jumpToLatest(): void {
    autoScrollRef.current = true;
    setUnseenCount(0);
    timelineEndRef.current?.scrollIntoView({ block: 'end' });
    timelineEndRef.current?.focus();
  }

  const startedAt = currentEvent.activatedAt;
  const canPost = eventAcceptsJournalPosts(currentEvent);
  const locationPayload = locationPayloadFromDraft(locationDraft);
  const dialogLocationPayload = locationPayloadFromDraft(dialogLocationDraft);
  const photoFileValid =
    photoFile !== null &&
    photoFile.size >= 1 &&
    photoFile.size <= MAX_MEDIA_BYTES &&
    MediaContentTypeSchema.safeParse(photoFile.type).success;
  const dialogFeedback = (
    <>
      {mutationError === null ? null : (
        <div
          className="error-panel dialog-error-panel"
          ref={dialogMutationErrorRef}
          role="alert"
          tabIndex={-1}
        >
          <h3>Request needs attention</h3>
          <p>{mutationError}</p>
        </div>
      )}
      <p
        aria-atomic="true"
        aria-live="polite"
        className="mutation-status"
        role="status"
      >
        {mutationStatus}
      </p>
    </>
  );

  return (
    <main className="event-room" id="main-content" tabIndex={-1}>
      <header>
        <div
          className={`classification-banner mode-${classification.kind === 'incident' ? 'real' : classification.kind}`}
        >
          <span aria-hidden="true" className="classification-icon">
            {classification.icon.glyph}
          </span>
          <span>{classificationLabel}</span>
        </div>
        <div className="event-heading">
          <div>
            <p className="facility-name">{facilityLabel}</p>
            <h1>{eventTypeLabel}</h1>
            <dl className="event-facts">
              <dt>Status</dt>
              <dd>
                <span className={`event-status status-${currentEvent.status}`}>
                  {statusLabel(currentEvent)}
                </span>
              </dd>
              {startedAt === null ? (
                <>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={currentEvent.createdAt}>
                      {readableDateTime(
                        currentEvent.createdAt,
                        displayTimeZone,
                      )}
                    </time>
                  </dd>
                </>
              ) : (
                <>
                  <dt>Started</dt>
                  <dd>
                    <time dateTime={startedAt}>
                      {readableDateTime(startedAt, displayTimeZone)}
                    </time>
                  </dd>
                  <dt>Elapsed</dt>
                  <dd suppressHydrationWarning>{elapsed}</dd>
                </>
              )}
            </dl>
            {currentEvent.correctionOfEventId === null ? null : (
              <p className="supersession-notice">
                This is a separate correction event. The source event remains
                retained. Reason: {currentEvent.correctionReason}
              </p>
            )}
            <a
              className="button-link event-export-link"
              href={exportSummaryPath}
            >
              Download PDF summary
            </a>
          </div>
          <div className="connection-panel">
            <p
              className={`connection-line connection-${connection}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span aria-hidden="true" className="connection-dot" />
              <span>{connectionLabel(connection)}</span>
            </p>
            <p aria-hidden="true" className="last-updated">
              {lastUpdatedAt === null
                ? 'Waiting for first refresh'
                : `Updated ${readableDateTime(lastUpdatedAt, displayTimeZone)}`}
            </p>
          </div>
        </div>
      </header>

      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {announcement === null ? null : (
          <span key={announcement.id}>{announcement.message}</span>
        )}
      </p>

      {retainedCommand !== null || recoveryBlocked ? (
        <section
          aria-labelledby="recovery-heading"
          className="recovery-panel"
          role="alert"
        >
          <h2 id="recovery-heading">Previous request needs verification</h2>
          <p>
            {retainedCommand === null
              ? 'The browser recovery record is unreadable.'
              : `The ${commandLabel(retainedCommand.operation)} outcome is unresolved.`}{' '}
            PSD EOC will never replay it automatically. Review the current event
            status and timeline first.
          </p>
          {retainedLifecycleCommand ? (
            <p>
              A lifecycle action cannot be retried from browser storage. After
              verification, clear this record. If the action is still needed,
              PSD EOC will require a fresh consequence review and confirmation.
            </p>
          ) : null}
          {retainedPhotoRecoveryConflict ? (
            <p>
              The retained photo post conflicts with private photo recovery
              evidence and cannot be retried. Verify the timeline, then clear
              both browser records explicitly.
            </p>
          ) : null}
          <div className="form-actions">
            {retainedCommand === null ||
            retainedLifecycleCommand ||
            retainedPhotoRecoveryConflict ? null : (
              <button
                disabled={pendingOperation !== null}
                onClick={retryRetained}
                type="button"
              >
                Retry exact retained request
              </button>
            )}
            <button
              className="secondary"
              disabled={pendingOperation !== null}
              onClick={discardRecoveryRecord}
              type="button"
            >
              I verified the timeline — clear browser recovery record
            </button>
          </div>
        </section>
      ) : null}

      {mutationError === null || dialog !== null ? null : (
        <div
          className="error-panel"
          ref={mutationErrorRef}
          role="alert"
          tabIndex={-1}
        >
          <h2>Request needs attention</h2>
          <p>{mutationError}</p>
        </div>
      )}

      <p
        aria-atomic="true"
        aria-live="polite"
        className="mutation-status"
        role="status"
      >
        {dialog === null ? mutationStatus : null}
      </p>

      <section
        aria-labelledby="lifecycle-heading"
        className={`lifecycle-panel ${realEvent ? 'mode-real' : 'mode-drill'}`}
      >
        <h2 id="lifecycle-heading">Event state</h2>
        <p>
          Current state: <strong>{statusLabel(currentEvent)}</strong>. State
          changes append journal evidence; they never rewrite history.
        </p>
        <div className="lifecycle-actions">
          {currentEvent.status === 'active' ? (
            <button
              aria-haspopup="dialog"
              className="danger"
              disabled={lifecycleCommandsBlocked}
              onClick={(click) => beginAllClear(click.currentTarget)}
              type="button"
            >
              Review all-clear
            </button>
          ) : null}
          {currentEvent.status === 'all-clear' ? (
            <button
              aria-haspopup="dialog"
              className="caution"
              disabled={lifecycleCommandsBlocked}
              onClick={(click) =>
                openDialog({ kind: 'close' }, click.currentTarget)
              }
              type="button"
            >
              Review event close
            </button>
          ) : null}
          {currentEvent.status === 'closed' ? (
            <p>The event is closed. Its complete journal remains retained.</p>
          ) : null}
        </div>
      </section>

      <div className="room-grid">
        <section
          aria-labelledby="timeline-heading"
          aria-busy={loadingHistory}
          className="timeline-panel"
        >
          <div className="timeline-toolbar">
            <div>
              <h2 id="timeline-heading">Event timeline</h2>
              <p className="muted">
                Server-assigned sequence determines receipt order.
                Server-recorded and client-reported times are shown as
                supporting evidence.
              </p>
            </div>
            {unseenCount > 0 ? (
              <button onClick={jumpToLatest} type="button">
                {unseenCount} new {unseenCount === 1 ? 'update' : 'updates'} —
                jump to latest
              </button>
            ) : null}
          </div>
          {loadingHistory ? (
            <p role="status">Loading full authorized event history…</p>
          ) : null}
          {pollMessage === null ? null : (
            <p className="muted">{pollMessage} PSD EOC will keep checking.</p>
          )}
          <div
            aria-label="Chronological event journal"
            className="timeline-scroll"
            onScroll={() => {
              if (isNearTimelineEnd()) setUnseenCount(0);
            }}
            ref={timelineScrollRef}
            role="region"
            tabIndex={0}
          >
            {loadingHistory ? (
              <p className="muted timeline-loading-placeholder">
                Timeline content remains hidden until all authorized history,
                including later corrections and redactions, has loaded.
              </p>
            ) : entries.length === 0 ? (
              <p className="muted">No journal entries are available yet.</p>
            ) : (
              <ol className="timeline-list">
                {entries.map((projection) => (
                  <li key={projection.entry.id}>
                    <TimelineEntry
                      classificationLabel={classificationLabel}
                      displayTimeZone={displayTimeZone}
                      commandsBlocked={commandsBlocked}
                      onCorrect={(target, opener) =>
                        openDialog(
                          {
                            kind: 'correct',
                            entryId: target.id,
                            entrySequence: target.sequence,
                          },
                          opener,
                        )
                      }
                      onRedact={(target, opener) =>
                        openDialog(
                          {
                            kind: 'redact',
                            entryId: target.id,
                            entrySequence: target.sequence,
                          },
                          opener,
                        )
                      }
                      locationMapVisible={
                        visibleLocationMapEntryId === projection.entry.id
                      }
                      onToggleLocationMap={() =>
                        setVisibleLocationMapEntryId((visibleEntryId) =>
                          visibleEntryId === projection.entry.id
                            ? null
                            : projection.entry.id,
                        )
                      }
                      onActivateOlderPhoto={(entryId) => {
                        if (!automaticPrivatePhotoEntryIds.has(entryId)) {
                          // Reserve one recent slot in a committed render
                          // before mounting the selected older loader. React
                          // therefore never transiently owns eleven stateful
                          // photo components while replacing a selection.
                          setPendingOlderPhotoEntryId(entryId);
                          setSelectedOlderPhotoEntryId(null);
                        }
                      }}
                      photoLoadCoordinator={photoLoadCoordinator}
                      photoMountMode={
                        projection.visibility !== 'visible' ||
                        projection.entry.kind !== 'photo' ||
                        automaticPrivatePhotoEntryIds.has(projection.entry.id)
                          ? 'recent'
                          : selectedOlderPhotoEntryId === projection.entry.id
                            ? 'selected-older'
                            : 'deferred-older'
                      }
                      projection={projection}
                      realEvent={realEvent}
                      supersededBy={
                        supersessionsByEntry.get(projection.entry.id) ?? []
                      }
                      timelineScrollRef={timelineScrollRef}
                    />
                  </li>
                ))}
              </ol>
            )}
            <div className="timeline-end" ref={timelineEndRef} tabIndex={-1}>
              <span className="sr-only">Latest timeline position</span>
            </div>
          </div>
        </section>

        <div className="side-column">
          <section aria-labelledby="post-heading" className="composer-panel">
            <h2 id="post-heading">Post an update</h2>
            <form onSubmit={(submission) => void submitPost(submission)}>
              <fieldset
                disabled={commandsBlocked || !canPost}
                style={{ border: 0, margin: 0, padding: 0 }}
              >
                <legend className="sr-only">Text timeline update</legend>
                <div className="field">
                  <label htmlFor="event-post-text">Update text</label>
                  <textarea
                    aria-describedby="event-post-help event-post-count"
                    id="event-post-text"
                    maxLength={10_000}
                    onChange={(change) => setPostText(change.target.value)}
                    required
                    value={postText}
                  />
                </div>
                <p className="field-help" id="event-post-help">
                  Do not include student data. A submitted update is
                  append-only; corrections create a new entry.
                </p>
                <p
                  aria-hidden="true"
                  className="character-count"
                  id="event-post-count"
                >
                  {postText.length.toLocaleString()} / 10,000
                </p>
                <button disabled={postText.trim().length === 0} type="submit">
                  {pendingOperation === 'post-text'
                    ? 'Posting update…'
                    : 'Post update'}
                </button>
              </fieldset>
            </form>
            {!canPost ? (
              <p className="muted">
                New text posts are unavailable after this event is closed or
                before it is active.
              </p>
            ) : null}
          </section>

          <section
            aria-labelledby="location-post-heading"
            className="composer-panel location-composer"
          >
            <h2 id="location-post-heading">Post a location</h2>
            <DialogClassification
              label={classificationLabel}
              real={realEvent}
            />
            <form onSubmit={(submission) => void submitLocation(submission)}>
              <fieldset
                disabled={commandsBlocked || !canPost}
                style={{ border: 0, margin: 0, padding: 0 }}
              >
                <legend className="sr-only">Location timeline update</legend>
                <LocationEditor
                  draft={locationDraft}
                  idPrefix="event-location"
                  onChange={setLocationDraft}
                />
                <p className="field-help">
                  Do not include student data. Post only the precision you can
                  support. The posted entry is immutable; later corrections
                  append a superseding entry with a reason.
                </p>
                <button disabled={locationPayload === null} type="submit">
                  {pendingOperation === 'post-location'
                    ? 'Posting location…'
                    : 'Post location'}
                </button>
              </fieldset>
            </form>
            {!canPost ? (
              <p className="muted">
                New location posts are unavailable after this event is closed or
                before it is active.
              </p>
            ) : null}
          </section>

          <section
            aria-labelledby="photo-post-heading"
            className="composer-panel photo-composer"
          >
            <h2 id="photo-post-heading">Post a photo</h2>
            <DialogClassification
              label={classificationLabel}
              real={realEvent}
            />
            <form onSubmit={(submission) => void submitPhoto(submission)}>
              <fieldset
                disabled={
                  commandsBlocked ||
                  !canPost ||
                  pendingPhotoCompletion !== null ||
                  photoRecoveryBlocked
                }
                style={{ border: 0, margin: 0, padding: 0 }}
              >
                <legend className="sr-only">
                  Private photo timeline update
                </legend>
                <div className="field">
                  <label htmlFor="event-photo-file">Photo file</label>
                  <input
                    accept={ACCEPTED_MEDIA_TYPES}
                    aria-describedby="event-photo-help"
                    id="event-photo-file"
                    onChange={(change) =>
                      selectPhoto(change.currentTarget.files?.[0] ?? null)
                    }
                    ref={photoFileRef}
                    required
                    type="file"
                  />
                </div>
                <div className="field">
                  <label htmlFor="event-photo-alt">
                    Photo description (alternative text)
                  </label>
                  <input
                    aria-describedby="event-photo-alt-help"
                    id="event-photo-alt"
                    maxLength={500}
                    onChange={(change) => setPhotoAltText(change.target.value)}
                    required
                    type="text"
                    value={photoAltText}
                  />
                  <p className="field-help" id="event-photo-alt-help">
                    Replace the author-and-time fallback with important visual
                    details when possible. If it is unchanged, the timeline
                    states that visual details were not described.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="event-photo-caption">
                    Caption (optional)
                  </label>
                  <textarea
                    id="event-photo-caption"
                    maxLength={2_000}
                    onChange={(change) => setPhotoCaption(change.target.value)}
                    value={photoCaption}
                  />
                </div>
                <p className="field-help" id="event-photo-help">
                  Do not include student data. JPEG, PNG, WebP, and HEIC files
                  up to 25 MiB are accepted as untrusted input. PSD EOC checks
                  the actual bytes, malware-scans the upload, and rewrites the
                  image without EXIF or GPS metadata. Location is recorded only
                  through the explicit location workflow.
                </p>
                <button
                  disabled={!photoFileValid || photoAltText.trim().length === 0}
                  type="submit"
                >
                  {photoWorkflowBusy
                    ? 'Validating private photo…'
                    : 'Upload and post photo'}
                </button>
              </fieldset>
            </form>

            {photoError === null ? null : (
              <div
                className="photo-workflow-error"
                ref={photoErrorRef}
                role="alert"
                tabIndex={-1}
              >
                <strong>Photo needs attention</strong>
                <p>{photoError}</p>
              </div>
            )}
            <p
              aria-atomic="true"
              aria-live="polite"
              className="photo-status"
              role="status"
            >
              {photoStatus}
            </p>
            {pendingPhotoCompletion === null && !photoRecoveryBlocked ? null : (
              <div className="photo-pending">
                <p>
                  {pendingPhotoCompletion === null
                    ? 'A private photo recovery record needs explicit review. It will never send or retry automatically.'
                    : 'The exact uploaded photo is awaiting a confirmed validation result. It will never retry automatically.'}
                </p>
                <div className="form-actions">
                  {pendingPhotoCompletion === null ? null : (
                    <button
                      disabled={
                        commandsBlocked || !canPost || photoRecoveryBlocked
                      }
                      onClick={retryPhotoValidation}
                      type="button"
                    >
                      Retry photo validation
                    </button>
                  )}
                  <button
                    className="secondary"
                    disabled={commandsBlocked}
                    onClick={clearPendingPhotoAttempt}
                    type="button"
                  >
                    Clear pending photo attempt after timeline verification
                  </button>
                </div>
              </div>
            )}
            {!canPost ? (
              <p className="muted">
                New photo posts are unavailable after this event is closed or
                before it is active.
              </p>
            ) : null}
          </section>
        </div>
      </div>

      <dialog
        aria-labelledby={dialog === null ? undefined : 'event-dialog-heading'}
        onCancel={(cancel) => {
          if (pendingRef.current) cancel.preventDefault();
          else closeDialog();
        }}
        onClose={(event) => {
          if (
            !event.currentTarget.open &&
            dialog !== null &&
            !pendingRef.current
          ) {
            setDialog(null);
            setDialogText('');
            setDialogLocationDraft(EMPTY_LOCATION_DRAFT);
            setDialogReason('');
          }
        }}
        ref={dialogRef}
      >
        {dialog?.kind === 'correct' && correctionDialogEntry !== null ? (
          <form onSubmit={(submission) => void submitCorrection(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              Correct{' '}
              {correctionDialogEntry.kind === 'location' ? 'location ' : ''}
              entry {correctionDialogEntry.sequence}
            </h2>
            <DialogClassification
              label={classificationLabel}
              real={realEvent}
            />
            {dialogFeedback}
            <p>
              The original remains visible and marked as superseded. This form
              appends a replacement with actor, time, and reason provenance.
            </p>
            <fieldset disabled={commandsBlocked}>
              <legend>Correction details</legend>
              {correctionDialogEntry.kind === 'location' ? (
                <LocationEditor
                  draft={dialogLocationDraft}
                  idPrefix="correction-location"
                  onChange={setDialogLocationDraft}
                />
              ) : (
                <div className="field">
                  <label htmlFor="correction-text">Corrected text</label>
                  <textarea
                    data-autofocus
                    id="correction-text"
                    maxLength={10_000}
                    onChange={(change) => setDialogText(change.target.value)}
                    required
                    value={dialogText}
                  />
                </div>
              )}
              <div className="field">
                <label htmlFor="correction-reason">Reason for correction</label>
                <textarea
                  id="correction-reason"
                  maxLength={1_000}
                  onChange={(change) => setDialogReason(change.target.value)}
                  required
                  value={dialogReason}
                />
              </div>
            </fieldset>
            <div className="form-actions">
              <button
                disabled={
                  commandsBlocked ||
                  (correctionDialogEntry.kind === 'location'
                    ? dialogLocationPayload === null
                    : dialogText.trim().length === 0) ||
                  dialogReason.trim().length === 0
                }
                type="submit"
              >
                Append correction
              </button>
              <button
                className="secondary"
                disabled={pendingOperation !== null}
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {dialog?.kind === 'redact' && redactionDialogEntry !== null ? (
          <form onSubmit={(submission) => void submitRedaction(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              Redact entry {redactionDialogEntry.sequence}
            </h2>
            <DialogClassification
              label={classificationLabel}
              real={realEvent}
            />
            {dialogFeedback}
            <p>
              Redaction appends a superseding entry and hides the original
              content in this view. The original journal record, sequence,
              timing, and provenance are never deleted.
            </p>
            <fieldset disabled={commandsBlocked}>
              <legend>Redaction details</legend>
              <div className="field">
                <label htmlFor="redaction-reason">Reason for redaction</label>
                <textarea
                  data-autofocus
                  id="redaction-reason"
                  maxLength={1_000}
                  onChange={(change) => setDialogReason(change.target.value)}
                  required
                  value={dialogReason}
                />
              </div>
            </fieldset>
            <div className="form-actions">
              <button
                className="danger"
                disabled={commandsBlocked || dialogReason.trim().length === 0}
                type="submit"
              >
                Append redaction
              </button>
              <button
                className="secondary"
                disabled={pendingOperation !== null}
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {dialog?.kind === 'all-clear' ? (
          <form onSubmit={(submission) => void submitAllClear(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              Review and issue all-clear
            </h2>
            <DialogClassification
              label={classificationLabel}
              real={realEvent}
            />
            {dialogFeedback}
            <p>
              Issuing all-clear changes this event state, appends a distinct
              journal entry, and sends the previewed notification. It does not
              close or delete the event.
            </p>
            {dialog.loading ? (
              <p role="status">Loading a fresh consequence preview…</p>
            ) : null}
            {dialog.error === null ? null : (
              <div className="error-panel" role="alert">
                <h3>Preview unavailable</h3>
                <p>{dialog.error}</p>
                <button
                  disabled={lifecycleCommandsBlocked}
                  onClick={() =>
                    void loadAllClearPreview(dialog.idempotencyKey)
                  }
                  type="button"
                >
                  Retry preview
                </button>
              </div>
            )}
            {dialog.preview === null ? null : (
              <>
                <PreviewDetails
                  displayTimeZone={displayTimeZone}
                  preview={dialog.preview}
                />
                <div className="form-actions">
                  <button
                    className="danger"
                    disabled={
                      lifecycleCommandsBlocked ||
                      dialog.preview.sendReadiness !== 'ready'
                    }
                    type="submit"
                  >
                    {pendingOperation === 'all-clear'
                      ? 'Issuing all-clear…'
                      : 'Issue all-clear and notify'}
                  </button>
                  <button
                    className="secondary"
                    data-autofocus
                    disabled={pendingOperation !== null}
                    onClick={closeDialog}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
            {dialog.preview !== null ? null : (
              <div className="form-actions">
                <button
                  className="secondary"
                  data-autofocus
                  onClick={closeDialog}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            )}
          </form>
        ) : null}

        {dialog?.kind === 'close' ? (
          <form onSubmit={(submission) => void submitClose(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              Review and close event
            </h2>
            <DialogClassification
              label={classificationLabel}
              real={realEvent}
            />
            {dialogFeedback}
            <p className="consequence-summary">
              <strong>
                No recipients or notification channels are contacted.
              </strong>{' '}
              Select “Close event” to append a distinct close entry while
              preserving the complete journal, or select “Cancel” to make no
              change.
            </p>
            <details className="technical-consequence-details">
              <summary>Technical close details</summary>
              <dl className="event-facts">
                <dt>Event ID</dt>
                <dd>
                  <code>{currentEvent.id}</code>
                </dd>
                <dt>Current state</dt>
                <dd>
                  <code>{currentEvent.status}</code>
                </dd>
              </dl>
              <p>
                Closing appends a distinct journal entry. It never deletes or
                rewrites history and does not send another all-clear.
              </p>
            </details>
            <div className="form-actions">
              <button
                className="caution"
                disabled={lifecycleCommandsBlocked}
                type="submit"
              >
                {pendingOperation === 'close'
                  ? 'Closing event…'
                  : 'Close event'}
              </button>
              <button
                className="secondary"
                data-autofocus
                disabled={pendingOperation !== null}
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </main>
  );
}
