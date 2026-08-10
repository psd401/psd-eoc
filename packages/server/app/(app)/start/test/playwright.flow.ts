import {
  CreateActivationPreviewInputSchema,
  JoinEventInputSchema,
  StartEventInputSchema,
  type CreateActivationPreviewInput,
} from '@psd-eoc/contracts';
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';

import { assertAxeClean, installAxe } from './axe-playwright';
import {
  PLAYWRIGHT_IDS,
  activeEventFixture,
  activationPreviewFixture,
  activationResultFixture,
  interceptedActivationError,
  joinEventResultFixture,
} from './playwright.fixtures';

const SYNTHETIC_FACILITY = 'Synthetic North Campus';
const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';

interface PreviewInterception {
  readonly activationRequests: () => number;
  readonly previewRequests: readonly CreateActivationPreviewInput[];
}

async function installPreviewInterception(
  page: Page,
  input: Readonly<{
    activeEventIds?: readonly string[];
    activationOutcome?: 'fail-closed' | 'success';
    mismatchedFacility?: boolean;
    simulatedReadyStaff?: boolean;
  }> = {},
): Promise<PreviewInterception> {
  const previewRequests: CreateActivationPreviewInput[] = [];
  let latestPreview: ReturnType<typeof activationPreviewFixture> | undefined;
  let activationRequestCount = 0;

  await page.route('**/start/api/preview', async (route) => {
    const selection = CreateActivationPreviewInputSchema.parse(
      route.request().postDataJSON(),
    );
    previewRequests.push(selection);
    const preview = activationPreviewFixture(selection, input);
    latestPreview = preview;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'x-psd-eoc-browser-fixture':
          'simulated-only-does-not-prove-live-integration',
      },
      body: JSON.stringify(preview),
    });
  });
  await page.route('**/start/api/activate', async (route) => {
    activationRequestCount += 1;
    StartEventInputSchema.parse(route.request().postDataJSON());
    const idempotencyKey = route.request().headers()['idempotency-key'];
    expect(idempotencyKey).toMatch(/^activate:/u);
    if (input.activationOutcome === 'success') {
      if (latestPreview === undefined || idempotencyKey === undefined) {
        throw new Error(
          'Activation was submitted before a valid intercepted preview.',
        );
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'x-psd-eoc-browser-fixture':
            'simulated-only-does-not-prove-live-integration',
        },
        body: JSON.stringify(
          activationResultFixture(latestPreview, idempotencyKey),
        ),
      });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify(interceptedActivationError()),
    });
  });

  return {
    activationRequests: () => activationRequestCount,
    previewRequests,
  };
}

async function expectEmergencyAffordance(page: Page): Promise<void> {
  const emergency = page.getByRole('complementary', {
    name: 'Emergency assistance',
  });
  await expect(emergency).toContainText(
    'PSD EOC notifies staff; it does not contact 911.',
  );
  const call911 = emergency.getByRole('link', { name: 'Call 911' });
  await expect(call911).toHaveAttribute('href', 'tel:911');
  const target = await call911.boundingBox();
  expect(target?.height).toBeGreaterThanOrEqual(44);
}

async function expectPreviewCounts(
  page: Page,
  mode: 'real' | 'drill',
): Promise<void> {
  await expect(
    page.getByRole('heading', {
      name: 'Notification audience and eligible endpoints',
    }),
  ).toBeVisible();
  await expect(
    page.getByText('4 selected staff recipients', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(PLAYWRIGHT_IDS.rosterSnapshot)).toBeVisible();

  const expectedChannels = [
    [
      'Push notifications',
      '4 active endpoints',
      'No provider can receive this browser fixture.',
    ],
    [
      'Email',
      '3 active endpoints',
      'No provider can receive this browser fixture.',
    ],
    ['Text messages', '2 active endpoints', 'Synthetic browser preview only.'],
  ] as const;
  for (const [name, count, message] of expectedChannels) {
    const card = page.locator('.channel-card').filter({
      has: page.getByRole('heading', { name }),
    });
    await expect(card).toContainText(count);
    await expect(
      card.getByRole('heading', { name: 'Exact message preview' }),
    ).toBeVisible();
    await expect(card).toContainText(
      `[${mode === 'real' ? 'INCIDENT' : 'DRILL'}]`,
    );
    await expect(card).toContainText(message);
  }
  await expect(
    page.getByText(
      'Counts describe eligible endpoints, not confirmed human receipt.',
    ),
  ).toBeVisible();
}

async function activateByKeyboard(page: Page, target: Locator): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard focus did not reach the expected control.');
}

async function fulfillSyntheticJoin(
  route: Route,
  selection: CreateActivationPreviewInput,
): Promise<void> {
  const input = JoinEventInputSchema.parse(route.request().postDataJSON());
  expect(input.eventId).toBe(PLAYWRIGHT_IDS.activeEvent);
  expect(route.request().headers()['idempotency-key']).toMatch(/^join:/u);
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(
      joinEventResultFixture(selection, PLAYWRIGHT_IDS.activeEvent),
    ),
  });
}

test.beforeEach(async ({ context }) => {
  await installAxe(context);
});

test('unauthenticated deep links preserve each exact validated start-flow return target', async ({
  context,
  page,
}) => {
  const targets = [
    {
      heading: 'Choose event type',
      target: `/start?facilityId=${SYNTHETIC_FACILITY_ID}&mode=real`,
    },
    {
      heading: 'Review and confirm',
      target: `/start/confirm?facilityId=${SYNTHETIC_FACILITY_ID}&mode=drill&eventTypeVersionId=${SYNTHETIC_DRILL_VERSION_ID}`,
    },
  ] as const;

  for (const { heading, target } of targets) {
    await context.clearCookies();
    await page.goto(target);
    const login = new URL(page.url());
    expect(login.pathname).toBe('/login');
    expect([...login.searchParams.keys()]).toEqual(['reason', 'returnTo']);
    expect(login.searchParams.getAll('reason')).toEqual(['session-required']);
    expect(login.searchParams.getAll('returnTo')).toEqual([target]);
    await assertAxeClean(page, `${target} login redirect`);

    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await expect(
      page.getByRole('heading', { name: 'Synthetic Google sign-in' }),
    ).toBeVisible();
    await page
      .getByRole('link', { name: 'Continue as access-group member' })
      .click();

    await expect
      .poll(
        () => `${new URL(page.url()).pathname}${new URL(page.url()).search}`,
      )
      .toBe(target);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await assertAxeClean(page, `${target} after Google OIDC`);
  }
});

test('dashboard exposes unmistakable choices, 911, skip navigation, and AA-clean semantics', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Active events' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: SYNTHETIC_FACILITY }),
  ).toBeVisible();
  await expectEmergencyAffordance(page);

  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  const realChoice = page
    .getByRole('link', { name: /Start REAL incident/u })
    .first();
  const drillChoice = page.getByRole('link', { name: /Run DRILL/u }).first();
  await expect(realChoice.locator('svg.classification-icon')).toHaveCount(1);
  await expect(drillChoice.locator('svg.classification-icon')).toHaveCount(1);
  const [realBackground, drillBackground] = await Promise.all([
    realChoice.evaluate((element) => getComputedStyle(element).backgroundColor),
    drillChoice.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ]);
  expect(realBackground).not.toBe(drillBackground);
  await assertAxeClean(page, 'active-events dashboard');
});

test('real incident path reaches a current, fail-closed consequence preview in two clicks', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page);
  let interactionCount = 0;
  await page.goto('/');

  await page
    .getByRole('link', { name: /Start REAL incident/u })
    .first()
    .click();
  interactionCount += 1;
  await expect(page).toHaveURL(/\/start\?.*mode=real/u);
  const selectionBanner = page.getByRole('region', {
    name: 'REAL INCIDENT classification',
  });
  await expect(selectionBanner).toContainText('REAL INCIDENT');
  await expect(selectionBanner.locator('svg.classification-icon')).toHaveCount(
    1,
  );
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    '2. Choose event type',
  );
  await expectEmergencyAffordance(page);
  const [realModeBackground, drillModeBackground] = await Promise.all([
    page
      .locator('.mode-switch__real')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    page
      .locator('.mode-switch__drill')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(realModeBackground).not.toBe(drillModeBackground);
  await assertAxeClean(page, 'real incident type selection');

  await page
    .getByRole('link', { name: /^Lockdown/u })
    .first()
    .click();
  interactionCount += 1;
  await expect(page).toHaveURL(/\/start\/confirm\?/u);
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    '3. Review and confirm',
  );
  const confirmBanner = page.getByRole('region', {
    name: 'REAL INCIDENT classification',
  });
  await expect(confirmBanner).toContainText('REAL INCIDENT');
  await expect(confirmBanner.locator('svg.classification-icon')).toHaveCount(1);
  await expectPreviewCounts(page, 'real');
  await expect(page.getByText('Configured, not verified')).toHaveCount(3);
  await expect(
    page.getByRole('heading', { name: 'Notifications are not ready' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Start REAL incident/u }),
  ).toHaveCount(0);
  expect(interactionCount).toBeLessThanOrEqual(3);
  expect(intercepted.previewRequests.length).toBeGreaterThanOrEqual(1);
  expect(intercepted.previewRequests.length).toBeLessThanOrEqual(2);
  for (const previewRequest of intercepted.previewRequests) {
    expect(previewRequest).toMatchObject({
      kind: 'incident',
      templateMode: 'real',
      rosterPopulation: 'staff',
    });
  }
  expect(intercepted.activationRequests()).toBe(0);
  await assertAxeClean(page, 'blocked real incident confirmation');
});

test('simulated staff drill submit is keyboard-only, three interactions, and intercepted before any provider', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    simulatedReadyStaff: true,
  });
  let interactionCount = 0;
  await page.goto('/');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await activateByKeyboard(
    page,
    page.getByRole('link', { name: /Run DRILL/u }).first(),
  );
  interactionCount += 1;
  await expect(page).toHaveURL(/\/start\?.*mode=drill/u);
  const selectionBanner = page.getByRole('region', {
    name: 'DRILL — TRAINING ONLY classification',
  });
  await expect(selectionBanner).toContainText('DRILL — TRAINING ONLY');
  await expect(selectionBanner.locator('svg.classification-icon')).toHaveCount(
    1,
  );
  await assertAxeClean(page, 'drill type selection');

  await activateByKeyboard(
    page,
    page.getByRole('link', { name: /^Lockdown Drill/u }).first(),
  );
  interactionCount += 1;
  await expect(page).toHaveURL(/\/start\/confirm\?/u);
  await expectPreviewCounts(page, 'drill');
  // This label is contract-valid simulated response data. The activation
  // request below is intercepted in the browser and proves no integration.
  await expect(page.getByText('Live integration verified')).toHaveCount(3);
  const submit = page.getByRole('button', {
    name: 'Start DRILL and create notification intents for 4 selected staff recipients',
    exact: true,
  });
  const submitTarget = await submit.boundingBox();
  expect(submitTarget?.height).toBeGreaterThanOrEqual(44);
  await assertAxeClean(page, 'simulated ready staff drill confirmation');

  await activateByKeyboard(page, submit);
  interactionCount += 1;
  const rejected = page.locator('section.error-summary[role="alert"]').filter({
    has: page.getByRole('heading', { name: 'Request not accepted' }),
  });
  await expect(rejected).toBeFocused();
  await expect(rejected).toContainText(
    'Synthetic browser interception stopped here; no event or notification was created.',
  );
  expect(interactionCount).toBe(3);
  expect(intercepted.activationRequests()).toBe(1);
  await page.waitForTimeout(250);
  expect(intercepted.activationRequests()).toBe(1);
  await assertAxeClean(page, 'intercepted simulated staff drill result');
});

for (const scenario of [
  {
    mode: 'real' as const,
    choice: /Start REAL incident/u,
    eventType: /^Lockdown/u,
    submit:
      'Start REAL incident and create notification intents for 4 selected staff recipients',
    heading: 'Incident started',
    classification: 'REAL INCIDENT',
    status:
      'PSD EOC durably accepted the incident and recorded its notification intent.',
  },
  {
    mode: 'drill' as const,
    choice: /Run DRILL/u,
    eventType: /^Lockdown Drill/u,
    submit:
      'Start DRILL and create notification intents for 4 selected staff recipients',
    heading: 'Drill started',
    classification: 'DRILL — TRAINING ONLY',
    status:
      'PSD EOC durably accepted the drill and recorded its notification intent.',
  },
] as const) {
  test(`schema-valid intercepted ${scenario.mode} activation renders an unmistakable success result`, async ({
    page,
  }) => {
    const intercepted = await installPreviewInterception(page, {
      activationOutcome: 'success',
      simulatedReadyStaff: true,
    });
    await page.goto('/');
    await page.getByRole('link', { name: scenario.choice }).first().click();
    await page.getByRole('link', { name: scenario.eventType }).first().click();
    await page.getByRole('button', { name: scenario.submit }).click();

    const result = page.locator('section.result-panel').filter({
      has: page.getByRole('heading', { name: scenario.heading }),
    });
    await expect(result).toBeFocused();
    const classification = page.getByRole('region', {
      name: `${scenario.classification} classification`,
    });
    await expect(classification).toContainText(scenario.classification);
    await expect(classification.locator('svg.classification-icon')).toHaveCount(
      1,
    );
    await expect(result.getByRole('status')).toHaveText(scenario.status);
    await expect(result).toContainText(
      'Provider acceptance and human receipt are tracked separately',
    );
    expect(intercepted.activationRequests()).toBe(1);
    await page.waitForTimeout(250);
    expect(intercepted.activationRequests()).toBe(1);
    await assertAxeClean(
      page,
      `intercepted ${scenario.mode} activation result`,
    );
  });
}

test('a mismatched preview is rejected before consequences or activation are offered', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    mismatchedFacility: true,
  });
  await page.goto('/');
  await page
    .getByRole('link', { name: /Start REAL incident/u })
    .first()
    .click();
  await page
    .getByRole('link', { name: /^Lockdown/u })
    .first()
    .click();

  const error = page.locator('section.error-summary[role="alert"]').filter({
    has: page.getByRole('heading', {
      name: 'Consequence preview unavailable',
    }),
  });
  await expect(
    error.getByRole('heading', { name: 'Consequence preview unavailable' }),
  ).toBeVisible();
  await expect(error).toContainText(
    'The server returned a consequence preview for a different event selection.',
  );
  await expect(
    page.getByRole('heading', {
      name: 'Notification audience and eligible endpoints',
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Start REAL incident/u }),
  ).toHaveCount(0);
  expect(intercepted.activationRequests()).toBe(0);
  await assertAxeClean(page, 'mismatched consequence preview rejection');
});

test('unknown active-event details fail closed before join or start is offered', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    activeEventIds: [PLAYWRIGHT_IDS.activeEvent],
    simulatedReadyStaff: true,
  });
  await page.route(
    `**/api/events/${PLAYWRIGHT_IDS.activeEvent}`,
    async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'NOT_FOUND',
          message: 'Synthetic active-event details are unavailable.',
          requestId: PLAYWRIGHT_IDS.request,
          retryable: false,
          fieldErrors: [],
        }),
      });
    },
  );

  await page.goto('/');
  await page
    .getByRole('link', { name: /Start REAL incident/u })
    .first()
    .click();
  await page
    .getByRole('link', { name: /^Lockdown/u })
    .first()
    .click();

  const error = page.locator('section.error-summary[role="alert"]').filter({
    has: page.getByRole('heading', {
      name: 'Consequence preview unavailable',
    }),
  });
  await expect(error).toContainText(
    'PSD EOC could not verify an existing active event',
  );
  await expect(
    page.getByRole('region', { name: 'An event is already active here' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Start REAL incident/u }),
  ).toHaveCount(0);
  expect(intercepted.activationRequests()).toBe(0);
  await assertAxeClean(page, 'unknown active-event fail-closed state');
});

test('join-existing shows the actual cross-classification event and never invokes activation', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    activeEventIds: [PLAYWRIGHT_IDS.activeEvent],
  });
  let interactionCount = 0;
  let joinRequests = 0;
  let selection: CreateActivationPreviewInput | undefined;
  await page.route('**/start/api/join', async (route) => {
    joinRequests += 1;
    selection = intercepted.previewRequests.at(-1);
    if (selection === undefined) {
      throw new Error('Join was requested before a consequence preview.');
    }
    await fulfillSyntheticJoin(route, selection);
  });
  await page.route(
    `**/api/events/${PLAYWRIGHT_IDS.activeEvent}`,
    async (route) => {
      const currentSelection = intercepted.previewRequests.at(-1);
      if (currentSelection === undefined) {
        throw new Error('Active event was read before a consequence preview.');
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          activeEventFixture(currentSelection, PLAYWRIGHT_IDS.activeEvent),
        ),
      });
    },
  );

  await page.goto('/');
  await page
    .getByRole('link', { name: /Start REAL incident/u })
    .first()
    .click();
  interactionCount += 1;
  await page
    .getByRole('link', { name: /^Lockdown/u })
    .first()
    .click();
  interactionCount += 1;
  await expectPreviewCounts(page, 'real');
  const chooser = page.getByRole('region', {
    name: 'An event is already active here',
  });
  await expect(chooser).toContainText(
    'join an existing event, or start a separate event',
  );
  await assertAxeClean(page, 'join-or-start choice');

  await chooser
    .getByRole('button', {
      name: 'Join Drill — DRILL — TRAINING ONLY',
    })
    .click();
  interactionCount += 1;
  const joined = page.locator('section.result-panel').filter({
    has: page.getByRole('heading', { name: 'Event joined' }),
  });
  await expect(joined).toBeFocused();
  await expect(page.getByRole('status')).toContainText(
    'Joining did not create another event or notification.',
  );
  await expect(
    page.getByRole('region', {
      name: 'DRILL — TRAINING ONLY classification',
    }),
  ).toContainText('actual classification of the event you joined');
  await expect(
    page.getByRole('region', { name: 'REAL INCIDENT classification' }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Provider acceptance and human receipt'),
  ).toBeVisible();
  expect(interactionCount).toBe(3);
  expect(joinRequests).toBe(1);
  expect(intercepted.activationRequests()).toBe(0);
  await assertAxeClean(page, 'synthetic join result');
});
