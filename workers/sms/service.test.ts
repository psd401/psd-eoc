import { describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';

import {
  readSmsServiceConfiguration,
  runSmsService,
  type SmsServiceDependencies,
} from './service';
import type { SmsRuntimeClient } from './state-client';
import { AwsEumSmsDeliveryEventError } from './delivery-events';

const TOKEN = 'synthetic-worker-token-'.padEnd(48, 'x');
const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const ENABLED_ENVIRONMENT = Object.freeze({
  AWS_ACCOUNT_ID: '000000000000',
  AWS_REGION: 'us-east-1',
  PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: TOKEN,
  PSD_EOC_DELIVERY_STATE_WORKER_TOKEN: TOKEN,
  PSD_EOC_SERVICE_ORIGIN: 'https://eoc.example.invalid',
  PSD_EOC_SMS_CONFIGURATION_SET_NAME: 'synthetic-sms',
  PSD_EOC_SMS_CONFIGURATION_STATUS: 'verified',
  PSD_EOC_SMS_DELIVERY_EVENT_RULE_ARN:
    'arn:aws:events:us-east-1:000000000000:rule/sms-delivery',
  PSD_EOC_SMS_MAX_PRICE: '0.05',
  PSD_EOC_SMS_OPT_OUT_LIST_ARN:
    'arn:aws:sms-voice:us-east-1:000000000000:opt-out-list/synthetic-sms',
  PSD_EOC_SMS_OPT_OUT_LIST_NAME: 'synthetic-sms',
  PSD_EOC_SMS_OPT_OUT_SCHEDULE_RULE_ARN:
    'arn:aws:events:us-east-1:000000000000:rule/sms-opt-outs',
  PSD_EOC_SMS_ORIGINATION_IDENTITY:
    'arn:aws:sms-voice:us-east-1:000000000000:pool/synthetic',
  PSD_EOC_SMS_PROTECT_CONFIGURATION_ID: 'protect-synthetic',
  PSD_EOC_SMS_PROVIDER_AUTHORIZED: 'true',
  PSD_EOC_SMS_RUNTIME_MODE: 'enabled',
  PSD_EOC_SMS_RUNTIME_WORKER_TOKEN: TOKEN,
  PSD_EOC_SMS_TTL_SECONDS: '300',
  SMS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:000000000000:psd-eoc-sms',
  SMS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/psd-eoc-sms',
  SMS_DEAD_LETTER_QUEUE_URL:
    'https://sqs.us-east-1.amazonaws.com/000000000000/psd-eoc-sms-dlq',
  SMS_RECEIPT_DEAD_LETTER_QUEUE_URL:
    'https://sqs.us-east-1.amazonaws.com/000000000000/psd-eoc-sms-receipts-dlq',
  SMS_RECEIPT_QUEUE_ARN:
    'arn:aws:sqs:us-east-1:000000000000:psd-eoc-sms-receipts',
  SMS_RECEIPT_QUEUE_URL:
    'https://sqs.us-east-1.amazonaws.com/000000000000/psd-eoc-sms-receipts',
});

describe('SMS service configuration', () => {
  test('requires every exact carrier, provider, and runtime opt-in', () => {
    for (const environment of [
      {},
      { ...ENABLED_ENVIRONMENT, PSD_EOC_SMS_RUNTIME_MODE: 'dark' },
      { ...ENABLED_ENVIRONMENT, PSD_EOC_SMS_PROVIDER_AUTHORIZED: 'TRUE' },
      {
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_SMS_CONFIGURATION_STATUS: 'UNCONFIGURED',
      },
    ]) {
      expect(() => readSmsServiceConfiguration(environment)).toThrow(
        expect.objectContaining({ code: 'FEATURE_DISABLED' }),
      );
    }
    expect(readSmsServiceConfiguration(ENABLED_ENVIRONMENT)).toMatchObject({
      accountId: '000000000000',
      region: 'us-east-1',
      optOutListName: 'synthetic-sms',
      timeToLiveSeconds: 300,
    });
  });

  test('refuses unsafe origins, mismatched ARNs, prices, and credentials', () => {
    for (const environment of [
      { ...ENABLED_ENVIRONMENT, PSD_EOC_SERVICE_ORIGIN: 'http://localhost' },
      {
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_SMS_OPT_OUT_LIST_ARN:
          'arn:aws:sms-voice:us-east-1:000000000000:opt-out-list/other',
      },
      { ...ENABLED_ENVIRONMENT, PSD_EOC_SMS_MAX_PRICE: 'unbounded' },
      { ...ENABLED_ENVIRONMENT, PSD_EOC_SMS_RUNTIME_WORKER_TOKEN: 'short' },
      { ...ENABLED_ENVIRONMENT, PSD_EOC_SMS_TTL_SECONDS: '301' },
      {
        ...ENABLED_ENVIRONMENT,
        SMS_RECEIPT_QUEUE_ARN: ENABLED_ENVIRONMENT.SMS_QUEUE_ARN,
      },
    ]) {
      expect(() => readSmsServiceConfiguration(environment)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
  });
});

describe('SMS long-poll service', () => {
  test('does not trust a delivery-event body received from the work queue', async () => {
    const commands: unknown[] = [];
    let invocations = 0;
    let loopChecks = 0;
    await runSmsService({
      environment: ENABLED_ENVIRONMENT,
      now: () => NOW,
      shouldContinue: () => loopChecks++ === 0,
      log: () => undefined,
      runtime: {
        processDeliveryEvent() {
          invocations += 1;
          return Promise.resolve(undefined as never);
        },
        processQueueAttempt: () => Promise.reject(new Error('unused')),
        reconcileOptOuts: () => Promise.reject(new Error('unused')),
      },
      state: {} as SmsRuntimeClient,
      sqs: {
        send(command) {
          commands.push(command);
          return command instanceof ReceiveMessageCommand
            ? Promise.resolve({
                Messages: [
                  {
                    Body: JSON.stringify({
                      source: 'aws.sms-voice',
                      'detail-type': 'Text Message Delivery Status Updated',
                    }),
                    ReceiptHandle: 'synthetic-receipt-handle',
                    Attributes: {
                      SentTimestamp: String(NOW),
                      ApproximateReceiveCount: '1',
                    },
                  },
                ],
              })
            : Promise.resolve({});
        },
      },
    });

    expect(invocations).toBe(0);
    expect(
      commands.some((command) => command instanceof DeleteMessageCommand),
    ).toBe(false);
  });

  test('records a provider delivery event, deletes it, and logs aggregate facts only', async () => {
    const commands: unknown[] = [];
    const logs: unknown[] = [];
    const invocations: unknown[] = [];
    let loopChecks = 0;
    const event = {
      source: 'aws.sms-voice',
      'detail-type': 'Text Message Delivery Status Updated',
      detail: { destinationPhoneNumber: '+12025550123' },
    };
    await runSmsService({
      environment: ENABLED_ENVIRONMENT,
      now: () => NOW,
      shouldContinue: () => loopChecks++ < 2,
      log: (value) => logs.push(value),
      runtime: {
        processDeliveryEvent(value, context) {
          invocations.push({ value, context });
          return Promise.resolve(undefined as never);
        },
        processQueueAttempt: () => Promise.reject(new Error('unused')),
        reconcileOptOuts: () => Promise.reject(new Error('unused')),
      },
      state: {} as SmsRuntimeClient,
      sqs: {
        send(command) {
          commands.push(command);
          return command instanceof ReceiveMessageCommand &&
            command.input.QueueUrl === ENABLED_ENVIRONMENT.SMS_RECEIPT_QUEUE_URL
            ? Promise.resolve({
                Messages: [
                  {
                    Body: JSON.stringify(event),
                    ReceiptHandle: 'synthetic-receipt-handle',
                    Attributes: {
                      SentTimestamp: String(NOW - 1_000),
                      ApproximateReceiveCount: '1',
                    },
                  },
                ],
              })
            : Promise.resolve({});
        },
      },
    });

    expect(invocations).toHaveLength(1);
    expect(
      commands.some((command) => command instanceof DeleteMessageCommand),
    ).toBe(true);
    expect(logs).toContainEqual({
      event: 'sms-worker-delivery-event-recorded',
      count: 1,
    });
    expect(JSON.stringify(logs)).not.toContain('+12025550123');
    expect(JSON.stringify(logs)).not.toContain('synthetic-receipt-handle');
  });

  test('acknowledges an authenticated account event that has no local attempt', async () => {
    const logs: unknown[] = [];
    let loopChecks = 0;
    await runSmsService({
      environment: ENABLED_ENVIRONMENT,
      now: () => NOW,
      shouldContinue: () => loopChecks++ < 2,
      log: (value) => logs.push(value),
      runtime: {
        processDeliveryEvent: () =>
          Promise.reject(new AwsEumSmsDeliveryEventError('ATTEMPT_NOT_FOUND')),
        processQueueAttempt: () => Promise.reject(new Error('unused')),
        reconcileOptOuts: () => Promise.reject(new Error('unused')),
      },
      state: {} as SmsRuntimeClient,
      sqs: {
        send(command) {
          return command instanceof ReceiveMessageCommand &&
            command.input.QueueUrl === ENABLED_ENVIRONMENT.SMS_RECEIPT_QUEUE_URL
            ? Promise.resolve({
                Messages: [
                  {
                    Body: JSON.stringify({
                      source: 'aws.sms-voice',
                      'detail-type': 'Text Message Delivery Status Updated',
                    }),
                    ReceiptHandle: 'synthetic-receipt-handle',
                    Attributes: {
                      SentTimestamp: String(NOW),
                      ApproximateReceiveCount: '1',
                    },
                  },
                ],
              })
            : Promise.resolve({});
        },
      },
    });
    expect(logs).toContainEqual({
      event: 'sms-worker-delivery-event-ignored',
      count: 0,
    });
  });

  test('retains a correlated receipt until ambiguous attempt evidence catches up', async () => {
    const commands: unknown[] = [];
    let loopChecks = 0;
    await runSmsService({
      environment: ENABLED_ENVIRONMENT,
      now: () => NOW,
      shouldContinue: () => loopChecks++ < 2,
      log: () => undefined,
      runtime: {
        processDeliveryEvent: () =>
          Promise.reject(new AwsEumSmsDeliveryEventError('ATTEMPT_NOT_READY')),
        processQueueAttempt: () => Promise.reject(new Error('unused')),
        reconcileOptOuts: () => Promise.reject(new Error('unused')),
      },
      state: {} as SmsRuntimeClient,
      sqs: {
        send(command) {
          commands.push(command);
          return command instanceof ReceiveMessageCommand &&
            command.input.QueueUrl === ENABLED_ENVIRONMENT.SMS_RECEIPT_QUEUE_URL
            ? Promise.resolve({
                Messages: [
                  {
                    Body: JSON.stringify({
                      source: 'aws.sms-voice',
                      'detail-type': 'Text Message Delivery Status Updated',
                    }),
                    ReceiptHandle: 'synthetic-receipt-handle',
                    Attributes: {
                      SentTimestamp: String(NOW),
                      ApproximateReceiveCount: '1',
                    },
                  },
                ],
              })
            : Promise.resolve({});
        },
      },
    });
    expect(
      commands.some((command) => command instanceof DeleteMessageCommand),
    ).toBe(false);
  });

  test('acknowledges a terminal DLQ attempt without visibility deferral', async () => {
    const commands: unknown[] = [];
    const logs: unknown[] = [];
    let loopChecks = 0;
    await runSmsService({
      environment: ENABLED_ENVIRONMENT,
      now: () => NOW,
      shouldContinue: () => loopChecks++ === 0,
      log: (value) => logs.push(value),
      runtime: {
        processDeliveryEvent: () => Promise.reject(new Error('unused')),
        processQueueAttempt: () =>
          Promise.resolve({
            attemptResult: { kind: 'dlq' },
            optOutRecord: null,
          } as never),
        reconcileOptOuts: () => Promise.reject(new Error('unused')),
      },
      state: {
        resolveRetry: () =>
          Promise.resolve({ kind: 'ready', workItem: {} } as never),
      } as unknown as SmsRuntimeClient,
      sqs: {
        send(command) {
          commands.push(command);
          return command instanceof ReceiveMessageCommand
            ? Promise.resolve({
                Messages: [
                  {
                    Body: JSON.stringify({
                      kind: 'sms-attempt-reference',
                      attemptId: '00000000-0000-4000-8000-000000000279',
                    }),
                    ReceiptHandle: 'synthetic-dlq-receipt-handle',
                    Attributes: {
                      SentTimestamp: String(NOW - 1_000),
                      ApproximateReceiveCount: '1',
                    },
                  },
                ],
              })
            : Promise.resolve({});
        },
      },
    });

    expect(
      commands.some((command) => command instanceof DeleteMessageCommand),
    ).toBe(true);
    expect(
      commands.some(
        (command) => command instanceof ChangeMessageVisibilityCommand,
      ),
    ).toBe(false);
    expect(logs).toContainEqual({
      event: 'sms-worker-message-completed',
      count: 1,
      durationMilliseconds: 1_000,
    });
  });

  test('retains failed work for SQS redrive without logging provider detail', async () => {
    const commands: unknown[] = [];
    const logs: unknown[] = [];
    let loopChecks = 0;
    const dependencies: SmsServiceDependencies = {
      environment: ENABLED_ENVIRONMENT,
      shouldContinue: () => loopChecks++ < 2,
      log: (value) => logs.push(value),
      runtime: {
        processDeliveryEvent: () =>
          Promise.reject(new Error('provider-controlled secret detail')),
        processQueueAttempt: () => Promise.reject(new Error('unused')),
        reconcileOptOuts: () => Promise.reject(new Error('unused')),
      },
      state: {} as SmsRuntimeClient,
      sqs: {
        send(command) {
          commands.push(command);
          return command instanceof ReceiveMessageCommand &&
            command.input.QueueUrl === ENABLED_ENVIRONMENT.SMS_RECEIPT_QUEUE_URL
            ? Promise.resolve({
                Messages: [
                  {
                    Body: JSON.stringify({
                      source: 'aws.sms-voice',
                      'detail-type': 'Text Message Delivery Status Updated',
                    }),
                    ReceiptHandle: 'synthetic-receipt-handle',
                    Attributes: {
                      SentTimestamp: String(NOW),
                      ApproximateReceiveCount: '4',
                    },
                  },
                ],
              })
            : Promise.resolve({});
        },
      },
    };
    await runSmsService(dependencies);
    expect(
      commands.some((command) => command instanceof DeleteMessageCommand),
    ).toBe(false);
    expect(logs).toContainEqual({
      event: 'sms-worker-message-failed',
      count: 1,
      stage: 'process',
      code: 'UNEXPECTED',
      receiveCount: 4,
    });
    expect(JSON.stringify(logs)).not.toContain('provider-controlled');
  });
});
