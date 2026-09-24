import {
  AppendJournalEntryInputSchema,
  CreateMediaUploadIntentInputSchema,
  EventIdSchema,
  IdempotencyKeySchema,
  JournalEntryReadProjectionSchema,
  JournalEntrySchema,
  MediaContentTypeSchema,
  MediaIdSchema,
  MediaRecordSchema,
  MediaUploadIntentIdSchema,
  MediaUploadIntentSchema,
  UuidSchema,
  type CreateMediaUploadIntentInput,
  type JournalEntry,
  type JournalEntryInput,
  type JournalEntryReadProjection,
  type MediaContentType,
  type MediaRecord,
  type MediaUploadIntent,
} from '@psd-eoc/contracts';

import { parseIgnoringNewServerFields } from '../../lib/api/forward-compatible-parse';

const PHOTO_DRAFT_VERSION = 1 as const;
const PHOTO_PAYLOAD_VALIDATION_MEDIA_ID =
  '00000000-0000-4000-8000-000000000000';

export type PhotoDraftNetworkStage =
  'create-intent' | 'upload-bytes' | 'complete-upload' | 'append-entry';

export type PhotoDraftStage =
  | 'ready'
  | 'creating-intent'
  | 'uploading'
  | 'completing-upload'
  | 'appending'
  | 'failed'
  | 'unknown'
  | 'cleanup-pending';

export type PhotoDraftCleanupProof =
  'append-response' | 'timeline-reconciliation';

export interface PhotoDraftIdempotencyKeys {
  readonly createIntent: string;
  readonly completeUpload: string;
  readonly appendEntry: string;
}

/**
 * Durable, private metadata for one selected photo. Transient upload grants
 * deliberately have no field in this closed shape.
 */
export interface PhotoDraftManifest {
  readonly version: typeof PHOTO_DRAFT_VERSION;
  readonly draftId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly localUri: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly declaredContentType: MediaContentType;
  readonly altText: string;
  readonly caption: string | null;
  readonly stage: PhotoDraftStage;
  readonly retryStage: PhotoDraftNetworkStage | null;
  readonly cleanupProof: PhotoDraftCleanupProof | null;
  readonly uploadIntentId: string | null;
  readonly mediaId: string | null;
  readonly idempotencyKeys: PhotoDraftIdempotencyKeys;
}

export interface CreatePhotoDraftInput {
  /** Unique, persisted owner token created before the native picker opens. */
  readonly draftId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly localUri: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly declaredContentType: MediaContentType;
  readonly altText: string;
  readonly caption: string | null;
}

export interface RestorePhotoDraftInput {
  readonly draftId: string;
  readonly eventId: string;
  readonly sessionId: string;
}

export interface PhotoDraftStorage {
  /** Loads the single retained draft slot for an event. */
  load(eventId: string): Promise<unknown | null>;
  /** Atomically replaces only the exact expected prior state. */
  save(
    manifest: PhotoDraftManifest,
    expected: PhotoDraftManifest | null,
  ): Promise<void>;
  /** Deletes only when the retained slot still has this exact owner token. */
  deleteManifest(
    eventId: string,
    draftId: string,
    expected: PhotoDraftManifest,
  ): Promise<void>;
}

export interface PhotoDraftUploadInput {
  readonly draftId: string;
  readonly localUri: string;
  readonly uploadUrl: string;
  readonly contentType: MediaContentType;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly signal: AbortSignal;
  readonly onProgress: (fraction: number) => void;
}

type PhotoJournalEntryInput = Extract<JournalEntryInput, { kind: 'photo' }>;

export interface PhotoDraftNetwork {
  createUploadIntent(
    input: CreateMediaUploadIntentInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<MediaUploadIntent>;
  uploadBytes(input: PhotoDraftUploadInput): Promise<unknown>;
  completeUpload(
    uploadIntentId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<MediaRecord>;
  appendPhoto(
    input: PhotoJournalEntryInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<JournalEntry>;
}

export type PhotoDraftIdempotencyPurpose =
  'create-intent' | 'complete-upload' | 'append-entry';

export interface PhotoDraftDependencies {
  readonly storage: PhotoDraftStorage;
  readonly network: PhotoDraftNetwork;
  readonly deletePrivateCopy: (
    localUri: string,
    draftId: string,
  ) => void | Promise<void>;
  readonly createIdempotencyKey: (
    purpose: PhotoDraftIdempotencyPurpose,
  ) => string;
}

export interface PhotoDraftProgress {
  readonly stage: PhotoDraftStage | 'complete';
  readonly fraction: number;
  readonly requiresExplicitRetry: boolean;
}

export interface PhotoDraftSnapshot {
  readonly manifest: PhotoDraftManifest | null;
  readonly progress: PhotoDraftProgress;
}

export type PhotoDraftListener = (snapshot: PhotoDraftSnapshot) => void;

export type PhotoDraftOperationOutcome = 'failed' | 'unknown';

/** Lets an adapter distinguish a proved failure from an indeterminate call. */
export class PhotoDraftOperationError extends Error {
  public constructor(
    public readonly outcome: PhotoDraftOperationOutcome,
    message = 'The photo operation did not complete.',
  ) {
    super(message);
    this.name = 'PhotoDraftOperationError';
  }
}

export class PhotoDraftStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PhotoDraftStateError';
  }
}

class PhotoDraftHalted extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new PhotoDraftStateError(
      'The stored photo draft has an invalid shape.',
    );
  }
}

function parseExactString(
  value: unknown,
  parse: (candidate: unknown) => string,
): string {
  const parsed = parse(value);
  if (parsed !== value) {
    throw new PhotoDraftStateError(
      'The stored photo draft contains non-canonical text.',
    );
  }
  return parsed;
}

function parseUuid(value: unknown): string {
  return parseExactString(value, (candidate) => UuidSchema.parse(candidate));
}

function parseEventId(value: unknown): string {
  return parseExactString(value, (candidate) => EventIdSchema.parse(candidate));
}

function parseNullableUuid(
  value: unknown,
  parse: (candidate: unknown) => string,
): string | null {
  return value === null ? null : parseExactString(value, parse);
}

function parsePrivateLocalUri(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    !value.startsWith('file:///') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new PhotoDraftStateError(
      'The stored photo draft does not reference a private local file.',
    );
  }
  try {
    const parsed = new URL(value);
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (
      parsed.protocol !== 'file:' ||
      parsed.hostname !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      decodedPath.split('/').some((part) => part === '..')
    ) {
      throw new Error('Unsafe private URI.');
    }
  } catch {
    throw new PhotoDraftStateError(
      'The stored photo draft does not reference a private local file.',
    );
  }
  return value;
}

const PHOTO_DRAFT_STAGES: readonly PhotoDraftStage[] = [
  'ready',
  'creating-intent',
  'uploading',
  'completing-upload',
  'appending',
  'failed',
  'unknown',
  'cleanup-pending',
];

const NETWORK_STAGES: readonly PhotoDraftNetworkStage[] = [
  'create-intent',
  'upload-bytes',
  'complete-upload',
  'append-entry',
];

const CLEANUP_PROOFS: readonly PhotoDraftCleanupProof[] = [
  'append-response',
  'timeline-reconciliation',
];

function parseEnum<const Value extends string>(
  candidate: unknown,
  values: readonly Value[],
): Value {
  if (typeof candidate !== 'string' || !values.includes(candidate as Value)) {
    throw new PhotoDraftStateError(
      'The stored photo draft has an invalid stage.',
    );
  }
  return candidate as Value;
}

function parseNullableEnum<const Value extends string>(
  candidate: unknown,
  values: readonly Value[],
): Value | null {
  return candidate === null ? null : parseEnum(candidate, values);
}

function expectedIdentifiers(
  stage: PhotoDraftStage,
  retryStage: PhotoDraftNetworkStage | null,
): Readonly<{ uploadIntent: boolean; media: boolean }> {
  const effectiveStage =
    stage === 'failed' || stage === 'unknown' ? retryStage : null;
  if (stage === 'cleanup-pending' || stage === 'appending') {
    return { uploadIntent: true, media: true };
  }
  if (stage === 'uploading' || stage === 'completing-upload') {
    return { uploadIntent: true, media: false };
  }
  switch (effectiveStage) {
    case 'upload-bytes':
    case 'complete-upload':
      return { uploadIntent: true, media: false };
    case 'append-entry':
      return { uploadIntent: true, media: true };
    case 'create-intent':
    case null:
      return { uploadIntent: false, media: false };
  }
}

function freezeManifest(manifest: PhotoDraftManifest): PhotoDraftManifest {
  return Object.freeze({
    ...manifest,
    idempotencyKeys: Object.freeze({ ...manifest.idempotencyKeys }),
  });
}

/** Strictly validates untrusted persisted data without normalizing it. */
export function parsePhotoDraftManifest(value: unknown): PhotoDraftManifest {
  try {
    if (!isRecord(value)) {
      throw new PhotoDraftStateError(
        'The stored photo draft has an invalid shape.',
      );
    }
    assertExactKeys(value, [
      'version',
      'draftId',
      'eventId',
      'sessionId',
      'localUri',
      'byteLength',
      'contentSha256',
      'declaredContentType',
      'altText',
      'caption',
      'stage',
      'retryStage',
      'cleanupProof',
      'uploadIntentId',
      'mediaId',
      'idempotencyKeys',
    ]);
    if (value.version !== PHOTO_DRAFT_VERSION) {
      throw new PhotoDraftStateError(
        'The stored photo draft version is unsupported.',
      );
    }
    const draftId = parseUuid(value.draftId);
    const eventId = parseEventId(value.eventId);
    const sessionId = parseUuid(value.sessionId);
    const localUri = parsePrivateLocalUri(value.localUri);
    const metadata = CreateMediaUploadIntentInputSchema.parse({
      eventId,
      byteLength: value.byteLength,
      contentSha256: value.contentSha256,
      declaredContentType: value.declaredContentType,
    });
    if (
      metadata.byteLength !== value.byteLength ||
      metadata.contentSha256 !== value.contentSha256 ||
      metadata.declaredContentType !== value.declaredContentType
    ) {
      throw new PhotoDraftStateError(
        'The stored photo metadata is not canonical.',
      );
    }
    const photoInput = AppendJournalEntryInputSchema.parse({
      eventId,
      clientTime: null,
      supersedes: null,
      kind: 'photo',
      payload: {
        mediaId: PHOTO_PAYLOAD_VALIDATION_MEDIA_ID,
        altText: value.altText,
        caption: value.caption,
      },
    });
    if (
      photoInput.kind !== 'photo' ||
      photoInput.payload.altText !== value.altText ||
      photoInput.payload.caption !== value.caption
    ) {
      throw new PhotoDraftStateError(
        'The stored photo description is not canonical.',
      );
    }
    const stage = parseEnum(value.stage, PHOTO_DRAFT_STAGES);
    const retryStage = parseNullableEnum(value.retryStage, NETWORK_STAGES);
    const cleanupProof = parseNullableEnum(value.cleanupProof, CLEANUP_PROOFS);
    if (
      ((stage === 'failed' || stage === 'unknown') && retryStage === null) ||
      (stage !== 'failed' && stage !== 'unknown' && retryStage !== null) ||
      (stage === 'cleanup-pending' && cleanupProof === null) ||
      (stage !== 'cleanup-pending' && cleanupProof !== null)
    ) {
      throw new PhotoDraftStateError(
        'The stored photo draft stage is internally inconsistent.',
      );
    }
    const uploadIntentId = parseNullableUuid(
      value.uploadIntentId,
      (candidate) => MediaUploadIntentIdSchema.parse(candidate),
    );
    const mediaId = parseNullableUuid(value.mediaId, (candidate) =>
      MediaIdSchema.parse(candidate),
    );
    const expected = expectedIdentifiers(stage, retryStage);
    if (
      (uploadIntentId !== null) !== expected.uploadIntent ||
      (mediaId !== null) !== expected.media
    ) {
      throw new PhotoDraftStateError(
        'The stored photo draft identifiers do not match its stage.',
      );
    }
    if (!isRecord(value.idempotencyKeys)) {
      throw new PhotoDraftStateError(
        'The stored photo draft has invalid idempotency keys.',
      );
    }
    assertExactKeys(value.idempotencyKeys, [
      'createIntent',
      'completeUpload',
      'appendEntry',
    ]);
    const idempotencyKeys = {
      createIntent: parseExactString(
        value.idempotencyKeys.createIntent,
        (candidate) => IdempotencyKeySchema.parse(candidate),
      ),
      completeUpload: parseExactString(
        value.idempotencyKeys.completeUpload,
        (candidate) => IdempotencyKeySchema.parse(candidate),
      ),
      appendEntry: parseExactString(
        value.idempotencyKeys.appendEntry,
        (candidate) => IdempotencyKeySchema.parse(candidate),
      ),
    };
    if (new Set(Object.values(idempotencyKeys)).size !== 3) {
      throw new PhotoDraftStateError(
        'Photo draft operations require separate idempotency keys.',
      );
    }
    return freezeManifest({
      version: PHOTO_DRAFT_VERSION,
      draftId,
      eventId,
      sessionId,
      localUri,
      byteLength: metadata.byteLength,
      contentSha256: metadata.contentSha256,
      declaredContentType: MediaContentTypeSchema.parse(
        metadata.declaredContentType,
      ),
      altText: photoInput.payload.altText,
      caption: photoInput.payload.caption,
      stage,
      retryStage,
      cleanupProof,
      uploadIntentId,
      mediaId,
      idempotencyKeys,
    });
  } catch (error) {
    if (error instanceof PhotoDraftStateError) throw error;
    throw new PhotoDraftStateError('The stored photo draft failed validation.');
  }
}

function progressFloor(stage: PhotoDraftNetworkStage): number {
  switch (stage) {
    case 'create-intent':
      return 0.05;
    case 'upload-bytes':
      return 0.1;
    case 'complete-upload':
      return 0.78;
    case 'append-entry':
      return 0.9;
  }
}

function activeStageFor(networkStage: PhotoDraftNetworkStage): PhotoDraftStage {
  switch (networkStage) {
    case 'create-intent':
      return 'creating-intent';
    case 'upload-bytes':
      return 'uploading';
    case 'complete-upload':
      return 'completing-upload';
    case 'append-entry':
      return 'appending';
  }
}

function retryStageForActive(stage: PhotoDraftStage): PhotoDraftNetworkStage {
  switch (stage) {
    case 'creating-intent':
      return 'create-intent';
    case 'uploading':
      return 'upload-bytes';
    case 'completing-upload':
      return 'complete-upload';
    case 'appending':
      return 'append-entry';
    default:
      throw new PhotoDraftStateError(
        'Only an interrupted network stage can be restored as unknown.',
      );
  }
}

function sameRestoreLineage(
  left: PhotoDraftManifest,
  right: PhotoDraftManifest,
): boolean {
  return (
    left.draftId === right.draftId &&
    left.eventId === right.eventId &&
    left.sessionId === right.sessionId &&
    left.localUri === right.localUri &&
    left.byteLength === right.byteLength &&
    left.contentSha256 === right.contentSha256 &&
    left.declaredContentType === right.declaredContentType &&
    left.altText === right.altText &&
    left.caption === right.caption &&
    left.uploadIntentId === right.uploadIntentId &&
    left.mediaId === right.mediaId &&
    left.idempotencyKeys.createIntent === right.idempotencyKeys.createIntent &&
    left.idempotencyKeys.completeUpload ===
      right.idempotencyKeys.completeUpload &&
    left.idempotencyKeys.appendEntry === right.idempotencyKeys.appendEntry
  );
}

function validateIntent(
  value: unknown,
  manifest: PhotoDraftManifest,
  expectedIntentId: string | null,
): MediaUploadIntent {
  const intent = parseIgnoringNewServerFields(MediaUploadIntentSchema, value);
  if (
    intent.eventId !== manifest.eventId ||
    intent.byteLength !== manifest.byteLength ||
    intent.contentSha256 !== manifest.contentSha256 ||
    intent.declaredContentType !== manifest.declaredContentType ||
    (expectedIntentId !== null && intent.id !== expectedIntentId)
  ) {
    throw new PhotoDraftOperationError(
      'unknown',
      'The upload grant did not match the retained photo draft.',
    );
  }
  return intent;
}

function validateMedia(
  value: unknown,
  manifest: PhotoDraftManifest,
): MediaRecord {
  const media = parseIgnoringNewServerFields(MediaRecordSchema, value);
  if (
    media.eventId !== manifest.eventId ||
    media.uploadIntentId !== manifest.uploadIntentId
  ) {
    throw new PhotoDraftOperationError(
      'unknown',
      'The completed media did not match the retained photo draft.',
    );
  }
  return media;
}

function photoInput(manifest: PhotoDraftManifest): PhotoJournalEntryInput {
  const parsed = AppendJournalEntryInputSchema.parse({
    eventId: manifest.eventId,
    clientTime: null,
    supersedes: null,
    kind: 'photo',
    payload: {
      mediaId: manifest.mediaId,
      altText: manifest.altText,
      caption: manifest.caption,
    },
  });
  if (parsed.kind !== 'photo') {
    throw new PhotoDraftStateError('The retained photo payload is invalid.');
  }
  return parsed;
}

function isExactCanonicalPhoto(
  entry: JournalEntry,
  manifest: PhotoDraftManifest,
): boolean {
  return (
    entry.eventId === manifest.eventId &&
    entry.kind === 'photo' &&
    entry.payload.mediaId === manifest.mediaId &&
    entry.payload.altText === manifest.altText &&
    entry.payload.caption === manifest.caption &&
    entry.supersedes === null &&
    entry.author.kind === 'human' &&
    entry.author.sessionId === manifest.sessionId &&
    entry.source === 'mobile'
  );
}

function validateAppendedPhoto(
  value: unknown,
  manifest: PhotoDraftManifest,
): JournalEntry {
  const entry = parseIgnoringNewServerFields(JournalEntrySchema, value);
  if (!isExactCanonicalPhoto(entry, manifest)) {
    throw new PhotoDraftOperationError(
      'unknown',
      'The appended photo did not match the retained draft.',
    );
  }
  return entry;
}

function immutableSnapshot(
  manifest: PhotoDraftManifest | null,
  progress: PhotoDraftProgress,
): PhotoDraftSnapshot {
  return Object.freeze({
    manifest,
    progress: Object.freeze(progress),
  });
}

/**
 * Explicitly driven photo workflow. It schedules no work: callers must invoke
 * start, retry, reconciliation, or cleanup themselves.
 */
export class PhotoDraftController {
  private readonly listeners = new Set<PhotoDraftListener>();
  private manifest: PhotoDraftManifest | null;
  private uploadFraction = 0;
  private running = false;
  private backgroundObserved = false;
  private activeController: AbortController | null = null;
  private operationSettled: Promise<void> = Promise.resolve();

  private constructor(
    manifest: PhotoDraftManifest,
    private readonly dependencies: PhotoDraftDependencies,
  ) {
    this.manifest = manifest;
  }

  public static async create(
    input: CreatePhotoDraftInput,
    dependencies: PhotoDraftDependencies,
  ): Promise<PhotoDraftController> {
    const manifest = parsePhotoDraftManifest({
      version: PHOTO_DRAFT_VERSION,
      draftId: input.draftId,
      eventId: input.eventId,
      sessionId: input.sessionId,
      localUri: input.localUri,
      byteLength: input.byteLength,
      contentSha256: input.contentSha256,
      declaredContentType: input.declaredContentType,
      altText: input.altText,
      caption: input.caption,
      stage: 'ready',
      retryStage: null,
      cleanupProof: null,
      uploadIntentId: null,
      mediaId: null,
      idempotencyKeys: {
        createIntent: dependencies.createIdempotencyKey('create-intent'),
        completeUpload: dependencies.createIdempotencyKey('complete-upload'),
        appendEntry: dependencies.createIdempotencyKey('append-entry'),
      },
    });
    // This is the first side effect. Network adapters are unreachable until
    // the complete manifest, including all replay keys, is durable.
    await dependencies.storage.save(manifest, null);
    return new PhotoDraftController(manifest, dependencies);
  }

  public static async restore(
    input: RestorePhotoDraftInput,
    dependencies: PhotoDraftDependencies,
  ): Promise<PhotoDraftController> {
    const draftId = parseUuid(input.draftId);
    const eventId = parseEventId(input.eventId);
    const sessionId = parseUuid(input.sessionId);
    const stored = await dependencies.storage.load(eventId);
    if (stored === null) {
      throw new PhotoDraftStateError('The retained photo draft was not found.');
    }
    let manifest = parsePhotoDraftManifest(stored);
    if (
      manifest.draftId !== draftId ||
      manifest.eventId !== eventId ||
      manifest.sessionId !== sessionId
    ) {
      throw new PhotoDraftStateError(
        'The retained photo draft belongs to another event or session.',
      );
    }
    if (
      manifest.stage === 'creating-intent' ||
      manifest.stage === 'uploading' ||
      manifest.stage === 'completing-upload' ||
      manifest.stage === 'appending'
    ) {
      manifest = parsePhotoDraftManifest({
        ...manifest,
        stage: 'unknown',
        retryStage: retryStageForActive(manifest.stage),
      });
      const previous = parsePhotoDraftManifest(stored);
      try {
        await dependencies.storage.save(manifest, previous);
      } catch (error) {
        const concurrent = await dependencies.storage.load(eventId);
        if (concurrent === null) throw error;
        const adopted = parsePhotoDraftManifest(concurrent);
        if (
          adopted.stage !== 'unknown' ||
          adopted.retryStage !== manifest.retryStage ||
          adopted.cleanupProof !== null ||
          !sameRestoreLineage(adopted, manifest)
        ) {
          throw error;
        }
        manifest = adopted;
      }
    }
    return new PhotoDraftController(manifest, dependencies);
  }

  public snapshot(): PhotoDraftSnapshot {
    if (this.manifest === null) {
      return immutableSnapshot(null, {
        stage: 'complete',
        fraction: 1,
        requiresExplicitRetry: false,
      });
    }
    const { stage, retryStage } = this.manifest;
    const fraction = (() => {
      switch (stage) {
        case 'ready':
          return 0;
        case 'creating-intent':
          return 0.05;
        case 'uploading':
          return 0.1 + this.uploadFraction * 0.65;
        case 'completing-upload':
          return 0.78;
        case 'appending':
          return 0.9;
        case 'cleanup-pending':
          return 0.98;
        case 'failed':
        case 'unknown':
          return retryStage === null ? 0 : progressFloor(retryStage);
      }
    })();
    return immutableSnapshot(this.manifest, {
      stage,
      fraction,
      requiresExplicitRetry: stage === 'failed' || stage === 'unknown',
    });
  }

  public subscribe(listener: PhotoDraftListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Stops unlocked work while retaining the exact durable retry checkpoint. */
  public interruptForBackground(): void {
    // Merely backgrounding an idle, ready composer does not make its outcome
    // uncertain. start()/retry() claim synchronously before their first await,
    // so this still covers interruption during every persistence/network gap.
    if (!this.running) return;
    this.backgroundObserved = true;
    this.activeController?.abort();
  }

  /** Resolves after this controller's claimed persistence/network work settles. */
  public async waitForOperationSettlement(): Promise<void> {
    await this.operationSettled;
  }

  private trackOperation<Value>(operation: Promise<Value>): Promise<Value> {
    const previous = this.operationSettled;
    this.operationSettled = Promise.allSettled([previous, operation]).then(
      () => undefined,
    );
    return operation;
  }

  public async start(): Promise<PhotoDraftSnapshot> {
    const manifest = this.requireManifest();
    if (manifest.stage !== 'ready') {
      throw new PhotoDraftStateError(
        'Only a ready photo draft can start uploading.',
      );
    }
    return this.runFrom('create-intent');
  }

  /** Persists description edits only while no network operation has begun. */
  public async updateDescription(
    altText: string,
    caption: string | null,
  ): Promise<PhotoDraftSnapshot> {
    return this.trackOperation(this.updateDescriptionTracked(altText, caption));
  }

  private async updateDescriptionTracked(
    altText: string,
    caption: string | null,
  ): Promise<PhotoDraftSnapshot> {
    const manifest = this.requireManifest();
    if (this.running || manifest.stage !== 'ready') {
      throw new PhotoDraftStateError(
        'A started photo draft cannot change its description.',
      );
    }
    await this.transition({ ...manifest, altText, caption });
    return this.snapshot();
  }

  /** Cancels only a draft that has never attempted a network operation. */
  public async discard(): Promise<PhotoDraftSnapshot> {
    return this.trackOperation(this.discardTracked());
  }

  private async discardTracked(): Promise<PhotoDraftSnapshot> {
    const manifest = this.requireManifest();
    if (this.running || manifest.stage !== 'ready') {
      throw new PhotoDraftStateError(
        'A started or uncertain photo draft cannot be discarded.',
      );
    }
    try {
      await this.dependencies.deletePrivateCopy(
        manifest.localUri,
        manifest.draftId,
      );
      await this.dependencies.storage.deleteManifest(
        manifest.eventId,
        manifest.draftId,
        manifest,
      );
    } catch {
      return this.snapshot();
    }
    this.manifest = null;
    this.emit();
    return this.snapshot();
  }

  /**
   * Explicit local-only cleanup after an event is closed. No network adapter
   * is reachable, including for failed or uncertain retained operations.
   */
  public async discardLocallyAfterEventClosed(): Promise<PhotoDraftSnapshot> {
    return this.trackOperation(this.discardLocallyAfterEventClosedTracked());
  }

  private async discardLocallyAfterEventClosedTracked(): Promise<PhotoDraftSnapshot> {
    const manifest = this.requireManifest();
    if (this.running) {
      throw new PhotoDraftStateError(
        'An active photo operation cannot be cleaned up locally.',
      );
    }
    try {
      await this.dependencies.deletePrivateCopy(
        manifest.localUri,
        manifest.draftId,
      );
      await this.dependencies.storage.deleteManifest(
        manifest.eventId,
        manifest.draftId,
        manifest,
      );
    } catch {
      return this.snapshot();
    }
    this.manifest = null;
    this.emit();
    return this.snapshot();
  }

  public async retry(
    projections: readonly JournalEntryReadProjection[],
  ): Promise<PhotoDraftSnapshot> {
    return this.trackOperation(this.retryTracked(projections));
  }

  private async retryTracked(
    projections: readonly JournalEntryReadProjection[],
  ): Promise<PhotoDraftSnapshot> {
    const manifest = this.requireManifest();
    if (
      (manifest.stage !== 'failed' && manifest.stage !== 'unknown') ||
      manifest.retryStage === null
    ) {
      throw new PhotoDraftStateError(
        'Only a failed or unknown photo operation can be retried.',
      );
    }
    this.claimOperation();
    let delegatedToNetwork = false;
    try {
      const parsed = projections.map((projection) =>
        JournalEntryReadProjectionSchema.parse(projection),
      );
      const matched = parsed.some(
        (projection) =>
          projection.visibility === 'visible' &&
          isExactCanonicalPhoto(projection.entry, manifest),
      );
      if (matched) {
        await this.transition({
          ...manifest,
          stage: 'cleanup-pending',
          retryStage: null,
          cleanupProof: 'timeline-reconciliation',
        });
        await this.cleanup();
        return this.snapshot();
      }

      let retryStage = manifest.retryStage;
      if (
        manifest.stage === 'failed' &&
        manifest.mediaId === null &&
        retryStage !== 'append-entry'
      ) {
        const oldKeys = Object.values(manifest.idempotencyKeys);
        const createIntent =
          this.dependencies.createIdempotencyKey('create-intent');
        const completeUpload =
          this.dependencies.createIdempotencyKey('complete-upload');
        if (
          oldKeys.includes(createIntent) ||
          oldKeys.includes(completeUpload) ||
          createIntent === completeUpload
        ) {
          throw new PhotoDraftStateError(
            'A fresh upload attempt requires newly generated replay keys.',
          );
        }
        await this.transition({
          ...manifest,
          stage: 'creating-intent',
          retryStage: null,
          cleanupProof: null,
          uploadIntentId: null,
          mediaId: null,
          idempotencyKeys: {
            createIntent,
            completeUpload,
            appendEntry: manifest.idempotencyKeys.appendEntry,
          },
        });
        retryStage = 'create-intent';
      }

      delegatedToNetwork = true;
      return await this.runClaimedFrom(retryStage);
    } finally {
      if (!delegatedToNetwork) this.releaseOperation();
    }
  }

  public async retryCleanup(): Promise<PhotoDraftSnapshot> {
    return this.trackOperation(this.retryCleanupTracked());
  }

  private async retryCleanupTracked(): Promise<PhotoDraftSnapshot> {
    const manifest = this.requireManifest();
    if (this.running || manifest.stage !== 'cleanup-pending') {
      throw new PhotoDraftStateError('Photo cleanup is not currently pending.');
    }
    this.claimOperation();
    try {
      await this.cleanup();
      return this.snapshot();
    } finally {
      this.releaseOperation();
    }
  }

  public async reconcile(
    projections: readonly JournalEntryReadProjection[],
  ): Promise<boolean> {
    return this.trackOperation(this.reconcileTracked(projections));
  }

  private async reconcileTracked(
    projections: readonly JournalEntryReadProjection[],
  ): Promise<boolean> {
    this.claimOperation();
    try {
      const manifest = this.requireManifest();
      const parsed = projections.map((projection) =>
        JournalEntryReadProjectionSchema.parse(projection),
      );
      const matched = parsed.some(
        (projection) =>
          projection.visibility === 'visible' &&
          isExactCanonicalPhoto(projection.entry, manifest),
      );
      if (!matched) return false;
      await this.transition({
        ...manifest,
        stage: 'cleanup-pending',
        retryStage: null,
        cleanupProof: 'timeline-reconciliation',
      });
      await this.cleanup();
      return true;
    } finally {
      this.releaseOperation();
    }
  }

  private requireManifest(): PhotoDraftManifest {
    if (this.manifest === null) {
      throw new PhotoDraftStateError('The photo draft is already complete.');
    }
    return this.manifest;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // UI observers cannot change persistence or network semantics.
      }
    }
  }

  private async transition(value: PhotoDraftManifest): Promise<void> {
    const manifest = parsePhotoDraftManifest(value);
    const expected = this.requireManifest();
    await this.dependencies.storage.save(manifest, expected);
    this.manifest = manifest;
    if (manifest.stage !== 'uploading') this.uploadFraction = 0;
    this.emit();
  }

  private async halt(
    retryStage: PhotoDraftNetworkStage,
    error: unknown,
  ): Promise<never> {
    const manifest = this.requireManifest();
    const outcome =
      this.backgroundObserved ||
      !(error instanceof PhotoDraftOperationError) ||
      error.outcome === 'unknown'
        ? 'unknown'
        : 'failed';
    await this.transition({
      ...manifest,
      stage: outcome,
      retryStage,
      cleanupProof: null,
    });
    throw new PhotoDraftHalted();
  }

  private async perform<T>(
    retryStage: PhotoDraftNetworkStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      if (this.activeController?.signal.aborted) {
        throw new PhotoDraftOperationError(
          'unknown',
          'The photo operation was interrupted in the background.',
        );
      }
      return result;
    } catch (error) {
      return this.halt(retryStage, error);
    }
  }

  private createIntentInput(
    manifest: PhotoDraftManifest,
  ): CreateMediaUploadIntentInput {
    return CreateMediaUploadIntentInputSchema.parse({
      eventId: manifest.eventId,
      byteLength: manifest.byteLength,
      contentSha256: manifest.contentSha256,
      declaredContentType: manifest.declaredContentType,
    });
  }

  private async acquireIntent(
    retryStage: 'create-intent' | 'upload-bytes',
    signal: AbortSignal,
  ): Promise<MediaUploadIntent> {
    const manifest = this.requireManifest();
    const expectedIntentId =
      retryStage === 'upload-bytes' ? manifest.uploadIntentId : null;
    return this.perform(retryStage, async () =>
      validateIntent(
        await this.dependencies.network.createUploadIntent(
          this.createIntentInput(manifest),
          manifest.idempotencyKeys.createIntent,
          signal,
        ),
        manifest,
        expectedIntentId,
      ),
    );
  }

  private async haltBeforeNetworkIfInterrupted(
    retryStage: PhotoDraftNetworkStage,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.backgroundObserved && !signal.aborted) return;
    await this.halt(
      retryStage,
      new PhotoDraftOperationError(
        'unknown',
        'The photo operation was interrupted before network work began.',
      ),
    );
  }

  private claimOperation(): void {
    if (this.running) {
      throw new PhotoDraftStateError(
        'The photo draft is already performing an operation.',
      );
    }
    this.running = true;
  }

  private releaseOperation(): void {
    this.running = false;
    this.backgroundObserved = false;
    this.activeController = null;
  }

  private async runFrom(
    initialStage: PhotoDraftNetworkStage,
  ): Promise<PhotoDraftSnapshot> {
    this.claimOperation();
    return this.trackOperation(this.runClaimedFrom(initialStage));
  }

  private async runClaimedFrom(
    initialStage: PhotoDraftNetworkStage,
  ): Promise<PhotoDraftSnapshot> {
    try {
      if (this.backgroundObserved) {
        const manifest = this.requireManifest();
        const retryStage =
          manifest.stage === 'creating-intent' ? 'create-intent' : initialStage;
        await this.halt(
          retryStage,
          new PhotoDraftOperationError(
            'unknown',
            'The photo operation was interrupted before network work began.',
          ),
        );
      }
      this.activeController = new AbortController();
      const signal = this.activeController.signal;
      let stage = initialStage;
      let transientIntent: MediaUploadIntent | null = null;
      if (stage === 'create-intent') {
        const manifest = this.requireManifest();
        await this.transition({
          ...manifest,
          stage: activeStageFor(stage),
          retryStage: null,
          cleanupProof: null,
          uploadIntentId: null,
          mediaId: null,
        });
        await this.haltBeforeNetworkIfInterrupted('create-intent', signal);
        transientIntent = await this.acquireIntent('create-intent', signal);
        await this.transition({
          ...this.requireManifest(),
          stage: 'uploading',
          uploadIntentId: transientIntent.id,
        });
        stage = 'upload-bytes';
      }

      if (stage === 'upload-bytes') {
        const manifest = this.requireManifest();
        if (manifest.uploadIntentId === null) {
          throw new PhotoDraftStateError(
            'The upload stage is missing its retained intent.',
          );
        }
        if (manifest.stage !== 'uploading') {
          await this.transition({
            ...manifest,
            stage: 'uploading',
            retryStage: null,
            cleanupProof: null,
            mediaId: null,
          });
        }
        await this.haltBeforeNetworkIfInterrupted('upload-bytes', signal);
        const uploadIntent =
          transientIntent ?? (await this.acquireIntent('upload-bytes', signal));
        transientIntent = uploadIntent;
        const uploading = this.requireManifest();
        await this.perform('upload-bytes', async () =>
          this.dependencies.network.uploadBytes({
            draftId: uploading.draftId,
            localUri: uploading.localUri,
            uploadUrl: uploadIntent.uploadUrl,
            contentType: uploading.declaredContentType,
            byteLength: uploading.byteLength,
            contentSha256: uploading.contentSha256,
            signal,
            onProgress: (fraction) => {
              if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
                throw new PhotoDraftOperationError(
                  'unknown',
                  'The upload returned invalid progress.',
                );
              }
              this.uploadFraction = Math.max(this.uploadFraction, fraction);
              this.emit();
            },
          }),
        );
        await this.transition({
          ...this.requireManifest(),
          stage: 'completing-upload',
        });
        stage = 'complete-upload';
      }

      if (stage === 'complete-upload') {
        const manifest = this.requireManifest();
        if (manifest.uploadIntentId === null) {
          throw new PhotoDraftStateError(
            'The completion stage is missing its retained intent.',
          );
        }
        if (manifest.stage !== 'completing-upload') {
          await this.transition({
            ...manifest,
            stage: 'completing-upload',
            retryStage: null,
            cleanupProof: null,
            mediaId: null,
          });
        }
        await this.haltBeforeNetworkIfInterrupted('complete-upload', signal);
        const completing = this.requireManifest();
        const media = await this.perform('complete-upload', async () =>
          validateMedia(
            await this.dependencies.network.completeUpload(
              completing.uploadIntentId!,
              completing.idempotencyKeys.completeUpload,
              signal,
            ),
            completing,
          ),
        );
        await this.transition({
          ...this.requireManifest(),
          stage: 'appending',
          mediaId: media.id,
        });
        stage = 'append-entry';
      }

      if (stage === 'append-entry') {
        const manifest = this.requireManifest();
        if (manifest.mediaId === null || manifest.uploadIntentId === null) {
          throw new PhotoDraftStateError(
            'The append stage is missing retained media identity.',
          );
        }
        if (manifest.stage !== 'appending') {
          await this.transition({
            ...manifest,
            stage: 'appending',
            retryStage: null,
            cleanupProof: null,
          });
        }
        await this.haltBeforeNetworkIfInterrupted('append-entry', signal);
        const appending = this.requireManifest();
        await this.perform('append-entry', async () =>
          validateAppendedPhoto(
            await this.dependencies.network.appendPhoto(
              photoInput(appending),
              appending.idempotencyKeys.appendEntry,
              signal,
            ),
            appending,
          ),
        );
        await this.transition({
          ...this.requireManifest(),
          stage: 'cleanup-pending',
          cleanupProof: 'append-response',
        });
        await this.cleanup();
      }
      return this.snapshot();
    } catch (error) {
      if (error instanceof PhotoDraftHalted) return this.snapshot();
      throw error;
    } finally {
      this.releaseOperation();
    }
  }

  private async cleanup(): Promise<void> {
    const manifest = this.requireManifest();
    if (
      manifest.stage !== 'cleanup-pending' ||
      manifest.cleanupProof === null
    ) {
      throw new PhotoDraftStateError(
        'Photo cleanup requires canonical append evidence.',
      );
    }
    try {
      // File deletion is idempotent and intentionally precedes manifest
      // deletion so a failed cleanup always leaves a durable retry marker.
      await this.dependencies.deletePrivateCopy(
        manifest.localUri,
        manifest.draftId,
      );
      await this.dependencies.storage.deleteManifest(
        manifest.eventId,
        manifest.draftId,
        manifest,
      );
    } catch {
      return;
    }
    this.manifest = null;
    this.uploadFraction = 1;
    this.emit();
  }
}
