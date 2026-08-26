import {
  EmailAttemptReferenceMessageSchema,
  type DispatchBatch,
  type EmailWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';

import { parseWorkerBatchMessage } from '../shared/batch-message';
import type { WorkerAttemptProcessResult } from '../shared/processor';
import type { SesEmailRuntime } from './runtime';
import type { EmailRuntimeClient } from './state-client';

export interface EmailRetryPublisher {
  publishAttemptReference(
    sourceAttemptId: string,
    delaySeconds: number,
  ): Promise<void>;
}

export type EmailQueueMessageResult =
  | Readonly<{
      kind: 'completed';
      outboxCreatedAt: string;
      acceptedCount: number;
      incompleteCount: number;
      suppressedCount: number;
    }>
  | Readonly<{ kind: 'retry-later'; delaySeconds: number }>;

export type EmailQueueRuntimeErrorCode =
  | 'ATTEMPT_FAILED'
  | 'ATTEMPT_IN_PROGRESS'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_QUEUE_MESSAGE';

export class EmailQueueRuntimeError extends Error {
  public constructor(public readonly code: EmailQueueRuntimeErrorCode) {
    super('The email queue runtime failed safely.');
    this.name = 'EmailQueueRuntimeError';
  }
}

function parseQueueMessage(
  body: string,
):
  | Readonly<{ kind: 'batch'; batch: DispatchBatch }>
  | Readonly<{ kind: 'retry'; sourceAttemptId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new EmailQueueRuntimeError('INVALID_QUEUE_MESSAGE');
  }
  const reference = EmailAttemptReferenceMessageSchema.safeParse(parsed);
  if (reference.success) {
    return Object.freeze({
      kind: 'retry',
      sourceAttemptId: reference.data.sourceAttemptId,
    });
  }
  try {
    const batch = parseWorkerBatchMessage(parsed);
    if (batch.channel !== 'email') throw new TypeError();
    return Object.freeze({ kind: 'batch', batch });
  } catch {
    throw new EmailQueueRuntimeError('INVALID_QUEUE_MESSAGE');
  }
}

function delaySeconds(milliseconds: number): number {
  return Math.max(0, Math.min(900, Math.ceil(milliseconds / 1_000)));
}

export interface EmailQueueRuntimeOptions {
  readonly worker: Pick<SesEmailRuntime, 'processQueueAttempt'>;
  readonly state: Pick<EmailRuntimeClient, 'resolveBatch' | 'resolveRetry'>;
  readonly queue: EmailRetryPublisher;
  readonly queueArn: string;
  readonly clock?: () => number;
}

/** Destination-free SQS orchestration around the canonical attempt runtime. */
export class EmailQueueRuntime {
  readonly #worker: Pick<SesEmailRuntime, 'processQueueAttempt'>;
  readonly #state: Pick<EmailRuntimeClient, 'resolveBatch' | 'resolveRetry'>;
  readonly #queue: EmailRetryPublisher;
  readonly #queueArn: string;
  readonly #clock: () => number;

  public constructor(options: EmailQueueRuntimeOptions) {
    if (
      typeof options.worker?.processQueueAttempt !== 'function' ||
      typeof options.state?.resolveBatch !== 'function' ||
      typeof options.state?.resolveRetry !== 'function' ||
      typeof options.queue?.publishAttemptReference !== 'function' ||
      typeof options.queueArn !== 'string' ||
      options.queueArn.length < 1
    ) {
      throw new EmailQueueRuntimeError('INVALID_CONFIGURATION');
    }
    this.#worker = options.worker;
    this.#state = options.state;
    this.#queue = options.queue;
    this.#queueArn = options.queueArn;
    this.#clock = options.clock ?? Date.now;
  }

  async #processAttempt(
    workItem: EmailWorkerAttemptWorkItem,
    requestId: string,
  ): Promise<WorkerAttemptProcessResult> {
    try {
      return await this.#worker.processQueueAttempt(workItem, {
        requestId,
        sourceArn: this.#queueArn,
        authorization: { kind: 'verified-sqs-source' },
      });
    } catch {
      throw new EmailQueueRuntimeError('ATTEMPT_FAILED');
    }
  }

  async #resultForAttempt(
    workItem: EmailWorkerAttemptWorkItem,
    requestId: string,
  ): Promise<Readonly<{ accepted: number; incomplete: number }>> {
    const result = await this.#processAttempt(workItem, requestId);
    if (result.kind === 'in-progress') {
      throw new EmailQueueRuntimeError('ATTEMPT_IN_PROGRESS');
    }
    if (result.kind === 'dlq') {
      throw new EmailQueueRuntimeError('ATTEMPT_FAILED');
    }
    if (result.kind === 'retry') {
      await this.#queue.publishAttemptReference(
        workItem.attempt.id,
        delaySeconds(result.delayMilliseconds),
      );
      return Object.freeze({ accepted: 0, incomplete: 1 });
    }
    return Object.freeze({
      accepted:
        result.outcomeEvidence.state === 'provider-accepted' ||
        result.outcomeEvidence.state === 'delivered'
          ? 1
          : 0,
      incomplete:
        result.outcomeEvidence.state === 'unknown' ||
        result.outcomeEvidence.state === 'failed'
          ? 1
          : 0,
    });
  }

  public async processQueueMessage(
    body: string,
    enqueuedAt: string,
    requestId: string,
  ): Promise<EmailQueueMessageResult> {
    const message = parseQueueMessage(body);
    if (message.kind === 'retry') {
      const resolution = await this.#state.resolveRetry(
        message.sourceAttemptId,
      );
      if (resolution.kind === 'not-before') {
        return Object.freeze({
          kind: 'retry-later',
          delaySeconds: Math.max(
            1,
            Math.min(
              43_200,
              Math.ceil(
                (Date.parse(resolution.retryAt) - this.#clock()) / 1_000,
              ),
            ),
          ),
        });
      }
      if (resolution.kind !== 'ready') {
        return Object.freeze({
          kind: 'completed',
          outboxCreatedAt: new Date(this.#clock()).toISOString(),
          acceptedCount: 0,
          incompleteCount: 0,
          suppressedCount: 1,
        });
      }
      const result = await this.#resultForAttempt(
        resolution.workItem,
        requestId,
      );
      return Object.freeze({
        kind: 'completed',
        outboxCreatedAt: resolution.workItem.batch.createdAt,
        acceptedCount: result.accepted,
        incompleteCount: result.incomplete,
        suppressedCount: 0,
      });
    }

    let cursor = 0;
    let acceptedCount = 0;
    let incompleteCount = 0;
    let suppressedCount = 0;
    for (;;) {
      const page = await this.#state.resolveBatch(
        message.batch,
        enqueuedAt,
        cursor,
      );
      for (const item of page.items) {
        const result = await this.#resultForAttempt(item, requestId);
        acceptedCount += result.accepted;
        incompleteCount += result.incomplete;
      }
      suppressedCount += page.suppressedCount;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return Object.freeze({
      kind: 'completed',
      outboxCreatedAt: message.batch.createdAt,
      acceptedCount,
      incompleteCount,
      suppressedCount,
    });
  }
}
