import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const REPOSITORY_ROOT = new URL('..', import.meta.url).pathname;
const PACKAGE_ROOTS = ['packages', 'workers', 'infra', 'scripts'] as const;
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  'android',
  'build',
  'cdk.out',
  'dist',
  'ios',
  'node_modules',
]);

function discoverNamedFiles(
  directory: string,
  name: string,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      discoverNamedFiles(join(directory, entry.name), name, found);
    } else if (entry.name === name) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

function containsTypeScript(directory: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (containsTypeScript(join(directory, entry.name))) return true;
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      return true;
    }
  }
  return false;
}

export function workspacePatternMatches(
  pattern: string,
  packageDirectory: string,
): boolean {
  if (!pattern.includes('*')) return pattern === packageDirectory;
  const expression = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('[^/]+')}$`,
    'u',
  );
  return expression.test(packageDirectory);
}

export function verifyWorkspaceContract(
  repositoryRoot: string = REPOSITORY_ROOT,
): string[] {
  const rootPackage = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { workspaces?: unknown };
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces.filter(
        (workspace): workspace is string => typeof workspace === 'string',
      )
    : [];
  const errors: string[] = [];

  for (const packageRoot of PACKAGE_ROOTS) {
    const absoluteRoot = join(repositoryRoot, packageRoot);
    for (const manifest of discoverNamedFiles(absoluteRoot, 'package.json')) {
      const packageDirectory = relative(repositoryRoot, dirname(manifest));
      const packageDefinition = JSON.parse(readFileSync(manifest, 'utf8')) as {
        scripts?: Readonly<Record<string, unknown>>;
      };
      if (
        !workspaces.some((pattern) =>
          workspacePatternMatches(pattern, packageDirectory),
        )
      ) {
        errors.push(
          `${packageDirectory} has package.json but is absent from the root Bun workspaces.`,
        );
      }
      if (
        containsTypeScript(dirname(manifest)) &&
        typeof packageDefinition.scripts?.typecheck !== 'string'
      ) {
        errors.push(
          `${packageDirectory} contains TypeScript but has no workspace typecheck script.`,
        );
      }
    }
  }

  for (const lockfile of discoverNamedFiles(repositoryRoot, 'bun.lock')) {
    const lockfilePath = relative(repositoryRoot, lockfile);
    if (lockfilePath !== 'bun.lock') {
      errors.push(
        `${lockfilePath} is a nested Bun lockfile; every workspace must use the root bun.lock.`,
      );
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = verifyWorkspaceContract();
  if (errors.length > 0) {
    throw new Error(`Workspace verification failed:\n- ${errors.join('\n- ')}`);
  }
  console.info(
    'Workspace verification passed: every package is typechecked from bun.lock.',
  );
}
