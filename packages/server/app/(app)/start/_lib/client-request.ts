import { ApiErrorSchema, EventSchema, type Event } from '@psd-eoc/contracts';

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
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
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
  } catch {
    throw new StartFlowRequestError(
      'PSD EOC received an unreadable server response. No automatic retry will occur.',
      false,
      true,
    );
  }
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload);
    throw new StartFlowRequestError(
      parsed.success
        ? parsed.data.message
        : 'The request was not accepted. Review the current event state before trying again.',
      parsed.success && parsed.data.retryable,
      false,
    );
  }

  try {
    return parser.parse(payload);
  } catch {
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
): Promise<Event> {
  let response: Response;
  try {
    response = await fetch(`/api/events/${encodeURIComponent(eventId)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
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
  } catch {
    throw new StartFlowRequestError(
      'PSD EOC received an unreadable active-event response. No event can be started or joined from this preview.',
      false,
      false,
    );
  }
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
