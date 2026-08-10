import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import type { HumanConfirmationRecord } from '@psd-eoc/contracts';

import {
  CapabilityEngineError,
  type CapabilityAuditEvent,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type ConsumeHumanConfirmationInput,
  type IdempotencyClaim,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import {
  executeMediaCapability,
  type MediaCapabilityDependencies,
} from './capabilities';
import { ImageValidationError, type SanitizedImage } from './image';
import type {
  CompleteMediaRecord,
  NewMediaUploadIntent,
  PhotoChecksumExportProjection,
  StoredMediaRecord,
  StoredMediaUploadIntent,
} from './model';
import {
  MediaObjectStoreError,
  type MalwareScanStatus,
  type MediaObjectStore,
  type PutSanitizedObjectInput,
} from './object-store';
import { MediaProcessingCapacityError } from './processing-gate';
import type {
  MediaCapabilityStore,
  MediaCapabilityTransaction,
  ResolvedMediaUploadIntent,
  ResolvedReadyMedia,
} from './repository';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  facility: uuid(1),
  otherFacility: uuid(2),
  event: uuid(3),
  otherEvent: uuid(4),
  user: uuid(5),
  session: uuid(6),
  connectivityEpoch: uuid(7),
  intent: uuid(8),
});

const NOW = new Date('2026-08-10T18:00:00.000Z');
const RAW_BYTES = Buffer.from('untrusted-image-bytes');
const RAW_SHA256 = createHash('sha256').update(RAW_BYTES).digest('hex');
const SANITIZED_BYTES = Buffer.from('sanitized-image-bytes');
const SANITIZED_SHA256 = createHash('sha256')
  .update(SANITIZED_BYTES)
  .digest('hex');

interface MemoryIdempotencyRecord {
  readonly id: string;
  readonly requestDigest: string;
  status: 'in-progress' | 'completed';
  resultReference: string | null;
}

interface MemoryState {
  readonly eventFacilities: Map<string, string>;
  readonly intents: Map<string, StoredMediaUploadIntent>;
  readonly records: Map<string, StoredMediaRecord>;
  readonly idempotency: Map<string, MemoryIdempotencyRecord>;
  readonly audits: CapabilityAuditEvent[];
  readonly insertedIntents: NewMediaUploadIntent[];
  readonly completedRecords: CompleteMediaRecord[];
  currentTime: Date;
  nextRecord: number;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    eventFacilities: new Map(state.eventFacilities),
    intents: new Map(state.intents),
    records: new Map(state.records),
    idempotency: new Map(
      [...state.idempotency].map(([key, value]) => [key, { ...value }]),
    ),
    audits: [...state.audits],
    insertedIntents: [...state.insertedIntents],
    completedRecords: [...state.completedRecords],
    currentTime: new Date(state.currentTime),
    nextRecord: state.nextRecord,
  };
}

function idempotencyKey(input: ClaimIdempotencyInput): string {
  return `${input.capabilityId}:${input.principalDigest}:${input.key}`;
}

class MemoryMediaTransaction implements MediaCapabilityTransaction {
  public constructor(private readonly state: MemoryState) {}

  public async readCurrentTime(): Promise<Date> {
    return new Date(this.state.currentTime);
  }

  public async claimIdempotency(
    input: ClaimIdempotencyInput,
  ): Promise<IdempotencyClaim> {
    const key = idempotencyKey(input);
    const existing = this.state.idempotency.get(key);
    if (existing !== undefined) {
      return existing.status === 'completed'
        ? {
            kind: 'completed',
            requestDigest: existing.requestDigest,
            resultReference: existing.resultReference ?? '',
          }
        : { kind: 'in-progress', requestDigest: existing.requestDigest };
    }
    const id = uuid(800 + this.state.nextRecord++);
    this.state.idempotency.set(key, {
      id,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      resultReference: null,
    });
    return { kind: 'new', recordId: id };
  }

  public async completeIdempotency(
    input: CompleteIdempotencyInput,
  ): Promise<void> {
    const record = [...this.state.idempotency.values()].find(
      (candidate) => candidate.id === input.recordId,
    );
    if (record === undefined || record.status !== 'in-progress') {
      throw new Error('Idempotency completion mismatch.');
    }
    record.status = 'completed';
    record.resultReference = input.resultReference;
  }

  public async getHumanConfirmation(): Promise<HumanConfirmationRecord | null> {
    return null;
  }

  public async consumeHumanConfirmation(
    input: ConsumeHumanConfirmationInput,
  ): Promise<boolean> {
    void input;
    return false;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.state.audits.push(event);
  }

  public async resolveEventFacilityId(eventId: string): Promise<string | null> {
    return this.state.eventFacilities.get(eventId) ?? null;
  }

  public async resolveUploadIntent(
    uploadIntentId: string,
    lock: boolean,
  ): Promise<ResolvedMediaUploadIntent | null> {
    void lock;
    const intent = this.state.intents.get(uploadIntentId);
    if (intent === undefined) {
      return null;
    }
    const facilityId = this.state.eventFacilities.get(intent.eventId);
    if (facilityId === undefined) {
      return null;
    }
    return {
      facilityId,
      intent,
      readyRecord: this.state.records.get(uploadIntentId) ?? null,
    };
  }

  public async resolveReadyMedia(
    eventId: string,
    mediaId: string,
  ): Promise<ResolvedReadyMedia | null> {
    const record = this.state.records.get(mediaId);
    if (record === undefined || record.eventId !== eventId) {
      return null;
    }
    const facilityId = this.state.eventFacilities.get(eventId);
    return facilityId === undefined ? null : { facilityId, record };
  }

  public async insertUploadIntent(intent: NewMediaUploadIntent): Promise<void> {
    if (!this.state.eventFacilities.has(intent.eventId)) {
      throw new Error('Missing event.');
    }
    const stored: StoredMediaUploadIntent = {
      id: intent.id,
      eventId: intent.eventId,
      byteLength: intent.byteLength,
      contentSha256: intent.contentSha256,
      declaredContentType: intent.declaredContentType,
      storageKey: intent.storageKey,
      status: 'pending-upload',
      createdAt: intent.createdAt.toISOString(),
      expiresAt: intent.expiresAt.toISOString(),
    };
    this.state.intents.set(intent.id, stored);
    this.state.insertedIntents.push(intent);
  }

  public async completeUpload(input: CompleteMediaRecord): Promise<void> {
    const intent = this.state.intents.get(input.record.uploadIntentId);
    if (intent?.status !== input.expectedIntentStatus) {
      throw new Error('Intent state mismatch.');
    }
    this.state.records.set(input.record.id, input.record);
    this.state.intents.set(intent.id, { ...intent, status: 'completed' });
    this.state.completedRecords.push(input);
  }

  public async listPhotoChecksumExportProjection(
    eventId: string,
  ): Promise<readonly PhotoChecksumExportProjection[]> {
    void eventId;
    return [];
  }
}

class MemoryMediaStore implements MediaCapabilityStore {
  public state: MemoryState;

  public constructor() {
    this.state = {
      eventFacilities: new Map([
        [IDS.event, IDS.facility],
        [IDS.otherEvent, IDS.otherFacility],
      ]),
      intents: new Map(),
      records: new Map(),
      idempotency: new Map(),
      audits: [],
      insertedIntents: [],
      completedRecords: [],
      currentTime: new Date(NOW),
      nextRecord: 0,
    };
  }

  public async transaction<Result>(
    operation: (transaction: MediaCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    const staged = cloneState(this.state);
    const result = await operation(new MemoryMediaTransaction(staged));
    this.state = staged;
    return result;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.state.audits.push(event);
  }
}

interface ObjectStoreCalls {
  readonly uploadKeys: string[];
  readonly scanKeys: string[];
  readonly rawKeys: string[];
  readonly sanitized: PutSanitizedObjectInput[];
  readonly readKeys: string[];
}

function createObjectStore(
  options: Readonly<{
    scanStatus?: MalwareScanStatus;
    rawError?: MediaObjectStoreError;
  }> = {},
): {
  readonly objectStore: MediaObjectStore;
  readonly calls: ObjectStoreCalls;
} {
  const calls: ObjectStoreCalls = {
    uploadKeys: [],
    scanKeys: [],
    rawKeys: [],
    sanitized: [],
    readKeys: [],
  };
  const objectStore: MediaObjectStore = {
    async createRawUploadGrant(input) {
      calls.uploadKeys.push(input.storageKey);
      return {
        method: 'PUT',
        uploadUrl: `https://media.example.test/${input.storageKey}?signature=test`,
        requiredHeaders: { 'content-type': input.contentType },
        byteLength: input.byteLength,
        contentSha256: input.contentSha256,
        expiresInSeconds: input.expiresInSeconds ?? 300,
      };
    },
    async getMalwareScanStatus(storageKey) {
      calls.scanKeys.push(storageKey);
      return options.scanStatus ?? 'clean';
    },
    async readVerifiedRawObject(input) {
      calls.rawKeys.push(input.storageKey);
      if (options.rawError !== undefined) {
        throw options.rawError;
      }
      return {
        bytes: RAW_BYTES,
        byteLength: RAW_BYTES.byteLength,
        contentSha256: RAW_SHA256,
        storedContentType: 'application/octet-stream',
      };
    },
    async putSanitizedObject(input) {
      calls.sanitized.push(input);
      return {
        storageKey: input.storageKey,
        byteLength: input.bytes.byteLength,
        contentSha256: createHash('sha256').update(input.bytes).digest('hex'),
        contentType: input.contentType,
      };
    },
    async createPrivateReadGrant(input) {
      calls.readKeys.push(input.storageKey);
      return {
        readUrl: `https://media.example.test/${input.storageKey}?signature=${calls.readKeys.length}`,
        expiresInSeconds: input.expiresInSeconds ?? 60,
      };
    },
  };
  return { objectStore, calls };
}

function sanitizedImage(): SanitizedImage {
  return {
    detectedContentType: 'image/jpeg',
    sanitizedContentType: 'image/jpeg',
    sanitizedBytes: SANITIZED_BYTES,
    sanitizedByteLength: SANITIZED_BYTES.byteLength,
    sanitizedContentSha256: SANITIZED_SHA256,
    width: 4,
    height: 3,
    exifStripped: true,
    structuralContentDisarm: {
      kind: 'structural-content-disarm',
      result: 'passed',
      checks: {
        sourceFullyDecoded: true,
        sourceSinglePage: true,
        sourcePixelCountBounded: true,
        orientationNormalized: true,
        pixelsReencoded: true,
        outputMagicBytesMatched: true,
        outputContainerMetadataAbsent: true,
        outputDecoderMetadataAbsent: true,
        outputSinglePage: true,
        outputPixelCountBounded: true,
        outputFullyDecoded: true,
      },
    },
  };
}

function dependencies(
  objectStore: MediaObjectStore,
  sanitizeImage: MediaCapabilityDependencies['sanitizeImage'] = async () =>
    sanitizedImage(),
): MediaCapabilityDependencies {
  return {
    objectStore,
    createId: () => IDS.intent,
    sanitizeImage,
  };
}

let requestSequence = 100;

function humanInvocation(
  input: Readonly<{
    mutation: boolean;
    idempotencyKey?: string;
    facilityId?: string;
  }>,
): TrustedCapabilityInvocation {
  requestSequence += 1;
  return {
    actor: { kind: 'human', userId: IDS.user, sessionId: IDS.session },
    source: 'web',
    scope: {
      facilityScope: {
        kind: 'facilities',
        facilityIds: [input.facilityId ?? IDS.facility],
      },
    },
    requestId: uuid(requestSequence),
    serverTime: new Date(NOW),
    connectivityEpochId: IDS.connectivityEpoch,
    mutation: input.mutation
      ? {
          idempotencyKey:
            input.idempotencyKey ?? `media-request-${requestSequence}`,
          humanConfirmationId: null,
          transport: {
            kind: 'web-interactive',
            method: 'POST',
            interaction: 'explicit-user-submit',
            csrfVerified: true,
          },
        }
      : null,
  };
}

function seedPendingIntent(store: MemoryMediaStore): void {
  store.state.intents.set(IDS.intent, {
    id: IDS.intent,
    eventId: IDS.event,
    byteLength: RAW_BYTES.byteLength,
    contentSha256: RAW_SHA256,
    declaredContentType: 'image/jpeg',
    storageKey: `quarantine/${IDS.event}/${IDS.intent}`,
    status: 'pending-upload',
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
  });
}

async function expectEngineError(
  operation: Promise<unknown>,
): Promise<CapabilityEngineError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityEngineError);
    return error as CapabilityEngineError;
  }
  throw new Error('Expected the capability to reject.');
}

describe('media capabilities', () => {
  test('creates one exact quarantine grant and scopes idempotent replay', async () => {
    const store = new MemoryMediaStore();
    const object = createObjectStore();
    const invocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'create-photo-0001',
    });
    const input = {
      eventId: IDS.event,
      byteLength: RAW_BYTES.byteLength,
      contentSha256: RAW_SHA256,
      declaredContentType: 'image/jpeg',
    };

    const created = await executeMediaCapability(
      'create-media-upload-intent',
      input,
      invocation,
      store,
      dependencies(object.objectStore),
    );
    expect(created).toMatchObject({
      id: IDS.intent,
      eventId: IDS.event,
      byteLength: RAW_BYTES.byteLength,
      contentSha256: RAW_SHA256,
      declaredContentType: 'image/jpeg',
      uploadMethod: 'PUT',
      status: 'pending-upload',
    });
    expect(store.state.insertedIntents).toHaveLength(1);
    expect(object.calls.uploadKeys).toEqual([
      `quarantine/${IDS.event}/${IDS.intent}`,
    ]);

    const replay = await executeMediaCapability(
      'create-media-upload-intent',
      input,
      { ...invocation, requestId: uuid(300) },
      store,
      dependencies(object.objectStore),
    );
    expect(replay.id).toBe(created.id);
    expect(store.state.insertedIntents).toHaveLength(1);
    expect(object.calls.uploadKeys).toHaveLength(2);

    const denied = await expectEngineError(
      executeMediaCapability(
        'create-media-upload-intent',
        input,
        {
          ...invocation,
          requestId: uuid(301),
          scope: {
            facilityScope: {
              kind: 'facilities',
              facilityIds: [IDS.otherFacility],
            },
          },
        },
        store,
        dependencies(object.objectStore),
      ),
    );
    expect(denied).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
    });
    expect(object.calls.uploadKeys).toHaveLength(2);

    const pending = store.state.intents.get(IDS.intent);
    if (pending === undefined) {
      throw new Error('Expected the persisted upload intent.');
    }
    store.state.intents.set(IDS.intent, { ...pending, status: 'completed' });
    const completedReplay = await expectEngineError(
      executeMediaCapability(
        'create-media-upload-intent',
        input,
        { ...invocation, requestId: uuid(304) },
        store,
        dependencies(object.objectStore),
      ),
    );
    expect(completedReplay).toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(object.calls.uploadKeys).toHaveLength(2);
  });

  const rejectedScanStatuses = [
    ['pending', 409, true],
    ['threats', 400, false],
    ['unsupported', 503, true],
    ['access-denied', 503, true],
    ['failed', 503, true],
  ] as const;
  for (const [scanStatus, status, retryable] of rejectedScanStatuses) {
    test(`fails closed when the authoritative malware result is ${scanStatus}`, async () => {
      const store = new MemoryMediaStore();
      seedPendingIntent(store);
      const object = createObjectStore({ scanStatus });
      const error = await expectEngineError(
        executeMediaCapability(
          'complete-media-upload',
          { uploadIntentId: IDS.intent },
          humanInvocation({ mutation: true }),
          store,
          dependencies(object.objectStore),
        ),
      );
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
      expect(object.calls.scanKeys).toHaveLength(1);
      expect(object.calls.rawKeys).toHaveLength(0);
      expect(object.calls.sanitized).toHaveLength(0);
      expect(store.state.completedRecords).toHaveLength(0);
    });
  }

  test('persists clean, EXIF-free checksum evidence and replays without reprocessing', async () => {
    const store = new MemoryMediaStore();
    seedPendingIntent(store);
    const object = createObjectStore({ scanStatus: 'clean' });
    let sanitizeCalls = 0;
    const deps = dependencies(object.objectStore, async () => {
      sanitizeCalls += 1;
      return sanitizedImage();
    });
    const invocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'complete-photo-0001',
    });

    const completed = await executeMediaCapability(
      'complete-media-upload',
      { uploadIntentId: IDS.intent },
      invocation,
      store,
      deps,
    );
    expect(completed).toEqual({
      id: IDS.intent,
      uploadIntentId: IDS.intent,
      eventId: IDS.event,
      status: 'ready',
      detectedContentType: 'image/jpeg',
      sanitizedByteLength: SANITIZED_BYTES.byteLength,
      sanitizedContentSha256: SANITIZED_SHA256,
      malwareScan: 'clean',
      exifStripped: true,
      createdAt: NOW.toISOString(),
    });
    expect(store.state.completedRecords).toHaveLength(1);
    expect(store.state.completedRecords[0]?.record).toMatchObject({
      sanitizedContentSha256: SANITIZED_SHA256,
      malwareScan: 'clean',
      exifStripped: true,
      storageKey: `ready/${IDS.event}/${IDS.intent}`,
    });
    expect(object.calls.sanitized[0]?.contentType).toBe('image/jpeg');

    const replay = await executeMediaCapability(
      'complete-media-upload',
      { uploadIntentId: IDS.intent },
      { ...invocation, requestId: uuid(302) },
      store,
      deps,
    );
    expect(replay).toEqual(completed);
    expect(sanitizeCalls).toBe(1);
    expect(object.calls.sanitized).toHaveLength(1);

    const deniedReplay = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        {
          ...invocation,
          requestId: uuid(303),
          scope: {
            facilityScope: {
              kind: 'facilities',
              facilityIds: [IDS.otherFacility],
            },
          },
        },
        store,
        deps,
      ),
    );
    expect(deniedReplay.code).toBe('FORBIDDEN');
    expect(sanitizeCalls).toBe(1);
  });

  test('returns bounded user-safe failures for corrupt objects and malformed images', async () => {
    const corruptStore = new MemoryMediaStore();
    seedPendingIntent(corruptStore);
    const corruptObject = createObjectStore({
      rawError: new MediaObjectStoreError(
        'CHECKSUM_MISMATCH',
        'provider detail must not escape',
      ),
    });
    const corruptError = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        humanInvocation({ mutation: true }),
        corruptStore,
        dependencies(corruptObject.objectStore),
      ),
    );
    expect(corruptError).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(corruptError.message).not.toContain('provider detail');

    const malformedStore = new MemoryMediaStore();
    seedPendingIntent(malformedStore);
    const malformedObject = createObjectStore();
    const malformedError = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        humanInvocation({ mutation: true }),
        malformedStore,
        dependencies(malformedObject.objectStore, async () => {
          throw new ImageValidationError(
            'MALFORMED_IMAGE',
            'The image could not be safely processed. Choose a different image and try again.',
          );
        }),
      ),
    );
    expect(malformedError).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
    });
    expect(malformedError.message).toContain('safely processed');
    expect(malformedObject.calls.sanitized).toHaveLength(0);
  });

  test('rejects saturated photo processing before raw bytes enter memory', async () => {
    const store = new MemoryMediaStore();
    seedPendingIntent(store);
    const object = createObjectStore();
    const error = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        humanInvocation({ mutation: true }),
        store,
        {
          ...dependencies(object.objectStore),
          processingGate: {
            async run() {
              throw new MediaProcessingCapacityError();
            },
          },
        },
      ),
    );

    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 503,
      retryable: true,
    });
    expect(object.calls.scanKeys).toHaveLength(1);
    expect(object.calls.rawKeys).toHaveLength(0);
    expect(object.calls.sanitized).toHaveLength(0);
  });

  test('authorizes every private read against the exact event and facility', async () => {
    const store = new MemoryMediaStore();
    seedPendingIntent(store);
    const record: StoredMediaRecord = {
      id: IDS.intent,
      uploadIntentId: IDS.intent,
      eventId: IDS.event,
      status: 'ready',
      detectedContentType: 'image/jpeg',
      sanitizedByteLength: SANITIZED_BYTES.byteLength,
      sanitizedContentSha256: SANITIZED_SHA256,
      malwareScan: 'clean',
      exifStripped: true,
      createdAt: NOW.toISOString(),
      storageKey: `ready/${IDS.event}/${IDS.intent}`,
    };
    store.state.records.set(record.id, record);
    const object = createObjectStore();
    const deps = dependencies(object.objectStore);

    const first = await executeMediaCapability(
      'get-media-read-grant',
      { eventId: IDS.event, mediaId: IDS.intent },
      humanInvocation({ mutation: false }),
      store,
      deps,
    );
    const second = await executeMediaCapability(
      'get-media-read-grant',
      { eventId: IDS.event, mediaId: IDS.intent },
      humanInvocation({ mutation: false }),
      store,
      deps,
    );
    expect(first.readUrl).not.toBe(second.readUrl);
    expect(Date.parse(first.expiresAt) - Date.parse(first.issuedAt)).toBe(
      120_000,
    );
    expect(object.calls.readKeys).toEqual([
      record.storageKey,
      record.storageKey,
    ]);

    const wrongEvent = await expectEngineError(
      executeMediaCapability(
        'get-media-read-grant',
        { eventId: IDS.otherEvent, mediaId: IDS.intent },
        humanInvocation({ mutation: false, facilityId: IDS.otherFacility }),
        store,
        deps,
      ),
    );
    expect(wrongEvent.code).toBe('NOT_FOUND');

    const wrongFacility = await expectEngineError(
      executeMediaCapability(
        'get-media-read-grant',
        { eventId: IDS.event, mediaId: IDS.intent },
        humanInvocation({ mutation: false, facilityId: IDS.otherFacility }),
        store,
        deps,
      ),
    );
    expect(wrongFacility).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
    });
    expect(object.calls.readKeys).toHaveLength(2);
  });
});
