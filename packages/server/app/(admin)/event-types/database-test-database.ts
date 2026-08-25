import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../../lib/testing/owned-database-lifecycle';
import { requireSyntheticTestDatabaseUrl } from '../../../lib/testing/database';

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATABASE_NAME_PATTERN = /^psd_eoc_i94_et_[0-9a-f]{32}_test$/u;

interface DatabaseMarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

export interface EventTypeDatabaseTestContext {
  readonly baseDatabaseUrl: string;
  readonly runId: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
}

export type EventTypeDatabaseTestAdminFactory = (
  context: EventTypeDatabaseTestContext,
) => PostgresDatabaseConnection;

interface EventTypeDatabaseTestOperations<Resource> {
  readonly open: (databaseUrl: string) => Resource | PromiseLike<Resource>;
  readonly prepare: (resource: Resource) => Promise<void>;
  readonly close: (resource: Resource) => Promise<void>;
}

export interface OwnedEventTypeDatabaseTestDatabase<Resource> {
  readonly context: EventTypeDatabaseTestContext;
  readonly resource: Resource;
  cleanup(): Promise<void>;
}

function databaseAdmin(
  context: EventTypeDatabaseTestContext,
): PostgresDatabaseConnection {
  const admin = createDatabaseClient({
    driver: 'postgres',
    url: context.baseDatabaseUrl,
    maxConnections: 1,
  });
  if (admin.driver !== 'postgres') {
    throw new Error('Event-type database-test ownership requires PostgreSQL.');
  }
  return admin;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Derives one UUID-owned loopback child without mutating the configured base. */
export function resolveEventTypeDatabaseTestContext(
  baseDatabaseUrl: string | undefined = process.env.TEST_DATABASE_URL,
  runIdValue: string = randomUUID(),
): EventTypeDatabaseTestContext {
  const validatedBase = requireSyntheticTestDatabaseUrl(baseDatabaseUrl, false);
  if (!RUN_ID_PATTERN.test(runIdValue)) {
    throw new Error('The event-type database-test run ID must be a UUID.');
  }
  const runId = runIdValue.toLowerCase();
  const databaseName = `psd_eoc_i94_et_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The event-type database-test name is invalid.');
  }
  const databaseUrl = new URL(validatedBase);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl: validatedBase,
    runId,
    databaseName,
    databaseUrl: databaseUrl.toString(),
  });
}

function requireEventTypeDatabaseTestContext(
  value: unknown,
): EventTypeDatabaseTestContext {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('baseDatabaseUrl' in value) ||
    !('runId' in value)
  ) {
    throw new Error('The event-type database-test context is invalid.');
  }
  const candidate = value as Partial<EventTypeDatabaseTestContext>;
  if (
    typeof candidate.baseDatabaseUrl !== 'string' ||
    typeof candidate.runId !== 'string'
  ) {
    throw new Error('The event-type database-test context is invalid.');
  }
  const expected = resolveEventTypeDatabaseTestContext(
    candidate.baseDatabaseUrl,
    candidate.runId,
  );
  if (
    candidate.databaseName !== expected.databaseName ||
    candidate.databaseUrl !== expected.databaseUrl
  ) {
    throw new Error('The event-type database-test context was altered.');
  }
  return expected;
}

/** Exact non-secret catalog comment granting deletion authority to one run. */
export function eventTypeDatabaseTestDatabaseMarker(value: unknown): string {
  const context = requireEventTypeDatabaseTestContext(value);
  return JSON.stringify({
    kind: 'psd-eoc-issue94-event-type-database-test',
    version: 1,
    runId: context.runId,
    databaseName: context.databaseName,
  });
}

/** Fails closed unless the catalog proves this exact UUID-owned child. */
export function requireEventTypeDatabaseTestDatabaseOwnership(
  value: unknown,
  actualMarker: unknown,
): void {
  if (
    typeof actualMarker !== 'string' ||
    actualMarker !== eventTypeDatabaseTestDatabaseMarker(value)
  ) {
    throw new Error(
      'The event-type database-test ownership marker does not match this run.',
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
      'The event-type database-test catalog identity is ambiguous.',
    );
  }
  return rows[0]?.marker;
}

/** Creates and immediately marker-verifies the exact run-owned child. */
export async function createOwnedEventTypeDatabaseTestDatabase(
  value: unknown,
  adminFactory: EventTypeDatabaseTestAdminFactory = databaseAdmin,
): Promise<void> {
  const context = requireEventTypeDatabaseTestContext(value);
  const admin = adminFactory(context);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${context.databaseName}"`),
      );
      recordCreated();
      const marker = eventTypeDatabaseTestDatabaseMarker(context);
      await admin.db.execute(
        sql.raw(
          `comment on database "${context.databaseName}" is ${quotedLiteral(marker)}`,
        ),
      );
      requireEventTypeDatabaseTestDatabaseOwnership(
        context,
        await readDatabaseMarker(admin, context.databaseName),
      );
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: async () => {
      await dropOwnedEventTypeDatabaseTestDatabase(context, adminFactory);
    },
    failureMessage:
      'Event-type database-test creation, creator close, or marker-owned rollback failed.',
  });
}

/** Drops only a child carrying the exact immutable marker for this run. */
export async function dropOwnedEventTypeDatabaseTestDatabase(
  value: unknown,
  adminFactory: EventTypeDatabaseTestAdminFactory = databaseAdmin,
): Promise<boolean> {
  const context = requireEventTypeDatabaseTestContext(value);
  const admin = adminFactory(context);
  return executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, context.databaseName);
      if (marker === undefined) return false;
      requireEventTypeDatabaseTestDatabaseOwnership(context, marker);
      await admin.db.execute(
        sql.raw(`drop database "${context.databaseName}" with (force)`),
      );
      if (
        (await readDatabaseMarker(admin, context.databaseName)) !== undefined
      ) {
        throw new Error(
          'The owned event-type database-test child remained after cleanup.',
        );
      }
      return true;
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Event-type database-test cleanup and connection close failed.',
  });
}

async function closeResourceAndDropDatabase<Resource>(
  context: EventTypeDatabaseTestContext,
  resource: Resource,
  close: (resource: Resource) => Promise<void>,
  adminFactory: EventTypeDatabaseTestAdminFactory,
): Promise<void> {
  await executeOperationWithCleanup({
    operation: () => close(resource),
    cleanup: async () => {
      await dropOwnedEventTypeDatabaseTestDatabase(context, adminFactory);
    },
    failureMessage:
      'Event-type database-test resource close and marker-owned cleanup failed.',
  });
}

/**
 * Owns the whole non-browser suite lifecycle. Migration/seed setup receives
 * only the isolated child, and any setup rejection closes it before a fresh
 * marker-verified drop. Successful setup returns the same cleanup authority.
 */
export async function prepareOwnedEventTypeDatabaseTestDatabase<Resource>(
  value: unknown,
  operations: EventTypeDatabaseTestOperations<Resource>,
  adminFactory: EventTypeDatabaseTestAdminFactory = databaseAdmin,
): Promise<OwnedEventTypeDatabaseTestDatabase<Resource>> {
  const context = requireEventTypeDatabaseTestContext(value);
  await createOwnedEventTypeDatabaseTestDatabase(context, adminFactory);

  let resource!: Resource;
  let resourceOpened = false;
  try {
    resource = await operations.open(context.databaseUrl);
    resourceOpened = true;
    await operations.prepare(resource);
  } catch (error) {
    return executeOperationWithCleanup<never>({
      operation: () => Promise.reject(error),
      cleanup: resourceOpened
        ? () =>
            closeResourceAndDropDatabase(
              context,
              resource,
              operations.close,
              adminFactory,
            )
        : async () => {
            await dropOwnedEventTypeDatabaseTestDatabase(context, adminFactory);
          },
      failureMessage:
        'Event-type database-test setup and marker-owned cleanup failed.',
    });
  }

  let cleanupPromise: Promise<void> | undefined;
  return Object.freeze({
    context,
    resource,
    cleanup: () => {
      cleanupPromise ??= closeResourceAndDropDatabase(
        context,
        resource,
        operations.close,
        adminFactory,
      );
      return cleanupPromise;
    },
  });
}
