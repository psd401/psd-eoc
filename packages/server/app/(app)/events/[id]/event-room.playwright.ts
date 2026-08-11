import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  ApiErrorSchema,
  CreateMediaUploadIntentInputSchema,
  JournalEntrySchema,
  LocationPayloadSchema,
  MediaReadGrantSchema,
  MediaRecordSchema,
  MediaUploadIntentSchema,
  type CreateMediaUploadIntentInput,
} from '@psd-eoc/contracts';
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
  readonly concurrentDialogEventId: string;
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
  readonly mismatchedAllClearTransitionEventId: string;
  readonly mismatchedTransitionEventId: string;
  readonly newerPollEventId: string;
  readonly paginatedDialogEventId: string;
  readonly paginatedLifecycleEventId: string;
  readonly pendingDialogEventId: string;
  readonly previewRetryEventId: string;
  readonly realDraftEventId: string;
  readonly rejectedDialogRaceEventId: string;
  readonly rejectedLifecycleDialogEventId: string;
  readonly stalePollEventId: string;
  readonly staleLifecycleResponseEventId: string;
  readonly stalledMutationEventId: string;
  readonly stalledPreviewEventId: string;
  readonly photoEventId: string;
  readonly photoMediaId: string;
  readonly photoUploadMediaId: string;
  readonly photoSanitizedSha256: string;
  readonly photoStressEventId: string;
  readonly photoStressOldestMediaId: string;
  readonly photoStressSecondMediaId: string;
  readonly photoStressMiddleMediaId: string;
  readonly redactedPhotoEventId: string;
  readonly redactedPhotoMediaId: string;
}

type CompletionOutcome = 'malformed' | 'ready' | 'scan-pending';
type ReadGrantOutcome =
  | 'cross-event'
  | 'expired'
  | 'malformed'
  | 'raw-noncanonical'
  | 'ready';
type ImageOutcome = 'error' | 'ready';

interface SyntheticMediaRouteOptions {
  readonly eventId: string;
  readonly uploadIntentId: string;
  readonly mediaId: string;
  readonly sanitizedSha256: string;
  readonly completionOutcomes?: readonly CompletionOutcome[];
  readonly readGrantOutcomes?: readonly ReadGrantOutcome[];
  readonly imageOutcomes?: readonly ImageOutcome[];
  readonly holdCreateResponses?: boolean;
  readonly holdUploadResponses?: boolean;
  readonly holdCompletionResponses?: boolean;
  readonly holdImageResponses?: boolean;
  readonly holdReadGrants?: boolean;
}

interface SyntheticMediaRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

interface SyntheticMediaPreflight extends SyntheticMediaRequest {
  readonly allowedHeaders: string;
  readonly allowedOrigin: string;
}

interface SyntheticMediaLog {
  readonly stages: string[];
  readonly createInputs: CreateMediaUploadIntentInput[];
  readonly createRequests: SyntheticMediaRequest[];
  readonly preflightRequests: SyntheticMediaPreflight[];
  readonly uploadRequests: Array<
    SyntheticMediaRequest & Readonly<{ body: Buffer }>
  >;
  readonly completionRequests: Array<
    SyntheticMediaRequest & Readonly<{ body: string | null }>
  >;
  readonly readGrantRequests: Array<
    SyntheticMediaRequest &
      Readonly<{
        eventId: string;
        mediaId: string;
        outcome: ReadGrantOutcome;
        readUrl: string;
      }>
  >;
  readonly imageRequests: Array<
    SyntheticMediaRequest & Readonly<{ outcome: ImageOutcome }>
  >;
  concurrentImageRequests: number;
  concurrentReadGrantRequests: number;
  maxConcurrentImageRequests: number;
  maxConcurrentReadGrantRequests: number;
  readonly releaseCompletionResponses: () => void;
  readonly releaseCreateResponses: () => void;
  readonly releaseImageResponses: () => void;
  readonly releaseReadGrants: () => void;
  readonly releaseUploadResponses: () => void;
}

interface PrivatePhotoIntersectionProbe {
  readonly activeTargets: number;
  readonly disconnectCalls: number;
  readonly observeCalls: number;
}

interface PrivatePhotoDecodeProbe {
  readonly active: number;
  readonly maxActive: number;
  readonly pendingAltText: readonly string[];
}

interface PrivatePhotoMountProbe {
  readonly maxStateful: number;
  readonly stateful: number;
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
        stats: () => ({
          activeTargets: records.reduce(
            (total, record) =>
              total + (record.connected ? record.targets.size : 0),
            0,
          ),
          disconnectCalls,
          observeCalls,
        }),
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

async function installPrivatePhotoMountProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let maxStateful = 0;
    const sample = () => {
      maxStateful = Math.max(
        maxStateful,
        document.querySelectorAll('[data-private-photo-mount="stateful"]')
          .length,
      );
    };
    const observer = new MutationObserver(sample);
    observer.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-private-photo-mount'],
    });

    const originalAppendChild = Node.prototype.appendChild;
    Object.defineProperty(Node.prototype, 'appendChild', {
      configurable: true,
      value: function appendChild<T extends Node>(this: Node, child: T): T {
        const result = originalAppendChild.call(this, child) as T;
        sample();
        return result;
      },
      writable: true,
    });
    const originalInsertBefore = Node.prototype.insertBefore;
    Object.defineProperty(Node.prototype, 'insertBefore', {
      configurable: true,
      value: function insertBefore<T extends Node>(
        this: Node,
        child: T,
        before: Node | null,
      ): T {
        const result = originalInsertBefore.call(this, child, before) as T;
        sample();
        return result;
      },
      writable: true,
    });
    const originalReplaceChild = Node.prototype.replaceChild;
    Object.defineProperty(Node.prototype, 'replaceChild', {
      configurable: true,
      value: function replaceChild<T extends Node>(
        this: Node,
        child: Node,
        replaced: T,
      ): T {
        const result = originalReplaceChild.call(this, child, replaced) as T;
        sample();
        return result;
      },
      writable: true,
    });

    Object.defineProperty(window, '__privatePhotoMountProbe', {
      configurable: true,
      value: {
        stats: () => {
          sample();
          return {
            maxStateful,
            stateful: document.querySelectorAll(
              '[data-private-photo-mount="stateful"]',
            ).length,
          };
        },
      },
    });
  });
}

async function privatePhotoMountStats(
  page: Page,
): Promise<PrivatePhotoMountProbe> {
  return page.evaluate(() =>
    (
      window as typeof window & {
        __privatePhotoMountProbe: {
          stats(): PrivatePhotoMountProbe;
        };
      }
    ).__privatePhotoMountProbe.stats(),
  );
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

function syntheticResponseGate(initiallyHeld: boolean): Readonly<{
  release: () => void;
  wait: () => Promise<void>;
}> {
  let held = initiallyHeld;
  const pending: Array<() => void> = [];
  return {
    release: () => {
      held = false;
      for (const resolve of pending.splice(0)) resolve();
    },
    wait: async () => {
      if (!held) return;
      await new Promise<void>((resolve) => pending.push(resolve));
    },
  };
}

function syntheticCorsPreflightHeaders(
  requestOrigin: string,
  expectedOrigin: string,
): Readonly<Record<string, string>> {
  return {
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Access-Control-Allow-Methods': 'PUT',
    'Access-Control-Allow-Origin':
      requestOrigin === expectedOrigin ? expectedOrigin : '',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function expectSyntheticCorsUpload(
  media: SyntheticMediaLog,
  expectedOrigin: string,
): void {
  const policy = syntheticCorsPreflightHeaders(expectedOrigin, expectedOrigin);
  expect(policy).toEqual({
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Access-Control-Allow-Methods': 'PUT',
    'Access-Control-Allow-Origin': expectedOrigin,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });
  expect(media.uploadRequests[0]?.headers.origin).toBe(expectedOrigin);
  expect(media.uploadRequests[0]?.headers['content-type']).toBe('image/png');
  expect(media.uploadRequests[0]?.headers['if-none-match']).toBe('*');

  // Chromium may satisfy a Playwright-routed cross-origin PUT without
  // surfacing its internal preflight as an interceptable request. When it is
  // surfaced, prove the exact request and response contract; in either case,
  // the routed PUT above proves the browser sent the triggering Origin and
  // non-safelisted headers.
  expect(media.preflightRequests.length).toBeLessThanOrEqual(1);
  for (const preflight of media.preflightRequests) {
    expect(preflight.headers.origin).toBe(expectedOrigin);
    expect(preflight.allowedOrigin).toBe(expectedOrigin);
    expect(preflight.headers['access-control-request-method']).toBe('PUT');
    expect(
      preflight.headers['access-control-request-headers']
        ?.split(',')
        .map((header) => header.trim().toLowerCase())
        .sort(),
    ).toEqual(['content-type', 'if-none-match']);
    expect(preflight.allowedHeaders).toBe(
      policy['Access-Control-Allow-Headers'],
    );
  }
}

async function installSyntheticMediaRoutes(
  page: Page,
  options: SyntheticMediaRouteOptions,
): Promise<SyntheticMediaLog> {
  const createGate = syntheticResponseGate(
    options.holdCreateResponses ?? false,
  );
  const uploadGate = syntheticResponseGate(
    options.holdUploadResponses ?? false,
  );
  const completionGate = syntheticResponseGate(
    options.holdCompletionResponses ?? false,
  );
  const readGrantGate = syntheticResponseGate(options.holdReadGrants ?? false);
  const imageGate = syntheticResponseGate(options.holdImageResponses ?? false);
  const log: SyntheticMediaLog = {
    stages: [],
    createInputs: [],
    createRequests: [],
    preflightRequests: [],
    uploadRequests: [],
    completionRequests: [],
    readGrantRequests: [],
    imageRequests: [],
    concurrentImageRequests: 0,
    concurrentReadGrantRequests: 0,
    maxConcurrentImageRequests: 0,
    maxConcurrentReadGrantRequests: 0,
    releaseCompletionResponses: completionGate.release,
    releaseCreateResponses: createGate.release,
    releaseImageResponses: imageGate.release,
    releaseReadGrants: readGrantGate.release,
    releaseUploadResponses: uploadGate.release,
  };
  const completionOutcomes = options.completionOutcomes ?? ['ready'];
  const readGrantOutcomes = options.readGrantOutcomes ?? ['ready'];
  const imageOutcomes = options.imageOutcomes ?? ['ready'];
  let completionAttempt = 0;
  let readGrantAttempt = 0;
  let imageAttempt = 0;
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
      await createGate.wait();
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
      await completionGate.wait();
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
      const outcome =
        readGrantOutcomes[
          Math.min(readGrantAttempt, readGrantOutcomes.length - 1)
        ] ?? 'ready';
      readGrantAttempt += 1;
      grantSequence += 1;
      const canonicalReadUrl = `${SYNTHETIC_MEDIA_ORIGIN}/ready/${eventId}/${mediaId}?grant=${grantSequence}`;
      const readUrl =
        outcome === 'raw-noncanonical'
          ? `HTTPS://PRIVATE-MEDIA.EXAMPLE.TEST:443/ready/${eventId}/${mediaId}?grant=${grantSequence}#synthetic-fragment`
          : canonicalReadUrl;
      log.concurrentReadGrantRequests += 1;
      log.maxConcurrentReadGrantRequests = Math.max(
        log.maxConcurrentReadGrantRequests,
        log.concurrentReadGrantRequests,
      );
      log.stages.push('read-grant');
      log.readGrantRequests.push({
        eventId,
        headers,
        mediaId,
        outcome,
        readUrl,
        url: request.url(),
      });
      try {
        await readGrantGate.wait();
        if (outcome === 'malformed') {
          await route.fulfill({
            contentType: 'application/json',
            json: { eventId, mediaId, readUrl: 17 },
          });
          return;
        }
        if (outcome === 'expired') {
          const issuedAt = new Date(Date.now() - 2 * 60_000);
          await route.fulfill({
            contentType: 'application/json',
            json: MediaReadGrantSchema.parse({
              eventId,
              mediaId,
              readUrl,
              issuedAt: issuedAt.toISOString(),
              expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
            }),
          });
          return;
        }
        const times = mediaTimestampWindow();
        await route.fulfill({
          contentType: 'application/json',
          json: MediaReadGrantSchema.parse({
            eventId: outcome === 'cross-event' ? randomUUID() : eventId,
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
    const requestOrigin = headers.origin ?? '';
    const expectedOrigin = new URL(page.url()).origin;
    const preflightHeaders = syntheticCorsPreflightHeaders(
      requestOrigin,
      expectedOrigin,
    );
    const allowedOrigin = preflightHeaders['Access-Control-Allow-Origin'] ?? '';
    const allowedHeaders =
      preflightHeaders['Access-Control-Allow-Headers'] ?? '';
    if (request.method() === 'OPTIONS') {
      log.preflightRequests.push({
        allowedHeaders,
        allowedOrigin,
        headers,
        url: request.url(),
      });
      await route.fulfill({
        status: 204,
        headers: preflightHeaders,
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
      await uploadGate.wait();
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          ETag: '"synthetic-private-upload"',
        },
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname.startsWith('/ready/')) {
      const outcome =
        imageOutcomes[Math.min(imageAttempt, imageOutcomes.length - 1)] ??
        'ready';
      imageAttempt += 1;
      log.concurrentImageRequests += 1;
      log.maxConcurrentImageRequests = Math.max(
        log.maxConcurrentImageRequests,
        log.concurrentImageRequests,
      );
      log.stages.push('read-image');
      log.imageRequests.push({ headers, outcome, url: request.url() });
      try {
        await imageGate.wait();
        await route.fulfill(
          outcome === 'error'
            ? {
                status: 404,
                contentType: 'application/json',
                body: JSON.stringify({
                  error: 'Synthetic private image miss.',
                }),
              }
            : {
                status: 200,
                body: SYNTHETIC_PNG,
                contentType: 'image/png',
                headers: { 'Cache-Control': 'private, no-store' },
              },
        );
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

async function persistedSessionValuesContaining(
  page: Page,
  needle: string,
): Promise<readonly string[]> {
  return page.evaluate((value) => {
    const matches: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key === null) continue;
      const stored = window.sessionStorage.getItem(key);
      if (stored?.includes(value) === true) matches.push(stored);
    }
    return matches;
  }, needle);
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

async function redactExternalEntry(
  page: Page,
  eventId: string,
  entryId: string,
  entrySequence: number,
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
            operation: 'redact-entry',
            entryId: input.entryId,
            entrySequence: input.entrySequence,
            reason: 'Synthetic concurrent redaction regression.',
            clientTime: new Date().toISOString(),
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
      entryId,
      entrySequence,
      idempotencyKey: `event-room-redaction-${randomUUID()}`,
    },
  );
  if (!result.ok) {
    throw new Error(
      `Synthetic external redaction failed (${result.status}): ${result.body}`,
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
  await expect(page.locator('.connection-line')).toContainText('Connected', {
    timeout: 22_000,
  });

  let releaseStalePage: () => void = () => undefined;
  const stalePageRelease = new Promise<void>((resolve) => {
    releaseStalePage = resolve;
  });
  let releaseTerminalPage: () => void = () => undefined;
  const terminalPageRelease = new Promise<void>((resolve) => {
    releaseTerminalPage = resolve;
  });
  let resolveStalePageCaptured: () => void = () => undefined;
  const stalePageCaptured = new Promise<void>((resolve) => {
    resolveStalePageCaptured = resolve;
  });
  let resolveRetryFirstPageSeen: () => void = () => undefined;
  const retryFirstPageSeen = new Promise<void>((resolve) => {
    resolveRetryFirstPageSeen = resolve;
  });
  let resolveRetryTerminalHeld: () => void = () => undefined;
  const retryTerminalHeld = new Promise<void>((resolve) => {
    resolveRetryTerminalHeld = resolve;
  });
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
      resolveStalePageCaptured();
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
      resolveRetryFirstPageSeen();
      await route.fulfill({ response: upstream, json: value });
      return;
    }
    if (timelineRequests === 3) {
      resolveRetryTerminalHeld();
      await terminalPageRelease;
    }
    await route.continue();
  });

  let scenarioCompleted = false;
  try {
    await appendSyntheticBurst(testInfo, fixture.invalidationEventId, 101);
    await stalePageCaptured;
    await page
      .getByLabel('Update text')
      .fill('Mutation committed while a stale continuation was held');
    await page.getByRole('button', { name: 'Post update' }).press('Enter');
    await expect(page.locator('.mutation-status')).toContainText(
      'timeline post confirmed by the server.',
    );
    releaseStalePage();
    await retryFirstPageSeen;
    await retryTerminalHeld;
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
    scenarioCompleted = true;
  } finally {
    releaseStalePage();
    releaseTerminalPage();
    await page.unrouteAll({
      behavior: scenarioCompleted ? 'wait' : 'ignoreErrors',
    });
  }
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
  const appendCorrection = page.getByRole('button', {
    name: 'Append correction',
  });
  await page.getByLabel('Reason for correction').fill('   ');
  await expect(appendCorrection).toBeDisabled();
  await page.getByLabel('Corrected text').fill('   ');
  await page
    .getByLabel('Reason for correction')
    .fill('Synthetic accuracy correction');
  await expect(appendCorrection).toBeDisabled();
  await page.getByLabel('Corrected text').fill('Append-only corrected text');
  await expect(appendCorrection).toBeEnabled();
  await appendCorrection.press('Enter');
  await expect(
    page.getByText('Append-only corrected text', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Entry 1: Text update' }),
  ).toContainText('This original entry was superseded, not deleted.');
  await expect(
    page.getByRole('article', { name: 'Entry 5: Text update' }),
  ).toContainText('Reason: Synthetic accuracy correction');
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'timeline correction confirmed by the server.',
  );
  await expect(
    page.locator('.event-room > .mutation-status'),
  ).not.toContainText('No request was sent');

  await page.getByRole('button', { name: 'Redact entry 1' }).press('Enter');
  const redactionDialog = page.getByRole('dialog');
  await expect(redactionDialog).toContainText('DRILL — TRAINING ONLY');
  await expect(redactionDialog.locator('.mutation-status')).toHaveText('');
  await expect(redactionDialog).not.toContainText(
    'timeline correction confirmed by the server.',
  );
  await expect(page.getByLabel('Reason for redaction')).toBeFocused();
  const appendRedaction = page.getByRole('button', {
    name: 'Append redaction',
  });
  await page.getByLabel('Reason for redaction').fill('   ');
  await expect(appendRedaction).toBeDisabled();
  await page
    .getByLabel('Reason for redaction')
    .fill('Synthetic privacy-safe redaction');
  await expect(appendRedaction).toBeEnabled();
  await appendRedaction.press('Enter');
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
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'timeline redaction confirmed by the server.',
  );
  await expect(
    page.locator('.event-room > .mutation-status'),
  ).not.toContainText('No request was sent');
  const redactedProjection = await page.evaluate(async (eventId) => {
    const response = await fetch(`/events/${encodeURIComponent(eventId)}/api`, {
      credentials: 'same-origin',
    });
    const value = (await response.json()) as {
      entries?: Array<{
        visibility?: string;
        entry?: { sequence?: number; payload?: unknown };
      }>;
    };
    return value.entries?.find(
      (projection) => projection.entry?.sequence === 1,
    );
  }, fixture.keyboardEventId);
  expect(redactedProjection?.visibility).toBe('redacted');
  expect(redactedProjection?.entry).not.toHaveProperty('payload');
  expect(JSON.stringify(redactedProjection)).not.toContain(
    'Synthetic ordered history 001',
  );
  await expectAxeClean(page, 'event room after correction and redaction');
});

test('location posts preserve browser accuracy, explicit truth states, and append-only correction when tiles fail', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({
    latitude: 47.385612,
    longitude: -122.622407,
    accuracy: 18.5,
  });
  await page.goto(fixturePath(fixture.keyboardEventId));
  await expect(page.locator('.timeline-loading-placeholder')).toHaveCount(0);

  const malformed = await page.evaluate(async (eventId) => {
    const csrf = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('__Host-psd-eoc-csrf='))
      ?.split('=', 2)[1];
    const response = await fetch(`/events/${encodeURIComponent(eventId)}/api`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `event-room-location-malformed-${crypto.randomUUID()}`,
        ...(csrf === undefined
          ? {}
          : { 'X-PSD-EOC-CSRF': decodeURIComponent(csrf) }),
      },
      body: JSON.stringify({
        operation: 'post-location',
        payload: {
          state: 'known',
          latitude: 47.385612,
          longitude: -122.622407,
          label: null,
        },
        clientTime: new Date().toISOString(),
      }),
    });
    return { status: response.status, value: await response.json() };
  }, fixture.keyboardEventId);
  expect(malformed.status).toBe(400);
  expect(ApiErrorSchema.safeParse(malformed.value).success).toBe(true);

  const lastHeading = await page
    .locator('.timeline-entry .entry-heading h3')
    .last()
    .textContent();
  const lastSequence = /Entry (\d+):/u.exec(lastHeading ?? '')?.[1];
  if (lastSequence === undefined) {
    throw new Error('The synthetic location event has no journal head.');
  }
  let nextSequence = Number(lastSequence) + 1;
  let tileFailures = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const syntheticUserId = randomUUID();
  await page.route('https://tile.openstreetmap.org/**', async (route) => {
    tileFailures += 1;
    await route.fulfill({ status: 503, body: 'Synthetic tile failure.' });
  });
  await page.route(
    `**/events/${fixture.keyboardEventId}/api`,
    async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (
        body.operation !== 'post-location' &&
        body.operation !== 'correct-location'
      ) {
        await route.continue();
        return;
      }
      bodies.push(body);
      const payload = LocationPayloadSchema.parse(body.payload);
      const sequence = nextSequence;
      nextSequence += 1;
      const entry = JournalEntrySchema.parse({
        id: randomUUID(),
        eventId: fixture.keyboardEventId,
        sequence,
        author: {
          kind: 'human',
          userId: syntheticUserId,
          sessionId: fixture.sessionId,
        },
        source: 'web',
        serverTime: new Date().toISOString(),
        clientTime: body.clientTime,
        supersedes:
          body.operation === 'correct-location'
            ? {
                entryId: body.entryId,
                entrySequence: body.entrySequence,
                kind: 'correction',
                reason: body.reason,
              }
            : null,
        kind: 'location',
        payload,
      });
      await route.fulfill({
        contentType: 'application/json',
        headers: {
          'Idempotency-Key': request.headers()['idempotency-key'] ?? '',
        },
        json: { entry },
      });
    },
  );

  const composer = page.locator('.location-composer');
  await composer.getByLabel('Known coordinates').check();
  await composer
    .getByRole('button', { name: 'Use current device location' })
    .press('Enter');
  await expect(composer.locator('.location-accuracy')).toContainText(
    '±18.5 meters',
  );
  await expect(composer).toContainText(
    'GPS accuracy is a radius and never establishes room-level precision.',
  );
  await composer.getByLabel('Latitude').fill('47.386001');
  await composer.getByLabel('Longitude').fill('-122.623002');
  await composer
    .getByLabel('Location label (optional)')
    .fill('North staff entrance');
  await expect.poll(() => tileFailures).toBeGreaterThan(0);
  await expect(composer).toContainText('Map unavailable.');
  await composer.getByRole('button', { name: 'Post location' }).press('Enter');
  await expect.poll(() => bodies.length).toBe(1);
  const knownSequence = Number(lastSequence) + 1;
  const knownArticle = page.getByRole('article', {
    name: `Entry ${knownSequence}: Location update`,
  });
  await expect(knownArticle).toContainText(
    'latitude 47.386001, longitude -122.623002; GPS accuracy radius ±18.5 meters.',
  );
  expect(bodies[0]?.payload).toEqual({
    state: 'known',
    latitude: 47.386001,
    longitude: -122.623002,
    accuracyMeters: 18.5,
    label: 'North staff entrance',
  });

  await knownArticle
    .getByRole('button', { name: `Correct entry ${knownSequence}` })
    .press('Enter');
  const correctionDialog = page.getByRole('dialog');
  await correctionDialog.getByLabel('Latitude').fill('47.3865');
  await correctionDialog.getByLabel('Longitude').fill('-122.6235');
  await correctionDialog
    .getByLabel('Reason for correction')
    .fill('Corrected the pin before relying on it.');
  await correctionDialog
    .getByRole('button', { name: 'Append correction' })
    .press('Enter');
  await expect.poll(() => bodies.length).toBe(2);
  await expect(knownArticle).toContainText(
    'This original entry was superseded, not deleted.',
  );
  expect(bodies[1]).toMatchObject({
    operation: 'correct-location',
    entrySequence: knownSequence,
    reason: 'Corrected the pin before relying on it.',
    payload: {
      state: 'known',
      latitude: 47.3865,
      longitude: -122.6235,
      accuracyMeters: 18.5,
      label: 'North staff entrance',
    },
  });

  await composer.getByLabel('Ambiguous location').check();
  await composer.getByLabel('Best available label').fill('West field area');
  await composer
    .getByLabel('Why the location is ambiguous')
    .fill('Two possible assembly points.');
  await composer.getByRole('button', { name: 'Post location' }).press('Enter');
  await expect.poll(() => bodies.length).toBe(3);
  await expect(
    page.getByText('Ambiguous location: West field area.'),
  ).toBeVisible();

  await composer
    .getByLabel('Why the location is unknown')
    .fill('Reporter could not verify a location.');
  await composer.getByRole('button', { name: 'Post location' }).press('Enter');
  await expect.poll(() => bodies.length).toBe(4);
  await expect(page.getByText('Location unknown.')).toBeVisible();
  expect(bodies[2]?.payload).toEqual({
    state: 'ambiguous',
    label: 'West field area',
    reason: 'Two possible assembly points.',
  });
  expect(bodies[3]?.payload).toEqual({
    state: 'unknown',
    reason: 'Reporter could not verify a location.',
  });
  await expectAxeClean(page, 'location truth states after failed map tiles');
  await page.unrouteAll({ behavior: 'wait' });
});

test('a concurrent redaction immediately removes and invalidates an open correction dialog', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.concurrentDialogEventId));
  await expect(page.locator('.connection-line')).toContainText('Connected');

  const original = page.getByRole('article', {
    name: 'Entry 1: Text update',
  });
  const articleId = await original.getAttribute('id');
  if (articleId === null || !articleId.startsWith('entry-')) {
    throw new Error('Synthetic correction target is missing its entry ID.');
  }
  const entryId = articleId.slice('entry-'.length);
  await page.getByRole('button', { name: 'Correct entry 1' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Corrected text')).toHaveValue(
    'Synthetic ordered history 001',
  );

  await redactExternalEntry(page, fixture.concurrentDialogEventId, entryId, 1);

  await expect(dialog).not.toBeVisible({ timeout: 8_000 });
  await expect(
    page.getByText('Synthetic ordered history 001', { exact: true }),
  ).toHaveCount(0);
  await expect(original).toContainText(
    'Original content is hidden because a later append-only redaction supersedes this entry.',
  );
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'Entry 1 changed while the dialog was open. No request was sent',
  );
  await expect(
    page.getByRole('button', { name: 'Append correction' }),
  ).toHaveCount(0);
  await expectAxeClean(page, 'event room after concurrent dialog redaction');
});

test('a committed correction with a delayed response never reports that no request was sent', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let resolveCommitted: () => void = () => undefined;
  const committed = new Promise<void>((resolve) => {
    resolveCommitted = resolve;
  });
  let releaseResponse: () => void = () => undefined;
  const responseRelease = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.pendingDialogEventId) &&
      body?.operation === 'correct-text'
    ) {
      const upstream = await route.fetch();
      resolveCommitted();
      await responseRelease;
      await route.fulfill({ response: upstream });
      return;
    }
    await route.continue();
  });

  let scenarioCompleted = false;
  try {
    await page.goto(fixturePath(fixture.pendingDialogEventId));
    await page.getByRole('button', { name: 'Correct entry 1' }).press('Enter');
    await page
      .getByLabel('Corrected text')
      .fill('Correction committed before acknowledgement');
    await page
      .getByLabel('Reason for correction')
      .fill('Synthetic delayed-response regression');
    await page
      .getByRole('button', { name: 'Append correction' })
      .press('Enter');
    await committed;

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('Corrected text')).toHaveCount(0);
    await expect(page.locator('.event-room > .mutation-status')).toContainText(
      'Sending timeline correction',
    );
    await expect(
      page.locator('.event-room > .mutation-status'),
    ).not.toContainText('No request was sent');

    releaseResponse();
    await expect(page.locator('.event-room > .mutation-status')).toContainText(
      'timeline correction confirmed by the server.',
    );
    await expect(
      page.locator('.event-room > .mutation-status'),
    ).not.toContainText('No request was sent');
    await expect(
      page.getByText('Correction committed before acknowledgement', {
        exact: true,
      }),
    ).toBeVisible();
    scenarioCompleted = true;
  } finally {
    releaseResponse();
    await page.unrouteAll({
      behavior: scenarioCompleted ? 'wait' : 'ignoreErrors',
    });
  }
});

test('a definite correction rejection remains truthful when a later poll closes the invalidated dialog', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  let releasePoll: () => void = () => undefined;
  const pollRelease = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let announceHeldPoll: () => void = () => undefined;
  const heldPoll = new Promise<void>((resolve) => {
    announceHeldPoll = resolve;
  });
  let pollIsHeld = false;
  await page.goto(fixturePath(fixture.rejectedDialogRaceEventId));
  await expect(page.locator('.connection-line')).toContainText('Connected');

  const original = page.getByRole('article', {
    name: 'Entry 1: Text update',
  });
  const articleId = await original.getAttribute('id');
  if (articleId === null || !articleId.startsWith('entry-')) {
    throw new Error('Synthetic correction target is missing its entry ID.');
  }
  const entryId = articleId.slice('entry-'.length);
  await page.getByRole('button', { name: 'Correct entry 1' }).press('Enter');
  await page
    .getByLabel('Corrected text')
    .fill('Correction rejected after concurrent redaction');
  await page
    .getByLabel('Reason for correction')
    .fill('Synthetic rejected-response ordering');

  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    const appliesToFixture = request
      .url()
      .includes(fixture.rejectedDialogRaceEventId);
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      appliesToFixture &&
      request.method() === 'POST' &&
      body?.operation === 'correct-text'
    ) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'CONFLICT',
          message: 'Synthetic correction lost the redaction race.',
          requestId: randomUUID(),
          retryable: false,
          fieldErrors: [],
        }),
      });
      return;
    }
    if (appliesToFixture && request.method() === 'GET' && !pollIsHeld) {
      pollIsHeld = true;
      announceHeldPoll();
      await pollRelease;
    }
    await route.continue();
  });

  let scenarioCompleted = false;
  try {
    await redactExternalEntry(
      page,
      fixture.rejectedDialogRaceEventId,
      entryId,
      1,
    );
    await heldPoll;
    await page
      .getByRole('button', { name: 'Append correction' })
      .press('Enter');

    const dialogAlert = page.getByRole('dialog').getByRole('alert');
    await expect(dialogAlert).toBeVisible();
    await expect(dialogAlert).toBeFocused();
    const rejection = await dialogAlert.textContent();
    expect(rejection).toContain(
      'Synthetic correction lost the redaction race.',
    );
    await expect(
      page.getByRole('dialog').locator('.mutation-status'),
    ).toContainText('The request was not accepted.');

    releasePoll();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('Corrected text')).toHaveCount(0);
    const outerError = page.locator('.event-room > .error-panel');
    await expect(outerError).toBeVisible();
    await expect(outerError).toBeFocused();
    await expect(outerError).toHaveText(rejection ?? '');
    await expect(page.locator('.event-room > .mutation-status')).toContainText(
      'The request was not accepted.',
    );
    await expect(
      page.locator('.event-room > .mutation-status'),
    ).not.toContainText('No request was sent');
    await expect(
      page.getByText('Synthetic ordered history 001', { exact: true }),
    ).toHaveCount(0);
    await expect(original).toContainText(
      'Original content is hidden because a later append-only redaction supersedes this entry.',
    );
    scenarioCompleted = true;
  } finally {
    releasePoll();
    await page.unrouteAll({
      behavior: scenarioCompleted ? 'wait' : 'ignoreErrors',
    });
  }
});

test('paginated catch-up hides raw correction content before its terminal page arrives', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const rawText = 'Synthetic ordered history 001';
  let mutationsReady = false;
  let timelineRequests = 0;
  let resolveFirstPageSeen: () => void = () => undefined;
  const firstPageSeen = new Promise<void>((resolve) => {
    resolveFirstPageSeen = resolve;
  });
  let resolveTerminalHeld: () => void = () => undefined;
  const terminalHeld = new Promise<void>((resolve) => {
    resolveTerminalHeld = resolve;
  });
  let releaseTerminal: () => void = () => undefined;
  const terminalRelease = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    if (
      !mutationsReady ||
      request.method() !== 'GET' ||
      !request.url().includes(fixture.paginatedDialogEventId)
    ) {
      await route.continue();
      return;
    }
    timelineRequests += 1;
    const upstream = await route.fetch();
    const value = (await upstream.json()) as {
      entries?: unknown[];
      hasMore?: boolean;
    };
    if (timelineRequests === 1) {
      expect(value.hasMore).toBe(true);
      expect(value.entries).toHaveLength(100);
      expect(JSON.stringify(value.entries)).not.toContain(rawText);
      expect(JSON.stringify(value.entries)).toContain('redaction');
      resolveFirstPageSeen();
      await route.fulfill({ response: upstream, json: value });
      return;
    }
    if (timelineRequests === 2) {
      expect(value.hasMore).toBe(false);
      resolveTerminalHeld();
      await terminalRelease;
    }
    await route.fulfill({ response: upstream, json: value });
  });

  let scenarioCompleted = false;
  try {
    await page.goto(fixturePath(fixture.paginatedDialogEventId));
    const original = page.getByRole('article', {
      name: 'Entry 1: Text update',
    });
    const articleId = await original.getAttribute('id');
    if (articleId === null || !articleId.startsWith('entry-')) {
      throw new Error('Synthetic correction target is missing its entry ID.');
    }
    const entryId = articleId.slice('entry-'.length);
    await page.getByRole('button', { name: 'Correct entry 1' }).press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Corrected text')).toHaveValue(rawText);

    await redactExternalEntry(page, fixture.paginatedDialogEventId, entryId, 1);
    await appendSyntheticBurst(testInfo, fixture.paginatedDialogEventId, 101);
    mutationsReady = true;
    await firstPageSeen;
    await terminalHeld;

    await expect(page.locator('.timeline-panel')).toContainText(
      'Timeline content remains hidden until all authorized history',
    );
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel('Corrected text')).toHaveCount(0);
    await expect(page.getByText(rawText, { exact: true })).toHaveCount(0);
    await expect(page.locator('.event-room > .mutation-status')).toContainText(
      'Timeline synchronization began while the dialog was open. No request was sent',
    );
    await expect(
      page.getByRole('button', { name: 'Append correction' }),
    ).toHaveCount(0);

    releaseTerminal();
    await expect(original).toContainText(
      'Original content is hidden because a later append-only redaction supersedes this entry.',
    );
    scenarioCompleted = true;
  } finally {
    releaseTerminal();
    await page.unrouteAll({
      behavior: scenarioCompleted ? 'wait' : 'ignoreErrors',
    });
  }
});

test('paginated catch-up invalidates all-clear and close confirmations before they can silently no-op', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const eventId = fixture.paginatedLifecycleEventId;

  const expectInvalidatedDuringCatchUp = async (input: {
    readonly openButton: 'Review all-clear' | 'Review event close';
    readonly confirmationLabel:
      | 'Type ALL CLEAR exactly'
      | 'Type CLOSE EVENT exactly';
    readonly confirmationValue: 'ALL CLEAR' | 'CLOSE EVENT';
    readonly submitButton: 'Issue all-clear and notify' | 'Close event';
  }): Promise<void> => {
    await page.getByRole('button', { name: input.openButton }).press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    if (input.openButton === 'Review all-clear') {
      await expect(
        page.getByRole('heading', { name: 'Notification consequences' }),
      ).toBeVisible();
    }
    await page
      .getByLabel(input.confirmationLabel)
      .fill(input.confirmationValue);
    await expect(
      page.getByRole('button', { name: input.submitButton }),
    ).toBeEnabled();

    let releaseMutations: () => void = () => undefined;
    const mutationsCommitted = new Promise<void>((resolve) => {
      releaseMutations = resolve;
    });
    let resolveFirstPageSeen: () => void = () => undefined;
    const firstPageSeen = new Promise<void>((resolve) => {
      resolveFirstPageSeen = resolve;
    });
    let resolveTerminalHeld: () => void = () => undefined;
    const terminalHeld = new Promise<void>((resolve) => {
      resolveTerminalHeld = resolve;
    });
    let releaseTerminal: () => void = () => undefined;
    const terminalRelease = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let timelineRequests = 0;
    await page.route('**/events/*/api**', async (route) => {
      const request = route.request();
      if (request.method() !== 'GET' || !request.url().includes(eventId)) {
        await route.continue();
        return;
      }
      await mutationsCommitted;
      timelineRequests += 1;
      const upstream = await route.fetch();
      const value = (await upstream.json()) as {
        entries?: unknown[];
        hasMore?: boolean;
      };
      if (timelineRequests === 1) {
        expect(value.hasMore).toBe(true);
        expect(value.entries).toHaveLength(100);
        resolveFirstPageSeen();
      } else if (timelineRequests === 2) {
        expect(value.hasMore).toBe(false);
        resolveTerminalHeld();
        await terminalRelease;
      }
      await route.fulfill({ response: upstream, json: value });
    });

    let scenarioCompleted = false;
    try {
      await appendSyntheticBurst(testInfo, eventId, 101);
      releaseMutations();
      await firstPageSeen;
      await terminalHeld;
      await expect(page.locator('.timeline-panel')).toContainText(
        'Timeline content remains hidden until all authorized history',
      );
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('#main-content')).toBeFocused();
      await expect(page.getByLabel(input.confirmationLabel)).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: input.submitButton }),
      ).toHaveCount(0);
      await expect(
        page.locator('.event-room > .mutation-status'),
      ).toContainText(
        'No lifecycle transition request was submitted; reopen the action after the complete timeline is visible.',
      );
      releaseTerminal();
      await expect(page.locator('.timeline-loading-placeholder')).toHaveCount(
        0,
      );
      scenarioCompleted = true;
    } finally {
      releaseMutations();
      releaseTerminal();
      await page.unrouteAll({
        behavior: scenarioCompleted ? 'wait' : 'ignoreErrors',
      });
    }
  };

  await page.goto(fixturePath(eventId));
  await expectInvalidatedDuringCatchUp({
    openButton: 'Review all-clear',
    confirmationLabel: 'Type ALL CLEAR exactly',
    confirmationValue: 'ALL CLEAR',
    submitButton: 'Issue all-clear and notify',
  });

  await issueExternalAllClear(page, eventId);
  await expect(page.locator('.event-status')).toHaveText('All-clear issued', {
    timeout: 10_000,
  });
  await expectInvalidatedDuringCatchUp({
    openButton: 'Review event close',
    confirmationLabel: 'Type CLOSE EVENT exactly',
    confirmationValue: 'CLOSE EVENT',
    submitButton: 'Close event',
  });
});

test('a definite lifecycle rejection survives a later paginated dialog invalidation', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const eventId = fixture.rejectedLifecycleDialogEventId;
  await page.goto(fixturePath(eventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Notification consequences' }),
  ).toBeVisible();
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');

  let releaseFirstPoll: () => void = () => undefined;
  const firstPollRelease = new Promise<void>((resolve) => {
    releaseFirstPoll = resolve;
  });
  let announceFirstPollHeld: () => void = () => undefined;
  const firstPollHeld = new Promise<void>((resolve) => {
    announceFirstPollHeld = resolve;
  });
  let resolveFirstPageSeen: () => void = () => undefined;
  const firstPageSeen = new Promise<void>((resolve) => {
    resolveFirstPageSeen = resolve;
  });
  let resolveTerminalHeld: () => void = () => undefined;
  const terminalHeld = new Promise<void>((resolve) => {
    resolveTerminalHeld = resolve;
  });
  let releaseTerminal: () => void = () => undefined;
  const terminalRelease = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  let timelineRequests = 0;
  await page.route('**/events/*/api**', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(eventId) &&
      body?.operation === 'all-clear'
    ) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'CONFLICT',
          message: 'Synthetic definite all-clear conflict.',
          requestId: randomUUID(),
          retryable: false,
          fieldErrors: [],
        }),
      });
      return;
    }
    if (request.method() !== 'GET' || !request.url().includes(eventId)) {
      await route.continue();
      return;
    }
    timelineRequests += 1;
    if (timelineRequests === 1) {
      announceFirstPollHeld();
      await firstPollRelease;
    }
    const upstream = await route.fetch();
    const value = (await upstream.json()) as {
      entries?: unknown[];
      hasMore?: boolean;
    };
    if (timelineRequests === 1) {
      expect(value.hasMore).toBe(true);
      expect(value.entries).toHaveLength(100);
      resolveFirstPageSeen();
    } else if (timelineRequests === 2) {
      expect(value.hasMore).toBe(false);
      resolveTerminalHeld();
      await terminalRelease;
    }
    await route.fulfill({ response: upstream, json: value });
  });

  let scenarioCompleted = false;
  try {
    await firstPollHeld;
    await page
      .getByRole('button', { name: 'Issue all-clear and notify' })
      .press('Enter');
    const dialogAlert = page.getByRole('dialog').getByRole('alert');
    await expect(dialogAlert).toBeVisible();
    await expect(dialogAlert).toBeFocused();
    await expect(dialogAlert).toContainText(
      'Synthetic definite all-clear conflict.',
    );
    await expect(
      page.getByRole('dialog').locator('.mutation-status'),
    ).toContainText('The request was not accepted.');

    await appendSyntheticBurst(testInfo, eventId, 101);
    releaseFirstPoll();
    await firstPageSeen;
    await terminalHeld;
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const outerError = page.locator('.event-room > .error-panel');
    await expect(outerError).toContainText(
      'Synthetic definite all-clear conflict.',
    );
    await expect(outerError).toBeFocused();
    await expect(page.locator('.event-room > .mutation-status')).toContainText(
      'The request was not accepted. No change was recorded by this attempt.',
    );
    await expect(
      page.locator('.event-room > .mutation-status'),
    ).not.toContainText('No lifecycle transition request was submitted');
    releaseTerminal();
    await expect(page.locator('.timeline-loading-placeholder')).toHaveCount(0);
    scenarioCompleted = true;
  } finally {
    releaseFirstPoll();
    releaseTerminal();
    await page.unrouteAll({
      behavior: scenarioCompleted ? 'wait' : 'ignoreErrors',
    });
  }
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
    const value = (await response.json()) as {
      entries?: Array<{ entry?: unknown }>;
    };
    return value.entries?.[0]?.entry ?? null;
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
    await expect(page.locator('.event-room > .mutation-status')).toContainText(
      'Clearing this browser record sent no new request; the prior outcome remains determined by the verified timeline and event status.',
    );
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
  await expect(page.locator('.event-room > .error-panel')).toContainText(
    'This page load sent no new request; any prior request outcome remains unresolved.',
  );
  await expect(
    page.getByRole('button', { name: 'Retry exact retained request' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Update text')).toBeDisabled();
  await page.waitForTimeout(1_000);
  expect(postCount).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('a missing local CSRF preflight never claims that the server rejected a request', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.recoveryOwnerEventId));
  await page.context().clearCookies({ name: '__Host-psd-eoc-csrf' });
  let postCount = 0;
  await page.route('**/events/*/api', async (route) => {
    if (route.request().method() === 'POST') postCount += 1;
    await route.continue();
  });

  await page
    .getByLabel('Update text')
    .fill('Local CSRF preflight must fail before fetch');
  await page.getByRole('button', { name: 'Post update' }).press('Enter');
  const error = page.locator('.event-room > .error-panel');
  await expect(error).toContainText(
    'Your session is missing its request-protection cookie.',
  );
  await expect(error).toBeFocused();
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'The request was not accepted. No change was recorded by this attempt.',
  );
  await expect(
    page.locator('.event-room > .mutation-status'),
  ).not.toContainText('The server rejected the request');
  await expect(
    page.getByRole('heading', { name: 'Previous request needs verification' }),
  ).toHaveCount(0);
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

test('the preview UI retries the exact committed request and rejects a mismatched acknowledgement', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const before = await lifecyclePreviewIds(
    testInfo,
    fixture.previewRetryEventId,
  );
  const requestKeys: string[] = [];
  const requestBodies: string[] = [];
  let firstCommitted = false;
  let firstFinished = false;
  let releaseFirst: () => void = () => undefined;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() !== 'POST' ||
      !request.url().includes(fixture.previewRetryEventId) ||
      body?.operation !== 'preview-all-clear'
    ) {
      await route.continue();
      return;
    }
    requestKeys.push(request.headers()['idempotency-key'] ?? 'missing');
    requestBodies.push(request.postData() ?? 'missing');
    if (requestKeys.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      firstCommitted = true;
      await firstRelease;
      await route.abort('timedout').catch(() => undefined);
      firstFinished = true;
      return;
    }
    if (requestKeys.length === 2) {
      const replay = await route.fetch();
      expect(replay.ok()).toBe(true);
      await route.fulfill({
        response: replay,
        headers: {
          ...replay.headers(),
          'idempotency-key': `event-room-preview-${randomUUID()}`,
        },
      });
      return;
    }
    await route.continue();
  });

  let scenarioCompleted = false;
  try {
    await page.goto(fixturePath(fixture.previewRetryEventId));
    await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
    await expect.poll(() => firstCommitted).toBe(true);
    await expect(page.getByRole('dialog')).toContainText(
      'The all-clear preview timed out.',
      { timeout: 12_000 },
    );
    releaseFirst();
    await expect.poll(() => firstFinished).toBe(true);

    await page.getByRole('button', { name: 'Retry preview' }).press('Enter');
    await expect(page.getByRole('dialog')).toContainText(
      'PSD EOC did not acknowledge the exact preview request key.',
    );
    await page.getByRole('button', { name: 'Retry preview' }).press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Notification consequences' }),
    ).toBeVisible();

    expect(requestKeys).toHaveLength(3);
    expect(new Set(requestKeys).size).toBe(1);
    expect(new Set(requestBodies).size).toBe(1);
    const after = await lifecyclePreviewIds(
      testInfo,
      fixture.previewRetryEventId,
    );
    expect(after).toHaveLength(before.length + 1);
    scenarioCompleted = true;
  } finally {
    releaseFirst();
    await page.unrouteAll({
      behavior: scenarioCompleted ? 'wait' : 'ignoreErrors',
    });
  }
});

test('a blocked all-clear preview keeps classification visible and an operable keyboard dismissal', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.stalledPreviewEventId));
  const prepared = await postPreview(
    page,
    fixture.stalledPreviewEventId,
    `event-room-preview-${randomUUID()}`,
    true,
  );
  expect(prepared.status).toBe(200);
  const value = prepared.value as Record<string, unknown>;
  const preview = value.preview as Record<string, unknown>;
  const channels = preview.channels as Array<Record<string, unknown>>;
  const blockedValue = {
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
  };
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
      const idempotencyKey = request.headers()['idempotency-key'];
      expect(idempotencyKey).toBeTruthy();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Idempotency-Key': idempotencyKey ?? '',
        },
        body: JSON.stringify(blockedValue),
      });
      return;
    }
    await route.continue();
  });

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
  let stalePollJson: unknown = null;
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
      stalePollJson = json;
      pollCaptured = true;
      await pollRelease;
      await route.fulfill({ response: upstream, json }).catch(() => undefined);
      return;
    }
    if (isEventPoll && eventPolls === 2) {
      retryHeld = true;
      await retryRelease;
      expect(stalePollJson).not.toBeNull();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: stalePollJson,
      });
      return;
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
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'Synchronizing the complete timeline',
  );
  await expect(page.locator('.timeline-panel')).toContainText(
    'Timeline content remains hidden until all authorized history',
  );
  await expect(page.locator('.event-status')).toHaveText('Active');
  await expect(
    page.getByRole('button', { name: 'Review all-clear' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Review event close' }),
  ).toHaveCount(0);

  releasePoll();
  await expect.poll(() => retryHeld).toBe(true);
  await expect(page.locator('.timeline-panel')).toContainText(
    'Timeline content remains hidden until all authorized history',
  );
  await expect(page.locator('.event-status')).toHaveText('Active');
  releaseRetry();
  await page.waitForTimeout(1_000);
  expect(eventPolls).toBe(2);
  await expect.poll(() => eventPolls, { timeout: 12_000 }).toBeGreaterThan(2);
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

test('a quick hide and show interrupts an active poll delay without overlapping the refresh', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.addInitScript(() => {
    let hidden = false;
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
    if (
      route.request().method() === 'GET' &&
      route.request().url().includes(fixture.keyboardEventId)
    ) {
      timelineRequests += 1;
      await requestRelease;
    }
    await route.continue();
  });

  try {
    await page.goto(fixturePath(fixture.keyboardEventId));
    await page.waitForTimeout(250);
    expect(timelineRequests).toBe(0);
    await page.evaluate(() => {
      const setHidden = Reflect.get(window, '__eventRoomSetHidden') as (
        hidden: boolean,
      ) => void;
      setHidden(true);
      setHidden(false);
    });
    await expect.poll(() => timelineRequests, { timeout: 2_000 }).toBe(1);
    await page.evaluate(() => {
      const setHidden = Reflect.get(window, '__eventRoomSetHidden') as (
        hidden: boolean,
      ) => void;
      setHidden(true);
      setHidden(false);
    });
    await page.waitForTimeout(1_000);
    expect(timelineRequests).toBe(1);
  } finally {
    releaseRequest();
    await page.unrouteAll({ behavior: 'wait' });
  }
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
  await expect(
    page.getByText('Timeline refresh timed out. PSD EOC will keep checking.', {
      exact: true,
    }),
  ).toBeVisible();
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

test('a canonical all-clear response whose transition belongs to another request remains unresolved', async ({
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
      request.url().includes(fixture.mismatchedAllClearTransitionEventId) &&
      body?.operation === 'all-clear'
    ) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as Record<string, unknown>;
      const mismatchedTransition = {
        ...(value.transition as Record<string, unknown>),
        idempotencyKey: `event-room-${randomUUID()}`,
      };
      const rewriteEntries = (candidate: unknown): unknown =>
        (candidate as readonly Record<string, unknown>[]).map((entry) => ({
          ...entry,
          payload: {
            ...(entry.payload as Record<string, unknown>),
            transition: mismatchedTransition,
          },
        }));
      await route.fulfill({
        response: upstream,
        json: {
          ...value,
          transition: mismatchedTransition,
          journalEntries: rewriteEntries(value.journalEntries),
          entries: rewriteEntries(value.entries),
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.mismatchedAllClearTransitionEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
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
  await expect(
    page.locator('.event-room > .mutation-status'),
  ).not.toContainText('confirmed by the server');
  await expect(page.locator('.event-room > .error-panel')).toBeFocused();
  await page.unrouteAll({ behavior: 'wait' });
});

test('a canonical close response whose transition belongs to another request remains unresolved', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  await page.goto(fixturePath(fixture.mismatchedTransitionEventId));
  await page.getByRole('button', { name: 'Review all-clear' }).press('Enter');
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');
  await page
    .getByRole('button', { name: 'Issue all-clear and notify' })
    .press('Enter');
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.route('**/events/*/api', async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (
      request.method() === 'POST' &&
      request.url().includes(fixture.mismatchedTransitionEventId) &&
      body?.operation === 'close'
    ) {
      const upstream = await route.fetch();
      const value = (await upstream.json()) as Record<string, unknown>;
      const mismatchedTransition = {
        ...(value.transition as Record<string, unknown>),
        idempotencyKey: `event-room-${randomUUID()}`,
      };
      const rewriteEntries = (candidate: unknown): unknown =>
        (candidate as readonly Record<string, unknown>[]).map((entry) => ({
          ...entry,
          payload: {
            ...(entry.payload as Record<string, unknown>),
            transition: mismatchedTransition,
          },
        }));
      await route.fulfill({
        response: upstream,
        json: {
          ...value,
          transition: mismatchedTransition,
          journalEntries: rewriteEntries(value.journalEntries),
          entries: rewriteEntries(value.entries),
        },
      });
      return;
    }
    await route.continue();
  });

  const reviewClose = page.getByRole('button', { name: 'Review event close' });
  await expect(reviewClose).toBeEnabled();
  await reviewClose.press('Enter');
  await page.getByLabel('Type CLOSE EVENT exactly').fill('CLOSE EVENT');
  await page.getByRole('button', { name: 'Close event' }).press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Previous request needs verification' }),
  ).toBeVisible();
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'The outcome is unresolved.',
  );
  await expect(
    page.locator('.event-room > .mutation-status'),
  ).not.toContainText('confirmed by the server');
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

test('a private photo receives a fresh authorized read grant after reload', async ({
  page,
}, testInfo) => {
  await installDeterministicIntersectionObserver(page);
  const fixture = await readFixture(testInfo);
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId: fixture.photoUploadMediaId,
    mediaId: fixture.photoUploadMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoEventId));
  const figure = page
    .getByRole('article', { name: 'Entry 1: Photo update', exact: true })
    .locator('figure.photo-entry');
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).activeTargets)
    .toBe(1);
  await triggerPrivatePhotoIntersection(figure);
  const photo = page.getByRole('img', {
    name: 'Synthetic emergency operations scene; no people are shown.',
  });
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(photo).toHaveAttribute('src', /[?&]grant=1$/u);
  const firstReadUrl = await photo.getAttribute('src');
  expect(firstReadUrl).toBe(media.readGrantRequests[0]?.readUrl);
  expect(media.readGrantRequests).toHaveLength(1);
  await expect.poll(() => media.imageRequests.length).toBe(1);

  await page.reload();
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).activeTargets)
    .toBe(1);
  await triggerPrivatePhotoIntersection(figure);
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute('src', /[?&]grant=2$/u);
  const reloadedReadUrl = await photo.getAttribute('src');
  expect(reloadedReadUrl).toBe(media.readGrantRequests[1]?.readUrl);
  expect(reloadedReadUrl).not.toBe(firstReadUrl);
  expect(media.readGrantRequests).toHaveLength(2);
  await expect.poll(() => media.imageRequests.length).toBe(2);
  expect(
    media.readGrantRequests.every(
      (request) =>
        request.eventId === fixture.photoEventId &&
        request.mediaId === fixture.photoMediaId &&
        request.headers['idempotency-key'] === undefined &&
        request.headers['x-psd-eoc-csrf'] === undefined,
    ),
  ).toBe(true);
  await expectAxeClean(page, 'authorized private photo after reload');
});

test('photo upload uses canonical create, exact CORS PUT, completion, journal post, and authorized read', async ({
  page,
}, testInfo) => {
  await installDeterministicIntersectionObserver(page);
  const fixture = await readFixture(testInfo);
  const uploadEventId = fixture.photoEventId;
  const uploadedMediaId = fixture.photoUploadMediaId;
  const media = await installSyntheticMediaRoutes(page, {
    eventId: uploadEventId,
    uploadIntentId: uploadedMediaId,
    mediaId: uploadedMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });
  const journalRequests: Array<
    Readonly<{
      body: unknown;
      headers: Readonly<Record<string, string>>;
    }>
  > = [];
  await page.route(`**/events/${uploadEventId}/api`, async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (body?.operation === 'post-photo') {
      media.stages.push('post-photo');
      journalRequests.push({ body, headers: request.headers() });
    }
    await route.continue();
  });

  await page.goto(fixturePath(uploadEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(1);
  await expect(
    page.locator('.photo-composer .dialog-classification'),
  ).toContainText('DRILL — TRAINING ONLY');
  const pageOrigin = await page.evaluate(() => window.location.origin);
  const photoFile = page.getByLabel('Photo file');
  await photoFile.setInputFiles({
    name: 'synthetic-staff-exercise.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  const altText = page.getByLabel('Photo description (alternative text)');
  await expect(altText).toHaveValue(
    /^Photo by Synthetic Event Room Operator at .+\. Visual details were not described\.$/u,
  );
  await altText.fill('Synthetic staff exercise photo');
  await page
    .getByLabel('Caption (optional)')
    .fill('Synthetic staff-only exercise evidence');
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');

  await expect.poll(() => media.createRequests.length).toBe(1);
  await expect.poll(() => media.completionRequests.length).toBe(1);
  await expect.poll(() => journalRequests.length).toBe(1);
  const postedEntry = page.getByRole('article', {
    name: 'Entry 2: Photo update',
    exact: true,
  });
  await expect(page.locator('.timeline-entry')).toHaveCount(2);
  await expect(postedEntry).toContainText('Synthetic staff exercise photo');
  await expect(postedEntry).toContainText(
    'Synthetic staff-only exercise evidence',
  );
  await expect(
    postedEntry.locator('.photo-entry .dialog-classification'),
  ).toContainText('DRILL — TRAINING ONLY');
  expect(media.createInputs).toEqual([
    {
      eventId: uploadEventId,
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
  expectSyntheticCorsUpload(media, pageOrigin);
  expect(media.uploadRequests[0]?.body).toEqual(SYNTHETIC_PNG);
  expect(media.uploadRequests[0]?.headers['content-type']).toBe('image/png');
  expect(media.uploadRequests[0]?.headers['if-none-match']).toBe('*');
  expect(media.uploadRequests[0]?.headers.authorization).toBeUndefined();
  expect(media.uploadRequests[0]?.headers.cookie).toBeUndefined();
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
    mediaId: uploadedMediaId,
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
    media.stages.filter(
      (stage) => stage !== 'read-grant' && stage !== 'read-image',
    ),
  ).toEqual(['create-intent', 'upload-bytes', 'complete-upload', 'post-photo']);

  await postedEntry
    .getByRole('button', { name: 'Load private photo for entry 2' })
    .press('Enter');
  const postedPhoto = postedEntry.getByRole('img', {
    name: 'Synthetic staff exercise photo',
  });
  await expect(postedPhoto).toBeVisible();
  await expect(postedPhoto).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(
    media.readGrantRequests.some(
      (request) =>
        request.eventId === uploadEventId &&
        request.mediaId === uploadedMediaId,
    ),
  ).toBe(true);
  expect(
    media.imageRequests.some((request) =>
      new URL(request.url).pathname.endsWith(`/${uploadedMediaId}`),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      uploadEventId,
    ),
  ).toBeNull();
  await expectAxeClean(page, 'canonical private photo upload and read');
});

test('a definite photo timeline rejection reports no post and clears browser recovery', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const uploadIntentId = randomUUID();
  const mediaId = randomUUID();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId,
    mediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });
  let photoPostAttempts = 0;
  await page.route(`**/events/${fixture.photoEventId}/api`, async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (body?.operation === 'post-photo') {
      photoPostAttempts += 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'CONFLICT',
          message: 'Synthetic definite photo-post conflict.',
          requestId: randomUUID(),
          retryable: false,
          fieldErrors: [],
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.photoEventId));
  const timelineEntries = page.locator('.timeline-entry');
  const originalEntryCount = await timelineEntries.count();
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-definite-rejection.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByLabel('Photo description (alternative text)')
    .fill('Synthetic definitely rejected photo post');
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');

  await expect.poll(() => photoPostAttempts).toBe(1);
  expect(media.createRequests).toHaveLength(1);
  expect(media.uploadRequests).toHaveLength(1);
  expect(media.completionRequests).toHaveLength(1);
  await expect(page.locator('.photo-status')).toHaveText(
    'Photo validation was confirmed, but the timeline post request was rejected. No photo timeline entry was posted.',
  );
  const rejection = page.locator('.event-room > .error-panel');
  await expect(rejection).toContainText(
    'Synthetic definite photo-post conflict.',
  );
  await expect(rejection).toBeFocused();
  await expect(page.locator('.event-room > .mutation-status')).toContainText(
    'The request was not accepted. No change was recorded by this attempt.',
  );
  await expect(page.locator('.recovery-panel')).toHaveCount(0);
  await expect(page.locator('.photo-pending')).toHaveCount(0);
  await expect(timelineEntries).toHaveCount(originalEntryCount);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(`psd-eoc:event-room:pending:v1:${eventId}`),
      fixture.photoEventId,
    ),
  ).toBeNull();
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.photoEventId,
    ),
  ).toBeNull();
  await expectAxeClean(page, 'definite photo timeline rejection');
});

test('oversized and disguised malformed photos show focused axe-clean errors and never post', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
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
      if (
        route.request().method() === 'POST' &&
        route.request().postData()?.includes('"operation":"post-photo"') ===
          true
      ) {
        photoJournalPosts += 1;
      }
      await route.continue();
    },
  );

  await page.goto(fixturePath(fixture.keyboardEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-oversized.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(25 * 1_024 * 1_024 + 1),
  });
  await expect(
    page.getByRole('button', { name: 'Upload and post photo' }),
  ).toBeDisabled();
  let alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(/25 MiB|too large/iu);
  await expect(alert).toBeFocused();
  expect(media.createRequests).toHaveLength(0);
  expect(media.uploadRequests).toHaveLength(0);
  expect(media.completionRequests).toHaveLength(0);
  expect(photoJournalPosts).toBe(0);
  await expectAxeClean(page, 'oversized photo validation error');

  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-disguised-image.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_DISGUISED_NON_IMAGE,
  });
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(
    'The image could not be safely processed. Choose a different image and try again.',
  );
  await expect(alert).toBeFocused();
  expect(media.createRequests).toHaveLength(1);
  expect(media.uploadRequests).toHaveLength(1);
  expect(media.completionRequests).toHaveLength(1);
  expect(photoJournalPosts).toBe(0);
  await expectAxeClean(page, 'disguised malformed photo processing error');
});

test('malformed, cross-event, and expired read grants fail focused without image GET or URL persistence until explicit retry', async ({
  page,
}, testInfo) => {
  await installDeterministicIntersectionObserver(page);
  const fixture = await readFixture(testInfo);
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
    readGrantOutcomes: [
      'malformed',
      'ready',
      'cross-event',
      'ready',
      'expired',
      'ready',
    ],
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  for (const sequence of [3, 4, 5]) {
    const entry = page.getByRole('article', {
      name: `Entry ${sequence}: Photo update`,
      exact: true,
    });
    const figure = entry.locator('figure.photo-entry');
    const grantCount = media.readGrantRequests.length;
    const imageCount = media.imageRequests.length;
    await entry
      .getByRole('button', {
        name: `Load private photo for entry ${sequence}`,
      })
      .press('Enter');
    const error = figure.locator('.photo-read-error');
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
    await expect(error).toContainText(
      'PSD EOC returned a private photo authorization that does not match this event.',
    );
    expect(media.readGrantRequests).toHaveLength(grantCount + 1);
    expect(media.imageRequests).toHaveLength(imageCount);
    expect(
      await persistedSessionValuesContaining(page, SYNTHETIC_MEDIA_ORIGIN),
    ).toEqual([]);

    const rejectedReadUrl = media.readGrantRequests.at(-1)?.readUrl;
    await error
      .getByRole('button', {
        name: `Retry private photo for entry ${sequence}`,
      })
      .press('Enter');
    await expect
      .poll(() => media.readGrantRequests.length)
      .toBe(grantCount + 2);
    expect(media.readGrantRequests.at(-1)?.readUrl).not.toBe(rejectedReadUrl);
    await expect.poll(() => media.imageRequests.length).toBe(imageCount + 1);
    await expect(
      entry.getByRole('img', {
        name: `Synthetic bounded-loader private photo ${sequence}.`,
      }),
    ).toBeVisible();
    expect(
      await persistedSessionValuesContaining(page, SYNTHETIC_MEDIA_ORIGIN),
    ).toEqual([]);
  }
  expect(media.readGrantRequests.map(({ outcome }) => outcome)).toEqual([
    'malformed',
    'ready',
    'cross-event',
    'ready',
    'expired',
    'ready',
  ]);
  await expectAxeClean(page, 'explicit recovery from invalid read grants');
});

test('a raw noncanonical read URL still reaches focused onError recovery and requires a fresh grant', async ({
  page,
}, testInfo) => {
  await installDeterministicIntersectionObserver(page);
  const fixture = await readFixture(testInfo);
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
    readGrantOutcomes: ['raw-noncanonical', 'ready'],
    imageOutcomes: ['error', 'ready'],
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  const entry = page.getByRole('article', {
    name: 'Entry 6: Photo update',
    exact: true,
  });
  const figure = entry.locator('figure.photo-entry');
  await entry
    .getByRole('button', { name: 'Load private photo for entry 6' })
    .press('Enter');
  const error = figure.locator('.photo-read-error');
  await expect(error).toBeVisible();
  await expect(error).toBeFocused();
  await expect(error).toContainText(
    'The authorized private photo could not be displayed. Request a fresh authorization to retry.',
  );
  expect(media.readGrantRequests).toHaveLength(1);
  expect(media.imageRequests).toHaveLength(1);
  expect(media.readGrantRequests[0]?.outcome).toBe('raw-noncanonical');
  expect(media.imageRequests[0]?.url).not.toBe(
    media.readGrantRequests[0]?.readUrl,
  );
  expect(
    await persistedSessionValuesContaining(page, SYNTHETIC_MEDIA_ORIGIN),
  ).toEqual([]);

  await error
    .getByRole('button', { name: 'Retry private photo for entry 6' })
    .press('Enter');
  await expect.poll(() => media.readGrantRequests.length).toBe(2);
  await expect.poll(() => media.imageRequests.length).toBe(2);
  await expect(
    entry.getByRole('img', {
      name: 'Synthetic bounded-loader private photo 6.',
    }),
  ).toBeVisible();
  expect(media.readGrantRequests[1]?.outcome).toBe('ready');
  await expectAxeClean(page, 'raw read URL image failure recovery');
});

test('a redacted photo mounts no stateful loader and requests no grant or image', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
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
  await expect(page.locator('[data-private-photo-mount]')).toHaveCount(0);
  await expect(page.locator('.timeline-entry img')).toHaveCount(0);
  await page.waitForTimeout(750);
  expect(media.readGrantRequests).toHaveLength(0);
  expect(media.imageRequests).toHaveLength(0);
  await expectAxeClean(page, 'redacted photo without private media access');
});

test('private photo history never exceeds ten stateful mounts and keeps only nine recent observers while an older selection is active', async ({
  page,
}, testInfo) => {
  await installDeterministicIntersectionObserver(page);
  await installPrivatePhotoMountProbe(page);
  const fixture = await readFixture(testInfo);
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(12);
  await expect(
    page.locator('[data-private-photo-mount="stateful"]'),
  ).toHaveCount(10);
  await expect(
    page.locator('[data-private-photo-mount="deferred"]'),
  ).toHaveCount(2);
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).activeTargets)
    .toBe(10);

  const oldestEntry = page.getByRole('article', {
    name: 'Entry 1: Photo update',
    exact: true,
  });
  await oldestEntry
    .getByRole('button', { name: 'Load older private photo for entry 1' })
    .press('Enter');
  await expect(oldestEntry.locator('figure.photo-entry')).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect(
    page
      .getByRole('article', {
        name: 'Entry 3: Photo update',
        exact: true,
      })
      .locator('figure.photo-entry'),
  ).toHaveAttribute('data-private-photo-mount', 'deferred');
  await expect(
    page.locator('[data-private-photo-mount="stateful"]'),
  ).toHaveCount(10);
  await expect(
    page.locator('[data-private-photo-mount="deferred"]'),
  ).toHaveCount(2);
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).activeTargets)
    .toBe(9);

  const secondEntry = page.getByRole('article', {
    name: 'Entry 2: Photo update',
    exact: true,
  });
  await secondEntry
    .getByRole('button', { name: 'Load older private photo for entry 2' })
    .press('Enter');
  await expect(secondEntry.locator('figure.photo-entry')).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect(oldestEntry.locator('figure.photo-entry')).toHaveAttribute(
    'data-private-photo-mount',
    'deferred',
  );
  await expect(oldestEntry.locator('img')).toHaveCount(0);
  await expect(
    page.locator('[data-private-photo-mount="stateful"]'),
  ).toHaveCount(10);
  await expect(
    page.locator('[data-private-photo-mount="deferred"]'),
  ).toHaveCount(2);
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).activeTargets)
    .toBe(9);
  expect(await privatePhotoMountStats(page)).toEqual({
    maxStateful: 10,
    stateful: 10,
  });
  expect(media.readGrantRequests.map(({ mediaId }) => mediaId)).toEqual([
    fixture.photoStressOldestMediaId,
    fixture.photoStressSecondMediaId,
  ]);
  expect(media.maxConcurrentReadGrantRequests).toBeLessThanOrEqual(2);
  expect(media.maxConcurrentImageRequests).toBeLessThanOrEqual(2);
  await expectAxeClean(page, 'bounded selected older private photo history');
});

test('a displaced recent private photo can replace the selected older photo without exceeding any loader bound', async ({
  page,
}, testInfo) => {
  await installDeterministicIntersectionObserver(page);
  await installPrivatePhotoMountProbe(page);
  const fixture = await readFixture(testInfo);
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  await expect(page.locator('.timeline-entry')).toHaveCount(12);
  await expect(
    page.locator('[data-private-photo-mount="stateful"]'),
  ).toHaveCount(10);
  await expect(
    page.locator('[data-private-photo-mount="deferred"]'),
  ).toHaveCount(2);
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).activeTargets)
    .toBe(10);

  const oldestEntry = page.getByRole('article', {
    name: 'Entry 1: Photo update',
    exact: true,
  });
  const oldestFigure = oldestEntry.locator('figure.photo-entry');
  await oldestEntry
    .getByRole('button', { name: 'Load older private photo for entry 1' })
    .press('Enter');
  await expect(oldestFigure).toBeFocused();
  await expect(oldestFigure).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect
    .poll(() =>
      media.readGrantRequests.some(
        ({ mediaId }) => mediaId === fixture.photoStressOldestMediaId,
      ),
    )
    .toBe(true);
  expect(media.readGrantRequests).toHaveLength(1);
  await expect.poll(() => media.concurrentReadGrantRequests).toBe(0);
  await expect.poll(() => media.concurrentImageRequests).toBe(0);

  const displacedEntry = page.getByRole('article', {
    name: 'Entry 3: Photo update',
    exact: true,
  });
  const displacedFigure = displacedEntry.locator('figure.photo-entry');
  await expect(displacedFigure).toHaveAttribute(
    'data-private-photo-mount',
    'deferred',
  );
  const loadDisplaced = displacedEntry.getByRole('button', {
    name: 'Load older private photo for entry 3',
  });
  await expect(loadDisplaced).toBeEnabled();
  await loadDisplaced.focus();
  await expect(loadDisplaced).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(oldestFigure).toHaveAttribute(
    'data-private-photo-mount',
    'deferred',
  );
  await expect(oldestFigure.locator('img')).toHaveCount(0);
  await expect(displacedFigure).toHaveAttribute(
    'data-private-photo-mount',
    'stateful',
  );
  await expect(displacedFigure).toHaveAttribute(
    'data-private-photo-observer',
    'disabled',
  );
  await expect(displacedFigure).toBeFocused();
  await expect(
    displacedEntry.getByRole('img', {
      name: 'Synthetic bounded-loader private photo 3.',
    }),
  ).toBeVisible();
  await expect(displacedFigure).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect(displacedFigure).toBeFocused();
  await expect.poll(() => media.readGrantRequests.length).toBe(2);
  await expect.poll(() => media.imageRequests.length).toBe(2);
  expect(media.maxConcurrentReadGrantRequests).toBeLessThanOrEqual(2);
  expect(media.maxConcurrentImageRequests).toBeLessThanOrEqual(2);
  await expect.poll(() => media.concurrentReadGrantRequests).toBe(0);
  await expect.poll(() => media.concurrentImageRequests).toBe(0);

  await expect(
    page.locator('[data-private-photo-mount="stateful"]'),
  ).toHaveCount(10);
  await expect(
    page.locator('[data-private-photo-mount="deferred"]'),
  ).toHaveCount(2);
  await expect
    .poll(async () => (await privatePhotoIntersectionStats(page)).activeTargets)
    .toBe(9);
  expect(await privatePhotoMountStats(page)).toEqual({
    maxStateful: 10,
    stateful: 10,
  });
  expect(media.readGrantRequests[0]?.mediaId).toBe(
    fixture.photoStressOldestMediaId,
  );
  expect(media.readGrantRequests[1]?.mediaId).not.toBe(
    fixture.photoStressOldestMediaId,
  );
  await expectAxeClean(page, 'displaced recent private photo selection');
});

test('private photo loading and out-of-order decoding never use more than two jobs', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: undefined,
      writable: true,
    });
  });
  await installControllableImageDecode(page);
  const fixture = await readFixture(testInfo);
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoStressEventId,
    uploadIntentId: fixture.photoStressMiddleMediaId,
    mediaId: fixture.photoStressMiddleMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });

  await page.goto(fixturePath(fixture.photoStressEventId));
  await expect(
    page
      .getByText(
        'Automatic viewport loading is unavailable in this browser. Load this private photo explicitly if it is operationally needed.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  const entry = (sequence: number) =>
    page.getByRole('article', {
      name: `Entry ${sequence}: Photo update`,
      exact: true,
    });
  const figure = (sequence: number) => entry(sequence).locator('figure');
  const load = (sequence: number) =>
    entry(sequence).getByRole('button', {
      name: `Load private photo for entry ${sequence}`,
    });

  await load(3).press('Enter');
  await load(4).evaluate((button) => (button as HTMLButtonElement).click());
  await load(5).evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => media.readGrantRequests.length).toBe(2);
  await expect.poll(() => media.imageRequests.length).toBe(2);
  await expect
    .poll(async () => (await privatePhotoDecodeStats(page)).active)
    .toBe(2);
  expect(await privatePhotoDecodeStats(page)).toMatchObject({
    active: 2,
    maxActive: 2,
  });
  expect(media.maxConcurrentReadGrantRequests).toBeLessThanOrEqual(2);
  expect(media.maxConcurrentImageRequests).toBeLessThanOrEqual(2);

  expect(
    await releasePrivatePhotoDecode(
      page,
      'Synthetic bounded-loader private photo 4.',
    ),
  ).toBe(true);
  await expect.poll(() => media.readGrantRequests.length).toBe(3);
  await expect.poll(() => media.imageRequests.length).toBe(3);
  await expect
    .poll(async () => (await privatePhotoDecodeStats(page)).active)
    .toBe(2);
  expect((await privatePhotoDecodeStats(page)).maxActive).toBe(2);
  await expect(figure(4)).toHaveAttribute(
    'data-private-photo-state',
    'evicted',
  );
  await expect(figure(4).locator('img')).toHaveCount(0);

  expect(
    await releasePrivatePhotoDecode(
      page,
      'Synthetic bounded-loader private photo 3.',
    ),
  ).toBe(true);
  expect(
    await releasePrivatePhotoDecode(
      page,
      'Synthetic bounded-loader private photo 5.',
    ),
  ).toBe(true);
  await expect(figure(5)).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expect.poll(() => page.locator('.timeline-entry img').count()).toBe(2);
  expect((await privatePhotoDecodeStats(page)).maxActive).toBe(2);
  await expectAxeClean(page, 'two-slot private photo loader');
});

test('every private photo load has a fixed sixty-second deadline that frees slots and exposes explicit retry', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: undefined,
      writable: true,
    });
  });
  await installControllableImageDecode(page);
  await page.clock.install();
  const fixture = await readFixture(testInfo);
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
  const figure = (sequence: number) => entry(sequence).locator('figure');
  const load = (sequence: number) =>
    entry(sequence).getByRole('button', {
      name: `Load private photo for entry ${sequence}`,
    });

  await load(3).evaluate((button) => (button as HTMLButtonElement).click());
  await load(4).evaluate((button) => (button as HTMLButtonElement).click());
  await load(5).press('Enter');
  await expect.poll(() => media.readGrantRequests.length).toBe(2);
  await expect
    .poll(async () => (await privatePhotoDecodeStats(page)).active)
    .toBe(2);

  await page.clock.fastForward(60_001);
  await expect.poll(() => media.readGrantRequests.length).toBe(3);
  await expect
    .poll(async () =>
      (await privatePhotoDecodeStats(page)).pendingAltText.includes(
        'Synthetic bounded-loader private photo 5.',
      ),
    )
    .toBe(true);
  expect(await privatePhotoDecodeStats(page)).toMatchObject({
    active: 1,
    maxActive: 2,
  });
  for (const sequence of [3, 4]) {
    const error = figure(sequence).locator('.photo-read-error');
    await expect(error).toContainText(
      'Private photo loading exceeded the 60-second safety limit and was stopped.',
    );
    await expect(
      error.getByRole('button', {
        name: `Retry private photo for entry ${sequence}`,
      }),
    ).toBeVisible();
  }
  await page.clock.fastForward(60_001);
  const finalError = figure(5).locator('.photo-read-error');
  await expect(finalError).toContainText(
    'Private photo loading exceeded the 60-second safety limit and was stopped.',
  );
  await expect(finalError).toBeFocused();
  await expect(
    finalError.getByRole('button', {
      name: 'Retry private photo for entry 5',
    }),
  ).toBeVisible();
  expect(await privatePhotoDecodeStats(page)).toMatchObject({
    active: 0,
    maxActive: 2,
    pendingAltText: [],
  });
  // The deadlines above intentionally advance the browser two minutes while
  // synthetic grants are minted from the runner clock. Realign those clocks
  // before proving that a newly issued grant remains usable on explicit retry.
  await page.clock.setSystemTime(new Date());
  const grantsBeforeRetry = media.readGrantRequests.length;
  const imagesBeforeRetry = media.imageRequests.length;
  await finalError
    .getByRole('button', { name: 'Retry private photo for entry 5' })
    .press('Enter');
  await expect
    .poll(() => media.readGrantRequests.length)
    .toBe(grantsBeforeRetry + 1);
  await expect
    .poll(() => media.imageRequests.length)
    .toBe(imagesBeforeRetry + 1);
  await expect(figure(5)).toBeFocused();
  await expect
    .poll(async () =>
      (await privatePhotoDecodeStats(page)).pendingAltText.includes(
        'Synthetic bounded-loader private photo 5.',
      ),
    )
    .toBe(true);
  expect(media.readGrantRequests.at(-1)?.readUrl).not.toBe(
    media.readGrantRequests.at(-2)?.readUrl,
  );
  expect(
    await releasePrivatePhotoDecode(
      page,
      'Synthetic bounded-loader private photo 5.',
    ),
  ).toBe(true);
  await expect(figure(5)).toHaveAttribute(
    'data-private-photo-state',
    'displayed',
  );
  await expectAxeClean(page, 'private photo fixed-deadline error');
});

test('create, PUT, and completion deadlines stop automatically and retain only the exact completion recovery', async ({
  page,
}, testInfo) => {
  await page.clock.install();
  const fixture = await readFixture(testInfo);

  const createMedia = await installSyntheticMediaRoutes(page, {
    eventId: fixture.keyboardEventId,
    uploadIntentId: randomUUID(),
    mediaId: randomUUID(),
    sanitizedSha256: SYNTHETIC_PNG_SHA256,
    holdCreateResponses: true,
  });
  await page.goto(fixturePath(fixture.keyboardEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-create-deadline.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  await expect.poll(() => createMedia.createRequests.length).toBe(1);
  await page.clock.fastForward(15_001);
  let alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(
    'PSD EOC did not authorize the private upload within 15 seconds. Nothing will retry automatically.',
  );
  await expect(alert).toBeFocused();
  createMedia.releaseCreateResponses();
  expect(createMedia.uploadRequests).toHaveLength(0);
  expect(createMedia.completionRequests).toHaveLength(0);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.keyboardEventId,
    ),
  ).toBeNull();
  await page.unrouteAll({ behavior: 'wait' });

  const uploadMedia = await installSyntheticMediaRoutes(page, {
    eventId: fixture.recoveryEventId,
    uploadIntentId: randomUUID(),
    mediaId: randomUUID(),
    sanitizedSha256: SYNTHETIC_PNG_SHA256,
    holdUploadResponses: true,
  });
  await page.goto(fixturePath(fixture.recoveryEventId));
  const uploadPageOrigin = await page.evaluate(() => window.location.origin);
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-put-deadline.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  await expect.poll(() => uploadMedia.uploadRequests.length).toBe(1);
  expectSyntheticCorsUpload(uploadMedia, uploadPageOrigin);
  await page.clock.fastForward(60_001);
  alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(
    'The private upload exceeded 60 seconds and was stopped. PSD EOC will not retry it automatically; choose the file again to start a new attempt.',
  );
  await expect(alert).toBeFocused();
  uploadMedia.releaseUploadResponses();
  expect(uploadMedia.completionRequests).toHaveLength(0);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.recoveryEventId,
    ),
  ).toBeNull();
  await page.unrouteAll({ behavior: 'wait' });

  const completionMedia = await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId: fixture.photoUploadMediaId,
    mediaId: fixture.photoUploadMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
    holdCompletionResponses: true,
  });
  await page.goto(fixturePath(fixture.photoEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-completion-deadline.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByLabel('Photo description (alternative text)')
    .fill('Synthetic completion deadline recovery');
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  await expect.poll(() => completionMedia.completionRequests.length).toBe(1);
  const completionKey =
    completionMedia.completionRequests[0]?.headers['idempotency-key'];
  expect(completionKey).toBeTruthy();
  await page.clock.fastForward(15_001);
  alert = page.locator('.photo-workflow-error');
  await expect(alert).toContainText(
    'PSD EOC did not confirm photo validation within 15 seconds. The exact completion request is available for explicit retry and will not retry automatically.',
  );
  await expect(alert).toBeFocused();
  const retainedCompletion = await page.evaluate((eventId) => {
    const raw = sessionStorage.getItem(
      `psd-eoc:event-room:photo-completion:v1:${eventId}`,
    );
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }, fixture.photoEventId);
  expect(retainedCompletion).toMatchObject({
    eventId: fixture.photoEventId,
    idempotencyKey: completionKey,
    mediaId: null,
    ownerSessionId: fixture.sessionId,
    uploadIntentId: fixture.photoUploadMediaId,
  });
  completionMedia.releaseCompletionResponses();

  await page.reload();
  const retry = page.getByRole('button', { name: 'Retry photo validation' });
  await expect(retry).toBeVisible();
  await page.clock.fastForward(1_000);
  expect(completionMedia.completionRequests).toHaveLength(1);
  await retry.press('Enter');
  await expect.poll(() => completionMedia.completionRequests.length).toBe(2);
  expect(
    completionMedia.completionRequests.every(
      (request) => request.headers['idempotency-key'] === completionKey,
    ),
  ).toBe(true);
  await expect(page.locator('.mutation-status')).toContainText(
    'photo post confirmed by the server.',
  );
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.photoEventId,
    ),
  ).toBeNull();
});

test('a retained photo post stops at fifteen seconds, never replays on reload, and retries the exact key explicitly', async ({
  page,
}, testInfo) => {
  await installDeterministicIntersectionObserver(page);
  await page.clock.install();
  const fixture = await readFixture(testInfo);
  await installSyntheticMediaRoutes(page, {
    eventId: fixture.photoEventId,
    uploadIntentId: fixture.photoUploadMediaId,
    mediaId: fixture.photoUploadMediaId,
    sanitizedSha256: fixture.photoSanitizedSha256,
  });
  const postGate = syntheticResponseGate(true);
  const postAttempts: Array<
    Readonly<{ body: unknown; idempotencyKey: string | undefined }>
  > = [];
  let firstPostCommitted = false;
  await page.route(`**/events/${fixture.photoEventId}/api`, async (route) => {
    const request = route.request();
    const body =
      request.method() === 'POST'
        ? (request.postDataJSON() as { operation?: string } | null)
        : null;
    if (body?.operation !== 'post-photo') {
      await route.continue();
      return;
    }
    postAttempts.push({
      body,
      idempotencyKey: request.headers()['idempotency-key'],
    });
    if (postAttempts.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      firstPostCommitted = true;
      await postGate.wait();
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  await page.goto(fixturePath(fixture.photoEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-post-deadline.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByLabel('Photo description (alternative text)')
    .fill('Synthetic retained photo post deadline');
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  await expect.poll(() => firstPostCommitted).toBe(true);
  expect(postAttempts).toHaveLength(1);
  await page.clock.fastForward(15_001);
  const commandError = page.locator('.event-room > .error-panel');
  await expect(commandError).toContainText(
    'PSD EOC did not confirm the request before the safety deadline. The exact request is retained and will not retry automatically.',
  );
  await expect(commandError).toBeFocused();
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      fixture.photoEventId,
    ),
  ).toBeNull();
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(`psd-eoc:event-room:pending:v1:${eventId}`),
      fixture.photoEventId,
    ),
  ).not.toBeNull();
  postGate.release();

  await page.reload();
  const retry = page.getByRole('button', {
    name: 'Retry exact retained request',
  });
  await expect(retry).toBeVisible();
  await page.clock.fastForward(1_000);
  expect(postAttempts).toHaveLength(1);
  await retry.press('Enter');
  await expect.poll(() => postAttempts.length).toBe(2);
  expect(postAttempts[1]?.body).toEqual(postAttempts[0]?.body);
  expect(postAttempts[1]?.idempotencyKey).toBe(postAttempts[0]?.idempotencyKey);
  await expect(page.locator('.mutation-status')).toContainText(
    'photo post confirmed by the server.',
  );
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(`psd-eoc:event-room:pending:v1:${eventId}`),
      fixture.photoEventId,
    ),
  ).toBeNull();
});

test('all-clear and close remain keyboard and axe operable during held photo create and PUT stages without an accidental post or retry', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const lifecycleMediaEventId = fixture.stalledPreviewEventId;
  const media = await installSyntheticMediaRoutes(page, {
    eventId: lifecycleMediaEventId,
    uploadIntentId: randomUUID(),
    mediaId: randomUUID(),
    sanitizedSha256: fixture.photoSanitizedSha256,
    holdCreateResponses: true,
    holdUploadResponses: true,
  });
  const eventOperations: string[] = [];
  await page.route(`**/events/${lifecycleMediaEventId}/api`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { operation?: unknown } | null;
      if (typeof body?.operation === 'string') {
        eventOperations.push(body.operation);
      }
    }
    await route.continue();
  });

  await page.goto(fixturePath(lifecycleMediaEventId));
  const pageOrigin = await page.evaluate(() => window.location.origin);
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-held-lifecycle.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByLabel('Photo description (alternative text)')
    .fill('Synthetic held lifecycle photo');
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  await expect.poll(() => media.createRequests.length).toBe(1);
  expect(media.uploadRequests).toHaveLength(0);

  const reviewAllClear = page.getByRole('button', {
    name: 'Review all-clear',
  });
  await expect(reviewAllClear).toBeEnabled();
  await reviewAllClear.press('Enter');
  const allClearDialog = page.getByRole('dialog');
  await expect(
    allClearDialog.getByRole('heading', {
      name: 'Notification consequences',
    }),
  ).toBeVisible();
  await expectAxeClean(page, 'all-clear dialog during held photo create');
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');
  await page
    .getByRole('button', { name: 'Issue all-clear and notify' })
    .press('Enter');
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  expect(eventOperations).not.toContain('post-photo');
  expect(media.completionRequests).toHaveLength(0);

  media.releaseCreateResponses();
  await expect.poll(() => media.uploadRequests.length).toBe(1);
  expectSyntheticCorsUpload(media, pageOrigin);
  const reviewClose = page.getByRole('button', {
    name: 'Review event close',
  });
  await expect(reviewClose).toBeEnabled();
  await reviewClose.press('Enter');
  const closeDialog = page.getByRole('dialog');
  await expect(closeDialog).toContainText('DRILL — TRAINING ONLY');
  await expect(page.getByLabel('Type CLOSE EVENT exactly')).toBeFocused();
  await expectAxeClean(page, 'close dialog during held photo PUT');
  await page.getByLabel('Type CLOSE EVENT exactly').fill('CLOSE EVENT');
  await page.getByRole('button', { name: 'Close event' }).press('Enter');
  await expect(page.locator('.event-status')).toHaveText('Closed');
  expect(eventOperations).not.toContain('post-photo');

  media.releaseUploadResponses();
  await expect(page.locator('.photo-workflow-error')).toContainText(
    'The event no longer accepts photo posts. The private upload will remain quarantined and no validation or timeline post was started.',
  );
  await page.waitForTimeout(750);
  expect(media.completionRequests).toHaveLength(0);
  expect(eventOperations).not.toContain('post-photo');
  expect(
    eventOperations.filter((operation) => operation === 'all-clear'),
  ).toHaveLength(1);
  expect(
    eventOperations.filter((operation) => operation === 'close'),
  ).toHaveLength(1);
  await expect(
    page.getByRole('button', { name: 'Retry photo validation' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      (eventId) =>
        sessionStorage.getItem(
          `psd-eoc:event-room:photo-completion:v1:${eventId}`,
        ),
      lifecycleMediaEventId,
    ),
  ).toBeNull();
  await expectAxeClean(page, 'closed event after held photo stages');
});

test('all-clear and close remain operable while photo completion is held and a stale completion cannot append after close', async ({
  page,
}, testInfo) => {
  const fixture = await readFixture(testInfo);
  const uploadIntentId = randomUUID();
  const mediaId = randomUUID();
  const media = await installSyntheticMediaRoutes(page, {
    eventId: fixture.keyboardEventId,
    uploadIntentId,
    mediaId,
    sanitizedSha256: SYNTHETIC_PNG_SHA256,
    holdCompletionResponses: true,
  });
  const eventOperations: string[] = [];
  await page.route(
    `**/events/${fixture.keyboardEventId}/api`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { operation?: unknown } | null;
        if (typeof body?.operation === 'string') {
          eventOperations.push(body.operation);
        }
      }
      await route.continue();
    },
  );

  await page.goto(fixturePath(fixture.keyboardEventId));
  await page.getByLabel('Photo file').setInputFiles({
    name: 'synthetic-held-completion.png',
    mimeType: 'image/png',
    buffer: SYNTHETIC_PNG,
  });
  await page
    .getByLabel('Photo description (alternative text)')
    .fill('Synthetic held completion photo');
  await page
    .getByRole('button', { name: 'Upload and post photo' })
    .press('Enter');
  await expect.poll(() => media.completionRequests.length).toBe(1);
  expect(eventOperations).not.toContain('post-photo');

  const reviewAllClear = page.getByRole('button', {
    name: 'Review all-clear',
  });
  await expect(reviewAllClear).toBeEnabled();
  await reviewAllClear.press('Enter');
  await expect(page.getByLabel('Type ALL CLEAR exactly')).toBeFocused();
  await expectAxeClean(page, 'all-clear dialog during held photo completion');
  await page.getByLabel('Type ALL CLEAR exactly').fill('ALL CLEAR');
  await page
    .getByRole('button', { name: 'Issue all-clear and notify' })
    .press('Enter');
  await expect(page.locator('.event-status')).toHaveText('All-clear issued');
  expect(media.completionRequests).toHaveLength(1);
  expect(eventOperations).not.toContain('post-photo');

  const reviewClose = page.getByRole('button', {
    name: 'Review event close',
  });
  await expect(reviewClose).toBeEnabled();
  await reviewClose.press('Enter');
  await expect(page.getByLabel('Type CLOSE EVENT exactly')).toBeFocused();
  await expectAxeClean(page, 'close dialog during held photo completion');
  await page.getByLabel('Type CLOSE EVENT exactly').fill('CLOSE EVENT');
  await page.getByRole('button', { name: 'Close event' }).press('Enter');
  await expect(page.locator('.event-status')).toHaveText('Closed');
  expect(media.completionRequests).toHaveLength(1);
  expect(eventOperations).not.toContain('post-photo');

  media.releaseCompletionResponses();
  const staleError = page.locator('.photo-workflow-error');
  await expect(staleError).toContainText(
    'The photo was validated, but the event no longer accepts photo posts. No timeline post was sent; verify the timeline before clearing this completed photo attempt.',
  );
  await expect(staleError).toBeFocused();
  await page.waitForTimeout(750);
  expect(media.completionRequests).toHaveLength(1);
  expect(eventOperations).not.toContain('post-photo');
  expect(
    await page.evaluate((eventId) => {
      const raw = sessionStorage.getItem(
        `psd-eoc:event-room:photo-completion:v1:${eventId}`,
      );
      return raw === null
        ? null
        : (JSON.parse(raw) as { mediaId?: unknown }).mediaId;
    }, fixture.keyboardEventId),
  ).toBe(mediaId);
  await expect(
    page.getByRole('button', { name: 'Retry photo validation' }),
  ).toBeDisabled();
  await expectAxeClean(page, 'stale completion blocked after event close');
});
