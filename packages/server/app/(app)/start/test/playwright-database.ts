import postgres from 'postgres';

import { requireSyntheticTestDatabaseUrl } from '../../../(admin)/event-types/test-database';

const START_FLOW_DATABASE_NAME = 'psd_eoc_issue15_playwright_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

function requireLoopbackBaseDatabase(value: string | undefined): URL {
  const baseUrl = new URL(requireSyntheticTestDatabaseUrl(value));
  if (!LOOPBACK_HOSTS.has(baseUrl.hostname)) {
    throw new Error(
      'Start-flow Playwright database isolation is restricted to loopback PostgreSQL.',
    );
  }
  return baseUrl;
}

/**
 * Keeps browser mutations out of the shared Bun integration-test database.
 * The fixed child name is synthetic, loopback-only, and still ends in `_test`.
 */
export function startFlowPlaywrightDatabaseUrl(
  value: string | undefined = process.env.TEST_DATABASE_URL,
): string {
  const databaseUrl = requireLoopbackBaseDatabase(value);
  databaseUrl.pathname = `/${START_FLOW_DATABASE_NAME}`;
  return requireSyntheticTestDatabaseUrl(databaseUrl.toString());
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
): Promise<string> {
  const isolatedUrl = startFlowPlaywrightDatabaseUrl(baseDatabaseUrl);
  const isolatedName = databaseName(isolatedUrl);
  if (isolatedName !== START_FLOW_DATABASE_NAME) {
    throw new Error('Refusing to recreate an unexpected database.');
  }
  await withMaintenanceConnection(baseDatabaseUrl, async (sql) => {
    await sql.unsafe(
      `drop database if exists "${START_FLOW_DATABASE_NAME}" with (force)`,
    );
    await sql.unsafe(`create database "${START_FLOW_DATABASE_NAME}"`);
  });
  return isolatedUrl;
}

export async function dropStartFlowPlaywrightDatabase(
  baseDatabaseUrl: string | undefined = process.env.TEST_DATABASE_URL,
): Promise<void> {
  const isolatedUrl = startFlowPlaywrightDatabaseUrl(baseDatabaseUrl);
  if (databaseName(isolatedUrl) !== START_FLOW_DATABASE_NAME) {
    throw new Error('Refusing to drop an unexpected database.');
  }
  await withMaintenanceConnection(baseDatabaseUrl, async (sql) => {
    await sql.unsafe(
      `drop database if exists "${START_FLOW_DATABASE_NAME}" with (force)`,
    );
  });
}
