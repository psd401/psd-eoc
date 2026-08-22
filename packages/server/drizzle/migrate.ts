import { migrate as migrateWithDataApi } from 'drizzle-orm/aws-data-api/pg/migrator';
import { migrate as migrateWithPostgres } from 'drizzle-orm/postgres-js/migrator';
import { join } from 'node:path';

import { createDatabaseClient, readDatabaseConfig } from '../db/client';

/** Absolute path keeps migrations independent of the caller's working directory. */
export const migrationsFolder = join(import.meta.dir, 'migrations');

/** Apply all committed migrations using the explicitly selected database driver. */
export async function migrateDatabase(
  client: ReturnType<typeof createDatabaseClient>,
): Promise<void> {
  const config = { migrationsFolder };

  if (client.driver === 'postgres') {
    await migrateWithPostgres(client.db, config);
    return;
  }

  await migrateWithDataApi(client.db, config);
}

/**
 * Applies migrations, and nothing else.
 *
 * The access group, the district's facilities and its campuses used to be
 * seeded from here too. They are steps of the bootstrap now
 * (`scripts/operations/bootstrap.ts`), which is what the deployment actually
 * runs and which holds `pg_advisory_lock(178401)` for the whole sequence.
 *
 * Leaving copies here made this file a second, unlocked entry point to the
 * same mutations. Nothing in `infra/` or CI invokes it, but nothing stops it
 * being pointed at a live database by hand either, and the access-group step
 * is a check-then-insert: two unlocked callers configured with different group
 * ids could both observe "no active access group" and both insert, leaving two
 * active groups that each grant administrator. The unique index on
 * `google_group_id` only catches the case where both supply the same id.
 *
 * So this does migrations, matching its name, and the bootstrap owns seeding.
 */
const runFromCommandLine = async (): Promise<void> => {
  const client = createDatabaseClient(readDatabaseConfig());
  try {
    await migrateDatabase(client);
    console.info('Database migrations applied successfully.');
  } finally {
    await client.close();
  }
};

if (import.meta.main) {
  await runFromCommandLine();
}
