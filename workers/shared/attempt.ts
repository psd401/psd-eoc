import { createHash } from 'node:crypto';

import {
  ChannelAttemptSchema,
  EndpointSchema,
  type ChannelAttempt,
  type DispatchBatch,
  type Endpoint,
} from '@psd-eoc/contracts';

import { parseWorkerBatchMessage } from './batch-message';

export type WorkerAttemptErrorCode =
  | 'INVALID_ATTEMPT_WORK_ITEM'
  | 'ATTEMPT_BATCH_MISMATCH'
  | 'ATTEMPT_ENDPOINT_MISMATCH'
  | 'INACTIVE_ENDPOINT'
  | 'ROUTABLE_SYNTHETIC_ENDPOINT';

/** Safe validation error that never repeats a contact destination. */
export class WorkerAttemptError extends Error {
  public constructor(public readonly code: WorkerAttemptErrorCode) {
    super('The notification worker attempt is invalid.');
    this.name = 'WorkerAttemptError';
  }
}

/** Destination data enters only after authorized pinned-roster resolution. */
export interface WorkerAttemptWorkItem {
  readonly batch: DispatchBatch;
  readonly attempt: ChannelAttempt;
  readonly endpoint: Endpoint;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function syntheticEndpointIsUnroutable(endpoint: Endpoint): boolean {
  switch (endpoint.channel) {
    case 'push':
      return endpoint.token.startsWith('synthetic-unroutable:');
    case 'email': {
      const separator = endpoint.email.lastIndexOf('@');
      return (
        separator > 0 &&
        endpoint.email
          .slice(separator + 1)
          .toLowerCase()
          .endsWith('.invalid')
      );
    }
    case 'sms':
      return (
        /^\+120255501\d{2}$/u.test(endpoint.phoneNumber) ||
        /^\+999\d{12}$/u.test(endpoint.phoneNumber)
      );
  }
}

function attemptMatchesBatch(
  attempt: ChannelAttempt,
  batch: DispatchBatch,
): boolean {
  return (
    attempt.batchId === batch.id &&
    attempt.intentId === batch.intentId &&
    attempt.eventId === batch.eventId &&
    attempt.eventKind === batch.eventKind &&
    attempt.templateMode === batch.templateMode &&
    attempt.purpose === batch.purpose &&
    attempt.eventTypeVersion.id === batch.eventTypeVersion.id &&
    attempt.eventTypeVersion.templateMode ===
      batch.eventTypeVersion.templateMode &&
    attempt.rosterSnapshotId === batch.rosterSnapshotId &&
    attempt.rosterPopulation === batch.rosterPopulation &&
    attempt.channel === batch.channel &&
    Date.parse(attempt.attemptedAt) >= Date.parse(batch.createdAt)
  );
}

/** Revalidates every repeated identity and classification before provider I/O. */
export function parseWorkerAttemptWorkItem(
  value: WorkerAttemptWorkItem | unknown,
): WorkerAttemptWorkItem {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['batch', 'attempt', 'endpoint'])
  ) {
    throw new WorkerAttemptError('INVALID_ATTEMPT_WORK_ITEM');
  }
  let batch: DispatchBatch;
  try {
    batch = parseWorkerBatchMessage(value.batch);
  } catch {
    throw new WorkerAttemptError('INVALID_ATTEMPT_WORK_ITEM');
  }
  const attemptResult = ChannelAttemptSchema.safeParse(value.attempt);
  const endpointResult = EndpointSchema.safeParse(value.endpoint);
  if (!attemptResult.success || !endpointResult.success) {
    throw new WorkerAttemptError('INVALID_ATTEMPT_WORK_ITEM');
  }
  const attempt = attemptResult.data;
  const endpoint = endpointResult.data;
  if (!attemptMatchesBatch(attempt, batch)) {
    throw new WorkerAttemptError('ATTEMPT_BATCH_MISMATCH');
  }
  if (
    attempt.endpointId !== endpoint.id ||
    attempt.channel !== endpoint.channel
  ) {
    throw new WorkerAttemptError('ATTEMPT_ENDPOINT_MISMATCH');
  }
  if (endpoint.status !== 'active') {
    throw new WorkerAttemptError('INACTIVE_ENDPOINT');
  }
  if (
    attempt.rosterPopulation === 'synthetic' &&
    !syntheticEndpointIsUnroutable(endpoint)
  ) {
    throw new WorkerAttemptError('ROUTABLE_SYNTHETIC_ENDPOINT');
  }
  return Object.freeze({ batch, attempt, endpoint });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** PII-safe binding of a stable attempt ID to its exact immutable work. */
export function workerAttemptFingerprint(
  value: WorkerAttemptWorkItem | unknown,
): string {
  return createHash('sha256')
    .update(stableJson(parseWorkerAttemptWorkItem(value)), 'utf8')
    .digest('hex');
}
