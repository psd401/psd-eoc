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
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
