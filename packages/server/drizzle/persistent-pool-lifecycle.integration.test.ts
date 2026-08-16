import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { requireSyntheticTestDatabaseUrl } from '../app/(admin)/event-types/test-database';
import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../db/client';

const FORMER_IDLE_TIMEOUT_SECONDS = 20;
const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(45_000);

interface PoolProbeRow extends Record<string, unknown> {
  readonly backendPid: number;
  readonly value: number;
}

function openPersistentRoutePool(
  databaseUrl: string,
  routeKind: 'authenticated-session' | 'admin',
): PostgresDatabaseConnection {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', `psd-eoc:issue-194:${routeKind}`);
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: url.toString(),
    maxConnections: 1,
    connectTimeoutSeconds: 2,
    idleTimeoutSeconds: 0,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Persistent route-pool evidence requires PostgreSQL.');
  }
  return connection;
}

async function probePool(
  connection: PostgresDatabaseConnection,
): Promise<PoolProbeRow> {
  const rows = databaseExecuteRows<PoolProbeRow>(
    await connection.db.execute<PoolProbeRow>(sql`
      select
        pg_backend_pid()::integer as "backendPid",
        194::integer as value
    `),
  );
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error('The persistent route-pool probe returned invalid truth.');
  }
  return rows[0];
}

describeWithDatabase('persistent native route-pool lifecycle', () => {
  test('reuses authenticated-session and admin max-one pools after the former idle window', async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('The synthetic test database URL was unavailable.');
    }
    const sessionConnection = openPersistentRoutePool(
      baseTestDatabaseUrl,
      'authenticated-session',
    );
    const adminConnection = openPersistentRoutePool(
      baseTestDatabaseUrl,
      'admin',
    );

    try {
      const [sessionBeforeIdle, adminBeforeIdle] = await Promise.all([
        probePool(sessionConnection),
        probePool(adminConnection),
      ]);

      await Bun.sleep((FORMER_IDLE_TIMEOUT_SECONDS + 1) * 1_000);

      const [sessionAfterIdle, adminAfterIdle] = await Promise.all([
        probePool(sessionConnection),
        probePool(adminConnection),
      ]);

      expect(sessionAfterIdle).toEqual(sessionBeforeIdle);
      expect(adminAfterIdle).toEqual(adminBeforeIdle);
    } finally {
      await Promise.all([sessionConnection.close(), adminConnection.close()]);
    }

    await expect(probePool(sessionConnection)).rejects.toMatchObject({
      cause: { code: 'CONNECTION_ENDED' },
    });
    await expect(probePool(adminConnection)).rejects.toMatchObject({
      cause: { code: 'CONNECTION_ENDED' },
    });
  });
});
