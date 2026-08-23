import {
  EventRoomHeaderSchema,
  EventSchema,
  JournalEntryReadProjectionSchema,
  LocationPayloadSchema,
  type Event,
  type EventRoomHeader,
  type EventRoomSyncResult,
  type JournalEntryReadProjection,
  type LocationPayload,
} from '@psd-eoc/contracts';

export const POLL_INTERVAL_MILLISECONDS = 4_000;
export const ANNOUNCEMENT_THROTTLE_MILLISECONDS = 5_000;
export const ANNOUNCEMENT_LATEST_TEXT_LIMIT = 240;
export const LIVE_EDGE_DISTANCE_PX = 96;

export interface EventRoomModel {
  readonly event: Event | null;
  readonly header: EventRoomHeader | null;
  readonly entries: readonly JournalEntryReadProjection[];
  readonly cursor: string | null;
  readonly snapshotSequence: number;
  readonly eventSnapshotSequence: number;
  readonly historyComplete: boolean;
  readonly unseenUpdateCount: number;
}

export const EMPTY_EVENT_ROOM_MODEL: EventRoomModel = Object.freeze({
  event: null,
  header: null,
  entries: Object.freeze([]),
  cursor: null,
  snapshotSequence: 0,
  eventSnapshotSequence: 0,
  historyComplete: false,
  unseenUpdateCount: 0,
});

export interface JournalEntryActionAvailability {
  readonly allowed: boolean;
  readonly unavailableReason: string | null;
}

export interface JournalEntryActionEligibility {
  readonly correction: JournalEntryActionAvailability;
  readonly redaction: JournalEntryActionAvailability;
}

function unavailable(reason: string): JournalEntryActionAvailability {
  return Object.freeze({ allowed: false, unavailableReason: reason });
}

const AVAILABLE_ACTION = Object.freeze({
  allowed: true,
  unavailableReason: null,
});

/**
 * Derives safe mobile correction/redaction affordances only from a complete
 * canonical history. The server remains the final facility/role authority.
 */
export function journalEntryActionEligibility(
  targetValue: JournalEntryReadProjection,
  entries: readonly JournalEntryReadProjection[],
  historyComplete: boolean,
): JournalEntryActionEligibility {
  const target = JournalEntryReadProjectionSchema.parse(targetValue);
  if (!historyComplete) {
    const reason =
      'Load the complete timeline before correcting or redacting an entry.';
    return Object.freeze({
      correction: unavailable(reason),
      redaction: unavailable(reason),
    });
  }
  if (target.visibility === 'redacted') {
    const reason = 'This entry is already redacted.';
    return Object.freeze({
      correction: unavailable(reason),
      redaction: unavailable(reason),
    });
  }
  if (target.entry.kind === 'system') {
    const reason = 'System lifecycle facts cannot be corrected or redacted.';
    return Object.freeze({
      correction: unavailable(reason),
      redaction: unavailable(reason),
    });
  }

  const supersessions = entries
    .map(
      (projection) =>
        JournalEntryReadProjectionSchema.parse(projection).entry.supersedes,
    )
    .filter(
      (supersession) =>
        supersession?.entryId === target.entry.id &&
        supersession.entrySequence === target.entry.sequence,
    );
  const correction =
    target.entry.kind !== 'text' && target.entry.kind !== 'location'
      ? unavailable(
          'Photos cannot be replaced as corrections. Redact the photo and post a new one instead.',
        )
      : supersessions.length > 0
        ? unavailable(
            'This entry is already superseded. Refresh and choose the latest entry.',
          )
        : AVAILABLE_ACTION;
  const redaction = supersessions.some(
    (supersession) => supersession?.kind === 'redaction',
  )
    ? unavailable('This entry already has an append-only redaction.')
    : AVAILABLE_ACTION;
  return Object.freeze({ correction, redaction });
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

function assertSameEventIdentity(current: Event, candidate: Event): void {
  if (immutableEventIdentity(current) !== immutableEventIdentity(candidate)) {
    throw new Error(
      'PSD EOC returned event identity or classification that does not match this room.',
    );
  }
}

function lifecycleState(event: Event): string {
  return JSON.stringify({
    status: event.status,
    activatedAt: event.activatedAt,
    allClearAt: event.allClearAt,
    reactivatedAt: event.reactivatedAt,
    closedAt: event.closedAt,
  });
}

function assertSameLifecycleState(current: Event, candidate: Event): void {
  if (lifecycleState(current) !== lifecycleState(candidate)) {
    throw new Error(
      'PSD EOC returned conflicting event states at one journal sequence.',
    );
  }
}

function latestEntrySequence(
  entries: readonly JournalEntryReadProjection[],
): number {
  return entries.reduce(
    (latest, projection) => Math.max(latest, projection.entry.sequence),
    0,
  );
}

function assertSameHeader(
  current: EventRoomHeader,
  candidate: EventRoomHeader,
): void {
  if (
    current.facility.id !== candidate.facility.id ||
    current.eventType.id !== candidate.eventType.id ||
    current.eventType.templateMode !== candidate.eventType.templateMode
  ) {
    throw new Error(
      'PSD EOC returned site or event-type identity that does not match this room.',
    );
  }
}

function mergeEntries(
  existing: readonly JournalEntryReadProjection[],
  incoming: readonly JournalEntryReadProjection[],
): readonly JournalEntryReadProjection[] {
  const byId = new Map(existing.map((entry) => [entry.entry.id, entry]));
  for (const projection of incoming) {
    const parsed = JournalEntryReadProjectionSchema.parse(projection);
    const prior = byId.get(parsed.entry.id);
    if (
      prior !== undefined &&
      JSON.stringify(prior) !== JSON.stringify(parsed)
    ) {
      const visibleToRedacted =
        prior.visibility === 'visible' &&
        parsed.visibility === 'redacted' &&
        JSON.stringify(redactProjection(prior)) === JSON.stringify(parsed);
      if (!visibleToRedacted) {
        throw new Error(
          'An immutable timeline entry changed after it was read.',
        );
      }
    }
    byId.set(parsed.entry.id, parsed);
  }

  // A live delta carries the append-only redaction entry, not a rewritten
  // target row. Hide the target locally as soon as that provenance arrives.
  for (const projection of byId.values()) {
    const supersession = projection.entry.supersedes;
    if (supersession?.kind !== 'redaction') continue;
    const target = byId.get(supersession.entryId);
    if (
      target === undefined ||
      target.entry.sequence !== supersession.entrySequence
    ) {
      continue;
    }
    byId.set(target.entry.id, redactProjection(target));
  }
  const merged = [...byId.values()].sort((left, right) => {
    const sequence = left.entry.sequence - right.entry.sequence;
    return sequence === 0
      ? left.entry.id.localeCompare(right.entry.id)
      : sequence;
  });
  for (let index = 1; index < merged.length; index += 1) {
    const previous = merged[index - 1];
    const current = merged[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.entry.sequence === current.entry.sequence
    ) {
      throw new Error('The event timeline contains a duplicate sequence.');
    }
  }
  return Object.freeze(merged);
}

function redactProjection(
  projection: JournalEntryReadProjection,
): JournalEntryReadProjection {
  if (projection.visibility === 'redacted') return projection;
  const {
    id,
    eventId,
    sequence,
    kind,
    author,
    source,
    serverTime,
    clientTime,
    supersedes,
  } = projection.entry;
  return JournalEntryReadProjectionSchema.parse({
    visibility: 'redacted',
    entry: {
      id,
      eventId,
      sequence,
      kind,
      author,
      source,
      serverTime,
      clientTime,
      supersedes,
    },
  });
}

/** Applies one canonical page without replacing immutable history. */
export function applyEventRoomPage(
  model: EventRoomModel,
  page: EventRoomSyncResult,
  options: Readonly<{ initialCatchUp: boolean; nearLiveEdge: boolean }>,
): EventRoomModel {
  const candidateEvent = page.event;
  if (model.event !== null && candidateEvent !== null) {
    assertSameEventIdentity(model.event, candidateEvent);
    if (page.snapshotSequence === model.eventSnapshotSequence) {
      assertSameLifecycleState(model.event, candidateEvent);
    }
  }
  const nextEvent =
    model.event === null || page.snapshotSequence > model.eventSnapshotSequence
      ? (candidateEvent ?? model.event)
      : model.event;
  const eventSnapshotSequence =
    candidateEvent !== null &&
    (model.event === null ||
      page.snapshotSequence > model.eventSnapshotSequence)
      ? page.snapshotSequence
      : model.eventSnapshotSequence;
  const nextHeader = page.header ?? model.header;
  if (nextEvent === null || nextHeader === null) {
    throw new Error('The initial event-room page omitted its event header.');
  }
  if (page.eventId !== nextEvent.id) {
    throw new Error('PSD EOC returned a different event room.');
  }
  if (model.header !== null && page.header !== null) {
    assertSameHeader(model.header, page.header);
  }
  EventSchema.parse(nextEvent);
  EventRoomHeaderSchema.parse(nextHeader);

  const entries = mergeEntries(model.entries, page.entries);
  const added = entries.length - model.entries.length;
  return Object.freeze({
    event: nextEvent,
    header: nextHeader,
    entries,
    cursor: page.cursor,
    snapshotSequence: Math.max(model.snapshotSequence, page.snapshotSequence),
    eventSnapshotSequence,
    historyComplete: options.initialCatchUp ? !page.hasMore : true,
    unseenUpdateCount:
      options.initialCatchUp || options.nearLiveEdge
        ? 0
        : model.unseenUpdateCount + Math.max(0, added),
  });
}

/** Applies a confirmed mutation result while retaining sequence truth. */
export function applyConfirmedMutation(
  model: EventRoomModel,
  event: Event | null,
  entries: readonly JournalEntryReadProjection[],
): EventRoomModel {
  const confirmedSequence = latestEntrySequence(entries);
  let nextEvent = model.event;
  let eventSnapshotSequence = model.eventSnapshotSequence;
  if (event !== null) {
    const candidate = EventSchema.parse(event);
    if (model.event === null) {
      nextEvent = candidate;
      eventSnapshotSequence = confirmedSequence;
    } else {
      assertSameEventIdentity(model.event, candidate);
      if (confirmedSequence > model.eventSnapshotSequence) {
        nextEvent = candidate;
        eventSnapshotSequence = confirmedSequence;
      } else if (confirmedSequence === model.eventSnapshotSequence) {
        assertSameLifecycleState(model.event, candidate);
      }
    }
  }
  const merged = mergeEntries(model.entries, entries);
  return Object.freeze({
    ...model,
    event: nextEvent,
    entries: merged,
    snapshotSequence: Math.max(model.snapshotSequence, confirmedSequence),
    eventSnapshotSequence,
    unseenUpdateCount: model.unseenUpdateCount,
  });
}

export function markTimelineSeen(model: EventRoomModel): EventRoomModel {
  return model.unseenUpdateCount === 0
    ? model
    : Object.freeze({ ...model, unseenUpdateCount: 0 });
}

export function isNearLiveEdge(
  contentHeight: number,
  viewportHeight: number,
  scrollOffset: number,
): boolean {
  if (
    ![contentHeight, viewportHeight, scrollOffset].every(Number.isFinite) ||
    contentHeight < 0 ||
    viewportHeight < 0 ||
    scrollOffset < 0
  ) {
    return false;
  }
  return contentHeight - viewportHeight - scrollOffset <= LIVE_EDGE_DISTANCE_PX;
}

/** A pending auto-follow is cancelled as soon as the reader leaves live edge. */
export function retainPendingTimelineFollow(
  followPending: boolean,
  nearLiveEdge: boolean,
): boolean {
  return followPending && nearLiveEdge;
}

export function isEventComposerVisible(
  selected: 'location' | 'photo' | null,
  composer: 'location' | 'photo',
  eventStatus: Event['status'],
): boolean {
  return selected === composer && eventStatus !== 'closed';
}

function conservativeDecimal(value: number): string {
  const ceiling = Math.ceil((value - Number.EPSILON) * 10) / 10;
  return Number.isInteger(ceiling) ? ceiling.toFixed(0) : ceiling.toFixed(1);
}

/** Never rounds a GPS uncertainty radius downward. */
export function formatAccuracyRadius(accuracyMeters: number): string {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
    throw new Error('Location accuracy is unavailable.');
  }
  return `±${conservativeDecimal(accuracyMeters)} metres`;
}

export function formatLocationPayload(payloadValue: LocationPayload): string {
  const payload = LocationPayloadSchema.parse(payloadValue);
  switch (payload.state) {
    case 'known': {
      const label = payload.label === null ? '' : `${payload.label}. `;
      return `${label}Latitude ${payload.latitude.toFixed(6)}, longitude ${payload.longitude.toFixed(6)}. GPS accuracy radius ${formatAccuracyRadius(payload.accuracyMeters)}. GPS does not establish room-level location.`;
    }
    case 'ambiguous':
      return `Location ambiguous. ${payload.label}. ${payload.reason}. Coordinates and accuracy unavailable.`;
    case 'unknown':
      return `Location unknown. ${payload.reason}. Coordinates and accuracy unavailable.`;
  }
}

export function adjustKnownLocation(
  payloadValue: Extract<LocationPayload, { state: 'known' }>,
  direction: 'north' | 'south' | 'east' | 'west',
  metres: number,
): Extract<LocationPayload, { state: 'known' }> {
  const payload = LocationPayloadSchema.parse(payloadValue);
  if (payload.state !== 'known') {
    throw new Error('Only a known location can be adjusted.');
  }
  if (!Number.isFinite(metres) || metres <= 0 || metres > 100) {
    throw new Error('Pin adjustment must be between 0 and 100 metres.');
  }
  const latitudeDelta = metres / 111_320;
  const longitudeScale = Math.max(
    0.01,
    Math.cos((payload.latitude * Math.PI) / 180),
  );
  const longitudeDelta = metres / (111_320 * longitudeScale);
  const latitude =
    payload.latitude +
    (direction === 'north'
      ? latitudeDelta
      : direction === 'south'
        ? -latitudeDelta
        : 0);
  const longitude =
    payload.longitude +
    (direction === 'east'
      ? longitudeDelta
      : direction === 'west'
        ? -longitudeDelta
        : 0);
  return LocationPayloadSchema.parse({
    ...payload,
    latitude: Math.max(-90, Math.min(90, latitude)),
    longitude: Math.max(-180, Math.min(180, longitude)),
    // Pin correction never claims a better GPS fix.
    accuracyMeters: payload.accuracyMeters,
  }) as Extract<LocationPayload, { state: 'known' }>;
}

function actorLabel(
  projection: JournalEntryReadProjection,
): 'Staff member' | 'District agent' | 'PSD EOC system' {
  switch (projection.entry.author.kind) {
    case 'human':
      return 'Staff member';
    case 'agent':
      return 'District agent';
    case 'system':
      return 'PSD EOC system';
  }
}

export function timelineEntryText(
  projectionValue: JournalEntryReadProjection,
): string {
  const projection = JournalEntryReadProjectionSchema.parse(projectionValue);
  if (projection.visibility === 'redacted') {
    return 'Content redacted. The original remains retained in the append-only journal.';
  }
  const { entry } = projection;
  switch (entry.kind) {
    case 'text':
      return entry.payload.text;
    case 'photo':
      return entry.payload.caption === null
        ? `Photo. ${entry.payload.altText}`
        : `Photo. ${entry.payload.altText}. ${entry.payload.caption}`;
    case 'location':
      return formatLocationPayload(entry.payload);
    case 'system':
      return entry.payload.summary;
  }
}

export function timelineEntryAccessibilityLabel(
  projectionValue: JournalEntryReadProjection,
): string {
  const projection = JournalEntryReadProjectionSchema.parse(projectionValue);
  const time = new Date(projection.entry.serverTime).toLocaleString();
  const supersession =
    projection.entry.supersedes === null
      ? ''
      : ` ${projection.entry.supersedes.kind === 'correction' ? 'Correction' : 'Redaction'} of timeline entry ${projection.entry.supersedes.entrySequence}.`;
  return `${actorLabel(projection)} at ${time}. ${timelineEntryText(projection)}${supersession}`;
}

export interface AnnouncementScheduler {
  schedule(callback: () => void, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
}

const DEFAULT_ANNOUNCEMENT_SCHEDULER: AnnouncementScheduler = Object.freeze({
  schedule: (callback: () => void, delay: number) =>
    setTimeout(callback, delay),
  cancel: (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** Coalesces poll bursts so a screen reader receives one concise update. */
export class TimelineAnnouncementBatcher {
  private pendingCount = 0;
  private latest = '';
  private handle: unknown | null = null;

  public constructor(
    private readonly announce: (message: string) => void,
    private readonly scheduler: AnnouncementScheduler = DEFAULT_ANNOUNCEMENT_SCHEDULER,
  ) {}

  public enqueue(entries: readonly JournalEntryReadProjection[]): void {
    if (entries.length === 0) return;
    this.pendingCount += entries.length;
    const latest = entries.at(-1);
    if (latest !== undefined) {
      const text = timelineEntryText(latest);
      this.latest =
        text.length <= ANNOUNCEMENT_LATEST_TEXT_LIMIT
          ? text
          : `${text.slice(0, ANNOUNCEMENT_LATEST_TEXT_LIMIT - 1).trimEnd()}…`;
    }
    if (this.handle !== null) return;
    this.handle = this.scheduler.schedule(() => {
      this.handle = null;
      const count = this.pendingCount;
      const message = `${count} new timeline ${count === 1 ? 'update' : 'updates'}. Latest: ${this.latest}`;
      this.pendingCount = 0;
      this.latest = '';
      this.announce(message);
    }, ANNOUNCEMENT_THROTTLE_MILLISECONDS);
  }

  public cancel(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
    this.pendingCount = 0;
    this.latest = '';
  }
}
