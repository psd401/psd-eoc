import { CapabilityEngineError } from '../capabilities/engine';

export type MediaFailureKind =
  | 'conflict'
  | 'invalid'
  | 'not-found'
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
          : kind === 'unavailable'
            ? 'INTERNAL_ERROR'
            : 'CONFLICT',
      'PERSISTENCE_CONFLICT',
      message,
      kind === 'invalid'
        ? 400
        : kind === 'not-found'
          ? 404
          : kind === 'unavailable'
            ? 503
            : 409,
      kind === 'scan-pending' || kind === 'unavailable',
    );
    this.name = 'MediaPipelineError';
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
