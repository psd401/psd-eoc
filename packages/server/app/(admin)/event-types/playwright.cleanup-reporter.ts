import type { Reporter } from '@playwright/test/reporter';

import {
  cleanupReportedEventTypePlaywrightRun,
  requireInheritedEventTypePlaywrightRunContext,
} from './playwright-run';

/** Removes artifacts only after the web-server wrapper proves exact cleanup. */
export default class EventTypeCleanupReporter implements Reporter {
  onExit(): Promise<void> {
    const context = requireInheritedEventTypePlaywrightRunContext();
    cleanupReportedEventTypePlaywrightRun(context);
    return Promise.resolve();
  }
}
