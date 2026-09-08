import {
  ExpoPushAttemptReferenceMessageSchema,
  ExpoPushRuntimeRequestSchema,
  ExpoReceiptPendingActionSchema,
  ExpoSendLedgerCompletionSchema,
  PersistedExpoReceiptTargetSchema,
  PushWorkerAttemptWorkItemSchema,
  TimestampSchema,
  UuidSchema,
  type ChannelAttempt,
  type DispatchBatch,
  type ExpoPushRuntimeRequest,
} from '@psd-eoc/contracts';

import type {
  ClaimExpoProviderIoRequest,
  CompleteExpoProviderIoRequest,
  DurableExpoSendLedger,
  ExpoSendLedgerClaim,
  ExpoSendLedgerLookup,
} from './adapter';
import type {
  DurableExpoReceiptStore,
  ExpoReceiptClaim,
  ExpoReceiptClaimRequest,
  ExpoReceiptDecisionRequest,
  ExpoReceiptScheduleRequest,
  ExpoReceiptResendRequest,
} from './receipt-lifecycle';
import type { WorkerAttemptWorkItem } from '../shared/attempt';

export const EXPO_PUSH_RUNTIME_PATH =
  '/api/internal/expo-push-runtime' as const;

const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/u;

export type ExpoPushRuntimeClientErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'RETRYABLE_RESPONSE'
  | 'CONFLICT'
  | 'INVALID_RESPONSE';

export class ExpoPushRuntimeClientError extends Error {
  public constructor(
    public readonly code: ExpoPushRuntimeClientErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('The Expo push runtime request failed safely.');
    this.name = 'ExpoPushRuntimeClientError';
  }
}

export interface ExpoPushRuntimeClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
}

export type ExpoPushRetryScheduleResult =
  | Readonly<{
      kind: 'scheduled';
      attemptId: string;
      retryAt: string;
    }>
  | Readonly<{ kind: 'expired' }>;

export type ExpoPushRetryResolution =
  | Readonly<{ kind: 'ready'; workItem: WorkerAttemptWorkItem }>
  | Readonly<{ kind: 'not-before'; retryAt: string }>
  | Readonly<{ kind: 'expired' | 'ineligible' }>;

export interface ExpoPushBatchResolutionPage {
  readonly items: readonly WorkerAttemptWorkItem[];
  readonly nextCursor: number | null;
}

function fail(
  code: ExpoPushRuntimeClientErrorCode,
  retryable = false,
  status: number | null = null,
): never {
  throw new ExpoPushRuntimeClientError(code, retryable, status);
}

function parseOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return fail('INVALID_CONFIGURATION');
    }
    return url.origin;
  } catch {
    return fail('INVALID_CONFIGURATION');
  }
}

function parseToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    return fail('INVALID_CONFIGURATION');
  }
  return value;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    return fail('INVALID_CONFIGURATION');
  }
  return timeout;
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
    ? record
    : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return fail('INVALID_RESPONSE');
  }
  if (response.body === null) return fail('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail('INVALID_RESPONSE');
      }
      chunks.push(chunk.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled response remains rejected.
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('INVALID_RESPONSE');
  }
}

function parseProviderLookup(value: unknown): ExpoSendLedgerLookup {
  const simple = exactRecord(value, ['kind']);
  if (
    simple?.kind === 'missing' ||
    simple?.kind === 'uncertain' ||
    simple?.kind === 'conflict'
  ) {
    return Object.freeze({ kind: simple.kind });
  }
  const completed = exactRecord(value, ['kind', 'completion']);
  const completion = ExpoSendLedgerCompletionSchema.safeParse(
    completed?.completion,
  );
  if (completed?.kind === 'completed' && completion.success) {
    return Object.freeze({ kind: 'completed', completion: completion.data });
  }
  return fail('INVALID_RESPONSE');
}

function parseProviderClaim(value: unknown): ExpoSendLedgerClaim {
  const execute = exactRecord(value, ['kind', 'claimToken']);
  if (
    execute?.kind === 'execute' &&
    UuidSchema.safeParse(execute.claimToken).success
  ) {
    return Object.freeze({
      kind: 'execute',
      claimToken: String(execute.claimToken),
    });
  }
  const lookup = parseProviderLookup(value);
  return lookup.kind === 'missing' ? fail('INVALID_RESPONSE') : lookup;
}

function parseReceiptClaim(value: unknown): ExpoReceiptClaim {
  const record = exactRecord(value, [
    'target',
    'dueAt',
    'horizonAt',
    'pollAttemptNumber',
    'lastReasonCode',
    'receiptReferenceState',
    'pendingAction',
    'leaseToken',
    'leaseExpiresAt',
  ]);
  const target = PersistedExpoReceiptTargetSchema.safeParse(record?.target);
  const pendingAction = ExpoReceiptPendingActionSchema.nullable().safeParse(
    record?.pendingAction,
  );
  if (
    record === null ||
    !target.success ||
    !pendingAction.success ||
    !TimestampSchema.safeParse(record.dueAt).success ||
    !TimestampSchema.safeParse(record.horizonAt).success ||
    !TimestampSchema.safeParse(record.leaseExpiresAt).success ||
    !UuidSchema.safeParse(record.leaseToken).success ||
    !Number.isSafeInteger(record.pollAttemptNumber) ||
    Number(record.pollAttemptNumber) < 1 ||
    Number(record.pollAttemptNumber) > 10_000 ||
    (record.lastReasonCode !== null &&
      (typeof record.lastReasonCode !== 'string' ||
        !SAFE_CODE_PATTERN.test(record.lastReasonCode))) ||
    (record.receiptReferenceState !== 'unique' &&
      record.receiptReferenceState !== 'conflict')
  ) {
    return fail('INVALID_RESPONSE');
  }
  return Object.freeze({
    target: target.data,
    dueAt: String(record.dueAt),
    horizonAt: String(record.horizonAt),
    pollAttemptNumber: Number(record.pollAttemptNumber),
    lastReasonCode: record.lastReasonCode as ExpoReceiptClaim['lastReasonCode'],
    receiptReferenceState: record.receiptReferenceState,
    pendingAction: pendingAction.data,
    leaseToken: String(record.leaseToken),
    leaseExpiresAt: String(record.leaseExpiresAt),
  });
}

export class ExpoPushRuntimeClient
  implements DurableExpoSendLedger, DurableExpoReceiptStore
{
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: ExpoPushRuntimeClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${EXPO_PUSH_RUNTIME_PATH}`;
    this.#token = parseToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
  }

  public async readStuckOutboxCount(): Promise<number> {
    const response = exactRecord(
      await this.#post({ operation: 'read-stuck-outbox-count' }),
      ['count'],
    );
    if (
      response === null ||
      !Number.isSafeInteger(response.count) ||
      Number(response.count) < 0
    ) {
      return fail('INVALID_RESPONSE');
    }
    return Number(response.count);
  }

  async #post(request: ExpoPushRuntimeRequest): Promise<unknown> {
    const parsed = ExpoPushRuntimeRequestSchema.safeParse(request);
    if (!parsed.success) return fail('INVALID_REQUEST');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#timeoutMilliseconds,
    );
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(parsed.data),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      return fail('REQUEST_FAILED', true);
    }
    clearTimeout(timeout);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Retryable, because this is deployment skew rather than a verdict on
      // the message. The runtime answers 403 when the worker presents a
      // verification reference the deployment has moved past, which every
      // message gets until the worker is replaced with the matching image.
      // Treating it as terminal would dead-letter live notifications for the
      // length of a deploy; the flag is what `isTerminalFailure` reads.
      if (response.status === 401 || response.status === 403) {
        return fail('REQUEST_UNAUTHORIZED', true, response.status);
      }
      if (response.status === 409) {
        return fail('CONFLICT', false, response.status);
      }
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      return fail(
        retryable ? 'RETRYABLE_RESPONSE' : 'REQUEST_FAILED',
        retryable,
        response.status,
      );
    }
    return readBoundedJson(response);
  }

  public async lookupProviderIo(
    request: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerLookup> {
    return parseProviderLookup(
      await this.#post({ operation: 'lookup-provider-io', ...request }),
    );
  }

  public async claimProviderIo(
    request: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerClaim> {
    return parseProviderClaim(
      await this.#post({ operation: 'claim-provider-io', ...request }),
    );
  }

  public async completeProviderIo(
    request: CompleteExpoProviderIoRequest,
  ): Promise<void> {
    const response = exactRecord(
      await this.#post({ operation: 'complete-provider-io', ...request }),
      ['kind'],
    );
    if (response?.kind !== 'completed') return fail('INVALID_RESPONSE');
  }

  public async schedule(request: ExpoReceiptScheduleRequest): Promise<void> {
    const response = exactRecord(
      await this.#post({ operation: 'schedule-receipt', ...request }),
      ['kind'],
    );
    if (response?.kind !== 'scheduled') return fail('INVALID_RESPONSE');
  }

  public async claimDue(
    request: ExpoReceiptClaimRequest,
  ): Promise<readonly ExpoReceiptClaim[]> {
    const response = exactRecord(
      await this.#post({ operation: 'claim-due-receipts', ...request }),
      ['claims'],
    );
    if (response === null || !Array.isArray(response.claims)) {
      return fail('INVALID_RESPONSE');
    }
    if (response.claims.length > request.limit) return fail('INVALID_RESPONSE');
    return Object.freeze(response.claims.map(parseReceiptClaim));
  }

  public async decide(request: ExpoReceiptDecisionRequest): Promise<void> {
    const response = exactRecord(
      await this.#post({ operation: 'decide-receipt', ...request }),
      ['kind'],
    );
    if (response?.kind !== 'decided') return fail('INVALID_RESPONSE');
  }

  public async scheduleRetry(
    request: Readonly<{
      sourceAttempt: ChannelAttempt;
      sourceFingerprint: string;
      receiptId: string | null;
      nextAttemptNumber: number;
      delayMilliseconds: number;
      retryAt: string;
      expiresAt: string;
      reasonCode: string;
    }>,
  ): Promise<ExpoPushRetryScheduleResult> {
    const response = await this.#post({
      operation: 'schedule-retry',
      ...request,
    });
    const expired = exactRecord(response, ['kind']);
    if (expired?.kind === 'expired') return Object.freeze({ kind: 'expired' });
    const scheduled = exactRecord(response, ['kind', 'attemptId', 'retryAt']);
    if (
      scheduled?.kind !== 'scheduled' ||
      !UuidSchema.safeParse(scheduled.attemptId).success ||
      !TimestampSchema.safeParse(scheduled.retryAt).success
    ) {
      return fail('INVALID_RESPONSE');
    }
    return Object.freeze({
      kind: 'scheduled',
      attemptId: String(scheduled.attemptId),
      retryAt: String(scheduled.retryAt),
    });
  }

  public scheduleReceiptRetry(
    request: ExpoReceiptResendRequest,
  ): Promise<ExpoPushRetryScheduleResult> {
    return this.scheduleRetry({ ...request, receiptId: request.receiptId });
  }

  public async resolveBatch(
    batch: DispatchBatch,
    enqueuedAt: string,
    cursor: number,
  ): Promise<ExpoPushBatchResolutionPage> {
    const response = exactRecord(
      await this.#post({
        operation: 'resolve-batch',
        batch,
        enqueuedAt,
        cursor,
      }),
      ['items', 'nextCursor'],
    );
    if (
      response === null ||
      !Array.isArray(response.items) ||
      response.items.length > 50 ||
      (response.nextCursor !== null &&
        (!Number.isSafeInteger(response.nextCursor) ||
          Number(response.nextCursor) <= cursor ||
          Number(response.nextCursor) > 12_000))
    ) {
      return fail('INVALID_RESPONSE');
    }
    const items = response.items.map((item) => {
      const parsed = PushWorkerAttemptWorkItemSchema.safeParse(item);
      if (!parsed.success) return fail('INVALID_RESPONSE');
      return parsed.data as WorkerAttemptWorkItem;
    });
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor:
        response.nextCursor === null ? null : Number(response.nextCursor),
    });
  }

  public async resolveRetry(
    attemptId: string,
  ): Promise<ExpoPushRetryResolution> {
    const response = await this.#post({
      operation: 'resolve-retry',
      attemptId,
    });
    const simple = exactRecord(response, ['kind']);
    if (simple?.kind === 'expired' || simple?.kind === 'ineligible') {
      return Object.freeze({ kind: simple.kind });
    }
    const notBefore = exactRecord(response, ['kind', 'retryAt']);
    if (
      notBefore?.kind === 'not-before' &&
      TimestampSchema.safeParse(notBefore.retryAt).success
    ) {
      return Object.freeze({
        kind: 'not-before',
        retryAt: String(notBefore.retryAt),
      });
    }
    const ready = exactRecord(response, ['kind', 'workItem']);
    const workItem = PushWorkerAttemptWorkItemSchema.safeParse(ready?.workItem);
    if (ready?.kind !== 'ready' || !workItem.success) {
      return fail('INVALID_RESPONSE');
    }
    return Object.freeze({
      kind: 'ready',
      workItem: workItem.data as WorkerAttemptWorkItem,
    });
  }

  public retryMessage(attemptId: string): string {
    return JSON.stringify(
      ExpoPushAttemptReferenceMessageSchema.parse({
        kind: 'expo-push-attempt-reference',
        attemptId,
      }),
    );
  }
}
