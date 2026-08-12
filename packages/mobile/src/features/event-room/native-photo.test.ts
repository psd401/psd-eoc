import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PhotoDraftManifest } from './photo-draft';
import type { PendingPhotoSelectionLease } from './native-photo';

const DOCUMENT_URI = 'file:///documents/';
const DRAFT_DIRECTORY_URI = `${DOCUMENT_URI}event-photo-drafts/`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const files = new Map<string, Uint8Array>();

type MoveFault =
  | 'after-delete'
  | 'after-move'
  | 'after-move-source-left'
  | null;
let moveFault: MoveFault = null;
let uuidCounter = 1;
let launchResult: unknown = { canceled: true, assets: null };
let launchError: Error | null = null;
let launchCalls = 0;
let permissionGranted = true;
let permissionCalls = 0;
let pendingResult: unknown = null;
let pendingResultCalls = 0;
let pendingResultImplementation: (() => Promise<unknown>) | null = null;
let uploadImplementation: (() => Promise<Readonly<{ status: number }>>) | null =
  null;
let uploadCancelCalls = 0;
let uploadReleaseCalls = 0;
let uploadCancelError: Error | null = null;

function pathUri(value: string | Readonly<{ uri: string }>): string {
  return typeof value === 'string' ? value : value.uri;
}

function joinUri(
  parts: readonly (string | Readonly<{ uri: string }>)[],
): string {
  const [first, ...rest] = parts;
  let result = pathUri(first!);
  for (const part of rest) {
    const next = pathUri(part);
    result = `${result.replace(/\/$/, '')}/${next.replace(/^\//, '')}`;
  }
  return result;
}

class FakeDirectory {
  public readonly uri: string;

  public constructor(...parts: (string | Readonly<{ uri: string }>)[]) {
    const joined = joinUri(parts);
    this.uri = joined.endsWith('/') ? joined : `${joined}/`;
  }

  public create(): void {}
}

class FakeFile {
  public uri: string;

  public constructor(...parts: (string | Readonly<{ uri: string }>)[]) {
    this.uri = joinUri(parts);
  }

  public get exists(): boolean {
    return files.has(this.uri);
  }

  public get size(): number {
    return files.get(this.uri)?.byteLength ?? 0;
  }

  public get name(): string {
    return decodeURIComponent(this.uri.split('/').at(-1)!);
  }

  public get parentDirectory(): FakeDirectory {
    return new FakeDirectory(this.uri.slice(0, this.uri.lastIndexOf('/') + 1));
  }

  public create(options: Readonly<{ overwrite?: boolean }> = {}): void {
    if (this.exists && options.overwrite !== true) {
      throw new Error('file already exists');
    }
    files.set(this.uri, new Uint8Array());
  }

  public write(value: string | Uint8Array): void {
    files.set(
      this.uri,
      typeof value === 'string' ? encoder.encode(value) : value.slice(),
    );
  }

  public async text(): Promise<string> {
    const value = files.get(this.uri);
    if (value === undefined) throw new Error('file missing');
    return decoder.decode(value);
  }

  public async bytes(): Promise<Uint8Array> {
    const value = files.get(this.uri);
    if (value === undefined) throw new Error('file missing');
    return value.slice();
  }

  public delete(): void {
    if (!files.delete(this.uri)) throw new Error('file missing');
  }

  public async copy(
    destination: FakeFile,
    options: Readonly<{ overwrite?: boolean }> = {},
  ): Promise<void> {
    const value = files.get(this.uri);
    if (value === undefined) throw new Error('source missing');
    if (destination.exists && options.overwrite !== true) {
      throw new Error('destination exists');
    }
    files.set(destination.uri, value.slice());
  }

  public async move(
    destination: FakeFile,
    options: Readonly<{ overwrite?: boolean }> = {},
  ): Promise<void> {
    const value = files.get(this.uri);
    if (value === undefined) throw new Error('source missing');
    if (destination.exists) {
      if (options.overwrite !== true) throw new Error('destination exists');
      files.delete(destination.uri);
    }
    if (moveFault === 'after-delete') {
      moveFault = null;
      throw new Error('synthetic move failure after destination delete');
    }
    const sourceUri = this.uri;
    files.set(destination.uri, value.slice());
    if (moveFault !== 'after-move-source-left') files.delete(sourceUri);
    this.uri = destination.uri;
    if (moveFault === 'after-move' || moveFault === 'after-move-source-left') {
      moveFault = null;
      throw new Error('synthetic move rejection after commit');
    }
  }

  public createUploadTask(): Readonly<{
    uploadAsync: () => Promise<Readonly<{ status: number }>>;
    cancel: () => void;
    release: () => void;
  }> {
    return {
      uploadAsync: () =>
        uploadImplementation?.() ?? Promise.resolve({ status: 200 }),
      cancel: () => {
        uploadCancelCalls += 1;
        if (uploadCancelError !== null) throw uploadCancelError;
      },
      release: () => {
        uploadReleaseCalls += 1;
      },
    };
  }
}

function syntheticHash(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const slot = index % output.length;
    output[slot] = (output[slot]! * 33 + bytes[index]! + index) & 0xff;
  }
  return output;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

mock.module('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  randomUUID(): string {
    const suffix = String(uuidCounter++).padStart(12, '0');
    return `10000000-0000-4000-8000-${suffix}`;
  },
  async digest(
    _algorithm: string,
    value: ArrayBufferView,
  ): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    const result = new ArrayBuffer(32);
    new Uint8Array(result).set(syntheticHash(bytes));
    return result;
  },
  async digestStringAsync(_algorithm: string, value: string): Promise<string> {
    return toHex(syntheticHash(encoder.encode(value)));
  },
}));

mock.module('expo-file-system', () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { document: { uri: DOCUMENT_URI } },
  UploadType: { BINARY_CONTENT: 0 },
}));

mock.module('expo-image-picker', () => ({
  async requestMediaLibraryPermissionsAsync() {
    permissionCalls += 1;
    return { granted: permissionGranted };
  },
  async launchImageLibraryAsync() {
    launchCalls += 1;
    if (launchError !== null) throw launchError;
    return launchResult;
  },
  async getPendingResultAsync() {
    pendingResultCalls += 1;
    if (pendingResultImplementation !== null) {
      return pendingResultImplementation();
    }
    const result = pendingResult;
    pendingResult = null;
    return result;
  },
}));

const { NativePhotoDraftStorage, uploadPrivatePhoto } = await import(
  './native-photo'
);

const ids = {
  draft: '00000000-0000-4000-8000-000000000701',
  otherDraft: '00000000-0000-4000-8000-000000000702',
  selection: '00000000-0000-4000-8000-000000000703',
  otherSelection: '00000000-0000-4000-8000-000000000704',
  event: '00000000-0000-4000-8000-000000000705',
  otherEvent: '00000000-0000-4000-8000-000000000706',
  session: '00000000-0000-4000-8000-000000000707',
  otherSession: '00000000-0000-4000-8000-000000000708',
} as const;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
const OTHER_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x09]);

function owner(
  overrides: Partial<{
    selectionId: string;
    draftId: string;
    eventId: string;
    sessionId: string;
  }> = {},
) {
  return Object.freeze({
    version: 1 as const,
    selectionId: overrides.selectionId ?? ids.selection,
    draftId: overrides.draftId ?? ids.draft,
    eventId: overrides.eventId ?? ids.event,
    sessionId: overrides.sessionId ?? ids.session,
  });
}

function manifest(
  overrides: Partial<PhotoDraftManifest> = {},
): PhotoDraftManifest {
  return {
    version: 1,
    draftId: ids.draft,
    eventId: ids.event,
    sessionId: ids.session,
    localUri: `${DRAFT_DIRECTORY_URI}${ids.draft}.private-photo`,
    byteLength: JPEG.byteLength,
    contentSha256: toHex(syntheticHash(JPEG)),
    declaredContentType: 'image/jpeg',
    altText: 'Synthetic north entrance photo',
    caption: null,
    stage: 'ready',
    retryStage: null,
    cleanupProof: null,
    uploadIntentId: null,
    mediaId: null,
    idempotencyKeys: {
      createIntent: 'photo-create-intent-key-0701',
      completeUpload: 'photo-complete-upload-key-0701',
      appendEntry: 'photo-append-entry-key-0701',
    },
    ...overrides,
  };
}

function deferred<Value = void>(): Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function beginOwner(
  storage: InstanceType<typeof NativePhotoDraftStorage>,
  value = owner(),
): Promise<void> {
  await storage.withNewPendingSelection(value, async () => undefined);
}

beforeEach(() => {
  files.clear();
  moveFault = null;
  uuidCounter = 1;
  launchResult = { canceled: true, assets: null };
  launchError = null;
  launchCalls = 0;
  permissionGranted = true;
  permissionCalls = 0;
  pendingResult = null;
  pendingResultCalls = 0;
  pendingResultImplementation = null;
  uploadImplementation = null;
  uploadCancelCalls = 0;
  uploadReleaseCalls = 0;
  uploadCancelError = null;
});

describe('native photo durable ownership', () => {
  test('bounds a stalled foreground upload and reports an uncertain result', async () => {
    const retained = manifest();
    files.set(retained.localUri, JPEG);
    uploadImplementation = () => new Promise(() => undefined);

    await expect(
      uploadPrivatePhoto({
        draftId: retained.draftId,
        localUri: retained.localUri,
        uploadUrl: 'https://uploads.invalid/synthetic-stalled-put',
        contentType: retained.declaredContentType,
        byteLength: retained.byteLength,
        contentSha256: retained.contentSha256,
        onProgress: () => undefined,
        timeoutMilliseconds: 5,
      }),
    ).rejects.toMatchObject({
      name: 'PhotoDraftOperationError',
      outcome: 'unknown',
    });
    expect(uploadCancelCalls).toBe(1);
    expect(uploadReleaseCalls).toBe(1);

    uploadCancelError = new Error('synthetic native cancel failure');
    await expect(
      uploadPrivatePhoto({
        draftId: retained.draftId,
        localUri: retained.localUri,
        uploadUrl: 'https://uploads.invalid/synthetic-stalled-put',
        contentType: retained.declaredContentType,
        byteLength: retained.byteLength,
        contentSha256: retained.contentSha256,
        onProgress: () => undefined,
        timeoutMilliseconds: 5,
      }),
    ).rejects.toMatchObject({
      name: 'PhotoDraftOperationError',
      outcome: 'unknown',
    });
    expect(uploadCancelCalls).toBe(2);
    expect(uploadReleaseCalls).toBe(2);
  });

  test('retains the last valid slot and adopts only an exact committed move rejection', async () => {
    const storage = new NativePhotoDraftStorage();
    const first = manifest();
    const second = manifest({ altText: 'Second durable description' });
    await storage.save(first, null);
    await storage.save(second, first);

    moveFault = 'after-delete';
    await expect(
      storage.save(manifest({ altText: 'Torn third description' }), second),
    ).rejects.toThrow();
    expect(await storage.load(ids.event)).toMatchObject({
      altText: 'Second durable description',
    });

    moveFault = 'after-move-source-left';
    await storage.save(
      manifest({ altText: 'Committed third description' }),
      second,
    );
    expect(await storage.load(ids.event)).toMatchObject({
      altText: 'Committed third description',
    });
    expect(
      [...files.keys()].filter((uri) => uri.endsWith('.write-in-progress')),
    ).toEqual([]);
  });

  test('rejects cross-owner and replay-lineage replacement', async () => {
    const storage = new NativePhotoDraftStorage();
    const retained = manifest();
    await storage.save(retained, null);

    await expect(
      storage.save(
        manifest({
          draftId: ids.otherDraft,
          localUri: `${DRAFT_DIRECTORY_URI}${ids.otherDraft}.private-photo`,
        }),
        null,
      ),
    ).rejects.toThrow('changed before this write');
    await expect(
      storage.save(
        manifest({
          idempotencyKeys: {
            ...retained.idempotencyKeys,
            appendEntry: 'different-append-replay-key-0702',
          },
        }),
        retained,
      ),
    ).rejects.toThrow('changed immutable lineage');
    expect(await storage.load(ids.event)).toEqual(retained);
  });

  test('rejects a stale same-lineage state transition', async () => {
    const storage = new NativePhotoDraftStorage();
    const ready = manifest();
    const edited = manifest({ altText: 'New canonical description' });
    await storage.save(ready, null);
    await storage.save(edited, ready);

    await expect(
      storage.save(manifest({ stage: 'creating-intent' }), ready),
    ).rejects.toThrow('changed before this write');
    expect(await storage.load(ids.event)).toEqual(edited);
  });

  test('permits only the exact failed pre-append upload-key rotation', async () => {
    const storage = new NativePhotoDraftStorage();
    const failed = manifest({
      stage: 'failed',
      retryStage: 'upload-bytes',
      uploadIntentId: '00000000-0000-4000-8000-000000000708',
    });
    await storage.save(failed, null);
    const fresh = manifest({
      stage: 'creating-intent',
      retryStage: null,
      uploadIntentId: null,
      idempotencyKeys: {
        createIntent: 'photo-create-intent-key-0702',
        completeUpload: 'photo-complete-upload-key-0702',
        appendEntry: failed.idempotencyKeys.appendEntry,
      },
    });
    await expect(storage.save(fresh, failed)).resolves.toBeUndefined();

    const illegal = manifest({
      ...fresh,
      idempotencyKeys: {
        ...fresh.idempotencyKeys,
        appendEntry: 'photo-append-entry-key-rotated-illegally',
      },
    });
    await expect(storage.save(illegal, fresh)).rejects.toThrow(
      'changed immutable lineage',
    );
    expect(await storage.load(ids.event)).toEqual(fresh);
  });

  test('commits tombstones before pruning and fails closed if the sole tombstone corrupts', async () => {
    const storage = new NativePhotoDraftStorage();
    const retained = manifest();
    await storage.save(retained, null);
    await storage.deleteManifest(ids.event, ids.draft, retained);
    expect(await storage.load(ids.event)).toBeNull();

    const tombstoneUri = `${DRAFT_DIRECTORY_URI}${ids.event}.manifest.b.json`;
    expect(files.has(tombstoneUri)).toBe(true);
    expect(
      files.has(`${DRAFT_DIRECTORY_URI}${ids.event}.manifest.a.json`),
    ).toBe(false);
    files.set(tombstoneUri, encoder.encode('{"torn":'));
    await expect(storage.load(ids.event)).rejects.toThrow(
      'Both private photo journal slots are invalid',
    );
  });

  test('compare-and-tombstones only the exact pending selection token', async () => {
    const storage = new NativePhotoDraftStorage();
    const first = owner();
    const stale = owner({ selectionId: ids.otherSelection });
    await beginOwner(storage, first);
    await expect(
      storage.withNewPendingSelection(stale, async () => undefined),
    ).rejects.toThrow('retained owner');
    await expect(storage.clearPendingSelection(stale)).rejects.toThrow(
      'owns the retained token',
    );
    expect(await storage.loadPendingSelection()).toEqual(first);
    await storage.clearPendingSelection(first);
    expect(await storage.loadPendingSelection()).toBeNull();
    expect(pendingResultCalls).toBe(1);
  });

  test('resolves a cross-event owner without deleting retained manifests or canonical bytes', async () => {
    const storage = new NativePhotoDraftStorage();
    const currentManifest = manifest();
    const currentUri = currentManifest.localUri;
    files.set(currentUri, JPEG);
    await storage.save(currentManifest, null);

    const foreign = owner({
      draftId: ids.otherDraft,
      selectionId: ids.otherSelection,
      eventId: ids.otherEvent,
      sessionId: ids.otherSession,
    });
    const foreignUri = `${DRAFT_DIRECTORY_URI}${foreign.draftId}.private-photo`;
    files.set(foreignUri, OTHER_JPEG);
    await beginOwner(storage, foreign);

    await expect(storage.discardPendingSelection(foreign)).resolves.toBe(
      'discarded-uncommitted',
    );
    expect(await storage.load(ids.event)).toEqual(currentManifest);
    expect(files.get(currentUri)).toEqual(JPEG);
    expect(files.has(foreignUri)).toBe(false);
    expect(await storage.loadPendingSelection()).toBeNull();
  });

  test('releases an exact committed owner but fails closed on same-draft session ambiguity', async () => {
    const storage = new NativePhotoDraftStorage();
    const committedOwner = owner();
    const committedManifest = manifest();
    const canonicalUri = committedManifest.localUri;
    files.set(canonicalUri, JPEG);
    await beginOwner(storage, committedOwner);
    await storage.save(committedManifest, null);

    await expect(storage.discardPendingSelection(committedOwner)).resolves.toBe(
      'released-committed',
    );
    expect(await storage.load(ids.event)).toEqual(committedManifest);
    expect(files.get(canonicalUri)).toEqual(JPEG);

    const ambiguousOwner = owner({
      selectionId: ids.otherSelection,
      sessionId: ids.otherSession,
    });
    await beginOwner(storage, ambiguousOwner);
    await expect(
      storage.discardPendingSelection(ambiguousOwner),
    ).rejects.toThrow('another session');
    expect(await storage.loadPendingSelection()).toEqual(ambiguousOwner);
    expect(await storage.load(ids.event)).toEqual(committedManifest);
    expect(files.get(canonicalUri)).toEqual(JPEG);
  });

  test('atomically discards only the exact prior-session manifest', async () => {
    const storage = new NativePhotoDraftStorage();
    const prior = manifest();
    files.set(prior.localUri, JPEG);
    await storage.save(prior, null);

    await expect(
      storage.discardPriorSessionManifest(prior, ids.session),
    ).rejects.toThrow('current session');
    expect(await storage.load(ids.event)).toEqual(prior);
    expect(files.get(prior.localUri)).toEqual(JPEG);

    const stale = manifest({ altText: 'Changed retained description' });
    await expect(
      storage.discardPriorSessionManifest(stale, ids.otherSession),
    ).rejects.toThrow('changed before local cleanup');
    expect(await storage.load(ids.event)).toEqual(prior);
    expect(files.get(prior.localUri)).toEqual(JPEG);

    const conflictingPending = owner({
      selectionId: ids.otherSelection,
      sessionId: ids.otherSession,
    });
    await beginOwner(storage, conflictingPending);
    await expect(
      storage.discardPriorSessionManifest(prior, ids.otherSession),
    ).rejects.toThrow('conflicts with a pending photo selection');
    expect(await storage.load(ids.event)).toEqual(prior);
    expect(files.get(prior.localUri)).toEqual(JPEG);
    await storage.clearPendingSelection(conflictingPending);

    await storage.discardPriorSessionManifest(prior, ids.otherSession);
    expect(await storage.load(ids.event)).toBeNull();
    expect(files.has(prior.localUri)).toBe(false);
  });

  test('drains Android exactly once before recovering existing canonical or staging bytes', async () => {
    const storage = new NativePhotoDraftStorage();
    const first = owner();
    await beginOwner(storage, first);
    const canonicalUri = `${DRAFT_DIRECTORY_URI}${first.draftId}.private-photo`;
    files.set(canonicalUri, JPEG);
    pendingResult = {
      canceled: false,
      assets: [{ uri: 'file:///picker/unrelated.jpg', type: 'image' }],
    };
    await storage.withPendingSelection(first, async (lease) => {
      expect((await lease.recover())?.localUri).toBe(canonicalUri);
      expect((await lease.recover())?.localUri).toBe(canonicalUri);
    });
    expect(pendingResultCalls).toBe(1);
    await storage.discardPendingSelection(first);
    expect(pendingResultCalls).toBe(1);

    const staged = owner({
      draftId: ids.otherDraft,
      selectionId: ids.otherSelection,
      eventId: ids.otherEvent,
    });
    await beginOwner(storage, staged);
    files.set(
      `${DRAFT_DIRECTORY_URI}${staged.draftId}.${staged.selectionId}.pending-photo`,
      OTHER_JPEG,
    );
    const recovered = await storage.withPendingSelection(
      staged,
      async (lease) => lease.recover(),
    );
    expect(recovered?.localUri).toBe(
      `${DRAFT_DIRECTORY_URI}${staged.draftId}.private-photo`,
    );
    expect(pendingResultCalls).toBe(2);
    await storage.discardPendingSelection(staged);
    expect(files.has(recovered!.localUri)).toBe(false);
  });

  test('replaces only exact invalid staging with a valid owner-leased Android result', async () => {
    const storage = new NativePhotoDraftStorage();
    const retainedOwner = owner();
    await beginOwner(storage, retainedOwner);
    const stagingUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.${retainedOwner.selectionId}.pending-photo`;
    files.set(stagingUri, new Uint8Array([0x01, 0x02, 0x03]));
    const sourceUri = 'file:///picker/recovered.jpg';
    files.set(sourceUri, OTHER_JPEG);
    pendingResult = {
      canceled: false,
      assets: [{ uri: sourceUri, type: 'image' }],
    };

    const recovered = await storage.withPendingSelection(
      retainedOwner,
      async (lease) => lease.recover(),
    );
    const canonicalUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.private-photo`;
    expect(recovered?.localUri).toBe(canonicalUri);
    expect(files.get(canonicalUri)).toEqual(OTHER_JPEG);
    expect(files.has(stagingUri)).toBe(false);
    expect(pendingResultCalls).toBe(1);
    await storage.discardPendingSelection(retainedOwner);
  });

  test('adopts a committed staging move rejection without deleting its mutated destination', async () => {
    const storage = new NativePhotoDraftStorage();
    const retainedOwner = owner();
    await beginOwner(storage, retainedOwner);
    const stagingUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.${retainedOwner.selectionId}.pending-photo`;
    const canonicalUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.private-photo`;
    files.set(stagingUri, JPEG);
    const replacementUri = 'file:///picker/replacement.jpg';
    files.set(replacementUri, OTHER_JPEG);
    pendingResult = {
      canceled: false,
      assets: [{ uri: replacementUri, type: 'image' }],
    };
    moveFault = 'after-move';

    const recovered = await storage.withPendingSelection(
      retainedOwner,
      async (lease) => lease.recover(),
    );
    expect(recovered?.localUri).toBe(canonicalUri);
    expect(files.get(canonicalUri)).toEqual(JPEG);
    expect(files.has(stagingUri)).toBe(false);
    await storage.discardPendingSelection(retainedOwner);
  });

  test('preserves conflicting valid canonical and staging recovery evidence', async () => {
    const storage = new NativePhotoDraftStorage();
    const retainedOwner = owner();
    await beginOwner(storage, retainedOwner);
    const stagingUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.${retainedOwner.selectionId}.pending-photo`;
    const canonicalUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.private-photo`;
    files.set(stagingUri, OTHER_JPEG);
    files.set(canonicalUri, JPEG);

    await expect(
      storage.withPendingSelection(retainedOwner, async (lease) =>
        lease.recover(),
      ),
    ).rejects.toThrow('recovery evidence conflicts');
    expect(files.get(stagingUri)).toEqual(OTHER_JPEG);
    expect(files.get(canonicalUri)).toEqual(JPEG);
    await storage.discardPendingSelection(retainedOwner);
  });

  test('distinguishes proved Android cancellation from an absent pending result', async () => {
    const storage = new NativePhotoDraftStorage();
    const canceledOwner = owner();
    await beginOwner(storage, canceledOwner);
    pendingResult = { canceled: true, assets: null };
    expect(
      await storage.withPendingSelection(canceledOwner, async (lease) =>
        lease.recover(),
      ),
    ).toBeNull();
    expect(await storage.loadPendingSelection()).toBeNull();

    const absentOwner = owner({ selectionId: ids.otherSelection });
    await beginOwner(storage, absentOwner);
    pendingResult = null;
    expect(
      await storage.withPendingSelection(absentOwner, async (lease) =>
        lease.recover(),
      ),
    ).toBeNull();
    expect(await storage.loadPendingSelection()).toEqual(absentOwner);
    await storage.discardPendingSelection(absentOwner);
  });

  test('never overwrites or deletes a pre-existing canonical private file', async () => {
    const storage = new NativePhotoDraftStorage();
    const retainedOwner = owner();
    const canonicalUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.private-photo`;
    files.set(canonicalUri, JPEG);
    const sourceUri = 'file:///picker/replacement.jpg';
    files.set(sourceUri, OTHER_JPEG);
    launchResult = {
      canceled: false,
      assets: [{ uri: sourceUri, type: 'image' }],
    };

    await expect(
      storage.withNewPendingSelection(retainedOwner, async (lease) =>
        lease.select(),
      ),
    ).rejects.toThrow('already owns private bytes');
    expect(await storage.loadPendingSelection()).toEqual(retainedOwner);
    expect(files.get(canonicalUri)).toEqual(JPEG);
    await storage.discardPendingSelection(retainedOwner);
  });

  test('uses the system picker without broad permission and clears only proved-empty failed selections', async () => {
    const storage = new NativePhotoDraftStorage();

    permissionGranted = false;
    expect(
      await storage.withNewPendingSelection(owner(), async (lease) =>
        lease.select(),
      ),
    ).toBeNull();
    expect(await storage.loadPendingSelection()).toBeNull();
    expect(permissionCalls).toBe(0);
    expect(launchCalls).toBe(1);
    expect(pendingResultCalls).toBe(1);

    permissionGranted = true;
    expect(
      await storage.withNewPendingSelection(owner(), async (lease) =>
        lease.select(),
      ),
    ).toBeNull();
    expect(await storage.loadPendingSelection()).toBeNull();
    expect(permissionCalls).toBe(0);
    expect(pendingResultCalls).toBe(2);

    const invalidOwner = owner({ selectionId: ids.otherSelection });
    launchResult = { canceled: false, assets: [] };
    await expect(
      storage.withNewPendingSelection(invalidOwner, async (lease) =>
        lease.select(),
      ),
    ).rejects.toThrow('exactly one photo');
    expect(await storage.loadPendingSelection()).toBeNull();
    expect(pendingResultCalls).toBe(3);

    const thrownOwner = owner({ draftId: ids.otherDraft });
    launchError = new Error('synthetic picker launch rejection');
    await expect(
      storage.withNewPendingSelection(thrownOwner, async (lease) =>
        lease.select(),
      ),
    ).rejects.toThrow('synthetic picker launch rejection');
    expect(await storage.loadPendingSelection()).toBeNull();
    expect(pendingResultCalls).toBe(4);
    expect(permissionCalls).toBe(0);
    expect(
      files.has(
        `${DRAFT_DIRECTORY_URI}${thrownOwner.draftId}.${thrownOwner.selectionId}.pending-photo`,
      ),
    ).toBe(false);
  });

  test('automatic cancel and stale-scope clear preserve a valid drained Android asset', async () => {
    const storage = new NativePhotoDraftStorage();
    const sourceUri = 'file:///picker/android-recovered.jpg';
    files.set(sourceUri, JPEG);
    pendingResult = {
      canceled: false,
      assets: [{ uri: sourceUri, type: 'image' }],
    };
    const canceledOwner = owner();
    const recoveredFromCancel = await storage.withNewPendingSelection(
      canceledOwner,
      async (lease) => lease.select(),
    );
    expect(recoveredFromCancel?.localUri).toBe(
      `${DRAFT_DIRECTORY_URI}${canceledOwner.draftId}.private-photo`,
    );
    expect(await storage.loadPendingSelection()).toEqual(canceledOwner);
    expect(pendingResultCalls).toBe(1);
    await storage.discardPendingSelection(canceledOwner);

    const staleOwner = owner({
      selectionId: ids.otherSelection,
      draftId: ids.otherDraft,
      eventId: ids.otherEvent,
    });
    const staleSourceUri = 'file:///picker/stale-scope-recovered.jpg';
    files.set(staleSourceUri, OTHER_JPEG);
    pendingResult = {
      canceled: false,
      assets: [{ uri: staleSourceUri, type: 'image' }],
    };
    const recoveredFromStaleClear = await storage.withNewPendingSelection(
      staleOwner,
      async (lease) => {
        expect(await lease.clearBeforeCopy()).toBe(false);
        return lease.recover();
      },
    );
    expect(recoveredFromStaleClear?.localUri).toBe(
      `${DRAFT_DIRECTORY_URI}${staleOwner.draftId}.private-photo`,
    );
    expect(await storage.loadPendingSelection()).toEqual(staleOwner);
    expect(pendingResultCalls).toBe(2);
    await storage.discardPendingSelection(staleOwner);
  });

  test('serializes manifest commit against pending discard in both directions', async () => {
    const commitWinsStorage = new NativePhotoDraftStorage();
    const retainedOwner = owner();
    const canonicalUri = `${DRAFT_DIRECTORY_URI}${retainedOwner.draftId}.private-photo`;
    files.set(canonicalUri, JPEG);
    const leaseReady = deferred();
    const allowCommit = deferred();
    const commit = commitWinsStorage.withNewPendingSelection(
      retainedOwner,
      async (lease) => {
        leaseReady.resolve();
        await allowCommit.promise;
        await lease.storage.save(manifest(), null);
      },
    );
    await leaseReady.promise;
    const losingDiscard =
      commitWinsStorage.discardPendingSelection(retainedOwner);
    allowCommit.resolve();
    await commit;
    await expect(losingDiscard).rejects.toThrow('no longer retained');
    expect(await commitWinsStorage.load(ids.event)).toEqual(manifest());
    expect(files.get(canonicalUri)).toEqual(JPEG);

    files.clear();
    pendingResultCalls = 0;
    pendingResult = null;
    const discardWinsStorage = new NativePhotoDraftStorage();
    await beginOwner(discardWinsStorage, retainedOwner);
    files.set(canonicalUri, JPEG);
    const drainStarted = deferred();
    const allowDrain = deferred<unknown>();
    pendingResultImplementation = async () => {
      drainStarted.resolve();
      return allowDrain.promise;
    };
    const discard = discardWinsStorage.discardPendingSelection(retainedOwner);
    await drainStarted.promise;
    const losingCommit = discardWinsStorage.withPendingSelection(
      retainedOwner,
      async (lease) => lease.storage.save(manifest(), null),
    );
    allowDrain.resolve(null);
    await discard;
    await expect(losingCommit).rejects.toThrow('no longer retained');
    expect(await discardWinsStorage.load(ids.event)).toBeNull();
    expect(files.has(canonicalUri)).toBe(false);
  });

  test('rejects stale cross-owner callbacks before consuming or launching for the new owner', async () => {
    const storage = new NativePhotoDraftStorage();
    const first = owner();
    const second = owner({
      selectionId: ids.otherSelection,
      draftId: ids.otherDraft,
      eventId: ids.otherEvent,
    });
    const firstReady = deferred();
    const releaseFirst = deferred();
    let staleLease: PendingPhotoSelectionLease | null = null;
    const firstOperation = storage.withNewPendingSelection(
      first,
      async (lease) => {
        staleLease = lease;
        firstReady.resolve();
        await releaseFirst.promise;
        await lease.clearBeforeCopy();
      },
    );
    await firstReady.promise;
    const secondReady = deferred();
    const releaseSecond = deferred();
    const secondOperation = storage.withNewPendingSelection(
      second,
      async (lease) => {
        secondReady.resolve();
        await releaseSecond.promise;
        await lease.clearBeforeCopy();
      },
    );
    releaseFirst.resolve();
    await firstOperation;
    await secondReady.promise;
    const callsBeforeStale = pendingResultCalls;
    const launchesBeforeStale = launchCalls;
    const capturedStaleLease = staleLease as PendingPhotoSelectionLease | null;
    if (capturedStaleLease === null) {
      throw new Error('Synthetic stale lease was not captured.');
    }
    await expect(capturedStaleLease.recover()).rejects.toThrow(
      'no longer active',
    );
    expect(pendingResultCalls).toBe(callsBeforeStale);
    expect(launchCalls).toBe(launchesBeforeStale);
    expect(await storage.loadPendingSelection()).toEqual(second);
    releaseSecond.resolve();
    await secondOperation;
  });
});
