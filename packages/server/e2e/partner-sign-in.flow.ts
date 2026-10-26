import { expect, test } from '@playwright/test';

import { syntheticPartnerOtpCode } from '../lib/auth/partner-otp';
import { expectAxeClean, issue593EvidencePath } from './support';

/**
 * Issue #593: a partner signs in on the web with an emailed one-time
 * password, lands on the events list, and signs out again.
 *
 * The partner identity provider is the synthetic stand-in, so no pool is
 * contacted and no mail is sent: the code is derived from the address exactly
 * as the provider derives it, which is what a partner would read in their
 * email. Everything after the code — the admission check, the session, its
 * one-day lifetime, and the cookie — is the production path unchanged.
 */

const PARTNER_EMAIL = 'sign-me-in@agency.example.invalid';
const UNKNOWN_EMAIL = 'nobody@agency.example.invalid';

test.describe('partner-sign-in', () => {
  // A partner arrives with no session at all.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('partner signs in with an emailed code, then signs out', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Partner agency sign-in' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Partner agency sign-in' }),
    ).toBeVisible({ timeout: 30_000 });
    await expectAxeClean(page);
    await page.screenshot({
      path: issue593EvidencePath('partner-sign-in-email.png'),
      fullPage: true,
    });

    await page.getByLabel('Your agency email address').fill(PARTNER_EMAIL);
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'a sign-in code is on its way',
    );
    await expectAxeClean(page);
    await page.screenshot({
      path: issue593EvidencePath('partner-sign-in-code.png'),
      fullPage: true,
    });

    await page
      .getByLabel('Sign-in code from your email')
      .fill(syntheticPartnerOtpCode(PARTNER_EMAIL));
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Signed in: the partner lands in the application and the navigation
    // shows the one role a partner ever holds.
    await expect(page.getByText(PARTNER_EMAIL)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('partner', { exact: true })).toBeVisible();
    await page.screenshot({
      path: issue593EvidencePath('partner-signed-in.png'),
      fullPage: true,
    });

    // The session cookie never outlives one day.
    const sessionCookie = (await page.context().cookies()).find((cookie) =>
      cookie.name.endsWith('psd-eoc-session'),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.expires).toBeGreaterThan(Date.now() / 1_000);
    expect(sessionCookie?.expires).toBeLessThanOrEqual(
      Date.now() / 1_000 + 24 * 60 * 60 + 60,
    );

    // Signing out is a POST that revokes server-side: the credential is dead
    // even though the browser is handed back its own cookie jar.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sign in to PSD EOC' }),
    ).toBeVisible({ timeout: 30_000 });
    const afterSignOut = (await page.context().cookies()).find((cookie) =>
      cookie.name.endsWith('psd-eoc-session'),
    );
    expect(afterSignOut?.value ?? '').toBe('');
  });

  test('an address with no admission gets one generic refusal', async ({
    page,
  }) => {
    await page.goto('/partner-sign-in');
    await page.getByLabel('Your agency email address').fill(UNKNOWN_EMAIL);
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    // Step one says the same thing for every address, so it answers no
    // question about who has partner access.
    await expect(page.getByRole('alert')).toContainText(
      'a sign-in code is on its way',
    );

    await page
      .getByLabel('Sign-in code from your email')
      .fill(syntheticPartnerOtpCode(UNKNOWN_EMAIL));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'That sign-in could not be completed',
    );
    await expect(page.getByText(UNKNOWN_EMAIL)).toHaveCount(0);
    await expectAxeClean(page);
    await page.screenshot({
      path: issue593EvidencePath('partner-sign-in-refused.png'),
      fullPage: true,
    });
  });

  test('a wrong code is refused and issues no session', async ({ page }) => {
    await page.goto('/partner-sign-in');
    await page.getByLabel('Your agency email address').fill(PARTNER_EMAIL);
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('Sign-in code from your email').fill('000000');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'That sign-in could not be completed',
    );
    const session = (await page.context().cookies()).find((cookie) =>
      cookie.name.endsWith('psd-eoc-session'),
    );
    expect(session?.value ?? '').toBe('');
  });
});
