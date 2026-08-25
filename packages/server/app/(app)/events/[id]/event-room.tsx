'use client';

import {
  getEventClassificationPresentation,
  type Event,
  type JournalEntryReadProjection,
} from '@psd-eoc/contracts';
import { useEffect, useState, type FormEvent } from 'react';

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
    submitAllClear,
    submitClose,
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
            onScroll={acknowledgeVisibleTimelineEnd}
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
