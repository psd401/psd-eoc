import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import { EmailAttemptReferenceMessageSchema } from '@psd-eoc/contracts';

import { failureDetail } from '../shared/failure-detail';
import { isTerminalFailure, retireMessage } from '../shared/terminal-failure';
import { AttemptExecutionClient } from '../shared/attempt-execution-client';
import { DeliveryStateWritebackClient } from '../shared/delivery-state-client';
import { AwsSesV2Client } from './aws-client';
import { sqsQueueUrlForArn } from './aws-arn';
import { EmailQueueRuntime, type EmailRetryPublisher } from './queue-runtime';
import { SesEmailRuntime } from './runtime';
import { EmailRuntimeClient } from './state-client';

const VISIBILITY_HEARTBEAT_MILLISECONDS = 30_000;
const VISIBILITY_TIMEOUT_SECONDS = 120;

type SafeLogEvent = Readonly<{
  event:
    | 'email-worker-heartbeat'
    | 'email-worker-message-completed'
    | 'email-worker-message-failed'
    | 'email-worker-message-retired'
    | 'email-worker-message-incomplete'
    | 'email-worker-message-suppressed'
    | 'email-worker-started';
  count?: number;
  durationMilliseconds?: number;
  /** Bounded, value-free reason. Never a recipient, token, or payload. */
  detail?: string;
}>;

export interface EmailServiceConfiguration {
  readonly queueUrl: string;
  readonly queueArn: string;
  /** Where a message that cannot succeed goes, instead of round-tripping. */
  readonly deadLetterQueueUrl: string;
  readonly serviceOrigin: string;
  readonly fromEmailAddress: string;
  readonly attemptExecutionToken: string;
  readonly deliveryStateToken: string;
  readonly emailRuntimeToken: string;
}

export class EmailServiceError extends Error {
  public constructor(
    public readonly code:
      'FEATURE_DISABLED' | 'INVALID_CONFIGURATION' | 'QUEUE_MESSAGE_INVALID',
  ) {
    super('The email service is unavailable.');
    this.name = 'EmailServiceError';
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
    throw new EmailServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function token(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = required(environment, name);
  if (value.length < 32 || /\s/u.test(value)) {
    throw new EmailServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function exactHttpsOrigin(value: string): string {
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
    throw new EmailServiceError('INVALID_CONFIGURATION');
  }
}

/** All three explicit opt-ins are required before the worker can reach SES. */
export function readEmailServiceConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EmailServiceConfiguration {
  if (
    environment.PSD_EOC_EMAIL_RUNTIME_MODE !== 'enabled' ||
    environment.PSD_EOC_SES_PROVIDER_AUTHORIZED !== 'true' ||
    environment.PSD_EOC_SES_CREDENTIAL_STATUS !== 'verified'
  ) {
    throw new EmailServiceError('FEATURE_DISABLED');
  }
  const queueArn = required(environment, 'EMAIL_QUEUE_ARN', 2_048);
  let queueUrl: string;
  let deadLetterQueueUrl: string;
  try {
    queueUrl = sqsQueueUrlForArn(
      required(environment, 'EMAIL_QUEUE_URL', 2_048),
      queueArn,
    );
    deadLetterQueueUrl = sqsQueueUrlForArn(
      required(environment, 'EMAIL_DEAD_LETTER_QUEUE_URL', 2_048),
      required(environment, 'EMAIL_DEAD_LETTER_QUEUE_ARN', 2_048),
    );
  } catch {
    throw new EmailServiceError('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    queueUrl,
    queueArn,
    deadLetterQueueUrl,
    serviceOrigin: exactHttpsOrigin(
      required(environment, 'PSD_EOC_SERVICE_ORIGIN', 2_048),
    ),
    fromEmailAddress: required(environment, 'PSD_EOC_SES_FROM_ADDRESS', 320),
    attemptExecutionToken: token(
      environment,
      'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
    ),
    deliveryStateToken: token(
      environment,
      'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
    ),
    emailRuntimeToken: token(environment, 'PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN'),
  });
}

interface SqsSendClient {
  send(command: unknown): Promise<unknown>;
}

export class SqsEmailRetryPublisher implements EmailRetryPublisher {
  public constructor(
    private readonly client: SqsSendClient,
    private readonly queueUrl: string,
  ) {}

  public async publishAttemptReference(
    sourceAttemptId: string,
    delaySeconds: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < 0 ||
      delaySeconds > 900
    ) {
      throw new EmailServiceError('INVALID_CONFIGURATION');
    }
    const message = EmailAttemptReferenceMessageSchema.parse({
      kind: 'ses-email-attempt-reference',
      sourceAttemptId,
    });
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        DelaySeconds: delaySeconds,
      }),
    );
  }
}

function buildRuntime(
  configuration: EmailServiceConfiguration,
  sqs: SqsSendClient,
): EmailQueueRuntime {
  const state = new EmailRuntimeClient({
    serviceOrigin: configuration.serviceOrigin,
    bearerToken: configuration.emailRuntimeToken,
  });
  const worker = new SesEmailRuntime({
    queueArn: configuration.queueArn,
    fromEmailAddress: configuration.fromEmailAddress,
    authorizeQueueInvocation: (invocation) =>
      invocation.sourceArn === configuration.queueArn &&
      (invocation.authorization as Readonly<{ kind?: unknown }>).kind ===
        'verified-sqs-source',
    mode: {
      state: 'enabled',
      client: new AwsSesV2Client(),
      sendLedger: state,
      executionStore: new AttemptExecutionClient({
        serviceOrigin: configuration.serviceOrigin,
        bearerToken: configuration.attemptExecutionToken,
      }),
      evidenceWriter: new DeliveryStateWritebackClient({
        serviceOrigin: configuration.serviceOrigin,
        bearerToken: configuration.deliveryStateToken,
      }),
      authorizeProviderSend: (workItem) =>
        state.authorizeProviderSend(workItem),
    },
  });
  return new EmailQueueRuntime({
    worker,
    state,
    queue: new SqsEmailRetryPublisher(sqs, configuration.queueUrl),
    queueArn: configuration.queueArn,
  });
}

function parseMessage(value: unknown): Readonly<{
  body: string;
  receiptHandle: string;
  enqueuedAt: string;
  requestId: string;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EmailServiceError('QUEUE_MESSAGE_INVALID');
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
    typeof message.MessageId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      message.MessageId,
    ) ||
    typeof sentTimestamp !== 'string' ||
    !/^\d{13}$/u.test(sentTimestamp)
  ) {
    throw new EmailServiceError('QUEUE_MESSAGE_INVALID');
  }
  return Object.freeze({
    body: message.Body,
    receiptHandle: message.ReceiptHandle,
    enqueuedAt: new Date(Number(sentTimestamp)).toISOString(),
    requestId: message.MessageId,
  });
}

export interface EmailServiceDependencies {
  readonly sqs?: SqsSendClient;
  readonly runtime?: Pick<EmailQueueRuntime, 'processQueueMessage'>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly log?: (event: SafeLogEvent) => void;
  readonly shouldContinue?: () => boolean;
  readonly now?: () => number;
}

function logToStdout(event: SafeLogEvent): void {
  console.log(JSON.stringify(event));
}

/** Long-polling, non-root Fargate entrypoint with bounded aggregate logs. */
export async function runEmailService(
  dependencies: EmailServiceDependencies = {},
): Promise<void> {
  const configuration = readEmailServiceConfiguration(dependencies.environment);
  const sqs = dependencies.sqs ?? new SQSClient({} satisfies SQSClientConfig);
  const runtime = dependencies.runtime ?? buildRuntime(configuration, sqs);
  const log = dependencies.log ?? logToStdout;
  const shouldContinue = dependencies.shouldContinue ?? (() => true);
  const now = dependencies.now ?? Date.now;
  log({ event: 'email-worker-started' });

  while (shouldContinue()) {
    log({ event: 'email-worker-heartbeat' });
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
      // Not retired here. The envelope failed validation, so its receipt
      // handle is unvalidated input and reaching into it to delete a message
      // is not something this worker does on a value it just refused. The
      // redrive policy still retires it, and this has never happened in
      // production.
      log({
        event: 'email-worker-message-failed',
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
        message.requestId,
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
        if (result.acceptedCount > 0) {
          log({
            event: 'email-worker-message-completed',
            count: result.acceptedCount,
            durationMilliseconds: Math.max(
              0,
              now() - Date.parse(result.outboxCreatedAt),
            ),
          });
        }
        if (result.incompleteCount > 0) {
          log({
            event: 'email-worker-message-incomplete',
            count: result.incompleteCount,
          });
        }
        if (result.suppressedCount > 0) {
          log({
            event: 'email-worker-message-suppressed',
            count: result.suppressedCount,
          });
        }
      }
    } catch (error) {
      const detail = failureDetail(error);
      if (isTerminalFailure(error)) {
        // Retrying cannot change this answer, so retire it now rather than
        // let it oscillate on and off the queue for five receives. See
        // `workers/shared/terminal-failure.ts`.
        try {
          await retireMessage({
            client: sqs,
            queueUrl: configuration.queueUrl,
            deadLetterQueueUrl: configuration.deadLetterQueueUrl,
            receiptHandle: message.receiptHandle,
            body: message.body,
          });
          log({ event: 'email-worker-message-retired', count: 1, detail });
        } catch (retireError) {
          // The redrive policy is still behind this. Falling back to it costs
          // the oscillation this change removes, never the message.
          log({
            event: 'email-worker-message-failed',
            count: 1,
            detail: failureDetail(retireError),
          });
        }
      } else {
        // Leave the message for the queue's bounded redrive policy and alarm.
        log({ event: 'email-worker-message-failed', count: 1, detail });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

if (import.meta.main) {
  await runEmailService();
}
