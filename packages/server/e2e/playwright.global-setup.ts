import { inArray } from 'drizzle-orm';

import startFlowGlobalSetup from '../app/(app)/start/test/playwright.global-setup';
import startFlowGlobalTeardown from '../app/(app)/start/test/playwright.global-teardown';
import { startFlowPlaywrightDatabaseUrl } from '../app/(app)/start/test/playwright-database';
import { createDatabaseClient } from '../db/client';
import { channelConfigurations } from '../db/schema';

const REQUIRED_MOCKED_CHANNELS = ['expo-push', 'ses-email'] as const;

/**
 * Extends the canonical start-flow fixture only inside its isolated loopback
 * database. Start-flow setup restores channel switches after it seeds two
 * drills; this cross-screen suite keeps those same mocked switches enabled so
 * the human can obtain a fresh all-clear preview and traverse the real
 * capability path. No provider client or worker is started by this suite.
 */
export default async function prepareCriticalJourney(): Promise<void> {
  await startFlowGlobalSetup();
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: startFlowPlaywrightDatabaseUrl(),
    maxConnections: 1,
  });
  if (connection.driver !== 'postgres') {
    await startFlowGlobalTeardown();
    throw new Error('Critical-journey Playwright requires PostgreSQL.');
  }

  try {
    const configurations = await connection.db
      .select({
        integrationId: channelConfigurations.integrationId,
        enabled: channelConfigurations.enabled,
        statusLabel: channelConfigurations.statusLabel,
      })
      .from(channelConfigurations)
      .where(
        inArray(channelConfigurations.integrationId, REQUIRED_MOCKED_CHANNELS),
      );
    if (
      configurations.length !== REQUIRED_MOCKED_CHANNELS.length ||
      configurations.some(
        (configuration) =>
          configuration.enabled || configuration.statusLabel !== 'mocked',
      )
    ) {
      throw new Error(
        'Critical-journey channels must start disabled and truth-labeled mocked.',
      );
    }

    const enabled = await connection.db
      .update(channelConfigurations)
      .set({ enabled: true, changedAt: new Date() })
      .where(
        inArray(channelConfigurations.integrationId, REQUIRED_MOCKED_CHANNELS),
      )
      .returning({
        integrationId: channelConfigurations.integrationId,
        enabled: channelConfigurations.enabled,
        statusLabel: channelConfigurations.statusLabel,
      });
    if (
      enabled.length !== REQUIRED_MOCKED_CHANNELS.length ||
      enabled.some(
        (configuration) =>
          !configuration.enabled || configuration.statusLabel !== 'mocked',
      )
    ) {
      throw new Error('Mocked critical-journey channels did not enable.');
    }
  } catch (error) {
    await connection.close();
    await startFlowGlobalTeardown();
    throw error;
  }
  await connection.close();
}
