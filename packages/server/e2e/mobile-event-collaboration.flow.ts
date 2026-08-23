import { expect, test } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';

import { createDatabaseClient, readDatabaseConfig } from '../db/client';
import { journalEntries } from '../db/schema';
import { expectAxeClean, issue341EvidencePath, readFixture } from './support';

const ORIGINAL = 'Synthetic mobile collaboration update.';
const CORRECTED = 'Synthetic mobile collaboration update — corrected.';
const CORRECTION_REASON = 'Clarified the synthetic acceptance fixture.';
const REDACTION_REASON = 'Removed the corrected synthetic fixture from view.';

test.describe('mobile-event-collaboration', () => {
  test('a mobile viewport reconnects and appends correction/redaction provenance without rewriting history', async ({
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
    await originalCard.getByRole('button', { name: /Correct entry/u }).click();

    const correctionDialog = page.getByRole('dialog', {
      name: /Correct entry/u,
    });
    await correctionDialog.getByLabel('Corrected text').fill(CORRECTED);
    await correctionDialog
      .getByLabel('Reason for correction')
      .fill(CORRECTION_REASON);
    await correctionDialog
      .getByRole('button', { name: 'Append correction' })
      .click();

    const correctionCard = page.locator('article.timeline-entry', {
      hasText: CORRECTED,
    });
    await expect(correctionCard).toBeVisible();
    await expect(originalCard).toContainText(
      'This original entry was superseded, not deleted.',
    );
    await correctionCard.getByRole('button', { name: /Redact entry/u }).click();

    const redactionDialog = page.getByRole('dialog', {
      name: /Redact entry/u,
    });
    await expect(redactionDialog).toContainText(
      'The original journal record, sequence, timing, and provenance are never deleted.',
    );
    await redactionDialog
      .getByLabel('Reason for redaction')
      .fill(REDACTION_REASON);
    await redactionDialog
      .getByRole('button', { name: 'Append redaction' })
      .click();

    await expect(
      page.getByText(
        'Original content is hidden because a later append-only redaction supersedes this entry. Its sequence, timing, and provenance remain in the journal.',
      ),
    ).toBeVisible();
    await expect(page.getByText(REDACTION_REASON)).toBeVisible();
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
          supersessionReason: journalEntries.supersessionReason,
        })
        .from(journalEntries)
        .where(eq(journalEntries.eventId, fixture.eventId))
        .orderBy(asc(journalEntries.sequence));
      const original = retained.find(
        ({ payload }) =>
          (payload as Readonly<{ text?: unknown }>).text === ORIGINAL,
      );
      const correction = retained.find(
        ({ payload }) =>
          (payload as Readonly<{ text?: unknown }>).text === CORRECTED,
      );
      const redaction = retained.find(
        ({ supersessionKind }) => supersessionKind === 'redaction',
      );
      expect(original).toBeDefined();
      expect(correction).toMatchObject({
        supersessionKind: 'correction',
        supersessionReason: CORRECTION_REASON,
      });
      expect(redaction).toMatchObject({
        supersessionKind: 'redaction',
        supersessionReason: REDACTION_REASON,
      });
      expect(correction?.supersedesEntryId).toBe(original?.id);
      expect(redaction?.supersedesEntryId).toBe(correction?.id);
      expect(
        (original?.payload as Readonly<{ text?: unknown }> | undefined)?.text,
      ).toBe(ORIGINAL);
      expect(
        (correction?.payload as Readonly<{ text?: unknown }> | undefined)?.text,
      ).toBe(CORRECTED);
    } finally {
      await connection.close();
    }
  });
});
