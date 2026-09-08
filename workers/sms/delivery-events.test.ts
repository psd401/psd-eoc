import { describe, expect, test } from 'bun:test';
import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  type ChannelAttempt,
  type DeliveryEvidence,
} from '@psd-eoc/contracts';

import type {
  AttemptEvidenceWriter,
  DeliveryStateWriteRequest,
} from '../shared/delivery-state-client';
import {
  AWS_EUM_SMS_PROVIDER,
  AwsEumSmsDeliveryEventError,
  SmsDeliveryEventProcessor,
  mapAwsEumSmsDeliveryEvent,
  parseAwsEumSmsDeliveryEvent,
  type SmsDeliveryAttemptLookup,
} from './delivery-events';

const IDS = Object.freeze({
  batch: '00000000-0000-4000-8000-000000000101',
  intent: '00000000-0000-4000-8000-000000000102',
  event: '00000000-0000-4000-8000-000000000103',
  type: '00000000-0000-4000-8000-000000000104',
  roster: '00000000-0000-4000-8000-000000000105',
  recipient: '00000000-0000-4000-8000-000000000106',
  endpoint: '00000000-0000-4000-8000-000000000107',
  attempt: '00000000-0000-4000-8000-000000000108',
  eventBridge: '00000000-0000-4000-8000-000000000109',
  evidence: '00000000-0000-4000-8000-000000000110',
  correlation: '00000000-0000-4000-8000-000000000111',
});

const NOW = new Date('2026-08-11T18:00:00.000Z');
const OCCURRED_AT = new Date('2026-08-11T17:59:00.000Z').getTime();
const CONFIGURATION = Object.freeze({
  accountId: '000000000000',
  region: 'us-east-1',
  eventBridgeRuleArn:
    'arn:aws:events:us-east-1:000000000000:rule/psd-eoc-sms-delivery',
  clock: () => new Date(NOW),
});
const TRUSTED_INVOCATION = Symbol('trusted-eventbridge-invocation');
const INVOCATION = Object.freeze({
  requestId: '00000000-0000-4000-8000-000000000112',
  ruleArn: CONFIGURATION.eventBridgeRuleArn,
  authorization: TRUSTED_INVOCATION,
});

function authorizeInvocation(invocation: { readonly authorization: unknown }) {
  return invocation.authorization === TRUSTED_INVOCATION;
}

function attempt(): ChannelAttempt {
  return ChannelAttemptSchema.parse({
    id: IDS.attempt,
    batchId: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    eventKind: 'incident',
    templateMode: 'real',
    purpose: 'activation',
    eventTypeVersion: { id: IDS.type, templateMode: 'real' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'staff',
    recipientId: IDS.recipient,
    endpointId: IDS.endpoint,
    channel: 'sms',
    attemptNumber: 1,
    attemptedAt: '2026-08-11T17:58:00.000Z',
  });
}

function deliveryEvent(
  status: string,
  options: Readonly<{
    final?: boolean;
    attemptId?: string | null;
    account?: string;
    eventType?: string;
  }> = {},
): unknown {
  const context =
    options.attemptId === null
      ? undefined
      : {
          psdAttemptId: options.attemptId ?? IDS.attempt,
          psdProviderClaimToken: IDS.correlation,
        };
  return {
    version: '0',
    id: IDS.eventBridge,
    'detail-type': 'Text Message Delivery Status Updated',
    source: 'aws.sms-voice',
    account: options.account ?? CONFIGURATION.accountId,
    time: '2026-08-11T17:59:00.000Z',
    region: CONFIGURATION.region,
    resources: [],
    detail: {
      eventType: options.eventType ?? `TEXT_${status}`,
      eventVersion: '1.0',
      eventTimestamp: OCCURRED_AT,
      isFinal: options.final ?? true,
      originationPhoneNumber: '+12025550199',
      destinationPhoneNumber: '+12025550198',
      messageId: 'synthetic-provider-message-1',
      messageRequestTimestamp: OCCURRED_AT - 500,
      messageType: 'TRANSACTIONAL',
      messageStatus: status,
      messageStatusDescription: 'Untrusted provider text is discarded.',
      ...(context === undefined ? {} : { context }),
    },
  };
}

describe('AWS EUM SMS delivery event truth mapping', () => {
  test('keeps carrier acceptance separate from device delivery', () => {
    const accepted = mapAwsEumSmsDeliveryEvent(
      deliveryEvent('SUCCESSFUL'),
      CONFIGURATION,
      IDS.attempt,
    );
    expect(accepted).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({
          state: 'provider-accepted',
          provider: AWS_EUM_SMS_PROVIDER,
          providerReference: 'synthetic-provider-message-1',
          proof: null,
        }),
      }),
    );

    const delivered = mapAwsEumSmsDeliveryEvent(
      deliveryEvent('DELIVERED'),
      CONFIGURATION,
      IDS.attempt,
    );
    expect(delivered).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({
          state: 'delivered',
          proof: {
            kind: 'provider-delivery-receipt',
            provider: AWS_EUM_SMS_PROVIDER,
            receiptId: IDS.eventBridge,
            deliveredAt: '2026-08-11T17:59:00.000Z',
          },
        }),
      }),
    );
  });

  test.each([
    ['CARRIER_BLOCKED', 'AWS_CARRIER_FILTERED'],
    ['SPAM', 'AWS_SPAM_FILTERED'],
    ['BLOCKED', 'AWS_RECIPIENT_BLOCKED'],
    ['PROTECT_BLOCKED', 'AWS_PROTECT_BLOCKED'],
  ])('surfaces provider filtering %s as failed %s', (status, reasonCode) => {
    const mapping = mapAwsEumSmsDeliveryEvent(
      deliveryEvent(status),
      CONFIGURATION,
      IDS.attempt,
    );
    expect(mapping).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({ state: 'failed', reasonCode }),
      }),
    );
  });

  test('records provider uncertainty and future statuses as explicit unknown', () => {
    const unknown = mapAwsEumSmsDeliveryEvent(
      deliveryEvent('UNKNOWN'),
      CONFIGURATION,
      IDS.attempt,
    );
    expect(unknown).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({
          state: 'unknown',
          reasonCode: 'AWS_STATUS_UNKNOWN',
        }),
      }),
    );

    const future = mapAwsEumSmsDeliveryEvent(
      deliveryEvent('FUTURE_PROVIDER_STATE'),
      CONFIGURATION,
      IDS.attempt,
    );
    expect(future).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({
          state: 'unknown',
          reasonCode: 'AWS_STATUS_UNRECOGNIZED',
        }),
      }),
    );
  });

  test('retains non-final filtering as unknown and rejects scope or correlation drift', () => {
    expect(
      mapAwsEumSmsDeliveryEvent(
        deliveryEvent('CARRIER_BLOCKED', { final: false }),
        CONFIGURATION,
        IDS.attempt,
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({
          state: 'unknown',
          reasonCode: 'AWS_CARRIER_FILTERING_NOT_FINAL',
        }),
      }),
    );

    expect(() =>
      parseAwsEumSmsDeliveryEvent(
        deliveryEvent('DELIVERED', { account: '111111111111' }),
        CONFIGURATION,
      ),
    ).toThrow(AwsEumSmsDeliveryEventError);

    expect(() =>
      mapAwsEumSmsDeliveryEvent(
        deliveryEvent('DELIVERED', {
          attemptId: '00000000-0000-4000-8000-000000000999',
        }),
        CONFIGURATION,
        IDS.attempt,
      ),
    ).toThrow(AwsEumSmsDeliveryEventError);

    expect(() =>
      mapAwsEumSmsDeliveryEvent(
        deliveryEvent('DELIVERED', { attemptId: null }),
        CONFIGURATION,
        IDS.attempt,
      ),
    ).toThrow(AwsEumSmsDeliveryEventError);
  });

  test('treats mismatched eventType and status as unknown instead of dropping it', () => {
    const mapping = mapAwsEumSmsDeliveryEvent(
      deliveryEvent('SUCCESSFUL', { eventType: 'TEXT_DELIVERED' }),
      CONFIGURATION,
      IDS.attempt,
    );
    expect(mapping).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({
          state: 'unknown',
          reasonCode: 'AWS_STATUS_UNRECOGNIZED',
        }),
      }),
    );
  });

  test('uses the EventBridge envelope time when optional provider time is absent', () => {
    const value = deliveryEvent('DELIVERED') as {
      detail: Record<string, unknown>;
    };
    delete value.detail.eventTimestamp;

    const mapping = mapAwsEumSmsDeliveryEvent(
      value,
      CONFIGURATION,
      IDS.attempt,
    );
    expect(mapping).toEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidence: expect.objectContaining({
          state: 'delivered',
          proof: expect.objectContaining({
            deliveredAt: '2026-08-11T17:59:00.000Z',
          }),
        }),
      }),
    );
  });
});

class MemoryLookup implements SmsDeliveryAttemptLookup {
  public providerReferenceCalls = 0;
  public unknownAttemptCalls = 0;

  public constructor(
    private readonly providerReferenceValue: ChannelAttempt | null,
    private readonly unknownAttemptValue: ChannelAttempt | null = providerReferenceValue,
  ) {}

  public loadAttemptByProviderReference(
    provider: typeof AWS_EUM_SMS_PROVIDER,
    providerReference: string,
  ): Promise<ChannelAttempt | null> {
    this.providerReferenceCalls += 1;
    expect(provider).toBe(AWS_EUM_SMS_PROVIDER);
    expect(providerReference).toBe('synthetic-provider-message-1');
    return Promise.resolve(this.providerReferenceValue);
  }

  public loadUnknownAttemptById(
    provider: typeof AWS_EUM_SMS_PROVIDER,
    attemptId: string,
    correlationToken: string,
  ): Promise<ChannelAttempt | null> {
    this.unknownAttemptCalls += 1;
    expect(provider).toBe(AWS_EUM_SMS_PROVIDER);
    expect(attemptId).toBe(IDS.attempt);
    expect(correlationToken).toBe(IDS.correlation);
    return Promise.resolve(this.unknownAttemptValue);
  }
}

class MemoryWriter implements AttemptEvidenceWriter {
  public readonly requests: DeliveryStateWriteRequest[] = [];

  public recordAttemptEvidence(
    value: DeliveryStateWriteRequest | unknown,
  ): Promise<DeliveryEvidence> {
    const request = value as DeliveryStateWriteRequest;
    this.requests.push(request);
    return Promise.resolve(
      DeliveryEvidenceSchema.parse({
        id: IDS.evidence,
        subject: request.evidence.subject,
        sequence: 2,
        previousEvidenceId: '00000000-0000-4000-8000-000000000111',
        state: request.evidence.state,
        recordedAt: '2026-08-11T18:00:00.000Z',
        provider: request.evidence.provider,
        providerReference: request.evidence.providerReference,
        proof: request.evidence.proof,
        reasonCode: request.evidence.reasonCode,
        diagnosticDigest: request.evidence.diagnosticDigest,
      }),
    );
  }
}

describe('SMS delivery event processor', () => {
  test('correlates by MessageId and appends canonical evidence', async () => {
    const writer = new MemoryWriter();
    const lookup = new MemoryLookup(attempt());
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: lookup,
      evidenceWriter: writer,
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(deliveryEvent('DELIVERED'), INVOCATION),
    ).resolves.toEqual(expect.objectContaining({ kind: 'recorded' }));
    expect(writer.requests).toHaveLength(1);
    expect(writer.requests[0]).toEqual(
      expect.objectContaining({
        attempt: expect.objectContaining({ id: IDS.attempt, channel: 'sms' }),
        evidence: expect.objectContaining({ state: 'delivered' }),
      }),
    );
    expect(lookup.providerReferenceCalls).toBe(1);
    expect(lookup.unknownAttemptCalls).toBe(0);
  });

  test('recovers late proof by authenticated attempt context only after an unknown no-reference send', async () => {
    const writer = new MemoryWriter();
    const lookup = new MemoryLookup(null, attempt());
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: lookup,
      evidenceWriter: writer,
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(deliveryEvent('DELIVERED'), INVOCATION),
    ).resolves.toEqual(expect.objectContaining({ kind: 'recorded' }));
    expect(lookup.providerReferenceCalls).toBe(1);
    expect(lookup.unknownAttemptCalls).toBe(1);
    expect(writer.requests[0]?.evidence).toEqual(
      expect.objectContaining({
        subject: { kind: 'attempt', attemptId: IDS.attempt },
        state: 'delivered',
        provider: AWS_EUM_SMS_PROVIDER,
        providerReference: 'synthetic-provider-message-1',
      }),
    );
  });

  test('correlates a receipt that carries no context by MessageId alone', async () => {
    // AWS End User Messaging publishes EventBridge delivery events without
    // the send's Context, so a live receipt names only its MessageId. The
    // first production delivery (2026-09-08) was refused for that.
    const writer = new MemoryWriter();
    const lookup = new MemoryLookup(attempt());
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: lookup,
      evidenceWriter: writer,
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(
        deliveryEvent('DELIVERED', { attemptId: null }),
        INVOCATION,
      ),
    ).resolves.toEqual(expect.objectContaining({ kind: 'recorded' }));
    expect(lookup.providerReferenceCalls).toBe(1);
    expect(lookup.unknownAttemptCalls).toBe(0);
    expect(writer.requests).toHaveLength(1);
    expect(writer.requests[0]).toEqual(
      expect.objectContaining({
        attempt: expect.objectContaining({ id: IDS.attempt, channel: 'sms' }),
        evidence: expect.objectContaining({
          subject: { kind: 'attempt', attemptId: IDS.attempt },
          state: 'delivered',
          providerReference: 'synthetic-provider-message-1',
        }),
      }),
    );
  });

  test('reports a context-free receipt that names no retained send as unmatched instead of failing', async () => {
    // A text this system never sent (an account verification message, for
    // example) produces the same receipt shape. Retrying cannot make it match.
    const writer = new MemoryWriter();
    const lookup = new MemoryLookup(null, attempt());
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: lookup,
      evidenceWriter: writer,
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(
        deliveryEvent('DELIVERED', { attemptId: null }),
        INVOCATION,
      ),
    ).resolves.toEqual(expect.objectContaining({ kind: 'unmatched' }));
    expect(lookup.providerReferenceCalls).toBe(1);
    expect(lookup.unknownAttemptCalls).toBe(0);
    expect(writer.requests).toHaveLength(0);
  });

  test('still refuses a receipt whose context names a different attempt than its MessageId', async () => {
    const lookup = new MemoryLookup(attempt());
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: lookup,
      evidenceWriter: new MemoryWriter(),
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(
        deliveryEvent('DELIVERED', { attemptId: IDS.evidence }),
        INVOCATION,
      ),
    ).rejects.toMatchObject({ code: 'ATTEMPT_MISMATCH' });
  });

  test('fails closed for uncorrelated provider events', async () => {
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: new MemoryLookup(null),
      evidenceWriter: new MemoryWriter(),
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(deliveryEvent('DELIVERED'), INVOCATION),
    ).rejects.toEqual(expect.objectContaining({ code: 'ATTEMPT_NOT_READY' }));
  });

  test('never uses the deterministic attempt id alone for unknown-send recovery', async () => {
    const lookup = new MemoryLookup(null, attempt());
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: lookup,
      evidenceWriter: new MemoryWriter(),
      authorizeEventBridgeInvocation: authorizeInvocation,
    });
    const value = deliveryEvent('DELIVERED') as {
      detail: { context: Record<string, unknown> };
    };
    delete value.detail.context.psdProviderClaimToken;

    await expect(processor.process(value, INVOCATION)).rejects.toMatchObject({
      code: 'ATTEMPT_NOT_FOUND',
    });
    expect(lookup.providerReferenceCalls).toBe(1);
    expect(lookup.unknownAttemptCalls).toBe(0);
  });

  test('appends non-final carrier filtering instead of dropping it', async () => {
    const writer = new MemoryWriter();
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: new MemoryLookup(attempt()),
      evidenceWriter: writer,
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(
        deliveryEvent('CARRIER_BLOCKED', { final: false }),
        INVOCATION,
      ),
    ).resolves.toEqual(expect.objectContaining({ kind: 'recorded' }));
    expect(writer.requests[0]?.evidence).toEqual(
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'AWS_CARRIER_FILTERING_NOT_FINAL',
      }),
    );
  });

  test('rejects an unverified invocation before lookup or evidence writes', async () => {
    const writer = new MemoryWriter();
    const lookup = new MemoryLookup(attempt());
    const processor = new SmsDeliveryEventProcessor({
      configuration: CONFIGURATION,
      attempts: lookup,
      evidenceWriter: writer,
      authorizeEventBridgeInvocation: authorizeInvocation,
    });

    await expect(
      processor.process(deliveryEvent('DELIVERED'), {
        ...INVOCATION,
        authorization: Symbol('forged'),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVOCATION_UNVERIFIED' }),
    );
    expect(lookup.providerReferenceCalls).toBe(0);
    expect(lookup.unknownAttemptCalls).toBe(0);
    expect(writer.requests).toHaveLength(0);
  });

  test('fails closed before lookup when rule identity drifts or authorization throws', async () => {
    for (const options of [
      {
        invocation: {
          ...INVOCATION,
          ruleArn:
            'arn:aws:events:us-east-1:000000000000:rule/forged-sms-delivery',
        },
        authorize: authorizeInvocation,
      },
      {
        invocation: INVOCATION,
        authorize: () => {
          throw new Error('synthetic authorizer failure');
        },
      },
    ]) {
      const lookup = new MemoryLookup(attempt());
      const writer = new MemoryWriter();
      const processor = new SmsDeliveryEventProcessor({
        configuration: CONFIGURATION,
        attempts: lookup,
        evidenceWriter: writer,
        authorizeEventBridgeInvocation: options.authorize,
      });

      await expect(
        processor.process(deliveryEvent('DELIVERED'), options.invocation),
      ).rejects.toEqual(
        expect.objectContaining({ code: 'INVOCATION_UNVERIFIED' }),
      );
      expect(lookup.providerReferenceCalls).toBe(0);
      expect(lookup.unknownAttemptCalls).toBe(0);
      expect(writer.requests).toHaveLength(0);
    }
  });
});
