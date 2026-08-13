import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  MobileOidcStartResponseSchema,
  MobileSessionResponseSchema,
} from '@psd-eoc/contracts';
import { and, eq } from 'drizzle-orm';

import { createDatabaseClient } from '../db/client';
import { events, journalEntries } from '../db/schema';
import startFlowGlobalTeardown from '../app/(app)/start/test/playwright.global-teardown';
import { startFlowPlaywrightDatabaseUrl } from '../app/(app)/start/test/playwright-database';
import {
  StartFlowPlaywrightFixtureSchema,
  type StartFlowPlaywrightFixture,
} from '../app/(app)/start/test/playwright.fixtures';
import {
  START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV,
  START_FLOW_PLAYWRIGHT_RUN_ID_ENV,
  acquireStartFlowPlaywrightArtifacts,
  removeStartFlowPlaywrightArtifacts,
  startFlowPlaywrightPaths,
} from '../app/(app)/start/test/playwright-run';
import {
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
} from '../lib/capabilities/journal';
import type { TrustedCapabilityInvocation } from '../lib/capabilities/engine';
import prepareCriticalJourney from './playwright.global-setup';
import {
  MOBILE_MOCK_GOOGLE_MEMBER_LINK_LABEL,
  createMobileMockGoogleIdp,
  type MobileMockGoogleIdp,
} from './mobile-mock-google-idp';
import {
  MobileRuntimeManifestSchema,
  acquireMobileRuntimeRoot,
  executeMobileRuntimeCleanup,
  parseMobileRuntimeCli,
  publishMobileRuntimeManifest,
  removeMobileRuntimeRoot,
  removeOwnedMobileRuntimeManifest,
  requireMobileRuntimeEnvironment,
  type MobileRuntimeManifest,
  type OwnedManifest,
} from './mobile-runtime-lib';

const LOOPBACK_HOST = '127.0.0.1' as const;
const GOOGLE_CLIENT_ID = 'synthetic-client.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'synthetic-issue-32-client-secret';
const STARTUP_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 10_000;
const RETRY_DELAY_MS = 250;
const PROBE_REQUEST_TIMEOUT_MS = 30_000;

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serverRoot, '../..');

class ShutdownRequestedError extends Error {
  public constructor() {
    super('Issue #32 mobile runtime shutdown requested.');
    this.name = 'ShutdownRequestedError';
  }
}

class MobileRuntimeReadinessInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MobileRuntimeReadinessInvariantError';
  }
}

interface PreparedMobileEvent {
  readonly event: MobileRuntimeManifest['event'];
}

interface ShutdownController {
  readonly promise: Promise<NodeJS.Signals>;
  requested(): boolean;
  dispose(): void;
}

function createShutdownController(): ShutdownController {
  let requested = false;
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      if (!requested) {
        requested = true;
        resolveSignal(signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return Object.freeze({
    promise,
    requested: () => requested,
    dispose(): void {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    },
  });
}

function assertRunning(shutdown: ShutdownController): void {
  if (shutdown.requested()) throw new ShutdownRequestedError();
}

function routeEvidenceInvocation(runId: string): TrustedCapabilityInvocation {
  return Object.freeze({
    actor: {
      kind: 'agent' as const,
      agentId: randomUUID(),
      apiKeyId: randomUUID(),
    },
    source: 'agent-rest' as const,
    scope: { facilityScope: { kind: 'district' as const } },
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: null,
    mutation: {
      idempotencyKey: `issue-32-mobile-route-${runId}`,
      transport: {
        kind: 'agent-rest-command' as const,
        method: 'POST' as const,
      },
      humanConfirmationId: null,
    },
  });
}

async function readStartFlowFixture(
  runId: string,
): Promise<StartFlowPlaywrightFixture> {
  return StartFlowPlaywrightFixtureSchema.parse(
    JSON.parse(await readFile(startFlowPlaywrightPaths(runId).fixture, 'utf8')),
  );
}

async function appendCanonicalRouteEvidence(
  runId: string,
  databaseUrl: string,
): Promise<PreparedMobileEvent> {
  const fixture = await readStartFlowFixture(runId);
  const seededEvent = fixture.activeEvents[0];
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: databaseUrl,
    maxConnections: 2,
  });
  if (connection.driver !== 'postgres') {
    await connection.close();
    throw new Error('Issue #32 mobile runtime requires PostgreSQL.');
  }
  try {
    const [event] = await connection.db
      .select({
        id: events.id,
        facilityId: events.facilityId,
        eventTypeVersionId: events.eventTypeVersionId,
        kind: events.kind,
        templateMode: events.templateMode,
        rosterPopulation: events.rosterPopulation,
        status: events.status,
      })
      .from(events)
      .where(eq(events.id, seededEvent.id))
      .limit(1);
    if (
      event === undefined ||
      event.kind !== 'drill' ||
      event.templateMode !== 'drill' ||
      event.rosterPopulation !== 'synthetic' ||
      event.status !== 'active'
    ) {
      throw new Error(
        'The issue #32 mobile route fixture is not an active synthetic drill.',
      );
    }

    const routeEvidence = `Issue 32 route proof ${runId}`;
    const entry = await executeJournalCapability(
      'append-journal-entry',
      {
        eventId: event.id,
        clientTime: null,
        supersedes: null,
        kind: 'text',
        payload: { text: routeEvidence },
      },
      routeEvidenceInvocation(runId),
      createDrizzleJournalCapabilityStore(connection.db),
    );
    const [persisted] = await connection.db
      .select({
        id: journalEntries.id,
        eventId: journalEntries.eventId,
        kind: journalEntries.kind,
        payload: journalEntries.payload,
        supersedesEntryId: journalEntries.supersedesEntryId,
      })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, entry.id),
          eq(journalEntries.eventId, event.id),
        ),
      )
      .limit(1);
    if (
      entry.kind !== 'text' ||
      entry.payload.text !== routeEvidence ||
      entry.supersedes !== null ||
      persisted?.kind !== 'text' ||
      persisted.supersedesEntryId !== null ||
      (persisted.payload as { readonly text?: unknown }).text !== routeEvidence
    ) {
      throw new Error(
        'Canonical append-only route evidence was not persisted exactly.',
      );
    }
    return Object.freeze({
      event: Object.freeze({
        id: event.id,
        facilityId: event.facilityId,
        eventTypeVersionId: event.eventTypeVersionId,
        routeEvidence,
      }),
    });
  } finally {
    await connection.close();
  }
}

async function copyServerForRuntime(runId: string): Promise<string> {
  const paths = await acquireMobileRuntimeRoot(runId);
  try {
    await mkdir(resolve(paths.workspace, 'packages'), { recursive: true });
    await cp(serverRoot, paths.copiedServer, {
      recursive: true,
      filter(source) {
        const name = source.slice(source.lastIndexOf('/') + 1);
        return (
          ![
            '.next',
            'next-env.d.ts',
            'node_modules',
            'tsconfig.tsbuildinfo',
          ].includes(name) &&
          name !== '.env' &&
          !name.startsWith('.env.')
        );
      },
    });
    await cp(
      resolve(repositoryRoot, 'tsconfig.base.json'),
      resolve(paths.workspace, 'tsconfig.base.json'),
    );
    await symlink(
      resolve(repositoryRoot, 'node_modules'),
      resolve(paths.workspace, 'node_modules'),
      'dir',
    );
    await writeFile(resolve(paths.root, 'workspace-ready'), `${runId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return paths.copiedServer;
  } catch (error) {
    await removeMobileRuntimeRoot(runId).catch(() => undefined);
    throw error;
  }
}

function startNextServer(
  copiedServer: string,
  appPort: number,
  databaseUrl: string,
  idpOrigin: string,
): ReturnType<typeof Bun.spawn> {
  // Next development requests canonicalize their callback host to localhost;
  // keep the provider callback on that exact loopback origin while the
  // manifest/API origin remains the unambiguous 127.0.0.1 host.
  const callbackOrigin = `http://localhost:${appPort}`;
  const nextExecutable = resolve(
    repositoryRoot,
    'node_modules/next/dist/bin/next',
  );
  return Bun.spawn(
    [
      process.execPath,
      nextExecutable,
      'dev',
      '--hostname',
      LOOPBACK_HOST,
      '--port',
      String(appPort),
    ],
    {
      cwd: copiedServer,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
        GOOGLE_OIDC_CLIENT_ID: GOOGLE_CLIENT_ID,
        GOOGLE_OIDC_CLIENT_SECRET: GOOGLE_CLIENT_SECRET,
        GOOGLE_OIDC_REDIRECT_URI: `${callbackOrigin}/auth/callback`,
        GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 32).toString('base64url'),
        GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: `${idpOrigin}/authorize`,
        GOOGLE_OIDC_TOKEN_ENDPOINT: `${idpOrigin}/token`,
        GOOGLE_OIDC_JWKS_URI: `${idpOrigin}/jwks`,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
}

async function terminateProcess(
  child: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = child.exited.then(() => undefined);
  child.kill('SIGTERM');
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolveTimeout) => {
        forceTimer = setTimeout(
          () => resolveTimeout('timeout'),
          TERMINATION_GRACE_MS,
        );
      }),
    ]);
    if (outcome === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
  } finally {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
  }
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function mobileProbeFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
  });
}

async function verifiedMobileSignInProbe(
  appOrigin: string,
  idpOrigin: string,
  runId: string,
): Promise<void> {
  const verifier = Buffer.from(
    createHash('sha256').update(runId).digest(),
  ).toString('base64url');
  const startResponse = await mobileProbeFetch(
    `${appOrigin}/api/auth/mobile/oidc/start`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platform: 'ios',
        installationId: `issue-32-runtime-${runId}`,
        codeChallenge: codeChallenge(verifier),
      }),
      redirect: 'manual',
    },
  );
  if (!startResponse.ok) {
    throw new Error('The mobile OIDC start route is not ready.');
  }
  const parsedStart = MobileOidcStartResponseSchema.safeParse(
    await startResponse.json(),
  );
  if (!parsedStart.success) {
    throw new MobileRuntimeReadinessInvariantError(
      'The mobile OIDC start route returned an invalid response.',
    );
  }
  const start = parsedStart.data;
  const authorizationUrl = new URL(start.authorizationUrl);
  if (
    authorizationUrl.origin !== idpOrigin ||
    authorizationUrl.pathname !== '/authorize'
  ) {
    throw new MobileRuntimeReadinessInvariantError(
      'The mobile OIDC start route did not select the mock IdP.',
    );
  }
  const authorizationPage = await mobileProbeFetch(authorizationUrl, {
    redirect: 'manual',
  });
  const authorizationHtml = await authorizationPage.text();
  const requestId = authorizationHtml.match(
    /request_id=([0-9a-f-]{36})&amp;identity=member/u,
  )?.[1];
  if (
    !authorizationPage.ok ||
    requestId === undefined ||
    !authorizationHtml.includes(MOBILE_MOCK_GOOGLE_MEMBER_LINK_LABEL)
  ) {
    throw new MobileRuntimeReadinessInvariantError(
      'The synthetic mobile identity page did not expose the member action.',
    );
  }
  const providerCallback = await mobileProbeFetch(
    `${idpOrigin}/authorize/complete?request_id=${requestId}&identity=member`,
    { redirect: 'manual' },
  );
  const serverCallbackUrl = providerCallback.headers.get('location');
  if (providerCallback.status !== 302 || serverCallbackUrl === null) {
    throw new MobileRuntimeReadinessInvariantError(
      'The synthetic mobile identity callback was not issued.',
    );
  }
  const appCallback = await mobileProbeFetch(serverCallbackUrl, {
    redirect: 'manual',
  });
  const applicationRedirect = appCallback.headers.get('location');
  if (appCallback.status !== 303 || applicationRedirect === null) {
    throw new MobileRuntimeReadinessInvariantError(
      `The server did not relay the mobile OIDC callback (status ${appCallback.status}).`,
    );
  }
  const relay = new URL(applicationRedirect);
  const authorizationCode = relay.searchParams.get('code');
  const state = relay.searchParams.get('state');
  if (
    relay.origin !== 'null' ||
    relay.protocol !== 'psdeoc:' ||
    authorizationCode === null ||
    state !== start.state
  ) {
    throw new MobileRuntimeReadinessInvariantError(
      `The mobile OIDC relay was invalid (protocol ${relay.protocol}, host ${relay.hostname}, path ${relay.pathname}, code ${authorizationCode === null ? 'missing' : 'present'}, state ${state === start.state ? 'matched' : 'mismatched'}).`,
    );
  }
  const exchangeResponse = await mobileProbeFetch(
    `${appOrigin}/api/auth/mobile/oidc/exchange`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        authorizationCode,
        state,
        codeVerifier: verifier,
        flowToken: start.flowToken,
      }),
      redirect: 'manual',
    },
  );
  if (!exchangeResponse.ok) {
    throw new MobileRuntimeReadinessInvariantError(
      `The mobile OIDC exchange was rejected (status ${exchangeResponse.status}).`,
    );
  }
  if (
    !MobileSessionResponseSchema.safeParse(await exchangeResponse.json())
      .success
  ) {
    throw new MobileRuntimeReadinessInvariantError(
      'The mobile OIDC exchange returned an invalid session.',
    );
  }
}

async function awaitMobileRuntimeReady(
  appOrigin: string,
  idpOrigin: string,
  runId: string,
  serverProcess: ReturnType<typeof Bun.spawn>,
  shutdown: ShutdownController,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    assertRunning(shutdown);
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `The issue #32 Next server exited before readiness (${serverProcess.exitCode}).`,
      );
    }
    try {
      await verifiedMobileSignInProbe(appOrigin, idpOrigin, runId);
      return;
    } catch (error) {
      if (error instanceof MobileRuntimeReadinessInvariantError) throw error;
      lastFailure = error;
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
  throw new AggregateError(
    lastFailure === undefined ? [] : [lastFailure],
    'The issue #32 mobile runtime did not become ready in time.',
  );
}

async function main(): Promise<void> {
  const options = parseMobileRuntimeCli(process.argv.slice(2));
  const baseDatabaseUrl = requireMobileRuntimeEnvironment();
  const shutdown = createShutdownController();
  const runId = options.runId;
  const appOrigin = `http://${LOOPBACK_HOST}:${options.appPort}`;
  const idpOrigin = `http://${LOOPBACK_HOST}:${options.idpPort}`;
  const callbackOrigin = `http://localhost:${options.appPort}`;
  const databaseUrl = startFlowPlaywrightDatabaseUrl(baseDatabaseUrl, runId);

  let artifactsAcquired = false;
  let runtimeRootAcquired = false;
  let idp: MobileMockGoogleIdp | undefined;
  let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
  let ownedManifest: OwnedManifest | undefined;
  let setupFailure: unknown;
  try {
    if (
      process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV] !== undefined ||
      process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] !== undefined
    ) {
      throw new Error(
        'The issue #32 mobile runtime inherited a fixture claim.',
      );
    }
    process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV] = runId;
    await acquireStartFlowPlaywrightArtifacts(runId);
    artifactsAcquired = true;
    process.env[START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV] = runId;
    assertRunning(shutdown);
    await prepareCriticalJourney();
    assertRunning(shutdown);
    const prepared = await appendCanonicalRouteEvidence(runId, databaseUrl);
    assertRunning(shutdown);
    const copiedServer = await copyServerForRuntime(runId);
    runtimeRootAcquired = true;
    assertRunning(shutdown);
    idp = await createMobileMockGoogleIdp({
      hostname: LOOPBACK_HOST,
      port: options.idpPort,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackOrigin,
    });
    serverProcess = startNextServer(
      copiedServer,
      options.appPort,
      databaseUrl,
      idpOrigin,
    );
    await awaitMobileRuntimeReady(
      appOrigin,
      idpOrigin,
      runId,
      serverProcess,
      shutdown,
    );
    assertRunning(shutdown);
    const manifest = MobileRuntimeManifestSchema.parse({
      runId,
      appOrigin,
      idpOrigin,
      event: prepared.event,
      classification: 'drill',
      templateMode: 'drill',
      rosterPopulation: 'synthetic',
    });
    ownedManifest = await publishMobileRuntimeManifest(
      options.manifestPath,
      manifest,
    );
    console.log(
      `[issue #32 mobile runtime] ready: ${appOrigin} (${manifest.classification}, synthetic only)`,
    );
    const outcome = await Promise.race([
      shutdown.promise.then(() => ({ kind: 'signal' as const })),
      serverProcess.exited.then((exitCode) => ({
        kind: 'server-exit' as const,
        exitCode,
      })),
    ]);
    if (outcome.kind === 'server-exit') {
      throw new Error(
        `The issue #32 Next server exited unexpectedly (${outcome.exitCode}).`,
      );
    }
  } catch (error) {
    if (!(error instanceof ShutdownRequestedError) && !shutdown.requested()) {
      setupFailure = error;
    }
  }
  const cleanupTasks: Array<() => void | Promise<void>> = [];
  if (ownedManifest !== undefined) {
    const manifestToRemove = ownedManifest;
    cleanupTasks.push(() => removeOwnedMobileRuntimeManifest(manifestToRemove));
  }
  if (serverProcess !== undefined) {
    const processToTerminate = serverProcess;
    cleanupTasks.push(() => terminateProcess(processToTerminate));
  }
  if (idp !== undefined) {
    const idpToStop = idp;
    cleanupTasks.push(() => idpToStop.stop());
  }
  if (artifactsAcquired) {
    cleanupTasks.push(
      () => startFlowGlobalTeardown(),
      () => removeStartFlowPlaywrightArtifacts(runId),
    );
  }
  if (runtimeRootAcquired) {
    cleanupTasks.push(() => removeMobileRuntimeRoot(runId));
  }
  let cleanupFailure: unknown;
  try {
    await executeMobileRuntimeCleanup(cleanupTasks);
  } catch (error) {
    cleanupFailure = error;
  }
  shutdown.dispose();
  const failures: unknown[] = [];
  if (setupFailure !== undefined) failures.push(setupFailure);
  if (cleanupFailure !== undefined) failures.push(cleanupFailure);
  if (failures.length > 0) {
    if (
      failures.length === 1 &&
      failures[0] instanceof MobileRuntimeReadinessInvariantError
    ) {
      throw failures[0];
    }
    throw new AggregateError(
      failures,
      'Issue #32 mobile runtime failed and cleaned up fail-closed.',
    );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Mobile runtime failed.',
    );
    process.exitCode = 1;
  }
}
