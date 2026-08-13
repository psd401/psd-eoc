import { createDatabaseClient } from '../../../../db/client';
import { userRoles } from '../../../../db/schema';
import prepareStartFlowBrowserSession from '../../start/test/playwright.global-setup';
import { PLAYWRIGHT_IDS } from '../../start/test/playwright.fixtures';
import {
  dropStartFlowPlaywrightDatabase,
  startFlowPlaywrightDatabaseUrl,
} from '../../start/test/playwright-database';
import { removeStartFlowPlaywrightArtifacts } from '../../start/test/playwright-run';

/** Adds only the synthetic product-owner role after shared safe browser setup. */
export default async function prepareDeliveryTestBrowserSession(): Promise<void> {
  let connection: ReturnType<typeof createDatabaseClient> | null = null;
  try {
    await prepareStartFlowBrowserSession();
    connection = createDatabaseClient({
      driver: 'postgres',
      url: startFlowPlaywrightDatabaseUrl(),
      maxConnections: 1,
    });
    await connection.db
      .insert(userRoles)
      .values({ userId: PLAYWRIGHT_IDS.user, role: 'admin' })
      .onConflictDoNothing();
    await connection.close();
    connection = null;
  } catch (error) {
    const failures: unknown[] = [error];
    if (connection !== null) {
      try {
        await connection.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    try {
      await dropStartFlowPlaywrightDatabase();
    } catch (dropError) {
      failures.push(dropError);
    }
    try {
      await removeStartFlowPlaywrightArtifacts();
    } catch (artifactError) {
      failures.push(artifactError);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(
      failures,
      'Delivery-test browser setup and exact-run cleanup both failed.',
    );
  }
}
