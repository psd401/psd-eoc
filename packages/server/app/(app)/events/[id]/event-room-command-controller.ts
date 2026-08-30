'use client';

import {
  type Event,
  type JournalEntryReadProjection,
} from '@psd-eoc/contracts';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';

import { type DialogState } from './event-room-lifecycle';
import {
  EMPTY_LOCATION_DRAFT,
  type LocationDraft,
  locationDraftFromPayload,
  locationPayloadFromDraft,
} from './event-room-location';
import {
  clearMatchingPhotoCompletion,
  clearRetainedCommand,
  type CommandBody,
  commandLabel,
  type CommandOperation,
  EventRoomRequestError,
  makeRetainedCommand,
  type MutationResult,
  parseMutationResult,
  postRetainedCommand,
  readRetainedCommand,
  recoveryStorageKey,
  requestLifecyclePreview,
  retainCommand,
  type RetainedCommand,
  type RetainedCommandDispatchOutcome,
  webLifecycleCommandBody,
} from './event-room-transport';

interface PhotoRecoveryBridge {
  readonly blocked: boolean;
  readonly setBlocked: (blocked: boolean) => void;
  readonly clearPending: () => void;
  readonly setError: (message: string) => void;
}

interface EventRoomCommandControllerOptions {
  readonly event: Event;
  readonly currentEvent: Event;
  readonly entries: readonly JournalEntryReadProjection[];
  readonly supersessionsByEntry: ReadonlyMap<
    string,
    readonly JournalEntryReadProjection[]
  >;
  readonly loadingHistory: boolean;
  readonly apiUrl: string;
  readonly csrfCookieName: string;
  readonly sessionId: string;
  readonly photoWorkflowBusy: boolean;
  readonly photoWorkflowRef: RefObject<boolean>;
  readonly photoRecovery: PhotoRecoveryBridge;
  readonly pendingRef: RefObject<boolean>;
  readonly applyMutationResult: (
    result: MutationResult,
  ) => 'applied' | 'refreshing';
}

export function useEventRoomCommandController({
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
  photoRecovery,
  pendingRef,
  applyMutationResult,
}: EventRoomCommandControllerOptions) {
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

  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogWasOpenRef = useRef(false);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);
  const dialogRequestAttemptedRef = useRef(false);
  const mutationErrorRef = useRef<HTMLDivElement>(null);
  const dialogMutationErrorRef = useRef<HTMLDivElement>(null);
  const dialogOpen = dialog !== null;

  useEffect(
    () => () => {
      previewControllerRef.current?.abort();
    },
    [],
  );

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
    const element = dialogRef.current;
    if (element === null) return;
    if (dialogOpen) {
      if (!element.open) element.showModal();
      dialogWasOpenRef.current = true;
      return;
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
  }, [dialogOpen]);

  useEffect(() => {
    if (dialog === null) return;
    const frame = window.requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>(
        '[data-autofocus]:not(:disabled)',
      );
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialog]);

  useEffect(() => {
    if (mutationError === null) return;
    const target =
      dialog === null
        ? mutationErrorRef.current
        : dialogMutationErrorRef.current;
    target?.focus();
  }, [dialog, mutationError]);

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
    setDialog,
    loadingHistory,
    pendingRef,
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
    retainedCommand?.operation === 'post-photo' && photoRecovery.blocked;

  useEffect(() => {
    if (dialog?.kind !== 'all-clear' || pendingRef.current) return;
    // The end-event action performs the all-clear and then the close, so the
    // all-clear state is expected mid-flight and must not invalidate it.
    const eventStateChanged =
      currentEvent.status !== 'active' && currentEvent.status !== 'all-clear';
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
    pendingRef,
    recoveryBlocked,
    retainedCommand,
  ]);

  function openDialog(next: DialogState, opener: HTMLElement): void {
    const openingLifecycleDialog = next.kind === 'all-clear';
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

  function clearCommandAfterResult(command: RetainedCommand): boolean {
    try {
      const photoRecoveryReconciled = clearMatchingPhotoCompletion(command);
      clearRetainedCommand(command);
      setRetainedCommand(null);
      if (command.operation === 'post-photo') {
        if (photoRecoveryReconciled) {
          photoRecovery.clearPending();
          photoRecovery.setBlocked(false);
        } else {
          photoRecovery.setBlocked(true);
          photoRecovery.setError(
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

  function clearPreparedCommand(command: RetainedCommand): boolean {
    try {
      clearRetainedCommand(command);
      setRetainedCommand(null);
      return true;
    } catch {
      setRecoveryBlocked(true);
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

  /**
   * Ends the event in one confirmed action.
   *
   * The server still records two transitions -- the all-clear that notifies
   * staff, then the close -- because that is what the state machine, the
   * capability, and the database CHECK all require. The operator should not
   * have to know that: they are ending the event, which is one decision.
   *
   * If the close half fails, the event is genuinely in the all-clear state and
   * the lifecycle panel says so and offers to finish it. It is never silently
   * half-ended.
   */
  async function submitEndEvent(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (
      dialog?.kind !== 'all-clear' ||
      dialog.preview === null ||
      dialog.preview.sendReadiness !== 'ready'
    ) {
      return;
    }
    const notified = await executeNewCommand(
      webLifecycleCommandBody({
        operation: 'all-clear',
        lifecyclePreviewId: dialog.preview.id,
      }),
    );
    if (!notified) return;
    closeDialog();
    await executeNewCommand(webLifecycleCommandBody({ operation: 'close' }));
  }

  /** Completes an event whose all-clear landed but whose close did not. */
  async function finishEndingEvent(): Promise<void> {
    if (currentEvent.status !== 'all-clear') return;
    await executeNewCommand(webLifecycleCommandBody({ operation: 'close' }));
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
          photoRecovery.clearPending();
          photoRecovery.setBlocked(false);
        } else {
          photoRecovery.setBlocked(true);
          photoRecovery.setError(
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

  return {
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
    baseCommandsBlocked,
    commandsBlocked,
    lifecycleCommandsBlocked,
    retainedLifecycleCommand,
    retainedPhotoRecoveryConflict,
    openDialog,
    closeDialog,
    beginAllClear,
    loadAllClearPreview,
    prepareNewCommand,
    executeNewCommand,
    sendRetainedCommand,
    clearPreparedCommand,
    submitCorrection,
    submitRedaction,
    submitEndEvent,
    finishEndingEvent,
    retryRetained,
    discardRecoveryRecord,
  };
}
