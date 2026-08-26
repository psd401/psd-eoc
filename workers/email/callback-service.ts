import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';

import { parseSnsCallbackEnvelope } from './sns-signature';

const VISIBILITY_TIMEOUT_SECONDS = 120;
const VISIBILITY_HEARTBEAT_MILLISECONDS = 30_000;
const MAX_CALLBACK_BYTES = 512 * 1024;

type CallbackLogEvent = Readonly<{
  event:
    | 'email-callback-worker-started'
    | 'email-callback-worker-heartbeat'
    | 'email-callback-message-completed'
    | 'email-callback-message-failed';
  count?: number;
}>;

export interface EmailCallbackServiceConfiguration {
  readonly queueUrl: string;
  readonly expectedTopicArn: string;
  readonly serviceOrigin: string;
}

export type EmailCallbackFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class EmailCallbackServiceError extends Error {
  public constructor(
    public readonly code:
      | 'FEATURE_DISABLED'
      | 'INVALID_CONFIGURATION'
      | 'QUEUE_MESSAGE_INVALID',
  ) {
    super('The email callback service is unavailable.');
    this.name = 'EmailCallbackServiceError';
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
    throw new EmailCallbackServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function exactHttps(value: string, kind: 'origin' | 'queue'): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      (kind === 'origin' &&
        (url.pathname !== '/' || url.search !== '' || url.hash !== '')) ||
      (kind === 'queue' && !url.hostname.startsWith('sqs.'))
    ) {
      throw new Error();
    }
    return kind === 'origin' ? url.origin : url.toString();
  } catch {
    throw new EmailCallbackServiceError('INVALID_CONFIGURATION');
  }
}

export function readEmailCallbackServiceConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EmailCallbackServiceConfiguration {
  if (environment.PSD_EOC_EMAIL_CALLBACK_RUNTIME_MODE !== 'enabled') {
    throw new EmailCallbackServiceError('FEATURE_DISABLED');
  }
  const expectedTopicArn = required(
    environment,
    'PSD_EOC_SES_SNS_TOPIC_ARN',
    2_048,
  );
  if (
    !/^arn:[a-z0-9-]+:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/u.test(
      expectedTopicArn,
    )
  ) {
    throw new EmailCallbackServiceError('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    queueUrl: exactHttps(
      required(environment, 'EMAIL_CALLBACK_QUEUE_URL', 2_048),
      'queue',
    ),
    serviceOrigin: exactHttps(
      required(environment, 'PSD_EOC_SERVICE_ORIGIN', 2_048),
      'origin',
    ),
    expectedTopicArn,
  });
}

function callbackEnvelope(body: string, expectedTopicArn: string) {
  if (
    body.length === 0 ||
    Buffer.byteLength(body, 'utf8') > MAX_CALLBACK_BYTES
  ) {
    throw new EmailCallbackServiceError('QUEUE_MESSAGE_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new EmailCallbackServiceError('QUEUE_MESSAGE_INVALID');
  }
  try {
    return parseSnsCallbackEnvelope(value, expectedTopicArn);
  } catch {
    throw new EmailCallbackServiceError('QUEUE_MESSAGE_INVALID');
  }
}

export async function forwardEmailCallback(
  body: string,
  configuration: EmailCallbackServiceConfiguration,
  fetcher: EmailCallbackFetch = globalThis.fetch,
): Promise<boolean> {
  const envelope = callbackEnvelope(body, configuration.expectedTopicArn);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetcher(
      `${configuration.serviceOrigin}/api/webhooks/ses`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-amz-sns-message-id': envelope.MessageId,
          'x-amz-sns-message-type': envelope.Type,
          'x-amz-sns-topic-arn': envelope.TopicArn,
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      },
    );
  } catch {
    clearTimeout(timeout);
    return false;
  }
  clearTimeout(timeout);
  await response.body?.cancel().catch(() => undefined);
  return response.status === 204;
}

function parseQueueMessage(value: unknown): Readonly<{
  body: string;
  receiptHandle: string;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EmailCallbackServiceError('QUEUE_MESSAGE_INVALID');
  }
  const message = value as Readonly<Record<string, unknown>>;
  if (
    typeof message.Body !== 'string' ||
    typeof message.ReceiptHandle !== 'string' ||
    message.ReceiptHandle.length < 1 ||
    message.ReceiptHandle.length > 8_192
  ) {
    throw new EmailCallbackServiceError('QUEUE_MESSAGE_INVALID');
  }
  return Object.freeze({
    body: message.Body,
    receiptHandle: message.ReceiptHandle,
  });
}

interface SqsCallbackClient {
  send(command: unknown): Promise<unknown>;
}

export interface EmailCallbackServiceDependencies {
  readonly sqs?: SqsCallbackClient;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: EmailCallbackFetch;
  readonly log?: (event: CallbackLogEvent) => void;
  readonly shouldContinue?: () => boolean;
}

function logToStdout(event: CallbackLogEvent): void {
  console.log(JSON.stringify(event));
}

/** Durably forwards SNS envelopes from SQS to the signature-verifying route. */
export async function runEmailCallbackService(
  dependencies: EmailCallbackServiceDependencies = {},
): Promise<void> {
  const configuration = readEmailCallbackServiceConfiguration(
    dependencies.environment,
  );
  const sqs = dependencies.sqs ?? new SQSClient({} satisfies SQSClientConfig);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const log = dependencies.log ?? logToStdout;
  const shouldContinue = dependencies.shouldContinue ?? (() => true);
  log({ event: 'email-callback-worker-started' });

  while (shouldContinue()) {
    log({ event: 'email-callback-worker-heartbeat' });
    const response = (await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: configuration.queueUrl,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
        WaitTimeSeconds: 20,
      }),
    )) as Readonly<{ Messages?: readonly unknown[] }>;
    const raw = response.Messages?.[0];
    if (raw === undefined) continue;

    let message: ReturnType<typeof parseQueueMessage>;
    try {
      message = parseQueueMessage(raw);
    } catch {
      log({ event: 'email-callback-message-failed', count: 1 });
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
      let forwarded = false;
      try {
        forwarded = await forwardEmailCallback(
          message.body,
          configuration,
          fetcher,
        );
      } catch {
        // A malformed retained envelope is a failure of this message, not the
        // long-running consumer. Leave it for bounded SQS redrive and continue
        // draining later callbacks.
      }
      if (forwarded) {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: configuration.queueUrl,
            ReceiptHandle: message.receiptHandle,
          }),
        );
        log({ event: 'email-callback-message-completed', count: 1 });
      } else {
        log({ event: 'email-callback-message-failed', count: 1 });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

if (import.meta.main) {
  await runEmailCallbackService();
}
