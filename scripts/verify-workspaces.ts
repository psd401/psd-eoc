import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

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

export function isTypeScriptSource(name: string): boolean {
  return /(?<!\.d)\.(?:cts|mts|ts|tsx)$/u.test(name);
}

function discoverTypeScriptSources(
  directory: string,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      discoverTypeScriptSources(join(directory, entry.name), found);
    } else if (isTypeScriptSource(entry.name)) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
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
  const manifests = PACKAGE_ROOTS.flatMap((packageRoot) => {
    const absoluteRoot = join(repositoryRoot, packageRoot);
    return existsSync(absoluteRoot)
      ? discoverNamedFiles(absoluteRoot, 'package.json')
      : [];
  });
  const packageDirectories = manifests
    .map((manifest) => dirname(manifest))
    .sort((left, right) => right.length - left.length);
  const sources = PACKAGE_ROOTS.flatMap((packageRoot) => {
    const absoluteRoot = join(repositoryRoot, packageRoot);
    return existsSync(absoluteRoot)
      ? discoverTypeScriptSources(absoluteRoot)
      : [];
  });
  const ownedSources = new Map<string, string[]>();
  for (const source of sources) {
    const owner = packageDirectories.find((directory) =>
      source.startsWith(`${directory}${sep}`),
    );
    if (owner === undefined) {
      errors.push(
        `${relative(repositoryRoot, source)} is TypeScript without an owning workspace package.`,
      );
      continue;
    }
    const current = ownedSources.get(owner) ?? [];
    current.push(source);
    ownedSources.set(owner, current);
  }

  for (const manifest of manifests) {
    const absolutePackageDirectory = dirname(manifest);
    const packageDirectory = relative(repositoryRoot, absolutePackageDirectory);
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
    const packageSources = ownedSources.get(absolutePackageDirectory) ?? [];
    if (
      packageSources.length > 0 &&
      typeof packageDefinition.scripts?.typecheck !== 'string'
    ) {
      errors.push(
        `${packageDirectory} contains TypeScript but has no workspace typecheck script.`,
      );
    }
    if (packageSources.length === 0) continue;

    const configPath = join(absolutePackageDirectory, 'tsconfig.json');
    if (!existsSync(configPath)) {
      errors.push(
        `${packageDirectory} contains TypeScript but has no tsconfig.json.`,
      );
      continue;
    }
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error !== undefined) {
      errors.push(
        `${relative(repositoryRoot, configPath)} cannot be read: ${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`,
      );
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      absolutePackageDirectory,
      undefined,
      configPath,
    );
    if (parsed.errors.length > 0) {
      errors.push(
        `${relative(repositoryRoot, configPath)} is invalid: ${parsed.errors
          .map((error) =>
            ts.flattenDiagnosticMessageText(error.messageText, '\n'),
          )
          .join('; ')}`,
      );
      continue;
    }
    const compiledFiles = new Set(
      parsed.fileNames.map((file) => resolve(file)),
    );
    for (const source of packageSources) {
      if (!compiledFiles.has(resolve(source))) {
        errors.push(
          `${relative(repositoryRoot, source)} is not included by ${relative(repositoryRoot, configPath)}.`,
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
