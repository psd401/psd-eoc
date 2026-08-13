import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  EVENT_TYPE_PLAYWRIGHT_RUN_CONTEXT_ENV,
  cleanupEventTypePlaywrightRunAfterChildExit,
  cleanupReportedEventTypePlaywrightRun,
  finalizeEventTypePlaywrightWebServer,
  inspectEventTypePlaywrightPortLease,
  prepareEventTypePlaywrightServerWorkspace,
  requireEventTypePlaywrightRunContext,
  requireInheritedEventTypePlaywrightRunContext,
  resolveEventTypePlaywrightRunContext,
} from './playwright-run';

const BASE_DATABASE_URL =
  'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test';

async function cleanContext(context: unknown): Promise<void> {
  await cleanupEventTypePlaywrightRunAfterChildExit(context, () =>
    Promise.resolve(),
  );
}

function makeSyntheticSourceWorkspace(): Readonly<{
  root: string;
  server: string;
}> {
  const root = join(tmpdir(), `psd-eoc-event-type-source-${randomUUID()}`);
  const server = join(root, 'packages', 'server');
  mkdirSync(join(server, '.next'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const [path, contents] of [
    [join(root, 'package.json'), '{}'],
    [join(root, 'tsconfig.base.json'), '{}'],
    [join(server, 'package.json'), '{}'],
    [join(server, 'tsconfig.json'), '{}'],
    [join(server, 'source.ts'), 'export const source = true;'],
    [join(server, '.next', 'shared-build.txt'), 'must not be copied'],
    [join(server, 'next-env.d.ts'), 'must not be copied'],
    [join(server, 'stale.tsbuildinfo'), 'must not be copied'],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return { root, server };
}

describe('issue #94 event-type Playwright run isolation', () => {
  test('claims unique database, port, storage, artifact, and workspace resources', async () => {
    const firstEnvironment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const secondEnvironment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const first = resolveEventTypePlaywrightRunContext(
      BASE_DATABASE_URL,
      firstEnvironment,
      randomUUID,
    );
    const second = resolveEventTypePlaywrightRunContext(
      BASE_DATABASE_URL,
      secondEnvironment,
      randomUUID,
    );
    try {
      expect(first.databaseUrl).not.toBe(BASE_DATABASE_URL);
      expect(first.databaseName).toMatch(
        /^psd_eoc_event_type_[0-9a-f]{32}_test$/u,
      );
      expect(first.databaseName).not.toBe(second.databaseName);
      expect(first.appPort).not.toBe(second.appPort);
      expect(first.storageStatePath).not.toBe(second.storageStatePath);
      expect(first.outputDirectory).not.toBe(second.outputDirectory);
      expect(first.serverDirectory).not.toBe(second.serverDirectory);
      expect(first.outputDirectory.startsWith(first.runDirectory)).toBe(true);
      expect(first.serverDirectory.startsWith(first.runDirectory)).toBe(true);
      expect(
        firstEnvironment[EVENT_TYPE_PLAYWRIGHT_RUN_CONTEXT_ENV],
      ).toBeTruthy();
      expect(
        requireInheritedEventTypePlaywrightRunContext(firstEnvironment),
      ).toEqual(first);
    } finally {
      await cleanContext(first);
      await cleanContext(second);
    }
  });

  test('rejects altered context fields and non-UUID run IDs', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    try {
      expect(() =>
        requireEventTypePlaywrightRunContext({
          ...context,
          storageStatePath: '/tmp/shared-storage-state.json',
        }),
      ).toThrow('metadata was altered');
      expect(() =>
        resolveEventTypePlaywrightRunContext(
          BASE_DATABASE_URL,
          { NODE_ENV: 'test' },
          () => 'not-a-uuid',
        ),
      ).toThrow('random UUID');
    } finally {
      await cleanContext(context);
    }
  });

  test('copies a run workspace without shared Next bookkeeping', async () => {
    const source = makeSyntheticSourceWorkspace();
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    try {
      prepareEventTypePlaywrightServerWorkspace(context, source.server);
      prepareEventTypePlaywrightServerWorkspace(context, source.server);

      expect(existsSync(join(context.serverDirectory, 'source.ts'))).toBe(true);
      expect(existsSync(context.serverBuildDirectory)).toBe(false);
      expect(existsSync(context.serverNextEnvPath)).toBe(false);
      expect(
        existsSync(join(context.serverDirectory, 'stale.tsbuildinfo')),
      ).toBe(false);
      expect(existsSync(context.serverWorkspaceReadyPath)).toBe(true);
      expect(existsSync(join(context.workspaceDirectory, 'node_modules'))).toBe(
        true,
      );
    } finally {
      await cleanContext(context);
      rmSync(source.root, { force: true, recursive: true });
    }
  });

  test('marker-verifies artifacts before cleanup', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const marker = readFileSync(context.runOwnershipPath, 'utf8');
    try {
      writeFileSync(context.runOwnershipPath, '{"altered":true}', 'utf8');
      await expect(cleanContext(context)).rejects.toThrow(
        'run ownership marker was altered',
      );
      expect(existsSync(context.runDirectory)).toBe(true);
    } finally {
      writeFileSync(context.runOwnershipPath, marker, 'utf8');
      await cleanContext(context);
    }
  });

  test('finalizes server, port, database, and reporter cleanup in order', async () => {
    const context = resolveEventTypePlaywrightRunContext(BASE_DATABASE_URL, {
      NODE_ENV: 'test',
    });
    const order: string[] = [];
    try {
      const exitCode = await finalizeEventTypePlaywrightWebServer(
        context,
        async () => {
          order.push('server-exited');
          return 0;
        },
        async (appPort) => {
          expect(appPort).toBe(context.appPort);
          order.push('port-closed');
        },
        async () => {
          order.push('database-dropped');
        },
      );
      expect(exitCode).toBe(0);
      expect(order).toEqual([
        'server-exited',
        'port-closed',
        'database-dropped',
      ]);
      expect(inspectEventTypePlaywrightPortLease(context)).toBe('absent');
      cleanupReportedEventTypePlaywrightRun(context);
      expect(existsSync(context.runDirectory)).toBe(false);
    } finally {
      await cleanContext(context);
    }
  });
});
