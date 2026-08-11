export const MAX_CONCURRENT_MEDIA_PROCESSING = 1;
export const MAX_CONCURRENT_MEDIA_PROVIDER_OPERATIONS = 2;

/** Signals local saturation without queueing untrusted media in memory. */
export class MediaProcessingCapacityError extends Error {
  public constructor() {
    super('Media processing capacity is currently unavailable.');
    this.name = 'MediaProcessingCapacityError';
  }
}

interface MediaAdmissionGate {
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export type MediaProcessingGate = MediaAdmissionGate;

/** Signals local S3/signing saturation without queueing inside a DB transaction. */
export class MediaProviderCapacityError extends Error {
  public constructor() {
    super('Media provider capacity is currently unavailable.');
    this.name = 'MediaProviderCapacityError';
  }
}

export type MediaProviderGate = MediaAdmissionGate;

function createFailFastGate(
  maximumConcurrent: number,
  configurationName: string,
  capacityError: () => Error,
): MediaAdmissionGate {
  if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1) {
    throw new RangeError(`${configurationName} concurrency must be positive.`);
  }
  let active = 0;
  return Object.freeze({
    async run<Result>(operation: () => Promise<Result>): Promise<Result> {
      if (active >= maximumConcurrent) {
        throw capacityError();
      }
      active += 1;
      try {
        return await operation();
      } finally {
        active -= 1;
      }
    },
  });
}

/**
 * Bounds raw download, decode, re-encode, and sanitized upload together. Photo
 * work is non-critical and must yield capacity to the activation/event path.
 */
export function createMediaProcessingGate(
  maximumConcurrent = MAX_CONCURRENT_MEDIA_PROCESSING,
): MediaProcessingGate {
  return createFailFastGate(
    maximumConcurrent,
    'Media processing',
    () => new MediaProcessingCapacityError(),
  );
}

/**
 * Bounds every S3/signing operation across upload, completion, replay, and read
 * grants. Saturated callers fail immediately so they do not retain a database
 * transaction while waiting for a provider slot.
 */
export function createMediaProviderGate(
  maximumConcurrent = MAX_CONCURRENT_MEDIA_PROVIDER_OPERATIONS,
): MediaProviderGate {
  return createFailFastGate(
    maximumConcurrent,
    'Media provider',
    () => new MediaProviderCapacityError(),
  );
}
