import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../../(admin)/facilities/owned-database-lifecycle';
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

/** Creates and immediately marks the exact UUID-named disposable database. */
export async function createOwnedEventRoomPlaywrightDatabase(
  value: unknown,
  adminFactory: (
    context: EventRoomPlaywrightRunContext,
  ) => PostgresDatabaseConnection = databaseAdmin,
): Promise<void> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const admin = adminFactory(context);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${context.databaseName}"`),
      );
      recordCreated();
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
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: async () => {
      await dropOwnedEventRoomPlaywrightDatabase(context, adminFactory);
    },
    failureMessage:
      'Event-room Playwright database creation, creator close, or marker-owned rollback failed.',
  });
}

/**
 * Drops only an exact database whose catalog comment proves run ownership.
 * The operation is idempotent after a successful drop and verifies absence.
 */
export async function dropOwnedEventRoomPlaywrightDatabase(
  value: unknown,
  adminFactory: (
    context: EventRoomPlaywrightRunContext,
  ) => PostgresDatabaseConnection = databaseAdmin,
): Promise<boolean> {
  const context = requireEventRoomPlaywrightRunContext(value);
  const admin = adminFactory(context);
  return executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, context.databaseName);
      if (marker === undefined) return false;
      requireEventRoomPlaywrightDatabaseOwnership(context, marker);
      await admin.db.execute(
        sql.raw(`drop database "${context.databaseName}" with (force)`),
      );
      if (
        (await readDatabaseMarker(admin, context.databaseName)) !== undefined
      ) {
        throw new Error(
          'The owned event-room Playwright database remained after cleanup.',
        );
      }
      return true;
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Event-room Playwright database cleanup and connection close failed.',
  });
}
