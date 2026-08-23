import { defineConfig } from '@playwright/test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_ROOT = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PSD_EOC_E2E_APP_PORT);
const stateDirectory = process.env.PSD_EOC_E2E_STATE_DIR;
if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
  throw new Error('PSD_EOC_E2E_APP_PORT must be a user port.');
}
if (stateDirectory === undefined) {
  throw new Error('PSD_EOC_E2E_STATE_DIR is required.');
}

export default defineConfig({
  testDir: E2E_ROOT,
  testMatch: /\.flow\.ts$/u,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: join(stateDirectory, 'artifacts'),
  reporter: 'line',
  use: {
    baseURL: `http://localhost:${port}`,
    storageState: join(stateDirectory, 'district-admin.json'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `bun run dev --hostname localhost --port ${port}`,
    cwd: resolve(E2E_ROOT, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
    url: `http://localhost:${port}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
