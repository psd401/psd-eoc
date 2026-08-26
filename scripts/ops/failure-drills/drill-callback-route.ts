import { timingSafeEqual } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { UuidSchema } from '@psd-eoc/contracts';
import {
  createDatabaseClient,
  readDatabaseConfig,
} from '@psd-eoc/server/db/client';
import {
  channelAttempts,
  deliveryEvidence,
  idempotencyRecords,
} from '@psd-eoc/server/db/schema';
import {
  createDrizzleSesWebhookStore,
  createSesWebhookRouteHandler,
  SES_CONFIGURATION_SET_NAME,
} from '@psd-eoc/server/app/api/webhooks/ses/runtime';

export const dynamic = 'force-dynamic';

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
    origin !== new URL(request.url).origin ||
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

export async function POST(request: Request): Promise<Response> {
  try {
    const { accountId, origin, region } =
      authorizeSyntheticCallbackRequest(request);
    const body = (await request.json()) as Readonly<Record<string, unknown>>;
    const attemptId = UuidSchema.parse(body.attemptId);
    const callbackId = UuidSchema.parse(body.callbackId);
    const connection = createDatabaseClient(readDatabaseConfig());
    try {
      const store = createDrizzleSesWebhookStore(connection.db);
      const attempt = await store.loadAttempt(attemptId);
      if (
        attempt === null ||
        attempt.channel !== 'email' ||
        attempt.rosterPopulation !== 'synthetic' ||
        attempt.templateMode !== 'drill'
      ) {
        throw new Error('The callback attempt is not synthetic email work.');
      }
      const topicArn = `arn:aws:sns:${region}:${accountId}:synthetic-failure-drill`;
      const handler = createSesWebhookRouteHandler({
        readExpectedTopicArn: () => topicArn,
        verifySignature: () => Promise.resolve(),
        createStore: () => Promise.resolve(store),
      });
      const timestamp = new Date().toISOString();
      const first = await handler(
        createSyntheticCallbackRequest(
          origin,
          accountId,
          region,
          topicArn,
          callbackId,
          timestamp,
          attempt,
        ),
      );
      const replay = await handler(
        createSyntheticCallbackRequest(
          origin,
          accountId,
          region,
          topicArn,
          callbackId,
          timestamp,
          attempt,
        ),
      );
      if (first.status !== 204 || replay.status !== 204) {
        throw new Error('The exact callback replay was not acknowledged.');
      }
      const providerReference = `mock-provider-${callbackId}`;
      const [persistedAttempt] = await connection.db
        .select({
          id: channelAttempts.id,
          endpointId: channelAttempts.endpointId,
        })
        .from(channelAttempts)
        .where(eq(channelAttempts.id, attemptId))
        .limit(1);
      const evidence = await connection.db
        .select({
          id: deliveryEvidence.id,
          sequence: deliveryEvidence.sequence,
        })
        .from(deliveryEvidence)
        .where(
          and(
            eq(deliveryEvidence.attemptId, attemptId),
            eq(deliveryEvidence.provider, 'ses'),
            eq(deliveryEvidence.providerReference, providerReference),
          ),
        );
      const claims = await connection.db
        .select({
          id: idempotencyRecords.id,
          resultReference: idempotencyRecords.resultReference,
          status: idempotencyRecords.status,
        })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'record-delivery-evidence'),
            eq(idempotencyRecords.resultReference, `ses-sns:${callbackId}`),
          ),
        );
      if (
        persistedAttempt === undefined ||
        evidence.length !== 1 ||
        claims.length !== 1 ||
        claims[0]?.status !== 'completed'
      ) {
        throw new Error('The callback replay evidence did not reconcile.');
      }
      const identity = `callback:${callbackId}:attempt:${persistedAttempt.id}:endpoint:${persistedAttempt.endpointId}`;
      return Response.json({
        observedSideEffects: [identity],
        facts: {
          attemptId: persistedAttempt.id,
          callbackId,
          callbackClaimId: claims[0].id,
          capabilityEvidenceId: evidence[0]?.id,
          capabilityEvidenceSequence: evidence[0]?.sequence,
          endpointId: persistedAttempt.endpointId,
          firstStatus: first.status,
          replayStatus: replay.status,
        },
      });
    } finally {
      await connection.close();
    }
  } catch {
    return Response.json(
      { code: 'FAILURE_DRILL_CALLBACK_REFUSED' },
      { status: 403 },
    );
  }
}
