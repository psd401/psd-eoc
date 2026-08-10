import { randomUUID } from 'node:crypto';

import {
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
  type CapabilityOutput,
  type MediaReadGrant,
  type MediaRecord,
  type MediaUploadIntent,
} from '@psd-eoc/contracts';

import {
  CapabilityEngineError,
  executeCapability,
  readCapabilityTime,
  type CapabilityHandlerContext,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import {
  ImageValidationError,
  sanitizeUploadedImage,
  type SanitizedImage,
} from './image';
import {
  invalidMedia,
  mediaConflict,
  mediaNotFound,
  mediaScanPending,
  mediaUnavailable,
} from './errors';
import {
  MEDIA_READ_GRANT_SECONDS,
  MEDIA_UPLOAD_GRANT_SECONDS,
  quarantineStorageKey,
  readyStorageKey,
  type StoredMediaRecord,
} from './model';
import {
  createMediaObjectStore,
  MediaObjectStoreError,
  type MediaObjectStore,
} from './object-store';
import {
  createMediaProcessingGate,
  MediaProcessingCapacityError,
  type MediaProcessingGate,
} from './processing-gate';
import {
  createDefaultMediaRepositoryRuntime,
  type MediaCapabilityStore,
  type MediaCapabilityTransaction,
  type MediaRepositoryRuntime,
  type ResolvedMediaUploadIntent,
  type ResolvedReadyMedia,
} from './repository';

export type MediaCapabilityId =
  | 'create-media-upload-intent'
  | 'complete-media-upload'
  | 'get-media-read-grant';

export interface MediaCapabilityDependencies {
  readonly objectStore: MediaObjectStore;
  readonly createId?: () => string;
  readonly sanitizeImage?: typeof sanitizeUploadedImage;
  readonly processingGate?: MediaProcessingGate;
}

interface ResolvedMediaCapabilityDependencies {
  readonly objectStore: MediaObjectStore;
  readonly createId: () => string;
  readonly sanitizeImage: typeof sanitizeUploadedImage;
  readonly processingGate: MediaProcessingGate;
}

const EVENT_CACHE_PREFIX = 'media:event:';
const INTENT_CACHE_PREFIX = 'media:intent:';
const LOCKED_INTENT_CACHE_PREFIX = 'media:intent:locked:';
const READY_CACHE_PREFIX = 'media:ready:';
const defaultMediaProcessingGate = createMediaProcessingGate();

function resolveDependencies(
  dependencies: MediaCapabilityDependencies,
): ResolvedMediaCapabilityDependencies {
  return Object.freeze({
    objectStore: dependencies.objectStore,
    createId: dependencies.createId ?? randomUUID,
    sanitizeImage: dependencies.sanitizeImage ?? sanitizeUploadedImage,
    processingGate: dependencies.processingGate ?? defaultMediaProcessingGate,
  });
}

function scopeAllowsFacility(
  context: CapabilityHandlerContext<MediaCapabilityTransaction>,
  facilityId: string,
): boolean {
  const facilityScope = context.invocation.scope.facilityScope;
  return (
    facilityScope.kind === 'district' ||
    facilityScope.facilityIds.includes(facilityId)
  );
}

async function eventFacilityId(
  eventId: string,
  context: CapabilityHandlerContext<MediaCapabilityTransaction>,
): Promise<string> {
  const key = `${EVENT_CACHE_PREFIX}${eventId}`;
  const cached = context.cache.get(key);
  if (typeof cached === 'string') {
    return cached;
  }
  const facilityId = await context.transaction.resolveEventFacilityId(eventId);
  if (facilityId === null) {
    throw mediaNotFound('The event is unavailable for this photo request.');
  }
  context.cache.set(key, facilityId);
  return facilityId;
}

async function uploadIntent(
  uploadIntentId: string,
  context: CapabilityHandlerContext<MediaCapabilityTransaction>,
  lock: boolean,
): Promise<ResolvedMediaUploadIntent> {
  const key = `${lock ? LOCKED_INTENT_CACHE_PREFIX : INTENT_CACHE_PREFIX}${uploadIntentId}`;
  const cached = context.cache.get(key) as
    | ResolvedMediaUploadIntent
    | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const resolved = await context.transaction.resolveUploadIntent(
    uploadIntentId,
    lock,
  );
  if (resolved === null) {
    throw mediaNotFound('The photo upload is unavailable.');
  }
  context.cache.set(key, resolved);
  return resolved;
}

async function readyMedia(
  eventId: string,
  mediaId: string,
  context: CapabilityHandlerContext<MediaCapabilityTransaction>,
): Promise<ResolvedReadyMedia> {
  const key = `${READY_CACHE_PREFIX}${eventId}:${mediaId}`;
  const cached = context.cache.get(key) as ResolvedReadyMedia | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const resolved = await context.transaction.resolveReadyMedia(
    eventId,
    mediaId,
  );
  if (resolved === null) {
    throw mediaNotFound('The requested photo is unavailable.');
  }
  context.cache.set(key, resolved);
  return resolved;
}

function translateObjectStoreError(error: unknown): never {
  if (!(error instanceof MediaObjectStoreError)) {
    throw error;
  }
  switch (error.code) {
    case 'CHECKSUM_MISMATCH':
    case 'OBJECT_SIZE_MISMATCH':
      throw invalidMedia(
        'The uploaded image did not match the selected file. Please upload it again.',
      );
    case 'INVALID_ARGUMENT':
    case 'CONFIGURATION_UNAVAILABLE':
    case 'OBJECT_BODY_UNAVAILABLE':
    case 'STORAGE_UNAVAILABLE':
      throw mediaUnavailable();
  }
}

async function callObjectStore<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    translateObjectStoreError(error);
  }
}

async function sanitizeImage(
  intent: ResolvedMediaUploadIntent['intent'],
  bytes: Uint8Array,
  dependencies: ResolvedMediaCapabilityDependencies,
): Promise<SanitizedImage> {
  try {
    return await dependencies.sanitizeImage({
      bytes,
      declaredByteLength: intent.byteLength,
      declaredContentSha256: intent.contentSha256,
      declaredContentType: intent.declaredContentType,
    });
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw invalidMedia(error.message);
    }
    throw mediaUnavailable();
  }
}

async function runMediaProcessing<Result>(
  dependencies: ResolvedMediaCapabilityDependencies,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await dependencies.processingGate.run(operation);
  } catch (error) {
    if (error instanceof MediaProcessingCapacityError) {
      throw mediaUnavailable();
    }
    throw error;
  }
}

function assertIntentCanIssueUploadGrant(
  resolved: ResolvedMediaUploadIntent,
): void {
  if (
    resolved.intent.status !== 'pending-upload' ||
    resolved.readyRecord !== null
  ) {
    throw mediaConflict(
      'The original photo upload grant is no longer available.',
    );
  }
}

function mediaRecordOutput(record: StoredMediaRecord): MediaRecord {
  return MediaRecordSchema.parse({
    id: record.id,
    uploadIntentId: record.uploadIntentId,
    eventId: record.eventId,
    status: record.status,
    detectedContentType: record.detectedContentType,
    sanitizedByteLength: record.sanitizedByteLength,
    sanitizedContentSha256: record.sanitizedContentSha256,
    malwareScan: record.malwareScan,
    exifStripped: record.exifStripped,
    createdAt: record.createdAt,
  });
}

async function uploadIntentOutput(
  resolved: ResolvedMediaUploadIntent,
  context: CapabilityHandlerContext<MediaCapabilityTransaction>,
  dependencies: ResolvedMediaCapabilityDependencies,
): Promise<MediaUploadIntent> {
  assertIntentCanIssueUploadGrant(resolved);
  const currentTime = await readCapabilityTime(context);
  const remainingSeconds = Math.floor(
    (Date.parse(resolved.intent.expiresAt) - currentTime.getTime()) / 1_000,
  );
  if (remainingSeconds < 1) {
    throw mediaConflict(
      'The photo upload grant has expired. Start a new upload.',
    );
  }
  const grant = await callObjectStore(() =>
    dependencies.objectStore.createRawUploadGrant({
      storageKey: resolved.intent.storageKey,
      byteLength: resolved.intent.byteLength,
      contentSha256: resolved.intent.contentSha256,
      contentType: resolved.intent.declaredContentType,
      expiresInSeconds: Math.min(MEDIA_UPLOAD_GRANT_SECONDS, remainingSeconds),
    }),
  );
  return MediaUploadIntentSchema.parse({
    id: resolved.intent.id,
    eventId: resolved.intent.eventId,
    byteLength: resolved.intent.byteLength,
    contentSha256: resolved.intent.contentSha256,
    declaredContentType: resolved.intent.declaredContentType,
    uploadMethod: grant.method,
    uploadUrl: grant.uploadUrl,
    status: 'pending-upload',
    createdAt: resolved.intent.createdAt,
    expiresAt: resolved.intent.expiresAt,
  });
}

/**
 * Media outputs intentionally omit facility IDs. Replays therefore validate
 * the persisted facility against the current scope here, then use a null/null
 * engine comparison rather than trusting caller-owned output as evidence.
 */
function authorizeReplayFacility(
  context: CapabilityHandlerContext<MediaCapabilityTransaction>,
  facilityId: string,
): null {
  context.resolvedFacilityId = facilityId;
  if (!scopeAllowsFacility(context, facilityId)) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_SCOPE_DENIED',
      'The requested facility is outside the authenticated scope.',
      403,
    );
  }
  return null;
}

function createRegistrations(
  dependencies: ResolvedMediaCapabilityDependencies,
): Readonly<{
  'create-media-upload-intent': ServerCapabilityRegistration<
    'create-media-upload-intent',
    MediaCapabilityTransaction
  >;
  'complete-media-upload': ServerCapabilityRegistration<
    'complete-media-upload',
    MediaCapabilityTransaction
  >;
  'get-media-read-grant': ServerCapabilityRegistration<
    'get-media-read-grant',
    MediaCapabilityTransaction
  >;
}> {
  const createUploadIntent: ServerCapabilityRegistration<
    'create-media-upload-intent',
    MediaCapabilityTransaction
  > = {
    id: 'create-media-upload-intent',
    resolveFacilityId: (input, context) =>
      eventFacilityId(input.eventId, context),
    async handler(input, context): Promise<MediaUploadIntent> {
      const createdAt = await readCapabilityTime(context);
      const expiresAt = new Date(
        createdAt.getTime() + MEDIA_UPLOAD_GRANT_SECONDS * 1_000,
      );
      const id = dependencies.createId();
      const storageKey = quarantineStorageKey(input.eventId, id);
      await context.transaction.insertUploadIntent({
        id,
        eventId: input.eventId,
        byteLength: input.byteLength,
        contentSha256: input.contentSha256,
        declaredContentType: input.declaredContentType,
        storageKey,
        createdAt,
        expiresAt,
      });
      return uploadIntentOutput(
        {
          facilityId: context.authorization?.facilityId ?? '',
          intent: {
            id,
            eventId: input.eventId,
            byteLength: input.byteLength,
            contentSha256: input.contentSha256,
            declaredContentType: input.declaredContentType,
            storageKey,
            status: 'pending-upload',
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
          readyRecord: null,
        },
        context,
        dependencies,
      );
    },
    resultReference: (output) => output.id,
    async loadReplay(resultReference, context) {
      return uploadIntentOutput(
        await uploadIntent(resultReference, context, false),
        context,
        dependencies,
      );
    },
    async resolveReplayFacilityId(resultReference, context) {
      const resolved = await uploadIntent(resultReference, context, false);
      return authorizeReplayFacility(context, resolved.facilityId);
    },
    replayFacilityId: () => null,
  };

  const completeUpload: ServerCapabilityRegistration<
    'complete-media-upload',
    MediaCapabilityTransaction
  > = {
    id: 'complete-media-upload',
    async resolveFacilityId(input, context) {
      return (await uploadIntent(input.uploadIntentId, context, false))
        .facilityId;
    },
    async handler(input, context): Promise<MediaRecord> {
      const resolved = await uploadIntent(input.uploadIntentId, context, true);
      if (resolved.readyRecord !== null) {
        return mediaRecordOutput(resolved.readyRecord);
      }
      if (resolved.intent.status !== 'pending-upload') {
        throw mediaConflict(
          'The photo upload cannot be completed in its current state.',
        );
      }
      const currentTime = await readCapabilityTime(context);
      if (currentTime.getTime() > Date.parse(resolved.intent.expiresAt)) {
        throw mediaConflict(
          'The photo upload has expired. Start a new upload.',
        );
      }

      const scanStatus = await callObjectStore(() =>
        dependencies.objectStore.getMalwareScanStatus(
          resolved.intent.storageKey,
        ),
      );
      switch (scanStatus) {
        case 'pending':
          throw mediaScanPending();
        case 'threats':
          throw invalidMedia(
            'The photo did not pass its safety scan. Choose a different image.',
          );
        case 'unsupported':
        case 'access-denied':
        case 'failed':
          throw mediaUnavailable();
        case 'clean':
          break;
      }

      const mediaId = resolved.intent.id;
      const storageKey = readyStorageKey(resolved.intent.eventId, mediaId);
      const { sanitized, stored } = await runMediaProcessing(
        dependencies,
        async () => {
          const raw = await callObjectStore(() =>
            dependencies.objectStore.readVerifiedRawObject({
              storageKey: resolved.intent.storageKey,
              expectedByteLength: resolved.intent.byteLength,
              expectedContentSha256: resolved.intent.contentSha256,
            }),
          );
          const sanitizedResult = await sanitizeImage(
            resolved.intent,
            raw.bytes,
            dependencies,
          );
          const storedResult = await callObjectStore(() =>
            dependencies.objectStore.putSanitizedObject({
              storageKey,
              bytes: sanitizedResult.sanitizedBytes,
              contentType: sanitizedResult.sanitizedContentType,
              metadata: {
                eventId: resolved.intent.eventId,
                mediaId,
                uploadIntentId: resolved.intent.id,
              },
            }),
          );
          return { sanitized: sanitizedResult, stored: storedResult };
        },
      );
      if (
        stored.contentSha256 !== sanitized.sanitizedContentSha256 ||
        stored.byteLength !== sanitized.sanitizedByteLength
      ) {
        throw mediaUnavailable();
      }
      const record: StoredMediaRecord = Object.freeze({
        id: mediaId,
        uploadIntentId: resolved.intent.id,
        eventId: resolved.intent.eventId,
        status: 'ready',
        detectedContentType: sanitized.detectedContentType,
        sanitizedByteLength: stored.byteLength,
        sanitizedContentSha256: stored.contentSha256,
        malwareScan: 'clean',
        exifStripped: true,
        createdAt: currentTime.toISOString(),
        storageKey,
      });
      await context.transaction.completeUpload({
        record,
        expectedIntentStatus: 'pending-upload',
      });
      return mediaRecordOutput(record);
    },
    resultReference: (output) => output.id,
    async loadReplay(resultReference, context) {
      const resolved = await uploadIntent(resultReference, context, false);
      if (resolved.readyRecord === null) {
        throw mediaUnavailable();
      }
      return mediaRecordOutput(resolved.readyRecord);
    },
    async resolveReplayFacilityId(resultReference, context) {
      const resolved = await uploadIntent(resultReference, context, false);
      return authorizeReplayFacility(context, resolved.facilityId);
    },
    replayFacilityId: () => null,
  };

  const getReadGrant: ServerCapabilityRegistration<
    'get-media-read-grant',
    MediaCapabilityTransaction
  > = {
    id: 'get-media-read-grant',
    async resolveFacilityId(input, context) {
      return (await readyMedia(input.eventId, input.mediaId, context))
        .facilityId;
    },
    async handler(input, context): Promise<MediaReadGrant> {
      const resolved = await readyMedia(input.eventId, input.mediaId, context);
      const issuedAt = await readCapabilityTime(context);
      const grant = await callObjectStore(() =>
        dependencies.objectStore.createPrivateReadGrant({
          storageKey: resolved.record.storageKey,
          expiresInSeconds: MEDIA_READ_GRANT_SECONDS,
        }),
      );
      return MediaReadGrantSchema.parse({
        eventId: input.eventId,
        mediaId: input.mediaId,
        readUrl: grant.readUrl,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(
          issuedAt.getTime() + grant.expiresInSeconds * 1_000,
        ).toISOString(),
      });
    },
  };

  return Object.freeze({
    'create-media-upload-intent': createUploadIntent,
    'complete-media-upload': completeUpload,
    'get-media-read-grant': getReadGrant,
  });
}

export async function executeMediaCapability<Id extends MediaCapabilityId>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: MediaCapabilityStore,
  dependencies: MediaCapabilityDependencies,
): Promise<CapabilityOutput<Id>> {
  const registrations = createRegistrations(resolveDependencies(dependencies));
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, MediaCapabilityTransaction>;
  return executeCapability(registration, input, invocation, store);
}

export interface MediaCapabilityRuntime {
  readonly store: MediaCapabilityStore;
  execute<Id extends MediaCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  close(): Promise<void>;
}

/** Builds a media runtime around an explicitly managed repository. */
export function createMediaCapabilityRuntime(
  repository: MediaRepositoryRuntime,
  dependencies: MediaCapabilityDependencies,
): MediaCapabilityRuntime {
  const resolved = resolveDependencies(dependencies);
  const registrations = createRegistrations(resolved);
  return Object.freeze({
    store: repository.store,
    execute<Id extends MediaCapabilityId>(
      capabilityId: Id,
      input: unknown,
      invocation: TrustedCapabilityInvocation,
    ): Promise<CapabilityOutput<Id>> {
      const registration = registrations[
        capabilityId
      ] as ServerCapabilityRegistration<Id, MediaCapabilityTransaction>;
      return executeCapability(
        registration,
        input,
        invocation,
        repository.store,
      );
    },
    close: () => repository.connection.close(),
  });
}

let defaultMediaCapabilityRuntime: MediaCapabilityRuntime | undefined;

/** Lazily creates the private S3 + database runtime used by REST routes. */
export function getDefaultMediaCapabilityRuntime(): MediaCapabilityRuntime {
  defaultMediaCapabilityRuntime ??= createMediaCapabilityRuntime(
    createDefaultMediaRepositoryRuntime(),
    { objectStore: createMediaObjectStore() },
  );
  return defaultMediaCapabilityRuntime;
}

/** Lifecycle hook for tests and scripts; Next.js retains the normal pool. */
export async function closeDefaultMediaCapabilityRuntime(): Promise<void> {
  const runtime = defaultMediaCapabilityRuntime;
  defaultMediaCapabilityRuntime = undefined;
  await runtime?.close();
}
