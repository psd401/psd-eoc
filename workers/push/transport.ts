import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import { ProviderDispatchError } from '../shared/retry';
import {
  PushEndpointEligibilityError,
  type PushEndpointEligibilityChecker,
} from './eligibility';
import {
  EXPO_RECEIPTS_URL,
  EXPO_RECEIPT_CHUNK_SIZE,
  EXPO_SEND_URL,
  chunkExpoValues,
  createExpoPushMessage,
  expired,
  parseExpoReceiptResponse,
  parseExpoTicketResponse,
  type ExpoProviderOutcome,
} from './protocol';

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_TIMEOUT_MILLISECONDS = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const SAFE_PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;

export type ExpoPushFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ExpoLiveTransportAuthorizer = () => boolean | Promise<boolean>;

export interface ExpoPushTransport {
  sendChunk(
    workItems: readonly WorkerAttemptWorkItem[],
  ): Promise<readonly ExpoProviderOutcome[]>;
  queryReceiptChunk(
    receiptIds: readonly string[],
  ): Promise<readonly ExpoProviderOutcome[]>;
}

export interface ExpoPushHttpTransportOptions {
  readonly accessToken: string;
  /** Final authoritative endpoint check immediately before Expo HTTP I/O. */
  readonly endpointEligibility: PushEndpointEligibilityChecker;
  readonly fetch?: ExpoPushFetch;
  /** Omission keeps all provider network I/O disabled. */
  readonly authorizeLiveTransport?: ExpoLiveTransportAuthorizer;
  readonly timeoutMilliseconds?: number;
  readonly clock?: () => Date | string | number;
}

function parseAccessToken(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 4_096 ||
    /[\s\p{Cc}]/u.test(value)
  ) {
    throw new TypeError('Expo access token is invalid.');
  }
  return value;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > MAX_TIMEOUT_MILLISECONDS
  ) {
    throw new TypeError('Expo request timeout is invalid.');
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
    throw new ProviderDispatchError('EXPO_RESPONSE_TOO_LARGE', 'ambiguous');
  }
  if (response.body === null) return null;
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
        throw new ProviderDispatchError('EXPO_RESPONSE_TOO_LARGE', 'ambiguous');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderDispatchError) throw error;
    throw new ProviderDispatchError(
      'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
      'ambiguous',
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled response can retain its lock and is already rejected.
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function canonicalSingletonLiveWork(
  workItems: readonly WorkerAttemptWorkItem[],
): WorkerAttemptWorkItem {
  try {
    if (workItems.length !== 1) throw new TypeError();
    const item = parseWorkerAttemptWorkItem(workItems[0]);
    if (
      (item.batch.integrationStatus.integrationId !== 'expo-push' &&
        item.batch.integrationStatus.integrationId !== 'mobile-push') ||
      item.batch.integrationStatus.label !== 'live-verified' ||
      item.batch.rosterPopulation !== 'staff' ||
      item.batch.channel !== 'push' ||
      item.attempt.channel !== 'push' ||
      item.endpoint.channel !== 'push' ||
      item.endpoint.provider !== 'expo'
    ) {
      throw new TypeError();
    }
    return item;
  } catch {
    throw new ProviderDispatchError(
      'EXPO_LIVE_TRANSPORT_DISABLED',
      'terminal-failure',
      null,
    );
  }
}

function endpointEligibilityDispatchError(
  code:
    | 'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED'
    | 'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE'
    | 'EXPO_ENDPOINT_INELIGIBLE',
): ProviderDispatchError {
  return new ProviderDispatchError(
    code,
    code === 'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE'
      ? 'safe-to-retry'
      : 'terminal-failure',
    null,
  );
}

function retryableEligibilityError(error: unknown): boolean {
  try {
    return (
      error instanceof PushEndpointEligibilityError && error.retryable === true
    );
  } catch {
    return false;
  }
}

/**
 * Native-fetch Expo transport. It is deliberately unusable unless both the
 * canonical integration state and an explicit runtime authorization agree.
 */
export class ExpoPushHttpTransport implements ExpoPushTransport {
  readonly #accessToken: string;
  readonly #fetch: ExpoPushFetch;
  readonly #authorize: ExpoLiveTransportAuthorizer | undefined;
  readonly #endpointEligibility: PushEndpointEligibilityChecker;
  readonly #checkEndpointEligibility: (
    workItem: WorkerAttemptWorkItem,
  ) => Promise<boolean>;
  readonly #timeoutMilliseconds: number;
  readonly #clock: () => Date | string | number;

  /** Proves the HTTP boundary owns the exact checker used by its worker. */
  public static usesEndpointEligibility(
    transport: unknown,
    checker: PushEndpointEligibilityChecker,
  ): transport is ExpoPushHttpTransport {
    try {
      return (
        transport instanceof ExpoPushHttpTransport &&
        transport.#endpointEligibility === checker
      );
    } catch {
      return false;
    }
  }

  public constructor(options: ExpoPushHttpTransportOptions) {
    let endpointEligibility: PushEndpointEligibilityChecker;
    let checkEndpointEligibility: (
      workItem: WorkerAttemptWorkItem,
    ) => Promise<boolean>;
    try {
      endpointEligibility = options.endpointEligibility;
      if (
        endpointEligibility === null ||
        typeof endpointEligibility !== 'object' ||
        typeof endpointEligibility.isEligible !== 'function'
      ) {
        throw new TypeError();
      }
      checkEndpointEligibility =
        endpointEligibility.isEligible.bind(endpointEligibility);
    } catch {
      throw new TypeError('Expo endpoint eligibility checker is invalid.');
    }
    this.#accessToken = parseAccessToken(options.accessToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorize = options.authorizeLiveTransport;
    this.#endpointEligibility = endpointEligibility;
    this.#checkEndpointEligibility = checkEndpointEligibility;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
    this.#clock = options.clock ?? Date.now;
  }

  public async sendChunk(
    workItems: readonly WorkerAttemptWorkItem[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    const workItem = canonicalSingletonLiveWork(workItems);
    await this.#assertAuthorized();
    await this.#assertEndpointEligible(workItem);
    const now = this.#clock();
    const message = createExpoPushMessage(workItem, now);
    if (message.ttl < 1) {
      return Object.freeze([expired()]);
    }
    // Enter #post synchronously after the final check. Its first await invokes
    // fetch, leaving no asynchronous revocation window before provider I/O.
    const responsePromise = this.#post(EXPO_SEND_URL, [message]);
    const response = await responsePromise;
    return parseExpoTicketResponse(response, 1);
  }

  public async queryReceiptChunk(
    receiptIds: readonly string[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    if (
      receiptIds.length < 1 ||
      receiptIds.length > EXPO_RECEIPT_CHUNK_SIZE ||
      new Set(receiptIds).size !== receiptIds.length ||
      receiptIds.some((id) => !SAFE_PROVIDER_REFERENCE_PATTERN.test(id))
    ) {
      throw new TypeError('Expo receipt chunk is invalid.');
    }
    await this.#assertAuthorized();
    const response = await this.#post(EXPO_RECEIPTS_URL, {
      ids: receiptIds,
    });
    return parseExpoReceiptResponse(response, receiptIds);
  }

  public async sendAll(
    workItems: readonly WorkerAttemptWorkItem[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    const outcomes: ExpoProviderOutcome[] = [];
    for (const workItem of workItems) {
      outcomes.push(...(await this.sendChunk([workItem])));
    }
    return Object.freeze(outcomes);
  }

  public async queryAllReceipts(
    receiptIds: readonly string[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    const outcomes: ExpoProviderOutcome[] = [];
    for (const chunk of chunkExpoValues(receiptIds, EXPO_RECEIPT_CHUNK_SIZE)) {
      outcomes.push(...(await this.queryReceiptChunk(chunk)));
    }
    return Object.freeze(outcomes);
  }

  async #assertAuthorized(): Promise<void> {
    let authorized = false;
    try {
      authorized =
        this.#authorize !== undefined && (await this.#authorize()) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      throw new ProviderDispatchError(
        'EXPO_LIVE_TRANSPORT_DISABLED',
        'terminal-failure',
      );
    }
  }

  async #assertEndpointEligible(
    workItem: WorkerAttemptWorkItem,
  ): Promise<void> {
    let eligible: unknown;
    try {
      eligible = await this.#checkEndpointEligibility(workItem);
    } catch (error) {
      throw endpointEligibilityDispatchError(
        retryableEligibilityError(error)
          ? 'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE'
          : 'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
      );
    }
    if (eligible === true) return;
    throw endpointEligibilityDispatchError(
      eligible === false
        ? 'EXPO_ENDPOINT_INELIGIBLE'
        : 'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
    );
  }

  async #post(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#timeoutMilliseconds,
    );
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderDispatchError(
          'EXPO_HTTP_RATE_LIMITED',
          'safe-to-retry',
        );
      }
      if (response.status >= 500 && response.status <= 599) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderDispatchError(
          'EXPO_HTTP_SERVER_ERROR',
          'safe-to-retry',
        );
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderDispatchError(
          'EXPO_INVALID_CREDENTIALS',
          'terminal-failure',
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderDispatchError(
          'EXPO_HTTP_CLIENT_ERROR',
          'terminal-failure',
        );
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (error instanceof ProviderDispatchError) throw error;
      throw new ProviderDispatchError(
        'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
        'ambiguous',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
