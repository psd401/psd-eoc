import {
  AttemptExecutionCompletionSchema,
  UuidSchema,
} from '@psd-eoc/contracts';

import type {
  AttemptExecutionClaim,
  AttemptExecutionClaimRequest,
  AttemptExecutionLookup,
  AttemptExecutionLookupRequest,
  AttemptExecutionStore,
  CompleteAttemptExecutionRequest,
  ReleaseAttemptExecutionRequest,
} from './processor';

export const ATTEMPT_EXECUTION_PATH =
  '/api/internal/attempt-execution' as const;

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export type AttemptExecutionClientErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'RETRYABLE_RESPONSE'
  | 'CONFLICT'
  | 'INVALID_RESPONSE';

export class AttemptExecutionClientError extends Error {
  public constructor(
    public readonly code: AttemptExecutionClientErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('The attempt-execution request failed safely.');
    this.name = 'AttemptExecutionClientError';
  }
}

export interface AttemptExecutionClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
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
    throw new AttemptExecutionClientError('INVALID_CONFIGURATION', false);
  }
}

function parseToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new AttemptExecutionClientError('INVALID_CONFIGURATION', false);
  }
  return value;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new AttemptExecutionClientError('INVALID_CONFIGURATION', false);
  }
  return timeout;
}

function requestIdentity(value: {
  readonly attemptId: string;
  readonly fingerprint: string;
}): void {
  if (
    !UuidSchema.safeParse(value.attemptId).success ||
    !FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    throw new AttemptExecutionClientError('INVALID_REQUEST', false);
  }
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
    throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
  }
  if (response.body === null) {
    throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
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
        throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
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
    throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
  }
}

function parseLookup(value: unknown): AttemptExecutionLookup {
  const simple = exactRecord(value, ['kind']);
  if (
    simple?.kind === 'missing' ||
    simple?.kind === 'reclaimable' ||
    simple?.kind === 'in-progress'
  ) {
    return Object.freeze({ kind: simple.kind });
  }
  const completed = exactRecord(value, ['kind', 'completion']);
  const completion = AttemptExecutionCompletionSchema.safeParse(
    completed?.completion,
  );
  if (completed?.kind === 'completed' && completion.success) {
    return Object.freeze({ kind: 'completed', completion: completion.data });
  }
  throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
}

function parseClaim(value: unknown): AttemptExecutionClaim {
  const inProgress = exactRecord(value, ['kind']);
  if (inProgress?.kind === 'in-progress') {
    return Object.freeze({ kind: 'in-progress' });
  }
  const acquired = exactRecord(value, ['kind', 'leaseToken']);
  if (
    acquired?.kind === 'acquired' &&
    UuidSchema.safeParse(acquired.leaseToken).success
  ) {
    return Object.freeze({
      kind: 'acquired',
      leaseToken: String(acquired.leaseToken),
    });
  }
  const completed = exactRecord(value, ['kind', 'completion']);
  const completion = AttemptExecutionCompletionSchema.safeParse(
    completed?.completion,
  );
  if (completed?.kind === 'completed' && completion.success) {
    return Object.freeze({ kind: 'completed', completion: completion.data });
  }
  throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
}

export class AttemptExecutionClient implements AttemptExecutionStore {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: AttemptExecutionClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${ATTEMPT_EXECUTION_PATH}`;
    this.#token = parseToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
  }

  async #post(body: unknown): Promise<unknown> {
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
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new AttemptExecutionClientError('REQUEST_FAILED', true);
    }
    clearTimeout(timeout);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new AttemptExecutionClientError(
          'REQUEST_UNAUTHORIZED',
          false,
          response.status,
        );
      }
      if (response.status === 409) {
        throw new AttemptExecutionClientError(
          'CONFLICT',
          false,
          response.status,
        );
      }
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      throw new AttemptExecutionClientError(
        retryable ? 'RETRYABLE_RESPONSE' : 'REQUEST_FAILED',
        retryable,
        response.status,
      );
    }
    return readBoundedJson(response);
  }

  public async lookup(
    request: AttemptExecutionLookupRequest,
  ): Promise<AttemptExecutionLookup> {
    requestIdentity(request);
    return parseLookup(await this.#post({ operation: 'lookup', ...request }));
  }

  public async claim(
    request: AttemptExecutionClaimRequest,
  ): Promise<AttemptExecutionClaim> {
    requestIdentity(request);
    if (
      !Number.isInteger(request.leaseMilliseconds) ||
      request.leaseMilliseconds < 1 ||
      request.leaseMilliseconds > 10 * 60_000
    ) {
      throw new AttemptExecutionClientError('INVALID_REQUEST', false);
    }
    return parseClaim(await this.#post({ operation: 'claim', ...request }));
  }

  public async complete(
    request: CompleteAttemptExecutionRequest,
  ): Promise<void> {
    requestIdentity(request);
    if (
      !UuidSchema.safeParse(request.leaseToken).success ||
      !AttemptExecutionCompletionSchema.safeParse(request.completion).success
    ) {
      throw new AttemptExecutionClientError('INVALID_REQUEST', false);
    }
    const response = exactRecord(
      await this.#post({ operation: 'complete', ...request }),
      ['kind'],
    );
    if (response?.kind !== 'completed') {
      throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
    }
  }

  public async release(request: ReleaseAttemptExecutionRequest): Promise<void> {
    requestIdentity(request);
    if (!UuidSchema.safeParse(request.leaseToken).success) {
      throw new AttemptExecutionClientError('INVALID_REQUEST', false);
    }
    const response = exactRecord(
      await this.#post({ operation: 'release', ...request }),
      ['kind'],
    );
    if (response?.kind !== 'released') {
      throw new AttemptExecutionClientError('INVALID_RESPONSE', false);
    }
  }
}
