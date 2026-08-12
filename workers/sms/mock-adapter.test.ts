import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  EndpointSchema,
  type DispatchBatch,
  type Endpoint,
} from '@psd-eoc/contracts';

import type { ProviderSendRequest } from '../shared';
import {
  IDS,
  TIMES,
  attemptFor,
  realBatch,
  syntheticBatch,
} from '../shared/test-fixtures';
import { MockAwsEumSmsAdapter } from './mock-adapter';

const DRILL_BODY =
  '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic drill only. [DRILL]';

function smsBatch(population: 'synthetic' | 'staff'): DispatchBatch {
  const base = population === 'synthetic' ? syntheticBatch() : realBatch();
  const marker = population === 'synthetic' ? 'DRILL' : 'INCIDENT';
  return DispatchBatchSchema.parse({
    ...base,
    channel: 'sms',
    renderedMessage: {
      eventKind: base.eventKind,
      templateMode: base.templateMode,
      purpose: base.purpose,
      classificationMarker: marker,
      channel: 'sms',
      body:
        population === 'synthetic'
          ? DRILL_BODY
          : '[INCIDENT] REAL INCIDENT - ACTIVATION: Synthetic test. [INCIDENT]',
    },
    integrationStatus: {
      ...base.integrationStatus,
      integrationId: 'aws-eum-sms',
    },
  });
}

function endpoint(phoneNumber = '+12025550123'): Endpoint {
  return EndpointSchema.parse({
    id: IDS.endpoint,
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'sms',
    phoneNumber,
  });
}

function requestFor(
  batch: DispatchBatch,
  selectedEndpoint: Endpoint = endpoint(),
): ProviderSendRequest {
  const attempt = attemptFor(batch);
  return Object.freeze({
    workItem: Object.freeze({ batch, attempt, endpoint: selectedEndpoint }),
    idempotencyKey: attempt.id,
  });
}

describe('fail-closed AWS EUM SMS CI mock', () => {
  test('accepts only canonical DRILL synthetic work and replays one logical send', async () => {
    const adapter = new MockAwsEumSmsAdapter();
    const request = requestFor(smsBatch('synthetic'));

    const first = await adapter.send(request);
    const replay = await adapter.send(request);

    expect(first).toEqual({
      state: 'provider-accepted',
      provider: 'mock-aws-eum-sms',
      providerReference: `mock-sms:${IDS.attempt}`,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });
    expect(replay).toEqual(first);
    expect(adapter.logicalSendCount).toBe(1);
    expect(request.workItem.batch.renderedMessage).toMatchObject({
      channel: 'sms',
      classificationMarker: 'DRILL',
      body: DRILL_BODY,
    });
  });

  test('rejects live-verified work and routable synthetic destinations', async () => {
    for (const request of [
      requestFor(smsBatch('staff')),
      requestFor(smsBatch('synthetic'), endpoint('+12065550123')),
    ]) {
      const adapter = new MockAwsEumSmsAdapter();
      await expect(adapter.send(request)).rejects.toMatchObject({
        code: 'AWS_EUM_WORK_ITEM_INVALID',
      });
      expect(adapter.logicalSendCount).toBe(0);
    }
  });

  test('rejects reuse of one attempt ID for different immutable copy', async () => {
    const adapter = new MockAwsEumSmsAdapter();
    const originalBatch = smsBatch('synthetic');
    const original = requestFor(originalBatch);
    const driftedBatch = DispatchBatchSchema.parse({
      ...originalBatch,
      renderedMessage: {
        ...originalBatch.renderedMessage,
        body: '[DRILL] TRAINING ONLY - ACTIVATION: Changed copy. [DRILL]',
      },
    });
    const drifted = Object.freeze({
      workItem: Object.freeze({
        ...original.workItem,
        batch: driftedBatch,
      }),
      idempotencyKey: original.idempotencyKey,
    });

    await expect(adapter.send(original)).resolves.toBeDefined();
    await expect(adapter.send(drifted)).rejects.toMatchObject({
      code: 'MOCK_SMS_IDEMPOTENCY_CONFLICT',
    });
    expect(adapter.logicalSendCount).toBe(1);
  });
});
