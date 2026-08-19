import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  prepareEventRoomPlaywrightServerWorkspace,
  requireSyntheticEventRoomTestDatabaseUrl,
  resolveEventRoomPlaywrightRunContext,
} from './test-database';

const baseDatabaseUrl = requireSyntheticEventRoomTestDatabaseUrl(
  process.env.TEST_DATABASE_URL,
);
const eventRoomRun = resolveEventRoomPlaywrightRunContext(baseDatabaseUrl);

const configDirectory = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(configDirectory, '../../../..');
prepareEventRoomPlaywrightServerWorkspace(eventRoomRun, serverRoot);

export default defineConfig({
  metadata: { eventRoomRun },
  testDir: '.',
  testMatch: /event-room\.playwright\.ts$/u,
  globalSetup: resolve(configDirectory, 'playwright.global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  // 90s, not 60s. The 60s ceiling was set when no layout rendered a global
  // navigation. Adding one costs this suite about 15%: the same gate on the
  // same runner takes 657,950 ms on the commit before the navigation and
  // 753,933 ms after it, single worker both times. The cost is per navigation
  // and is a `next dev` artifact — one more stylesheet chunk and a larger
  // layout module graph compiled on demand — not something a viewer of the
  // built application pays.
  //
  // The average test here takes about 14s, so that tax is invisible to almost
  // all of them. The handful that drive the synthetic clock, hold network
  // responses, and navigate several times already ran near 60s, and 15% put
  // whichever one sat closest over the edge. That is why the failing test
  // moved between runs while the suite itself stayed correct: 47 of 48 passed
  // every time, and which one failed was decided by the ceiling, not by a
  // defect.
  //
  // Raise the assertion timeout with it. A per-test budget is worth nothing if
  // a single expect() inside it still gives up on the old schedule.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: eventRoomRun.outputDirectory,
  reporter: [
    ['line'],
    [resolve(configDirectory, 'playwright.cleanup-reporter.ts')],
  ],
  use: {
    baseURL: `http://localhost:${eventRoomRun.appPort}`,
    bypassCSP: true,
    channel: process.env.CI === 'true' ? 'chrome' : undefined,
    storageState: eventRoomRun.storageStatePath,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'exec bun "app/(app)/events/[id]/playwright.web-server.ts"',
    cwd: eventRoomRun.serverDirectory,
    env: {
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: eventRoomRun.databaseUrl,
      NODE_ENV: 'development',
    },
    url: `http://localhost:${eventRoomRun.appPort}/login`,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
