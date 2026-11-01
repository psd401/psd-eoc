import { expect, test, type Page } from '@playwright/test';

import { syntheticPartnerOtpCode } from '../lib/auth/partner-otp';
import { expectAxeClean, issue599EvidencePath } from './support';

/**
 * Issue #599: a partner enrolls a passkey after a code sign-in, and the next
 * sign-in uses the passkey instead of an inbox.
 *
 * The authenticator is Chromium's virtual authenticator, driven over the
 * DevTools protocol, so the WebAuthn ceremony is the browser's real
 * implementation: the page calls `navigator.credentials`, the browser refuses
 * any relying party that is not the page's own origin, and the client data it
 * signs over carries the origin and the challenge. What the virtual
 * authenticator stands in for is the hardware, not the protocol.
 *
 * The identity provider is the synthetic stand-in, so no pool is contacted.
 * It checks the ceremony type, the origin, the challenge it issued, and that
 * the credential is one it registered for this address; it does not verify
 * the authenticator's signature, which is what the real pool is for. Every
 * step after the factor — the admission check, the session, its one-day
 * ceiling, and the audit — is the production path unchanged.
 */

const PARTNER_EMAIL = 'passkey-me@agency.example.invalid';
/**
 * The no-script flow signs in with a code too, and the stand-in derives its
 * claims digest from the address, so a second code sign-in by one address is
 * refused as a replay. Each code sign-in therefore needs its own address.
 */
const NO_SCRIPT_EMAIL = 'passkey-no-script@agency.example.invalid';

/**
 * Adds a platform authenticator that is always present and always verified,
 * so the flow never waits on a biometric prompt no test can satisfy.
 */
async function addVirtualAuthenticator(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('WebAuthn.enable', { enableUI: false });
  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function signInWithCode(
  page: Page,
  email = PARTNER_EMAIL,
): Promise<void> {
  await page.goto('/partner-sign-in');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Partner agency sign-in' }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Your agency email address').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('p.form-message[role="alert"]')).toContainText(
    'a sign-in code is on its way',
    { timeout: 30_000 },
  );
  await page
    .getByLabel('Sign-in code from your email')
    .fill(syntheticPartnerOtpCode(email));
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page): Promise<void> {
  const signInHeading = page.getByRole('heading', {
    level: 1,
    name: 'Sign in to PSD EOC',
  });
  // Sign out is a client button: a click that lands before the dev server has
  // hydrated it does nothing, so retry the click until it navigates.
  await expect(async () => {
    if (await signInHeading.isVisible()) {
      return;
    }
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(signInHeading).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

test.describe('partner-passkey', () => {
  // A partner arrives with no session at all.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a partner enrolls a passkey, then signs in with it', async ({
    page,
  }) => {
    await addVirtualAuthenticator(page);

    // A first sign-in still needs the emailed code: there is no passkey yet.
    await signInWithCode(page);

    // The code sign-in lands on the offer, not straight in the application.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up a passkey' }),
    ).toBeVisible({ timeout: 30_000 });
    await expectAxeClean(page);
    await page.screenshot({
      path: issue599EvidencePath('partner-passkey-offer.png'),
      fullPage: true,
    });

    await page.getByRole('button', { name: 'Set up a passkey' }).click();
    await expect(page.getByTestId('passkey-outcome')).toContainText(
      'Passkey saved',
      { timeout: 30_000 },
    );
    await expectAxeClean(page);
    await page.screenshot({
      path: issue599EvidencePath('partner-passkey-registered.png'),
      fullPage: true,
    });

    // The offer is not a gate: the partner was already signed in.
    await page.getByRole('link', { name: 'Continue' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Active events' }),
    ).toBeVisible({ timeout: 30_000 });

    await signOut(page);

    // Now the passkey: the same address, and no code is ever asked for.
    await page.goto('/partner-sign-in');
    await page.getByLabel('Your agency email address').fill(PARTNER_EMAIL);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Signed in with the passkey alone. The code form never appears.
    await expect(page.getByText(PARTNER_EMAIL)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('partner', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Sign-in code from your email')).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Active events' }),
    ).toBeVisible();
    await page.screenshot({
      path: issue599EvidencePath('partner-passkey-signed-in.png'),
      fullPage: true,
    });

    // A passkey session is a partner session: at most one day, exactly as a
    // code session is, and never longer because the factor was stronger.
    const sessionCookie = (await page.context().cookies()).find((cookie) =>
      cookie.name.endsWith('psd-eoc-session'),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.expires).toBeGreaterThan(Date.now() / 1_000);
    expect(sessionCookie?.expires).toBeLessThanOrEqual(
      Date.now() / 1_000 + 24 * 60 * 60 + 60,
    );
  });

  test('an address with no passkey is asked for a code, never refused', async ({
    page,
  }) => {
    await addVirtualAuthenticator(page);
    // This address holds no passkey, and the browser holds no credential for
    // it. The first step answers "use a code" rather than refusing, so it
    // says nothing about whether the address has partner access.
    await page.goto('/partner-sign-in');
    await page
      .getByLabel('Your agency email address')
      .fill('nobody@agency.example.invalid');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('p.form-message[role="alert"]')).toContainText(
      'a sign-in code is on its way',
      { timeout: 30_000 },
    );
    await expect(page.getByLabel('Sign-in code from your email')).toBeVisible();
    await page.screenshot({
      path: issue599EvidencePath('partner-passkey-falls-back-to-code.png'),
      fullPage: true,
    });
  });

  test.describe('with no script at all', () => {
    // The emailed code is the path that needs no script, and it has to keep
    // working: a partner whose browser blocks scripts, or whose device has no
    // authenticator, must still be able to sign in to an emergency tool.
    test.use({
      storageState: { cookies: [], origins: [] },
      javaScriptEnabled: false,
    });

    test('a partner signs in with a code and is told no passkey is possible', async ({
      page,
    }) => {
      await signInWithCode(page, NO_SCRIPT_EMAIL);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Set up a passkey' }),
      ).toBeVisible({ timeout: 30_000 });
      // Rendered on the server, where there is no `window` to ask: the offer
      // says plainly that this browser cannot store one rather than showing a
      // button that could never work.
      await expect(page.getByTestId('passkey-outcome')).toContainText(
        'cannot store a passkey',
      );
      await page.screenshot({
        path: issue599EvidencePath('partner-passkey-no-script.png'),
        fullPage: true,
      });
      // And the session is real: the offer led into the application.
      await page.getByRole('link', { name: 'Continue' }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Active events' }),
      ).toBeVisible({ timeout: 30_000 });
    });
  });
});
