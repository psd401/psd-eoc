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
  const availability = page.getByLabel('Available for new activations');
  await availability.check();
  await expect(availability).toBeChecked();
  await pushTitle.fill('[DRILL] contradictory marker');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  const errorSummary = page.getByRole('alert').filter({
    has: page.getByRole('heading', { name: 'Draft not saved' }),
  });
  await expect(errorSummary).toBeFocused();
  await expect(errorSummary).toContainText(
    'Classification markers [INCIDENT] and [DRILL] are owned by the renderer',
  );

  await pushTitle.fill('{{eventType}} at {{site}}');
  await availability.uncheck();
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
  await expect(
    page.getByRole('heading', { name: 'Activation preview', exact: true }),
  ).toHaveCount(0);

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
  await expect(publish).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Activation preview', exact: true }),
  ).toHaveCount(0);
  expect(previewFailureInjected).toBe(true);

  await page.unroute('**/event-types/api**');
  await page.getByRole('button', { name: 'Update draft and preview' }).click();
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByRole('status')).toContainText(
    /Version \d+ published/u,
  );
  await expect(
    page.getByRole('heading', { name: 'Activation preview', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Not available for activation')).toBeVisible();
});

test('a valid unresolved command survives a damaged draft record and a definite 403 clears it', async ({
  page,
}) => {
  await openAsSyntheticAdministrator(page);
  const attempts: Array<Readonly<{ body: string; idempotencyKey: string }>> =
    [];
  await page.route('**/event-types/api', async (route) => {
    if (route.request().method() === 'POST') {
      attempts.push({
        body: route.request().postData() ?? '',
        idempotencyKey:
          route.request().headers()['idempotency-key'] ?? 'missing',
      });
      if (attempts.length === 1) {
        await route.abort('connectionreset');
        return;
      }
      if (attempts.length === 2) {
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
  expect(attempts).toHaveLength(1);

  await page.evaluate(() => {
    const pendingPrefix = 'psd-eoc:event-type-admin:pending:v1:';
    const draftPrefix = 'psd-eoc:event-type-admin:draft:v1:';
    const pendingKey = Object.keys(sessionStorage).find((key) =>
      key.startsWith(pendingPrefix),
    );
    if (pendingKey === undefined) {
      throw new Error('Expected a retained pending command.');
    }
    sessionStorage.setItem(
      `${draftPrefix}${pendingKey.slice(pendingPrefix.length)}`,
      '{damaged-draft-record',
    );
  });

  await page.reload();
  const recovery = page.getByRole('button', {
    name: 'Retry exact draft save',
  });
  await expect(recovery).toBeVisible();
  await expect(
    page.getByRole('alert').filter({
      has: page.getByRole('heading', {
        name: 'Previous change needs explicit recovery',
      }),
    }),
  ).toBeFocused();
  await expect(
    page.getByText('It will never replay automatically.'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Browser recovery needs manual verification',
    }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'No new request was sent during restoration.',
  );
  await page.waitForTimeout(500);
  expect(attempts).toHaveLength(1);

  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('psd-eoc:event-type-admin:draft:v1:')) {
        sessionStorage.removeItem(key);
      }
    }
  });

  await recovery.click();
  await expect(
    page.getByRole('heading', { name: 'Previous change not recovered' }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(
    page.getByRole('button', { name: 'Retry exact draft save' }),
  ).toHaveCount(0);

  await page.reload();
  await page.waitForTimeout(500);
  expect(attempts).toHaveLength(2);
  await expect(
    page.getByRole('button', { name: 'Retry exact draft save' }),
  ).toHaveCount(0);
});

test('a damaged pending record blocks publication after a valid draft restore', async ({
  page,
}) => {
  await openAsSyntheticAdministrator(page);
  let postCount = 0;
  await page.route('**/event-types/api', async (route) => {
    if (route.request().method() === 'POST') {
      postCount += 1;
    }
    await route.continue();
  });

  await page
    .getByLabel('Description')
    .fill('Synthetic damaged-pending recovery gate check.');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  const publish = page.getByRole('button', { name: 'Publish new version' });
  await expect(publish).toBeEnabled();
  expect(postCount).toBe(1);

  await page.evaluate(() => {
    const pendingPrefix = 'psd-eoc:event-type-admin:pending:v1:';
    const draftPrefix = 'psd-eoc:event-type-admin:draft:v1:';
    const draftKey = Object.keys(sessionStorage).find((key) =>
      key.startsWith(draftPrefix),
    );
    if (draftKey === undefined) {
      throw new Error('Expected a retained draft record.');
    }
    sessionStorage.setItem(
      `${pendingPrefix}${draftKey.slice(draftPrefix.length)}`,
      '{damaged-pending-record',
    );
  });

  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Browser recovery needs manual verification',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Activation preview', exact: true }),
  ).toBeVisible();
  await expect(publish).toBeDisabled();
  await page.waitForTimeout(500);
  expect(postCount).toBe(1);

  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('psd-eoc:event-type-admin:')) {
        sessionStorage.removeItem(key);
      }
    }
  });
});

test('a response lost after commit retries the exact idempotent command only on explicit request', async ({
  page,
}) => {
  await openAsSyntheticAdministrator(page);
  const attempts: Array<Readonly<{ body: string; idempotencyKey: string }>> =
    [];
  await page.route('**/event-types/api', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    attempts.push({
      body: route.request().postData() ?? '',
      idempotencyKey: route.request().headers()['idempotency-key'] ?? 'missing',
    });
    if (attempts.length === 1) {
      const committedResponse = await route.fetch();
      expect(committedResponse.ok()).toBe(true);
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });

  await page
    .getByLabel('Description')
    .fill('Synthetic post-commit response-loss check.');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  await expect(page.getByRole('status')).toContainText(
    'The outcome is unresolved.',
  );
  expect(attempts).toHaveLength(1);

  await page.reload();
  const recovery = page.getByRole('button', {
    name: 'Retry exact draft save',
  });
  await expect(recovery).toBeVisible();
  await page.waitForTimeout(500);
  expect(attempts).toHaveLength(1);
  await recovery.click();
  await expect(
    page.getByText(
      'Draft saved and retained for recovery. Review every renderer-produced channel below before publishing.',
    ),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});

test('a confirmed save never reports failure when browser cleanup throws', async ({
  page,
}) => {
  await openAsSyntheticAdministrator(page);
  await page.evaluate(() => {
    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function removeItem(key: string): void {
      if (key.includes('event-type-admin:pending')) {
        throw new DOMException('Synthetic storage cleanup failure.');
      }
      originalRemoveItem.call(this, key);
    };
  });

  await page
    .getByLabel('Description')
    .fill('Synthetic confirmed-save storage failure check.');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Draft saved; browser recovery needs attention',
    }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'The server confirmed the draft save.',
  );
  await expect(
    page.getByRole('heading', { name: 'Draft not saved' }),
  ).toHaveCount(0);
});

test('a confirmed publication clears previews and never reports failure when browser cleanup throws', async ({
  page,
}) => {
  await openAsSyntheticAdministrator(page);
  await page
    .getByLabel('Description')
    .fill('Synthetic confirmed-publication storage failure check.');
  await page.getByRole('button', { name: 'Save draft and preview' }).click();
  const publish = page.getByRole('button', { name: 'Publish new version' });
  await expect(publish).toBeEnabled();

  await page.evaluate(() => {
    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function removeItem(key: string): void {
      if (key.includes('event-type-admin:draft')) {
        throw new DOMException('Synthetic storage cleanup failure.');
      }
      originalRemoveItem.call(this, key);
    };
  });
  await publish.click();

  await expect(
    page.getByRole('heading', {
      name: 'Version published; browser recovery needs attention',
    }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'The server confirmed publication.',
  );
  await expect(
    page.getByRole('heading', { name: 'Version not published' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Activation preview', exact: true }),
  ).toHaveCount(0);
});
