import { IdempotencyKeySchema } from '@psd-eoc/contracts';
import { describe, expect, test } from 'bun:test';

import { scheduledRosterPublishIdempotencyKey } from './scheduled-publish';

const WITHIN_ONE_OCCURRENCE = [
  new Date('2026-09-04T18:00:00.000Z'),
  new Date('2026-09-04T19:59:59.999Z'),
] as const;

describe('scheduled roster-publish idempotency bucketing', () => {
  test('collapses a redelivered occurrence into one publication', () => {
    const [first, second] = WITHIN_ONE_OCCURRENCE;
    expect(scheduledRosterPublishIdempotencyKey(first)).toBe(
      scheduledRosterPublishIdempotencyKey(second),
    );
  });

  test('separates consecutive occurrences so the roster keeps republishing', () => {
    // The failure this prevents is silent and total. A constant key -- which
    // is what a statically templated scheduler payload produces -- makes every
    // run after the first replay the first run's stored result and answer
    // success without publishing anything, for as long as the schedule runs.
    const first = scheduledRosterPublishIdempotencyKey(
      new Date('2026-09-04T18:00:00.000Z'),
    );
    const next = scheduledRosterPublishIdempotencyKey(
      new Date('2026-09-04T20:00:00.000Z'),
    );
    expect(next).not.toBe(first);
  });

  test('does not collide with the membership run it rides on', () => {
    // Both keys are minted from the same clock in the same task. Sharing a
    // prefix would make one leg replay the other's result.
    expect(
      scheduledRosterPublishIdempotencyKey(
        new Date('2026-09-04T18:00:00.000Z'),
      ),
    ).toStartWith('roster-publish:scheduled:');
  });

  test('produces a key the capability contract accepts', () => {
    expect(() =>
      IdempotencyKeySchema.parse(
        scheduledRosterPublishIdempotencyKey(
          new Date('2026-09-04T18:00:00.000Z'),
        ),
      ),
    ).not.toThrow();
  });
});
