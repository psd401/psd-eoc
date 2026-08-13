import { defineConfig } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import eventTypeConfig from '../app/(admin)/event-types/playwright.config';

const directory = dirname(fileURLToPath(import.meta.url));

/** Adds the issue #32 axe proof to the existing synthetic admin runtime. */
export default defineConfig({
  ...eventTypeConfig,
  testDir: directory,
  testMatch: /admin-accessibility\.playwright\.ts$/u,
  outputDir: '/tmp/psd-eoc-issue32-admin-playwright',
});
