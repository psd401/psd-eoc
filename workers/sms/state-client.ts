import {
  ChannelAttemptSchema,
  CurrentRosterSnapshotSchema,
  SmsOptOutRecordSchema,
  SmsProviderSendAuthorizationSchema,
  SmsProviderIoCompletionSchema,
  SmsRuntimeRequestSchema,
  SmsWorkerAttemptWorkItemSchema,
  TimestampSchema,
  UuidSchema,
  type ChannelAttempt,
  type CurrentRosterSnapshot,
  type DispatchBatch,
  type SmsRuntimeRequest,
} from '@psd-eoc/contracts';

import type {
  AwsEumSmsLedgerClaim,
  AwsEumSmsLedgerCompleteRequest,
  AwsEumSmsLedgerLookup,
  AwsEumSmsLedgerClaimRequest,
  AwsEumSmsLedgerLookupRequest,
  AwsEumSmsSendLedger,
} from './aws-eum-adapter';
import type { SmsDeliveryAttemptLookup } from './delivery-events';
import type { SmsOptOutDestinationResolver } from './opt-out';
import type { SmsCanonicalCapabilityExecutor } from './runtime';

export const SMS_RUNTIME_PATH = '/api/internal/aws-eum-sms-runtime' as const;

const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;

export type SmsRuntimeClientErrorCode =
  | 'CONFLICT'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'RETRYABLE_RESPONSE';

export class SmsRuntimeClientError extends Error {
  public constructor(
    public readonly code: SmsRuntimeClientErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('The SMS runtime request failed safely.');
    this.name = 'SmsRuntimeClientError';
  }
}

export interface SmsRuntimeClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
}

export type SmsRetryScheduleResult =
  | Readonly<{
      kind: 'scheduled';
      attemptId: string;
      retryAt: string;
    }>
  | Readonly<{ kind: 'expired' }>;

export type SmsRetryResolution =
  | Readonly<{
      kind: 'ready';
      workItem: ReturnType<typeof SmsWorkerAttemptWorkItemSchema.parse>;
    }>
  | Readonly<{ kind: 'not-before'; retryAt: string }>
  | Readonly<{ kind: 'expired' | 'ineligible' }>;

export type SmsBatchResolutionPage =
  | Readonly<{
      kind: 'ready';
      readonly items: readonly ReturnType<
        typeof SmsWorkerAttemptWorkItemSchema.parse
      >[];
      readonly nextCursor: number | null;
    }>
  | Readonly<{ kind: 'expired' }>;

function fail(
  code: SmsRuntimeClientErrorCode,
  retryable = false,
  status: number | null = null,
): never {
  throw new SmsRuntimeClientError(code, retryable, status);
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

function parseLookup(value: unknown): AwsEumSmsLedgerLookup {
  const simple = exactRecord(value, ['kind']);
  if (simple?.kind === 'missing' || simple?.kind === 'indeterminate') {
    return Object.freeze({ kind: simple.kind });
  }
  const completed = exactRecord(value, ['kind', 'completion']);
  const completion = SmsProviderIoCompletionSchema.safeParse(
    completed?.completion,
  );
  if (completed?.kind === 'completed' && completion.success) {
    return Object.freeze({ kind: 'completed', completion: completion.data });
  }
  return fail('INVALID_RESPONSE');
}

function parseClaim(value: unknown): AwsEumSmsLedgerClaim {
  const acquired = exactRecord(value, ['kind', 'claimToken']);
  if (
    acquired?.kind === 'acquired' &&
    UuidSchema.safeParse(acquired.claimToken).success
  ) {
    return Object.freeze({
      kind: 'acquired',
      leaseToken: String(acquired.claimToken),
    });
  }
  const lookup = parseLookup(value);
  return lookup.kind === 'missing' ? fail('INVALID_RESPONSE') : lookup;
}

export class SmsRuntimeClient
  implements
    AwsEumSmsSendLedger,
    SmsCanonicalCapabilityExecutor,
    SmsDeliveryAttemptLookup,
    SmsOptOutDestinationResolver
{
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: SmsRuntimeClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${SMS_RUNTIME_PATH}`;
    this.#token = parseToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
  }

  async #post(request: SmsRuntimeRequest): Promise<unknown> {
    const parsed = SmsRuntimeRequestSchema.safeParse(request);
    if (!parsed.success) return fail('INVALID_REQUEST');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#timeoutMilliseconds,
    );
    try {
      const response = await this.#fetch(this.#endpoint, {
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
        return fail(
          'RETRYABLE_RESPONSE',
          response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
          response.status,
        );
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (error instanceof SmsRuntimeClientError) throw error;
      return fail('REQUEST_FAILED', true);
    } finally {
      clearTimeout(timeout);
    }
  }

  public async lookup(
    request: AwsEumSmsLedgerLookupRequest,
  ): Promise<AwsEumSmsLedgerLookup> {
    return parseLookup(
      await this.#post({
        operation: 'lookup-provider-io',
        attemptId: request.attemptId,
        workFingerprint: request.fingerprint,
      }),
    );
  }

  public async claim(
    request: AwsEumSmsLedgerClaimRequest,
  ): Promise<AwsEumSmsLedgerClaim> {
    return parseClaim(
      await this.#post({
        operation: 'claim-provider-io',
        attemptId: request.attemptId,
        workFingerprint: request.fingerprint,
      }),
    );
  }

  public async complete(
    request: AwsEumSmsLedgerCompleteRequest,
  ): Promise<void> {
    const result = exactRecord(
      await this.#post({
        operation: 'complete-provider-io',
        attemptId: request.attemptId,
        workFingerprint: request.fingerprint,
        claimToken: request.leaseToken,
        completion: SmsProviderIoCompletionSchema.parse(request.completion),
      }),
      ['kind'],
    );
    if (result?.kind !== 'completed') return fail('INVALID_RESPONSE');
  }

  public async scheduleRetry(input: {
    sourceAttempt: ChannelAttempt;
    sourceFingerprint: string;
    nextAttemptNumber: number;
    delayMilliseconds: number;
    reasonCode: string;
  }): Promise<SmsRetryScheduleResult> {
    const response = await this.#post({
      operation: 'schedule-retry',
      ...input,
    });
    const expired = exactRecord(response, ['kind']);
    if (expired?.kind === 'expired') {
      return Object.freeze({ kind: 'expired' });
    }
    const value = exactRecord(response, ['kind', 'attemptId', 'retryAt']);
    if (
      value?.kind !== 'scheduled' ||
      !UuidSchema.safeParse(value.attemptId).success ||
      !TimestampSchema.safeParse(value.retryAt).success
    ) {
      return fail('INVALID_RESPONSE');
    }
    return Object.freeze({
      kind: 'scheduled',
      attemptId: String(value.attemptId),
      retryAt: String(value.retryAt),
    });
  }

  public async resolveBatch(input: {
    batch: DispatchBatch;
    enqueuedAt: string;
    cursor: number;
  }): Promise<SmsBatchResolutionPage> {
    const response = await this.#post({ operation: 'resolve-batch', ...input });
    const expired = exactRecord(response, ['kind']);
    if (expired?.kind === 'expired') {
      return Object.freeze({ kind: 'expired' });
    }
    const value = exactRecord(response, ['kind', 'items', 'nextCursor']);
    if (value?.kind !== 'ready') return fail('INVALID_RESPONSE');
    if (!Array.isArray(value?.items)) return fail('INVALID_RESPONSE');
    const items = value.items.map((item) =>
      SmsWorkerAttemptWorkItemSchema.parse(item),
    );
    if (
      !(
        value.nextCursor === null ||
        (Number.isSafeInteger(value.nextCursor) &&
          Number(value.nextCursor) > input.cursor &&
          Number(value.nextCursor) <= 12_000)
      )
    ) {
      return fail('INVALID_RESPONSE');
    }
    return Object.freeze({
      kind: 'ready',
      items: Object.freeze(items),
      nextCursor: value.nextCursor === null ? null : Number(value.nextCursor),
    });
  }

  public async resolveRetry(attemptId: string): Promise<SmsRetryResolution> {
    const value = await this.#post({
      operation: 'resolve-retry',
      attemptId,
    });
    const simple = exactRecord(value, ['kind']);
    if (simple?.kind === 'expired' || simple?.kind === 'ineligible') {
      return Object.freeze({ kind: simple.kind });
    }
    const notBefore = exactRecord(value, ['kind', 'retryAt']);
    if (
      notBefore?.kind === 'not-before' &&
      TimestampSchema.safeParse(notBefore.retryAt).success
    ) {
      return Object.freeze({
        kind: 'not-before',
        retryAt: String(notBefore.retryAt),
      });
    }
    const ready = exactRecord(value, ['kind', 'workItem']);
    const workItem = SmsWorkerAttemptWorkItemSchema.safeParse(ready?.workItem);
    if (ready?.kind === 'ready' && workItem.success) {
      return Object.freeze({ kind: 'ready', workItem: workItem.data });
    }
    return fail('INVALID_RESPONSE');
  }

  public readonly authorizeProviderSend = async (workItem: unknown) => {
    const parsed = SmsWorkerAttemptWorkItemSchema.parse(workItem);
    const value = SmsProviderSendAuthorizationSchema.safeParse(
      await this.#post({
        operation: 'authorize-provider-send',
        workItem: parsed,
      }),
    );
    if (!value.success) return fail('INVALID_RESPONSE');
    return value.data;
  };

  public async execute(
    request: Parameters<SmsCanonicalCapabilityExecutor['execute']>[0],
  ): Promise<unknown> {
    if (request.capabilityId === 'record-sms-opt-out') {
      return SmsOptOutRecordSchema.parse(
        await this.#post({
          operation: 'record-sms-opt-out',
          context: request.context,
          input: request.input,
        }),
      );
    }
    throw new SmsRuntimeClientError('INVALID_REQUEST', false);
  }

  public async resolveSmsDestination(input: {
    rosterSnapshotId: string;
    phoneNumber: string;
  }): Promise<Readonly<{
    rosterSnapshotId: string;
    recipientId: string;
    endpointId: string;
  }> | null> {
    const value = await this.#post({
      operation: 'resolve-sms-destination',
      ...input,
    });
    if (value === null) return null;
    const record = exactRecord(value, [
      'rosterSnapshotId',
      'recipientId',
      'endpointId',
    ]);
    if (
      !UuidSchema.safeParse(record?.rosterSnapshotId).success ||
      !UuidSchema.safeParse(record?.recipientId).success ||
      !UuidSchema.safeParse(record?.endpointId).success
    ) {
      return fail('INVALID_RESPONSE');
    }
    return Object.freeze({
      rosterSnapshotId: String(record?.rosterSnapshotId),
      recipientId: String(record?.recipientId),
      endpointId: String(record?.endpointId),
    });
  }

  public async loadAttemptByProviderReference(
    provider: 'aws-eum-sms',
    providerReference: string,
  ): Promise<ChannelAttempt | null> {
    if (provider !== 'aws-eum-sms') return fail('INVALID_REQUEST');
    const value = await this.#post({
      operation: 'load-attempt-by-provider-reference',
      providerReference,
    });
    return value === null ? null : ChannelAttemptSchema.parse(value);
  }

  public async loadUnknownAttemptById(
    provider: 'aws-eum-sms',
    attemptId: string,
    correlationToken: string,
  ): Promise<ChannelAttempt | null> {
    if (provider !== 'aws-eum-sms') return fail('INVALID_REQUEST');
    const value = await this.#post({
      operation: 'load-unknown-attempt',
      attemptId,
      correlationToken,
    });
    return value === null ? null : ChannelAttemptSchema.parse(value);
  }

  public async listCurrentRosterSnapshots(): Promise<
    readonly CurrentRosterSnapshot[]
  > {
    const value = exactRecord(
      await this.#post({ operation: 'list-current-roster-snapshots' }),
      ['snapshots'],
    );
    if (!Array.isArray(value?.snapshots)) return fail('INVALID_RESPONSE');
    return Object.freeze(
      value.snapshots.map((snapshot) =>
        CurrentRosterSnapshotSchema.parse(snapshot),
      ),
    );
  }
}
