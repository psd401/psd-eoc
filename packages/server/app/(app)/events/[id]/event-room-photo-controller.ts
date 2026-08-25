'use client';

import { MediaContentTypeSchema, type Event } from '@psd-eoc/contracts';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';

import {
  clearPendingPhotoCompletion,
  type CommandBody,
  makePendingPhotoCompletion,
  type PendingPhotoCompletion,
  photoCompletionStorageKey,
  readPendingPhotoCompletion,
  readRetainedCommand,
  recordCompletedPhotoMedia,
  retainedPhotoCommandMatches,
  retainPendingPhotoCompletion,
  type RetainedCommand,
  type RetainedCommandDispatchOutcome,
} from './event-room-transport';
import {
  completePhotoUpload,
  createPhotoUploadIntent,
  MAX_MEDIA_BYTES,
  MediaWorkflowError,
  PrivatePhotoLoadCoordinator,
  putPhotoBytes,
  validatePhotoFile,
} from './event-room-media';
import { readableDateTime } from './event-room-timeline';

interface EventRoomPhotoStateOptions {
  readonly event: Event;
  readonly apiUrl: string;
  readonly sessionId: string;
}

export function useEventRoomPhotoState({
  event,
  apiUrl,
  sessionId,
}: EventRoomPhotoStateOptions) {
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoAltText, setPhotoAltText] = useState('');
  const [photoCaption, setPhotoCaption] = useState('');
  const [photoWorkflowBusy, setPhotoWorkflowBusy] = useState(false);
  const [photoStatus, setPhotoStatus] = useState('');
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [pendingPhotoCompletion, setPendingPhotoCompletion] =
    useState<PendingPhotoCompletion | null>(null);
  const [photoRecoveryBlocked, setPhotoRecoveryBlocked] = useState(false);

  const photoErrorRef = useRef<HTMLDivElement>(null);
  const photoFileRef = useRef<HTMLInputElement>(null);
  const photoWorkflowRef = useRef(false);
  const photoLoadCoordinatorRef = useRef<PrivatePhotoLoadCoordinator | null>(
    null,
  );
  if (photoLoadCoordinatorRef.current === null) {
    photoLoadCoordinatorRef.current = new PrivatePhotoLoadCoordinator();
  }

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

  return {
    photoFile,
    setPhotoFile,
    photoAltText,
    setPhotoAltText,
    photoCaption,
    setPhotoCaption,
    photoWorkflowBusy,
    setPhotoWorkflowBusy,
    photoStatus,
    setPhotoStatus,
    photoError,
    setPhotoError,
    pendingPhotoCompletion,
    setPendingPhotoCompletion,
    photoRecoveryBlocked,
    setPhotoRecoveryBlocked,
    photoErrorRef,
    photoFileRef,
    photoWorkflowRef,
    photoLoadCoordinator: photoLoadCoordinatorRef.current,
    clearPending: () => setPendingPhotoCompletion(null),
  };
}

export type EventRoomPhotoState = ReturnType<typeof useEventRoomPhotoState>;

interface PhotoCommandController {
  readonly commandsBlocked: boolean;
  readonly prepareNewCommand: (
    body: CommandBody,
    options?: Readonly<{
      fromPhotoWorkflow?: boolean;
      idempotencyKey?: string;
    }>,
  ) => RetainedCommand | null;
  readonly sendRetainedCommand: (
    command: RetainedCommand,
  ) => Promise<RetainedCommandDispatchOutcome>;
  readonly clearPreparedCommand: (command: RetainedCommand) => boolean;
}

interface EventRoomPhotoWorkflowOptions {
  readonly state: EventRoomPhotoState;
  readonly command: PhotoCommandController;
  readonly event: Event;
  readonly currentEventRef: RefObject<Event>;
  readonly csrfCookieName: string;
  readonly sessionId: string;
  readonly authorDisplayName: string;
  readonly displayTimeZone: string;
  readonly dialogOpen: boolean;
}

function eventAcceptsJournalPosts(event: Event): boolean {
  return event.status === 'active' || event.status === 'all-clear';
}

export function useEventRoomPhotoWorkflow({
  state,
  command,
  event,
  currentEventRef,
  csrfCookieName,
  sessionId,
  authorDisplayName,
  displayTimeZone,
  dialogOpen,
}: EventRoomPhotoWorkflowOptions) {
  const {
    photoFile,
    setPhotoFile,
    photoAltText,
    setPhotoAltText,
    photoCaption,
    setPhotoCaption,
    photoWorkflowBusy,
    setPhotoWorkflowBusy,
    setPhotoStatus,
    photoError,
    setPhotoError,
    pendingPhotoCompletion,
    setPendingPhotoCompletion,
    photoRecoveryBlocked,
    setPhotoRecoveryBlocked,
    photoErrorRef,
    photoFileRef,
    photoWorkflowRef,
  } = state;

  useEffect(() => {
    if (photoError === null || dialogOpen) return;
    photoErrorRef.current?.focus();
  }, [dialogOpen, photoError, photoErrorRef]);

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
      const retained = command.prepareNewCommand(
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
      if (retained === null) {
        throw new MediaWorkflowError(
          'The photo was validated, but this browser could not retain the exact timeline post. The validation request remains available and no post was sent.',
          true,
        );
      }
      try {
        clearPendingPhotoCompletion(recoveryPending);
      } catch {
        command.clearPreparedCommand(retained);
        setPhotoRecoveryBlocked(true);
        throw new MediaWorkflowError(
          'The photo was validated, but this browser could not safely transition from validation recovery to timeline-post recovery. No post was sent. Verify the timeline before clearing recovery records.',
          true,
        );
      }
      setPendingPhotoCompletion(null);
      setPhotoRecoveryBlocked(false);
      const dispatchOutcome = await command.sendRetainedCommand(retained);
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
      command.commandsBlocked ||
      !eventAcceptsJournalPosts(currentEventRef.current) ||
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
      setPhotoError(
        error instanceof Error
          ? error.message
          : 'PSD EOC could not start the private photo upload.',
      );
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
      !eventAcceptsJournalPosts(currentEventRef.current) ||
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

  const photoFileValid =
    photoFile !== null &&
    photoFile.size >= 1 &&
    photoFile.size <= MAX_MEDIA_BYTES &&
    MediaContentTypeSchema.safeParse(photoFile.type).success;

  return {
    submitPhoto,
    selectPhoto,
    retryPhotoValidation,
    clearPendingPhotoAttempt,
    photoFileValid,
  };
}
