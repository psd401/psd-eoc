import { createHash } from 'node:crypto';

import {
  PushEndpointSendEligibilityInputSchema,
  PushEndpointSendEligibilityResultSchema,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';

export const PUSH_ENDPOINT_ELIGIBILITY_PATH =
  '/api/devices/internal/push-endpoint-eligibility' as const;

export type PushEligibilityFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PushEndpointEligibilityChecker {
  isEligible(workItem: WorkerAttemptWorkItem): Promise<boolean>;
}

export interface PushEndpointEligibilityClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly fetch?: PushEligibilityFetch;
  readonly timeoutMilliseconds?: number;
}

/**
 * Deployment configuration deliberately omits a fetch override. Production
 * composition always uses the runtime transport and cannot inject an
 * allow-all checker or synthetic HTTP implementation.
 */
export interface ProductionPushEndpointEligibilityClientOptions {
  readonly serviceOrigin: string;
  readonly bearerToken: string;
  readonly timeoutMilliseconds?: number;
}

export type PushEndpointEligibilityErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'INVALID_RESPONSE'
  | 'REQUEST_FAILED'
  | 'REQUEST_UNAUTHORIZED'
  | 'RETRYABLE_RESPONSE';

const MAX_RESPONSE_BYTES = 8 * 1_024;

export class PushEndpointEligibilityError extends Error {
  public constructor(
    public readonly code: PushEndpointEligibilityErrorCode,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super('Push endpoint eligibility check failed safely.');
    this.name = 'PushEndpointEligibilityError';
  }
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PushEndpointEligibilityError('INVALID_CONFIGURATION', false);
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
    throw new PushEndpointEligibilityError('INVALID_CONFIGURATION', false);
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
    throw new PushEndpointEligibilityError('INVALID_CONFIGURATION', false);
  }
  return value;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new PushEndpointEligibilityError('INVALID_CONFIGURATION', false);
  }
  return timeout;
}

function parseProductionOptions(
  value: ProductionPushEndpointEligibilityClientOptions | unknown,
): ProductionPushEndpointEligibilityClientOptions {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = [
      'serviceOrigin',
      'bearerToken',
      'timeoutMilliseconds',
    ] as const;
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.some((allowedKey) => allowedKey === key),
      ) ||
      !Object.hasOwn(descriptors, 'serviceOrigin') ||
      !Object.hasOwn(descriptors, 'bearerToken')
    ) {
      throw new TypeError();
    }
    for (const key of keys) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError();
      }
    }
    const serviceOrigin = descriptors.serviceOrigin?.value as unknown;
    const bearerToken = descriptors.bearerToken?.value as unknown;
    const timeoutMilliseconds = descriptors.timeoutMilliseconds?.value as
      | number
      | undefined;
    if (
      typeof serviceOrigin !== 'string' ||
      typeof bearerToken !== 'string' ||
      (timeoutMilliseconds !== undefined &&
        typeof timeoutMilliseconds !== 'number')
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      serviceOrigin,
      bearerToken,
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    });
  } catch (error) {
    if (error instanceof PushEndpointEligibilityError) throw error;
    throw new PushEndpointEligibilityError('INVALID_CONFIGURATION', false);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new PushEndpointEligibilityError('INVALID_RESPONSE', true);
  }
  if (response.body === null) {
    throw new PushEndpointEligibilityError('INVALID_RESPONSE', true);
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
        throw new PushEndpointEligibilityError('INVALID_RESPONSE', true);
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
    throw new PushEndpointEligibilityError('INVALID_RESPONSE', true);
  }
}

/** Worker-only client that sends a digest, never the push destination. */
export class PushEndpointEligibilityClient
  implements PushEndpointEligibilityChecker
{
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: PushEligibilityFetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: PushEndpointEligibilityClientOptions) {
    this.#endpoint = `${parseOrigin(options.serviceOrigin)}${PUSH_ENDPOINT_ELIGIBILITY_PATH}`;
    this.#token = parseToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
  }

  public async isEligible(workValue: WorkerAttemptWorkItem): Promise<boolean> {
    let workItem: WorkerAttemptWorkItem;
    try {
      workItem = parseWorkerAttemptWorkItem(workValue);
      if (workItem.endpoint.channel !== 'push') throw new TypeError();
    } catch {
      throw new PushEndpointEligibilityError('INVALID_INPUT', false);
    }
    const input = PushEndpointSendEligibilityInputSchema.parse({
      version: 1,
      rosterSnapshotId: workItem.attempt.rosterSnapshotId,
      rosterPopulation: workItem.attempt.rosterPopulation,
      recipientId: workItem.attempt.recipientId,
      endpointId: workItem.attempt.endpointId,
      platform: workItem.endpoint.platform,
      tokenDigest: createHash('sha256')
        .update(workItem.endpoint.token, 'utf8')
        .digest('hex'),
    });
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
          throw new PushEndpointEligibilityError(
            'REQUEST_UNAUTHORIZED',
            false,
            response.status,
          );
        }
        const retryable = response.status === 429 || response.status >= 500;
        throw new PushEndpointEligibilityError(
          retryable ? 'RETRYABLE_RESPONSE' : 'REQUEST_FAILED',
          retryable,
          response.status,
        );
      }
      const result = PushEndpointSendEligibilityResultSchema.safeParse(
        await readBoundedJson(response),
      );
      if (!result.success) {
        throw new PushEndpointEligibilityError('INVALID_RESPONSE', true);
      }
      return result.data.eligible;
    } catch (error) {
      if (error instanceof PushEndpointEligibilityError) throw error;
      throw new PushEndpointEligibilityError('REQUEST_FAILED', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Canonical fail-closed client construction used by deployable workers. */
export function createProductionPushEndpointEligibilityClient(
  optionsValue: ProductionPushEndpointEligibilityClientOptions,
): PushEndpointEligibilityClient {
  const options = parseProductionOptions(optionsValue);
  return new PushEndpointEligibilityClient({
    serviceOrigin: options.serviceOrigin,
    bearerToken: options.bearerToken,
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
}
