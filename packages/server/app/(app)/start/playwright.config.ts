import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFlowPlaywrightDatabaseUrl } from './test/playwright-database';
import {
  START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV,
  START_FLOW_PLAYWRIGHT_RUN_ID_ENV,
  acquireStartFlowPlaywrightArtifacts,
  assertStartFlowPlaywrightArtifactsOwned,
  createStartFlowPlaywrightRunId,
  requireStartFlowPlaywrightRunId,
  startFlowPlaywrightPaths,
} from './test/playwright-run';

const runId = requireStartFlowPlaywrightRunId(
  process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV] ??
    createStartFlowPlaywrightRunId(),
);
process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV] = runId;
const runPortSeed = Number.parseInt(runId.slice(0, 8), 16);
const appPort = Number(
  process.env.PSD_EOC_START_APP_PORT ?? 20_000 + (runPortSeed % 10_000),
);
const idpPort = Number(
  process.env.PSD_EOC_START_IDP_PORT ?? 30_000 + (runPortSeed % 10_000),
);
const databaseUrl = startFlowPlaywrightDatabaseUrl(undefined, runId);
const runPaths = startFlowPlaywrightPaths(runId);
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

const workerIndex = process.env.TEST_WORKER_INDEX;
const parallelIndex = process.env.TEST_PARALLEL_INDEX;
const isPlaywrightWorker =
  workerIndex !== undefined &&
  parallelIndex !== undefined &&
  /^\d+$/u.test(workerIndex) &&
  /^\d+$/u.test(parallelIndex);
if (
  (workerIndex === undefined) !== (parallelIndex === undefined) ||
  (workerIndex !== undefined && !isPlaywrightWorker)
) {
  throw new Error('The Playwright worker identity is invalid.');
}
const disallowedCoordinatorArguments = [
  '--output',
  '--reporter',
  '--ui',
  '--ui-host',
  '--ui-port',
] as const;
const hasDisallowedCoordinatorArgument = process.argv
  .slice(2)
  .some((argument) =>
    disallowedCoordinatorArguments.some(
      (option) => argument === option || argument.startsWith(`${option}=`),
    ),
  );

// The coordinator claims ownership before Playwright's pre-run output clear.
// Workers reload this config, so they may only revalidate that exact claim.
if (isPlaywrightWorker) {
  if (process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] !== runId) {
    throw new Error('The Playwright worker has no matching artifact claim.');
  }
  await assertStartFlowPlaywrightArtifactsOwned(runId);
} else {
  if (
    hasDisallowedCoordinatorArgument ||
    process.env.PWTEST_WATCH !== undefined
  ) {
    throw new Error(
      'The start-flow Playwright suite does not permit reporter, output, UI, or watch overrides.',
    );
  }
  if (process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] !== undefined) {
    throw new Error('The Playwright coordinator artifact claim is invalid.');
  }
  await acquireStartFlowPlaywrightArtifacts(runId);
  process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] = runId;
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
  outputDir: runPaths.output,
  reporter: [
    ['line'],
    [resolve(startRoot, 'test/playwright-cleanup-reporter.ts')],
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
        [START_FLOW_PLAYWRIGHT_RUN_ID_ENV]: runId,
      },
      url: `http://localhost:${appPort}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
