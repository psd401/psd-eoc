import { randomUUID } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import {
  DispatchBatchSchema,
  SMS_TOTAL_LIFETIME_SECONDS,
  SmsAttemptReferenceMessageSchema,
  SmsOptOutReconciliationMessageSchema,
  type SmsWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';

import { AttemptExecutionClient } from '../shared/attempt-execution-client';
import { workerAttemptFingerprint } from '../shared/attempt';
import { DeliveryStateWritebackClient } from '../shared/delivery-state-client';
import type { WorkerAttemptProcessResult } from '../shared/processor';
import { isTerminalFailure, retireMessage } from '../shared/terminal-failure';
import { AwsEumSmsRuntime } from './runtime';
import { AwsEumSmsDeliveryEventError } from './delivery-events';
import { SmsRuntimeClient } from './state-client';

const VISIBILITY_HEARTBEAT_MILLISECONDS = 30_000;
/**
 * How many times a receipt that names no retained send is read before it is
 * given up as foreign. The send's provider reference is written after AWS
 * has already returned the MessageId, over two further server round trips,
 * and a worker replaced between them rewrites it only after its work message
 * becomes visible again; a receipt for that send can arrive first. Two more
 * receives, each after the visibility timeout, cover that window.
 */
const UNMATCHED_RECEIPT_RECEIVES = 3;
const VISIBILITY_TIMEOUT_SECONDS = 120;
const MAX_RECONCILIATION_SEGMENTS = 10;
/**
 * How often the worker says it is alive.
 *
 * `psd-eoc-sms-worker-health` sums these over a fifteen-minute period and
 * alarms on two empty periods, treating missing data as breaching. At the
 * previous fifteen-minute cadence a period held exactly one heartbeat, so one
 * slow poll emptied it; five minutes puts three in every window. Keep this
 * comfortably under the alarm's period or the alarm goes off on its own.
 */
const HEARTBEAT_LOG_INTERVAL_MILLISECONDS = 5 * 60 * 1_000;

type SafeLogEvent = Readonly<{
  event:
    | 'sms-worker-started'
    | 'sms-worker-heartbeat'
    | 'sms-worker-message-completed'
    | 'sms-worker-message-deferred'
    | 'sms-worker-message-failed'
    | 'sms-worker-message-retired'
    | 'sms-worker-delivery-event-recorded'
    | 'sms-worker-delivery-event-ignored'
    | 'sms-worker-opt-outs-reconciled';
  count?: number;
  durationMilliseconds?: number;
  stage?: 'receive' | 'process';
  code?: string;
  receiveCount?: number;
}>;

export interface SmsServiceConfiguration {
  readonly accountId: string;
  readonly region: string;
  readonly queueUrl: string;
  readonly queueArn: string;
  readonly receiptQueueUrl: string;
  readonly receiptQueueArn: string;
  /** Where a work message that cannot succeed goes, per queue. */
  readonly deadLetterQueueUrl: string;
  readonly receiptDeadLetterQueueUrl: string;
  readonly serviceOrigin: string;
  readonly attemptExecutionToken: string;
  readonly deliveryStateToken: string;
  readonly smsRuntimeToken: string;
  readonly originationIdentity: string;
  readonly configurationSetName: string;
  readonly protectConfigurationId: string;
  readonly optOutListName: string;
  readonly optOutListArn: string;
  readonly deliveryEventRuleArn: string;
  readonly optOutScheduleRuleArn: string;
  readonly maxPrice: string;
  readonly timeToLiveSeconds: number;
}

export type SmsServiceErrorCode =
  'FEATURE_DISABLED' | 'INVALID_CONFIGURATION' | 'QUEUE_MESSAGE_INVALID';

export class SmsServiceError extends Error {
  public constructor(public readonly code: SmsServiceErrorCode) {
    super('The SMS service is unavailable.');
    this.name = 'SmsServiceError';
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
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function matching(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  pattern: RegExp,
  maximum = 4_096,
): string {
  const value = required(environment, name, maximum);
  if (!pattern.test(value)) {
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

function token(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = required(environment, name);
  if (value.length < 32 || /\s/u.test(value)) {
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
  return value;
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
    throw new SmsServiceError('INVALID_CONFIGURATION');
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
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
}

function boundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(environment, name, 16);
  if (!/^\d+$/u.test(raw)) {
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
  return value;
}

/** Every gate is an exact opt-in; omission always keeps the worker dark. */
export function readSmsServiceConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SmsServiceConfiguration {
  if (
    environment.PSD_EOC_SMS_RUNTIME_MODE !== 'enabled' ||
    environment.PSD_EOC_SMS_PROVIDER_AUTHORIZED !== 'true' ||
    environment.PSD_EOC_SMS_CONFIGURATION_STATUS !== 'verified'
  ) {
    throw new SmsServiceError('FEATURE_DISABLED');
  }
  const accountId = matching(environment, 'AWS_ACCOUNT_ID', /^\d{12}$/u, 12);
  const region = matching(
    environment,
    'AWS_REGION',
    /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u,
    32,
  );
  const partition = region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
  const queueArn = matching(
    environment,
    'SMS_QUEUE_ARN',
    new RegExp(
      `^arn:${partition}:sqs:${region}:${accountId}:[A-Za-z0-9_-]{1,80}$`,
      'u',
    ),
    256,
  );
  const receiptQueueArn = matching(
    environment,
    'SMS_RECEIPT_QUEUE_ARN',
    new RegExp(
      `^arn:${partition}:sqs:${region}:${accountId}:[A-Za-z0-9_-]{1,80}$`,
      'u',
    ),
    256,
  );
  if (receiptQueueArn === queueArn) {
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
  const rulePattern = new RegExp(
    `^arn:${partition}:events:${region}:${accountId}:rule/[A-Za-z0-9._/-]{1,256}$`,
    'u',
  );
  const optOutListName = matching(
    environment,
    'PSD_EOC_SMS_OPT_OUT_LIST_NAME',
    /^[A-Za-z0-9_-]{1,64}$/u,
    64,
  );
  const optOutListArn = matching(
    environment,
    'PSD_EOC_SMS_OPT_OUT_LIST_ARN',
    new RegExp(
      `^arn:${partition}:sms-voice:${region}:${accountId}:opt-out-list/${optOutListName}$`,
      'u',
    ),
    256,
  );
  const timeToLiveSeconds = boundedInteger(
    environment,
    'PSD_EOC_SMS_TTL_SECONDS',
    5,
    900,
  );
  if (timeToLiveSeconds !== SMS_TOTAL_LIFETIME_SECONDS) {
    throw new SmsServiceError('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    accountId,
    region,
    queueUrl: queueUrl(required(environment, 'SMS_QUEUE_URL', 2_048)),
    deadLetterQueueUrl: queueUrl(
      required(environment, 'SMS_DEAD_LETTER_QUEUE_URL', 2_048),
    ),
    receiptDeadLetterQueueUrl: queueUrl(
      required(environment, 'SMS_RECEIPT_DEAD_LETTER_QUEUE_URL', 2_048),
    ),
    queueArn,
    receiptQueueUrl: queueUrl(
      required(environment, 'SMS_RECEIPT_QUEUE_URL', 2_048),
    ),
    receiptQueueArn,
    serviceOrigin: origin(
      required(environment, 'PSD_EOC_SERVICE_ORIGIN', 2_048),
    ),
    attemptExecutionToken: token(
      environment,
      'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
    ),
    deliveryStateToken: token(
      environment,
      'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
    ),
    smsRuntimeToken: token(environment, 'PSD_EOC_SMS_RUNTIME_WORKER_TOKEN'),
    originationIdentity: matching(
      environment,
      'PSD_EOC_SMS_ORIGINATION_IDENTITY',
      /^[A-Za-z0-9_:/+-]{1,256}$/u,
      256,
    ),
    configurationSetName: matching(
      environment,
      'PSD_EOC_SMS_CONFIGURATION_SET_NAME',
      /^[A-Za-z0-9_/-]{1,64}$/u,
      64,
    ),
    protectConfigurationId: matching(
      environment,
      'PSD_EOC_SMS_PROTECT_CONFIGURATION_ID',
      /^[A-Za-z0-9_:/-]{1,256}$/u,
      256,
    ),
    optOutListName,
    optOutListArn,
    deliveryEventRuleArn: matching(
      environment,
      'PSD_EOC_SMS_DELIVERY_EVENT_RULE_ARN',
      rulePattern,
      512,
    ),
    optOutScheduleRuleArn: matching(
      environment,
      'PSD_EOC_SMS_OPT_OUT_SCHEDULE_RULE_ARN',
      rulePattern,
      512,
    ),
    maxPrice: matching(
      environment,
      'PSD_EOC_SMS_MAX_PRICE',
      /^[0-9]{1,2}\.[0-9]{1,5}$/u,
      8,
    ),
    timeToLiveSeconds,
  });
}

interface SqsSendClient {
  send(command: unknown): Promise<unknown>;
}

export interface SmsServiceDependencies {
  readonly sqs?: SqsSendClient;
  readonly runtime?: Pick<
    AwsEumSmsRuntime,
    'processDeliveryEvent' | 'processQueueAttempt' | 'reconcileOptOuts'
  >;
  readonly state?: SmsRuntimeClient;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly log?: (event: SafeLogEvent) => void;
  readonly shouldContinue?: () => boolean;
  readonly now?: () => number;
}

function logToStdout(event: SafeLogEvent): void {
  console.log(JSON.stringify(event));
}

function buildRuntime(
  configuration: SmsServiceConfiguration,
  state: SmsRuntimeClient,
): AwsEumSmsRuntime {
  const writer = new DeliveryStateWritebackClient({
    serviceOrigin: configuration.serviceOrigin,
    bearerToken: configuration.deliveryStateToken,
  });
  return new AwsEumSmsRuntime({
    mode: {
      state: 'enabled',
      authorizeProviderSend: (workItem) =>
        state.authorizeProviderSend(workItem),
    },
    awsClient: { region: configuration.region },
    adapter: {
      ledger: state,
      originationIdentity: configuration.originationIdentity,
      configurationSetName: configuration.configurationSetName,
      protectConfigurationId: configuration.protectConfigurationId,
      maxPrice: configuration.maxPrice,
      timeToLiveSeconds: configuration.timeToLiveSeconds,
    },
    executionStore: new AttemptExecutionClient({
      serviceOrigin: configuration.serviceOrigin,
      bearerToken: configuration.attemptExecutionToken,
    }),
    evidenceWriter: writer,
    attempts: state,
    capabilities: state,
    destinationResolver: state,
    optOutList: {
      name: configuration.optOutListName,
      arn: configuration.optOutListArn,
    },
    queueArn: configuration.queueArn,
    scheduleRuleArn: configuration.optOutScheduleRuleArn,
    authorizeQueueInvocation: (invocation) =>
      invocation.authorization === 'ecs-sqs-receive',
    authorizeScheduledInvocation: (invocation) =>
      invocation.authorization === 'eventbridge-sqs-schedule',
    authorizeOptInInvocation: () => false,
    deliveryConfiguration: {
      accountId: configuration.accountId,
      region: configuration.region,
      eventBridgeRuleArn: configuration.deliveryEventRuleArn,
    },
    authorizeEventBridgeInvocation: (invocation) =>
      invocation.authorization === 'eventbridge-sqs-receipt-queue',
  });
}

function parseMessage(value: unknown): Readonly<{
  body: string;
  receiptHandle: string;
  enqueuedAt: string;
  receiveCount: number;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmsServiceError('QUEUE_MESSAGE_INVALID');
  }
  const message = value as Readonly<Record<string, unknown>>;
  const attributes = message.Attributes;
  const sentTimestamp =
    attributes !== null &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes)
      ? (attributes as Readonly<Record<string, unknown>>).SentTimestamp
      : undefined;
  const receiveCountValue =
    attributes !== null &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes)
      ? (attributes as Readonly<Record<string, unknown>>)
          .ApproximateReceiveCount
      : undefined;
  if (
    typeof message.Body !== 'string' ||
    typeof message.ReceiptHandle !== 'string' ||
    message.ReceiptHandle.length < 1 ||
    message.ReceiptHandle.length > 8_192 ||
    typeof sentTimestamp !== 'string' ||
    !/^\d{13}$/u.test(sentTimestamp) ||
    typeof receiveCountValue !== 'string' ||
    !/^[1-9]\d{0,5}$/u.test(receiveCountValue)
  ) {
    throw new SmsServiceError('QUEUE_MESSAGE_INVALID');
  }
  return Object.freeze({
    body: message.Body,
    receiptHandle: message.ReceiptHandle,
    enqueuedAt: new Date(Number(sentTimestamp)).toISOString(),
    receiveCount: Number(receiveCountValue),
  });
}

function safeFailureCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as Readonly<{ code?: unknown }>).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,100}$/u.test(code)) {
      return code;
    }
  }
  return 'UNEXPECTED';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

async function scheduleRetry(
  result: Extract<WorkerAttemptProcessResult, { kind: 'retry' }>,
  workItem: SmsWorkerAttemptWorkItem,
  state: SmsRuntimeClient,
  sqs: SqsSendClient,
  configuration: SmsServiceConfiguration,
  now: () => number,
): Promise<void> {
  const scheduled = await state.scheduleRetry({
    sourceAttempt: workItem.attempt,
    sourceFingerprint: workerAttemptFingerprint(workItem),
    nextAttemptNumber: result.nextAttemptNumber,
    delayMilliseconds: result.delayMilliseconds,
    reasonCode: result.reasonCode,
  });
  if (scheduled.kind === 'expired') return;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: configuration.queueUrl,
      MessageBody: JSON.stringify(
        SmsAttemptReferenceMessageSchema.parse({
          kind: 'sms-attempt-reference',
          attemptId: scheduled.attemptId,
        }),
      ),
      DelaySeconds: Math.min(
        900,
        Math.max(0, Math.ceil((Date.parse(scheduled.retryAt) - now()) / 1_000)),
      ),
    }),
  );
}

async function processWorkItem(
  workItem: SmsWorkerAttemptWorkItem,
  runtime: Pick<AwsEumSmsRuntime, 'processQueueAttempt'>,
  state: SmsRuntimeClient,
  sqs: SqsSendClient,
  configuration: SmsServiceConfiguration,
  now: () => number,
): Promise<'complete' | 'defer'> {
  const result = await runtime.processQueueAttempt(workItem, {
    requestId: randomUUID(),
    sourceArn: configuration.queueArn,
    authorization: 'ecs-sqs-receive',
  });
  if (result.attemptResult.kind === 'retry') {
    await scheduleRetry(
      result.attemptResult,
      workItem,
      state,
      sqs,
      configuration,
      now,
    );
    return 'complete';
  }
  return result.attemptResult.kind === 'in-progress' ? 'defer' : 'complete';
}

async function processBody(
  body: string,
  enqueuedAt: string,
  receiveCount: number,
  queueKind: 'work' | 'receipt',
  runtime: Pick<
    AwsEumSmsRuntime,
    'processDeliveryEvent' | 'processQueueAttempt' | 'reconcileOptOuts'
  >,
  state: SmsRuntimeClient,
  sqs: SqsSendClient,
  configuration: SmsServiceConfiguration,
  now: () => number,
): Promise<
  Readonly<{
    kind: 'complete' | 'defer';
    count: number;
    event: 'attempts' | 'delivery-event' | 'opt-outs';
    code?: string;
  }>
> {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new SmsServiceError('QUEUE_MESSAGE_INVALID');
  }

  if (queueKind === 'receipt') {
    const event = asRecord(value);
    if (
      event?.source !== 'aws.sms-voice' ||
      event['detail-type'] !== 'Text Message Delivery Status Updated'
    ) {
      throw new SmsServiceError('QUEUE_MESSAGE_INVALID');
    }
    try {
      const result = await runtime.processDeliveryEvent(value, {
        requestId: randomUUID(),
        ruleArn: configuration.deliveryEventRuleArn,
        authorization: 'eventbridge-sqs-receipt-queue',
      });
      if (result.kind !== 'unmatched') {
        return Object.freeze({
          kind: 'complete',
          count: 1,
          event: 'delivery-event',
        });
      }
      // A receipt that names no send this system retained is either foreign
      // (an account verification text, say) or early: its send's provider
      // reference is not written yet. It is retried a bounded number of
      // times for the second case, then logged as ignored and deleted for
      // the first, never toward the dead-letter queue.
      return Object.freeze({
        kind: receiveCount < UNMATCHED_RECEIPT_RECEIVES ? 'defer' : 'complete',
        count: 0,
        event: 'delivery-event',
        code: 'UNMATCHED_RECEIPT',
      });
    } catch (error) {
      if (
        error instanceof AwsEumSmsDeliveryEventError &&
        error.code === 'ATTEMPT_NOT_FOUND'
      ) {
        return Object.freeze({
          kind: 'complete',
          count: 0,
          event: 'delivery-event',
          code: error.code,
        });
      }
      throw error;
    }
  }

  const retry = SmsAttemptReferenceMessageSchema.safeParse(value);
  if (retry.success) {
    const resolution = await state.resolveRetry(retry.data.attemptId);
    if (resolution.kind !== 'ready') {
      return Object.freeze({
        kind: resolution.kind === 'not-before' ? 'defer' : 'complete',
        count: 0,
        event: 'attempts',
      });
    }
    const outcome = await processWorkItem(
      resolution.workItem,
      runtime,
      state,
      sqs,
      configuration,
      now,
    );
    return Object.freeze({ kind: outcome, count: 1, event: 'attempts' });
  }

  const reconciliation = SmsOptOutReconciliationMessageSchema.safeParse(value);
  if (reconciliation.success) {
    let count = 0;
    for (const snapshot of await state.listCurrentRosterSnapshots()) {
      let continuationToken: string | null = null;
      for (let segment = 0; segment < MAX_RECONCILIATION_SEGMENTS; segment++) {
        const report = await runtime.reconcileOptOuts(
          { rosterSnapshotId: snapshot.id, continuationToken },
          {
            requestId: randomUUID(),
            ruleArn: configuration.optOutScheduleRuleArn,
            authorization: 'eventbridge-sqs-schedule',
          },
        );
        count += report.recordedCount;
        continuationToken = report.continuationToken;
        if (continuationToken === null) break;
        if (segment === MAX_RECONCILIATION_SEGMENTS - 1) {
          throw new SmsServiceError('QUEUE_MESSAGE_INVALID');
        }
      }
    }
    return Object.freeze({ kind: 'complete', count, event: 'opt-outs' });
  }

  const batch = DispatchBatchSchema.safeParse(value);
  if (batch.success && batch.data.channel === 'sms') {
    let cursor = 0;
    let count = 0;
    let defer = false;
    for (;;) {
      const page = await state.resolveBatch({
        batch: batch.data,
        enqueuedAt,
        cursor,
      });
      if (page.kind === 'expired') {
        return Object.freeze({
          kind: 'complete',
          count,
          event: 'attempts',
        });
      }
      for (const workItem of page.items) {
        const outcome = await processWorkItem(
          workItem,
          runtime,
          state,
          sqs,
          configuration,
          now,
        );
        count += 1;
        defer ||= outcome === 'defer';
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return Object.freeze({
      kind: defer ? 'defer' : 'complete',
      count,
      event: 'attempts',
    });
  }

  throw new SmsServiceError('QUEUE_MESSAGE_INVALID');
}

/** Long-polling Fargate entry point. Logs contain aggregate facts only. */
export async function runSmsService(
  dependencies: SmsServiceDependencies = {},
): Promise<void> {
  const configuration = readSmsServiceConfiguration(dependencies.environment);
  const sqs = dependencies.sqs ?? new SQSClient({} satisfies SQSClientConfig);
  const state =
    dependencies.state ??
    new SmsRuntimeClient({
      serviceOrigin: configuration.serviceOrigin,
      bearerToken: configuration.smsRuntimeToken,
    });
  const runtime = dependencies.runtime ?? buildRuntime(configuration, state);
  const log = dependencies.log ?? logToStdout;
  const shouldContinue = dependencies.shouldContinue ?? (() => true);
  const now = dependencies.now ?? Date.now;
  log({ event: 'sms-worker-started' });
  let pollCount = 0;
  let lastHeartbeatAt = Number.NEGATIVE_INFINITY;

  while (shouldContinue()) {
    if (now() - lastHeartbeatAt >= HEARTBEAT_LOG_INTERVAL_MILLISECONDS) {
      log({ event: 'sms-worker-heartbeat' });
      lastHeartbeatAt = now();
    }
    const queueKind = pollCount++ % 2 === 0 ? 'work' : 'receipt';
    const currentQueueUrl =
      queueKind === 'work'
        ? configuration.queueUrl
        : configuration.receiptQueueUrl;
    const response = (await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: currentQueueUrl,
        MessageSystemAttributeNames: [
          'SentTimestamp',
          'ApproximateReceiveCount',
        ],
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
        event: 'sms-worker-message-failed',
        count: 1,
        stage: 'receive',
        code: safeFailureCode(error),
      });
      continue;
    }
    const heartbeat = setInterval(() => {
      void sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: currentQueueUrl,
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
          }),
        )
        .catch(() => undefined);
    }, VISIBILITY_HEARTBEAT_MILLISECONDS);
    try {
      const result = await processBody(
        message.body,
        message.enqueuedAt,
        message.receiveCount,
        queueKind,
        runtime,
        state,
        sqs,
        configuration,
        now,
      );
      if (result.kind === 'complete') {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: currentQueueUrl,
            ReceiptHandle: message.receiptHandle,
          }),
        );
      } else {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: currentQueueUrl,
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
          }),
        );
      }
      if (result.event === 'delivery-event' && result.kind === 'defer') {
        log({
          event: 'sms-worker-message-deferred',
          count: result.count,
          ...(result.code === undefined ? {} : { code: result.code }),
          receiveCount: message.receiveCount,
        });
      } else if (result.event === 'delivery-event') {
        log({
          event:
            result.count === 0
              ? 'sms-worker-delivery-event-ignored'
              : 'sms-worker-delivery-event-recorded',
          count: result.count,
          ...(result.code === undefined ? {} : { code: result.code }),
        });
      } else if (result.event === 'opt-outs') {
        log({ event: 'sms-worker-opt-outs-reconciled', count: result.count });
      } else if (result.kind === 'complete') {
        log({
          event: 'sms-worker-message-completed',
          count: result.count,
          durationMilliseconds: Math.max(
            0,
            now() - Date.parse(message.enqueuedAt),
          ),
        });
      } else {
        log({ event: 'sms-worker-message-deferred', count: result.count });
      }
    } catch (error) {
      const code = safeFailureCode(error);
      if (isTerminalFailure(error)) {
        // Retrying cannot change this answer, so retire it now rather than
        // let it oscillate on and off the queue for five receives. See
        // `workers/shared/terminal-failure.ts`.
        try {
          await retireMessage({
            client: sqs,
            queueUrl: currentQueueUrl,
            deadLetterQueueUrl:
              queueKind === 'work'
                ? configuration.deadLetterQueueUrl
                : configuration.receiptDeadLetterQueueUrl,
            receiptHandle: message.receiptHandle,
            body: message.body,
          });
          log({
            event: 'sms-worker-message-retired',
            count: 1,
            stage: 'process',
            code,
            receiveCount: message.receiveCount,
          });
        } catch (retireError) {
          // The redrive policy is still behind this.
          log({
            event: 'sms-worker-message-failed',
            count: 1,
            stage: 'process',
            code: safeFailureCode(retireError),
            receiveCount: message.receiveCount,
          });
        }
      } else {
        log({
          event: 'sms-worker-message-failed',
          count: 1,
          stage: 'process',
          code,
          receiveCount: message.receiveCount,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

if (import.meta.main) {
  await runSmsService();
}
