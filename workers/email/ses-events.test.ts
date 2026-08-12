import { describe, expect, test } from 'bun:test';

import {
  RecordDeliveryEvidenceInputSchema,
  RecordEndpointStatusInputSchema,
} from '@psd-eoc/contracts';

import { IDS } from '../shared/test-fixtures';
import {
  SES_CONFIGURATION_SET_NAME,
  SES_CORRELATION_TAG_NAMES,
  SES_V2_PROVIDER,
} from './ses-adapter';
import { SesEventError, parseSesEvent } from './ses-events';

const SNS_MESSAGE_ID = '20000000-0000-4000-8000-000000000001';
const SES_MESSAGE_ID = '0101010198f-synthetic-provider-id';
const EVENT_TIME = '2026-08-11T20:30:00.000Z';

function sesEvent(
  eventType: string,
  eventBody: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const bodyKey =
    eventType === 'Rendering Failure'
      ? 'failure'
      : eventType === 'DeliveryDelay'
        ? 'deliveryDelay'
        : eventType.toLowerCase();
  return JSON.stringify({
    eventType,
    mail: {
      timestamp: EVENT_TIME,
      messageId: SES_MESSAGE_ID,
      source: 'synthetic-sender@alerts.psd401.net',
      sendingAccountId: '338414773271',
      destination: ['private-recipient@example.invalid'],
      tags: {
        'ses:configuration-set': [SES_CONFIGURATION_SET_NAME],
        [SES_CORRELATION_TAG_NAMES.attemptId]: [IDS.attempt],
        [SES_CORRELATION_TAG_NAMES.endpointId]: [IDS.endpoint],
        [SES_CORRELATION_TAG_NAMES.rosterSnapshotId]: [IDS.roster],
        [SES_CORRELATION_TAG_NAMES.recipientId]: [IDS.recipient],
        [SES_CORRELATION_TAG_NAMES.templateMode]: ['drill'],
        [SES_CORRELATION_TAG_NAMES.eventKind]: ['test'],
      },
    },
    [bodyKey]: eventBody,
    ...overrides,
  });
}

function parse(message: string) {
  return parseSesEvent(message, { snsMessageId: SNS_MESSAGE_ID });
}

describe('signed SES configuration-set event mapping', () => {
  test('maps Send to provider acceptance without destination data', () => {
    const result = parse(sesEvent('Send', {}));

    expect(result).toEqual({
      attemptId: IDS.attempt,
      endpointId: IDS.endpoint,
      rosterSnapshotId: IDS.roster,
      recipientId: IDS.recipient,
      templateMode: 'drill',
      eventKind: 'test',
      mailMessageId: SES_MESSAGE_ID,
      evidence: {
        subject: { kind: 'attempt', attemptId: IDS.attempt },
        state: 'provider-accepted',
        provider: SES_V2_PROVIDER,
        providerReference: SES_MESSAGE_ID,
        proof: null,
        reasonCode: null,
        diagnosticDigest: null,
      },
      endpointStatus: null,
      eventType: 'Send',
    });
    expect(
      RecordDeliveryEvidenceInputSchema.safeParse(result.evidence).success,
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-recipient');
  });

  test('maps Delivery to explicit provider delivery proof', () => {
    const result = parse(
      sesEvent('Delivery', {
        timestamp: EVENT_TIME,
        recipients: ['private-recipient@example.invalid'],
        smtpResponse: '250 accepted',
      }),
    );

    expect(result.evidence).toEqual({
      subject: { kind: 'attempt', attemptId: IDS.attempt },
      state: 'delivered',
      provider: SES_V2_PROVIDER,
      providerReference: SES_MESSAGE_ID,
      proof: {
        kind: 'provider-delivery-receipt',
        provider: SES_V2_PROVIDER,
        receiptId: SNS_MESSAGE_ID,
        deliveredAt: EVENT_TIME,
      },
      reasonCode: null,
      diagnosticDigest: null,
    });
    expect(JSON.stringify(result)).not.toContain('private-recipient');
  });

  test('invalidates the pinned endpoint only for permanent bounces', () => {
    const permanent = parse(
      sesEvent('Bounce', {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        timestamp: EVENT_TIME,
        bouncedRecipients: [
          { emailAddress: 'private-recipient@example.invalid' },
        ],
      }),
    );
    const transient = parse(
      sesEvent('Bounce', {
        bounceType: 'Transient',
        bounceSubType: 'MailboxFull',
        timestamp: EVENT_TIME,
        bouncedRecipients: [
          { emailAddress: 'private-recipient@example.invalid' },
        ],
      }),
    );

    expect(permanent.evidence?.state).toBe('failed');
    expect(permanent.evidence?.reasonCode).toBe('SES_PERMANENT_BOUNCE');
    expect(permanent.endpointStatus).toEqual({
      rosterSnapshotId: IDS.roster,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      status: 'invalid',
      reasonCode: 'SES_PERMANENT_BOUNCE',
    });
    expect(
      RecordEndpointStatusInputSchema.safeParse(permanent.endpointStatus)
        .success,
    ).toBe(true);
    expect(transient.evidence?.state).toBe('failed');
    expect(transient.evidence?.reasonCode).toBe('SES_TRANSIENT_BOUNCE');
    expect(transient.endpointStatus).toBeNull();
    expect(JSON.stringify(permanent)).not.toContain('private-recipient');
  });

  test('maps undetermined bounce without suppressing the endpoint', () => {
    const result = parse(
      sesEvent('Bounce', {
        bounceType: 'Undetermined',
        bounceSubType: 'Undetermined',
        timestamp: EVENT_TIME,
      }),
    );

    expect(result.evidence?.reasonCode).toBe('SES_UNDETERMINED_BOUNCE');
    expect(result.endpointStatus).toBeNull();
  });

  test('disables a complained-about endpoint without regressing delivery truth', () => {
    const result = parse(
      sesEvent('Complaint', {
        timestamp: EVENT_TIME,
        feedbackId: 'synthetic-feedback-id',
        complainedRecipients: [
          { emailAddress: 'redacted-or-ambiguous@example.invalid' },
        ],
      }),
    );

    expect(result.evidence).toBeNull();
    expect(result.endpointStatus).toEqual({
      rosterSnapshotId: IDS.roster,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      status: 'disabled',
      reasonCode: 'SES_COMPLAINT',
    });
    expect(JSON.stringify(result)).not.toContain('redacted-or-ambiguous');
  });

  for (const { type, body, reason } of [
    {
      type: 'Reject',
      body: { reason: 'Bad content' },
      reason: 'SES_REJECTED',
    },
    {
      type: 'Rendering Failure',
      body: {
        templateName: 'synthetic',
        errorMessage: 'synthetic render failure',
      },
      reason: 'SES_RENDERING_FAILURE',
    },
  ] as const) {
    test(`maps configured ${type} callbacks to safe failed evidence`, () => {
      const result = parse(sesEvent(type, body));

      expect(result.evidence?.state).toBe('failed');
      expect(result.evidence?.reasonCode).toBe(reason);
      expect(result.evidence?.diagnosticDigest).toBeNull();
      expect(result.endpointStatus).toBeNull();
    });
  }

  test('acknowledges DeliveryDelay as nonterminal without inventing evidence', () => {
    const result = parse(
      sesEvent('DeliveryDelay', {
        timestamp: EVENT_TIME,
        delayType: 'MailboxFull',
        expirationTime: '2026-08-12T20:30:00.000Z',
        delayedRecipients: [
          { emailAddress: 'private-recipient@example.invalid' },
        ],
      }),
    );

    expect(result.eventType).toBe('DeliveryDelay');
    expect(result.evidence).toBeNull();
    expect(result.endpointStatus).toBeNull();
  });

  test('preserves the signed real-versus-drill distinction', () => {
    const drill = JSON.parse(sesEvent('Send', {})) as Record<string, unknown>;
    const real = structuredClone(drill) as {
      mail: { tags: Record<string, string[]> };
    };
    real.mail.tags[SES_CORRELATION_TAG_NAMES.templateMode] = ['real'];
    real.mail.tags[SES_CORRELATION_TAG_NAMES.eventKind] = ['incident'];

    expect(
      parseSesEvent(JSON.stringify(drill), { snsMessageId: SNS_MESSAGE_ID })
        .templateMode,
    ).toBe('drill');
    expect(
      parseSesEvent(JSON.stringify(real), { snsMessageId: SNS_MESSAGE_ID })
        .templateMode,
    ).toBe('real');
    expect(
      parseSesEvent(JSON.stringify(drill), { snsMessageId: SNS_MESSAGE_ID })
        .eventKind,
    ).toBe('test');
    expect(
      parseSesEvent(JSON.stringify(real), { snsMessageId: SNS_MESSAGE_ID })
        .eventKind,
    ).toBe('incident');
  });

  test('rejects missing, duplicated, malformed, or cross-account correlation tags', () => {
    const base = JSON.parse(sesEvent('Send', {})) as {
      mail: {
        sendingAccountId: string;
        tags: Record<string, string[]>;
      };
    };
    const candidates: unknown[] = [];
    for (const tag of [
      SES_CORRELATION_TAG_NAMES.attemptId,
      SES_CORRELATION_TAG_NAMES.endpointId,
      SES_CORRELATION_TAG_NAMES.rosterSnapshotId,
      SES_CORRELATION_TAG_NAMES.recipientId,
      SES_CORRELATION_TAG_NAMES.templateMode,
      SES_CORRELATION_TAG_NAMES.eventKind,
      'ses:configuration-set',
    ]) {
      const missing = structuredClone(base);
      delete missing.mail.tags[tag];
      candidates.push(missing);
    }
    const duplicated = structuredClone(base);
    duplicated.mail.tags[SES_CORRELATION_TAG_NAMES.attemptId] = [
      IDS.attempt,
      IDS.attempt,
    ];
    candidates.push(duplicated);
    const wrongMode = structuredClone(base);
    wrongMode.mail.tags[SES_CORRELATION_TAG_NAMES.templateMode] = ['real-ish'];
    candidates.push(wrongMode);
    const wrongEventKind = structuredClone(base);
    wrongEventKind.mail.tags[SES_CORRELATION_TAG_NAMES.eventKind] = [
      'incident-ish',
    ];
    candidates.push(wrongEventKind);
    const wrongConfigurationSet = structuredClone(base);
    wrongConfigurationSet.mail.tags['ses:configuration-set'] = ['other'];
    candidates.push(wrongConfigurationSet);
    const wrongAccount = structuredClone(base);
    wrongAccount.mail.sendingAccountId = '000000000000';
    candidates.push(wrongAccount);

    for (const candidate of candidates) {
      expect(() => parse(JSON.stringify(candidate))).toThrow(
        expect.objectContaining({ code: 'INVALID_CORRELATION' }),
      );
    }
  });

  test('rejects unconfigured event types and malformed configured event bodies', () => {
    expect(() => parse(sesEvent('Open', { timestamp: EVENT_TIME }))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_EVENT' }),
    );
    expect(() =>
      parse(sesEvent('Delivery', { timestamp: 'not-a-timestamp' })),
    ).toThrow(SesEventError);
    expect(() =>
      parse(
        sesEvent('Bounce', { bounceType: 'NewType', timestamp: EVENT_TIME }),
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MESSAGE' }));
    expect(() =>
      parseSesEvent(sesEvent('Send', {}), { snsMessageId: 'not-a-uuid' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MESSAGE' }));
  });
});
