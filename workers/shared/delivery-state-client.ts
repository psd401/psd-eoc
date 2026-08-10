import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  RecordDeliveryEvidenceInputSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
  type RecordDeliveryEvidenceInput,
} from '@psd-eoc/contracts';

export const DELIVERY_STATE_WRITEBACK_PATH =
  '/api/internal/delivery-state' as const;

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;

export type AttemptEvidenceInput = RecordDeliveryEvidenceInput &
  Readonly<{
    subject: Readonly<{ kind: 'attempt'; attemptId: string }>;
    state:
      | 'attempted'
      | 'provider-accepted'
      | 'delivered'
      | 'failed'
      | 'expired'
      | 'unknown';
  }>;

/** Strict composition of existing canonical attempt and evidence contracts. */
export interface DeliveryStateWriteRequest {
  readonly attempt: ChannelAttempt;
  readonly evidence: AttemptEvidenceInput;
}

export interface AttemptEvidenceWriter {
  recordAttemptEvidence(
    request: DeliveryStateWriteRequest | unknown,
  ): Promise<DeliveryEvidence>;
}

export type DeliveryStateFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DeliveryStateWritebackErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'RETRYABLE_RESPONSE'
  | 'INVALID_RESPONSE';

/** Safe internal-API failure that never includes a token or response body. */
export class DeliveryStateWritebackError extends Error {
  public constructor(
    public readonly code: DeliveryStateWritebackErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('The delivery-state writeback failed.');
    this.name = 'DeliveryStateWritebackError';
  }
}

export interface DeliveryStateWritebackClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly fetch?: DeliveryStateFetch;
  readonly timeoutMilliseconds?: number;
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

export function parseDeliveryStateWriteRequest(
  value: DeliveryStateWriteRequest | unknown,
): DeliveryStateWriteRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['attempt', 'evidence'])) {
    throw new DeliveryStateWritebackError('INVALID_REQUEST', false);
  }
  const attemptResult = ChannelAttemptSchema.safeParse(value.attempt);
  const evidenceResult = RecordDeliveryEvidenceInputSchema.safeParse(
    value.evidence,
  );
  if (
    !attemptResult.success ||
    !evidenceResult.success ||
    evidenceResult.data.subject.kind !== 'attempt' ||
    evidenceResult.data.subject.attemptId !== attemptResult.data.id ||
    ['accepted', 'recorded'].includes(evidenceResult.data.state)
  ) {
    throw new DeliveryStateWritebackError('INVALID_REQUEST', false);
  }
  return Object.freeze({
    attempt: attemptResult.data,
    evidence: evidenceResult.data as AttemptEvidenceInput,
  });
}

function sameEvidenceInput(
  input: AttemptEvidenceInput,
  result: DeliveryEvidence,
): boolean {
  return (
    result.subject.kind === 'attempt' &&
    result.subject.attemptId === input.subject.attemptId &&
    result.state === input.state &&
    result.provider === input.provider &&
    result.providerReference === input.providerReference &&
    JSON.stringify(result.proof) === JSON.stringify(input.proof) &&
    result.reasonCode === input.reasonCode &&
    result.diagnosticDigest === input.diagnosticDigest
  );
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
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new DeliveryStateWritebackError('INVALID_CONFIGURATION', false);
  }
}

function parseToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new DeliveryStateWritebackError('INVALID_CONFIGURATION', false);
  }
  return value;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new DeliveryStateWritebackError('INVALID_CONFIGURATION', false);
  }
  return timeout;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
  }
  if (response.body === null) {
    throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation can retain the lock; the response remains rejected.
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
  }
}

/**
 * Capability-minimized client: one POST path, one request contract, and no
 * generic/event-lifecycle request method.
 */
export class DeliveryStateWritebackClient implements AttemptEvidenceWriter {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: DeliveryStateFetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: DeliveryStateWritebackClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${DELIVERY_STATE_WRITEBACK_PATH}`;
    this.#token = parseToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
  }

  public async recordAttemptEvidence(
    requestValue: DeliveryStateWriteRequest | unknown,
  ): Promise<DeliveryEvidence> {
    const request = parseDeliveryStateWriteRequest(requestValue);
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
      throw new DeliveryStateWritebackError('REQUEST_FAILED', true);
    }

    if (!response.ok) {
      clearTimeout(timeout);
      if (response.status === 401 || response.status === 403) {
        throw new DeliveryStateWritebackError(
          'REQUEST_UNAUTHORIZED',
          false,
          response.status,
        );
      }
      const retryable = retryableStatus(response.status);
      throw new DeliveryStateWritebackError(
        retryable ? 'RETRYABLE_RESPONSE' : 'REQUEST_FAILED',
        retryable,
        response.status,
      );
    }

    let text: string;
    try {
      text = await readBoundedResponseText(response);
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof DeliveryStateWritebackError) throw error;
      throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
    }
    clearTimeout(timeout);
    let candidate: unknown;
    try {
      candidate = JSON.parse(text) as unknown;
    } catch {
      throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
    }
    if (!isPlainRecord(candidate) || !hasExactKeys(candidate, ['result'])) {
      throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
    }
    const result = DeliveryEvidenceSchema.safeParse(candidate.result);
    if (!result.success || !sameEvidenceInput(request.evidence, result.data)) {
      throw new DeliveryStateWritebackError('INVALID_RESPONSE', false);
    }
    return result.data;
  }
}
