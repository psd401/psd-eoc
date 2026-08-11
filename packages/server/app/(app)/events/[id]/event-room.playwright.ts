import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { desc, eq } from 'drizzle-orm';

import { createDatabaseClient } from '../../../../db/client';
import {
  journalEntries,
  lifecycleConsequencePreviews,
} from '../../../../db/schema';
import {
  requireEventRoomPlaywrightRunContext,
  type EventRoomPlaywrightRunContext,
} from './test-database';

const AXE_VERSION = '4.10.3';
const AXE_SHA256 =
  '880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb';
const AXE_SOURCE_URL = new URL('./axe-core-4.10.3.min.js.txt', import.meta.url);
const AXE_LICENSE_URL = new URL('./axe-core-4.10.3.LICENSE', import.meta.url);

interface EventRoomFixture {
  readonly continuationEventId: string;
  readonly dialogFailureEventId: string;
  readonly historyEventId: string;
  readonly invalidationEventId: string;
  readonly journalEvidenceEventId: string;
  readonly keyboardEventId: string;
  readonly recoveryEventId: string;
  readonly recoveryOwnerEventId: string;
  readonly lifecycleEventId: string;
  readonly malformedLifecycleEventId: string;
  readonly newerPollEventId: string;
  readonly realDraftEventId: string;
  readonly stalePollEventId: string;
  readonly staleLifecycleResponseEventId: string;
  readonly stalledMutationEventId: string;
  readonly stalledPreviewEventId: string;
}

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

function fixturePath(eventId: string): string {
  return `/events/${encodeURIComponent(eventId)}`;
}

async function readFixture(testInfo: TestInfo): Promise<EventRoomFixture> {
  const context = runContext(testInfo);
  const parsed: unknown = JSON.parse(
    await readFile(context.fixturePath, 'utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Object.values(parsed).every((value) => typeof value === 'string')
  ) {
    throw new Error('The event-room Playwright fixture is invalid.');
  }
  return parsed as EventRoomFixture;
}

function runContext(testInfo: TestInfo): EventRoomPlaywrightRunContext {
  const metadata = testInfo.config.metadata as Readonly<
    Record<string, unknown>
  >;
  return requireEventRoomPlaywrightRunContext(metadata.eventRoomRun);
}

async function lifecyclePreviewIds(
  testInfo: TestInfo,
  eventId: string,
): Promise<readonly string[]> {
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: runContext(testInfo).databaseUrl,
    maxConnections: 1,
  });
  if (connection.driver !== 'postgres') {
    throw new Error(
      'Event-room Playwright database inspection needs PostgreSQL.',
    );
  }
  try {
    const rows = await connection.db
      .select({ id: lifecycleConsequencePreviews.id })
      .from(lifecycleConsequencePreviews)
      .where(eq(lifecycleConsequencePreviews.eventId, eventId));
    return rows.map(({ id }) => id).sort();
  } finally {
    await connection.close();
  }
}

async function appendSyntheticBurst(
  testInfo: TestInfo,
  eventId: string,
  count: number,
): Promise<void> {
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: runContext(testInfo).databaseUrl,
    maxConnections: 1,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Event-room Playwright burst setup needs PostgreSQL.');
  }
  try {
    const [head] = await connection.db
      .select({
        sequence: journalEntries.sequence,
        author: journalEntries.author,
        serverTime: journalEntries.serverTime,
      })
      .from(journalEntries)
      .where(eq(journalEntries.eventId, eventId))
      .orderBy(desc(journalEntries.sequence))
      .limit(1);
    if (head === undefined) {
      throw new Error('Synthetic continuation event has no journal head.');
    }
    await connection.db.insert(journalEntries).values(
      Array.from({ length: count }, (_, index) => {
        const sequence = head.sequence + index + 1;
        const at = new Date(head.serverTime.getTime() + (index + 1) * 10);
        return {
          eventId,
          sequence,
          kind: 'text' as const,
          author: head.author,
          source: 'web' as const,
          serverTime: at,
          clientTime: at,
          payload: {
            text: `Synthetic post-connect burst ${String(sequence).padStart(3, '0')}`,
          },
        };
      }),
    );
  } finally {
    await connection.close();
  }
}

async function postPreview(
  page: Page,
  eventId: string,
  idempotencyKey: string,
  includeCsrf: boolean,
): Promise<
  Readonly<{
    status: number;
    value: unknown;
    acknowledgedIdempotencyKey: string | null;
  }>
> {
  return page.evaluate(
    async (input) => {
      const csrf = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('__Host-psd-eoc-csrf='))
        ?.split('=', 2)[1];
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      };
      if (input.includeCsrf && csrf !== undefined) {
        headers['X-PSD-EOC-CSRF'] = decodeURIComponent(csrf);
      }
      const response = await fetch(
        `/events/${encodeURIComponent(input.eventId)}/api`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: JSON.stringify({ operation: 'preview-all-clear' }),
        },
      );
      return {
        status: response.status,
        value: await response.json(),
        acknowledgedIdempotencyKey: response.headers.get('idempotency-key'),
      };
    },
    { eventId, idempotencyKey, includeCsrf },
  );
}

async function issueExternalAllClear(
  page: Page,
  eventId: string,
): Promise<void> {
  const previewKey = `event-room-preview-${randomUUID()}`;
  const previewResponse = await postPreview(page, eventId, previewKey, true);
  const previewEnvelope = previewResponse.value;
  const preview =
    typeof previewEnvelope === 'object' &&
    previewEnvelope !== null &&
    'preview' in previewEnvelope &&
    typeof previewEnvelope.preview === 'object' &&
    previewEnvelope.preview !== null
      ? previewEnvelope.preview
      : null;
  const lifecyclePreviewId =
    preview !== null && 'id' in preview && typeof preview.id === 'string'
      ? preview.id
      : null;
  expect(previewResponse.status).toBe(200);
  expect(previewResponse.acknowledgedIdempotencyKey).toBe(previewKey);
  if (lifecyclePreviewId === null) {
    throw new Error('Synthetic all-clear preview response is invalid.');
  }

  const idempotencyKey = `event-room-all-clear-${randomUUID()}`;
  const result = await page.evaluate(
    async (input) => {
      const csrf = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('__Host-psd-eoc-csrf='))
        ?.split('=', 2)[1];
      if (csrf === undefined) {
        return { status: 0, acknowledgedIdempotencyKey: null };
      }
      const response = await fetch(
        `/events/${encodeURIComponent(input.eventId)}/api`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
            'X-PSD-EOC-CSRF': decodeURIComponent(csrf),
          },
          body: JSON.stringify({
            operation: 'all-clear',
            lifecyclePreviewId: input.lifecyclePreviewId,
            confirmationPhrase: 'ALL CLEAR',
          }),
        },
      );
      return {
        status: response.status,
        acknowledgedIdempotencyKey: response.headers.get('idempotency-key'),
      };
    },
    { eventId, idempotencyKey, lifecyclePreviewId },
  );
  expect(result.status).toBe(200);
  expect(result.acknowledgedIdempotencyKey).toBe(idempotencyKey);
}

async function issueExternalClose(page: Page, eventId: string): Promise<void> {
  const idempotencyKey = `event-room-close-${randomUUID()}`;
  const result = await page.evaluate(
    async (input) => {
      const csrf = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('__Host-psd-eoc-csrf='))
        ?.split('=', 2)[1];
      if (csrf === undefined) {
        return { status: 0, acknowledgedIdempotencyKey: null };
      }
      const response = await fetch(
        `/events/${encodeURIComponent(input.eventId)}/api`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
            'X-PSD-EOC-CSRF': decodeURIComponent(csrf),
          },
          body: JSON.stringify({
            operation: 'close',
            confirmationPhrase: 'CLOSE EVENT',
          }),
        },
      );
      return {
        status: response.status,
        acknowledgedIdempotencyKey: response.headers.get('idempotency-key'),
      };
    },
    { eventId, idempotencyKey },
  );
  expect(result.status).toBe(200);
  expect(result.acknowledgedIdempotencyKey).toBe(idempotencyKey);
}

function relativeLuminance(cssColor: string): number {
  const components = cssColor
    .match(/[\d.]+/gu)
    ?.slice(0, 3)
    .map(Number);
  if (components === undefined || components.length !== 3) {
    throw new Error(`Cannot parse computed color ${cssColor}.`);
  }
  const linear = components.map((component) => {
    const channel = component / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const brighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (brighter + 0.05) / (darker + 0.05);
}

async function loadVerifiedAxeSource(): Promise<string> {
  axeSourcePromise ??= (async () => {
    const [storedBytes, license] = await Promise.all([
      readFile(AXE_SOURCE_URL),
      readFile(AXE_LICENSE_URL, 'utf8'),
    ]);
    if (!license.includes('Mozilla Public License, version 2.0')) {
      throw new Error(`Pinned axe-core ${AXE_VERSION} license is missing.`);
    }
    const bytes =
      storedBytes.at(-1) === 0x0a
        ? storedBytes.subarray(0, storedBytes.length - 1)
        : storedBytes;
    const actualDigest = createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== AXE_SHA256) {
      throw new Error(
        `Repository-local axe-core ${AXE_VERSION} failed SHA-256 verification.`,
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

async function postExternalUpdate(
  page: Page,
  eventId: string,
  text: string,
  clientTime: string,
): Promise<void> {
  const result = await page.evaluate(
    async (input) => {
      const csrf = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('__Host-psd-eoc-csrf='))
        ?.split('=', 2)[1];
      if (csrf === undefined) {
        return { ok: false, status: 0, body: 'CSRF cookie missing.' };
      }
      const response = await fetch(
        `/events/${encodeURIComponent(input.eventId)}/api`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
            'X-PSD-EOC-CSRF': decodeURIComponent(csrf),
          },
          body: JSON.stringify({
            operation: 'post-text',
            text: input.text,
            clientTime: input.clientTime,
          }),
        },
      );
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    },
    {
      eventId,
      text,
      clientTime,
      idempotencyKey: `event-room-external-${randomUUID()}`,
    },
  );
  if (!result.ok) {
    throw new Error(
      `Synthetic external timeline post failed (${result.status}): ${result.body}`,
    );
  }
}

test('late join drains complete ordered history, polls a stable cursor, batches announcements, and is axe-clean', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.historyEventId));
  await expect(page).toHaveURL(
    new RegExp(`/events/${fixture.historyEventId}$`, 'u'),
  );
  await expect(
    page.getByText('DRILL — TRAINING ONLY', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator('.timeline-entry')).toHaveCount(105);

  const headings = await page.locator('.timeline-entry h3').allTextContents();
  expect(headings).toHaveLength(105);
  expect(headings[0]).toBe('Entry 1: Text update');
  expect(headings.at(-1)).toBe('Entry 105: Text update');
  await expect(
    page.getByText('Synthetic ordered history 001', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Synthetic ordered history 105', { exact: true }),
  ).toBeVisible();

  const announcement = page.locator(
    'p.sr-only[role="status"][aria-live="polite"]',
  );
  await expect(announcement).toHaveText('');
  const now = Date.now();
  await postExternalUpdate(
    page,
    fixture.historyEventId,
    'Server first despite later client time',
    new Date(now - 60 * 60_000).toISOString(),
  );
  await postExternalUpdate(
    page,
    fixture.historyEventId,
    'Server second despite earlier client time',
    new Date(now - 2 * 60 * 60_000).toISOString(),
  );
  await expect(
    page.getByText('Server first despite later client time', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Server second despite earlier client time', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.timeline-entry')).toHaveCount(107);
  const updatedHeadings = await page
    .locator('.timeline-entry h3')
    .allTextContents();
  expect(updatedHeadings.at(-2)).toBe('Entry 106: Text update');
  expect(updatedHeadings.at(-1)).toBe('Entry 107: Text update');
  await expect(announcement).toHaveText('');
  await expect(announcement).toHaveText('2 new timeline updates received.', {
    timeout: 7_000,
  });
  await expectAxeClean(page, 'drill event room after late-join polling');
});

test('a post-connect continuation stays hidden and blocked across offline recovery until lifecycle state and all facts are coherent', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.continuationEventId));
  await expect(page.locator('.connection-line')).toContainText('Connected');
  await expect(page.locator('.event-status')).toHaveText('Active');

  let releaseBurst: () => void = () => undefined;
  const burstReady = new Promise<void>((resolve) => {
    releaseBurst = resolve;
  });
  let firstPageSeen = false;
  let continuationFailures = 0;
  let timelineRequests = 0;
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    if (
      request.method() !== 'GET' ||
      !request.url().includes(fixture.continuationEventId)
    ) {
      await route.continue();
      return;
    }
    timelineRequests += 1;
    await burstReady;
    if (!firstPageSeen) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as {
        event?: unknown;
        entries?: unknown[];
        hasMore?: boolean;
      };
      expect(value.event).toBeNull();
      expect(value.entries).toHaveLength(100);
      expect(value.hasMore).toBe(true);
      firstPageSeen = true;
      await route.fulfill({ response: upstream, json: value });
      return;
    }
    if (continuationFailures < 2) {
      continuationFailures += 1;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Synthetic continuation outage.',
          requestId: randomUUID(),
          retryable: true,
          fieldErrors: [],
        }),
      });
      return;
    }
    await route.continue();
  });

  try {
    await issueExternalAllClear(page, fixture.continuationEventId);
    await appendSyntheticBurst(testInfo, fixture.continuationEventId, 100);
  } finally {
    releaseBurst();
  }

  await expect.poll(() => firstPageSeen).toBe(true);
  await expect(page.locator('.timeline-panel')).toContainText(
    'Timeline content remains hidden until all authorized history',
  );
  await expect(
    page.getByRole('button', { name: 'Review all-clear' }),
  ).toBeDisabled();
  await expect(page.locator('.connection-line')).toContainText('Reconnecting');
  await expect(page.locator('.connection-line')).toContainText(
    'Offline — updates may be delayed',
    { timeout: 12_000 },
  );
  await expect(page.locator('.timeline-panel')).toContainText(
    'Timeline content remains hidden until all authorized history',
  );
  await expect(page.locator('.connection-line')).toContainText('Connected', {
    timeout: 22_000,
  });
  expect(continuationFailures).toBe(2);
  expect(timelineRequests).toBeGreaterThanOrEqual(4);
  await expect(page.locator('.timeline-entry')).toHaveCount(105);
  await expect(
    page.getByText('All-clear issued.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Notification fan-out intent recorded.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  await expect(
    page.getByRole('button', { name: 'Review all-clear' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Review event close' }),
  ).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
});

test('an invalidated continuation remains fail-closed until a complete retry reaches its terminal projection', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.invalidationEventId));
  await expect(page.locator('.connection-line')).toContainText('Connected');

  let releaseStalePage: () => void = () => undefined;
  const stalePageRelease = new Promise<void>((resolve) => {
    releaseStalePage = resolve;
  });
  let releaseTerminalPage: () => void = () => undefined;
  const terminalPageRelease = new Promise<void>((resolve) => {
    releaseTerminalPage = resolve;
  });
  let stalePageCaptured = false;
  let retryFirstPageSeen = false;
  let retryTerminalHeld = false;
  let timelineRequests = 0;
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    if (
      request.method() !== 'GET' ||
      !request.url().includes(fixture.invalidationEventId)
    ) {
      await route.continue();
      return;
    }
    timelineRequests += 1;
    if (timelineRequests === 1) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as {
        entries?: unknown[];
        hasMore?: boolean;
      };
      expect(value.entries).toHaveLength(100);
      expect(value.hasMore).toBe(true);
      stalePageCaptured = true;
      await stalePageRelease;
      await route.fulfill({ response: upstream, json: value });
      return;
    }
    if (timelineRequests === 2) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as {
        entries?: unknown[];
        hasMore?: boolean;
      };
      expect(value.entries).toHaveLength(100);
      expect(value.hasMore).toBe(true);
      retryFirstPageSeen = true;
      await route.fulfill({ response: upstream, json: value });
      return;
    }
    if (timelineRequests === 3) {
      retryTerminalHeld = true;
      await terminalPageRelease;
    }
    await route.continue();
  });

  try {
    await appendSyntheticBurst(testInfo, fixture.invalidationEventId, 101);
    await expect.poll(() => stalePageCaptured, { timeout: 7_000 }).toBe(true);
    await page
      .getByLabel('Update text')
      .fill('Mutation committed while a stale continuation was held');
    await page.getByRole('button', { name: 'Post update' }).press('Enter');
    await expect(page.locator('.mutation-status')).toContainText(
      'timeline post confirmed by the server.',
    );
    releaseStalePage();
    await expect.poll(() => retryFirstPageSeen).toBe(true);
    await expect.poll(() => retryTerminalHeld).toBe(true);
    await expect(page.locator('.timeline-panel')).toContainText(
      'Timeline content remains hidden until all authorized history',
    );
    await expect(
      page.getByText('Mutation committed while a stale continuation was held', {
        exact: true,
      }),
    ).toHaveCount(0);
    releaseTerminalPage();
    await expect(page.locator('.timeline-entry')).toHaveCount(105);
    await expect(
      page.getByText('Mutation committed while a stale continuation was held', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    releaseStalePage();
    releaseTerminalPage();
  }
  await page.unrouteAll({ behavior: 'wait' });
});

test('composer, correction, and redaction remain keyboard-operable and append provenance', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.keyboardEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(3);

  const hoverTarget = page.getByRole('button', { name: 'Correct entry 1' });
  await hoverTarget.hover();
  const hoveredColors = await hoverTarget.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(
    contrastRatio(hoveredColors.color, hoveredColors.background),
    'secondary-button hover text must meet WCAG 2.2 AA contrast',
  ).toBeGreaterThanOrEqual(4.5);

  const composer = page.getByLabel('Update text');
  await composer.focus();
  await composer.fill('Keyboard-authored timeline update');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Post update' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.mutation-status')).toContainText(
    'timeline post confirmed by the server.',
  );
  await expect(
    page.getByText('Keyboard-authored timeline update', { exact: true }),
  ).toBeVisible();

  const correct = page.getByRole('button', { name: 'Correct entry 1' });
  await correct.press('Enter');
  const correctionDialog = page.getByRole('dialog');
  await expect(correctionDialog).toBeVisible();
  await expect(correctionDialog).toContainText('DRILL — TRAINING ONLY');
  await expect(page.getByLabel('Corrected text')).toBeFocused();
  await expectAxeClean(page, 'keyboard correction dialog');
  await page.getByLabel('Corrected text').fill('Append-only corrected text');
  await page
    .getByLabel('Reason for correction')
    .fill('Synthetic accuracy correction');
  await page.getByRole('button', { name: 'Append correction' }).press('Enter');
  await expect(
    page.getByText('Append-only corrected text', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Entry 1: Text update' }),
  ).toContainText('This original entry was superseded, not deleted.');
  await expect(
    page.getByRole('article', { name: 'Entry 5: Text update' }),
  ).toContainText('Reason: Synthetic accuracy correction');

  await page.getByRole('button', { name: 'Redact entry 1' }).press('Enter');
  const redactionDialog = page.getByRole('dialog');
  await expect(redactionDialog).toContainText('DRILL — TRAINING ONLY');
  await expect(page.getByLabel('Reason for redaction')).toBeFocused();
  await page
    .getByLabel('Reason for redaction')
    .fill('Synthetic privacy-safe redaction');
  await page.getByRole('button', { name: 'Append redaction' }).press('Enter');
  const original = page.getByRole('article', {
    name: 'Entry 1: Text update',
  });
  await expect(original).toContainText(
    'Original content is hidden because a later append-only redaction supersedes this entry.',
  );
  await expect(original).not.toContainText('Synthetic ordered history 001');
  await expect(
    page.getByRole('article', { name: 'Entry 6: Text update' }),
  ).toContainText('Reason: Synthetic privacy-safe redaction');
  await expectAxeClean(page, 'event room after correction and redaction');
});

test('same-event but unrelated journal evidence never clears post, correction, or redaction recovery', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.journalEvidenceEventId));
  const unrelatedEntry = await page.evaluate(async (eventId) => {
    const response = await fetch(`/events/${encodeURIComponent(eventId)}/api`, {
      credentials: 'same-origin',
    });
    const value = (await response.json()) as { entries?: unknown[] };
    return value.entries?.[0] ?? null;
  }, fixture.journalEvidenceEventId);
  expect(unrelatedEntry).not.toBeNull();

  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.journalEvidenceEventId) &&
      (body?.operation === 'post-text' ||
        body?.operation === 'correct-text' ||
        body?.operation === 'redact-entry')
    ) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as Record<string, unknown>;
      await route.fulfill({
        response: upstream,
        json: { ...value, entry: unrelatedEntry },
      });
      return;
    }
    await route.continue();
  });

  const expectUnresolvedAndClear = async (): Promise<void> => {
    await expect(
      page.getByRole('heading', {
        name: 'Previous request needs verification',
      }),
    ).toBeVisible();
    const error = page.locator('.event-room > .error-panel');
    await expect(error).toContainText(
      'returned journal evidence for a different request',
    );
    await expect(error).toBeFocused();
    await expect(page.locator('.event-room > .mutation-status')).toContainText(
      'The outcome is unresolved.',
    );
    await page
      .getByRole('button', {
        name: 'I verified the timeline — clear browser recovery record',
      })
      .press('Enter');
    await expect(
      page.getByRole('heading', {
        name: 'Previous request needs verification',
      }),
    ).toHaveCount(0);
  };

  await page.getByLabel('Update text').fill('Exact post evidence required');
  await page.getByRole('button', { name: 'Post update' }).press('Enter');
  await expectUnresolvedAndClear();

  await page.getByRole('button', { name: 'Correct entry 1' }).press('Enter');
  await page.getByLabel('Corrected text').fill('Exact correction required');
  await page
    .getByLabel('Reason for correction')
    .fill('Synthetic evidence mismatch');
  await page.getByRole('button', { name: 'Append correction' }).press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expectUnresolvedAndClear();

  await page.getByRole('button', { name: 'Redact entry 1' }).press('Enter');
  await page
    .getByLabel('Reason for redaction')
    .fill('Synthetic evidence mismatch');
  await page.getByRole('button', { name: 'Append redaction' }).press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expectUnresolvedAndClear();
  await page.unrouteAll({ behavior: 'wait' });
});

test('a lost committed response never replays automatically and retries the exact idempotent command only on explicit keyboard action', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const attempts: Array<Readonly<{ body: string; idempotencyKey: string }>> =
    [];
  await page.route('**/events/*/api', async (route) => {
    if (
      route.request().method() !== 'POST' ||
      !route.request().url().includes(fixture.recoveryEventId)
    ) {
      await route.continue();
      return;
    }
    attempts.push({
      body: route.request().postData() ?? '',
      idempotencyKey: route.request().headers()['idempotency-key'] ?? 'missing',
    });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.recoveryEventId));
  await page.getByLabel('Update text').fill('Exactly-once response-loss post');
  await page.getByRole('button', { name: 'Post update' }).click();
  await expect(page.locator('.mutation-status')).toContainText(
    'The outcome is unresolved.',
  );
  expect(attempts).toHaveLength(1);

  await page.reload();
  const retry = page.getByRole('button', {
    name: 'Retry exact retained request',
  });
  await expect(retry).toBeVisible();
  await expect(
    page.getByText('PSD EOC will never replay it automatically.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(attempts).toHaveLength(1);
  await retry.press('Enter');
  await expect(page.locator('.mutation-status')).toContainText(
    'timeline post confirmed by the server.',
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(
    page.getByText('Exactly-once response-loss post', { exact: true }),
  ).toHaveCount(1);
  await page.unrouteAll({ behavior: 'wait' });
});

test('a retained command owned by another session is blocked without sending or exposing retry', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let postCount = 0;
  await page.route('**/events/*/api', async (route) => {
    if (route.request().method() === 'POST') postCount += 1;
    await route.continue();
  });
  await page.goto(fixturePath(fixture.recoveryOwnerEventId));
  await page.evaluate((eventId) => {
    const body = {
      operation: 'post-text',
      text: 'Mismatched owner command must never send',
      clientTime: new Date().toISOString(),
    };
    sessionStorage.setItem(
      `psd-eoc:event-room:pending:v1:${eventId}`,
      JSON.stringify({
        version: 1,
        eventId,
        apiUrl: `/events/${eventId}/api`,
        ownerSessionId: '00000000-0000-4000-8000-000000000999',
        operation: 'post-text',
        idempotencyKey: `event-room-owner-mismatch-${crypto.randomUUID()}`,
        bodyJson: JSON.stringify(body),
        createdAt: new Date().toISOString(),
      }),
    );
  }, fixture.recoveryOwnerEventId);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Previous request needs verification' }),
  ).toBeVisible();
  await expect(
    page.getByText('The browser recovery record is unreadable.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry exact retained request' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Update text')).toBeDisabled();
  await page.waitForTimeout(1_000);
  expect(postCount).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('same-ID real-to-drill poll data fails closed without changing the room classification', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let classificationSwapReturned = false;
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith(`/${fixture.realDraftEventId}/api`) &&
      url.searchParams.get('operation') === null
    ) {
      url.searchParams.delete('cursor');
      const upstream = await route.fetch({ url: url.toString() });
      const value = (await upstream.json()) as Record<string, unknown>;
      const event = value.event as Record<string, unknown>;
      classificationSwapReturned = true;
      await route.fulfill({
        response: upstream,
        json: {
          ...value,
          event: {
            ...event,
            kind: 'drill',
            templateMode: 'drill',
            eventTypeVersion: {
              id: '00000000-0000-4000-8000-000000000201',
              templateMode: 'drill',
            },
          },
        },
      });
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.realDraftEventId));
  await expect.poll(() => classificationSwapReturned).toBe(true);
  await expect(page.locator('.classification-banner')).toContainText(
    'REAL INCIDENT',
  );
  await expect(page.locator('.classification-banner')).not.toContainText(
    'TRAINING ONLY',
  );
  await expect(page.locator('.timeline-panel')).toContainText(
    'PSD EOC returned event identity or classification that does not match this room.',
  );
  await page.unrouteAll({ behavior: 'wait' });
});

test('real and drill event rooms use unmistakably different words and symbols', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.realDraftEventId));
  const realBanner = page.locator('.classification-banner');
  await expect(realBanner).toContainText('⚠');
  await expect(realBanner).toContainText('REAL INCIDENT');
  await expect(realBanner).not.toContainText('TRAINING ONLY');
  await expectAxeClean(page, 'real incident event room');

  await page.goto(fixturePath(fixture.keyboardEventId));
  const drillBanner = page.locator('.classification-banner');
  await expect(drillBanner).toContainText('◆');
  await expect(drillBanner).toContainText('DRILL — TRAINING ONLY');
  await expect(drillBanner).not.toContainText('REAL INCIDENT');
});

test('all-clear preview is POST-only, CSRF-protected, and exactly idempotent without GET writes', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.lifecycleEventId));
  const before = await lifecyclePreviewIds(testInfo, fixture.lifecycleEventId);

  const getResult = await page.evaluate(async (eventId) => {
    const response = await fetch(
      `/events/${encodeURIComponent(eventId)}/api?operation=preview-all-clear`,
      { credentials: 'same-origin' },
    );
    return { status: response.status, body: await response.text() };
  }, fixture.lifecycleEventId);
  expect(getResult.status).toBe(400);
  expect(await lifecyclePreviewIds(testInfo, fixture.lifecycleEventId)).toEqual(
    before,
  );

  const idempotencyKey = `event-room-preview-${randomUUID()}`;
  const missingCsrf = await postPreview(
    page,
    fixture.lifecycleEventId,
    idempotencyKey,
    false,
  );
  expect(missingCsrf.status).toBe(403);
  expect(await lifecyclePreviewIds(testInfo, fixture.lifecycleEventId)).toEqual(
    before,
  );

  const first = await postPreview(
    page,
    fixture.lifecycleEventId,
    idempotencyKey,
    true,
  );
  const replay = await postPreview(
    page,
    fixture.lifecycleEventId,
    idempotencyKey,
    true,
  );
  expect(first.status).toBe(200);
  expect(first.acknowledgedIdempotencyKey).toBe(idempotencyKey);
  expect(replay).toEqual(first);
  const after = await lifecyclePreviewIds(testInfo, fixture.lifecycleEventId);
  expect(after).toHaveLength(before.length + 1);
});

test('a blocked all-clear preview keeps classification visible and an operable keyboard dismissal', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.stalledPreviewEventId) &&
      body?.operation === 'preview-all-clear'
    ) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as Record<string, unknown>;
      const preview = value.preview as Record<string, unknown>;
      const channels = preview.channels as Array<Record<string, unknown>>;
      await route.fulfill({
        response: upstream,
        json: {
          ...value,
          preview: {
            ...preview,
            recipientCount: 0,
            channels: channels.map((channel) => ({
              ...channel,
              endpointCount: 0,
            })),
            sendReadiness: 'blocked',
            blockingReasonCodes: ['NO_RECIPIENTS'],
          },
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.stalledPreviewEventId));
  const opener = page.getByRole('button', { name: 'Review all-clear' });
  await opener.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('DRILL — TRAINING ONLY');
  await expect(dialog).toContainText('Sending is blocked.');
  await expect(page.getByLabel('Type ALL CLEAR exactly')).toBeDisabled();
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeEnabled();
  await expect(cancel).toBeFocused();
  await expectAxeClean(page, 'blocked all-clear consequence dialog');
  await cancel.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await page.unrouteAll({ behavior: 'wait' });
});

test('a delayed pre-mutation snapshot cannot regress a confirmed all-clear or its cursor', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let releasePoll: () => void = () => undefined;
  let pollCaptured = false;
  const pollRelease = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let releaseRetry: () => void = () => undefined;
  let retryHeld = false;
  const retryRelease = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let eventPolls = 0;
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    const isEventPoll =
      request.method() === 'GET' &&
      new URL(request.url()).pathname.endsWith(
        `/${fixture.stalePollEventId}/api`,
      );
    if (isEventPoll) eventPolls += 1;
    if (isEventPoll && eventPolls === 1) {
      const upstream = await route.fetch();
      const json = await upstream.json();
      pollCaptured = true;
      await pollRelease;
      await route.fulfill({ response: upstream, json });
      return;
    }
    if (isEventPoll && eventPolls === 2) {
      retryHeld = true;
      await retryRelease;
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.stalePollEventId));
  await postExternalUpdate(
    page,
    fixture.stalePollEventId,
    'Snapshot entry captured before all-clear',
    new Date().toISOString(),
  );
  await expect.poll(() => pollCaptured, { timeout: 7_000 }).toBe(true);

  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Notification consequences' }),
  ).toBeVisible();
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');
  await page
    .getByRole('button', { name: 'Issue all-clear and notify' })
    .press('Enter');
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'all-clear confirmed by the server.',
  );
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');

  releasePoll();
  await expect.poll(() => retryHeld).toBe(true);
  await expect(page.locator('.timeline-panel')).toContainText(
    'Timeline content remains hidden until all authorized history',
  );
  releaseRetry();
  await expect(
    page.getByText('Snapshot entry captured before all-clear', { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(750);
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  await expect(
    page.getByRole('button', { name: 'Review event close' }),
  ).toBeVisible();
  releaseRetry();
  await page.unrouteAll({ behavior: 'wait' });
});

test('a newer closed poll observed during a delayed all-clear response never regresses to the older mutation projection', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let allClearCommitted = false;
  let releaseAllClear: () => void = () => undefined;
  const allClearRelease = new Promise<void>((resolve) => {
    releaseAllClear = resolve;
  });
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.newerPollEventId) &&
      body?.operation === 'all-clear'
    ) {
      const upstream = await route.fetch();
      allClearCommitted = true;
      await allClearRelease;
      await route.fulfill({ response: upstream });
      return;
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.newerPollEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  const allClearDialog = page.getByRole('dialog');
  await expect(allClearDialog).toContainText('DRILL — TRAINING ONLY');
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');
  await page
    .getByRole('button', { name: 'Issue all-clear and notify' })
    .press('Enter');
  await expect.poll(() => allClearCommitted).toBe(true);

  try {
    await issueExternalClose(page, fixture.newerPollEventId);
    await expect(page.locator('.event-status')).toHaveText('Closed', {
      timeout: 8_000,
    });
    await expect(
      page.getByText('Event closed.', { exact: true }),
    ).toBeVisible();
  } finally {
    releaseAllClear();
  }

  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'all-clear confirmed by the server.',
  );
  await page.waitForTimeout(750);
  await expect(page.locator('.event-status')).toHaveText('Closed');
  await expect(
    page.getByRole('button', { name: 'Review event close' }),
  ).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('polling pauses while hidden, resumes immediately when visible, and keeps one request in flight', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.addInitScript(() => {
    let hidden = true;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    Reflect.set(window, '__eventRoomSetHidden', (next: boolean) => {
      hidden = next;
      document.dispatchEvent(new Event('visibilitychange'));
    });
  });
  let timelineRequests = 0;
  let releaseRequest: () => void = () => undefined;
  const requestRelease = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    if (
      request.method() === 'GET' &&
      request.url().includes(fixture.realDraftEventId)
    ) {
      timelineRequests += 1;
      await requestRelease;
      await route.continue();
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.realDraftEventId));
  await page.waitForTimeout(5_250);
  expect(timelineRequests).toBe(0);
  await page.evaluate(() => {
    const setHidden = Reflect.get(window, '__eventRoomSetHidden') as (
      hidden: boolean,
    ) => void;
    setHidden(false);
  });
  await expect.poll(() => timelineRequests, { timeout: 2_000 }).toBe(1);
  await page.waitForTimeout(5_250);
  expect(timelineRequests).toBe(1);
  releaseRequest();
  await page.unrouteAll({ behavior: 'wait' });
});

test('timeline polling aborts at its deadline without overlapping or replaying', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let timelineRequests = 0;
  let releaseRequest: () => void = () => undefined;
  const requestRelease = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await page.route('**/events/*/api**', async (route) => {
    if (
      route.request().method() === 'GET' &&
      route.request().url().includes(fixture.realDraftEventId)
    ) {
      timelineRequests += 1;
      await requestRelease;
      await route.abort('timedout').catch(() => undefined);
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.realDraftEventId));
  await expect(page.locator('.timeline-panel')).toContainText(
    'Timeline refresh timed out.',
    { timeout: 16_000 },
  );
  expect(timelineRequests).toBe(1);
  releaseRequest();
  await page.unrouteAll({ behavior: 'wait' });
});

test('a stalled preview is bounded and its loading dialog always has an immediate cancel', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let releasePreview: () => void = () => undefined;
  const previewRelease = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.stalledPreviewEventId) &&
      body?.operation === 'preview-all-clear'
    ) {
      await previewRelease;
      await route.abort('timedout').catch(() => undefined);
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.stalledPreviewEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  const cancel = page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeEnabled();
  await cancel.press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await expect(page.getByRole('dialog')).toContainText(
    'The all-clear preview timed out.',
    { timeout: 12_000 },
  );
  releasePreview();
  await page.unrouteAll({ behavior: 'wait' });
});

test('a stalled POST becomes ambiguous at its deadline and is never automatically replayed', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let mutationRequests = 0;
  let releaseMutation: () => void = () => undefined;
  const mutationRelease = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.stalledMutationEventId) &&
      body?.operation === 'post-text'
    ) {
      mutationRequests += 1;
      await mutationRelease;
      await route.abort('timedout').catch(() => undefined);
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.stalledMutationEventId));
  await page.getByLabel('Update text').fill('Stalled retained mutation');
  await page.getByRole('button', { name: 'Post update' }).press('Enter');
  await expect(page.locator('.mutation-status')).toContainText(
    'The outcome is unresolved.',
    { timeout: 18_000 },
  );
  expect(mutationRequests).toBe(1);
  await page.waitForTimeout(1_000);
  expect(mutationRequests).toBe(1);
  await expect(
    page.getByRole('heading', { name: 'Previous request needs verification' }),
  ).toBeVisible();
  releaseMutation();
  await page.unrouteAll({ behavior: 'wait' });
});

test('malformed lifecycle success retains recovery evidence and never announces confirmation', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.malformedLifecycleEventId) &&
      body?.operation === 'all-clear'
    ) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as Record<string, unknown>;
      await route.fulfill({
        response: upstream,
        json: { ...value, notificationIntent: null },
      });
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.malformedLifecycleEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await expect(page.getByLabel('Type ALL CLEAR exactly')).toBeVisible();
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');
  await page
    .getByRole('button', { name: 'Issue all-clear and notify' })
    .press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Previous request needs verification' }),
  ).toBeVisible();
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'The outcome is unresolved.',
  );
  await expect(page.locator('.event-room > .error-panel')).toBeFocused();
  await expect(
    page.locator('.event-room > .mutation-status'),
  ).not.toContainText('confirmed by the server');
  await page.unrouteAll({ behavior: 'wait' });
});

test('a successful lifecycle response with a mismatched request acknowledgement remains unresolved', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.staleLifecycleResponseEventId) &&
      body?.operation === 'all-clear'
    ) {
      const upstream = await route.fetch();
      await route.fulfill({
        response: upstream,
        headers: {
          ...upstream.headers(),
          'idempotency-key': `event-room-${randomUUID()}`,
        },
      });
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.staleLifecycleResponseEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await expect(page.getByLabel('Type ALL CLEAR exactly')).toBeVisible();
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');
  await page
    .getByRole('button', { name: 'Issue all-clear and notify' })
    .press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Previous request needs verification' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'The outcome is unresolved.',
  );
  await expect(page.locator('.event-room > .error-panel')).toContainText(
    'did not acknowledge the exact request key',
  );
  await expect(page.locator('.event-room > .error-panel')).toBeFocused();
  await page.unrouteAll({ behavior: 'wait' });
});

test('definite modal failures receive focus and leave an operable explicit retry path', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let rejectOnce = true;
  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      rejectOnce &&
      request.method() === 'POST' &&
      request.url().includes(fixture.dialogFailureEventId) &&
      body?.operation === 'correct-text'
    ) {
      rejectOnce = false;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'CONFLICT',
          message: 'Synthetic definite correction conflict.',
          requestId: randomUUID(),
          retryable: false,
          fieldErrors: [],
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(fixturePath(fixture.dialogFailureEventId));
  await page.getByRole('button', { name: 'Correct entry 1' }).press('Enter');
  await page
    .getByLabel('Corrected text')
    .fill('Corrected after explicit retry');
  await page
    .getByLabel('Reason for correction')
    .fill('Synthetic conflict recovery');
  await page.getByRole('button', { name: 'Append correction' }).press('Enter');
  const dialogAlert = page.getByRole('dialog').getByRole('alert');
  await expect(dialogAlert).toBeVisible();
  await expect(dialogAlert).toBeFocused();
  await expect(dialogAlert).toContainText(
    'Synthetic definite correction conflict.',
  );
  const retry = page.getByRole('button', { name: 'Append correction' });
  await expect(retry).toBeEnabled();
  await retry.press('Enter');
  await expect(
    page.getByText('Corrected after explicit retry', { exact: true }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
});

test('synthetic all-clear requires preview and exact typed confirmation, appends fan-out truth, then requires typed close', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.lifecycleEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Notification consequences' }),
  ).toBeVisible();
  const allClearDialog = page.getByRole('dialog');
  await expect(allClearDialog).toContainText('DRILL — TRAINING ONLY');
  await expect(
    page.getByText('4 authorized roster recipients', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Roster population: synthetic (provably unroutable training data)',
      { exact: true },
    ),
  ).toBeVisible();
  for (const channel of ['PUSH', 'EMAIL']) {
    const summary = page.locator('summary').filter({
      hasText: new RegExp(`^${channel}: 4 endpoints — mocked$`, 'u'),
    });
    await expect(summary.locator('xpath=..')).toHaveAttribute('open', '');
  }
  await expect(
    page.getByText(/\[DRILL\] TRAINING ONLY - ALL CLEAR/u).first(),
  ).toBeVisible();
  await expectAxeClean(page, 'all-clear consequence dialog');

  const phrase = page.getByLabel('Type ALL CLEAR exactly');
  const issueAllClear = page.getByRole('button', {
    name: 'Issue all-clear and notify',
  });
  await expect(phrase).toBeFocused();
  await phrase.fill('ALL-CLEAR');
  await expect(issueAllClear).toBeDisabled();
  await phrase.fill('ALL CLEAR');
  await issueAllClear.press('Enter');
  await expect(
    page.getByText('All-clear issued.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Notification fan-out intent recorded.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  const reviewClose = page.getByRole('button', {
    name: 'Review event close',
  });
  await expect(reviewClose).toBeEnabled();
  await reviewClose.press('Enter');
  const closeDialog = page.getByRole('dialog');
  await expect(closeDialog).toBeVisible();
  await expect(closeDialog).toContainText('DRILL — TRAINING ONLY');
  const closePhrase = page.getByLabel('Type CLOSE EVENT exactly');
  await expect(closePhrase).toBeFocused();
  await expectAxeClean(page, 'close consequence dialog');
  await closeDialog.getByRole('button', { name: 'Cancel' }).press('Enter');
  await expect(closeDialog).not.toBeVisible();
  await expect(reviewClose).toBeFocused();
  await reviewClose.press('Enter');
  await expect(closePhrase).toBeFocused();
  const closeEvent = page.getByRole('button', { name: 'Close event' });
  await closePhrase.fill('CLOSE');
  await expect(closeEvent).toBeDisabled();
  await closePhrase.fill('CLOSE EVENT');
  await closeEvent.press('Enter');
  await expect(page.getByText('Event closed.', { exact: true })).toBeVisible();
  await expect(page.locator('.event-status')).toHaveText('Closed');
  await expectAxeClean(page, 'closed synthetic event room');
});
