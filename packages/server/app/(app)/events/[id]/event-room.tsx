'use client';

import {
  getEventClassificationPresentation,
  type Event,
  type JournalEntryReadProjection,
} from '@psd-eoc/contracts';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { DialogClassification } from './event-room-classification';
import { useEventRoomCommandController } from './event-room-command-controller';
import { PreviewDetails } from './event-room-lifecycle';
import {
  EMPTY_LOCATION_DRAFT,
  type LocationDraft,
  LocationEditor,
  locationPayloadFromDraft,
} from './event-room-location';
import { ACCEPTED_MEDIA_TYPES } from './event-room-media';
import {
  useEventRoomPhotoState,
  useEventRoomPhotoWorkflow,
} from './event-room-photo-controller';
import { connectionLabel, useEventRoomSync } from './event-room-sync';
import { readableDateTime, TimelineEntry } from './event-room-timeline';
import { commandLabel } from './event-room-transport';

// Preserve the long-standing import surface while the implementation lives in
// focused modules. Consumers should not need a flag-day import migration.
export {
  eventRoomPollDelay,
  webLifecycleCommandBody,
} from './event-room-transport';
export {
  type LocationDraft,
  locationPayloadFromDraft,
} from './event-room-location';
export { PrivatePhotoLoadCoordinator } from './event-room-media';

/**
 * System facts PSD EOC records for the record, not for the room. Creating the
 * event, activating it, recording a send intent, and each join are all real
 * append-only evidence -- they stay in the journal and in the PDF summary --
 * but as timeline cards they bury the updates people are actually reading.
 */
const BACKGROUND_SYSTEM_CODES: ReadonlySet<string> = new Set([
  'event-created',
  'event-activated',
  'notification-intent-recorded',
  'participant-joined',
]);

function isBackgroundSystemEntry(
  projection: JournalEntryReadProjection,
): boolean {
  return (
    projection.visibility === 'visible' &&
    projection.entry.kind === 'system' &&
    BACKGROUND_SYSTEM_CODES.has(projection.entry.payload.code)
  );
}

/** A state change is worth one line: it is what happened to the event. */
function stateChangeSummary(
  projection: JournalEntryReadProjection,
): string | null {
  if (projection.visibility !== 'visible') return null;
  const { entry } = projection;
  if (entry.kind !== 'system') return null;
  return BACKGROUND_SYSTEM_CODES.has(entry.payload.code)
    ? null
    : entry.payload.summary;
}

interface RoomParticipant {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
}

function participantInitials(name: string): string {
  const parts = name.split(/\s+/u).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * Who else is here, taken from what people have already done in this event:
 * joining it, starting it, or posting to it. There is no presence heartbeat
 * and no leave signal, so this says who has been in the event, never who is
 * looking at it right now -- and the copy has to keep that promise.
 */
function roomParticipants(
  entries: readonly JournalEntryReadProjection[],
): readonly RoomParticipant[] {
  const byUser = new Map<string, RoomParticipant>();
  for (const projection of entries) {
    if (projection.visibility !== 'visible') continue;
    const { entry } = projection;
    if (entry.author.kind !== 'human') continue;
    if (entry.authorDisplayName === null) continue;
    if (byUser.has(entry.author.userId)) continue;
    byUser.set(entry.author.userId, {
      id: entry.author.userId,
      name: entry.authorDisplayName,
      initials: participantInitials(entry.authorDisplayName),
    });
  }
  return [...byUser.values()];
}

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
  const sync = useEventRoomSync({
    event,
    initialEntries,
    initialCursor,
    initialSnapshotSequence,
    initialHasMore,
    apiUrl,
  });
  const {
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
    pendingRef,
    supersessionsByEntry,
    automaticPrivatePhotoEntryIds,
    selectedOlderPhotoEntryId,
    setSelectedOlderPhotoEntryId,
    visibleLocationMapEntryId,
    setVisibleLocationMapEntryId,
    setPendingOlderPhotoEntryId,
    applyMutationResult,
    jumpToLatest,
    acknowledgeVisibleTimelineEnd,
  } = sync;
  const participants = useMemo(() => roomParticipants(entries), [entries]);
  const timelineEntries = useMemo(
    () => entries.filter((projection) => !isBackgroundSystemEntry(projection)),
    [entries],
  );
  const [postText, setPostText] = useState('');
  const [locationDraft, setLocationDraft] =
    useState<LocationDraft>(EMPTY_LOCATION_DRAFT);

  const photoState = useEventRoomPhotoState({ event, apiUrl, sessionId });
  const {
    photoAltText,
    setPhotoAltText,
    photoCaption,
    setPhotoCaption,
    photoWorkflowBusy,
    photoStatus,
    photoError,
    pendingPhotoCompletion,
    photoRecoveryBlocked,
    photoErrorRef,
    photoFileRef,
    photoWorkflowRef,
    photoLoadCoordinator,
  } = photoState;

  const command = useEventRoomCommandController({
    event,
    currentEvent,
    entries,
    supersessionsByEntry,
    loadingHistory,
    apiUrl,
    csrfCookieName,
    sessionId,
    photoWorkflowBusy,
    photoWorkflowRef,
    photoRecovery: {
      blocked: photoRecoveryBlocked,
      setBlocked: photoState.setPhotoRecoveryBlocked,
      clearPending: photoState.clearPending,
      setError: photoState.setPhotoError,
    },
    pendingRef,
    applyMutationResult,
  });
  const {
    mutationStatus,
    mutationError,
    pendingOperation,
    retainedCommand,
    recoveryBlocked,
    dialog,
    setDialog,
    dialogText,
    setDialogText,
    dialogLocationDraft,
    setDialogLocationDraft,
    dialogReason,
    setDialogReason,
    dialogRef,
    mutationErrorRef,
    dialogMutationErrorRef,
    correctionDialogEntry,
    redactionDialogEntry,
    commandsBlocked,
    lifecycleCommandsBlocked,
    retainedLifecycleCommand,
    retainedPhotoRecoveryConflict,
    openDialog,
    closeDialog,
    beginAllClear,
    loadAllClearPreview,
    executeNewCommand,
    submitCorrection,
    submitRedaction,
    submitEndEvent,
    finishEndingEvent,
    retryRetained,
    discardRecoveryRecord,
  } = command;

  const photoWorkflow = useEventRoomPhotoWorkflow({
    state: photoState,
    command,
    event,
    currentEventRef,
    csrfCookieName,
    sessionId,
    authorDisplayName,
    displayTimeZone,
    dialogOpen: dialog !== null,
  });
  const {
    submitPhoto,
    selectPhoto,
    retryPhotoValidation,
    clearPendingPhotoAttempt,
    photoFileValid,
  } = photoWorkflow;

  const elapsed = useElapsedLabel(currentEvent);
  const realEvent = event.templateMode === 'real';
  const classification = getEventClassificationPresentation(event);
  const classificationLabel = classification.label;

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
  const startedAt = currentEvent.activatedAt;
  const canPost = eventAcceptsJournalPosts(currentEvent);
  const locationPayload = locationPayloadFromDraft(locationDraft);
  const dialogLocationPayload = locationPayloadFromDraft(dialogLocationDraft);
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
                This is a correction of an earlier event, which is still on
                file. Reason: {currentEvent.correctionReason}
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
        {participants.length === 0 ? null : (
          <section
            aria-labelledby="participants-heading"
            className="participants"
          >
            <h2 className="sr-only" id="participants-heading">
              In this event
            </h2>
            <ul className="participant-chips">
              {participants.map((participant) => (
                <li key={participant.id}>
                  <span className="participant-chip" title={participant.name}>
                    <span aria-hidden="true">{participant.initials}</span>
                    <span className="sr-only">{participant.name}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
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
          <h2 id="recovery-heading">One earlier request is unresolved</h2>
          <p>
            {retainedCommand === null
              ? 'PSD EOC could not read what the last request was.'
              : `PSD EOC does not know whether your ${commandLabel(retainedCommand.operation)} went through.`}{' '}
            It will not be sent again on its own. Check the timeline below.
          </p>
          {retainedLifecycleCommand ? (
            <p>
              Ending an event is never retried from this browser. Dismiss this,
              then end the event again if it is still active.
            </p>
          ) : null}
          {retainedPhotoRecoveryConflict ? (
            <p>
              A photo attempt is also unresolved, so this one cannot be sent
              again. Check the timeline, then dismiss both.
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
                Send it again
              </button>
            )}
            <button
              className="secondary"
              disabled={pendingOperation !== null}
              onClick={discardRecoveryRecord}
              type="button"
            >
              I checked the timeline — dismiss
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
        <h2 id="lifecycle-heading">Event status</h2>
        <p>
          <strong>{statusLabel(currentEvent)}</strong>
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
              End event
            </button>
          ) : null}
          {currentEvent.status === 'all-clear' ? (
            <>
              <p>
                Staff have the all-clear. This event is not closed yet.
              </p>
              <button
                className="caution"
                disabled={lifecycleCommandsBlocked}
                onClick={() => void finishEndingEvent()}
                type="button"
              >
                {pendingOperation === 'close'
                  ? 'Finishing…'
                  : 'Finish ending the event'}
              </button>
            </>
          ) : null}
          {currentEvent.status === 'closed' ? (
            <p>This event is closed. Its timeline is still here.</p>
          ) : null}
        </div>
      </section>

      <div className="room-grid">
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
                  {/* The composer is why this page is open during an
                      incident, so it takes focus on arrival. */}
                  <textarea
                    autoFocus
                    aria-describedby="event-post-help event-post-count"
                    id="event-post-text"
                    maxLength={10_000}
                    onChange={(change) => setPostText(change.target.value)}
                    required
                    value={postText}
                  />
                </div>
                <p className="field-help" id="event-post-help">
                  Do not include student data. Updates cannot be edited -- post
                  a correction instead.
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

          <details className="composer-extra">
            <summary>Add a location</summary>
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
                  support. Locations cannot be edited -- post a correction
                  instead.
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
          </details>
          <details className="composer-extra">
            <summary>Add a photo</summary>

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
                  Do not include student data. JPEG, PNG, WebP, and HEIC up to
                  25 MiB. PSD EOC scans the file and strips EXIF and GPS data
                  before posting it.
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
                    ? 'A photo from an earlier attempt needs review. PSD EOC will not send it on its own.'
                    : 'This photo is still being checked. PSD EOC will not retry it on its own.'}
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
                    Discard the pending photo
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
          </details>
        </div>
        <section
          aria-labelledby="timeline-heading"
          aria-busy={loadingHistory}
          className="timeline-panel"
        >
          <div className="timeline-toolbar">
            <div>
              <h2 id="timeline-heading">Event timeline</h2>
            </div>
            {unseenCount > 0 ? (
              <button onClick={jumpToLatest} type="button">
                {unseenCount} new {unseenCount === 1 ? 'update' : 'updates'} —
                jump to latest
              </button>
            ) : null}
          </div>
          {loadingHistory ? (
            <p role="status">Loading the timeline…</p>
          ) : null}
          {pollMessage === null ? null : (
            <p className="muted">{pollMessage} PSD EOC will keep checking.</p>
          )}
          <div
            aria-label="Chronological event journal"
            className="timeline-scroll"
            onScroll={acknowledgeVisibleTimelineEnd}
            ref={timelineScrollRef}
            role="region"
            tabIndex={0}
          >
            {loadingHistory ? (
              <p className="muted timeline-loading-placeholder">
                Updates appear once the whole timeline has loaded, so nothing
                is shown out of order.
              </p>
            ) : timelineEntries.length === 0 ? (
              <p className="muted">No updates yet.</p>
            ) : (
              <ol className="timeline-list">
                {timelineEntries.map((projection) => {
                  const stateChange = stateChangeSummary(projection);
                  if (stateChange !== null) {
                    return (
                      <li key={projection.entry.id}>
                        <p className="timeline-marker">
                          <span>{stateChange}</span>{' '}
                          <time dateTime={projection.entry.serverTime}>
                            {readableDateTime(
                              projection.entry.serverTime,
                              displayTimeZone,
                            )}
                          </time>
                        </p>
                      </li>
                    );
                  }
                  return (
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
                  );
                })}
              </ol>
            )}
            <div className="timeline-end" ref={timelineEndRef} tabIndex={-1}>
              <span className="sr-only">Latest timeline position</span>
            </div>
          </div>
        </section>

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
              The original stays on the timeline, marked as corrected. Your
              replacement is added below it with your name, the time, and the
              reason.
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
                Post correction
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
              This hides the content from the timeline. The original record,
              its time, and who wrote it are kept and are never deleted.
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
                Hide this entry
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
          <form onSubmit={(submission) => void submitEndEvent(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              End this event
            </h2>
            <DialogClassification
              label={classificationLabel}
              real={realEvent}
            />
            {dialogFeedback}
            <p>
              This sends the all-clear to the staff below and ends the event.
              The timeline stays available afterward.
            </p>
            {dialog.loading ? (
              <p role="status">Checking who will be notified…</p>
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
                <PreviewDetails preview={dialog.preview} />
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
                      ? 'Ending event…'
                      : 'End event and notify staff'}
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

      </dialog>
    </main>
  );
}
