import { expect, test } from '@playwright/test';

test('mocked Google IdP signs in a configured access-group member', async ({
  context,
  page,
}) => {
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in to PSD EOC' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic Google sign-in' }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Continue as access-group member' })
    .click();

  await expect(page).toHaveURL(/\/signed-in$/u);
  await expect(
    page.getByRole('heading', { name: 'Return to PSD EOC' }),
  ).toBeVisible();
  const sessionCookie = (await context.cookies()).find(
    (cookie) => cookie.name === '__Host-psd-eoc-session',
  );
  expect(sessionCookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
  expect(sessionCookie?.value.length).toBeGreaterThanOrEqual(64);
});

test('public completion page does not claim an unauthenticated session', async ({
  page,
}) => {
  await page.goto('/signed-in');
  await expect(
    page.getByRole('heading', { name: 'Return to PSD EOC' }),
  ).toBeVisible();
  await expect(page.getByText('Your PSD EOC session is ready.')).toHaveCount(0);
  await expect(page.getByText('Sign-in complete')).toHaveCount(0);
});

test('mocked Google IdP denies a known non-member without a session', async ({
  context,
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.getByRole('link', { name: 'Continue as non-member' }).click();

  await expect(page).toHaveURL(/\/denied\?reason=access$/u);
  await expect(
    page.getByRole('heading', { name: 'Access not granted' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'not currently in a PSD EOC access group',
  );
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === '__Host-psd-eoc-session',
    ),
  ).toBe(false);
});
