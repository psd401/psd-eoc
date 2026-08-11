import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  prepareAdminPlaywrightServerWorkspace,
  requireInheritedAdminPlaywrightRunContext,
} from './playwright-run';

const directory = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(directory, '../../..');
const adminRun = requireInheritedAdminPlaywrightRunContext();
prepareAdminPlaywrightServerWorkspace(adminRun, serverRoot);

export default defineConfig({
  testDir: '.',
  testMatch: /admin\.playwright\.ts$/u,
  globalSetup: resolve(directory, 'playwright.global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: adminRun.outputDirectory,
  reporter: [['line']],
  use: {
    baseURL: `http://localhost:${adminRun.appPort}`,
    channel: process.env.CI === 'true' ? 'chrome' : undefined,
    storageState: adminRun.storageStatePath,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run dev --hostname localhost --port ${adminRun.appPort}`,
    cwd: adminRun.serverDirectory,
    env: {
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: adminRun.databaseUrl,
      NODE_ENV: 'development',
    },
    url: `http://localhost:${adminRun.appPort}/login`,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
