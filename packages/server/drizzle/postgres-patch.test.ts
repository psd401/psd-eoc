import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

const repositoryRoot = new URL('../../../', import.meta.url);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, repositoryRoot), 'utf8'));
}

/**
 * The postgres client runs patched (issue #130: close and cancel lifecycle).
 * Bun applies a patch only to the exact version it names, so a version bump
 * that leaves the patch behind ships the unpatched client. This fails such a
 * bump by name instead of through the close probes.
 */
describe('postgres client patch', () => {
  test('the installed postgres version carries its issue #130 patch', () => {
    const { version } = readJson('node_modules/postgres/package.json') as {
      version: string;
    };
    const { patchedDependencies } = readJson('package.json') as {
      patchedDependencies?: Record<string, string>;
    };
    const patchPath = patchedDependencies?.[`postgres@${version}`];

    expect(patchPath).toBe(`patches/postgres@${version}.patch`);
    expect(
      existsSync(new URL(`patches/postgres@${version}.patch`, repositoryRoot)),
    ).toBe(true);
  });
});
