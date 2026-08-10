import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENT_ROOM_PLAYWRIGHT_STORAGE_STATE_PATH,
  requireSyntheticEventRoomTestDatabaseUrl,
} from './test-database';

const appPort = Number(process.env.PSD_EOC_EVENT_ROOM_APP_PORT ?? '3116');
const databaseUrl = requireSyntheticEventRoomTestDatabaseUrl(
  process.env.TEST_DATABASE_URL,
);
if (!Number.isSafeInteger(appPort) || appPort < 1_024 || appPort > 65_535) {
  throw new Error('The Playwright app port must be a user port.');
}

const serverRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

export default defineConfig({
  testDir: '.',
  testMatch: /event-room\.playwright\.ts$/u,
  globalSetup: resolve(
    dirname(fileURLToPath(import.meta.url)),
    'playwright.global-setup.ts',
  ),
  globalTeardown: resolve(
    dirname(fileURLToPath(import.meta.url)),
    'playwright.global-teardown.ts',
  ),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: '/tmp/psd-eoc-issue16-playwright',
  reporter: [['line']],
  use: {
    baseURL: `http://localhost:${appPort}`,
    bypassCSP: true,
    channel: process.env.CI === 'true' ? 'chrome' : undefined,
    storageState: EVENT_ROOM_PLAYWRIGHT_STORAGE_STATE_PATH,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run dev --hostname localhost --port ${appPort}`,
    cwd: serverRoot,
    env: {
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'development',
    },
    url: `http://localhost:${appPort}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
