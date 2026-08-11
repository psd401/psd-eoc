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
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from './owned-database-lifecycle';

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
  adminFactory: (
    context: AdminPlaywrightRunContext,
  ) => PostgresDatabaseConnection = databaseAdmin,
): Promise<void> {
  const context = requireAdminPlaywrightRunContext(value);
  const admin = adminFactory(context);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${context.databaseName}"`),
      );
      recordCreated();
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
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: async () => {
      await dropOwnedAdminPlaywrightDatabase(context, adminFactory);
    },
    failureMessage:
      'Administration Playwright database creation, creator close, or marker-owned rollback failed.',
  });
}

/** Drops only a database carrying this exact run's immutable marker. */
export async function dropOwnedAdminPlaywrightDatabase(
  value: unknown,
  adminFactory: (
    context: AdminPlaywrightRunContext,
  ) => PostgresDatabaseConnection = databaseAdmin,
): Promise<boolean> {
  const context = requireAdminPlaywrightRunContext(value);
  const admin = adminFactory(context);
  return executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, context.databaseName);
      if (marker === undefined) return false;
      requireAdminPlaywrightDatabaseOwnership(context, marker);
      await admin.db.execute(
        sql.raw(`drop database "${context.databaseName}" with (force)`),
      );
      if (
        (await readDatabaseMarker(admin, context.databaseName)) !== undefined
      ) {
        throw new Error(
          'The owned administration Playwright database remained after cleanup.',
        );
      }
      return true;
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Administration Playwright database cleanup and connection close failed.',
  });
}
