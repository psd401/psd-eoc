import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  DispatchBatchSchema,
  EndpointStatusRecordSchema,
  EndpointSchema,
  SmsOptOutRecordSchema,
  type DeliveryEvidence,
} from '@psd-eoc/contracts';

import {
  workerAttemptFingerprint,
  type AttemptEvidenceWriter,
  type AttemptExecutionClaim,
  type AttemptExecutionLookup,
  type AttemptExecutionLookupRequest,
  type AttemptExecutionStore,
  type DeliveryStateWriteRequest,
  type WorkerAttemptWorkItem,
} from '../shared';
import { IDS, TIMES, attemptFor, realBatch } from '../shared/test-fixtures';
import type {
  AwsEumSmsLedgerClaim,
  AwsEumSmsLedgerLookup,
  AwsEumSmsSendLedger,
} from './aws-eum-adapter';
import type { SmsDeliveryAttemptLookup } from './delivery-events';
import type { SmsOptOutDestinationResolver } from './opt-out';
import {
  createAwsEumSmsRuntime,
  type SmsCanonicalCapabilityExecutor,
  type SmsLifecycleCapabilityRequest,
  type SmsQueueInvocation,
  type SmsRuntimeMode,
  type SmsScheduledInvocation,
} from './runtime';

const ACCOUNT_ID = '000000000000';
const REGION = 'us-west-2';
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:psd-eoc-sms`;
const SCHEDULE_RULE_ARN = `arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/psd-eoc-sms-opt-outs`;
const DELIVERY_RULE_ARN = `arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/psd-eoc-sms-delivery`;
const OPT_OUT_LIST = Object.freeze({
  name: 'SyntheticList',
  arn: `arn:aws:sms-voice:${REGION}:${ACCOUNT_ID}:opt-out-list/SyntheticList`,
});
const TRUSTED_QUEUE = Symbol('trusted-queue');
const TRUSTED_SCHEDULE = Symbol('trusted-schedule');
const TRUSTED_DELIVERY = Symbol('trusted-delivery');
const TRUSTED_OPT_IN = Symbol('trusted-opt-in');

const QUEUE_INVOCATION = Object.freeze({
  requestId: '00000000-0000-4000-8000-000000000301',
  sourceArn: QUEUE_ARN,
  authorization: TRUSTED_QUEUE,
});
const SCHEDULE_INVOCATION = Object.freeze({
  requestId: '00000000-0000-4000-8000-000000000302',
  ruleArn: SCHEDULE_RULE_ARN,
  authorization: TRUSTED_SCHEDULE,
});

function deliveredEvent(): unknown {
  const occurredAt = new Date('2026-08-10T16:00:01.500Z').getTime();
  return {
    version: '0',
    id: '00000000-0000-4000-8000-000000000306',
    'detail-type': 'Text Message Delivery Status Updated',
    source: 'aws.sms-voice',
    account: ACCOUNT_ID,
    time: '2026-08-10T16:00:01.500Z',
    region: REGION,
    resources: [],
    detail: {
      eventType: 'TEXT_DELIVERED',
      eventVersion: '1.0',
      eventTimestamp: occurredAt,
      isFinal: true,
      originationPhoneNumber: '+12025550199',
      destinationPhoneNumber: '+12025550123',
      messageId: 'synthetic-late-provider-message-id',
      messageRequestTimestamp: occurredAt - 500,
      messageType: 'TRANSACTIONAL',
      messageStatus: 'DELIVERED',
      messageStatusDescription: 'Synthetic delivery proof.',
      context: { psdAttemptId: IDS.attempt },
    },
  };
}

function smsWorkItem(): WorkerAttemptWorkItem {
  const base = realBatch();
  const batch = DispatchBatchSchema.parse({
    ...base,
    channel: 'sms',
    renderedMessage: {
      eventKind: 'incident',
      templateMode: 'real',
      purpose: 'activation',
      classificationMarker: 'INCIDENT',
      channel: 'sms',
      body: '[INCIDENT] REAL INCIDENT - ACTIVATION: Synthetic test. [INCIDENT]',
    },
    integrationStatus: {
      ...base.integrationStatus,
      integrationId: 'aws-eum-sms',
    },
  });
  return Object.freeze({
    batch,
    attempt: attemptFor(batch),
    endpoint: EndpointSchema.parse({
      id: IDS.endpoint,
      status: 'active',
      capturedAt: TIMES.created,
      channel: 'sms',
      phoneNumber: '+12025550123',
    }),
  });
}

function noNetworkTransport() {
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
      return Promise.reject(new Error('Unexpected synthetic AWS wire I/O.'));
    },
  };
}

function providerResponseTransport(
  response: Readonly<Record<string, unknown>>,
) {
  return {
    requests: 0,
    metadata: { handlerProtocol: 'http/1.1' as const },
    updateHttpClientConfig(): void {},
    httpHandlerConfigs(): Record<string, never> {
      return {};
    },
    destroy(): void {},
    handle() {
      this.requests += 1;
      return Promise.resolve({
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/x-amz-json-1.0' },
          body: new TextEncoder().encode(JSON.stringify(response)),
        },
      });
    },
  };
}

class ExecutionStore implements AttemptExecutionStore {
  public lookupCalls = 0;
  public claimCalls = 0;
  public completeCalls = 0;
  public releaseCalls = 0;
  public lastLookup: AttemptExecutionLookupRequest | null = null;

  public constructor(
    private readonly recovered: AttemptExecutionLookup = { kind: 'missing' },
  ) {}

  public lookup(
    request: AttemptExecutionLookupRequest,
  ): Promise<AttemptExecutionLookup> {
    this.lookupCalls += 1;
    this.lastLookup = request;
    return Promise.resolve(this.recovered);
  }

  public claim(): Promise<AttemptExecutionClaim> {
    this.claimCalls += 1;
    return Promise.resolve({
      kind: 'acquired',
      leaseToken: 'synthetic-outer-lease',
    });
  }

  public complete(): Promise<void> {
    this.completeCalls += 1;
    return Promise.resolve();
  }

  public release(): Promise<void> {
    this.releaseCalls += 1;
    return Promise.resolve();
  }
}

class SmsSendLedger implements AwsEumSmsSendLedger {
  public lookupCalls = 0;
  public claimCalls = 0;
  public completeCalls = 0;

  public lookup(): Promise<AwsEumSmsLedgerLookup> {
    this.lookupCalls += 1;
    return Promise.resolve({ kind: 'missing' });
  }

  public claim(): Promise<AwsEumSmsLedgerClaim> {
    this.claimCalls += 1;
    return Promise.resolve({
      kind: 'acquired',
      leaseToken: 'synthetic-provider-lease',
    });
  }

  public complete(): Promise<void> {
    this.completeCalls += 1;
    return Promise.resolve();
  }
}

class EvidenceWriter implements AttemptEvidenceWriter {
  public readonly requests: DeliveryStateWriteRequest[] = [];

  public recordAttemptEvidence(
    value: DeliveryStateWriteRequest | unknown,
  ): Promise<DeliveryEvidence> {
    const request = value as DeliveryStateWriteRequest;
    this.requests.push(request);
    const sequence = this.requests.length;
    return Promise.resolve(
      DeliveryEvidenceSchema.parse({
        id: `00000000-0000-4000-8000-${String(400 + sequence).padStart(12, '0')}`,
        subject: request.evidence.subject,
        sequence,
        previousEvidenceId:
          sequence === 1 ? null : '00000000-0000-4000-8000-000000000401',
        state: request.evidence.state,
        recordedAt: TIMES.recorded,
        provider: request.evidence.provider,
        providerReference: request.evidence.providerReference,
        proof: request.evidence.proof,
        reasonCode: request.evidence.reasonCode,
        diagnosticDigest: request.evidence.diagnosticDigest,
      }),
    );
  }
}

class CapabilityExecutor implements SmsCanonicalCapabilityExecutor {
  public readonly requests: SmsLifecycleCapabilityRequest[] = [];

  public execute(request: SmsLifecycleCapabilityRequest): Promise<unknown> {
    this.requests.push(request);
    if (request.capabilityId === 'record-sms-opt-out') {
      return Promise.resolve(
        SmsOptOutRecordSchema.parse({
          id: '00000000-0000-4000-8000-000000000403',
          ...request.input,
          recordedAt: TIMES.recorded,
        }),
      );
    }
    return Promise.resolve(
      EndpointStatusRecordSchema.parse({
        id: '00000000-0000-4000-8000-000000000404',
        ...request.input,
        recordedAt: TIMES.recorded,
      }),
    );
  }
}

interface HarnessOverrides {
  readonly executionStore?: ExecutionStore;
  readonly mode?: SmsRuntimeMode;
  readonly optOutList?: unknown;
  readonly providerResponse?: Readonly<Record<string, unknown>>;
  readonly resolveDestination?: boolean;
}

function harness(overrides: HarnessOverrides = {}) {
  const transport =
    overrides.providerResponse === undefined
      ? noNetworkTransport()
      : providerResponseTransport(overrides.providerResponse);
  const executionStore = overrides.executionStore ?? new ExecutionStore();
  const sendLedger = new SmsSendLedger();
  const evidenceWriter = new EvidenceWriter();
  const capabilities = new CapabilityExecutor();
  const counters = {
    queueAuthorizations: 0,
    scheduleAuthorizations: 0,
    deliveryAuthorizations: 0,
    optInAuthorizations: 0,
    destinationLookups: 0,
    deliveryLookups: 0,
  };
  const destinationResolver: SmsOptOutDestinationResolver = {
    resolveSmsDestination(input) {
      counters.destinationLookups += 1;
      return Promise.resolve(
        overrides.resolveDestination === true &&
          input.phoneNumber === '+12025550123'
          ? {
              rosterSnapshotId: input.rosterSnapshotId,
              recipientId: IDS.recipient,
              endpointId: IDS.endpoint,
            }
          : null,
      );
    },
  };
  const attempts: SmsDeliveryAttemptLookup = {
    loadAttemptByProviderReference() {
      counters.deliveryLookups += 1;
      return Promise.resolve(null);
    },
    loadUnknownAttemptById(provider, attemptId) {
      counters.deliveryLookups += 1;
      const latestEvidence = evidenceWriter.requests.at(-1)?.evidence;
      return Promise.resolve(
        provider === 'aws-eum-sms' &&
          attemptId === IDS.attempt &&
          latestEvidence?.state === 'unknown' &&
          latestEvidence.provider === provider &&
          latestEvidence.providerReference === null
          ? smsWorkItem().attempt
          : null,
      );
    },
  };

  const runtime = createAwsEumSmsRuntime({
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
    awsClient: {
      region: REGION,
      credentials: {
        accessKeyId: 'SYNTHETICACCESSKEY',
        secretAccessKey: 'synthetic-credential-never-used',
      },
      requestHandler: transport,
    },
    adapter: {
      ledger: sendLedger,
      originationIdentity: `arn:aws:sms-voice:${REGION}:${ACCOUNT_ID}:phone-number/synthetic`,
      configurationSetName: 'psd-eoc-sms',
      protectConfigurationId: 'protect-synthetic',
      maxPrice: '0.05',
      timeToLiveSeconds: 300,
    },
    executionStore,
    evidenceWriter,
    attempts,
    capabilities,
    destinationResolver,
    optOutList: (overrides.optOutList ?? OPT_OUT_LIST) as typeof OPT_OUT_LIST,
    queueArn: QUEUE_ARN,
    scheduleRuleArn: SCHEDULE_RULE_ARN,
    authorizeQueueInvocation(invocation: SmsQueueInvocation) {
      counters.queueAuthorizations += 1;
      return invocation.authorization === TRUSTED_QUEUE;
    },
    authorizeScheduledInvocation(invocation: SmsScheduledInvocation) {
      counters.scheduleAuthorizations += 1;
      return invocation.authorization === TRUSTED_SCHEDULE;
    },
    authorizeOptInInvocation(invocation) {
      counters.optInAuthorizations += 1;
      return invocation.authorization === TRUSTED_OPT_IN;
    },
    deliveryConfiguration: {
      accountId: ACCOUNT_ID,
      region: REGION,
      eventBridgeRuleArn: DELIVERY_RULE_ARN,
      clock: () => new Date('2026-08-11T18:00:00.000Z'),
    },
    authorizeEventBridgeInvocation(invocation) {
      counters.deliveryAuthorizations += 1;
      return invocation.authorization === TRUSTED_DELIVERY;
    },
  });

  return {
    runtime,
    transport,
    executionStore,
    sendLedger,
    evidenceWriter,
    capabilities,
    counters,
  };
}

function expectNoProviderIo(value: ReturnType<typeof harness>): void {
  expect(value.transport.requests).toBe(0);
  expect(value.sendLedger.lookupCalls).toBe(0);
  expect(value.sendLedger.claimCalls).toBe(0);
  expect(value.sendLedger.completeCalls).toBe(0);
}

describe('AWS EUM SMS production runtime boundary', () => {
  test('construction is network-free and omission of mode keeps the runtime dark', async () => {
    const value = harness();

    expectNoProviderIo(value);
    await expect(
      value.runtime.processQueueAttempt(smsWorkItem(), QUEUE_INVOCATION),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'LIVE_PROVIDER_DISABLED' }),
    );
    expect(value.executionStore.lookupCalls).toBe(1);
    expect(value.executionStore.claimCalls).toBe(0);
    expect(value.evidenceWriter.requests).toHaveLength(0);
    expect(value.capabilities.requests).toHaveLength(0);
    expectNoProviderIo(value);
  });

  test('copies dark configuration so later caller mutation cannot enable AWS reads', async () => {
    const mutableMode: { state: string } = { state: 'dark' };
    const value = harness({ mode: mutableMode as SmsRuntimeMode });
    mutableMode.state = 'enabled';

    await expect(
      value.runtime.reconcileOptOuts(
        { rosterSnapshotId: IDS.roster },
        SCHEDULE_INVOCATION,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    expect(value.counters.scheduleAuthorizations).toBe(1);
    expect(value.counters.destinationLookups).toBe(0);
    expectNoProviderIo(value);
  });

  test('rejects malformed or partially enabled runtime modes before I/O', () => {
    for (const mode of [
      { state: 'unexpected' },
      { state: 'enabled', authorizeLiveProvider: () => true },
      { state: 'enabled', authorizeLiveSend: () => true },
    ]) {
      expect(() => harness({ mode: mode as SmsRuntimeMode })).toThrow(
        'runtime request was rejected safely',
      );
    }

    expect(() =>
      harness({
        optOutList: {
          name: OPT_OUT_LIST.name,
          arn: `arn:aws:sms-voice:${REGION}:${ACCOUNT_ID}:opt-out-list/OtherList`,
        },
      }),
    ).toThrow('runtime request was rejected safely');
  });

  test('rejects a forged queue invocation before stores, evidence, capabilities, or AWS I/O', async () => {
    const value = harness();

    await expect(
      value.runtime.processQueueAttempt(smsWorkItem(), {
        ...QUEUE_INVOCATION,
        authorization: Symbol('forged-queue'),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVOCATION_UNVERIFIED' }),
    );
    expect(value.counters.queueAuthorizations).toBe(1);
    expect(value.executionStore.lookupCalls).toBe(0);
    expect(value.executionStore.claimCalls).toBe(0);
    expect(value.evidenceWriter.requests).toHaveLength(0);
    expect(value.capabilities.requests).toHaveLength(0);
    expectNoProviderIo(value);
  });

  test('replays retained opt-out completion in dark mode through the exact canonical capability', async () => {
    const workItem = smsWorkItem();
    const executionStore = new ExecutionStore({
      kind: 'completed',
      completion: {
        kind: 'final',
        outcome: {
          state: 'failed',
          provider: 'aws-eum-sms',
          providerReference: 'synthetic-provider-request-id',
          proof: null,
          reasonCode: 'DESTINATION_PHONE_NUMBER_OPTED_OUT',
          diagnosticDigest: 'a'.repeat(64),
        },
      },
    });
    const value = harness({ executionStore });

    const result = await value.runtime.processQueueAttempt(
      workItem,
      QUEUE_INVOCATION,
    );

    expect(result.attemptResult).toEqual(
      expect.objectContaining({ kind: 'dlq', replayed: true }),
    );
    expect(result.optOutRecord).toEqual(
      expect.objectContaining({ endpointId: IDS.endpoint }),
    );
    expect(executionStore.lastLookup).toEqual({
      attemptId: IDS.attempt,
      fingerprint: workerAttemptFingerprint(workItem),
    });
    expect(executionStore.claimCalls).toBe(0);
    expect(value.evidenceWriter.requests).toHaveLength(2);
    expect(value.capabilities.requests).toEqual([
      {
        capabilityId: 'record-sms-opt-out',
        context: {
          actor: { kind: 'system', serviceId: 'sms-worker' },
          source: 'worker',
          transport: 'sqs',
          requestId: QUEUE_INVOCATION.requestId,
          authenticated: true,
        },
        input: {
          rosterSnapshotId: IDS.roster,
          recipientId: IDS.recipient,
          endpointId: IDS.endpoint,
          provider: 'aws-eum-sms',
          providerReference: 'synthetic-provider-request-id',
          providerOccurredAt: TIMES.recorded,
        },
      },
    ]);
    expectNoProviderIo(value);
  });

  test('rejects authenticated scheduled reconciliation while dark before AWS I/O', async () => {
    const value = harness();

    await expect(
      value.runtime.reconcileOptOuts(
        { rosterSnapshotId: IDS.roster },
        SCHEDULE_INVOCATION,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'AwsEumSmsRuntimeError',
        code: 'FEATURE_DISABLED',
      }),
    );
    expect(value.counters.scheduleAuthorizations).toBe(1);
    expect(value.counters.destinationLookups).toBe(0);
    expect(value.capabilities.requests).toHaveLength(0);
    expectNoProviderIo(value);
  });

  test('rejects a wrong scheduled rule ARN before authorization or AWS I/O', async () => {
    const value = harness();

    await expect(
      value.runtime.reconcileOptOuts(
        { rosterSnapshotId: IDS.roster },
        {
          ...SCHEDULE_INVOCATION,
          ruleArn: `arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/forged-schedule`,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVOCATION_UNVERIFIED' }),
    );
    expect(value.counters.scheduleAuthorizations).toBe(0);
    expect(value.counters.destinationLookups).toBe(0);
    expectNoProviderIo(value);
  });

  test('binds scheduled opt-out writes to the exact authenticated schedule invocation', async () => {
    const occurredAt = new Date(TIMES.attempted);
    const value = harness({
      mode: {
        state: 'enabled',
        authorizeLiveProvider: () => true,
        authorizeLiveSend: () => true,
      },
      resolveDestination: true,
      providerResponse: {
        OptOutListArn: OPT_OUT_LIST.arn,
        OptOutListName: OPT_OUT_LIST.name,
        OptedOutNumbers: [
          {
            EndUserOptedOut: true,
            OptedOutNumber: '+12025550123',
            OptedOutTimestamp: occurredAt.getTime() / 1_000,
          },
        ],
      },
    });

    await expect(
      value.runtime.reconcileOptOuts(
        { rosterSnapshotId: IDS.roster },
        SCHEDULE_INVOCATION,
      ),
    ).resolves.toEqual({
      examinedCount: 1,
      recordedCount: 1,
      unresolvedCount: 0,
      pageCount: 1,
      continuationToken: null,
    });
    expect(value.capabilities.requests).toEqual([
      {
        capabilityId: 'record-sms-opt-out',
        context: {
          actor: { kind: 'system', serviceId: 'sms-opt-out-reconciler' },
          source: 'scheduled-job',
          transport: 'scheduled-execution',
          requestId: SCHEDULE_INVOCATION.requestId,
          authenticated: true,
        },
        input: {
          rosterSnapshotId: IDS.roster,
          recipientId: IDS.recipient,
          endpointId: IDS.endpoint,
          provider: 'aws-eum-sms',
          providerReference: `opt-out:${OPT_OUT_LIST.arn}:${occurredAt.getTime()}`,
          providerOccurredAt: occurredAt.toISOString(),
        },
      },
    ]);
    expect(value.transport.requests).toBe(1);
  });

  test('binds verified START writes to the exact authenticated provider webhook invocation', async () => {
    const invocation = Object.freeze({
      requestId: '00000000-0000-4000-8000-000000000305',
      keyword: 'START' as const,
      phoneNumber: '+12025550123',
      occurredAt: TIMES.attempted,
      authorization: TRUSTED_OPT_IN,
    });
    const value = harness({
      mode: {
        state: 'enabled',
        authorizeLiveProvider: () => true,
        authorizeLiveSend: () => true,
      },
      resolveDestination: true,
      providerResponse: {
        OptOutListArn: OPT_OUT_LIST.arn,
        OptOutListName: OPT_OUT_LIST.name,
        OptedOutNumbers: [],
      },
    });

    await expect(
      value.runtime.recordProviderVerifiedOptIn(
        { rosterSnapshotId: IDS.roster },
        invocation,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        endpointId: IDS.endpoint,
        status: 'active',
      }),
    );
    expect(value.capabilities.requests).toEqual([
      {
        capabilityId: 'record-endpoint-status',
        context: {
          actor: { kind: 'system', serviceId: 'sms-opt-in-webhook' },
          source: 'webhook',
          transport: 'provider-webhook',
          requestId: invocation.requestId,
          authenticated: true,
        },
        input: {
          rosterSnapshotId: IDS.roster,
          recipientId: IDS.recipient,
          endpointId: IDS.endpoint,
          status: 'active',
          reasonCode: 'SMS_OPT_IN_PROVIDER_VERIFIED',
          provider: 'aws-eum-sms',
          providerReference: `opt-in:${OPT_OUT_LIST.arn}:${invocation.requestId}`,
          providerOccurredAt: invocation.occurredAt,
        },
      },
    ]);
    expect(value.counters.optInAuthorizations).toBe(1);
    expect(value.transport.requests).toBe(1);
  });

  test('delegates delivery events to the authenticated EventBridge boundary', async () => {
    const value = harness();

    await expect(
      value.runtime.processDeliveryEvent(
        {},
        {
          requestId: '00000000-0000-4000-8000-000000000304',
          ruleArn: DELIVERY_RULE_ARN,
          authorization: Symbol('forged-delivery'),
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVOCATION_UNVERIFIED' }),
    );
    expect(value.counters.deliveryAuthorizations).toBe(1);
    expect(value.counters.deliveryLookups).toBe(0);
    expect(value.evidenceWriter.requests).toHaveLength(0);
    expectNoProviderIo(value);
  });

  test('recovers authenticated late delivery proof after an ambiguous no-reference send', async () => {
    const value = harness({
      mode: {
        state: 'enabled',
        authorizeLiveProvider: () => true,
        authorizeLiveSend: () => true,
      },
    });

    const sendResult = await value.runtime.processQueueAttempt(
      smsWorkItem(),
      QUEUE_INVOCATION,
    );
    expect(sendResult.attemptResult).toEqual(
      expect.objectContaining({
        kind: 'dlq',
        outcome: expect.objectContaining({
          state: 'unknown',
          provider: 'aws-eum-sms',
          providerReference: null,
        }),
      }),
    );
    expect(value.transport.requests).toBe(1);

    await expect(
      value.runtime.processDeliveryEvent(deliveredEvent(), {
        requestId: '00000000-0000-4000-8000-000000000307',
        ruleArn: DELIVERY_RULE_ARN,
        authorization: TRUSTED_DELIVERY,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: 'recorded' }));
    expect(value.counters.deliveryAuthorizations).toBe(1);
    expect(value.counters.deliveryLookups).toBe(2);
    expect(value.evidenceWriter.requests.at(-1)?.evidence).toEqual(
      expect.objectContaining({
        subject: { kind: 'attempt', attemptId: IDS.attempt },
        state: 'delivered',
        provider: 'aws-eum-sms',
        providerReference: 'synthetic-late-provider-message-id',
      }),
    );
  });
});
