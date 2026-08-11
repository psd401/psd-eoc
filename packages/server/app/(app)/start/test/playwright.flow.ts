import {
  ActivationPreviewSchema,
  CreateActivationPreviewInputSchema,
  EventSchema,
  JoinEventInputSchema,
  JoinEventResultSchema,
  StartEventInputSchema,
  type ActivationPreview,
  type CreateActivationPreviewInput,
  type Event,
} from '@psd-eoc/contracts';
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { count, eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabase,
} from '../../../../db/client';
import {
  activationPreviews,
  events,
  notificationIntents,
  outbox,
  rosterSnapshots,
} from '../../../../db/schema';

import { assertAxeClean, installAxe } from './axe-playwright';
import { startFlowPlaywrightDatabaseUrl } from './playwright-database';
import {
  PLAYWRIGHT_IDS,
  activationPreviewFixture,
  activationResultFixture,
  interceptedActivationError,
  interruptedActivationError,
  joinEventResultFixture,
} from './playwright.fixtures';
import {
  START_FLOW_STAFF_AUDIENCE_ID,
  START_FLOW_STAFF_AUDIENCE_VERSION,
  START_FLOW_STAFF_ROSTER_VERSION,
} from './playwright.global-setup';

const SYNTHETIC_FACILITY = 'Synthetic North Campus';
const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_SOUTH_FACILITY = 'Synthetic South Campus';
const SYNTHETIC_REAL_VERSION_ID = '00000000-0000-4000-8000-000000000200';
const SYNTHETIC_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const FIRST_ACTIVE_EVENT_TIME = '2026-08-10T18:00:00.000Z';
const SECOND_ACTIVE_EVENT_TIME = '2026-08-10T18:05:00.000Z';

const ACTIVE_EVENT_NAMES = Object.freeze({
  first: Object.freeze({
    confirmation:
      'Join Lockdown Drill — DRILL — TRAINING ONLY Started Aug 10, 2026, 11:00 AM — event 00000001',
    dashboard:
      'Join DRILL — TRAINING ONLY — Lockdown Drill at Synthetic North Campus — started Aug 10, 2026, 11:00 AM — event 00000001',
  }),
  second: Object.freeze({
    confirmation:
      'Join Lockdown Drill — DRILL — TRAINING ONLY Started Aug 10, 2026, 11:05 AM — event 00000016',
    dashboard:
      'Join DRILL — TRAINING ONLY — Lockdown Drill at Synthetic North Campus — started Aug 10, 2026, 11:05 AM — event 00000016',
  }),
});

const REAL_CONFIRMATION_PATH = `/start/confirm?facilityId=${SYNTHETIC_FACILITY_ID}&mode=real&eventTypeVersionId=${SYNTHETIC_REAL_VERSION_ID}`;

interface PreviewInterception {
  readonly allowPreviewSuccess: () => void;
  readonly activationIdempotencyKeys: readonly string[];
  readonly activationRequests: () => number;
  readonly previewRequests: readonly CreateActivationPreviewInput[];
}

async function installPreviewInterception(
  page: Page,
  input: Readonly<{
    activeEventIds?: readonly string[];
    activationDelayMs?: number;
    activationOutcome?: 'ambiguous' | 'fail-closed' | 'success';
    holdPreviewFailure?: boolean;
    includeSms?: boolean;
    mismatchedActivationIdempotencyKey?: boolean;
    mismatchedFacility?: boolean;
    previewDelayMs?: number;
    simulatedReadyStaff?: boolean;
  }> = {},
): Promise<PreviewInterception> {
  const previewRequests: CreateActivationPreviewInput[] = [];
  let latestPreview: ReturnType<typeof activationPreviewFixture> | undefined;
  let activationRequestCount = 0;
  const activationIdempotencyKeys: string[] = [];
  let previewSuccessAllowed = input.holdPreviewFailure !== true;

  await page.route('**/start/api/preview', async (route) => {
    const selection = CreateActivationPreviewInputSchema.parse(
      route.request().postDataJSON(),
    );
    previewRequests.push(selection);
    if (input.previewDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, input.previewDelayMs));
    }
    if (!previewSuccessAllowed) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'LIVE_ACTION_UNAVAILABLE',
          message: 'Synthetic consequence preview is temporarily unavailable.',
          requestId: PLAYWRIGHT_IDS.request,
          retryable: true,
          fieldErrors: [],
        }),
      });
      return;
    }
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
    if (idempotencyKey !== undefined) {
      activationIdempotencyKeys.push(idempotencyKey);
    }
    if (input.activationDelayMs !== undefined) {
      await new Promise((resolve) =>
        setTimeout(resolve, input.activationDelayMs),
      );
    }
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
          activationResultFixture(
            latestPreview,
            input.mismatchedActivationIdempotencyKey === true
              ? 'activate:00000000-0000-4000-8000-000000000999'
              : idempotencyKey,
          ),
        ),
      });
      return;
    }
    if (input.activationOutcome === 'ambiguous') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify(interruptedActivationError()),
      });
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify(interceptedActivationError()),
    });
  });

  return {
    allowPreviewSuccess: () => {
      previewSuccessAllowed = true;
    },
    activationIdempotencyKeys,
    activationRequests: () => activationRequestCount,
    previewRequests,
  };
}

function facilityStartChoice(page: Page, mode: 'drill' | 'real'): Locator {
  return page.getByRole('link', {
    name:
      mode === 'real'
        ? `Start REAL incident at ${SYNTHETIC_FACILITY}`
        : `Run DRILL at ${SYNTHETIC_FACILITY}`,
    exact: true,
  });
}

async function readServerEvent(page: Page, eventId: string): Promise<Event> {
  const response = await page.request.get(`/api/events/${eventId}`);
  expect(response.ok()).toBe(true);
  return EventSchema.parse((await response.json()) as unknown);
}

async function fulfillMatchingJoin(
  route: Route,
  expectedEvent: Event,
): Promise<void> {
  const input = JoinEventInputSchema.parse(route.request().postDataJSON());
  expect(input.eventId).toBe(expectedEvent.id);
  expect(route.request().headers()['idempotency-key']).toMatch(/^join:/u);
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(
      JoinEventResultSchema.parse({
        event: expectedEvent,
        participantId: PLAYWRIGHT_IDS.joinParticipant,
        joined: true,
      }),
    ),
  });
}

async function operationalMutationCounts(database: PostgresDatabase) {
  const [[eventCount], [intentCount], [outboxCount]] = await Promise.all([
    database.select({ value: count() }).from(events),
    database.select({ value: count() }).from(notificationIntents),
    database.select({ value: count() }).from(outbox),
  ]);
  if (
    eventCount === undefined ||
    intentCount === undefined ||
    outboxCount === undefined
  ) {
    throw new Error('Synthetic persistence counts were unavailable.');
  }
  return Object.freeze({
    events: eventCount.value,
    notificationIntents: intentCount.value,
    outboxMessages: outboxCount.value,
  });
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
  await expect(page).toHaveTitle('Active events');
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

  const realChoice = facilityStartChoice(page, 'real');
  const drillChoice = facilityStartChoice(page, 'drill');
  await expect(realChoice).toHaveCount(1);
  await expect(drillChoice).toHaveCount(1);
  await expect(
    page.getByRole('link', {
      name: `Start REAL incident at ${SYNTHETIC_SOUTH_FACILITY}`,
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('link', {
      name: `Run DRILL at ${SYNTHETIC_SOUTH_FACILITY}`,
      exact: true,
    }),
  ).toHaveCount(1);
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

  await facilityStartChoice(page, 'real').click();
  interactionCount += 1;
  await expect(page).toHaveURL(/\/start\?.*mode=real/u);
  await expect(page).toHaveTitle('Choose REAL incident type | PSD EOC');
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
  await expect(page).toHaveTitle('Review REAL incident confirmation | PSD EOC');
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
  await activateByKeyboard(page, facilityStartChoice(page, 'drill'));
  interactionCount += 1;
  await expect(page).toHaveURL(/\/start\?.*mode=drill/u);
  await expect(page).toHaveTitle('Choose DRILL type | PSD EOC');
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
  await expect(page).toHaveTitle('Review DRILL confirmation | PSD EOC');
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
    await facilityStartChoice(page, scenario.mode).click();
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
  await facilityStartChoice(page, 'real').click();
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
    activeEventIds: [PLAYWRIGHT_IDS.activatedEvent],
    simulatedReadyStaff: true,
  });
  await page.route(
    `**/api/events/${PLAYWRIGHT_IDS.activatedEvent}`,
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
  await facilityStartChoice(page, 'real').click();
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
  await page.goto('/');
  const expectedEvent = await readServerEvent(page, PLAYWRIGHT_IDS.activeEvent);
  await page.route('**/start/api/join', async (route) => {
    joinRequests += 1;
    await fulfillMatchingJoin(route, expectedEvent);
  });

  await facilityStartChoice(page, 'real').click();
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
      name: ACTIVE_EVENT_NAMES.first.confirmation,
      exact: true,
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

test('database-backed staff preview pins minimized roster evidence without creating an event or provider work', async ({
  page,
}) => {
  const databaseUrl = startFlowPlaywrightDatabaseUrl();
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: databaseUrl,
    maxConnections: 2,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Start-flow Playwright requires PostgreSQL.');
  }

  try {
    const before = await operationalMutationCounts(connection.db);
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/start/api/preview' &&
        response.request().method() === 'POST'
      );
    });

    await page.goto(REAL_CONFIRMATION_PATH);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const preview = ActivationPreviewSchema.parse(
      (await response.json()) as unknown,
    );

    expect(preview).toMatchObject({
      facilityId: SYNTHETIC_FACILITY_ID,
      kind: 'incident',
      templateMode: 'real',
      eventTypeVersion: {
        id: SYNTHETIC_REAL_VERSION_ID,
        templateMode: 'real',
      },
      rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
      rosterPopulation: 'staff',
      audienceConfig: {
        id: START_FLOW_STAFF_AUDIENCE_ID,
        version: START_FLOW_STAFF_AUDIENCE_VERSION,
      },
      recipientCount: 2,
      sendReadiness: 'blocked',
      activeEventIds: [
        PLAYWRIGHT_IDS.activeEvent,
        PLAYWRIGHT_IDS.activeEventSecond,
      ],
    });
    expect(preview.blockingReasonCodes).toEqual([
      'EMAIL_DISABLED',
      'EMAIL_NOT_LIVE_VERIFIED',
      'PUSH_DISABLED',
      'PUSH_NOT_LIVE_VERIFIED',
    ]);
    expect(preview.channels.map((channel) => channel.channel)).toEqual([
      'push',
      'email',
    ]);
    const channelByName = new Map<
      ActivationPreview['channels'][number]['channel'],
      ActivationPreview['channels'][number]
    >(preview.channels.map((channel) => [channel.channel, channel]));
    expect(channelByName.get('push')).toMatchObject({
      endpointCount: 2,
      integrationStatus: { integrationId: 'expo-push', label: 'mocked' },
      renderedMessage: {
        channel: 'push',
        eventKind: 'incident',
        templateMode: 'real',
        purpose: 'activation',
        classificationMarker: 'INCIDENT',
      },
    });
    expect(channelByName.get('email')).toMatchObject({
      endpointCount: 1,
      integrationStatus: { integrationId: 'ses-email', label: 'mocked' },
      renderedMessage: {
        channel: 'email',
        eventKind: 'incident',
        templateMode: 'real',
        purpose: 'activation',
        classificationMarker: 'INCIDENT',
      },
    });
    for (const channel of preview.channels) {
      const rendered = JSON.stringify(channel.renderedMessage);
      expect(rendered).toContain('REAL INCIDENT');
      expect(rendered).toContain(SYNTHETIC_FACILITY);
      expect(rendered).toContain('once confirmed');
    }
    const minimizedPreview = JSON.stringify(preview);
    expect(minimizedPreview).not.toContain('Synthetic Browser Staff One');
    expect(minimizedPreview).not.toContain('example.invalid');
    expect(minimizedPreview).not.toContain('synthetic-unroutable');

    const [persisted] = await connection.db
      .select({
        id: activationPreviews.id,
        rosterSnapshotId: activationPreviews.rosterSnapshotId,
        rosterPopulation: activationPreviews.rosterPopulation,
        audienceConfigId: activationPreviews.audienceConfigId,
        audienceConfigVersion: activationPreviews.audienceConfigVersion,
        recipientCount: activationPreviews.recipientCount,
        channels: activationPreviews.channels,
        sendReadiness: activationPreviews.sendReadiness,
        blockingReasonCodes: activationPreviews.blockingReasonCodes,
        activeEventIds: activationPreviews.activeEventIds,
        consequenceDigest: activationPreviews.consequenceDigest,
      })
      .from(activationPreviews)
      .where(eq(activationPreviews.id, preview.id))
      .limit(1);
    expect(persisted).toEqual({
      id: preview.id,
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: preview.rosterPopulation,
      audienceConfigId: preview.audienceConfig.id,
      audienceConfigVersion: preview.audienceConfig.version,
      recipientCount: preview.recipientCount,
      channels: preview.channels,
      sendReadiness: preview.sendReadiness,
      blockingReasonCodes: preview.blockingReasonCodes,
      activeEventIds: preview.activeEventIds,
      consequenceDigest: preview.consequenceDigest,
    });
    const [staffSnapshot] = await connection.db
      .select({ version: rosterSnapshots.version })
      .from(rosterSnapshots)
      .where(eq(rosterSnapshots.id, preview.rosterSnapshotId))
      .limit(1);
    expect(staffSnapshot?.version).toBe(START_FLOW_STAFF_ROSTER_VERSION);
    expect(await operationalMutationCounts(connection.db)).toEqual(before);

    await expect(page).toHaveTitle(
      'Review REAL incident confirmation | PSD EOC',
    );
    await expect(
      page.getByRole('status').filter({
        hasText:
          'Consequence preview ready: 2 selected staff recipients, 2 included channel previews, notifications blocked.',
      }),
    ).toBeVisible();
    await expect(
      page.getByText('2 selected staff recipients', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(PLAYWRIGHT_IDS.staffRosterSnapshot),
    ).toBeVisible();
    const pushCard = page.locator('.channel-card').filter({
      has: page.getByRole('heading', { name: 'Push notifications' }),
    });
    const emailCard = page.locator('.channel-card').filter({
      has: page.getByRole('heading', { name: 'Email' }),
    });
    const smsCard = page.locator('.channel-card').filter({
      has: page.getByRole('heading', { name: 'Text messages' }),
    });
    await expect(pushCard).toContainText('2 active endpoints');
    await expect(emailCard).toContainText('1 active endpoint');
    await expect(pushCard).toContainText('Mocked — training data only');
    await expect(emailCard).toContainText('Mocked — training data only');
    await expect(smsCard).toContainText('Not included');
    await expect(smsCard).toContainText(
      'The notification intent will contain no SMS channel',
    );
    await expect(
      page.getByRole('heading', { name: 'Notifications are not ready' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Start REAL incident/u }),
    ).toHaveCount(0);
    await assertAxeClean(page, 'database-backed staff consequence preview');
  } finally {
    await connection.close();
  }
});

test('dashboard gives concurrent same-type events unique names and joins the exact chosen event', async ({
  page,
}) => {
  await page.goto('/');
  const firstJoin = page.getByRole('button', {
    name: ACTIVE_EVENT_NAMES.first.dashboard,
    exact: true,
  });
  const secondJoin = page.getByRole('button', {
    name: ACTIVE_EVENT_NAMES.second.dashboard,
    exact: true,
  });
  await expect(firstJoin).toHaveCount(1);
  await expect(secondJoin).toHaveCount(1);
  await expect(firstJoin.locator('svg.classification-icon')).toHaveCount(1);
  await expect(secondJoin.locator('svg.classification-icon')).toHaveCount(1);

  const expectedEvent = await readServerEvent(page, PLAYWRIGHT_IDS.activeEvent);
  expect(expectedEvent.activatedAt).toBe(FIRST_ACTIVE_EVENT_TIME);
  let joinRequests = 0;
  await page.route('**/start/api/join', async (route) => {
    joinRequests += 1;
    await fulfillMatchingJoin(route, expectedEvent);
  });
  await firstJoin.click();

  const joined = page.getByRole('status').filter({
    hasText: 'DRILL — TRAINING ONLY event joined.',
  });
  await expect(joined).toBeFocused();
  await expect(joined).toContainText('DRILL — TRAINING ONLY event joined.');
  await expect(secondJoin).toBeVisible();
  expect(joinRequests).toBe(1);
  await assertAxeClean(page, 'direct dashboard join result');
});

test('dashboard treats a schema-valid response for different event truth as outcome unknown', async ({
  page,
}) => {
  await page.goto('/');
  const target = page.getByRole('button', {
    name: ACTIVE_EVENT_NAMES.second.dashboard,
    exact: true,
  });
  const prospectiveSelection = CreateActivationPreviewInputSchema.parse({
    facilityId: SYNTHETIC_FACILITY_ID,
    kind: 'incident',
    templateMode: 'real',
    eventTypeVersion: {
      id: SYNTHETIC_REAL_VERSION_ID,
      templateMode: 'real',
    },
    rosterPopulation: 'staff',
  });
  const mismatched = joinEventResultFixture(
    prospectiveSelection,
    PLAYWRIGHT_IDS.activeEventSecond,
    { activatedAt: SECOND_ACTIVE_EVENT_TIME },
  );
  let joinRequests = 0;
  await page.route('**/start/api/join', async (route) => {
    joinRequests += 1;
    const submitted = JoinEventInputSchema.parse(
      route.request().postDataJSON(),
    );
    expect(submitted.eventId).toBe(PLAYWRIGHT_IDS.activeEventSecond);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mismatched),
    });
  });

  await target.click();
  const unresolved = page.getByRole('alert').filter({
    hasText: 'Outcome unknown.',
  });
  await expect(unresolved).toBeFocused();
  await expect(unresolved).toContainText(
    'does not match the active event you chose',
  );
  await expect(target).toBeDisabled();
  await expect(
    page.getByRole('status').filter({ hasText: 'event joined' }),
  ).toHaveCount(0);
  expect(joinRequests).toBe(1);
  await assertAxeClean(page, 'mismatched direct join response');
});

test('confirmation distinguishes concurrent same-type choices by time and event ID', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    activeEventIds: [
      PLAYWRIGHT_IDS.activeEvent,
      PLAYWRIGHT_IDS.activeEventSecond,
    ],
    simulatedReadyStaff: true,
  });
  await page.goto(REAL_CONFIRMATION_PATH);

  const chooser = page.getByRole('region', {
    name: 'An event is already active here',
  });
  await expect(
    chooser.getByRole('button', {
      name: ACTIVE_EVENT_NAMES.first.confirmation,
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    chooser.getByRole('button', {
      name: ACTIVE_EVENT_NAMES.second.confirmation,
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', {
      name: 'Start a separate REAL incident and create notification intents for 4 selected staff recipients',
      exact: true,
    }),
  ).toBeVisible();
  expect(intercepted.activationRequests()).toBe(0);
  await assertAxeClean(page, 'concurrent same-type confirmation controls');
});

test('delayed confirmation join submits once, identifies only that operation, and reuses its key on explicit retry', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    activeEventIds: [
      PLAYWRIGHT_IDS.activeEvent,
      PLAYWRIGHT_IDS.activeEventSecond,
    ],
    simulatedReadyStaff: true,
  });
  await page.goto('/');
  const expectedEvent = await readServerEvent(page, PLAYWRIGHT_IDS.activeEvent);
  let releaseJoin = () => {};
  const joinGate = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  let joinRequests = 0;
  const joinKeys: string[] = [];
  await page.route('**/start/api/join', async (route) => {
    joinRequests += 1;
    const input = JoinEventInputSchema.parse(route.request().postDataJSON());
    expect(input.eventId).toBe(expectedEvent.id);
    const key = route.request().headers()['idempotency-key'];
    expect(key).toMatch(/^join:/u);
    if (key !== undefined) joinKeys.push(key);
    await joinGate;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify(interceptedActivationError()),
    });
  });

  await page.goto(REAL_CONFIRMATION_PATH);
  const chosen = page
    .locator('button.join-choice')
    .filter({ hasText: 'event 00000001' });
  const other = page
    .locator('button.join-choice')
    .filter({ hasText: 'event 00000016' });
  const activate = page.locator('button.button--real');
  await expect(chosen).toHaveAccessibleName(
    ACTIVE_EVENT_NAMES.first.confirmation,
  );
  await expect(other).toHaveAccessibleName(
    ACTIVE_EVENT_NAMES.second.confirmation,
  );
  await expect(activate).toHaveAccessibleName(
    'Start a separate REAL incident and create notification intents for 4 selected staff recipients',
  );
  await chosen.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => joinRequests).toBe(1);
  await expect(chosen).toContainText('Joining DRILL — TRAINING ONLY once…');
  await expect(other).toHaveAccessibleName(
    ACTIVE_EVENT_NAMES.second.confirmation,
  );
  await expect(other).toBeDisabled();
  await expect(activate).toHaveAccessibleName(
    'Start a separate REAL incident and create notification intents for 4 selected staff recipients',
  );
  await expect(activate).toBeDisabled();
  expect(intercepted.activationRequests()).toBe(0);

  releaseJoin();
  const rejected = page.locator('section.error-summary[role="alert"]').filter({
    has: page.getByRole('heading', { name: 'Request not accepted' }),
  });
  await expect(rejected).toBeFocused();
  await expect(rejected).toContainText(
    'Attempted action: Join DRILL — TRAINING ONLY event Lockdown Drill — event 00000001.',
  );
  await expect(chosen).toBeEnabled();

  await chosen.click();
  await expect.poll(() => joinRequests).toBe(2);
  await expect(rejected).toBeFocused();
  expect(joinKeys).toHaveLength(2);
  expect(joinKeys[1]).toBe(joinKeys[0]);
  expect(intercepted.activationRequests()).toBe(0);
  await assertAxeClean(page, 'delayed join rejection and retry');
});

test('delayed activation double-click submits once and preserves the full pending consequence label', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    activeEventIds: [
      PLAYWRIGHT_IDS.activeEvent,
      PLAYWRIGHT_IDS.activeEventSecond,
    ],
    activationDelayMs: 750,
    activationOutcome: 'success',
    simulatedReadyStaff: true,
  });
  await page.goto(REAL_CONFIRMATION_PATH);
  const submit = page.locator('button.button--real');
  const firstJoin = page
    .locator('button.join-choice')
    .filter({ hasText: 'event 00000001' });
  await expect(submit).toHaveAccessibleName(
    'Start a separate REAL incident and create notification intents for 4 selected staff recipients',
  );
  await expect(firstJoin).toHaveAccessibleName(
    ACTIVE_EVENT_NAMES.first.confirmation,
  );
  await submit.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect.poll(intercepted.activationRequests).toBe(1);
  await expect(submit).toHaveAccessibleName(
    `Starting REAL INCIDENT Lockdown at ${SYNTHETIC_FACILITY} once…`,
  );
  await expect(firstJoin).toHaveAccessibleName(
    ACTIVE_EVENT_NAMES.first.confirmation,
  );
  await expect(firstJoin).toBeDisabled();

  const result = page.locator('section.result-panel').filter({
    has: page.getByRole('heading', { name: 'Incident started' }),
  });
  await expect(result).toBeFocused();
  expect(intercepted.activationRequests()).toBe(1);
  expect(intercepted.activationIdempotencyKeys).toHaveLength(1);
  await assertAxeClean(page, 'single delayed activation result');
});

test('activation 503 is outcome-unknown, never auto-retries, and disables replay', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    activationOutcome: 'ambiguous',
    simulatedReadyStaff: true,
  });
  await page.goto(REAL_CONFIRMATION_PATH);
  const submit = page.getByRole('button', {
    name: 'Start REAL incident and create notification intents for 4 selected staff recipients',
    exact: true,
  });
  await submit.click();

  const unresolved = page
    .locator('section.error-summary[role="alert"]')
    .filter({
      has: page.getByRole('heading', { name: 'Outcome unknown' }),
    });
  await expect(unresolved).toBeFocused();
  await expect(unresolved).toContainText(
    'Synthetic response interruption leaves the activation outcome unknown.',
  );
  await expect(unresolved).toContainText(
    'Attempted action: Start REAL INCIDENT event Lockdown.',
  );
  await expect(submit).toBeDisabled();
  await submit.evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForTimeout(250);
  expect(intercepted.activationRequests()).toBe(1);
  expect(intercepted.activationIdempotencyKeys).toHaveLength(1);
  await assertAxeClean(page, 'ambiguous activation outcome');
});

test('preview retry focuses the persistent live status before rendering fresh consequences', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    holdPreviewFailure: true,
    previewDelayMs: 300,
  });
  await page.goto(REAL_CONFIRMATION_PATH);
  const error = page.locator('section.error-summary[role="alert"]').filter({
    has: page.getByRole('heading', {
      name: 'Consequence preview unavailable',
    }),
  });
  await expect(error).toContainText(
    'Synthetic consequence preview is temporarily unavailable.',
  );

  intercepted.allowPreviewSuccess();
  await error.getByRole('button', { name: 'Load a fresh preview' }).click();
  const status = page.getByRole('status').filter({
    hasText: 'Loading the current roster snapshot',
  });
  await expect(status).toBeFocused();
  await expect(status).toHaveText(
    'Loading the current roster snapshot, active events, and channel consequences…',
  );
  await expect(
    page.getByRole('status').filter({
      hasText: 'Consequence preview ready: 4 selected staff recipients',
    }),
  ).toBeFocused();
  expect(intercepted.previewRequests.length).toBeGreaterThanOrEqual(2);
  expect(intercepted.activationRequests()).toBe(0);
  await assertAxeClean(page, 'focused consequence preview retry');
});

test('schema-valid activation response with a different idempotency decision fails closed as unresolved', async ({
  page,
}) => {
  const intercepted = await installPreviewInterception(page, {
    activationOutcome: 'success',
    mismatchedActivationIdempotencyKey: true,
    simulatedReadyStaff: true,
  });
  await page.goto(REAL_CONFIRMATION_PATH);
  const submit = page.getByRole('button', {
    name: 'Start REAL incident and create notification intents for 4 selected staff recipients',
    exact: true,
  });
  await submit.click();

  const unresolved = page
    .locator('section.error-summary[role="alert"]')
    .filter({
      has: page.getByRole('heading', { name: 'Outcome unknown' }),
    });
  await expect(unresolved).toBeFocused();
  await expect(unresolved).toContainText(
    'returned an event that does not match the confirmed preview',
  );
  await expect(submit).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Incident started' }),
  ).toHaveCount(0);
  expect(intercepted.activationRequests()).toBe(1);
  expect(intercepted.activationIdempotencyKeys).toHaveLength(1);
  await assertAxeClean(page, 'mismatched activation decision response');
});
