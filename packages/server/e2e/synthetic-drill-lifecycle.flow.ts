import { EventTransitionSchema } from '@psd-eoc/contracts';
import { expect, test, type Page } from '@playwright/test';
import { and, asc, eq } from 'drizzle-orm';

import { createDatabaseClient, readDatabaseConfig } from '../db/client';
import { securityAuditEntries } from '../db/schema';
import { evidencePath, expectAxeClean, readFixture } from './support';

async function lifecycleAudit(
  action: 'all-clear-event' | 'close-event',
  requestId: string,
) {
  const connection = createDatabaseClient(readDatabaseConfig());
  try {
    return await connection.db
      .select({
        action: securityAuditEntries.action,
        category: securityAuditEntries.category,
        outcome: securityAuditEntries.outcome,
        principalKind: securityAuditEntries.principalKind,
        sequence: securityAuditEntries.sequence,
      })
      .from(securityAuditEntries)
      .where(
        and(
          eq(securityAuditEntries.action, action),
          eq(securityAuditEntries.outcome, 'success'),
          eq(securityAuditEntries.requestId, requestId),
        ),
      )
      .orderBy(asc(securityAuditEntries.sequence));
  } finally {
    await connection.close();
  }
}

function waitForLifecycleResponse(
  page: Page,
  eventId: string,
  operation: 'all-clear' | 'close',
) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/events/${eventId}/api` &&
      (response.request().postDataJSON() as { operation?: unknown })
        .operation === operation,
  );
}

test.describe('synthetic-drill-lifecycle', () => {
  test('a keyboard-operable synthetic drill appends all-clear and close through real capabilities', async ({
    page,
  }) => {
    const fixture = await readFixture();
    const mutationKeys: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() !== 'POST' ||
        !request.url().endsWith(`/events/${fixture.eventId}/api`)
      ) {
        return;
      }
      const body = request.postDataJSON() as Readonly<{ operation?: unknown }>;
      if (body.operation === 'all-clear' || body.operation === 'close') {
        const key = request.headers()['idempotency-key'];
        if (key !== undefined) mutationKeys.push(key);
      }
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/events/${fixture.eventId}`);
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: /Connected|Connecting/ }),
    ).toBeVisible();
    const lifecycle = page.getByRole('region', { name: 'Event state' });
    const composer = page.getByRole('heading', { name: 'Post an update' });
    expect((await lifecycle.boundingBox())?.y).toBeLessThan(
      (await composer.boundingBox())?.y ?? 0,
    );
    await expectAxeClean(page);
    await page.screenshot({
      path: evidencePath('synthetic-drill-active-desktop.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    expect((await lifecycle.boundingBox())?.y).toBeLessThan(
      (await composer.boundingBox())?.y ?? 0,
    );
    await page.screenshot({
      path: evidencePath('synthetic-drill-active-mobile-390.png'),
      fullPage: true,
    });

    const allClearOpener = page.getByRole('button', {
      name: 'Review all-clear',
    });
    await allClearOpener.focus();
    await page.keyboard.press('Enter');
    const allClearDialog = page.getByRole('dialog', {
      name: 'Review and issue all-clear',
    });
    await expect(allClearDialog).toBeVisible();
    const allClearCancel = allClearDialog.getByRole('button', {
      name: 'Cancel',
    });
    await expect(
      allClearDialog.getByText(/recipients across .* channels/i),
    ).toBeVisible();
    await expect(allClearCancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(allClearDialog).toBeHidden();
    await expect(allClearOpener).toBeFocused();
    await page.keyboard.press('Space');
    await expect(allClearDialog).toBeVisible();
    await expect(allClearDialog.locator('input')).toHaveCount(0);
    await expect(allClearDialog.locator('input[type="checkbox"]')).toHaveCount(
      0,
    );
    await expect(
      allClearDialog.getByText(/recipients across .* channels/i),
    ).toBeVisible();
    await expect(
      allClearDialog.getByText(/Select “Issue all-clear and notify”/u),
    ).toBeVisible();
    await expect(
      allClearDialog.getByText('Technical consequence details'),
    ).toBeVisible();
    await expect(allClearCancel).toBeFocused();
    await expectAxeClean(page);
    await page.screenshot({
      path: evidencePath('synthetic-drill-all-clear-review-mobile-390.png'),
      fullPage: true,
    });
    await page.keyboard.press('Shift+Tab');
    await expect(
      allClearDialog.getByRole('button', {
        name: 'Issue all-clear and notify',
      }),
    ).toBeFocused();
    const allClearResponsePromise = waitForLifecycleResponse(
      page,
      fixture.eventId,
      'all-clear',
    );
    await page.keyboard.press('Enter');
    const allClearResponse = await allClearResponsePromise;
    expect(allClearResponse.status()).toBe(200);
    const allClearTransition = EventTransitionSchema.parse(
      ((await allClearResponse.json()) as { transition?: unknown }).transition,
    );
    await expect(
      page.getByText('All-clear issued', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review event close' }),
    ).toBeVisible();

    const allClearAudits = await lifecycleAudit(
      'all-clear-event',
      allClearTransition.requestId,
    );
    expect(allClearAudits).toHaveLength(1);
    expect(allClearAudits[0]).toMatchObject({
      category: 'capability-execution',
      outcome: 'success',
      principalKind: 'human',
    });

    const closeOpener = page.getByRole('button', {
      name: 'Review event close',
    });
    await closeOpener.focus();
    await page.keyboard.press('Enter');
    const closeDialog = page.getByRole('dialog', {
      name: 'Review and close event',
    });
    await expect(closeDialog).toBeVisible();
    const closeCancel = closeDialog.getByRole('button', { name: 'Cancel' });
    await expect(closeCancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(closeDialog).toBeHidden();
    await expect(closeOpener).toBeFocused();
    await page.keyboard.press('Space');
    await expect(closeDialog).toBeVisible();
    await expect(closeDialog.locator('input')).toHaveCount(0);
    await expect(
      closeDialog.getByText(
        'No recipients or notification channels are contacted.',
      ),
    ).toBeVisible();
    await expect(
      closeDialog.getByText('Technical close details'),
    ).toBeVisible();
    await expect(closeCancel).toBeFocused();
    await expectAxeClean(page);
    await page.keyboard.press('Shift+Tab');
    await expect(
      closeDialog.getByRole('button', { name: 'Close event' }),
    ).toBeFocused();
    const closeResponsePromise = waitForLifecycleResponse(
      page,
      fixture.eventId,
      'close',
    );
    await page.keyboard.press('Enter');
    const closeResponse = await closeResponsePromise;
    expect(closeResponse.status()).toBe(200);
    const closeTransition = EventTransitionSchema.parse(
      ((await closeResponse.json()) as { transition?: unknown }).transition,
    );
    await expect(
      page.getByText('Closed', { exact: true }).first(),
    ).toBeVisible();

    const closeAudits = await lifecycleAudit(
      'close-event',
      closeTransition.requestId,
    );
    expect(closeAudits).toHaveLength(1);
    expect(closeAudits[0]).toMatchObject({
      category: 'capability-execution',
      outcome: 'success',
      principalKind: 'human',
    });
    expect(mutationKeys).toHaveLength(2);
    expect(new Set(mutationKeys).size).toBe(2);
    await page.screenshot({
      path: evidencePath('synthetic-drill-closed-mobile-390.png'),
      fullPage: true,
    });
  });
});
