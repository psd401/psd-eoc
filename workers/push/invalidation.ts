import {
  EndpointStatusRecordSchema,
  RecordEndpointStatusInputSchema,
  type RecordEndpointStatusInput,
} from '@psd-eoc/contracts';

export const PUSH_TOKEN_INVALIDATION_PATH =
  '/api/devices/internal/push-token-invalidation' as const;

export type PushInvalidationFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PushEndpointInvalidator {
  invalidate(input: RecordEndpointStatusInput): Promise<void>;
}

export interface PushEndpointInvalidationClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly fetch?: PushInvalidationFetch;
  readonly timeoutMilliseconds?: number;
}

export type PushEndpointInvalidationErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'INVALID_RESPONSE'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'RETRYABLE_RESPONSE';

const MAX_RESPONSE_BYTES = 32 * 1_024;

export class PushEndpointInvalidationError extends Error {
  public constructor(
    public readonly code: PushEndpointInvalidationErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('Push endpoint invalidation failed safely.');
    this.name = 'PushEndpointInvalidationError';
  }
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PushEndpointInvalidationError('INVALID_CONFIGURATION', false);
  }
  const localHttp =
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new PushEndpointInvalidationError('INVALID_CONFIGURATION', false);
  }
  return url.origin;
}

function parseToken(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new PushEndpointInvalidationError('INVALID_CONFIGURATION', false);
  }
  return value;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new PushEndpointInvalidationError('INVALID_CONFIGURATION', false);
  }
  return timeout;
}

function parseDeviceNotRegisteredInput(
  value: RecordEndpointStatusInput,
): RecordEndpointStatusInput {
  const result = RecordEndpointStatusInputSchema.safeParse(value);
  if (
    !result.success ||
    result.data.status !== 'invalid' ||
    result.data.reasonCode !== 'EXPO_DEVICE_NOT_REGISTERED'
  ) {
    throw new PushEndpointInvalidationError('INVALID_INPUT', false);
  }
  return result.data;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new PushEndpointInvalidationError('INVALID_RESPONSE', true);
  }
  if (response.body === null) {
    throw new PushEndpointInvalidationError('INVALID_RESPONSE', true);
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
        throw new PushEndpointInvalidationError('INVALID_RESPONSE', true);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled response is already rejected.
    }
  }
  const bytes = new Uint8Array(totalBytes);
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
    throw new PushEndpointInvalidationError('INVALID_RESPONSE', true);
  }
}

function responseMatchesInput(
  value: unknown,
  input: RecordEndpointStatusInput,
): boolean {
  const result = EndpointStatusRecordSchema.safeParse(value);
  return (
    result.success &&
    result.data.rosterSnapshotId === input.rosterSnapshotId &&
    result.data.recipientId === input.recipientId &&
    result.data.endpointId === input.endpointId &&
    result.data.status === input.status &&
    result.data.reasonCode === input.reasonCode
  );
}

/** Worker-only, token-free endpoint invalidation writeback client. */
export class PushEndpointInvalidationClient implements PushEndpointInvalidator {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: PushInvalidationFetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: PushEndpointInvalidationClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${PUSH_TOKEN_INVALIDATION_PATH}`;
    this.#token = parseToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
  }

  public async invalidate(
    inputValue: RecordEndpointStatusInput,
  ): Promise<void> {
    const input = parseDeviceNotRegisteredInput(inputValue);
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
        body: JSON.stringify(input),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new PushEndpointInvalidationError(
            'REQUEST_UNAUTHORIZED',
            false,
            response.status,
          );
        }
        const retryable = response.status === 429 || response.status >= 500;
        throw new PushEndpointInvalidationError(
          retryable ? 'RETRYABLE_RESPONSE' : 'REQUEST_FAILED',
          retryable,
          response.status,
        );
      }
      if (!responseMatchesInput(await readBoundedJson(response), input)) {
        throw new PushEndpointInvalidationError('INVALID_RESPONSE', true);
      }
    } catch (error) {
      if (error instanceof PushEndpointInvalidationError) throw error;
      throw new PushEndpointInvalidationError('REQUEST_FAILED', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
