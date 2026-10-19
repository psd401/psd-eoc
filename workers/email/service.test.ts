import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';

import {
  EMAIL_WORKER_CONCURRENCY,
  EmailServiceError,
  readEmailServiceConfiguration,
  runEmailService,
  SqsEmailRetryPublisher,
} from './service';

const TOKEN = 'worker-token-'.padEnd(48, 'x');
const ENABLED_ENV = Object.freeze({
  PSD_EOC_EMAIL_RUNTIME_MODE: 'enabled',
  PSD_EOC_SES_PROVIDER_AUTHORIZED: 'true',
  PSD_EOC_SES_CREDENTIAL_STATUS: 'verified',
  EMAIL_QUEUE_URL:
    'https://sqs.us-east-1.amazonaws.com/000000000000/example-email',
  EMAIL_QUEUE_ARN: 'arn:aws:sqs:us-east-1:000000000000:example-email',
  EMAIL_DEAD_LETTER_QUEUE_URL:
    'https://sqs.us-east-1.amazonaws.com/000000000000/example-email-dlq',
  EMAIL_DEAD_LETTER_QUEUE_ARN:
    'arn:aws:sqs:us-east-1:000000000000:example-email-dlq',
  PSD_EOC_SERVICE_ORIGIN: 'https://eoc.example.invalid',
  PSD_EOC_SES_FROM_ADDRESS: 'alerts@example.invalid',
  PSD_EOC_SES_FROM_DISPLAY_NAME: 'PSD EOC Alerts',
  PSD_EOC_ORGANIZATION_NAME: 'Example School District',
  PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: TOKEN,
  PSD_EOC_DELIVERY_STATE_WORKER_TOKEN: TOKEN,
  PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN: TOKEN,
});

describe('email service configuration', () => {
  test('requires every explicit live-provider opt-in', () => {
    for (const name of [
      'PSD_EOC_EMAIL_RUNTIME_MODE',
      'PSD_EOC_SES_PROVIDER_AUTHORIZED',
      'PSD_EOC_SES_CREDENTIAL_STATUS',
    ] as const) {
      expect(() =>
        readEmailServiceConfiguration({ ...ENABLED_ENV, [name]: undefined }),
      ).toThrow(EmailServiceError);
    }
    expect(readEmailServiceConfiguration(ENABLED_ENV)).toEqual(
      expect.objectContaining({
        fromEmailAddress: 'alerts@example.invalid',
      }),
    );
  });

  test('reads email branding and treats the display name as optional', () => {
    expect(readEmailServiceConfiguration(ENABLED_ENV).branding).toEqual({
      organizationName: 'Example School District',
      applicationOrigin: 'https://eoc.example.invalid',
      senderDisplayName: 'PSD EOC Alerts',
    });
    for (const displayName of [undefined, '']) {
      expect(
        readEmailServiceConfiguration({
          ...ENABLED_ENV,
          PSD_EOC_SES_FROM_DISPLAY_NAME: displayName,
        }).branding.senderDisplayName,
      ).toBeNull();
    }
    for (const invalid of [
      { PSD_EOC_ORGANIZATION_NAME: undefined },
      { PSD_EOC_ORGANIZATION_NAME: ' Padded District ' },
      { PSD_EOC_SES_FROM_DISPLAY_NAME: 'Alerts <x@example.invalid>' },
    ]) {
      expect(() =>
        readEmailServiceConfiguration({ ...ENABLED_ENV, ...invalid }),
      ).toThrow(EmailServiceError);
    }
  });

  test('rejects non-HTTPS origins', () => {
    expect(() =>
      readEmailServiceConfiguration({
        ...ENABLED_ENV,
        PSD_EOC_SERVICE_ORIGIN: 'http://eoc.example.invalid',
      }),
    ).toThrow(EmailServiceError);
  });

  test('binds the queue URL to the configured SQS ARN', () => {
    for (const queueConfiguration of [
      {
        EMAIL_QUEUE_URL:
          'https://sqs.attacker.example/000000000000/example-email',
      },
      {
        EMAIL_QUEUE_URL:
          'https://sqs.us-west-2.amazonaws.com/000000000000/example-email',
      },
      {
        EMAIL_QUEUE_URL:
          'https://sqs.us-east-1.amazonaws.com/111111111111/example-email',
      },
      {
        EMAIL_QUEUE_URL:
          'https://sqs.us-east-1.amazonaws.com/000000000000/other-email',
      },
      {
        EMAIL_QUEUE_URL:
          'https://sqs.us-east-1.amazonaws.com/000000000000/example-email?shadow=1',
      },
      {
        EMAIL_QUEUE_ARN: 'arn:aws:sqs:us-west-2:000000000000:example-email',
      },
    ]) {
      expect(() =>
        readEmailServiceConfiguration({
          ...ENABLED_ENV,
          ...queueConfiguration,
        }),
      ).toThrow(EmailServiceError);
    }
  });
});

describe('email retry publisher', () => {
  test('puts only an opaque attempt reference on SQS', async () => {
    const commands: unknown[] = [];
    const publisher = new SqsEmailRetryPublisher(
      {
        send(command) {
          commands.push(command);
          return Promise.resolve({});
        },
      },
      ENABLED_ENV.EMAIL_QUEUE_URL,
    );
    await publisher.publishAttemptReference(
      '10000000-0000-4000-8000-000000000001',
      7,
    );
    expect(commands[0]).toBeInstanceOf(SendMessageCommand);
    const body = (commands[0] as SendMessageCommand).input.MessageBody;
    expect(JSON.parse(body ?? '')).toEqual({
      kind: 'ses-email-attempt-reference',
      sourceAttemptId: '10000000-0000-4000-8000-000000000001',
    });
    expect(body).not.toContain('@');
  });
});

function queueMessage() {
  return {
    MessageId: randomUUID(),
    ReceiptHandle: `receipt-${randomUUID()}`,
    Body: '{}',
    Attributes: { SentTimestamp: String(Date.now()) },
  };
}

describe('email service loop', () => {
  test('works on several queued batches at once', async () => {
    // One loop handled one batch at a time; on 2026-10-15 the queue ran
    // minutes behind and drills ended before their begin email was reached.
    let inFlight = 0;
    let peak = 0;
    let processed = 0;
    const total = EMAIL_WORKER_CONCURRENCY * 3;
    let releaseAll: () => void = () => undefined;
    const allArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    await runEmailService({
      environment: ENABLED_ENV,
      log: () => undefined,
      shouldContinue: () => processed < total,
      sqs: {
        send(command) {
          return Promise.resolve(
            command instanceof ReceiveMessageCommand
              ? { Messages: [queueMessage()] }
              : {},
          );
        },
      },
      runtime: {
        async processQueueMessage() {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          if (peak === EMAIL_WORKER_CONCURRENCY) releaseAll();
          await allArrived;
          inFlight -= 1;
          processed += 1;
          return {
            kind: 'completed',
            outboxCreatedAt: new Date().toISOString(),
            acceptedCount: 1,
            incompleteCount: 0,
            suppressedCount: 0,
          };
        },
      },
    });
    expect(EMAIL_WORKER_CONCURRENCY).toBeGreaterThan(1);
    expect(peak).toBe(EMAIL_WORKER_CONCURRENCY);
    expect(processed).toBeGreaterThanOrEqual(total);
  });

  test('stops every loop and fails when one receive fails', async () => {
    let receives = 0;
    const failure = new Error('synthetic receive failure');
    await expect(
      runEmailService({
        environment: ENABLED_ENV,
        log: () => undefined,
        sqs: {
          send(command) {
            if (!(command instanceof ReceiveMessageCommand)) {
              return Promise.resolve({});
            }
            receives += 1;
            return receives === 1
              ? Promise.reject(failure)
              : new Promise((resolve) => setTimeout(() => resolve({}), 5));
          },
        },
        runtime: {
          processQueueMessage() {
            throw new Error('no message should be processed');
          },
        },
      }),
    ).rejects.toBe(failure);
    // The siblings each finish the poll they were in and stop; none loops on.
    expect(receives).toBe(EMAIL_WORKER_CONCURRENCY);
  });
});
