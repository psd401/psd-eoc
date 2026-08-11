import postgres from 'postgres';

import {
  START_FLOW_PLAYWRIGHT_RUN_ID_ENV,
  requireStartFlowPlaywrightRunId,
} from './playwright-run';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../../(admin)/facilities/owned-database-lifecycle';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SYNTHETIC_DATABASE_PATTERN = /^[A-Za-z0-9_-]+[-_]test$/u;

interface DatabaseMarkerRow {
  readonly marker: string | null;
}

function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function requireLoopbackBaseDatabase(value: string | undefined): URL {
  if (value === undefined || value.length === 0) {
    throw new Error('TEST_DATABASE_URL is required for start-flow tests.');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  let baseName: string;
  try {
    baseName = decodeURIComponent(baseUrl.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL must name a synthetic test database.');
  }
  if (
    (baseUrl.protocol !== 'postgres:' && baseUrl.protocol !== 'postgresql:') ||
    !LOOPBACK_HOSTS.has(normalizedHostname(baseUrl)) ||
    !SYNTHETIC_DATABASE_PATTERN.test(baseName) ||
    baseUrl.search.length > 0 ||
    baseUrl.hash.length > 0
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target a loopback PostgreSQL database whose name ends in _test.',
    );
  }
  return baseUrl;
}

/** Exact PostgreSQL identifier owned by one validated browser run. */
export function startFlowPlaywrightDatabaseName(
  runIdValue: string | undefined = process.env[
    START_FLOW_PLAYWRIGHT_RUN_ID_ENV
  ],
): string {
  const runId = requireStartFlowPlaywrightRunId(runIdValue);
  return `psd_eoc_i15_pw_${runId}_test`;
}

/** Exact non-secret catalog comment owned by one validated browser run. */
export function startFlowPlaywrightDatabaseMarker(
  runIdValue: string | undefined = process.env[
    START_FLOW_PLAYWRIGHT_RUN_ID_ENV
  ],
): string {
  const runId = requireStartFlowPlaywrightRunId(runIdValue);
  return JSON.stringify({
    kind: 'psd-eoc-start-flow-playwright-database',
    version: 1,
    runId,
    databaseName: startFlowPlaywrightDatabaseName(runId),
  });
}

/** Fails closed unless a catalog comment names this exact validated run. */
export function requireStartFlowPlaywrightDatabaseOwnership(
  runIdValue: string | undefined,
  actualMarker: unknown,
): void {
  if (
    typeof actualMarker !== 'string' ||
    actualMarker !== startFlowPlaywrightDatabaseMarker(runIdValue)
  ) {
    throw new Error(
      'The start-flow Playwright database ownership marker does not match this run.',
    );
  }
}

/**
 * Keeps browser mutations out of the shared Bun integration-test database.
 * Every run receives a distinct synthetic, loopback-only child database.
 */
export function startFlowPlaywrightDatabaseUrl(
  value: string | undefined = process.env.TEST_DATABASE_URL,
  runIdValue: string | undefined = process.env[
    START_FLOW_PLAYWRIGHT_RUN_ID_ENV
  ],
): string {
  const databaseUrl = requireLoopbackBaseDatabase(value);
  databaseUrl.pathname = `/${startFlowPlaywrightDatabaseName(runIdValue)}`;
  return databaseUrl.toString();
}

function maintenanceConnection(
  baseDatabaseUrl: string | undefined,
): postgres.Sql {
  const maintenanceUrl = requireLoopbackBaseDatabase(baseDatabaseUrl);
  maintenanceUrl.pathname = '/postgres';
  return postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readDatabaseMarker(
  sql: postgres.Sql,
  isolatedName: string,
): Promise<string | null | undefined> {
  const rows = await sql<DatabaseMarkerRow[]>`
    select shobj_description(oid, 'pg_database') as marker
    from pg_database
    where datname = ${isolatedName}
  `;
  if (rows.length > 1) {
    throw new Error('The start-flow database catalog identity is ambiguous.');
  }
  return rows[0]?.marker;
}

export async function recreateStartFlowPlaywrightDatabase(
  baseDatabaseUrl: string | undefined = process.env.TEST_DATABASE_URL,
  runIdValue: string | undefined = process.env[
    START_FLOW_PLAYWRIGHT_RUN_ID_ENV
  ],
): Promise<string> {
  const isolatedName = startFlowPlaywrightDatabaseName(runIdValue);
  const isolatedUrl = startFlowPlaywrightDatabaseUrl(
    baseDatabaseUrl,
    runIdValue,
  );
  if (databaseName(isolatedUrl) !== isolatedName) {
    throw new Error('Refusing to recreate an unexpected database.');
  }
  const creator = maintenanceConnection(baseDatabaseUrl);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await creator.unsafe(`create database "${isolatedName}"`);
      recordCreated();
      const marker = startFlowPlaywrightDatabaseMarker(runIdValue);
      await creator.unsafe(
        `comment on database "${isolatedName}" is ${quotedLiteral(marker)}`,
      );
      requireStartFlowPlaywrightDatabaseOwnership(
        runIdValue,
        await readDatabaseMarker(creator, isolatedName),
      );
    },
    closeCreator: () => creator.end(),
    rollbackWithFreshMarkerProof: async () => {
      await dropStartFlowPlaywrightDatabase(baseDatabaseUrl, runIdValue);
    },
    failureMessage:
      'Start-flow Playwright database creation, creator close, or marker-owned rollback failed.',
  });
  return isolatedUrl;
}

export async function dropStartFlowPlaywrightDatabase(
  baseDatabaseUrl: string | undefined = process.env.TEST_DATABASE_URL,
  runIdValue: string | undefined = process.env[
    START_FLOW_PLAYWRIGHT_RUN_ID_ENV
  ],
): Promise<boolean> {
  const isolatedName = startFlowPlaywrightDatabaseName(runIdValue);
  const isolatedUrl = startFlowPlaywrightDatabaseUrl(
    baseDatabaseUrl,
    runIdValue,
  );
  if (databaseName(isolatedUrl) !== isolatedName) {
    throw new Error('Refusing to drop an unexpected database.');
  }
  const admin = maintenanceConnection(baseDatabaseUrl);
  return executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, isolatedName);
      if (marker === undefined) return false;
      requireStartFlowPlaywrightDatabaseOwnership(runIdValue, marker);
      await admin.unsafe(`drop database "${isolatedName}" with (force)`);
      if ((await readDatabaseMarker(admin, isolatedName)) !== undefined) {
        throw new Error(
          'The owned start-flow Playwright database remained after cleanup.',
        );
      }
      return true;
    },
    cleanup: () => admin.end(),
    failureMessage:
      'Start-flow Playwright database cleanup and connection close failed.',
  });
}
