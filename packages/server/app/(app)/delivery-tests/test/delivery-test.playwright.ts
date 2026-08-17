import {
  ActivationPreviewSchema,
  CreateDeliveryTestPreviewInputSchema,
  DeliveryTestPreviewSchema,
  StartEventInputSchema,
  StartEventResultSchema,
  type DeliveryTestPreview,
  type StartEventResult,
} from '@psd-eoc/contracts';
import { expect, test, type Page } from '@playwright/test';

import { assertAxeClean, installAxe } from '../../start/test/axe-playwright';
import {
  activationPreviewFixture,
  activationResultFixture,
} from '../../start/test/playwright.fixtures';

const FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const DRILL_EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const TARGET_SET_ID = '53000000-0000-4000-8000-000000000001';
const TARGET_SET_VERSION = 1;
const ENDPOINT_REFERENCE_DIGEST = 'd'.repeat(64);

function deliveryTestPreview(
  input: Readonly<{
    controlledEmailCanary?: boolean;
    liveVerified: boolean;
  }>,
): DeliveryTestPreview {
  const base = activationPreviewFixture(
    {
      facilityId: FACILITY_ID,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: {
        id: DRILL_EVENT_TYPE_VERSION_ID,
        templateMode: 'drill',
      },
      rosterPopulation: 'staff',
    },
    { includeSms: false, simulatedReadyStaff: input.liveVerified },
  );
  const deliveryTest = {
    purpose: 'monthly-live-delivery-test' as const,
    targetSet: { id: TARGET_SET_ID, version: TARGET_SET_VERSION },
    endpointReferenceDigest: ENDPOINT_REFERENCE_DIGEST,
  };
  const activationPreview = ActivationPreviewSchema.parse(
    input.controlledEmailCanary === true
      ? {
          ...base,
          recipientCount: 1,
          channels: base.channels
            .filter((channel) => channel.channel === 'email')
            .map((channel) => ({ ...channel, endpointCount: 1 })),
          blockingReasonCodes: base.blockingReasonCodes.filter(
            (reason) => !reason.startsWith('PUSH_'),
          ),
          deliveryTest,
        }
      : { ...base, deliveryTest },
  );
  return DeliveryTestPreviewSchema.parse({
    purpose: 'monthly-live-delivery-test',
    activationPreview,
    targetSet: deliveryTest.targetSet,
    endpointReferenceDigest: ENDPOINT_REFERENCE_DIGEST,
    channels: activationPreview.channels.map((channel) => ({
      channel: channel.channel,
      endpointCount: channel.endpointCount,
      integrationStatus: channel.integrationStatus,
      credentialVerified: channel.integrationStatus.label === 'live-verified',
    })),
    consequenceDigest: activationPreview.consequenceDigest,
    createdAt: activationPreview.createdAt,
    expiresAt: activationPreview.expiresAt,
  });
}

function activationResult(
  preview: DeliveryTestPreview,
  idempotencyKey: string,
): StartEventResult {
  const activationFixturePreview =
    preview.activationPreview.channels.length === 1
      ? activationPreviewFixture(
          {
            facilityId: preview.activationPreview.facilityId,
            kind: 'drill',
            templateMode: 'drill',
            eventTypeVersion: preview.activationPreview.eventTypeVersion,
            rosterPopulation: 'staff',
          },
          { includeSms: false, simulatedReadyStaff: true },
        )
      : preview.activationPreview;
  const base = activationResultFixture(
    activationFixturePreview,
    idempotencyKey,
  );
  if (base.notificationIntent === null) {
    throw new Error(
      'Synthetic browser result omitted its notification intent.',
    );
  }
  return StartEventResultSchema.parse({
    ...base,
    notificationIntent: {
      ...base.notificationIntent,
      deliveryTest: preview.activationPreview.deliveryTest,
      channels: preview.activationPreview.channels,
    },
  });
}

interface Interception {
  readonly activationRequests: () => number;
  readonly previewRequests: () => number;
  readonly targetMutationRequests: () => number;
}

async function installDeliveryTestInterception(
  page: Page,
  liveVerified: boolean,
  controlledEmailCanary = false,
): Promise<Interception> {
  let previewRequestCount = 0;
  let activationRequestCount = 0;
  let targetMutationRequestCount = 0;
  const preview = deliveryTestPreview({
    controlledEmailCanary,
    liveVerified,
  });

  await page.route('**/delivery-tests/api/target-sets', async (route) => {
    targetMutationRequestCount += 1;
    await route.fulfill({ status: 500, body: 'Synthetic route must not run.' });
  });
  await page.route('**/delivery-tests/api/preview', async (route) => {
    previewRequestCount += 1;
    const selection = CreateDeliveryTestPreviewInputSchema.parse(
      route.request().postDataJSON(),
    );
    expect(selection).toEqual({
      targetSet: { id: TARGET_SET_ID, version: TARGET_SET_VERSION },
      eventTypeVersion: {
        id: DRILL_EVENT_TYPE_VERSION_ID,
        templateMode: 'drill',
      },
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'x-psd-eoc-browser-fixture': 'synthetic-intercept-no-provider-network',
      },
      body: JSON.stringify(preview),
    });
  });
  await page.route('**/delivery-tests/api/activate', async (route) => {
    activationRequestCount += 1;
    const input = StartEventInputSchema.parse(route.request().postDataJSON());
    expect(input).toEqual({
      source: 'activation-preview',
      activationPreviewId: preview.activationPreview.id,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: preview.activationPreview.activeEventIds,
      },
    });
    const idempotencyKey = route.request().headers()['idempotency-key'];
    expect(idempotencyKey).toMatch(/^activate:/u);
    if (idempotencyKey === undefined) {
      throw new Error('Synthetic activation omitted idempotency evidence.');
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'x-psd-eoc-browser-fixture': 'synthetic-intercept-no-provider-network',
      },
      body: JSON.stringify(activationResult(preview, idempotencyKey)),
    });
  });

  return {
    activationRequests: () => activationRequestCount,
    previewRequests: () => previewRequestCount,
    targetMutationRequests: () => targetMutationRequestCount,
  };
}

async function enterPreviewSelection(page: Page): Promise<void> {
  await page.getByLabel('Approved target version ID').fill(TARGET_SET_ID);
  await page
    .getByLabel('Target version number')
    .fill(String(TARGET_SET_VERSION));
  await page
    .getByLabel('DRILL event type')
    .selectOption(DRILL_EVENT_TYPE_VERSION_ID);
  await page.getByRole('button', { name: 'Load preview' }).click();
}

test.beforeEach(async ({ context }) => {
  await installAxe(context);
});

test('product-owner target configuration is keyboard-operable and a blocked preview cannot send', async ({
  page,
}) => {
  const intercept = await installDeliveryTestInterception(page, false);
  await page.goto('/delivery-tests');

  await expect(
    page.getByRole('heading', { name: 'Monthly live delivery test' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '1. Configure controlled canaries' }),
  ).toBeVisible();
  const targetConfiguration = page.getByRole('region', {
    name: '1. Configure controlled canaries',
  });
  const facility = targetConfiguration.getByLabel('Facility').first();
  await facility.focus();
  await page.keyboard.press('Tab');
  await expect(
    targetConfiguration.getByLabel('Current staff roster snapshot ID').first(),
  ).toBeFocused();
  expect(intercept.targetMutationRequests()).toBe(0);
  expect(intercept.previewRequests()).toBe(0);
  expect(intercept.activationRequests()).toBe(0);
  await assertAxeClean(page, 'delivery-test target configuration');

  await enterPreviewSelection(page);
  expect(intercept.previewRequests()).toBe(1);
  await expect(
    page.getByText('DRILL — LIVE CANARY — TRAINING ONLY', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Live canary run blocked' }),
  ).toBeVisible();
  const confirm = page.getByRole('button', {
    name: 'Confirm and start DRILL live canary',
  });
  await expect(confirm).toBeDisabled();
  await expect(
    page.getByText('Configured but unverified — live run blocked').first(),
  ).toBeVisible();
  expect(intercept.activationRequests()).toBe(0);
  await assertAxeClean(page, 'blocked delivery-test consequence preview');
});

test('fresh keyboard confirmation submits exactly once to an intercepted DRILL path', async ({
  page,
}) => {
  const intercept = await installDeliveryTestInterception(page, true, true);
  await page.goto('/delivery-tests');
  await enterPreviewSelection(page);

  await expect(
    page.getByText('DRILL — LIVE CANARY — TRAINING ONLY', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Email' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Push' })).toHaveCount(0);
  await expect(page.getByText('1 exact approved endpoint')).toBeVisible();
  await expect(
    page.getByText('[DRILL] Synthetic browser preview', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('[DRILL] No provider can receive this browser fixture.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Live integration and credentials verified'),
  ).toBeVisible();
  await expect(page.locator('time[datetime]').last()).toBeVisible();

  const humanDecision = page.getByLabel(
    /I am an authenticated human making a fresh decision/u,
  );
  const confirm = page.getByRole('button', {
    name: 'Confirm and start DRILL live canary',
  });
  await expect(confirm).toBeDisabled();
  expect(intercept.activationRequests()).toBe(0);
  await humanDecision.focus();
  await page.keyboard.press('Space');
  await expect(humanDecision).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await expect(confirm).toBeEnabled();
  await assertAxeClean(page, 'ready delivery-test human confirmation');

  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'DRILL accepted' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'This does not claim provider acceptance, delivery, or human receipt.',
      { exact: false },
    ),
  ).toBeVisible();
  expect(intercept.activationRequests()).toBe(1);
  expect(intercept.targetMutationRequests()).toBe(0);
  await assertAxeClean(page, 'accepted delivery-test response truth');
});
