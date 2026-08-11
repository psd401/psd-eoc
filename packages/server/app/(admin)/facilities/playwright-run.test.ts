import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import {
  adminPlaywrightDatabaseMarker,
  requireAdminPlaywrightDatabaseOwnership,
} from './playwright-database';
import {
  ADMIN_PLAYWRIGHT_RUN_CONTEXT_ENV,
  cleanupAdminPlaywrightRunArtifacts,
  requireAdminPlaywrightRunContext,
  requireInheritedAdminPlaywrightRunContext,
  resolveAdminPlaywrightRunContext,
} from './playwright-run';

const BASE_DATABASE_URL =
  'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test';

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
});
