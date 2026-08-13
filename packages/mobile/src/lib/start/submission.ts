import { IdempotencyKeySchema } from '@psd-eoc/contracts';

export type IdempotentSubmissionState<Result> =
  | Readonly<{
      phase: 'idle' | 'submitting' | 'failed';
      idempotencyKey: string;
      attemptCount: number;
    }>
  | Readonly<{
      phase: 'succeeded';
      idempotencyKey: string;
      attemptCount: number;
      result: Result;
    }>;

type SubmissionListener = () => void;

/**
 * Owns one explicit human submit decision. Concurrent presses share one
 * promise; an explicit retry after failure reuses the same idempotency key.
 * Nothing schedules or retries the operation automatically.
 */
export class IdempotentSubmissionController<Result> {
  private readonly listeners = new Set<SubmissionListener>();
  private inFlight: Promise<Result> | null = null;
  private state: IdempotentSubmissionState<Result>;

  public constructor(
    idempotencyKey: string,
    private readonly operation: (idempotencyKey: string) => Promise<Result>,
  ) {
    const parsedKey = IdempotencyKeySchema.parse(idempotencyKey);
    this.state = Object.freeze({
      phase: 'idle',
      idempotencyKey: parsedKey,
      attemptCount: 0,
    });
  }

  public getSnapshot = (): IdempotentSubmissionState<Result> => this.state;

  public subscribe = (listener: SubmissionListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(next: IdempotentSubmissionState<Result>): void {
    this.state = Object.freeze(next);
    for (const listener of this.listeners) {
      listener();
    }
  }

  public submit = (): Promise<Result> => {
    if (this.state.phase === 'succeeded') {
      return Promise.resolve(this.state.result);
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    const attemptCount = this.state.attemptCount + 1;
    const idempotencyKey = this.state.idempotencyKey;
    this.update({ phase: 'submitting', idempotencyKey, attemptCount });
    const attempt = Promise.resolve()
      .then(() => this.operation(idempotencyKey))
      .then(
        (result) => {
          this.update({
            phase: 'succeeded',
            idempotencyKey,
            attemptCount,
            result,
          });
          return result;
        },
        (error: unknown) => {
          this.update({ phase: 'failed', idempotencyKey, attemptCount });
          throw error;
        },
      )
      .finally(() => {
        if (this.inFlight === attempt) {
          this.inFlight = null;
        }
      });
    this.inFlight = attempt;
    return attempt;
  };
}

export function createIdempotentSubmission<Result>(
  idempotencyKey: string,
  operation: (idempotencyKey: string) => Promise<Result>,
): IdempotentSubmissionController<Result> {
  return new IdempotentSubmissionController(idempotencyKey, operation);
}
