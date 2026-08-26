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
});
