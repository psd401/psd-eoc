import type { Reporter } from '@playwright/test/reporter';

import { removeStartFlowPlaywrightArtifacts } from './playwright-run';

/**
 * Cleans the exact run-owned artifact root after every reporter has finished.
 * Playwright's internal last-run reporter writes after global teardown, so
 * cleanup must happen in reporter `onExit` rather than the teardown hook.
 */
export default class StartFlowCleanupReporter implements Reporter {
  public async onExit(): Promise<void> {
    try {
      await removeStartFlowPlaywrightArtifacts();
    } catch (error) {
      // Playwright 1.55 logs and swallows reporter onExit rejections. Exiting
      // here ensures a direct CLI invocation cannot report success while a
      // credential-bearing run directory remains on disk.
      console.error('Start-flow Playwright artifact cleanup failed.', error);
      process.exit(1);
    }
  }
}
