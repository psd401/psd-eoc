import { describe, expect, test } from 'bun:test';
import type {
  CreateMediaUploadIntentInput,
  JournalEntry,
  JournalEntryInput,
  JournalEntryReadProjection,
  MediaRecord,
  MediaUploadIntent,
} from '@psd-eoc/contracts';

import {
  PhotoDraftController,
  PhotoDraftOperationError,
  PhotoDraftStateError,
  parsePhotoDraftManifest,
  type CreatePhotoDraftInput,
  type PhotoDraftDependencies,
  type PhotoDraftIdempotencyPurpose,
  type PhotoDraftManifest,
  type PhotoDraftNetwork,
  type PhotoDraftStorage,
  type PhotoDraftUploadInput,
} from './photo-draft';

const ids = {
  draft: '00000000-0000-4000-8000-000000000201',
  event: '00000000-0000-4000-8000-000000000202',
  otherEvent: '00000000-0000-4000-8000-000000000203',
  session: '00000000-0000-4000-8000-000000000204',
  otherSession: '00000000-0000-4000-8000-000000000205',
  user: '00000000-0000-4000-8000-000000000206',
  intent: '00000000-0000-4000-8000-000000000207',
  freshIntent: '00000000-0000-4000-8000-000000000210',
  media: '00000000-0000-4000-8000-000000000208',
  entry: '00000000-0000-4000-8000-000000000209',
} as const;

const KEYS = Object.freeze({
  createIntent: 'photo-create-intent-key-0001',
  completeUpload: 'photo-complete-upload-key-0001',
  appendEntry: 'photo-append-entry-key-0001',
});

const FRESH_KEYS = Object.freeze({
  createIntent: 'photo-create-intent-key-0002',
  completeUpload: 'photo-complete-upload-key-0002',
  appendEntry: KEYS.appendEntry,
});

const CREATE_INPUT: CreatePhotoDraftInput = Object.freeze({
  draftId: ids.draft,
  eventId: ids.event,
  sessionId: ids.session,
  localUri: 'file:///private/psd-eoc/photo.private-photo',
  byteLength: 1_024,
  contentSha256: 'a'.repeat(64),
  declaredContentType: 'image/jpeg',
  altText: 'Synthetic staff member beside the north entrance',
  caption: 'Synthetic exercise image',
});

function uploadIntent(
  overrides: Partial<MediaUploadIntent> = {},
): MediaUploadIntent {
  return {
    id: ids.intent,
    eventId: ids.event,
    byteLength: CREATE_INPUT.byteLength,
    contentSha256: CREATE_INPUT.contentSha256,
    declaredContentType: CREATE_INPUT.declaredContentType,
    uploadMethod: 'PUT',
    uploadUrl: 'https://uploads.invalid/synthetic-presigned-secret',
    status: 'pending-upload',
    createdAt: '2026-08-11T20:00:00.000Z',
    expiresAt: '2026-08-11T20:15:00.000Z',
    ...overrides,
  };
}

function mediaRecord(uploadIntentId: string = ids.intent): MediaRecord {
  return {
    id: ids.media,
    uploadIntentId,
    eventId: ids.event,
    status: 'ready',
    detectedContentType: 'image/jpeg',
    sanitizedByteLength: 900,
    sanitizedContentSha256: 'b'.repeat(64),
    malwareScan: 'clean',
    exifStripped: true,
    createdAt: '2026-08-11T20:01:00.000Z',
  };
}

function canonicalEntry(): JournalEntry {
  return {
    id: ids.entry,
    eventId: ids.event,
    sequence: 3,
    kind: 'photo',
    author: {
      kind: 'human',
      userId: ids.user,
      sessionId: ids.session,
    },
    source: 'mobile',
    serverTime: '2026-08-11T20:02:00.000Z',
    clientTime: null,
    payload: {
      mediaId: ids.media,
      altText: CREATE_INPUT.altText,
      caption: CREATE_INPUT.caption,
    },
    supersedes: null,
  };
}

function projection(
  entry: JournalEntry = canonicalEntry(),
): JournalEntryReadProjection {
  return { visibility: 'visible', entry };
}

function idempotencyKey(
  purpose: PhotoDraftIdempotencyPurpose,
  generation = 0,
): string {
  if (generation > 0) {
    switch (purpose) {
      case 'create-intent':
        return `photo-create-intent-key-${String(generation + 1).padStart(4, '0')}`;
      case 'complete-upload':
        return `photo-complete-upload-key-${String(generation + 1).padStart(4, '0')}`;
      case 'append-entry':
        return KEYS.appendEntry;
    }
  }
  switch (purpose) {
    case 'create-intent':
      return KEYS.createIntent;
    case 'complete-upload':
      return KEYS.completeUpload;
    case 'append-entry':
      return KEYS.appendEntry;
  }
}

class MemoryStorage implements PhotoDraftStorage {
  public stored: unknown | null;
  public readonly events: string[] = [];
  public saveCount = 0;
  public deleteFailures = 0;

  public constructor(initial: unknown | null = null) {
    this.stored = initial;
  }

  public async load(eventId: string): Promise<unknown | null> {
    this.events.push(`load:${eventId}`);
    return this.stored === null
      ? null
      : (JSON.parse(JSON.stringify(this.stored)) as unknown);
  }

  public async save(
    manifest: PhotoDraftManifest,
    expected: PhotoDraftManifest | null,
  ): Promise<void> {
    this.saveCount += 1;
    this.events.push(`save:${manifest.stage}`);
    expect(this.stored).toEqual(expected);
    this.stored = JSON.parse(JSON.stringify(manifest)) as unknown;
  }

  public async deleteManifest(
    eventId: string,
    draftId: string,
    expected: PhotoDraftManifest,
  ): Promise<void> {
    this.events.push(`delete-manifest:${eventId}:${draftId}`);
    expect(this.stored).toEqual(expected);
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error('synthetic manifest cleanup failure');
    }
    this.stored = null;
  }
}

class FakeNetwork implements PhotoDraftNetwork {
  public readonly events: string[] = [];
  public readonly createKeys: string[] = [];
  public readonly completeKeys: string[] = [];
  public readonly appendKeys: string[] = [];
  public uploadCalls = 0;
  public createFailure: unknown | null = null;
  public successfulIntent: MediaUploadIntent = uploadIntent();
  private activeIntent: MediaUploadIntent = uploadIntent();
  public uploadImplementation: (
    input: PhotoDraftUploadInput,
  ) => Promise<unknown> = async (input) => {
    input.onProgress(0.25);
    input.onProgress(1);
    return { status: 200 };
  };

  public async createUploadIntent(
    input: CreateMediaUploadIntentInput,
    idempotencyKeyValue: string,
    signal: AbortSignal,
  ): Promise<MediaUploadIntent> {
    this.events.push('network:create-intent');
    this.createKeys.push(idempotencyKeyValue);
    expect(signal.aborted).toBe(false);
    expect(input).toEqual({
      eventId: ids.event,
      byteLength: CREATE_INPUT.byteLength,
      contentSha256: CREATE_INPUT.contentSha256,
      declaredContentType: CREATE_INPUT.declaredContentType,
    });
    if (this.createFailure !== null) {
      const failure = this.createFailure;
      this.createFailure = null;
      throw failure;
    }
    this.activeIntent = this.successfulIntent;
    return this.successfulIntent;
  }

  public async uploadBytes(input: PhotoDraftUploadInput): Promise<unknown> {
    this.events.push('network:upload-bytes');
    this.uploadCalls += 1;
    expect(input.localUri).toBe(CREATE_INPUT.localUri);
    expect(input.uploadUrl).toBe(this.activeIntent.uploadUrl);
    expect(input.contentType).toBe(CREATE_INPUT.declaredContentType);
    return this.uploadImplementation(input);
  }

  public async completeUpload(
    uploadIntentId: string,
    idempotencyKeyValue: string,
    signal: AbortSignal,
  ): Promise<MediaRecord> {
    this.events.push('network:complete-upload');
    this.completeKeys.push(idempotencyKeyValue);
    expect(signal.aborted).toBe(false);
    expect(uploadIntentId).toBe(this.activeIntent.id);
    return mediaRecord(this.activeIntent.id);
  }

  public async appendPhoto(
    input: Extract<JournalEntryInput, { kind: 'photo' }>,
    idempotencyKeyValue: string,
    signal: AbortSignal,
  ): Promise<JournalEntry> {
    this.events.push('network:append-entry');
    this.appendKeys.push(idempotencyKeyValue);
    expect(signal.aborted).toBe(false);
    expect(input).toEqual({
      eventId: ids.event,
      clientTime: null,
      supersedes: null,
      kind: 'photo',
      payload: {
        mediaId: ids.media,
        altText: CREATE_INPUT.altText,
        caption: CREATE_INPUT.caption,
      },
    });
    return canonicalEntry();
  }
}

interface Harness {
  readonly storage: MemoryStorage;
  readonly network: FakeNetwork;
  readonly dependencies: PhotoDraftDependencies;
  readonly cleanupEvents: string[];
  setPrivateDeleteFailures(count: number): void;
}

function harness(initial: unknown | null = null): Harness {
  const storage = new MemoryStorage(initial);
  const network = new FakeNetwork();
  const cleanupEvents: string[] = [];
  let privateDeleteFailures = 0;
  const keyGenerations: Record<PhotoDraftIdempotencyPurpose, number> = {
    'create-intent': 0,
    'complete-upload': 0,
    'append-entry': 0,
  };
  return {
    storage,
    network,
    cleanupEvents,
    setPrivateDeleteFailures(count) {
      privateDeleteFailures = count;
    },
    dependencies: {
      storage,
      network,
      deletePrivateCopy(localUri) {
        cleanupEvents.push(`delete-private:${localUri}`);
        storage.events.push(`delete-private:${localUri}`);
        if (privateDeleteFailures > 0) {
          privateDeleteFailures -= 1;
          throw new Error('synthetic private-copy cleanup failure');
        }
      },
      createIdempotencyKey(purpose) {
        const generation = keyGenerations[purpose];
        keyGenerations[purpose] += 1;
        return idempotencyKey(purpose, generation);
      },
    },
  };
}

async function readyController(testHarness: Harness) {
  return PhotoDraftController.create(CREATE_INPUT, testHarness.dependencies);
}

function retainedManifest(
  overrides: Partial<PhotoDraftManifest> = {},
): PhotoDraftManifest {
  return parsePhotoDraftManifest({
    version: 1,
    draftId: ids.draft,
    eventId: ids.event,
    sessionId: ids.session,
    localUri: CREATE_INPUT.localUri,
    byteLength: CREATE_INPUT.byteLength,
    contentSha256: CREATE_INPUT.contentSha256,
    declaredContentType: CREATE_INPUT.declaredContentType,
    altText: CREATE_INPUT.altText,
    caption: CREATE_INPUT.caption,
    stage: 'ready',
    retryStage: null,
    cleanupProof: null,
    uploadIntentId: null,
    mediaId: null,
    idempotencyKeys: KEYS,
    ...overrides,
  });
}

describe('durable photo draft', () => {
  test('persists the complete manifest before network and never persists a presigned URL', async () => {
    const testHarness = harness();
    const combinedEvents: string[] = [];
    const originalSave = testHarness.storage.save.bind(testHarness.storage);
    testHarness.storage.save = async (manifest, expected) => {
      combinedEvents.push(`save:${manifest.stage}`);
      expect(JSON.stringify(manifest)).not.toContain('uploadUrl');
      expect(JSON.stringify(manifest)).not.toContain(
        'synthetic-presigned-secret',
      );
      await originalSave(manifest, expected);
    };
    const originalCreate = testHarness.network.createUploadIntent.bind(
      testHarness.network,
    );
    testHarness.network.createUploadIntent = async (...argumentsList) => {
      combinedEvents.push('network:create-intent');
      return originalCreate(...argumentsList);
    };
    const originalUpload = testHarness.network.uploadBytes.bind(
      testHarness.network,
    );
    testHarness.network.uploadBytes = async (input) => {
      combinedEvents.push('network:upload-bytes');
      return originalUpload(input);
    };
    const originalComplete = testHarness.network.completeUpload.bind(
      testHarness.network,
    );
    testHarness.network.completeUpload = async (...argumentsList) => {
      combinedEvents.push('network:complete-upload');
      return originalComplete(...argumentsList);
    };
    const originalAppend = testHarness.network.appendPhoto.bind(
      testHarness.network,
    );
    testHarness.network.appendPhoto = async (...argumentsList) => {
      combinedEvents.push('network:append-entry');
      return originalAppend(...argumentsList);
    };

    const controller = await readyController(testHarness);
    expect(testHarness.network.events).toEqual([]);
    expect(controller.snapshot().manifest).toMatchObject({
      stage: 'ready',
      eventId: ids.event,
      sessionId: ids.session,
      localUri: CREATE_INPUT.localUri,
      byteLength: CREATE_INPUT.byteLength,
      contentSha256: CREATE_INPUT.contentSha256,
      declaredContentType: CREATE_INPUT.declaredContentType,
      altText: CREATE_INPUT.altText,
      caption: CREATE_INPUT.caption,
      uploadIntentId: null,
      mediaId: null,
      idempotencyKeys: KEYS,
    });

    const progress: number[] = [];
    controller.subscribe((snapshot) =>
      progress.push(snapshot.progress.fraction),
    );
    const completed = await controller.start();
    expect(completed).toEqual({
      manifest: null,
      progress: {
        stage: 'complete',
        fraction: 1,
        requiresExplicitRetry: false,
      },
    });
    expect(combinedEvents.indexOf('save:ready')).toBeLessThan(
      combinedEvents.indexOf('network:create-intent'),
    );
    expect(combinedEvents.indexOf('save:creating-intent')).toBeLessThan(
      combinedEvents.indexOf('network:create-intent'),
    );
    expect(combinedEvents.indexOf('save:uploading')).toBeLessThan(
      combinedEvents.indexOf('network:upload-bytes'),
    );
    expect(combinedEvents.indexOf('save:completing-upload')).toBeLessThan(
      combinedEvents.indexOf('network:complete-upload'),
    );
    expect(combinedEvents.indexOf('save:appending')).toBeLessThan(
      combinedEvents.indexOf('network:append-entry'),
    );
    expect(combinedEvents.indexOf('save:cleanup-pending')).toBeGreaterThan(
      combinedEvents.indexOf('network:append-entry'),
    );
    expect(progress).toContain(0.2625);
    expect(progress.at(-1)).toBe(1);
    expect(testHarness.network.events).toEqual([
      'network:create-intent',
      'network:upload-bytes',
      'network:complete-upload',
      'network:append-entry',
    ]);
  });

  test('retains an interrupted background operation as unknown and advances only after explicit retry', async () => {
    const testHarness = harness();
    let uploadStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    testHarness.network.uploadImplementation = async (input) => {
      input.onProgress(0.4);
      uploadStarted?.();
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(new Error('synthetic background interruption')),
          { once: true },
        );
      });
    };
    const controller = await readyController(testHarness);
    const running = controller.start();
    await started;
    controller.interruptForBackground();
    const interrupted = await running;

    expect(interrupted.manifest).toMatchObject({
      stage: 'unknown',
      retryStage: 'upload-bytes',
      uploadIntentId: ids.intent,
      mediaId: null,
      idempotencyKeys: KEYS,
    });
    expect(interrupted.progress.requiresExplicitRetry).toBe(true);
    expect(testHarness.network.events).toEqual([
      'network:create-intent',
      'network:upload-bytes',
    ]);
    expect(testHarness.cleanupEvents).toEqual([]);
    expect(testHarness.storage.stored).not.toBeNull();

    testHarness.network.uploadImplementation = async (input) => {
      input.onProgress(1);
      return { status: 412 };
    };
    await Promise.resolve();
    expect(testHarness.network.events).toHaveLength(2);
    const completed = await controller.retry([]);
    expect(completed.manifest).toBeNull();
    expect(testHarness.network.events.slice(2)).toEqual([
      'network:create-intent',
      'network:upload-bytes',
      'network:complete-upload',
      'network:append-entry',
    ]);
    expect(testHarness.network.createKeys).toEqual([
      KEYS.createIntent,
      KEYS.createIntent,
    ]);
    expect(testHarness.network.completeKeys).toEqual([KEYS.completeUpload]);
    expect(testHarness.network.appendKeys).toEqual([KEYS.appendEntry]);
  });

  test('ignores background interruption while idle and starts a ready draft normally', async () => {
    const testHarness = harness();
    const controller = await readyController(testHarness);

    controller.interruptForBackground();
    expect(controller.snapshot().manifest?.stage).toBe('ready');

    const completed = await controller.start();
    expect(completed.manifest).toBeNull();
    expect(testHarness.network.events).toEqual([
      'network:create-intent',
      'network:upload-bytes',
      'network:complete-upload',
      'network:append-entry',
    ]);
  });

  test('waits for every outstanding operation even after a concurrent claim rejects', async () => {
    const testHarness = harness();
    let uploadStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    let finishUpload: (() => void) | undefined;
    const upload = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    testHarness.network.uploadImplementation = async () => {
      uploadStarted?.();
      await upload;
      return { status: 200 };
    };
    const controller = await readyController(testHarness);
    const running = controller.start();
    await started;
    await expect(controller.reconcile([])).rejects.toBeInstanceOf(
      PhotoDraftStateError,
    );
    let settled = false;
    const settlement = controller.waitForOperationSettlement().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishUpload?.();
    await running;
    await settlement;
    expect(settled).toBe(true);
  });

  test('uses an exact retry after background, then rotates an expired failed upload epoch before network', async () => {
    const testHarness = harness();
    let uploadStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    testHarness.network.uploadImplementation = async (input) => {
      uploadStarted?.();
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(new Error('synthetic long background interruption')),
          { once: true },
        );
      });
    };
    const controller = await readyController(testHarness);
    const running = controller.start();
    await started;
    controller.interruptForBackground();
    expect((await running).manifest).toMatchObject({
      stage: 'unknown',
      retryStage: 'upload-bytes',
      uploadIntentId: ids.intent,
      idempotencyKeys: KEYS,
    });

    // The first explicit tap preserves the exact old replay key. A canonical
    // non-retryable expiry response proves that epoch cannot continue.
    testHarness.network.createFailure = new PhotoDraftOperationError(
      'failed',
      'synthetic expired upload intent',
    );
    expect((await controller.retry([])).manifest).toMatchObject({
      stage: 'failed',
      retryStage: 'upload-bytes',
      uploadIntentId: ids.intent,
      idempotencyKeys: KEYS,
    });
    expect(testHarness.network.createKeys).toEqual([
      KEYS.createIntent,
      KEYS.createIntent,
    ]);
    await Promise.resolve();
    expect(testHarness.network.events).toHaveLength(3);

    testHarness.network.successfulIntent = uploadIntent({
      id: ids.freshIntent,
      uploadUrl: 'https://uploads.invalid/fresh-synthetic-presigned-secret',
      createdAt: '2026-08-11T20:16:00.000Z',
      expiresAt: '2026-08-11T20:31:00.000Z',
    });
    testHarness.network.uploadImplementation = async (input) => {
      input.onProgress(1);
      return { status: 200 };
    };
    const originalCreate = testHarness.network.createUploadIntent.bind(
      testHarness.network,
    );
    testHarness.network.createUploadIntent = async (...argumentsList) => {
      if (argumentsList[1] === FRESH_KEYS.createIntent) {
        expect(testHarness.storage.stored).toMatchObject({
          stage: 'creating-intent',
          retryStage: null,
          uploadIntentId: null,
          mediaId: null,
          idempotencyKeys: FRESH_KEYS,
        });
      }
      return originalCreate(...argumentsList);
    };

    const completed = await controller.retry([]);
    expect(completed.manifest).toBeNull();
    expect(testHarness.network.createKeys).toEqual([
      KEYS.createIntent,
      KEYS.createIntent,
      FRESH_KEYS.createIntent,
    ]);
    expect(testHarness.network.completeKeys).toEqual([
      FRESH_KEYS.completeUpload,
    ]);
    expect(testHarness.network.appendKeys).toEqual([KEYS.appendEntry]);
  });

  test('rotates only upload-epoch keys for an explicit proved-failure retry', async () => {
    const testHarness = harness();
    testHarness.network.createFailure = new PhotoDraftOperationError(
      'failed',
      'synthetic rejected intent',
    );
    const controller = await readyController(testHarness);
    const failed = await controller.start();
    expect(failed.manifest).toMatchObject({
      stage: 'failed',
      retryStage: 'create-intent',
      idempotencyKeys: KEYS,
    });
    expect(testHarness.network.events).toEqual(['network:create-intent']);
    await Promise.resolve();
    expect(testHarness.network.events).toHaveLength(1);

    await controller.retry([]);
    expect(testHarness.network.createKeys).toEqual([
      KEYS.createIntent,
      FRESH_KEYS.createIntent,
    ]);
    expect(testHarness.network.completeKeys).toEqual([
      FRESH_KEYS.completeUpload,
    ]);
    expect(testHarness.network.appendKeys).toEqual([KEYS.appendEntry]);
  });

  test('halts an interrupted fresh-epoch retry before any network call', async () => {
    const failed = retainedManifest({
      stage: 'failed',
      retryStage: 'create-intent',
    });
    const testHarness = harness(failed);
    let keyGeneration = 0;
    const dependencies: PhotoDraftDependencies = {
      ...testHarness.dependencies,
      createIdempotencyKey(purpose) {
        keyGeneration += 1;
        return `photo-${purpose}-fresh-interrupt-${keyGeneration}`;
      },
    };
    const controller = await PhotoDraftController.restore(
      {
        draftId: ids.draft,
        eventId: ids.event,
        sessionId: ids.session,
      },
      dependencies,
    );
    const originalSave = testHarness.storage.save.bind(testHarness.storage);
    let releaseFreshTransition: (() => void) | undefined;
    const freshTransitionStarted = new Promise<void>((resolve) => {
      releaseFreshTransition = resolve;
    });
    let unblockSave: (() => void) | undefined;
    const blockedSave = new Promise<void>((resolve) => {
      unblockSave = resolve;
    });
    testHarness.storage.save = async (manifest, expected) => {
      if (manifest.stage === 'creating-intent') {
        releaseFreshTransition?.();
        await blockedSave;
      }
      await originalSave(manifest, expected);
    };

    const retry = controller.retry([]);
    await freshTransitionStarted;
    controller.interruptForBackground();
    unblockSave?.();
    const result = await retry;

    expect(result.manifest).toMatchObject({
      stage: 'unknown',
      retryStage: 'create-intent',
    });
    expect(testHarness.network.events).toEqual([]);
  });

  test('persists description edits only before start and denies uncertain edits or discard', async () => {
    const testHarness = harness();
    testHarness.network.createFailure = new PhotoDraftOperationError(
      'failed',
      'synthetic rejected intent',
    );
    const controller = await readyController(testHarness);
    const edited = await controller.updateDescription(
      'Updated synthetic alternative text',
      null,
    );
    expect(edited.manifest).toMatchObject({
      stage: 'ready',
      altText: 'Updated synthetic alternative text',
      caption: null,
      idempotencyKeys: KEYS,
    });
    expect(testHarness.network.events).toEqual([]);
    await expect(
      controller.updateDescription('   ', null),
    ).rejects.toBeInstanceOf(PhotoDraftStateError);
    expect(controller.snapshot().manifest?.altText).toBe(
      'Updated synthetic alternative text',
    );

    await controller.start();
    await expect(
      controller.updateDescription('Too late to edit', null),
    ).rejects.toBeInstanceOf(PhotoDraftStateError);
    await expect(controller.discard()).rejects.toBeInstanceOf(
      PhotoDraftStateError,
    );
    expect(testHarness.cleanupEvents).toEqual([]);
    expect(testHarness.storage.stored).not.toBeNull();
  });

  test('discards a never-started draft in private-copy then manifest order', async () => {
    const testHarness = harness();
    const controller = await readyController(testHarness);
    const discarded = await controller.discard();
    expect(discarded.manifest).toBeNull();
    expect(testHarness.network.events).toEqual([]);
    expect(testHarness.storage.events.slice(-2)).toEqual([
      `delete-private:${CREATE_INPUT.localUri}`,
      `delete-manifest:${ids.event}:${ids.draft}`,
    ]);
  });

  test('explicitly cleans an uncertain closed-event draft locally without network replay', async () => {
    const retained = retainedManifest({
      stage: 'unknown',
      retryStage: 'append-entry',
      uploadIntentId: ids.intent,
      mediaId: ids.media,
    });
    const testHarness = harness(retained);
    const controller = await PhotoDraftController.restore(
      {
        draftId: ids.draft,
        eventId: ids.event,
        sessionId: ids.session,
      },
      testHarness.dependencies,
    );

    testHarness.setPrivateDeleteFailures(1);
    expect(
      (await controller.discardLocallyAfterEventClosed()).manifest,
    ).toEqual(retained);
    expect(testHarness.network.events).toEqual([]);

    expect(
      (await controller.discardLocallyAfterEventClosed()).manifest,
    ).toBeNull();
    expect(testHarness.network.events).toEqual([]);
  });

  test('reconciles only the exact canonical photo before ordered cleanup', async () => {
    const manifest = retainedManifest({
      stage: 'unknown',
      retryStage: 'append-entry',
      uploadIntentId: ids.intent,
      mediaId: ids.media,
    });
    const testHarness = harness(manifest);
    const controller = await PhotoDraftController.restore(
      {
        draftId: ids.draft,
        eventId: ids.event,
        sessionId: ids.session,
      },
      testHarness.dependencies,
    );
    const mismatch = canonicalEntry();
    if (mismatch.kind !== 'photo') {
      throw new Error('Synthetic photo fixture has the wrong kind.');
    }
    const unmatched = await controller.reconcile([
      projection({
        ...mismatch,
        payload: { ...mismatch.payload, altText: 'Different description' },
      }),
    ]);
    expect(unmatched).toBe(false);
    expect(testHarness.cleanupEvents).toEqual([]);
    expect(testHarness.storage.stored).not.toBeNull();

    const matched = await controller.reconcile([projection()]);
    expect(matched).toBe(true);
    expect(controller.snapshot().manifest).toBeNull();
    expect(testHarness.network.events).toEqual([]);
    expect(testHarness.storage.events.slice(-3)).toEqual([
      'save:cleanup-pending',
      `delete-private:${CREATE_INPUT.localUri}`,
      `delete-manifest:${ids.event}:${ids.draft}`,
    ]);
  });

  test('serializes retry reconciliation and never rotates an append replay key', async () => {
    const retained = retainedManifest({
      stage: 'unknown',
      retryStage: 'append-entry',
      uploadIntentId: ids.intent,
      mediaId: ids.media,
    });
    const reconciledHarness = harness(retained);
    const reconciled = await PhotoDraftController.restore(
      {
        draftId: ids.draft,
        eventId: ids.event,
        sessionId: ids.session,
      },
      reconciledHarness.dependencies,
    );
    expect((await reconciled.retry([projection()])).manifest).toBeNull();
    expect(reconciledHarness.network.events).toEqual([]);

    const replayHarness = harness(retained);
    const replay = await PhotoDraftController.restore(
      {
        draftId: ids.draft,
        eventId: ids.event,
        sessionId: ids.session,
      },
      replayHarness.dependencies,
    );
    const mismatch = canonicalEntry();
    if (mismatch.kind !== 'photo') {
      throw new Error('Synthetic photo fixture has the wrong kind.');
    }
    expect(
      (
        await replay.retry([
          projection({
            ...mismatch,
            payload: { ...mismatch.payload, altText: 'Another photo' },
          }),
        ])
      ).manifest,
    ).toBeNull();
    expect(replayHarness.network.events).toEqual(['network:append-entry']);
    expect(replayHarness.network.createKeys).toEqual([]);
    expect(replayHarness.network.completeKeys).toEqual([]);
    expect(replayHarness.network.appendKeys).toEqual([KEYS.appendEntry]);
  });

  test('rejects a cross-session append response and reconciles only canonical timeline truth', async () => {
    const testHarness = harness();
    const originalAppend = testHarness.network.appendPhoto.bind(
      testHarness.network,
    );
    testHarness.network.appendPhoto = async (...argumentsList) => {
      const entry = await originalAppend(...argumentsList);
      return {
        ...entry,
        author: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.otherSession,
        },
      };
    };
    const controller = await readyController(testHarness);
    const rejected = await controller.start();
    expect(rejected.manifest).toMatchObject({
      stage: 'unknown',
      retryStage: 'append-entry',
      mediaId: ids.media,
      idempotencyKeys: KEYS,
    });
    expect(testHarness.network.appendKeys).toEqual([KEYS.appendEntry]);

    expect((await controller.retry([projection()])).manifest).toBeNull();
    expect(testHarness.network.appendKeys).toEqual([KEYS.appendEntry]);
  });

  test('keeps cleanup proof durable until private-copy then manifest deletion both succeed', async () => {
    const testHarness = harness();
    testHarness.setPrivateDeleteFailures(1);
    const controller = await readyController(testHarness);
    const afterAppend = await controller.start();
    expect(afterAppend.manifest).toMatchObject({
      stage: 'cleanup-pending',
      cleanupProof: 'append-response',
      uploadIntentId: ids.intent,
      mediaId: ids.media,
    });
    expect(testHarness.storage.events).not.toContain(
      `delete-manifest:${ids.event}:${ids.draft}`,
    );

    testHarness.storage.deleteFailures = 1;
    const afterManifestFailure = await controller.retryCleanup();
    expect(afterManifestFailure.manifest?.stage).toBe('cleanup-pending');
    expect(testHarness.storage.stored).not.toBeNull();
    const lastTwo = testHarness.storage.events.slice(-2);
    expect(lastTwo).toEqual([
      `delete-private:${CREATE_INPUT.localUri}`,
      `delete-manifest:${ids.event}:${ids.draft}`,
    ]);

    const completed = await controller.retryCleanup();
    expect(completed.manifest).toBeNull();
    expect(testHarness.storage.stored).toBeNull();
  });

  test('fails closed on malformed or cross-owner restore without network or cleanup', async () => {
    const cases: unknown[] = [
      { ...retainedManifest(), uploadUrl: uploadIntent().uploadUrl },
      { ...retainedManifest(), localUri: 'https://example.invalid/photo.jpg' },
      {
        ...retainedManifest(),
        stage: 'uploading',
        uploadIntentId: null,
      },
      {
        ...retainedManifest(),
        idempotencyKeys: {
          createIntent: KEYS.createIntent,
          completeUpload: KEYS.createIntent,
          appendEntry: KEYS.appendEntry,
        },
      },
    ];
    for (const stored of cases) {
      const testHarness = harness(stored);
      await expect(
        PhotoDraftController.restore(
          {
            draftId: ids.draft,
            eventId: ids.event,
            sessionId: ids.session,
          },
          testHarness.dependencies,
        ),
      ).rejects.toBeInstanceOf(PhotoDraftStateError);
      expect(testHarness.network.events).toEqual([]);
      expect(testHarness.cleanupEvents).toEqual([]);
      expect(testHarness.storage.saveCount).toBe(0);
    }

    for (const owner of [
      { eventId: ids.otherEvent, sessionId: ids.session },
      { eventId: ids.event, sessionId: ids.otherSession },
    ]) {
      const testHarness = harness(retainedManifest());
      await expect(
        PhotoDraftController.restore(
          { draftId: ids.draft, ...owner },
          testHarness.dependencies,
        ),
      ).rejects.toBeInstanceOf(PhotoDraftStateError);
      expect(testHarness.storage.saveCount).toBe(0);
      expect(testHarness.network.events).toEqual([]);
      expect(testHarness.cleanupEvents).toEqual([]);
    }
  });

  test('restores in-flight state as unknown without network and requires explicit retry', async () => {
    const interrupted = retainedManifest({
      stage: 'completing-upload',
      uploadIntentId: ids.intent,
    });
    const testHarness = harness(interrupted);
    const controller = await PhotoDraftController.restore(
      {
        draftId: ids.draft,
        eventId: ids.event,
        sessionId: ids.session,
      },
      testHarness.dependencies,
    );
    expect(controller.snapshot().manifest).toMatchObject({
      stage: 'unknown',
      retryStage: 'complete-upload',
      uploadIntentId: ids.intent,
    });
    expect(testHarness.network.events).toEqual([]);
    expect(testHarness.storage.events.at(-1)).toBe('save:unknown');
  });
});
