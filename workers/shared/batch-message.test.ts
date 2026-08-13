import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  EndpointSchema,
  type DispatchBatch,
} from '@psd-eoc/contracts';

import {
  MAX_WORKER_MESSAGE_BYTES,
  WorkerBatchMessageError,
  parseWorkerBatchMessage,
  serializeWorkerBatchMessage,
  workerBatchDeduplicationKey,
} from './batch-message';
import {
  WorkerAttemptError,
  parseWorkerAttemptWorkItem,
  workerAttemptFingerprint,
} from './attempt';
import {
  IDS,
  TIMES,
  attemptFor,
  deliveryTestBatch,
  syntheticBatch,
  workItem,
} from './test-fixtures';

function syntheticSmsWorkItem(phoneNumber: string) {
  const base = syntheticBatch();
  const batch: DispatchBatch = DispatchBatchSchema.parse({
    ...base,
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
      ...base.integrationStatus,
      integrationId: 'aws-eum-sms',
    },
  });
  return {
    batch,
    attempt: attemptFor(batch),
    endpoint: EndpointSchema.parse({
      id: IDS.endpoint,
      status: 'active',
      capturedAt: TIMES.created,
      channel: 'sms',
      phoneNumber,
    }),
  };
}

describe('canonical worker batch message', () => {
  test('round-trips a raw destination-free DispatchBatch', () => {
    const batch = syntheticBatch();
    const body = serializeWorkerBatchMessage(batch);

    expect(parseWorkerBatchMessage(body)).toEqual(batch);
    expect(workerBatchDeduplicationKey(batch)).toBe(IDS.batch);
    expect(body).not.toContain('synthetic-unroutable');
    expect(JSON.parse(body)).not.toHaveProperty('batch');
  });

  test('rejects invented wrappers, fields, oversized bodies, and mode drift', () => {
    const batch = syntheticBatch();
    for (const candidate of [
      { version: 1, kind: 'notification-batch', batch },
      { ...batch, unexpected: true },
      { ...batch, templateMode: 'real' },
      {
        ...batch,
        renderedMessage: {
          ...batch.renderedMessage,
          classificationMarker: 'INCIDENT',
        },
      },
    ]) {
      expect(() => parseWorkerBatchMessage(candidate)).toThrow(
        WorkerBatchMessageError,
      );
    }
    const oversized = JSON.stringify({
      padding: 'x'.repeat(MAX_WORKER_MESSAGE_BYTES),
    });
    expect(() => parseWorkerBatchMessage(oversized)).toThrow(
      expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }),
    );
  });
});

describe('resolved endpoint attempt', () => {
  test('binds batch, persisted attempt, and pinned endpoint', () => {
    const item = workItem();
    expect(parseWorkerAttemptWorkItem(item)).toEqual(item);
    expect(workerAttemptFingerprint(item)).toMatch(/^[a-f0-9]{64}$/u);
    expect(workerAttemptFingerprint(item)).toBe(
      workerAttemptFingerprint(workItem()),
    );
  });

  test('rejects identity drift, inactive endpoints, and routable synthetic data', () => {
    const item = workItem();
    for (const candidate of [
      { ...item, attempt: { ...item.attempt, eventId: IDS.actor } },
      { ...item, endpoint: { ...item.endpoint, status: 'disabled' } },
      {
        ...item,
        endpoint: {
          ...item.endpoint,
          token: 'ExponentPushToken[routable-looking-fixture]',
        },
      },
    ]) {
      expect(() => parseWorkerAttemptWorkItem(candidate)).toThrow(
        WorkerAttemptError,
      );
    }
  });

  test('changes only the digest when immutable endpoint work changes', () => {
    const original = workItem();
    const changed = {
      ...original,
      endpoint: {
        ...original.endpoint,
        token: 'synthetic-unroutable:another-device',
      },
    };
    const digest = workerAttemptFingerprint(changed);

    expect(digest).not.toBe(workerAttemptFingerprint(original));
    expect(digest).not.toContain('another-device');
  });

  test('requires attempt canary provenance to exactly match its batch', () => {
    const item = workItem(deliveryTestBatch());
    expect(parseWorkerAttemptWorkItem(item)).toEqual(item);

    for (const deliveryTest of [
      null,
      {
        ...item.attempt.deliveryTest,
        endpointReferenceDigest: 'e'.repeat(64),
      },
      {
        ...item.attempt.deliveryTest,
        targetSet: {
          ...item.attempt.deliveryTest?.targetSet,
          version: 2,
        },
      },
    ]) {
      expect(() =>
        parseWorkerAttemptWorkItem({
          ...item,
          attempt: { ...item.attempt, deliveryTest },
        }),
      ).toThrow(expect.objectContaining({ code: 'ATTEMPT_BATCH_MISMATCH' }));
    }
  });

  test('accepts only the reserved synthetic SMS fixture namespaces', () => {
    for (const phoneNumber of ['+12025550123', '+999000000000000']) {
      expect(
        parseWorkerAttemptWorkItem(syntheticSmsWorkItem(phoneNumber)).endpoint,
      ).toMatchObject({ channel: 'sms', phoneNumber });
    }
    expect(() =>
      parseWorkerAttemptWorkItem(syntheticSmsWorkItem('+998000000000000')),
    ).toThrow(expect.objectContaining({ code: 'ROUTABLE_SYNTHETIC_ENDPOINT' }));
  });
});
