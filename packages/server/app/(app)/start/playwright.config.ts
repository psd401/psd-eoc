import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireSyntheticTestDatabaseUrl } from '../../(admin)/event-types/test-database';
import { START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH } from './test/playwright.global-setup';

const appPort = Number(process.env.PSD_EOC_START_APP_PORT ?? '3115');
const databaseUrl = requireSyntheticTestDatabaseUrl(
  process.env.TEST_DATABASE_URL,
);
if (!Number.isSafeInteger(appPort) || appPort < 1_024 || appPort > 65_535) {
  throw new Error('The start-flow Playwright app port must be a user port.');
}

const startRoot = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(startRoot, '../../..');

export default defineConfig({
  testDir: './test',
  testMatch: /playwright\.flow\.ts$/u,
  globalSetup: resolve(startRoot, 'test/playwright.global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: '/tmp/psd-eoc-issue15-playwright',
  reporter: [['line']],
  use: {
    baseURL: `http://localhost:${appPort}`,
    channel: process.env.CI === 'true' ? 'chrome' : undefined,
    storageState: START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH,
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
