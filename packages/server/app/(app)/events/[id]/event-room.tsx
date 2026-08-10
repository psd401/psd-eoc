'use client';

import {
  ApiErrorSchema,
  EventSchema,
  IdempotencyKeySchema,
  JournalEntrySchema,
  LifecycleConsequencePreviewSchema,
  PaginationCursorSchema,
  UuidSchema,
  type ChannelConsequencePreview,
  type Event,
  type JournalEntry,
  type LifecycleConsequencePreview,
} from '@psd-eoc/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

const POLL_INTERVAL_MILLISECONDS = 4_000;
const ANNOUNCEMENT_BATCH_MILLISECONDS = 5_000;
const RECOVERY_RECORD_VERSION = 1;

type ConnectionState = 'loading' | 'connected' | 'reconnecting' | 'offline';

type CommandOperation =
  | 'post-text'
  | 'correct-text'
  | 'redact-entry'
  | 'all-clear'
  | 'close';

type CommandBody =
  | Readonly<{
      operation: 'post-text';
      text: string;
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
  readonly event: Event;
  readonly entries: readonly JournalEntry[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

interface MutationResult {
  readonly event: Event | null;
  readonly entries: readonly JournalEntry[];
}

type DialogState =
  | Readonly<{ kind: 'correct'; entry: JournalEntry }>
  | Readonly<{ kind: 'redact'; entry: JournalEntry }>
  | Readonly<{
      kind: 'all-clear';
      loading: boolean;
      preview: LifecycleConsequencePreview | null;
      error: string | null;
    }>
  | Readonly<{ kind: 'close' }>;

export interface EventRoomProps {
  /** Canonical, facility-authorized event returned by the capability layer. */
  readonly event: Event;
  /** First chronological journal page; every item remains immutable. */
  readonly initialEntries: readonly JournalEntry[];
  /** Opaque continuation token supplied by list-journal-entries. */
  readonly initialCursor: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareEntries(left: JournalEntry, right: JournalEntry): number {
  const sequenceDifference = left.sequence - right.sequence;
  return sequenceDifference !== 0
    ? sequenceDifference
    : left.id.localeCompare(right.id);
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

function parseTimelinePage(
  value: unknown,
  baselineEvent: Event,
  previousCursor: string | null,
): TimelinePage {
  if (!isRecord(value)) {
    throw new EventRoomRequestError(
      'PSD EOC returned an invalid timeline response.',
      false,
    );
  }
  const parsedEvent = EventSchema.safeParse(value.event);
  if (!parsedEvent.success) {
    throw new EventRoomRequestError(
      'PSD EOC returned an event that does not match this room.',
      false,
    );
  }
  assertImmutableEventIdentity(parsedEvent.data, baselineEvent);
  const entries = canonicalEntries(
    value.entries ?? value.items,
    baselineEvent.id,
  );
  const pageInfo = isRecord(value.pageInfo) ? value.pageInfo : null;
  const cursorCandidate = Object.hasOwn(value, 'cursor')
    ? value.cursor
    : pageInfo !== null && Object.hasOwn(pageInfo, 'nextCursor')
      ? pageInfo.nextCursor
      : previousCursor;
  const parsedCursor =
    cursorCandidate === null
      ? { success: true as const, data: null }
      : PaginationCursorSchema.safeParse(cursorCandidate);
  const hasMoreCandidate =
    typeof value.hasMore === 'boolean' ? value.hasMore : pageInfo?.hasMore;
  if (!parsedCursor.success || typeof hasMoreCandidate !== 'boolean') {
    throw new EventRoomRequestError(
      'PSD EOC returned invalid timeline continuation data.',
      false,
    );
  }
  if (hasMoreCandidate && parsedCursor.data === null) {
    throw new EventRoomRequestError(
      'PSD EOC omitted the next timeline cursor.',
      false,
    );
  }
  return {
    event: parsedEvent.data,
    entries,
    cursor: parsedCursor.data,
    hasMore: hasMoreCandidate,
  };
}

function parseMutationResult(
  operation: CommandOperation,
  value: unknown,
  baselineEvent: Event,
): MutationResult {
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

  const lifecycleOperation = operation === 'all-clear' || operation === 'close';
  if (entries.length === 0 || (lifecycleOperation && returnedEvent === null)) {
    throw new EventRoomRequestError(
      'PSD EOC returned an incomplete success response. The exact request is retained for verification.',
      true,
    );
  }
  return { event: returnedEvent, entries };
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
  let response: Response;
  try {
    response = await fetch(timelineUrl(apiUrl, cursor), {
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new EventRoomRequestError(
      'Timeline updates are temporarily unavailable.',
      false,
    );
  }
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
  return parseTimelinePage(value, baselineEvent, cursor);
}

async function requestLifecyclePreview(
  apiUrl: string,
  baselineEvent: Event,
  signal: AbortSignal,
): Promise<LifecycleConsequencePreview> {
  const url = new URL(apiUrl, window.location.href);
  url.searchParams.delete('cursor');
  url.searchParams.set('operation', 'preview-all-clear');
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new EventRoomRequestError(
      'The all-clear preview could not be loaded. No notification was sent.',
      false,
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
): Promise<unknown> {
  const csrf = csrfToken(csrfCookieName);
  if (csrf === null) {
    throw new EventRoomRequestError(
      'Your session is missing its request-protection cookie. Sign in again before retrying.',
      false,
    );
  }
  let response: Response;
  try {
    response = await fetch(command.apiUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': command.idempotencyKey,
        'X-PSD-EOC-CSRF': csrf,
      },
      body: command.bodyJson,
    });
  } catch {
    throw new EventRoomRequestError(
      'The connection ended before PSD EOC confirmed the result. The exact request is retained and will not retry automatically.',
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
  return value;
}

function isCommandOperation(value: unknown): value is CommandOperation {
  return (
    value === 'post-text' ||
    value === 'correct-text' ||
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

function makeRetainedCommand(
  eventId: string,
  apiUrl: string,
  ownerSessionId: string,
  body: CommandBody,
): RetainedCommand {
  return {
    version: RECOVERY_RECORD_VERSION,
    eventId,
    ownerSessionId: UuidSchema.parse(ownerSessionId),
    apiUrl,
    operation: body.operation,
    idempotencyKey: `event-room-${crypto.randomUUID()}`,
    bodyJson: JSON.stringify(body),
    createdAt: new Date().toISOString(),
  };
}

function commandLabel(operation: CommandOperation): string {
  switch (operation) {
    case 'post-text':
      return 'timeline post';
    case 'correct-text':
      return 'timeline correction';
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

function actorLabel(entry: JournalEntry): string {
  switch (entry.author.kind) {
    case 'human':
      return 'Authenticated staff member';
    case 'agent':
      return 'Authorized district agent';
    case 'system':
      return 'PSD EOC system';
  }
}

function entryKindLabel(entry: JournalEntry): string {
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

function useElapsedLabel(event: Event): string {
  const startedAt = event.activatedAt ?? event.createdAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (event.closedAt !== null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [event.closedAt, startedAt]);
  const end = event.closedAt === null ? now : Date.parse(event.closedAt);
  return formatElapsed(end - Date.parse(startedAt));
}

function waitForNextPoll(
  signal: AbortSignal,
  milliseconds = POLL_INTERVAL_MILLISECONDS,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, milliseconds);
    function abort() {
      window.clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function EntryContent({
  entry,
  redacted,
}: Readonly<{ entry: JournalEntry; redacted: boolean }>) {
  if (redacted && entry.kind !== 'system') {
    return (
      <p className="entry-content redacted-content">
        Original content is hidden because a later append-only redaction
        supersedes this entry. Its sequence, timing, and provenance remain in
        the journal.
      </p>
    );
  }
  switch (entry.kind) {
    case 'text':
      return <p className="entry-content">{entry.payload.text}</p>;
    case 'photo':
      return (
        <div className="entry-content">
          <p>
            <strong>Photo:</strong> {entry.payload.altText}
          </p>
          {entry.payload.caption === null ? null : (
            <p>{entry.payload.caption}</p>
          )}
          <p className="muted">
            The authorized media viewer will display the validated image when
            photo support is connected.
          </p>
        </div>
      );
    case 'location':
      if (entry.payload.state === 'known') {
        return (
          <p className="entry-content">
            {entry.payload.label ?? 'Recorded location'}: latitude{' '}
            {entry.payload.latitude}, longitude {entry.payload.longitude} (±
            {entry.payload.accuracyMeters} meters)
          </p>
        );
      }
      return (
        <p className="entry-content">
          Location {entry.payload.state}: {entry.payload.reason}
          {entry.payload.state === 'ambiguous'
            ? ` (${entry.payload.label})`
            : ''}
        </p>
      );
    case 'system':
      return <p className="entry-content">{entry.payload.summary}</p>;
  }
}

interface TimelineEntryProps {
  readonly entry: JournalEntry;
  readonly supersededBy: readonly JournalEntry[];
  readonly commandsBlocked: boolean;
  readonly onCorrect: (entry: JournalEntry, opener: HTMLElement) => void;
  readonly onRedact: (entry: JournalEntry, opener: HTMLElement) => void;
}

function TimelineEntry({
  entry,
  supersededBy,
  commandsBlocked,
  onCorrect,
  onRedact,
}: TimelineEntryProps) {
  const latestSupersession = supersededBy.at(-1) ?? null;
  const redacted = supersededBy.some(
    (candidate) => candidate.supersedes?.kind === 'redaction',
  );
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
          <a href={`#entry-${latestSupersession.id}`}>
            {latestSupersession.supersedes?.kind ?? 'update'} entry{' '}
            {latestSupersession.sequence}
          </a>
          .
        </p>
      )}

      <EntryContent entry={entry} redacted={redacted} />
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

      {entry.kind === 'system' || latestSupersession !== null ? null : (
        <div className="entry-actions">
          {entry.kind === 'text' ? (
            <button
              aria-haspopup="dialog"
              className="secondary"
              disabled={commandsBlocked}
              onClick={(event) => onCorrect(entry, event.currentTarget)}
              type="button"
            >
              Correct entry {entry.sequence}
            </button>
          ) : null}
          <button
            aria-haspopup="dialog"
            className="secondary"
            disabled={commandsBlocked}
            onClick={(event) => onRedact(entry, event.currentTarget)}
            type="button"
          >
            Redact entry {entry.sequence}
          </button>
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

export function EventRoom({
  event,
  initialEntries,
  initialCursor,
  initialHasMore,
  facilityLabel,
  eventTypeLabel,
  apiUrl,
  csrfCookieName,
  sessionId,
}: EventRoomProps) {
  const [currentEvent, setCurrentEvent] = useState(event);
  const [entries, setEntries] = useState<readonly JournalEntry[]>(() =>
    [...initialEntries].sort(compareEntries),
  );
  const [connection, setConnection] = useState<ConnectionState>('loading');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(initialHasMore);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<Readonly<{
    id: number;
    message: string;
  }> | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const [postText, setPostText] = useState('');
  const [mutationStatus, setMutationStatus] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] =
    useState<CommandOperation | null>(null);
  const [retainedCommand, setRetainedCommand] =
    useState<RetainedCommand | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmationPhrase, setConfirmationPhrase] = useState('');

  const cursorRef = useRef(initialCursor);
  const knownEntryIdsRef = useRef(
    new Set(initialEntries.map((entry) => entry.id)),
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
  const mutationErrorRef = useRef<HTMLDivElement>(null);

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
    (incoming: readonly JournalEntry[], announce: boolean) => {
      const newEntries = incoming.filter((entry) => {
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
    let drainInitialHistory = initialHasMore;
    let loadImmediately = true;
    let consecutiveFailures = 0;

    async function poll(): Promise<void> {
      while (active && !controller.signal.aborted) {
        if (!loadImmediately) {
          const continued = await waitForNextPoll(controller.signal);
          if (!continued) return;
        }
        loadImmediately = false;
        try {
          const page = await requestTimelinePage(
            apiUrl,
            cursorRef.current,
            event,
            controller.signal,
          );
          if (!active) return;
          cursorRef.current = page.cursor;
          setCurrentEvent(page.event);
          mergeIncomingEntries(page.entries, !drainInitialHistory);
          consecutiveFailures = 0;
          setConnection('connected');
          setLastUpdatedAt(new Date().toISOString());
          setPollMessage(null);
          if (drainInitialHistory && !page.hasMore) {
            drainInitialHistory = false;
            setLoadingHistory(false);
          }
          loadImmediately = page.hasMore;
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
  }, [apiUrl, event.id, initialHasMore, mergeIncomingEntries]);

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
        'PSD EOC could not read the browser recovery record. No request was sent. Verify the current timeline before clearing it.',
      );
    }
  }, [apiUrl, event.id, sessionId]);

  useEffect(() => {
    if (mutationError !== null) mutationErrorRef.current?.focus();
  }, [mutationError]);

  useEffect(() => {
    const element = dialogRef.current;
    if (element === null) return;
    if (dialog !== null) {
      if (!element.open) element.showModal();
      dialogWasOpenRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        const target = element.querySelector<HTMLElement>('[data-autofocus]');
        target?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (element.open) element.close();
    if (dialogWasOpenRef.current) {
      dialogWasOpenRef.current = false;
      const opener = dialogOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      else document.getElementById('main-content')?.focus();
    }
  }, [dialog]);

  const supersessionsByEntry = useMemo(() => {
    const result = new Map<string, JournalEntry[]>();
    for (const entry of entries) {
      const targetId = entry.supersedes?.entryId;
      if (targetId === undefined) continue;
      const existing = result.get(targetId) ?? [];
      existing.push(entry);
      existing.sort(compareEntries);
      result.set(targetId, existing);
    }
    return result;
  }, [entries]);

  const commandsBlocked =
    loadingHistory ||
    pendingOperation !== null ||
    retainedCommand !== null ||
    recoveryBlocked;
  const retainedLifecycleCommand =
    retainedCommand?.operation === 'all-clear' ||
    retainedCommand?.operation === 'close';

  function openDialog(next: DialogState, opener: HTMLElement): void {
    if (commandsBlocked) return;
    dialogOpenerRef.current = opener;
    setMutationError(null);
    setConfirmationPhrase('');
    setDialog(next);
  }

  function closeDialog(): void {
    if (pendingRef.current) return;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    setDialog(null);
    setConfirmationPhrase('');
  }

  async function loadAllClearPreview(): Promise<void> {
    previewControllerRef.current?.abort();
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setDialog((current) =>
      current?.kind === 'all-clear'
        ? { kind: 'all-clear', loading: true, preview: null, error: null }
        : current,
    );
    try {
      const preview = await requestLifecyclePreview(
        apiUrl,
        event,
        controller.signal,
      );
      setDialog((current) =>
        current?.kind === 'all-clear'
          ? { kind: 'all-clear', loading: false, preview, error: null }
          : current,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setDialog((current) =>
        current?.kind === 'all-clear'
          ? {
              kind: 'all-clear',
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
    openDialog(
      { kind: 'all-clear', loading: true, preview: null, error: null },
      opener,
    );
    void loadAllClearPreview();
  }

  function applyMutationResult(result: MutationResult): void {
    if (result.event !== null) setCurrentEvent(result.event);
    autoScrollRef.current = true;
    setUnseenCount(0);
    mergeIncomingEntries(result.entries, false);
  }

  function clearCommandAfterResult(command: RetainedCommand): boolean {
    try {
      clearRetainedCommand(command);
      setRetainedCommand(null);
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
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingOperation(command.operation);
    setMutationError(null);
    setMutationStatus(`Sending ${commandLabel(command.operation)}…`);
    try {
      const value = await postRetainedCommand(command, csrfCookieName);
      const result = parseMutationResult(command.operation, value, event);
      applyMutationResult(result);
      const cleared = clearCommandAfterResult(command);
      setMutationStatus(
        cleared
          ? `${commandLabel(command.operation)} confirmed by the server.`
          : `${commandLabel(command.operation)} confirmed; browser recovery cleanup needs attention.`,
      );
      return true;
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
          : 'The server rejected the request. No change was recorded by this attempt.',
      );
      return false;
    } finally {
      pendingRef.current = false;
      setPendingOperation(null);
    }
  }

  async function executeNewCommand(body: CommandBody): Promise<boolean> {
    if (commandsBlocked || pendingRef.current) return false;
    const command = makeRetainedCommand(event.id, apiUrl, sessionId, body);
    try {
      retainCommand(command);
      setRetainedCommand(command);
    } catch {
      setRecoveryBlocked(true);
      setMutationError(
        'This browser could not retain an exact recovery request, so PSD EOC did not send anything.',
      );
      setMutationStatus('No request was sent.');
      return false;
    }
    return sendRetainedCommand(command);
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

  async function submitCorrection(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (dialog?.kind !== 'correct') return;
    const form = new FormData(submission.currentTarget);
    const text = String(form.get('correctionText') ?? '').trim();
    const reason = String(form.get('correctionReason') ?? '').trim();
    if (text.length === 0 || reason.length === 0) return;
    const succeeded = await executeNewCommand({
      operation: 'correct-text',
      entryId: dialog.entry.id,
      entrySequence: dialog.entry.sequence,
      text,
      reason,
      clientTime: new Date().toISOString(),
    });
    if (succeeded) closeDialog();
  }

  async function submitRedaction(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    if (dialog?.kind !== 'redact') return;
    const form = new FormData(submission.currentTarget);
    const reason = String(form.get('redactionReason') ?? '').trim();
    if (reason.length === 0) return;
    const succeeded = await executeNewCommand({
      operation: 'redact-entry',
      entryId: dialog.entry.id,
      entrySequence: dialog.entry.sequence,
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
    if (retainedCommand === null || pendingRef.current) return;
    void sendRetainedCommand(retainedCommand);
  }

  function discardRecoveryRecord(): void {
    try {
      window.sessionStorage.removeItem(recoveryStorageKey(event.id));
      setRetainedCommand(null);
      setRecoveryBlocked(false);
      setMutationError(null);
      setMutationStatus(
        'Browser recovery record cleared after explicit timeline verification. No request was sent.',
      );
    } catch {
      setMutationError(
        'The browser recovery record could not be cleared. No request was sent.',
      );
    }
  }

  function jumpToLatest(): void {
    autoScrollRef.current = true;
    setUnseenCount(0);
    timelineEndRef.current?.scrollIntoView({ block: 'end' });
    timelineEndRef.current?.focus();
  }

  const startedAt = currentEvent.activatedAt ?? currentEvent.createdAt;
  const canPost =
    currentEvent.status === 'active' || currentEvent.status === 'all-clear';

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
              <dt>Started</dt>
              <dd>
                <time dateTime={startedAt}>{readableDateTime(startedAt)}</time>
              </dd>
              <dt>Elapsed</dt>
              <dd suppressHydrationWarning>{elapsed}</dd>
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
          <div className="form-actions">
            {retainedCommand === null || retainedLifecycleCommand ? null : (
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

      {mutationError === null ? null : (
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
        {mutationStatus}
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
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <TimelineEntry
                      commandsBlocked={commandsBlocked}
                      entry={entry}
                      onCorrect={(target, opener) =>
                        openDialog({ kind: 'correct', entry: target }, opener)
                      }
                      onRedact={(target, opener) =>
                        openDialog({ kind: 'redact', entry: target }, opener)
                      }
                      supersededBy={supersessionsByEntry.get(entry.id) ?? []}
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
                  disabled={commandsBlocked}
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
                  disabled={commandsBlocked}
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
        onClose={() => {
          if (dialog !== null && !pendingRef.current) setDialog(null);
        }}
        ref={dialogRef}
      >
        {dialog?.kind === 'correct' ? (
          <form onSubmit={(submission) => void submitCorrection(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              Correct entry {dialog.entry.sequence}
            </h2>
            <p>
              The original remains visible and marked as superseded. This form
              appends a replacement with actor, time, and reason provenance.
            </p>
            <fieldset disabled={pendingOperation !== null}>
              <legend>Correction details</legend>
              <div className="field">
                <label htmlFor="correction-text">Corrected text</label>
                <textarea
                  data-autofocus
                  defaultValue={
                    dialog.entry.kind === 'text'
                      ? dialog.entry.payload.text
                      : ''
                  }
                  id="correction-text"
                  maxLength={10_000}
                  name="correctionText"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="correction-reason">Reason for correction</label>
                <textarea
                  id="correction-reason"
                  maxLength={1_000}
                  name="correctionReason"
                  required
                />
              </div>
              <div className="form-actions">
                <button type="submit">Append correction</button>
                <button
                  className="secondary"
                  onClick={closeDialog}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        ) : null}

        {dialog?.kind === 'redact' ? (
          <form onSubmit={(submission) => void submitRedaction(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              Redact entry {dialog.entry.sequence}
            </h2>
            <p>
              Redaction appends a superseding entry and hides the original
              content in this view. The original journal record, sequence,
              timing, and provenance are never deleted.
            </p>
            <fieldset disabled={pendingOperation !== null}>
              <legend>Redaction details</legend>
              <div className="field">
                <label htmlFor="redaction-reason">Reason for redaction</label>
                <textarea
                  data-autofocus
                  id="redaction-reason"
                  maxLength={1_000}
                  name="redactionReason"
                  required
                />
              </div>
              <div className="form-actions">
                <button className="danger" type="submit">
                  Append redaction
                </button>
                <button
                  className="secondary"
                  onClick={closeDialog}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        ) : null}

        {dialog?.kind === 'all-clear' ? (
          <form onSubmit={(submission) => void submitAllClear(submission)}>
            <h2 className="dialog-heading" id="event-dialog-heading">
              Review and issue all-clear
            </h2>
            <p
              className={`dialog-classification ${realEvent ? 'mode-real' : 'mode-drill'}`}
            >
              {classificationLabel}
            </p>
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
                  onClick={() => void loadAllClearPreview()}
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
                    pendingOperation !== null ||
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
                  <div className="form-actions">
                    <button
                      className="danger"
                      disabled={confirmationPhrase !== 'ALL CLEAR'}
                      type="submit"
                    >
                      {pendingOperation === 'all-clear'
                        ? 'Issuing all-clear…'
                        : 'Issue all-clear and notify'}
                    </button>
                    <button
                      className="secondary"
                      onClick={closeDialog}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </fieldset>
              </>
            )}
            {dialog.preview !== null ? null : (
              <div className="form-actions">
                <button
                  className="secondary"
                  disabled={dialog.loading}
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
            <p
              className={`dialog-classification ${realEvent ? 'mode-real' : 'mode-drill'}`}
            >
              {classificationLabel}
            </p>
            <ul className="consequence-list">
              <li>The event has already reached the all-clear state.</li>
              <li>Closing appends a distinct journal entry.</li>
              <li>No journal history is deleted or rewritten.</li>
              <li>Closing does not send another all-clear notification.</li>
            </ul>
            <fieldset disabled={pendingOperation !== null}>
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
              <div className="form-actions">
                <button
                  className="caution"
                  disabled={confirmationPhrase !== 'CLOSE EVENT'}
                  type="submit"
                >
                  {pendingOperation === 'close'
                    ? 'Closing event…'
                    : 'Close event'}
                </button>
                <button
                  className="secondary"
                  onClick={closeDialog}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        ) : null}
      </dialog>
    </main>
  );
}
