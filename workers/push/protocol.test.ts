import { describe, expect, test } from 'bun:test';

import { realBatch, syntheticBatch, workItem } from '../shared/test-fixtures';
import {
  EXPO_ANDROID_CHANNEL_ID,
  EXPO_DRILL_CATEGORY_ID,
  EXPO_EMERGENCY_TTL_SECONDS,
  EXPO_INCIDENT_CATEGORY_ID,
  chunkExpoValues,
  createExpoPushMessage,
  parseExpoReceiptResponse,
  parseExpoProviderOutcome,
  parseExpoTicketResponse,
} from './protocol';

describe('Expo canonical payload', () => {
  test('preserves exact renderer titles and uses distinct real/drill categories', () => {
    const real = createExpoPushMessage(
      workItem(realBatch()),
      realBatch().createdAt,
    );
    const drill = createExpoPushMessage(
      workItem(syntheticBatch()),
      syntheticBatch().createdAt,
    );

    expect(real.title).toBe('[INCIDENT] Lockdown');
    expect(drill.title).toBe('[DRILL] Synthetic lockdown test');
    expect(EXPO_INCIDENT_CATEGORY_ID).toBe('PSD_EOC_INCIDENT');
    expect(EXPO_DRILL_CATEGORY_ID).toBe('PSD_EOC_DRILL');
    expect(real.categoryId).toBe(EXPO_INCIDENT_CATEGORY_ID);
    expect(drill.categoryId).toBe(EXPO_DRILL_CATEGORY_ID);
    expect(real.categoryId).not.toBe(drill.categoryId);
    expect(real.channelId).toBe(EXPO_ANDROID_CHANNEL_ID);
    expect(drill.channelId).toBe(EXPO_ANDROID_CHANNEL_ID);
    expect(real.ttl).toBe(EXPO_EMERGENCY_TTL_SECONDS);
    expect(drill.ttl).toBe(EXPO_EMERGENCY_TTL_SECONDS);
    expect(real.expiration).toBe(
      Date.parse(realBatch().createdAt) / 1_000 + EXPO_EMERGENCY_TTL_SECONDS,
    );
    expect(EXPO_EMERGENCY_TTL_SECONDS).toBeGreaterThan(0);
    expect(EXPO_EMERGENCY_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
    expect(real.data).toMatchObject({
      eventKind: 'incident',
      templateMode: 'real',
    });
    expect(drill.data).toMatchObject({
      eventKind: 'test',
      templateMode: 'drill',
    });
  });

  test('derives a shrinking TTL and immutable expiration from batch creation', () => {
    const batch = realBatch();
    const halfway = new Date(
      Date.parse(batch.createdAt) + (EXPO_EMERGENCY_TTL_SECONDS / 2) * 1_000,
    );
    const atHorizon = new Date(
      Date.parse(batch.createdAt) + EXPO_EMERGENCY_TTL_SECONDS * 1_000,
    );

    const active = createExpoPushMessage(workItem(batch), halfway);
    const stale = createExpoPushMessage(workItem(batch), atHorizon);

    expect(active.ttl).toBe(EXPO_EMERGENCY_TTL_SECONDS / 2);
    expect(stale.ttl).toBe(0);
    expect(stale.expiration).toBe(active.expiration);
  });

  test('never extends relative TTL beyond the immutable batch lifetime', () => {
    const batch = realBatch();
    const beforeCreation = new Date(
      Date.parse(batch.createdAt) - EXPO_EMERGENCY_TTL_SECONDS * 1_000,
    );
    const oneMillisecondBeforeExpiry = new Date(
      Date.parse(batch.createdAt) + EXPO_EMERGENCY_TTL_SECONDS * 1_000 - 1,
    );

    expect(createExpoPushMessage(workItem(batch), beforeCreation).ttl).toBe(
      EXPO_EMERGENCY_TTL_SECONDS,
    );
    expect(
      createExpoPushMessage(workItem(batch), oneMillisecondBeforeExpiry).ttl,
    ).toBe(0);
  });

  test('rejects real/drill marker tampering before building a provider payload', () => {
    const real = workItem(realBatch());
    const drill = workItem(syntheticBatch());

    expect(() =>
      createExpoPushMessage({
        ...real,
        batch: {
          ...real.batch,
          renderedMessage: {
            ...real.batch.renderedMessage,
            title: '[DRILL] Tampered incident',
          },
        },
      }),
    ).toThrow();
    expect(() =>
      createExpoPushMessage({
        ...drill,
        batch: {
          ...drill.batch,
          renderedMessage: {
            ...drill.batch.renderedMessage,
            body: '[INCIDENT] Tampered drill',
          },
        },
      }),
    ).toThrow();
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
  test('accepts only exact and internally consistent provider outcomes', () => {
    const accepted = {
      kind: 'provider-accepted',
      state: 'provider-accepted',
      providerReference: 'ticket-canonical-1',
      reasonCode: null,
      invalidatesEndpoint: false,
    } as const;

    const parsed = parseExpoProviderOutcome(accepted);
    expect(parsed).toEqual(accepted);
    expect(parsed).not.toBe(accepted);
    expect(Object.isFrozen(parsed)).toBe(true);

    const malformed = [
      { ...accepted, extra: 'hostile' },
      { ...accepted, state: 'delivered' },
      { ...accepted, providerReference: 'ticket-1\nsecret' },
      { ...accepted, reasonCode: 'EXPO_DEVICE_NOT_REGISTERED' },
      {
        kind: 'failed',
        state: 'failed',
        providerReference: null,
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        invalidatesEndpoint: false,
      },
      {
        kind: 'failed',
        state: 'failed',
        providerReference: null,
        reasonCode: 'EXPO_MESSAGE_TOO_BIG',
        invalidatesEndpoint: true,
      },
      {
        kind: 'retry',
        state: 'failed',
        providerReference: null,
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        invalidatesEndpoint: false,
      },
      {
        kind: 'failed',
        state: 'failed',
        providerReference: null,
        reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
        invalidatesEndpoint: false,
      },
      {
        kind: 'unknown',
        state: 'unknown',
        providerReference: null,
        reasonCode: 'untrusted provider text',
        invalidatesEndpoint: false,
      },
    ];
    expect(malformed.map((value) => parseExpoProviderOutcome(value))).toEqual(
      malformed.map(() => null),
    );

    const accessorOutcome = { ...accepted };
    Object.defineProperty(accessorOutcome, 'providerReference', {
      enumerable: true,
      get: () => 'ticket-accessor',
    });
    expect(parseExpoProviderOutcome(accessorOutcome)).toBeNull();
  });

  test('enforces the exact provider-item outcome kind for every safe reason code', () => {
    const canonicalKinds = [
      ['EXPO_DEVICE_NOT_REGISTERED', 'failed'],
      ['EXPO_HTTP_CLIENT_ERROR', null],
      ['EXPO_HTTP_RATE_LIMITED', null],
      ['EXPO_HTTP_SERVER_ERROR', null],
      ['EXPO_INVALID_CREDENTIALS', 'failed'],
      ['EXPO_LIVE_TRANSPORT_DISABLED', null],
      ['EXPO_MESSAGE_RATE_EXCEEDED', 'retry'],
      ['EXPO_MESSAGE_TOO_BIG', 'failed'],
      ['EXPO_MISMATCH_SENDER_ID', 'failed'],
      ['EXPO_NETWORK_OUTCOME_AMBIGUOUS', 'unknown'],
      ['EXPO_NOTIFICATION_EXPIRED', 'failed'],
      ['EXPO_RECEIPT_ERROR_UNKNOWN', 'unknown'],
      ['EXPO_RECEIPT_HORIZON_EXPIRED', null],
      ['EXPO_RECEIPT_MISSING', 'unknown'],
      ['EXPO_RECEIPT_REFERENCE_CONFLICT', null],
      ['EXPO_RECEIPT_RESPONSE_INVALID', 'unknown'],
      ['EXPO_RESPONSE_TOO_LARGE', null],
      ['EXPO_TICKET_ERROR_UNKNOWN', 'unknown'],
      ['EXPO_TICKET_MISSING', 'unknown'],
      ['EXPO_TICKET_RESPONSE_INVALID', 'unknown'],
      ['PROVIDER_RETRY_EXHAUSTED', null],
    ] as const;
    const kinds = ['failed', 'retry', 'unknown'] as const;

    for (const [reasonCode, canonicalKind] of canonicalKinds) {
      for (const kind of kinds) {
        const candidate =
          kind === 'failed'
            ? ({
                kind,
                state:
                  reasonCode === 'EXPO_NOTIFICATION_EXPIRED'
                    ? 'expired'
                    : 'failed',
                providerReference: 'outcome-matrix-reference',
                reasonCode,
                invalidatesEndpoint:
                  reasonCode === 'EXPO_DEVICE_NOT_REGISTERED',
              } as const)
            : kind === 'retry'
              ? ({
                  kind,
                  state: 'failed',
                  providerReference: 'outcome-matrix-reference',
                  reasonCode,
                  invalidatesEndpoint: false,
                } as const)
              : ({
                  kind,
                  state: 'unknown',
                  providerReference: 'outcome-matrix-reference',
                  reasonCode,
                  invalidatesEndpoint: false,
                } as const);

        const parsed = parseExpoProviderOutcome(candidate);
        if (kind === canonicalKind) {
          expect(parsed).toEqual(candidate);
          expect(Object.isFrozen(parsed)).toBe(true);
        } else {
          expect(parsed).toBeNull();
        }
      }
    }

    expect(
      parseExpoProviderOutcome({
        kind: 'failed',
        state: 'failed',
        providerReference: null,
        reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
        invalidatesEndpoint: false,
      }),
    ).toBeNull();
  });

  test('enforces ticket and receipt reason phases independently', () => {
    const outcome = (reasonCode: string) => ({
      kind: 'unknown',
      state: 'unknown',
      providerReference: 'phase-reference',
      reasonCode,
      invalidatesEndpoint: false,
    });

    expect(
      parseExpoProviderOutcome(outcome('EXPO_TICKET_MISSING'), 'ticket'),
    ).toMatchObject({ reasonCode: 'EXPO_TICKET_MISSING' });
    expect(
      parseExpoProviderOutcome(outcome('EXPO_TICKET_MISSING'), 'receipt'),
    ).toBeNull();
    expect(
      parseExpoProviderOutcome(outcome('EXPO_RECEIPT_MISSING'), 'receipt'),
    ).toMatchObject({ reasonCode: 'EXPO_RECEIPT_MISSING' });
    expect(
      parseExpoProviderOutcome(outcome('EXPO_RECEIPT_MISSING'), 'ticket'),
    ).toBeNull();
    expect(
      parseExpoProviderOutcome(
        outcome('EXPO_RECEIPT_REFERENCE_CONFLICT'),
        'receipt',
      ),
    ).toBeNull();
  });

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

  test('bounds hostile top-level array lengths without invoking length, iterator, or map traps', () => {
    let trapCalls = 0;
    const noPropertyReads = <Value extends readonly unknown[]>(value: Value) =>
      new Proxy(value, {
        get: (target, property, receiver) => {
          if (
            property === 'length' ||
            property === Symbol.iterator ||
            property === 'map'
          ) {
            trapCalls += 1;
            throw new Error('synthetic hostile array property');
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    const data = noPropertyReads([{ status: 'ok', id: 'ticket-safe' }]);
    const errors = noPropertyReads([]);

    expect(parseExpoTicketResponse({ data, errors }, 1)).toEqual([
      expect.objectContaining({
        kind: 'provider-accepted',
        providerReference: 'ticket-safe',
      }),
    ]);
    expect(trapCalls).toBe(0);

    const hostileDataLength = new Proxy(
      [{ status: 'ok', id: 'ticket-unreadable-data-length' }],
      {
        getOwnPropertyDescriptor: (target, property) => {
          if (property === 'length') {
            throw new Error('synthetic hostile data length');
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    expect(parseExpoTicketResponse({ data: hostileDataLength }, 1)).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        reasonCode: 'EXPO_TICKET_RESPONSE_INVALID',
      }),
    ]);

    const hostileErrorsLength = new Proxy([], {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === 'length') {
          throw new Error('synthetic hostile errors length');
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(
      parseExpoTicketResponse(
        {
          data: [{ status: 'ok', id: 'ticket-unreadable-errors-length' }],
          errors: hostileErrorsLength,
        },
        1,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        reasonCode: 'EXPO_TICKET_RESPONSE_INVALID',
      }),
    ]);
  });

  test('rejects an accessor-backed ticket slot without invoking it or discarding valid siblings', () => {
    let getterCalls = 0;
    const data = [
      { status: 'ok', id: 'ticket-accessor-sibling-1' },
      { status: 'ok', id: 'ticket-accessor-hostile' },
      { status: 'ok', id: 'ticket-accessor-sibling-2' },
    ];
    Object.defineProperty(data, 1, {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('synthetic hostile ticket accessor');
      },
    });

    expect(
      parseExpoTicketResponse({ data }, 3).map((outcome) => [
        outcome.kind,
        outcome.providerReference,
        outcome.reasonCode,
      ]),
    ).toEqual([
      ['provider-accepted', 'ticket-accessor-sibling-1', null],
      ['unknown', null, 'EXPO_TICKET_RESPONSE_INVALID'],
      ['provider-accepted', 'ticket-accessor-sibling-2', null],
    ]);
    expect(getterCalls).toBe(0);
  });

  test('isolates a throwing proxy index while preserving readable ticket siblings', () => {
    const data = new Proxy(
      [
        { status: 'ok', id: 'ticket-proxy-sibling-1' },
        { status: 'ok', id: 'ticket-proxy-hostile' },
        { status: 'ok', id: 'ticket-proxy-sibling-2' },
      ],
      {
        getOwnPropertyDescriptor: (target, property) => {
          if (property === '1') {
            throw new Error('synthetic hostile ticket proxy slot');
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    expect(
      parseExpoTicketResponse({ data }, 3).map((outcome) => [
        outcome.kind,
        outcome.providerReference,
        outcome.reasonCode,
      ]),
    ).toEqual([
      ['provider-accepted', 'ticket-proxy-sibling-1', null],
      ['unknown', null, 'EXPO_TICKET_RESPONSE_INVALID'],
      ['provider-accepted', 'ticket-proxy-sibling-2', null],
    ]);
  });

  test('rejects contradictory successes, duplicate ticket IDs, and malformed top-level errors', () => {
    expect(
      parseExpoTicketResponse(
        {
          data: [
            {
              status: 'ok',
              id: 'ticket-contradictory',
              details: { error: 'DeviceNotRegistered' },
            },
          ],
        },
        1,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        reasonCode: 'EXPO_TICKET_RESPONSE_INVALID',
      }),
    ]);
    expect(
      parseExpoTicketResponse(
        {
          data: [
            { status: 'ok', id: 'ticket-duplicate' },
            { status: 'ok', id: 'ticket-duplicate' },
          ],
        },
        2,
      ).map((outcome) => outcome.reasonCode),
    ).toEqual(['EXPO_TICKET_RESPONSE_INVALID', 'EXPO_TICKET_RESPONSE_INVALID']);
    expect(
      parseExpoTicketResponse(
        {
          data: [{ status: 'ok', id: 'ticket-1' }],
          errors: { code: 'malformed' },
        },
        1,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        reasonCode: 'EXPO_TICKET_RESPONSE_INVALID',
      }),
    ]);
    expect(
      parseExpoReceiptResponse(
        {
          data: {
            'ticket-1': {
              status: 'ok',
              details: { error: 'DeviceNotRegistered' },
            },
          },
        },
        ['ticket-1'],
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID',
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
