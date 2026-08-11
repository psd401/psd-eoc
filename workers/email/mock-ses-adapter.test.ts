import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  EmailEndpointSchema,
  type DispatchBatch,
  type EmailEndpoint,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import {
  IDS,
  attemptFor,
  realBatch,
  syntheticBatch,
} from '../shared/test-fixtures';
import { MOCK_SES_PROVIDER, MockSesEmailAdapter } from './mock-ses-adapter';

function emailBatch(live = false): DispatchBatch {
  const base = live ? realBatch() : syntheticBatch();
  return DispatchBatchSchema.parse({
    ...base,
    channel: 'email',
    renderedMessage: live
      ? {
          eventKind: 'incident',
          templateMode: 'real',
          purpose: 'activation',
          classificationMarker: 'INCIDENT',
          channel: 'email',
          subject:
            '[INCIDENT] REAL INCIDENT - ACTIVATION: Synthetic proof [INCIDENT]',
          textBody:
            '[INCIDENT] REAL INCIDENT - ACTIVATION: Synthetic proof only. [INCIDENT]',
        }
      : {
          eventKind: 'test',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          channel: 'email',
          subject:
            '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic proof [DRILL]',
          textBody:
            '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic proof only. [DRILL]',
        },
    integrationStatus: {
      ...base.integrationStatus,
      integrationId: 'ses-email',
    },
  });
}

function endpoint(
  live = false,
  email = live
    ? 'authorized-staff@example.invalid'
    : 'synthetic-recipient@example.invalid',
): EmailEndpoint {
  return EmailEndpointSchema.parse({
    id: IDS.endpoint,
    status: 'active',
    capturedAt: '2026-08-10T16:00:00.000Z',
    channel: 'email',
    email,
  });
}

function workItem(live = false, email?: string): WorkerAttemptWorkItem {
  const batch = emailBatch(live);
  return Object.freeze({
    batch,
    attempt: attemptFor(batch),
    endpoint: endpoint(live, email),
  });
}

describe('mock SES adapter', () => {
  test('is explicitly mocked, network-free, and attempt-ID idempotent', async () => {
    const adapter = new MockSesEmailAdapter();
    const item = workItem();
    const request = { workItem: item, idempotencyKey: item.attempt.id };

    const first = await adapter.send(request);
    const replay = await adapter.send(request);

    expect(adapter.channel).toBe('email');
    expect(adapter.integrationId).toBe('ses-email');
    expect(adapter.truthLabel).toBe('mocked');
    expect(adapter.provider).toBe(MOCK_SES_PROVIDER);
    expect(adapter.deliverySemantics).toBe('attempt-id-idempotent');
    expect(adapter.logicalSendCount).toBe(1);
    expect(replay).toEqual(first);
    expect(first).toEqual({
      state: 'provider-accepted',
      provider: MOCK_SES_PROVIDER,
      providerReference: `${MOCK_SES_PROVIDER}:${IDS.attempt}`,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });
  });

  test('accepts only synthetic drill copy with an unroutable reserved endpoint', async () => {
    const adapter = new MockSesEmailAdapter();
    const item = workItem();

    await expect(
      adapter.send({ workItem: item, idempotencyKey: item.attempt.id }),
    ).resolves.toEqual(expect.objectContaining({ state: 'provider-accepted' }));
    expect(item.batch.templateMode).toBe('drill');
    expect(item.batch.renderedMessage).toEqual(
      expect.objectContaining({
        channel: 'email',
        classificationMarker: 'DRILL',
        subject: expect.stringContaining('[DRILL] TRAINING ONLY'),
        textBody: expect.stringContaining('[DRILL] TRAINING ONLY'),
      }),
    );
  });

  test('rejects staff work without recording a mock logical send', async () => {
    const adapter = new MockSesEmailAdapter();
    const item = workItem(true);

    await expect(
      adapter.send({ workItem: item, idempotencyKey: item.attempt.id }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'MOCK_SES_WORK_ITEM_REJECTED',
        disposition: 'terminal-failure',
      }),
    );
    expect(adapter.logicalSendCount).toBe(0);
  });

  test('shared validation rejects a routable synthetic endpoint fail closed', async () => {
    const adapter = new MockSesEmailAdapter();
    const item = workItem(false, 'synthetic-recipient@example.com');

    await expect(
      adapter.send({ workItem: item, idempotencyKey: item.attempt.id }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'ROUTABLE_SYNTHETIC_ENDPOINT' }),
    );
    expect(adapter.logicalSendCount).toBe(0);
  });

  test('rejects attempt-ID reuse for changed immutable work', async () => {
    const adapter = new MockSesEmailAdapter();
    const first = workItem();
    const changed = workItem(false, 'different-synthetic@example.invalid');

    await adapter.send({
      workItem: first,
      idempotencyKey: first.attempt.id,
    });
    await expect(
      adapter.send({
        workItem: changed,
        idempotencyKey: changed.attempt.id,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'MOCK_SES_IDEMPOTENCY_CONFLICT',
        disposition: 'terminal-failure',
      }),
    );
    expect(adapter.logicalSendCount).toBe(1);
  });

  test('rejects an idempotency key that is not the immutable attempt ID', async () => {
    const adapter = new MockSesEmailAdapter();
    const item = workItem();

    await expect(
      adapter.send({
        workItem: item,
        idempotencyKey: 'different-attempt-id',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'MOCK_SES_WORK_ITEM_REJECTED',
      }),
    );
    expect(adapter.logicalSendCount).toBe(0);
  });
});
