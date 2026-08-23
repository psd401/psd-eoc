import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');

export interface BrowserFixture {
  readonly eventId: string;
  readonly districtAdministratorUserId: string;
}

export function statePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_STATE_DIR;
  if (directory === undefined) throw new Error('Browser state is unavailable.');
  return join(directory, name);
}

export function evidencePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_EVIDENCE_DIR;
  if (directory === undefined) {
    throw new Error('Browser evidence directory is unavailable.');
  }
  return join(directory, name);
}

export async function readFixture(): Promise<BrowserFixture> {
  return JSON.parse(
    await readFile(statePath('fixture.json'), 'utf8'),
  ) as BrowserFixture;
}

export async function expectAxeClean(page: Page): Promise<void> {
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const axe = Reflect.get(window, 'axe') as {
      run(
        context: Document,
        options: Readonly<{
          runOnly: Readonly<{ type: string; values: string[] }>;
        }>,
      ): Promise<Readonly<{ violations: readonly unknown[] }>>;
    };
    const result = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    });
    return result.violations;
  });
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}
