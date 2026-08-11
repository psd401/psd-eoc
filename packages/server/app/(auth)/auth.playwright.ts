import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

const AXE_VERSION = '4.10.3';
const AXE_URL = `https://cdn.jsdelivr.net/npm/axe-core@${AXE_VERSION}/axe.min.js`;
const AXE_SHA256 =
  '880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb';
const RETURN_TO_COOKIE_NAME = '__Host-psd-eoc-return-to';

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly Readonly<{
    readonly target: readonly string[];
    readonly failureSummary?: string;
  }>[];
}

let axeSourcePromise: Promise<string> | null = null;

async function loadVerifiedAxeSource(): Promise<string> {
  axeSourcePromise ??= (async () => {
    const response = await fetch(AXE_URL, {
      headers: { Accept: 'application/javascript' },
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(
        `Pinned axe-core ${AXE_VERSION} download failed with HTTP ${response.status}.`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualDigest = createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== AXE_SHA256) {
      throw new Error(
        `Pinned axe-core ${AXE_VERSION} failed SHA-256 verification.`,
      );
    }
    return bytes.toString('utf8');
  })();
  return axeSourcePromise;
}

async function expectAxeClean(page: Page, context: string): Promise<void> {
  await page.addScriptTag({ content: await loadVerifiedAxeSource() });
  const violations = await page.evaluate(async () => {
    const axeWindow = window as unknown as {
      axe: {
        run(
          root: Document,
          options: Readonly<{
            runOnly: Readonly<{ type: 'tag'; values: readonly string[] }>;
          }>,
        ): Promise<{ violations: AxeViolation[] }>;
      };
    };
    const result = await axeWindow.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: [
          'wcag2a',
          'wcag2aa',
          'wcag21a',
          'wcag21aa',
          'wcag22a',
          'wcag22aa',
        ],
      },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary,
      })),
    }));
  });
  expect(
    violations,
    `${context} must have no axe WCAG 2.2 A/AA violations: ${JSON.stringify(violations)}`,
  ).toEqual([]);
}

test('auth pages expose landmarks, alerts, and keyboard-operable navigation', async ({
  page,
}) => {
  for (const path of ['/login', '/denied?reason=access', '/signed-in']) {
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectAxeClean(page, path);
  }

  await page.goto('/login');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  await page.keyboard.press('Tab');
  const signInLink = page.getByRole('link', { name: 'Continue with Google' });
  await expect(signInLink).toBeFocused();
  const actionSize = await signInLink.boundingBox();
  expect(actionSize?.height).toBeGreaterThanOrEqual(44);

  await page.goto('/denied?reason=access');
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'not currently in a PSD EOC access group',
  );

  await page.goto('/signed-in');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const dashboardLink = page.getByRole('link', { name: 'Open dashboard' });
  await expect(dashboardLink).toBeFocused();
  expect((await dashboardLink.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  );
});

test('mocked Google IdP returns a member to the exact pathname and query', async ({
  context,
  page,
}) => {
  const returnTo =
    '/start?facility=synthetic-harbor%20school&mode=real&next=%2Fevents%2Factive';
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await expect(
    page.getByRole('heading', { name: 'Sign in to PSD EOC' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic Google sign-in' }),
  ).toBeVisible();
  const authorizationUrl = new URL(page.url());
  expect(authorizationUrl.searchParams.has('returnTo')).toBe(false);
  expect(authorizationUrl.toString()).not.toContain('synthetic-harbor');
  expect(
    await page.evaluate(
      (cookieName) => document.cookie.includes(cookieName),
      RETURN_TO_COOKIE_NAME,
    ),
  ).toBe(false);

  const inFlightReturnCookie = (await context.cookies()).find(
    (cookie) => cookie.name === RETURN_TO_COOKIE_NAME,
  );
  expect(inFlightReturnCookie).toMatchObject({
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
  const [callbackResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/auth/callback' && response.status() === 303;
    }),
    page.getByRole('link', { name: 'Continue as access-group member' }).click(),
  ]);
  const callbackLocation = callbackResponse.headers()['location'];
  expect(callbackLocation).toBeDefined();
  const returnedUrl = new URL(callbackLocation ?? '/', callbackResponse.url());
  expect(`${returnedUrl.pathname}${returnedUrl.search}`).toBe(returnTo);
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === RETURN_TO_COOKIE_NAME)).toBe(
    false,
  );
  const sessionCookie = cookies.find(
    (cookie) => cookie.name === '__Host-psd-eoc-session',
  );
  expect(sessionCookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
  expect(sessionCookie?.value.length).toBeGreaterThanOrEqual(64);
  const csrfCookie = cookies.find(
    (cookie) => cookie.name === '__Host-psd-eoc-csrf',
  );
  expect(csrfCookie).toMatchObject({
    httpOnly: false,
    secure: true,
    sameSite: 'Strict',
  });
  expect(csrfCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
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
  await expect(
    page.getByRole('link', { name: 'Open dashboard' }),
  ).toHaveAttribute('href', '/');
});

test('mocked Google IdP denies a known non-member without a session', async ({
  context,
  page,
}) => {
  await page.goto('/login?returnTo=%2Fstart%3Fmode%3Ddrill');
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
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === RETURN_TO_COOKIE_NAME,
    ),
  ).toBe(false);
});

test('external and tampered return destinations fail closed to the dashboard', async ({
  context,
  page,
}) => {
  await page.goto(
    `/login?returnTo=${encodeURIComponent('https://example.invalid/phish')}`,
  );
  const appOrigin = new URL(page.url()).origin;
  await expect(
    page.getByRole('link', { name: 'Continue with Google' }),
  ).toHaveAttribute('href', '/auth/sign-in?returnTo=%2F');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page
    .getByRole('link', { name: 'Continue as access-group member' })
    .click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).origin).toBe(appOrigin);

  await context.clearCookies();
  await page.goto('/login?returnTo=%2Fstart%3Fmode%3Dreal');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  const returnCookie = (await context.cookies()).find(
    (cookie) => cookie.name === RETURN_TO_COOKIE_NAME,
  );
  expect(returnCookie).toBeDefined();
  if (returnCookie === undefined) {
    throw new Error('The return destination cookie was not issued.');
  }
  await context.addCookies([
    {
      ...returnCookie,
      value: `${returnCookie.value.slice(0, -1)}${returnCookie.value.endsWith('A') ? 'B' : 'A'}`,
    },
  ]);
  await page
    .getByRole('link', { name: 'Continue as access-group member' })
    .click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === RETURN_TO_COOKIE_NAME,
    ),
  ).toBe(false);
});
