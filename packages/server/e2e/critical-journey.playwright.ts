import {
  CreateActivationPreviewInputSchema,
  StartEventInputSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type StartEventResult,
} from '@psd-eoc/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import {
  AXE_CORE_VERSION,
  assertAxeClean,
  installAxe,
} from '../app/(app)/start/test/axe-playwright';
import {
  StartFlowPlaywrightFixtureSchema,
  activationPreviewFixture,
  activationResultFixture,
  type StartFlowPlaywrightFixture,
} from '../app/(app)/start/test/playwright.fixtures';
import { startFlowPlaywrightPaths } from '../app/(app)/start/test/playwright-run';

let fixture: StartFlowPlaywrightFixture;

async function assertAxeZeroViolations(
  page: Page,
  stateLabel: string,
): Promise<void> {
  const result = await page.evaluate(async (expectedVersion) => {
    const axe = Reflect.get(globalThis, 'axe') as
      | Readonly<{
          version: string;
          run(
            root: Document,
            options: Readonly<{
              runOnly: Readonly<{
                type: 'tag';
                values: readonly string[];
              }>;
            }>,
          ): Promise<
            Readonly<{
              violations: readonly Readonly<{
                id: string;
                impact: string | null;
                help: string;
                nodes: readonly Readonly<{
                  target: readonly unknown[];
                  failureSummary?: string;
                }>[];
              }>[];
            }>
          >;
        }>
      | undefined;
    if (axe === undefined || axe.version !== expectedVersion) {
      throw new Error('The pinned axe browser engine is unavailable.');
    }
    const findings = await axe.run(document, {
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
    return { version: axe.version, violations: findings.violations };
  }, AXE_CORE_VERSION);
  expect(result.version).toBe(AXE_CORE_VERSION);
  expect(
    result.violations,
    `${stateLabel} axe violations: ${JSON.stringify(result.violations)}`,
  ).toEqual([]);
}

async function activateByKeyboard(page: Page, target: Locator): Promise<void> {
  await focusByKeyboard(page, target);
  await page.keyboard.press('Enter');
}

async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  // Give streamed server components and their client bundle an explicit,
  // bounded opportunity to settle before the tab-order proof begins. Without
  // this guard a cold CI render can consume the whole test timeout inside the
  // locator lookup and obscure which control was unavailable.
  await expect(target).toBeVisible({ timeout: 60_000 });
  for (let index = 0; index < 100; index += 1) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard focus did not reach the expected control.');
}

function remapActivationToSeededSyntheticEvent(
  result: StartEventResult,
  eventId: string,
): StartEventResult {
  const transition = { ...result.transition, eventId };
  return StartEventResultSchema.parse({
    ...result,
    event: { ...result.event, id: eventId },
    transition,
    journalEntries: result.journalEntries.map((entry) => ({
      ...entry,
      eventId,
      payload:
        entry.kind === 'system' && entry.payload.code === 'event-activated'
          ? { ...entry.payload, transition }
          : entry.payload,
    })),
    notificationIntent:
      result.notificationIntent === null
        ? null
        : { ...result.notificationIntent, eventId },
  });
}

async function installSyntheticActivationBridge(
  page: Page,
): Promise<Readonly<{ activationRequests: () => number }>> {
  let preview: ActivationPreview | null = null;
  let activationRequestCount = 0;

  await page.route('**/start/api/preview', async (route) => {
    const selection = CreateActivationPreviewInputSchema.parse(
      route.request().postDataJSON(),
    );
    preview = activationPreviewFixture(selection, {
      simulatedReadyStaff: true,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'x-psd-eoc-browser-fixture':
          'synthetic-only-does-not-prove-live-integration',
      },
      body: JSON.stringify(preview),
    });
  });

  await page.route('**/start/api/activate', async (route) => {
    activationRequestCount += 1;
    StartEventInputSchema.parse(route.request().postDataJSON());
    const idempotencyKey = route.request().headers()['idempotency-key'];
    if (preview === null || idempotencyKey === undefined) {
      throw new Error('Activation arrived without its synthetic preview.');
    }
    const seededEvent = fixture.activeEvents[0];
    if (seededEvent === undefined) {
      throw new Error('The seeded synthetic event is unavailable.');
    }
    const result = remapActivationToSeededSyntheticEvent(
      activationResultFixture(preview, idempotencyKey),
      seededEvent.id,
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'x-psd-eoc-browser-fixture':
          'synthetic-only-does-not-prove-live-integration',
      },
      body: JSON.stringify(result),
    });
  });

  return { activationRequests: () => activationRequestCount };
}

async function startDrillSelection(page: Page): Promise<void> {
  await page.goto('/');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await activateByKeyboard(
    page,
    page.getByRole('link', {
      name: 'Run DRILL at Synthetic North Campus',
      exact: true,
    }),
  );
  await expect(page).toHaveURL(/\/start\?.*mode=drill/u, { timeout: 60_000 });
}

async function warmCriticalRoutes(
  request: Readonly<{
    get(url: string): Promise<Readonly<{ ok(): boolean }>>;
  }>,
): Promise<void> {
  const seededEvent = fixture.activeEvents[0];
  if (seededEvent === undefined) {
    throw new Error('The seeded synthetic event is unavailable.');
  }
  const urls = [
    '/start?facilityId=00000000-0000-4000-8000-000000000001&mode=drill',
    '/start/confirm?facilityId=00000000-0000-4000-8000-000000000001&mode=drill&eventTypeVersionId=00000000-0000-4000-8000-000000000201',
    `/events/${seededEvent.id}`,
  ];
  for (const url of urls) {
    const response = await request.get(url);
    expect(response.ok(), `Critical route warm-up failed for ${url}.`).toBe(
      true,
    );
  }
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(360_000);
  fixture = StartFlowPlaywrightFixtureSchema.parse(
    JSON.parse(
      await readFile(startFlowPlaywrightPaths().fixture, 'utf8'),
    ) as unknown,
  );
  // The event-room client bundle is intentionally substantial. Compile each
  // dynamic critical route once in this separately bounded worker hook so a
  // cold CI machine cannot consume the keyboard journey's interaction budget.
  await warmCriticalRoutes(request);
});

test.beforeEach(async ({ context }) => {
  await installAxe(context);
});

test('keyboard-only synthetic activation continues through event-room all-clear', async ({
  page,
}) => {
  const bridge = await installSyntheticActivationBridge(page);
  await startDrillSelection(page);
  await assertAxeClean(page, 'keyboard drill type selection');

  await activateByKeyboard(
    page,
    page.getByRole('link', { name: /^Lockdown Drill/u }).first(),
  );
  await expect(page).toHaveURL(/\/start\/confirm\?/u);
  await assertAxeClean(page, 'keyboard drill consequence confirmation');

  const submit = page.getByRole('button', {
    name: 'Start DRILL and create notification intents for 4 selected staff recipients',
    exact: true,
  });
  await activateByKeyboard(page, submit);
  await expect(
    page.getByRole('heading', { name: 'Drill started' }),
  ).toBeVisible();
  expect(bridge.activationRequests()).toBe(1);
  await assertAxeClean(page, 'keyboard drill activation result');

  await activateByKeyboard(
    page,
    page.getByRole('link', { name: 'Open event' }),
  );
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]+$/u);
  await expect(page.locator('.event-status')).toHaveText('Active');
  await assertAxeZeroViolations(page, 'keyboard-opened active drill room');

  const update = page.getByLabel('Update text');
  await focusByKeyboard(page, update);
  await page.keyboard.insertText('Synthetic keyboard-only E2E update.');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Post update' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Synthetic keyboard-only E2E update.', { exact: true }),
  ).toBeVisible();
  await assertAxeZeroViolations(page, 'keyboard-posted drill room');
  const notificationIntents = page.getByText(
    'Notification fan-out intent recorded.',
    { exact: true },
  );
  await expect(notificationIntents).toHaveCount(1);

  const reviewAllClear = page.getByRole('button', {
    name: 'Review all-clear',
  });
  await expect(reviewAllClear).toBeEnabled();
  await activateByKeyboard(page, reviewAllClear);
  await expect(
    page.getByRole('heading', { name: 'Review and issue all-clear' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Notification consequences' }),
  ).toBeVisible({ timeout: 20_000 });
  const confirmation = page.getByLabel('Type ALL CLEAR exactly');
  await focusByKeyboard(page, confirmation);
  await assertAxeZeroViolations(page, 'keyboard all-clear consequence dialog');
  await page.keyboard.insertText('ALL CLEAR');
  const issueAllClear = page.getByRole('button', {
    name: 'Issue all-clear and notify',
  });
  await expect(issueAllClear).toBeEnabled();
  await activateByKeyboard(page, issueAllClear);
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  await expect(notificationIntents).toHaveCount(2);
  await assertAxeZeroViolations(page, 'keyboard-completed all-clear room');
});

test('activation remains operable in forced colors and at an explicit 200 percent page zoom', async ({
  page,
}) => {
  await installSyntheticActivationBridge(page);
  await startDrillSelection(page);

  await page.addInitScript(() => {
    const applyZoom = () => {
      document.documentElement.style.zoom = '2';
    };
    if (document.documentElement === null) {
      document.addEventListener('DOMContentLoaded', applyZoom, { once: true });
    } else {
      applyZoom();
    }
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await page.setViewportSize({ width: 640, height: 720 });

  await page.emulateMedia({ forcedColors: 'active' });

  const classification = page.getByRole('region', {
    name: 'DRILL — TRAINING ONLY classification',
  });
  await expect(classification).toBeVisible();
  await expect(classification.locator('svg.classification-icon')).toBeVisible();
  await expect(
    page.getByRole('link', { name: /^Lockdown Drill/u }).first(),
  ).toBeVisible();

  // Assert both an explicit two-times page zoom and the 640 CSS-pixel reflow
  // space exposed by a 1280-pixel desktop viewport at 200%. Keeping the checks
  // independent prevents this from silently regressing into viewport-only
  // evidence.
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        zoom: getComputedStyle(document.documentElement).zoom,
      })),
    )
    .toEqual({
      clientWidth: 640,
      innerWidth: 640,
      scrollWidth: 640,
      zoom: '2',
    });
  await activateByKeyboard(
    page,
    page.getByRole('link', { name: /^Lockdown Drill/u }).first(),
  );
  await expect(page).toHaveURL(/\/start\/confirm\?/u);
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        zoom: getComputedStyle(document.documentElement).zoom,
      })),
    )
    .toEqual({
      clientWidth: 640,
      innerWidth: 640,
      scrollWidth: 640,
      zoom: '2',
    });
  const submit = page.getByRole('button', {
    name: /Start DRILL and create notification intents/u,
  });
  await expect(submit).toBeVisible();
  await activateByKeyboard(page, submit);
  await expect(
    page.getByRole('heading', { name: 'Drill started' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', {
      name: 'DRILL — TRAINING ONLY classification',
    }),
  ).toBeVisible();
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1';
  });
  await assertAxeClean(page, '200-percent drill activation result');
});
