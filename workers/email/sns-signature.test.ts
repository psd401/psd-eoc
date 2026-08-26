import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  MAX_SNS_SIGNING_CERTIFICATE_BYTES,
  SnsSignatureError,
  canonicalSnsEnvelopeDigest,
  confirmSnsSubscription,
  parseSnsEnvelope,
  parseSnsSubscriptionConfirmationEnvelope,
  parseSnsTopicArn,
  verifySnsSignature,
  type SnsNotificationEnvelope,
  type SnsSignatureVersion,
} from './sns-signature';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:psd-eoc-email-events';
const CERTIFICATE_URL =
  'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem';

// Synthetic, test-only certificate material. It authenticates no service and
// expires in 2036; keeping it inline makes signature tests network-free.
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
<removed-test-key>
-----END PRIVATE KEY-----`;

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUIpelbBnExR3xhalWgbpfvjSj974wDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwac3ludGhldGljLXNucy10ZXN0LmludmFsaWQwHhcNMjYw
ODExMjAxOTI4WhcNMzYwODA4MjAxOTI4WjAlMSMwIQYDVQQDDBpzeW50aGV0aWMt
c25zLXRlc3QuaW52YWxpZDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AMGcRKOAZAEjzRTUmWWKhoQUbB4XAERsHsSvRv5BH5YgFB72MD/PFEGhrdy39rl/
2dTtXP34DP1C6owd0Y18udmbm+EuVZnxFCsM5c3H7JBadKGqbDpQ5ECkciGRPWAD
NsTBqxuhXh2yLONCSI4JWa8Z6TlXy0ShCI5oOGOUPFZjpSyU99gjsEQVEn6bJ4jy
zEzTtS8rgnN3XCwV1jx0jpsG7caxlDmSH2sqYKiAv6g7mzRg+tcIsZNPLW5o+7eT
VXCYX7PKeqcPM7IdolN7lL4elJGvPO0SW9Ca3gd0c/013ankfWYEcPBB/TjPnxaF
MkPQmwcvI3wNXAHcU5+QYicCAwEAAaNTMFEwHQYDVR0OBBYEFDEPvTOQAMru9jCK
a5Tnjt5oif/gMB8GA1UdIwQYMBaAFDEPvTOQAMru9jCKa5Tnjt5oif/gMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAKHH9Y9mtnyb0FoU7Eui93se
pPPbGXI0igjhNwZWCF4EA4oGJiz5Drpw0BiIiL8xP+cEkKHNCwHoGCJW9QOQZOCZ
S4dnogFYv0cxsjg1rCu3s18YVqjc52j+Fdx2El27RtQ0zSpZj+bAxuV0Ix49/jN6
8NAJuUk98GaztVJI56nU6zBlFuPyl1cgSGIQPZ18uvNdkSrKboj22iMxsfW4Hc2Q
jFTL2oqvgISezEWdM0x88EHGmKK8hxrHch4FTjpZvDT2vcx4gagc/y3UiuTxrxUn
rMNmOrHtio+QaVCZcdcs3QMwcZjIB2wLQLiCPDLz2B4mGKaTyFprzR4+9EESGEo=
-----END CERTIFICATE-----`;

type EnvelopeInput = Readonly<{
  Type: 'Notification';
  MessageId: string;
  TopicArn: string;
  Subject: string | undefined;
  Message: string;
  Timestamp: string;
  SignatureVersion: SnsSignatureVersion;
  Signature: string;
  SigningCertURL: string;
  UnsubscribeURL: string;
}>;

function canonicalString(input: {
  readonly Message: string;
  readonly MessageId: string;
  readonly Subject?: string | undefined;
  readonly Timestamp: string;
  readonly TopicArn: string;
  readonly Type: 'Notification';
}): string {
  return (
    [
      ['Message', input.Message],
      ['MessageId', input.MessageId],
      ...(input.Subject === undefined ? [] : [['Subject', input.Subject]]),
      ['Timestamp', input.Timestamp],
      ['TopicArn', input.TopicArn],
      ['Type', input.Type],
    ]
      .map(([name, value]) => `${name}\n${value}`)
      .join('\n') + '\n'
  );
}

function signedEnvelope(
  version: SnsSignatureVersion,
  overrides: Partial<EnvelopeInput> = {},
): SnsNotificationEnvelope {
  const unsigned: EnvelopeInput = {
    Type: 'Notification',
    MessageId: '10000000-0000-4000-8000-000000000001',
    TopicArn: TOPIC_ARN,
    Subject: 'Synthetic SES event',
    Message: '{"eventType":"Send"}',
    Timestamp: '2026-08-11T20:30:00.000Z',
    SignatureVersion: version,
    Signature: '',
    SigningCertURL: CERTIFICATE_URL,
    UnsubscribeURL:
      'https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&synthetic=1',
    ...overrides,
  };
  const signature = sign(
    version === '1' ? 'sha1' : 'sha256',
    Buffer.from(canonicalString(unsigned), 'utf8'),
    TEST_PRIVATE_KEY,
  ).toString('base64');
  return parseSnsEnvelope({ ...unsigned, Signature: signature }, TOPIC_ARN);
}

const loadTestCertificate = async (): Promise<string> => TEST_CERTIFICATE;
const testCertificateNow = (): Date => new Date('2026-08-11T20:30:00.000Z');

function testCertificateOptions() {
  return {
    loadSigningCertificate: loadTestCertificate,
    now: testCertificateNow,
  };
}

describe('SNS Notification signature verification', () => {
  test.each(['1', '2'] as const)(
    'verifies canonical SignatureVersion %s notifications',
    async (version) => {
      const envelope = signedEnvelope(version);

      await expect(
        verifySnsSignature(envelope, testCertificateOptions()),
      ).resolves.toBeUndefined();
    },
  );

  test('includes Subject only when present in the canonical signed fields', async () => {
    const envelope = signedEnvelope('2', { Subject: undefined });

    expect(envelope.Subject).toBeUndefined();
    await expect(
      verifySnsSignature(envelope, testCertificateOptions()),
    ).resolves.toBeUndefined();
  });

  test('rejects forged or post-signature mutated messages', async () => {
    const valid = signedEnvelope('2');
    const mutated = { ...valid, Message: '{"eventType":"Delivery"}' };
    const { privateKey: attackerKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const attackerSignature = sign(
      'sha256',
      Buffer.from(canonicalString(mutated), 'utf8'),
      attackerKey,
    ).toString('base64');

    await expect(
      verifySnsSignature(mutated, testCertificateOptions()),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    await expect(
      verifySnsSignature(
        { ...mutated, Signature: attackerSignature },
        testCertificateOptions(),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
  });

  test('produces a stable replay digest and detects same-ID content conflicts', () => {
    const first = signedEnvelope('2');
    const duplicate = signedEnvelope('2');
    const conflicting = signedEnvelope('2', {
      Message: '{"eventType":"Bounce"}',
    });

    expect(canonicalSnsEnvelopeDigest(duplicate)).toBe(
      canonicalSnsEnvelopeDigest(first),
    );
    expect(canonicalSnsEnvelopeDigest(conflicting)).not.toBe(
      canonicalSnsEnvelopeDigest(first),
    );
    expect(canonicalSnsEnvelopeDigest(first)).toMatch(/^[a-f0-9]{64}$/u);
    // Independently calculated from AWS's documented field order, including
    // the required newline after the final Type value. This catches a helper
    // and verifier accidentally sharing the same malformed construction.
    expect(canonicalSnsEnvelopeDigest(first)).toBe(
      'b82725f4361e6e53d2dea4209c415714626bed0e7ae2b67777fb0213cc27f872',
    );
  });

  test('rejects the wrong topic, region, account, message type, and extra fields', () => {
    const valid = signedEnvelope('2');
    const signature = valid.Signature;
    const invalidInputs = [
      { ...valid, TopicArn: `${TOPIC_ARN}-other` },
      {
        ...valid,
        TopicArn: 'arn:aws:sns:eu-west-1:000000000000:psd-eoc-email-events',
      },
      {
        ...valid,
        TopicArn: 'arn:aws:sns:us-east-1:111111111111:psd-eoc-email-events',
      },
      { ...valid, Type: 'SubscriptionConfirmation' },
      { ...valid, unexpected: true },
    ];

    for (const input of invalidInputs) {
      expect(() =>
        parseSnsEnvelope({ ...input, Signature: signature }, TOPIC_ARN),
      ).toThrow(SnsSignatureError);
    }

    for (const [otherTopic, signingCertificateUrl] of [
      [
        'arn:aws:sns:eu-central-1:111111111111:second-district-email-events',
        'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      ],
      [
        'arn:aws-cn:sns:cn-north-1:111111111111:second-district-email-events',
        'https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-00000000000000000000000000000000.pem',
      ],
      [
        'arn:aws-us-gov:sns:us-gov-west-1:111111111111:second-district-email-events',
        'https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      ],
    ] as const) {
      expect(
        parseSnsEnvelope(
          {
            ...valid,
            TopicArn: otherTopic,
            SigningCertURL: signingCertificateUrl,
          },
          otherTopic,
        ).TopicArn,
      ).toBe(otherTopic);
    }

    for (const impossibleTopic of [
      'arn:aws-cn:sns:us-east-1:111111111111:second-district-email-events',
      'arn:aws-us-gov:sns:eu-west-1:111111111111:second-district-email-events',
      'arn:aws:sns:cn-north-1:111111111111:second-district-email-events',
    ]) {
      expect(() => parseSnsTopicArn(impossibleTopic)).toThrow(
        expect.objectContaining({ code: 'WRONG_TOPIC' }),
      );
    }
  });

  test('rejects non-AWS, cross-region, redirected, or decorated certificate URLs', () => {
    const valid = signedEnvelope('2');
    for (const SigningCertURL of [
      'http://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      'https://sns.us-east-1.amazonaws.com.evil.invalid/SimpleNotificationService-00000000000000000000000000000000.pem',
      'https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      `${CERTIFICATE_URL}?redirect=https://evil.invalid`,
      'https://sns.us-east-1.amazonaws.com/other.pem',
    ]) {
      expect(() =>
        parseSnsEnvelope({ ...valid, SigningCertURL }, TOPIC_ARN),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CERTIFICATE_URL' }));
    }
  });

  test('bounds loaded certificates and rejects malformed or expired material', async () => {
    const envelope = signedEnvelope('2');
    await expect(
      verifySnsSignature(envelope, {
        loadSigningCertificate: async () =>
          new Uint8Array(MAX_SNS_SIGNING_CERTIFICATE_BYTES + 1),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CERTIFICATE' }));
    await expect(
      verifySnsSignature(envelope, {
        loadSigningCertificate: async () => 'not a certificate',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CERTIFICATE' }));
    await expect(
      verifySnsSignature(envelope, {
        loadSigningCertificate: loadTestCertificate,
        now: () => new Date('2040-01-01T00:00:00.000Z'),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CERTIFICATE' }));
  });
});

describe('SNS subscription confirmation', () => {
  test('verifies and follows only the exact signed AWS confirmation URL', async () => {
    const token = 'synthetic-confirmation-token';
    const subscribeUrl =
      `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription` +
      `&TopicArn=${encodeURIComponent(TOPIC_ARN)}` +
      `&Token=${encodeURIComponent(token)}`;
    const unsigned = {
      Type: 'SubscriptionConfirmation' as const,
      MessageId: '10000000-0000-4000-8000-000000000009',
      Token: token,
      TopicArn: TOPIC_ARN,
      Message: 'You have chosen to subscribe.',
      SubscribeURL: subscribeUrl,
      Timestamp: '2026-08-11T20:30:00.000Z',
      SignatureVersion: '2' as const,
      Signature: '',
      SigningCertURL: CERTIFICATE_URL,
    };
    const signingString =
      [
        ['Message', unsigned.Message],
        ['MessageId', unsigned.MessageId],
        ['SubscribeURL', unsigned.SubscribeURL],
        ['Timestamp', unsigned.Timestamp],
        ['Token', unsigned.Token],
        ['TopicArn', unsigned.TopicArn],
        ['Type', unsigned.Type],
      ]
        .map(([name, value]) => `${name}\n${value}`)
        .join('\n') + '\n';
    const envelope = parseSnsSubscriptionConfirmationEnvelope(
      {
        ...unsigned,
        Signature: sign(
          'sha256',
          Buffer.from(signingString, 'utf8'),
          TEST_PRIVATE_KEY,
        ).toString('base64'),
      },
      TOPIC_ARN,
    );
    await expect(
      verifySnsSignature(envelope, testCertificateOptions()),
    ).resolves.toBeUndefined();

    const calls: unknown[] = [];
    await confirmSnsSubscription(envelope, (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({ input: subscribeUrl }));
  });

  test('rejects a signed-looking confirmation URL outside the exact topic host', () => {
    const token = 'synthetic-confirmation-token';
    expect(() =>
      parseSnsSubscriptionConfirmationEnvelope(
        {
          Type: 'SubscriptionConfirmation',
          MessageId: '10000000-0000-4000-8000-000000000009',
          Token: token,
          TopicArn: TOPIC_ARN,
          Message: 'You have chosen to subscribe.',
          SubscribeURL:
            `https://example.invalid/?Action=ConfirmSubscription` +
            `&TopicArn=${encodeURIComponent(TOPIC_ARN)}` +
            `&Token=${token}`,
          Timestamp: '2026-08-11T20:30:00.000Z',
          SignatureVersion: '2',
          Signature: Buffer.from('synthetic').toString('base64'),
          SigningCertURL: CERTIFICATE_URL,
        },
        TOPIC_ARN,
      ),
    ).toThrow(SnsSignatureError);
  });
});
