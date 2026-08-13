import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import startFlowConfig from '../app/(app)/start/playwright.config';

const directory = dirname(fileURLToPath(import.meta.url));

/**
 * Issue #32's cross-screen evidence reuses the start-flow suite's isolated
 * database, authenticated human session, fail-closed web server, and exact
 * artifact cleanup. Only the test directory changes: production routes and
 * capability paths remain the ones exercised by the browser.
 */
export default defineConfig({
  ...startFlowConfig,
  testDir: directory,
  testMatch: /critical-journey\.playwright\.ts$/u,
  globalSetup: resolve(directory, 'playwright.global-setup.ts'),
  timeout: 600_000,
  expect: { timeout: 15_000 },
});
