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
