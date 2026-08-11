import { describe, expect, test } from 'bun:test';

import type { Database } from '../../../../db/client';
import { createDrizzleStartFlowCapabilityStore } from './capabilities';
import { createDrizzleStartConfirmationStore } from './confirmation';

const DATA_API_CLOCK = '2026-08-10T19:23:45.000Z';

function dataApiClockDatabase(): Database {
  const transaction = {
    execute: async () => ({ rows: [{ value: DATA_API_CLOCK }] }),
  };

  return {
    transaction: async (
      operation: (value: typeof transaction) => Promise<unknown>,
    ) => operation(transaction),
  } as unknown as Database;
}

describe('start-flow database transport normalization', () => {
  test('reads the capability clock from an AWS Data API rows envelope', async () => {
    const store = createDrizzleStartFlowCapabilityStore(dataApiClockDatabase());

    const value = await store.transaction((transaction) =>
      transaction.readCurrentTime(new Date(0)),
    );

    expect(value).toEqual(new Date(DATA_API_CLOCK));
  });

  test('reads the confirmation clock from an AWS Data API rows envelope', async () => {
    const store = createDrizzleStartConfirmationStore(dataApiClockDatabase());

    const value = await store.transaction((transaction) =>
      transaction.readCurrentTime(),
    );

    expect(value).toEqual(new Date(DATA_API_CLOCK));
  });
});
