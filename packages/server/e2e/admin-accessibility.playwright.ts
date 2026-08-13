import { expect, test } from '@playwright/test';

import {
  assertAxeClean,
  installAxe,
} from '../app/(app)/start/test/axe-playwright';

test.beforeEach(async ({ context }) => {
  await installAxe(context);
});

test('event-type administration validates, previews, publishes, and is axe-clean in every state', async ({
  page,
}) => {
  await page.goto('/event-types/manage');
  await expect(page).toHaveURL(/\/event-types\/manage$/u);
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

  await expect(page.getByLabel('Event type')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save draft and preview' }),
  ).toBeVisible();
  await assertAxeClean(page, 'initial event-type administration');

  const pushTitle = page.getByLabel('Lock-screen title').first();
  const availability = page.getByLabel('Available for new activations');
  await availability.check();
  await pushTitle.fill('[DRILL] contradictory marker');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  const errorSummary = page.getByRole('alert').filter({
    has: page.getByRole('heading', { name: 'Draft not saved' }),
  });
  await expect(errorSummary).toBeFocused();
  await expect(errorSummary).toContainText(
    'Classification markers [INCIDENT] and [DRILL] are owned by the renderer',
  );
  await assertAxeClean(page, 'event-type validation error');

  await pushTitle.fill('{{eventType}} at {{site}}');
  await availability.uncheck();
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  await expect(
    page.getByRole('heading', { name: 'Activation preview', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'All-clear preview', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Reactivation preview', exact: true }),
  ).toBeVisible();
  await assertAxeClean(page, 'event-type channel previews');

  const publish = page.getByRole('button', { name: 'Publish new version' });
  const description = page.getByLabel('Description');
  const firstDescription = 'Synthetic issue 32 accessibility review A.';
  const secondDescription = 'Synthetic issue 32 accessibility review B.';
  await description.fill(
    (await description.inputValue()) === firstDescription
      ? secondDescription
      : firstDescription,
  );
  await expect(publish).toBeDisabled();

  let previewFailureInjected = false;
  await page.route('**/event-types/api**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      !previewFailureInjected &&
      route.request().method() === 'GET' &&
      requestUrl.searchParams.get('operation') === 'preview' &&
      requestUrl.searchParams.get('purpose') === 'all-clear'
    ) {
      previewFailureInjected = true;
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Update draft and preview' }).click();
  await expect(
    page.getByRole('heading', { name: 'Draft saved, but preview failed' }),
  ).toBeVisible();
  expect(previewFailureInjected).toBe(true);
  await assertAxeClean(page, 'event-type preview failure');

  await page.unroute('**/event-types/api**');
  await page.getByRole('button', { name: 'Update draft and preview' }).click();
  await expect(publish).toBeEnabled();
  await assertAxeClean(page, 'updated event-type channel previews');
  await publish.click();
  await expect(page.getByRole('status')).toContainText(
    /Version \d+ published/u,
  );
  await expect(page.getByText('Not available for activation')).toBeVisible();
  await assertAxeClean(page, 'published event-type administration');
});
