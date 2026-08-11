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
  type PhotoDraftSnapshot,
} from './photo-draft';
import {
  NativePhotoDraftStorage,
  deletePrivatePhoto,
  uploadPrivatePhoto,
  type PendingPhotoSelectionLease,
  type PendingPhotoSelectionOwner,
  type PrivatePhotoFile,
} from './native-photo';

export interface EventPhotoDraftView {
  readonly altText: string;
  readonly caption: string | null;
  readonly stage: string;
  readonly progress: number;
  readonly error: string | null;
}

export interface UseEventPhotoDraftInput {
  readonly eventId: string;
  readonly sessionId: string;
  readonly api: EventRoomApi;
  readonly entries?: readonly JournalEntryReadProjection[];
  readonly onAppended: (entry: JournalEntryReadProjection) => void;
}

export interface EventPhotoDraftWorkflow {
  readonly draft: EventPhotoDraftView | null;
  readonly busy: boolean;
  readonly selectPhoto: () => Promise<void>;
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
  const pendingOwnerRef = useRef<PendingPhotoSelectionOwner | null>(null);
  const hydratingRef = useRef(true);
  const blockedRef = useRef(false);
  const descriptionRef = useRef<
    Readonly<{ altText: string; caption: string | null }>
  >({ altText: '', caption: null });
  const mountedRef = useRef(true);
  apiRef.current = input.api;
  onAppendedRef.current = input.onAppended;
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
    pendingProjectionRef.current = null;
    controllerRef.current?.interruptForBackground();
    controllerRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    descriptionRef.current = { altText: '', caption: null };
    setDraft(EMPTY_COMPOSER);
    let cancelled = false;
    void (async () => {
      try {
        const stored = await storage.load(scope.eventId);
        if (stored !== null) {
          const manifest = parsePhotoDraftManifest(stored);
          const controller = await PhotoDraftController.restore(
            {
              draftId: manifest.draftId,
              eventId: scope.eventId,
              sessionId: scope.sessionId,
            },
            dependencies,
          );
          if (!cancelled && scopeIsCurrent(scope)) {
            const pending = await storage.loadPendingSelection();
            if (
              pending !== null &&
              ownerMatchesScope(pending, scope) &&
              pending.draftId === manifest.draftId
            ) {
              await storage.clearPendingSelection(pending);
            } else if (pending !== null && ownerMatchesScope(pending, scope)) {
              throw new Error(
                'Another pending photo token conflicts with this manifest.',
              );
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
          setDraft({ ...EMPTY_COMPOSER, ...composer });
        }
        const pending = await storage.loadPendingSelection();
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

    const appState = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        controllerRef.current?.interruptForBackground();
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
      controllerRef.current?.interruptForBackground();
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
    input.sessionId,
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

  const selectPhoto = useCallback(async () => {
    const scope = currentScopeRef.current;
    if (
      scope.eventId !== input.eventId ||
      scope.sessionId !== input.sessionId ||
      hydratingRef.current
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
        const file = await lease.select();
        if (file === null) {
          if (pendingOwnerRef.current?.selectionId === owner.selectionId) {
            pendingOwnerRef.current = null;
          }
          return;
        }
        if (!scopeIsCurrent(scope)) return;
        await createFromFile(owner, file, altText, caption, scope, lease);
      });
    } catch {
      if (scopeIsCurrent(scope)) {
        setDraft((current) => ({ ...current, error: boundedFailure() }));
      }
    } finally {
      if (selectionRef.current?.owner.selectionId === owner.selectionId) {
        selectionRef.current = null;
        if (mountedRef.current) setSelecting(false);
      }
    }
  }, [createFromFile, input.eventId, input.sessionId, scopeIsCurrent, storage]);

  const submit = useCallback(async () => {
    const scope = currentScopeRef.current;
    if (
      scope.eventId !== input.eventId ||
      scope.sessionId !== input.sessionId ||
      hydratingRef.current ||
      selectionRef.current !== null ||
      blockedRef.current
    ) {
      setDraft((current) => ({ ...current, error: boundedFailure() }));
      return;
    }
    await editTailRef.current;
    if (!scopeIsCurrent(scope)) return;
    if (descriptionRef.current.altText.trim().length === 0) {
      setDraft((current) => ({
        ...current,
        error: 'Alternative text is required before posting the photo.',
      }));
      return;
    }
    const controller = controllerRef.current;
    if (controller === null) {
      setDraft((current) => ({
        ...current,
        error: 'Select and retain a photo before posting.',
      }));
      return;
    }
    const manifest = controller.snapshot().manifest;
    if (
      manifest === null ||
      manifest.eventId !== scope.eventId ||
      manifest.sessionId !== scope.sessionId
    ) {
      setDraft((current) => ({ ...current, error: boundedFailure() }));
      return;
    }
    if (AppState.currentState !== 'active') {
      setDraft((current) => ({ ...current, error: boundedFailure() }));
      return;
    }
    try {
      pendingProjectionRef.current = null;
      publishValidatedAppend(controller, scope, await controller.start());
    } catch {
      if (scopeIsCurrent(scope) && controllerRef.current === controller) {
        setDraft((current) => ({ ...current, error: boundedFailure() }));
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
      blockedRef.current
    ) {
      return;
    }
    const controller = controllerRef.current;
    if (controller === null) return;
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

  const discard = useCallback(async () => {
    const scope = currentScopeRef.current;
    if (
      scope.eventId !== input.eventId ||
      scope.sessionId !== input.sessionId ||
      hydratingRef.current ||
      selectionRef.current !== null
    ) {
      setDraft((current) => ({ ...current, error: boundedFailure() }));
      return;
    }
    await editTailRef.current;
    if (!scopeIsCurrent(scope)) return;
    const controller = controllerRef.current;
    try {
      if (controller === null) {
        const pending = pendingOwnerRef.current;
        if (pending !== null && ownerMatchesScope(pending, scope)) {
          await storage.discardPendingSelection(pending);
          pendingOwnerRef.current = null;
          blockedRef.current = false;
          await storage.deleteComposer(scope.eventId, scope.sessionId);
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
      const result = await controller.discard();
      if (result.manifest !== null) {
        setDraft((current) => ({
          ...current,
          error: 'The private draft could not be removed safely. Try again.',
        }));
      }
    } catch {
      if (scopeIsCurrent(scope)) {
        setDraft((current) => ({
          ...current,
          error:
            'A started or uncertain photo draft cannot be discarded. Retry or reconcile it instead.',
        }));
      }
    }
  }, [input.eventId, input.sessionId, scopeIsCurrent, storage]);

  return Object.freeze({
    draft,
    busy: hydrating || selecting || ACTIVE_STAGES.has(draft.stage),
    selectPhoto,
    setAltText,
    setCaption,
    submit,
    retry,
    discard,
  });
}
