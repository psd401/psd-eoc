import type {
  MediaContentType,
  MediaRecord,
  MediaUploadIntent,
} from '@psd-eoc/contracts';

export const MEDIA_UPLOAD_GRANT_SECONDS = 10 * 60;
export const MEDIA_READ_GRANT_SECONDS = 2 * 60;
export const MEDIA_MAX_BYTES = 25 * 1_024 * 1_024;
export const MEDIA_QUARANTINE_PREFIX = 'quarantine';
export const MEDIA_READY_PREFIX = 'ready';

export type MediaUploadIntentStatus =
  | 'pending-upload'
  | 'completed'
  | 'rejected'
  | 'expired';

/** Server-only upload intent; storage keys are never returned to clients. */
export interface StoredMediaUploadIntent
  extends Omit<MediaUploadIntent, 'uploadMethod' | 'uploadUrl' | 'status'> {
  readonly storageKey: string;
  readonly status: MediaUploadIntentStatus;
}

/** Server-only ready record; the private storage key never crosses the API. */
export interface StoredMediaRecord extends MediaRecord {
  readonly storageKey: string;
}

export interface NewMediaUploadIntent {
  readonly id: string;
  readonly eventId: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly declaredContentType: MediaContentType;
  readonly storageKey: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface CompleteMediaRecord {
  readonly record: StoredMediaRecord;
  readonly expectedIntentStatus: 'pending-upload';
}

/** Minimal checksum evidence intentionally designed for issue #27 exports. */
export interface PhotoChecksumExportProjection {
  readonly journalEntryId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly mediaId: string;
  readonly sanitizedContentSha256: string;
  readonly sanitizedByteLength: number;
  readonly detectedContentType: MediaContentType;
}

export function quarantineStorageKey(
  eventId: string,
  intentId: string,
): string {
  return `${MEDIA_QUARANTINE_PREFIX}/${eventId}/${intentId}`;
}

export function readyStorageKey(eventId: string, mediaId: string): string {
  return `${MEDIA_READY_PREFIX}/${eventId}/${mediaId}`;
}
