import type { WorkerAttemptWorkItem } from '../shared/attempt';
import type { ExpoLiveTransportAuthorizer } from './transport';
import { parseFcmProjectId } from './fcm-credentials';
import type { FcmOAuthCredential } from './fcm-credentials';
import { FcmOAuthTokenSourceError } from './provider-clients';
import {
  FCM_DIRECT_PROVIDER,
  acceptedDirectPush,
  createDirectPushMessage,
  expiredDirectPush,
  invalidatingDirectPush,
  retryableDirectPush,
  safeFcmProviderReference,
  terminalDirectPush,
  unknownDirectPush,
  type DirectPushProviderOutcome,
  type DirectPushPreparation,
  type DirectPushTransport,
} from './direct-protocol';

export const FCM_API_ORIGIN = 'https://fcm.googleapis.com' as const;
export const FCM_MAX_REQUEST_BYTES = 4_096;

export type FcmPushFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FcmPushTransportOptions {
  readonly projectId: string;
  readonly serviceEnvironment: 'development' | 'production';
  readonly credential: FcmOAuthCredential;
  readonly fetch?: FcmPushFetch;
  /** Omission keeps provider network I/O disabled. */
  readonly authorizeLiveTransport?: ExpoLiveTransportAuthorizer;
  readonly timeoutMilliseconds?: number;
  readonly clock?: () => Date | string | number;
}

const MAX_RESPONSE_BYTES = 32 * 1_024;
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:-]{32,4096}$/u;
const FCM_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:%+-]{0,511}$/u;

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new TypeError('FCM timeout is invalid.');
  }
  return timeout;
}

function nowSeconds(clock: () => Date | string | number): number {
  const value = new Date(clock()).getTime();
  if (!Number.isFinite(value)) throw new TypeError('FCM clock is invalid.');
  return Math.floor(value / 1_000);
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return null;
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
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The bounded reader has already rejected the response.
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
    return null;
  }
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

type ParsedFcmError = Readonly<{
  code: number;
  status: string;
  hasBadRequest: boolean;
  fcmErrorCode: string | null;
}>;

function parseFcmError(value: unknown): ParsedFcmError | null {
  const root = plainRecord(value);
  if (root === null || !hasExactKeys(root, ['error'])) return null;
  const error = plainRecord(root.error);
  if (
    error === null ||
    !(
      hasExactKeys(error, ['code', 'message', 'status']) ||
      hasExactKeys(error, ['code', 'details', 'message', 'status'])
    ) ||
    !Number.isSafeInteger(error.code) ||
    typeof error.message !== 'string' ||
    error.message.length > 4_096 ||
    typeof error.status !== 'string' ||
    !/^[A-Z_]{1,64}$/u.test(error.status)
  ) {
    return null;
  }
  const details = error.details ?? [];
  if (!Array.isArray(details) || details.length > 16) return null;
  let hasBadRequest = false;
  let fcmErrorCode: string | null = null;
  for (const detailValue of details) {
    const detail = plainRecord(detailValue);
    if (detail === null || typeof detail['@type'] !== 'string') return null;
    const type = detail['@type'];
    if (type === 'type.googleapis.com/google.rpc.BadRequest') {
      if (!hasExactKeys(detail, ['@type', 'fieldViolations'])) return null;
      if (
        !Array.isArray(detail.fieldViolations) ||
        detail.fieldViolations.length > 32
      ) {
        return null;
      }
      hasBadRequest = true;
      continue;
    }
    if (type === 'type.googleapis.com/google.firebase.fcm.v1.FcmError') {
      if (
        !hasExactKeys(detail, ['@type', 'errorCode']) ||
        typeof detail.errorCode !== 'string' ||
        !/^[A-Z_]{1,64}$/u.test(detail.errorCode)
      ) {
        return null;
      }
      fcmErrorCode = detail.errorCode;
      continue;
    }
    // Other documented google.rpc details are irrelevant to classification,
    // but remain bounded by the response byte cap and the detail count cap.
  }
  return Object.freeze({
    code: Number(error.code),
    status: error.status,
    hasBadRequest,
    fcmErrorCode,
  });
}

export async function classifyFcmResponse(
  response: Response,
  locallyValidatedPayload: boolean,
  expectedProjectId?: string,
): Promise<DirectPushProviderOutcome> {
  const body = await readBoundedJson(response);
  if (body === null) return unknownDirectPush('FCM_RESPONSE_INVALID');
  if (response.status === 200) {
    const record = plainRecord(body);
    const expectedPrefix =
      expectedProjectId === undefined
        ? null
        : `projects/${expectedProjectId}/messages/`;
    if (
      record === null ||
      !hasExactKeys(record, ['name']) ||
      typeof record.name !== 'string' ||
      expectedPrefix === null ||
      !record.name.startsWith(expectedPrefix) ||
      !FCM_MESSAGE_ID_PATTERN.test(record.name.slice(expectedPrefix.length))
    ) {
      return unknownDirectPush('FCM_RESPONSE_INVALID');
    }
    const reference = safeFcmProviderReference(record.name);
    return reference === null
      ? unknownDirectPush('FCM_RESPONSE_INVALID')
      : acceptedDirectPush(reference);
  }
  const error = parseFcmError(body);
  if (error === null || error.code !== response.status) {
    return unknownDirectPush('FCM_RESPONSE_INVALID');
  }
  if (
    error.fcmErrorCode === 'UNREGISTERED' &&
    (response.status === 400 || response.status === 404)
  ) {
    return invalidatingDirectPush('FCM_UNREGISTERED');
  }
  if (
    response.status === 400 &&
    (error.status === 'INVALID_ARGUMENT' ||
      error.fcmErrorCode === 'INVALID_ARGUMENT')
  ) {
    if (error.hasBadRequest || !locallyValidatedPayload) {
      return terminalDirectPush('FCM_PAYLOAD_INVALID');
    }
    return invalidatingDirectPush('FCM_INVALID_ARGUMENT');
  }
  if (response.status === 429 || error.status === 'RESOURCE_EXHAUSTED') {
    return retryableDirectPush('FCM_THROTTLED');
  }
  if (
    response.status >= 500 ||
    error.status === 'UNAVAILABLE' ||
    error.status === 'INTERNAL'
  ) {
    return retryableDirectPush('FCM_SERVER_ERROR');
  }
  if (response.status === 401 || response.status === 403) {
    return terminalDirectPush('FCM_AUTHENTICATION_FAILED');
  }
  return terminalDirectPush('FCM_PAYLOAD_INVALID');
}

function endpointMetadata(
  workItem: WorkerAttemptWorkItem,
): Readonly<{ provider?: unknown; serviceEnvironment?: unknown }> {
  return workItem.endpoint as unknown as Readonly<{
    provider?: unknown;
    serviceEnvironment?: unknown;
  }>;
}

/** Fixed-origin FCM HTTP v1 transport with injected OAuth and fetch boundaries. */
export class FcmPushTransport implements DirectPushTransport {
  public readonly provider = FCM_DIRECT_PROVIDER;
  public readonly projectId: string;
  readonly #serviceEnvironment: 'development' | 'production';
  readonly #credential: FcmOAuthCredential;
  readonly #fetch: FcmPushFetch;
  readonly #authorize: ExpoLiveTransportAuthorizer | undefined;
  readonly #timeoutMilliseconds: number;
  readonly #clock: () => Date | string | number;

  public constructor(options: FcmPushTransportOptions) {
    this.projectId = parseFcmProjectId(options.projectId);
    if (options.credential.projectId !== this.projectId) {
      throw new TypeError('FCM credential project does not match transport.');
    }
    if (
      options.serviceEnvironment !== 'development' &&
      options.serviceEnvironment !== 'production'
    ) {
      throw new TypeError('FCM service environment is invalid.');
    }
    this.#serviceEnvironment = options.serviceEnvironment;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorize = options.authorizeLiveTransport;
    this.#timeoutMilliseconds = parseTimeout(options.timeoutMilliseconds);
    this.#clock = options.clock ?? Date.now;
  }

  public async prepare(
    workItem: WorkerAttemptWorkItem,
  ): Promise<DirectPushPreparation> {
    const outcome = (value: DirectPushProviderOutcome) =>
      Object.freeze({
        kind: 'outcome' as const,
        provider: this.provider,
        outcome: value,
      });
    const metadata = endpointMetadata(workItem);
    if (
      workItem.endpoint.channel !== 'push' ||
      workItem.endpoint.platform !== 'android' ||
      metadata.provider !== 'fcm' ||
      metadata.serviceEnvironment !== this.#serviceEnvironment ||
      !FCM_TOKEN_PATTERN.test(workItem.endpoint.token)
    ) {
      return outcome(terminalDirectPush('FCM_ENDPOINT_INELIGIBLE'));
    }
    const message = createDirectPushMessage(workItem);
    if (message.expiration <= nowSeconds(this.#clock)) {
      return outcome(expiredDirectPush(this.provider));
    }
    let credential: Awaited<ReturnType<FcmOAuthCredential['getAccessToken']>>;
    try {
      credential = await this.#credential.getAccessToken();
    } catch (error) {
      const retryable =
        error instanceof FcmOAuthTokenSourceError && error.retryable;
      return outcome(
        retryable
          ? retryableDirectPush('FCM_AUTHENTICATION_UNAVAILABLE')
          : terminalDirectPush('FCM_AUTHENTICATION_FAILED'),
      );
    }
    let authorized = false;
    try {
      authorized =
        this.#authorize !== undefined && (await this.#authorize()) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return outcome(terminalDirectPush('FCM_LIVE_TRANSPORT_DISABLED'));
    }
    return Object.freeze({
      kind: 'prepared' as const,
      provider: this.provider,
      send: async (): Promise<DirectPushProviderOutcome> => {
        // Relative TTL is derived immediately before the synchronous fetch.
        const sendNow = nowSeconds(this.#clock);
        if (message.expiration <= sendNow) {
          return expiredDirectPush(this.provider);
        }
        const body = JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: Object.fromEntries(
              Object.entries(message.data).map(([key, value]) => [
                key,
                String(value),
              ]),
            ),
            android: {
              priority: 'high',
              ttl: `${message.expiration - sendNow}s`,
            },
            apns: {
              headers: {
                'apns-expiration': String(message.expiration),
                'apns-priority': '10',
                'apns-push-type': 'alert',
              },
              payload: {
                aps: {
                  sound: 'default',
                  'interruption-level': 'time-sensitive',
                },
              },
            },
          },
        });
        const locallyValidatedPayload =
          new TextEncoder().encode(body).byteLength <= FCM_MAX_REQUEST_BYTES;
        if (!locallyValidatedPayload) {
          return terminalDirectPush('FCM_PAYLOAD_INVALID');
        }
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.#timeoutMilliseconds,
        );
        try {
          const responsePromise = this.#fetch(
            `${FCM_API_ORIGIN}/v1/projects/${this.projectId}/messages:send`,
            {
              method: 'POST',
              headers: {
                accept: 'application/json',
                authorization: `Bearer ${credential.accessToken}`,
                'content-type': 'application/json',
              },
              body,
              redirect: 'error',
              signal: controller.signal,
            },
          );
          return await classifyFcmResponse(
            await responsePromise,
            locallyValidatedPayload,
            this.projectId,
          );
        } catch {
          // Failure after invocation cannot prove FCM did not accept it.
          return unknownDirectPush('FCM_NETWORK_OUTCOME_AMBIGUOUS');
        } finally {
          clearTimeout(timeout);
        }
      },
    });
  }
}
