import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import {
  ExpoPushAttemptReferenceMessageSchema,
  IntegrationVerificationReferenceSchema,
  PushProviderCutoverSchema,
  type PushProviderCutover,
} from '@psd-eoc/contracts';

import { failureDetail } from '../shared/failure-detail';
import { AttemptExecutionClient } from '../shared/attempt-execution-client';
import { DeliveryStateWritebackClient } from '../shared/delivery-state-client';
import { LedgeredExpoPushAdapter } from './adapter';
import { ApnsJwtCredential } from './apns-credentials';
import { ApnsPushTransport } from './apns-transport';
import { LedgeredDirectPushAdapter } from './direct-adapter';
import {
  DirectPushWorker,
  PushProviderRouter,
  type PushAttemptWorker,
} from './direct-worker';
import { createProductionPushEndpointEligibilityClient } from './eligibility';
import { FcmOAuthCredential } from './fcm-credentials';
import { FcmPushTransport } from './fcm-transport';
import { PushEndpointInvalidationClient } from './invalidation';
import {
  createApnsJwtSigner,
  createFcmServiceAccountTokenSource,
  NodeApnsHttp2Client,
} from './provider-clients';
import { ExpoReceiptLifecycle } from './receipt-lifecycle';
import {
  ExpoPushRuntime,
  ExpoReceiptQueueResendScheduler,
  type ExpoPushRetryPublisher,
} from './runtime';
import { ExpoPushRuntimeClient } from './state-client';
import { ExpoPushHttpTransport } from './transport';
import { ExpoPushWorker } from './worker';

const RECEIPT_INTERVAL_MILLISECONDS = 60_000;
const VISIBILITY_HEARTBEAT_MILLISECONDS = 30_000;
const VISIBILITY_TIMEOUT_SECONDS = 120;

type SafeLogEvent = Readonly<{
  event:
    | 'push-worker-started'
    | 'push-worker-heartbeat'
    | 'push-worker-message-completed'
    | 'push-worker-message-incomplete'
    | 'push-worker-message-failed'
    | 'push-worker-receipts-completed'
    | 'push-worker-receipts-failed'
    | 'push-worker-stuck-outbox-sample'
    | 'push-worker-stuck-outbox-sample-failed';
  count?: number;
  durationMilliseconds?: number;
  /** Bounded, value-free reason. Never a recipient, token, or payload. */
  detail?: string;
}>;

export interface ExpoPushServiceConfiguration {
  readonly queueUrl: string;
  readonly serviceOrigin: string;
  readonly expoAccessToken: string;
  readonly attemptExecutionToken: string;
  readonly deliveryStateToken: string;
  readonly endpointWorkerToken: string;
  readonly pushRuntimeToken: string;
  readonly verificationReference: string;
  readonly cutover: PushProviderCutover;
  readonly direct: DirectPushServiceConfiguration | null;
}

export interface DirectPushServiceConfiguration {
  readonly verificationReference: string;
  readonly apns: Readonly<{
    environment: 'development' | 'production';
    keyId: string;
    privateKey: string;
    teamId: string;
    topic: string;
  }>;
  readonly fcm: Readonly<{
    clientEmail: string;
    environment: 'development' | 'production';
    privateKey: string;
    projectId: string;
  }>;
}

export type ExpoPushServiceErrorCode =
  | 'FEATURE_DISABLED'
  | 'INVALID_CONFIGURATION'
  | 'QUEUE_MESSAGE_INVALID';

export class ExpoPushServiceError extends Error {
  public constructor(public readonly code: ExpoPushServiceErrorCode) {
    super('The Expo push service is unavailable.');
    this.name = 'ExpoPushServiceError';
  }
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum = 4_096,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new ExpoPushServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function token(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = required(environment, name);
  if (value.length < 32 || /\s/u.test(value)) {
    throw new ExpoPushServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function privateKey(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  const normalized = value?.endsWith('\n') ? value.slice(0, -1) : value;
  const containsUnsafeControl = Array.from(value ?? '').some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 10) || code === 127;
  });
  if (
    value === undefined ||
    normalized === undefined ||
    value.length < 100 ||
    value.length > 16_384 ||
    normalized.trim() !== normalized ||
    containsUnsafeControl ||
    !normalized.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !normalized.endsWith('\n-----END PRIVATE KEY-----')
  ) {
    throw new ExpoPushServiceError('INVALID_CONFIGURATION');
  }
  return normalized;
}

function origin(value: string): string {
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
    throw new ExpoPushServiceError('INVALID_CONFIGURATION');
  }
}

function queueUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.startsWith('sqs.') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new ExpoPushServiceError('INVALID_CONFIGURATION');
  }
}

function serviceEnvironment(value: string): 'development' | 'production' {
  if (value !== 'development' && value !== 'production') {
    throw new ExpoPushServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function verificationReference(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  provider: 'expo' | 'direct',
): string {
  const reference = required(environment, name, 255);
  if (
    reference === 'UNVERIFIED' ||
    (provider === 'direct'
      ? !IntegrationVerificationReferenceSchema.safeParse(reference).success
      : !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(reference))
  ) {
    throw new ExpoPushServiceError('FEATURE_DISABLED');
  }
  return reference;
}

function pushProviderCutover(value: string): PushProviderCutover {
  try {
    const parsed = PushProviderCutoverSchema.safeParse(JSON.parse(value));
    if (!parsed.success || JSON.stringify(parsed.data) !== value) {
      throw new TypeError();
    }
    return parsed.data;
  } catch {
    throw new ExpoPushServiceError('INVALID_CONFIGURATION');
  }
}

/** Runtime mode and provider authorization must both be exact opt-ins. */
export function readExpoPushServiceConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExpoPushServiceConfiguration {
  if (
    environment.PSD_EOC_EXPO_PUSH_RUNTIME_MODE !== 'enabled' ||
    environment.PSD_EOC_EXPO_PUSH_PROVIDER_AUTHORIZED !== 'true' ||
    environment.PSD_EOC_EXPO_CREDENTIAL_STATUS !== 'verified'
  ) {
    throw new ExpoPushServiceError('FEATURE_DISABLED');
  }
  const expoVerificationReference = verificationReference(
    environment,
    'PSD_EOC_EXPO_CREDENTIAL_VERIFICATION_REFERENCE',
    'expo',
  );
  const cutover = pushProviderCutover(
    required(environment, 'PSD_EOC_PUSH_PROVIDER_CUTOVER', 1_024),
  );
  const directSelected =
    cutover.ios === 'direct' || cutover.android === 'direct';
  const directAuthorized =
    environment.PSD_EOC_DIRECT_PUSH_PROVIDER_AUTHORIZED === 'true';
  if (directSelected && !directAuthorized) {
    throw new ExpoPushServiceError('FEATURE_DISABLED');
  }
  let direct: DirectPushServiceConfiguration | null = null;
  if (directAuthorized) {
    if (
      environment.APNS_CREDENTIAL_STATUS !== 'verified' ||
      environment.FCM_CREDENTIAL_STATUS !== 'verified'
    ) {
      throw new ExpoPushServiceError('FEATURE_DISABLED');
    }
    const apnsTopic = required(environment, 'APNS_TOPIC', 255);
    if (apnsTopic !== required(environment, 'PSD_EOC_IOS_BUNDLE_ID', 255)) {
      throw new ExpoPushServiceError('INVALID_CONFIGURATION');
    }
    direct = Object.freeze({
      verificationReference: verificationReference(
        environment,
        'PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE',
        'direct',
      ),
      apns: Object.freeze({
        environment: serviceEnvironment(
          required(environment, 'APNS_ENVIRONMENT', 32),
        ),
        keyId: required(environment, 'APNS_KEY_ID', 10),
        privateKey: privateKey(environment, 'APNS_PRIVATE_KEY'),
        teamId: required(environment, 'APNS_TEAM_ID', 10),
        topic: apnsTopic,
      }),
      fcm: Object.freeze({
        clientEmail: required(environment, 'FCM_CLIENT_EMAIL', 320),
        environment: serviceEnvironment(
          required(environment, 'FCM_ENVIRONMENT', 32),
        ),
        privateKey: privateKey(environment, 'FCM_PRIVATE_KEY'),
        projectId: required(environment, 'FCM_PROJECT_ID', 64),
      }),
    });
  }
  return Object.freeze({
    queueUrl: queueUrl(required(environment, 'PUSH_QUEUE_URL', 2_048)),
    serviceOrigin: origin(
      required(environment, 'PSD_EOC_SERVICE_ORIGIN', 2_048),
    ),
    expoAccessToken: token(environment, 'EXPO_ACCESS_TOKEN'),
    attemptExecutionToken: token(
      environment,
      'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
    ),
    deliveryStateToken: token(
      environment,
      'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
    ),
    endpointWorkerToken: token(
      environment,
      'PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN',
    ),
    pushRuntimeToken: token(
      environment,
      'PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN',
    ),
    verificationReference: expoVerificationReference,
    cutover,
    direct,
  });
}

interface SqsSendClient {
  send(command: unknown): Promise<unknown>;
}

export class SqsExpoPushRetryPublisher implements ExpoPushRetryPublisher {
  public constructor(
    private readonly client: SqsSendClient,
    private readonly queue: string,
  ) {}

  public async publishAttemptReference(
    attemptId: string,
    delaySeconds: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < 0 ||
      delaySeconds > 900
    ) {
      throw new ExpoPushServiceError('INVALID_CONFIGURATION');
    }
    const message = ExpoPushAttemptReferenceMessageSchema.parse({
      kind: 'expo-push-attempt-reference',
      attemptId,
    });
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queue,
        MessageBody: JSON.stringify(message),
        DelaySeconds: delaySeconds,
      }),
    );
  }
}

export interface ExpoPushServiceDependencies {
  readonly sqs?: SqsSendClient;
  readonly runtime?: Pick<
    ExpoPushRuntime,
    'processQueueMessage' | 'readStuckOutboxCount' | 'runDueReceipts'
  >;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly log?: (event: SafeLogEvent) => void;
  readonly shouldContinue?: () => boolean;
  readonly now?: () => number;
}

function logToStdout(event: SafeLogEvent): void {
  console.log(JSON.stringify(event));
}

function buildRuntime(
  configuration: ExpoPushServiceConfiguration,
  sqs: SqsSendClient,
): ExpoPushRuntime {
  const state = new ExpoPushRuntimeClient({
    serviceOrigin: configuration.serviceOrigin,
    bearerToken: configuration.pushRuntimeToken,
  });
  const queue = new SqsExpoPushRetryPublisher(sqs, configuration.queueUrl);
  const eligibility = createProductionPushEndpointEligibilityClient({
    serviceOrigin: configuration.serviceOrigin,
    bearerToken: configuration.endpointWorkerToken,
  });
  const invalidator = new PushEndpointInvalidationClient({
    serviceOrigin: configuration.serviceOrigin,
    bearerToken: configuration.endpointWorkerToken,
  });
  const transport = new ExpoPushHttpTransport({
    accessToken: configuration.expoAccessToken,
    endpointEligibility: eligibility,
    authorizeLiveTransport: () => true,
  });
  const writer = new DeliveryStateWritebackClient({
    serviceOrigin: configuration.serviceOrigin,
    bearerToken: configuration.deliveryStateToken,
  });
  const receipts = new ExpoReceiptLifecycle({
    store: state,
    transport,
    evidenceWriter: writer,
    endpointInvalidator: invalidator,
    resendScheduler: new ExpoReceiptQueueResendScheduler(state, queue),
  });
  const executionStore = new AttemptExecutionClient({
    serviceOrigin: configuration.serviceOrigin,
    bearerToken: configuration.attemptExecutionToken,
  });
  const expoWorker = (
    integrationId: 'expo-push' | 'mobile-push',
  ): ExpoPushWorker =>
    new ExpoPushWorker({
      adapter: new LedgeredExpoPushAdapter({
        transport,
        sendLedger: state,
        endpointEligibility: eligibility,
        integrationId,
      }),
      executionStore,
      evidenceWriter: writer,
      endpointInvalidator: invalidator,
      receiptScheduler: receipts,
      endpointEligibility: eligibility,
      authorizeLiveProvider: () => true,
    });
  const disabledDirectWorker: PushAttemptWorker = Object.freeze({
    process: () => Promise.reject(new ExpoPushServiceError('FEATURE_DISABLED')),
  });
  let apnsWorker = disabledDirectWorker;
  let fcmWorker = disabledDirectWorker;
  if (configuration.direct !== null) {
    const apnsTransport = new ApnsPushTransport({
      topic: configuration.direct.apns.topic,
      environment: configuration.direct.apns.environment,
      credential: new ApnsJwtCredential({
        teamId: configuration.direct.apns.teamId,
        keyId: configuration.direct.apns.keyId,
        privateKey: configuration.direct.apns.privateKey,
        signer: createApnsJwtSigner(),
      }),
      client: new NodeApnsHttp2Client(),
      authorizeLiveTransport: () => true,
    });
    const fcmCredential = new FcmOAuthCredential({
      projectId: configuration.direct.fcm.projectId,
      tokenSource: createFcmServiceAccountTokenSource({
        clientEmail: configuration.direct.fcm.clientEmail,
        privateKey: configuration.direct.fcm.privateKey,
      }),
    });
    const fcmTransport = new FcmPushTransport({
      projectId: configuration.direct.fcm.projectId,
      serviceEnvironment: configuration.direct.fcm.environment,
      credential: fcmCredential,
      authorizeLiveTransport: () => true,
    });
    apnsWorker = new DirectPushWorker({
      adapter: new LedgeredDirectPushAdapter({
        transport: apnsTransport,
        sendLedger: state,
        endpointEligibility: eligibility,
        authorizeLiveTransport: () => true,
      }),
      executionStore,
      evidenceWriter: writer,
      endpointInvalidator: invalidator,
      endpointEligibility: eligibility,
      authorizeLiveProvider: () => true,
    });
    fcmWorker = new DirectPushWorker({
      adapter: new LedgeredDirectPushAdapter({
        transport: fcmTransport,
        sendLedger: state,
        endpointEligibility: eligibility,
        authorizeLiveTransport: () => true,
      }),
      executionStore,
      evidenceWriter: writer,
      endpointInvalidator: invalidator,
      endpointEligibility: eligibility,
      authorizeLiveProvider: () => true,
    });
  }
  const worker = new PushProviderRouter({
    legacyExpo: expoWorker('expo-push'),
    expo: expoWorker('mobile-push'),
    apns: apnsWorker,
    fcm: fcmWorker,
  });
  return new ExpoPushRuntime({ worker, receipts, state, queue });
}

function parseMessage(value: unknown): Readonly<{
  body: string;
  receiptHandle: string;
  enqueuedAt: string;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExpoPushServiceError('QUEUE_MESSAGE_INVALID');
  }
  const message = value as Readonly<Record<string, unknown>>;
  const attributes = message.Attributes;
  const sentTimestamp =
    attributes !== null &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes)
      ? (attributes as Readonly<Record<string, unknown>>).SentTimestamp
      : undefined;
  if (
    typeof message.Body !== 'string' ||
    typeof message.ReceiptHandle !== 'string' ||
    message.ReceiptHandle.length < 1 ||
    message.ReceiptHandle.length > 8_192 ||
    typeof sentTimestamp !== 'string' ||
    !/^\d{13}$/u.test(sentTimestamp)
  ) {
    throw new ExpoPushServiceError('QUEUE_MESSAGE_INVALID');
  }
  const enqueuedAt = new Date(Number(sentTimestamp)).toISOString();
  return Object.freeze({
    body: message.Body,
    receiptHandle: message.ReceiptHandle,
    enqueuedAt,
  });
}

/** Long-polling Fargate entry point. It logs only bounded aggregate events. */
export async function runExpoPushService(
  dependencies: ExpoPushServiceDependencies = {},
): Promise<void> {
  const configuration = readExpoPushServiceConfiguration(
    dependencies.environment,
  );
  const sqs = dependencies.sqs ?? new SQSClient({} satisfies SQSClientConfig);
  const runtime = dependencies.runtime ?? buildRuntime(configuration, sqs);
  const log = dependencies.log ?? logToStdout;
  const shouldContinue = dependencies.shouldContinue ?? (() => true);
  const now = dependencies.now ?? Date.now;
  let nextReceiptRun = now();
  log({ event: 'push-worker-started' });

  while (shouldContinue()) {
    if (now() >= nextReceiptRun) {
      try {
        const results = await runtime.runDueReceipts();
        log({
          event: 'push-worker-receipts-completed',
          count: Array.isArray(results) ? results.length : 0,
        });
      } catch {
        log({ event: 'push-worker-receipts-failed' });
      }
      try {
        log({
          event: 'push-worker-stuck-outbox-sample',
          count: await runtime.readStuckOutboxCount(),
        });
      } catch {
        log({ event: 'push-worker-stuck-outbox-sample-failed' });
      }
      nextReceiptRun = now() + RECEIPT_INTERVAL_MILLISECONDS;
    }
    log({ event: 'push-worker-heartbeat' });
    const response = (await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: configuration.queueUrl,
        MessageSystemAttributeNames: ['SentTimestamp'],
        MaxNumberOfMessages: 1,
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
        WaitTimeSeconds: 20,
      }),
    )) as Readonly<{ Messages?: readonly unknown[] }>;
    const raw = response.Messages?.[0];
    if (raw === undefined) continue;

    let message: ReturnType<typeof parseMessage>;
    try {
      message = parseMessage(raw);
    } catch (error) {
      log({
        event: 'push-worker-message-failed',
        count: 1,
        detail: failureDetail(error),
      });
      continue;
    }
    const heartbeat = setInterval(() => {
      void sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: configuration.queueUrl,
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
          }),
        )
        .catch(() => undefined);
    }, VISIBILITY_HEARTBEAT_MILLISECONDS);
    try {
      const result = await runtime.processQueueMessage(
        message.body,
        message.enqueuedAt,
      );
      if (result.kind === 'retry-later') {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: configuration.queueUrl,
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: result.delaySeconds,
          }),
        );
      } else {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: configuration.queueUrl,
            ReceiptHandle: message.receiptHandle,
          }),
        );
      }
      if (result.kind === 'completed' && result.acceptedCount > 0) {
        log({
          event: 'push-worker-message-completed',
          count: result.acceptedCount,
          durationMilliseconds: Math.max(
            0,
            now() - Date.parse(result.outboxCreatedAt),
          ),
        });
      }
      if (result.kind === 'completed' && result.incompleteCount > 0) {
        log({
          event: 'push-worker-message-incomplete',
          count: result.incompleteCount,
        });
      }
    } catch {
      log({ event: 'push-worker-message-failed', count: 1 });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

if (import.meta.main) {
  await runExpoPushService();
}
