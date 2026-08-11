import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH } from './test/playwright.global-setup';
import { startFlowPlaywrightDatabaseUrl } from './test/playwright-database';

const appPort = Number(process.env.PSD_EOC_START_APP_PORT ?? '3115');
const idpPort = Number(process.env.PSD_EOC_START_IDP_PORT ?? '4115');
const databaseUrl = startFlowPlaywrightDatabaseUrl();
if (
  ![appPort, idpPort].every(
    (port) => Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535,
  ) ||
  appPort === idpPort
) {
  throw new Error(
    'The start-flow Playwright app and IdP ports must be distinct user ports.',
  );
}

const startRoot = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(startRoot, '../../..');
const sharedAuthEnvironment = {
  GOOGLE_OIDC_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  GOOGLE_OIDC_CLIENT_SECRET: 'synthetic-client-secret',
  GOOGLE_OIDC_REDIRECT_URI: `http://localhost:${appPort}/auth/callback`,
  GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 15).toString('base64url'),
  GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: `http://localhost:${idpPort}/authorize`,
  GOOGLE_OIDC_TOKEN_ENDPOINT: `http://localhost:${idpPort}/token`,
  GOOGLE_OIDC_JWKS_URI: `http://localhost:${idpPort}/jwks`,
} as const;

export default defineConfig({
  testDir: './test',
  testMatch: /playwright\.flow\.ts$/u,
  globalSetup: resolve(startRoot, 'test/playwright.global-setup.ts'),
  globalTeardown: resolve(startRoot, 'test/playwright.global-teardown.ts'),
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
  webServer: [
    {
      command: "bun 'app/(auth)/test/mock-google-idp.ts'",
      cwd: serverRoot,
      env: {
        ...sharedAuthEnvironment,
        MOCK_GOOGLE_OIDC_PORT: String(idpPort),
      },
      port: idpPort,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `bun run dev --hostname localhost --port ${appPort}`,
      cwd: serverRoot,
      env: {
        ...sharedAuthEnvironment,
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'development',
      },
      url: `http://localhost:${appPort}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
