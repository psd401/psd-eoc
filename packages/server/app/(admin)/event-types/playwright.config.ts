import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireSyntheticTestDatabaseUrl } from './test-database';
import {
  prepareEventTypePlaywrightServerWorkspace,
  resolveEventTypePlaywrightRunContext,
} from './playwright-run';

const baseDatabaseUrl = requireSyntheticTestDatabaseUrl(
  process.env.TEST_DATABASE_URL,
);
const eventTypeRun = resolveEventTypePlaywrightRunContext(baseDatabaseUrl);

const configDirectory = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(configDirectory, '../../..');
prepareEventTypePlaywrightServerWorkspace(eventTypeRun, serverRoot);

export default defineConfig({
  metadata: { eventTypeRun },
  testDir: '.',
  testMatch: /event-types\.playwright\.ts$/u,
  globalSetup: resolve(configDirectory, 'playwright.global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: eventTypeRun.outputDirectory,
  reporter: [
    ['line'],
    [resolve(configDirectory, 'playwright.cleanup-reporter.ts')],
  ],
  use: {
    baseURL: `http://localhost:${eventTypeRun.appPort}`,
    channel: process.env.CI === 'true' ? 'chrome' : undefined,
    storageState: eventTypeRun.storageStatePath,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'exec bun "app/(admin)/event-types/playwright.web-server.ts"',
    cwd: eventTypeRun.serverDirectory,
    env: {
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: eventTypeRun.databaseUrl,
      NODE_ENV: 'development',
    },
    url: `http://localhost:${eventTypeRun.appPort}/login`,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
