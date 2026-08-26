import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
  chromium,
  expect,
  request,
  type Locator,
  type Page,
} from '@playwright/test';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for remote drill E2E.`);
  return value;
}

const baseUrl = new URL(requiredEnvironment('FAILURE_DRILL_APP_URL')).origin;
const operatorToken = requiredEnvironment('FAILURE_DRILL_OPERATOR_TOKEN');
const recoveredUpdate =
  'Synthetic deployed recovery update retained during the simulated outage.';
const evidenceDirectory = resolve(
  requiredEnvironment('FAILURE_DRILL_EVIDENCE_DIRECTORY'),
);
await mkdir(evidenceDirectory, { recursive: true });

async function focusWithKeyboard(page: Page, target: Locator): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  for (let press = 0; press < 80; press += 1) {
    await page.keyboard.press('Tab');
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
  }
  throw new Error('Keyboard traversal did not reach the all-clear control.');
}

async function axeViolations(page: Page): Promise<readonly unknown[]> {
  const require = createRequire(import.meta.url);
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    const axe = Reflect.get(window, 'axe') as {
      run(): Promise<Readonly<{ violations: readonly unknown[] }>>;
    };
    return (await axe.run()).violations;
  });
}

const api = await request.newContext({ baseURL: baseUrl });
const sessionResponse = await api.post('/api/failure-drills/session', {
  headers: { Authorization: `Bearer ${operatorToken}` },
});
if (sessionResponse.status() !== 201) {
  throw new Error(
    `Synthetic session setup returned ${String(sessionResponse.status())}.`,
  );
}
const setup = (await sessionResponse.json()) as Readonly<{
  applicationOrigin?: unknown;
  eventPath?: unknown;
}>;
if (
  typeof setup.applicationOrigin !== 'string' ||
  setup.applicationOrigin !== baseUrl ||
  typeof setup.eventPath !== 'string' ||
  !/^\/events\/[0-9a-f-]{36}$/u.test(setup.eventPath)
) {
  throw new Error('Synthetic session setup returned an invalid event path.');
}
const setCookies = sessionResponse
  .headersArray()
  .filter(({ name }) => name.toLowerCase() === 'set-cookie')
  .map(({ value }) => value.split(';', 1)[0] ?? '')
  .map((pair) => {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw new Error('Synthetic session cookie is invalid.');
    return {
      name: pair.slice(0, separator),
      value: decodeURIComponent(pair.slice(separator + 1)),
      url: baseUrl,
    };
  });
if (setCookies.length !== 2) {
  throw new Error('Synthetic session setup must issue exactly two cookies.');
}
await api.dispose();

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addCookies(setCookies);
  const page = await context.newPage();
  let failNextTimelineRead = false;
  let failedReadObserved = false;
  await page.route(`**${setup.eventPath}/api?*`, async (route) => {
    if (route.request().method() === 'GET' && failNextTimelineRead) {
      failNextTimelineRead = false;
      failedReadObserved = true;
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(new URL(setup.eventPath, baseUrl).toString());
  await expect(
    page.getByText('DRILL — TRAINING ONLY', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Connected' }),
  ).toBeVisible({ timeout: 45_000 });
  failNextTimelineRead = true;
  await expect
    .poll(() => failedReadObserved, {
      message: 'The deployed timeline did not issue the injected failed read.',
      timeout: 30_000,
    })
    .toBe(true);
  await expect(
    page.getByRole('status').filter({ hasText: /Reconnecting|Offline/u }),
  ).toBeVisible({ timeout: 20_000 });

  const collaboratorPage = await context.newPage();
  try {
    await collaboratorPage.goto(new URL(setup.eventPath, baseUrl).toString());
    await collaboratorPage.getByLabel('Update text').fill(recoveredUpdate);
    const [postResponse] = await Promise.all([
      collaboratorPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `${setup.eventPath}/api`,
      ),
      collaboratorPage.getByRole('button', { name: 'Post update' }).click(),
    ]);
    if (!postResponse.ok()) {
      throw new Error('The deployed synthetic collaborator update failed.');
    }
    await expect(collaboratorPage.getByText(recoveredUpdate)).toBeVisible();
  } finally {
    await collaboratorPage.close();
  }
  await page.bringToFront();
  await expect(page.getByText(recoveredUpdate)).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    page.getByRole('status').filter({ hasText: 'Connected' }),
  ).toBeVisible({ timeout: 45_000 });
  const allClearButton = page.getByRole('button', {
    name: 'Review all-clear',
  });
  await expect(allClearButton).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review event close' }),
  ).toHaveCount(0);
  await focusWithKeyboard(page, allClearButton);
  await expect(allClearButton).toBeFocused();

  const desktopViolations = await axeViolations(page);
  if (desktopViolations.length > 0) {
    throw new Error('The deployed synthetic recovery page failed axe.');
  }
  await page.screenshot({
    fullPage: true,
    path: resolve(evidenceDirectory, 'deployed-recovery-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText('DRILL — TRAINING ONLY', { exact: true }),
  ).toBeVisible();
  await focusWithKeyboard(page, allClearButton);
  await expect(allClearButton).toBeFocused();
  const mobileViolations = await axeViolations(page);
  if (mobileViolations.length > 0) {
    throw new Error('The mobile deployed synthetic recovery page failed axe.');
  }
  await page.screenshot({
    fullPage: true,
    path: resolve(evidenceDirectory, 'deployed-recovery-mobile-390.png'),
  });
  await writeFile(
    resolve(evidenceDirectory, 'browser-evidence.json'),
    `${JSON.stringify(
      {
        accessibilityViolations: { desktop: 0, mobile: 0 },
        allClearKeyboardReachableWithoutActivation: {
          desktop: true,
          mobile: true,
        },
        deploymentClass: 'non-production',
        eventPath: setup.eventPath,
        providerMode: 'mocked',
        recoveredAppend: recoveredUpdate,
        recoveredFromLostTimelineRead: true,
        rosterPopulation: 'synthetic',
        viewports: ['1440x1000', '390x844'],
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await context.close();
} finally {
  await browser.close();
}
