import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  isTypeScriptSource,
  verifyWorkspaceContract,
  workspacePatternMatches,
} from './verify-workspaces';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('root Bun workspace coverage', () => {
  test('matches only one directory segment for a star', () => {
    expect(
      workspacePatternMatches('scripts/ops/*', 'scripts/ops/appstore'),
    ).toBe(true);
    expect(
      workspacePatternMatches('scripts/ops/*', 'scripts/ops/appstore/nested'),
    ).toBe(false);
  });

  test('includes every shipped package and has exactly one Bun lockfile', () => {
    expect(verifyWorkspaceContract()).toEqual([]);
  });

  test('recognizes executable TypeScript extensions but not declarations', () => {
    expect(isTypeScriptSource('script.ts')).toBe(true);
    expect(isTypeScriptSource('script.tsx')).toBe(true);
    expect(isTypeScriptSource('script.mts')).toBe(true);
    expect(isTypeScriptSource('script.cts')).toBe(true);
    expect(isTypeScriptSource('generated.d.mts')).toBe(false);
  });

  test('rejects source files omitted from their workspace tsconfig', () => {
    const root = mkdtempSync(join(tmpdir(), 'psd-eoc-workspace-contract-'));
    temporaryDirectories.push(root);
    for (const directory of ['workers', 'infra', 'scripts']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    const packageRoot = join(root, 'packages/example');
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(
      join(packageRoot, 'tsconfig.json'),
      JSON.stringify({ include: ['src/**/*.ts'] }),
    );
    writeFileSync(join(packageRoot, 'src/covered.ts'), 'export {};\n');
    writeFileSync(join(packageRoot, 'missed.mts'), 'export {};\n');

    expect(verifyWorkspaceContract(root)).toContain(
      'packages/example/missed.mts is not included by packages/example/tsconfig.json.',
    );
  });
});

describe('test preload', () => {
  const repositoryRoot = resolve(import.meta.dir, '..');
  const preload = join(repositoryRoot, 'scripts/test-preload.ts');

  // Bun reads bunfig.toml from the working directory only, and the gate runs
  // from the root, so nothing else would notice packages/server losing it.
  test.each(['bunfig.toml', 'packages/server/bunfig.toml'])(
    '%s preloads the synthetic district',
    (path) => {
      const file = join(repositoryRoot, path);
      expect(existsSync(file)).toBe(true);
      const config = Bun.TOML.parse(readFileSync(file, 'utf8')) as {
        readonly test?: { readonly preload?: readonly string[] };
      };
      const preloads = (config.test?.preload ?? []).map((entry) =>
        resolve(dirname(file), entry),
      );
      expect(preloads).toEqual([preload]);
      expect(existsSync(preload)).toBe(true);
    },
  );
});
