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
    const lifecycle = page.getByRole('region', { name: 'Event status' });
    const composer = page.getByRole('heading', { name: 'Post an update' });
    const timeline = page.getByRole('heading', { name: 'Event timeline' });
    // Posting is what the room is for, so the composer comes before the
    // timeline; the status panel stays above both.
    expect((await lifecycle.boundingBox())?.y).toBeLessThan(
      (await composer.boundingBox())?.y ?? 0,
    );
    expect((await composer.boundingBox())?.y).toBeLessThan(
      (await timeline.boundingBox())?.y ?? 0,
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

    const endOpener = page.getByRole('button', { name: 'End event' });
    await endOpener.focus();
    await page.keyboard.press('Enter');
    const endDialog = page.getByRole('dialog', { name: 'End this event' });
    await expect(endDialog).toBeVisible();
    const endCancel = endDialog.getByRole('button', { name: 'Cancel' });
    await expect(endDialog.getByText(/staff by/iu)).toBeVisible();
    await expect(endCancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(endDialog).toBeHidden();
    await expect(endOpener).toBeFocused();
    await page.keyboard.press('Space');
    await expect(endDialog).toBeVisible();
    await expect(endDialog.locator('input')).toHaveCount(0);
    // Raw preview identifiers and digests are record-keeping, not operator
    // reading material.
    await expect(
      endDialog.getByText('Technical consequence details'),
    ).toHaveCount(0);
    await expect(endCancel).toBeFocused();
    await expectAxeClean(page);
    await page.screenshot({
      path: evidencePath('synthetic-drill-all-clear-review-mobile-390.png'),
      fullPage: true,
    });
    // The dialog re-renders when its preview settles, and that render moves
    // focus back to Cancel on the next animation frame. Wait for both before
    // moving focus, or Shift+Tab races the refocus and lands nowhere.
    await expect(
      endDialog.getByRole('button', { name: 'End event and notify staff' }),
    ).toBeEnabled();
    await expect(endCancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(
      endDialog.getByRole('button', { name: 'End event and notify staff' }),
    ).toBeFocused();
    const allClearResponsePromise = waitForLifecycleResponse(
      page,
      fixture.eventId,
      'all-clear',
    );
    const closeResponsePromise = waitForLifecycleResponse(
      page,
      fixture.eventId,
      'close',
    );
    // One confirmed action performs both server transitions.
    await page.keyboard.press('Enter');
    const allClearResponse = await allClearResponsePromise;
    expect(allClearResponse.status()).toBe(200);
    const allClearTransition = EventTransitionSchema.parse(
      ((await allClearResponse.json()) as { transition?: unknown }).transition,
    );

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

    const closeResponse = await closeResponsePromise;
    expect(closeResponse.status()).toBe(200);
    const closeTransition = EventTransitionSchema.parse(
      ((await closeResponse.json()) as { transition?: unknown }).transition,
    );
    await expect(
      page.getByText('Closed', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'End event' })).toHaveCount(
      0,
    );

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
