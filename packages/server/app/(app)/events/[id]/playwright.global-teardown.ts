import { readFile, rm } from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { createDatabaseClient } from '../../../../db/client';
import { channelConfigurations } from '../../../../db/schema';
import {
  EVENT_ROOM_PLAYWRIGHT_CHANNEL_STATE_PATH,
  requireSyntheticEventRoomTestDatabaseUrl,
} from './test-database';

interface ChannelConfigurationState {
  readonly integrationId: 'expo-push' | 'ses-email';
  readonly enabled: false;
  readonly changedAt: string;
}

function parseChannelState(
  value: unknown,
): readonly ChannelConfigurationState[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('The event-room channel restoration state is invalid.');
  }
  const parsed = value.map((candidate) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('integrationId' in candidate) ||
      (candidate.integrationId !== 'expo-push' &&
        candidate.integrationId !== 'ses-email') ||
      !('enabled' in candidate) ||
      candidate.enabled !== false ||
      !('changedAt' in candidate) ||
      typeof candidate.changedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.changedAt)) ||
      Object.keys(candidate).sort().join(',') !==
        'changedAt,enabled,integrationId'
    ) {
      throw new Error('The event-room channel restoration state is invalid.');
    }
    return {
      integrationId: candidate.integrationId,
      enabled: false,
      changedAt: candidate.changedAt,
    } as const;
  });
  if (new Set(parsed.map(({ integrationId }) => integrationId)).size !== 2) {
    throw new Error('The event-room channel restoration state is invalid.');
  }
  return parsed;
}

export default async function globalTeardown(): Promise<void> {
  const databaseUrl = requireSyntheticEventRoomTestDatabaseUrl(
    process.env.TEST_DATABASE_URL,
  );
  let serializedState: string;
  try {
    serializedState = await readFile(
      EVENT_ROOM_PLAYWRIGHT_CHANNEL_STATE_PATH,
      'utf8',
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const state = parseChannelState(JSON.parse(serializedState) as unknown);
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: databaseUrl,
    maxConnections: 1,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Event-room Playwright teardown requires PostgreSQL.');
  }
  try {
    await connection.db.transaction(async (transaction) => {
      for (const configuration of state) {
        const restored = await transaction
          .update(channelConfigurations)
          .set({
            enabled: configuration.enabled,
            changedAt: new Date(configuration.changedAt),
          })
          .where(
            eq(
              channelConfigurations.integrationId,
              configuration.integrationId,
            ),
          )
          .returning({ integrationId: channelConfigurations.integrationId });
        if (restored.length !== 1) {
          throw new Error(
            'The event-room channel configuration could not be restored.',
          );
        }
      }
    });
    await rm(EVENT_ROOM_PLAYWRIGHT_CHANNEL_STATE_PATH, { force: true });
  } finally {
    await connection.close();
  }
}
