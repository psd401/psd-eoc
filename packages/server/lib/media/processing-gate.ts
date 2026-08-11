export const MAX_CONCURRENT_MEDIA_PROCESSING_PER_FACILITY = 1;
export const MAX_CONCURRENT_MEDIA_PROCESSING_PER_INSTANCE = 2;
export const MAX_CONCURRENT_MEDIA_PROVIDER_OPERATIONS_PER_INSTANCE = 2;

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

export interface MediaProcessingGate {
  run<Result>(
    facilityId: string,
    operation: () => Promise<Result>,
  ): Promise<Result>;
}

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
  maximumConcurrentPerFacility = MAX_CONCURRENT_MEDIA_PROCESSING_PER_FACILITY,
  maximumConcurrentPerInstance = MAX_CONCURRENT_MEDIA_PROCESSING_PER_INSTANCE,
): MediaProcessingGate {
  if (
    !Number.isSafeInteger(maximumConcurrentPerFacility) ||
    maximumConcurrentPerFacility < 1
  ) {
    throw new RangeError(
      'Media processing per-facility concurrency must be positive.',
    );
  }
  if (
    !Number.isSafeInteger(maximumConcurrentPerInstance) ||
    maximumConcurrentPerInstance < maximumConcurrentPerFacility
  ) {
    throw new RangeError(
      'Media processing per-instance concurrency must be a positive integer no smaller than the per-facility bound.',
    );
  }

  // These counters intentionally protect one App Runner process. Durable
  // principal/event/facility admission budgets and advisory locks in the
  // repository remain the cross-instance authority. A keyed local bound keeps
  // one facility from occupying every native image slot during a multi-site
  // incident, while the process-wide ceiling still prevents CPU exhaustion.
  let activeAcrossInstance = 0;
  const activeByFacility = new Map<string, number>();
  return Object.freeze({
    async run<Result>(
      facilityId: string,
      operation: () => Promise<Result>,
    ): Promise<Result> {
      const activeForFacility = activeByFacility.get(facilityId) ?? 0;
      if (
        activeAcrossInstance >= maximumConcurrentPerInstance ||
        activeForFacility >= maximumConcurrentPerFacility
      ) {
        throw new MediaProcessingCapacityError();
      }
      activeAcrossInstance += 1;
      activeByFacility.set(facilityId, activeForFacility + 1);
      try {
        return await operation();
      } finally {
        activeAcrossInstance -= 1;
        const currentActiveForFacility = activeByFacility.get(facilityId) ?? 0;
        if (currentActiveForFacility <= 1) {
          activeByFacility.delete(facilityId);
        } else {
          activeByFacility.set(facilityId, currentActiveForFacility - 1);
        }
      }
    },
  });
}

/**
 * Bounds every S3/signing operation across upload, completion, replay, and read
 * grants. Saturated callers fail immediately so they do not retain a database
 * transaction while waiting for a provider slot.
 */
export function createMediaProviderGate(
  maximumConcurrent = MAX_CONCURRENT_MEDIA_PROVIDER_OPERATIONS_PER_INSTANCE,
): MediaProviderGate {
  return createFailFastGate(
    maximumConcurrent,
    'Media provider',
    () => new MediaProviderCapacityError(),
  );
}
