import { expect, test } from '@playwright/test';

import { evidencePath, expectAxeClean, statePath } from './support';

const DISTRICT_ADMIN_DESTINATIONS = [
  ['Events', '/', 'Active events'],
  ['Start event', '/start', 'Start an event'],
  ['Records', '/records', 'Drill records'],
  ['Delivery tests', '/delivery-tests', 'Monthly live delivery test'],
  ['Readiness', '/admin', 'Deployment readiness'],
  ['Schools', '/facilities', 'Facilities, neighborhoods, and audiences'],
  ['Event types', '/event-types', 'Event types and message templates'],
  ['Access', '/access', 'Access groups and the roles they grant'],
  ['Devices', '/devices', 'Device sessions'],
  ['Notifications', '/integrations', 'Integrations administration'],
  ['Audit', '/audit', 'Security audit log'],
  ['Agents', '/agents', 'Agent access'],
] as const;

test.describe('operator-shell-navigation', () => {
  test('one authorized navigation reaches every visible destination', async ({
    page,
  }) => {
    await page.goto('/');
    const primary = page.getByRole('navigation', { name: 'Primary' });
    await expect(primary.getByRole('link')).toHaveCount(13);
    await expect(
      primary.getByRole('link', {
        name: 'Synthetic Example School District emergency operations',
      }),
    ).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('link', { name: 'Skip to main content' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main-content')).toBeFocused();

    for (const [label, href, heading] of DISTRICT_ADMIN_DESTINATIONS) {
      const response = await page.goto(href);
      expect(response?.ok()).toBe(true);
      await expect(page.locator('main#main-content')).toHaveCount(1);
      await expect(
        page.getByRole('heading', { level: 1, name: heading }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByText(/(?:administrator access|session) required/i),
      ).toHaveCount(0);
      await expect(
        page.getByRole('link', { name: label, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await expectAxeClean(page);
    }

    await page.goto('/');
    await page.screenshot({
      path: evidencePath('operator-shell-desktop.png'),
      fullPage: true,
    });
  });

  test('server authorization filters facility admin and staff destinations', async ({
    browser,
  }) => {
    const cases = [
      {
        state: 'facility-admin.json',
        labels: [
          'Events',
          'Start event',
          'Records',
          'Delivery tests',
          'Devices',
          'Audit',
        ],
      },
      {
        state: 'facility-staff.json',
        labels: ['Events', 'Start event', 'Records', 'Delivery tests'],
      },
    ] as const;
    for (const testCase of cases) {
      const context = await browser.newContext({
        storageState: statePath(testCase.state),
      });
      const page = await context.newPage();
      await page.goto('/');
      const links = page
        .getByRole('navigation', { name: 'Primary' })
        .locator('.primary-nav__links a');
      await expect(links).toHaveText(testCase.labels);
      await context.close();
    }
  });

  test('the same shell stays operable at 390 pixels', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page.getByRole('navigation', { name: 'Primary' }),
    ).toBeVisible();
    await expect(page.locator('main#main-content')).toBeVisible();
    const agents = page.getByRole('link', { name: 'Agents', exact: true });
    await agents.focus();
    await expect(agents).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/agents$/u);
    await expect(agents).toHaveAttribute('aria-current', 'page');
    await expectAxeClean(page);
    await page.screenshot({
      path: evidencePath('operator-shell-mobile-390.png'),
      fullPage: true,
    });
  });
});
