import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

/**
 * The server image is assembled from named files, not from the repository.
 *
 * `psd-eoc.Dockerfile` copies `packages/server`, `packages/contracts/src`, and
 * the exact transitive source closure of its worker entry points. Importing
 * another worker module directly or transitively compiles everywhere except
 * inside the image, where the file simply is not there — and the failure
 * surfaces during deploy after the image has already been building for a
 * minute.
 *
 * CI cannot catch this by building the server: it builds with the whole
 * repository checked out, so the import resolves. This checks the thing that
 * actually differs — what the Dockerfile copies versus what the server imports.
 */
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const SERVER_ROOT = join(REPOSITORY_ROOT, 'packages/server');
const DOCKERFILE = join(
  REPOSITORY_ROOT,
  'packages/server/container/psd-eoc.Dockerfile',
);
const WORKER_ENTRY_POINTS = [
  join(REPOSITORY_ROOT, 'workers/push/service.ts'),
] as const;

function dockerfileText(): string {
  return readFileSync(DOCKERFILE, 'utf8');
}

const SKIP_DIRECTORIES = new Set(['node_modules', '.next', 'dist', 'coverage']);
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts'];

function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (SOURCE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
      found.push(path);
    }
  }
  return found;
}

function resolveWorkerModule(
  importer: string,
  specifier: string,
): string | undefined {
  const unresolved = specifier.startsWith('workers/')
    ? join(REPOSITORY_ROOT, specifier)
    : resolve(dirname(importer), specifier);
  for (const candidate of [`${unresolved}.ts`, join(unresolved, 'index.ts')]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Every `workers/...` module the server reaches, including transitive imports. */
function importedWorkerModules(): readonly string[] {
  const directPattern = /from\s+'(?:\.\.\/)+(workers\/[A-Za-z0-9._/-]+)'/gu;
  const relativePattern = /from\s+'(\.{1,2}\/[A-Za-z0-9._/-]+)'/gu;
  const modules = new Set<string>();
  const pending: string[] = [];
  for (const entryPoint of WORKER_ENTRY_POINTS) {
    modules.add(entryPoint);
    pending.push(entryPoint);
  }
  for (const file of sourceFiles(SERVER_ROOT)) {
    const contents = readFileSync(file, 'utf8');
    for (const match of contents.matchAll(directPattern)) {
      const specifier = match[1];
      const moduleFile =
        specifier === undefined
          ? undefined
          : resolveWorkerModule(file, specifier);
      if (moduleFile !== undefined && !modules.has(moduleFile)) {
        modules.add(moduleFile);
        pending.push(moduleFile);
      }
    }
  }
  while (pending.length > 0) {
    const importer = pending.pop();
    if (importer === undefined) {
      continue;
    }
    const contents = readFileSync(importer, 'utf8');
    for (const match of contents.matchAll(relativePattern)) {
      const specifier = match[1];
      const moduleFile =
        specifier === undefined
          ? undefined
          : resolveWorkerModule(importer, specifier);
      if (moduleFile !== undefined && !modules.has(moduleFile)) {
        modules.add(moduleFile);
        pending.push(moduleFile);
      }
    }
  }
  return [...modules]
    .map((file) => relative(REPOSITORY_ROOT, file).replace(/\.ts$/u, ''))
    .sort();
}

/** Every `workers/...` file the Dockerfile copies into the build stage. */
function copiedWorkerFiles(): readonly string[] {
  const dockerfile = dockerfileText();
  const copied = new Set<string>();
  for (const line of dockerfile.split('\n')) {
    if (!line.startsWith('COPY ')) {
      continue;
    }
    for (const token of line.slice('COPY '.length).trim().split(/\s+/u)) {
      if (token.startsWith('workers/') && token.endsWith('.ts')) {
        copied.add(token);
      }
    }
  }
  return [...copied].sort();
}

describe('server image contents', () => {
  test('uses configured source metadata and project-neutral label keys', () => {
    const dockerfile = dockerfileText();

    expect(dockerfile).toContain('ARG SOURCE_REPOSITORY_URL');
    expect(dockerfile).toContain(
      'org.opencontainers.image.source="$SOURCE_REPOSITORY_URL"',
    );
    expect(dockerfile).toContain('org.psd-eoc.environment="live-pilot"');
    expect(dockerfile).toContain(
      'org.psd-eoc.data-classification="staff-minimized"',
    );
    expect(dockerfile).not.toMatch(/psd401|338414773271/iu);
  });

  test('every reachable worker module is copied into the image', () => {
    const copied = copiedWorkerFiles();
    expect(copied.length).toBeGreaterThan(0);

    const missing = importedWorkerModules().filter(
      (specifier) => !copied.includes(`${specifier}.ts`),
    );
    expect(missing).toEqual([]);
  });

  test('the Dockerfile copies no unreachable worker file', () => {
    // Kept tight on purpose: the image's surface is the reason this file can
    // be reasoned about at all, and an unused copy is how it starts widening.
    const imported = importedWorkerModules().map(
      (specifier) => `${specifier}.ts`,
    );
    const unused = copiedWorkerFiles().filter(
      (file) => !imported.includes(file),
    );
    expect(unused).toEqual([]);
  });

  test('it scans the server sources it claims to scan', () => {
    const scanned = sourceFiles(SERVER_ROOT).map((file) =>
      relative(REPOSITORY_ROOT, file),
    );
    expect(scanned).toContain('packages/server/lib/notify/dispatcher.ts');
    expect(scanned.length).toBeGreaterThan(100);
  });
});
