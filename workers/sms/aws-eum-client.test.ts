import { describe, expect, test } from 'bun:test';
import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';

import type { AwsEumSendTextMessageRequest } from './aws-eum-adapter';
import {
  createAwsEumSingleAttemptClient,
  type AwsEumSingleAttemptClientConfig,
} from './aws-eum-client';

const SYNTHETIC_CREDENTIALS = {
  accessKeyId: 'SYNTHETICACCESSKEY',
  secretAccessKey: 'synthetic-secret-never-used-outside-the-test',
};

const SEND_REQUEST = Object.freeze({
  DestinationPhoneNumber: '+12025550123',
  OriginationIdentity:
    'arn:aws:sms-voice:us-west-2:000000000000:phone-number/synthetic',
  MessageBody: '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic. [DRILL]',
  MessageType: 'TRANSACTIONAL',
  ConfigurationSetName: 'psd-eoc-sms',
  MaxPrice: '0.05',
  TimeToLive: 300,
  Context: Object.freeze({
    psdAttemptId: '00000000-0000-4000-8000-000000000013',
    psdProviderClaimToken: '00000000-0000-4000-8000-000000000014',
  }),
  DryRun: false,
  ProtectConfigurationId: 'protect-synthetic',
}) satisfies AwsEumSendTextMessageRequest;

function ambiguousTransport() {
  return {
    requests: 0,
    metadata: { handlerProtocol: 'http/1.1' as const },
    updateHttpClientConfig(): void {},
    httpHandlerConfigs(): Record<string, never> {
      return {};
    },
    destroy(): void {},
    handle(): Promise<never> {
      this.requests += 1;
      return Promise.reject(
        Object.assign(new Error('Synthetic loss after request write.'), {
          name: 'TimeoutError',
        }),
      );
    },
  };
}

describe('AWS EUM SDK single-wire construction', () => {
  test('control proves a normal retry-capable SDK client can cross the wire twice for one call', async () => {
    const transport = ambiguousTransport();
    const retryingClient = new PinpointSMSVoiceV2Client({
      region: 'us-west-2',
      credentials: SYNTHETIC_CREDENTIALS,
      maxAttempts: 2,
      requestHandler: transport,
    });

    try {
      await expect(
        retryingClient.send(new SendTextMessageCommand(SEND_REQUEST)),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(transport.requests).toBe(2);
    } finally {
      retryingClient.destroy();
    }
  });

  test('production factory exposes the same ambiguous loss after exactly one wire request', async () => {
    const transport = ambiguousTransport();
    const client = createAwsEumSingleAttemptClient({
      region: 'us-west-2',
      credentials: SYNTHETIC_CREDENTIALS,
      requestHandler: transport,
    });

    await expect(client.sendTextMessage(SEND_REQUEST)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(client.deliverySemantics).toBe('single-wire-attempt');
    expect(transport.requests).toBe(1);
  });

  test('uses the same one-wire SDK boundary for bounded opt-out reads', async () => {
    const transport = ambiguousTransport();
    const client = createAwsEumSingleAttemptClient({
      region: 'us-west-2',
      credentials: SYNTHETIC_CREDENTIALS,
      requestHandler: transport,
    });

    await expect(
      client.describeOptedOutNumbers({
        OptOutListName:
          'arn:aws:sms-voice:us-west-2:000000000000:opt-out-list/SyntheticList',
        MaxResults: 100,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.requests).toBe(1);
  });

  test('factory rejects caller-controlled retry settings before transport I/O', () => {
    for (const forbidden of [
      { maxAttempts: 2 },
      { retryStrategy: { mode: 'standard' } },
    ]) {
      const transport = ambiguousTransport();
      const unsafeConfiguration = {
        region: 'us-west-2',
        credentials: SYNTHETIC_CREDENTIALS,
        requestHandler: transport,
        ...forbidden,
      } as unknown as AwsEumSingleAttemptClientConfig;

      expect(() =>
        createAwsEumSingleAttemptClient(unsafeConfiguration),
      ).toThrow('retry configuration is fixed');
      expect(transport.requests).toBe(0);
    }
  });
});
