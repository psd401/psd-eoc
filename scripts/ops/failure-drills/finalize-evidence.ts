import { readFile, writeFile } from 'node:fs/promises';

import {
  assertCompletedFailureDrillManifest,
  parseFailureDrillManifest,
} from './contract';

export interface CleanupObservation {
  readonly stackName: string;
  readonly stackAbsent: true;
  readonly observedAt: string;
  readonly checkedResources: readonly string[];
  readonly remainingResources: readonly string[];
}

export function parseCleanupObservation(
  value: unknown,
  expectedStackName: string,
): CleanupObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Failure-drill cleanup observation is invalid.');
  }
  const cleanup = value as Readonly<Record<string, unknown>>;
  if (
    cleanup.stackName !== expectedStackName ||
    cleanup.stackAbsent !== true ||
    typeof cleanup.observedAt !== 'string' ||
    new Date(cleanup.observedAt).toISOString() !== cleanup.observedAt ||
    !Array.isArray(cleanup.checkedResources) ||
    cleanup.checkedResources.length === 0 ||
    !cleanup.checkedResources.every(
      (resource) => typeof resource === 'string' && resource.length > 0,
    ) ||
    !Array.isArray(cleanup.remainingResources) ||
    !cleanup.remainingResources.every(
      (resource) => typeof resource === 'string' && resource.length > 0,
    )
  ) {
    throw new Error('Failure-drill cleanup observation is incomplete.');
  }
  return cleanup as unknown as CleanupObservation;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  const cleanupInput = process.argv[3];
  const output = process.argv[4];
  if (!input || !cleanupInput || !output || process.argv.length !== 5) {
    throw new Error(
      'Usage: bun finalize-evidence.ts INPUT CLEANUP_OBSERVATION OUTPUT',
    );
  }
  const parsed = parseFailureDrillManifest(
    JSON.parse(await readFile(input, 'utf8')),
  );
  const cleanup = parseCleanupObservation(
    JSON.parse(await readFile(cleanupInput, 'utf8')),
    parsed.cleanup.stackName,
  );
  const completed = {
    ...parsed,
    cleanup: {
      ...parsed.cleanup,
      status: 'complete' as const,
      remainingResources: cleanup.remainingResources,
    },
  };
  assertCompletedFailureDrillManifest(completed);
  await writeFile(output, `${JSON.stringify(completed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

if (import.meta.main) await main();
