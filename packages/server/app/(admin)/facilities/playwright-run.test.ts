import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import {
  adminPlaywrightDatabaseMarker,
  createOwnedAdminPlaywrightDatabase,
  requireAdminPlaywrightDatabaseOwnership,
} from './playwright-database';
import {
  ADMIN_PLAYWRIGHT_RUN_CONTEXT_ENV,
  cleanupAdminPlaywrightRunArtifacts,
  requireAdminPlaywrightRunContext,
  requireInheritedAdminPlaywrightRunContext,
  resolveAdminPlaywrightRunContext,
} from './playwright-run';
import type { PostgresDatabaseConnection } from '../../../db/client';

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

async function captureRejection(
  promise: Promise<unknown>,
): Promise<Readonly<{ rejected: boolean; reason: unknown }>> {
  return promise.then(
    () => ({ rejected: false, reason: null }),
    (reason: unknown) => ({ rejected: true, reason }),
  );
}

describe('issue #26 Playwright run isolation', () => {
  test('derives a disposable database and storage path unique to each UUID run', () => {
    const firstEnvironment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const secondEnvironment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const first = resolveAdminPlaywrightRunContext(
      BASE_DATABASE_URL,
      firstEnvironment,
      randomUUID,
    );
    const second = resolveAdminPlaywrightRunContext(
      BASE_DATABASE_URL,
      secondEnvironment,
      randomUUID,
    );
    try {
      expect(first.databaseUrl).not.toBe(BASE_DATABASE_URL);
      expect(first.databaseName).toMatch(
        /^psd_eoc_issue26_admin_[0-9a-f]{32}_test$/u,
      );
      expect(first.databaseName).not.toBe(second.databaseName);
      expect(first.storageStatePath).not.toBe(second.storageStatePath);
      expect(first.storageStatePath).not.toContain(
        'psd-eoc-issue10-storage-state.json',
      );
      expect(first.outputDirectory.startsWith(first.runDirectory)).toBe(true);
      expect(first.serverDirectory.startsWith(first.runDirectory)).toBe(true);
      expect(firstEnvironment[ADMIN_PLAYWRIGHT_RUN_CONTEXT_ENV]).toBeTruthy();
      expect(
        requireInheritedAdminPlaywrightRunContext(firstEnvironment),
      ).toEqual(first);
    } finally {
      cleanupAdminPlaywrightRunArtifacts(first);
      cleanupAdminPlaywrightRunArtifacts(second);
    }
  });

  test('rejects altered context fields and non-UUID run IDs', () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const context = resolveAdminPlaywrightRunContext(
      BASE_DATABASE_URL,
      environment,
    );
    try {
      expect(() =>
        requireAdminPlaywrightRunContext({
          ...context,
          storageStatePath: '/tmp/psd-eoc-issue10-storage-state.json',
        }),
      ).toThrow('metadata was altered');
      expect(() =>
        resolveAdminPlaywrightRunContext(
          BASE_DATABASE_URL,
          { NODE_ENV: 'test' },
          () => 'not-a-uuid',
        ),
      ).toThrow('must be a UUID');
    } finally {
      cleanupAdminPlaywrightRunArtifacts(context);
    }
  });

  test('database deletion authority requires the exact immutable run marker', () => {
    const context = resolveAdminPlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    try {
      const marker = adminPlaywrightDatabaseMarker(context);
      expect(() =>
        requireAdminPlaywrightDatabaseOwnership(context, marker),
      ).not.toThrow();
      expect(() =>
        requireAdminPlaywrightDatabaseOwnership(context, null),
      ).toThrow('ownership marker does not match');
      expect(() =>
        requireAdminPlaywrightDatabaseOwnership(
          context,
          marker.replace(context.runId, randomUUID()),
        ),
      ).toThrow('ownership marker does not match');
    } finally {
      cleanupAdminPlaywrightRunArtifacts(context);
    }
  });

  test('a mismatched marker is never converted into name-only rollback authority', async () => {
    const context = resolveAdminPlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const creator = fakeAdminConnection([
      [],
      [],
      [{ marker: 'synthetic-wrong-marker' }],
    ]);
    const rollback = fakeAdminConnection([
      [{ marker: 'synthetic-wrong-marker' }],
    ]);
    const connections = [creator, rollback];
    let factoryCalls = 0;
    try {
      const outcome = await captureRejection(
        createOwnedAdminPlaywrightDatabase(context, () => {
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
      expect(factoryCalls).toBe(2);
      expect(creator.executeCalls()).toBe(3);
      expect(rollback.executeCalls()).toBe(1);
      expect(creator.closeCalls()).toBe(1);
      expect(rollback.closeCalls()).toBe(1);
    } finally {
      cleanupAdminPlaywrightRunArtifacts(context);
    }
  });

  test('a creator-close rejection triggers fresh exact-marker rollback and preserves the close error', async () => {
    const context = resolveAdminPlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const closeError = new Error('Synthetic creator close rejection.');
    const marker = adminPlaywrightDatabaseMarker(context);
    const creator = fakeAdminConnection([[], [], [{ marker }]], () =>
      Promise.reject(closeError),
    );
    const rollback = fakeAdminConnection([[{ marker }], [], []]);
    const connections = [creator, rollback];
    let factoryCalls = 0;
    try {
      const outcome = await captureRejection(
        createOwnedAdminPlaywrightDatabase(context, () => {
          const next = connections[factoryCalls];
          factoryCalls += 1;
          if (next === undefined) {
            throw new Error('Unexpected synthetic admin connection request.');
          }
          return next.connection;
        }),
      );

      expect(outcome).toEqual({ rejected: true, reason: closeError });
      expect(factoryCalls).toBe(2);
      expect(creator.executeCalls()).toBe(3);
      expect(rollback.executeCalls()).toBe(3);
      expect(creator.closeCalls()).toBe(1);
      expect(rollback.closeCalls()).toBe(1);
    } finally {
      cleanupAdminPlaywrightRunArtifacts(context);
    }
  });
});
