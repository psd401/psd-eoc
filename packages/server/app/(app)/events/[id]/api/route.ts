import { randomUUID } from 'node:crypto';

import {
  AppendJournalEntryInputSchema,
  CorrectJournalEntryInputSchema,
  EventIdSchema,
  IdempotencyKeySchema,
  RedactJournalEntryInputSchema,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import { authenticateSessionRequest } from '../../../../../lib/auth/middleware';
import { getDefaultSessionService } from '../../../../../lib/auth/sessions';
import { resolveHumanCapabilityInvocation } from '../../../../../lib/capabilities/engine';
import { getDefaultEventCapabilityRuntime } from '../../../../../lib/capabilities/events';
import {
  createJournalCursor,
  getDefaultJournalCapabilityRuntime,
} from '../../../../../lib/capabilities/journal';
import { eventApiErrorResponse } from '../../../../api/events/_lib/http';

const JSON_MEDIA_TYPE = 'application/json';
const MAX_BODY_BYTES = 64 * 1_024;
const PAGE_LIMIT = 100;
const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Vary: 'Authorization, Cookie',
});

interface EventRoomRouteContext {
  readonly params: Promise<Readonly<{ id: string }>>;
}

type JsonObject = Readonly<Record<string, unknown>>;

function success(value: unknown): NextResponse {
  return NextResponse.json(value, { headers: RESPONSE_HEADERS });
}

function assertOnlyKeys(
  body: JsonObject,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new SyntaxError(
      'The event-room request contains unsupported fields.',
    );
  }
}

async function readJsonObject(request: Request): Promise<JsonObject> {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new SyntaxError('Event-room mutations require JSON content.');
  }
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
  ) {
    throw new SyntaxError('The event-room request body is too large.');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new SyntaxError('The event-room request body is too large.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError('The event-room request body is not valid UTF-8.');
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError('The event-room request body must be an object.');
  }
  return parsed as JsonObject;
}

function requiredString(
  body: JsonObject,
  key: string,
  message: string,
): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new SyntaxError(message);
  }
  return value;
}

function nullableString(
  body: JsonObject,
  key: string,
  message: string,
): string | null {
  const value = body[key];
  if (value !== null && typeof value !== 'string') {
    throw new SyntaxError(message);
  }
  return value;
}

function mutationKey(request: Request): string {
  return IdempotencyKeySchema.parse(
    request.headers.get('idempotency-key') ?? '',
  );
}

function timelineCursor(
  eventId: string,
  requestedCursor: string | null,
  items: readonly { readonly sequence: number }[],
  nextCursor: string | null,
): string {
  if (nextCursor !== null) {
    return nextCursor;
  }
  const lastSequence = items.at(-1)?.sequence;
  if (lastSequence !== undefined) {
    return createJournalCursor(eventId, lastSequence);
  }
  return requestedCursor ?? createJournalCursor(eventId, 0);
}

async function handleTimelineQuery(
  request: Request,
  eventId: string,
  serverTime: Date,
): Promise<NextResponse> {
  if (
    request.headers.has('idempotency-key') ||
    request.headers.has('human-confirmation-id')
  ) {
    throw new SyntaxError('Timeline queries cannot carry mutation metadata.');
  }
  const url = new URL(request.url);
  const allowed = new Set(['cursor', 'operation']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new SyntaxError('The event-room query parameters are invalid.');
    }
  }
  const operation = url.searchParams.get('operation');
  if (operation !== null && operation !== 'preview-all-clear') {
    throw new SyntaxError('The event-room query operation is invalid.');
  }
  const cursor = url.searchParams.get('cursor');
  const authenticated = await authenticateSessionRequest(
    request,
    getDefaultSessionService(),
    { mutation: false },
    serverTime,
  );
  const queryInvocation = () =>
    resolveHumanCapabilityInvocation(authenticated, {
      requestId: randomUUID(),
      serverTime,
      mutation: null,
    });
  const journalRuntime = getDefaultJournalCapabilityRuntime();
  if (operation === 'preview-all-clear') {
    if (cursor !== null) {
      throw new SyntaxError('All-clear previews do not accept a cursor.');
    }
    const preview = await journalRuntime.execute(
      'create-lifecycle-consequence-preview',
      { eventId, purpose: 'all-clear' },
      queryInvocation(),
    );
    return success({ preview });
  }

  const eventRuntime = getDefaultEventCapabilityRuntime();
  const [event, page] = await Promise.all([
    eventRuntime.execute('get-event', { eventId }, queryInvocation()),
    journalRuntime.execute(
      'list-journal-entries',
      { eventId, cursor, limit: PAGE_LIMIT },
      queryInvocation(),
    ),
  ]);
  return success({
    event,
    entries: page.items,
    cursor: timelineCursor(
      eventId,
      cursor,
      page.items,
      page.pageInfo.nextCursor,
    ),
    hasMore: page.pageInfo.hasMore,
  });
}

async function handleMutation(
  request: Request,
  eventId: string,
  requestId: string,
  serverTime: Date,
): Promise<NextResponse> {
  if (new URL(request.url).search.length > 0) {
    throw new SyntaxError(
      'Event-room mutations do not accept query parameters.',
    );
  }
  if (request.headers.has('human-confirmation-id')) {
    throw new SyntaxError(
      'Event-room confirmations are issued by the server, not supplied by the client.',
    );
  }
  const idempotencyKey = mutationKey(request);
  const authenticated = await authenticateSessionRequest(
    request,
    getDefaultSessionService(),
    { mutation: true },
    serverTime,
  );
  const body = await readJsonObject(request);
  const operation = requiredString(
    body,
    'operation',
    'The event-room operation is required.',
  );
  const journalRuntime = getDefaultJournalCapabilityRuntime();
  const eventRuntime = getDefaultEventCapabilityRuntime();

  if (operation === 'post-text') {
    assertOnlyKeys(body, ['operation', 'text', 'clientTime']);
    const input = AppendJournalEntryInputSchema.parse({
      eventId,
      clientTime: nullableString(
        body,
        'clientTime',
        'The client time must be a timestamp or null.',
      ),
      supersedes: null,
      kind: 'text',
      payload: {
        text: requiredString(body, 'text', 'The post text is required.'),
      },
    });
    const invocation = resolveHumanCapabilityInvocation(authenticated, {
      requestId,
      serverTime,
      mutation: { idempotencyKey, humanConfirmationId: null },
    });
    return success({
      entry: await journalRuntime.execute(
        'append-journal-entry',
        input,
        invocation,
      ),
    });
  }

  if (operation === 'post-photo') {
    assertOnlyKeys(body, [
      'operation',
      'mediaId',
      'altText',
      'caption',
      'clientTime',
    ]);
    const input = AppendJournalEntryInputSchema.parse({
      eventId,
      clientTime: nullableString(
        body,
        'clientTime',
        'The client time must be a timestamp or null.',
      ),
      supersedes: null,
      kind: 'photo',
      payload: {
        mediaId: requiredString(
          body,
          'mediaId',
          'The photo media ID is required.',
        ),
        altText: requiredString(
          body,
          'altText',
          'The photo alternative text is required.',
        ),
        caption: nullableString(
          body,
          'caption',
          'The photo caption must be text or null.',
        ),
      },
    });
    const invocation = resolveHumanCapabilityInvocation(authenticated, {
      requestId,
      serverTime,
      mutation: { idempotencyKey, humanConfirmationId: null },
    });
    return success({
      entry: await journalRuntime.execute(
        'append-journal-entry',
        input,
        invocation,
      ),
    });
  }

  if (operation === 'correct-text') {
    assertOnlyKeys(body, [
      'operation',
      'entryId',
      'entrySequence',
      'text',
      'reason',
      'clientTime',
    ]);
    const input = CorrectJournalEntryInputSchema.parse({
      eventId,
      clientTime: nullableString(
        body,
        'clientTime',
        'The client time must be a timestamp or null.',
      ),
      supersedes: {
        entryId: requiredString(
          body,
          'entryId',
          'The corrected entry ID is required.',
        ),
        entrySequence: body.entrySequence,
        kind: 'correction',
        reason: requiredString(
          body,
          'reason',
          'The correction reason is required.',
        ),
      },
      kind: 'text',
      payload: {
        text: requiredString(body, 'text', 'The corrected text is required.'),
      },
    });
    const invocation = resolveHumanCapabilityInvocation(authenticated, {
      requestId,
      serverTime,
      mutation: { idempotencyKey, humanConfirmationId: null },
    });
    return success({
      entry: await journalRuntime.execute(
        'correct-journal-entry',
        input,
        invocation,
      ),
    });
  }

  if (operation === 'redact-entry') {
    assertOnlyKeys(body, [
      'operation',
      'entryId',
      'entrySequence',
      'reason',
      'clientTime',
    ]);
    const input = RedactJournalEntryInputSchema.parse({
      eventId,
      clientTime: nullableString(
        body,
        'clientTime',
        'The client time must be a timestamp or null.',
      ),
      supersedes: {
        entryId: requiredString(
          body,
          'entryId',
          'The redacted entry ID is required.',
        ),
        entrySequence: body.entrySequence,
        kind: 'redaction',
        reason: requiredString(
          body,
          'reason',
          'The redaction reason is required.',
        ),
      },
      kind: 'text',
      payload: { text: '[Content redacted — original retained in journal]' },
    });
    const invocation = resolveHumanCapabilityInvocation(authenticated, {
      requestId,
      serverTime,
      mutation: { idempotencyKey, humanConfirmationId: null },
    });
    return success({
      entry: await journalRuntime.execute(
        'redact-journal-entry',
        input,
        invocation,
      ),
    });
  }

  if (operation === 'all-clear') {
    assertOnlyKeys(body, [
      'operation',
      'lifecyclePreviewId',
      'confirmationPhrase',
    ]);
    const lifecyclePreviewId = requiredString(
      body,
      'lifecyclePreviewId',
      'The all-clear preview ID is required.',
    );
    const confirmation = await journalRuntime.issueHumanConfirmation({
      authenticated,
      eventId,
      action: 'all-clear',
      lifecyclePreviewId,
      confirmationPhrase: requiredString(
        body,
        'confirmationPhrase',
        'The all-clear confirmation phrase is required.',
      ),
      requestId,
      now: serverTime,
    });
    const actionServerTime = new Date();
    const invocation = resolveHumanCapabilityInvocation(authenticated, {
      requestId,
      serverTime: actionServerTime,
      mutation: {
        idempotencyKey,
        humanConfirmationId: confirmation.confirmationId,
      },
    });
    const result = await eventRuntime.execute(
      'all-clear-event',
      { eventId, lifecyclePreviewId },
      invocation,
    );
    const lastSequence = result.journalEntries.at(-1)?.sequence ?? 0;
    return success({
      event: result.event,
      entries: result.journalEntries,
      cursor: createJournalCursor(eventId, lastSequence),
      hasMore: false,
    });
  }

  if (operation === 'close') {
    assertOnlyKeys(body, ['operation', 'confirmationPhrase']);
    const confirmation = await journalRuntime.issueHumanConfirmation({
      authenticated,
      eventId,
      action: 'close',
      lifecyclePreviewId: null,
      confirmationPhrase: requiredString(
        body,
        'confirmationPhrase',
        'The close confirmation phrase is required.',
      ),
      requestId,
      now: serverTime,
    });
    const actionServerTime = new Date();
    const invocation = resolveHumanCapabilityInvocation(authenticated, {
      requestId,
      serverTime: actionServerTime,
      mutation: {
        idempotencyKey,
        humanConfirmationId: confirmation.confirmationId,
      },
    });
    const result = await eventRuntime.execute(
      'close-event',
      { eventId },
      invocation,
    );
    const lastSequence = result.journalEntries.at(-1)?.sequence ?? 0;
    return success({
      event: result.event,
      entries: result.journalEntries,
      cursor: createJournalCursor(eventId, lastSequence),
      hasMore: false,
    });
  }

  throw new SyntaxError('The event-room operation is invalid.');
}

async function executeRoute(
  request: Request,
  context: EventRoomRouteContext,
): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const { id } = await context.params;
    const eventId = EventIdSchema.parse(id);
    const serverTime = new Date();
    if (request.method === 'GET') {
      return await handleTimelineQuery(request, eventId, serverTime);
    }
    if (request.method === 'POST') {
      return await handleMutation(request, eventId, requestId, serverTime);
    }
    throw new SyntaxError('The event-room method is not supported.');
  } catch (error) {
    return eventApiErrorResponse(error, requestId);
  }
}

export async function GET(request: Request, context: EventRoomRouteContext) {
  return executeRoute(request, context);
}

export async function POST(request: Request, context: EventRoomRouteContext) {
  return executeRoute(request, context);
}
