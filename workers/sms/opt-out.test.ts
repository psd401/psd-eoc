import { describe, expect, test } from 'bun:test';
import {
  ChannelAttemptSchema,
  DispatchBatchSchema,
  EndpointStatusRecordSchema,
  EndpointSchema,
  SmsOptOutRecordSchema,
  type EndpointStatusRecord,
  type RecordEndpointStatusInput,
  type RecordSmsOptOutInput,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import {
  SmsOptOutError,
  SmsOptOutReconciler,
  recordAwsManagedOptIn,
  recordAwsManagedOptOutConflict,
  type AwsEumDescribeOptedOutNumbersRequest,
  type AwsEumOptOutTransport,
  type SmsEndpointStatusRecorder,
  type SmsOptOutDestinationResolver,
  type SmsOptOutRecorder,
} from './opt-out';

const OPT_OUT_LIST = Object.freeze({
  name: 'SyntheticList',
  arn: 'arn:aws:sms-voice:us-west-2:000000000000:opt-out-list/SyntheticList',
});
const TRUSTED_OPT_IN_INVOCATION = Symbol('trusted-opt-in-invocation');
const OPT_IN_INVOCATION = Object.freeze({
  requestId: '00000000-0000-4000-8000-000000000215',
  keyword: 'START' as const,
  phoneNumber: '+12025550123',
  occurredAt: '2026-08-11T18:02:30.000Z',
  authorization: TRUSTED_OPT_IN_INVOCATION,
});

const IDS = Object.freeze({
  request: '00000000-0000-4000-8000-000000000201',
  preview: '00000000-0000-4000-8000-000000000202',
  audience: '00000000-0000-4000-8000-000000000203',
  roster: '00000000-0000-4000-8000-000000000204',
  eventType: '00000000-0000-4000-8000-000000000205',
  event: '00000000-0000-4000-8000-000000000206',
  facility: '00000000-0000-4000-8000-000000000217',
  intent: '00000000-0000-4000-8000-000000000207',
  batch: '00000000-0000-4000-8000-000000000208',
  recipient: '00000000-0000-4000-8000-000000000209',
  endpoint: '00000000-0000-4000-8000-000000000210',
  attempt: '00000000-0000-4000-8000-000000000211',
  optOut: '00000000-0000-4000-8000-000000000212',
  endpointStatus: '00000000-0000-4000-8000-000000000213',
  otherRecipient: '00000000-0000-4000-8000-000000000214',
  otherRoster: '00000000-0000-4000-8000-000000000216',
});

function workItem(): WorkerAttemptWorkItem {
  const batch = DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    facilityId: IDS.facility,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: { id: IDS.eventType, templateMode: 'drill' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
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
      observedAt: '2026-08-11T18:00:00.000Z',
    },
    sequence: 3,
    endpointCount: 1,
    createdAt: '2026-08-11T18:00:00.000Z',
  });
  return Object.freeze({
    batch,
    attempt: ChannelAttemptSchema.parse({
      id: IDS.attempt,
      batchId: batch.id,
      intentId: batch.intentId,
      eventId: batch.eventId,
      eventKind: batch.eventKind,
      templateMode: batch.templateMode,
      purpose: batch.purpose,
      eventTypeVersion: batch.eventTypeVersion,
      rosterSnapshotId: batch.rosterSnapshotId,
      rosterPopulation: batch.rosterPopulation,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      channel: 'sms',
      attemptNumber: 1,
      attemptedAt: batch.createdAt,
    }),
    endpoint: EndpointSchema.parse({
      id: IDS.endpoint,
      status: 'active',
      capturedAt: batch.createdAt,
      channel: 'sms',
      phoneNumber: '+12025550123',
    }),
  });
}

class MemoryRecorder implements SmsOptOutRecorder {
  public readonly inputs: RecordSmsOptOutInput[] = [];

  public recordSmsOptOut(
    input: RecordSmsOptOutInput,
  ): Promise<SmsOptOutRecord> {
    this.inputs.push(input);
    return Promise.resolve(
      SmsOptOutRecordSchema.parse({
        id: IDS.optOut,
        ...input,
        recordedAt: '2026-08-11T18:03:00.000Z',
      }),
    );
  }
}

class MemoryEndpointStatusRecorder implements SmsEndpointStatusRecorder {
  public readonly inputs: RecordEndpointStatusInput[] = [];

  public recordEndpointStatus(
    input: RecordEndpointStatusInput,
  ): Promise<EndpointStatusRecord> {
    this.inputs.push(input);
    return Promise.resolve(
      EndpointStatusRecordSchema.parse({
        id: IDS.endpointStatus,
        ...input,
        recordedAt: '2026-08-11T18:03:00.000Z',
      }),
    );
  }
}

describe('AWS-managed SMS opt-out capture', () => {
  test('persists the already resolved endpoint without retaining a phone number', async () => {
    const recorder = new MemoryRecorder();
    await expect(
      recordAwsManagedOptOutConflict(
        workItem(),
        'synthetic-aws-request-id',
        '2026-08-11T18:00:30.000Z',
        recorder,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        endpointId: IDS.endpoint,
        provider: 'aws-eum-sms',
      }),
    );
    expect(recorder.inputs).toEqual([
      {
        rosterSnapshotId: IDS.roster,
        recipientId: IDS.recipient,
        endpointId: IDS.endpoint,
        provider: 'aws-eum-sms',
        providerReference: 'synthetic-aws-request-id',
        providerOccurredAt: '2026-08-11T18:00:30.000Z',
      },
    ]);
    expect(JSON.stringify(recorder.inputs)).not.toContain('+12025550123');
  });

  test('canonicalizes an offset provider occurrence before exact persistence comparison', async () => {
    const recorder = new MemoryRecorder();

    await expect(
      recordAwsManagedOptOutConflict(
        workItem(),
        'synthetic-offset-request-id',
        '2026-08-11T11:00:30-07:00',
        recorder,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        providerOccurredAt: '2026-08-11T18:00:30.000Z',
      }),
    );
    expect(recorder.inputs[0]?.providerOccurredAt).toBe(
      '2026-08-11T18:00:30.000Z',
    );
  });

  test('rejects a schema-valid recorder response for a different identity', async () => {
    const recorder: SmsOptOutRecorder = {
      recordSmsOptOut(input) {
        return Promise.resolve(
          SmsOptOutRecordSchema.parse({
            id: IDS.optOut,
            ...input,
            recipientId: IDS.otherRecipient,
            recordedAt: '2026-08-11T18:01:00.000Z',
          }),
        );
      },
    };

    await expect(
      recordAwsManagedOptOutConflict(
        workItem(),
        'synthetic-aws-request-id',
        '2026-08-11T18:00:30.000Z',
        recorder,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_RECORDER_RESPONSE' }),
    );
  });

  test('rejects a resolved non-SMS work item before recording an opt-out', async () => {
    const sms = workItem();
    const pushBatch = DispatchBatchSchema.parse({
      ...sms.batch,
      channel: 'push',
      renderedMessage: {
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'activation',
        classificationMarker: 'DRILL',
        channel: 'push',
        title: '[DRILL] TRAINING ONLY',
        body: '[DRILL] TRAINING ONLY - Synthetic test. [DRILL]',
      },
      integrationStatus: {
        ...sms.batch.integrationStatus,
        integrationId: 'expo-push',
      },
    });
    const recorder = new MemoryRecorder();

    await expect(
      recordAwsManagedOptOutConflict(
        {
          batch: pushBatch,
          attempt: ChannelAttemptSchema.parse({
            ...sms.attempt,
            channel: 'push',
          }),
          endpoint: EndpointSchema.parse({
            id: IDS.endpoint,
            status: 'active',
            capturedAt: pushBatch.createdAt,
            channel: 'push',
            platform: 'ios',
            token: 'synthetic-unroutable:push-device-issue-14',
          }),
        },
        'synthetic-aws-request-id',
        '2026-08-11T18:00:30.000Z',
        recorder,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'OPT_OUT_ENDPOINT_MISMATCH' }),
    );
    expect(recorder.inputs).toEqual([]);
  });
});

describe('AWS-managed opt-out reconciliation', () => {
  test('pages bounded provider results, resolves pinned endpoints, and reports only counts', async () => {
    const requests: AwsEumDescribeOptedOutNumbersRequest[] = [];
    const transport = {
      describeOptedOutNumbers(
        request: AwsEumDescribeOptedOutNumbersRequest,
      ): Promise<unknown> {
        requests.push(request);
        if (request.NextToken === undefined) {
          return Promise.resolve({
            OptOutListArn: OPT_OUT_LIST.arn,
            OptOutListName: OPT_OUT_LIST.name,
            OptedOutNumbers: [
              {
                EndUserOptedOut: true,
                OptedOutNumber: '+12025550123',
                OptedOutTimestamp: new Date('2026-08-11T18:00:00.000Z'),
              },
              {
                EndUserOptedOut: false,
                OptedOutNumber: '+12025550124',
                OptedOutTimestamp: new Date('2026-08-11T18:00:01.000Z'),
              },
            ],
            NextToken: 'synthetic-next-token',
          });
        }
        return Promise.resolve({
          OptOutListArn: OPT_OUT_LIST.arn,
          OptOutListName: OPT_OUT_LIST.name,
          OptedOutNumbers: [
            {
              EndUserOptedOut: true,
              OptedOutNumber: '+12025550125',
              OptedOutTimestamp: new Date('2026-08-11T18:00:02.000Z'),
            },
          ],
        });
      },
    };
    const resolvedNumbers: string[] = [];
    const resolver: SmsOptOutDestinationResolver = {
      resolveSmsDestination(input) {
        resolvedNumbers.push(input.phoneNumber);
        return Promise.resolve(
          input.phoneNumber === '+12025550123'
            ? {
                rosterSnapshotId: IDS.roster,
                recipientId: IDS.recipient,
                endpointId: IDS.endpoint,
              }
            : null,
        );
      },
    };
    const recorder = new MemoryRecorder();
    const reconciler = new SmsOptOutReconciler({
      transport,
      resolver,
      recorder,
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });

    const report = await reconciler.reconcile({
      rosterSnapshotId: IDS.roster,
    });
    expect(report).toEqual({
      examinedCount: 3,
      recordedCount: 1,
      unresolvedCount: 2,
      pageCount: 2,
      continuationToken: null,
    });
    expect(requests).toEqual([
      { OptOutListName: OPT_OUT_LIST.arn, MaxResults: 100 },
      {
        OptOutListName: OPT_OUT_LIST.arn,
        MaxResults: 100,
        NextToken: 'synthetic-next-token',
      },
    ]);
    expect(resolvedNumbers).toEqual([
      '+12025550123',
      '+12025550124',
      '+12025550125',
    ]);
    expect(JSON.stringify(report)).not.toContain('+1202555');
    expect(recorder.inputs).toHaveLength(1);
  });

  test('rejects provider pagination loops and malformed destinations', async () => {
    const recorder = new MemoryRecorder();
    const resolver: SmsOptOutDestinationResolver = {
      resolveSmsDestination: () => Promise.resolve(null),
    };
    const looping = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers: () =>
          Promise.resolve({
            OptOutListArn: OPT_OUT_LIST.arn,
            OptOutListName: OPT_OUT_LIST.name,
            OptedOutNumbers: [],
            NextToken: 'same-token',
          }),
      },
      resolver,
      recorder,
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });
    await expect(
      looping.reconcile({ rosterSnapshotId: IDS.roster }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'OPT_OUT_PAGINATION_EXCEEDED' }),
    );

    const malformed = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers: () =>
          Promise.resolve({
            OptOutListArn: OPT_OUT_LIST.arn,
            OptOutListName: OPT_OUT_LIST.name,
            OptedOutNumbers: [
              {
                EndUserOptedOut: true,
                OptedOutNumber: 'not-a-number',
                OptedOutTimestamp: 1,
              },
            ],
          }),
      },
      resolver,
      recorder,
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });
    await expect(
      malformed.reconcile({ rosterSnapshotId: IDS.roster }),
    ).rejects.toBeInstanceOf(SmsOptOutError);
  });

  test('rejects a response for a different managed opt-out list', async () => {
    const recorder = new MemoryRecorder();
    const reconciler = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers: () =>
          Promise.resolve({
            OptOutListName: 'UnexpectedList',
            OptOutListArn: OPT_OUT_LIST.arn,
            OptedOutNumbers: [],
          }),
      },
      resolver: {
        resolveSmsDestination: () => Promise.resolve(null),
      },
      recorder,
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });

    await expect(
      reconciler.reconcile({ rosterSnapshotId: IDS.roster }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }),
    );
    expect(recorder.inputs).toEqual([]);
  });

  test('requires the exact configured opt-out-list ARN as well as its name', async () => {
    const recorder = new MemoryRecorder();
    const reconciler = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers: () =>
          Promise.resolve({
            OptOutListName: OPT_OUT_LIST.name,
            OptOutListArn:
              'arn:aws:sms-voice:us-west-2:000000000000:opt-out-list/OtherList',
            OptedOutNumbers: [],
          }),
      },
      resolver: {
        resolveSmsDestination: () => Promise.resolve(null),
      },
      recorder,
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });

    await expect(
      reconciler.reconcile({ rosterSnapshotId: IDS.roster }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }),
    );
    expect(recorder.inputs).toEqual([]);
  });

  test('returns a safe continuation token before the result bound and resumes without starvation', async () => {
    const requestTokens: Array<string | null> = [];
    const reconciler = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers(request) {
          const page =
            request.NextToken === undefined
              ? 0
              : Number(request.NextToken.replace('page-', ''));
          requestTokens.push(request.NextToken ?? null);
          const count = page < 12 ? 100 : 5;
          return Promise.resolve({
            OptOutListName: OPT_OUT_LIST.name,
            OptOutListArn: OPT_OUT_LIST.arn,
            OptedOutNumbers: Array.from({ length: count }, (_, index) => ({
              EndUserOptedOut: index % 2 === 0,
              OptedOutNumber: `+1202${String(5_550_000 + page * 100 + index)}`,
              OptedOutTimestamp: new Date(
                Date.UTC(2026, 7, 11, 18, page, index),
              ),
            })),
            ...(page < 12 ? { NextToken: `page-${page + 1}` } : {}),
          });
        },
      },
      resolver: {
        resolveSmsDestination: () => Promise.resolve(null),
      },
      recorder: new MemoryRecorder(),
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });

    const first = await reconciler.reconcile({ rosterSnapshotId: IDS.roster });
    expect(first).toEqual({
      examinedCount: 1_200,
      recordedCount: 0,
      unresolvedCount: 1_200,
      pageCount: 12,
      continuationToken: 'page-12',
    });

    const second = await reconciler.reconcile({
      rosterSnapshotId: IDS.roster,
      continuationToken: first.continuationToken,
    });
    expect(second).toEqual({
      examinedCount: 5,
      recordedCount: 0,
      unresolvedCount: 5,
      pageCount: 1,
      continuationToken: null,
    });
    expect(requestTokens).toHaveLength(13);
  });

  test('rejects a wrong-but-schema-valid recorder response during reconciliation', async () => {
    const reconciler = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers: () =>
          Promise.resolve({
            OptOutListName: OPT_OUT_LIST.name,
            OptOutListArn: OPT_OUT_LIST.arn,
            OptedOutNumbers: [
              {
                EndUserOptedOut: false,
                OptedOutNumber: '+12025550123',
                OptedOutTimestamp: new Date('2026-08-11T18:00:00.000Z'),
              },
            ],
          }),
      },
      resolver: {
        resolveSmsDestination: () =>
          Promise.resolve({
            rosterSnapshotId: IDS.roster,
            recipientId: IDS.recipient,
            endpointId: IDS.endpoint,
          }),
      },
      recorder: {
        recordSmsOptOut(input) {
          return Promise.resolve(
            SmsOptOutRecordSchema.parse({
              id: IDS.optOut,
              ...input,
              endpointId: '00000000-0000-4000-8000-000000000299',
              recordedAt: '2026-08-11T18:01:00.000Z',
            }),
          );
        },
      },
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });

    await expect(
      reconciler.reconcile({ rosterSnapshotId: IDS.roster }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_RECORDER_RESPONSE' }),
    );
  });

  test('rejects a resolver result from another roster snapshot before recording', async () => {
    const recorder = new MemoryRecorder();
    const reconciler = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers: () =>
          Promise.resolve({
            OptOutListName: OPT_OUT_LIST.name,
            OptOutListArn: OPT_OUT_LIST.arn,
            OptedOutNumbers: [
              {
                EndUserOptedOut: true,
                OptedOutNumber: '+12025550123',
                OptedOutTimestamp: new Date('2026-08-11T18:00:00.000Z'),
              },
            ],
          }),
      },
      resolver: {
        resolveSmsDestination: () =>
          Promise.resolve({
            rosterSnapshotId: IDS.otherRoster,
            recipientId: IDS.recipient,
            endpointId: IDS.endpoint,
          }),
      },
      recorder,
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });

    await expect(
      reconciler.reconcile({ rosterSnapshotId: IDS.roster }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'OPT_OUT_ENDPOINT_MISMATCH' }),
    );
    expect(recorder.inputs).toEqual([]);
  });

  test('replaces provider read failures with a fixed PII-free error', async () => {
    const leakedProviderMessage =
      'AWS rejected DescribeOptedOutNumbers for +12025550123';
    const reconciler = new SmsOptOutReconciler({
      transport: {
        describeOptedOutNumbers: () =>
          Promise.reject(new Error(leakedProviderMessage)),
      },
      resolver: {
        resolveSmsDestination: () => Promise.resolve(null),
      },
      recorder: new MemoryRecorder(),
      optOutListName: OPT_OUT_LIST.name,
      optOutListArn: OPT_OUT_LIST.arn,
    });

    const error: unknown = await reconciler
      .reconcile({ rosterSnapshotId: IDS.roster })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(SmsOptOutError);
    expect(error).toEqual(
      expect.objectContaining({ code: 'PROVIDER_READ_FAILED' }),
    );
    expect(String(error)).not.toContain(leakedProviderMessage);
    expect(String(error)).not.toContain('+12025550123');
  });
});

describe('AWS-managed SMS opt-in supersession', () => {
  test('appends active status only for authenticated START/UNSTOP and exact provider absence', async () => {
    const recorder = new MemoryEndpointStatusRecorder();
    const verificationRequests: AwsEumDescribeOptedOutNumbersRequest[] = [];
    const result = await recordAwsManagedOptIn(
      { rosterSnapshotId: IDS.roster },
      OPT_OUT_LIST,
      OPT_IN_INVOCATION,
      {
        transport: {
          describeOptedOutNumbers(request) {
            verificationRequests.push(request);
            return Promise.resolve({
              OptOutListName: OPT_OUT_LIST.name,
              OptOutListArn: OPT_OUT_LIST.arn,
              OptedOutNumbers: [],
            });
          },
        },
        resolver: {
          resolveSmsDestination: () =>
            Promise.resolve({
              rosterSnapshotId: IDS.roster,
              recipientId: IDS.recipient,
              endpointId: IDS.endpoint,
            }),
        },
        recorder,
        authorizeInvocation: (invocation) =>
          invocation.authorization === TRUSTED_OPT_IN_INVOCATION,
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        endpointId: IDS.endpoint,
        status: 'active',
        reasonCode: 'SMS_OPT_IN_PROVIDER_VERIFIED',
      }),
    );
    expect(recorder.inputs).toEqual([
      {
        rosterSnapshotId: IDS.roster,
        recipientId: IDS.recipient,
        endpointId: IDS.endpoint,
        status: 'active',
        reasonCode: 'SMS_OPT_IN_PROVIDER_VERIFIED',
        provider: 'aws-eum-sms',
        providerReference: `opt-in:${OPT_OUT_LIST.arn}:${OPT_IN_INVOCATION.requestId}`,
        providerOccurredAt: OPT_IN_INVOCATION.occurredAt,
      },
    ]);
    expect(verificationRequests).toEqual([
      {
        OptOutListName: OPT_OUT_LIST.arn,
        MaxResults: 1,
        OptedOutNumbers: ['+12025550123'],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('+12025550123');
  });

  test('canonicalizes a valid no-millisecond webhook occurrence before persistence', async () => {
    const recorder = new MemoryEndpointStatusRecorder();

    await expect(
      recordAwsManagedOptIn(
        { rosterSnapshotId: IDS.roster },
        OPT_OUT_LIST,
        {
          ...OPT_IN_INVOCATION,
          occurredAt: '2026-08-11T18:02:30Z',
        },
        {
          transport: {
            describeOptedOutNumbers: () =>
              Promise.resolve({
                OptOutListName: OPT_OUT_LIST.name,
                OptOutListArn: OPT_OUT_LIST.arn,
                OptedOutNumbers: [],
              }),
          },
          resolver: {
            resolveSmsDestination: () =>
              Promise.resolve({
                rosterSnapshotId: IDS.roster,
                recipientId: IDS.recipient,
                endpointId: IDS.endpoint,
              }),
          },
          recorder,
          authorizeInvocation: (invocation) =>
            invocation.authorization === TRUSTED_OPT_IN_INVOCATION,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        providerOccurredAt: '2026-08-11T18:02:30.000Z',
      }),
    );
    expect(recorder.inputs[0]?.providerOccurredAt).toBe(
      '2026-08-11T18:02:30.000Z',
    );
  });

  test('rejects provider-list drift and schema-valid recorder identity drift', async () => {
    const resolver: SmsOptOutDestinationResolver = {
      resolveSmsDestination: () =>
        Promise.resolve({
          rosterSnapshotId: IDS.roster,
          recipientId: IDS.recipient,
          endpointId: IDS.endpoint,
        }),
    };
    const verifiedTransport = {
      describeOptedOutNumbers: () =>
        Promise.resolve({
          OptOutListName: OPT_OUT_LIST.name,
          OptOutListArn: OPT_OUT_LIST.arn,
          OptedOutNumbers: [],
        }),
    };
    const optionsFor = (
      recorder: SmsEndpointStatusRecorder,
      transport: AwsEumOptOutTransport = verifiedTransport,
    ) => ({
      transport,
      resolver,
      recorder,
      authorizeInvocation: (invocation: { readonly authorization: unknown }) =>
        invocation.authorization === TRUSTED_OPT_IN_INVOCATION,
    });

    await expect(
      recordAwsManagedOptIn(
        { rosterSnapshotId: IDS.roster },
        OPT_OUT_LIST,
        OPT_IN_INVOCATION,
        optionsFor(new MemoryEndpointStatusRecorder(), {
          describeOptedOutNumbers: () =>
            Promise.resolve({
              OptOutListName: 'OtherList',
              OptOutListArn: OPT_OUT_LIST.arn,
              OptedOutNumbers: [],
            }),
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }),
    );
    await expect(
      recordAwsManagedOptIn(
        { rosterSnapshotId: IDS.roster },
        OPT_OUT_LIST,
        OPT_IN_INVOCATION,
        optionsFor({
          recordEndpointStatus(input) {
            return Promise.resolve(
              EndpointStatusRecordSchema.parse({
                id: IDS.endpointStatus,
                ...input,
                recipientId: IDS.otherRecipient,
                recordedAt: '2026-08-11T18:03:00.000Z',
              }),
            );
          },
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_RECORDER_RESPONSE' }),
    );
  });

  test('rejects an opt-in resolver result from another roster snapshot', async () => {
    const recorder = new MemoryEndpointStatusRecorder();

    await expect(
      recordAwsManagedOptIn(
        { rosterSnapshotId: IDS.roster },
        OPT_OUT_LIST,
        OPT_IN_INVOCATION,
        {
          transport: {
            describeOptedOutNumbers: () =>
              Promise.resolve({
                OptOutListName: OPT_OUT_LIST.name,
                OptOutListArn: OPT_OUT_LIST.arn,
                OptedOutNumbers: [],
              }),
          },
          resolver: {
            resolveSmsDestination: () =>
              Promise.resolve({
                rosterSnapshotId: IDS.otherRoster,
                recipientId: IDS.recipient,
                endpointId: IDS.endpoint,
              }),
          },
          recorder,
          authorizeInvocation: (invocation) =>
            invocation.authorization === TRUSTED_OPT_IN_INVOCATION,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'OPT_OUT_ENDPOINT_MISMATCH' }),
    );
    expect(recorder.inputs).toEqual([]);
  });

  test('authorizes START/UNSTOP before reads and refuses reactivation while AWS still lists the number', async () => {
    let providerReads = 0;
    let destinationReads = 0;
    const recorder = new MemoryEndpointStatusRecorder();
    const options = {
      transport: {
        describeOptedOutNumbers: () => {
          providerReads += 1;
          return Promise.resolve({
            OptOutListName: OPT_OUT_LIST.name,
            OptOutListArn: OPT_OUT_LIST.arn,
            OptedOutNumbers: [
              {
                EndUserOptedOut: true,
                OptedOutNumber: '+12025550123',
                OptedOutTimestamp: new Date('2026-08-11T18:00:00.000Z'),
              },
            ],
          });
        },
      },
      resolver: {
        resolveSmsDestination: () => {
          destinationReads += 1;
          return Promise.resolve({
            rosterSnapshotId: IDS.roster,
            recipientId: IDS.recipient,
            endpointId: IDS.endpoint,
          });
        },
      },
      recorder,
      authorizeInvocation: (invocation: { readonly authorization: unknown }) =>
        invocation.authorization === TRUSTED_OPT_IN_INVOCATION,
    };

    await expect(
      recordAwsManagedOptIn(
        { rosterSnapshotId: IDS.roster },
        OPT_OUT_LIST,
        { ...OPT_IN_INVOCATION, authorization: Symbol('forged') },
        options,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVOCATION_UNVERIFIED' }),
    );
    expect(providerReads).toBe(0);
    expect(destinationReads).toBe(0);
    expect(recorder.inputs).toHaveLength(0);

    await expect(
      recordAwsManagedOptIn(
        { rosterSnapshotId: IDS.roster },
        OPT_OUT_LIST,
        OPT_IN_INVOCATION,
        options,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }),
    );
    expect(providerReads).toBe(1);
    expect(destinationReads).toBe(0);
    expect(recorder.inputs).toHaveLength(0);
  });

  test('does not expose provider errors that echo the START sender', async () => {
    const leakedProviderMessage =
      'AWS request failed for OptedOutNumbers +12025550123';
    const error: unknown = await recordAwsManagedOptIn(
      { rosterSnapshotId: IDS.roster },
      OPT_OUT_LIST,
      OPT_IN_INVOCATION,
      {
        transport: {
          describeOptedOutNumbers: () =>
            Promise.reject(new Error(leakedProviderMessage)),
        },
        resolver: {
          resolveSmsDestination: () => Promise.resolve(null),
        },
        recorder: new MemoryEndpointStatusRecorder(),
        authorizeInvocation: (invocation) =>
          invocation.authorization === TRUSTED_OPT_IN_INVOCATION,
      },
    ).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(SmsOptOutError);
    expect(error).toEqual(
      expect.objectContaining({ code: 'PROVIDER_READ_FAILED' }),
    );
    expect(String(error)).not.toContain(leakedProviderMessage);
    expect(String(error)).not.toContain('+12025550123');
  });
});
