import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENT_TYPE_PLAYWRIGHT_STORAGE_STATE_PATH,
  requireSyntheticTestDatabaseUrl,
} from './test-database';

const appPort = Number(process.env.PSD_EOC_EVENT_TYPES_APP_PORT ?? '3110');
const databaseUrl = requireSyntheticTestDatabaseUrl(
  process.env.TEST_DATABASE_URL,
);
if (!Number.isSafeInteger(appPort) || appPort < 1_024 || appPort > 65_535) {
  throw new Error('The Playwright app port must be a user port.');
}

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  testDir: '.',
  testMatch: /event-types\.playwright\.ts$/u,
  globalSetup: resolve(
    dirname(fileURLToPath(import.meta.url)),
    'playwright.global-setup.ts',
  ),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: '/tmp/psd-eoc-issue10-playwright',
  reporter: [['line']],
  use: {
    baseURL: `http://localhost:${appPort}`,
    storageState: EVENT_TYPE_PLAYWRIGHT_STORAGE_STATE_PATH,
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
