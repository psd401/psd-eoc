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
    integrationId: 'aws-eum-sms',
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
  replayed = false,
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
    replayed,
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

class FailOnceOptOutStore extends RecordingOptOutStore {
  public override recordSmsOptOut(
    input: RecordSmsOptOutInput,
  ): Promise<SmsOptOutRecord> {
    this.inputs.push(input);
    if (this.inputs.length === 1) {
      return Promise.reject(new Error('synthetic append interruption'));
    }
    return Promise.resolve(
      SmsOptOutRecordSchema.parse({
        id: EVIDENCE_IDS.optOut,
        ...input,
        recordedAt: TIMES.created,
      }),
    );
  }
}

class RecoveringProcessor implements SmsAttemptProcessor {
  public callCount = 0;
  public providerSendCount = 0;

  public process(): Promise<WorkerAttemptProcessResult> {
    this.callCount += 1;
    if (this.callCount === 1) this.providerSendCount += 1;
    return Promise.resolve(
      processResult(
        AWS_EUM_OPT_OUT_REASON,
        'synthetic-aws-request-id',
        this.callCount > 1,
      ),
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
        providerOccurredAt: TIMES.created,
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

  test('replays a failed opt-out append without a second provider send', async () => {
    const processor = new RecoveringProcessor();
    const recorder = new FailOnceOptOutStore();
    const options = { attemptProcessor: processor, optOutRecorder: recorder };

    await expect(processSmsWorkItem(workItem(), options)).rejects.toThrow(
      'synthetic append interruption',
    );
    const replay = await processSmsWorkItem(workItem(), options);

    expect(replay.attemptResult).toEqual(
      expect.objectContaining({ replayed: true }),
    );
    expect(replay.optOutRecord).toEqual(
      expect.objectContaining({ endpointId: IDS.endpoint }),
    );
    expect(processor.callCount).toBe(2);
    expect(processor.providerSendCount).toBe(1);
    expect(recorder.inputs).toHaveLength(2);
    expect(JSON.stringify(recorder.inputs)).not.toContain('+12025550123');
  });
});
