import { timingSafeEqual } from 'node:crypto';

import { SES_CONFIGURATION_SET_NAME } from '@psd-eoc/server/app/api/webhooks/ses/runtime';

function equal(value: string, expected: string): boolean {
  const first = Buffer.from(value, 'utf8');
  const second = Buffer.from(expected, 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
}

export function authorizeSyntheticCallbackRequest(
  request: Request,
): Readonly<{ accountId: string; origin: string; region: string }> {
  const origin = process.env.GOOGLE_OIDC_APPLICATION_ORIGIN;
  const accountId = process.env.AWS_ACCOUNT_ID;
  const region = process.env.AWS_REGION;
  const token = process.env.PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN;
  const supplied = request.headers.get('authorization');
  const suppliedOrigin = request.headers.get('origin');
  if (
    process.env.PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS !== 'non-production' ||
    process.env.PSD_EOC_FAILURE_DRILL_PROVIDER_MODE !== 'mocked' ||
    process.env.PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION !== 'synthetic' ||
    process.env.GOOGLE_OIDC_HOSTED_DOMAIN !== 'example.invalid' ||
    accountId === undefined ||
    !/^\d{12}$/u.test(accountId) ||
    region === undefined ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region) ||
    origin === undefined ||
    suppliedOrigin !== origin ||
    !/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9-]+\.awsapprunner\.com$/u.test(
      origin,
    ) ||
    token === undefined ||
    supplied === null ||
    !supplied.startsWith('Bearer ') ||
    !equal(supplied.slice('Bearer '.length), token)
  ) {
    throw new Error('The deployed synthetic callback boundary is unavailable.');
  }
  return Object.freeze({ accountId, origin, region });
}

export function createSyntheticCallbackRequest(
  origin: string,
  accountId: string,
  region: string,
  topicArn: string,
  callbackId: string,
  timestamp: string,
  attempt: Readonly<{
    id: string;
    endpointId: string;
    rosterSnapshotId: string;
    recipientId: string;
    templateMode: string;
    eventKind: string;
  }>,
): Request {
  const mailMessageId = `mock-provider-${callbackId}`;
  const message = JSON.stringify({
    eventType: 'Send',
    mail: {
      timestamp,
      messageId: mailMessageId,
      source: 'synthetic-sender@alerts.example.invalid',
      sendingAccountId: accountId,
      destination: ['synthetic-recipient@example.invalid'],
      tags: {
        'ses:configuration-set': [SES_CONFIGURATION_SET_NAME],
        'psd-eoc-attempt-id': [attempt.id],
        'psd-eoc-endpoint-id': [attempt.endpointId],
        'psd-eoc-roster-snapshot-id': [attempt.rosterSnapshotId],
        'psd-eoc-recipient-id': [attempt.recipientId],
        'psd-eoc-template-mode': [attempt.templateMode],
        'psd-eoc-event-kind': [attempt.eventKind],
      },
    },
    send: {},
  });
  const envelope = {
    Type: 'Notification',
    MessageId: callbackId,
    TopicArn: topicArn,
    Subject: 'Synthetic failure-drill SES callback',
    Message: message,
    Timestamp: timestamp,
    SignatureVersion: '2',
    Signature: 'c3ludGhldGlj',
    SigningCertURL: `https://sns.${region}.amazonaws.com/SimpleNotificationService-${'0'.repeat(32)}.pem`,
    UnsubscribeURL: `https://sns.${region}.amazonaws.com/?Action=Unsubscribe&synthetic=1`,
  } as const;
  return new Request(`${origin}/api/webhooks/ses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-amz-sns-message-type': envelope.Type,
      'x-amz-sns-message-id': envelope.MessageId,
      'x-amz-sns-topic-arn': envelope.TopicArn,
    },
    body: JSON.stringify(envelope),
  });
}
