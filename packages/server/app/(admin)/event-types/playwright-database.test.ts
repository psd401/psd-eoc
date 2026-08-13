import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import type { PostgresDatabaseConnection } from '../../../db/client';
import {
  createOwnedEventTypePlaywrightDatabase,
  dropOwnedEventTypePlaywrightDatabase,
  eventTypePlaywrightDatabaseMarker,
  requireEventTypePlaywrightDatabaseOwnership,
} from './playwright-database';
import {
  cleanupEventTypePlaywrightRunAfterChildExit,
  resolveEventTypePlaywrightRunContext,
} from './playwright-run';

const BASE_DATABASE_URL =
  'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test';

interface FakeAdminConnection {
  readonly connection: PostgresDatabaseConnection;
  readonly executeCalls: () => number;
  readonly closeCalls: () => number;
}

function fakeAdminConnection(
  results: readonly unknown[],
  close: () => Promise<void> = () => Promise.resolve(),
): FakeAdminConnection {
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

async function cleanContext(context: unknown): Promise<void> {
  await cleanupEventTypePlaywrightRunAfterChildExit(context, () =>
    Promise.resolve(),
  );
}

async function captureRejection(
  promise: Promise<unknown>,
): Promise<Readonly<{ rejected: boolean; reason: unknown }>> {
  return promise.then(
    () => ({ rejected: false, reason: null }),
    (reason: unknown) => ({ rejected: true, reason }),
  );
}

describe('issue #94 event-type Playwright database ownership', () => {
  test('requires the exact immutable run marker', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    try {
      const marker = eventTypePlaywrightDatabaseMarker(context);
      expect(() =>
        requireEventTypePlaywrightDatabaseOwnership(context, marker),
      ).not.toThrow();
      expect(() =>
        requireEventTypePlaywrightDatabaseOwnership(context, null),
      ).toThrow('ownership marker does not match');
      expect(() =>
        requireEventTypePlaywrightDatabaseOwnership(
          context,
          marker.replace(context.runId, randomUUID()),
        ),
      ).toThrow('ownership marker does not match');
    } finally {
      await cleanContext(context);
    }
  });

  test('never drops a name-only database with a mismatched marker', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const admin = fakeAdminConnection([[{ marker: 'wrong-run-marker' }]]);
    try {
      await expect(
        dropOwnedEventTypePlaywrightDatabase(context, () => admin.connection),
      ).rejects.toThrow('ownership marker does not match');
      expect(admin.executeCalls()).toBe(1);
      expect(admin.closeCalls()).toBe(1);
    } finally {
      await cleanContext(context);
    }
  });

  test('verifies absence after dropping an exactly marked database', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const marker = eventTypePlaywrightDatabaseMarker(context);
    const admin = fakeAdminConnection([[{ marker }], [], []]);
    try {
      expect(
        await dropOwnedEventTypePlaywrightDatabase(
          context,
          () => admin.connection,
        ),
      ).toBe(true);
      expect(admin.executeCalls()).toBe(3);
      expect(admin.closeCalls()).toBe(1);
    } finally {
      await cleanContext(context);
    }
  });

  test('a mismatched creation marker cannot become rollback authority', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const creator = fakeAdminConnection([
      [],
      [],
      [{ marker: 'wrong-run-marker' }],
    ]);
    const rollback = fakeAdminConnection([[{ marker: 'wrong-run-marker' }]]);
    const connections = [creator, rollback];
    let factoryCalls = 0;
    try {
      const outcome = await captureRejection(
        createOwnedEventTypePlaywrightDatabase(context, () => {
          const connection = connections[factoryCalls];
          factoryCalls += 1;
          if (connection === undefined) {
            throw new Error('Unexpected synthetic admin connection request.');
          }
          return connection.connection;
        }),
      );
      expect(outcome.rejected).toBe(true);
      expect(outcome.reason).toBeInstanceOf(AggregateError);
      expect(factoryCalls).toBe(2);
      expect(creator.executeCalls()).toBe(3);
      expect(rollback.executeCalls()).toBe(1);
      expect(creator.closeCalls()).toBe(1);
      expect(rollback.closeCalls()).toBe(1);
    } finally {
      await cleanContext(context);
    }
  });

  test('creator-close failure triggers fresh exact-marker rollback', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const closeError = new Error('Synthetic creator close rejection.');
    const marker = eventTypePlaywrightDatabaseMarker(context);
    const creator = fakeAdminConnection([[], [], [{ marker }]], () =>
      Promise.reject(closeError),
    );
    const rollback = fakeAdminConnection([[{ marker }], [], []]);
    const connections = [creator, rollback];
    let factoryCalls = 0;
    try {
      const outcome = await captureRejection(
        createOwnedEventTypePlaywrightDatabase(context, () => {
          const connection = connections[factoryCalls];
          factoryCalls += 1;
          if (connection === undefined) {
            throw new Error('Unexpected synthetic admin connection request.');
          }
          return connection.connection;
        }),
      );
      expect(outcome).toEqual({ rejected: true, reason: closeError });
      expect(factoryCalls).toBe(2);
      expect(creator.executeCalls()).toBe(3);
      expect(rollback.executeCalls()).toBe(3);
      expect(creator.closeCalls()).toBe(1);
      expect(rollback.closeCalls()).toBe(1);
    } finally {
      await cleanContext(context);
    }
  });
});
