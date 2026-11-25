import { describe, expect, test } from 'bun:test';

import { createSendPacer, forEachConcurrently } from './pacing';

function fakeClock() {
  let now = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => now,
      sleep: (milliseconds: number) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe('send pacer', () => {
  test('spaces calls evenly at the configured rate', async () => {
    const { clock, sleeps } = fakeClock();
    const pace = createSendPacer(4, clock);
    await Promise.all([pace(), pace(), pace(), pace()]);
    expect(sleeps).toEqual([250, 500, 750]);
  });

  test('lets a call through at once after the rate has recovered', async () => {
    const { clock, sleeps, advance } = fakeClock();
    const pace = createSendPacer(3, clock);
    await pace();
    advance(1_000);
    await pace();
    expect(sleeps).toEqual([]);
  });

  test('refuses a rate that cannot pace', () => {
    expect(() => createSendPacer(0)).toThrow(RangeError);
    expect(() => createSendPacer(Number.NaN)).toThrow(RangeError);
  });
});

describe('forEachConcurrently', () => {
  test('runs every item with at most the limit in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const done: number[] = [];
    await forEachConcurrently([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      done.push(item);
    });
    expect(maxInFlight).toBe(3);
    expect([...done].sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  test('starts nothing after a failure, waits for running items, and rethrows the first error', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const failure = new Error('first');
    await expect(
      forEachConcurrently([1, 2, 3, 4, 5], 2, async (item) => {
        started.push(item);
        if (item === 1) throw failure;
        await new Promise((resolve) => setTimeout(resolve, 1));
        finished.push(item);
      }),
    ).rejects.toBe(failure);
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([2]);
  });

  test('keeps the first error when several running items fail', async () => {
    const first = new Error('first');
    await expect(
      forEachConcurrently([1, 2, 3], 2, async (item) => {
        if (item === 1) throw first;
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('second');
      }),
    ).rejects.toBe(first);
  });

  test('refuses a limit below one', async () => {
    await expect(forEachConcurrently([1], 0, async () => {})).rejects.toThrow(
      RangeError,
    );
  });
});
