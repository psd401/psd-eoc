export const MAX_CONCURRENT_MEDIA_PROCESSING = 1;

/** Signals local saturation without queueing untrusted media in memory. */
export class MediaProcessingCapacityError extends Error {
  public constructor() {
    super('Media processing capacity is currently unavailable.');
    this.name = 'MediaProcessingCapacityError';
  }
}

export interface MediaProcessingGate {
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}

/**
 * Bounds raw download, decode, re-encode, and sanitized upload together. Photo
 * work is non-critical and must yield capacity to the activation/event path.
 */
export function createMediaProcessingGate(
  maximumConcurrent = MAX_CONCURRENT_MEDIA_PROCESSING,
): MediaProcessingGate {
  if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1) {
    throw new RangeError('Media processing concurrency must be positive.');
  }
  let active = 0;
  return Object.freeze({
    async run<Result>(operation: () => Promise<Result>): Promise<Result> {
      if (active >= maximumConcurrent) {
        throw new MediaProcessingCapacityError();
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
