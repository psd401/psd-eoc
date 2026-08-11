'use client';

import {
  AllClearEventResultSchema,
  ApiErrorSchema,
  AppendJournalEntryInputSchema,
  CloseEventResultSchema,
  CorrectJournalEntryInputSchema,
  CreateMediaUploadIntentInputSchema,
  EventRoomSyncResultSchema,
  EventSchema,
  JournalEntryReadProjectionSchema,
  IdempotencyKeySchema,
  JournalEntrySchema,
  LifecycleConsequencePreviewSchema,
  LocationPayloadSchema,
  MediaContentTypeSchema,
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
  UuidSchema,
  type ChannelConsequencePreview,
  type Event,
  type JournalEntry,
  type JournalEntryReadProjection,
  type LifecycleConsequencePreview,
  type LocationPayload,
  type MediaRecord,
  type MediaUploadIntent,
} from '@psd-eoc/contracts';
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import { LocationMap, formatLocationTextEquivalent } from '../../../../lib/map';

const POLL_MINIMUM_MILLISECONDS = 3_000;
const POLL_JITTER_MILLISECONDS = 2_000;
const POLL_MAXIMUM_BACKOFF_MILLISECONDS = 30_000;
const QUERY_DEADLINE_MILLISECONDS = 10_000;
const MUTATION_DEADLINE_MILLISECONDS = 15_000;
const ANNOUNCEMENT_BATCH_MILLISECONDS = 5_000;
const RECOVERY_RECORD_VERSION = 1;
const PHOTO_COMPLETION_RECORD_VERSION = 1;
const MAX_MEDIA_BYTES = 25 * 1_024 * 1_024;
const ACCEPTED_MEDIA_TYPES = 'image/jpeg,image/png,image/webp,image/heic';
const MAX_CONCURRENT_PRIVATE_PHOTO_LOADS = 2;
const MAX_RESIDENT_PRIVATE_PHOTOS = 2;
const MAX_AUTOMATIC_PRIVATE_PHOTO_LOADS = 2;
const RECENT_PRIVATE_PHOTO_WORKING_SET_SIZE = 10;
const SELECTED_PRIVATE_PHOTO_RECENT_WORKING_SET_SIZE =
  RECENT_PRIVATE_PHOTO_WORKING_SET_SIZE - 1;
const PRIVATE_PHOTO_LOAD_DEADLINE_MILLISECONDS = 60_000;

type ConnectionState = 'loading' | 'connected' | 'reconnecting' | 'offline';

type CommandOperation =
  | 'post-text'
  | 'post-photo'
  | 'post-location'
  | 'correct-text'
  | 'correct-location'
  | 'redact-entry'
  | 'all-clear'
  | 'close';

type RetainedCommandDispatchOutcome =
  | 'confirmed'
  | 'ambiguous'
  | 'rejected'
  | 'not-sent';

type CommandBody =
  | Readonly<{
      operation: 'post-text';
      text: string;
      clientTime: string;
    }>
  | Readonly<{
      operation: 'post-photo';
      mediaId: string;
      altText: string;
      caption: string | null;
      clientTime: string;
    }>
  | Readonly<{
      operation: 'post-location';
      payload: LocationPayload;
      clientTime: string;
    }>
  | Readonly<{
      operation: 'correct-text';
      entryId: string;
      entrySequence: number;
      text: string;
      reason: string;
      clientTime: string;
    }>
  | Readonly<{
      operation: 'correct-location';
      entryId: string;
      entrySequence: number;
      payload: LocationPayload;
      reason: string;
      clientTime: string;
    }>
  | Readonly<{
      operation: 'redact-entry';
      entryId: string;
      entrySequence: number;
      reason: string;
      clientTime: string;
    }>
  | Readonly<{
      operation: 'all-clear';
      lifecyclePreviewId: string;
      confirmationPhrase: 'ALL CLEAR';
    }>
  | Readonly<{
      operation: 'close';
      confirmationPhrase: 'CLOSE EVENT';
    }>;

interface RetainedCommand {
  readonly version: typeof RECOVERY_RECORD_VERSION;
  readonly eventId: string;
  readonly ownerSessionId: string;
  readonly apiUrl: string;
  readonly operation: CommandOperation;
  readonly idempotencyKey: string;
  readonly bodyJson: string;
  readonly createdAt: string;
}

interface TimelinePage {
  readonly event: Event | null;
  readonly entries: readonly JournalEntryReadProjection[];
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly snapshotSequence: number;
}

interface TimelineContinuation {
  /** Last cursor whose event projection and entries are visible together. */
  readonly baseCursor: string | null;
  /** Cursor for the next page in this still-hidden catch-up chain. */
  readonly cursor: string;
  readonly entries: readonly JournalEntryReadProjection[];
  readonly snapshotSequence: number;
}

interface MutationResult {
  readonly event: Event | null;
  readonly entries: readonly JournalEntryReadProjection[];
}

interface RetainedCommandResponse {
  readonly value: unknown;
  readonly transitionIdempotencyKey: string | null;
}

interface PendingPhotoCompletion {
  readonly version: typeof PHOTO_COMPLETION_RECORD_VERSION;
  readonly eventId: string;
  readonly ownerSessionId: string;
  readonly uploadIntentId: string;
  readonly mediaId: string | null;
  readonly idempotencyKey: string;
  readonly postIdempotencyKey: string;
  readonly altText: string;
  readonly caption: string | null;
  readonly clientTime: string;
  readonly createdAt: string;
}

type DialogState =
  | Readonly<{
      kind: 'correct';
      entryId: string;
      entrySequence: number;
    }>
  | Readonly<{
      kind: 'redact';
      entryId: string;
      entrySequence: number;
    }>
  | Readonly<{
      kind: 'all-clear';
      idempotencyKey: string;
      loading: boolean;
      preview: LifecycleConsequencePreview | null;
      error: string | null;
    }>
  | Readonly<{ kind: 'close' }>;

export interface LocationDraft {
  readonly state: LocationPayload['state'];
  readonly latitude: string;
  readonly longitude: string;
  readonly accuracyMeters: string;
  readonly label: string;
  readonly reason: string;
}

const EMPTY_LOCATION_DRAFT: LocationDraft = Object.freeze({
  state: 'unknown',
  latitude: '',
  longitude: '',
  accuracyMeters: '',
  label: '',
  reason: '',
});

function locationDraftFromPayload(payload: LocationPayload): LocationDraft {
  if (payload.state === 'known') {
    return {
      state: 'known',
      latitude: String(payload.latitude),
      longitude: String(payload.longitude),
      accuracyMeters: String(payload.accuracyMeters),
      label: payload.label ?? '',
      reason: '',
    };
  }
  if (payload.state === 'ambiguous') {
    return {
      ...EMPTY_LOCATION_DRAFT,
      state: 'ambiguous',
      label: payload.label,
      reason: payload.reason,
    };
  }
  return {
    ...EMPTY_LOCATION_DRAFT,
    reason: payload.reason,
  };
}

export function locationPayloadFromDraft(
  draft: LocationDraft,
): LocationPayload | null {
  let candidate: unknown;
  if (draft.state === 'known') {
    if (
      draft.latitude.trim().length === 0 ||
      draft.longitude.trim().length === 0 ||
      draft.accuracyMeters.trim().length === 0
    ) {
      return null;
    }
    candidate = {
      state: 'known',
      latitude: Number(draft.latitude),
      longitude: Number(draft.longitude),
      accuracyMeters: Number(draft.accuracyMeters),
      label: draft.label.trim().length === 0 ? null : draft.label.trim(),
    };
  } else if (draft.state === 'ambiguous') {
    candidate = {
      state: 'ambiguous',
      label: draft.label.trim(),
      reason: draft.reason.trim(),
    };
  } else {
    candidate = { state: 'unknown', reason: draft.reason.trim() };
  }
  const parsed = LocationPayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
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
  /** Name of the readable double-submit CSRF cookie issued by the server. */
  readonly csrfCookieName: string;
  /** Server-authenticated session that owns the idempotency namespace. */
  readonly sessionId: string;
  /** Authenticated staff display name used only for the editable alt default. */
  readonly authorDisplayName: string;
}

class EventRoomRequestError extends Error {
  public constructor(
    message: string,
    public readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = 'EventRoomRequestError';
  }
}

class MediaWorkflowError extends Error {
  public constructor(
    message: string,
    public readonly keepCompletion: boolean,
  ) {
    super(message);
    this.name = 'MediaWorkflowError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareEntries(
  left: JournalEntryReadProjection,
  right: JournalEntryReadProjection,
): number {
  const sequenceDifference = left.entry.sequence - right.entry.sequence;
  return sequenceDifference !== 0
    ? sequenceDifference
    : left.entry.id.localeCompare(right.entry.id);
}

function visibleJournalEntry(entry: JournalEntry): JournalEntryReadProjection {
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'visible',
    entry,
  });
}

function immutableEventIdentity(event: Event): string {
  return JSON.stringify({
    id: event.id,
    facilityId: event.facilityId,
    kind: event.kind,
    templateMode: event.templateMode,
    eventTypeVersion: event.eventTypeVersion,
    rosterSnapshotId: event.rosterSnapshotId,
    rosterPopulation: event.rosterPopulation,
    createdBy: event.createdBy,
    createdAt: event.createdAt,
    correctionOfEventId: event.correctionOfEventId,
    correctionReason: event.correctionReason,
    activationAuthorization: event.activationAuthorization,
  });
}

function assertImmutableEventIdentity(
  candidate: Event,
  baseline: Event,
  ambiguous = false,
): void {
  if (immutableEventIdentity(candidate) !== immutableEventIdentity(baseline)) {
    throw new EventRoomRequestError(
      'PSD EOC returned event identity or classification that does not match this room.',
      ambiguous,
    );
  }
}

function canonicalEntries(
  value: unknown,
  eventId: string,
): readonly JournalEntry[] {
  if (!Array.isArray(value)) {
    throw new EventRoomRequestError(
      'PSD EOC returned an invalid timeline response.',
      false,
    );
  }
  return value.map((candidate) => {
    const parsed = JournalEntrySchema.safeParse(candidate);
    if (!parsed.success || parsed.data.eventId !== eventId) {
      throw new EventRoomRequestError(
        'PSD EOC returned an invalid timeline response.',
        false,
      );
    }
    return parsed.data;
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join(',') === [...expectedKeys].sort().join(',')
  );
}

function locationPayloadsEqual(
  left: LocationPayload,
  right: LocationPayload,
): boolean {
  if (left.state !== right.state) return false;
  if (left.state === 'known' && right.state === 'known') {
    return (
      left.latitude === right.latitude &&
      left.longitude === right.longitude &&
      left.accuracyMeters === right.accuracyMeters &&
      left.label === right.label
    );
  }
  if (left.state === 'ambiguous' && right.state === 'ambiguous') {
    return left.label === right.label && left.reason === right.reason;
  }
  return (
    left.state === 'unknown' &&
    right.state === 'unknown' &&
    left.reason === right.reason
  );
}

function journalEntryProvesCommand(
  command: RetainedCommand,
  entry: JournalEntry,
): boolean {
  let body: unknown;
  try {
    body = JSON.parse(command.bodyJson);
  } catch {
    return false;
  }
  if (
    !isRecord(body) ||
    entry.source !== 'web' ||
    entry.author.kind !== 'human' ||
    entry.author.sessionId !== command.ownerSessionId ||
    entry.clientTime !== body.clientTime
  ) {
    return false;
  }

  if (command.operation === 'post-text') {
    return (
      hasExactKeys(body, ['operation', 'text', 'clientTime']) &&
      body.operation === 'post-text' &&
      typeof body.text === 'string' &&
      entry.kind === 'text' &&
      entry.payload.text === body.text &&
      entry.supersedes === null
    );
  }

  if (command.operation === 'post-photo') {
    if (
      !hasExactKeys(body, [
        'operation',
        'mediaId',
        'altText',
        'caption',
        'clientTime',
      ]) ||
      body.operation !== 'post-photo'
    ) {
      return false;
    }
    const input = AppendJournalEntryInputSchema.safeParse({
      eventId: command.eventId,
      clientTime: body.clientTime,
      supersedes: null,
      kind: 'photo',
      payload: {
        mediaId: body.mediaId,
        altText: body.altText,
        caption: body.caption,
      },
    });
    return (
      input.success &&
      input.data.kind === 'photo' &&
      entry.kind === 'photo' &&
      entry.eventId === input.data.eventId &&
      entry.payload.mediaId === input.data.payload.mediaId &&
      entry.payload.altText === input.data.payload.altText &&
      entry.payload.caption === input.data.payload.caption &&
      entry.supersedes === null
    );
  }

  if (command.operation === 'post-location') {
    if (
      !hasExactKeys(body, ['operation', 'payload', 'clientTime']) ||
      body.operation !== 'post-location'
    ) {
      return false;
    }
    const input = AppendJournalEntryInputSchema.safeParse({
      eventId: command.eventId,
      clientTime: body.clientTime,
      supersedes: null,
      kind: 'location',
      payload: body.payload,
    });
    return (
      input.success &&
      input.data.kind === 'location' &&
      entry.kind === 'location' &&
      entry.eventId === input.data.eventId &&
      locationPayloadsEqual(entry.payload, input.data.payload) &&
      entry.supersedes === null
    );
  }

  if (command.operation === 'correct-location') {
    if (
      !hasExactKeys(body, [
        'operation',
        'entryId',
        'entrySequence',
        'payload',
        'reason',
        'clientTime',
      ]) ||
      body.operation !== 'correct-location'
    ) {
      return false;
    }
    const input = CorrectJournalEntryInputSchema.safeParse({
      eventId: command.eventId,
      clientTime: body.clientTime,
      supersedes: {
        entryId: body.entryId,
        entrySequence: body.entrySequence,
        kind: 'correction',
        reason: body.reason,
      },
      kind: 'location',
      payload: body.payload,
    });
    return (
      input.success &&
      input.data.kind === 'location' &&
      input.data.supersedes !== null &&
      entry.kind === 'location' &&
      entry.eventId === input.data.eventId &&
      locationPayloadsEqual(entry.payload, input.data.payload) &&
      entry.supersedes?.entryId === input.data.supersedes.entryId &&
      entry.supersedes.entrySequence === input.data.supersedes.entrySequence &&
      entry.supersedes.kind === 'correction' &&
      entry.supersedes.reason === input.data.supersedes.reason
    );
  }

  if (
    command.operation !== 'correct-text' &&
    command.operation !== 'redact-entry'
  ) {
    return false;
  }
  const expectedKeys =
    command.operation === 'correct-text'
      ? [
          'operation',
          'entryId',
          'entrySequence',
          'text',
          'reason',
          'clientTime',
        ]
      : ['operation', 'entryId', 'entrySequence', 'reason', 'clientTime'];
  const supersedes = entry.supersedes;
  if (
    !hasExactKeys(body, expectedKeys) ||
    body.operation !== command.operation ||
    typeof body.entryId !== 'string' ||
    typeof body.entrySequence !== 'number' ||
    typeof body.reason !== 'string' ||
    entry.kind !== 'text' ||
    supersedes === null ||
    supersedes.entryId !== body.entryId ||
    supersedes.entrySequence !== body.entrySequence ||
    supersedes.kind !==
      (command.operation === 'correct-text' ? 'correction' : 'redaction') ||
    supersedes.reason !== body.reason
  ) {
    return false;
  }
  return command.operation === 'correct-text'
    ? typeof body.text === 'string' && entry.payload.text === body.text
    : entry.payload.text ===
        '[Content redacted — original retained in journal]';
}

function parseTimelinePage(value: unknown, baselineEvent: Event): TimelinePage {
  const parsed = EventRoomSyncResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.eventId !== baselineEvent.id) {
    throw new EventRoomRequestError(
      'PSD EOC returned an invalid timeline response.',
      false,
    );
  }
  const returnedEvent = parsed.data.event;
  if (returnedEvent !== null) {
    assertImmutableEventIdentity(returnedEvent, baselineEvent);
  }
  return {
    event: returnedEvent,
    entries: parsed.data.entries,
    cursor: parsed.data.cursor,
    hasMore: parsed.data.hasMore,
    snapshotSequence: parsed.data.snapshotSequence,
  };
}

function parseMutationResult(
  command: RetainedCommand,
  response: RetainedCommandResponse,
  baselineEvent: Event,
): MutationResult {
  const { value } = response;
  const operation = command.operation;
  if (operation === 'all-clear' || operation === 'close') {
    if (!isRecord(value)) {
      throw new EventRoomRequestError(
        'PSD EOC returned an incomplete lifecycle response. The exact request is retained for verification.',
        true,
      );
    }
    const candidate = {
      event: value.event,
      transition: value.transition,
      journalEntries: value.journalEntries ?? value.entries,
      notificationIntent: value.notificationIntent,
      preparedActivationConsumption: value.preparedActivationConsumption,
    };
    const parsed =
      operation === 'all-clear'
        ? AllClearEventResultSchema.safeParse(candidate)
        : CloseEventResultSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new EventRoomRequestError(
        'PSD EOC returned lifecycle evidence that does not prove the requested state change. The exact request is retained for verification.',
        true,
      );
    }
    const body: unknown = JSON.parse(command.bodyJson);
    const transition = parsed.data.transition;
    if (
      !isRecord(body) ||
      transition.actor.kind !== 'human' ||
      transition.actor.sessionId !== command.ownerSessionId ||
      transition.source !== 'web' ||
      response.transitionIdempotencyKey === null ||
      transition.idempotencyKey !== response.transitionIdempotencyKey
    ) {
      throw new EventRoomRequestError(
        'PSD EOC returned lifecycle evidence for a different authenticated request. The exact request is retained for verification.',
        true,
      );
    }
    if (operation === 'all-clear') {
      const expectedPreviewId =
        typeof body.lifecyclePreviewId === 'string'
          ? body.lifecyclePreviewId
          : null;
      const authorization =
        parsed.data.transition.transition === 'all-clear'
          ? parsed.data.transition.notificationAuthorization
          : null;
      if (
        !hasExactKeys(body, [
          'operation',
          'lifecyclePreviewId',
          'confirmationPhrase',
        ]) ||
        body.operation !== 'all-clear' ||
        body.confirmationPhrase !== 'ALL CLEAR' ||
        expectedPreviewId === null ||
        authorization?.lifecyclePreviewId !== expectedPreviewId
      ) {
        throw new EventRoomRequestError(
          'PSD EOC returned lifecycle evidence for a different consequence preview. The exact request is retained for verification.',
          true,
        );
      }
    } else if (
      !hasExactKeys(body, ['operation', 'confirmationPhrase']) ||
      body.operation !== 'close' ||
      body.confirmationPhrase !== 'CLOSE EVENT'
    ) {
      throw new EventRoomRequestError(
        'PSD EOC returned close evidence for a different command. The exact request is retained for verification.',
        true,
      );
    }
    assertImmutableEventIdentity(parsed.data.event, baselineEvent, true);
    const entries = canonicalEntries(
      parsed.data.journalEntries,
      baselineEvent.id,
    ).map(visibleJournalEntry);
    return { event: parsed.data.event, entries };
  }

  const directEntry = JournalEntrySchema.safeParse(value);
  const record = isRecord(value) ? value : null;
  const entryCandidate = record?.entry;
  const parsedEntry = JournalEntrySchema.safeParse(entryCandidate);
  const arrayCandidate = record?.journalEntries ?? record?.entries;
  let entries: readonly JournalEntry[] = [];
  if (directEntry.success) {
    entries = [directEntry.data];
  } else if (parsedEntry.success) {
    entries = [parsedEntry.data];
  } else if (arrayCandidate !== undefined) {
    entries = canonicalEntries(arrayCandidate, baselineEvent.id);
  }
  if (entries.some((entry) => entry.eventId !== baselineEvent.id)) {
    throw new EventRoomRequestError(
      'PSD EOC returned a journal entry for a different event.',
      true,
    );
  }

  const parsedEvent = EventSchema.safeParse(record?.event);
  const returnedEvent = parsedEvent.success ? parsedEvent.data : null;
  if (returnedEvent !== null) {
    assertImmutableEventIdentity(returnedEvent, baselineEvent, true);
  }

  if (entries.length === 0) {
    throw new EventRoomRequestError(
      'PSD EOC returned an incomplete success response. The exact request is retained for verification.',
      true,
    );
  }
  if (
    entries.length !== 1 ||
    !journalEntryProvesCommand(command, entries[0]!)
  ) {
    throw new EventRoomRequestError(
      'PSD EOC returned journal evidence for a different request. The exact request is retained for verification.',
      true,
    );
  }
  return {
    event: returnedEvent,
    entries: entries.map(visibleJournalEntry),
  };
}

interface DeadlineSignal {
  readonly signal: AbortSignal;
  readonly didExpire: () => boolean;
  readonly dispose: () => void;
}

function deadlineSignal(
  parentSignal: AbortSignal | null,
  milliseconds: number,
): DeadlineSignal {
  const controller = new AbortController();
  let expired = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = window.setTimeout(() => {
    expired = true;
    controller.abort(
      new DOMException('The request timed out.', 'TimeoutError'),
    );
  }, milliseconds);
  return {
    signal: controller.signal,
    didExpire: () => expired,
    dispose: () => {
      window.clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function parseLifecyclePreview(
  value: unknown,
  baselineEvent: Event,
): LifecycleConsequencePreview {
  const candidate =
    isRecord(value) && value.preview !== undefined ? value.preview : value;
  const parsed = LifecycleConsequencePreviewSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.eventId !== baselineEvent.id ||
    parsed.data.purpose !== 'all-clear' ||
    parsed.data.kind !== baselineEvent.kind ||
    parsed.data.templateMode !== baselineEvent.templateMode ||
    parsed.data.eventTypeVersion.id !== baselineEvent.eventTypeVersion.id ||
    parsed.data.eventTypeVersion.templateMode !==
      baselineEvent.eventTypeVersion.templateMode ||
    parsed.data.rosterSnapshotId !== baselineEvent.rosterSnapshotId ||
    parsed.data.rosterPopulation !== baselineEvent.rosterPopulation
  ) {
    throw new EventRoomRequestError(
      'PSD EOC returned an invalid all-clear consequence preview.',
      false,
    );
  }
  return parsed.data;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new EventRoomRequestError(
      response.ok
        ? 'PSD EOC returned an incomplete success response.'
        : 'PSD EOC returned an unreadable error response.',
      response.ok,
    );
  }
}

function publicErrorMessage(value: unknown, fallback: string): string {
  const parsed = ApiErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.message : fallback;
}

function mediaIdempotencyKey(purpose: 'create' | 'complete'): string {
  return IdempotencyKeySchema.parse(
    `event-photo-${purpose}-${crypto.randomUUID()}`,
  );
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

function validatePhotoFile(file: File): void {
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

async function createPhotoUploadIntent(
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

async function putPhotoBytes(
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

async function completePhotoUpload(
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

function timelineUrl(apiUrl: string, cursor: string | null): string {
  const url = new URL(apiUrl, window.location.href);
  url.searchParams.delete('operation');
  if (cursor === null) url.searchParams.delete('cursor');
  else url.searchParams.set('cursor', cursor);
  return url.toString();
}

async function requestTimelinePage(
  apiUrl: string,
  cursor: string | null,
  baselineEvent: Event,
  signal: AbortSignal,
): Promise<TimelinePage> {
  const deadline = deadlineSignal(signal, QUERY_DEADLINE_MILLISECONDS);
  try {
    const response = await fetch(timelineUrl(apiUrl, cursor), {
      credentials: 'same-origin',
      signal: deadline.signal,
    });
    const value = await readJson(response);
    if (!response.ok) {
      throw new EventRoomRequestError(
        publicErrorMessage(
          value,
          'Timeline updates are temporarily unavailable.',
        ),
        false,
      );
    }
    return parseTimelinePage(value, baselineEvent);
  } catch (error) {
    if (signal.aborted && !deadline.didExpire()) throw error;
    if (error instanceof EventRoomRequestError && !deadline.didExpire()) {
      throw error;
    }
    throw new EventRoomRequestError(
      deadline.didExpire()
        ? 'Timeline refresh timed out.'
        : 'Timeline updates are temporarily unavailable.',
      false,
    );
  } finally {
    deadline.dispose();
  }
}

async function requestLifecyclePreview(
  apiUrl: string,
  baselineEvent: Event,
  csrfCookieName: string,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<LifecycleConsequencePreview> {
  const csrf = csrfToken(csrfCookieName);
  if (csrf === null) {
    throw new EventRoomRequestError(
      'Your session is missing its request-protection cookie. No notification was sent.',
      false,
    );
  }
  const deadline = deadlineSignal(signal, QUERY_DEADLINE_MILLISECONDS);
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'X-PSD-EOC-CSRF': csrf,
      },
      body: JSON.stringify({ operation: 'preview-all-clear' }),
      signal: deadline.signal,
    });
    if (
      response.ok &&
      response.headers.get('idempotency-key') !== idempotencyKey
    ) {
      throw new EventRoomRequestError(
        'PSD EOC did not acknowledge the exact preview request key. Retry will use the same request key.',
        true,
      );
    }
    const value = await readJson(response);
    if (!response.ok) {
      throw new EventRoomRequestError(
        publicErrorMessage(
          value,
          'The all-clear preview could not be loaded. No notification was sent.',
        ),
        false,
      );
    }
    return parseLifecyclePreview(value, baselineEvent);
  } catch (error) {
    if (signal.aborted && !deadline.didExpire()) throw error;
    if (error instanceof EventRoomRequestError && !deadline.didExpire()) {
      throw error;
    }
    throw new EventRoomRequestError(
      deadline.didExpire()
        ? 'The all-clear preview timed out. No notification was sent.'
        : 'The all-clear preview could not be loaded. No notification was sent.',
      false,
    );
  } finally {
    deadline.dispose();
  }
}

function csrfToken(cookieName: string): string | null {
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (cookie === undefined) return null;
  try {
    return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  } catch {
    return null;
  }
}

async function postRetainedCommand(
  command: RetainedCommand,
  csrfCookieName: string,
): Promise<RetainedCommandResponse> {
  const csrf = csrfToken(csrfCookieName);
  if (csrf === null) {
    throw new EventRoomRequestError(
      'Your session is missing its request-protection cookie. Sign in again before retrying.',
      false,
    );
  }
  const deadline = deadlineSignal(null, MUTATION_DEADLINE_MILLISECONDS);
  try {
    const response = await fetch(command.apiUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': command.idempotencyKey,
        'X-PSD-EOC-CSRF': csrf,
      },
      body: command.bodyJson,
      signal: deadline.signal,
    });
    if (
      response.ok &&
      response.headers.get('idempotency-key') !== command.idempotencyKey
    ) {
      throw new EventRoomRequestError(
        'PSD EOC did not acknowledge the exact request key. The exact request is retained for verification.',
        true,
      );
    }
    let value: unknown;
    try {
      value = await readJson(response);
    } catch (error) {
      if (error instanceof EventRoomRequestError && response.ok) throw error;
      value = null;
    }
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(value);
      const definitelyRejected =
        response.status >= 400 &&
        response.status < 500 &&
        parsed.success &&
        !parsed.data.retryable;
      throw new EventRoomRequestError(
        publicErrorMessage(value, 'PSD EOC could not complete the request.'),
        !definitelyRejected,
      );
    }
    return {
      value,
      transitionIdempotencyKey: response.headers.get(
        'x-psd-eoc-transition-idempotency-key',
      ),
    };
  } catch (error) {
    if (error instanceof EventRoomRequestError && !deadline.didExpire()) {
      throw error;
    }
    throw new EventRoomRequestError(
      deadline.didExpire()
        ? 'PSD EOC did not confirm the request before the safety deadline. The exact request is retained and will not retry automatically.'
        : 'The connection ended before PSD EOC confirmed the result. The exact request is retained and will not retry automatically.',
      true,
    );
  } finally {
    deadline.dispose();
  }
}

function isCommandOperation(value: unknown): value is CommandOperation {
  return (
    value === 'post-text' ||
    value === 'post-photo' ||
    value === 'post-location' ||
    value === 'correct-text' ||
    value === 'correct-location' ||
    value === 'redact-entry' ||
    value === 'all-clear' ||
    value === 'close'
  );
}

function recoveryStorageKey(eventId: string): string {
  return `psd-eoc:event-room:pending:v1:${eventId}`;
}

function parseRetainedCommand(
  value: string,
  eventId: string,
  apiUrl: string,
  ownerSessionId: string,
): RetainedCommand {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== RECOVERY_RECORD_VERSION ||
    parsed.eventId !== eventId ||
    parsed.ownerSessionId !== ownerSessionId ||
    !UuidSchema.safeParse(parsed.ownerSessionId).success ||
    parsed.apiUrl !== apiUrl ||
    !isCommandOperation(parsed.operation) ||
    typeof parsed.idempotencyKey !== 'string' ||
    !IdempotencyKeySchema.safeParse(parsed.idempotencyKey).success ||
    typeof parsed.bodyJson !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    throw new Error('The retained event-room request is invalid.');
  }
  const body: unknown = JSON.parse(parsed.bodyJson);
  if (!isRecord(body) || body.operation !== parsed.operation) {
    throw new Error('The retained event-room request body is invalid.');
  }
  return {
    version: RECOVERY_RECORD_VERSION,
    eventId,
    ownerSessionId,
    apiUrl,
    operation: parsed.operation,
    idempotencyKey: parsed.idempotencyKey,
    bodyJson: parsed.bodyJson,
    createdAt: parsed.createdAt,
  };
}

function readRetainedCommand(
  eventId: string,
  apiUrl: string,
  ownerSessionId: string,
): RetainedCommand | null {
  const value = window.sessionStorage.getItem(recoveryStorageKey(eventId));
  return value === null
    ? null
    : parseRetainedCommand(value, eventId, apiUrl, ownerSessionId);
}

function retainCommand(command: RetainedCommand): void {
  const key = recoveryStorageKey(command.eventId);
  if (window.sessionStorage.getItem(key) !== null) {
    throw new Error('Another unresolved event-room request is retained.');
  }
  const serialized = JSON.stringify(command);
  window.sessionStorage.setItem(key, serialized);
  const verified = window.sessionStorage.getItem(key);
  if (
    verified === null ||
    parseRetainedCommand(
      verified,
      command.eventId,
      command.apiUrl,
      command.ownerSessionId,
    ).idempotencyKey !== command.idempotencyKey
  ) {
    throw new Error('The browser could not verify the recovery record.');
  }
}

function clearRetainedCommand(command: RetainedCommand): void {
  const key = recoveryStorageKey(command.eventId);
  const existing = window.sessionStorage.getItem(key);
  if (existing === null) return;
  const parsed = parseRetainedCommand(
    existing,
    command.eventId,
    command.apiUrl,
    command.ownerSessionId,
  );
  if (parsed.idempotencyKey !== command.idempotencyKey) {
    throw new Error('A different unresolved event-room request is retained.');
  }
  window.sessionStorage.removeItem(key);
}

function photoCompletionStorageKey(eventId: string): string {
  return `psd-eoc:event-room:photo-completion:v1:${eventId}`;
}

function parsePendingPhotoCompletion(
  value: string,
  eventId: string,
  ownerSessionId: string,
): PendingPhotoCompletion {
  const parsed: unknown = JSON.parse(value);
  const expectedKeys = [
    'version',
    'eventId',
    'ownerSessionId',
    'uploadIntentId',
    'mediaId',
    'idempotencyKey',
    'postIdempotencyKey',
    'altText',
    'caption',
    'clientTime',
    'createdAt',
  ];
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(parsed, key)) ||
    parsed.version !== PHOTO_COMPLETION_RECORD_VERSION ||
    parsed.eventId !== eventId ||
    parsed.ownerSessionId !== ownerSessionId ||
    !UuidSchema.safeParse(parsed.ownerSessionId).success ||
    !UuidSchema.safeParse(parsed.uploadIntentId).success ||
    (parsed.mediaId !== null &&
      !UuidSchema.safeParse(parsed.mediaId).success) ||
    !IdempotencyKeySchema.safeParse(parsed.idempotencyKey).success ||
    !IdempotencyKeySchema.safeParse(parsed.postIdempotencyKey).success ||
    typeof parsed.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    throw new Error('The retained photo-validation request is invalid.');
  }
  const photoInput = AppendJournalEntryInputSchema.safeParse({
    eventId: parsed.eventId,
    clientTime: parsed.clientTime,
    supersedes: null,
    kind: 'photo',
    payload: {
      mediaId: parsed.uploadIntentId,
      altText: parsed.altText,
      caption: parsed.caption,
    },
  });
  if (
    !photoInput.success ||
    photoInput.data.kind !== 'photo' ||
    photoInput.data.clientTime === null
  ) {
    throw new Error('The retained photo-validation payload is invalid.');
  }
  return {
    version: PHOTO_COMPLETION_RECORD_VERSION,
    eventId: photoInput.data.eventId,
    ownerSessionId,
    uploadIntentId: photoInput.data.payload.mediaId,
    mediaId: parsed.mediaId === null ? null : UuidSchema.parse(parsed.mediaId),
    idempotencyKey: IdempotencyKeySchema.parse(parsed.idempotencyKey),
    postIdempotencyKey: IdempotencyKeySchema.parse(parsed.postIdempotencyKey),
    altText: photoInput.data.payload.altText,
    caption: photoInput.data.payload.caption,
    clientTime: photoInput.data.clientTime,
    createdAt: parsed.createdAt,
  };
}

function readPendingPhotoCompletion(
  eventId: string,
  ownerSessionId: string,
): PendingPhotoCompletion | null {
  const value = window.sessionStorage.getItem(
    photoCompletionStorageKey(eventId),
  );
  return value === null
    ? null
    : parsePendingPhotoCompletion(value, eventId, ownerSessionId);
}

function retainPendingPhotoCompletion(pending: PendingPhotoCompletion): void {
  const key = photoCompletionStorageKey(pending.eventId);
  if (window.sessionStorage.getItem(key) !== null) {
    throw new Error('Another unresolved photo validation is retained.');
  }
  window.sessionStorage.setItem(key, JSON.stringify(pending));
  const verified = window.sessionStorage.getItem(key);
  if (
    verified === null ||
    parsePendingPhotoCompletion(
      verified,
      pending.eventId,
      pending.ownerSessionId,
    ).idempotencyKey !== pending.idempotencyKey
  ) {
    throw new Error('The browser could not verify the photo recovery record.');
  }
}

function clearPendingPhotoCompletion(pending: PendingPhotoCompletion): void {
  const key = photoCompletionStorageKey(pending.eventId);
  const existing = window.sessionStorage.getItem(key);
  if (existing === null) return;
  const parsed = parsePendingPhotoCompletion(
    existing,
    pending.eventId,
    pending.ownerSessionId,
  );
  if (
    parsed.idempotencyKey !== pending.idempotencyKey ||
    parsed.uploadIntentId !== pending.uploadIntentId ||
    parsed.mediaId !== pending.mediaId ||
    parsed.postIdempotencyKey !== pending.postIdempotencyKey
  ) {
    throw new Error('A different unresolved photo validation is retained.');
  }
  window.sessionStorage.removeItem(key);
}

function recordCompletedPhotoMedia(
  pending: PendingPhotoCompletion,
  mediaId: string,
): PendingPhotoCompletion {
  const key = photoCompletionStorageKey(pending.eventId);
  const existingValue = window.sessionStorage.getItem(key);
  if (existingValue === null) {
    throw new Error('The photo recovery record is missing.');
  }
  const existing = parsePendingPhotoCompletion(
    existingValue,
    pending.eventId,
    pending.ownerSessionId,
  );
  if (
    existing.uploadIntentId !== pending.uploadIntentId ||
    existing.idempotencyKey !== pending.idempotencyKey ||
    existing.postIdempotencyKey !== pending.postIdempotencyKey ||
    existing.altText !== pending.altText ||
    existing.caption !== pending.caption ||
    existing.clientTime !== pending.clientTime ||
    existing.createdAt !== pending.createdAt
  ) {
    throw new Error('A different photo recovery record is retained.');
  }
  const canonicalMediaId = UuidSchema.parse(mediaId);
  if (existing.mediaId !== null && existing.mediaId !== canonicalMediaId) {
    throw new Error('The completed photo media evidence changed.');
  }
  const completed: PendingPhotoCompletion = {
    ...existing,
    mediaId: canonicalMediaId,
  };
  window.sessionStorage.setItem(key, JSON.stringify(completed));
  const verified = window.sessionStorage.getItem(key);
  if (
    verified === null ||
    parsePendingPhotoCompletion(
      verified,
      pending.eventId,
      pending.ownerSessionId,
    ).mediaId !== canonicalMediaId
  ) {
    throw new Error('The browser could not verify completed photo evidence.');
  }
  return completed;
}

function makePendingPhotoCompletion(
  eventId: string,
  ownerSessionId: string,
  uploadIntentId: string,
  altText: string,
  caption: string | null,
  clientTime: string,
): PendingPhotoCompletion {
  const input = AppendJournalEntryInputSchema.parse({
    eventId,
    clientTime,
    supersedes: null,
    kind: 'photo',
    payload: {
      mediaId: uploadIntentId,
      altText,
      caption,
    },
  });
  if (input.kind !== 'photo' || input.clientTime === null) {
    throw new Error('The photo recovery payload is invalid.');
  }
  return {
    version: PHOTO_COMPLETION_RECORD_VERSION,
    eventId: input.eventId,
    ownerSessionId: UuidSchema.parse(ownerSessionId),
    uploadIntentId: input.payload.mediaId,
    mediaId: null,
    idempotencyKey: mediaIdempotencyKey('complete'),
    postIdempotencyKey: IdempotencyKeySchema.parse(
      `event-room-${crypto.randomUUID()}`,
    ),
    altText: input.payload.altText,
    caption: input.payload.caption,
    clientTime: input.clientTime,
    createdAt: new Date().toISOString(),
  };
}

function makeRetainedCommand(
  eventId: string,
  apiUrl: string,
  ownerSessionId: string,
  body: CommandBody,
  idempotencyKey = `event-room-${crypto.randomUUID()}`,
): RetainedCommand {
  return {
    version: RECOVERY_RECORD_VERSION,
    eventId,
    ownerSessionId: UuidSchema.parse(ownerSessionId),
    apiUrl,
    operation: body.operation,
    idempotencyKey: IdempotencyKeySchema.parse(idempotencyKey),
    bodyJson: JSON.stringify(body),
    createdAt: new Date().toISOString(),
  };
}

function retainedPhotoCommandMatches(
  command: RetainedCommand,
  pending: PendingPhotoCompletion,
): boolean {
  if (
    command.operation !== 'post-photo' ||
    pending.mediaId === null ||
    command.idempotencyKey !== pending.postIdempotencyKey
  ) {
    return false;
  }
  const body: unknown = JSON.parse(command.bodyJson);
  const expectedKeys = [
    'operation',
    'mediaId',
    'altText',
    'caption',
    'clientTime',
  ];
  if (
    !isRecord(body) ||
    Object.keys(body).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(body, key)) ||
    body.operation !== 'post-photo'
  ) {
    return false;
  }
  const input = AppendJournalEntryInputSchema.safeParse({
    eventId: command.eventId,
    clientTime: body.clientTime,
    supersedes: null,
    kind: 'photo',
    payload: {
      mediaId: body.mediaId,
      altText: body.altText,
      caption: body.caption,
    },
  });
  return (
    input.success &&
    input.data.kind === 'photo' &&
    input.data.eventId === pending.eventId &&
    input.data.clientTime === pending.clientTime &&
    input.data.payload.mediaId === pending.mediaId &&
    input.data.payload.altText === pending.altText &&
    input.data.payload.caption === pending.caption
  );
}

function clearMatchingPhotoCompletion(command: RetainedCommand): boolean {
  if (command.operation !== 'post-photo') return true;
  try {
    const pending = readPendingPhotoCompletion(
      command.eventId,
      command.ownerSessionId,
    );
    if (pending === null) return true;
    if (!retainedPhotoCommandMatches(command, pending)) return false;
    clearPendingPhotoCompletion(pending);
    return true;
  } catch {
    return false;
  }
}

function commandLabel(operation: CommandOperation): string {
  switch (operation) {
    case 'post-text':
      return 'timeline post';
    case 'post-photo':
      return 'photo post';
    case 'post-location':
      return 'location post';
    case 'correct-text':
      return 'timeline correction';
    case 'correct-location':
      return 'location correction';
    case 'redact-entry':
      return 'timeline redaction';
    case 'all-clear':
      return 'all-clear';
    case 'close':
      return 'event close';
  }
}

function readableDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  }).format(new Date(value));
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

type JournalReadMetadata = JournalEntryReadProjection['entry'];

function actorLabel(entry: JournalReadMetadata): string {
  switch (entry.author.kind) {
    case 'human':
      return 'Authenticated staff member';
    case 'agent':
      return 'Authorized district agent';
    case 'system':
      return 'PSD EOC system';
  }
}

function entryKindLabel(entry: JournalReadMetadata): string {
  switch (entry.kind) {
    case 'text':
      return 'Text update';
    case 'photo':
      return 'Photo update';
    case 'location':
      return 'Location update';
    case 'system':
      return 'System update';
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

export function eventRoomPollDelay(
  failureCount: number,
  jitterUnit = Math.random(),
): number {
  const jittered =
    POLL_MINIMUM_MILLISECONDS +
    Math.min(1, Math.max(0, jitterUnit)) * POLL_JITTER_MILLISECONDS;
  const multiplier = 2 ** Math.min(failureCount, 3);
  return Math.min(
    POLL_MAXIMUM_BACKOFF_MILLISECONDS,
    Math.round(jittered * multiplier),
  );
}

function waitForDocumentVisibility(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (document.visibilityState !== 'hidden') return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (visible: boolean) => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      signal.removeEventListener('abort', aborted);
      resolve(visible);
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== 'hidden') finish(true);
    };
    const aborted = () => finish(false);
    document.addEventListener('visibilitychange', visibilityChanged);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function waitForNextPoll(
  signal: AbortSignal,
  milliseconds: number,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let observedHidden = document.visibilityState === 'hidden';
    const finish = (continued: boolean) => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      signal.removeEventListener('abort', abort);
      resolve(continued);
    };
    const timer = window.setTimeout(() => finish(true), milliseconds);
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') {
        observedHidden = true;
      } else if (observedHidden) {
        finish(true);
      }
    };
    const abort = () => finish(false);
    document.addEventListener('visibilitychange', visibilityChanged);
    signal.addEventListener('abort', abort, { once: true });
  });
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

/**
 * Per-event scheduler for untrusted private images. It bounds authorization,
 * transfer, and decode work independently of journal length. Explicit staff
 * requests receive priority, but never bypass the concurrency or resident-set
 * limits.
 */
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
  | 'checking'
  | 'available'
  | 'unavailable'
  | 'disabled';

function AuthorizedPhoto({
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
        <img
          alt={altText}
          className="timeline-photo"
          decoding="async"
          loading={explicitDemand ? 'eager' : 'lazy'}
          onError={() => failDisplayedImage(readUrl)}
          onLoad={(event) => finishDecodedImage(event.currentTarget)}
          ref={(image) => {
            imageElementRef.current = image;
          }}
          referrerPolicy="no-referrer"
          src={readUrl}
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

type PrivatePhotoMountMode = 'recent' | 'selected-older' | 'deferred-older';

function DeferredPrivatePhoto({
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

class LocationMapBoundary extends Component<
  Readonly<{ children: ReactNode }>,
  Readonly<{ failed: boolean }>
> {
  public override state = { failed: false };

  public static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
    return { failed: true };
  }

  public override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="location-map-fallback" role="status">
          Map unavailable. The complete location text remains available.
        </p>
      );
    }
    return this.props.children;
  }
}

function SafeLocationMap({
  payload,
  mode,
  ariaLabel,
  onCoordinatesChange,
}: Readonly<{
  payload: Extract<LocationPayload, { state: 'known' }>;
  mode: 'display' | 'edit';
  ariaLabel: string;
  onCoordinatesChange?: (coordinates: {
    latitude: number;
    longitude: number;
  }) => void;
}>) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="location-map-fallback" role="status">
        Map unavailable. The complete location text and posting controls remain
        available.
      </p>
    );
  }
  return (
    <LocationMapBoundary>
      {mode === 'edit' && onCoordinatesChange !== undefined ? (
        <LocationMap
          ariaLabel={ariaLabel}
          mode="edit"
          onCoordinatesChange={onCoordinatesChange}
          onError={() => setFailed(true)}
          payload={payload}
        />
      ) : (
        <LocationMap
          ariaLabel={ariaLabel}
          mode="display"
          onError={() => setFailed(true)}
          payload={payload}
        />
      )}
    </LocationMapBoundary>
  );
}

function LocationEditor({
  draft,
  idPrefix,
  onChange,
}: Readonly<{
  draft: LocationDraft;
  idPrefix: string;
  onChange: (draft: LocationDraft) => void;
}>) {
  const [geolocationStatus, setGeolocationStatus] = useState('');
  const [locating, setLocating] = useState(false);
  const geolocationRequestRef = useRef(0);
  const currentDraftRef = useRef(draft);
  currentDraftRef.current = draft;
  const payload = locationPayloadFromDraft(draft);
  const knownPayload = payload?.state === 'known' ? payload : null;

  useEffect(
    () => () => {
      geolocationRequestRef.current += 1;
    },
    [],
  );

  function update(patch: Partial<LocationDraft>): void {
    const nextDraft = { ...draft, ...patch };
    currentDraftRef.current = nextDraft;
    onChange(nextDraft);
  }

  function changeState(
    state: LocationPayload['state'],
    patch: Partial<LocationDraft> = {},
  ): void {
    geolocationRequestRef.current += 1;
    if (locating) {
      setLocating(false);
      setGeolocationStatus(
        'The pending device-location result was ignored after the location state changed.',
      );
    }
    update({ state, ...patch });
  }

  function requestCurrentLocation(): void {
    if (locating) return;
    if (!('geolocation' in navigator)) {
      setGeolocationStatus(
        'This browser cannot provide a device location. Choose ambiguous or unknown instead.',
      );
      return;
    }
    setLocating(true);
    setGeolocationStatus('Requesting the current device location…');
    const requestGeneration = geolocationRequestRef.current + 1;
    geolocationRequestRef.current = requestGeneration;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (geolocationRequestRef.current !== requestGeneration) return;
        const currentDraft = currentDraftRef.current;
        if (currentDraft.state !== 'known') return;
        const captured = LocationPayloadSchema.safeParse({
          state: 'known',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          label:
            currentDraft.label.trim().length === 0
              ? null
              : currentDraft.label.trim(),
        });
        setLocating(false);
        if (!captured.success || captured.data.state !== 'known') {
          setGeolocationStatus(
            'The browser returned invalid location evidence. Nothing was posted; choose ambiguous or unknown instead.',
          );
          return;
        }
        onChange(locationDraftFromPayload(captured.data));
        setGeolocationStatus(
          'Device location captured. Review the accuracy radius and correct the pin before posting.',
        );
      },
      () => {
        if (geolocationRequestRef.current !== requestGeneration) return;
        setLocating(false);
        setGeolocationStatus(
          'The device location was not available. Nothing was posted; choose ambiguous or unknown instead.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
    );
  }

  return (
    <div className="location-editor">
      <fieldset className="location-state-options">
        <legend>Location certainty</legend>
        <label>
          <input
            checked={draft.state === 'known'}
            data-autofocus={draft.state === 'known' ? true : undefined}
            name={`${idPrefix}-state`}
            onChange={() => changeState('known', { reason: '' })}
            type="radio"
            value="known"
          />{' '}
          Known coordinates
        </label>
        <label>
          <input
            checked={draft.state === 'ambiguous'}
            data-autofocus={draft.state === 'ambiguous' ? true : undefined}
            name={`${idPrefix}-state`}
            onChange={() => changeState('ambiguous')}
            type="radio"
            value="ambiguous"
          />{' '}
          Ambiguous location
        </label>
        <label>
          <input
            checked={draft.state === 'unknown'}
            data-autofocus={draft.state === 'unknown' ? true : undefined}
            name={`${idPrefix}-state`}
            onChange={() => changeState('unknown', { label: '' })}
            type="radio"
            value="unknown"
          />{' '}
          Unknown location
        </label>
      </fieldset>

      {draft.state === 'known' ? (
        <>
          <button
            className="secondary"
            disabled={locating}
            onClick={requestCurrentLocation}
            type="button"
          >
            {locating ? 'Locating device…' : 'Use current device location'}
          </button>
          <p className="field-help">
            GPS accuracy is a radius and never establishes room-level precision.
            Review the visible radius, then drag the pin or edit the coordinates
            before posting.
          </p>
          <div className="location-coordinate-grid">
            <div className="field">
              <label htmlFor={`${idPrefix}-latitude`}>Latitude</label>
              <input
                id={`${idPrefix}-latitude`}
                max={90}
                min={-90}
                onChange={(change) =>
                  update({ latitude: change.currentTarget.value })
                }
                required
                step="any"
                type="number"
                value={draft.latitude}
              />
            </div>
            <div className="field">
              <label htmlFor={`${idPrefix}-longitude`}>Longitude</label>
              <input
                id={`${idPrefix}-longitude`}
                max={180}
                min={-180}
                onChange={(change) =>
                  update({ longitude: change.currentTarget.value })
                }
                required
                step="any"
                type="number"
                value={draft.longitude}
              />
            </div>
          </div>
          <p className="location-accuracy" role="status">
            Accuracy radius:{' '}
            <strong>
              {draft.accuracyMeters.trim().length === 0
                ? 'not captured'
                : `±${draft.accuracyMeters} meters`}
            </strong>
          </p>
          <div className="field">
            <label htmlFor={`${idPrefix}-label`}>
              Location label (optional)
            </label>
            <input
              id={`${idPrefix}-label`}
              maxLength={200}
              onChange={(change) => update({ label: change.target.value })}
              type="text"
              value={draft.label}
            />
          </div>
          {knownPayload === null ? (
            <p className="location-map-fallback">
              Capture a device location to establish its accuracy radius. A
              known location cannot be posted without that evidence.
            </p>
          ) : (
            <SafeLocationMap
              ariaLabel="Adjustable location pin and browser accuracy radius"
              mode="edit"
              onCoordinatesChange={(coordinates) =>
                update({
                  latitude: String(coordinates.latitude),
                  longitude: String(coordinates.longitude),
                })
              }
              payload={knownPayload}
            />
          )}
        </>
      ) : draft.state === 'ambiguous' ? (
        <>
          <div className="field">
            <label htmlFor={`${idPrefix}-label`}>Best available label</label>
            <input
              id={`${idPrefix}-label`}
              maxLength={200}
              onChange={(change) => update({ label: change.target.value })}
              required
              type="text"
              value={draft.label}
            />
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-reason`}>
              Why the location is ambiguous
            </label>
            <textarea
              id={`${idPrefix}-reason`}
              maxLength={500}
              onChange={(change) => update({ reason: change.target.value })}
              required
              value={draft.reason}
            />
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor={`${idPrefix}-reason`}>
            Why the location is unknown
          </label>
          <textarea
            id={`${idPrefix}-reason`}
            maxLength={500}
            onChange={(change) => update({ reason: change.target.value })}
            required
            value={draft.reason}
          />
        </div>
      )}
      <p aria-atomic="true" aria-live="polite" className="location-status">
        {geolocationStatus}
      </p>
    </div>
  );
}

function LocationEntryContent({
  entryId,
  entrySequence,
  mapVisible,
  onToggleMap,
  payload,
}: Readonly<{
  entryId: string;
  entrySequence: number;
  mapVisible: boolean;
  onToggleMap: () => void;
  payload: LocationPayload;
}>) {
  const mapId = `location-map-${entryId}`;
  return (
    <div className="entry-content location-entry-content">
      <p className="location-text-equivalent">
        {formatLocationTextEquivalent(payload)}
      </p>
      {payload.state === 'known' ? (
        <>
          <button
            aria-controls={mapId}
            aria-expanded={mapVisible}
            className="secondary location-map-toggle"
            onClick={onToggleMap}
            type="button"
          >
            {mapVisible ? 'Hide' : 'Show'} map for entry {entrySequence}
          </button>
          <div hidden={!mapVisible} id={mapId}>
            {mapVisible ? (
              <SafeLocationMap
                ariaLabel={`Posted location pin and accuracy radius for entry ${entrySequence}`}
                mode="display"
                payload={payload}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function EntryContent({
  projection,
  redacted,
  loadCoordinator,
  scrollRootRef,
  photoMountMode,
  onActivateOlderPhoto,
  classificationLabel,
  realEvent,
  locationMapVisible,
  onToggleLocationMap,
}: Readonly<{
  projection: JournalEntryReadProjection;
  redacted: boolean;
  loadCoordinator: PrivatePhotoLoadCoordinator;
  scrollRootRef: Readonly<{ current: HTMLDivElement | null }>;
  photoMountMode: PrivatePhotoMountMode;
  onActivateOlderPhoto: () => void;
  classificationLabel: string;
  realEvent: boolean;
  locationMapVisible: boolean;
  onToggleLocationMap: () => void;
}>) {
  if (redacted || projection.visibility === 'redacted') {
    return (
      <p className="entry-content redacted-content">
        Original content is hidden because a later append-only redaction
        supersedes this entry. Its sequence, timing, and provenance remain in
        the journal.
      </p>
    );
  }
  const { entry } = projection;
  switch (entry.kind) {
    case 'text':
      return <p className="entry-content">{entry.payload.text}</p>;
    case 'photo':
      if (photoMountMode === 'deferred-older') {
        return (
          <DeferredPrivatePhoto
            altText={entry.payload.altText}
            caption={entry.payload.caption}
            entryId={entry.id}
            entrySequence={entry.sequence}
            onActivate={onActivateOlderPhoto}
            classificationLabel={classificationLabel}
            realEvent={realEvent}
          />
        );
      }
      return (
        <AuthorizedPhoto
          altText={entry.payload.altText}
          caption={entry.payload.caption}
          entryId={entry.id}
          entrySequence={entry.sequence}
          eventId={entry.eventId}
          loadExplicitlyOnMount={photoMountMode === 'selected-older'}
          loadCoordinator={loadCoordinator}
          mediaId={entry.payload.mediaId}
          observeViewport={photoMountMode === 'recent'}
          classificationLabel={classificationLabel}
          realEvent={realEvent}
          scrollRootRef={scrollRootRef}
        />
      );
    case 'location':
      return (
        <LocationEntryContent
          entryId={entry.id}
          entrySequence={entry.sequence}
          mapVisible={locationMapVisible}
          onToggleMap={onToggleLocationMap}
          payload={entry.payload}
        />
      );
    case 'system':
      return <p className="entry-content">{entry.payload.summary}</p>;
  }
}

interface TimelineEntryProps {
  readonly projection: JournalEntryReadProjection;
  readonly supersededBy: readonly JournalEntryReadProjection[];
  readonly commandsBlocked: boolean;
  readonly photoMountMode: PrivatePhotoMountMode;
  readonly photoLoadCoordinator: PrivatePhotoLoadCoordinator;
  readonly timelineScrollRef: Readonly<{
    current: HTMLDivElement | null;
  }>;
  readonly onCorrect: (entry: JournalEntry, opener: HTMLElement) => void;
  readonly onRedact: (entry: JournalEntry, opener: HTMLElement) => void;
  readonly onActivateOlderPhoto: (entryId: string) => void;
  readonly classificationLabel: string;
  readonly realEvent: boolean;
  readonly locationMapVisible: boolean;
  readonly onToggleLocationMap: () => void;
}

function TimelineEntry({
  projection,
  supersededBy,
  commandsBlocked,
  photoMountMode,
  photoLoadCoordinator,
  timelineScrollRef,
  onCorrect,
  onRedact,
  onActivateOlderPhoto,
  classificationLabel,
  realEvent,
  locationMapVisible,
  onToggleLocationMap,
}: TimelineEntryProps) {
  const { entry } = projection;
  const latestSupersession = supersededBy.at(-1) ?? null;
  const redacted =
    projection.visibility === 'redacted' ||
    supersededBy.some(
      (candidate) => candidate.entry.supersedes?.kind === 'redaction',
    );
  const visibleEntry =
    projection.visibility === 'visible' ? projection.entry : null;
  const mayCorrect =
    (visibleEntry?.kind === 'text' || visibleEntry?.kind === 'location') &&
    latestSupersession === null;
  const mayRedact =
    visibleEntry !== null && entry.kind !== 'system' && !redacted;
  const ownSupersession = entry.supersedes;
  const classes = [
    'timeline-entry',
    `entry-${entry.kind}`,
    ownSupersession === null ? '' : `entry-${ownSupersession.kind}`,
    latestSupersession === null ? '' : 'entry-superseded',
  ]
    .filter(Boolean)
    .join(' ');
  const headingId = `entry-${entry.id}-heading`;
  return (
    <article
      aria-labelledby={headingId}
      className={classes}
      id={`entry-${entry.id}`}
    >
      <div className="entry-heading">
        <h3 id={headingId}>
          Entry {entry.sequence}: {entryKindLabel(entry)}
        </h3>
        <time dateTime={entry.serverTime}>
          {readableDateTime(entry.serverTime)}
        </time>
      </div>

      {ownSupersession === null ? null : (
        <p className="supersession-notice">
          This entry is an appended {ownSupersession.kind} of{' '}
          <a href={`#entry-${ownSupersession.entryId}`}>
            entry {ownSupersession.entrySequence}
          </a>
          . Reason: {ownSupersession.reason}
        </p>
      )}

      {latestSupersession === null ? null : (
        <p className="supersession-notice">
          This original entry was superseded, not deleted. Latest:{' '}
          <a href={`#entry-${latestSupersession.entry.id}`}>
            {latestSupersession.entry.supersedes?.kind ?? 'update'} entry{' '}
            {latestSupersession.entry.sequence}
          </a>
          .
        </p>
      )}

      <EntryContent
        loadCoordinator={photoLoadCoordinator}
        onActivateOlderPhoto={() => onActivateOlderPhoto(entry.id)}
        photoMountMode={photoMountMode}
        projection={projection}
        classificationLabel={classificationLabel}
        realEvent={realEvent}
        locationMapVisible={locationMapVisible}
        onToggleLocationMap={onToggleLocationMap}
        redacted={redacted}
        scrollRootRef={timelineScrollRef}
      />
      <p className="entry-meta">
        <span>{actorLabel(entry)}</span>
        <span>Source: {entry.source}</span>
        <span>
          Client-reported time:{' '}
          {entry.clientTime === null
            ? 'not supplied'
            : readableDateTime(entry.clientTime)}
        </span>
      </p>

      {!mayCorrect && !mayRedact ? null : (
        <div className="entry-actions">
          {mayCorrect && visibleEntry !== null ? (
            <button
              aria-haspopup="dialog"
              className="secondary"
              disabled={commandsBlocked}
              onClick={(event) => onCorrect(visibleEntry, event.currentTarget)}
              type="button"
            >
              Correct entry {entry.sequence}
            </button>
          ) : null}
          {mayRedact && visibleEntry !== null ? (
            <button
              aria-haspopup="dialog"
              className="secondary"
              disabled={commandsBlocked}
              onClick={(event) => onRedact(visibleEntry, event.currentTarget)}
              type="button"
            >
              Redact entry {entry.sequence}
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

function renderedMessageContent(channel: ChannelConsequencePreview): ReactNode {
  const message = channel.renderedMessage;
  switch (message.channel) {
    case 'push':
      return (
        <>
          <p>
            <strong>Title:</strong> {message.title}
          </p>
          <p className="channel-copy">{message.body}</p>
        </>
      );
    case 'email':
      return (
        <>
          <p>
            <strong>Subject:</strong> {message.subject}
          </p>
          <p className="channel-copy">{message.textBody}</p>
        </>
      );
    case 'sms':
      return <p className="channel-copy">{message.body}</p>;
  }
}

function PreviewDetails({
  preview,
}: Readonly<{ preview: LifecycleConsequencePreview }>) {
  return (
    <section aria-labelledby="all-clear-consequences-heading">
      <h3 id="all-clear-consequences-heading">Notification consequences</h3>
      <ul className="consequence-list">
        <li>{preview.recipientCount} authorized roster recipients</li>
        <li>
          Roster population: {preview.rosterPopulation}
          {preview.rosterPopulation === 'synthetic'
            ? ' (provably unroutable training data)'
            : ''}
        </li>
        <li>
          Preview expires {readableDateTime(preview.expiresAt)}; an expired
          preview cannot be sent.
        </li>
      </ul>
      {preview.channels.map((channel) => (
        <details className="channel-preview" key={channel.channel} open>
          <summary>
            {channel.channel.toUpperCase()}: {channel.endpointCount} endpoints —{' '}
            {channel.integrationStatus.label}
          </summary>
          {renderedMessageContent(channel)}
        </details>
      ))}
      {preview.sendReadiness === 'blocked' ? (
        <div className="blocked-preview" role="alert">
          <strong>Sending is blocked.</strong>
          <p>
            PSD EOC will not issue this all-clear until the consequence preview
            is ready.
          </p>
          <ul>
            {preview.blockingReasonCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function DialogClassification({
  label,
  real,
}: Readonly<{ label: string; real: boolean }>) {
  return (
    <p className={`dialog-classification ${real ? 'mode-real' : 'mode-drill'}`}>
      <span aria-hidden="true">{real ? '⚠' : '◆'} </span>
      {label}
    </p>
  );
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
  csrfCookieName,
  sessionId,
  authorDisplayName,
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
  const [confirmationPhrase, setConfirmationPhrase] = useState('');
  const [pollRefreshVersion, setPollRefreshVersion] = useState(0);

  const cursorRef = useRef(initialCursor);
  const appliedSnapshotSequenceRef = useRef(initialSnapshotSequence);
  const requiredSyncSequenceRef = useRef<number | null>(null);
  const knownEntryIdsRef = useRef(
    new Set(initialEntries.map(({ entry }) => entry.id)),
  );
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
  const classificationLabel = realEvent
    ? 'REAL INCIDENT'
    : event.kind === 'test'
      ? 'TEST — TRAINING ONLY'
      : 'DRILL — TRAINING ONLY';

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
      const newEntries = incoming.filter(({ entry }) => {
        if (
          entry.eventId !== event.id ||
          knownEntryIdsRef.current.has(entry.id)
        ) {
          return false;
        }
        knownEntryIdsRef.current.add(entry.id);
        return true;
      });
      if (newEntries.length === 0) return;
      const nearEnd = isNearTimelineEnd();
      autoScrollRef.current = nearEnd;
      setEntries((existing) =>
        [...existing, ...newEntries].sort(compareEntries),
      );
      if (!nearEnd) setUnseenCount((count) => count + newEntries.length);
      if (announce) queueAnnouncement(newEntries.length);
    },
    [event.id, isNearTimelineEnd, queueAnnouncement],
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
    setConfirmationPhrase('');
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
    setConfirmationPhrase('');
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
    setConfirmationPhrase('');
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
    setConfirmationPhrase('');
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
        setConfirmationPhrase('');
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
        setConfirmationPhrase('');
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
      `Photo by ${authorDisplayName} at ${readableDateTime(new Date().toISOString())}. Visual details were not described.`,
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
      dialog.preview.sendReadiness !== 'ready' ||
      confirmationPhrase !== 'ALL CLEAR'
    ) {
      return;
    }
    const succeeded = await executeNewCommand({
      operation: 'all-clear',
      lifecyclePreviewId: dialog.preview.id,
      confirmationPhrase: 'ALL CLEAR',
    });
    if (succeeded) closeDialog();
  }

  async function submitClose(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (dialog?.kind !== 'close' || confirmationPhrase !== 'CLOSE EVENT') {
      return;
    }
    const succeeded = await executeNewCommand({
      operation: 'close',
      confirmationPhrase: 'CLOSE EVENT',
    });
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
          className={`classification-banner ${realEvent ? 'mode-real' : 'mode-drill'}`}
        >
          <span aria-hidden="true" className="classification-icon">
            {realEvent ? '⚠' : '◆'}
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
                      {readableDateTime(currentEvent.createdAt)}
                    </time>
                  </dd>
                </>
              ) : (
                <>
                  <dt>Started</dt>
                  <dd>
                    <time dateTime={startedAt}>
                      {readableDateTime(startedAt)}
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
                : `Updated ${readableDateTime(lastUpdatedAt)}`}
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
              PSD EOC will require a fresh consequence review and typed
              confirmation.
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
                <p>
                  The event is closed. Its complete journal remains retained.
                </p>
              ) : null}
            </div>
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
            setConfirmationPhrase('');
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
              journal entry, and starts the previewed notification fan-out. It
              does not close or delete the event.
            </p>
            {dialog.loading ? (
              <p role="status">Loading a fresh consequence preview…</p>
            ) : null}
            {dialog.error === null ? null : (
              <div className="error-panel" role="alert">
                <h3>Preview unavailable</h3>
                <p>{dialog.error}</p>
                <button
                  data-autofocus
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
                <fieldset
                  disabled={
                    lifecycleCommandsBlocked ||
                    dialog.preview.sendReadiness !== 'ready'
                  }
                >
                  <legend>Human confirmation</legend>
                  <div className="field">
                    <label htmlFor="all-clear-phrase">
                      Type ALL CLEAR exactly
                    </label>
                    <input
                      aria-describedby="all-clear-confirm-help"
                      autoComplete="off"
                      data-autofocus
                      id="all-clear-phrase"
                      onChange={(change) =>
                        setConfirmationPhrase(change.target.value)
                      }
                      spellCheck={false}
                      type="text"
                      value={confirmationPhrase}
                    />
                  </div>
                  <p className="field-help" id="all-clear-confirm-help">
                    This confirmation is case-sensitive and applies only to the
                    fresh preview shown above.
                  </p>
                </fieldset>
                <div className="form-actions">
                  <button
                    className="danger"
                    disabled={
                      lifecycleCommandsBlocked ||
                      dialog.preview.sendReadiness !== 'ready' ||
                      confirmationPhrase !== 'ALL CLEAR'
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
            <ul className="consequence-list">
              <li>The event has already reached the all-clear state.</li>
              <li>Closing appends a distinct journal entry.</li>
              <li>No journal history is deleted or rewritten.</li>
              <li>Closing does not send another all-clear notification.</li>
            </ul>
            <fieldset disabled={lifecycleCommandsBlocked}>
              <legend>Human confirmation</legend>
              <div className="field">
                <label htmlFor="close-event-phrase">
                  Type CLOSE EVENT exactly
                </label>
                <input
                  aria-describedby="close-confirm-help"
                  autoComplete="off"
                  data-autofocus
                  id="close-event-phrase"
                  onChange={(change) =>
                    setConfirmationPhrase(change.target.value)
                  }
                  spellCheck={false}
                  type="text"
                  value={confirmationPhrase}
                />
              </div>
              <p className="field-help" id="close-confirm-help">
                This confirmation is case-sensitive. Closing preserves the full
                append-only event record.
              </p>
            </fieldset>
            <div className="form-actions">
              <button
                className="caution"
                disabled={
                  lifecycleCommandsBlocked ||
                  confirmationPhrase !== 'CLOSE EVENT'
                }
                type="submit"
              >
                {pendingOperation === 'close'
                  ? 'Closing event…'
                  : 'Close event'}
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
      </dialog>
    </main>
  );
}
