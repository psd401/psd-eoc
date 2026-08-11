import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  requireAdminPlaywrightRunContext,
  type AdminPlaywrightRunContext,
} from './playwright-run';

interface DatabaseMarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

function databaseAdmin(
  context: AdminPlaywrightRunContext,
): PostgresDatabaseConnection {
  const admin = createDatabaseClient({
    driver: 'postgres',
    url: context.baseDatabaseUrl,
    maxConnections: 1,
  });
  if (admin.driver !== 'postgres') {
    throw new Error(
      'Administration Playwright database ownership requires PostgreSQL.',
    );
  }
  return admin;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function adminPlaywrightDatabaseMarker(value: unknown): string {
  const context = requireAdminPlaywrightRunContext(value);
  return JSON.stringify({
    kind: 'psd-eoc-issue26-admin-playwright-database',
    version: 1,
    runId: context.runId,
    databaseName: context.databaseName,
  });
}

export function requireAdminPlaywrightDatabaseOwnership(
  value: unknown,
  actualMarker: unknown,
): void {
  if (
    typeof actualMarker !== 'string' ||
    actualMarker !== adminPlaywrightDatabaseMarker(value)
  ) {
    throw new Error(
      'The administration Playwright database ownership marker does not match this run.',
    );
  }
}

async function readDatabaseMarker(
  admin: PostgresDatabaseConnection,
  databaseName: string,
): Promise<string | null | undefined> {
  const rows = databaseExecuteRows<DatabaseMarkerRow>(
    await admin.db.execute<DatabaseMarkerRow>(sql`
      select shobj_description(oid, 'pg_database') as marker
      from pg_database
      where datname = ${databaseName}
    `),
  );
  if (rows.length > 1) {
    throw new Error(
      'The administration Playwright database identity is ambiguous.',
    );
  }
  return rows[0]?.marker;
}

/** Creates and immediately marks the exact UUID-named disposable database. */
export async function createOwnedAdminPlaywrightDatabase(
  value: unknown,
): Promise<void> {
  const context = requireAdminPlaywrightRunContext(value);
  const admin = databaseAdmin(context);
  let created = false;
  try {
    await admin.db.execute(
      sql.raw(`create database "${context.databaseName}"`),
    );
    created = true;
    const marker = adminPlaywrightDatabaseMarker(context);
    await admin.db.execute(
      sql.raw(
        `comment on database "${context.databaseName}" is ${quotedLiteral(marker)}`,
      ),
    );
    requireAdminPlaywrightDatabaseOwnership(
      context,
      await readDatabaseMarker(admin, context.databaseName),
    );
  } catch (error) {
    if (created) {
      try {
        await admin.db.execute(
          sql.raw(`drop database "${context.databaseName}" with (force)`),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Administration Playwright database creation and rollback both failed.',
        );
      }
    }
    throw error;
  } finally {
    await admin.close();
  }
}

/** Drops only a database carrying this exact run's immutable marker. */
export async function dropOwnedAdminPlaywrightDatabase(
  value: unknown,
): Promise<boolean> {
  const context = requireAdminPlaywrightRunContext(value);
  const admin = databaseAdmin(context);
  try {
    const marker = await readDatabaseMarker(admin, context.databaseName);
    if (marker === undefined) return false;
    requireAdminPlaywrightDatabaseOwnership(context, marker);
    await admin.db.execute(
      sql.raw(`drop database "${context.databaseName}" with (force)`),
    );
    if ((await readDatabaseMarker(admin, context.databaseName)) !== undefined) {
      throw new Error(
        'The owned administration Playwright database remained after cleanup.',
      );
    }
    return true;
  } finally {
    await admin.close();
  }
}
