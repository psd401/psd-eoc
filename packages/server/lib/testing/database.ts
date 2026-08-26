import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Fails closed before a test can migrate, seed, or mutate a database.
 *
 * Remote test services require an explicit opt-in and every database name must
 * end in `_test` or `-test`, so an ordinary production URL cannot be reused by
 * a suite that is about to drop and recreate what it points at.
 */
export function requireSyntheticTestDatabaseUrl(
  value: string | undefined,
  allowRemote = process.env.PSD_EOC_ALLOW_REMOTE_TEST_DATABASE === 'true',
): string {
  if (value === undefined || value.length === 0) {
    throw new Error('TEST_DATABASE_URL is required for database tests.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL must name a synthetic test database.');
  }
  const hasAcceptedTlsQuery =
    parsed.search.length === 0 ||
    (allowRemote &&
      parsed.searchParams.size === 1 &&
      parsed.searchParams.get('sslmode') === 'verify-full');
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname.length === 0 ||
    !/^[A-Za-z0-9_-]+[-_]test$/u.test(databaseName) ||
    !hasAcceptedTlsQuery ||
    parsed.hash.length > 0 ||
    (!LOOPBACK_HOSTS.has(parsed.hostname) && !allowRemote)
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target a loopback PostgreSQL database whose name ends in _test; remote test databases require explicit opt-in.',
    );
  }
  return value;
}

/** A database that exists only for one suite, and the way to remove it. */
export interface DisposableDatabase {
  readonly url: string;
  readonly name: string;
  drop(): Promise<void>;
}

async function withMaintenanceConnection<T>(
  baseUrl: string,
  run: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const maintenanceUrl = new URL(baseUrl);
  maintenanceUrl.pathname = '/postgres';
  const sql = postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Creates an empty database for one suite to own.
 *
 * The name carries a random suffix, so two suites never collide and a leaked
 * database is obvious in `\l`. There is deliberately no ownership marker, no
 * catalog comment, and no rollback protocol: the name is generated here and
 * nowhere else, which is the whole of what those mechanisms were protecting.
 */
export async function createDisposableDatabase(
  prefix: string,
  baseUrl: string | undefined = process.env.TEST_DATABASE_URL,
): Promise<DisposableDatabase> {
  const verified = requireSyntheticTestDatabaseUrl(baseUrl);
  if (!/^[a-z][a-z0-9_]*$/u.test(prefix)) {
    throw new Error('A disposable database prefix must be lowercase ASCII.');
  }
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}_test`;
  await withMaintenanceConnection(verified, (sql) =>
    sql.unsafe(`create database "${name}"`),
  );
  const url = new URL(verified);
  url.pathname = `/${name}`;
  return Object.freeze({
    url: url.toString(),
    name,
    async drop(): Promise<void> {
      await withMaintenanceConnection(verified, (sql) =>
        sql.unsafe(`drop database if exists "${name}" (force)`),
      );
    },
  });
}
