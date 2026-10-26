import { expect, test } from '@playwright/test';

import { expectAxeClean, issue597EvidencePath, statePath } from './support';

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
    await expect(row).toContainText('Not signed up');
    await expectAxeClean(page);
  });

  test('a partner who replied STOP shows as opted out of texts', async ({
    page,
  }) => {
    await page.goto('/access');
    const section = page.getByRole('region', { name: 'Partners' });
    const row = section.getByRole('row', {
      name: /Synthetic Joining Responder/u,
    });
    await expect(row).toContainText('Opted out — replied STOP', {
      timeout: 30_000,
    });
    await expectAxeClean(page);
    await section.screenshot({
      path: issue597EvidencePath('partner-access-text-alerts.png'),
    });
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

  test('expired partner is refused', async ({ browser, page }) => {
    const partnerContext = await browser.newContext({
      storageState: statePath('partner-expired.json'),
    });
    try {
      // The session itself is current; the admission behind it expired five
      // days ago and no sweep has run. The very first request is refused.
      const partnerPage = await partnerContext.newPage();
      // A lapsed authorization is refused as forbidden (a revoked session
      // would be unauthenticated): the session exists, its admission does not.
      const response = await partnerPage.request.get('/api/sms-consent');
      expect(response.status()).toBe(403);
    } finally {
      await partnerContext.close();
    }
    await page.goto('/access');
    await expect(
      page
        .getByRole('region', { name: 'Partners' })
        .getByRole('row', { name: /Synthetic Expired Responder/u }),
    ).toContainText('Expired');
  });

  test('admin renews partner', async ({ browser, page }) => {
    const partnerContext = await browser.newContext({
      storageState: statePath('partner-renew.json'),
    });
    try {
      const partnerPage = await partnerContext.newPage();
      expect((await partnerPage.request.get('/api/sms-consent')).status()).toBe(
        200,
      );

      await page.goto('/access');
      await page
        .getByRole('button', {
          name: 'Renew renew-me@agency.example.invalid for one year',
        })
        .click();
      await expect(page.getByRole('status')).toContainText(
        'The partner was renewed for one year from today.',
      );
      const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000)
        .toISOString()
        .slice(0, 7);
      const rows = page
        .getByRole('region', { name: 'Partners' })
        .getByRole('row', { name: /Synthetic Renewing Responder/u });
      // The new admission, expiring a year from today, and the replaced one.
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText(nextYear);
      await expect(rows.nth(1)).toContainText('Replaced');
      await expectAxeClean(page);

      // Renewal keeps the partner's open session working.
      expect((await partnerPage.request.get('/api/sms-consent')).status()).toBe(
        200,
      );
    } finally {
      await partnerContext.close();
    }
  });
});
