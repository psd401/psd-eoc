import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

import { ProviderDispatchError } from '../shared/retry';
import type { SesV2Client, SesV2SendEmailInput } from './ses-adapter';

const RETRYABLE_NAMES = new Set([
  'LimitExceededException',
  'TooManyRequestsException',
]);

const TERMINAL_NAMES = new Set([
  'AccountSuspendedException',
  'BadRequestException',
  'MailFromDomainNotVerifiedException',
  'MessageRejected',
  'NotFoundException',
  'SendingPausedException',
]);

function errorMetadata(value: unknown): Readonly<{
  name: string | null;
  httpStatusCode: number | null;
}> {
  if (value === null || typeof value !== 'object') {
    return { name: null, httpStatusCode: null };
  }
  const error = value as Readonly<Record<string, unknown>>;
  const metadata = error.$metadata;
  const status =
    metadata !== null && typeof metadata === 'object'
      ? (metadata as Readonly<Record<string, unknown>>).httpStatusCode
      : null;
  return {
    name: typeof error.name === 'string' ? error.name : null,
    httpStatusCode: typeof status === 'number' ? status : null,
  };
}

/** SES SDK boundary with SDK retries disabled so the durable ledger owns them. */
export class AwsSesV2Client implements SesV2Client {
  readonly #client: SESv2Client;

  public constructor(client = new SESv2Client({ maxAttempts: 1 })) {
    this.#client = client;
  }

  public async sendEmail(input: SesV2SendEmailInput): Promise<unknown> {
    try {
      return await this.#client.send(
        new SendEmailCommand({
          FromEmailAddress: input.FromEmailAddress,
          Destination: { ToAddresses: [...input.Destination.ToAddresses] },
          Content: input.Content,
          ConfigurationSetName: input.ConfigurationSetName,
          EmailTags: [...input.EmailTags],
        }),
      );
    } catch (error) {
      const metadata = errorMetadata(error);
      if (
        (metadata.name !== null && RETRYABLE_NAMES.has(metadata.name)) ||
        metadata.httpStatusCode === 429
      ) {
        throw new ProviderDispatchError(
          'SES_PROVIDER_RETRYABLE',
          'safe-to-retry',
        );
      }
      if (
        (metadata.name !== null && TERMINAL_NAMES.has(metadata.name)) ||
        (metadata.httpStatusCode !== null &&
          metadata.httpStatusCode >= 400 &&
          metadata.httpStatusCode < 500)
      ) {
        throw new ProviderDispatchError(
          'SES_PROVIDER_REJECTED',
          'terminal-failure',
        );
      }
      throw new ProviderDispatchError(
        'SES_SEND_OUTCOME_AMBIGUOUS',
        'ambiguous',
      );
    }
  }
}
