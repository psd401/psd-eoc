import { copyFile, chmod } from 'node:fs/promises';

import prepareEventTypeBrowserSession from '../../../(admin)/event-types/playwright.global-setup';
import { EVENT_TYPE_PLAYWRIGHT_STORAGE_STATE_PATH } from '../../../(admin)/event-types/test-database';

export const START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH =
  '/tmp/psd-eoc-issue15-storage-state.json';

/**
 * Reuses the canonical synthetic session fixture, then snapshots it to an
 * issue-owned path so unrelated Playwright suites cannot replace auth state
 * between this suite's isolated browser contexts.
 */
export default async function prepareStartFlowBrowserSession(): Promise<void> {
  await prepareEventTypeBrowserSession();
  await copyFile(
    EVENT_TYPE_PLAYWRIGHT_STORAGE_STATE_PATH,
    START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH,
  );
  await chmod(START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH, 0o600);
}
