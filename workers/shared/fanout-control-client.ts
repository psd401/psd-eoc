import {
  FanoutAuthorizationCheckInputSchema,
  FanoutAuthorizationDecisionSchema,
  type FanoutAuthorizationDecision,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from './attempt';

export const FANOUT_CONTROL_AUTHORIZATION_PATH =
  '/api/internal/fanout-control' as const;

const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export type FanoutControlFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FanoutControlClientErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'INVALID_RESPONSE';

/** Safe internal-boundary error which never includes credentials or payloads. */
export class FanoutControlClientError extends Error {
  public constructor(
    public readonly code: FanoutControlClientErrorCode,
    public readonly status: number | null = null,
  ) {
    super('Notification fan-out authorization failed closed.');
    this.name = 'FanoutControlClientError';
  }
}

export interface FanoutControlClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly fetch?: FanoutControlFetch;
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
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new FanoutControlClientError('INVALID_CONFIGURATION');
  }
}

function parseToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new FanoutControlClientError('INVALID_CONFIGURATION');
  }
  return value;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new FanoutControlClientError('INVALID_CONFIGURATION');
  }
  return timeout;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new FanoutControlClientError('INVALID_RESPONSE', response.status);
  }
  if (response.body === null) {
    throw new FanoutControlClientError('INVALID_RESPONSE', response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new FanoutControlClientError('INVALID_RESPONSE', response.status);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled oversized response remains rejected.
    }
  }
  const bytes = new Uint8Array(total);
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
    throw new FanoutControlClientError('INVALID_RESPONSE', response.status);
  }
}

function parseDecision(value: unknown): FanoutAuthorizationDecision {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'result')
  ) {
    throw new FanoutControlClientError('INVALID_RESPONSE');
  }
  const parsed = FanoutAuthorizationDecisionSchema.safeParse(
    Reflect.get(value, 'result'),
  );
  if (!parsed.success) {
    throw new FanoutControlClientError('INVALID_RESPONSE');
  }
  return parsed.data;
}

/**
 * Capability-minimized worker client. It can ask about only the immutable
 * intent attached to a work item and returns false for every explicit denial.
 * Transport and response errors throw; the shared processor catches them and
 * terminally suppresses provider I/O.
 */
export class FanoutControlClient {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: FanoutControlFetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: FanoutControlClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${FANOUT_CONTROL_AUTHORIZATION_PATH}`;
    this.#token = parseToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
  }

  public readonly authorizeFanout = async (
    workItem: WorkerAttemptWorkItem,
  ): Promise<boolean> => {
    const input = FanoutAuthorizationCheckInputSchema.parse({
      intentId: workItem.batch.intentId,
    });
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
        body: JSON.stringify(input),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new FanoutControlClientError('REQUEST_FAILED');
    }
    if (!response.ok) {
      clearTimeout(timeout);
      throw new FanoutControlClientError(
        response.status === 401 || response.status === 403
          ? 'REQUEST_UNAUTHORIZED'
          : 'REQUEST_FAILED',
        response.status,
      );
    }
    try {
      return parseDecision(await readBoundedJson(response)).authorized;
    } finally {
      clearTimeout(timeout);
    }
  };
}
