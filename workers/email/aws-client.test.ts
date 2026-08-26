import { describe, expect, test } from 'bun:test';
import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';

import { ProviderDispatchError } from '../shared/retry';
import { AwsSesV2Client } from './aws-client';
import type { SesV2SendEmailInput } from './ses-adapter';

const INPUT: SesV2SendEmailInput = {
  FromEmailAddress: 'alerts@example.invalid',
  Destination: { ToAddresses: ['recipient@example.invalid'] },
  Content: {
    Simple: {
      Subject: { Charset: 'UTF-8', Data: '[DRILL] Test' },
      Body: {
        Text: { Charset: 'UTF-8', Data: '[DRILL] No emergency.' },
        Html: { Charset: 'UTF-8', Data: '<p>[DRILL] No emergency.</p>' },
      },
    },
  },
  ConfigurationSetName: 'psd-eoc-transactional',
  EmailTags: [],
};

describe('AWS SES v2 client boundary', () => {
  test('uses SendEmail and returns only the SDK response to the adapter', async () => {
    const commands: unknown[] = [];
    const client = new AwsSesV2Client({
      send(command: unknown) {
        commands.push(command);
        return Promise.resolve({ MessageId: 'synthetic-provider-id' });
      },
    } as unknown as SESv2Client);
    await expect(client.sendEmail(INPUT)).resolves.toEqual({
      MessageId: 'synthetic-provider-id',
    });
    expect(commands[0]).toBeInstanceOf(SendEmailCommand);
  });

  test('distinguishes explicit throttling from an ambiguous network loss', async () => {
    const throttled = new AwsSesV2Client({
      send() {
        return Promise.reject({
          name: 'TooManyRequestsException',
          $metadata: { httpStatusCode: 429 },
        });
      },
    } as unknown as SESv2Client);
    await expect(throttled.sendEmail(INPUT)).rejects.toEqual(
      expect.objectContaining({
        code: 'SES_PROVIDER_RETRYABLE',
        disposition: 'safe-to-retry',
      }),
    );

    const ambiguous = new AwsSesV2Client({
      send() {
        return Promise.reject(new Error('socket closed'));
      },
    } as unknown as SESv2Client);
    await expect(ambiguous.sendEmail(INPUT)).rejects.toEqual(
      expect.objectContaining({
        code: 'SES_SEND_OUTCOME_AMBIGUOUS',
        disposition: 'ambiguous',
      }),
    );
    await expect(ambiguous.sendEmail(INPUT)).rejects.toBeInstanceOf(
      ProviderDispatchError,
    );

    const serverFailure = new AwsSesV2Client({
      send() {
        return Promise.reject({
          name: 'InternalServiceError',
          $metadata: { httpStatusCode: 500 },
        });
      },
    } as unknown as SESv2Client);
    await expect(serverFailure.sendEmail(INPUT)).rejects.toEqual(
      expect.objectContaining({
        code: 'SES_SEND_OUTCOME_AMBIGUOUS',
        disposition: 'ambiguous',
      }),
    );
  });
});
