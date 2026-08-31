'use client';

import {
  AllClearEventResultSchema,
  ApiErrorSchema,
  AppendJournalEntryInputSchema,
  CloseEventResultSchema,
  CorrectJournalEntryInputSchema,
  EventRoomSyncResultSchema,
  EventSchema,
  JournalEntryReadProjectionSchema,
  IdempotencyKeySchema,
  JournalEntrySchema,
  LifecycleConsequencePreviewSchema,
  UuidSchema,
  type Event,
  type JournalEntry,
  type JournalEntryReadProjection,
  type LifecycleConsequencePreview,
  type LocationPayload,
  hasSameImmutableEventIdentity,
} from '@psd-eoc/contracts';

const POLL_MINIMUM_MILLISECONDS = 3_000;

const POLL_JITTER_MILLISECONDS = 2_000;

const POLL_MAXIMUM_BACKOFF_MILLISECONDS = 30_000;

const QUERY_DEADLINE_MILLISECONDS = 10_000;

export const MUTATION_DEADLINE_MILLISECONDS = 15_000;

const RECOVERY_RECORD_VERSION = 1;

const PHOTO_COMPLETION_RECORD_VERSION = 1;

export function mediaIdempotencyKey(purpose: 'create' | 'complete'): string {
  return IdempotencyKeySchema.parse(
    `event-photo-${purpose}-${crypto.randomUUID()}`,
  );
}

export type CommandOperation =
  | 'post-text'
  | 'post-photo'
  | 'post-location'
  | 'correct-text'
  | 'correct-location'
  | 'redact-entry'
  | 'all-clear'
  | 'close';

export type RetainedCommandDispatchOutcome =
  | 'confirmed'
  | 'ambiguous'
  | 'rejected'
  | 'not-sent';

export type CommandBody =
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
    }>
  | Readonly<{
      operation: 'close';
    }>;

type LifecycleCommandBody = Extract<
  CommandBody,
  Readonly<{ operation: 'all-clear' | 'close' }>
>;

export function webLifecycleCommandBody(
  input:
    | Readonly<{ operation: 'all-clear'; lifecyclePreviewId: string }>
    | Readonly<{ operation: 'close' }>,
): LifecycleCommandBody {
  return Object.freeze({ ...input });
}

export interface RetainedCommand {
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

export interface TimelineContinuation {
  /** Last cursor whose event projection and entries are visible together. */
  readonly baseCursor: string | null;
  /** Cursor for the next page in this still-hidden catch-up chain. */
  readonly cursor: string;
  readonly entries: readonly JournalEntryReadProjection[];
  readonly snapshotSequence: number;
}

export interface MutationResult {
  readonly event: Event | null;
  readonly entries: readonly JournalEntryReadProjection[];
}

interface RetainedCommandResponse {
  readonly value: unknown;
  readonly transitionIdempotencyKey: string | null;
}

export interface PendingPhotoCompletion {
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

export class EventRoomRequestError extends Error {
  public constructor(
    message: string,
    public readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = 'EventRoomRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visibleJournalEntry(entry: JournalEntry): JournalEntryReadProjection {
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'visible',
    entry,
  });
}

function assertImmutableEventIdentity(
  candidate: Event,
  baseline: Event,
  ambiguous = false,
): void {
  if (!hasSameImmutableEventIdentity(candidate, baseline)) {
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

export function parseMutationResult(
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
        !hasExactKeys(body, ['operation', 'lifecyclePreviewId']) ||
        body.operation !== 'all-clear' ||
        expectedPreviewId === null ||
        authorization?.lifecyclePreviewId !== expectedPreviewId
      ) {
        throw new EventRoomRequestError(
          'PSD EOC answered a different request than the one you confirmed. Your request is kept so you can check the timeline.',
          true,
        );
      }
    } else if (
      !hasExactKeys(body, ['operation']) ||
      body.operation !== 'close'
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

/**
 * Reports whether the fully loaded timeline already contains the entry a
 * retained request was trying to create.
 *
 * A retained record exists because a request's outcome was unknown. Once the
 * entry it would have written is visibly on the timeline, the outcome is not
 * unknown any more, and continuing to block every composer behind a manual
 * "I checked the timeline" button asks the operator to confirm something the
 * client can already see. Only ever call this with complete history: a
 * half-drained timeline cannot prove an absence, and this must never be used
 * to conclude that a request did *not* land.
 */
export function retainedCommandLandedInTimeline(
  command: RetainedCommand,
  entries: readonly JournalEntryReadProjection[],
): boolean {
  return entries.some(
    (projection) =>
      projection.visibility === 'visible' &&
      journalEntryProvesCommand(command, projection.entry),
  );
}

interface DeadlineSignal {
  readonly signal: AbortSignal;
  readonly didExpire: () => boolean;
  readonly dispose: () => void;
}

export function deadlineSignal(
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
      'PSD EOC returned an unusable check of who would be notified.',
      false,
    );
  }
  return parsed.data;
}

export async function readJson(response: Response): Promise<unknown> {
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

export function publicErrorMessage(value: unknown, fallback: string): string {
  const parsed = ApiErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.message : fallback;
}

function timelineUrl(apiUrl: string, cursor: string | null): string {
  const url = new URL(apiUrl, window.location.href);
  url.searchParams.delete('operation');
  if (cursor === null) url.searchParams.delete('cursor');
  else url.searchParams.set('cursor', cursor);
  return url.toString();
}

export async function requestTimelinePage(
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

export async function requestLifecyclePreview(
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

export function csrfToken(cookieName: string): string | null {
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

export async function postRetainedCommand(
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

export function recoveryStorageKey(eventId: string): string {
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

export function readRetainedCommand(
  eventId: string,
  apiUrl: string,
  ownerSessionId: string,
): RetainedCommand | null {
  const value = window.sessionStorage.getItem(recoveryStorageKey(eventId));
  return value === null
    ? null
    : parseRetainedCommand(value, eventId, apiUrl, ownerSessionId);
}

export function retainCommand(command: RetainedCommand): void {
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

export function clearRetainedCommand(command: RetainedCommand): void {
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

export function photoCompletionStorageKey(eventId: string): string {
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

export function readPendingPhotoCompletion(
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

export function retainPendingPhotoCompletion(
  pending: PendingPhotoCompletion,
): void {
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

export function clearPendingPhotoCompletion(
  pending: PendingPhotoCompletion,
): void {
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

export function recordCompletedPhotoMedia(
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

export function makePendingPhotoCompletion(
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

export function makeRetainedCommand(
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

export function retainedPhotoCommandMatches(
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

export function clearMatchingPhotoCompletion(
  command: RetainedCommand,
): boolean {
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

export function commandLabel(operation: CommandOperation): string {
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

export function waitForDocumentVisibility(
  signal: AbortSignal,
): Promise<boolean> {
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

export function waitForNextPoll(
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
