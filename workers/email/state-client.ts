import {
  EmailBatchResolutionPageSchema,
  EmailRetryResolutionSchema,
  EmailRuntimeRequestSchema,
  SesVerificationReferenceSchema,
  SesSendLedgerClaimSchema,
  type DispatchBatch,
  type EmailWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';

import type {
  DurableSesSendLedger,
  SesSendLedgerClaim,
  SesSendLedgerClaimRequest,
  SesSendLedgerCompleteRequest,
} from './ses-adapter';

export const EMAIL_RUNTIME_PATH = '/api/internal/email-runtime' as const;
const MAX_RESPONSE_BYTES = 512 * 1024;

export type EmailRuntimeClientErrorCode =
  | 'CONFLICT'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'RETRYABLE_RESPONSE';

export class EmailRuntimeClientError extends Error {
  public constructor(
    public readonly code: EmailRuntimeClientErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('The email runtime request failed safely.');
    this.name = 'EmailRuntimeClientError';
  }
}

export interface EmailRuntimeClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly verificationReference: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
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
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new EmailRuntimeClientError('INVALID_CONFIGURATION', false);
  }
}

function parseToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new EmailRuntimeClientError('INVALID_CONFIGURATION', false);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
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
    throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
  }
  if (response.body === null) {
    throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
  }
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
        throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
      }
      chunks.push(chunk.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled body remains rejected.
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
  }
}

export class EmailRuntimeClient implements DurableSesSendLedger {
  public readonly durability = 'durable' as const;
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #verificationReference: string;
  readonly #timeoutMilliseconds: number;

  public constructor(options: EmailRuntimeClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${EMAIL_RUNTIME_PATH}`;
    this.#token = parseToken(options.bearerToken);
    const verificationReference = SesVerificationReferenceSchema.safeParse(
      options.verificationReference,
    );
    if (!verificationReference.success) {
      throw new EmailRuntimeClientError('INVALID_CONFIGURATION', false);
    }
    this.#verificationReference = verificationReference.data;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    if (
      !Number.isInteger(this.#timeoutMilliseconds) ||
      this.#timeoutMilliseconds < 100 ||
      this.#timeoutMilliseconds > 60_000
    ) {
      throw new EmailRuntimeClientError('INVALID_CONFIGURATION', false);
    }
  }

  async #post(body: unknown): Promise<unknown> {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new EmailRuntimeClientError('INVALID_REQUEST', false);
    }
    const request = {
      ...(body as Readonly<Record<string, unknown>>),
      verificationReference: this.#verificationReference,
    };
    if (!EmailRuntimeRequestSchema.safeParse(request).success) {
      throw new EmailRuntimeClientError('INVALID_REQUEST', false);
    }
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
        body: JSON.stringify(request),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new EmailRuntimeClientError('REQUEST_FAILED', true);
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
        throw new EmailRuntimeClientError(
          'REQUEST_UNAUTHORIZED',
          true,
          response.status,
        );
      }
      if (response.status === 409) {
        throw new EmailRuntimeClientError('CONFLICT', false, response.status);
      }
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      throw new EmailRuntimeClientError(
        retryable ? 'RETRYABLE_RESPONSE' : 'REQUEST_FAILED',
        retryable,
        response.status,
      );
    }
    return readBoundedJson(response);
  }

  public async claim(
    request: SesSendLedgerClaimRequest,
  ): Promise<SesSendLedgerClaim> {
    const parsed = SesSendLedgerClaimSchema.safeParse(
      await this.#post({ operation: 'claim-provider-io', ...request }),
    );
    if (!parsed.success) {
      throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
    }
    return parsed.data;
  }

  public async complete(request: SesSendLedgerCompleteRequest): Promise<void> {
    const response = exactRecord(
      await this.#post({ operation: 'complete-provider-io', ...request }),
      ['kind'],
    );
    if (response?.kind !== 'completed') {
      throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
    }
  }

  public async resolveBatch(
    batch: DispatchBatch,
    enqueuedAt: string,
    cursor: number,
  ) {
    const response = EmailBatchResolutionPageSchema.safeParse(
      await this.#post({
        operation: 'resolve-batch',
        batch,
        enqueuedAt,
        cursor,
      }),
    );
    if (!response.success) {
      throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
    }
    return response.data;
  }

  public async resolveRetry(sourceAttemptId: string) {
    const response = EmailRetryResolutionSchema.safeParse(
      await this.#post({ operation: 'resolve-retry', sourceAttemptId }),
    );
    if (!response.success) {
      throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
    }
    return response.data;
  }

  public async authorizeProviderSend(
    workItem: EmailWorkerAttemptWorkItem,
  ): Promise<boolean> {
    const response = exactRecord(
      await this.#post({ operation: 'authorize-provider-send', workItem }),
      ['allowed'],
    );
    if (typeof response?.allowed !== 'boolean') {
      throw new EmailRuntimeClientError('INVALID_RESPONSE', false);
    }
    return response.allowed;
  }
}
