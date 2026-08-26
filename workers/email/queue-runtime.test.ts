import { describe, expect, test } from 'bun:test';
import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  DispatchBatchSchema,
  EmailEndpointSchema,
  type EmailWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';

import {
  attemptFor,
  deliveryTestBatch,
  IDS,
  TIMES,
} from '../shared/test-fixtures';
import type { ProviderSendOutcome } from '../shared/processor';
import { EmailQueueRuntime, EmailQueueRuntimeError } from './queue-runtime';

function workItem(): EmailWorkerAttemptWorkItem {
  const source = deliveryTestBatch();
  const batch = DispatchBatchSchema.parse({
    ...source,
    channel: 'email',
    renderedMessage: {
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'email',
      subject: '[DRILL] Live-pilot email test',
      textBody: '[DRILL] LIVE PILOT TEST — NO EMERGENCY.',
    },
    integrationStatus: {
      ...source.integrationStatus,
      integrationId: 'ses-email',
    },
  });
  return {
    batch,
    attempt: ChannelAttemptSchema.parse({
      ...attemptFor(batch),
      channel: 'email',
    }),
    endpoint: EmailEndpointSchema.parse({
      id: IDS.endpoint,
      status: 'active',
      capturedAt: TIMES.created,
      channel: 'email',
      email: 'controlled-recipient@example.invalid',
    }),
  };
}

function outcomeEvidence(state: 'provider-accepted' | 'failed') {
  return DeliveryEvidenceSchema.parse({
    id: '30000000-0000-4000-8000-000000000001',
    subject: { kind: 'attempt', attemptId: IDS.attempt },
    sequence: 2,
    previousEvidenceId: '30000000-0000-4000-8000-000000000000',
    state,
    recordedAt: TIMES.recorded,
    provider: 'aws-ses-v2',
    providerReference:
      state === 'provider-accepted' ? 'synthetic-message-id' : null,
    proof: null,
    reasonCode: state === 'failed' ? 'SES_PROVIDER_REJECTED' : null,
    diagnosticDigest: null,
  });
}

function providerOutcome(
  state: 'provider-accepted' | 'failed',
): ProviderSendOutcome {
  return state === 'provider-accepted'
    ? Object.freeze({
        state,
        provider: 'aws-ses-v2',
        providerReference: 'synthetic-message-id',
        proof: null,
        reasonCode: null,
        diagnosticDigest: null,
      })
    : Object.freeze({
        state,
        provider: 'aws-ses-v2',
        providerReference: null,
        proof: null,
        reasonCode: 'SES_PROVIDER_REJECTED',
        diagnosticDigest: null,
      });
}

describe('email queue runtime', () => {
  test('resolves a destination-free batch before processing one accepted attempt', async () => {
    const item = workItem();
    const calls: unknown[] = [];
    const runtime = new EmailQueueRuntime({
      queueArn: 'arn:aws:sqs:us-east-1:000000000000:email',
      state: {
        resolveBatch(batch, enqueuedAt, cursor) {
          calls.push({ batch, enqueuedAt, cursor });
          return Promise.resolve({
            items: [item],
            nextCursor: null,
            suppressedCount: 0,
          });
        },
        resolveRetry: () => Promise.resolve({ kind: 'expired' }),
      },
      worker: {
        processQueueAttempt(received, invocation) {
          calls.push({ received, invocation });
          return Promise.resolve({
            kind: 'completed',
            replayed: false,
            outcome: providerOutcome('provider-accepted'),
            attemptedEvidence: outcomeEvidence('provider-accepted'),
            outcomeEvidence: outcomeEvidence('provider-accepted'),
          });
        },
      },
      queue: { publishAttemptReference: () => Promise.resolve() },
    });

    await expect(
      runtime.processQueueMessage(
        JSON.stringify(item.batch),
        TIMES.created,
        IDS.request,
      ),
    ).resolves.toEqual({
      kind: 'completed',
      outboxCreatedAt: item.batch.createdAt,
      acceptedCount: 1,
      incompleteCount: 0,
      suppressedCount: 0,
    });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).toContain('verified-sqs-source');
  });

  test('publishes only an opaque source-attempt retry reference', async () => {
    const item = workItem();
    const published: unknown[] = [];
    const runtime = new EmailQueueRuntime({
      queueArn: 'arn:aws:sqs:us-east-1:000000000000:email',
      state: {
        resolveBatch: () =>
          Promise.resolve({
            items: [item],
            nextCursor: null,
            suppressedCount: 0,
          }),
        resolveRetry: () => Promise.resolve({ kind: 'expired' }),
      },
      worker: {
        processQueueAttempt: () =>
          Promise.resolve({
            kind: 'retry',
            replayed: false,
            outcome: providerOutcome('failed'),
            attemptedEvidence: outcomeEvidence('provider-accepted'),
            outcomeEvidence: outcomeEvidence('failed'),
            delayMilliseconds: 1_500,
            nextAttemptNumber: 2,
            reasonCode: 'SES_PROVIDER_RETRYABLE',
          }),
      },
      queue: {
        publishAttemptReference(sourceAttemptId, delaySeconds) {
          published.push({ sourceAttemptId, delaySeconds });
          return Promise.resolve();
        },
      },
    });

    await runtime.processQueueMessage(
      JSON.stringify(item.batch),
      TIMES.created,
      IDS.request,
    );
    expect(published).toEqual([
      { sourceAttemptId: item.attempt.id, delaySeconds: 2 },
    ]);
    expect(JSON.stringify(published)).not.toContain('@');
  });

  test('deletes an ineligible retry without another provider call', async () => {
    let workerCalls = 0;
    const runtime = new EmailQueueRuntime({
      queueArn: 'arn:aws:sqs:us-east-1:000000000000:email',
      state: {
        resolveBatch: () =>
          Promise.resolve({
            items: [],
            nextCursor: null,
            suppressedCount: 1,
          }),
        resolveRetry: () => Promise.resolve({ kind: 'ineligible' }),
      },
      worker: {
        processQueueAttempt: () => {
          workerCalls += 1;
          throw new Error('must not send');
        },
      },
      queue: { publishAttemptReference: () => Promise.resolve() },
    });

    await expect(
      runtime.processQueueMessage(
        JSON.stringify({
          kind: 'ses-email-attempt-reference',
          sourceAttemptId: IDS.attempt,
        }),
        TIMES.created,
        IDS.request,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ kind: 'completed', suppressedCount: 1 }),
    );
    expect(workerCalls).toBe(0);
  });

  test('leaves malformed messages and terminal attempts for the queue DLQ', async () => {
    const item = workItem();
    const runtime = new EmailQueueRuntime({
      queueArn: 'arn:aws:sqs:us-east-1:000000000000:email',
      state: {
        resolveBatch: () =>
          Promise.resolve({
            items: [item],
            nextCursor: null,
            suppressedCount: 0,
          }),
        resolveRetry: () => Promise.resolve({ kind: 'expired' }),
      },
      worker: {
        processQueueAttempt: () =>
          Promise.resolve({
            kind: 'dlq',
            replayed: false,
            outcome: providerOutcome('failed'),
            attemptedEvidence: outcomeEvidence('provider-accepted'),
            outcomeEvidence: outcomeEvidence('failed'),
          }),
      },
      queue: { publishAttemptReference: () => Promise.resolve() },
    });

    await expect(
      runtime.processQueueMessage('{}', TIMES.created, IDS.request),
    ).rejects.toBeInstanceOf(EmailQueueRuntimeError);
    await expect(
      runtime.processQueueMessage(
        JSON.stringify(item.batch),
        TIMES.created,
        IDS.request,
      ),
    ).rejects.toBeInstanceOf(EmailQueueRuntimeError);
  });
});
