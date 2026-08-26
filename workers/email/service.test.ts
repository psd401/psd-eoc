import { describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';

import {
  EmailServiceError,
  readEmailServiceConfiguration,
  SqsEmailRetryPublisher,
} from './service';

const TOKEN = 'worker-token-'.padEnd(48, 'x');
const ENABLED_ENV = Object.freeze({
  PSD_EOC_EMAIL_RUNTIME_MODE: 'enabled',
  PSD_EOC_SES_PROVIDER_AUTHORIZED: 'true',
  PSD_EOC_SES_CREDENTIAL_STATUS: 'verified',
  PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE: 'deployment:commit-277',
  EMAIL_QUEUE_URL:
    'https://sqs.us-east-1.amazonaws.com/000000000000/example-email',
  EMAIL_QUEUE_ARN: 'arn:aws:sqs:us-east-1:000000000000:example-email',
  PSD_EOC_SERVICE_ORIGIN: 'https://eoc.example.invalid',
  PSD_EOC_SES_FROM_ADDRESS: 'alerts@example.invalid',
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
        verificationReference: 'deployment:commit-277',
      }),
    );
  });

  test('rejects unverified deployment references and non-HTTPS origins', () => {
    expect(() =>
      readEmailServiceConfiguration({
        ...ENABLED_ENV,
        PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE: 'UNVERIFIED',
      }),
    ).toThrow(EmailServiceError);
    expect(() =>
      readEmailServiceConfiguration({
        ...ENABLED_ENV,
        PSD_EOC_SERVICE_ORIGIN: 'http://eoc.example.invalid',
      }),
    ).toThrow(EmailServiceError);
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
