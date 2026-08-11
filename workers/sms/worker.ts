import type { SmsOptOutRecord } from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptProcessResult,
  type WorkerAttemptWorkItem,
} from '../shared';
import { AWS_EUM_SMS_PROVIDER } from './aws-eum-adapter';
import {
  recordAwsManagedOptOutConflict,
  type SmsOptOutRecorder,
} from './opt-out';

export const AWS_EUM_OPT_OUT_REASON =
  'DESTINATION_PHONE_NUMBER_OPTED_OUT' as const;

/** Structural boundary implemented by the shared durable attempt processor. */
export interface SmsAttemptProcessor {
  process(
    workItem: WorkerAttemptWorkItem | unknown,
  ): Promise<WorkerAttemptProcessResult>;
}

export interface SmsWorkerOptions {
  readonly attemptProcessor: SmsAttemptProcessor;
  readonly optOutRecorder: SmsOptOutRecorder;
}

export interface SmsWorkerProcessResult {
  readonly attemptResult: WorkerAttemptProcessResult;
  readonly optOutRecord: SmsOptOutRecord | null;
}

export class SmsWorkerError extends Error {
  public constructor() {
    super('The SMS work item was rejected.');
    this.name = 'SmsWorkerError';
  }
}

function optOutReference(
  workItem: WorkerAttemptWorkItem,
  providerReference: string | null,
): string {
  return providerReference ?? `attempt:${workItem.attempt.id}`;
}

/**
 * Processes one durable attempt and immediately persists AWS's managed
 * opt-out conflict against the already resolved endpoint. If persistence
 * fails, the invocation fails so an at-least-once replay can finish the
 * idempotent append without re-sending the completed provider attempt.
 */
export async function processSmsWorkItem(
  workValue: WorkerAttemptWorkItem | unknown,
  options: SmsWorkerOptions,
): Promise<SmsWorkerProcessResult> {
  const workItem = parseWorkerAttemptWorkItem(workValue);
  if (
    workItem.batch.channel !== 'sms' ||
    workItem.endpoint.channel !== 'sms' ||
    typeof options.attemptProcessor?.process !== 'function' ||
    typeof options.optOutRecorder?.recordSmsOptOut !== 'function'
  ) {
    throw new SmsWorkerError();
  }

  const attemptResult = await options.attemptProcessor.process(workItem);
  if (
    attemptResult.kind === 'in-progress' ||
    attemptResult.outcome.state !== 'failed' ||
    attemptResult.outcome.provider !== AWS_EUM_SMS_PROVIDER ||
    attemptResult.outcome.reasonCode !== AWS_EUM_OPT_OUT_REASON
  ) {
    return Object.freeze({ attemptResult, optOutRecord: null });
  }

  const optOutRecord = await recordAwsManagedOptOutConflict(
    workItem,
    optOutReference(workItem, attemptResult.outcome.providerReference),
    attemptResult.outcomeEvidence.recordedAt,
    options.optOutRecorder,
  );
  return Object.freeze({ attemptResult, optOutRecord });
}
