import { expect, test, type Page } from '@playwright/test';

async function openAsSyntheticAdministrator(page: Page) {
  await page.goto('/event-types/manage');
  await expect(page).toHaveURL(/\/event-types\/manage$/u);
}

test('admin edits, validates, previews, and publishes by keyboard-visible controls', async ({
  page,
}) => {
  await openAsSyntheticAdministrator(page);

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Event types and message templates',
    }),
  ).toBeVisible();
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  const picker = page.getByLabel('Event type');
  await expect(picker).toBeVisible();
  const pickerSize = await picker.boundingBox();
  expect(pickerSize?.height).toBeGreaterThanOrEqual(44);
  await expect(
    page.getByText('REAL INCIDENT TYPE', { exact: true }),
  ).toBeVisible();

  const pushTitle = page.getByLabel('Lock-screen title').first();
  await pushTitle.fill('[DRILL] contradictory marker');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  const errorSummary = page.getByRole('alert').filter({
    has: page.getByRole('heading', { name: 'Draft not saved' }),
  });
  await expect(errorSummary).toBeFocused();
  await expect(errorSummary).toContainText('real classification');

  await pushTitle.fill('{{eventType}} at {{site}}');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  await expect(
    page.getByText(
      'Draft saved and retained for recovery. Review every renderer-produced channel below before publishing.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Activation preview', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'All-clear preview', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Reactivation preview', exact: true }),
  ).toBeVisible();
  for (const lockScreen of await page.locator('.lock-screen').all()) {
    await expect(lockScreen).toContainText('[INCIDENT]');
  }

  const publish = page.getByRole('button', { name: 'Publish new version' });
  await expect(publish).toBeEnabled();
  await page
    .getByLabel('Description')
    .fill('Synthetic keyboard review change.');
  await expect(publish).toBeDisabled();
  await page.getByRole('button', { name: 'Update draft and preview' }).click();
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByRole('status')).toContainText(
    /Version \d+ published/u,
  );
});

test('an unresolved draft save is retained but never replayed automatically', async ({
  page,
}) => {
  await openAsSyntheticAdministrator(page);
  let postCount = 0;
  await page.route('**/event-types/api', async (route) => {
    if (route.request().method() === 'POST') {
      postCount += 1;
      if (postCount === 1) {
        await route.abort('connectionreset');
        return;
      }
      if (postCount === 2) {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'FORBIDDEN',
            message: 'Access is denied.',
            requestId: '10000000-0000-4000-8000-000000000010',
            retryable: false,
            fieldErrors: [],
          }),
        });
        return;
      }
    }
    await route.continue();
  });
  await page
    .getByLabel('Description')
    .fill('Synthetic retained-command recovery check.');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  await expect(page.getByRole('status')).toContainText(
    'The outcome is unresolved.',
  );
  expect(postCount).toBe(1);

  await page.reload();
  const recovery = page.getByRole('button', {
    name: 'Retry exact draft save',
  });
  await expect(recovery).toBeVisible();
  await expect(
    page.getByText('It will never replay automatically.'),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(postCount).toBe(1);

  await recovery.click();
  await expect(
    page.getByRole('heading', { name: 'Previous change not recovered' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'The outcome remains unresolved.',
  );
  expect(postCount).toBe(2);

  await page.reload();
  await expect(recovery).toBeVisible();
  await page.waitForTimeout(500);
  expect(postCount).toBe(2);

  await recovery.click();
  await expect(
    page.getByText(
      'Draft saved and retained for recovery. Review every renderer-produced channel below before publishing.',
    ),
  ).toBeVisible();
  expect(postCount).toBe(3);
});
