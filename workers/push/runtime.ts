import {
  ExpoPushAttemptReferenceMessageSchema,
  type DispatchBatch,
} from '@psd-eoc/contracts';

import {
  workerAttemptFingerprint,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import { parseWorkerBatchMessage } from '../shared/batch-message';
import type { WorkerAttemptProcessResult } from '../shared/processor';
import type { ExpoPushWorker } from './worker';
import type {
  ExpoReceiptLifecycle,
  ExpoReceiptResendRequest,
  ExpoReceiptResendResult,
  ExpoReceiptResendScheduler,
} from './receipt-lifecycle';
import type {
  ExpoPushRuntimeClient,
  ExpoPushRetryScheduleResult,
} from './state-client';
import { EXPO_EMERGENCY_TTL_SECONDS } from './protocol';

export interface ExpoPushRetryPublisher {
  publishAttemptReference(
    attemptId: string,
    delaySeconds: number,
  ): Promise<void>;
}

export type ExpoPushQueueMessageResult =
  | Readonly<{
      kind: 'completed';
      outboxCreatedAt: string;
      acceptedCount: number;
      incompleteCount: number;
    }>
  | Readonly<{ kind: 'retry-later'; delaySeconds: number }>;

export type ExpoPushRuntimeErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_QUEUE_MESSAGE'
  | 'ATTEMPT_IN_PROGRESS'
  | 'ATTEMPT_FAILED';

export class ExpoPushRuntimeError extends Error {
  public constructor(public readonly code: ExpoPushRuntimeErrorCode) {
    super('The Expo push runtime request failed safely.');
    this.name = 'ExpoPushRuntimeError';
  }
}

function delaySeconds(retryAt: string, now = Date.now()): number {
  return Math.max(
    0,
    Math.min(900, Math.ceil((Date.parse(retryAt) - now) / 1_000)),
  );
}

function expiresAt(batch: DispatchBatch): string {
  return new Date(
    Date.parse(batch.createdAt) + EXPO_EMERGENCY_TTL_SECONDS * 1_000,
  ).toISOString();
}

function parseQueueMessage(
  body: string,
):
  | Readonly<{ kind: 'batch'; batch: DispatchBatch }>
  | Readonly<{ kind: 'retry'; attemptId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ExpoPushRuntimeError('INVALID_QUEUE_MESSAGE');
  }
  const reference = ExpoPushAttemptReferenceMessageSchema.safeParse(parsed);
  if (reference.success) {
    return Object.freeze({
      kind: 'retry',
      attemptId: reference.data.attemptId,
    });
  }
  try {
    const batch = parseWorkerBatchMessage(parsed);
    if (batch.channel !== 'push') throw new TypeError();
    return Object.freeze({ kind: 'batch', batch });
  } catch {
    throw new ExpoPushRuntimeError('INVALID_QUEUE_MESSAGE');
  }
}

export class ExpoReceiptQueueResendScheduler
  implements ExpoReceiptResendScheduler
{
  public constructor(
    private readonly state: ExpoPushRuntimeClient,
    private readonly queue: ExpoPushRetryPublisher,
  ) {}

  public async scheduleReceiptRetry(
    request: ExpoReceiptResendRequest,
  ): Promise<ExpoReceiptResendResult> {
    const scheduled = await this.state.scheduleRetry({
      ...request,
      receiptId: request.receiptId,
    });
    if (scheduled.kind === 'expired') {
      return Object.freeze({ kind: 'expired' });
    }
    await this.queue.publishAttemptReference(
      scheduled.attemptId,
      delaySeconds(scheduled.retryAt),
    );
    return Object.freeze({ kind: 'scheduled' });
  }
}

export interface ExpoPushRuntimeOptions {
  readonly worker: ExpoPushWorker;
  readonly receipts: ExpoReceiptLifecycle;
  readonly state: ExpoPushRuntimeClient;
  readonly queue: ExpoPushRetryPublisher;
  readonly clock?: () => number;
}

/**
 * Provider-agnostic SQS orchestration around the hardened attempt and receipt
 * domain. Queue bodies for retries contain only an opaque attempt UUID.
 */
export class ExpoPushRuntime {
  readonly #worker: ExpoPushWorker;
  readonly #receipts: ExpoReceiptLifecycle;
  readonly #state: ExpoPushRuntimeClient;
  readonly #queue: ExpoPushRetryPublisher;
  readonly #clock: () => number;

  public constructor(options: ExpoPushRuntimeOptions) {
    if (
      typeof options.worker?.process !== 'function' ||
      typeof options.receipts?.runDue !== 'function' ||
      typeof options.state?.resolveBatch !== 'function' ||
      typeof options.queue?.publishAttemptReference !== 'function'
    ) {
      throw new ExpoPushRuntimeError('INVALID_CONFIGURATION');
    }
    this.#worker = options.worker;
    this.#receipts = options.receipts;
    this.#state = options.state;
    this.#queue = options.queue;
    this.#clock = options.clock ?? Date.now;
  }

  async #scheduleWorkerRetry(
    workItem: WorkerAttemptWorkItem,
    result: Extract<WorkerAttemptProcessResult, { kind: 'retry' }>,
  ): Promise<ExpoPushRetryScheduleResult> {
    const retryAt = new Date(
      this.#clock() + result.delayMilliseconds,
    ).toISOString();
    const scheduled = await this.#state.scheduleRetry({
      sourceAttempt: workItem.attempt,
      sourceFingerprint: workerAttemptFingerprint(workItem),
      receiptId: null,
      nextAttemptNumber: result.nextAttemptNumber,
      delayMilliseconds: result.delayMilliseconds,
      retryAt,
      expiresAt: expiresAt(workItem.batch),
      reasonCode: result.reasonCode,
    });
    if (scheduled.kind === 'scheduled') {
      await this.#queue.publishAttemptReference(
        scheduled.attemptId,
        delaySeconds(scheduled.retryAt, this.#clock()),
      );
    }
    return scheduled;
  }

  async #processAttempt(
    workItem: WorkerAttemptWorkItem,
  ): Promise<'completed' | 'retry'> {
    let result: WorkerAttemptProcessResult;
    try {
      result = await this.#worker.process(workItem);
    } catch {
      throw new ExpoPushRuntimeError('ATTEMPT_FAILED');
    }
    if (result.kind === 'in-progress') {
      throw new ExpoPushRuntimeError('ATTEMPT_IN_PROGRESS');
    }
    if (result.kind === 'dlq') {
      throw new ExpoPushRuntimeError('ATTEMPT_FAILED');
    }
    if (result.kind === 'retry') {
      await this.#scheduleWorkerRetry(workItem, result);
    }
    return result.kind;
  }

  public async processQueueMessage(
    body: string,
    enqueuedAt: string,
  ): Promise<ExpoPushQueueMessageResult> {
    const message = parseQueueMessage(body);
    if (message.kind === 'retry') {
      const resolution = await this.#state.resolveRetry(message.attemptId);
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
          incompleteCount: 1,
        });
      }
      const result = await this.#processAttempt(resolution.workItem);
      return Object.freeze({
        kind: 'completed',
        outboxCreatedAt: resolution.workItem.batch.createdAt,
        acceptedCount: result === 'completed' ? 1 : 0,
        incompleteCount: result === 'retry' ? 1 : 0,
      });
    }

    let cursor = 0;
    let acceptedCount = 0;
    let incompleteCount = 0;
    for (;;) {
      const page = await this.#state.resolveBatch(
        message.batch,
        enqueuedAt,
        cursor,
      );
      const settled = await Promise.allSettled(
        page.items.map((item) => this.#processAttempt(item)),
      );
      if (settled.some((result) => result.status === 'rejected')) {
        throw new ExpoPushRuntimeError('ATTEMPT_FAILED');
      }
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        if (result.value === 'completed') acceptedCount += 1;
        if (result.value === 'retry') incompleteCount += 1;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return Object.freeze({
      kind: 'completed',
      outboxCreatedAt: message.batch.createdAt,
      acceptedCount,
      incompleteCount,
    });
  }

  public runDueReceipts(): Promise<unknown> {
    return this.#receipts.runDue();
  }

  public readStuckOutboxCount(): Promise<number> {
    return this.#state.readStuckOutboxCount();
  }
}
