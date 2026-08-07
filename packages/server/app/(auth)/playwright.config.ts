import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appPort = Number(process.env.PSD_EOC_PLAYWRIGHT_APP_PORT ?? '3106');
const idpPort = Number(process.env.PSD_EOC_PLAYWRIGHT_IDP_PORT ?? '4106');
if (
  ![appPort, idpPort].every(
    (port) => Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535,
  ) ||
  appPort === idpPort
) {
  throw new Error('Playwright app and IdP ports must be distinct user ports.');
}
const clientId = 'synthetic-client.apps.googleusercontent.com';
const clientSecret = 'synthetic-client-secret';
const cookieSecret = Buffer.alloc(32, 7).toString('base64url');
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sharedEnvironment = {
  GOOGLE_OIDC_CLIENT_ID: clientId,
  GOOGLE_OIDC_CLIENT_SECRET: clientSecret,
  GOOGLE_OIDC_REDIRECT_URI: `http://localhost:${appPort}/auth/callback`,
  GOOGLE_OIDC_COOKIE_SECRET: cookieSecret,
  GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: `http://localhost:${idpPort}/authorize`,
  GOOGLE_OIDC_TOKEN_ENDPOINT: `http://localhost:${idpPort}/token`,
  GOOGLE_OIDC_JWKS_URI: `http://localhost:${idpPort}/jwks`,
} as const;

export default defineConfig({
  testDir: '.',
  testMatch: /auth\.playwright\.ts$/u,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: '/tmp/psd-eoc-issue6-playwright',
  reporter: [['line']],
  use: {
    baseURL: `http://localhost:${appPort}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: "bun 'app/(auth)/test/mock-google-idp.ts'",
      cwd: serverRoot,
      env: {
        ...sharedEnvironment,
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
        ...sharedEnvironment,
        NODE_ENV: 'development',
        PSD_EOC_AUTH_TEST_MODE: 'playwright',
        PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS: 'mock-google-subject-member',
      },
      url: `http://localhost:${appPort}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
