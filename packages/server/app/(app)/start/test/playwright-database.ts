import postgres from 'postgres';

import {
  START_FLOW_PLAYWRIGHT_RUN_ID_ENV,
  requireStartFlowPlaywrightRunId,
} from './playwright-run';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SYNTHETIC_DATABASE_PATTERN = /^[A-Za-z0-9_-]+[-_]test$/u;

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

async function withMaintenanceConnection(
  baseDatabaseUrl: string | undefined,
  operation: (sql: postgres.Sql) => Promise<void>,
): Promise<void> {
  const maintenanceUrl = requireLoopbackBaseDatabase(baseDatabaseUrl);
  maintenanceUrl.pathname = '/postgres';
  const sql = postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await operation(sql);
  } finally {
    await sql.end();
  }
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
  await withMaintenanceConnection(baseDatabaseUrl, async (sql) => {
    await sql.unsafe(`drop database if exists "${isolatedName}" with (force)`);
    await sql.unsafe(`create database "${isolatedName}"`);
  });
  return isolatedUrl;
}

export async function dropStartFlowPlaywrightDatabase(
  baseDatabaseUrl: string | undefined = process.env.TEST_DATABASE_URL,
  runIdValue: string | undefined = process.env[
    START_FLOW_PLAYWRIGHT_RUN_ID_ENV
  ],
): Promise<void> {
  const isolatedName = startFlowPlaywrightDatabaseName(runIdValue);
  const isolatedUrl = startFlowPlaywrightDatabaseUrl(
    baseDatabaseUrl,
    runIdValue,
  );
  if (databaseName(isolatedUrl) !== isolatedName) {
    throw new Error('Refusing to drop an unexpected database.');
  }
  await withMaintenanceConnection(baseDatabaseUrl, async (sql) => {
    await sql.unsafe(`drop database if exists "${isolatedName}" with (force)`);
  });
}
