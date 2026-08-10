import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  ApiErrorSchema,
  CreateMediaUploadIntentInputSchema,
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
  type CreateMediaUploadIntentInput,
} from '@psd-eoc/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { EVENT_ROOM_PLAYWRIGHT_FIXTURE_PATH } from './test-database';

const AXE_VERSION = '4.10.3';
const AXE_URL = `https://cdn.jsdelivr.net/npm/axe-core@${AXE_VERSION}/axe.min.js`;
const AXE_SHA256 =
  '880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb';
const SYNTHETIC_MEDIA_ORIGIN = 'https://private-media.example.test';
const SYNTHETIC_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const SYNTHETIC_DISGUISED_NON_IMAGE = Buffer.from(
  'Synthetic text intentionally disguised as image/png.',
  'utf8',
);
const SYNTHETIC_PNG_SHA256 = createHash('sha256')
  .update(SYNTHETIC_PNG)
  .digest('hex');

interface EventRoomFixture {
  readonly sessionId: string;
  readonly historyEventId: string;
  readonly keyboardEventId: string;
  readonly recoveryEventId: string;
  readonly recoveryOwnerEventId: string;
  readonly lifecycleEventId: string;
  readonly realDraftEventId: string;
  readonly photoEventId: string;
  readonly photoMediaId: string;
  readonly photoUploadMediaId: string;
  readonly photoSanitizedSha256: string;
  readonly photoStressEventId: string;
  readonly photoStressMiddleMediaId: string;
  readonly redactedPhotoEventId: string;
  readonly redactedPhotoMediaId: string;
}

type CompletionOutcome =
  | 'malformed'
  | 'ready'
  | 'scan-pending'
  | 'unreadable-rate-limit'
  | 'server-nonretryable';

interface SyntheticMediaRouteOptions {
  readonly eventId: string;
  readonly uploadIntentId: string;
  readonly mediaId: string;
  readonly sanitizedSha256: string;
  readonly completionOutcomes?: readonly CompletionOutcome[];
  readonly holdImageResponses?: boolean;
  readonly holdReadGrants?: boolean;
}

interface SyntheticMediaRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

interface SyntheticMediaLog {
  readonly stages: string[];
  readonly createInputs: CreateMediaUploadIntentInput[];
  readonly createRequests: SyntheticMediaRequest[];
  readonly uploadRequests: Array<
    SyntheticMediaRequest & Readonly<{ body: Buffer }>
  >;
  readonly completionRequests: Array<
    SyntheticMediaRequest & Readonly<{ body: string | null }>
  >;
  readonly readGrantRequests: Array<
    SyntheticMediaRequest &
      Readonly<{ eventId: string; mediaId: string; readUrl: string }>
  >;
  readonly imageRequests: SyntheticMediaRequest[];
  concurrentImageRequests: number;
  concurrentReadGrantRequests: number;
  maxConcurrentImageRequests: number;
  maxConcurrentReadGrantRequests: number;
  readonly releaseImageResponses: () => void;
  readonly releaseReadGrants: () => void;
}

interface PrivatePhotoIntersectionProbe {
  readonly disconnectCalls: number;
  readonly observeCalls: number;
}

interface PrivatePhotoDecodeProbe {
  readonly active: number;
  readonly maxActive: number;
  readonly pendingAltText: readonly string[];
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

async function readFixture(): Promise<EventRoomFixture> {
  const parsed: unknown = JSON.parse(
    await readFile(EVENT_ROOM_PLAYWRIGHT_FIXTURE_PATH, 'utf8'),
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

async function installDeterministicIntersectionObserver(
  page: Page,
): Promise<void> {
  await page.addInitScript(() => {
    interface ObserverRecord {
      readonly callback: IntersectionObserverCallback;
      readonly observer: IntersectionObserver;
      readonly targets: Set<Element>;
      connected: boolean;
    }

    const records: ObserverRecord[] = [];
    let disconnectCalls = 0;
    let observeCalls = 0;

    class DeterministicIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null;
      readonly rootMargin: string;
      readonly thresholds: readonly number[];
      readonly record: ObserverRecord;

      constructor(
        callback: IntersectionObserverCallback,
        options: IntersectionObserverInit = {},
      ) {
        this.root = options.root ?? null;
        this.rootMargin = options.rootMargin ?? '0px';
        this.thresholds = Array.isArray(options.threshold)
          ? options.threshold
          : [options.threshold ?? 0];
        this.record = {
          callback,
          observer: this,
          targets: new Set<Element>(),
          connected: true,
        };
        records.push(this.record);
      }

      disconnect(): void {
        disconnectCalls += 1;
        this.record.connected = false;
        this.record.targets.clear();
      }

      observe(target: Element): void {
        observeCalls += 1;
        this.record.connected = true;
        this.record.targets.add(target);
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }

      unobserve(target: Element): void {
        this.record.targets.delete(target);
      }
    }

    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: DeterministicIntersectionObserver,
      writable: true,
    });
    Object.defineProperty(window, '__privatePhotoIntersectionProbe', {
      configurable: true,
      value: {
        stats: () => ({ disconnectCalls, observeCalls }),
        trigger: (target: Element, isIntersecting: boolean) => {
          const bounds = target.getBoundingClientRect();
          for (const record of records) {
            if (!record.connected || !record.targets.has(target)) continue;
            record.callback(
              [
                {
                  boundingClientRect: bounds,
                  intersectionRatio: isIntersecting ? 1 : 0,
                  intersectionRect: isIntersecting
                    ? bounds
                    : new DOMRectReadOnly(),
                  isIntersecting,
                  rootBounds: null,
                  target,
                  time: performance.now(),
                },
              ],
              record.observer,
            );
          }
        },
      },
    });
  });
}

async function privatePhotoIntersectionStats(
  page: Page,
): Promise<PrivatePhotoIntersectionProbe> {
  return page.evaluate(() =>
    (
      window as typeof window & {
        __privatePhotoIntersectionProbe: {
          stats(): PrivatePhotoIntersectionProbe;
        };
      }
    ).__privatePhotoIntersectionProbe.stats(),
  );
}

async function triggerPrivatePhotoIntersection(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    (
      window as typeof window & {
        __privatePhotoIntersectionProbe: {
          trigger(target: Element, isIntersecting: boolean): void;
        };
      }
    ).__privatePhotoIntersectionProbe.trigger(element, true);
  });
}

async function installControllableImageDecode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface PendingDecode {
      readonly altText: string;
      readonly settleSuccess: () => void;
    }

    const pending: PendingDecode[] = [];
    let active = 0;
    let maxActive = 0;
    HTMLImageElement.prototype.decode = function decode(): Promise<void> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const altText = this.alt;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const originalRemoveAttribute = this.removeAttribute;
        const settle = (succeeded: boolean) => {
          if (settled) return;
          settled = true;
          const index = pending.findIndex(
            (candidate) => candidate.settleSuccess === settleSuccess,
          );
          if (index >= 0) pending.splice(index, 1);
          active -= 1;
          Reflect.deleteProperty(this, 'removeAttribute');
          if (succeeded) {
            resolve();
          } else {
            reject(
              new DOMException('Synthetic decode cancelled.', 'AbortError'),
            );
          }
        };
        const settleSuccess = () => settle(true);
        Object.defineProperty(this, 'removeAttribute', {
          configurable: true,
          value: function removeAttribute(
            this: HTMLImageElement,
            name: string,
          ): void {
            if (name.toLowerCase() === 'src') settle(false);
            originalRemoveAttribute.call(this, name);
          },
        });
        pending.push({ altText, settleSuccess });
      });
    };
    Object.defineProperty(window, '__privatePhotoDecodeProbe', {
      configurable: true,
      value: {
        release: (altText: string) => {
          const index = pending.findIndex(
            (candidate) => candidate.altText === altText,
          );
          const selected = index < 0 ? undefined : pending.splice(index, 1)[0];
          if (selected === undefined) return false;
          selected.settleSuccess();
          return true;
        },
        stats: () => ({
          active,
          maxActive,
          pendingAltText: pending.map((candidate) => candidate.altText),
        }),
      },
    });
  });
}

async function privatePhotoDecodeStats(
  page: Page,
): Promise<PrivatePhotoDecodeProbe> {
  return page.evaluate(() =>
    (
      window as typeof window & {
        __privatePhotoDecodeProbe: {
          stats(): PrivatePhotoDecodeProbe;
        };
      }
    ).__privatePhotoDecodeProbe.stats(),
  );
}

async function releasePrivatePhotoDecode(
  page: Page,
  altText: string,
): Promise<boolean> {
  return page.evaluate(
    (targetAltText) =>
      (
        window as typeof window & {
          __privatePhotoDecodeProbe: {
            release(value: string): boolean;
          };
        }
      ).__privatePhotoDecodeProbe.release(targetAltText),
    altText,
  );
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

function mediaTimestampWindow(): Readonly<{
  createdAt: string;
  expiresAt: string;
}> {
  const createdAt = new Date();
  return {
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 2 * 60_000).toISOString(),
  };
}

async function installSyntheticMediaRoutes(
  page: Page,
  options: SyntheticMediaRouteOptions,
): Promise<SyntheticMediaLog> {
  let holdImageResponses = options.holdImageResponses ?? false;
  let holdReadGrants = options.holdReadGrants ?? false;
  const pendingImageResponses: Array<() => void> = [];
  const pendingReadGrants: Array<() => void> = [];
  const releaseImageResponses = () => {
    holdImageResponses = false;
    for (const release of pendingImageResponses.splice(0)) release();
  };
  const releaseReadGrants = () => {
    holdReadGrants = false;
    for (const release of pendingReadGrants.splice(0)) release();
  };
  const log: SyntheticMediaLog = {
    stages: [],
    createInputs: [],
    createRequests: [],
    uploadRequests: [],
    completionRequests: [],
    readGrantRequests: [],
    imageRequests: [],
    concurrentImageRequests: 0,
    concurrentReadGrantRequests: 0,
    maxConcurrentImageRequests: 0,
    maxConcurrentReadGrantRequests: 0,
    releaseImageResponses,
    releaseReadGrants,
  };
  const completionOutcomes = options.completionOutcomes ?? ['ready'];
  let completionAttempt = 0;
  let grantSequence = 0;

  await page.route('**/api/media/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();

    if (
      request.method() === 'POST' &&
      url.pathname === '/api/media/upload-intents'
    ) {
      const input = CreateMediaUploadIntentInputSchema.parse(
        request.postDataJSON() as unknown,
      );
      log.stages.push('create-intent');
      log.createInputs.push(input);
      log.createRequests.push({ headers, url: request.url() });
      const times = mediaTimestampWindow();
      await route.fulfill({
        contentType: 'application/json',
        json: MediaUploadIntentSchema.parse({
          id: options.uploadIntentId,
          eventId: options.eventId,
          byteLength: input.byteLength,
          contentSha256: input.contentSha256,
          declaredContentType: input.declaredContentType,
          uploadMethod: 'PUT',
          uploadUrl: `${SYNTHETIC_MEDIA_ORIGIN}/quarantine/${options.eventId}/${options.uploadIntentId}?signature=synthetic`,
          status: 'pending-upload',
          ...times,
        }),
      });
      return;
    }

    const completionMatch =
      /^\/api\/media\/upload-intents\/([^/]+)\/complete$/u.exec(url.pathname);
    if (request.method() === 'POST' && completionMatch !== null) {
      expect(decodeURIComponent(completionMatch[1] ?? '')).toBe(
        options.uploadIntentId,
      );
      log.stages.push('complete-upload');
      log.completionRequests.push({
        body: request.postData(),
        headers,
        url: request.url(),
      });
      const outcome =
        completionOutcomes[
          Math.min(completionAttempt, completionOutcomes.length - 1)
        ] ?? 'ready';
      completionAttempt += 1;
      if (outcome === 'malformed') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          json: ApiErrorSchema.parse({
            code: 'VALIDATION_ERROR',
            message:
              'The image could not be safely processed. Choose a different image and try again.',
            requestId: randomUUID(),
            retryable: false,
            fieldErrors: [],
          }),
        });
        return;
      }
      if (outcome === 'unreadable-rate-limit') {
        await route.fulfill({
          status: 429,
          contentType: 'text/html',
          body: '<p>Synthetic unreadable rate-limit response</p>',
        });
        return;
      }
      if (outcome === 'server-nonretryable') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          json: ApiErrorSchema.parse({
            code: 'INTERNAL_ERROR',
            message: 'Synthetic upstream failure with an unsafe retry hint.',
            requestId: randomUUID(),
            retryable: false,
            fieldErrors: [],
          }),
        });
        return;
      }
      if (outcome === 'scan-pending') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          json: ApiErrorSchema.parse({
            code: 'CONFLICT',
            message:
              'The photo safety scan is still pending. Try again shortly.',
            requestId: randomUUID(),
            retryable: true,
            fieldErrors: [],
          }),
        });
        return;
      }
      const times = mediaTimestampWindow();
      await route.fulfill({
        contentType: 'application/json',
        json: MediaRecordSchema.parse({
          id: options.mediaId,
          uploadIntentId: options.uploadIntentId,
          eventId: options.eventId,
          status: 'ready',
          detectedContentType: 'image/png',
          sanitizedByteLength: SYNTHETIC_PNG.byteLength,
          sanitizedContentSha256: options.sanitizedSha256,
          malwareScan: 'clean',
          exifStripped: true,
          createdAt: times.createdAt,
        }),
      });
      return;
    }

    const readMatch =
      /^\/api\/media\/events\/([^/]+)\/([^/]+)\/read-grant$/u.exec(
        url.pathname,
      );
    if (request.method() === 'GET' && readMatch !== null) {
      const eventId = decodeURIComponent(readMatch[1] ?? '');
      const mediaId = decodeURIComponent(readMatch[2] ?? '');
      log.concurrentReadGrantRequests += 1;
      log.maxConcurrentReadGrantRequests = Math.max(
        log.maxConcurrentReadGrantRequests,
        log.concurrentReadGrantRequests,
      );
      grantSequence += 1;
      const readUrl = `${SYNTHETIC_MEDIA_ORIGIN}/ready/${eventId}/${mediaId}?grant=${grantSequence}`;
      log.stages.push('read-grant');
      log.readGrantRequests.push({
        eventId,
        headers,
        mediaId,
        readUrl,
        url: request.url(),
      });
      try {
        if (holdReadGrants) {
          await new Promise<void>((resolve) => pendingReadGrants.push(resolve));
        }
        const times = mediaTimestampWindow();
        await route.fulfill({
          contentType: 'application/json',
          json: MediaReadGrantSchema.parse({
            eventId,
            mediaId,
            readUrl,
            issuedAt: times.createdAt,
            expiresAt: times.expiresAt,
          }),
        });
      } finally {
        log.concurrentReadGrantRequests -= 1;
      }
      return;
    }

    throw new Error(
      `Unexpected synthetic media request: ${request.method()} ${url.pathname}`,
    );
  });

  await page.route(`${SYNTHETIC_MEDIA_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    const requestOrigin = headers['origin'] ?? 'http://localhost';
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'PUT',
          'Access-Control-Allow-Origin': requestOrigin,
          'Access-Control-Max-Age': '600',
        },
      });
      return;
    }
    if (request.method() === 'PUT' && url.pathname.startsWith('/quarantine/')) {
      log.stages.push('upload-bytes');
      log.uploadRequests.push({
        body: request.postDataBuffer() ?? Buffer.alloc(0),
        headers,
        url: request.url(),
      });
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': requestOrigin,
          ETag: '"synthetic-private-upload"',
        },
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname.startsWith('/ready/')) {
      log.concurrentImageRequests += 1;
      log.maxConcurrentImageRequests = Math.max(
        log.maxConcurrentImageRequests,
        log.concurrentImageRequests,
      );
      log.stages.push('read-image');
      log.imageRequests.push({ headers, url: request.url() });
      try {
        if (holdImageResponses) {
          await new Promise<void>((resolve) =>
            pendingImageResponses.push(resolve),
          );
        }
        await route.fulfill({
          status: 200,
          body: SYNTHETIC_PNG,
          contentType: 'image/png',
          headers: {
            'Cache-Control': 'private, no-store',
          },
        });
      } finally {
        log.concurrentImageRequests -= 1;
      }
      return;
    }
    throw new Error(
      `Unexpected synthetic object-store request: ${request.method()} ${url.pathname}`,
    );
  });
  return log;
}

test('late join drains complete ordered history, polls a stable cursor, batches announcements, and is axe-clean', async ({
  page,
}) => {
  const fixture = await readFixture();
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

test('composer, correction, and redaction remain keyboard-operable and append provenance', async ({
  page,
}) => {
  const fixture = await readFixture();
  await page.goto(fixturePath(fixture.keyboardEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(3);

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
  await expect(page.getByRole('dialog')).toBeVisible();
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

  await page.getByRole('button', { name: 'Redact entry 2' }).press('Enter');
  await expect(page.getByLabel('Reason for redaction')).toBeFocused();
  await page
    .getByLabel('Reason for redaction')
    .fill('Synthetic privacy-safe redaction');
  await page.getByRole('button', { name: 'Append redaction' }).press('Enter');
  const original = page.getByRole('article', {
    name: 'Entry 2: Text update',
  });
  await expect(original).toContainText(
    'Original content is hidden because a later append-only redaction supersedes this entry.',
  );
  await expect(original).not.toContainText('Synthetic ordered history 002');
  await expect(
    page.getByRole('article', { name: 'Entry 6: Text update' }),
  ).toContainText('Reason: Synthetic privacy-safe redaction');
  await expectAxeClean(page, 'event room after correction and redaction');
});

test('a private photo receives a fresh authorized read grant after reload', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId: fixture.photoUploadMediaId,
    mediaId: fixture.photoUploadMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoEventId));
  const photo = page.locator('.timeline-entry img').first();
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(photo).toHaveAttribute('src', /[?&]grant=\d+$/u);
  const firstReadUrl = await photo.getAttribute('src');
  expect(firstReadUrl).not.toBeNull();
  await expect.poll(() => media.imageRequests.length).toBeGreaterThanOrEqual(1);
  expect(media.readGrantRequests.length).toBeGreaterThanOrEqual(1);
  expect(
    media.readGrantRequests.every(
      (request) =>
        request.eventId === fixture.photoEventId &&
        request.mediaId === fixture.photoMediaId &&
        request.headers['idempotency-key'] === undefined &&
        request.headers['x-psd-eoc-csrf'] === undefined,
    ),
  ).toBe(true);

  const grantCountBeforeReload = media.readGrantRequests.length;
  await page.reload();
  await expect
    .poll(() => media.readGrantRequests.length)
    .toBeGreaterThan(grantCountBeforeReload);
  await expect(photo).toHaveAttribute('src', /[?&]grant=\d+$/u);
  const reloadedReadUrl = await photo.getAttribute('src');
  expect(reloadedReadUrl).not.toBe(firstReadUrl);
  expect(
    media.readGrantRequests
      .slice(grantCountBeforeReload)
      .map((request) => request.readUrl),
  ).toContain(reloadedReadUrl);
  await expectAxeClean(page, 'authorized private photo after a fresh grant');
});

test('deterministic viewport demand authorizes only the intersecting target with unused automatic capacity', async ({
  page,
}) => {
  await installDeterministicIntersectionObserver(page);
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(12);
  await page.waitForTimeout(250);
  expect(media.readGrantRequests).toHaveLength(0);
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).observeCalls)
    .toBeGreaterThanOrEqual(12);

  const targetEntry = page.getByRole('article', {
    name: 'Entry 6: Photo update',
    exact: true,
  });
  const targetFigure = targetEntry.locator('figure.photo-entry');
  const targetButton = targetEntry.getByRole('button', {
    name: 'Load private photo for entry 6',
  });
  await targetButton.focus();
  await expect(targetButton).toBeFocused();
  await triggerPrivatePhotoIntersection(targetFigure);
  await expect(targetFigure).toBeFocused();
  await expect.poll(() => media.readGrantRequests.length).toBe(1);
  expect(media.readGrantRequests[0]?.mediaId).toBe(
    fixture.photoStressMiddleMediaId,
  );
  await expect(targetFigure).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect(targetFigure).toBeFocused();

  const explicitEntry = page.getByRole('article', {
    name: 'Entry 5: Photo update',
    exact: true,
  });
  const explicitFigure = explicitEntry.locator('figure.photo-entry');
  const explicitButton = explicitEntry.getByRole('button', {
    name: 'Load private photo for entry 5',
  });
  await explicitButton.focus();
  await page.keyboard.press('Enter');
  await expect(explicitFigure).toBeFocused();
  await expect.poll(() => media.readGrantRequests.length).toBe(2);
  await expect(explicitFigure).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect(explicitFigure).toBeFocused();
});

test('offscreen private photos require viewport or explicit demand and automatic work stays capped', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(12);
  await expect
    .poll(() => media.readGrantRequests.length)
    .toBeGreaterThanOrEqual(1);

  const middleEntry = page.getByRole('article', {
    name: 'Entry 6: Photo update',
    exact: true,
  });
  const middleLoadButton = middleEntry.getByRole('button', {
    name: 'Load private photo for entry 6',
  });
  await expect(middleLoadButton).toBeAttached();
  expect(
    media.readGrantRequests.some(
      (request) => request.mediaId === fixture.photoStressMiddleMediaId,
    ),
  ).toBe(false);

  await middleLoadButton.evaluate((button) =>
    (button as HTMLButtonElement).focus({ preventScroll: true }),
  );
  await expect(middleLoadButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      media.readGrantRequests.some(
        (request) => request.mediaId === fixture.photoStressMiddleMediaId,
      ),
    )
    .toBe(true);
  await expect(
    middleEntry.getByRole('img', {
      name: 'Synthetic bounded-loader private photo 6.',
    }),
  ).toBeAttached();

  const timeline = page.getByRole('region', {
    name: 'Chronological event journal',
  });
  for (const fraction of [0, 0.5, 1]) {
    await timeline.evaluate((region, position) => {
      region.scrollTop =
        (region.scrollHeight - region.clientHeight) * Number(position);
      region.dispatchEvent(new Event('scroll'));
    }, fraction);
    await page.waitForTimeout(250);
  }
  expect(
    media.readGrantRequests.filter(
      (request) => request.mediaId !== fixture.photoStressMiddleMediaId,
    ).length,
  ).toBeLessThanOrEqual(2);
  expect(await page.locator('.timeline-entry img').count()).toBeLessThanOrEqual(
    2,
  );
  await expectAxeClean(page, 'bounded viewport-gated private photo history');
});

test('private photos use truthful explicit fallback and keep out-of-order decodes within two slots', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: undefined,
      writable: true,
    });
  });
  await installControllableImageDecode(page);
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(12);
  await page.waitForTimeout(250);
  expect(media.readGrantRequests).toHaveLength(0);
  await expect(
    page
      .getByText(
        'Automatic viewport loading is unavailable in this browser. Load this private photo explicitly if it is operationally needed.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Load private photo for entry /u }),
  ).toHaveCount(12);

  const loadButton = (sequence: number) =>
    page
      .getByRole('article', {
        name: `Entry ${sequence}: Photo update`,
        exact: true,
      })
      .getByRole('button', {
        name: `Load private photo for entry ${sequence}`,
      });
  const figure = (sequence: number) =>
    page
      .getByRole('article', {
        name: `Entry ${sequence}: Photo update`,
        exact: true,
      })
      .locator('figure.photo-entry');
  const firstLoad = loadButton(1);
  await firstLoad.evaluate((button) =>
    (button as HTMLButtonElement).focus({ preventScroll: true }),
  );
  await expect(firstLoad).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(figure(1)).toBeFocused();
  for (const sequence of [2, 3]) {
    await loadButton(sequence).evaluate((button) =>
      (button as HTMLButtonElement).click(),
    );
  }
  await expect(figure(3)).toBeFocused();

  await expect.poll(() => media.readGrantRequests.length).toBe(2);
  await expect.poll(() => media.imageRequests.length).toBe(2);
  await expect
    .poll(async () => (await privatePhotoDecodeStats(page)).active)
    .toBe(2);
  expect((await privatePhotoDecodeStats(page)).maxActive).toBe(2);

  expect(
    await releasePrivatePhotoDecode(
      page,
      'Synthetic bounded-loader private photo 2.',
    ),
  ).toBe(true);
  await expect.poll(() => media.readGrantRequests.length).toBe(3);
  await expect.poll(() => media.imageRequests.length).toBe(3);
  await expect
    .poll(async () => (await privatePhotoDecodeStats(page)).active)
    .toBe(2);
  expect((await privatePhotoDecodeStats(page)).maxActive).toBe(2);
  await expect(figure(1).locator('img')).toBeAttached();
  await expect(figure(2)).toHaveAttribute(
    'data-private-photo-state',
    'evicted',
  );
  await expect(figure(2).locator('img')).toHaveCount(0);
  await expect(figure(3).locator('img')).toBeAttached();

  expect(
    await releasePrivatePhotoDecode(
      page,
      'Synthetic bounded-loader private photo 1.',
    ),
  ).toBe(true);
  expect(
    await releasePrivatePhotoDecode(
      page,
      'Synthetic bounded-loader private photo 3.',
    ),
  ).toBe(true);
  await expect(figure(3)).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect(figure(3)).toBeFocused();
  await expect.poll(() => page.locator('.timeline-entry img').count()).toBe(2);
  await expectAxeClean(page, 'explicit bounded private photo fallback');
});

test('a fixed private-photo deadline fails visibly and advances queued explicit work', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: undefined,
      writable: true,
    });
  });
  await installControllableImageDecode(page);
  await page.clock.install();
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  const entry = (sequence: number) =>
    page.getByRole('article', {
      name: `Entry ${sequence}: Photo update`,
      exact: true,
    });
  const figure = (sequence: number) =>
    entry(sequence).locator('figure.photo-entry');
  const loadButton = (sequence: number) =>
    entry(sequence).getByRole('button', {
      name: `Load private photo for entry ${sequence}`,
    });

  for (const sequence of [1, 2]) {
    await loadButton(sequence).evaluate((button) =>
      (button as HTMLButtonElement).click(),
    );
  }
  await loadButton(3).focus();
  await page.keyboard.press('Enter');
  await expect(figure(3)).toBeFocused();
  await expect.poll(() => media.readGrantRequests.length).toBe(2);
  await expect
    .poll(async () => (await privatePhotoDecodeStats(page)).active)
    .toBe(2);

  await page.clock.fastForward(60_001);
  await expect.poll(() => media.readGrantRequests.length).toBe(3);
  await expect.poll(() => media.imageRequests.length).toBe(3);
  await expect
    .poll(async () =>
      (await privatePhotoDecodeStats(page)).pendingAltText.includes(
        'Synthetic bounded-loader private photo 3.',
      ),
    )
    .toBe(true);
  expect(await privatePhotoDecodeStats(page)).toMatchObject({
    active: 1,
    maxActive: 2,
  });
  for (const sequence of [1, 2]) {
    await expect(figure(sequence)).toContainText(
      'Private photo loading exceeded the 60-second safety limit and was stopped.',
    );
  }
  await expect(figure(3)).toBeFocused();

  await page.clock.fastForward(60_001);
  await expect(figure(3)).toContainText(
    'Private photo loading exceeded the 60-second safety limit and was stopped.',
  );
  await expect(
    entry(3).getByRole('button', {
      name: 'Retry private photo for entry 3',
    }),
  ).toBeVisible();
  expect(await privatePhotoDecodeStats(page)).toMatchObject({
    active: 0,
    maxActive: 2,
    pendingAltText: [],
  });
  await expect(figure(3)).toBeFocused();
});

test('photo upload is keyboard-operable and appends only canonical same-event media data', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId: fixture.photoUploadMediaId,
    mediaId: fixture.photoUploadMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });
  const journalRequests: Array<
    Readonly<{
      body: unknown;
      headers: Readonly<Record<string, string>>;
    }>
  > = [];
  await page.route(`**/events/${fixture.photoEventId}/api`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as unknown;
      if (
        typeof body === 'object' &&
        body !== null &&
        'operation' in body &&
        body.operation === 'post-photo'
      ) {
        media.stages.push('post-photo');
        journalRequests.push({ body, headers: request.headers() });
      }
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.photoEventId));
  const seededPhoto = page.locator('.timeline-entry img').first();
  await expect(seededPhoto).toHaveAttribute('src', /[?&]grant=\d+$/u);
  await expect.poll(() => media.imageRequests.length).toBeGreaterThanOrEqual(1);
  const stageOffset = media.stages.length;

  const photoFile = page.getByLabel('Photo file');
  await photoFile.focus();
  await expect(photoFile).toBeFocused();
  await photoFile.setInputFiles({
    name: 'synthetic-staff-exercise.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  const altText = page.getByLabel('Photo description (alternative text)');
  await expect(altText).toHaveValue(
    /^Photo by Synthetic Event Room Operator at .+/u,
  );

  await photoFile.focus();
  await page.keyboard.press('Tab');
  await expect(altText).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Synthetic staff exercise photo');
  await page.keyboard.press('Tab');
  const caption = page.getByLabel('Caption (optional)');
  await expect(caption).toBeFocused();
  await page.keyboard.type('Synthetic staff-only exercise evidence');
  await page.keyboard.press('Tab');
  const submit = page.getByRole('button', { name: 'Upload and post photo' });
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');

  const postedPhoto = page.getByRole('img', {
    name: 'Synthetic staff exercise photo',
  });
  await expect(postedPhoto).toBeVisible();
  await expect(postedPhoto).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(
    page.getByText('Synthetic staff-only exercise evidence', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => media.imageRequests.length).toBeGreaterThanOrEqual(2);

  expect(media.createInputs).toEqual([
    {
      eventId: fixture.photoEventId,
      byteLength: SYNTHETIC_PNG.byteLength,
      contentSha256: SYNTHETIC_PNG_SHA256,
      declaredContentType: 'image/png',
    },
  ]);
  expect(media.createRequests).toHaveLength(1);
  expect(media.createRequests[0]?.headers['content-type']).toContain(
    'application/json',
  );
  expect(media.createRequests[0]?.headers['idempotency-key']).toBeTruthy();
  expect(media.createRequests[0]?.headers['x-psd-eoc-csrf']).toBeTruthy();

  expect(media.uploadRequests).toHaveLength(1);
  expect(media.uploadRequests[0]?.body).toEqual(SYNTHETIC_PNG);
  expect(media.uploadRequests[0]?.headers['content-type']).toBe('image/png');
  expect(media.uploadRequests[0]?.headers['if-none-match']).toBe('*');
  expect(media.uploadRequests[0]?.headers['authorization']).toBeUndefined();
  expect(media.uploadRequests[0]?.headers['cookie']).toBeUndefined();
  expect(media.uploadRequests[0]?.headers['idempotency-key']).toBeUndefined();
  expect(media.uploadRequests[0]?.headers['x-psd-eoc-csrf']).toBeUndefined();

  expect(media.completionRequests).toHaveLength(1);
  expect(media.completionRequests[0]?.body).toBeNull();
  expect(media.completionRequests[0]?.headers['content-type']).toBeUndefined();
  expect(media.completionRequests[0]?.headers['idempotency-key']).toBeTruthy();
  expect(media.completionRequests[0]?.headers['x-psd-eoc-csrf']).toBeTruthy();

  expect(journalRequests).toHaveLength(1);
  const journalBody = journalRequests[0]?.body;
  expect(journalBody).toEqual({
    operation: 'post-photo',
    mediaId: fixture.photoUploadMediaId,
    altText: 'Synthetic staff exercise photo',
    caption: 'Synthetic staff-only exercise evidence',
    clientTime:
      typeof journalBody === 'object' &&
      journalBody !== null &&
      'clientTime' in journalBody
        ? journalBody.clientTime
        : null,
  });
  expect(
    typeof journalBody === 'object' &&
      journalBody !== null &&
      'clientTime' in journalBody &&
      typeof journalBody.clientTime === 'string' &&
      !Number.isNaN(Date.parse(journalBody.clientTime)),
  ).toBe(true);
  expect(journalRequests[0]?.headers['idempotency-key']).toBeTruthy();
  expect(journalRequests[0]?.headers['x-psd-eoc-csrf']).toBeTruthy();
  expect(
    media.readGrantRequests.some(
      (request) =>
        request.eventId === fixture.photoEventId &&
        request.mediaId === fixture.photoUploadMediaId,
    ),
  ).toBe(true);
  expect(
    media.stages
      .slice(stageOffset)
      .filter((stage) => stage !== 'read-grant' && stage !== 'read-image'),
  ).toEqual(['create-intent', 'upload-bytes', 'complete-upload', 'post-photo']);
  expect(
    media.imageRequests.some((request) =>
      new URL(request.url).pathname.endsWith(`/${fixture.photoUploadMediaId}`),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.photoEventId,
    ),
  ).toBeNull();
  await expectAxeClean(page, 'keyboard-authored private photo update');
});

test('oversized photo is rejected visibly before any media network request', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.keyboardEventId,
    uploadIntentId: randomUUID(),
    mediaId: randomUUID(),
    sanitizedSha256: SYNTHETIC_PNG_SHA256,
  });
  await page.goto(fixturePath(fixture.keyboardEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-oversized.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(25 * 1_024 * 1_024 + 1),
  });
  await expect(
    page.getByRole('button', { name: 'Upload and post photo' }),
  ).toBeDisabled();
  const alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(/25 MiB|too large/iu);
  await expect(alert).toBeFocused();
  expect(media.createRequests).toHaveLength(0);
  expect(media.uploadRequests).toHaveLength(0);
  expect(media.completionRequests).toHaveLength(0);
  await expectAxeClean(page, 'oversized photo validation error');
});

test('malformed photo failure is focused and never appends a journal entry', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.keyboardEventId,
    uploadIntentId: randomUUID(),
    mediaId: randomUUID(),
    sanitizedSha256: SYNTHETIC_PNG_SHA256,
    completionOutcomes: ['malformed'],
  });
  let photoJournalPosts = 0;
  await page.route(
    `**/events/${fixture.keyboardEventId}/api`,
    async (route) => {
      const request = route.request();
      const body = request.method() === 'POST' ? request.postData() : null;
      if (body?.includes('"operation":"post-photo"') === true) {
        photoJournalPosts += 1;
      }
      await route.continue();
    },
  );

  await page.goto(fixturePath(fixture.keyboardEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-disguised-image.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_DISGUISED_NON_IMAGE,
  });
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  const alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(
    'The image could not be safely processed. Choose a different image and try again.',
  );
  await expect(alert).toBeFocused();
  expect(media.createRequests).toHaveLength(1);
  expect(media.uploadRequests).toHaveLength(1);
  expect(media.completionRequests).toHaveLength(1);
  expect(photoJournalPosts).toBe(0);
  await expectAxeClean(page, 'malformed photo processing error');
});

test('ambiguous photo completion survives reload and only retries explicitly with one key', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.keyboardEventId,
    uploadIntentId: randomUUID(),
    mediaId: randomUUID(),
    sanitizedSha256: SYNTHETIC_PNG_SHA256,
    completionOutcomes: [
      'unreadable-rate-limit',
      'server-nonretryable',
      'scan-pending',
    ],
  });
  let photoJournalPosts = 0;
  await page.route(
    `**/events/${fixture.keyboardEventId}/api`,
    async (route) => {
      const request = route.request();
      const body = request.method() === 'POST' ? request.postData() : null;
      if (body?.includes('"operation":"post-photo"') === true) {
        photoJournalPosts += 1;
      }
      await route.continue();
    },
  );

  await page.goto(fixturePath(fixture.keyboardEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-scan-pending.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  const alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(
    'Photo validation is not complete. Use the explicit retry after waiting for the malware scan.',
  );
  await expect(alert).toBeFocused();
  expect(media.completionRequests).toHaveLength(1);
  const firstRecovery = await page.evaluate((eventId) => {
    const raw = sessionStorage.getItem(
      `psd-eoc:event-room:photo-completion:v1:${eventId}`,
    );
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { raw, parsed, keys: Object.keys(parsed).sort() };
  }, fixture.keyboardEventId);
  expect(firstRecovery).not.toBeNull();
  if (firstRecovery === null) {
    throw new Error('Missing retained photo completion after ambiguity.');
  }
  expect(firstRecovery.keys).toEqual(
    [
      'version',
      'eventId',
      'ownerSessionId',
      'uploadIntentId',
      'mediaId',
      'idempotencyKey',
      'postIdempotencyKey',
      'altText',
      'caption',
      'clientTime',
      'createdAt',
    ].sort(),
  );
  expect(firstRecovery.parsed).toMatchObject({
    version: 1,
    eventId: fixture.keyboardEventId,
    ownerSessionId: fixture.sessionId,
    mediaId: null,
    idempotencyKey: media.completionRequests[0]?.headers['idempotency-key'],
  });
  expect(firstRecovery.raw).not.toContain('uploadUrl');
  expect(firstRecovery.raw).not.toContain(SYNTHETIC_MEDIA_ORIGIN);

  await page.reload();
  await expect(alert).toContainText(
    'A previous private photo validation has an unresolved result. It was not retried automatically.',
  );
  await expect(alert).toBeFocused();
  await page.waitForTimeout(750);
  expect(media.completionRequests).toHaveLength(1);

  let retry = page.getByRole('button', { name: 'Retry photo validation' });
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press('Enter');
  await expect.poll(() => media.completionRequests.length).toBe(2);
  await expect(alert).toContainText(
    'Synthetic upstream failure with an unsafe retry hint.',
  );

  await page.reload();
  await expect(alert).toContainText(
    'A previous private photo validation has an unresolved result. It was not retried automatically.',
  );
  await page.waitForTimeout(750);
  expect(media.completionRequests).toHaveLength(2);
  retry = page.getByRole('button', { name: 'Retry photo validation' });
  await retry.press('Enter');
  await expect.poll(() => media.completionRequests.length).toBe(3);
  await expect(alert).toContainText(
    'The photo safety scan is still pending. Try again shortly.',
  );
  expect(media.createRequests).toHaveLength(1);
  expect(media.uploadRequests).toHaveLength(1);
  expect(
    media.completionRequests.every((request) => request.body === null),
  ).toBe(true);
  expect(media.completionRequests[0]?.headers['idempotency-key']).toBeTruthy();
  expect(
    media.completionRequests.every(
      (request) =>
        request.headers['idempotency-key'] ===
        media.completionRequests[0]?.headers['idempotency-key'],
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.keyboardEventId,
    ),
  ).toBe(firstRecovery.raw);
  expect(photoJournalPosts).toBe(0);
  await page
    .getByRole('button', {
      name: 'Clear pending photo attempt after timeline verification',
    })
    .press('Enter');
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.keyboardEventId,
    ),
  ).toBeNull();
  await expect(page.getByLabel('Photo file')).toBeEnabled();
  await expectAxeClean(page, 'ambiguous photo validation recovery');
});

test('another-session photo recovery blocks upload and sends nothing until explicit clear', async ({
  page,
}) => {
  const fixture = await readFixture();
  let completionPosts = 0;
  let journalPosts = 0;
  await page.route('**/api/media/upload-intents/**/complete', async (route) => {
    if (route.request().method() === 'POST') completionPosts += 1;
    await route.abort('blockedbyclient');
  });
  await page.route(
    `**/events/${fixture.recoveryOwnerEventId}/api`,
    async (route) => {
      if (route.request().method() === 'POST') journalPosts += 1;
      await route.continue();
    },
  );

  await page.goto(fixturePath(fixture.recoveryOwnerEventId));
  await page.evaluate((eventId) => {
    const now = new Date().toISOString();
    sessionStorage.setItem(
      `psd-eoc:event-room:photo-completion:v1:${eventId}`,
      JSON.stringify({
        version: 1,
        eventId,
        ownerSessionId: '00000000-0000-4000-8000-000000000999',
        uploadIntentId: crypto.randomUUID(),
        mediaId: null,
        idempotencyKey: `event-photo-complete-${crypto.randomUUID()}`,
        postIdempotencyKey: `event-room-${crypto.randomUUID()}`,
        altText: 'Another session synthetic photo',
        caption: null,
        clientTime: now,
        createdAt: now,
      }),
    );
  }, fixture.recoveryOwnerEventId);
  await page.reload();

  const alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(
    'PSD EOC could not read the private photo recovery record. No request was sent.',
  );
  await expect(alert).toBeFocused();
  await expect(page.getByLabel('Photo file')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retry photo validation' }),
  ).toHaveCount(0);
  await page.waitForTimeout(750);
  expect(completionPosts).toBe(0);
  expect(journalPosts).toBe(0);

  await page
    .getByRole('button', {
      name: 'Clear pending photo attempt after timeline verification',
    })
    .press('Enter');
  await expect(page.getByLabel('Photo file')).toBeEnabled();
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.recoveryOwnerEventId,
    ),
  ).toBeNull();
  expect(completionPosts).toBe(0);
  expect(journalPosts).toBe(0);
  await expectAxeClean(page, 'another-session photo recovery block');
});

test('a handoff crash with both recovery records converges on one exact photo post', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId: randomUUID(),
    mediaId: fixture.photoUploadMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });
  const postRequests: Array<
    Readonly<{ body: unknown; idempotencyKey: string | undefined }>
  > = [];
  await page.route(`**/events/${fixture.photoEventId}/api`, async (route) => {
    const request = route.request();
    if (
      request.method() === 'POST' &&
      request.postData()?.includes('Synthetic handoff crash photo') === true
    ) {
      postRequests.push({
        body: request.postDataJSON() as unknown,
        idempotencyKey: request.headers()['idempotency-key'],
      });
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.photoEventId));
  const postIdempotencyKey = `event-room-${randomUUID()}`;
  const completionIdempotencyKey = `event-photo-complete-${randomUUID()}`;
  const uploadIntentId = randomUUID();
  const clientTime = new Date().toISOString();
  const body = {
    operation: 'post-photo' as const,
    mediaId: fixture.photoUploadMediaId,
    altText: 'Synthetic handoff crash photo',
    caption: 'Synthetic dual-record recovery evidence',
    clientTime,
  };
  await page.evaluate(
    ({
      bodyJson,
      clientTime: storedClientTime,
      completionKey,
      eventId,
      mediaId,
      ownerSessionId,
      postKey,
      uploadId,
    }) => {
      sessionStorage.setItem(
        `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        JSON.stringify({
          version: 1,
          eventId,
          ownerSessionId,
          uploadIntentId: uploadId,
          mediaId,
          idempotencyKey: completionKey,
          postIdempotencyKey: postKey,
          altText: 'Synthetic handoff crash photo',
          caption: 'Synthetic dual-record recovery evidence',
          clientTime: storedClientTime,
          createdAt: storedClientTime,
        }),
      );
      sessionStorage.setItem(
        `psd-eoc:event-room:pending:v1:${eventId}`,
        JSON.stringify({
          version: 1,
          eventId,
          ownerSessionId,
          apiUrl: `/events/${eventId}/api`,
          operation: 'post-photo',
          idempotencyKey: postKey,
          bodyJson,
          createdAt: storedClientTime,
        }),
      );
    },
    {
      bodyJson: JSON.stringify(body),
      clientTime,
      completionKey: completionIdempotencyKey,
      eventId: fixture.photoEventId,
      mediaId: fixture.photoUploadMediaId,
      ownerSessionId: fixture.sessionId,
      postKey: postIdempotencyKey,
      uploadId: uploadIntentId,
    },
  );
  await page.reload();

  await expect(
    page.getByRole('button', { name: 'Retry exact retained request' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry photo validation' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.photoEventId,
    ),
  ).toBeNull();
  await page.waitForTimeout(750);
  expect(postRequests).toHaveLength(0);
  expect(media.completionRequests).toHaveLength(0);

  await page
    .getByRole('button', { name: 'Retry exact retained request' })
    .press('Enter');
  await expect(page.locator('.mutation-status')).toContainText(
    'photo post confirmed by the server.',
  );
  expect(postRequests).toEqual([{ body, idempotencyKey: postIdempotencyKey }]);
  await expect(
    page.getByRole('img', { name: 'Synthetic handoff crash photo' }),
  ).toHaveCount(1);
  expect(media.completionRequests).toHaveLength(0);
  expect(
    await page.evaluate(
      (eventId) => ({
        completion: sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
        post: sessionStorage.getItem(
          `psd-eoc:event-room:pending:v1:${eventId}`,
        ),
      }),
      fixture.photoEventId,
    ),
  ).toEqual({ completion: null, post: null });
  await page.reload();
  await page.waitForTimeout(750);
  expect(postRequests).toHaveLength(1);
  expect(media.completionRequests).toHaveLength(0);
  await expect(
    page.getByRole('img', { name: 'Synthetic handoff crash photo' }),
  ).toHaveCount(1);
  await expectAxeClean(page, 'dual-record photo handoff recovery');
});

test('a same-key but altered handoff record is never reconciled or sent', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId: randomUUID(),
    mediaId: fixture.photoUploadMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });
  let journalPosts = 0;
  await page.route(`**/events/${fixture.photoEventId}/api`, async (route) => {
    if (route.request().method() === 'POST') journalPosts += 1;
    await route.continue();
  });
  await page.goto(fixturePath(fixture.photoEventId));
  const postKey = `event-room-${randomUUID()}`;
  const clientTime = new Date().toISOString();
  const completionRaw = JSON.stringify({
    version: 1,
    eventId: fixture.photoEventId,
    ownerSessionId: fixture.sessionId,
    uploadIntentId: randomUUID(),
    mediaId: fixture.photoUploadMediaId,
    idempotencyKey: `event-photo-complete-${randomUUID()}`,
    postIdempotencyKey: postKey,
    altText: 'Valid pending photo evidence',
    caption: 'Must not be erased by an altered post body',
    clientTime,
    createdAt: clientTime,
  });
  await page.evaluate(
    ({
      alteredMediaId,
      eventId,
      ownerSessionId,
      pendingRaw,
      retainedPostKey,
      storedTime,
    }) => {
      sessionStorage.setItem(
        `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        pendingRaw,
      );
      sessionStorage.setItem(
        `psd-eoc:event-room:pending:v1:${eventId}`,
        JSON.stringify({
          version: 1,
          eventId,
          ownerSessionId,
          apiUrl: `/events/${eventId}/api`,
          operation: 'post-photo',
          idempotencyKey: retainedPostKey,
          bodyJson: JSON.stringify({
            operation: 'post-photo',
            mediaId: alteredMediaId,
            altText: 'Altered retained photo evidence',
            caption: null,
            clientTime: storedTime,
          }),
          createdAt: storedTime,
        }),
      );
    },
    {
      alteredMediaId: fixture.photoMediaId,
      eventId: fixture.photoEventId,
      ownerSessionId: fixture.sessionId,
      pendingRaw: completionRaw,
      retainedPostKey: postKey,
      storedTime: clientTime,
    },
  );
  await page.reload();

  await expect(page.locator('.photo-workflow-error')).toContainText(
    'PSD EOC could not read the private photo recovery record. No request was sent.',
  );
  await expect(page.getByLabel('Photo file')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retry photo validation' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Retry exact retained request' }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      'The retained photo post conflicts with private photo recovery evidence and cannot be retried.',
      { exact: false },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.photoEventId,
    ),
  ).toBe(completionRaw);
  await page.waitForTimeout(750);
  expect(journalPosts).toBe(0);
  expect(media.completionRequests).toHaveLength(0);

  await page
    .getByRole('button', {
      name: 'I verified the timeline — clear browser recovery record',
    })
    .press('Enter');
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.photoEventId,
    ),
  ).toBe(completionRaw);
  await page
    .getByRole('button', {
      name: 'Clear pending photo attempt after timeline verification',
    })
    .press('Enter');
  await expect(page.getByLabel('Photo file')).toBeEnabled();
  expect(
    await page.evaluate(
      (eventId) => ({
        completion: sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
        post: sessionStorage.getItem(
          `psd-eoc:event-room:pending:v1:${eventId}`,
        ),
      }),
      fixture.photoEventId,
    ),
  ).toEqual({ completion: null, post: null });
  expect(journalPosts).toBe(0);
  expect(media.completionRequests).toHaveLength(0);
});

test('a redacted photo never mounts an image or requests private media', async ({
  page,
}) => {
  const fixture = await readFixture();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.redactedPhotoEventId,
    uploadIntentId: fixture.redactedPhotoMediaId,
    mediaId: fixture.redactedPhotoMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });
  await page.goto(fixturePath(fixture.redactedPhotoEventId));
  await expect(page.locator('.redacted-content')).toContainText(
    'Original content is hidden because a later append-only redaction supersedes this entry.',
  );
  await expect(page.locator('.timeline-entry img')).toHaveCount(0);
  await page.waitForTimeout(750);
  expect(media.readGrantRequests).toHaveLength(0);
  expect(media.imageRequests).toHaveLength(0);
  await expectAxeClean(page, 'redacted photo without a private read');
});

test('a lost committed response never replays automatically and retries the exact idempotent command only on explicit keyboard action', async ({
  page,
}) => {
  const fixture = await readFixture();
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
}) => {
  const fixture = await readFixture();
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
}) => {
  const fixture = await readFixture();
  let classificationSwapReturned = false;
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith(`/${fixture.realDraftEventId}/api`) &&
      url.searchParams.get('operation') === null
    ) {
      const upstream = await route.fetch();
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
}) => {
  const fixture = await readFixture();
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

test('synthetic all-clear requires preview and exact typed confirmation, appends fan-out truth, then requires typed close', async ({
  page,
}) => {
  const fixture = await readFixture();
  await page.goto(fixturePath(fixture.lifecycleEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Notification consequences' }),
  ).toBeVisible();
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

  await page.getByRole('button', { name: 'Review event close' }).press('Enter');
  const closePhrase = page.getByLabel('Type CLOSE EVENT exactly');
  const closeEvent = page.getByRole('button', { name: 'Close event' });
  await closePhrase.fill('CLOSE');
  await expect(closeEvent).toBeDisabled();
  await closePhrase.fill('CLOSE EVENT');
  await closeEvent.press('Enter');
  await expect(page.getByText('Event closed.', { exact: true })).toBeVisible();
  await expect(page.locator('.event-status')).toHaveText('Closed');
  await expectAxeClean(page, 'closed synthetic event room');
});
