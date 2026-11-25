/**
 * Send pacing and bounded parallelism for channel workers.
 *
 * Provider SDK clients run with retries disabled, so a throttled call becomes
 * a ledger retry minutes later rather than a quick second try. Workers that
 * send to several recipients at once therefore space their provider calls
 * below the provider's rate instead of relying on throttling to slow them.
 */

export type PacerClock = Readonly<{
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

const SYSTEM_CLOCK: PacerClock = Object.freeze({
  now: Date.now,
  sleep: (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
});

/** Resolves when the caller may start its next provider call. */
export type SendPacer = () => Promise<void>;

/**
 * Starts at most `perSecond` calls in any one-second window, evenly spaced.
 * Callers wait in arrival order; one pacer is shared by every caller of the
 * same provider account in this process.
 */
export function createSendPacer(
  perSecond: number,
  clock: PacerClock = SYSTEM_CLOCK,
): SendPacer {
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    throw new RangeError('A send pacer needs a positive rate.');
  }
  const intervalMilliseconds = 1_000 / perSecond;
  let nextSlot = Number.NEGATIVE_INFINITY;
  return async () => {
    const now = clock.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMilliseconds;
    if (slot > now) await clock.sleep(slot - now);
  };
}

/**
 * Runs `task` for every item with at most `limit` in flight. After a task
 * throws, no further item starts; the tasks already running finish, and the
 * first error is rethrown, so the caller sees what a sequential loop would.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Concurrency must be a positive integer.');
  }
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async () => {
    while (failure === null && next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  if (failure !== null) throw (failure as { error: unknown }).error;
}
