import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import type { PostgresDatabaseConnection } from '../../../db/client';
import {
  eventTypeDatabaseTestDatabaseMarker,
  prepareOwnedEventTypeDatabaseTestDatabase,
  requireEventTypeDatabaseTestDatabaseOwnership,
  resolveEventTypeDatabaseTestContext,
  type EventTypeDatabaseTestAdminFactory,
} from './database-test-database';

const BASE_DATABASE_URL =
  'postgresql://synthetic:synthetic@127.0.0.1:5432/psd_eoc_test';

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

function queuedAdminFactory(
  connections: readonly FakeAdminConnection[],
): Readonly<{
  factory: EventTypeDatabaseTestAdminFactory;
  calls: () => number;
}> {
  let callCount = 0;
  return {
    factory: () => {
      const next = connections[callCount];
      callCount += 1;
      if (next === undefined) {
        throw new Error('Unexpected synthetic admin connection request.');
      }
      return next.connection;
    },
    calls: () => callCount,
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

describe('event-type non-browser database isolation', () => {
  test('derives a distinct loopback child for each UUID without changing the base', () => {
    const first = resolveEventTypeDatabaseTestContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const second = resolveEventTypeDatabaseTestContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );

    expect(first.baseDatabaseUrl).toBe(BASE_DATABASE_URL);
    expect(first.databaseUrl).not.toBe(BASE_DATABASE_URL);
    expect(first.databaseName).toMatch(/^psd_eoc_i94_et_[0-9a-f]{32}_test$/u);
    expect(first.databaseName).not.toBe(second.databaseName);
    expect(new URL(first.databaseUrl).hostname).toBe('127.0.0.1');
    expect(
      decodeURIComponent(new URL(first.databaseUrl).pathname.slice(1)),
    ).toBe(first.databaseName);
  });

  test('rejects remote, production-shaped, queried, and non-UUID inputs', () => {
    for (const value of [
      'postgresql://synthetic:synthetic@database.internal:5432/psd_eoc_test',
      'postgresql://synthetic:synthetic@127.0.0.1:5432/psd_eoc',
      'postgresql://synthetic:synthetic@127.0.0.1:5432/psd_eoc_test?host=elsewhere',
    ]) {
      expect(() =>
        resolveEventTypeDatabaseTestContext(value, randomUUID()),
      ).toThrow();
    }
    expect(() =>
      resolveEventTypeDatabaseTestContext(BASE_DATABASE_URL, 'not-a-uuid'),
    ).toThrow('must be a UUID');
  });

  test('binds deletion authority to the exact immutable run marker', () => {
    const context = resolveEventTypeDatabaseTestContext(BASE_DATABASE_URL);
    const marker = eventTypeDatabaseTestDatabaseMarker(context);

    expect(() =>
      requireEventTypeDatabaseTestDatabaseOwnership(context, marker),
    ).not.toThrow();
    expect(() =>
      requireEventTypeDatabaseTestDatabaseOwnership(context, null),
    ).toThrow('ownership marker does not match');
    expect(() =>
      requireEventTypeDatabaseTestDatabaseOwnership(
        context,
        marker.replace(context.runId, randomUUID()),
      ),
    ).toThrow('ownership marker does not match');
    expect(() =>
      eventTypeDatabaseTestDatabaseMarker({
        ...context,
        databaseName: 'psd_eoc_i94_et_altered_test',
      }),
    ).toThrow('context was altered');
  });

  test('closes and marker-verifies cleanup after successful preparation', async () => {
    const context = resolveEventTypeDatabaseTestContext(BASE_DATABASE_URL);
    const marker = eventTypeDatabaseTestDatabaseMarker(context);
    const creator = fakeAdminConnection([[], [], [{ marker }]]);
    const cleanup = fakeAdminConnection([[{ marker }], [], []]);
    const admins = queuedAdminFactory([creator, cleanup]);
    const operations: string[] = [];
    const resource = { kind: 'synthetic-resource' } as const;

    const owned = await prepareOwnedEventTypeDatabaseTestDatabase(
      context,
      {
        open(databaseUrl) {
          operations.push(`open:${databaseUrl}`);
          return resource;
        },
        prepare(received) {
          expect(received).toBe(resource);
          operations.push('prepare');
          return Promise.resolve();
        },
        close(received) {
          expect(received).toBe(resource);
          operations.push('close');
          return Promise.resolve();
        },
      },
      admins.factory,
    );
    await owned.cleanup();
    await owned.cleanup();

    expect(owned.resource).toBe(resource);
    expect(operations).toEqual([
      `open:${context.databaseUrl}`,
      'prepare',
      'close',
    ]);
    expect(admins.calls()).toBe(2);
    expect(creator.executeCalls()).toBe(3);
    expect(cleanup.executeCalls()).toBe(3);
    expect(creator.closeCalls()).toBe(1);
    expect(cleanup.closeCalls()).toBe(1);
  });

  test('closes and marker-verifies cleanup when migration or seed setup fails', async () => {
    const context = resolveEventTypeDatabaseTestContext(BASE_DATABASE_URL);
    const marker = eventTypeDatabaseTestDatabaseMarker(context);
    const creator = fakeAdminConnection([[], [], [{ marker }]]);
    const cleanup = fakeAdminConnection([[{ marker }], [], []]);
    const admins = queuedAdminFactory([creator, cleanup]);
    const setupError = new Error('Synthetic migration failure.');
    const operations: string[] = [];

    const outcome = await captureRejection(
      prepareOwnedEventTypeDatabaseTestDatabase(
        context,
        {
          open() {
            operations.push('open');
            return { kind: 'synthetic-resource' };
          },
          prepare() {
            operations.push('prepare');
            return Promise.reject(setupError);
          },
          close() {
            operations.push('close');
            return Promise.resolve();
          },
        },
        admins.factory,
      ),
    );

    expect(outcome).toEqual({ rejected: true, reason: setupError });
    expect(operations).toEqual(['open', 'prepare', 'close']);
    expect(admins.calls()).toBe(2);
    expect(cleanup.executeCalls()).toBe(3);
    expect(cleanup.closeCalls()).toBe(1);
  });

  test('still attempts the exact drop when resource close fails during setup cleanup', async () => {
    const context = resolveEventTypeDatabaseTestContext(BASE_DATABASE_URL);
    const marker = eventTypeDatabaseTestDatabaseMarker(context);
    const creator = fakeAdminConnection([[], [], [{ marker }]]);
    const cleanup = fakeAdminConnection([[{ marker }], [], []]);
    const admins = queuedAdminFactory([creator, cleanup]);
    const setupError = new Error('Synthetic seed failure.');
    const closeError = new Error('Synthetic resource-close failure.');

    const outcome = await captureRejection(
      prepareOwnedEventTypeDatabaseTestDatabase(
        context,
        {
          open: () => ({ kind: 'synthetic-resource' }),
          prepare: () => Promise.reject(setupError),
          close: () => Promise.reject(closeError),
        },
        admins.factory,
      ),
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect(admins.calls()).toBe(2);
    expect(cleanup.executeCalls()).toBe(3);
    expect(cleanup.closeCalls()).toBe(1);
  });
});
