import { describe, expect, test } from 'bun:test';

import type { Database } from '../../db/client';
import { channelAttempts, dispatchBatches } from '../../db/schema';
import {
  emailDeliveryTestBatch,
  emailDeliveryTestWorkItem,
} from '../testing/email-runtime';
import {
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
