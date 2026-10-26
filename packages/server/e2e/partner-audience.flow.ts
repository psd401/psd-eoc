import { expect, test, type Page } from '@playwright/test';

import { expectAxeClean, issue597EvidencePath } from './support';

const NORTH_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const LOCKDOWN_REAL_VERSION_ID = '00000000-0000-4000-8000-000000000200';
const LOCKDOWN_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';
// Synthetic earthquake: a threat the settings flow never excludes, so this
// flow reads the same whichever order the partner flows run in.
const EARTHQUAKE_THREAT_ID = '00000000-0000-4000-8000-000000000701';

async function openConfirmation(page: Page, mode: 'real' | 'drill') {
  const query = new URLSearchParams({
    facilityId: NORTH_FACILITY_ID,
    eventTypeVersionId:
      mode === 'real' ? LOCKDOWN_REAL_VERSION_ID : LOCKDOWN_DRILL_VERSION_ID,
    mode,
    threatId: EARTHQUAKE_THREAT_ID,
  });
  await page.goto(`/start/confirm?${query.toString()}`);
  const audience = page.getByRole('region', { name: 'Who gets notified' });
  await expect(audience).toBeVisible({ timeout: 30_000 });
  return audience;
}

/**
 * Issue #597: a live lockdown's consequence preview counts the admitted
 * partners it would alert, beside its staff. The harness's staff roster at
 * North is empty, so the preview is blocked and nothing can be started or
 * sent; the server still resolves and shows the partner audience.
 */
test.describe('partner-audience', () => {
  test('lockdown activation lists partner recipients', async ({ page }) => {
    const audience = await openConfirmation(page, 'real');
    const partners = audience.getByText(/^\d+ partner recipients?$/u);
    await expect(partners).toBeVisible();
    const count = Number.parseInt(
      (await partners.textContent())?.trim() ?? '',
      10,
    );
    // Several admitted, unexpired partners exist in the harness; the expired
    // one is never counted.
    expect(count).toBeGreaterThan(0);
    await expect(
      audience.getByText(/admitted first responders outside the district/u),
    ).toBeVisible();
    // Partners never make an unready send ready.
    await expect(
      page.getByRole('heading', { name: 'Notifications are not ready' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: /Start (?:a separate )?REAL incident and notify/u,
      }),
    ).toHaveCount(0);
    await expectAxeClean(page);
    await page.screenshot({
      path: issue597EvidencePath('lockdown-activation-partner-recipients.png'),
      fullPage: true,
    });

    // A drill of the same response never reaches a partner.
    const drillAudience = await openConfirmation(page, 'drill');
    await expect(drillAudience.getByText(/partner recipient/u)).toHaveCount(0);
  });
});
