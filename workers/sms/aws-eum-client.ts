import {
  DescribeOptedOutNumbersCommand,
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
  type PinpointSMSVoiceV2ClientConfig,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';

import type {
  AwsEumSendTextMessageRequest,
  AwsEumSmsClient,
} from './aws-eum-adapter';
import type {
  AwsEumDescribeOptedOutNumbersRequest,
  AwsEumOptOutTransport,
} from './opt-out';

/**
 * Production SDK configuration deliberately excludes every caller-controlled
 * retry setting. SendTextMessage has no provider idempotency token, so the
 * durable attempt ledger must own all retry decisions above the wire.
 */
export type AwsEumSingleAttemptClientConfig = Omit<
  PinpointSMSVoiceV2ClientConfig,
  'maxAttempts' | 'retryStrategy'
> &
  Readonly<{
    maxAttempts?: never;
    retryStrategy?: never;
  }>;

/** Write-once send boundary plus bounded read-only opt-out reconciliation. */
export interface AwsEumSingleAttemptClient
  extends AwsEumSmsClient,
    AwsEumOptOutTransport {}

/**
 * Builds the only supported live AWS EUM client boundary. `maxAttempts: 1`
 * makes an ambiguous transport failure observable after one wire request;
 * the adapter then persists `unknown` rather than allowing an SDK-level
 * duplicate send.
 */
export function createAwsEumSingleAttemptClient(
  configuration: AwsEumSingleAttemptClientConfig,
): AwsEumSingleAttemptClient {
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration) ||
    Object.hasOwn(configuration, 'maxAttempts') ||
    Object.hasOwn(configuration, 'retryStrategy')
  ) {
    throw new TypeError(
      'AWS EUM SMS client retry configuration is fixed by the factory.',
    );
  }
  const client = new PinpointSMSVoiceV2Client({
    ...configuration,
    maxAttempts: 1,
  });

  return Object.freeze({
    deliverySemantics: 'single-wire-attempt' as const,
    sendTextMessage(request: AwsEumSendTextMessageRequest): Promise<unknown> {
      return client.send(new SendTextMessageCommand(request));
    },
    describeOptedOutNumbers(
      request: AwsEumDescribeOptedOutNumbersRequest,
    ): Promise<unknown> {
      const { OptedOutNumbers, ...rest } = request;
      return client.send(
        new DescribeOptedOutNumbersCommand({
          ...rest,
          ...(OptedOutNumbers === undefined
            ? {}
            : { OptedOutNumbers: [...OptedOutNumbers] }),
        }),
      );
    },
  });
}
