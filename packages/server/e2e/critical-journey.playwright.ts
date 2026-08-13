import {
  CreateActivationPreviewInputSchema,
  JournalEntrySchema,
  StartEventInputSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type StartEventResult,
} from '@psd-eoc/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { asc, eq, inArray } from 'drizzle-orm';
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
import { startFlowPlaywrightDatabaseUrl } from '../app/(app)/start/test/playwright-database';
import { startFlowPlaywrightPaths } from '../app/(app)/start/test/playwright-run';
import { createDatabaseClient } from '../db/client';
import {
  activationPreviews,
  events,
  journalEntries,
  notificationIntents,
  outbox,
} from '../db/schema';

let fixture: StartFlowPlaywrightFixture;

/**
 * Axe cannot calculate color contrast for the aria-hidden diamond glyphs used
 * beside drill labels. Chromium also reports every text descendant of a modal
 * native dialog as partially obscured by that same dialog. Scan an open dialog
 * non-modally for the duration of axe's contrast calculation, then restore its
 * modality and focus. Every other incomplete result remains a gate failure.
 */
async function assertEventRoomAxeClean(
  page: Page,
  stateLabel: string,
  expectedModalDialog = false,
): Promise<void> {
  const openDialogs = page.locator('dialog[open]');
  const openDialogCount = await openDialogs.count();
  expect(
    openDialogCount,
    `${stateLabel} has an unexpected open-dialog count.`,
  ).toBe(expectedModalDialog ? 1 : 0);
  const contextSelector = expectedModalDialog ? 'dialog[open]' : null;
  const decorativeTargets =
    contextSelector === null
      ? [
          '.classification-icon',
          '.location-composer > .dialog-classification.mode-drill > span[aria-hidden="true"]',
          '.photo-composer > .dialog-classification.mode-drill > span[aria-hidden="true"]',
        ]
      : [
          'dialog[open] form > .dialog-classification.mode-drill > span[aria-hidden="true"]',
        ];
  for (const selector of decorativeTargets) {
    const element = page.locator(selector);
    await expect(element).toHaveAttribute('aria-hidden', 'true');
    await expect(element).toHaveText(/^◆\s*$/u);
  }

  const result = await page.evaluate(
    async ({ expectedDecorativeSelectors, expectedVersion, rootSelector }) => {
      const axe = Reflect.get(globalThis, 'axe') as
        | Readonly<{
            version: string;
            run(
              root: Document | Element,
              options: Readonly<{
                resultTypes: readonly (
                  | 'violations'
                  | 'incomplete'
                  | 'passes'
                )[];
                runOnly: Readonly<{
                  type: 'rule' | 'tag';
                  values: readonly string[];
                }>;
              }>,
            ): Promise<
              Readonly<{
                incomplete: readonly Readonly<{
                  id: string;
                  nodes: readonly Readonly<{
                    any: readonly Readonly<{
                      data?: Readonly<{ messageKey?: string }>;
                      id: string;
                      relatedNodes?: readonly Readonly<{
                        target: readonly string[];
                      }>[];
                    }>[];
                    target: readonly string[];
                  }>[];
                }>[];
                passes: readonly Readonly<{
                  id: string;
                  nodes: readonly Readonly<{ target: readonly string[] }>[];
                }>[];
                testEngine: Readonly<{ version: string }>;
                violations: readonly unknown[];
              }>
            >;
          }>
        | undefined;
      if (axe === undefined || axe.version !== expectedVersion) {
        throw new Error('The pinned axe browser engine is unavailable.');
      }
      const root =
        rootSelector === null ? document : document.querySelector(rootSelector);
      if (root === null) {
        throw new Error('The requested axe scan root is unavailable.');
      }
      let dialog:
        | Readonly<{
            documentScrollX: number;
            documentScrollY: number;
            element: HTMLDialogElement;
            focusedElement: HTMLElement | null;
            scrollLeft: number;
            scrollTop: number;
          }>
        | undefined;
      if (rootSelector !== null) {
        if (
          !(root instanceof HTMLDialogElement) ||
          !root.open ||
          !root.matches(':modal')
        ) {
          throw new Error('The requested axe dialog is not open and modal.');
        }
        const focusedElement =
          document.activeElement instanceof HTMLElement &&
          root.contains(document.activeElement)
            ? document.activeElement
            : null;
        const closed = new Promise<void>((resolveClose) => {
          root.addEventListener(
            'close',
            (event) => {
              event.stopImmediatePropagation();
              resolveClose();
            },
            { capture: true, once: true },
          );
        });
        dialog = {
          documentScrollX: window.scrollX,
          documentScrollY: window.scrollY,
          element: root,
          focusedElement,
          scrollLeft: root.scrollLeft,
          scrollTop: root.scrollTop,
        };
        root.close();
        await closed;
        if (root.open || root.matches(':modal')) {
          throw new Error('The axe dialog did not leave the modal top layer.');
        }
        root.show();
        if (!root.open || root.matches(':modal')) {
          throw new Error('The axe dialog did not enter non-modal mode.');
        }
        await new Promise<void>((resolveFrame) =>
          requestAnimationFrame(() => resolveFrame()),
        );
      }

      let findings: Awaited<ReturnType<NonNullable<typeof axe>['run']>>;
      const verifiedDialogOcclusionKeys = new Set<string>();
      const dialogOcclusionFailures: unknown[] = [];
      let dialogRestored = true;
      try {
        findings = await axe.run(root, {
          resultTypes: ['violations', 'incomplete'],
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
        if (dialog !== undefined) {
          for (const finding of findings.incomplete) {
            for (const node of finding.nodes) {
              const selector =
                node.target.length === 1 ? node.target[0] : undefined;
              const exactNativeDialogOcclusion =
                finding.id === 'color-contrast' &&
                selector !== undefined &&
                node.any.length > 0 &&
                node.any.every(
                  (check) =>
                    check.id === 'color-contrast' &&
                    check.data?.messageKey === 'elmPartiallyObscured' &&
                    check.relatedNodes?.some(
                      (related) =>
                        related.target.length === 1 &&
                        related.target[0] === 'dialog',
                    ) === true,
                );
              const matches =
                exactNativeDialogOcclusion && selector !== undefined
                  ? dialog.element.querySelectorAll(selector)
                  : [];
              const element = matches.length === 1 ? matches[0] : undefined;
              if (!(element instanceof HTMLElement)) continue;

              element.scrollIntoView({ block: 'center', inline: 'center' });
              await new Promise<void>((resolveFrame) =>
                requestAnimationFrame(() => resolveFrame()),
              );
              const verification = await axe.run(element, {
                resultTypes: ['violations', 'incomplete', 'passes'],
                runOnly: { type: 'rule', values: ['color-contrast'] },
              });
              const passedContrast = verification.passes.some(
                (pass) =>
                  pass.id === 'color-contrast' &&
                  pass.nodes.some(
                    (passNode) =>
                      passNode.target.length === 1 &&
                      passNode.target[0] !== undefined &&
                      element.matches(passNode.target[0]),
                  ),
              );
              if (
                verification.testEngine.version === expectedVersion &&
                verification.violations.length === 0 &&
                verification.incomplete.length === 0 &&
                passedContrast
              ) {
                verifiedDialogOcclusionKeys.add(
                  JSON.stringify({
                    findingId: finding.id,
                    messageKeys: node.any.map(
                      (check) => check.data?.messageKey ?? null,
                    ),
                    target: node.target,
                  }),
                );
              } else {
                dialogOcclusionFailures.push({ node, verification });
              }
            }
          }
        }
      } finally {
        if (dialog !== undefined) {
          dialog.element.removeAttribute('open');
          dialog.element.showModal();
          dialogRestored =
            dialog.element.open && dialog.element.matches(':modal');
          dialog.element.scrollTo(dialog.scrollLeft, dialog.scrollTop);
          dialog.focusedElement?.focus({ preventScroll: true });
          window.scrollTo(dialog.documentScrollX, dialog.documentScrollY);
          await new Promise<void>((resolveFrame) =>
            requestAnimationFrame(() => resolveFrame()),
          );
        }
      }
      if (!dialogRestored) {
        throw new Error('The axe dialog did not restore modal behavior.');
      }
      const decorativeIncompleteSelectors: string[] = [];
      const unexpectedIncomplete: unknown[] = [];
      for (const finding of findings.incomplete) {
        for (const node of finding.nodes) {
          const selector =
            node.target.length === 1 ? node.target[0] : undefined;
          const matches =
            selector === undefined
              ? []
              : rootSelector === null
                ? document.querySelectorAll(selector)
                : root.querySelectorAll(selector);
          const element =
            matches.length === 1 && matches[0] instanceof Element
              ? matches[0]
              : null;
          const decorativeSelector = expectedDecorativeSelectors.find(
            (expectedSelector) =>
              element !== null &&
              element === document.querySelector(expectedSelector),
          );
          const decorativeDiamond =
            finding.id === 'color-contrast' &&
            decorativeSelector !== undefined &&
            element !== null &&
            element.getAttribute('aria-hidden') === 'true' &&
            /^\s*◆\s*$/u.test(element.textContent ?? '') &&
            node.any.length > 0 &&
            node.any.every(
              (check) =>
                check.id === 'color-contrast' &&
                check.data?.messageKey === 'nonBmp',
            );
          if (decorativeDiamond) {
            decorativeIncompleteSelectors.push(decorativeSelector);
            continue;
          }
          if (
            verifiedDialogOcclusionKeys.has(
              JSON.stringify({
                findingId: finding.id,
                messageKeys: node.any.map(
                  (check) => check.data?.messageKey ?? null,
                ),
                target: node.target,
              }),
            )
          ) {
            continue;
          }

          unexpectedIncomplete.push(node);
        }
      }
      unexpectedIncomplete.push(...dialogOcclusionFailures);
      return {
        decorativeIncompleteSelectors,
        testEngineVersion: findings.testEngine.version,
        unexpectedIncomplete,
        violations: findings.violations,
      };
    },
    {
      expectedDecorativeSelectors: decorativeTargets,
      expectedVersion: AXE_CORE_VERSION,
      rootSelector: contextSelector,
    },
  );
  expect(result.testEngineVersion).toBe(AXE_CORE_VERSION);
  expect(
    result.violations,
    `${stateLabel} axe violations: ${JSON.stringify(result.violations)}`,
  ).toEqual([]);
  expect(
    result.unexpectedIncomplete,
    `${stateLabel} unexpected axe incomplete results: ${JSON.stringify(result.unexpectedIncomplete)}`,
  ).toEqual([]);
  expect(result.decorativeIncompleteSelectors.sort()).toEqual(
    [...decorativeTargets].sort(),
  );
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

test('production capability-backed synthetic drill supports join and location without provider I/O', async ({
  page,
}) => {
  const seededEvent = fixture.activeEvents[1];
  if (seededEvent === undefined) {
    throw new Error('The second production-seeded synthetic drill is absent.');
  }
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: startFlowPlaywrightDatabaseUrl(),
    maxConnections: 2,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Critical-journey Playwright requires PostgreSQL.');
  }

  try {
    const [
      [persistedEvent],
      [persistedPreview],
      [persistedIntent],
      [persistedOutbox],
      persistedActivationJournals,
    ] = await Promise.all([
      connection.db
        .select({
          id: events.id,
          status: events.status,
          kind: events.kind,
          templateMode: events.templateMode,
          rosterPopulation: events.rosterPopulation,
          activationAuthorization: events.activationAuthorization,
        })
        .from(events)
        .where(eq(events.id, seededEvent.id))
        .limit(1),
      connection.db
        .select({
          id: activationPreviews.id,
          kind: activationPreviews.kind,
          templateMode: activationPreviews.templateMode,
          rosterPopulation: activationPreviews.rosterPopulation,
          sendReadiness: activationPreviews.sendReadiness,
          channels: activationPreviews.channels,
        })
        .from(activationPreviews)
        .where(eq(activationPreviews.id, seededEvent.previewId))
        .limit(1),
      connection.db
        .select({
          id: notificationIntents.id,
          eventId: notificationIntents.eventId,
          eventKind: notificationIntents.eventKind,
          templateMode: notificationIntents.templateMode,
          purpose: notificationIntents.purpose,
          rosterPopulation: notificationIntents.rosterPopulation,
          requestId: notificationIntents.requestId,
        })
        .from(notificationIntents)
        .where(eq(notificationIntents.id, seededEvent.notificationIntentId))
        .limit(1),
      connection.db
        .select({
          id: outbox.id,
          eventId: outbox.eventId,
          intentId: outbox.intentId,
          templateMode: outbox.templateMode,
          rosterPopulation: outbox.rosterPopulation,
          status: outbox.status,
          attempts: outbox.attempts,
          publishedAt: outbox.publishedAt,
        })
        .from(outbox)
        .where(eq(outbox.id, seededEvent.outboxId))
        .limit(1),
      connection.db
        .select({
          id: journalEntries.id,
          eventId: journalEntries.eventId,
          sequence: journalEntries.sequence,
        })
        .from(journalEntries)
        .where(inArray(journalEntries.id, seededEvent.journalEntryIds))
        .orderBy(asc(journalEntries.sequence)),
    ]);

    expect(persistedEvent).toMatchObject({
      id: seededEvent.id,
      status: 'active',
      kind: 'drill',
      templateMode: 'drill',
      rosterPopulation: 'synthetic',
      activationAuthorization: {
        kind: 'synthetic-training',
        activationPreviewId: seededEvent.previewId,
        requestId: seededEvent.requestId,
      },
    });
    expect(persistedPreview).toMatchObject({
      id: seededEvent.previewId,
      kind: 'drill',
      templateMode: 'drill',
      rosterPopulation: 'synthetic',
      sendReadiness: 'ready',
    });
    const previewChannels = JSON.stringify(persistedPreview?.channels);
    expect(previewChannels).toContain('mocked');
    expect(previewChannels).not.toContain('live-verified');
    expect(persistedIntent).toEqual({
      id: seededEvent.notificationIntentId,
      eventId: seededEvent.id,
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      rosterPopulation: 'synthetic',
      requestId: seededEvent.requestId,
    });
    expect(persistedOutbox).toEqual({
      id: seededEvent.outboxId,
      eventId: seededEvent.id,
      intentId: seededEvent.notificationIntentId,
      templateMode: 'drill',
      rosterPopulation: 'synthetic',
      status: 'pending',
      attempts: 0,
      publishedAt: null,
    });
    expect(
      persistedActivationJournals.map((entry) => ({
        id: entry.id,
        eventId: entry.eventId,
      })),
    ).toEqual(
      seededEvent.journalEntryIds.map((id) => ({
        id,
        eventId: seededEvent.id,
      })),
    );

    await page.goto('/');
    await assertAxeClean(page, 'production-backed synthetic drill dashboard');
    const joinButton = page
      .getByRole('button')
      .filter({ hasText: seededEvent.id.slice(-8) });
    await expect(joinButton).toHaveCount(1);
    const joinResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/start/api/join' &&
        response.request().method() === 'POST',
    );
    await joinButton.press('Enter');
    expect((await joinResponse).status()).toBe(200);
    const joinedStatus = page.getByRole('status').filter({
      hasText: 'DRILL — TRAINING ONLY event joined.',
    });
    await expect(joinedStatus).toBeFocused();
    await assertAxeClean(page, 'production join result');

    await joinedStatus.getByRole('link', { name: 'Open event' }).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/events/${seededEvent.id}$`, 'u'));
    await expect(page.locator('.event-status')).toHaveText('Active');
    await assertEventRoomAxeClean(page, 'production-joined drill room');

    const locationReason =
      'Synthetic E2E reporter could not verify a precise location';
    const composer = page.locator('.location-composer');
    await composer
      .getByLabel('Why the location is unknown')
      .fill(locationReason);
    const locationResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/events/${seededEvent.id}/api` &&
        response.request().method() === 'POST' &&
        (response.request().postDataJSON() as { operation?: unknown })
          .operation === 'post-location',
    );
    await composer
      .getByRole('button', { name: 'Post location' })
      .press('Enter');
    const response = await locationResponse;
    expect(response.status()).toBe(200);
    const responseBody = (await response.json()) as { entry?: unknown };
    const locationEntry = JournalEntrySchema.parse(responseBody.entry);
    expect(locationEntry).toMatchObject({
      eventId: seededEvent.id,
      kind: 'location',
      payload: { state: 'unknown', reason: locationReason },
    });
    await expect(
      page.getByText(
        `Location unknown. Coordinates and accuracy are unavailable. Reason: ${locationReason}.`,
        { exact: true },
      ),
    ).toBeVisible();
    await assertEventRoomAxeClean(page, 'production location result');

    const [persistedLocation] = await connection.db
      .select({
        id: journalEntries.id,
        eventId: journalEntries.eventId,
        kind: journalEntries.kind,
        payload: journalEntries.payload,
      })
      .from(journalEntries)
      .where(eq(journalEntries.id, locationEntry.id))
      .limit(1);
    expect(persistedLocation).toEqual({
      id: locationEntry.id,
      eventId: seededEvent.id,
      kind: 'location',
      payload: { state: 'unknown', reason: locationReason },
    });
    const [unchangedOutbox] = await connection.db
      .select({
        status: outbox.status,
        attempts: outbox.attempts,
        publishedAt: outbox.publishedAt,
      })
      .from(outbox)
      .where(eq(outbox.id, seededEvent.outboxId))
      .limit(1);
    expect(unchangedOutbox).toEqual({
      status: 'pending',
      attempts: 0,
      publishedAt: null,
    });
  } finally {
    await connection.close();
  }
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
  await assertEventRoomAxeClean(page, 'keyboard-opened active drill room');

  const update = page.getByLabel('Update text');
  await focusByKeyboard(page, update);
  await page.keyboard.insertText('Synthetic keyboard-only E2E update.');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Post update' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Synthetic keyboard-only E2E update.', { exact: true }),
  ).toBeVisible();
  await assertEventRoomAxeClean(page, 'keyboard-posted drill room');
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
  await assertEventRoomAxeClean(
    page,
    'keyboard all-clear consequence dialog',
    true,
  );
  await page.keyboard.insertText('ALL CLEAR');
  const issueAllClear = page.getByRole('button', {
    name: 'Issue all-clear and notify',
  });
  await expect(issueAllClear).toBeEnabled();
  await activateByKeyboard(page, issueAllClear);
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  await expect(notificationIntents).toHaveCount(2);
  await assertEventRoomAxeClean(page, 'keyboard-completed all-clear room');
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
