import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import type { HumanConfirmationRecord } from '@psd-eoc/contracts';

import {
  CapabilityEngineError,
  digestCapabilityValue,
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
import { TerminalMediaImageRejectionError } from './errors';
import {
  ImageValidationError,
  mapSharpFailure,
  type SanitizedImage,
} from './image';
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
import {
  createMediaProcessingGate,
  createMediaProviderGate,
} from './processing-gate';
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
  status: 'in-progress' | 'completed' | 'failed';
  completedAt: Date | null;
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
  public newlyClaimedIdempotencyRecordId: string | null = null;

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
      switch (existing.status) {
        case 'completed':
          return {
            kind: 'completed',
            requestDigest: existing.requestDigest,
            resultReference: existing.resultReference ?? '',
          };
        case 'failed':
          return {
            kind: 'failed',
            requestDigest: existing.requestDigest,
            resultReference: existing.resultReference ?? '',
          };
        case 'in-progress':
          return {
            kind: 'in-progress',
            requestDigest: existing.requestDigest,
          };
      }
    }
    const id = uuid(800 + this.state.nextRecord++);
    this.state.idempotency.set(key, {
      id,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      completedAt: null,
      resultReference: null,
    });
    this.newlyClaimedIdempotencyRecordId = id;
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
    record.completedAt = new Date(this.state.currentTime);
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
    const transaction = new MemoryMediaTransaction(staged);
    try {
      const result = await operation(transaction);
      this.state = staged;
      return result;
    } catch (error) {
      if (!(error instanceof TerminalMediaImageRejectionError)) {
        throw error;
      }
      const intent = staged.intents.get(error.uploadIntentId);
      const idempotencyRecord = [...staged.idempotency.values()].find(
        (candidate) =>
          candidate.id === transaction.newlyClaimedIdempotencyRecordId,
      );
      if (
        intent === undefined ||
        intent.eventId !== error.eventId ||
        intent.status !== 'pending-upload' ||
        idempotencyRecord === undefined ||
        idempotencyRecord.status !== 'in-progress'
      ) {
        throw new Error('Terminal image rejection persistence mismatch.');
      }
      staged.intents.set(intent.id, { ...intent, status: 'rejected' });
      idempotencyRecord.status = 'failed';
      idempotencyRecord.completedAt = new Date(staged.currentTime);
      idempotencyRecord.resultReference = `terminal-image-rejection:${error.eventId}:${error.uploadIntentId}`;
      this.state = staged;
      throw error;
    }
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
        requiredHeaders: {
          'content-type': input.contentType,
          'if-none-match': '*',
        },
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

async function settleBeforeProviderRelease<Result>(
  operation: Promise<Result>,
  description: string,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(`${description} queued behind saturated provider work.`),
      );
    }, 1_000);
    void operation.then(
      (result) => {
        clearTimeout(deadline);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        reject(error);
      },
    );
  });
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
    expect(store.state.insertedIntents[0]).toMatchObject({
      facilityId: IDS.facility,
      budgetPrincipal: {
        kind: 'human',
        userId: IDS.user,
        digest: digestCapabilityValue({ kind: 'human', userId: IDS.user }),
      },
    });
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

  test('shares fail-fast provider admission across creation, replay, completion, and reads', async () => {
    const object = createObjectStore();
    const providerGate = createMediaProviderGate(2);
    let blockUploadGrants = false;
    let blockedProviderEntries = 0;
    let announceAtCapacity: (() => void) | undefined;
    const atCapacity = new Promise<void>((resolve) => {
      announceAtCapacity = resolve;
    });
    let releaseProviders: (() => void) | undefined;
    const providersReleased = new Promise<void>((resolve) => {
      releaseProviders = resolve;
    });
    const blockingObjectStore: MediaObjectStore = {
      async createRawUploadGrant(input) {
        const grant = await object.objectStore.createRawUploadGrant(input);
        if (blockUploadGrants) {
          blockedProviderEntries += 1;
          if (blockedProviderEntries === 2) {
            announceAtCapacity?.();
          }
          await providersReleased;
        }
        return grant;
      },
      getMalwareScanStatus: (storageKey) =>
        object.objectStore.getMalwareScanStatus(storageKey),
      readVerifiedRawObject: (input) =>
        object.objectStore.readVerifiedRawObject(input),
      putSanitizedObject: (input) =>
        object.objectStore.putSanitizedObject(input),
      createPrivateReadGrant: (input) =>
        object.objectStore.createPrivateReadGrant(input),
    };
    const deps: MediaCapabilityDependencies = {
      ...dependencies(blockingObjectStore),
      processingGate: createMediaProcessingGate(1),
      providerGate,
    };
    const createInput = {
      eventId: IDS.event,
      byteLength: RAW_BYTES.byteLength,
      contentSha256: RAW_SHA256,
      declaredContentType: 'image/jpeg',
    };
    const replayStore = new MemoryMediaStore();
    const replayInvocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'provider-capacity-replay',
    });
    await executeMediaCapability(
      'create-media-upload-intent',
      createInput,
      replayInvocation,
      replayStore,
      deps,
    );

    const readStore = new MemoryMediaStore();
    const completeStore = new MemoryMediaStore();
    seedPendingIntent(completeStore);
    const readyRecord: StoredMediaRecord = {
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
    readStore.state.records.set(readyRecord.id, readyRecord);

    blockUploadGrants = true;
    const firstHolderStore = new MemoryMediaStore();
    const secondHolderStore = new MemoryMediaStore();
    const holders = Promise.all([
      executeMediaCapability(
        'create-media-upload-intent',
        createInput,
        humanInvocation({
          mutation: true,
          idempotencyKey: 'provider-capacity-holder-first',
        }),
        firstHolderStore,
        deps,
      ),
      executeMediaCapability(
        'create-media-upload-intent',
        createInput,
        humanInvocation({
          mutation: true,
          idempotencyKey: 'provider-capacity-holder-second',
        }),
        secondHolderStore,
        deps,
      ),
    ]);
    await atCapacity;

    const saturatedStore = new MemoryMediaStore();
    const saturatedInvocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'provider-capacity-saturated-create',
    });
    const replayWhileSaturated = {
      ...replayInvocation,
      requestId: uuid(307),
    };
    const readWhileSaturated = humanInvocation({ mutation: false });
    const completeWhileSaturated = humanInvocation({
      mutation: true,
      idempotencyKey: 'provider-capacity-saturated-complete',
    });
    let saturatedCreateError: CapabilityEngineError;
    let saturatedReplayError: CapabilityEngineError;
    let saturatedReadError: CapabilityEngineError;
    let saturatedCompleteError: CapabilityEngineError;
    try {
      saturatedCreateError = await settleBeforeProviderRelease(
        expectEngineError(
          executeMediaCapability(
            'create-media-upload-intent',
            createInput,
            saturatedInvocation,
            saturatedStore,
            deps,
          ),
        ),
        'A new upload grant',
      );
      saturatedReplayError = await settleBeforeProviderRelease(
        expectEngineError(
          executeMediaCapability(
            'create-media-upload-intent',
            createInput,
            replayWhileSaturated,
            replayStore,
            deps,
          ),
        ),
        'An upload-grant replay',
      );
      saturatedReadError = await settleBeforeProviderRelease(
        expectEngineError(
          executeMediaCapability(
            'get-media-read-grant',
            { eventId: IDS.event, mediaId: IDS.intent },
            readWhileSaturated,
            readStore,
            deps,
          ),
        ),
        'A private read grant',
      );
      saturatedCompleteError = await settleBeforeProviderRelease(
        expectEngineError(
          executeMediaCapability(
            'complete-media-upload',
            { uploadIntentId: IDS.intent },
            completeWhileSaturated,
            completeStore,
            deps,
          ),
        ),
        'A completed upload safety scan',
      );
    } finally {
      releaseProviders?.();
    }
    await holders;

    for (const error of [
      saturatedCreateError,
      saturatedReplayError,
      saturatedReadError,
      saturatedCompleteError,
    ]) {
      expect(error).toMatchObject({
        code: 'INTERNAL_ERROR',
        reasonCode: 'PERSISTENCE_CONFLICT',
        status: 503,
        retryable: true,
      });
    }
    expect(blockedProviderEntries).toBe(2);
    expect(object.calls.uploadKeys).toHaveLength(3);
    expect(object.calls.readKeys).toHaveLength(0);
    expect(object.calls.scanKeys).toHaveLength(0);
    expect(object.calls.rawKeys).toHaveLength(0);
    expect(object.calls.sanitized).toHaveLength(0);
    expect(saturatedStore.state.insertedIntents).toHaveLength(0);
    expect(saturatedStore.state.idempotency.size).toBe(0);
    expect(saturatedStore.state.audits).toEqual([
      expect.objectContaining({
        requestId: saturatedInvocation.requestId,
        outcome: 'failure',
      }),
    ]);
    expect([...replayStore.state.idempotency.values()]).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(replayStore.state.audits).toEqual([
      expect.objectContaining({ outcome: 'success' }),
      expect.objectContaining({
        requestId: replayWhileSaturated.requestId,
        outcome: 'failure',
      }),
    ]);
    expect(readStore.state.audits).toEqual([
      expect.objectContaining({
        requestId: readWhileSaturated.requestId,
        outcome: 'failure',
      }),
    ]);
    expect(completeStore.state.idempotency.size).toBe(0);
    expect(completeStore.state.audits).toEqual([
      expect.objectContaining({
        requestId: completeWhileSaturated.requestId,
        outcome: 'failure',
      }),
    ]);

    await expect(
      executeMediaCapability(
        'create-media-upload-intent',
        createInput,
        { ...saturatedInvocation, requestId: uuid(308) },
        saturatedStore,
        deps,
      ),
    ).resolves.toMatchObject({ status: 'pending-upload' });
    await expect(
      executeMediaCapability(
        'create-media-upload-intent',
        createInput,
        { ...replayInvocation, requestId: uuid(309) },
        replayStore,
        deps,
      ),
    ).resolves.toMatchObject({ id: IDS.intent });
    await expect(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        { ...completeWhileSaturated, requestId: uuid(310) },
        completeStore,
        deps,
      ),
    ).resolves.toMatchObject({ status: 'ready' });
    await expect(
      executeMediaCapability(
        'get-media-read-grant',
        { eventId: IDS.event, mediaId: IDS.intent },
        { ...readWhileSaturated, requestId: uuid(311) },
        readStore,
        deps,
      ),
    ).resolves.toMatchObject({ mediaId: IDS.intent });
    expect(object.calls.uploadKeys).toHaveLength(5);
    expect(object.calls.readKeys).toHaveLength(1);
    expect(object.calls.scanKeys).toHaveLength(1);
    expect(object.calls.rawKeys).toHaveLength(1);
    expect(object.calls.sanitized).toHaveLength(1);
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

  const terminalProviderFailures = [
    {
      name: 'malware threats',
      options: { scanStatus: 'threats' as const },
      expectedScanCalls: 1,
      expectedRawCalls: 0,
    },
    {
      name: 'raw checksum mismatch',
      options: {
        rawError: new MediaObjectStoreError(
          'CHECKSUM_MISMATCH',
          'synthetic provider detail',
        ),
      },
      expectedScanCalls: 1,
      expectedRawCalls: 1,
    },
  ] as const;
  for (const failure of terminalProviderFailures) {
    test(`terminalizes ${failure.name} before a fresh key can repeat provider work`, async () => {
      const store = new MemoryMediaStore();
      seedPendingIntent(store);
      const object = createObjectStore(failure.options);
      let sanitizeCalls = 0;
      const deps = dependencies(object.objectStore, async () => {
        sanitizeCalls += 1;
        return sanitizedImage();
      });

      const firstError = await expectEngineError(
        executeMediaCapability(
          'complete-media-upload',
          { uploadIntentId: IDS.intent },
          humanInvocation({
            mutation: true,
            idempotencyKey: `terminal-provider-first-${failure.name.replaceAll(' ', '-')}`,
          }),
          store,
          deps,
        ),
      );
      const laterError = await expectEngineError(
        executeMediaCapability(
          'complete-media-upload',
          { uploadIntentId: IDS.intent },
          humanInvocation({
            mutation: true,
            idempotencyKey: `terminal-provider-later-${failure.name.replaceAll(' ', '-')}`,
          }),
          store,
          deps,
        ),
      );

      expect(firstError).toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        retryable: false,
      });
      expect(laterError).toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        retryable: false,
      });
      expect(store.state.intents.get(IDS.intent)?.status).toBe('rejected');
      expect([...store.state.idempotency.values()]).toEqual([
        expect.objectContaining({
          status: 'failed',
          resultReference: `terminal-image-rejection:${IDS.event}:${IDS.intent}`,
        }),
      ]);
      expect(object.calls.scanKeys).toHaveLength(failure.expectedScanCalls);
      expect(object.calls.rawKeys).toHaveLength(failure.expectedRawCalls);
      expect(sanitizeCalls).toBe(0);
      expect(object.calls.sanitized).toHaveLength(0);
      expect(store.state.audits).toHaveLength(2);
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
    expect(malformedStore.state.intents.get(IDS.intent)?.status).toBe(
      'rejected',
    );
  });

  test('keeps sanitized provider integrity failures retryable without rejecting the intent', async () => {
    const store = new MemoryMediaStore();
    seedPendingIntent(store);
    const object = createObjectStore();
    const providerDetail =
      'Synthetic S3 sanitized checksum acknowledgement mismatch.';
    const failingObjectStore: MediaObjectStore = {
      ...object.objectStore,
      async putSanitizedObject(input) {
        await object.objectStore.putSanitizedObject(input);
        throw new MediaObjectStoreError('STORAGE_UNAVAILABLE', providerDetail);
      },
    };
    const invocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'sanitized-provider-integrity-failure',
    });

    const error = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        invocation,
        store,
        dependencies(failingObjectStore),
      ),
    );

    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 503,
      retryable: true,
    });
    expect(error.message).not.toContain(providerDetail);
    expect(object.calls.sanitized).toHaveLength(1);
    expect(store.state.intents.get(IDS.intent)?.status).toBe('pending-upload');
    expect(store.state.completedRecords).toHaveLength(0);
    expect(store.state.idempotency.size).toBe(0);
    expect(store.state.audits).toEqual([
      expect.objectContaining({
        requestId: invocation.requestId,
        outcome: 'failure',
      }),
    ]);
  });

  test('keeps Sharp timeouts retryable without terminalizing valid bytes', async () => {
    const store = new MemoryMediaStore();
    seedPendingIntent(store);
    const object = createObjectStore();
    const nativeDetail = 'Synthetic Sharp operation timeout native detail.';
    const invocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'sharp-operation-timeout',
    });

    const error = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        invocation,
        store,
        dependencies(object.objectStore, async () => {
          throw mapSharpFailure(new Error(nativeDetail), 'image/jpeg');
        }),
      ),
    );

    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 503,
      retryable: true,
    });
    expect(error.message).not.toContain(nativeDetail);
    expect(object.calls.sanitized).toHaveLength(0);
    expect(store.state.intents.get(IDS.intent)?.status).toBe('pending-upload');
    expect(store.state.completedRecords).toHaveLength(0);
    expect(store.state.idempotency.size).toBe(0);
    expect(store.state.audits).toEqual([
      expect.objectContaining({
        requestId: invocation.requestId,
        outcome: 'failure',
      }),
    ]);
  });

  test('durably rejects a malformed intent and terminalizes its exact idempotency claim', async () => {
    const store = new MemoryMediaStore();
    seedPendingIntent(store);
    const object = createObjectStore();
    let sanitizeCalls = 0;
    const deps = dependencies(object.objectStore, async () => {
      sanitizeCalls += 1;
      throw new ImageValidationError(
        'MALFORMED_IMAGE',
        'The image could not be safely processed. Choose a different image and try again.',
      );
    });
    const firstInvocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'reject-malformed-photo-first',
    });

    const firstError = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        firstInvocation,
        store,
        deps,
      ),
    );
    const sameKeyError = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        { ...firstInvocation, requestId: uuid(305) },
        store,
        deps,
      ),
    );
    const newKeyInvocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'reject-malformed-photo-second',
    });
    const newKeyError = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        newKeyInvocation,
        store,
        deps,
      ),
    );

    expect(firstError).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
    });
    expect(sameKeyError).toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'IDEMPOTENCY_PREVIOUSLY_FAILED',
      status: 409,
      retryable: false,
    });
    expect(newKeyError).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
    });
    expect(object.calls.scanKeys).toHaveLength(1);
    expect(object.calls.rawKeys).toHaveLength(1);
    expect(sanitizeCalls).toBe(1);
    expect(object.calls.sanitized).toHaveLength(0);
    expect(store.state.completedRecords).toHaveLength(0);
    expect(store.state.intents.get(IDS.intent)?.status).toBe('rejected');
    expect([...store.state.idempotency.values()]).toEqual([
      expect.objectContaining({
        status: 'failed',
        completedAt: NOW,
        resultReference: `terminal-image-rejection:${IDS.event}:${IDS.intent}`,
      }),
    ]);
    expect(store.state.audits).toHaveLength(3);
    expect(store.state.audits.map((audit) => audit.requestId)).toEqual([
      firstInvocation.requestId,
      uuid(305),
      newKeyInvocation.requestId,
    ]);
    expect(
      store.state.audits.every((audit) => audit.outcome === 'failure'),
    ).toBe(true);
  });

  test('fails a saturated concurrent completion before provider work and preserves retryable idempotency', async () => {
    const firstStore = new MemoryMediaStore();
    const saturatedStore = new MemoryMediaStore();
    seedPendingIntent(firstStore);
    seedPendingIntent(saturatedStore);
    const object = createObjectStore();
    const processingGate = createMediaProcessingGate(1);
    let announceScanEntered: (() => void) | undefined;
    const scanEntered = new Promise<void>((resolve) => {
      announceScanEntered = resolve;
    });
    let releaseScan: (() => void) | undefined;
    const scanRelease = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const blockingObjectStore: MediaObjectStore = {
      createRawUploadGrant: (input) =>
        object.objectStore.createRawUploadGrant(input),
      async getMalwareScanStatus(storageKey) {
        const status =
          await object.objectStore.getMalwareScanStatus(storageKey);
        announceScanEntered?.();
        await scanRelease;
        return status;
      },
      readVerifiedRawObject: (input) =>
        object.objectStore.readVerifiedRawObject(input),
      putSanitizedObject: (input) =>
        object.objectStore.putSanitizedObject(input),
      createPrivateReadGrant: (input) =>
        object.objectStore.createPrivateReadGrant(input),
    };
    let sanitizeCalls = 0;
    const deps: MediaCapabilityDependencies = {
      ...dependencies(blockingObjectStore, async () => {
        sanitizeCalls += 1;
        return sanitizedImage();
      }),
      processingGate,
    };
    const firstInvocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'processing-capacity-first',
    });
    const saturatedInvocation = humanInvocation({
      mutation: true,
      idempotencyKey: 'processing-capacity-saturated',
    });

    const first = executeMediaCapability(
      'complete-media-upload',
      { uploadIntentId: IDS.intent },
      firstInvocation,
      firstStore,
      deps,
    );
    await scanEntered;

    const saturatedError = await expectEngineError(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        saturatedInvocation,
        saturatedStore,
        deps,
      ),
    );

    expect(saturatedError).toMatchObject({
      code: 'INTERNAL_ERROR',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 503,
      retryable: true,
    });
    expect(object.calls.scanKeys).toHaveLength(1);
    expect(object.calls.rawKeys).toHaveLength(0);
    expect(sanitizeCalls).toBe(0);
    expect(object.calls.sanitized).toHaveLength(0);
    expect(saturatedStore.state.idempotency.size).toBe(0);
    expect(saturatedStore.state.audits).toEqual([
      expect.objectContaining({
        requestId: saturatedInvocation.requestId,
        outcome: 'failure',
        reasonCode: 'PERSISTENCE_CONFLICT',
      }),
    ]);

    releaseScan?.();
    await expect(first).resolves.toMatchObject({ status: 'ready' });
    const retryInvocation = {
      ...saturatedInvocation,
      requestId: uuid(306),
    };
    await expect(
      executeMediaCapability(
        'complete-media-upload',
        { uploadIntentId: IDS.intent },
        retryInvocation,
        saturatedStore,
        deps,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect([...saturatedStore.state.idempotency.values()]).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(saturatedStore.state.audits).toEqual([
      expect.objectContaining({
        requestId: saturatedInvocation.requestId,
        outcome: 'failure',
      }),
      expect.objectContaining({
        requestId: retryInvocation.requestId,
        outcome: 'success',
      }),
    ]);
    expect(object.calls.scanKeys).toHaveLength(2);
    expect(object.calls.rawKeys).toHaveLength(2);
    expect(sanitizeCalls).toBe(2);
    expect(object.calls.sanitized).toHaveLength(2);
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
