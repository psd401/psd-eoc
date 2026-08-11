import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  MAX_SNS_SIGNING_CERTIFICATE_BYTES,
  SnsSignatureError,
  canonicalSnsEnvelopeDigest,
  parseSnsEnvelope,
  verifySnsSignature,
  type SnsNotificationEnvelope,
  type SnsSignatureVersion,
} from './sns-signature';

const TOPIC_ARN = 'arn:aws:sns:us-west-2:338414773271:psd-eoc-email-events';
const CERTIFICATE_URL =
  'https://sns.us-west-2.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem';

// Synthetic, test-only certificate material. It authenticates no service and
// expires in 2036; keeping it inline makes signature tests network-free.
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBnESjgGQBI80U
1JllioaEFGweFwBEbB7Er0b+QR+WIBQe9jA/zxRBoa3ct/a5f9nU7Vz9+Az9QuqM
HdGNfLnZm5vhLlWZ8RQrDOXNx+yQWnShqmw6UORApHIhkT1gAzbEwasboV4dsizj
QkiOCVmvGek5V8tEoQiOaDhjlDxWY6UslPfYI7BEFRJ+myeI8sxM07UvK4Jzd1ws
FdY8dI6bBu3GsZQ5kh9rKmCogL+oO5s0YPrXCLGTTy1uaPu3k1VwmF+zynqnDzOy
HaJTe5S+HpSRrzztElvQmt4HdHP9Nd2p5H1mBHDwQf04z58WhTJD0JsHLyN8DVwB
3FOfkGInAgMBAAECggEAAYYgxV4Gh+66lCY14KstSAbwiEFu+0DRk7MMTqxSxpWC
8dkS+VXmdP3LK4J6Jhd+M0zIoKx3AwrgiZk2CvkibfRbTu7i4JE/loCkYDN3sTg5
M2MU6V9poKzHIq7f6Fq/TpOvYKkwDtSrdcf1aaZtVuIEJNRxHb7N2weerr9OnwQv
JoGl5c+j+YHLlorXCWS4QQCo8VTOex8cBPcW5BJtiipWa9Uc492FkiASNIXVYnTH
zOGgH29lWu2GyJ3/Ta9Z5V798+OCxIz/xdjKu8bBFV8PqpoFzL+io5kTYSwMUzcA
89SAMA2W5Ef59U8mfKCTpv9u+c39pfP4QlGbrsTNAQKBgQDtO1c6Tn2uaxxkO6w9
3i5ljne1NelE1WWwcmIAC2qeErhait/8VPO/0Vs6jHbDtdHOX10mc87BwXLtWjwu
1I3lVhdprU7Hw9mRb+H+MxoxQthqRSVk6OHuPmh3jFdqyBm4KCNHBToAtJ55ykME
MKEpH/fXRr3nEZqHCDwV/Zh0EQKBgQDQ7XaEwPtJn2iNAm0/NAExwzMKA34IbIkN
1r6RklB0gJMZgkMxNqW/gBIcCVhws5TK+mQojrILokJUjn5yr+4egSO0VqFF5h52
DqKTmKhZybkBLyyRKe2uSE2FtvMMOE90YqteLBOZzL4elbNOCCzUaoNPRKsAOuLi
B2dMTADKtwKBgH9p8rSHOat3Ld2LyzvDXEoBVbwHA42Ly70UAhyiBRZ3WXqPwjNl
cTEiAYyVqqf8vH3J7F7drjuUaeSfJVnFoZx+O77vbTOPtggN/mQoEDZK/688ChSD
m+z4qeUjhEP+ywmEzUW0we1lFQS2pH3YnIZY/CUsgoxbgRJrUtJAzSPxAoGBAJGd
f+ZEzp9gkDD/iP7tEwwI3ZDUIEpkwx03F7lD/flFB8FWrdgmG12eOID77n0WXNUf
sSEnW2aKX6qpae4rOk5eeXEek+aw3Xgw+RTf6C40T1JI+8ntLDA1SnqwqTNSJ+aZ
QpEvLTYbokKU2dTAE+a0mfJsjLZrVGhu+osNydt/AoGAHkhhc4lf0nePegskvyVI
L/9UdWyRj7kiZ1CMBLdMvXgOaEtiZzHqaLZJnSNQJBMvmkR/hfHydWdOuoAqBXy5
F4hbPWdtyTYcYfcwo8KMojASIQ86AkP+f2wO6z6LvqlH6KEKt73zLSsNQU4SFE+T
aBEr40zInqIefPr5nS2pURg=
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
  return [
    ['Message', input.Message],
    ['MessageId', input.MessageId],
    ...(input.Subject === undefined ? [] : [['Subject', input.Subject]]),
    ['Timestamp', input.Timestamp],
    ['TopicArn', input.TopicArn],
    ['Type', input.Type],
  ]
    .map(([name, value]) => `${name}\n${value}`)
    .join('\n');
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
      'https://sns.us-west-2.amazonaws.com/?Action=Unsubscribe&synthetic=1',
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

describe('SNS Notification signature verification', () => {
  test.each(['1', '2'] as const)(
    'verifies canonical SignatureVersion %s notifications',
    async (version) => {
      const envelope = signedEnvelope(version);

      await expect(
        verifySnsSignature(envelope, {
          loadSigningCertificate: loadTestCertificate,
        }),
      ).resolves.toBeUndefined();
    },
  );

  test('includes Subject only when present in the canonical signed fields', async () => {
    const envelope = signedEnvelope('2', { Subject: undefined });

    expect(envelope.Subject).toBeUndefined();
    await expect(
      verifySnsSignature(envelope, {
        loadSigningCertificate: loadTestCertificate,
      }),
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
      verifySnsSignature(mutated, {
        loadSigningCertificate: loadTestCertificate,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    await expect(
      verifySnsSignature(
        { ...mutated, Signature: attackerSignature },
        { loadSigningCertificate: loadTestCertificate },
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
  });

  test('rejects the wrong topic, region, account, message type, and extra fields', () => {
    const valid = signedEnvelope('2');
    const signature = valid.Signature;
    const invalidInputs = [
      { ...valid, TopicArn: `${TOPIC_ARN}-other` },
      {
        ...valid,
        TopicArn: 'arn:aws:sns:us-east-1:338414773271:psd-eoc-email-events',
      },
      {
        ...valid,
        TopicArn: 'arn:aws:sns:us-west-2:000000000000:psd-eoc-email-events',
      },
      { ...valid, Type: 'SubscriptionConfirmation' },
      { ...valid, unexpected: true },
    ];

    for (const input of invalidInputs) {
      expect(() =>
        parseSnsEnvelope({ ...input, Signature: signature }, TOPIC_ARN),
      ).toThrow(SnsSignatureError);
    }
  });

  test('rejects non-AWS, cross-region, redirected, or decorated certificate URLs', () => {
    const valid = signedEnvelope('2');
    for (const SigningCertURL of [
      'http://sns.us-west-2.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      'https://sns.us-west-2.amazonaws.com.evil.invalid/SimpleNotificationService-00000000000000000000000000000000.pem',
      'https://user@sns.us-west-2.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
      `${CERTIFICATE_URL}?redirect=https://evil.invalid`,
      'https://sns.us-west-2.amazonaws.com/other.pem',
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
