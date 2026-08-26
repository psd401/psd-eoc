import { describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';

import {
  EmailCallbackServiceError,
  forwardEmailCallback,
  readEmailCallbackServiceConfiguration,
  runEmailCallbackService,
} from './callback-service';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:psd-eoc-email-events';
const CONFIGURATION = Object.freeze({
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/email-callbacks',
  queueArn: 'arn:aws:sqs:us-east-1:000000000000:email-callbacks',
  expectedTopicArn: TOPIC_ARN,
  serviceOrigin: 'https://eoc.example.invalid',
});
const ENVIRONMENT = Object.freeze({
  PSD_EOC_EMAIL_CALLBACK_RUNTIME_MODE: 'enabled',
  EMAIL_CALLBACK_QUEUE_URL: CONFIGURATION.queueUrl,
  EMAIL_CALLBACK_QUEUE_ARN: CONFIGURATION.queueArn,
  PSD_EOC_SES_SNS_TOPIC_ARN: TOPIC_ARN,
  PSD_EOC_SERVICE_ORIGIN: CONFIGURATION.serviceOrigin,
});

function envelope(): string {
  return JSON.stringify({
    Type: 'Notification',
    MessageId: '00000000-0000-4000-8000-000000000001',
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify({ eventType: 'Send' }),
    Timestamp: '2026-08-26T12:00:00.000Z',
    SignatureVersion: '2',
    Signature: Buffer.from('synthetic-signature').toString('base64'),
    SigningCertURL:
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
  });
}

describe('email callback service', () => {
  test('requires a durable queue, exact topic, and HTTPS application origin', () => {
    expect(readEmailCallbackServiceConfiguration(ENVIRONMENT)).toEqual(
      CONFIGURATION,
    );
    for (const environment of [
      { ...ENVIRONMENT, PSD_EOC_EMAIL_CALLBACK_RUNTIME_MODE: 'dark' },
      { ...ENVIRONMENT, EMAIL_CALLBACK_QUEUE_URL: 'http://sqs.invalid/queue' },
      {
        ...ENVIRONMENT,
        EMAIL_CALLBACK_QUEUE_URL:
          'https://sqs.attacker.example/000000000000/email-callbacks',
      },
      {
        ...ENVIRONMENT,
        EMAIL_CALLBACK_QUEUE_URL:
          'https://sqs.us-east-1.amazonaws.com/111111111111/email-callbacks',
      },
      {
        ...ENVIRONMENT,
        EMAIL_CALLBACK_QUEUE_ARN:
          'arn:aws:sqs:us-east-1:000000000000:other-callbacks',
      },
      { ...ENVIRONMENT, PSD_EOC_SES_SNS_TOPIC_ARN: 'not-an-arn' },
      { ...ENVIRONMENT, PSD_EOC_SERVICE_ORIGIN: 'http://eoc.invalid' },
    ]) {
      expect(() => readEmailCallbackServiceConfiguration(environment)).toThrow(
        EmailCallbackServiceError,
      );
    }
  });

  test('forwards the exact signed envelope and SNS headers to server verification', async () => {
    const calls: Readonly<{ input: string; init: RequestInit }>[] = [];
    const body = envelope();
    const forwarded = await forwardEmailCallback(
      body,
      CONFIGURATION,
      (input, init) => {
        calls.push({ input: String(input), init: init ?? {} });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    );
    expect(forwarded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      'https://eoc.example.invalid/api/webhooks/ses',
    );
    expect(calls[0]?.init.body).toBe(body);
    expect(calls[0]?.init.headers).toEqual({
      'content-type': 'text/plain; charset=utf-8',
      'x-amz-sns-message-id': '00000000-0000-4000-8000-000000000001',
      'x-amz-sns-message-type': 'Notification',
      'x-amz-sns-topic-arn': TOPIC_ARN,
    });
  });

  test('retains transient failures and refuses malformed or wrong-topic payloads', async () => {
    await expect(
      forwardEmailCallback(envelope(), CONFIGURATION, () =>
        Promise.resolve(new Response(null, { status: 503 })),
      ),
    ).resolves.toBe(false);
    await expect(forwardEmailCallback('{', CONFIGURATION)).rejects.toThrow(
      EmailCallbackServiceError,
    );
    await expect(
      forwardEmailCallback(
        envelope().replace(TOPIC_ARN, `${TOPIC_ARN}-other`),
        CONFIGURATION,
      ),
    ).rejects.toThrow(EmailCallbackServiceError);
  });

  test('contains one malformed retained envelope and continues draining callbacks', async () => {
    let receiveCount = 0;
    let deleteCount = 0;
    const events: unknown[] = [];
    await runEmailCallbackService({
      environment: ENVIRONMENT,
      shouldContinue: () => receiveCount < 2,
      log: (event) => events.push(event),
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      sqs: {
        send(command) {
          if (command instanceof ReceiveMessageCommand) {
            receiveCount += 1;
            return Promise.resolve({
              Messages: [
                {
                  Body: receiveCount === 1 ? '{' : envelope(),
                  ReceiptHandle: `synthetic-receipt-${receiveCount}`,
                },
              ],
            });
          }
          if (command instanceof DeleteMessageCommand) {
            deleteCount += 1;
            return Promise.resolve({});
          }
          throw new Error('Unexpected synthetic SQS command.');
        },
      },
    });

    expect(receiveCount).toBe(2);
    expect(deleteCount).toBe(1);
    expect(events).toContainEqual({
      event: 'email-callback-message-failed',
      count: 1,
    });
    expect(events).toContainEqual({
      event: 'email-callback-message-completed',
      count: 1,
    });
  });
});
