import { describe, expect, test } from 'bun:test';

import type { Database } from '../../db/client';
import { channelAttempts, dispatchBatches } from '../../db/schema';
import {
  emailDeliveryTestBatch,
  emailDeliveryTestWorkItem,
} from '../testing/email-runtime';
import {
  assertControlledCanaryBatch,
  assertEmailBatch,
  createDrizzleEmailRuntimeStore,
  emailBatchMatchesDeploymentAuthorization,
} from './email-runtime-store';

const batch = emailDeliveryTestBatch();
const reference = batch.integrationStatus.authorizationReference!;

describe('email runtime deployment authorization', () => {
  test('binds immutable batches to the exact active verification reference', () => {
    expect(
      emailBatchMatchesDeploymentAuthorization(batch, {
        workerEnabled: true,
        verificationReference: reference,
      }),
    ).toBeTrue();
    expect(
      emailBatchMatchesDeploymentAuthorization(batch, {
        workerEnabled: true,
        verificationReference: 'superseding-verification-reference',
      }),
    ).toBeFalse();
    expect(
      emailBatchMatchesDeploymentAuthorization(batch, {
        workerEnabled: false,
        verificationReference: reference,
      }),
    ).toBeFalse();
  });

  test('rejects a stale retry batch before returning not-before', async () => {
    const workItem = emailDeliveryTestWorkItem();
    const outboxId = '00000000-0000-4000-8000-000000000018';
    const readOrder: string[] = [];
    let rows: readonly unknown[] = [];
    const query = {
      from(table: unknown) {
        if (table === channelAttempts) {
          readOrder.push('attempt');
          rows = [
            {
              attempt: {
                ...workItem.attempt,
                eventTypeVersionId: workItem.attempt.eventTypeVersion.id,
                attemptedAt: new Date(workItem.attempt.attemptedAt),
              },
              completion: {
                kind: 'retry',
                outcome: {
                  state: 'unknown',
                  provider: 'aws-ses-v2',
                  providerReference: null,
                  proof: null,
                  reasonCode: 'SES_SEND_OUTCOME_UNKNOWN',
                  diagnosticDigest: 'a'.repeat(64),
                },
                delayMilliseconds: 60_000,
                nextAttemptNumber: 2,
                reasonCode: 'SES_SEND_OUTCOME_UNKNOWN',
              },
            },
          ];
        } else if (table === dispatchBatches) {
          readOrder.push('batch');
          rows = [
            {
              batch: {
                id: batch.id,
                outboxId,
                intentId: batch.intentId,
                eventId: batch.eventId,
                eventKind: batch.eventKind,
                templateMode: batch.templateMode,
                purpose: batch.purpose,
                eventTypeVersionId: batch.eventTypeVersion.id,
                rosterSnapshotId: batch.rosterSnapshotId,
                rosterPopulation: batch.rosterPopulation,
                requestId: batch.requestId,
                authorization: batch.authorization,
                channel: batch.channel,
                renderedMessage: batch.renderedMessage,
                integrationStatusId: '00000000-0000-4000-8000-000000000019',
                integrationId: batch.integrationStatus.integrationId,
                integrationLabel: batch.integrationStatus.label,
                sequence: batch.sequence,
                endpointCount: batch.endpointCount,
                createdAt: new Date(batch.createdAt),
              },
              message: {
                version: 2,
                outboxId,
                intentId: batch.intentId,
                eventId: batch.eventId,
                facilityId: batch.facilityId,
                eventKind: batch.eventKind,
                templateMode: batch.templateMode,
                purpose: batch.purpose,
                eventTypeVersion: batch.eventTypeVersion,
                rosterSnapshotId: batch.rosterSnapshotId,
                rosterPopulation: batch.rosterPopulation,
                deliveryTest: batch.deliveryTest,
                requestId: batch.requestId,
                authorization: batch.authorization,
                channels: [
                  {
                    channel: batch.channel,
                    endpointCount: batch.endpointCount,
                    renderedMessage: batch.renderedMessage,
                    integrationStatus: batch.integrationStatus,
                  },
                ],
                createdAt: batch.createdAt,
              },
              facilityId: batch.facilityId,
            },
          ];
        } else {
          readOrder.push('clock');
          rows = [{ value: new Date(workItem.attempt.attemptedAt) }];
        }
        return query;
      },
      innerJoin() {
        return query;
      },
      where() {
        return query;
      },
      async limit() {
        return rows;
      },
    };
    const database = {
      select: () => query,
    } as unknown as Database;
    const store = createDrizzleEmailRuntimeStore(database, {
      deploymentAuthorization: {
        workerEnabled: true,
        verificationReference: 'superseding-verification-reference',
      },
    });

    await expect(store.resolveRetry(workItem.attempt.id)).resolves.toEqual({
      kind: 'ineligible',
    });
    expect(readOrder).toEqual(['attempt', 'batch']);
  });
});

describe('which email batches this store will send', () => {
  test('accepts an ordinary activation that is not a controlled canary', () => {
    // The canary's conditions were applied to every batch, so a confirmed
    // activation queued its email and was refused on arrival: an ordinary
    // drill notified nobody, and a REAL incident would have sent no email at
    // all. This is that batch.
    const activation = {
      ...batch,
      eventKind: 'incident' as const,
      templateMode: 'real' as const,
      purpose: 'activation' as const,
      endpointCount: 42,
      deliveryTest: null,
    };
    expect(() => assertEmailBatch(activation)).not.toThrow();
  });

  test('accepts an all-clear, which is not an activation', () => {
    expect(() =>
      assertEmailBatch({ ...batch, purpose: 'all-clear' as const }),
    ).not.toThrow();
  });

  test('accepts the lifecycle authorization a real all-clear actually carries', () => {
    // The test above varies `purpose`, which is not what distinguishes an
    // all-clear to this guard: the batch it builds still carries
    // `human-confirmed`. A real all-clear carries `human-confirmed-lifecycle`,
    // and reading only the activation kind refused every one ever queued --
    // rejected on arrival, retried until the redrive policy gave up, and
    // dead-lettered, so staff were told an incident started and never told it
    // ended. Push has no equivalent gate and sent them the whole time.
    const lifecycle = {
      ...batch,
      purpose: 'all-clear' as const,
      authorization: {
        kind: 'human-confirmed-lifecycle' as const,
        purpose: 'all-clear' as const,
        targeting: {
          kind: 'incident' as const,
          facilityId: batch.facilityId,
          rosterSnapshotId: batch.rosterSnapshotId,
          rosterPopulation: batch.rosterPopulation,
        },
        lifecyclePreviewId: batch.id,
        transitionId: batch.intentId,
        consequenceDigest: 'a'.repeat(64),
        requestId: batch.requestId,
        actionIds: ['all-clear', 'send-real-notification'] as const,
        confirmationId: batch.intentId,
      },
    } as unknown as Parameters<typeof assertEmailBatch>[0];
    expect(() => assertEmailBatch(lifecycle)).not.toThrow();
  });

  test('still refuses an authorization no human confirmed', () => {
    const synthetic = {
      ...batch,
      authorization: { ...batch.authorization, kind: 'synthetic-training' },
    } as unknown as Parameters<typeof assertEmailBatch>[0];
    expect(() => assertEmailBatch(synthetic)).toThrow();
  });

  test('still refuses a batch this store must never send', () => {
    // A human confirmed it, it is the verified SES integration, and it is an
    // email batch. These remain the conditions for sending anything.
    expect(() =>
      assertEmailBatch({ ...batch, channel: 'push' as const }),
    ).toThrow();
    expect(() =>
      assertEmailBatch({
        ...batch,
        integrationStatus: { ...batch.integrationStatus, label: 'mocked' },
      }),
    ).toThrow();
  });

  test('holds a controlled canary to every condition it always had', () => {
    expect(() => assertControlledCanaryBatch(batch)).not.toThrow();
    expect(() =>
      assertControlledCanaryBatch({ ...batch, endpointCount: 2 }),
    ).toThrow();
    expect(() =>
      assertControlledCanaryBatch({ ...batch, eventKind: 'incident' as const }),
    ).toThrow();
    expect(() =>
      assertControlledCanaryBatch({ ...batch, templateMode: 'real' as const }),
    ).toThrow();
    expect(() =>
      assertControlledCanaryBatch({ ...batch, purpose: 'all-clear' as const }),
    ).toThrow();
  });
});
