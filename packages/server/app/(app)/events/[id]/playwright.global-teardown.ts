import type { FullConfig } from '@playwright/test';

import { sql } from 'drizzle-orm';

import { createDatabaseClient } from '../../../../db/client';
import { requireEventRoomPlaywrightRunContext } from './test-database';

export default async function globalTeardown(
  config: FullConfig,
): Promise<void> {
  const metadata = config.metadata as Readonly<Record<string, unknown>>;
  const context = requireEventRoomPlaywrightRunContext(metadata.eventRoomRun);
  const admin = createDatabaseClient({
    driver: 'postgres',
    url: context.baseDatabaseUrl,
    maxConnections: 1,
  });
  if (admin.driver !== 'postgres') {
    throw new Error(
      'Event-room Playwright database teardown requires PostgreSQL.',
    );
  }
  try {
    await admin.db.execute(
      sql.raw(`drop database if exists "${context.databaseName}" with (force)`),
    );
  } finally {
    await admin.close();
  }
}
