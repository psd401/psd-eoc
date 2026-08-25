import { expect, test } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';

import { createDatabaseClient, readDatabaseConfig } from '../db/client';
import { events, journalEntries } from '../db/schema';
import {
  expectAxeClean,
  issue344EvidencePath,
  readFixture,
  statePath,
} from './support';

const LATE_UPDATE = 'Synthetic late-arriving collaboration update.';
const UNKNOWN_REASON = 'Synthetic exercise location was not available.';

test.describe('synthetic-event-room-regression', () => {
  test('recovers a failed refresh and preserves collaborative drill workflows', async ({
    browser,
    page,
  }) => {
    const fixture = await readFixture();
    const eventPath = `/events/${fixture.issue344EventId}`;
    let failNextTimelineRead = false;
    let observedFailedRead: (() => void) | undefined;
    const failedRead = new Promise<void>((resolveFailure) => {
      observedFailedRead = resolveFailure;
    });
    await page.route(`**${eventPath}/api?*`, async (route) => {
      if (route.request().method() === 'GET' && failNextTimelineRead) {
        failNextTimelineRead = false;
        observedFailedRead?.();
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
    await expect(
      page.getByRole('heading', { name: 'Post a photo' }),
    ).toBeVisible();
    await expect(page.getByLabel('Photo file')).toBeEnabled();

    failNextTimelineRead = true;
    await failedRead;
    await expect(
      page.getByRole('status').filter({ hasText: /Reconnecting|Offline/u }),
    ).toBeVisible({ timeout: 15_000 });

    const collaborator = await browser.newContext({
      storageState: statePath('district-admin.json'),
    });
    try {
      const collaboratorPage = await collaborator.newPage();
      await collaboratorPage.goto(eventPath);
      await collaboratorPage.getByLabel('Update text').fill(LATE_UPDATE);
      await collaboratorPage
        .getByRole('button', { name: 'Post update' })
        .click();
      await expect(collaboratorPage.getByText(LATE_UPDATE)).toBeVisible();
    } finally {
      await collaborator.close();
    }

    await expect(page.getByText(LATE_UPDATE)).toBeVisible({ timeout: 35_000 });
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected' }),
    ).toBeVisible({ timeout: 35_000 });

    await page.getByRole('radio', { name: 'Unknown location' }).check();
    await page.getByLabel('Why the location is unknown').fill(UNKNOWN_REASON);
    await page.getByRole('button', { name: 'Post location' }).click();
    await expect(page.getByText(UNKNOWN_REASON)).toBeVisible();
    await expect(
      page.getByText('Active', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review all-clear' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review event close' }),
    ).toHaveCount(0);
    await expectAxeClean(page);
    await page.screenshot({
      path: issue344EvidencePath('synthetic-event-room-regression-desktop.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(LATE_UPDATE)).toBeVisible();
    await page.screenshot({
      path: issue344EvidencePath(
        'synthetic-event-room-regression-mobile-390.png',
      ),
      fullPage: true,
    });

    const connection = createDatabaseClient(readDatabaseConfig());
    try {
      const [storedEvent] = await connection.db
        .select({ status: events.status })
        .from(events)
        .where(eq(events.id, fixture.issue344EventId));
      expect(storedEvent?.status).toBe('active');
      const entries = await connection.db
        .select({ kind: journalEntries.kind, payload: journalEntries.payload })
        .from(journalEntries)
        .where(eq(journalEntries.eventId, fixture.issue344EventId))
        .orderBy(asc(journalEntries.sequence));
      expect(
        entries.some(
          ({ kind, payload }) =>
            kind === 'text' &&
            (payload as Readonly<{ text?: unknown }>).text === LATE_UPDATE,
        ),
      ).toBe(true);
      expect(
        entries.some(
          ({ kind, payload }) =>
            kind === 'location' &&
            (payload as Readonly<{ reason?: unknown }>).reason ===
              UNKNOWN_REASON,
        ),
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
