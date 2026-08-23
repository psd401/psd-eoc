import {
  AllClearEventResultSchema,
  CloseEventResultSchema,
  EventIdSchema,
  EventRoomSyncResultSchema,
  JournalEntrySchema,
  JournalSupersessionSchema,
  LifecycleConsequencePreviewSchema,
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
  SessionIdSchema,
  projectJournalEntryForRead,
  type AllClearEventResult,
  type CloseEventResult,
  type EventRoomSyncResult,
  type JournalEntry,
  type JournalEntryReadProjection,
  type LifecycleConsequencePreview,
  type LocationPayload,
  type MediaContentType,
  type MediaReadGrant,
  type MediaRecord,
  type MediaUploadIntent,
} from '@psd-eoc/contracts';

import type { JsonResponseSchema, RequestAuthenticated } from '../../lib/api';

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('PSD EOC returned an invalid event-room response.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function schema<Output>(
  parse: (value: unknown) => Output,
): JsonResponseSchema<Output> {
  return Object.freeze({ parse });
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
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

function journalMutationSchema(
  eventId: string,
  sessionId: string,
  kind: 'text' | 'photo' | 'location',
  clientTime: string | null,
  matchesRequest: (entry: JournalEntry) => boolean,
): JsonResponseSchema<JournalEntryReadProjection> {
  return schema((value) => {
    const entry = JournalEntrySchema.parse(record(value).entry);
    if (
      entry.eventId !== eventId ||
      entry.kind !== kind ||
      entry.source !== 'mobile' ||
      entry.author.kind !== 'human' ||
      entry.author.sessionId !== sessionId ||
      entry.clientTime !== clientTime ||
      entry.supersedes !== null ||
      !matchesRequest(entry)
    ) {
      throw new Error('PSD EOC returned a journal entry for another request.');
    }
    return projectJournalEntryForRead(entry, false);
  });
}

function journalSupersessionSchema(
  eventId: string,
  sessionId: string,
  target: Readonly<{ entryId: string; entrySequence: number }>,
  supersessionKind: 'correction' | 'redaction',
  reason: string,
  kind: 'text' | 'location',
  clientTime: string | null,
  matchesRequest: (entry: JournalEntry) => boolean,
): JsonResponseSchema<JournalEntryReadProjection> {
  return schema((value) => {
    const entry = JournalEntrySchema.parse(record(value).entry);
    if (
      entry.eventId !== eventId ||
      entry.kind !== kind ||
      entry.source !== 'mobile' ||
      entry.author.kind !== 'human' ||
      entry.author.sessionId !== sessionId ||
      entry.clientTime !== clientTime ||
      entry.supersedes?.entryId !== target.entryId ||
      entry.supersedes.entrySequence !== target.entrySequence ||
      entry.supersedes.kind !== supersessionKind ||
      entry.supersedes.reason !== reason ||
      !matchesRequest(entry)
    ) {
      throw new Error(
        'PSD EOC returned a journal supersession for another request.',
      );
    }
    return projectJournalEntryForRead(entry, false);
  });
}

function supersessionTarget(
  target: Readonly<{ entryId: string; entrySequence: number }>,
  kind: 'correction' | 'redaction',
  reason: string,
) {
  return JournalSupersessionSchema.parse({ ...target, kind, reason });
}

function allClearPreviewSchema(
  eventId: string,
): JsonResponseSchema<LifecycleConsequencePreview> {
  return schema((value) => {
    const preview = LifecycleConsequencePreviewSchema.parse(
      record(value).preview,
    );
    if (preview.eventId !== eventId || preview.purpose !== 'all-clear') {
      throw new Error('PSD EOC returned a preview for another event.');
    }
    return preview;
  });
}

function lifecycleFields(value: unknown): Readonly<Record<string, unknown>> {
  const response = record(value);
  return {
    event: response.event,
    transition: response.transition,
    journalEntries: response.journalEntries,
    notificationIntent: response.notificationIntent,
    preparedActivationConsumption: response.preparedActivationConsumption,
  };
}

function isScopedTransitionEvidenceKey(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function allClearSchema(
  eventId: string,
  lifecyclePreviewId: string,
): JsonResponseSchema<AllClearEventResult> {
  return schema((value) => {
    const result = AllClearEventResultSchema.parse(lifecycleFields(value));
    if (
      result.event.id !== eventId ||
      result.transition.transition !== 'all-clear' ||
      result.transition.source !== 'mobile' ||
      result.transition.actor.kind !== 'human' ||
      !isScopedTransitionEvidenceKey(result.transition.idempotencyKey) ||
      result.transition.notificationAuthorization.lifecyclePreviewId !==
        lifecyclePreviewId
    ) {
      throw new Error('PSD EOC returned an all-clear for another event.');
    }
    return result;
  });
}

function closeSchema(eventId: string): JsonResponseSchema<CloseEventResult> {
  return schema((value) => {
    const result = CloseEventResultSchema.parse(lifecycleFields(value));
    if (
      result.event.id !== eventId ||
      result.transition.transition !== 'close' ||
      result.transition.source !== 'mobile' ||
      result.transition.actor.kind !== 'human' ||
      !isScopedTransitionEvidenceKey(result.transition.idempotencyKey)
    ) {
      throw new Error('PSD EOC returned a close result for another event.');
    }
    return result;
  });
}

function eventRoomPath(eventIdValue: string): string {
  return `/events/${EventIdSchema.parse(eventIdValue)}/api`;
}

/** Canonical event-room REST adapter; all credentials remain inside auth. */
export class EventRoomApi {
  public constructor(private readonly request: RequestAuthenticated) {}

  public sync(
    eventId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<EventRoomSyncResult> {
    const parsedEventId = EventIdSchema.parse(eventId);
    const query =
      cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return this.request({
      method: 'GET',
      path: `${eventRoomPath(parsedEventId)}${query}`,
      schema: schema((value) => {
        const result = EventRoomSyncResultSchema.parse(value);
        if (result.eventId !== parsedEventId) {
          throw new Error('PSD EOC returned another event room.');
        }
        return result;
      }),
      signal,
    });
  }

  public postText(
    eventId: string,
    sessionId: string,
    text: string,
    idempotencyKey: string,
    clientTime: string | null,
    signal?: AbortSignal,
  ): Promise<JournalEntryReadProjection> {
    return this.mutate(
      eventId,
      { operation: 'post-text', text, clientTime },
      idempotencyKey,
      journalMutationSchema(
        EventIdSchema.parse(eventId),
        SessionIdSchema.parse(sessionId),
        'text',
        clientTime,
        (entry) => entry.kind === 'text' && entry.payload.text === text,
      ),
      signal,
    );
  }

  public postLocation(
    eventId: string,
    sessionId: string,
    payload: LocationPayload,
    idempotencyKey: string,
    clientTime: string | null,
    signal?: AbortSignal,
  ): Promise<JournalEntryReadProjection> {
    return this.mutate(
      eventId,
      { operation: 'post-location', payload, clientTime },
      idempotencyKey,
      journalMutationSchema(
        EventIdSchema.parse(eventId),
        SessionIdSchema.parse(sessionId),
        'location',
        clientTime,
        (entry) =>
          entry.kind === 'location' &&
          structurallyEqual(entry.payload, payload),
      ),
      signal,
    );
  }

  public postPhoto(
    eventId: string,
    sessionId: string,
    mediaId: string,
    altText: string,
    caption: string | null,
    idempotencyKey: string,
    clientTime: string | null,
    signal?: AbortSignal,
  ): Promise<JournalEntryReadProjection> {
    return this.mutate(
      eventId,
      {
        operation: 'post-photo',
        mediaId,
        altText,
        caption,
        clientTime,
      },
      idempotencyKey,
      journalMutationSchema(
        EventIdSchema.parse(eventId),
        SessionIdSchema.parse(sessionId),
        'photo',
        clientTime,
        (entry) =>
          entry.kind === 'photo' &&
          entry.payload.mediaId === mediaId &&
          entry.payload.altText === altText &&
          entry.payload.caption === caption,
      ),
      signal,
    );
  }

  public correctText(
    eventId: string,
    sessionId: string,
    target: Readonly<{ entryId: string; entrySequence: number }>,
    text: string,
    reason: string,
    idempotencyKey: string,
    clientTime: string | null,
    signal?: AbortSignal,
  ): Promise<JournalEntryReadProjection> {
    const supersedes = supersessionTarget(target, 'correction', reason);
    return this.mutate(
      eventId,
      {
        operation: 'correct-text',
        entryId: supersedes.entryId,
        entrySequence: supersedes.entrySequence,
        text,
        reason: supersedes.reason,
        clientTime,
      },
      idempotencyKey,
      journalSupersessionSchema(
        EventIdSchema.parse(eventId),
        SessionIdSchema.parse(sessionId),
        supersedes,
        'correction',
        supersedes.reason,
        'text',
        clientTime,
        (entry) => entry.kind === 'text' && entry.payload.text === text,
      ),
      signal,
    );
  }

  public correctLocation(
    eventId: string,
    sessionId: string,
    target: Readonly<{ entryId: string; entrySequence: number }>,
    payload: LocationPayload,
    reason: string,
    idempotencyKey: string,
    clientTime: string | null,
    signal?: AbortSignal,
  ): Promise<JournalEntryReadProjection> {
    const supersedes = supersessionTarget(target, 'correction', reason);
    return this.mutate(
      eventId,
      {
        operation: 'correct-location',
        entryId: supersedes.entryId,
        entrySequence: supersedes.entrySequence,
        payload,
        reason: supersedes.reason,
        clientTime,
      },
      idempotencyKey,
      journalSupersessionSchema(
        EventIdSchema.parse(eventId),
        SessionIdSchema.parse(sessionId),
        supersedes,
        'correction',
        supersedes.reason,
        'location',
        clientTime,
        (entry) =>
          entry.kind === 'location' &&
          structurallyEqual(entry.payload, payload),
      ),
      signal,
    );
  }

  public redactEntry(
    eventId: string,
    sessionId: string,
    target: Readonly<{ entryId: string; entrySequence: number }>,
    reason: string,
    idempotencyKey: string,
    clientTime: string | null,
    signal?: AbortSignal,
  ): Promise<JournalEntryReadProjection> {
    const redactionText = '[Content redacted — original retained in journal]';
    const supersedes = supersessionTarget(target, 'redaction', reason);
    return this.mutate(
      eventId,
      {
        operation: 'redact-entry',
        entryId: supersedes.entryId,
        entrySequence: supersedes.entrySequence,
        reason: supersedes.reason,
        clientTime,
      },
      idempotencyKey,
      journalSupersessionSchema(
        EventIdSchema.parse(eventId),
        SessionIdSchema.parse(sessionId),
        supersedes,
        'redaction',
        supersedes.reason,
        'text',
        clientTime,
        (entry) =>
          entry.kind === 'text' && entry.payload.text === redactionText,
      ),
      signal,
    );
  }

  public previewAllClear(
    eventId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<LifecycleConsequencePreview> {
    return this.mutate(
      eventId,
      { operation: 'preview-all-clear' },
      idempotencyKey,
      allClearPreviewSchema(EventIdSchema.parse(eventId)),
      signal,
    );
  }

  public allClear(
    eventId: string,
    lifecyclePreviewId: string,
    confirmationPhrase: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AllClearEventResult> {
    return this.mutate(
      eventId,
      {
        operation: 'all-clear',
        lifecyclePreviewId,
        confirmationPhrase,
      },
      idempotencyKey,
      allClearSchema(EventIdSchema.parse(eventId), lifecyclePreviewId),
      signal,
    );
  }

  public close(
    eventId: string,
    confirmationPhrase: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CloseEventResult> {
    return this.mutate(
      eventId,
      { operation: 'close', confirmationPhrase },
      idempotencyKey,
      closeSchema(EventIdSchema.parse(eventId)),
      signal,
    );
  }

  public createMediaUploadIntent(
    input: Readonly<{
      eventId: string;
      byteLength: number;
      contentSha256: string;
      declaredContentType: MediaContentType;
    }>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MediaUploadIntent> {
    const parsedEventId = EventIdSchema.parse(input.eventId);
    return this.request({
      method: 'POST',
      path: '/api/media/upload-intents',
      body: input,
      idempotencyKey,
      schema: schema((value) => {
        const intent = MediaUploadIntentSchema.parse(value);
        if (
          intent.eventId !== parsedEventId ||
          intent.byteLength !== input.byteLength ||
          intent.contentSha256 !== input.contentSha256 ||
          intent.declaredContentType !== input.declaredContentType
        ) {
          throw new Error('PSD EOC returned another photo upload intent.');
        }
        return intent;
      }),
      signal,
    });
  }

  public completeMediaUpload(
    uploadIntentId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MediaRecord> {
    return this.request({
      method: 'POST',
      path: `/api/media/upload-intents/${encodeURIComponent(uploadIntentId)}/complete`,
      idempotencyKey,
      schema: schema((value) => {
        const media = MediaRecordSchema.parse(value);
        if (media.uploadIntentId !== uploadIntentId) {
          throw new Error('PSD EOC completed another photo upload.');
        }
        return media;
      }),
      signal,
    });
  }

  public getMediaReadGrant(
    eventId: string,
    mediaId: string,
    signal?: AbortSignal,
  ): Promise<MediaReadGrant> {
    const parsedEventId = EventIdSchema.parse(eventId);
    return this.request({
      method: 'GET',
      path: `/api/media/events/${parsedEventId}/${encodeURIComponent(mediaId)}/read-grant`,
      schema: schema((value) => {
        const grant = MediaReadGrantSchema.parse(value);
        if (grant.eventId !== parsedEventId || grant.mediaId !== mediaId) {
          throw new Error('PSD EOC returned another photo read grant.');
        }
        return grant;
      }),
      signal,
    });
  }

  private mutate<Output>(
    eventId: string,
    body: unknown,
    idempotencyKey: string,
    responseSchema: JsonResponseSchema<Output>,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request({
      method: 'POST',
      path: eventRoomPath(eventId),
      body,
      idempotencyKey,
      schema: responseSchema,
      signal,
    });
  }
}
