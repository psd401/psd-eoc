import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_ROOT = new URL('.', import.meta.url).pathname;
const SHARED_STYLESHEET = join(APP_ROOT, 'start/styles.css');

/**
 * The layout class the shared operator stylesheet owns, and only it.
 *
 * `.page-shell` is defined in exactly one file, so a page that uses it without
 * importing that file renders as unstyled browser defaults. It still works, so
 * no typecheck, lint, or test catches it, and the operator browser flows only
 * assert headings and roles -- the text-alerts page reached production that
 * way. Narrower classes like `button` and `field` are deliberately excluded:
 * the event room legitimately styles those from its own stylesheet.
 */
const SHELL_CLASS = 'page-shell';

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
  });
}

/**
 * Whether the stylesheet actually reaches this component in the browser.
 *
 * Import specifiers are resolved against the importing file rather than
 * matched as text: the same stylesheet is written `./styles.css` from inside
 * the start route and `../start/styles.css` from a sibling, and a substring
 * check silently misses the first.
 *
 * Only a `layout.tsx` import cascades to nested routes, which is how the start
 * route imports the sheet once for both of its pages. A `page.tsx` import
 * applies to that one route alone, so it counts only at the component's own
 * level. Crediting an ancestor `page.tsx` would make this vacuous, because
 * `(app)/page.tsx` imports the sheet and every file below it would pass.
 */
function importsSharedStylesheet(directory: string, routeFile: string) {
  let source: string;
  try {
    source = readFileSync(join(directory, routeFile), 'utf8');
  } catch {
    return false;
  }
  return [...source.matchAll(/^import\s+'([^']+\.css)';$/gmu)].some(
    (match) => join(directory, match[1] ?? '') === SHARED_STYLESHEET,
  );
}

function inheritsSharedStylesheet(file: string): boolean {
  let directory = join(file, '..');
  if (importsSharedStylesheet(directory, 'page.tsx')) return true;
  for (;;) {
    if (importsSharedStylesheet(directory, 'layout.tsx')) return true;
    if (directory.length <= APP_ROOT.length) return false;
    directory = join(directory, '..');
  }
}

describe('shared operator stylesheet', () => {
  const usingShell = filesUnder(APP_ROOT).filter((file) =>
    new RegExp(`className=[^\\n]*\\b${SHELL_CLASS}\\b`, 'u').test(
      readFileSync(file, 'utf8'),
    ),
  );

  test('is used by at least the pages this repository already ships', () => {
    // Guards the discovery itself: a refactor that moves or renames these files
    // must not silently reduce this suite to asserting nothing.
    expect(usingShell.length).toBeGreaterThanOrEqual(5);
  });

  test.each(usingShell)(
    '%s belongs to a route that imports the shared stylesheet',
    (file) => {
      expect(inheritsSharedStylesheet(file)).toBe(true);
    },
  );
});
