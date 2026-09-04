import { expect, test } from '@playwright/test';

test.describe('public privacy policy', () => {
  test('stays anonymous and keyboard-operable at the public route', async ({
    page,
  }) => {
    await page.context().clearCookies();

    const response = await page.goto('/privacy');

    expect(response?.status()).toBe(200);
    expect(response?.request().redirectedFrom()).toBeNull();
    expect(response?.headers()['set-cookie']).toBeUndefined();
    await expect(page).toHaveURL(/\/privacy$/u);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Privacy policy' }),
    ).toBeVisible();
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);

    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('link', {
        name: 'Contact Synthetic Example School District',
      }),
    ).toBeFocused();
  });

  test('states the messaging disclosures a carrier registration requires', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/privacy');

    // A toll-free review reads this public page and rejects a program whose
    // policy omits any of these. They are asserted separately so a deletion
    // names the sentence it removed rather than failing one opaque snapshot.
    await expect(
      page.getByRole('heading', { name: 'Mobile numbers and text messages' }),
    ).toBeVisible();
    for (const statement of [
      /Giving a number is voluntary/u,
      /the exact wording the person agreed to/u,
      /never used for marketing/u,
      /not sold, rented, or shared with third parties or affiliates/u,
      /replying STOP to any message/u,
    ]) {
      await expect(page.getByText(statement)).toHaveCount(1);
    }
  });
});
