import { migrate as migrateWithDataApi } from 'drizzle-orm/aws-data-api/pg/migrator';
import { migrate as migrateWithPostgres } from 'drizzle-orm/postgres-js/migrator';
import { join } from 'node:path';

import {
  bootstrapAccessConfiguration,
  describeBootstrapOutcome,
} from '../db/bootstrap-access';
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

const runFromCommandLine = async (): Promise<void> => {
  const client = createDatabaseClient(readDatabaseConfig());
  try {
    await migrateDatabase(client);
    console.info('Database migrations applied successfully.');
    // A deployment with no access group admits nobody, and the page that
    // configures access groups is behind sign-in. This runs on every deploy
    // and acts only when no access group exists at all, so it can create the
    // first one without ever disturbing a district that has its own.
    console.info(
      describeBootstrapOutcome(await bootstrapAccessConfiguration(client.db)),
    );
  } finally {
    await client.close();
  }
};

if (import.meta.main) {
  await runFromCommandLine();
}
