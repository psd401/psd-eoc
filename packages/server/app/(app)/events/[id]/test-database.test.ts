import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV,
  claimEventRoomPlaywrightRunContext,
  cleanupEventRoomPlaywrightRunAfterChildExit,
  cleanupReportedEventRoomPlaywrightRun,
  finalizeEventRoomPlaywrightWebServer,
  inspectEventRoomPlaywrightPortLease,
  prepareEventRoomPlaywrightServerWorkspace,
  releaseEventRoomPlaywrightPortLease,
  releaseEventRoomPlaywrightPortLeaseIfOwned,
  requireEventRoomPlaywrightRunContext,
  requireSyntheticEventRoomTestDatabaseUrl,
  resolveEventRoomPlaywrightRunContext,
} from './test-database';

const BASE_DATABASE_URL = 'postgresql://test:test@localhost:5432/psd_eoc_test';

function createSyntheticSourceWorkspace(): {
  readonly root: string;
  readonly server: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'psd-eoc-source-workspace-'));
  const server = join(root, 'packages', 'server');
  mkdirSync(join(server, 'app'), { recursive: true });
  mkdirSync(join(server, '.next'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"private":true}');
  writeFileSync(join(root, 'bun.lock'), 'synthetic lock');
  writeFileSync(join(root, 'tsconfig.base.json'), '{}');
  writeFileSync(
    join(server, 'package.json'),
    '{"name":"@psd-eoc/server","private":true}',
  );
  writeFileSync(
    join(server, 'tsconfig.json'),
    '{"extends":"../../tsconfig.base.json"}',
  );
  writeFileSync(join(server, 'next-env.d.ts'), 'shared generated metadata');
  writeFileSync(join(server, 'server.tsbuildinfo'), 'shared build metadata');
  writeFileSync(join(server, '.next', 'shared-build'), 'shared build output');
  writeFileSync(
    join(server, 'app', 'page.tsx'),
    'export default function Page() {}',
  );
  return { root, server };
}

describe('event-room synthetic database guard', () => {
  test('accepts IPv4, bracketed IPv6, and localhost loopback test databases', () => {
    for (const value of [
      'postgresql://test:test@127.0.0.1:5432/psd_eoc_test',
      'postgresql://test:test@[::1]:5432/psd_eoc_test',
      'postgresql://test:test@localhost:5432/psd-eoc-test',
    ]) {
      expect(requireSyntheticEventRoomTestDatabaseUrl(value, false)).toBe(
        value,
      );
    }
  });

  test('rejects remote IPv6, non-test names, and URL options by default', () => {
    for (const value of [
      'postgresql://test:test@[2001:db8::1]:5432/psd_eoc_test',
      'postgresql://test:test@localhost:5432/psd_eoc',
      'postgresql://test:test@localhost:5432/psd_eoc_test?sslmode=require',
    ]) {
      expect(() =>
        requireSyntheticEventRoomTestDatabaseUrl(value, false),
      ).toThrow();
    }
  });

  test('derives isolated database, files, and port from immutable run metadata', () => {
    const runId = randomUUID();
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      runId,
    );
    try {
      expect(context.databaseName).toBe(
        `psd_eoc_event_room_${runId.replaceAll('-', '')}_test`,
      );
      expect(new URL(context.databaseUrl).pathname).toBe(
        `/${context.databaseName}`,
      );
      expect(context.fixturePath.startsWith(`${context.runDirectory}/`)).toBe(
        true,
      );
      expect(
        context.storageStatePath.startsWith(`${context.runDirectory}/`),
      ).toBe(true);
      for (const path of [
        context.workspaceDirectory,
        context.serverDirectory,
        context.serverBuildDirectory,
        context.serverTsconfigPath,
        context.serverNextEnvPath,
        context.serverWorkspaceReadyPath,
        context.serverStoppedPath,
      ]) {
        expect(path.startsWith(`${context.runDirectory}${sep}`)).toBe(true);
      }
      expect(context.appPort).toBeGreaterThanOrEqual(20_000);
      expect(context.appPort).toBeLessThan(50_000);
      expect(requireEventRoomPlaywrightRunContext(context)).toEqual(context);
      expect(() =>
        requireEventRoomPlaywrightRunContext({
          ...context,
          databaseName: 'main',
        }),
      ).toThrow('altered');
    } finally {
      releaseEventRoomPlaywrightPortLease(context);
    }
  });

  test('atomically probes past a concurrent run holding the preferred port', () => {
    const first = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    let second: ReturnType<typeof claimEventRoomPlaywrightRunContext> | null =
      null;
    try {
      second = claimEventRoomPlaywrightRunContext(
        BASE_DATABASE_URL,
        randomUUID(),
        first.appPort,
      );
      expect(second.appPort).not.toBe(first.appPort);
      expect(second.appPort).toBeGreaterThanOrEqual(20_000);
      expect(second.appPort).toBeLessThan(50_000);
      expect(first.portLeasePath).not.toBe(second.portLeasePath);
      expect(first.workspaceDirectory).not.toBe(second.workspaceDirectory);
      expect(first.serverBuildDirectory).not.toBe(second.serverBuildDirectory);
      expect(first.serverTsconfigPath).not.toBe(second.serverTsconfigPath);
      expect(first.serverNextEnvPath).not.toBe(second.serverNextEnvPath);
    } finally {
      if (second !== null) releaseEventRoomPlaywrightPortLease(second);
      releaseEventRoomPlaywrightPortLease(first);
    }
  });

  test('publishes one run-scoped server copy and reuses it without overwriting a live overlay', () => {
    const source = createSyntheticSourceWorkspace();
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    try {
      prepareEventRoomPlaywrightServerWorkspace(context, source.server);

      expect(readFileSync(context.serverTsconfigPath, 'utf8')).toContain(
        '../../tsconfig.base.json',
      );
      expect(
        readFileSync(join(context.serverDirectory, 'app', 'page.tsx'), 'utf8'),
      ).toContain('function Page');
      expect(
        lstatSync(
          join(context.workspaceDirectory, 'node_modules'),
        ).isSymbolicLink(),
      ).toBe(true);
      expect(existsSync(context.serverBuildDirectory)).toBe(false);
      expect(existsSync(context.serverNextEnvPath)).toBe(false);
      expect(
        existsSync(join(context.serverDirectory, 'server.tsbuildinfo')),
      ).toBe(false);

      writeFileSync(context.serverTsconfigPath, 'live worker metadata');
      writeFileSync(
        join(source.server, 'tsconfig.json'),
        'changed shared source',
      );
      prepareEventRoomPlaywrightServerWorkspace(context, source.server);
      expect(readFileSync(context.serverTsconfigPath, 'utf8')).toBe(
        'live worker metadata',
      );
      expect(existsSync(context.serverWorkspacePreparationLeasePath)).toBe(
        false,
      );
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLease(context);
      rmSync(source.root, { force: true, recursive: true });
    }
  });

  test('retains the run directory and lease until the server exits and its port closes', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    mkdirSync(context.runDirectory, { recursive: true });
    let resolveServerExit: (exitCode: number) => void = () => undefined;
    const serverExit = new Promise<number>((resolveExit) => {
      resolveServerExit = resolveExit;
    });
    let announcePortWait: () => void = () => undefined;
    const portWaitStarted = new Promise<void>((resolveStarted) => {
      announcePortWait = resolveStarted;
    });
    let resolvePortClosed: () => void = () => undefined;
    const portClosed = new Promise<void>((resolveClosed) => {
      resolvePortClosed = resolveClosed;
    });
    let replacement: ReturnType<
      typeof claimEventRoomPlaywrightRunContext
    > | null = null;

    try {
      const finalizing = finalizeEventRoomPlaywrightWebServer(
        context,
        () => serverExit,
        async (appPort) => {
          expect(appPort).toBe(context.appPort);
          announcePortWait();
          await portClosed;
        },
      );
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(true);
      expect(() => cleanupReportedEventRoomPlaywrightRun(context)).toThrow(
        'no stopped evidence',
      );

      resolveServerExit(0);
      await portWaitStarted;
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(true);

      resolvePortClosed();
      expect(await finalizing).toBe(0);
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(false);
      expect(existsSync(context.serverStoppedPath)).toBe(true);

      replacement = claimEventRoomPlaywrightRunContext(
        BASE_DATABASE_URL,
        randomUUID(),
        context.appPort,
      );
      expect(replacement.appPort).toBe(context.appPort);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('replacement');
      expect(releaseEventRoomPlaywrightPortLeaseIfOwned(context)).toBe(false);
      cleanupReportedEventRoomPlaywrightRun(context);
      expect(existsSync(context.runDirectory)).toBe(false);
      expect(existsSync(replacement.portLeasePath)).toBe(true);
      expect(inspectEventRoomPlaywrightPortLease(replacement)).toBe('owned');
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      if (replacement !== null) {
        releaseEventRoomPlaywrightPortLease(replacement);
      } else {
        releaseEventRoomPlaywrightPortLeaseIfOwned(context);
      }
    }
  });

  test('configures graceful wrapper shutdown and leaves server artifacts out of setup hooks', () => {
    const config = readFileSync(
      new URL('./playwright.config.ts', import.meta.url),
      'utf8',
    );
    const setup = readFileSync(
      new URL('./playwright.global-setup.ts', import.meta.url),
      'utf8',
    );
    const teardown = readFileSync(
      new URL('./playwright.global-teardown.ts', import.meta.url),
      'utf8',
    );
    const cleanupReporter = readFileSync(
      new URL('./playwright.cleanup-reporter.ts', import.meta.url),
      'utf8',
    );
    expect(config).toContain('playwright.web-server.ts');
    expect(config).toContain('playwright.cleanup-reporter.ts');
    expect(config).toContain('gracefulShutdown');
    expect(cleanupReporter).toContain('onExit()');
    expect(cleanupReporter).toContain('cleanupReportedEventRoomPlaywrightRun');
    for (const hook of [setup, teardown]) {
      expect(hook).not.toContain('releaseEventRoomPlaywrightPortLease');
      expect(hook).not.toContain('rm(context.runDirectory');
    }
  });

  test('outer cleanup fails closed until an unmarked run independently proves its port closed', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    mkdirSync(context.runDirectory, { recursive: true });
    try {
      await expect(
        cleanupEventRoomPlaywrightRunAfterChildExit(
          context,
          async (appPort) => {
            expect(appPort).toBe(context.appPort);
            throw new Error('synthetic port remains open');
          },
        ),
      ).rejects.toThrow('synthetic port remains open');
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('owned');

      await cleanupEventRoomPlaywrightRunAfterChildExit(
        context,
        async () => undefined,
      );
      expect(existsSync(context.runDirectory)).toBe(false);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('absent');
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('reuses the coordinator run context when workers evaluate config', () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const runId = randomUUID();
    const coordinator = resolveEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      environment,
      () => runId,
    );
    try {
      const worker = resolveEventRoomPlaywrightRunContext(
        BASE_DATABASE_URL,
        environment,
        () => {
          throw new Error('a worker must not claim another run');
        },
      );
      expect(worker).toEqual(coordinator);
      expect(environment[EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV]).toBe(
        JSON.stringify(coordinator),
      );
    } finally {
      releaseEventRoomPlaywrightPortLease(coordinator);
    }
  });

  test('fails closed on malformed or cross-database inherited metadata', () => {
    expect(() =>
      resolveEventRoomPlaywrightRunContext(BASE_DATABASE_URL, {
        NODE_ENV: 'test',
        [EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV]: '{',
      }),
    ).toThrow('invalid JSON');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const coordinator = resolveEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      environment,
    );
    try {
      expect(() =>
        resolveEventRoomPlaywrightRunContext(
          'postgresql://test:test@localhost:5432/another_test',
          environment,
        ),
      ).toThrow('different base database');
    } finally {
      releaseEventRoomPlaywrightPortLease(coordinator);
    }
  });
});
