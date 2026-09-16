import {
  ActivationPreviewSchema,
  CreateActivationPreviewInputSchema,
  EventIdSchema,
  EventPageSchema,
  EventSchema,
  EventTypePageSchema,
  EventTypeVersionSchema,
  FacilityPageSchema,
  IdempotencyKeySchema,
  isAtOrAfter,
  JoinEventResultSchema,
  StartEventInputSchema,
  StartEventResultSchema,
  ThreatPageSchema,
  type ActivationPreview,
  type ApiErrorCode,
  type CreateActivationPreviewInput,
  type Event,
  type EventTypeListItem,
  type Facility,
  type JoinEventResult,
  type StartEventResult,
  type Threat,
} from '@psd-eoc/contracts';

import {
  AuthenticatedApiError,
  AuthenticatedRequestFailure,
  type AuthenticatedRequestOptions,
  type JsonResponseSchema,
  type RequestAuthenticated,
} from '../api';
import { tolerantResponseSchema } from '../api/forward-compatible-parse';
import { OfflineMutationDeniedError } from '../auth/auth-errors';

export type StartAuthenticatedRequest = RequestAuthenticated;

export interface StartHomeActiveEvent {
  readonly event: Event;
  readonly facilityName: string;
  readonly eventTypeName: string;
}

export interface StartHomeData {
  readonly facilities: readonly Facility[];
  readonly eventTypes: readonly EventTypeListItem[];
  /** Selectable threats in the district's declared order. */
  readonly threats: readonly Threat[];
  readonly activeEvents: readonly StartHomeActiveEvent[];
}

/** Public-safe failure metadata; callers must never automatically retry a mutation. */
export class StartClientError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean,
    public readonly code: ApiErrorCode | null = null,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'StartClientError';
  }
}

interface ParsedPage<Item> {
  readonly items: readonly Item[];
  readonly pageInfo: Readonly<{
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  }>;
}

type RequestKind = 'query' | 'preview' | 'mutation';

const MAX_PAGES_PER_COLLECTION = 100;
const START_QUERY_TIMEOUT_MS = 10_000;
const START_MUTATION_TIMEOUT_MS = 20_000;

function requestFailure(kind: RequestKind, message?: string): StartClientError {
  if (kind === 'mutation') {
    return new StartClientError(
      message ??
        'The server outcome is unknown. Nothing will retry automatically. Check active events before making a fresh decision.',
      false,
      true,
    );
  }
  if (kind === 'preview') {
    return new StartClientError(
      message ??
        'PSD EOC could not load the consequence preview. No event was started and no notification was queued.',
      true,
      false,
    );
  }
  return new StartClientError(
    message ??
      'PSD EOC could not load the current start information. No event was started and no notification was queued.',
    true,
    false,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isExplicitTerminalApiRejection(error: AuthenticatedApiError): boolean {
  if (error.apiError.retryable) {
    return false;
  }

  switch (error.status) {
    case 400:
      return error.apiError.code === 'VALIDATION_ERROR';
    case 401:
      return error.apiError.code === 'UNAUTHENTICATED';
    case 403:
      return error.apiError.code === 'FORBIDDEN';
    case 404:
      return error.apiError.code === 'NOT_FOUND';
    case 409:
      return (
        error.apiError.code === 'CONFLICT' ||
        error.apiError.code === 'IDEMPOTENCY_CONFLICT'
      );
    default:
      return false;
  }
}

function isKnownPreSendFailure(error: AuthenticatedRequestFailure): boolean {
  return error.kind === 'configuration' || error.kind === 'invalid-request';
}

async function executeJsonRequest<Output>(
  request: StartAuthenticatedRequest,
  input: AuthenticatedRequestOptions<Output>,
  kind: RequestKind,
): Promise<Output> {
  try {
    return await request(input);
  } catch (error) {
    if (error instanceof OfflineMutationDeniedError || isAbortError(error)) {
      throw error;
    }
    if (error instanceof AuthenticatedApiError) {
      const outcomeUnknown =
        kind === 'mutation' && !isExplicitTerminalApiRejection(error);
      throw new StartClientError(
        error.apiError.message,
        !outcomeUnknown && error.apiError.retryable,
        outcomeUnknown,
        error.apiError.code,
        error.apiError.requestId,
      );
    }
    if (error instanceof AuthenticatedRequestFailure) {
      const outcomeUnknown =
        kind === 'mutation' && !isKnownPreSendFailure(error);
      throw new StartClientError(
        outcomeUnknown
          ? 'PSD EOC did not return a trustworthy acknowledgement. Treat the outcome as unresolved; no automatic retry will occur.'
          : error.message,
        kind !== 'mutation' && error.kind === 'network',
        outcomeUnknown,
      );
    }
    throw requestFailure(kind);
  }
}

function timeoutFailure(kind: RequestKind): StartClientError {
  if (kind === 'mutation') {
    return requestFailure(
      kind,
      'The request timed out, so the server outcome is unknown. Nothing will retry automatically. Check active events before making a fresh decision.',
    );
  }
  return requestFailure(
    kind,
    kind === 'preview'
      ? 'The consequence preview timed out. No event was started and no notification was queued.'
      : 'Loading the current start information timed out. No event was started and no notification was queued.',
  );
}

async function requestJson<Output>(
  request: StartAuthenticatedRequest,
  input: AuthenticatedRequestOptions<Output>,
  kind: RequestKind,
): Promise<Output> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    kind === 'mutation' ? START_MUTATION_TIMEOUT_MS : START_QUERY_TIMEOUT_MS,
  );
  try {
    return await executeJsonRequest(
      request,
      { ...input, signal: controller.signal },
      kind,
    );
  } catch (error) {
    if (timedOut) {
      throw timeoutFailure(kind);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function pagePath(firstPath: string, cursor: string): string {
  const separator = firstPath.includes('?') ? '&' : '?';
  return `${firstPath}${separator}cursor=${encodeURIComponent(cursor)}`;
}

async function loadAllPages<Item>(
  request: StartAuthenticatedRequest,
  firstPath: string,
  schema: JsonResponseSchema<ParsedPage<Item>>,
): Promise<readonly Item[]> {
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let path = firstPath;

  for (
    let pageNumber = 0;
    pageNumber < MAX_PAGES_PER_COLLECTION;
    pageNumber += 1
  ) {
    const page = await requestJson(
      request,
      { method: 'GET', path, schema },
      'query',
    );
    items.push(...page.items);
    if (!page.pageInfo.hasMore) {
      return Object.freeze(items);
    }
    const cursor = page.pageInfo.nextCursor;
    if (cursor === null || seenCursors.has(cursor)) {
      throw requestFailure(
        'query',
        'PSD EOC returned an invalid pagination response. No event was started and no notification was queued.',
      );
    }
    seenCursors.add(cursor);
    path = pagePath(firstPath, cursor);
  }

  throw requestFailure(
    'query',
    'PSD EOC returned too many start-information pages. No event was started and no notification was queued.',
  );
}

function fallbackEventTypeName(event: Event): string {
  if (event.templateMode === 'real') {
    return 'Real incident';
  }
  return event.kind === 'test' ? 'Controlled test' : 'Practice drill';
}

async function historicalEventTypeName(
  request: StartAuthenticatedRequest,
  event: Event,
): Promise<string> {
  try {
    const version = await requestJson(
      request,
      {
        method: 'GET',
        path: `/event-types/api?operation=version&eventTypeVersionId=${encodeURIComponent(event.eventTypeVersion.id)}`,
        schema: tolerantResponseSchema(EventTypeVersionSchema),
      },
      'query',
    );
    return version.id === event.eventTypeVersion.id &&
      version.templateMode === event.templateMode
      ? version.name
      : fallbackEventTypeName(event);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return fallbackEventTypeName(event);
  }
}

/** Loads only facility-authorized start choices and active events. */
export async function loadStartHomeData(
  request: StartAuthenticatedRequest,
): Promise<StartHomeData> {
  const [facilities, eventTypes, threats, activeEvents] = await Promise.all([
    // Each page is read tolerantly: a field the server gained after this
    // build shipped is dropped rather than making the home screen unreadable.
    loadAllPages<Facility>(
      request,
      '/api/mobile/start/facilities',
      tolerantResponseSchema(FacilityPageSchema),
    ),
    loadAllPages<EventTypeListItem>(
      request,
      '/event-types/api?operation=list&enabled=true',
      tolerantResponseSchema(EventTypePageSchema),
    ),
    loadAllPages<Threat>(
      request,
      '/api/mobile/start/threats',
      tolerantResponseSchema(ThreatPageSchema),
    ),
    loadAllPages<Event>(
      request,
      '/api/events',
      tolerantResponseSchema(EventPageSchema),
    ),
  ]);
  if (activeEvents.some((event) => event.status !== 'active')) {
    throw requestFailure(
      'query',
      'PSD EOC returned an event that is not active. No event was started and no notification was queued.',
    );
  }

  const facilityNames = new Map(
    facilities.map((facility) => [facility.id, facility.name] as const),
  );
  const versionNames = new Map(
    eventTypes.map(
      (item) => [item.latestVersion.id, item.latestVersion.name] as const,
    ),
  );
  const missingVersions = new Map<string, Event>();
  for (const event of activeEvents) {
    if (!versionNames.has(event.eventTypeVersion.id)) {
      missingVersions.set(event.eventTypeVersion.id, event);
    }
  }
  await Promise.all(
    [...missingVersions.values()].map(async (event) => {
      versionNames.set(
        event.eventTypeVersion.id,
        await historicalEventTypeName(request, event),
      );
    }),
  );

  return Object.freeze({
    // Inactive authorized facilities remain available above for naming any
    // still-active event, but can never be offered as a new start target.
    facilities: Object.freeze(facilities.filter((facility) => facility.active)),
    eventTypes,
    threats: Object.freeze(threats.filter((threat) => threat.active)),
    activeEvents: Object.freeze(
      activeEvents.map((event) =>
        Object.freeze({
          event,
          facilityName:
            facilityNames.get(event.facilityId) ?? 'Authorized facility',
          eventTypeName:
            versionNames.get(event.eventTypeVersion.id) ??
            fallbackEventTypeName(event),
        }),
      ),
    ),
  });
}

function sameVersion(
  left: ActivationPreview['eventTypeVersion'],
  right: ActivationPreview['eventTypeVersion'],
): boolean {
  return left.id === right.id && left.templateMode === right.templateMode;
}

/** Creates a non-mutating server consequence preview and binds it to the selection. */
export async function createPreview(
  request: StartAuthenticatedRequest,
  input: CreateActivationPreviewInput,
  idempotencyKeyInput: string,
): Promise<ActivationPreview> {
  const selection = CreateActivationPreviewInputSchema.parse(input);
  const idempotencyKey = IdempotencyKeySchema.parse(idempotencyKeyInput);
  const preview = await requestJson(
    request,
    {
      method: 'POST',
      path: '/api/mobile/start/preview',
      body: selection,
      idempotencyKey,
      schema: tolerantResponseSchema(ActivationPreviewSchema),
    },
    'preview',
  );
  if (
    preview.facilityId !== selection.facilityId ||
    preview.kind !== selection.kind ||
    preview.templateMode !== selection.templateMode ||
    preview.rosterPopulation !== selection.rosterPopulation ||
    !sameVersion(preview.eventTypeVersion, selection.eventTypeVersion) ||
    preview.threat === null ||
    preview.threat.id !== selection.threatId ||
    preview.threat.detail !== selection.threatDetail ||
    preview.responseDetail !== selection.responseDetail
  ) {
    throw requestFailure(
      'preview',
      'PSD EOC returned a consequence preview that does not match your selection. No event was started and no notification was queued.',
    );
  }
  return preview;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * The server re-renders notification copy at confirmation on purpose: the sent
 * message carries the real start time and the names as they stand at that
 * moment, not the ones the preview guessed. `buildNotification` says so and
 * then replaces `renderedMessage` on every channel, so an activation whose
 * preview and confirmation fall in different clock minutes legitimately
 * returns different copy.
 *
 * Comparing that copy byte for byte therefore made a correct server look like
 * one that had returned the wrong event: the start was refused as unresolved
 * after it had already run and notified. What the operator actually authorized
 * is the channel set and its order, how many endpoints each channel reaches,
 * which integration sends it, and the classification marker that separates a
 * drill from a real incident. Those must still match exactly; the wording may
 * move.
 */
function channelAuthorizationMatches(
  intentChannels: NonNullable<
    StartEventResult['notificationIntent']
  >['channels'],
  previewChannels: ActivationPreview['channels'],
): boolean {
  return (
    intentChannels.length === previewChannels.length &&
    intentChannels.every((channel, index) => {
      const expected = previewChannels[index];
      return (
        expected !== undefined &&
        channel.channel === expected.channel &&
        channel.endpointCount === expected.endpointCount &&
        channel.integrationId === expected.integrationId &&
        channel.renderedMessage.classificationMarker ===
          expected.renderedMessage.classificationMarker
      );
    })
  );
}

function activationMatchesPreview(
  result: StartEventResult,
  preview: ActivationPreview,
): boolean {
  const event = result.event;
  const authorization = event.activationAuthorization;
  const intent = result.notificationIntent;
  return (
    event.facilityId === preview.facilityId &&
    event.kind === preview.kind &&
    event.templateMode === preview.templateMode &&
    sameVersion(event.eventTypeVersion, preview.eventTypeVersion) &&
    event.rosterSnapshotId === preview.rosterSnapshotId &&
    event.rosterPopulation === preview.rosterPopulation &&
    event.status === 'active' &&
    authorization !== null &&
    authorization.activationPreviewId === preview.id &&
    authorization.consequenceDigest === preview.consequenceDigest &&
    (authorization.kind !== 'human-confirmed' ||
      authorization.preparedActivationId === null) &&
    result.preparedActivationConsumption === null &&
    intent !== null &&
    intent.eventId === event.id &&
    intent.eventKind === preview.kind &&
    intent.templateMode === preview.templateMode &&
    intent.purpose === 'activation' &&
    sameVersion(intent.eventTypeVersion, preview.eventTypeVersion) &&
    intent.rosterSnapshotId === preview.rosterSnapshotId &&
    intent.rosterPopulation === preview.rosterPopulation &&
    channelAuthorizationMatches(intent.channels, preview.channels)
  );
}

function joinResultMatchesSelectedEvent(
  event: Event,
  expected: Event,
): boolean {
  const lifecycleDidNotRegress =
    expected.allClearAt === null && expected.reactivatedAt === null
      ? true
      : expected.allClearAt !== null &&
        expected.reactivatedAt !== null &&
        event.allClearAt !== null &&
        event.reactivatedAt !== null &&
        ((event.allClearAt === expected.allClearAt &&
          event.reactivatedAt === expected.reactivatedAt) ||
          isAtOrAfter(event.allClearAt, expected.reactivatedAt));

  return (
    event.status === 'active' &&
    lifecycleDidNotRegress &&
    structurallyEqual(
      { ...event, allClearAt: null, reactivatedAt: null },
      { ...expected, allClearAt: null, reactivatedAt: null },
    )
  );
}

/** Executes one explicit human activation; failures are never retried here. */
export async function activate(
  request: StartAuthenticatedRequest,
  previewInput: ActivationPreview,
  idempotencyKeyInput: string,
): Promise<StartEventResult> {
  const preview = ActivationPreviewSchema.parse(previewInput);
  const idempotencyKey = IdempotencyKeySchema.parse(idempotencyKeyInput);
  const body = StartEventInputSchema.parse({
    source: 'activation-preview',
    activationPreviewId: preview.id,
    activeEventDecision: {
      decision: 'start-new',
      activeEventIdsSeen: preview.activeEventIds,
    },
  });
  const result = await requestJson(
    request,
    {
      method: 'POST',
      path: '/api/mobile/start/activate',
      body,
      idempotencyKey,
      schema: tolerantResponseSchema(StartEventResultSchema),
    },
    'mutation',
  );
  if (!activationMatchesPreview(result, preview)) {
    throw requestFailure(
      'mutation',
      'PSD EOC returned an event that does not match the confirmed preview. Treat the outcome as unresolved; no automatic retry will occur.',
    );
  }
  return result;
}

/** Joins exactly one selected active event and never creates a notification intent. */
export async function join(
  request: StartAuthenticatedRequest,
  expectedEventInput: Event,
  idempotencyKeyInput: string,
): Promise<JoinEventResult> {
  const expectedEvent = EventSchema.parse(expectedEventInput);
  const eventId = EventIdSchema.parse(expectedEvent.id);
  const idempotencyKey = IdempotencyKeySchema.parse(idempotencyKeyInput);
  const result = await requestJson(
    request,
    {
      method: 'POST',
      path: `/api/events/${encodeURIComponent(eventId)}/join`,
      body: {},
      idempotencyKey,
      schema: tolerantResponseSchema(JoinEventResultSchema),
    },
    'mutation',
  );
  if (!joinResultMatchesSelectedEvent(result.event, expectedEvent)) {
    throw requestFailure(
      'mutation',
      'PSD EOC returned a joined event whose identity or classification does not match your choice. Treat the outcome as unresolved; no automatic retry will occur.',
    );
  }
  return result;
}
