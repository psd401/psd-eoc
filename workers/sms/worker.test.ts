import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  DispatchBatchSchema,
  EndpointSchema,
  SmsOptOutRecordSchema,
  type RecordSmsOptOutInput,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';

import {
  IDS,
  TIMES,
  attemptFor,
  syntheticBatch,
} from '../shared/test-fixtures';
import type { WorkerAttemptProcessResult } from '../shared';
import type { SmsOptOutRecorder } from './opt-out';
import {
  AWS_EUM_OPT_OUT_REASON,
  processSmsWorkItem,
  type SmsAttemptProcessor,
} from './worker';

const EVIDENCE_IDS = Object.freeze({
  attempted: '10000000-0000-4000-8000-000000000014',
  outcome: '20000000-0000-4000-8000-000000000014',
  optOut: '30000000-0000-4000-8000-000000000014',
});

function workItem() {
  const base = syntheticBatch();
  const batch = DispatchBatchSchema.parse({
    ...base,
    channel: 'sms',
    renderedMessage: {
      eventKind: 'test',
      templateMode: 'drill',
      purpose: base.purpose,
      classificationMarker: 'DRILL',
      channel: 'sms',
      body: '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic test. [DRILL]',
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

function processResult(
  reasonCode: string,
  providerReference: string | null = 'synthetic-aws-request-id',
): WorkerAttemptProcessResult {
  const item = workItem();
  const attemptedEvidence = DeliveryEvidenceSchema.parse({
    id: EVIDENCE_IDS.attempted,
    subject: { kind: 'attempt', attemptId: item.attempt.id },
    sequence: 1,
    previousEvidenceId: null,
    state: 'attempted',
    recordedAt: TIMES.created,
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
  const outcomeEvidence = DeliveryEvidenceSchema.parse({
    id: EVIDENCE_IDS.outcome,
    subject: { kind: 'attempt', attemptId: item.attempt.id },
    sequence: 2,
    previousEvidenceId: EVIDENCE_IDS.attempted,
    state: 'failed',
    recordedAt: TIMES.created,
    provider: 'aws-eum-sms',
    providerReference,
    proof: null,
    reasonCode,
    diagnosticDigest: 'a'.repeat(64),
  });
  const outcome = Object.freeze({
    state: 'failed' as const,
    provider: 'aws-eum-sms',
    providerReference,
    proof: null,
    reasonCode,
    diagnosticDigest: 'a'.repeat(64),
  });
  return Object.freeze({
    kind: 'dlq',
    replayed: false,
    outcome,
    attemptedEvidence,
    outcomeEvidence,
  });
}

class FixedProcessor implements SmsAttemptProcessor {
  public constructor(private readonly result: WorkerAttemptProcessResult) {}

  public process(): Promise<WorkerAttemptProcessResult> {
    return Promise.resolve(this.result);
  }
}

class RecordingOptOutStore implements SmsOptOutRecorder {
  public readonly inputs: RecordSmsOptOutInput[] = [];

  public recordSmsOptOut(
    input: RecordSmsOptOutInput,
  ): Promise<SmsOptOutRecord> {
    this.inputs.push(input);
    return Promise.resolve(
      SmsOptOutRecordSchema.parse({
        id: EVIDENCE_IDS.optOut,
        ...input,
        recordedAt: TIMES.created,
      }),
    );
  }
}

describe('SMS worker opt-out persistence', () => {
  test('automatically persists AWS managed opt-out conflicts', async () => {
    const recorder = new RecordingOptOutStore();
    const result = await processSmsWorkItem(workItem(), {
      attemptProcessor: new FixedProcessor(
        processResult(AWS_EUM_OPT_OUT_REASON),
      ),
      optOutRecorder: recorder,
    });

    expect(result.optOutRecord).toEqual(
      expect.objectContaining({ endpointId: IDS.endpoint }),
    );
    expect(recorder.inputs).toEqual([
      {
        rosterSnapshotId: workItem().batch.rosterSnapshotId,
        recipientId: workItem().attempt.recipientId,
        endpointId: IDS.endpoint,
        provider: 'aws-eum-sms',
        providerReference: 'synthetic-aws-request-id',
      },
    ]);
    expect(JSON.stringify(recorder.inputs)).not.toContain('+12025550123');
  });

  test('does not create opt-out evidence for unrelated failures', async () => {
    const recorder = new RecordingOptOutStore();
    const result = await processSmsWorkItem(workItem(), {
      attemptProcessor: new FixedProcessor(
        processResult('AWS_EUM_REQUEST_INVALID'),
      ),
      optOutRecorder: recorder,
    });

    expect(result.optOutRecord).toBeNull();
    expect(recorder.inputs).toEqual([]);
  });
});
