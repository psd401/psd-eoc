import { expect, test } from '@playwright/test';

import { expectAxeClean, issue597EvidencePath } from './support';

/**
 * Issue #597: a district administrator chooses which real events alert
 * partners. Each save is a new version; nothing is sent by this flow.
 */
test.describe('partner-alert-settings', () => {
  test('admin edits partner alert settings', async ({ page }) => {
    await page.goto('/partner-alerts');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Partner alerts' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('link', { name: 'Partner alerts', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Default settings in effect.')).toBeVisible();

    const responses = page.getByRole('group', {
      name: 'Responses that alert partners',
    });
    const threats = page.getByRole('group', {
      name: 'Threats that never alert partners',
    });
    const response = (name: string) =>
      responses.getByRole('checkbox', { name, exact: true });
    const threat = (name: string) =>
      threats.getByRole('checkbox', { name, exact: true });

    // The product owner's default: Lockdown and Modified Lockdown only.
    await expect(response('Lockdown')).toBeChecked();
    await expect(response('Modified Lockdown')).toBeChecked();
    await expect(response('Evacuation')).not.toBeChecked();
    await expect(threat('Synthetic wildlife')).not.toBeChecked();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue597EvidencePath('partner-alerts-defaults.png'),
      fullPage: true,
    });

    await response('Modified Lockdown').uncheck();
    await response('Evacuation').check();
    await threat('Synthetic wildlife').check();
    await page
      .getByRole('button', { name: 'Save partner alert settings' })
      .click();

    await expect(page.getByRole('status')).toContainText(
      'Partner alert settings were saved as a new version.',
    );
    await expect(page.getByText(/Version 1 in effect/u)).toBeVisible();
    await expect(response('Lockdown')).toBeChecked();
    await expect(response('Modified Lockdown')).not.toBeChecked();
    await expect(response('Evacuation')).toBeChecked();
    await expect(threat('Synthetic wildlife')).toBeChecked();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue597EvidencePath('partner-alerts-saved.png'),
      fullPage: true,
    });

    // A second save is the next version, built on the first.
    await threat('Synthetic wildlife').uncheck();
    await page
      .getByRole('button', { name: 'Save partner alert settings' })
      .click();
    await expect(page.getByText(/Version 2 in effect/u)).toBeVisible();
    await expect(threat('Synthetic wildlife')).not.toBeChecked();
  });
});
