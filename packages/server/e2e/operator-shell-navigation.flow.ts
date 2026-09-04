import { expect, test } from '@playwright/test';

import { evidencePath, expectAxeClean, statePath } from './support';

const DISTRICT_ADMIN_DESTINATIONS = [
  ['Events', '/', 'Active events'],
  ['Start event', '/start', 'Start an event'],
  ['Records', '/records', 'Records'],
  ['Delivery tests', '/delivery-tests', 'Monthly live delivery test'],
  ['Readiness', '/admin', 'Deployment readiness'],
  ['Schools', '/facilities', /^Facilities, neighborhoods,/u],
  ['Responses', '/event-types', 'Responses and message templates'],
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

    // The responses admin is where the "event type" wording used to live, so
    // this navigation also proves an operator reads only "response" there.
    await page.goto('/event-types/manage');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Responses and message templates',
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Response', { exact: true })).toBeVisible();
    expect(
      (await page.locator('main#main-content').innerText()).toLowerCase(),
    ).not.toContain('event type');

    // A retired response is never deleted, so the picker defaults to what an
    // operator can actually choose and keeps a way back to the rest.
    const picker = page.getByLabel('Response', { exact: true });
    const availableCount = await picker.locator('option').count();
    await expect(page).not.toHaveURL(/show=all/u);
    await expect(
      page.getByText(/Showing responses available for new activations/u),
    ).toBeVisible();
    await page
      .getByRole('link', { name: 'Show retired responses', exact: true })
      .click();
    await expect(page).toHaveURL(/\/event-types\/manage\?show=all$/u);
    await expect(
      page.getByText(/Showing every response, including those no longer/u),
    ).toBeVisible();
    // Every available response is still listed once retired ones join them.
    expect(await picker.locator('option').count()).toBeGreaterThanOrEqual(
      availableCount,
    );
    await expectAxeClean(page);
    await page
      .getByRole('link', { name: 'Hide retired responses', exact: true })
      .click();
    await expect(page).toHaveURL(/\/event-types\/manage$/u);

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

  test('start-flow back links return a step without previewing or starting', async ({
    page,
  }) => {
    let previewRequests = 0;
    let activationRequests = 0;
    await page.route('**/start/api/preview', async (route) => {
      previewRequests += 1;
      await route.abort();
    });
    await page.route('**/start/api/activate', async (route) => {
      activationRequests += 1;
      await route.abort();
    });

    await page.goto('/');
    await page
      .getByRole('link', {
        name: 'Run DRILL at Synthetic North Campus',
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/start\?.*mode=drill/u);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Choose threat' }),
    ).toBeVisible();
    await page
      .getByRole('link', { name: 'Synthetic wildlife', exact: true })
      .click();
    await expect(page).toHaveURL(/\/start\?.*threatId=/u);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Choose response' }),
    ).toBeVisible();

    // A response that needs a description refuses whitespace the browser's own
    // required-field check accepts, and says so beside the words the operator
    // typed rather than emptying the field.
    const otherResponse = page.getByRole('form', { name: 'Other Drill' });
    await otherResponse.getByLabel('Describe the response').fill('   ');
    await otherResponse
      .getByRole('button', { name: 'Continue with Other Drill' })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Choose response' }),
    ).toBeVisible();
    await expect(
      otherResponse.getByRole('alert').filter({ hasText: /Type a short/u }),
    ).toBeVisible();
    await expect(otherResponse.getByLabel('Describe the response')).toHaveValue(
      '   ',
    );
    await expectAxeClean(page);

    await page
      .getByRole('link', { name: 'Change threat', exact: true })
      .click();
    await expect(page).toHaveURL(/\/start\?(?!.*threatId=).*mode=drill/u);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Choose threat' }),
    ).toBeVisible();
    await expectAxeClean(page);

    await page.getByRole('link', { name: 'Change site', exact: true }).click();
    await expect(page).toHaveURL(/\/$/u);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Active events' }),
    ).toBeVisible();
    expect(previewRequests).toBe(0);
    expect(activationRequests).toBe(0);
  });
});
