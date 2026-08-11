import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  eventRoomPlaywrightDatabaseMarker,
  requireEventRoomPlaywrightDatabaseOwnership,
  requireEventRoomPlaywrightRunContext,
  type EventRoomPlaywrightRunContext,
} from './test-database';

interface DatabaseMarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

function databaseAdmin(
  context: EventRoomPlaywrightRunContext,
): PostgresDatabaseConnection {
  const admin = createDatabaseClient({
    driver: 'postgres',
    url: context.baseDatabaseUrl,
    maxConnections: 1,
  });
  if (admin.driver !== 'postgres') {
    throw new Error(
      'Event-room Playwright database ownership requires PostgreSQL.',
    );
  }
  return admin;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
    throw new Error('The disposable database catalog identity is ambiguous.');
  }
  return rows[0]?.marker;
}

async function dropCreatedDatabaseWithoutMarker(
  admin: PostgresDatabaseConnection,
  databaseName: string,
): Promise<void> {
  await admin.db.execute(
    sql.raw(`drop database "${databaseName}" with (force)`),
  );
}

/** Creates and immediately marks the exact UUID-named disposable database. */
export async function createOwnedEventRoomPlaywrightDatabase(
  value: unknown,
): Promise<void> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const admin = databaseAdmin(context);
  let created = false;
  try {
    await admin.db.execute(
      sql.raw(`create database "${context.databaseName}"`),
    );
    created = true;
    const marker = eventRoomPlaywrightDatabaseMarker(context);
    await admin.db.execute(
      sql.raw(
        `comment on database "${context.databaseName}" is ${quotedLiteral(marker)}`,
      ),
    );
    requireEventRoomPlaywrightDatabaseOwnership(
      context,
      await readDatabaseMarker(admin, context.databaseName),
    );
  } catch (error) {
    if (created) {
      try {
        await dropCreatedDatabaseWithoutMarker(admin, context.databaseName);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Disposable database creation and rollback both failed.',
        );
      }
    }
    throw error;
  } finally {
    await admin.close();
  }
}

/**
 * Drops only an exact database whose catalog comment proves run ownership.
 * The operation is idempotent after a successful drop and verifies absence.
 */
export async function dropOwnedEventRoomPlaywrightDatabase(
  value: unknown,
): Promise<boolean> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const admin = databaseAdmin(context);
  try {
    const marker = await readDatabaseMarker(admin, context.databaseName);
    if (marker === undefined) return false;
    requireEventRoomPlaywrightDatabaseOwnership(context, marker);
    await admin.db.execute(
      sql.raw(`drop database "${context.databaseName}" with (force)`),
    );
    if ((await readDatabaseMarker(admin, context.databaseName)) !== undefined) {
      throw new Error('The owned disposable database remained after cleanup.');
    }
    return true;
  } finally {
    await admin.close();
  }
}
