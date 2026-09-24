'use client';

import {
  ApiErrorSchema,
  CreateMediaUploadIntentInputSchema,
  IdempotencyKeySchema,
  MediaContentTypeSchema,
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
  type MediaRecord,
  type MediaUploadIntent,
} from '@psd-eoc/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';

import { DialogClassification } from './event-room-classification';
import {
  csrfToken,
  deadlineSignal,
  EventRoomRequestError,
  mediaIdempotencyKey,
  MUTATION_DEADLINE_MILLISECONDS,
  type PendingPhotoCompletion,
  publicErrorMessage,
  readJson,
} from './event-room-transport';

export const MAX_MEDIA_BYTES = 25 * 1_024 * 1_024;

export const ACCEPTED_MEDIA_TYPES =
  'image/jpeg,image/png,image/webp,image/heic';

const MAX_CONCURRENT_PRIVATE_PHOTO_LOADS = 2;

const MAX_RESIDENT_PRIVATE_PHOTOS = 2;

const MAX_AUTOMATIC_PRIVATE_PHOTO_LOADS = 2;

export const RECENT_PRIVATE_PHOTO_WORKING_SET_SIZE = 10;

export const SELECTED_PRIVATE_PHOTO_RECENT_WORKING_SET_SIZE =
  RECENT_PRIVATE_PHOTO_WORKING_SET_SIZE - 1;

const PRIVATE_PHOTO_LOAD_DEADLINE_MILLISECONDS = 60_000;

export class MediaWorkflowError extends Error {
  public constructor(
    message: string,
    public readonly keepCompletion: boolean,
  ) {
    super(message);
    this.name = 'MediaWorkflowError';
  }
}

async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function validatePhotoFile(file: File): void {
  if (file.size < 1 || file.size > MAX_MEDIA_BYTES) {
    throw new MediaWorkflowError(
      'Choose a photo between 1 byte and 25 MiB. No upload was started.',
      false,
    );
  }
  if (!MediaContentTypeSchema.safeParse(file.type).success) {
    throw new MediaWorkflowError(
      'Choose a JPEG, PNG, WebP, or HEIC image. PSD EOC will also validate the file contents after upload.',
      false,
    );
  }
}

function mediaMutationHeaders(
  csrfCookieName: string,
  idempotencyKey: string,
  contentType = false,
): Record<string, string> {
  const csrf = csrfToken(csrfCookieName);
  if (csrf === null) {
    throw new MediaWorkflowError(
      'Your session is missing its request-protection cookie. Sign in again before uploading a photo.',
      false,
    );
  }
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    'Idempotency-Key': IdempotencyKeySchema.parse(idempotencyKey),
    'X-PSD-EOC-CSRF': csrf,
  };
}

export async function createPhotoUploadIntent(
  file: File,
  eventId: string,
  csrfCookieName: string,
): Promise<MediaUploadIntent> {
  validatePhotoFile(file);
  const input = CreateMediaUploadIntentInputSchema.parse({
    eventId,
    byteLength: file.size,
    contentSha256: await fileSha256(file),
    declaredContentType: file.type,
  });
  const deadline = deadlineSignal(null, MUTATION_DEADLINE_MILLISECONDS);
  try {
    const response = await fetch('/api/media/upload-intents', {
      method: 'POST',
      credentials: 'same-origin',
      headers: mediaMutationHeaders(
        csrfCookieName,
        mediaIdempotencyKey('create'),
        true,
      ),
      body: JSON.stringify(input),
      signal: deadline.signal,
    });
    const value = await readJson(response);
    if (!response.ok) {
      throw new MediaWorkflowError(
        publicErrorMessage(
          value,
          'PSD EOC could not authorize the private photo upload.',
        ),
        false,
      );
    }
    const parsed = MediaUploadIntentSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.eventId !== input.eventId ||
      parsed.data.byteLength !== input.byteLength ||
      parsed.data.contentSha256 !== input.contentSha256 ||
      parsed.data.declaredContentType !== input.declaredContentType ||
      Date.parse(parsed.data.expiresAt) <= Date.now()
    ) {
      throw new MediaWorkflowError(
        'PSD EOC returned an invalid or expired private upload authorization. No upload was started.',
        false,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof MediaWorkflowError && !deadline.didExpire()) {
      throw error;
    }
    throw new MediaWorkflowError(
      deadline.didExpire()
        ? 'PSD EOC did not authorize the private upload within 15 seconds. Nothing will retry automatically.'
        : 'The connection ended before PSD EOC confirmed the upload authorization. Nothing will retry automatically.',
      false,
    );
  } finally {
    deadline.dispose();
  }
}

export async function putPhotoBytes(
  file: File,
  intent: MediaUploadIntent,
): Promise<void> {
  const deadline = deadlineSignal(
    null,
    PRIVATE_PHOTO_LOAD_DEADLINE_MILLISECONDS,
  );
  try {
    const response = await fetch(intent.uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      headers: {
        'Content-Type': intent.declaredContentType,
        'If-None-Match': '*',
      },
      body: file,
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      signal: deadline.signal,
    });
    if (!response.ok) {
      throw new MediaWorkflowError(
        'The private photo upload was rejected. No timeline entry was posted.',
        false,
      );
    }
  } catch (error) {
    if (error instanceof MediaWorkflowError && !deadline.didExpire()) {
      throw error;
    }
    throw new MediaWorkflowError(
      deadline.didExpire()
        ? 'The private upload exceeded 60 seconds and was stopped. PSD EOC will not retry it automatically; choose the file again to start a new attempt.'
        : 'The private upload connection ended without a confirmed result. PSD EOC will not retry it automatically; choose the file again to start a new attempt.',
      false,
    );
  } finally {
    deadline.dispose();
  }
}

export async function completePhotoUpload(
  pending: PendingPhotoCompletion,
  csrfCookieName: string,
): Promise<MediaRecord> {
  const deadline = deadlineSignal(null, MUTATION_DEADLINE_MILLISECONDS);
  try {
    const response = await fetch(
      `/api/media/upload-intents/${encodeURIComponent(pending.uploadIntentId)}/complete`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: mediaMutationHeaders(csrfCookieName, pending.idempotencyKey),
        signal: deadline.signal,
      },
    );
    let value: unknown;
    try {
      value = await readJson(response);
    } catch (error) {
      if (error instanceof EventRoomRequestError && response.ok) {
        throw new MediaWorkflowError(
          'PSD EOC returned an incomplete photo-validation result. The exact completion request is available for explicit retry.',
          true,
        );
      }
      value = null;
    }
    if (!response.ok) {
      const parsedError = ApiErrorSchema.safeParse(value);
      const definitelyRejected =
        response.status >= 400 &&
        response.status < 500 &&
        parsedError.success &&
        !parsedError.data.retryable;
      const keepCompletion = !definitelyRejected;
      throw new MediaWorkflowError(
        publicErrorMessage(
          value,
          keepCompletion
            ? 'Photo validation is not complete. Use the explicit retry after waiting for the malware scan.'
            : 'PSD EOC rejected the photo safely. No timeline entry was posted.',
        ),
        keepCompletion,
      );
    }
    const parsed = MediaRecordSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.uploadIntentId !== pending.uploadIntentId ||
      parsed.data.eventId !== pending.eventId
    ) {
      throw new MediaWorkflowError(
        'PSD EOC returned photo evidence that does not match this upload. The exact completion request is available for explicit retry.',
        true,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof MediaWorkflowError && !deadline.didExpire()) {
      throw error;
    }
    throw new MediaWorkflowError(
      deadline.didExpire()
        ? 'PSD EOC did not confirm photo validation within 15 seconds. The exact completion request is available for explicit retry and will not retry automatically.'
        : 'The connection ended before PSD EOC confirmed photo validation. The exact completion request is available for explicit retry and will not retry automatically.',
      true,
    );
  } finally {
    deadline.dispose();
  }
}

type PrivatePhotoLoadMode = 'automatic' | 'explicit';

interface PrivatePhotoLoadRequest {
  readonly key: string;
  readonly mode: PrivatePhotoLoadMode;
  readonly onAutomaticLimit: () => void;
  readonly onStartError: () => void;
  readonly start: (complete: () => void) => () => void;
}

interface ActivePrivatePhotoLoad {
  cancel: () => void;
}

export class PrivatePhotoLoadCoordinator {
  readonly #active = new Map<string, ActivePrivatePhotoLoad>();
  readonly #automaticStarts = new Set<string>();
  readonly #residents = new Map<string, () => void>();
  readonly #queue: PrivatePhotoLoadRequest[] = [];

  enqueue(request: PrivatePhotoLoadRequest): () => void {
    this.cancel(request.key);
    this.#queue.push(request);
    this.#pump();
    return () => this.cancel(request.key);
  }

  cancel(key: string): void {
    let queueIndex = this.#queue.findIndex(
      (candidate) => candidate.key === key,
    );
    while (queueIndex >= 0) {
      this.#queue.splice(queueIndex, 1);
      queueIndex = this.#queue.findIndex((candidate) => candidate.key === key);
    }
    const active = this.#active.get(key);
    if (active !== undefined) {
      this.#active.delete(key);
      active.cancel();
      this.#pump();
    }
  }

  claimResident(key: string, evict: () => void): boolean {
    this.#residents.delete(key);
    const evictions: Array<() => void> = [];
    while (this.#residents.size >= MAX_RESIDENT_PRIVATE_PHOTOS) {
      let oldestKey: string | undefined;
      for (const candidate of this.#residents.keys()) {
        if (!this.#active.has(candidate)) {
          oldestKey = candidate;
          break;
        }
      }
      if (oldestKey === undefined) return false;
      const oldestEviction = this.#residents.get(oldestKey);
      this.#residents.delete(oldestKey);
      if (oldestEviction !== undefined) evictions.push(oldestEviction);
    }
    this.#residents.set(key, evict);
    for (const runEviction of evictions) runEviction();
    return true;
  }

  releaseResident(key: string): void {
    this.#residents.delete(key);
  }

  remove(key: string): void {
    this.cancel(key);
    this.releaseResident(key);
  }

  #complete(key: string): void {
    if (!this.#active.delete(key)) return;
    this.#pump();
  }

  #pump(): void {
    while (
      this.#active.size < MAX_CONCURRENT_PRIVATE_PHOTO_LOADS &&
      this.#queue.length > 0
    ) {
      const explicitIndex = this.#queue.findIndex(
        (candidate) => candidate.mode === 'explicit',
      );
      const next = this.#queue.splice(
        explicitIndex >= 0 ? explicitIndex : 0,
        1,
      )[0];
      if (next === undefined) return;

      if (next.mode === 'automatic') {
        if (
          this.#automaticStarts.has(next.key) ||
          this.#automaticStarts.size >= MAX_AUTOMATIC_PRIVATE_PHOTO_LOADS
        ) {
          next.onAutomaticLimit();
          continue;
        }
        this.#automaticStarts.add(next.key);
      }

      const active: ActivePrivatePhotoLoad = { cancel: () => undefined };
      this.#active.set(next.key, active);
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        this.#complete(next.key);
      };
      try {
        const cancel = next.start(complete);
        if (this.#active.get(next.key) === active) {
          active.cancel = () => {
            completed = true;
            cancel();
          };
        } else {
          cancel();
        }
      } catch {
        this.#active.delete(next.key);
        next.onStartError();
      }
    }
  }
}

type PrivatePhotoPhase =
  | 'idle'
  | 'queued'
  | 'authorizing'
  | 'loading-image'
  | 'displayed'
  | 'manual-only'
  | 'evicted'
  | 'error';

type PrivatePhotoObserverSupport =
  'checking' | 'available' | 'unavailable' | 'disabled';

export function AuthorizedPhoto({
  entryId,
  entrySequence,
  eventId,
  mediaId,
  altText,
  caption,
  loadCoordinator,
  scrollRootRef,
  observeViewport,
  loadExplicitlyOnMount,
  classificationLabel,
  realEvent,
}: Readonly<{
  entryId: string;
  entrySequence: number;
  eventId: string;
  mediaId: string;
  altText: string;
  caption: string | null;
  loadCoordinator: PrivatePhotoLoadCoordinator;
  scrollRootRef: Readonly<{ current: HTMLDivElement | null }>;
  observeViewport: boolean;
  loadExplicitlyOnMount: boolean;
  classificationLabel: string;
  realEvent: boolean;
}>) {
  const photoKey = `${entryId}:${mediaId}`;
  const statusId = `private-photo-${entryId}-status`;
  const captionId = `private-photo-${entryId}-caption`;
  const [readUrl, setReadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PrivatePhotoPhase>('idle');
  const [explicitDemand, setExplicitDemand] = useState(false);
  const [observerSupport, setObserverSupport] =
    useState<PrivatePhotoObserverSupport>(
      observeViewport ? 'checking' : 'disabled',
    );
  const figureRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const focusErrorOnRenderRef = useRef(false);
  const mountedRef = useRef(true);
  const attemptRef = useRef(0);
  const automaticStartedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const finishActiveRef = useRef<(() => void) | null>(null);
  const requestCancelRef = useRef<(() => void) | null>(null);
  const requestModeRef = useRef<PrivatePhotoLoadMode | null>(null);
  const loadingRef = useRef(false);
  const readUrlRef = useRef<string | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);

  const finishActive = useCallback(() => {
    finishActiveRef.current?.();
  }, []);

  const cancelCurrentImage = useCallback(() => {
    const image = imageElementRef.current;
    imageElementRef.current = null;
    if (image === null) return;
    image.removeAttribute('src');
  }, []);

  const evictPhoto = useCallback(() => {
    attemptRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    readUrlRef.current = null;
    cancelCurrentImage();
    requestCancelRef.current?.();
    requestCancelRef.current = null;
    finishActiveRef.current = null;
    requestModeRef.current = null;
    loadingRef.current = false;
    if (!mountedRef.current) return;
    setReadUrl(null);
    setError(null);
    setExplicitDemand(false);
    setPhase('evicted');
  }, [cancelCurrentImage]);

  const requestLoad = useCallback(
    (mode: PrivatePhotoLoadMode): void => {
      if (
        loadingRef.current ||
        readUrlRef.current !== null ||
        (mode === 'automatic' && automaticStartedRef.current)
      ) {
        return;
      }

      const figure = figureRef.current;
      if (
        figure !== null &&
        (mode === 'explicit' || figure.contains(document.activeElement))
      ) {
        figure.focus({ preventScroll: true });
      }

      const attempt = attemptRef.current + 1;
      attemptRef.current = attempt;
      loadingRef.current = true;
      requestModeRef.current = mode;
      focusErrorOnRenderRef.current = false;
      setError(null);
      setExplicitDemand(mode === 'explicit');
      setPhase('queued');

      requestCancelRef.current = loadCoordinator.enqueue({
        key: photoKey,
        mode,
        onAutomaticLimit: () => {
          if (!mountedRef.current || attemptRef.current !== attempt) return;
          automaticStartedRef.current = true;
          loadingRef.current = false;
          requestCancelRef.current = null;
          requestModeRef.current = null;
          setPhase('manual-only');
        },
        onStartError: () => {
          if (!mountedRef.current || attemptRef.current !== attempt) return;
          loadingRef.current = false;
          requestCancelRef.current = null;
          requestModeRef.current = null;
          focusErrorOnRenderRef.current = mode === 'explicit';
          setError(
            'The bounded private photo loader could not start. No public image URL was used.',
          );
          setPhase('error');
        },
        start: (complete) => {
          const controller = new AbortController();
          controllerRef.current = controller;
          if (mode === 'automatic') automaticStartedRef.current = true;
          setPhase('authorizing');

          let deadlineTimer: number | null = null;
          const finish = () => {
            if (finishActiveRef.current !== finish) return;
            if (deadlineTimer !== null) {
              window.clearTimeout(deadlineTimer);
              deadlineTimer = null;
            }
            finishActiveRef.current = null;
            controllerRef.current = null;
            requestCancelRef.current = null;
            requestModeRef.current = null;
            loadingRef.current = false;
            complete();
          };
          finishActiveRef.current = finish;

          const fail = (message: string) => {
            if (
              controller.signal.aborted ||
              !mountedRef.current ||
              attemptRef.current !== attempt
            ) {
              return;
            }
            readUrlRef.current = null;
            cancelCurrentImage();
            loadCoordinator.releaseResident(photoKey);
            setReadUrl(null);
            setExplicitDemand(false);
            focusErrorOnRenderRef.current =
              requestModeRef.current === 'explicit';
            setError(message);
            setPhase('error');
            finish();
          };

          deadlineTimer = window.setTimeout(() => {
            if (
              controller.signal.aborted ||
              !mountedRef.current ||
              attemptRef.current !== attempt
            ) {
              return;
            }
            attemptRef.current += 1;
            controller.abort();
            readUrlRef.current = null;
            cancelCurrentImage();
            loadCoordinator.releaseResident(photoKey);
            setReadUrl(null);
            setExplicitDemand(false);
            focusErrorOnRenderRef.current =
              requestModeRef.current === 'explicit';
            setError(
              'Private photo loading exceeded the 60-second safety limit and was stopped. Retry explicitly if the photo is still needed.',
            );
            setPhase('error');
            finish();
          }, PRIVATE_PHOTO_LOAD_DEADLINE_MILLISECONDS);

          void (async () => {
            let response: Response;
            try {
              response = await fetch(
                `/api/media/events/${encodeURIComponent(eventId)}/${encodeURIComponent(mediaId)}/read-grant`,
                {
                  credentials: 'same-origin',
                  cache: 'no-store',
                  signal: controller.signal,
                },
              );
            } catch {
              fail(
                'The private photo could not be authorized. No public image URL was used.',
              );
              return;
            }
            let value: unknown;
            try {
              value = await readJson(response);
            } catch (requestError) {
              fail(
                requestError instanceof Error
                  ? requestError.message
                  : 'The private photo authorization response was invalid.',
              );
              return;
            }
            if (!response.ok) {
              fail(
                publicErrorMessage(
                  value,
                  'The private photo could not be authorized.',
                ),
              );
              return;
            }
            const parsed = MediaReadGrantSchema.safeParse(value);
            if (
              !parsed.success ||
              parsed.data.eventId !== eventId ||
              parsed.data.mediaId !== mediaId ||
              Date.parse(parsed.data.expiresAt) <= Date.now()
            ) {
              fail(
                'PSD EOC returned a private photo authorization that does not match this event.',
              );
              return;
            }
            if (
              controller.signal.aborted ||
              !mountedRef.current ||
              attemptRef.current !== attempt
            ) {
              return;
            }
            if (!loadCoordinator.claimResident(photoKey, evictPhoto)) {
              fail(
                'The bounded private photo working set is busy. Retry explicitly after another photo finishes loading.',
              );
              return;
            }
            readUrlRef.current = parsed.data.readUrl;
            setReadUrl(parsed.data.readUrl);
            setPhase('loading-image');
          })();

          return () => {
            if (deadlineTimer !== null) {
              window.clearTimeout(deadlineTimer);
              deadlineTimer = null;
            }
            controller.abort();
            if (controllerRef.current === controller) {
              controllerRef.current = null;
            }
            if (finishActiveRef.current === finish) {
              finishActiveRef.current = null;
            }
          };
        },
      });
    },
    [
      cancelCurrentImage,
      eventId,
      evictPhoto,
      loadCoordinator,
      mediaId,
      photoKey,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      readUrlRef.current = null;
      cancelCurrentImage();
      requestCancelRef.current?.();
      requestCancelRef.current = null;
      finishActiveRef.current = null;
      requestModeRef.current = null;
      loadingRef.current = false;
      loadCoordinator.remove(photoKey);
    };
  }, [cancelCurrentImage, loadCoordinator, photoKey]);

  useEffect(() => {
    if (!loadExplicitlyOnMount) return;
    figureRef.current?.focus({ preventScroll: true });
    const requestTimer = window.setTimeout(() => {
      requestLoad('explicit');
    }, 0);
    return () => window.clearTimeout(requestTimer);
  }, [loadExplicitlyOnMount, requestLoad]);

  useEffect(() => {
    if (error === null || !focusErrorOnRenderRef.current) return;
    focusErrorOnRenderRef.current = false;
    errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  useEffect(() => {
    if (!observeViewport) {
      setObserverSupport('disabled');
      return;
    }
    const figure = figureRef.current;
    if (figure === null || typeof window.IntersectionObserver === 'undefined') {
      setObserverSupport('unavailable');
      return;
    }
    setObserverSupport('available');
    const observer = new window.IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (visible) {
          requestLoad('automatic');
          return;
        }
        if (
          requestModeRef.current !== 'automatic' ||
          !loadingRef.current ||
          readUrlRef.current !== null
        ) {
          return;
        }
        attemptRef.current += 1;
        controllerRef.current?.abort();
        controllerRef.current = null;
        cancelCurrentImage();
        requestCancelRef.current?.();
        requestCancelRef.current = null;
        finishActiveRef.current = null;
        requestModeRef.current = null;
        loadingRef.current = false;
        setPhase(automaticStartedRef.current ? 'manual-only' : 'idle');
      },
      {
        root: scrollRootRef.current,
        rootMargin: '0px',
        threshold: 0.01,
      },
    );
    observer.observe(figure);
    return () => observer.disconnect();
  }, [cancelCurrentImage, observeViewport, requestLoad, scrollRootRef]);

  function failDisplayedImage(expectedUrl = readUrlRef.current): void {
    if (expectedUrl === null || expectedUrl !== readUrlRef.current) return;
    attemptRef.current += 1;
    readUrlRef.current = null;
    cancelCurrentImage();
    loadCoordinator.releaseResident(photoKey);
    setReadUrl(null);
    setExplicitDemand(false);
    focusErrorOnRenderRef.current = requestModeRef.current === 'explicit';
    setError(
      'The authorized private photo could not be displayed. Request a fresh authorization to retry.',
    );
    setPhase('error');
    finishActive();
  }

  function finishDecodedImage(image: HTMLImageElement): void {
    const expectedUrl = readUrlRef.current;
    const expectedAttempt = attemptRef.current;
    void (async () => {
      try {
        await image.decode();
      } catch {
        if (
          mountedRef.current &&
          expectedAttempt === attemptRef.current &&
          expectedUrl === readUrlRef.current
        ) {
          failDisplayedImage();
        }
        return;
      }
      if (
        !mountedRef.current ||
        expectedAttempt !== attemptRef.current ||
        expectedUrl !== readUrlRef.current
      ) {
        return;
      }
      setPhase('displayed');
      finishActive();
    })();
  }

  const loading =
    phase === 'queued' || phase === 'authorizing' || phase === 'loading-image';
  const idleMessage =
    phase === 'manual-only'
      ? 'Automatic private photo loading is capped for this event view. Load this photo explicitly if it is operationally needed.'
      : phase === 'evicted'
        ? 'This private photo was unloaded to keep the authorized image working set bounded. Load it explicitly to view it again.'
        : observerSupport === 'available'
          ? 'This private photo is not loaded. It will load when it enters the timeline viewport, or you can load it explicitly.'
          : observerSupport === 'unavailable'
            ? 'Automatic viewport loading is unavailable in this browser. Load this private photo explicitly if it is operationally needed.'
            : 'This private photo is not loaded. Load it explicitly if it is operationally needed.';

  return (
    <figure
      aria-busy={loading}
      aria-labelledby={captionId}
      className="entry-content photo-entry"
      data-private-photo-mount="stateful"
      data-private-photo-observer={observeViewport ? 'enabled' : 'disabled'}
      data-private-photo-state={phase}
      ref={figureRef}
      tabIndex={-1}
    >
      <DialogClassification label={classificationLabel} real={realEvent} />
      {readUrl === null ? null : (
        <Image
          alt={altText}
          className="timeline-photo"
          decoding="async"
          height={900}
          loading={explicitDemand ? 'eager' : 'lazy'}
          onError={() => failDisplayedImage(readUrl)}
          onLoad={(event) => finishDecodedImage(event.currentTarget)}
          ref={(image) => {
            imageElementRef.current = image;
          }}
          referrerPolicy="no-referrer"
          src={readUrl}
          unoptimized
          width={1200}
        />
      )}
      <figcaption id={captionId}>
        <p>
          <strong>Photo description:</strong> {altText}
        </p>
        {caption === null ? null : <p>{caption}</p>}
      </figcaption>
      {loading ? (
        <p id={statusId} role="status">
          {phase === 'queued'
            ? 'Private photo load queued within the bounded loader…'
            : phase === 'authorizing'
              ? 'Authorizing private photo…'
              : 'Loading and decoding authorized private photo…'}
        </p>
      ) : null}
      {readUrl === null && error === null && !loading ? (
        <div className="photo-read-control">
          <p id={statusId}>{idleMessage}</p>
          <button
            aria-describedby={statusId}
            className="secondary"
            onClick={() => requestLoad('explicit')}
            type="button"
          >
            Load private photo for entry {entrySequence}
          </button>
        </div>
      ) : null}
      {error === null ? null : (
        <div
          className="photo-read-error"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          <p id={statusId}>{error}</p>
          <button
            aria-describedby={statusId}
            className="secondary"
            onClick={() => requestLoad('explicit')}
            type="button"
          >
            Retry private photo for entry {entrySequence}
          </button>
        </div>
      )}
    </figure>
  );
}

export type PrivatePhotoMountMode =
  'recent' | 'selected-older' | 'deferred-older';

export function DeferredPrivatePhoto({
  entryId,
  entrySequence,
  altText,
  caption,
  onActivate,
  classificationLabel,
  realEvent,
}: Readonly<{
  entryId: string;
  entrySequence: number;
  altText: string;
  caption: string | null;
  onActivate: () => void;
  classificationLabel: string;
  realEvent: boolean;
}>) {
  const statusId = `private-photo-${entryId}-status`;
  const captionId = `private-photo-${entryId}-caption`;
  return (
    <figure
      aria-labelledby={captionId}
      className="entry-content photo-entry photo-entry-deferred"
      data-private-photo-mount="deferred"
      data-private-photo-observer="disabled"
      data-private-photo-state="deferred"
    >
      <DialogClassification label={classificationLabel} real={realEvent} />
      <figcaption id={captionId}>
        <p>
          <strong>Photo description:</strong> {altText}
        </p>
        {caption === null ? null : <p>{caption}</p>}
      </figcaption>
      <div className="photo-read-control">
        <p id={statusId}>
          This older private photo is not loaded. Activating it authorizes this
          photo and unloads any previously selected older photo.
        </p>
        <button
          aria-describedby={statusId}
          className="secondary"
          onClick={onActivate}
          type="button"
        >
          Load older private photo for entry {entrySequence}
        </button>
      </div>
    </figure>
  );
}
