import { expect, test, type Locator, type Page } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';

import { createDatabaseClient, readDatabaseConfig } from '../db/client';
import { events, journalEntries } from '../db/schema';
import {
  expectAxeClean,
  issue31EvidencePath,
  readFixture,
  statePath,
} from './support';

const RECOVERED_UPDATE =
  'Synthetic recovery update retained during the simulated outage.';

async function focusWithKeyboard(page: Page, target: Locator): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  for (let press = 0; press < 80; press += 1) {
    await page.keyboard.press('Tab');
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
  }
  throw new Error('Keyboard traversal did not reach the all-clear control.');
}

test.describe('synthetic-failure-recovery', () => {
  test('keeps a synthetic drill usable, classified, and append-only through a lost timeline read', async ({
    browser,
    page,
  }) => {
    const fixture = await readFixture();
    const eventPath = `/events/${fixture.issue31EventId}`;
    let failNextTimelineRead = false;
    let failedReadObserved = false;
    await page.route(`**${eventPath}/api?*`, async (route) => {
      if (route.request().method() === 'GET' && failNextTimelineRead) {
        failNextTimelineRead = false;
        failedReadObserved = true;
        await route.abort('connectionfailed');
        return;
      }
      await route.continue();
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(eventPath);
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected' }),
    ).toBeVisible({ timeout: 30_000 });

    failNextTimelineRead = true;
    await expect
      .poll(() => failedReadObserved, {
        message: 'The timeline did not issue the injected failed read.',
        timeout: 30_000,
      })
      .toBe(true);
    await expect(
      page.getByRole('status').filter({ hasText: /Reconnecting|Offline/u }),
    ).toBeVisible({ timeout: 15_000 });

    const collaborator = await browser.newContext({
      storageState: statePath('district-admin.json'),
    });
    try {
      const collaboratorPage = await collaborator.newPage();
      await collaboratorPage.goto(eventPath);
      await collaboratorPage.getByLabel('Update text').fill(RECOVERED_UPDATE);
      const [postResponse] = await Promise.all([
        collaboratorPage.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `${eventPath}/api`,
        ),
        collaboratorPage.getByRole('button', { name: 'Post update' }).click(),
      ]);
      expect(postResponse.ok()).toBe(true);
      await expect(
        collaboratorPage
          .getByRole('article')
          .filter({ hasText: RECOVERED_UPDATE }),
      ).toBeVisible();
    } finally {
      await collaborator.close();
    }

    // Opening the collaborator can make Chromium treat this tab as hidden.
    // Return it to the foreground so the production visibility-aware poller
    // resumes and proves the missed append is recovered from its cursor.
    await page.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('visible');
    await expect(page.getByText(RECOVERED_UPDATE)).toBeVisible({
      timeout: 35_000,
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected' }),
    ).toBeVisible({ timeout: 35_000 });
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    const allClearButton = page.getByRole('button', {
      name: 'Review all-clear',
    });
    await expect(allClearButton).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review event close' }),
    ).toHaveCount(0);
    await focusWithKeyboard(page, allClearButton);
    await expect(allClearButton).toBeFocused();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue31EvidencePath('synthetic-failure-recovery-desktop.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(RECOVERED_UPDATE)).toBeVisible();
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    await focusWithKeyboard(page, allClearButton);
    await expect(allClearButton).toBeFocused();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue31EvidencePath('synthetic-failure-recovery-mobile-390.png'),
      fullPage: true,
    });

    const connection = createDatabaseClient(readDatabaseConfig());
    try {
      const [storedEvent] = await connection.db
        .select({
          kind: events.kind,
          rosterPopulation: events.rosterPopulation,
          status: events.status,
        })
        .from(events)
        .where(eq(events.id, fixture.issue31EventId));
      expect(storedEvent).toEqual({
        kind: 'drill',
        rosterPopulation: 'synthetic',
        status: 'active',
      });
      const entries = await connection.db
        .select({
          kind: journalEntries.kind,
          payload: journalEntries.payload,
          sequence: journalEntries.sequence,
        })
        .from(journalEntries)
        .where(eq(journalEntries.eventId, fixture.issue31EventId))
        .orderBy(asc(journalEntries.sequence));
      expect(entries.map(({ sequence }) => sequence)).toEqual(
        entries.map((_, index) => index + 1),
      );
      expect(
        entries.some(
          ({ kind, payload }) =>
            kind === 'text' &&
            (payload as Readonly<{ text?: unknown }>).text === RECOVERED_UPDATE,
        ),
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
