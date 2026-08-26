import { describe, expect, test } from 'bun:test';
import {
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  EndpointStatusRecordSchema,
  RecordDeliveryEvidenceInputSchema,
  RecordEndpointStatusInputSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
  type EndpointStatusRecord,
  type RecordDeliveryEvidenceInput,
  type RecordEndpointStatusInput,
} from '@psd-eoc/contracts';

import { DeliveryStateError } from '../../packages/server/app/api/internal/delivery-state/runtime';
import {
  SES_WEBHOOK_MAX_BODY_BYTES,
  createSesWebhookRouteHandler,
  type SesCallbackClaim,
  type SesWebhookStore,
} from '../../packages/server/app/api/webhooks/ses/runtime';
import { IDS, emailDeliveryTestWorkItem } from '../shared/test-fixtures';
import {
  SnsSignatureError,
  canonicalSnsEnvelopeDigest,
  parseSnsEnvelope,
} from './sns-signature';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:psd-eoc-email-events';
const CERTIFICATE_URL =
  'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem';
const SES_MESSAGE_ID = '0101010198f-synthetic-provider-id';
const EVENT_TIME = '2026-08-11T20:30:00.000Z';
const RECORDED_TIME = '2026-08-11T20:31:00.000Z';

const signingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attackerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

const ATTEMPT = ChannelAttemptSchema.parse({
  id: IDS.attempt,
  batchId: IDS.batch,
  intentId: IDS.intent,
  eventId: IDS.event,
  eventKind: 'test',
  templateMode: 'drill',
  purpose: 'activation',
  eventTypeVersion: {
    id: IDS.eventTypeVersion,
    templateMode: 'drill',
  },
  rosterSnapshotId: IDS.roster,
  rosterPopulation: 'synthetic',
  recipientId: IDS.recipient,
  endpointId: IDS.endpoint,
  channel: 'email',
  attemptNumber: 1,
  attemptedAt: '2026-08-11T20:00:00.000Z',
});
const DELIVERY_TEST_ATTEMPT = emailDeliveryTestWorkItem().attempt;

type SupportedFixtureType = 'Send' | 'Delivery' | 'Bounce' | 'Complaint';

interface CorrelationOverrides {
  readonly attemptId?: string;
  readonly endpointId?: string;
  readonly rosterSnapshotId?: string;
  readonly recipientId?: string;
  readonly templateMode?: 'real' | 'drill';
  readonly eventKind?: 'incident' | 'drill' | 'test';
  readonly providerIoClaimToken?: string;
  readonly configurationSet?: string;
}

interface SignedEnvelopeOptions {
  readonly eventType?: SupportedFixtureType;
  readonly snsMessageId?: string;
  readonly topicArn?: string;
  readonly signingKey?: KeyObject;
  readonly correlation?: CorrelationOverrides;
}

interface TestSnsEnvelope {
  readonly Type: 'Notification';
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Subject: string;
  readonly Message: string;
  readonly Timestamp: string;
  readonly SignatureVersion: '2';
  readonly Signature: string;
  readonly SigningCertURL: string;
  readonly UnsubscribeURL: string;
}

function eventBody(eventType: SupportedFixtureType): Record<string, unknown> {
  switch (eventType) {
    case 'Send':
      return {};
    case 'Delivery':
      return {
        timestamp: EVENT_TIME,
        recipients: ['private-recipient@example.invalid'],
        smtpResponse: '250 accepted',
      };
    case 'Bounce':
      return {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        timestamp: EVENT_TIME,
        bouncedRecipients: [
          { emailAddress: 'private-recipient@example.invalid' },
        ],
      };
    case 'Complaint':
      return {
        timestamp: EVENT_TIME,
        feedbackId: 'synthetic-feedback-id',
        complainedRecipients: [
          { emailAddress: 'private-recipient@example.invalid' },
        ],
      };
  }
}

function sesMessage(
  eventType: SupportedFixtureType,
  correlation: CorrelationOverrides = {},
): string {
  const bodyKey = eventType.toLowerCase();
  return JSON.stringify({
    eventType,
    mail: {
      timestamp: EVENT_TIME,
      messageId: SES_MESSAGE_ID,
      source: 'synthetic-sender@alerts.example.invalid',
      sendingAccountId: '000000000000',
      destination: ['private-recipient@example.invalid'],
      tags: {
        'ses:configuration-set': [
          correlation.configurationSet ?? 'psd-eoc-transactional',
        ],
        'psd-eoc-attempt-id': [correlation.attemptId ?? ATTEMPT.id],
        'psd-eoc-endpoint-id': [correlation.endpointId ?? ATTEMPT.endpointId],
        'psd-eoc-roster-snapshot-id': [
          correlation.rosterSnapshotId ?? ATTEMPT.rosterSnapshotId,
        ],
        'psd-eoc-recipient-id': [
          correlation.recipientId ?? ATTEMPT.recipientId,
        ],
        'psd-eoc-template-mode': [
          correlation.templateMode ?? ATTEMPT.templateMode,
        ],
        'psd-eoc-event-kind': [correlation.eventKind ?? ATTEMPT.eventKind],
        'psd-eoc-provider-io-claim': [
          correlation.providerIoClaimToken ?? IDS.confirmation,
        ],
      },
    },
    [bodyKey]: eventBody(eventType),
  });
}

function canonicalString(envelope: {
  readonly Message: string;
  readonly MessageId: string;
  readonly Subject?: string;
  readonly Timestamp: string;
  readonly TopicArn: string;
  readonly Type: 'Notification';
}): string {
  return [
    ['Message', envelope.Message],
    ['MessageId', envelope.MessageId],
    ...(envelope.Subject === undefined
      ? []
      : ([['Subject', envelope.Subject]] as const)),
    ['Timestamp', envelope.Timestamp],
    ['TopicArn', envelope.TopicArn],
    ['Type', envelope.Type],
  ]
    .map(([name, value]) => `${name}\n${value}`)
    .join('\n');
}

function signedEnvelope(options: SignedEnvelopeOptions = {}): TestSnsEnvelope {
  const unsigned: TestSnsEnvelope = {
    Type: 'Notification',
    MessageId: options.snsMessageId ?? randomUUID(),
    TopicArn: options.topicArn ?? TOPIC_ARN,
    Subject: 'Synthetic SES configuration-set event',
    Message: sesMessage(options.eventType ?? 'Send', options.correlation),
    Timestamp: '2026-08-11T20:30:10.000Z',
    SignatureVersion: '2',
    Signature: '',
    SigningCertURL: CERTIFICATE_URL,
    UnsubscribeURL:
      'https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&synthetic=1',
  };
  return Object.freeze({
    ...unsigned,
    Signature: sign(
      'sha256',
      Buffer.from(canonicalString(unsigned), 'utf8'),
      options.signingKey ?? signingKeys.privateKey,
    ).toString('base64'),
  });
}

function requestForEnvelope(
  envelope: TestSnsEnvelope,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request('https://app.example.invalid/api/webhooks/ses', {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-amz-sns-message-type': envelope.Type,
      'x-amz-sns-message-id': envelope.MessageId,
      'x-amz-sns-topic-arn': envelope.TopicArn,
      ...headers,
    },
    body: JSON.stringify(envelope),
  });
}

interface EvidenceWrite {
  readonly attempt: ChannelAttempt;
  readonly input: RecordDeliveryEvidenceInput;
}

interface EndpointWrite {
  readonly attempt: ChannelAttempt;
  readonly input: RecordEndpointStatusInput;
  readonly semanticIdempotencyKey: string;
}

interface ReportProjectionWrite {
  readonly attempt: ChannelAttempt;
  readonly evidence: DeliveryEvidence;
}

class MemorySesWebhookStore implements SesWebhookStore {
  public readonly evidenceWrites: EvidenceWrite[] = [];
  public readonly endpointWrites: EndpointWrite[] = [];
  public readonly reportProjectionWrites: ReportProjectionWrite[] = [];
  public readonly failedCallbacks: Readonly<{
    recordId: string;
    reasonCode: string;
  }>[] = [];
  public claimCalls = 0;
  public completeCalls = 0;
  public reconcileCalls = 0;
  public loadAttemptCalls = 0;
  public closeCalls = 0;

  readonly #claims = new Map<
    string,
    {
      digest: string;
      recordId: string;
      leaseToken: string;
      status: 'in-progress' | 'completed' | 'failed';
    }
  >();

  public constructor(private readonly attempt = ATTEMPT) {}

  public claimCallback(
    messageId: string,
    requestDigest: string,
  ): Promise<SesCallbackClaim> {
    this.claimCalls += 1;
    const existing = this.#claims.get(messageId);
    if (existing !== undefined) {
      if (existing.digest !== requestDigest) {
        return Promise.resolve({ kind: 'conflict' });
      }
      if (existing.status === 'completed') {
        return Promise.resolve({ kind: 'replay' });
      }
      if (existing.status === 'in-progress') {
        return Promise.resolve({ kind: 'in-progress' });
      }
      existing.status = 'in-progress';
      existing.recordId = randomUUID();
      existing.leaseToken = existing.recordId;
      return Promise.resolve({
        kind: 'acquired',
        recordId: existing.recordId,
        leaseToken: existing.leaseToken,
      });
    }
    const recordId = randomUUID();
    const leaseToken = recordId;
    this.#claims.set(messageId, {
      digest: requestDigest,
      recordId,
      leaseToken,
      status: 'in-progress',
    });
    return Promise.resolve({ kind: 'acquired', recordId, leaseToken });
  }

  public completeCallback(
    recordId: string,
    leaseToken: string,
    messageId: string,
  ): Promise<void> {
    const claim = this.#claims.get(messageId);
    if (
      claim === undefined ||
      claim.recordId !== recordId ||
      claim.leaseToken !== leaseToken ||
      claim.status !== 'in-progress'
    ) {
      return Promise.reject(new Error('Synthetic stale callback owner.'));
    }
    claim.status = 'completed';
    this.completeCalls += 1;
    return Promise.resolve();
  }

  public failCallback(
    recordId: string,
    leaseToken: string,
    reasonCode: string,
  ): Promise<void> {
    const claim = [...this.#claims.values()].find(
      (candidate) => candidate.recordId === recordId,
    );
    if (
      claim === undefined ||
      claim.leaseToken !== leaseToken ||
      claim.status !== 'in-progress'
    ) {
      return Promise.reject(new Error('Synthetic stale callback owner.'));
    }
    claim.status = 'failed';
    this.failedCallbacks.push({ recordId, reasonCode });
    return Promise.resolve();
  }

  public loadAttempt(attemptId: string): Promise<ChannelAttempt | null> {
    this.loadAttemptCalls += 1;
    return Promise.resolve(attemptId === this.attempt.id ? this.attempt : null);
  }

  public reconcileProviderIo(
    attempt: ChannelAttempt,
    providerReference: string,
    providerIoClaimToken: string,
  ): Promise<void> {
    if (
      attempt.id !== this.attempt.id ||
      providerReference.length === 0 ||
      providerIoClaimToken !== IDS.confirmation
    ) {
      return Promise.reject(new Error('Synthetic reconciliation mismatch.'));
    }
    this.reconcileCalls += 1;
    return Promise.resolve();
  }

  public recordAttemptEvidence(
    attempt: ChannelAttempt,
    inputValue: RecordDeliveryEvidenceInput,
  ): Promise<DeliveryEvidence> {
    const input = RecordDeliveryEvidenceInputSchema.parse(inputValue);
    this.evidenceWrites.push({ attempt, input });
    const previous = this.evidenceWrites.at(-2);
    return Promise.resolve(
      DeliveryEvidenceSchema.parse({
        id: randomUUID(),
        subject: input.subject,
        sequence: this.evidenceWrites.length,
        previousEvidenceId: previous === undefined ? null : randomUUID(),
        state: input.state,
        recordedAt: RECORDED_TIME,
        provider: input.provider,
        providerReference: input.providerReference,
        proof: input.proof,
        reasonCode: input.reasonCode,
        diagnosticDigest: input.diagnosticDigest,
      }),
    );
  }

  public reprojectDeliveryTestReport(
    attempt: ChannelAttempt,
    evidence: DeliveryEvidence,
  ): Promise<void> {
    this.reportProjectionWrites.push({ attempt, evidence });
    return Promise.resolve();
  }

  public recordEndpointStatus(
    attempt: ChannelAttempt,
    inputValue: RecordEndpointStatusInput,
    semanticIdempotencyKey: string,
  ): Promise<EndpointStatusRecord> {
    const input = RecordEndpointStatusInputSchema.parse(inputValue);
    this.endpointWrites.push({
      attempt,
      input,
      semanticIdempotencyKey,
    });
    return Promise.resolve(
      EndpointStatusRecordSchema.parse({
        id: randomUUID(),
        ...input,
        recordedAt: RECORDED_TIME,
      }),
    );
  }

  public close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

class FailingEvidenceStore extends MemorySesWebhookStore {
  public constructor(private readonly error: Error) {
    super();
  }

  public override recordAttemptEvidence(): Promise<DeliveryEvidence> {
    return Promise.reject(this.error);
  }
}

function createHarness(
  store = new MemorySesWebhookStore(),
  verifierError?: Error,
) {
  const calls = { createStore: 0, verifySignature: 0 };
  const handler = createSesWebhookRouteHandler({
    readExpectedTopicArn: () => TOPIC_ARN,
    async verifySignature(envelope): Promise<void> {
      calls.verifySignature += 1;
      if (verifierError !== undefined) throw verifierError;
      if (envelope.Type !== 'Notification') {
        throw new Error('Unexpected confirmation in notification harness.');
      }
      const valid = verify(
        'sha256',
        Buffer.from(canonicalString(envelope), 'utf8'),
        signingKeys.publicKey,
        Buffer.from(envelope.Signature, 'base64'),
      );
      if (!valid) throw new Error('Synthetic invalid signature.');
    },
    confirmSubscription: () => Promise.resolve(),
    createStore: () => {
      calls.createStore += 1;
      return Promise.resolve(store);
    },
  });
  return { calls, handler, store };
}

async function errorCode(response: Response): Promise<string | undefined> {
  const value = (await response.json()) as {
    error?: { code?: string };
  };
  return value.error?.code;
}

describe('SES signed SNS webhook route', () => {
  test('confirms an authenticated managed subscription before opening storage', async () => {
    const messageId = '10000000-0000-4000-8000-000000000099';
    const token = 'synthetic-confirmation-token';
    const subscribeUrl =
      `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription` +
      `&TopicArn=${encodeURIComponent(TOPIC_ARN)}` +
      `&Token=${encodeURIComponent(token)}`;
    let confirmations = 0;
    let stores = 0;
    const handler = createSesWebhookRouteHandler({
      readExpectedTopicArn: () => TOPIC_ARN,
      verifySignature: () => Promise.resolve(),
      confirmSubscription(envelope) {
        confirmations += 1;
        expect(envelope.SubscribeURL).toBe(subscribeUrl);
        return Promise.resolve();
      },
      createStore() {
        stores += 1;
        return Promise.resolve(new MemorySesWebhookStore());
      },
    });
    const response = await handler(
      new Request('https://eoc.example.invalid/api/webhooks/ses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-amz-sns-message-type': 'SubscriptionConfirmation',
          'x-amz-sns-message-id': messageId,
          'x-amz-sns-topic-arn': TOPIC_ARN,
        },
        body: JSON.stringify({
          Type: 'SubscriptionConfirmation',
          MessageId: messageId,
          Token: token,
          TopicArn: TOPIC_ARN,
          Message: 'You have chosen to subscribe.',
          SubscribeURL: subscribeUrl,
          Timestamp: '2026-08-11T20:30:00.000Z',
          SignatureVersion: '2',
          Signature: Buffer.from('synthetic').toString('base64'),
          SigningCertURL:
            'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
        }),
      }),
    );
    expect(response.status).toBe(204);
    expect(confirmations).toBe(1);
    expect(stores).toBe(0);
  });
  for (const fixture of [
    { eventType: 'Send', state: 'provider-accepted' },
    { eventType: 'Delivery', state: 'delivered' },
  ] as const) {
    test(`maps signed ${fixture.eventType} through the delivery capability`, async () => {
      const app = createHarness();
      const envelope = signedEnvelope({ eventType: fixture.eventType });

      const response = await app.handler(requestForEnvelope(envelope));

      expect(response.status).toBe(204);
      expect(app.calls.verifySignature).toBe(1);
      expect(app.calls.createStore).toBe(1);
      expect(app.store.evidenceWrites).toHaveLength(1);
      expect(app.store.evidenceWrites[0]?.input.state).toBe(fixture.state);
      expect(app.store.evidenceWrites[0]?.attempt).toEqual(ATTEMPT);
      expect(app.store.endpointWrites).toHaveLength(0);
      expect(app.store.reconcileCalls).toBe(1);
      expect(app.store.completeCalls).toBe(1);
      expect(app.store.closeCalls).toBe(1);
      if (fixture.eventType === 'Delivery') {
        expect(app.store.evidenceWrites[0]?.input.proof).toEqual({
          kind: 'provider-delivery-receipt',
          provider: 'aws-ses-v2',
          receiptId: envelope.MessageId,
          deliveredAt: EVENT_TIME,
        });
      }
    });
  }

  test('permanent Bounce writes failed evidence and invalid endpoint status', async () => {
    const app = createHarness();

    const response = await app.handler(
      requestForEnvelope(signedEnvelope({ eventType: 'Bounce' })),
    );

    expect(response.status).toBe(204);
    expect(app.store.evidenceWrites.map(({ input }) => input.state)).toEqual([
      'failed',
    ]);
    expect(app.store.evidenceWrites[0]?.input.reasonCode).toBe(
      'SES_PERMANENT_BOUNCE',
    );
    expect(app.store.endpointWrites).toHaveLength(1);
    expect(app.store.reconcileCalls).toBe(1);
    expect(app.store.endpointWrites[0]?.input).toEqual({
      rosterSnapshotId: ATTEMPT.rosterSnapshotId,
      recipientId: ATTEMPT.recipientId,
      endpointId: ATTEMPT.endpointId,
      status: 'invalid',
      reasonCode: 'SES_PERMANENT_BOUNCE',
    });
    expect(app.store.endpointWrites[0]?.semanticIdempotencyKey).toBe(
      `${SES_MESSAGE_ID}:Bounce:SES_PERMANENT_BOUNCE`,
    );
  });

  test('reprojects a controlled email report after each terminal provider fact', async () => {
    const store = new MemorySesWebhookStore(DELIVERY_TEST_ATTEMPT);
    const app = createHarness(store);
    const correlation = { eventKind: 'drill' as const };
    const send = signedEnvelope({ eventType: 'Send', correlation });
    const delivery = signedEnvelope({
      eventType: 'Delivery',
      snsMessageId: randomUUID(),
      correlation,
    });

    const acceptedResponse = await app.handler(requestForEnvelope(send));
    const deliveredResponse = await app.handler(requestForEnvelope(delivery));
    const replayResponse = await app.handler(requestForEnvelope(delivery));

    expect(acceptedResponse.status).toBe(204);
    expect(deliveredResponse.status).toBe(204);
    expect(replayResponse.status).toBe(204);
    expect(
      store.reportProjectionWrites.map(({ evidence }) => evidence.state),
    ).toEqual(['provider-accepted', 'delivered']);
    expect(
      store.reportProjectionWrites.map(({ attempt }) => attempt.deliveryTest),
    ).toEqual([
      DELIVERY_TEST_ATTEMPT.deliveryTest,
      DELIVERY_TEST_ATTEMPT.deliveryTest,
    ]);
  });

  test('Complaint disables the endpoint without regressing delivery evidence', async () => {
    const app = createHarness();

    const response = await app.handler(
      requestForEnvelope(signedEnvelope({ eventType: 'Complaint' })),
    );

    expect(response.status).toBe(204);
    expect(app.store.evidenceWrites).toHaveLength(0);
    expect(app.store.endpointWrites).toHaveLength(1);
    expect(app.store.reconcileCalls).toBe(1);
    expect(app.store.endpointWrites[0]?.input).toEqual({
      rosterSnapshotId: ATTEMPT.rosterSnapshotId,
      recipientId: ATTEMPT.recipientId,
      endpointId: ATTEMPT.endpointId,
      status: 'disabled',
      reasonCode: 'SES_COMPLAINT',
    });
    expect(app.store.completeCalls).toBe(1);
  });

  test('acknowledges an exact completed replay without a second capability write', async () => {
    const app = createHarness();
    const envelope = signedEnvelope({ eventType: 'Send' });

    const first = await app.handler(requestForEnvelope(envelope));
    const replay = await app.handler(requestForEnvelope(envelope));

    expect(first.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe('');
    expect(app.store.claimCalls).toBe(2);
    expect(app.store.loadAttemptCalls).toBe(1);
    expect(app.store.reconcileCalls).toBe(1);
    expect(app.store.evidenceWrites).toHaveLength(1);
    expect(app.store.endpointWrites).toHaveLength(0);
    expect(app.store.completeCalls).toBe(1);
    expect(app.store.closeCalls).toBe(2);
  });

  test('returns retryable failure for a fresh in-progress duplicate without writes', async () => {
    const app = createHarness();
    const envelope = signedEnvelope({ eventType: 'Send' });
    const parsedEnvelope = parseSnsEnvelope(envelope, TOPIC_ARN);
    const first = await app.store.claimCallback(
      envelope.MessageId,
      canonicalSnsEnvelopeDigest(parsedEnvelope),
    );
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') throw new Error('Expected acquisition.');

    const duplicate = await app.handler(requestForEnvelope(envelope));

    expect(duplicate.status).toBe(503);
    expect(await errorCode(duplicate)).toBe('SNS_CALLBACK_IN_PROGRESS');
    expect(app.store.claimCalls).toBe(2);
    expect(app.store.loadAttemptCalls).toBe(0);
    expect(app.store.evidenceWrites).toHaveLength(0);
    expect(app.store.endpointWrites).toHaveLength(0);
    expect(app.store.completeCalls).toBe(0);
    expect(app.store.failedCallbacks).toHaveLength(0);
    expect(app.store.closeCalls).toBe(1);

    await expect(
      app.store.completeCallback(
        first.recordId,
        first.leaseToken,
        envelope.MessageId,
      ),
    ).resolves.toBeUndefined();
  });

  test('a reacquired failed callback is fenced from its stale owner', async () => {
    const store = new MemorySesWebhookStore();
    const messageId = randomUUID();
    const requestDigest = 'a'.repeat(64);
    const first = await store.claimCallback(messageId, requestDigest);
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') throw new Error('Expected acquisition.');
    await store.failCallback(
      first.recordId,
      first.leaseToken,
      'SYNTHETIC_RETRYABLE_FAILURE',
    );

    const reacquired = await store.claimCallback(messageId, requestDigest);
    expect(reacquired.kind).toBe('acquired');
    if (reacquired.kind !== 'acquired') {
      throw new Error('Expected reacquisition.');
    }
    expect(reacquired.recordId).not.toBe(first.recordId);
    expect(reacquired.leaseToken).not.toBe(first.leaseToken);

    await expect(
      store.completeCallback(first.recordId, first.leaseToken, messageId),
    ).rejects.toThrow('Synthetic stale callback owner.');
    await expect(
      store.failCallback(
        first.recordId,
        first.leaseToken,
        'STALE_OWNER_FAILURE',
      ),
    ).rejects.toThrow('Synthetic stale callback owner.');
    expect(store.completeCalls).toBe(0);
    expect(store.failedCallbacks).toHaveLength(1);

    await expect(
      store.completeCallback(
        reacquired.recordId,
        reacquired.leaseToken,
        messageId,
      ),
    ).resolves.toBeUndefined();
    expect(store.completeCalls).toBe(1);
  });

  test('rejects forged, tampered, and wrong-topic envelopes before store creation', async () => {
    const forgedApp = createHarness();
    const forged = signedEnvelope({ signingKey: attackerKeys.privateKey });
    const forgedResponse = await forgedApp.handler(requestForEnvelope(forged));
    expect(forgedResponse.status).toBe(401);
    expect(await errorCode(forgedResponse)).toBe('SNS_SIGNATURE_INVALID');
    expect(forgedApp.calls.createStore).toBe(0);

    const tamperedApp = createHarness();
    const signed = signedEnvelope({ eventType: 'Send' });
    const tampered = {
      ...signed,
      Message: sesMessage('Delivery'),
    };
    const tamperedResponse = await tamperedApp.handler(
      requestForEnvelope(tampered),
    );
    expect(tamperedResponse.status).toBe(401);
    expect(await errorCode(tamperedResponse)).toBe('SNS_SIGNATURE_INVALID');
    expect(tamperedApp.calls.createStore).toBe(0);

    const wrongTopicApp = createHarness();
    const wrongTopic = signedEnvelope({
      topicArn: 'arn:aws:sns:us-east-1:000000000000:psd-eoc-email-events-other',
    });
    const wrongTopicResponse = await wrongTopicApp.handler(
      requestForEnvelope(wrongTopic),
    );
    expect(wrongTopicResponse.status).toBe(400);
    expect(await errorCode(wrongTopicResponse)).toBe('INVALID_SNS_ENVELOPE');
    expect(wrongTopicApp.calls.verifySignature).toBe(0);
    expect(wrongTopicApp.calls.createStore).toBe(0);
  });

  test('returns a safe retryable response when certificate retrieval is transiently unavailable', async () => {
    const privateDetail = 'Synthetic upstream certificate fetch detail.';
    const verificationError = new SnsSignatureError('CERTIFICATE_UNAVAILABLE');
    verificationError.cause = new Error(privateDetail);
    const app = createHarness(new MemorySesWebhookStore(), verificationError);

    const response = await app.handler(
      requestForEnvelope(signedEnvelope({ eventType: 'Send' })),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'SNS_VERIFICATION_UNAVAILABLE',
        message: 'SNS callback authentication is temporarily unavailable.',
      },
    });
    expect(JSON.stringify(body)).not.toContain('CERTIFICATE_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain(privateDetail);
    expect(app.calls.verifySignature).toBe(1);
    expect(app.calls.createStore).toBe(0);
    expect(app.store.closeCalls).toBe(0);
  });

  test('keeps invalid verifier results unauthorized and non-retryable', async () => {
    for (const verifierCode of [
      'INVALID_CERTIFICATE',
      'INVALID_SIGNATURE',
    ] as const) {
      const app = createHarness(
        new MemorySesWebhookStore(),
        new SnsSignatureError(verifierCode),
      );

      const response = await app.handler(
        requestForEnvelope(signedEnvelope({ eventType: 'Send' })),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('retry-after')).toBeNull();
      expect(await response.json()).toEqual({
        error: {
          code: 'SNS_SIGNATURE_INVALID',
          message: 'The SNS callback signature could not be verified.',
        },
      });
      expect(app.calls.verifySignature).toBe(1);
      expect(app.calls.createStore).toBe(0);
      expect(app.store.closeCalls).toBe(0);
    }
  });

  test('a valid signature with endpoint correlation drift fails closed', async () => {
    const app = createHarness();
    const envelope = signedEnvelope({
      eventType: 'Bounce',
      correlation: { endpointId: randomUUID() },
    });

    const response = await app.handler(requestForEnvelope(envelope));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('SES_CORRELATION_INVALID');
    expect(app.store.evidenceWrites).toHaveLength(0);
    expect(app.store.endpointWrites).toHaveLength(0);
    expect(app.store.failedCallbacks).toEqual([
      expect.objectContaining({ reasonCode: 'SES_CORRELATION_INVALID' }),
    ]);
    expect(app.store.completeCalls).toBe(0);
    expect(app.store.closeCalls).toBe(1);
  });

  test('preserves public delivery-transition failures and their callback reason', async () => {
    const message =
      'Delivery evidence may not transition from delivered to provider-accepted.';
    const store = new FailingEvidenceStore(
      new DeliveryStateError('INVALID_DELIVERY_TRANSITION', 409, message),
    );
    const app = createHarness(store);

    const response = await app.handler(
      requestForEnvelope(signedEnvelope({ eventType: 'Send' })),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_DELIVERY_TRANSITION', message },
    });
    expect(store.failedCallbacks).toEqual([
      expect.objectContaining({ reasonCode: 'INVALID_DELIVERY_TRANSITION' }),
    ]);
    expect(store.completeCalls).toBe(0);
    expect(store.closeCalls).toBe(1);
  });

  test('keeps unknown evidence persistence failures generic and retryable', async () => {
    const store = new FailingEvidenceStore(
      new Error('Synthetic private persistence detail.'),
    );
    const app = createHarness(store);

    const response = await app.handler(
      requestForEnvelope(signedEnvelope({ eventType: 'Send' })),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'SES_WEBHOOK_UNAVAILABLE',
        message: 'SES callback persistence failed safely.',
      },
    });
    expect(store.failedCallbacks).toEqual([
      expect.objectContaining({ reasonCode: 'SES_CALLBACK_PROCESSING_FAILED' }),
    ]);
    expect(store.completeCalls).toBe(0);
    expect(store.closeCalls).toBe(1);
  });

  test('valid Send signatures with immutable correlation drift fail closed', async () => {
    for (const correlation of [
      { rosterSnapshotId: randomUUID() },
      { recipientId: randomUUID() },
      { eventKind: 'drill' as const },
    ]) {
      const app = createHarness();
      const envelope = signedEnvelope({ eventType: 'Send', correlation });

      const response = await app.handler(requestForEnvelope(envelope));

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('SES_CORRELATION_INVALID');
      expect(app.store.evidenceWrites).toHaveLength(0);
      expect(app.store.endpointWrites).toHaveLength(0);
      expect(app.store.completeCalls).toBe(0);
      expect(app.store.closeCalls).toBe(1);
    }
  });

  test('invalid signed message tags fail before opening the store', async () => {
    const app = createHarness();
    const envelope = signedEnvelope({
      correlation: { configurationSet: 'other-configuration-set' },
    });

    const response = await app.handler(requestForEnvelope(envelope));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('INVALID_SES_EVENT');
    expect(app.calls.verifySignature).toBe(1);
    expect(app.calls.createStore).toBe(0);
  });

  test('GET, unsupported content, compression, and oversized bodies fail before stores', async () => {
    const getApp = createHarness();
    const getResponse = await getApp.handler(
      new Request('https://app.example.invalid/api/webhooks/ses'),
    );
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get('allow')).toBe('POST');
    expect(getApp.calls.createStore).toBe(0);

    const envelope = signedEnvelope();
    for (const headers of [
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-encoding': 'gzip' },
    ]) {
      const app = createHarness();
      const response = await app.handler(requestForEnvelope(envelope, headers));
      expect(response.status).toBe(415);
      expect(await errorCode(response)).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(app.calls.createStore).toBe(0);
    }

    const declaredApp = createHarness();
    const declaredResponse = await declaredApp.handler(
      requestForEnvelope(envelope, {
        'content-length': String(SES_WEBHOOK_MAX_BODY_BYTES + 1),
      }),
    );
    expect(declaredResponse.status).toBe(413);
    expect(await errorCode(declaredResponse)).toBe('PAYLOAD_TOO_LARGE');
    expect(declaredApp.calls.createStore).toBe(0);

    const streamedApp = createHarness();
    const streamedResponse = await streamedApp.handler(
      new Request('https://app.example.invalid/api/webhooks/ses', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x'.repeat(SES_WEBHOOK_MAX_BODY_BYTES + 1),
      }),
    );
    expect(streamedResponse.status).toBe(413);
    expect(await errorCode(streamedResponse)).toBe('PAYLOAD_TOO_LARGE');
    expect(streamedApp.calls.createStore).toBe(0);
  });
});
