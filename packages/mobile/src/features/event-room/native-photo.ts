import {
  EventIdSchema,
  UuidSchema,
  type MediaContentType,
} from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths, UploadType } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import {
  PhotoDraftOperationError,
  parsePhotoDraftManifest,
  type PhotoDraftManifest,
  type PhotoDraftStorage,
} from './photo-draft';

const MAX_PHOTO_BYTES = 25 * 1_024 * 1_024;
const DRAFT_DIRECTORY_NAME = 'event-photo-drafts';
const STORAGE_JOURNAL_VERSION = 1 as const;
const JOURNAL_SLOTS = ['a', 'b'] as const;

type JournalSlot = (typeof JOURNAL_SLOTS)[number];
type JournalKind = 'manifest' | 'composer' | 'pending-selection';

export interface PendingPhotoSelectionOwner {
  readonly version: 1;
  readonly selectionId: string;
  readonly draftId: string;
  readonly eventId: string;
  readonly sessionId: string;
}

interface JournalRecord<Value> {
  readonly slot: JournalSlot;
  readonly sequence: number;
  readonly checksumSha256: string;
  readonly value: Value | null;
}

interface RawJournalRecord {
  readonly slot: JournalSlot;
  readonly sequence: number;
  readonly checksumSha256: string;
  readonly state: 'value' | 'deleted';
  readonly valueJson: string | null;
}

interface JournalDescriptor<Value> {
  readonly kind: JournalKind;
  readonly key: string;
  readonly basename: string;
  readonly parseValue: (value: unknown) => Value;
}

const journalTails = new Map<string, Promise<void>>();
const PENDING_OWNER_LEASE_KEY = 'pending-photo-owner-lease';
const drainedPendingResults = new Map<
  string,
  ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null
>();

export interface PrivatePhotoFile {
  readonly localUri: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly declaredContentType: MediaContentType;
}

class InvalidPrivatePhotoError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPrivatePhotoError';
  }
}

function hasBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/** Client-side defense in depth; the server still decodes/sniffs/rewrites. */
export function sniffPhotoContentType(
  bytes: Uint8Array,
): MediaContentType | null {
  if (hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }
  return null;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function draftDirectory(): Directory {
  const directory = new Directory(Paths.document, DRAFT_DIRECTORY_NAME);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The retained private photo record is invalid.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function parsePendingOwner(value: unknown): PendingPhotoSelectionOwner {
  const record = asRecord(value);
  if (
    !exactKeys(record, [
      'version',
      'selectionId',
      'draftId',
      'eventId',
      'sessionId',
    ]) ||
    record.version !== 1
  ) {
    throw new Error('The pending photo selection has an invalid owner.');
  }
  const selectionId = UuidSchema.parse(record.selectionId);
  const draftId = UuidSchema.parse(record.draftId);
  const eventId = EventIdSchema.parse(record.eventId);
  const sessionId = UuidSchema.parse(record.sessionId);
  if (
    selectionId !== record.selectionId ||
    draftId !== record.draftId ||
    eventId !== record.eventId ||
    sessionId !== record.sessionId
  ) {
    throw new Error('The pending photo selection has an invalid owner.');
  }
  return Object.freeze({
    version: 1,
    selectionId,
    draftId,
    eventId,
    sessionId,
  });
}

function samePendingOwner(
  left: PendingPhotoSelectionOwner,
  right: PendingPhotoSelectionOwner,
): boolean {
  return (
    left.version === right.version &&
    left.selectionId === right.selectionId &&
    left.draftId === right.draftId &&
    left.eventId === right.eventId &&
    left.sessionId === right.sessionId
  );
}

function pendingOwnerKey(owner: PendingPhotoSelectionOwner): string {
  return [
    owner.selectionId,
    owner.draftId,
    owner.eventId,
    owner.sessionId,
  ].join(':');
}

function parseComposer(
  value: unknown,
  eventId: string,
  sessionId: string,
): Readonly<{
  eventId: string;
  sessionId: string;
  altText: string;
  caption: string | null;
}> {
  const record = asRecord(value);
  if (
    !exactKeys(record, ['eventId', 'sessionId', 'altText', 'caption']) ||
    record.eventId !== eventId ||
    record.sessionId !== sessionId ||
    typeof record.altText !== 'string' ||
    record.altText.length > 500 ||
    (record.caption !== null && typeof record.caption !== 'string') ||
    (typeof record.caption === 'string' && record.caption.length > 2_000)
  ) {
    throw new Error('The retained photo description has another owner.');
  }
  return Object.freeze({
    eventId,
    sessionId,
    altText: record.altText,
    caption: record.caption,
  });
}

function manifestJournal(
  eventIdValue: string,
): JournalDescriptor<PhotoDraftManifest> {
  const eventId = EventIdSchema.parse(eventIdValue);
  return {
    kind: 'manifest',
    key: `manifest:${eventId}`,
    basename: `${eventId}.manifest`,
    parseValue(value) {
      const manifest = parsePhotoDraftManifest(value);
      if (manifest.eventId !== eventId) {
        throw new Error('The retained photo manifest has another event owner.');
      }
      privateDraftFile(manifest.localUri, manifest.draftId);
      return manifest;
    },
  };
}

function composerJournal(
  eventIdValue: string,
  sessionIdValue: string,
): JournalDescriptor<ReturnType<typeof parseComposer>> {
  const eventId = EventIdSchema.parse(eventIdValue);
  const sessionId = UuidSchema.parse(sessionIdValue);
  return {
    kind: 'composer',
    key: `composer:${eventId}:${sessionId}`,
    basename: `${eventId}.${sessionId}.composer`,
    parseValue: (value) => parseComposer(value, eventId, sessionId),
  };
}

function pendingSelectionJournal(): JournalDescriptor<PendingPhotoSelectionOwner> {
  return {
    kind: 'pending-selection',
    key: 'pending-selection',
    basename: 'pending-selection',
    parseValue: parsePendingOwner,
  };
}

function journalFile<Value>(
  descriptor: JournalDescriptor<Value>,
  slot: JournalSlot,
): File {
  return new File(draftDirectory(), `${descriptor.basename}.${slot}.json`);
}

function journalChecksumInput(
  descriptor: Readonly<Pick<JournalDescriptor<unknown>, 'kind' | 'key'>>,
  sequence: number,
  state: 'value' | 'deleted',
  valueJson: string | null,
): string {
  return JSON.stringify([
    STORAGE_JOURNAL_VERSION,
    descriptor.kind,
    descriptor.key,
    sequence,
    state,
    valueJson,
  ]);
}

async function checksumJournal(
  descriptor: Readonly<Pick<JournalDescriptor<unknown>, 'kind' | 'key'>>,
  sequence: number,
  state: 'value' | 'deleted',
  valueJson: string | null,
): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    journalChecksumInput(descriptor, sequence, state, valueJson),
  );
}

async function readRawJournalSlot<Value>(
  descriptor: JournalDescriptor<Value>,
  slot: JournalSlot,
): Promise<Readonly<{ exists: boolean; record: RawJournalRecord | null }>> {
  const file = journalFile(descriptor, slot);
  if (!file.exists) return { exists: false, record: null };
  try {
    const envelope = asRecord(JSON.parse(await file.text()) as unknown);
    if (
      !exactKeys(envelope, [
        'version',
        'kind',
        'key',
        'sequence',
        'state',
        'valueJson',
        'checksumSha256',
      ]) ||
      envelope.version !== STORAGE_JOURNAL_VERSION ||
      envelope.kind !== descriptor.kind ||
      envelope.key !== descriptor.key ||
      !Number.isSafeInteger(envelope.sequence) ||
      (envelope.sequence as number) < 1 ||
      (envelope.state !== 'value' && envelope.state !== 'deleted') ||
      (envelope.state === 'deleted' && envelope.valueJson !== null) ||
      (envelope.state === 'value' && typeof envelope.valueJson !== 'string') ||
      typeof envelope.checksumSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(envelope.checksumSha256)
    ) {
      return { exists: true, record: null };
    }
    const sequence = envelope.sequence as number;
    const state = envelope.state;
    const valueJson = envelope.valueJson as string | null;
    const checksumSha256 = envelope.checksumSha256;
    if (
      checksumSha256 !==
      (await checksumJournal(descriptor, sequence, state, valueJson))
    ) {
      return { exists: true, record: null };
    }
    return {
      exists: true,
      record: Object.freeze({
        slot,
        sequence,
        checksumSha256,
        state,
        valueJson,
      }),
    };
  } catch {
    // The other journal slot remains authoritative after a torn write.
    return { exists: true, record: null };
  }
}

async function readJournal<Value>(
  descriptor: JournalDescriptor<Value>,
): Promise<JournalRecord<Value> | null> {
  const slots = await Promise.all(
    JOURNAL_SLOTS.map((slot) => readRawJournalSlot(descriptor, slot)),
  );
  const records = slots
    .map(({ record }) => record)
    .filter((record): record is RawJournalRecord => record !== null);
  if (records.length === 0) {
    if (slots.some(({ exists }) => exists)) {
      throw new Error('Both private photo journal slots are invalid.');
    }
    return null;
  }
  records.sort((left, right) =>
    left.sequence === right.sequence
      ? left.slot.localeCompare(right.slot)
      : left.sequence - right.sequence,
  );
  const latest = records.at(-1)!;
  const sameGeneration = records.filter(
    (record) => record.sequence === latest.sequence,
  );
  if (
    sameGeneration.length > 1 &&
    new Set(sameGeneration.map((record) => record.checksumSha256)).size > 1
  ) {
    throw new Error('The private photo journal has conflicting latest slots.');
  }
  return Object.freeze({
    slot: latest.slot,
    sequence: latest.sequence,
    checksumSha256: latest.checksumSha256,
    value:
      latest.state === 'deleted'
        ? null
        : descriptor.parseValue(JSON.parse(latest.valueJson!)),
  });
}

async function withJournalLock<Value>(
  key: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const previous = journalTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => held);
  journalTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (journalTails.get(key) === tail) journalTails.delete(key);
  }
}

async function writeJournal<Value>(
  descriptor: JournalDescriptor<Value>,
  value: Value | null,
  current: JournalRecord<Value> | null,
): Promise<void> {
  const sequence = (current?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) {
    throw new Error('The private photo journal sequence is exhausted.');
  }
  const slot: JournalSlot = current?.slot === 'a' ? 'b' : 'a';
  const destination = journalFile(descriptor, slot);
  const temporary = new File(
    draftDirectory(),
    `${Crypto.randomUUID()}.write-in-progress`,
  );
  const temporaryUri = temporary.uri;
  let temporaryCreated = false;
  try {
    temporary.create();
    temporaryCreated = true;
    const state = value === null ? 'deleted' : 'value';
    const valueJson = value === null ? null : JSON.stringify(value);
    const checksumSha256 = await checksumJournal(
      descriptor,
      sequence,
      state,
      valueJson,
    );
    temporary.write(
      JSON.stringify({
        version: STORAGE_JOURNAL_VERSION,
        kind: descriptor.kind,
        key: descriptor.key,
        sequence,
        state,
        valueJson,
        checksumSha256,
      }),
    );
    // Validate the complete temporary record before replacing only the
    // inactive slot. The previous highest sequence remains recoverable if the
    // process dies during Expo's non-atomic overwrite implementation.
    const parsedTemporary = asRecord(
      JSON.parse(await temporary.text()) as unknown,
    );
    if (parsedTemporary.sequence !== sequence) {
      throw new Error('The private photo journal write was incomplete.');
    }
    try {
      await temporary.move(destination, { overwrite: true });
      temporaryCreated = false;
    } catch (error) {
      // Expo's move can commit the replacement and still reject. Adopt that
      // uncertain native outcome only when the exact destination generation
      // and checksum prove this write landed; otherwise preserve the error.
      const committed = await readRawJournalSlot(descriptor, slot);
      if (
        committed.record?.sequence !== sequence ||
        committed.record.checksumSha256 !== checksumSha256
      ) {
        throw error;
      }
      // Keep cleanup armed for the captured original URI. Some native move
      // implementations leave that source behind even after committing the
      // destination; cleanup below can never target the destination URI.
    }
    const committed = await readRawJournalSlot(descriptor, slot);
    if (
      committed.record?.sequence !== sequence ||
      committed.record.checksumSha256 !== checksumSha256
    ) {
      throw new Error('The private photo journal write did not commit.');
    }
  } finally {
    if (temporaryCreated) {
      // File.move mutates the File object's URI. Cleanup may target only the
      // exact temporary path created above, never a destination it moved to.
      const originalTemporary = new File(temporaryUri);
      if (originalTemporary.exists) originalTemporary.delete();
    }
  }
}

function pruneJournalAfterTombstone<Value>(
  descriptor: JournalDescriptor<Value>,
  current: JournalRecord<Value> | null,
): void {
  if (current === null || current.value !== null) return;
  for (const slot of JOURNAL_SLOTS) {
    if (slot === current.slot) continue;
    const stale = journalFile(descriptor, slot);
    if (stale.exists) stale.delete();
  }
}

function sameManifestLineage(
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
    left.idempotencyKeys.appendEntry === right.idempotencyKeys.appendEntry
  );
}

function sameIdempotencyKeys(
  left: PhotoDraftManifest,
  right: PhotoDraftManifest,
): boolean {
  return (
    left.idempotencyKeys.createIntent === right.idempotencyKeys.createIntent &&
    left.idempotencyKeys.completeUpload ===
      right.idempotencyKeys.completeUpload &&
    left.idempotencyKeys.appendEntry === right.idempotencyKeys.appendEntry
  );
}

function isFreshUploadEpochTransition(
  previous: PhotoDraftManifest,
  next: PhotoDraftManifest,
): boolean {
  const previousKeys = Object.values(previous.idempotencyKeys);
  return (
    sameManifestLineage(previous, next) &&
    previous.altText === next.altText &&
    previous.caption === next.caption &&
    previous.stage === 'failed' &&
    (previous.retryStage === 'create-intent' ||
      previous.retryStage === 'upload-bytes' ||
      previous.retryStage === 'complete-upload') &&
    previous.mediaId === null &&
    next.stage === 'creating-intent' &&
    next.retryStage === null &&
    next.cleanupProof === null &&
    next.uploadIntentId === null &&
    next.mediaId === null &&
    next.idempotencyKeys.createIntent !==
      previous.idempotencyKeys.createIntent &&
    next.idempotencyKeys.completeUpload !==
      previous.idempotencyKeys.completeUpload &&
    !previousKeys.includes(next.idempotencyKeys.createIntent) &&
    !previousKeys.includes(next.idempotencyKeys.completeUpload) &&
    next.idempotencyKeys.createIntent !== next.idempotencyKeys.completeUpload
  );
}

function sameManifestState(
  left: PhotoDraftManifest,
  right: PhotoDraftManifest,
): boolean {
  return (
    sameManifestLineage(left, right) &&
    sameIdempotencyKeys(left, right) &&
    left.altText === right.altText &&
    left.caption === right.caption &&
    left.stage === right.stage &&
    left.retryStage === right.retryStage &&
    left.cleanupProof === right.cleanupProof &&
    left.uploadIntentId === right.uploadIntentId &&
    left.mediaId === right.mediaId
  );
}

async function readPendingOwnerJournal(): Promise<JournalRecord<PendingPhotoSelectionOwner> | null> {
  const descriptor = pendingSelectionJournal();
  return withJournalLock(descriptor.key, async () => {
    const current = await readJournal(descriptor);
    pruneJournalAfterTombstone(descriptor, current);
    return current;
  });
}

async function requirePendingOwner(
  owner: PendingPhotoSelectionOwner,
): Promise<JournalRecord<PendingPhotoSelectionOwner>> {
  const current = await readPendingOwnerJournal();
  if (current?.value === null || current?.value === undefined) {
    throw new Error('The pending photo selection owner is no longer retained.');
  }
  if (!samePendingOwner(current.value, owner)) {
    throw new Error('Another photo picker result owns the retained token.');
  }
  return current;
}

async function beginPendingOwner(
  owner: PendingPhotoSelectionOwner,
): Promise<void> {
  const descriptor = pendingSelectionJournal();
  await withJournalLock(descriptor.key, async () => {
    const current = await readJournal(descriptor);
    if (current?.value !== null && current?.value !== undefined) {
      if (samePendingOwner(current.value, owner)) return;
      throw new Error('Another photo picker result has a retained owner.');
    }
    drainedPendingResults.delete(pendingOwnerKey(owner));
    await writeJournal(descriptor, owner, current);
  });
}

async function drainPendingPickerResult(
  owner: PendingPhotoSelectionOwner,
): Promise<
  ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null
> {
  await requirePendingOwner(owner);
  const key = pendingOwnerKey(owner);
  if (drainedPendingResults.has(key)) {
    return drainedPendingResults.get(key) ?? null;
  }
  const result = await ImagePicker.getPendingResultAsync();
  drainedPendingResults.set(key, result);
  return result;
}

async function tombstonePendingOwner(
  owner: PendingPhotoSelectionOwner,
): Promise<void> {
  const descriptor = pendingSelectionJournal();
  await withJournalLock(descriptor.key, async () => {
    const current = await readJournal(descriptor);
    if (current === null || current.value === null) {
      pruneJournalAfterTombstone(descriptor, current);
      return;
    }
    if (!samePendingOwner(current.value, owner)) {
      throw new Error('Another photo picker result owns the retained token.');
    }
    await writeJournal(descriptor, null, current);
    const tombstone = await readJournal(descriptor);
    pruneJournalAfterTombstone(descriptor, tombstone);
  });
  drainedPendingResults.delete(pendingOwnerKey(owner));
}

export interface PendingPhotoSelectionLease {
  readonly owner: PendingPhotoSelectionOwner;
  /** Initial save commits the exact retained file and owner as one operation. */
  readonly storage: PhotoDraftStorage;
  select(): Promise<PrivatePhotoFile | null>;
  recover(): Promise<PrivatePhotoFile | null>;
  /** Returns true only when the exact owner was safely tombstoned. */
  clearBeforeCopy(): Promise<boolean>;
  clearAfterCommittedManifest(): Promise<void>;
}

/** Recoverable app-private storage with owner-checked, alternating slots. */
export class NativePhotoDraftStorage implements PhotoDraftStorage {
  public async load(eventId: string): Promise<unknown | null> {
    const descriptor = manifestJournal(eventId);
    return withJournalLock(descriptor.key, async () => {
      const current = await readJournal(descriptor);
      pruneJournalAfterTombstone(descriptor, current);
      return current?.value ?? null;
    });
  }

  public async save(
    manifestValue: PhotoDraftManifest,
    expectedValue: PhotoDraftManifest | null,
  ): Promise<void> {
    const manifest = parsePhotoDraftManifest(manifestValue);
    const expected =
      expectedValue === null ? null : parsePhotoDraftManifest(expectedValue);
    if (
      expected !== null &&
      (expected.eventId !== manifest.eventId ||
        (!sameIdempotencyKeys(expected, manifest) &&
          !isFreshUploadEpochTransition(expected, manifest)) ||
        !sameManifestLineage(expected, manifest))
    ) {
      throw new Error('A photo draft transition changed immutable lineage.');
    }
    const descriptor = manifestJournal(manifest.eventId);
    await withJournalLock(descriptor.key, async () => {
      const current = await readJournal(descriptor);
      const currentValue = current?.value ?? null;
      if (
        (expected === null && currentValue !== null) ||
        (expected !== null &&
          (currentValue === null || !sameManifestState(currentValue, expected)))
      ) {
        throw new Error('The retained photo draft changed before this write.');
      }
      await writeJournal(descriptor, manifest, current);
    });
  }

  public async deleteManifest(
    eventId: string,
    draftIdValue: string,
    expectedValue: PhotoDraftManifest,
  ): Promise<void> {
    const draftId = UuidSchema.parse(draftIdValue);
    const expected = parsePhotoDraftManifest(expectedValue);
    if (expected.eventId !== eventId || expected.draftId !== draftId) {
      throw new Error('The expected photo draft has another owner.');
    }
    const descriptor = manifestJournal(eventId);
    await withJournalLock(descriptor.key, async () => {
      const current = await readJournal(descriptor);
      if (current === null || current.value === null) {
        pruneJournalAfterTombstone(descriptor, current);
        return;
      }
      if (current.value.draftId !== draftId) {
        throw new Error('Another retained photo draft owns this event slot.');
      }
      if (!sameManifestState(current.value, expected)) {
        throw new Error('The retained photo draft changed before deletion.');
      }
      await writeJournal(descriptor, null, current);
      const tombstone = await readJournal(descriptor);
      pruneJournalAfterTombstone(descriptor, tombstone);
    });
  }

  public async loadComposer(
    eventId: string,
    sessionId: string,
  ): Promise<Readonly<{ altText: string; caption: string | null }> | null> {
    const descriptor = composerJournal(eventId, sessionId);
    const retained = await withJournalLock(descriptor.key, async () => {
      const current = await readJournal(descriptor);
      pruneJournalAfterTombstone(descriptor, current);
      return current?.value ?? null;
    });
    return retained === null || retained === undefined
      ? null
      : Object.freeze({
          altText: retained.altText,
          caption: retained.caption,
        });
  }

  public async saveComposer(
    eventId: string,
    sessionId: string,
    altText: string,
    caption: string | null,
  ): Promise<void> {
    const descriptor = composerJournal(eventId, sessionId);
    const composer = descriptor.parseValue({
      eventId: EventIdSchema.parse(eventId),
      sessionId: UuidSchema.parse(sessionId),
      altText,
      caption,
    });
    await withJournalLock(descriptor.key, async () => {
      const current = await readJournal(descriptor);
      await writeJournal(descriptor, composer, current);
    });
  }

  public async deleteComposer(
    eventId: string,
    sessionId: string,
  ): Promise<void> {
    const descriptor = composerJournal(eventId, sessionId);
    await withJournalLock(descriptor.key, async () => {
      const current = await readJournal(descriptor);
      if (current === null || current.value === null) {
        pruneJournalAfterTombstone(descriptor, current);
        return;
      }
      await writeJournal(descriptor, null, current);
      const tombstone = await readJournal(descriptor);
      pruneJournalAfterTombstone(descriptor, tombstone);
    });
  }

  public async loadPendingSelection(): Promise<PendingPhotoSelectionOwner | null> {
    return (await readPendingOwnerJournal())?.value ?? null;
  }

  /**
   * Requests permission before retaining an owner, then holds the one process-
   * global picker lease through the caller's file-to-manifest commit.
   */
  public async withNewPendingSelection<Value>(
    ownerValue: PendingPhotoSelectionOwner,
    operation: (lease: PendingPhotoSelectionLease) => Promise<Value>,
  ): Promise<Value> {
    const owner = parsePendingOwner(ownerValue);
    return withJournalLock(PENDING_OWNER_LEASE_KEY, async () => {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        throw new Error(
          'Photo access is required to select an event-journal image.',
        );
      }
      await beginPendingOwner(owner);
      return this.runPendingSelection(owner, operation);
    });
  }

  /** Resumes only the exact durable owner while holding the global lease. */
  public async withPendingSelection<Value>(
    ownerValue: PendingPhotoSelectionOwner,
    operation: (lease: PendingPhotoSelectionLease) => Promise<Value>,
  ): Promise<Value> {
    const owner = parsePendingOwner(ownerValue);
    return withJournalLock(PENDING_OWNER_LEASE_KEY, async () => {
      await requirePendingOwner(owner);
      return this.runPendingSelection(owner, operation);
    });
  }

  public async clearPendingSelection(
    ownerValue: PendingPhotoSelectionOwner,
  ): Promise<void> {
    const owner = parsePendingOwner(ownerValue);
    await withJournalLock(PENDING_OWNER_LEASE_KEY, async () => {
      const current = await readPendingOwnerJournal();
      if (current?.value === null || current?.value === undefined) {
        return;
      }
      if (!samePendingOwner(current.value, owner)) {
        throw new Error('Another photo picker result owns the retained token.');
      }
      await drainPendingPickerResult(owner);
      await tombstonePendingOwner(owner);
    });
  }

  /**
   * Discards only the exact pending owner while manifest absence, file removal,
   * and the pending-owner tombstone share one critical section.
   */
  public async discardPendingSelection(
    ownerValue: PendingPhotoSelectionOwner,
  ): Promise<void> {
    const owner = parsePendingOwner(ownerValue);
    await withJournalLock(PENDING_OWNER_LEASE_KEY, async () => {
      await requirePendingOwner(owner);
      await drainPendingPickerResult(owner);
      const manifestDescriptor = manifestJournal(owner.eventId);
      await withJournalLock(manifestDescriptor.key, async () => {
        const currentManifest = await readJournal(manifestDescriptor);
        if (
          currentManifest?.value !== null &&
          currentManifest?.value !== undefined
        ) {
          throw new Error('A retained manifest owns the private photo.');
        }
        deletePendingPrivatePhotoFiles(owner);
        await tombstonePendingOwner(owner);
      });
    });
  }

  private async runPendingSelection<Value>(
    owner: PendingPhotoSelectionOwner,
    operation: (lease: PendingPhotoSelectionLease) => Promise<Value>,
  ): Promise<Value> {
    let active = true;
    let initialSaveCommitted = false;
    const assertActive = (): void => {
      if (!active) {
        throw new Error('The pending photo owner lease is no longer active.');
      }
    };
    const pendingStorage: PhotoDraftStorage = Object.freeze({
      load: (eventId: string) => this.load(eventId),
      save: async (
        manifest: PhotoDraftManifest,
        expected: PhotoDraftManifest | null,
      ) => {
        if (expected !== null) {
          await this.save(manifest, expected);
          return;
        }
        assertActive();
        if (initialSaveCommitted) {
          throw new Error('The pending owner already committed its manifest.');
        }
        await commitPendingManifest(owner, manifest);
        initialSaveCommitted = true;
      },
      deleteManifest: (
        eventId: string,
        draftId: string,
        expected: PhotoDraftManifest,
      ) => this.deleteManifest(eventId, draftId, expected),
    });
    const lease: PendingPhotoSelectionLease = Object.freeze({
      owner,
      storage: pendingStorage,
      select: async () => {
        assertActive();
        await requirePendingOwner(owner);
        return selectOwnedPrivatePhoto(owner);
      },
      recover: async () => {
        assertActive();
        await requirePendingOwner(owner);
        return recoverOwnedPendingPrivatePhoto(owner);
      },
      clearBeforeCopy: async () => {
        assertActive();
        return clearProvedOwnerWithoutBytes(owner);
      },
      clearAfterCommittedManifest: async () => {
        assertActive();
        await clearOwnerAfterManifestCommit(owner);
      },
    });
    try {
      return await operation(lease);
    } finally {
      active = false;
    }
  }
}

async function commitPendingManifest(
  owner: PendingPhotoSelectionOwner,
  manifestValue: PhotoDraftManifest,
): Promise<void> {
  const manifest = parsePhotoDraftManifest(manifestValue);
  if (
    manifest.draftId !== owner.draftId ||
    manifest.eventId !== owner.eventId ||
    manifest.sessionId !== owner.sessionId ||
    manifest.stage !== 'ready'
  ) {
    throw new Error('The pending photo manifest has another owner or stage.');
  }
  await requirePendingOwner(owner);
  // Android exposes one global one-shot result. Drain it while this exact
  // owner still holds the process lease, even when canonical bytes exist.
  await drainPendingPickerResult(owner);
  const descriptor = manifestJournal(owner.eventId);
  await withJournalLock(descriptor.key, async () => {
    const current = await readJournal(descriptor);
    if (current?.value !== null && current?.value !== undefined) {
      throw new Error('Another retained photo draft owns this event slot.');
    }
    const retained = await inspectCanonicalOwnerPrivatePhoto(owner);
    if (
      retained.localUri !== manifest.localUri ||
      retained.byteLength !== manifest.byteLength ||
      retained.contentSha256 !== manifest.contentSha256 ||
      retained.declaredContentType !== manifest.declaredContentType
    ) {
      throw new Error('The pending private photo does not match its manifest.');
    }
    await writeJournal(descriptor, manifest, current);
    await tombstonePendingOwner(owner);
  });
}

async function clearOwnerAfterManifestCommit(
  owner: PendingPhotoSelectionOwner,
): Promise<void> {
  const pending = await readPendingOwnerJournal();
  if (pending?.value === null || pending?.value === undefined) return;
  if (!samePendingOwner(pending.value, owner)) {
    throw new Error('Another photo picker result owns the retained token.');
  }
  await drainPendingPickerResult(owner);
  const descriptor = manifestJournal(owner.eventId);
  await withJournalLock(descriptor.key, async () => {
    const current = await readJournal(descriptor);
    if (
      current?.value === null ||
      current?.value === undefined ||
      current.value.draftId !== owner.draftId ||
      current.value.sessionId !== owner.sessionId
    ) {
      throw new Error('The exact pending owner has no committed manifest.');
    }
    await tombstonePendingOwner(owner);
  });
}

async function clearProvedOwnerWithoutBytes(
  owner: PendingPhotoSelectionOwner,
): Promise<boolean> {
  const descriptor = manifestJournal(owner.eventId);
  return withJournalLock(descriptor.key, async () => {
    const current = await readJournal(descriptor);
    if (current?.value !== null && current?.value !== undefined) {
      throw new Error('A retained manifest owns the private photo.');
    }
    if (
      privateDraftDestination(owner.draftId).exists ||
      privateDraftInProgressFile(owner.draftId, owner.selectionId).exists
    ) {
      throw new Error('The pending owner still has private photo bytes.');
    }
    const drained = parsePickerResult(await drainPendingPickerResult(owner));
    if (drained.kind === 'asset') {
      // The Android one-shot still carries recoverable selection evidence.
      // Keep both the durable owner and in-memory drained result so the caller
      // can recover it under this same exact lease.
      return false;
    }
    await tombstonePendingOwner(owner);
    return true;
  });
}

function privateDraftFile(localUri: string, draftIdValue: string): File {
  const draftId = UuidSchema.parse(draftIdValue);
  const directoryUri = draftDirectory().uri;
  if (!localUri.startsWith(directoryUri)) {
    throw new Error('The photo draft is outside private event storage.');
  }
  const file = new File(localUri);
  if (
    file.parentDirectory.uri !== directoryUri ||
    file.name !== `${draftId}.private-photo`
  ) {
    throw new Error('The photo draft is outside private event storage.');
  }
  return file;
}

function privateDraftDestination(draftIdValue: string): File {
  return new File(
    draftDirectory(),
    `${UuidSchema.parse(draftIdValue)}.private-photo`,
  );
}

function privateDraftInProgressFile(
  draftIdValue: string,
  selectionIdValue: string,
): File {
  return new File(
    draftDirectory(),
    `${UuidSchema.parse(draftIdValue)}.${UuidSchema.parse(selectionIdValue)}.pending-photo`,
  );
}

async function inspectPrivatePhotoFile(file: File): Promise<PrivatePhotoFile> {
  if (!file.exists || file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
    throw new InvalidPrivatePhotoError(
      'The selected photo must be between 1 byte and 25 MB.',
    );
  }
  const bytes = await file.bytes();
  const declaredContentType = sniffPhotoContentType(bytes);
  if (declaredContentType === null) {
    throw new InvalidPrivatePhotoError(
      'Select a valid JPEG, PNG, WebP, or HEIC image.',
    );
  }
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    bytes,
  );
  return Object.freeze({
    localUri: file.uri,
    byteLength: file.size,
    contentSha256: hex(digest),
    declaredContentType,
  });
}

async function inspectCanonicalOwnerPrivatePhoto(
  owner: PendingPhotoSelectionOwner,
): Promise<PrivatePhotoFile> {
  const destination = privateDraftDestination(owner.draftId);
  const retained = await inspectPrivatePhotoFile(destination);
  const inProgress = privateDraftInProgressFile(
    owner.draftId,
    owner.selectionId,
  );
  if (!inProgress.exists) return retained;

  const stagingUri = inProgress.uri;
  let staging: PrivatePhotoFile | null = null;
  try {
    staging = await inspectPrivatePhotoFile(inProgress);
  } catch (error) {
    // A malformed staging remnant cannot displace a valid canonical file,
    // while an unknown read/digest failure preserves both files.
    if (!(error instanceof InvalidPrivatePhotoError)) throw error;
  }
  if (
    staging !== null &&
    (staging.byteLength !== retained.byteLength ||
      staging.contentSha256 !== retained.contentSha256 ||
      staging.declaredContentType !== retained.declaredContentType)
  ) {
    throw new Error(
      'The canonical and staging photo recovery evidence conflicts.',
    );
  }
  const exactStaging = new File(stagingUri);
  if (exactStaging.exists) exactStaging.delete();
  return retained;
}

async function retainAssetPrivately(
  asset: ImagePicker.ImagePickerAsset,
  ownerValue: PendingPhotoSelectionOwner,
): Promise<PrivatePhotoFile> {
  if (
    asset.type !== undefined &&
    asset.type !== null &&
    asset.type !== 'image'
  ) {
    throw new Error('Select a still image for the event journal.');
  }
  const owner = parsePendingOwner(ownerValue);
  const destination = privateDraftDestination(owner.draftId);
  const inProgress = privateDraftInProgressFile(
    owner.draftId,
    owner.selectionId,
  );
  if (destination.exists || inProgress.exists) {
    throw new Error('This photo selection token already owns private bytes.');
  }
  let ownsInProgress = false;
  try {
    // Exclusive creation establishes which invocation may clean this staging
    // file. The picker copy never targets a pre-existing retained photo.
    inProgress.create();
    ownsInProgress = true;
    await new File(asset.uri).copy(inProgress, { overwrite: true });
    // A completed copy is recovery evidence until content validation proves it
    // invalid. Unknown read/digest failures must not discard those bytes.
    ownsInProgress = false;
    const retained = await inspectPrivatePhotoFile(inProgress);
    // From this point the complete staging file is durable recovery evidence;
    // a move failure or uncertain native result must not delete it.
    await inProgress.move(destination);
    return Object.freeze({ ...retained, localUri: destination.uri });
  } catch (error) {
    if (inProgress.exists) {
      if (
        error instanceof InvalidPrivatePhotoError ||
        (ownsInProgress && inProgress.size === 0)
      ) {
        inProgress.delete();
      }
    }
    throw error;
  }
}

type ParsedPickerResult =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'canceled' }>
  | Readonly<{ kind: 'invalid'; error: Error }>
  | Readonly<{ kind: 'asset'; asset: ImagePicker.ImagePickerAsset }>;

function parsePickerResult(
  result:
    | ImagePicker.ImagePickerResult
    | ImagePicker.ImagePickerErrorResult
    | null,
): ParsedPickerResult {
  if (result === null) return Object.freeze({ kind: 'absent' });
  if ('canceled' in result && result.canceled) {
    return Object.freeze({ kind: 'canceled' });
  }
  if ('code' in result) {
    return Object.freeze({
      kind: 'invalid',
      error: new Error('PSD EOC could not recover the selected photo safely.'),
    });
  }
  const asset = result.assets[0];
  if (asset === undefined || result.assets.length !== 1) {
    return Object.freeze({
      kind: 'invalid',
      error: new Error('Select exactly one photo.'),
    });
  }
  return Object.freeze({ kind: 'asset', asset });
}

async function validatePickerAsset(
  asset: ImagePicker.ImagePickerAsset,
): Promise<void> {
  if (
    asset.type !== undefined &&
    asset.type !== null &&
    asset.type !== 'image'
  ) {
    throw new Error('Select a still image for the event journal.');
  }
  await inspectPrivatePhotoFile(new File(asset.uri));
}

async function retainOrClearProvedFailure(
  owner: PendingPhotoSelectionOwner,
  asset: ImagePicker.ImagePickerAsset,
): Promise<PrivatePhotoFile | null> {
  try {
    return await retainAssetPrivately(asset, owner);
  } catch (error) {
    if (
      !privateDraftDestination(owner.draftId).exists &&
      !privateDraftInProgressFile(owner.draftId, owner.selectionId).exists
    ) {
      await clearProvedOwnerWithoutBytes(owner);
    }
    throw error;
  }
}

/** Runs only while the exact owner holds the process-global picker lease. */
async function selectOwnedPrivatePhoto(
  owner: PendingPhotoSelectionOwner,
): Promise<PrivatePhotoFile | null> {
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      allowsMultipleSelection: false,
      selectionLimit: 1,
      quality: 1,
      exif: false,
      base64: false,
    });
  } catch (error) {
    if (
      !privateDraftDestination(owner.draftId).exists &&
      !privateDraftInProgressFile(owner.draftId, owner.selectionId).exists
    ) {
      const cleared = await clearProvedOwnerWithoutBytes(owner);
      if (!cleared) {
        const recovered = await recoverOwnedPendingPrivatePhoto(owner);
        if (recovered !== null) return recovered;
      }
    }
    throw error;
  }
  const parsed = parsePickerResult(result);
  if (parsed.kind === 'asset') {
    return retainOrClearProvedFailure(owner, parsed.asset);
  }
  if (parsed.kind === 'absent' || parsed.kind === 'invalid') {
    const cleared = await clearProvedOwnerWithoutBytes(owner);
    if (!cleared) {
      const recovered = await recoverOwnedPendingPrivatePhoto(owner);
      if (recovered !== null) return recovered;
    }
    throw parsed.kind === 'invalid'
      ? parsed.error
      : new Error('PSD EOC returned no photo-picker result.');
  }
  const cleared = await clearProvedOwnerWithoutBytes(owner);
  if (!cleared) return recoverOwnedPendingPrivatePhoto(owner);
  return null;
}

/** Drains Android first, then recovers only files derived from this owner. */
async function recoverOwnedPendingPrivatePhoto(
  owner: PendingPhotoSelectionOwner,
): Promise<PrivatePhotoFile | null> {
  const parsed = parsePickerResult(await drainPendingPickerResult(owner));
  const destination = privateDraftDestination(owner.draftId);
  const inProgress = privateDraftInProgressFile(
    owner.draftId,
    owner.selectionId,
  );

  if (destination.exists) {
    return inspectCanonicalOwnerPrivatePhoto(owner);
  }

  if (inProgress.exists) {
    const stagingUri = inProgress.uri;
    let retained: PrivatePhotoFile;
    try {
      retained = await inspectPrivatePhotoFile(inProgress);
    } catch (stagingError) {
      if (
        !(stagingError instanceof InvalidPrivatePhotoError) ||
        parsed.kind !== 'asset'
      ) {
        throw stagingError;
      }
      // Validate the replacement before removing only this exact owner's
      // invalid staging path. An invalid canonical destination is never
      // replaced by a picker callback.
      await validatePickerAsset(parsed.asset);
      const exactInvalidStaging = new File(stagingUri);
      if (exactInvalidStaging.exists) exactInvalidStaging.delete();
      return retainOrClearProvedFailure(owner, parsed.asset);
    }
    try {
      await inProgress.move(destination);
      return Object.freeze({ ...retained, localUri: destination.uri });
    } catch (moveError) {
      // A move may commit and still reject. Adopt only the exact canonical
      // destination when its content is the staging content just validated.
      if (destination.exists) {
        const committed = await inspectPrivatePhotoFile(destination);
        if (
          committed.byteLength === retained.byteLength &&
          committed.contentSha256 === retained.contentSha256 &&
          committed.declaredContentType === retained.declaredContentType
        ) {
          const exactStaging = new File(stagingUri);
          if (exactStaging.exists) exactStaging.delete();
          return committed;
        }
      }
      throw moveError;
    }
  }

  if (parsed.kind === 'asset') {
    return retainOrClearProvedFailure(owner, parsed.asset);
  }
  if (parsed.kind === 'canceled' || parsed.kind === 'invalid') {
    await clearProvedOwnerWithoutBytes(owner);
    if (parsed.kind === 'invalid') throw parsed.error;
    return null;
  }
  // A null Android result is absence, not proof of cancellation. Preserve the
  // owner so another explicit recovery/discard decision remains possible.
  return null;
}

export interface PrivatePhotoUploadInput {
  readonly draftId: string;
  readonly localUri: string;
  readonly uploadUrl: string;
  readonly contentType: MediaContentType;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly signal?: AbortSignal;
  readonly onProgress: (fraction: number) => void;
}

/** Uploads only to a server-issued exact PUT grant, never with app credentials. */
export async function uploadPrivatePhoto(
  input: PrivatePhotoUploadInput,
): Promise<Readonly<{ status: number }>> {
  const file = privateDraftFile(input.localUri, input.draftId);
  if (
    !file.exists ||
    file.size <= 0 ||
    file.size > MAX_PHOTO_BYTES ||
    file.size !== input.byteLength
  ) {
    throw new Error('The private photo draft is unavailable.');
  }
  const bytes = await file.bytes();
  const digest = hex(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  );
  if (
    digest !== input.contentSha256 ||
    sniffPhotoContentType(bytes) !== input.contentType
  ) {
    throw new Error('The private photo draft no longer matches its manifest.');
  }
  const task = file.createUploadTask(input.uploadUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    mimeType: input.contentType,
    headers: {
      'Content-Type': input.contentType,
      'If-None-Match': '*',
    },
    sessionType: 'foreground',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    onProgress({ bytesSent, totalBytes }) {
      input.onProgress(
        totalBytes <= 0 ? 0 : Math.min(1, bytesSent / totalBytes),
      );
    },
  });
  try {
    const result = await task.uploadAsync();
    // 412 means a prior uncertain PUT already created this intent-bound object;
    // completion remains the authoritative reconciliation step.
    if (
      (result.status < 200 || result.status >= 300) &&
      result.status !== 412
    ) {
      throw new PhotoDraftOperationError(
        'failed',
        'The upload endpoint definitively rejected this upload attempt.',
      );
    }
    input.onProgress(1);
    return Object.freeze({ status: result.status });
  } finally {
    task.release();
  }
}

export function deletePrivatePhoto(localUri: string, draftId: string): void {
  const file = privateDraftFile(localUri, draftId);
  if (file.exists) file.delete();
}

/** Removes only files derived from this exact pending picker token. */
function deletePendingPrivatePhotoFiles(
  ownerValue: PendingPhotoSelectionOwner,
): void {
  const owner = parsePendingOwner(ownerValue);
  const destination = privateDraftDestination(owner.draftId);
  if (destination.exists) destination.delete();
  const inProgress = privateDraftInProgressFile(
    owner.draftId,
    owner.selectionId,
  );
  if (inProgress.exists) inProgress.delete();
}
