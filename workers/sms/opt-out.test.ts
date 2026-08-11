import { describe, expect, test } from 'bun:test';
import {
  ChannelAttemptSchema,
  DispatchBatchSchema,
  EndpointSchema,
  SmsOptOutRecordSchema,
  type RecordSmsOptOutInput,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import {
  SmsOptOutError,
  SmsOptOutReconciler,
  recordAwsManagedOptOutConflict,
  type AwsEumDescribeOptedOutNumbersRequest,
  type SmsOptOutDestinationResolver,
  type SmsOptOutRecorder,
} from './opt-out';

const IDS = Object.freeze({
  request: '00000000-0000-4000-8000-000000000201',
  preview: '00000000-0000-4000-8000-000000000202',
  audience: '00000000-0000-4000-8000-000000000203',
  roster: '00000000-0000-4000-8000-000000000204',
  eventType: '00000000-0000-4000-8000-000000000205',
  event: '00000000-0000-4000-8000-000000000206',
  intent: '00000000-0000-4000-8000-000000000207',
  batch: '00000000-0000-4000-8000-000000000208',
  recipient: '00000000-0000-4000-8000-000000000209',
  endpoint: '00000000-0000-4000-8000-000000000210',
  attempt: '00000000-0000-4000-8000-000000000211',
  optOut: '00000000-0000-4000-8000-000000000212',
});

function workItem(): WorkerAttemptWorkItem {
  const batch = DispatchBatchSchema.parse({
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
        recordedAt: '2026-08-11T18:01:00.000Z',
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
      },
    ]);
    expect(JSON.stringify(recorder.inputs)).not.toContain('+12025550123');
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
            OptOutListName: 'Default',
            OptedOutNumbers: [
              {
                EndUserOptedOut: true,
                OptedOutNumber: '+12025550123',
                OptedOutTimestamp: 1_786_470_000_000,
              },
              {
                EndUserOptedOut: false,
                OptedOutNumber: '+12025550124',
                OptedOutTimestamp: 1_786_470_000_001,
              },
            ],
            NextToken: 'synthetic-next-token',
          });
        }
        return Promise.resolve({
          OptOutListName: 'Default',
          OptedOutNumbers: [
            {
              EndUserOptedOut: true,
              OptedOutNumber: '+12025550125',
              OptedOutTimestamp: 1_786_470_000_002,
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
      optOutListName: 'Default',
    });

    const report = await reconciler.reconcile({
      rosterSnapshotId: IDS.roster,
    });
    expect(report).toEqual({
      examinedCount: 2,
      recordedCount: 1,
      unresolvedCount: 1,
      pageCount: 2,
    });
    expect(requests).toEqual([
      { OptOutListName: 'Default', MaxResults: 100 },
      {
        OptOutListName: 'Default',
        MaxResults: 100,
        NextToken: 'synthetic-next-token',
      },
    ]);
    expect(resolvedNumbers).toEqual(['+12025550123', '+12025550125']);
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
            OptOutListName: 'Default',
            OptedOutNumbers: [],
            NextToken: 'same-token',
          }),
      },
      resolver,
      recorder,
      optOutListName: 'Default',
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
            OptOutListName: 'Default',
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
      optOutListName: 'Default',
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
            OptedOutNumbers: [],
          }),
      },
      resolver: {
        resolveSmsDestination: () => Promise.resolve(null),
      },
      recorder,
      optOutListName: 'Default',
    });

    await expect(
      reconciler.reconcile({ rosterSnapshotId: IDS.roster }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }),
    );
    expect(recorder.inputs).toEqual([]);
  });
});
