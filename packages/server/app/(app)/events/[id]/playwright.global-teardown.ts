import type { FullConfig } from '@playwright/test';

import { dropOwnedEventRoomPlaywrightDatabase } from './playwright-database';
import { requireEventRoomPlaywrightRunContext } from './test-database';

export default async function globalTeardown(
  config: FullConfig,
): Promise<void> {
  const metadata = config.metadata as Readonly<Record<string, unknown>>;
  const context = requireEventRoomPlaywrightRunContext(metadata.eventRoomRun);
  await dropOwnedEventRoomPlaywrightDatabase(context);
}
