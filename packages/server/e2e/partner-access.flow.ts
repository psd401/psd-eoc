import { expect, test } from '@playwright/test';

import { expectAxeClean, statePath } from './support';

/**
 * Issue #595: an administrator manages partners from the Access page. The
 * partner identity provider and mailer are the synthetic stand-ins, so
 * nothing leaves the machine.
 */
test.describe('partner-access', () => {
  test('admin invites partner → partner listed as invited', async ({
    page,
  }) => {
    await page.goto('/access');
    const section = page.getByRole('region', { name: 'Partners' });
    await expect(
      page.getByRole('heading', { level: 2, name: 'Partners' }),
    ).toBeVisible({ timeout: 30_000 });

    const invite = page.getByRole('group', { name: 'Invite a partner' });
    await invite
      .getByLabel('Email address')
      .fill('new-responder@agency.example.invalid');
    await invite.getByLabel('Name').fill('Synthetic New Responder');
    await invite.getByLabel('Agency').fill('Synthetic Police Department');
    await invite.getByRole('button', { name: 'Invite partner' }).click();

    await expect(page.getByRole('status')).toContainText(
      'The partner was invited.',
    );
    const row = section.getByRole('row', {
      name: /Synthetic New Responder/u,
    });
    await expect(row).toContainText('Invited — has not signed in');
    await expect(row).toContainText('new-responder@agency.example.invalid');
    await expect(row).toContainText('In sync');
    await expectAxeClean(page);
  });

  test('admin disables partner → partner session refused', async ({
    page,
    browser,
  }) => {
    const partnerContext = await browser.newContext({
      storageState: statePath('partner.json'),
    });
    try {
      const partnerPage = await partnerContext.newPage();
      // Signed in: the partner's session is accepted before the disable.
      const before = await partnerPage.request.get('/api/sms-consent');
      expect(before.status()).toBe(200);

      await page.goto('/access');
      await page
        .getByRole('button', {
          name: 'Disable disable-me@agency.example.invalid',
        })
        .click();
      await expect(page.getByRole('status')).toContainText(
        'The partner was disabled.',
      );
      await expect(
        page
          .getByRole('region', { name: 'Partners' })
          .getByRole('row', { name: /Synthetic Disabled Responder/u }),
      ).toContainText('Disabled');

      // The very next request with the partner's session is refused.
      const after = await partnerPage.request.get('/api/sms-consent');
      expect(after.status()).toBe(401);
    } finally {
      await partnerContext.close();
    }
  });
});
