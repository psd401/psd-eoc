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

/**
 * Fixed server-side allocation budgets for private upload grants. The rolling
 * window matches the maximum grant lifetime, while active limits continue to
 * protect an event and facility when uploads are abandoned until expiry.
 */
export const MEDIA_UPLOAD_BUDGET_WINDOW_SECONDS = 10 * 60;
export const MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT = 12;
export const MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT = 100 * 1_024 * 1_024;
export const MEDIA_EVENT_ACTIVE_INTENT_LIMIT = 48;
export const MEDIA_EVENT_ACTIVE_BYTE_LIMIT = 400 * 1_024 * 1_024;
export const MEDIA_EVENT_ROLLING_INTENT_LIMIT = 96;
export const MEDIA_EVENT_ROLLING_BYTE_LIMIT = 800 * 1_024 * 1_024;
export const MEDIA_FACILITY_ACTIVE_INTENT_LIMIT = 128;
export const MEDIA_FACILITY_ACTIVE_BYTE_LIMIT = 1_024 * 1_024 * 1_024;
export const MEDIA_FACILITY_ROLLING_INTENT_LIMIT = 256;
export const MEDIA_FACILITY_ROLLING_BYTE_LIMIT = 2 * 1_024 * 1_024 * 1_024;

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

/** Stable server-only identity shared across sessions or API key rotations. */
export type MediaBudgetPrincipal =
  | Readonly<{ kind: 'human'; userId: string; digest: string }>
  | Readonly<{ kind: 'agent'; agentId: string; digest: string }>
  | Readonly<{ kind: 'system'; serviceId: string; digest: string }>;

export interface NewMediaUploadIntent {
  readonly id: string;
  readonly eventId: string;
  /** Trusted facility resolved from the event before the capability handler. */
  readonly facilityId: string;
  /** Stable authenticated identity; session/API-key facts are excluded. */
  readonly budgetPrincipal: MediaBudgetPrincipal;
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
