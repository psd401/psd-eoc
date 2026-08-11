import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, type BrowserContext, type Page } from '@playwright/test';

export const AXE_CORE_VERSION = '4.12.1' as const;
export const AXE_CORE_SHA256 =
  '66a8aaa95a8b044a7fd74a5435873bf04ff65a1ca75567c921b7509742085a14' as const;

const AXE_CORE_SOURCE_PATH = fileURLToPath(
  new URL('./vendor/axe-core-4.12.1/axe.min.js.txt', import.meta.url),
);

const WCAG_AA_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
] as const;

interface AxeNodeResult {
  readonly failureSummary?: string;
  readonly html: string;
  readonly target: readonly unknown[];
}

interface AxeFinding {
  readonly help: string;
  readonly helpUrl: string;
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly AxeNodeResult[];
}

interface AxeRunResults {
  readonly incomplete: readonly AxeFinding[];
  readonly testEngine: Readonly<{ version: string }>;
  readonly violations: readonly AxeFinding[];
}

interface AxeBrowserApi {
  readonly version: string;
  run(
    context: Document,
    options: Readonly<{
      resultTypes: readonly ['violations', 'incomplete'];
      runOnly: Readonly<{
        type: 'tag';
        values: readonly string[];
      }>;
    }>,
  ): Promise<AxeRunResults>;
}

let axeSourcePromise: Promise<string> | undefined;

async function readVerifiedAxeSource(): Promise<string> {
  const source = await readFile(AXE_CORE_SOURCE_PATH);
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== AXE_CORE_SHA256) {
    throw new Error(
      `Vendored axe-core integrity check failed: expected ${AXE_CORE_SHA256}, received ${digest}.`,
    );
  }

  const text = source.toString('utf8');
  if (!text.startsWith(`/*! axe v${AXE_CORE_VERSION}\n`)) {
    throw new Error('Vendored axe-core is missing its pinned version notice.');
  }
  return text;
}

function verifiedAxeSource(): Promise<string> {
  axeSourcePromise ??= readVerifiedAxeSource();
  return axeSourcePromise;
}

/**
 * Installs the pinned axe browser engine for every subsequent navigation and
 * child frame in this context. Call this before the test's first page.goto.
 */
export async function installAxe(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: await verifiedAxeSource() });
}

function formatFindings(
  stateLabel: string,
  resultKind: 'violation' | 'incomplete result',
  findings: readonly AxeFinding[],
): string {
  const details = findings.flatMap((finding) => [
    `${finding.impact ?? 'unknown impact'} ${finding.id}: ${finding.help}`,
    `  Guidance: ${finding.helpUrl}`,
    ...finding.nodes.flatMap((node) => [
      `  Target: ${JSON.stringify(node.target)}`,
      `  HTML: ${node.html}`,
      `  ${node.failureSummary ?? 'No failure summary was supplied.'}`,
    ]),
  ]);
  return [
    `${stateLabel} returned ${findings.length} axe-core ${resultKind}${findings.length === 1 ? '' : 's'}.`,
    ...details,
  ].join('\n');
}

/** Runs genuine axe-core WCAG A/AA rules against one fully rendered UI state. */
export async function assertAxeClean(
  page: Page,
  stateLabel: string,
): Promise<void> {
  const results = await page.evaluate(
    async ({ expectedVersion, tags }) => {
      const axe = (
        globalThis as typeof globalThis & {
          readonly axe?: AxeBrowserApi;
        }
      ).axe;
      if (axe === undefined) {
        throw new Error('Vendored axe-core did not initialize in the page.');
      }
      if (axe.version !== expectedVersion) {
        throw new Error(
          `Unexpected axe-core version: expected ${expectedVersion}, received ${axe.version}.`,
        );
      }
      return axe.run(document, {
        resultTypes: ['violations', 'incomplete'],
        runOnly: { type: 'tag', values: tags },
      });
    },
    {
      expectedVersion: AXE_CORE_VERSION,
      tags: [...WCAG_AA_TAGS],
    },
  );

  expect(
    results.testEngine.version,
    `${stateLabel} ran a different axe-core engine.`,
  ).toBe(AXE_CORE_VERSION);
  expect(
    results.violations,
    formatFindings(stateLabel, 'violation', results.violations),
  ).toEqual([]);
  expect(
    results.incomplete,
    formatFindings(stateLabel, 'incomplete result', results.incomplete),
  ).toEqual([]);
}
