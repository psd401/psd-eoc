import { CapabilityEngineError } from '../capabilities/engine';

export type MediaFailureKind =
  | 'conflict'
  | 'invalid'
  | 'not-found'
  | 'rate-limited'
  | 'scan-pending'
  | 'unavailable';

/** Public-safe media failure. Provider/storage details remain server-side. */
export class MediaPipelineError extends CapabilityEngineError {
  public constructor(
    public readonly kind: MediaFailureKind,
    message: string,
  ) {
    super(
      kind === 'invalid'
        ? 'VALIDATION_ERROR'
        : kind === 'not-found'
          ? 'NOT_FOUND'
          : kind === 'rate-limited'
            ? 'RATE_LIMITED'
            : kind === 'unavailable'
              ? 'INTERNAL_ERROR'
              : 'CONFLICT',
      'PERSISTENCE_CONFLICT',
      message,
      kind === 'invalid'
        ? 400
        : kind === 'not-found'
          ? 404
          : kind === 'rate-limited'
            ? 429
            : kind === 'unavailable'
              ? 503
              : 409,
      kind === 'rate-limited' ||
        kind === 'scan-pending' ||
        kind === 'unavailable',
    );
    this.name = 'MediaPipelineError';
  }
}

/**
 * Internal signal for a structurally invalid image whose upload intent must be
 * made terminal before its public-safe validation failure is returned. The
 * exact binding prevents persistence from rejecting a different event upload.
 */
export class TerminalMediaImageRejectionError extends MediaPipelineError {
  public constructor(
    public readonly eventId: string,
    public readonly uploadIntentId: string,
    message: string,
  ) {
    super('invalid', message);
    this.name = 'TerminalMediaImageRejectionError';
  }
}

export function invalidMedia(message: string): MediaPipelineError {
  return new MediaPipelineError('invalid', message);
}

export function mediaNotFound(message: string): MediaPipelineError {
  return new MediaPipelineError('not-found', message);
}

export function mediaConflict(message: string): MediaPipelineError {
  return new MediaPipelineError('conflict', message);
}

export function mediaRateLimited(): MediaPipelineError {
  return new MediaPipelineError(
    'rate-limited',
    'Photo upload capacity is temporarily limited. Try again shortly.',
  );
}

export function mediaScanPending(): MediaPipelineError {
  return new MediaPipelineError(
    'scan-pending',
    'The photo safety scan is still pending. Try again shortly.',
  );
}

export function mediaUnavailable(): MediaPipelineError {
  return new MediaPipelineError(
    'unavailable',
    'Photo processing is temporarily unavailable.',
  );
}
