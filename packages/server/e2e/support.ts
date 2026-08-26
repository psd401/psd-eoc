import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const axeVersion = (require('axe-core/package.json') as { version: string })
  .version;

export interface BrowserFixture {
  readonly eventId: string;
  readonly issue344EventId: string;
  readonly issue32EventId: string;
  readonly issue32Media: Readonly<{
    mediaId: string;
    uploadIntentId: string;
  }>;
  readonly districtAdministratorUserId: string;
  readonly records: Readonly<{
    northIncidentId: string;
    northDrillId: string;
    northTestId: string;
    southIncidentId: string;
  }>;
}

export function statePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_STATE_DIR;
  if (directory === undefined) throw new Error('Browser state is unavailable.');
  return join(directory, name);
}

export function evidencePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_EVIDENCE_DIR;
  if (directory === undefined) {
    throw new Error('Browser evidence directory is unavailable.');
  }
  return join(directory, name);
}

export function issue341EvidencePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_ISSUE_341_EVIDENCE_DIR;
  if (directory === undefined) {
    throw new Error('Issue 341 browser evidence directory is unavailable.');
  }
  return join(directory, name);
}

export function issue344EvidencePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_ISSUE_344_EVIDENCE_DIR;
  if (directory === undefined) {
    throw new Error('Issue 344 browser evidence directory is unavailable.');
  }
  return join(directory, name);
}

export function issue32EvidencePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_ISSUE_32_EVIDENCE_DIR;
  if (directory === undefined) {
    throw new Error('Issue 32 browser evidence directory is unavailable.');
  }
  return join(directory, name);
}

export function issue279EvidencePath(name: string): string {
  const directory = process.env.PSD_EOC_E2E_ISSUE_279_EVIDENCE_DIR;
  if (directory === undefined) {
    throw new Error('Issue 279 browser evidence directory is unavailable.');
  }
  return join(directory, name);
}

export async function readFixture(): Promise<BrowserFixture> {
  return JSON.parse(
    await readFile(statePath('fixture.json'), 'utf8'),
  ) as BrowserFixture;
}

export async function expectAxeClean(page: Page): Promise<void> {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async (expectedVersion) => {
    const axe = Reflect.get(window, 'axe') as {
      version: string;
      run(
        context: Document | Element,
        options: Readonly<{
          resultTypes: readonly string[];
          runOnly: Readonly<{ type: string; values: string[] }>;
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
    };
    if (axe.version !== expectedVersion) {
      throw new Error('The pinned axe browser engine is unavailable.');
    }
    const openDialogs = document.querySelectorAll('dialog[open]');
    if (openDialogs.length > 1) {
      throw new Error('The page has more than one open dialog.');
    }
    const root = openDialogs[0] ?? document;
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
    if (root instanceof HTMLDialogElement) {
      if (!root.matches(':modal')) {
        throw new Error('The open axe dialog is not modal.');
      }
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
        focusedElement:
          document.activeElement instanceof HTMLElement &&
          root.contains(document.activeElement)
            ? document.activeElement
            : null,
        scrollLeft: root.scrollLeft,
        scrollTop: root.scrollTop,
      };
      root.close();
      await closed;
      root.show();
      await new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => resolveFrame()),
      );
    }

    let findings: Awaited<ReturnType<typeof axe.run>>;
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

    const decorativeIncomplete: unknown[] = [];
    const unexpectedIncomplete: unknown[] = [];
    for (const finding of findings.incomplete) {
      for (const node of finding.nodes) {
        const selector = node.target.length === 1 ? node.target[0] : undefined;
        const matches =
          selector === undefined ? [] : root.querySelectorAll(selector);
        const element = matches.length === 1 ? matches[0] : undefined;
        const verifiedDecorativeGlyph =
          finding.id === 'color-contrast' &&
          element instanceof HTMLElement &&
          element.getAttribute('aria-hidden') === 'true' &&
          /^\s*[◆✎]\s*$/u.test(element.textContent ?? '') &&
          node.any.length > 0 &&
          node.any.every(
            (check) =>
              check.id === 'color-contrast' &&
              check.data?.messageKey === 'nonBmp',
          );
        if (verifiedDecorativeGlyph) {
          decorativeIncomplete.push({ selector, text: element.textContent });
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
        unexpectedIncomplete.push({ findingId: finding.id, node });
      }
    }
    unexpectedIncomplete.push(...dialogOcclusionFailures);
    return {
      decorativeIncomplete,
      dialogRestored,
      testEngineVersion: findings.testEngine.version,
      unexpectedIncomplete,
      violations: findings.violations,
    };
  }, axeVersion);
  expect(result.testEngineVersion).toBe(axeVersion);
  expect(result.dialogRestored).toBe(true);
  expect(
    result.violations,
    `Axe violations: ${JSON.stringify(result.violations, null, 2)}`,
  ).toEqual([]);
  expect(
    result.unexpectedIncomplete,
    `Unexpected axe incomplete checks: ${JSON.stringify(result.unexpectedIncomplete, null, 2)}`,
  ).toEqual([]);
}
