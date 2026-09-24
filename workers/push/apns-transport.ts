import type { WorkerAttemptWorkItem } from '../shared/attempt';
import type { ExpoLiveTransportAuthorizer } from './transport';
import type { ApnsJwtCredential } from './apns-credentials';
import {
  APNS_DIRECT_PROVIDER,
  acceptedDirectPush,
  createDirectPushMessage,
  expiredDirectPush,
  invalidatingDirectPush,
  retryableDirectPush,
  terminalDirectPush,
  unknownDirectPush,
  type DirectPushProviderOutcome,
  type DirectPushPreparation,
  type DirectPushTransport,
} from './direct-protocol';

export const APNS_DEVELOPMENT_ORIGIN =
  'https://api.sandbox.push.apple.com' as const;
export const APNS_PRODUCTION_ORIGIN = 'https://api.push.apple.com' as const;
export const APNS_MAX_PAYLOAD_BYTES = 4_096;

export type ApnsEnvironment = 'development' | 'production';

export interface ApnsHttp2Request {
  readonly origin:
    typeof APNS_DEVELOPMENT_ORIGIN | typeof APNS_PRODUCTION_ORIGIN;
  readonly method: 'POST';
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
  readonly tls: Readonly<{
    alpnProtocol: 'h2';
    minimumVersion: 'TLSv1.2';
    servername: 'api.sandbox.push.apple.com' | 'api.push.apple.com';
  }>;
}

export interface ApnsHttp2Response {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

export interface ApnsHttp2Client {
  request(request: ApnsHttp2Request): Promise<ApnsHttp2Response>;
}

export interface ApnsPushTransportOptions {
  readonly topic: string;
  readonly environment: ApnsEnvironment;
  readonly credential: ApnsJwtCredential;
  readonly client: ApnsHttp2Client;
  /** Omission keeps provider network I/O disabled. */
  readonly authorizeLiveTransport?: ExpoLiveTransportAuthorizer;
  readonly timeoutMilliseconds?: number;
  readonly clock?: () => Date | string | number;
}

const TOPIC_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/u;
const APNS_TOKEN_PATTERN = /^[a-fA-F0-9]{64,200}$/u;
const APNS_ID_PATTERN =
  /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/u;
const MAX_RESPONSE_BYTES = 16 * 1_024;

function timeoutMilliseconds(value: number | undefined): number {
  const timeout = value ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new TypeError('APNs timeout is invalid.');
  }
  return timeout;
}

function parseTopic(value: string): string {
  if (typeof value !== 'string' || !TOPIC_PATTERN.test(value)) {
    throw new TypeError('APNs topic is invalid.');
  }
  return value;
}

function nowSeconds(clock: () => Date | string | number): number {
  const value = new Date(clock()).getTime();
  if (!Number.isFinite(value)) throw new TypeError('APNs clock is invalid.');
  return Math.floor(value / 1_000);
}

function exactJsonRecord(
  body: Uint8Array,
): Readonly<Record<string, unknown>> | null {
  if (body.byteLength < 2 || body.byteLength > MAX_RESPONSE_BYTES) return null;
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body),
    ) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Object.keys(value);
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      !keys.includes('reason') ||
      keys.some((key) => key !== 'reason' && key !== 'timestamp')
    ) {
      return null;
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (
      typeof record.reason !== 'string' ||
      record.reason.length < 1 ||
      record.reason.length > 100 ||
      !/^[A-Za-z]+$/u.test(record.reason)
    ) {
      return null;
    }
    if (
      Object.hasOwn(record, 'timestamp') &&
      (!Number.isSafeInteger(record.timestamp) || Number(record.timestamp) < 0)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function safeApnsId(
  headers: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = headers['apns-id'];
  return typeof value === 'string' && APNS_ID_PATTERN.test(value)
    ? value
    : null;
}

export function classifyApnsResponse(
  response: ApnsHttp2Response,
): DirectPushProviderOutcome {
  let reference: string | null = null;
  try {
    reference = safeApnsId(response.headers);
    return classifyApnsResponseSafely(response, reference);
  } catch {
    return unknownDirectPush('APNS_RESPONSE_INVALID', reference);
  }
}

function classifyApnsResponseSafely(
  response: ApnsHttp2Response,
  reference: string | null,
): DirectPushProviderOutcome {
  if (
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    !(response.body instanceof Uint8Array) ||
    response.body.byteLength > MAX_RESPONSE_BYTES
  ) {
    return unknownDirectPush('APNS_RESPONSE_INVALID', reference);
  }
  if (response.status === 200) {
    return response.body.byteLength === 0 && reference !== null
      ? acceptedDirectPush(reference)
      : unknownDirectPush('APNS_RESPONSE_INVALID', reference);
  }
  const body = exactJsonRecord(response.body);
  if (body === null)
    return unknownDirectPush('APNS_RESPONSE_INVALID', reference);
  const reason = body.reason;
  if (response.status === 410 && reason === 'Unregistered') {
    if (!Object.hasOwn(body, 'timestamp')) {
      return unknownDirectPush('APNS_RESPONSE_INVALID', reference);
    }
    const providerOccurredAt = new Date(Number(body.timestamp)).toISOString();
    return invalidatingDirectPush(
      'APNS_UNREGISTERED',
      reference,
      providerOccurredAt,
    );
  }
  if (
    response.status === 400 &&
    (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')
  ) {
    return invalidatingDirectPush('APNS_BAD_DEVICE_TOKEN', reference);
  }
  if (response.status === 429) {
    return retryableDirectPush('APNS_THROTTLED', reference);
  }
  if (response.status >= 500) {
    return retryableDirectPush('APNS_SERVER_ERROR', reference);
  }
  if (response.status === 401 || response.status === 403) {
    return terminalDirectPush('APNS_AUTHENTICATION_FAILED', reference);
  }
  if (
    ['BadTopic', 'MissingTopic', 'TopicDisallowed'].includes(String(reason))
  ) {
    return terminalDirectPush('APNS_TOPIC_REJECTED', reference);
  }
  return terminalDirectPush('APNS_PAYLOAD_REJECTED', reference);
}

function endpointMetadata(
  workItem: WorkerAttemptWorkItem,
): Readonly<{ provider?: unknown; serviceEnvironment?: unknown }> {
  return workItem.endpoint as unknown as Readonly<{
    provider?: unknown;
    serviceEnvironment?: unknown;
  }>;
}

/** Provider-free APNs boundary; the injected client owns the actual HTTP/2 session. */
export class ApnsPushTransport implements DirectPushTransport {
  public readonly provider = APNS_DIRECT_PROVIDER;
  readonly #topic: string;
  readonly #environment: ApnsEnvironment;
  readonly #credential: ApnsJwtCredential;
  readonly #client: ApnsHttp2Client;
  readonly #authorize: ExpoLiveTransportAuthorizer | undefined;
  readonly #timeoutMilliseconds: number;
  readonly #clock: () => Date | string | number;

  public constructor(options: ApnsPushTransportOptions) {
    if (
      options.environment !== 'development' &&
      options.environment !== 'production'
    ) {
      throw new TypeError('APNs environment is invalid.');
    }
    if (
      options.client === null ||
      typeof options.client !== 'object' ||
      typeof options.client.request !== 'function'
    ) {
      throw new TypeError('APNs HTTP/2 client is invalid.');
    }
    this.#topic = parseTopic(options.topic);
    this.#environment = options.environment;
    this.#credential = options.credential;
    this.#client = options.client;
    this.#authorize = options.authorizeLiveTransport;
    this.#timeoutMilliseconds = timeoutMilliseconds(
      options.timeoutMilliseconds,
    );
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
      workItem.endpoint.platform !== 'ios' ||
      metadata.provider !== 'apns' ||
      metadata.serviceEnvironment !== this.#environment ||
      !APNS_TOKEN_PATTERN.test(workItem.endpoint.token)
    ) {
      return outcome(terminalDirectPush('APNS_ENDPOINT_INELIGIBLE'));
    }
    const message = createDirectPushMessage(workItem);
    const deviceToken = workItem.endpoint.token;
    const now = nowSeconds(this.#clock);
    if (message.expiration <= now) {
      return outcome(expiredDirectPush(this.provider));
    }

    let token: string;
    try {
      token = await this.#credential.getToken();
    } catch {
      return outcome(terminalDirectPush('APNS_AUTHENTICATION_FAILED'));
    }
    const body = new TextEncoder().encode(
      JSON.stringify({
        aps: {
          alert: { title: message.title, body: message.body },
          sound: 'default',
          'interruption-level': 'time-sensitive',
        },
        ...message.data,
      }),
    );
    if (body.byteLength > APNS_MAX_PAYLOAD_BYTES) {
      return outcome(terminalDirectPush('APNS_PAYLOAD_REJECTED'));
    }
    let authorized = false;
    try {
      authorized =
        this.#authorize !== undefined && (await this.#authorize()) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return outcome(terminalDirectPush('APNS_LIVE_TRANSPORT_DISABLED'));
    }
    const origin =
      this.#environment === 'production'
        ? APNS_PRODUCTION_ORIGIN
        : APNS_DEVELOPMENT_ORIGIN;
    const hostname = new URL(origin).hostname as
      'api.sandbox.push.apple.com' | 'api.push.apple.com';
    return Object.freeze({
      kind: 'prepared' as const,
      provider: this.provider,
      send: async (): Promise<DirectPushProviderOutcome> => {
        // This check is synchronous and immediately precedes provider I/O.
        if (message.expiration <= nowSeconds(this.#clock)) {
          return expiredDirectPush(this.provider);
        }
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.#timeoutMilliseconds,
        );
        try {
          const responsePromise = this.#client.request(
            Object.freeze({
              origin,
              method: 'POST',
              path: `/3/device/${deviceToken}`,
              headers: Object.freeze({
                authorization: `bearer ${token}`,
                'apns-expiration': String(message.expiration),
                'apns-priority': '10',
                'apns-push-type': 'alert',
                'apns-topic': this.#topic,
                'content-type': 'application/json',
              }),
              body,
              signal: controller.signal,
              tls: Object.freeze({
                alpnProtocol: 'h2',
                minimumVersion: 'TLSv1.2',
                servername: hostname,
              }),
            }),
          );
          return classifyApnsResponse(await responsePromise);
        } catch {
          // The request boundary was crossed; stream reset, GOAWAY, timeout,
          // and connection errors cannot prove Apple did not accept it.
          return unknownDirectPush('APNS_NETWORK_OUTCOME_AMBIGUOUS');
        } finally {
          clearTimeout(timeout);
        }
      },
    });
  }
}
