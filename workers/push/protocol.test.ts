import { describe, expect, test } from 'bun:test';

import { realBatch, syntheticBatch, workItem } from '../shared/test-fixtures';
import {
  EXPO_ANDROID_CHANNEL_ID,
  EXPO_DRILL_CATEGORY_ID,
  EXPO_INCIDENT_CATEGORY_ID,
  chunkExpoValues,
  createExpoPushMessage,
  parseExpoReceiptResponse,
  parseExpoTicketResponse,
} from './protocol';

describe('Expo canonical payload', () => {
  test('preserves exact renderer titles and uses distinct real/drill categories', () => {
    const real = createExpoPushMessage(workItem(realBatch()));
    const drill = createExpoPushMessage(workItem(syntheticBatch()));

    expect(real.title).toBe('[INCIDENT] Lockdown');
    expect(drill.title).toBe('[DRILL] Synthetic lockdown test');
    expect(EXPO_INCIDENT_CATEGORY_ID).toBe('PSD_EOC_INCIDENT');
    expect(EXPO_DRILL_CATEGORY_ID).toBe('PSD_EOC_DRILL');
    expect(real.categoryId).toBe(EXPO_INCIDENT_CATEGORY_ID);
    expect(drill.categoryId).toBe(EXPO_DRILL_CATEGORY_ID);
    expect(real.categoryId).not.toBe(drill.categoryId);
    expect(real.channelId).toBe(EXPO_ANDROID_CHANNEL_ID);
    expect(drill.channelId).toBe(EXPO_ANDROID_CHANNEL_ID);
    expect(real.data).toMatchObject({
      eventKind: 'incident',
      templateMode: 'real',
    });
    expect(drill.data).toMatchObject({
      eventKind: 'test',
      templateMode: 'drill',
    });
  });

  test('creates stable chunks without exceeding provider bounds', () => {
    const chunks = chunkExpoValues(
      Array.from({ length: 201 }, (_unused, index) => index),
      100,
    );
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 1]);
    expect(chunks.flat()).toEqual(
      Array.from({ length: 201 }, (_unused, index) => index),
    );
  });
});

describe('Expo untrusted provider response mapping', () => {
  test('maps partial tickets independently', () => {
    const outcomes = parseExpoTicketResponse(
      {
        data: [
          { status: 'ok', id: 'ticket-1' },
          {
            status: 'error',
            message: 'untrusted',
            details: { error: 'DeviceNotRegistered' },
          },
          {
            status: 'error',
            message: 'untrusted',
            details: { error: 'MessageRateExceeded' },
          },
        ],
      },
      4,
    );

    expect(outcomes).toEqual([
      expect.objectContaining({
        kind: 'provider-accepted',
        state: 'provider-accepted',
        providerReference: 'ticket-1',
      }),
      expect.objectContaining({
        kind: 'failed',
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        invalidatesEndpoint: true,
      }),
      expect.objectContaining({
        kind: 'retry',
        reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
      }),
      expect.objectContaining({
        kind: 'unknown',
        reasonCode: 'EXPO_TICKET_MISSING',
      }),
    ]);
  });

  test('rejects provider references containing control characters', () => {
    expect(
      parseExpoTicketResponse(
        { data: [{ status: 'ok', id: 'ticket-1\nsecret' }] },
        1,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        reasonCode: 'EXPO_TICKET_RESPONSE_INVALID',
      }),
    ]);
  });

  test('never treats Expo receipt success as device delivery', () => {
    const outcomes = parseExpoReceiptResponse(
      {
        data: {
          'ticket-1': { status: 'ok' },
          'ticket-2': {
            status: 'error',
            message: 'untrusted',
            details: { error: 'DeviceNotRegistered' },
          },
        },
      },
      ['ticket-1', 'ticket-2', 'ticket-3'],
    );

    expect(outcomes[0]).toMatchObject({
      kind: 'provider-accepted',
      state: 'provider-accepted',
    });
    expect(outcomes[0]).not.toHaveProperty('proof');
    expect(outcomes[1]).toMatchObject({
      kind: 'failed',
      reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
    });
    expect(outcomes[2]).toMatchObject({
      kind: 'unknown',
      reasonCode: 'EXPO_RECEIPT_MISSING',
    });
    expect(outcomes.map((outcome) => String(outcome.state))).not.toContain(
      'delivered',
    );
  });
});
