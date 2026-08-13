import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAYWRIGHT_IDS } from '../start/test/playwright.fixtures';
import { startFlowPlaywrightDatabaseUrl } from '../start/test/playwright-database';
import {
  START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV,
  START_FLOW_PLAYWRIGHT_RUN_ID_ENV,
  acquireStartFlowPlaywrightArtifacts,
  assertStartFlowPlaywrightArtifactsOwned,
  createStartFlowPlaywrightRunId,
  requireStartFlowPlaywrightRunId,
  startFlowPlaywrightPaths,
} from '../start/test/playwright-run';

const runId = requireStartFlowPlaywrightRunId(
  process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV] ??
    createStartFlowPlaywrightRunId(),
);
process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV] = runId;
const portSeed = Number.parseInt(runId.slice(0, 8), 16);
const appPort = Number(
  process.env.PSD_EOC_DELIVERY_TEST_APP_PORT ?? 40_000 + (portSeed % 5_000),
);
const idpPort = Number(
  process.env.PSD_EOC_DELIVERY_TEST_IDP_PORT ?? 50_000 + (portSeed % 5_000),
);
if (
  ![appPort, idpPort].every(
    (port) => Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535,
  ) ||
  appPort === idpPort
) {
  throw new Error('Delivery-test browser ports must be distinct user ports.');
}

const workerIndex = process.env.TEST_WORKER_INDEX;
const parallelIndex = process.env.TEST_PARALLEL_INDEX;
const isWorker =
  workerIndex !== undefined &&
  parallelIndex !== undefined &&
  /^\d+$/u.test(workerIndex) &&
  /^\d+$/u.test(parallelIndex);
if (
  (workerIndex === undefined) !== (parallelIndex === undefined) ||
  (workerIndex !== undefined && !isWorker)
) {
  throw new Error('The delivery-test Playwright worker identity is invalid.');
}
const disallowedCoordinatorArguments = [
  '--output',
  '--reporter',
  '--ui',
  '--ui-host',
  '--ui-port',
] as const;
const hasDisallowedArgument = process.argv
  .slice(2)
  .some((argument) =>
    disallowedCoordinatorArguments.some(
      (option) => argument === option || argument.startsWith(`${option}=`),
    ),
  );
if (isWorker) {
  if (process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] !== runId) {
    throw new Error('The Playwright worker has no matching artifact claim.');
  }
  await assertStartFlowPlaywrightArtifactsOwned(runId);
} else {
  if (hasDisallowedArgument || process.env.PWTEST_WATCH !== undefined) {
    throw new Error(
      'The delivery-test Playwright suite does not permit reporter, output, UI, or watch overrides.',
    );
  }
  if (process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] !== undefined) {
    throw new Error('The Playwright coordinator artifact claim is invalid.');
  }
  await acquireStartFlowPlaywrightArtifacts(runId);
  process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] = runId;
}

const deliveryTestRoot = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(deliveryTestRoot, '../../..');
const runPaths = startFlowPlaywrightPaths(runId);
const databaseUrl = startFlowPlaywrightDatabaseUrl(undefined, runId);
const sharedAuthEnvironment = {
  GOOGLE_OIDC_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  GOOGLE_OIDC_CLIENT_SECRET: 'synthetic-client-secret',
  GOOGLE_OIDC_REDIRECT_URI: `http://localhost:${appPort}/auth/callback`,
  GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 30).toString('base64url'),
  GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: `http://localhost:${idpPort}/authorize`,
  GOOGLE_OIDC_TOKEN_ENDPOINT: `http://localhost:${idpPort}/token`,
  GOOGLE_OIDC_JWKS_URI: `http://localhost:${idpPort}/jwks`,
} as const;

export default defineConfig({
  testDir: './test',
  testMatch: /delivery-test\.playwright\.ts$/u,
  globalSetup: resolve(deliveryTestRoot, 'test/playwright.global-setup.ts'),
  globalTeardown: resolve(
    deliveryTestRoot,
    'test/playwright.global-teardown.ts',
  ),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: runPaths.output,
  reporter: [
    ['line'],
    [resolve(deliveryTestRoot, '../start/test/playwright-cleanup-reporter.ts')],
  ],
  use: {
    baseURL: `http://localhost:${appPort}`,
    channel: process.env.CI === 'true' ? 'chrome' : undefined,
    storageState: runPaths.storageState,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: "bun 'app/(auth)/test/mock-google-idp.ts'",
      cwd: serverRoot,
      env: {
        ...sharedAuthEnvironment,
        MOCK_GOOGLE_OIDC_PORT: String(idpPort),
        [START_FLOW_PLAYWRIGHT_RUN_ID_ENV]: runId,
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
        PSD_EOC_PRODUCT_OWNER_USER_ID: PLAYWRIGHT_IDS.user,
        [START_FLOW_PLAYWRIGHT_RUN_ID_ENV]: runId,
      },
      url: `http://localhost:${appPort}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
