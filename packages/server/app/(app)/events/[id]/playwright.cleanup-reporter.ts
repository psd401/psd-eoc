import type { Reporter } from '@playwright/test/reporter';

import {
  cleanupReportedEventRoomPlaywrightRun,
  requireInheritedEventRoomPlaywrightRunContext,
} from './test-database';

/**
 * Reporter onExit runs after every reporter's onEnd has finished writing.
 * The web-server wrapper must already have proven the port closed and released
 * its lease; only then may this process remove the exact run directory.
 */
export default class EventRoomCleanupReporter implements Reporter {
  onExit(): Promise<void> {
    const context = requireInheritedEventRoomPlaywrightRunContext();
    cleanupReportedEventRoomPlaywrightRun(context);
    return Promise.resolve();
  }
}
