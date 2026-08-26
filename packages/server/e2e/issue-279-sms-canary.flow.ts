import { expect, test } from '@playwright/test';

import { expectAxeClean, issue279EvidencePath } from './support';

test.describe('issue 279 controlled SMS canary', () => {
  test('offers one approved SMS endpoint without starting a request', async ({
    page,
  }) => {
    const mutationRequests: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') mutationRequests.push(request.url());
    });

    await page.goto('/delivery-tests');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Monthly live delivery test',
      }),
    ).toBeVisible();
    const targetMode = page.getByLabel('Target mode');
    await expect(targetMode).toBeVisible();
    await targetMode.selectOption('controlled-sms-canary');
    await expect(targetMode).toHaveValue('controlled-sms-canary');
    await expect(
      targetMode.locator('option[value="controlled-sms-canary"]'),
    ).toHaveText('One approved SMS endpoint');
    expect(mutationRequests).toEqual([]);
    await expectAxeClean(page);
    await page.screenshot({
      path: issue279EvidencePath('controlled-sms-canary.png'),
      fullPage: true,
    });
  });
});
