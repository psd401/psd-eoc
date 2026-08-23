import {
  ApiErrorSchema,
  EventSchema,
  type ActivationPreview,
  type Event,
  type EventKind,
  type StartEventResult,
  type TemplateMode,
} from '@psd-eoc/contracts';

export class StartFlowRequestError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = 'StartFlowRequestError';
  }
}

const START_FLOW_REQUEST_TIMEOUT_MS = 20_000;
const ACTIVE_EVENT_REQUEST_TIMEOUT_MS = 10_000;

interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

function requestDeadline(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestDeadline {
  const controller = new AbortController();
  let deadlineExpired = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted === true) {
    abortFromCaller();
  } else {
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(
      new DOMException('Request deadline exceeded.', 'AbortError'),
    );
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => deadlineExpired,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function startFlowTimeoutError(
  path: '/start/api/activate' | '/start/api/join' | '/start/api/preview',
): StartFlowRequestError {
  if (path === '/start/api/preview') {
    return new StartFlowRequestError(
      'The consequence preview timed out. No event was started and no notification was queued. Load a fresh preview before continuing.',
      true,
      false,
    );
  }
  return new StartFlowRequestError(
    'The server outcome is unknown because the request timed out. Nothing will retry automatically. Return to the dashboard and check active events before making a fresh decision.',
    false,
    true,
  );
}

function joinedEventMismatch(): StartFlowRequestError {
  return new StartFlowRequestError(
    'PSD EOC returned a joined event that does not match the active event you chose. Treat the outcome as unresolved and check the dashboard before making another decision.',
    false,
    true,
  );
}

/** A successful join response must identify the requested event as active. */
export function requireActiveJoinedEvent(
  event: Event,
  expectedEventId: string,
): Event {
  if (event.id !== expectedEventId || event.status !== 'active') {
    throw joinedEventMismatch();
  }
  return event;
}

/** Confirmation-page joins also pin every classification-relevant identity. */
export function requireMatchingActiveJoinedEvent(
  event: Event,
  expected: Event,
): Event {
  requireActiveJoinedEvent(event, expected.id);
  if (
    event.facilityId !== expected.facilityId ||
    event.kind !== expected.kind ||
    event.templateMode !== expected.templateMode ||
    event.eventTypeVersion.id !== expected.eventTypeVersion.id ||
    event.eventTypeVersion.templateMode !==
      expected.eventTypeVersion.templateMode ||
    event.rosterSnapshotId !== expected.rosterSnapshotId ||
    event.rosterPopulation !== expected.rosterPopulation
  ) {
    throw joinedEventMismatch();
  }
  return event;
}

interface ExpectedActivationSelection {
  readonly eventKind: Extract<EventKind, 'incident' | 'drill'>;
  readonly eventTypeVersionId: string;
  readonly facilityId: string;
  readonly templateMode: TemplateMode;
}

function exactChannelConsequencesMatch(
  actual: StartEventResult['notificationIntent'],
  expected: ActivationPreview['channels'],
): boolean {
  if (actual === null || actual.channels.length !== expected.length) {
    return false;
  }
  return expected.every((expectedChannel) => {
    const actualChannel = actual.channels.find(
      (candidate) => candidate.channel === expectedChannel.channel,
    );
    return JSON.stringify(actualChannel) === JSON.stringify(expectedChannel);
  });
}

/** Binds a schema-valid activation response to this exact browser decision. */
export function requireMatchingActivationResult(
  result: StartEventResult,
  preview: ActivationPreview,
  selection: ExpectedActivationSelection,
  activationIdempotencyKey: string,
): Event {
  const event = result.event;
  const authorization = event.activationAuthorization;
  const notificationIntent = result.notificationIntent;
  if (
    event.facilityId !== selection.facilityId ||
    event.kind !== selection.eventKind ||
    event.templateMode !== selection.templateMode ||
    event.eventTypeVersion.id !== selection.eventTypeVersionId ||
    event.eventTypeVersion.templateMode !== selection.templateMode ||
    event.rosterSnapshotId !== preview.rosterSnapshotId ||
    event.rosterPopulation !== preview.rosterPopulation ||
    event.status !== 'active' ||
    result.transition.idempotencyKey !== activationIdempotencyKey ||
    authorization?.kind !== 'human-confirmed' ||
    authorization.activationPreviewId !== preview.id ||
    authorization.preparedActivationId !== null ||
    authorization.consequenceDigest !== preview.consequenceDigest ||
    result.preparedActivationConsumption !== null ||
    notificationIntent === null ||
    !exactChannelConsequencesMatch(notificationIntent, preview.channels)
  ) {
    throw new StartFlowRequestError(
      'PSD EOC returned an event that does not match the confirmed preview. Treat the outcome as unresolved and check the dashboard before making another decision.',
      false,
      true,
    );
  }
  return event;
}

function readCookie(name: string): string | null {
  for (const segment of document.cookie.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    if (segment.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Sends one explicit browser action; network failures are never queued. */
export async function requestStartFlow<Output>(
  path: '/start/api/activate' | '/start/api/join' | '/start/api/preview',
  body: unknown,
  csrfCookieName: string,
  parser: Readonly<{ parse(value: unknown): Output }>,
  idempotencyKey?: string,
  signal?: AbortSignal,
  timeoutMs = START_FLOW_REQUEST_TIMEOUT_MS,
): Promise<Output> {
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken === null) {
    throw new StartFlowRequestError(
      'Your secure browser session is incomplete. Sign in again before continuing.',
      false,
      false,
    );
  }

  let response: Response;
  const deadline = requestDeadline(signal, timeoutMs);
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-psd-eoc-csrf': csrfToken,
        ...(idempotencyKey === undefined
          ? {}
          : { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
  } catch (error) {
    deadline.dispose();
    if (deadline.timedOut()) {
      throw startFlowTimeoutError(path);
    }
    if (
      signal?.aborted === true ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    if (path === '/start/api/preview') {
      throw new StartFlowRequestError(
        'PSD EOC could not load the consequence preview. No event was started and no notification was queued. Load a fresh preview before continuing.',
        true,
        false,
      );
    }
    throw new StartFlowRequestError(
      'The server outcome is unknown. Nothing will retry automatically. Return to the dashboard and check active events before making a fresh decision.',
      false,
      true,
    );
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    deadline.dispose();
    if (deadline.timedOut()) {
      throw startFlowTimeoutError(path);
    }
    if (
      signal?.aborted === true ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    if (path === '/start/api/preview') {
      throw new StartFlowRequestError(
        'PSD EOC received an unreadable consequence preview. No event was started and no notification was queued. Load a fresh preview before continuing.',
        true,
        false,
      );
    }
    throw new StartFlowRequestError(
      'PSD EOC received an unreadable server response. No automatic retry will occur.',
      false,
      true,
    );
  }
  deadline.dispose();
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload);
    const mutationOutcomeUnknown =
      path !== '/start/api/preview' && response.status >= 500;
    throw new StartFlowRequestError(
      parsed.success
        ? parsed.data.message
        : 'The request was not accepted. Review the current event state before trying again.',
      !mutationOutcomeUnknown && parsed.success && parsed.data.retryable,
      mutationOutcomeUnknown,
    );
  }

  try {
    return parser.parse(payload);
  } catch {
    if (path === '/start/api/preview') {
      throw new StartFlowRequestError(
        'PSD EOC received an invalid consequence preview. No event was started and no notification was queued. Load a fresh preview before continuing.',
        true,
        false,
      );
    }
    throw new StartFlowRequestError(
      'PSD EOC received an invalid server response. Treat the outcome as unresolved and contact district technology.',
      false,
      true,
    );
  }
}

/**
 * Reloads one active event through the canonical read API before presenting a
 * join-or-start decision. A missing or malformed event blocks both choices.
 */
export async function requestActiveEvent(
  eventId: string,
  signal?: AbortSignal,
  timeoutMs = ACTIVE_EVENT_REQUEST_TIMEOUT_MS,
): Promise<Event> {
  let response: Response;
  const deadline = requestDeadline(signal, timeoutMs);
  try {
    response = await fetch(`/api/events/${encodeURIComponent(eventId)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: deadline.signal,
    });
  } catch (error) {
    deadline.dispose();
    if (deadline.timedOut()) {
      throw new StartFlowRequestError(
        'PSD EOC timed out while verifying the current active-event details. No event can be started or joined from this preview.',
        true,
        false,
      );
    }
    if (
      signal?.aborted === true ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    throw new StartFlowRequestError(
      'PSD EOC could not verify the current active-event details. No event can be started or joined from this preview.',
      true,
      false,
    );
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    deadline.dispose();
    if (deadline.timedOut()) {
      throw new StartFlowRequestError(
        'PSD EOC timed out while verifying the current active-event details. No event can be started or joined from this preview.',
        true,
        false,
      );
    }
    if (
      signal?.aborted === true ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    throw new StartFlowRequestError(
      'PSD EOC received an unreadable active-event response. No event can be started or joined from this preview.',
      false,
      false,
    );
  }
  deadline.dispose();
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload);
    throw new StartFlowRequestError(
      parsed.success
        ? `PSD EOC could not verify an existing active event: ${parsed.data.message}`
        : 'PSD EOC could not verify an existing active event. No event can be started or joined from this preview.',
      parsed.success && parsed.data.retryable,
      false,
    );
  }

  const parsed = EventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new StartFlowRequestError(
      'PSD EOC received invalid active-event details. No event can be started or joined from this preview.',
      false,
      false,
    );
  }
  return parsed.data;
}
