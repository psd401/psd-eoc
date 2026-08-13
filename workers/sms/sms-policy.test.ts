import { describe, expect, test } from 'bun:test';
import {
  AudienceConfigSchema,
  ChannelAttemptSchema,
  DispatchBatchSchema,
  EndpointSchema,
  EndpointStatusRecordSchema,
  RosterSnapshotSchema,
  SmsMessageTemplateSchema,
  SmsOptOutRecordSchema,
  type DispatchBatch,
  type RecordEndpointStatusInput,
  type RecordSmsOptOutInput,
  type SmsLifecycleCapabilityContext,
} from '@psd-eoc/contracts';

import {
  SmsPolicyError,
  createDrizzleSmsPolicyStore,
  executeRecordEndpointStatusCapability,
  executeRecordSmsOptOutCapability,
  renderSmsMessage,
  resolveSmsEndpoints,
  validateRenderedSmsMessage,
  type SmsEndpointPolicyQuery,
  type SmsEndpointPolicyStore,
} from '../../packages/server/lib/notify/sms-policy';
import type { Database } from '../../packages/server/db/client';
import { parseSmsProviderSendRequest } from './aws-eum-adapter';

const TIMESTAMP = '2026-08-11T18:00:00.000Z';
const IDS = Object.freeze({
  facility: '00000000-0000-4000-8000-000000000001',
  audience: '00000000-0000-4000-8000-000000000002',
  group: '00000000-0000-4000-8000-000000000003',
  configuration: '00000000-0000-4000-8000-000000000004',
  roster: '00000000-0000-4000-8000-000000000005',
  recipient: '00000000-0000-4000-8000-000000000006',
  endpoint: '00000000-0000-4000-8000-000000000007',
  request: '00000000-0000-4000-8000-000000000008',
  preview: '00000000-0000-4000-8000-000000000009',
  eventType: '00000000-0000-4000-8000-000000000010',
  event: '00000000-0000-4000-8000-000000000011',
  intent: '00000000-0000-4000-8000-000000000012',
  batch: '00000000-0000-4000-8000-000000000013',
  ordinaryRecipient: '00000000-0000-4000-8000-000000000014',
  ordinaryEndpoint: '00000000-0000-4000-8000-000000000015',
  targetSet: '00000000-0000-4000-8000-000000000016',
  actor: '00000000-0000-4000-8000-000000000017',
  confirmation: '00000000-0000-4000-8000-000000000018',
});

const GROUP = Object.freeze({
  id: IDS.group,
  kind: 'synthetic' as const,
  purpose: 'building' as const,
  facilityId: IDS.facility,
});

const audienceConfig = AudienceConfigSchema.parse({
  id: IDS.audience,
  facilityId: IDS.facility,
  version: 1,
  targets: [{ kind: 'building', facilityId: IDS.facility }],
  createdAt: TIMESTAMP,
});

const rosterSnapshot = RosterSnapshotSchema.parse({
  id: IDS.roster,
  version: 1,
  population: 'synthetic',
  complete: true,
  sourceConfiguration: { id: IDS.configuration, version: 1 },
  facilityIds: [IDS.facility],
  expectedSourceGroupRefs: [GROUP],
  sourceGroupRefs: [GROUP],
  recipients: [
    {
      id: IDS.recipient,
      population: 'synthetic',
      googleSubject: null,
      displayName: 'Synthetic SMS Staff',
      groupSourceRefs: [GROUP],
      endpoints: [
        {
          id: IDS.endpoint,
          channel: 'sms',
          status: 'active',
          capturedAt: TIMESTAMP,
          phoneNumber: '+12025550123',
        },
      ],
    },
  ],
  syncStartedAt: TIMESTAMP,
  capturedAt: TIMESTAMP,
});

function batch(): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: { id: IDS.eventType, templateMode: 'drill' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    audienceConfig: { id: IDS.audience, version: 1 },
    requestId: IDS.request,
    authorization: {
      kind: 'synthetic-training',
      activationPreviewId: IDS.preview,
      consequenceDigest: 'a'.repeat(64),
      requestId: IDS.request,
    },
    channel: 'sms',
    renderedMessage: {
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'sms',
      body: '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic test. [DRILL]',
    },
    integrationStatus: {
      integrationId: 'aws-eum-sms',
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: TIMESTAMP,
    },
    sequence: 3,
    endpointCount: 1,
    createdAt: TIMESTAMP,
  });
}

function audienceInput() {
  return {
    audienceConfig,
    neighborhoodVersions: [],
    rosterSnapshot,
  };
}

function deliveryTestSmsResolutionInput() {
  const staffGroup = Object.freeze({
    ...GROUP,
    kind: 'google-group' as const,
  });
  const roster = RosterSnapshotSchema.parse({
    ...rosterSnapshot,
    population: 'staff',
    expectedSourceGroupRefs: [staffGroup],
    sourceGroupRefs: [staffGroup],
    recipients: [
      {
        id: IDS.recipient,
        population: 'staff',
        googleSubject: 'synthetic-approved-sms-canary-subject',
        displayName: 'Approved synthetic SMS canary fixture',
        groupSourceRefs: [staffGroup],
        endpoints: [
          {
            id: IDS.endpoint,
            channel: 'sms',
            status: 'active',
            capturedAt: TIMESTAMP,
            phoneNumber: '+12025550123',
          },
        ],
      },
      {
        id: IDS.ordinaryRecipient,
        population: 'staff',
        googleSubject: 'synthetic-ordinary-sms-staff-subject',
        displayName: 'Ordinary synthetic SMS staff fixture',
        groupSourceRefs: [staffGroup],
        endpoints: [
          {
            id: IDS.ordinaryEndpoint,
            channel: 'sms',
            status: 'active',
            capturedAt: TIMESTAMP,
            phoneNumber: '+12025550124',
          },
        ],
      },
    ],
  });
  const deliveryTest = Object.freeze({
    purpose: 'monthly-live-delivery-test' as const,
    targetSet: { id: IDS.targetSet, version: 1 },
    endpointReferenceDigest: 'd'.repeat(64),
  });
  const deliveryBatch = DispatchBatchSchema.parse({
    ...batch(),
    eventKind: 'drill',
    rosterPopulation: 'staff',
    deliveryTest,
    authorization: {
      kind: 'human-confirmed',
      activationPreviewId: IDS.preview,
      preparedActivationId: null,
      confirmationId: IDS.confirmation,
      consequenceDigest: 'b'.repeat(64),
      requestId: IDS.request,
    },
    renderedMessage: {
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'sms',
      body: '[DRILL] LIVE CANARY — TRAINING ONLY.',
    },
    integrationStatus: {
      integrationId: 'aws-eum-sms',
      label: 'live-verified',
      verifiedAt: TIMESTAMP,
      verifiedByUserId: IDS.actor,
      authorizationReference: 'synthetic-live-verification-reference',
      reasonCode: null,
      observedAt: TIMESTAMP,
    },
    endpointCount: 1,
  });
  return Object.freeze({
    deliveryTest,
    input: Object.freeze({
      batch: deliveryBatch,
      audience: Object.freeze({
        audienceConfig,
        neighborhoodVersions: Object.freeze([]),
        rosterSnapshot: roster,
      }),
    }),
  });
}

function supersededTargetDatabase(target: Readonly<Record<string, unknown>>) {
  const queuedRows: readonly (readonly unknown[])[] = [
    [{ facilityId: IDS.facility }],
    [target],
    [{ id: '00000000-0000-4000-8000-000000000019' }],
  ];
  let selectCalls = 0;
  let executeCalls = 0;
  let transactionCalls = 0;
  const queryDatabase = {
    select() {
      const rows = queuedRows[selectCalls] ?? [];
      selectCalls += 1;
      const builder = {
        from() {
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve(rows);
        },
      };
      return builder;
    },
    execute() {
      executeCalls += 1;
      return Promise.resolve([]);
    },
  };
  const database = {
    ...queryDatabase,
    transaction<Result>(
      operation: (transaction: typeof queryDatabase) => Promise<Result>,
    ) {
      transactionCalls += 1;
      return operation(queryDatabase);
    },
  } as unknown as Database;
  return Object.freeze({
    database,
    executeCalls: () => executeCalls,
    selectCalls: () => selectCalls,
    transactionCalls: () => transactionCalls,
  });
}

class PolicyStore implements SmsEndpointPolicyStore {
  public constructor(
    private readonly status: 'active' | 'disabled' | 'invalid' = 'active',
    private readonly optedOut = false,
    private readonly approvedEndpointIds: ReadonlySet<string> | null = null,
  ) {}

  public loadEndpointPolicy(query: SmsEndpointPolicyQuery): Promise<unknown> {
    return Promise.resolve(
      query.candidates.map((candidate) => ({
        ...candidate,
        status: this.status,
        optedOut: this.optedOut,
        approvedForDeliveryTest:
          query.deliveryTest == null ||
          this.approvedEndpointIds === null ||
          this.approvedEndpointIds.has(candidate.endpointId),
      })),
    );
  }
}

function expectPolicyError(
  operation: () => unknown,
  code: SmsPolicyError['code'],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SmsPolicyError);
    expect((error as SmsPolicyError).code).toBe(code);
    return;
  }
  throw new Error(`Expected SMS policy to fail with ${code}.`);
}

describe('SMS rendering policy', () => {
  test('renders an unmistakable one-part drill SMS', () => {
    const template = SmsMessageTemplateSchema.parse({
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'sms',
      body: '{{eventType}} at {{site}}. Follow staff instructions.',
    });

    const rendered = renderSmsMessage({
      eventKind: 'test',
      template,
      variables: {
        site: 'Synthetic School',
        eventType: 'Synthetic drill',
        startTime: '2026-08-11T18:00:00.000Z',
        initiator: 'Synthetic Operator',
      },
    });

    expect(rendered.body).toStartWith('[DRILL] TRAINING ONLY - ACTIVATION:');
    expect(rendered.body).toEndWith('[DRILL]');
    expect(rendered.body).not.toContain('[INCIDENT]');
  });

  test('rejects a contract-valid SMS that would split into multiple parts', () => {
    expectPolicyError(
      () =>
        validateRenderedSmsMessage({
          eventKind: 'test',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          channel: 'sms',
          body: `[DRILL] ${'A'.repeat(180)}`,
        }),
      'SMS_LENGTH_UNSAFE',
    );
  });
});

describe('SMS endpoint policy', () => {
  test('resolves only active endpoints in the exact pinned audience', async () => {
    await expect(
      resolveSmsEndpoints(
        { batch: batch(), audience: audienceInput() },
        new PolicyStore(),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        rosterSnapshotId: IDS.roster,
        recipientId: IDS.recipient,
        endpoint: expect.objectContaining({ id: IDS.endpoint }),
      }),
    ]);
  });

  test('honors retained opt-outs before exposing a destination', async () => {
    await expect(
      resolveSmsEndpoints(
        { batch: batch(), audience: audienceInput() },
        new PolicyStore('active', true),
      ),
    ).resolves.toEqual([]);
  });

  test('honors append-only disabled endpoint evidence', async () => {
    await expect(
      resolveSmsEndpoints(
        { batch: batch(), audience: audienceInput() },
        new PolicyStore('disabled'),
      ),
    ).resolves.toEqual([]);
  });

  test('excludes ordinary staff from an approved live canary batch', async () => {
    const { input } = deliveryTestSmsResolutionInput();

    const resolved = await resolveSmsEndpoints(
      input,
      new PolicyStore('active', false, new Set([IDS.endpoint])),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.recipientId).toBe(IDS.recipient);
    expect(resolved[0]?.endpoint.id).toBe(IDS.endpoint);
    expect(JSON.stringify(resolved)).not.toContain('+12025550124');
  });

  test('rejects a superseded target under the facility lock before exposing a phone number', async () => {
    const { deliveryTest, input } = deliveryTestSmsResolutionInput();
    const fixture = supersededTargetDatabase({
      id: deliveryTest.targetSet.id,
      version: deliveryTest.targetSet.version,
      facilityId: IDS.facility,
      rosterSnapshotId: IDS.roster,
      rosterPopulation: 'staff',
      endpointReferenceDigest: deliveryTest.endpointReferenceDigest,
    });
    const store = createDrizzleSmsPolicyStore(fixture.database);
    let releasedPhoneNumbers: readonly string[] | undefined;
    let providerCalls = 0;

    await expect(
      resolveSmsEndpoints(input, store).then((resolved) => {
        releasedPhoneNumbers = resolved.map(
          ({ endpoint }) => endpoint.phoneNumber,
        );
        providerCalls += resolved.length;
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SMS_ENDPOINT_POLICY' });

    expect(releasedPhoneNumbers).toBeUndefined();
    expect(providerCalls).toBe(0);
    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.executeCalls()).toBe(2);
    expect(fixture.selectCalls()).toBe(3);
  });

  test('allows +999 fixtures only through the mocked provider preflight', () => {
    const syntheticBatch = batch();
    const attempt = ChannelAttemptSchema.parse({
      id: IDS.actor,
      batchId: syntheticBatch.id,
      intentId: syntheticBatch.intentId,
      eventId: syntheticBatch.eventId,
      eventKind: syntheticBatch.eventKind,
      templateMode: syntheticBatch.templateMode,
      purpose: syntheticBatch.purpose,
      eventTypeVersion: syntheticBatch.eventTypeVersion,
      rosterSnapshotId: syntheticBatch.rosterSnapshotId,
      rosterPopulation: syntheticBatch.rosterPopulation,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      channel: syntheticBatch.channel,
      attemptNumber: 1,
      attemptedAt: TIMESTAMP,
    });
    const request = {
      workItem: {
        batch: syntheticBatch,
        attempt,
        endpoint: EndpointSchema.parse({
          id: IDS.endpoint,
          channel: 'sms',
          status: 'active',
          capturedAt: TIMESTAMP,
          phoneNumber: '+999000000000000',
        }),
      },
      idempotencyKey: attempt.id,
    };

    expect(parseSmsProviderSendRequest(request, 'mocked')).toMatchObject({
      idempotencyKey: attempt.id,
    });
    expect(() => parseSmsProviderSendRequest(request, 'live-verified')).toThrow(
      expect.objectContaining({ code: 'AWS_EUM_WORK_ITEM_INVALID' }),
    );
  });

  test('canonicalizes provider timestamps before persistence and replay comparison', async () => {
    const optOutInputs: unknown[] = [];
    const endpointStatusInputs: unknown[] = [];
    const optOutStore = {
      recordSmsOptOut(input: RecordSmsOptOutInput) {
        optOutInputs.push(input);
        return Promise.resolve(
          SmsOptOutRecordSchema.parse({
            id: IDS.request,
            ...input,
            providerOccurredAt: new Date(
              input.providerOccurredAt,
            ).toISOString(),
            recordedAt: '2026-08-11T18:05:00.000Z',
          }),
        );
      },
    };
    const endpointStatusStore = {
      recordEndpointStatus(input: RecordEndpointStatusInput) {
        endpointStatusInputs.push(input);
        const occurredAt = input.providerOccurredAt;
        return Promise.resolve(
          EndpointStatusRecordSchema.parse({
            id: IDS.preview,
            ...input,
            providerOccurredAt:
              occurredAt === undefined
                ? undefined
                : new Date(occurredAt).toISOString(),
            recordedAt: '2026-08-11T18:05:00.000Z',
          }),
        );
      },
    };
    const workerContext = {
      actor: { kind: 'system', serviceId: 'sms-worker' },
      source: 'worker',
      transport: 'sqs',
      requestId: IDS.request,
      authenticated: true,
    } satisfies SmsLifecycleCapabilityContext;
    const webhookContext = {
      actor: { kind: 'system', serviceId: 'sms-opt-in-webhook' },
      source: 'webhook',
      transport: 'provider-webhook',
      requestId: IDS.preview,
      authenticated: true,
    } satisfies SmsLifecycleCapabilityContext;
    const optOutInput = {
      rosterSnapshotId: IDS.roster,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      provider: 'aws-eum-sms',
      providerReference: 'synthetic-offset-opt-out',
      providerOccurredAt: '2026-08-11T11:00:00-07:00',
    } as const;
    const endpointStatusInput = {
      rosterSnapshotId: IDS.roster,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      status: 'active',
      reasonCode: 'SMS_OPT_IN_PROVIDER_VERIFIED',
      provider: 'aws-eum-sms',
      providerReference: 'synthetic-no-millisecond-opt-in',
      providerOccurredAt: '2026-08-11T18:02:00Z',
    } as const;

    const optOut = await executeRecordSmsOptOutCapability(
      optOutInput,
      workerContext,
      optOutStore,
    );
    await expect(
      executeRecordSmsOptOutCapability(optOutInput, workerContext, optOutStore),
    ).resolves.toEqual(optOut);
    const endpointStatus = await executeRecordEndpointStatusCapability(
      endpointStatusInput,
      webhookContext,
      endpointStatusStore,
    );
    await expect(
      executeRecordEndpointStatusCapability(
        endpointStatusInput,
        webhookContext,
        endpointStatusStore,
      ),
    ).resolves.toEqual(endpointStatus);

    expect(optOut.providerOccurredAt).toBe('2026-08-11T18:00:00.000Z');
    expect(endpointStatus.providerOccurredAt).toBe('2026-08-11T18:02:00.000Z');
    expect(optOutInputs).toEqual([
      expect.objectContaining({
        providerOccurredAt: '2026-08-11T18:00:00.000Z',
      }),
      expect.objectContaining({
        providerOccurredAt: '2026-08-11T18:00:00.000Z',
      }),
    ]);
    expect(endpointStatusInputs).toEqual([
      expect.objectContaining({
        providerOccurredAt: '2026-08-11T18:02:00.000Z',
      }),
      expect.objectContaining({
        providerOccurredAt: '2026-08-11T18:02:00.000Z',
      }),
    ]);
  });
});
