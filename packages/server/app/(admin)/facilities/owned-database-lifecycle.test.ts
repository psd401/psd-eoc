import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { createOwnedEventRoomPlaywrightDatabase } from '../../(app)/events/[id]/playwright-database';
import {
  claimEventRoomPlaywrightRunContext,
  eventRoomPlaywrightDatabaseMarker,
  releaseEventRoomPlaywrightPortLease,
} from '../../(app)/events/[id]/test-database';
import type { PostgresDatabaseConnection } from '../../../db/client';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from './owned-database-lifecycle';

interface FakeDatabaseAdmin {
  readonly connection: PostgresDatabaseConnection;
  readonly executeCalls: () => number;
  readonly closeCalls: () => number;
}

function fakeDatabaseAdmin(
  results: readonly unknown[],
  close: () => Promise<void> = () => Promise.resolve(),
): FakeDatabaseAdmin {
  let executeCallCount = 0;
  let closeCallCount = 0;
  return {
    connection: {
      driver: 'postgres',
      db: {
        execute: () => {
          const result = results[executeCallCount];
          executeCallCount += 1;
          if (result instanceof Error) return Promise.reject(result);
          return Promise.resolve(result);
        },
      } as unknown as PostgresDatabaseConnection['db'],
      close: () => {
        closeCallCount += 1;
        return close();
      },
    },
    executeCalls: () => executeCallCount,
    closeCalls: () => closeCallCount,
  };
}

async function captureRejection(
  promise: Promise<unknown>,
): Promise<Readonly<{ rejected: boolean; reason: unknown }>> {
  return promise.then(
    () => ({ rejected: false, reason: null }),
    (reason: unknown) => ({ rejected: true, reason }),
  );
}

describe('marker-owned database lifecycle', () => {
  test('never rolls back when CREATE did not complete and preserves undefined rejection', async () => {
    const order: string[] = [];
    const outcome = await captureRejection(
      executeOwnedDatabaseCreation({
        createAndVerify: () => {
          order.push('create');
          return Promise.reject(undefined);
        },
        closeCreator: () => {
          order.push('close');
          return Promise.resolve();
        },
        rollbackWithFreshMarkerProof: () => {
          order.push('rollback');
          return Promise.resolve();
        },
        failureMessage: 'Synthetic creation failure.',
      }),
    );

    expect(outcome).toEqual({ rejected: true, reason: undefined });
    expect(order).toEqual(['create', 'close']);
  });

  test('closes first and then uses fresh marker-checked rollback after a post-CREATE proof failure', async () => {
    const proofError = new Error('Synthetic first marker read failure.');
    const order: string[] = [];
    const outcome = await captureRejection(
      executeOwnedDatabaseCreation({
        createAndVerify: async (recordCreated) => {
          order.push('create');
          recordCreated();
          order.push('proof');
          throw proofError;
        },
        closeCreator: () => {
          order.push('close');
          return Promise.resolve();
        },
        rollbackWithFreshMarkerProof: () => {
          order.push('fresh-proof-and-rollback');
          return Promise.resolve();
        },
        failureMessage: 'Synthetic proof failure.',
      }),
    );

    expect(outcome).toEqual({ rejected: true, reason: proofError });
    expect(order).toEqual([
      'create',
      'proof',
      'close',
      'fresh-proof-and-rollback',
    ]);
  });

  test('aggregates operation, creator-close, and marker-checked rollback failures without losing undefined', async () => {
    const operationError = new Error('Synthetic operation failure.');
    const rollbackError = new Error('Synthetic rollback failure.');
    const outcome = await captureRejection(
      executeOwnedDatabaseCreation({
        createAndVerify: async (recordCreated) => {
          recordCreated();
          throw operationError;
        },
        closeCreator: () => Promise.reject(undefined),
        rollbackWithFreshMarkerProof: () => Promise.reject(rollbackError),
        failureMessage: 'Synthetic aggregate failure.',
      }),
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect((outcome.reason as AggregateError).errors).toEqual([
      operationError,
      undefined,
      rollbackError,
    ]);
  });

  test('required cleanup cannot turn an undefined operation rejection into success', async () => {
    const outcome = await captureRejection(
      executeOperationWithCleanup({
        operation: () => Promise.reject(undefined),
        cleanup: () => Promise.resolve(),
        failureMessage: 'Synthetic operation and cleanup failure.',
      }),
    );
    expect(outcome).toEqual({ rejected: true, reason: undefined });
  });

  test('aggregates a primary error with an undefined cleanup rejection', async () => {
    const operationError = new Error('Synthetic primary failure.');
    const outcome = await captureRejection(
      executeOperationWithCleanup({
        operation: () => Promise.reject(operationError),
        cleanup: () => Promise.reject(undefined),
        failureMessage: 'Synthetic operation and cleanup failure.',
      }),
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect((outcome.reason as AggregateError).errors).toEqual([
      operationError,
      undefined,
    ]);
  });

  test('event-room creation re-proves ownership after a proof and creator-close failure', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      'postgres://synthetic:synthetic@127.0.0.1:5432/psd_eoc_test',
      randomUUID(),
    );
    const proofError = new Error('Synthetic event-room marker read failure.');
    const closeError = new Error('Synthetic event-room creator close failure.');
    const marker = eventRoomPlaywrightDatabaseMarker(context);
    const creator = fakeDatabaseAdmin([[], [], proofError], () =>
      Promise.reject(closeError),
    );
    const rollback = fakeDatabaseAdmin([[{ marker }], [], []]);
    const connections = [creator, rollback];
    let factoryCalls = 0;
    try {
      const outcome = await captureRejection(
        createOwnedEventRoomPlaywrightDatabase(context, () => {
          const next = connections[factoryCalls];
          factoryCalls += 1;
          if (next === undefined) {
            throw new Error('Unexpected synthetic admin connection request.');
          }
          return next.connection;
        }),
      );

      expect(outcome.rejected).toBe(true);
      expect(outcome.reason).toBeInstanceOf(AggregateError);
      expect((outcome.reason as AggregateError).errors).toEqual([
        proofError,
        closeError,
      ]);
      expect(factoryCalls).toBe(2);
      expect(creator.executeCalls()).toBe(3);
      expect(rollback.executeCalls()).toBe(3);
      expect(creator.closeCalls()).toBe(1);
      expect(rollback.closeCalls()).toBe(1);
    } finally {
      releaseEventRoomPlaywrightPortLease(context);
    }
  });
});
