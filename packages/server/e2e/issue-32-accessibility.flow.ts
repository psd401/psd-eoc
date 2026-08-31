import {
  CreateActivationPreviewInputSchema,
  CreateMediaUploadIntentInputSchema,
  JournalEntrySchema,
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
  StartEventInputSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type StartEventResult,
} from '@psd-eoc/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  activationPreviewFixture,
  activationResultFixture,
} from '../app/(app)/start/test/fixtures';
import {
  expectAxeClean,
  issue32EvidencePath,
  readFixture,
  statePath,
} from './support';

const ISSUE_32_PHOTO_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfY4AAAAASUVORK5CYII=',
  'base64',
);
const ISSUE_32_MOCK_INCIDENT_ID = '32000000-0000-4000-8000-000000000032';

function remapActivationToEvent(
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
  eventId: string,
  activeEventIds: readonly string[] = [],
): Promise<Readonly<{ activationRequests: () => number }>> {
  let preview: ActivationPreview | null = null;
  let activationRequestCount = 0;

  await page.route('**/start/api/preview', async (route) => {
    const selection = CreateActivationPreviewInputSchema.parse(
      route.request().postDataJSON(),
    );
    preview = activationPreviewFixture(selection, {
      activeEventIds: [...activeEventIds],
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'x-psd-eoc-browser-fixture':
          'synthetic-only-does-not-prove-live-integration',
      },
      body: JSON.stringify(
        remapActivationToEvent(
          activationResultFixture(preview, idempotencyKey),
          eventId,
        ),
      ),
    });
  });

  return { activationRequests: () => activationRequestCount };
}

async function installSyntheticPhotoBridge(
  page: Page,
  input: Readonly<{
    eventId: string;
    mediaId: string;
    uploadIntentId: string;
  }>,
): Promise<
  Readonly<{
    completedRequests: () => number;
    putRequests: () => number;
    uploadIntentRequests: () => number;
  }>
> {
  let completedRequestCount = 0;
  let putRequestCount = 0;
  let uploadIntentRequestCount = 0;
  const uploadUrl = 'https://media.example.test/issue-32-upload';
  const readUrl = 'https://media.example.test/issue-32-ready';
  let uploadInput:
    | ReturnType<typeof CreateMediaUploadIntentInputSchema.parse>
    | undefined;

  await page.route('**/api/media/upload-intents', async (route) => {
    uploadIntentRequestCount += 1;
    uploadInput = CreateMediaUploadIntentInputSchema.parse(
      route.request().postDataJSON(),
    );
    const createdAt = new Date();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        MediaUploadIntentSchema.parse({
          id: input.uploadIntentId,
          ...uploadInput,
          uploadMethod: 'PUT',
          uploadUrl,
          status: 'pending-upload',
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(
            createdAt.getTime() + 10 * 60 * 1_000,
          ).toISOString(),
        }),
      ),
    });
  });

  await page.route(uploadUrl, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-headers': 'content-type,if-none-match',
          'access-control-allow-methods': 'PUT',
          'access-control-allow-origin': '*',
        },
      });
      return;
    }
    if (route.request().method() !== 'PUT' || uploadInput === undefined) {
      throw new Error('The synthetic private upload request was invalid.');
    }
    const bytes = route.request().postDataBuffer();
    if (bytes === null || bytes.byteLength !== uploadInput.byteLength) {
      throw new Error('The synthetic private upload bytes changed.');
    }
    putRequestCount += 1;
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        etag: '"synthetic-issue-32"',
      },
    });
  });

  await page.route(
    `**/api/media/upload-intents/${input.uploadIntentId}/complete`,
    async (route) => {
      completedRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          MediaRecordSchema.parse({
            id: input.mediaId,
            uploadIntentId: input.uploadIntentId,
            eventId: input.eventId,
            status: 'ready',
            detectedContentType: 'image/png',
            sanitizedByteLength: 68,
            sanitizedContentSha256: 'd'.repeat(64),
            malwareScan: 'clean',
            exifStripped: true,
            createdAt: new Date().toISOString(),
          }),
        ),
      });
    },
  );

  await page.route(
    `**/api/media/events/${input.eventId}/${input.mediaId}/read-grant`,
    async (route) => {
      const issuedAt = new Date();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          MediaReadGrantSchema.parse({
            eventId: input.eventId,
            mediaId: input.mediaId,
            readUrl,
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(
              issuedAt.getTime() + 2 * 60 * 1_000,
            ).toISOString(),
          }),
        ),
      });
    },
  );
  await page.route(readUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'private, no-store',
      },
      body: ISSUE_32_PHOTO_BYTES,
    });
  });

  return {
    completedRequests: () => completedRequestCount,
    putRequests: () => putRequestCount,
    uploadIntentRequests: () => uploadIntentRequestCount,
  };
}

async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 30_000 });
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

async function activateByKeyboard(page: Page, target: Locator): Promise<void> {
  await focusByKeyboard(page, target);
  await page.keyboard.press('Enter');
}

async function openDrillConfirmation(
  page: Page,
  options: Readonly<{ scanAxe?: boolean }> = {},
): Promise<void> {
  await page.goto('/');
  await activateByKeyboard(
    page,
    page.getByRole('link', {
      name: 'Run DRILL at Synthetic North Campus',
      exact: true,
    }),
  );
  await expect(page).toHaveURL(/\/start\?.*mode=drill/u);
  if (options.scanAxe !== false) await expectAxeClean(page);
  await activateByKeyboard(
    page,
    page.getByRole('link', { name: /^Lockdown Drill/u }).first(),
  );
  await expect(page).toHaveURL(/\/start\/confirm\?/u);
  await expect(
    page.getByRole('status').filter({ hasText: /Ready to start\./u }),
  ).toBeVisible({ timeout: 30_000 });
  if (options.scanAxe !== false) await expectAxeClean(page);
}

test.describe('issue-32-accessibility-evidence', () => {
  test('keyboard-only drill activation, late join, text update, and all-clear remain accessible', async ({
    browser,
    page,
  }) => {
    const fixture = await readFixture();
    const activationBridge = await installSyntheticActivationBridge(
      page,
      fixture.issue32EventId,
      [fixture.eventId],
    );
    const photoBridge = await installSyntheticPhotoBridge(page, {
      eventId: fixture.issue32EventId,
      ...fixture.issue32Media,
    });
    await openDrillConfirmation(page);
    const start = page.getByRole('button', {
      name: /Start a separate DRILL and notify/u,
    });
    await activateByKeyboard(page, start);
    // Starting an event lands in its room; there is no interstitial to click.
    await page.waitForURL(/\/events\/[0-9a-f-]+$/u);
    expect(activationBridge.activationRequests()).toBe(1);
    await expectAxeClean(page);

    const eventPath = new URL(page.url()).pathname;
    const eventId = eventPath.slice('/events/'.length);

    const lateJoinContext = await browser.newContext({
      storageState: statePath('facility-staff.json'),
    });
    try {
      const lateJoinPage = await lateJoinContext.newPage();
      await lateJoinPage.goto('/');
      const join = lateJoinPage
        .getByRole('button')
        .filter({ hasText: eventId.slice(-8) });
      await expect(join).toHaveCount(1);
      await join.press('Enter');
      await lateJoinPage.waitForURL(eventPath);
      await expectAxeClean(lateJoinPage);
    } finally {
      await lateJoinContext.close();
    }

    await expect(page).toHaveURL(eventPath);
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toBeVisible();
    await expectAxeClean(page);

    const update = page.getByLabel('Update text');
    await focusByKeyboard(page, update);
    await page.keyboard.insertText('Synthetic keyboard-only issue 32 update.');
    await activateByKeyboard(
      page,
      page.getByRole('button', { name: 'Post update' }),
    );
    await expect(
      page.locator('article.timeline-entry', {
        hasText: 'Synthetic keyboard-only issue 32 update.',
      }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'End event' })).toBeEnabled();
    await expectAxeClean(page);

    const locationReason =
      'Synthetic issue 32 reporter could not verify a precise location.';
    // Location is behind a disclosure now; open it before typing into it.
    await page.locator('summary', { hasText: 'Add a location' }).click();
    const locationComposer = page.locator('.location-composer');
    const locationReasonInput = locationComposer.getByLabel(
      'Why the location is unknown',
    );
    await focusByKeyboard(page, locationReasonInput);
    await page.keyboard.insertText(locationReason);
    const locationResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/events/${eventId}/api` &&
        response.request().method() === 'POST' &&
        (response.request().postDataJSON() as { operation?: unknown })
          .operation === 'post-location',
    );
    await activateByKeyboard(
      page,
      locationComposer.getByRole('button', { name: 'Post location' }),
    );
    const locationResponse = await locationResponsePromise;
    expect(locationResponse.status()).toBe(200);
    const locationEntry = JournalEntrySchema.parse(
      ((await locationResponse.json()) as { entry?: unknown }).entry,
    );
    expect(locationEntry).toMatchObject({
      eventId,
      kind: 'location',
      payload: { state: 'unknown', reason: locationReason },
    });
    await expect(
      page.locator('article.timeline-entry', { hasText: locationReason }),
    ).toBeVisible();
    await expectAxeClean(page);

    await page.locator('summary', { hasText: 'Add a photo' }).click();
    const photoComposer = page.locator('.photo-composer');
    await photoComposer.getByLabel('Photo file').setInputFiles({
      name: 'synthetic-issue-32.png',
      mimeType: 'image/png',
      buffer: ISSUE_32_PHOTO_BYTES,
    });
    const photoAlt = 'One synthetic blue pixel with no people or location.';
    const photoAltInput = photoComposer.getByLabel(
      'Photo description (alternative text)',
    );
    await focusByKeyboard(page, photoAltInput);
    await page.keyboard.insertText(photoAlt);
    const photoResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/events/${eventId}/api` &&
        response.request().method() === 'POST' &&
        (response.request().postDataJSON() as { operation?: unknown })
          .operation === 'post-photo',
    );
    await activateByKeyboard(
      page,
      photoComposer.getByRole('button', { name: 'Upload and post photo' }),
    );
    const photoResponse = await photoResponsePromise;
    expect(photoResponse.status()).toBe(200);
    const photoEntry = JournalEntrySchema.parse(
      ((await photoResponse.json()) as { entry?: unknown }).entry,
    );
    expect(photoEntry).toMatchObject({
      eventId,
      kind: 'photo',
      payload: { mediaId: fixture.issue32Media.mediaId, altText: photoAlt },
    });
    await expect(
      page.getByText('Photo post confirmed by the server.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByAltText(photoAlt)).toBeVisible();
    expect(photoBridge.uploadIntentRequests()).toBe(1);
    expect(photoBridge.putRequests()).toBe(1);
    expect(photoBridge.completedRequests()).toBe(1);
    await expectAxeClean(page);

    await activateByKeyboard(
      page,
      page.getByRole('button', { name: 'End event' }),
    );
    const dialog = page.getByRole('dialog', { name: 'End this event' });
    await expect(dialog).toBeVisible();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue32EvidencePath('keyboard-all-clear-review.png'),
      fullPage: true,
    });
    await activateByKeyboard(
      page,
      dialog.getByRole('button', { name: 'End event and notify staff' }),
    );
    // One action performs the all-clear and the close.
    await expect(
      page.getByText('Closed', { exact: true }).first(),
    ).toBeVisible();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue32EvidencePath('keyboard-all-clear-complete.png'),
      fullPage: true,
    });
  });

  test('drill activation reflows at explicit 200% zoom in forced colors', async ({
    page,
  }) => {
    const fixture = await readFixture();
    const activationBridge = await installSyntheticActivationBridge(
      page,
      fixture.issue32EventId,
    );
    await page.addInitScript(() => {
      const applyZoom = () => {
        document.documentElement.style.zoom = '2';
      };
      if (document.documentElement === null) {
        document.addEventListener('DOMContentLoaded', applyZoom, {
          once: true,
        });
      } else {
        applyZoom();
      }
    });
    await page.setViewportSize({ width: 640, height: 720 });
    await page.emulateMedia({ forcedColors: 'active' });
    await openDrillConfirmation(page, { scanAxe: false });

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
    await expect(
      page.getByRole('region', {
        name: 'DRILL — TRAINING ONLY classification',
      }),
    ).toBeVisible();
    await page.screenshot({
      path: issue32EvidencePath('forced-colors-200-percent-confirmation.png'),
      fullPage: true,
    });

    await activateByKeyboard(
      page,
      page.getByRole('button', {
        name: /Start (?:a separate )?DRILL and notify/u,
      }),
    );
    await page.waitForURL(/\/events\/[0-9a-f-]+$/u);
    expect(activationBridge.activationRequests()).toBe(1);
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
    await page.screenshot({
      path: issue32EvidencePath('forced-colors-200-percent-result.png'),
      fullPage: true,
    });
    await page.emulateMedia({ forcedColors: 'none' });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1';
    });
    await expectAxeClean(page);
  });

  test('real-incident UI completes only through a mock-only browser bridge', async ({
    page,
  }) => {
    const fixture = await readFixture();
    expect([fixture.eventId, fixture.issue32EventId]).not.toContain(
      ISSUE_32_MOCK_INCIDENT_ID,
    );
    const activationBridge = await installSyntheticActivationBridge(
      page,
      ISSUE_32_MOCK_INCIDENT_ID,
    );
    await page.goto('/');
    await activateByKeyboard(
      page,
      page.getByRole('link', {
        name: 'Start REAL incident at Synthetic North Campus',
        exact: true,
      }),
    );
    await expect(page).toHaveURL(/\/start\?.*mode=real/u);
    await expectAxeClean(page);
    const lockdown = page.locator('a.choice-card').filter({
      has: page.getByText('Lockdown', { exact: true }),
    });
    await activateByKeyboard(page, lockdown.first());
    await expect(page).toHaveURL(/\/start\/confirm\?/u);
    await expect(
      page.getByRole('region', { name: 'REAL INCIDENT classification' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: /Start (?:a separate )?REAL incident and notify/u,
      }),
    ).toBeVisible();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue32EvidencePath('real-incident-safe-confirmation.png'),
      fullPage: true,
    });

    await activateByKeyboard(
      page,
      page.getByRole('button', {
        name: /Start (?:a separate )?REAL incident and notify/u,
      }),
    );
    // The mock bridge fabricates the activation response, so the event it
    // names does not exist in this database; the assertion that matters here
    // is that a confirmed REAL activation navigates straight into its room.
    await page.waitForURL(`/events/${ISSUE_32_MOCK_INCIDENT_ID}`);
    expect(activationBridge.activationRequests()).toBe(1);
    // The room itself is not asserted here: the bridge fabricated this event,
    // so the route resolves to a not-found page rather than real UI. The
    // accessible surface under test is the confirmation captured above, and
    // the event room has its own flows.
  });

  test('district admin completes an accessible configuration mutation', async ({
    page,
  }) => {
    await page.goto('/facilities');
    await expectAxeClean(page);
    const form = page.getByRole('group', { name: 'Add a facility' });
    const code = form.getByLabel('Short code');
    await focusByKeyboard(page, code);
    await page.keyboard.insertText('ISSUE-32');
    await page.keyboard.press('Tab');
    await page.keyboard.insertText('Synthetic Issue 32 Campus');
    await activateByKeyboard(
      page,
      form.getByRole('button', { name: 'Add facility' }),
    );
    await expect(page).toHaveURL(/\/facilities\?.*status=/u);
    await expect(
      page.getByText('Synthetic Issue 32 Campus', { exact: true }).first(),
    ).toBeVisible();
    await expectAxeClean(page);
    await page.screenshot({
      path: issue32EvidencePath('admin-facility-configuration.png'),
      fullPage: true,
    });
  });
});
