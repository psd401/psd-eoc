import type {
  JournalEntry,
  JournalEntryReadProjection,
} from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { EventRoomApi } from './api';
import {
  PhotoDraftController,
  PhotoDraftOperationError,
  parsePhotoDraftManifest,
  type PhotoDraftDependencies,
  type PhotoDraftManifest,
  type PhotoDraftSnapshot,
} from './photo-draft';
import {
  NativePhotoDraftStorage,
  PhotoSelectionUnavailableError,
  deletePrivatePhoto,
  uploadPrivatePhoto,
  type PendingPhotoSelectionLease,
  type PendingPhotoSelectionOwner,
  type PrivatePhotoFile,
  type PhotoSource,
} from './native-photo';

export interface EventPhotoDraftView {
  readonly altText: string;
  readonly caption: string | null;
  readonly stage: string;
  readonly progress: number;
  readonly error: string | null;
  readonly localCleanupOnly: boolean;
}

export interface UseEventPhotoDraftInput {
  readonly eventId: string;
  readonly sessionId: string;
  readonly newPostsAllowed: boolean;
  readonly api: EventRoomApi;
  readonly entries?: readonly JournalEntryReadProjection[];
  readonly onAppended: (entry: JournalEntryReadProjection) => void;
}

export interface EventPhotoDraftWorkflow {
  readonly draft: EventPhotoDraftView | null;
  readonly busy: boolean;
  readonly takePhoto: () => Promise<void>;
  readonly choosePhoto: () => Promise<void>;
  readonly setAltText: (value: string) => void;
  readonly setCaption: (value: string) => void;
  readonly submit: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly discard: () => Promise<void>;
}

const EMPTY_COMPOSER: EventPhotoDraftView = Object.freeze({
  altText: '',
  caption: null,
  stage: 'describe',
  progress: 0,
  error: null,
  localCleanupOnly: false,
});

const ACTIVE_STAGES = new Set([
  'creating-intent',
  'uploading',
  'completing-upload',
  'appending',
]);

interface PhotoDraftScope {
  readonly generation: number;
  readonly eventId: string;
  readonly sessionId: string;
}

interface PendingProjection {
  readonly eventId: string;
  readonly sessionId: string;
  readonly mediaId: string;
  readonly altText: string;
  readonly caption: string | null;
  readonly projection: JournalEntryReadProjection;
}

type RetainedOwnerCleanupState =
  | Readonly<{
      kind: 'prior-manifest';
      manifest: PhotoDraftManifest;
    }>
  | Readonly<{
      kind: 'pending-owner';
      pending: PendingPhotoSelectionOwner;
    }>
  | Readonly<{
      kind: 'current-composer';
      eventId: string;
      sessionId: string;
      altText: string;
      caption: string | null;
    }>;

type PhotoJournalEntry = Extract<JournalEntry, { readonly kind: 'photo' }>;

function visiblePhotoEntry(
  projection: JournalEntryReadProjection,
): PhotoJournalEntry | null {
  const entry = projection.entry;
  if (
    projection.visibility !== 'visible' ||
    entry.kind !== 'photo' ||
    !('payload' in entry)
  ) {
    return null;
  }
  return entry as PhotoJournalEntry;
}

function sameScope(left: PhotoDraftScope, right: PhotoDraftScope): boolean {
  return (
    left.generation === right.generation &&
    left.eventId === right.eventId &&
    left.sessionId === right.sessionId
  );
}

function ownerMatchesScope(
  owner: PendingPhotoSelectionOwner,
  scope: PhotoDraftScope,
): boolean {
  return owner.eventId === scope.eventId && owner.sessionId === scope.sessionId;
}

export function pendingPhotoOwnerRequiresLocalCleanup(
  owner: PendingPhotoSelectionOwner,
  eventId: string,
  sessionId: string,
): boolean {
  return owner.eventId !== eventId || owner.sessionId !== sessionId;
}

function publicDraftError(stage: string): string | null {
  switch (stage) {
    case 'failed':
      return 'The upload failed. Your private photo draft is retained; choose Retry when online.';
    case 'unknown':
      return 'The upload result is uncertain. Your private photo draft and replay keys are retained; choose Retry when online.';
    case 'cleanup-pending':
      return 'The photo was posted, but private local cleanup is pending. Choose Retry cleanup.';
    default:
      return null;
  }
}

function viewFromSnapshot(snapshot: PhotoDraftSnapshot): EventPhotoDraftView {
  const manifest = snapshot.manifest;
  if (manifest === null) return EMPTY_COMPOSER;
  return Object.freeze({
    altText: manifest.altText,
    caption: manifest.caption,
    stage: snapshot.progress.stage,
    progress: snapshot.progress.fraction,
    error: publicDraftError(snapshot.progress.stage),
    localCleanupOnly: false,
  });
}

function retainedOwnerCleanupView(
  target: RetainedOwnerCleanupState,
): EventPhotoDraftView {
  return Object.freeze({
    altText: target.kind === 'current-composer' ? target.altText : '',
    caption: target.kind === 'current-composer' ? target.caption : null,
    stage: 'retained-owner',
    progress: 0,
    error:
      target.kind === 'pending-owner'
        ? 'A private photo picker result is retained locally. It cannot be posted or replayed here; explicitly discard or release only that exact local result to continue.'
        : target.kind === 'current-composer'
          ? 'This closed event retains an owner-bound private photo description. It cannot select, upload, or post a photo; explicitly discard only this local description to continue.'
          : 'A private photo draft from an earlier signed-in session is retained locally. It cannot be posted or replayed here; explicitly discard only that exact local draft to continue.',
    localCleanupOnly: true,
  });
}

function boundedFailure(): string {
  return 'PSD EOC could not safely continue the photo draft. The retained draft was not sent automatically.';
}

function isCanonicalNonRetryableApiError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Readonly<Record<string, unknown>>;
  if (
    record.name !== 'AuthenticatedApiError' ||
    typeof record.apiError !== 'object' ||
    record.apiError === null
  ) {
    return false;
  }
  return (
    (record.apiError as Readonly<Record<string, unknown>>).retryable === false
  );
}

async function classifyPhotoNetworkResult<Value>(
  operation: () => Promise<Value>,
): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (isCanonicalNonRetryableApiError(error)) {
      throw new PhotoDraftOperationError(
        'failed',
        'The server definitively rejected this photo operation.',
      );
    }
    throw error;
  }
}

/** Durable native photo workflow; every retry remains an explicit human tap. */
export function useEventPhotoDraft(
  input: UseEventPhotoDraftInput,
): EventPhotoDraftWorkflow {
  const storage = useMemo(() => new NativePhotoDraftStorage(), []);
  const [draft, setDraft] = useState<EventPhotoDraftView>(EMPTY_COMPOSER);
  const [hydrating, setHydrating] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const controllerRef = useRef<PhotoDraftController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const editTailRef = useRef<Promise<void>>(Promise.resolve());
  const apiRef = useRef(input.api);
  const onAppendedRef = useRef(input.onAppended);
  const pendingProjectionRef = useRef<PendingProjection | null>(null);
  const scopeGenerationRef = useRef(0);
  const currentScopeRef = useRef<PhotoDraftScope>({
    generation: 0,
    eventId: input.eventId,
    sessionId: input.sessionId,
  });
  const selectionRef = useRef<Readonly<{
    owner: PendingPhotoSelectionOwner;
    scope: PhotoDraftScope;
  }> | null>(null);
  const submissionClaimRef = useRef<PhotoDraftScope | null>(null);
  const retirementTailRef = useRef<Promise<void>>(Promise.resolve());
  const localCleanupTailRef = useRef<Promise<void>>(Promise.resolve());
  const hydrationTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingOwnerRef = useRef<PendingPhotoSelectionOwner | null>(null);
  const retainedOwnerCleanupRef = useRef<RetainedOwnerCleanupState | null>(
    null,
  );
  const hydratingRef = useRef(true);
  const blockedRef = useRef(false);
  const newPostsAllowedRef = useRef(input.newPostsAllowed);
  const draftStageRef = useRef(draft.stage);
  const descriptionRef = useRef<
    Readonly<{ altText: string; caption: string | null }>
  >({ altText: '', caption: null });
  const mountedRef = useRef(true);
  apiRef.current = input.api;
  onAppendedRef.current = input.onAppended;
  newPostsAllowedRef.current = input.newPostsAllowed;
  draftStageRef.current = draft.stage;
  descriptionRef.current = {
    altText: draft.altText,
    caption: draft.caption,
  };

  const scopeIsCurrent = useCallback(
    (scope: PhotoDraftScope): boolean =>
      mountedRef.current && sameScope(currentScopeRef.current, scope),
    [],
  );

  const dependencies = useMemo<PhotoDraftDependencies>(
    () => ({
      storage,
      createIdempotencyKey: () => Crypto.randomUUID(),
      deletePrivateCopy: deletePrivatePhoto,
      network: {
        createUploadIntent: (value, key, signal) =>
          classifyPhotoNetworkResult(() =>
            apiRef.current.createMediaUploadIntent(value, key, signal),
          ),
        uploadBytes: (value) => uploadPrivatePhoto(value),
        completeUpload: (uploadIntentId, key, signal) =>
          classifyPhotoNetworkResult(() =>
            apiRef.current.completeMediaUpload(uploadIntentId, key, signal),
          ),
        async appendPhoto(value, key, signal): Promise<JournalEntry> {
          pendingProjectionRef.current = null;
          const projection = await classifyPhotoNetworkResult(() =>
            apiRef.current.postPhoto(
              value.eventId,
              input.sessionId,
              value.payload.mediaId,
              value.payload.altText,
              value.payload.caption,
              key,
              value.clientTime,
              signal,
            ),
          );
          const retainedProjection = projection as JournalEntryReadProjection;
          const entry = visiblePhotoEntry(projection);
          if (
            entry === null ||
            entry.eventId !== value.eventId ||
            entry.payload.mediaId !== value.payload.mediaId ||
            entry.payload.altText !== value.payload.altText ||
            entry.payload.caption !== value.payload.caption ||
            entry.author.kind !== 'human' ||
            entry.author.sessionId !== input.sessionId ||
            entry.source !== 'mobile' ||
            entry.supersedes !== null
          ) {
            throw new PhotoDraftOperationError(
              'unknown',
              'The appended projection did not match this photo draft.',
            );
          }
          // The controller still must cross-bind event, media, session, and
          // source before this projection may enter the visible timeline.
          pendingProjectionRef.current = Object.freeze({
            eventId: entry.eventId,
            sessionId: entry.author.sessionId,
            mediaId: entry.payload.mediaId,
            altText: entry.payload.altText,
            caption: entry.payload.caption,
            projection: retainedProjection,
          });
          return entry as JournalEntry;
        },
      },
    }),
    [input.eventId, input.sessionId, storage],
  );

  const publishValidatedAppend = useCallback(
    (
      controller: PhotoDraftController,
      scope: PhotoDraftScope,
      snapshot: PhotoDraftSnapshot,
    ) => {
      const pending = pendingProjectionRef.current;
      const pendingEntry =
        pending === null ? null : visiblePhotoEntry(pending.projection);
      const proved =
        snapshot.manifest === null ||
        (snapshot.manifest.stage === 'cleanup-pending' &&
          snapshot.manifest.cleanupProof === 'append-response');
      if (
        pending === null ||
        !proved ||
        !scopeIsCurrent(scope) ||
        (controllerRef.current !== controller &&
          !(snapshot.manifest === null && controllerRef.current === null)) ||
        pending.eventId !== scope.eventId ||
        pending.sessionId !== scope.sessionId ||
        pendingEntry === null ||
        pendingEntry.eventId !== pending.eventId ||
        pendingEntry.payload.mediaId !== pending.mediaId ||
        pendingEntry.payload.altText !== pending.altText ||
        pendingEntry.payload.caption !== pending.caption ||
        pendingEntry.author.kind !== 'human' ||
        pendingEntry.author.sessionId !== pending.sessionId ||
        pendingEntry.source !== 'mobile'
      ) {
        return;
      }
      pendingProjectionRef.current = null;
      onAppendedRef.current(pending.projection);
    },
    [scopeIsCurrent],
  );

  const attachController = useCallback(
    (controller: PhotoDraftController, scope: PhotoDraftScope): boolean => {
      if (!scopeIsCurrent(scope)) return false;
      unsubscribeRef.current?.();
      controllerRef.current = controller;
      unsubscribeRef.current = controller.subscribe((snapshot) => {
        if (!scopeIsCurrent(scope) || controllerRef.current !== controller) {
          return;
        }
        setDraft(viewFromSnapshot(snapshot));
        if (snapshot.manifest === null) controllerRef.current = null;
      });
      return true;
    },
    [scopeIsCurrent],
  );

  const createFromFile = useCallback(
    async (
      owner: PendingPhotoSelectionOwner,
      file: PrivatePhotoFile,
      altText: string,
      caption: string | null,
      scope: PhotoDraftScope,
      lease: PendingPhotoSelectionLease,
    ): Promise<void> => {
      let controller: PhotoDraftController;
      const pendingDependencies: PhotoDraftDependencies = {
        ...dependencies,
        storage: lease.storage,
      };
      try {
        controller = await PhotoDraftController.create(
          {
            draftId: owner.draftId,
            eventId: owner.eventId,
            sessionId: owner.sessionId,
            ...file,
            altText,
            caption,
          },
          pendingDependencies,
        );
      } catch (error) {
        // A journal write may have committed before its native promise
        // rejected. Restore only an exact owner; otherwise preserve the
        // pending token and bytes for deterministic recovery.
        const retained = await storage.load(owner.eventId);
        if (retained !== null) {
          const manifest = parsePhotoDraftManifest(retained);
          if (
            manifest.draftId !== owner.draftId ||
            manifest.eventId !== owner.eventId ||
            manifest.sessionId !== owner.sessionId ||
            manifest.localUri !== file.localUri
          ) {
            throw error;
          }
          controller = await PhotoDraftController.restore(
            {
              draftId: owner.draftId,
              eventId: owner.eventId,
              sessionId: owner.sessionId,
            },
            dependencies,
          );
        } else {
          throw error;
        }
      }
      // The commit storage normally tombstones the owner with its manifest.
      // This also repairs a manifest-committed/tombstone-failed native result
      // while the same exact owner lease is still held.
      await lease.clearAfterCommittedManifest();
      if (pendingOwnerRef.current?.selectionId === owner.selectionId) {
        pendingOwnerRef.current = null;
      }
      if (!scopeIsCurrent(scope)) {
        controller.interruptForBackground();
      } else {
        attachController(controller, scope);
      }
      try {
        await storage.deleteComposer(owner.eventId, owner.sessionId);
      } catch {
        // A stale owner-bound composer cannot overwrite the manifest.
      }
    },
    [attachController, dependencies, scopeIsCurrent, storage],
  );

  useEffect(() => {
    mountedRef.current = true;
    const generation = scopeGenerationRef.current + 1;
    scopeGenerationRef.current = generation;
    const scope: PhotoDraftScope = Object.freeze({
      generation,
      eventId: input.eventId,
      sessionId: input.sessionId,
    });
    currentScopeRef.current = scope;
    hydratingRef.current = true;
    setHydrating(true);
    setSelecting(selectionRef.current !== null);
    blockedRef.current = false;
    pendingOwnerRef.current = null;
    retainedOwnerCleanupRef.current = null;
    submissionClaimRef.current = null;
    setSubmitting(false);
    pendingProjectionRef.current = null;
    const previousRetirementTail = retirementTailRef.current;
    const previousLocalCleanupTail = localCleanupTailRef.current;
    const previousController = controllerRef.current;
    previousController?.interruptForBackground();
    controllerRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    descriptionRef.current = { altText: '', caption: null };
    setDraft(EMPTY_COMPOSER);
    let cancelled = false;
    const previousHydrationTail = hydrationTailRef.current;
    const hydration = (async () => {
      try {
        await previousHydrationTail;
        await editTailRef.current;
        await previousRetirementTail;
        await previousController?.waitForOperationSettlement();
        await previousLocalCleanupTail;
        if (cancelled || !scopeIsCurrent(scope)) return;
        const pending = await storage.loadPendingSelection();
        if (
          pending !== null &&
          pendingPhotoOwnerRequiresLocalCleanup(
            pending,
            scope.eventId,
            scope.sessionId,
          )
        ) {
          if (!cancelled && scopeIsCurrent(scope)) {
            const target: RetainedOwnerCleanupState = {
              kind: 'pending-owner',
              pending,
            };
            blockedRef.current = true;
            retainedOwnerCleanupRef.current = target;
            setDraft(retainedOwnerCleanupView(target));
          }
          return;
        }
        const stored = await storage.load(scope.eventId);
        if (stored !== null) {
          const manifest = parsePhotoDraftManifest(stored);
          if (manifest.eventId !== scope.eventId) {
            throw new Error('Another event owns the retained photo draft.');
          }
          if (manifest.sessionId !== scope.sessionId) {
            if (!cancelled && scopeIsCurrent(scope)) {
              const target: RetainedOwnerCleanupState = {
                kind: 'prior-manifest',
                manifest,
              };
              blockedRef.current = true;
              retainedOwnerCleanupRef.current = target;
              setDraft(retainedOwnerCleanupView(target));
            }
            return;
          }
          const controller = await PhotoDraftController.restore(
            {
              draftId: manifest.draftId,
              eventId: scope.eventId,
              sessionId: scope.sessionId,
            },
            dependencies,
          );
          if (!cancelled && scopeIsCurrent(scope)) {
            if (
              pending !== null &&
              ownerMatchesScope(pending, scope) &&
              pending.draftId === manifest.draftId
            ) {
              await storage.clearPendingSelection(pending);
            } else if (pending !== null && ownerMatchesScope(pending, scope)) {
              const target: RetainedOwnerCleanupState = {
                kind: 'pending-owner',
                pending,
              };
              blockedRef.current = true;
              retainedOwnerCleanupRef.current = target;
              setDraft(retainedOwnerCleanupView(target));
              return;
            }
            attachController(controller, scope);
          } else {
            controller.interruptForBackground();
          }
          return;
        }

        const composer = await storage.loadComposer(
          scope.eventId,
          scope.sessionId,
        );
        if (composer !== null && !cancelled && scopeIsCurrent(scope)) {
          if (!newPostsAllowedRef.current) {
            const target: RetainedOwnerCleanupState =
              pending !== null && ownerMatchesScope(pending, scope)
                ? { kind: 'pending-owner', pending }
                : {
                    kind: 'current-composer',
                    eventId: scope.eventId,
                    sessionId: scope.sessionId,
                    ...composer,
                  };
            blockedRef.current = true;
            retainedOwnerCleanupRef.current = target;
            setDraft(retainedOwnerCleanupView(target));
            return;
          }
          setDraft({ ...EMPTY_COMPOSER, ...composer });
        }
        if (pending === null || !ownerMatchesScope(pending, scope)) {
          return;
        }
        if (cancelled || !scopeIsCurrent(scope)) return;
        pendingOwnerRef.current = pending;
        await storage.withPendingSelection(pending, async (lease) => {
          const recovered = await lease.recover();
          if (recovered === null) {
            if ((await storage.loadPendingSelection()) === null) {
              pendingOwnerRef.current = null;
              return;
            }
            throw new Error(
              'The exact pending picker result is not yet recoverable.',
            );
          }
          if (cancelled || !scopeIsCurrent(scope)) {
            // The exact owner and bytes remain durable for the original scope.
            return;
          }
          if (composer === null || composer.altText.trim().length === 0) {
            throw new Error('A recovered photo is missing its description.');
          }
          await createFromFile(
            pending,
            recovered,
            composer.altText.trim(),
            composer.caption?.trim() || null,
            scope,
            lease,
          );
        });
      } catch {
        if (!cancelled && scopeIsCurrent(scope)) {
          blockedRef.current = true;
          setDraft((current) => ({
            ...current,
            stage: 'blocked',
            error: boundedFailure(),
          }));
        }
      } finally {
        if (!cancelled && scopeIsCurrent(scope)) {
          hydratingRef.current = false;
          setHydrating(false);
        }
      }
    })();
    hydrationTailRef.current = hydration.then(
      () => undefined,
      () => undefined,
    );
    void hydration;

    const appState = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        controllerRef.current?.interruptForBackground();
        // submit() retains its claim until the bounded interrupted operation
        // settles; foregrounding cannot unlock a duplicate submit or edit.
      }
    });
    return () => {
      cancelled = true;
      scopeGenerationRef.current += 1;
      currentScopeRef.current = {
        ...currentScopeRef.current,
        generation: scopeGenerationRef.current,
      };
      mountedRef.current = false;
      const retiringController = controllerRef.current;
      retiringController?.interruptForBackground();
      if (retiringController !== null) {
        const previousTail = retirementTailRef.current;
        retirementTailRef.current = Promise.allSettled([
          previousTail,
          retiringController.waitForOperationSettlement(),
        ]).then(() => undefined);
      }
      controllerRef.current = null;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      appState.remove();
    };
  }, [
    attachController,
    createFromFile,
    dependencies,
    input.eventId,
    input.newPostsAllowed,
    input.sessionId,
    hydrationRevision,
    scopeIsCurrent,
    storage,
  ]);

  useEffect(() => {
    const scope = currentScopeRef.current;
    const controller = controllerRef.current;
    const entries = input.entries;
    const manifest = controller?.snapshot().manifest;
    if (
      controller === null ||
      entries === undefined ||
      manifest === null ||
      manifest === undefined ||
      manifest.mediaId === null ||
      (manifest.stage !== 'failed' && manifest.stage !== 'unknown')
    ) {
      return;
    }
    pendingProjectionRef.current = null;
    void controller.reconcile(entries).catch(() => {
      if (scopeIsCurrent(scope) && controllerRef.current === controller) {
        setDraft((current) => ({ ...current, error: boundedFailure() }));
      }
    });
  }, [input.entries, scopeIsCurrent]);

  const queueDescription = useCallback(
    (altText: string, caption: string | null) => {
      const scope = currentScopeRef.current;
      if (
        scope.eventId !== input.eventId ||
        scope.sessionId !== input.sessionId
      ) {
        return;
      }
      const controller = controllerRef.current;
      editTailRef.current = editTailRef.current
        .then(async () => {
          if (
            !scopeIsCurrent(scope) ||
            blockedRef.current ||
            hydratingRef.current
          ) {
            return;
          }
          if (controller === null) {
            if (controllerRef.current !== null) return;
            await storage.saveComposer(
              scope.eventId,
              scope.sessionId,
              altText,
              caption,
            );
          } else if (controllerRef.current === controller) {
            const manifest = controller.snapshot().manifest;
            if (
              manifest?.stage !== 'ready' ||
              manifest.eventId !== scope.eventId ||
              manifest.sessionId !== scope.sessionId
            ) {
              return;
            }
            const canonicalAltText = altText.trim();
            if (canonicalAltText.length === 0) return;
            await controller.updateDescription(
              canonicalAltText,
              caption?.trim() || null,
            );
          }
        })
        .catch(() => {
          if (scopeIsCurrent(scope)) {
            setDraft((current) => ({ ...current, error: boundedFailure() }));
          }
        });
    },
    [input.eventId, input.sessionId, scopeIsCurrent, storage],
  );

  const setAltText = useCallback(
    (value: string) => {
      if (
        blockedRef.current ||
        submissionClaimRef.current !== null ||
        selectionRef.current !== null ||
        (draftStageRef.current !== 'describe' &&
          draftStageRef.current !== 'ready')
      ) {
        return;
      }
      const bounded = value.slice(0, 500);
      const description = {
        altText: bounded,
        caption: descriptionRef.current.caption,
      };
      descriptionRef.current = description;
      setDraft((current) => ({
        ...current,
        altText: bounded,
        error: null,
      }));
      queueDescription(description.altText, description.caption);
    },
    [queueDescription],
  );

  const setCaption = useCallback(
    (value: string) => {
      if (
        blockedRef.current ||
        submissionClaimRef.current !== null ||
        selectionRef.current !== null ||
        (draftStageRef.current !== 'describe' &&
          draftStageRef.current !== 'ready')
      ) {
        return;
      }
      const bounded = value.slice(0, 2_000);
      const caption = bounded.length === 0 ? null : bounded;
      const description = {
        altText: descriptionRef.current.altText,
        caption,
      };
      descriptionRef.current = description;
      setDraft((current) => ({ ...current, caption, error: null }));
      queueDescription(description.altText, description.caption);
    },
    [queueDescription],
  );

  const selectPhoto = useCallback(
    async (source: PhotoSource) => {
      const scope = currentScopeRef.current;
      if (
        scope.eventId !== input.eventId ||
        scope.sessionId !== input.sessionId ||
        !newPostsAllowedRef.current ||
        hydratingRef.current ||
        submissionClaimRef.current !== null
      ) {
        setDraft((current) => ({ ...current, error: boundedFailure() }));
        return;
      }
      if (selectionRef.current !== null) return;
      if (blockedRef.current) {
        setDraft((current) => ({
          ...current,
          error:
            'A retained photo draft cannot be opened by this session. It will not be overwritten.',
        }));
        return;
      }
      if (controllerRef.current !== null) {
        setDraft((current) => ({
          ...current,
          error:
            'Finish or safely discard the retained photo before selecting another.',
        }));
        return;
      }
      const owner: PendingPhotoSelectionOwner = Object.freeze({
        version: 1,
        selectionId: Crypto.randomUUID(),
        draftId: Crypto.randomUUID(),
        eventId: scope.eventId,
        sessionId: scope.sessionId,
      });
      selectionRef.current = Object.freeze({ owner, scope });
      setSelecting(true);
      try {
        await editTailRef.current;
        if (!scopeIsCurrent(scope)) return;
        if (blockedRef.current || controllerRef.current !== null) {
          throw new Error('The retained photo owner changed before selection.');
        }
        const altText = descriptionRef.current.altText.trim();
        const caption = descriptionRef.current.caption?.trim() || null;
        if (altText.length === 0) {
          setDraft((current) => ({
            ...current,
            error:
              'Describe the photo for screen-reader users before selecting it.',
          }));
          return;
        }
        await storage.saveComposer(
          scope.eventId,
          scope.sessionId,
          altText,
          caption,
        );
        if (!scopeIsCurrent(scope)) return;
        await storage.withNewPendingSelection(owner, async (lease) => {
          pendingOwnerRef.current = owner;
          if (!scopeIsCurrent(scope)) {
            if (await lease.clearBeforeCopy()) {
              pendingOwnerRef.current = null;
            }
            return;
          }
          const file = await lease.select(source);
          if (file === null) {
            if (pendingOwnerRef.current?.selectionId === owner.selectionId) {
              pendingOwnerRef.current = null;
            }
            return;
          }
          if (!scopeIsCurrent(scope)) return;
          await createFromFile(owner, file, altText, caption, scope, lease);
        });
      } catch (error) {
        if (scopeIsCurrent(scope)) {
          setDraft((current) => ({
            ...current,
            error:
              error instanceof PhotoSelectionUnavailableError
                ? error.message
                : boundedFailure(),
          }));
          setHydrationRevision((current) => current + 1);
        }
      } finally {
        const scopeChanged = !scopeIsCurrent(scope);
        if (selectionRef.current?.owner.selectionId === owner.selectionId) {
          selectionRef.current = null;
          if (mountedRef.current) setSelecting(false);
        }
        if (scopeChanged && mountedRef.current) {
          setHydrationRevision((current) => current + 1);
        }
      }
    },
    [createFromFile, input.eventId, input.sessionId, scopeIsCurrent, storage],
  );

  const takePhoto = useCallback(() => selectPhoto('camera'), [selectPhoto]);
  const choosePhoto = useCallback(() => selectPhoto('library'), [selectPhoto]);

  const submit = useCallback(async () => {
    const scope = currentScopeRef.current;
    if (
      scope.eventId !== input.eventId ||
      scope.sessionId !== input.sessionId ||
      !newPostsAllowedRef.current ||
      hydratingRef.current ||
      selectionRef.current !== null ||
      submissionClaimRef.current !== null ||
      blockedRef.current
    ) {
      setDraft((current) => ({ ...current, error: boundedFailure() }));
      return;
    }
    submissionClaimRef.current = scope;
    setSubmitting(true);
    try {
      const stableEditTail = editTailRef.current;
      await stableEditTail;
      if (
        !scopeIsCurrent(scope) ||
        submissionClaimRef.current !== scope ||
        !newPostsAllowedRef.current ||
        AppState.currentState !== 'active'
      ) {
        return;
      }
      const controller = controllerRef.current;
      const manifest = controller?.snapshot().manifest;
      const altText = descriptionRef.current.altText.trim();
      const caption = descriptionRef.current.caption?.trim() || null;
      if (altText.length === 0) {
        setDraft((current) => ({
          ...current,
          error: 'Alternative text is required before posting the photo.',
        }));
        return;
      }
      if (
        controller === null ||
        manifest === null ||
        manifest === undefined ||
        manifest.eventId !== scope.eventId ||
        manifest.sessionId !== scope.sessionId ||
        manifest.stage !== 'ready' ||
        manifest.altText !== altText ||
        manifest.caption !== caption
      ) {
        setDraft((current) => ({ ...current, error: boundedFailure() }));
        return;
      }
      pendingProjectionRef.current = null;
      publishValidatedAppend(controller, scope, await controller.start());
    } catch {
      if (scopeIsCurrent(scope)) {
        const controller = controllerRef.current;
        setDraft((current) => ({ ...current, error: boundedFailure() }));
        if (controller !== null) {
          setDraft((current) => ({
            ...viewFromSnapshot(controller.snapshot()),
            error: current.error ?? boundedFailure(),
          }));
        }
      }
    } finally {
      if (submissionClaimRef.current === scope) {
        submissionClaimRef.current = null;
        if (mountedRef.current) setSubmitting(false);
      }
    }
  }, [input.eventId, input.sessionId, publishValidatedAppend, scopeIsCurrent]);

  const retry = useCallback(async () => {
    const scope = currentScopeRef.current;
    if (
      scope.eventId !== input.eventId ||
      scope.sessionId !== input.sessionId ||
      hydratingRef.current ||
      selectionRef.current !== null ||
      submissionClaimRef.current !== null
    ) {
      return;
    }
    const controller = controllerRef.current;
    if (controller === null) {
      if (blockedRef.current) {
        blockedRef.current = false;
        setHydrationRevision((current) => current + 1);
      }
      return;
    }
    if (blockedRef.current) return;
    const manifest = controller.snapshot().manifest;
    if (
      manifest === null ||
      manifest.eventId !== scope.eventId ||
      manifest.sessionId !== scope.sessionId
    ) {
      return;
    }
    if (AppState.currentState !== 'active') return;
    try {
      pendingProjectionRef.current = null;
      if (manifest.stage === 'cleanup-pending') {
        await controller.retryCleanup();
      } else if (!newPostsAllowedRef.current) {
        if (input.entries === undefined) {
          setDraft((current) => ({ ...current, error: boundedFailure() }));
          return;
        }
        const matched = await controller.reconcile(input.entries);
        if (
          !matched &&
          scopeIsCurrent(scope) &&
          controllerRef.current === controller
        ) {
          setDraft((current) => ({
            ...current,
            error:
              'No matching timeline entry was found. The closed event will not restart this upload or post; the private draft remains retained.',
          }));
        }
      } else {
        if (input.entries === undefined) {
          setDraft((current) => ({ ...current, error: boundedFailure() }));
          return;
        }
        publishValidatedAppend(
          controller,
          scope,
          await controller.retry(input.entries),
        );
      }
    } catch {
      if (scopeIsCurrent(scope) && controllerRef.current === controller) {
        setDraft((current) => ({ ...current, error: boundedFailure() }));
      }
    }
  }, [
    input.entries,
    input.eventId,
    input.sessionId,
    publishValidatedAppend,
    scopeIsCurrent,
  ]);

  const discardTracked = useCallback(async () => {
    const scope = currentScopeRef.current;
    if (
      scope.eventId !== input.eventId ||
      scope.sessionId !== input.sessionId
    ) {
      return;
    }
    if (
      hydratingRef.current ||
      selectionRef.current !== null ||
      submissionClaimRef.current !== null
    ) {
      if (scopeIsCurrent(scope)) {
        setDraft((current) => ({ ...current, error: boundedFailure() }));
      }
      return;
    }
    await editTailRef.current;
    if (!scopeIsCurrent(scope)) return;
    const controller = controllerRef.current;
    try {
      if (controller === null) {
        const retainedOwnerCleanup = retainedOwnerCleanupRef.current;
        if (retainedOwnerCleanup !== null) {
          try {
            if (retainedOwnerCleanup.kind === 'prior-manifest') {
              await storage.discardPriorSessionManifest(
                retainedOwnerCleanup.manifest,
                scope.sessionId,
              );
            } else if (retainedOwnerCleanup.kind === 'pending-owner') {
              await storage.discardPendingSelection(
                retainedOwnerCleanup.pending,
              );
              if (!scopeIsCurrent(scope)) return;
              if (
                ownerMatchesScope(retainedOwnerCleanup.pending, scope) &&
                !newPostsAllowedRef.current
              ) {
                const remainingTarget: RetainedOwnerCleanupState = {
                  kind: 'current-composer',
                  eventId: scope.eventId,
                  sessionId: scope.sessionId,
                  altText: '',
                  caption: null,
                };
                retainedOwnerCleanupRef.current = remainingTarget;
                setDraft(retainedOwnerCleanupView(remainingTarget));
                await storage.deleteComposer(scope.eventId, scope.sessionId);
                if (!scopeIsCurrent(scope)) return;
              }
            } else {
              if (
                retainedOwnerCleanup.eventId !== scope.eventId ||
                retainedOwnerCleanup.sessionId !== scope.sessionId
              ) {
                throw new Error('Another composer owns the retained text.');
              }
              await storage.deleteComposer(scope.eventId, scope.sessionId);
              if (!scopeIsCurrent(scope)) return;
            }
          } catch {
            if (!scopeIsCurrent(scope)) return;
            retainedOwnerCleanupRef.current = null;
            setDraft((current) => ({
              ...current,
              error:
                'The exact private photo owner changed or could not be removed safely. Refreshing local recovery state; try explicit discard again.',
            }));
            setHydrationRevision((current) => current + 1);
            return;
          }
          if (!scopeIsCurrent(scope)) return;
          retainedOwnerCleanupRef.current = null;
          setHydrationRevision((current) => current + 1);
          return;
        }
        const pending = pendingOwnerRef.current;
        if (pending !== null && ownerMatchesScope(pending, scope)) {
          await storage.discardPendingSelection(pending);
          if (!scopeIsCurrent(scope)) return;
          pendingOwnerRef.current = null;
          blockedRef.current = false;
          await storage.deleteComposer(scope.eventId, scope.sessionId);
          if (!scopeIsCurrent(scope)) return;
          setDraft(EMPTY_COMPOSER);
          return;
        }
        if (blockedRef.current) {
          setDraft((current) => ({
            ...current,
            error:
              'This session cannot discard or overwrite another retained photo draft.',
          }));
          return;
        }
        await storage.deleteComposer(scope.eventId, scope.sessionId);
        if (!scopeIsCurrent(scope)) return;
        setDraft(EMPTY_COMPOSER);
        return;
      }
      const manifest = controller.snapshot().manifest;
      if (
        manifest === null ||
        manifest.eventId !== scope.eventId ||
        manifest.sessionId !== scope.sessionId
      ) {
        throw new Error('Another event owns the retained photo draft.');
      }
      const result = newPostsAllowedRef.current
        ? await controller.discard()
        : await controller.discardLocallyAfterEventClosed();
      if (
        result.manifest !== null &&
        scopeIsCurrent(scope) &&
        controllerRef.current === controller
      ) {
        setDraft((current) => ({
          ...current,
          error: 'The private draft could not be removed safely. Try again.',
        }));
      }
    } catch {
      if (scopeIsCurrent(scope)) {
        setDraft((current) => ({
          ...current,
          error: newPostsAllowedRef.current
            ? 'A started or uncertain photo draft cannot be discarded. Retry or reconcile it instead.'
            : 'The closed event’s private photo draft could not be removed safely. It remains retained.',
        }));
      }
    }
  }, [input.eventId, input.sessionId, scopeIsCurrent, storage]);

  const discard = useCallback((): Promise<void> => {
    const operation = discardTracked();
    const previousTail = localCleanupTailRef.current;
    localCleanupTailRef.current = Promise.allSettled([
      previousTail,
      operation,
    ]).then(() => undefined);
    return operation;
  }, [discardTracked]);

  return Object.freeze({
    draft,
    busy:
      hydrating || submitting || selecting || ACTIVE_STAGES.has(draft.stage),
    takePhoto,
    choosePhoto,
    setAltText,
    setCaption,
    submit,
    retry,
    discard,
  });
}
