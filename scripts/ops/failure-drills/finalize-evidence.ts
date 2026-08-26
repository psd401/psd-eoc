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

export type CleanupReadbackClassification = 'absent' | 'present';

export function classifyAppRunnerCleanupReadback(
  status: number,
  readback: string,
): CleanupReadbackClassification {
  if (!Number.isInteger(status) || status < 0 || typeof readback !== 'string') {
    throw new Error('App Runner cleanup readback input is invalid.');
  }
  if (status !== 0) {
    if (/An error occurred \(ResourceNotFoundException\)/u.test(readback)) {
      return 'absent';
    }
    throw new Error('App Runner cleanup readback failed unexpectedly.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readback);
  } catch {
    throw new Error('App Runner cleanup readback returned invalid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('App Runner cleanup readback is malformed.');
  }
  const service = (parsed as Readonly<Record<string, unknown>>).Service;
  if (
    typeof service !== 'object' ||
    service === null ||
    Array.isArray(service)
  ) {
    throw new Error('App Runner cleanup readback is missing its service.');
  }
  const serviceStatus = (service as Readonly<Record<string, unknown>>).Status;
  if (typeof serviceStatus !== 'string' || serviceStatus.length === 0) {
    throw new Error('App Runner cleanup readback is missing its status.');
  }
  return serviceStatus === 'DELETED' ? 'absent' : 'present';
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
  if (process.argv[2] === 'classify-apprunner-readback') {
    const status = Number(process.argv[3]);
    const readback = process.argv[4];
    if (readback === undefined || process.argv.length !== 5) {
      throw new Error(
        'Usage: bun finalize-evidence.ts classify-apprunner-readback STATUS READBACK',
      );
    }
    console.log(classifyAppRunnerCleanupReadback(status, readback));
    return;
  }
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
