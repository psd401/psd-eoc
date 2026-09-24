import { Buffer } from 'node:buffer';

import { DispatchBatchSchema, type DispatchBatch } from '@psd-eoc/contracts';

/** Intentionally strict local ceiling kept below the current SQS maximum. */
export const MAX_WORKER_MESSAGE_BYTES = 256 * 1024;

export type WorkerBatchMessageErrorCode =
  'MESSAGE_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_BATCH_MESSAGE';

/** Bounded queue error that never repeats rendered copy or recipient data. */
export class WorkerBatchMessageError extends Error {
  public constructor(public readonly code: WorkerBatchMessageErrorCode) {
    super('The notification worker batch message is invalid.');
    this.name = 'WorkerBatchMessageError';
  }
}

function parseJson(body: string): unknown {
  if (Buffer.byteLength(body, 'utf8') > MAX_WORKER_MESSAGE_BYTES) {
    throw new WorkerBatchMessageError('MESSAGE_TOO_LARGE');
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new WorkerBatchMessageError('INVALID_JSON');
  }
}

/**
 * Parses the raw canonical DispatchBatch queue body. The contract is strict,
 * so invented wrappers, fields, classifications, and channels fail closed.
 */
export function parseWorkerBatchMessage(body: string | unknown): DispatchBatch {
  const candidate = typeof body === 'string' ? parseJson(body) : body;
  const parsed = DispatchBatchSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new WorkerBatchMessageError('INVALID_BATCH_MESSAGE');
  }
  return parsed.data;
}

/** Serializes only a canonical DispatchBatch and rechecks the local size bound. */
export function serializeWorkerBatchMessage(
  batchValue: DispatchBatch | unknown,
): string {
  const serialized = JSON.stringify(parseWorkerBatchMessage(batchValue));
  if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKER_MESSAGE_BYTES) {
    throw new WorkerBatchMessageError('MESSAGE_TOO_LARGE');
  }
  return serialized;
}

/** Stable correlation identity for at-least-once deliveries of one batch. */
export function workerBatchDeduplicationKey(
  batchValue: DispatchBatch | unknown,
): string {
  return parseWorkerBatchMessage(batchValue).id;
}
