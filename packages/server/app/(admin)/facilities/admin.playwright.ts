import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const BUNDLED_AXE_PATH = fileURLToPath(
  new URL(
    '../../(app)/events/[id]/axe-core-4.10.3.min.js.txt',
    import.meta.url,
  ),
);

const ADMIN_PAGES = Object.freeze([
  {
    path: '/facilities',
    heading: 'Facilities, neighborhoods, and audiences',
  },
  {
    path: '/access',
    heading: 'Access groups and administrator roles',
  },
  {
    path: '/integrations',
    heading: 'Integrations administration',
  },
]);

async function openAdminPage(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(page).toHaveURL(new RegExp(`${path}$`, 'u'));
  await expect(
    page.getByRole('heading', { level: 1, name: heading }),
  ).toBeVisible();
}

for (const adminPage of ADMIN_PAGES) {
  test(`${adminPage.path} is keyboard and screen-reader structured`, async ({
    page,
  }) => {
    await openAdminPage(page, adminPage.path, adminPage.heading);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(
      page.getByRole('navigation', { name: 'Administration' }),
    ).toBeVisible();

    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();

    const main = page.getByRole('main');
    for (const control of await main
      .locator(
        'button, input:not([type="hidden"]):not([type="checkbox"]), select, summary',
      )
      .all()) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    for (const checkbox of await main.locator('input[type="checkbox"]').all()) {
      if (!(await checkbox.isVisible())) continue;
      const box = await checkbox.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(24);
      expect(box?.width).toBeGreaterThanOrEqual(24);
    }
  });
}

test('test mode is unmistakable and SMS cannot be enabled in the browser', async ({
  page,
}) => {
  await openAdminPage(page, '/integrations', 'Integrations administration');
  await expect(
    page.getByRole('heading', {
      level: 2,
      name: 'TEST — SYNTHETIC RECIPIENTS ONLY — NO REAL NOTIFICATIONS',
    }),
  ).toBeVisible();

  const smsRow = page
    .getByRole('table', {
      name: 'Administrative channel enablement and truth',
    })
    .getByRole('row')
    .filter({
      has: page.getByRole('button', { name: 'Save aws-eum-sms state' }),
    });
  await expect(smsRow).toBeVisible();
  await expect(smsRow.locator('option[value="true"]')).toHaveAttribute(
    'disabled',
    '',
  );
  await expect(smsRow).toContainText('blocked');
});

test('all issue #26 admin pages are axe clean', async ({ page }) => {
  const axePath = process.env.PSD_EOC_AXE_PATH ?? BUNDLED_AXE_PATH;

  for (const adminPage of ADMIN_PAGES) {
    await openAdminPage(page, adminPage.path, adminPage.heading);
    await page.addScriptTag({ path: axePath });
    const violations = await page.evaluate(async () => {
      const axe = Reflect.get(globalThis, 'axe') as
        | {
            run(
              context: Document,
              options: Readonly<Record<string, unknown>>,
            ): Promise<{
              violations: readonly {
                id: string;
                impact: string | null;
                nodes: readonly { target: readonly string[] }[];
              }[];
            }>;
          }
        | undefined;
      if (axe === undefined) throw new Error('axe did not load.');
      const result = await axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
        },
      });
      return result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.flatMap((node) => node.target),
      }));
    });
    expect(violations, `${adminPage.path} axe violations`).toEqual([]);
  }
});
