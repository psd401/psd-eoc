import { expect, test } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';

import { createDatabaseClient, readDatabaseConfig } from '../db/client';
import { journalEntries } from '../db/schema';
import { expectAxeClean, issue341EvidencePath, readFixture } from './support';

const ORIGINAL = 'Synthetic mobile collaboration update.';

// Correct and redact left the web event room in #407. Corrections now reach
// the journal only through the journal capabilities, so this flow stops at the
// appended update and proves the room retained it verbatim.
test.describe('mobile-event-collaboration', () => {
  test('a mobile viewport reconnects and appends an update the journal retains verbatim', async ({
    page,
  }) => {
    const fixture = await readFixture();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/events/${fixture.eventId}`);
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();

    await page.context().setOffline(true);
    await expect(
      page.getByRole('status').filter({ hasText: 'Offline' }),
    ).toBeVisible({ timeout: 15_000 });
    await page.context().setOffline(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Updated /u)).toBeVisible({
      timeout: 30_000,
    });

    const updateText = page.getByLabel('Update text');
    const postUpdate = page.getByRole('button', { name: 'Post update' });
    await updateText.fill(ORIGINAL);
    await expect(updateText).toHaveValue(ORIGINAL);
    await expect(postUpdate).toBeEnabled();
    await postUpdate.click();
    const originalCard = page.locator('article.timeline-entry', {
      hasText: ORIGINAL,
    });
    await expect(originalCard).toBeVisible();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue341EvidencePath('mobile-event-collaboration.png'),
      fullPage: true,
    });

    const connection = createDatabaseClient(readDatabaseConfig());
    try {
      const retained = await connection.db
        .select({
          id: journalEntries.id,
          sequence: journalEntries.sequence,
          payload: journalEntries.payload,
          supersedesEntryId: journalEntries.supersedesEntryId,
          supersessionKind: journalEntries.supersessionKind,
        })
        .from(journalEntries)
        .where(eq(journalEntries.eventId, fixture.eventId))
        .orderBy(asc(journalEntries.sequence));
      const original = retained.find(
        ({ payload }) =>
          (payload as Readonly<{ text?: unknown }>).text === ORIGINAL,
      );
      expect(original).toMatchObject({
        supersedesEntryId: null,
        supersessionKind: null,
      });
    } finally {
      await connection.close();
    }
  });
});
