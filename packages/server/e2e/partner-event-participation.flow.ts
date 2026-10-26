import { expect, test } from '@playwright/test';

import {
  expectAxeClean,
  issue594EvidencePath,
  readFixture,
  statePath,
} from './support';

/**
 * Issue #594: a partner-agency responder follows and posts to a live drill
 * and is offered nothing the capability engine refuses a partner session:
 * no start flow, no Records, no exports, no lifecycle controls, and no
 * administration.
 */

const PARTNER_UPDATE = 'Synthetic engine company staged at the north lot.';

test.describe('partner-event-participation', () => {
  test.use({ storageState: statePath('partner-responder.json') });

  test('partner joins a live drill and posts', async ({ page }) => {
    const fixture = await readFixture();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Active events' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('Partner agency emergency operations'),
    ).toBeVisible();

    // Join is a client button: a click before hydration does nothing, so
    // retry until the room opens.
    const join = page.getByRole('button', {
      name: new RegExp(`event ${fixture.partnerEventId.slice(-8)}$`, 'u'),
    });
    await expect(join).toBeVisible();
    await expect(async () => {
      if (new URL(page.url()).pathname === `/events/${fixture.partnerEventId}`)
        return;
      await join.click();
      await page.waitForURL(`**/events/${fixture.partnerEventId}`, {
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000 });

    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected' }),
    ).toBeVisible({ timeout: 30_000 });

    const updateText = page.getByLabel('Update text');
    const postUpdate = page.getByRole('button', { name: 'Post update' });
    await updateText.fill(PARTNER_UPDATE);
    await expect(postUpdate).toBeEnabled();
    await postUpdate.click();
    await expect(
      page.locator('article.timeline-entry', { hasText: PARTNER_UPDATE }),
    ).toBeVisible();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue594EvidencePath('partner-joined-drill-posted.png'),
      fullPage: true,
    });
  });

  test('partner has no start/end/admin controls', async ({ page }) => {
    const fixture = await readFixture();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Active events' }),
    ).toBeVisible({ timeout: 30_000 });

    // Navigation lists only what the partner allowlist admits.
    const navigation = page.getByRole('navigation', { name: 'Primary' });
    await expect(
      navigation.locator('.primary-nav__links').getByRole('link'),
    ).toHaveText(['Events', 'Text alerts']);
    await expect(
      navigation.getByRole('link', { name: /emergency operations$/u }),
    ).toHaveAttribute('href', '/');

    // The events list offers joining only: no start actions, no Records.
    await expect(page.getByRole('link', { name: 'View records' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('heading', { name: 'Start an event' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: /^(Start REAL incident|Run DRILL) at /u }),
    ).toHaveCount(0);
    await expectAxeClean(page);
    await page.screenshot({
      path: issue594EvidencePath('partner-events-list.png'),
      fullPage: true,
    });

    // Typing a staff-only address lands back on the events list.
    for (const address of ['/start', '/records']) {
      await page.goto(address);
      await expect(page).toHaveURL(/\/$/u);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Active events' }),
      ).toBeVisible();
    }

    // The event room lets the partner post but never end or export.
    await page.goto(`/events/${fixture.partnerEventId}`);
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    const lifecycle = page.getByRole('region', { name: 'Event status' });
    await expect(lifecycle).toContainText('Staff there end it');
    await expect(page.getByRole('button', { name: 'End event' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: 'Finish ending the event' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Download PDF summary' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Post an update' }),
    ).toBeVisible();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue594EvidencePath('partner-event-room.png'),
      fullPage: true,
    });

    // Administration is refused: every administrator page answers with its
    // refusal, never a server error, and links no administrator destination.
    for (const address of [
      '/admin',
      '/facilities',
      '/event-types',
      '/access',
      '/partner-alerts',
      '/devices',
      '/integrations',
      '/audit',
      '/agents',
    ]) {
      const response = await page.goto(address);
      expect(response?.status(), address).toBeLessThan(500);
      await expect(
        page.getByRole('link', {
          name: /^(Readiness|Access|Partner alerts|Agents|Audit)$/u,
        }),
      ).toHaveCount(0);
    }
    await page.goto('/access');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Administrator access required',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Partners' }),
    ).toHaveCount(0);
  });
});
