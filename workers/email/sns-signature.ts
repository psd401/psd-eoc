import {
  createHash,
  verify as verifyCryptographicSignature,
  X509Certificate,
} from 'node:crypto';

import { TimestampSchema, UuidSchema } from '@psd-eoc/contracts';

const TOPIC_ARN_PATTERN =
  /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z]{2}(?:-gov)?-[a-z]+-\d):([0-9]{12}):([A-Za-z0-9_-]{1,256})$/u;
const CERTIFICATE_PATH_PATTERN =
  /^\/SimpleNotificationService-[A-Za-z0-9_-]{16,128}\.pem$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const NOTIFICATION_KEYS = new Set([
  'Type',
  'MessageId',
  'TopicArn',
  'Subject',
  'Message',
  'Timestamp',
  'SignatureVersion',
  'Signature',
  'SigningCertURL',
  'UnsubscribeURL',
]);

export const MAX_SNS_MESSAGE_BYTES = 256 * 1024;
export const MAX_SNS_SIGNING_CERTIFICATE_BYTES = 64 * 1024;

export type SnsSignatureVersion = '1' | '2';

export interface SnsNotificationEnvelope {
  readonly Type: 'Notification';
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Subject?: string;
  readonly Message: string;
  readonly Timestamp: string;
  readonly SignatureVersion: SnsSignatureVersion;
  readonly Signature: string;
  readonly SigningCertURL: string;
}

export type SnsSignatureErrorCode =
  | 'INVALID_ENVELOPE'
  | 'WRONG_TOPIC'
  | 'INVALID_CERTIFICATE_URL'
  | 'CERTIFICATE_UNAVAILABLE'
  | 'INVALID_CERTIFICATE'
  | 'INVALID_SIGNATURE';

export class SnsSignatureError extends Error {
  public constructor(public readonly code: SnsSignatureErrorCode) {
    super('The SNS notification could not be authenticated.');
    this.name = 'SnsSignatureError';
  }
}

export type SnsSigningCertificateLoader = (
  url: string,
) => Promise<string | Uint8Array>;

export interface SnsSignatureVerificationOptions {
  readonly loadSigningCertificate?: SnsSigningCertificateLoader;
  readonly now?: () => Date;
}

export interface SnsTopicArn {
  readonly accountId: string;
  readonly partition: 'aws' | 'aws-cn' | 'aws-us-gov';
  readonly region: string;
  readonly topicName: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maximumBytes: number,
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return undefined;
  }
  return value;
}

/** Parses the operator-configured topic that anchors account and region trust. */
export function parseSnsTopicArn(expectedTopicArn: string): SnsTopicArn {
  const match = TOPIC_ARN_PATTERN.exec(expectedTopicArn);
  const partition = match?.[1];
  const region = match?.[2];
  const accountId = match?.[3];
  const topicName = match?.[4];
  if (
    (partition !== 'aws' &&
      partition !== 'aws-cn' &&
      partition !== 'aws-us-gov') ||
    region === undefined ||
    accountId === undefined ||
    topicName === undefined
  ) {
    throw new SnsSignatureError('WRONG_TOPIC');
  }
  return Object.freeze({ accountId, partition, region, topicName });
}

function assertSigningCertificateUrl(
  value: string,
  expectedTopicArn: string,
): void {
  const topic = parseSnsTopicArn(expectedTopicArn);
  const certificateHost =
    topic.partition === 'aws-cn'
      ? `sns.${topic.region}.amazonaws.com.cn`
      : `sns.${topic.region}.amazonaws.com`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SnsSignatureError('INVALID_CERTIFICATE_URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== certificateHost ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !CERTIFICATE_PATH_PATTERN.test(url.pathname) ||
    url.toString() !== value
  ) {
    throw new SnsSignatureError('INVALID_CERTIFICATE_URL');
  }
}

function strictBase64(value: string): Buffer | undefined {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

/**
 * Parses only signed SNS Notification envelopes for the one configured SES
 * topic. Subscription confirmations are intentionally not followed by this
 * webhook because connecting production callbacks is a human-approved change.
 */
export function parseSnsEnvelope(
  value: unknown,
  expectedTopicArn: string,
): SnsNotificationEnvelope {
  parseSnsTopicArn(expectedTopicArn);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !NOTIFICATION_KEYS.has(key)) ||
    value.Type !== 'Notification' ||
    value.TopicArn !== expectedTopicArn ||
    (value.SignatureVersion !== '1' && value.SignatureVersion !== '2')
  ) {
    throw new SnsSignatureError(
      isRecord(value) && value.TopicArn !== expectedTopicArn
        ? 'WRONG_TOPIC'
        : 'INVALID_ENVELOPE',
    );
  }

  const messageId = boundedString(value.MessageId, 100);
  const message = boundedString(value.Message, MAX_SNS_MESSAGE_BYTES);
  const timestamp = boundedString(value.Timestamp, 100);
  const signature = boundedString(value.Signature, 4_096);
  const signingCertUrl = boundedString(value.SigningCertURL, 2_048);
  const subject =
    value.Subject === undefined ? undefined : boundedString(value.Subject, 100);
  const unsubscribeUrl =
    value.UnsubscribeURL === undefined
      ? undefined
      : boundedString(value.UnsubscribeURL, 8_192);

  if (
    messageId === undefined ||
    !UuidSchema.safeParse(messageId).success ||
    message === undefined ||
    timestamp === undefined ||
    !TimestampSchema.safeParse(timestamp).success ||
    signature === undefined ||
    strictBase64(signature) === undefined ||
    signingCertUrl === undefined ||
    (value.Subject !== undefined && subject === undefined) ||
    (value.UnsubscribeURL !== undefined && unsubscribeUrl === undefined)
  ) {
    throw new SnsSignatureError('INVALID_ENVELOPE');
  }
  assertSigningCertificateUrl(signingCertUrl, expectedTopicArn);

  return Object.freeze({
    Type: 'Notification',
    MessageId: messageId,
    TopicArn: expectedTopicArn,
    ...(subject === undefined ? {} : { Subject: subject }),
    Message: message,
    Timestamp: timestamp,
    SignatureVersion: value.SignatureVersion,
    Signature: signature,
    SigningCertURL: signingCertUrl,
  });
}

function canonicalSnsSigningString(envelope: SnsNotificationEnvelope): string {
  const fields: readonly (readonly [string, string])[] = [
    ['Message', envelope.Message],
    ['MessageId', envelope.MessageId],
    ...(envelope.Subject === undefined
      ? []
      : ([['Subject', envelope.Subject]] as const)),
    ['Timestamp', envelope.Timestamp],
    ['TopicArn', envelope.TopicArn],
    ['Type', envelope.Type],
  ];
  return fields.map(([name, value]) => `${name}\n${value}`).join('\n');
}

/** Digest of exactly the SNS-signed fields, suitable for replay conflicts. */
export function canonicalSnsEnvelopeDigest(
  envelope: SnsNotificationEnvelope,
): string {
  return createHash('sha256')
    .update(canonicalSnsSigningString(envelope), 'utf8')
    .digest('hex');
}

async function defaultSigningCertificateLoader(
  url: string,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new SnsSignatureError('CERTIFICATE_UNAVAILABLE');
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) ||
        Number(declaredLength) > MAX_SNS_SIGNING_CERTIFICATE_BYTES)
    ) {
      throw new SnsSignatureError('INVALID_CERTIFICATE');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_SNS_SIGNING_CERTIFICATE_BYTES) {
        await reader.cancel();
        throw new SnsSignatureError('INVALID_CERTIFICATE');
      }
      chunks.push(result.value);
    }
    const certificate = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      certificate.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return certificate;
  } catch (error) {
    if (error instanceof SnsSignatureError) throw error;
    throw new SnsSignatureError('CERTIFICATE_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

function certificateBytes(value: string | Uint8Array): Uint8Array {
  const bytes =
    typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : new Uint8Array(value);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_SNS_SIGNING_CERTIFICATE_BYTES
  ) {
    throw new SnsSignatureError('INVALID_CERTIFICATE');
  }
  return bytes;
}

/** Verifies the canonical v1 (SHA-1) or v2 (SHA-256) SNS signature. */
export async function verifySnsSignature(
  envelope: SnsNotificationEnvelope,
  options: SnsSignatureVerificationOptions = {},
): Promise<void> {
  parseSnsTopicArn(envelope.TopicArn);
  assertSigningCertificateUrl(envelope.SigningCertURL, envelope.TopicArn);
  const signature = strictBase64(envelope.Signature);
  if (signature === undefined) {
    throw new SnsSignatureError('INVALID_SIGNATURE');
  }

  let loadedCertificate: string | Uint8Array;
  try {
    loadedCertificate = await (
      options.loadSigningCertificate ?? defaultSigningCertificateLoader
    )(envelope.SigningCertURL);
  } catch (error) {
    if (error instanceof SnsSignatureError) throw error;
    throw new SnsSignatureError('CERTIFICATE_UNAVAILABLE');
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificateBytes(loadedCertificate));
  } catch (error) {
    if (error instanceof SnsSignatureError) throw error;
    throw new SnsSignatureError('INVALID_CERTIFICATE');
  }

  const now = (options.now ?? (() => new Date()))().getTime();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    now < validFrom ||
    now > validTo ||
    certificate.publicKey.asymmetricKeyType !== 'rsa'
  ) {
    throw new SnsSignatureError('INVALID_CERTIFICATE');
  }

  let verified = false;
  try {
    verified = verifyCryptographicSignature(
      envelope.SignatureVersion === '1' ? 'sha1' : 'sha256',
      Buffer.from(canonicalSnsSigningString(envelope), 'utf8'),
      certificate.publicKey,
      signature,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new SnsSignatureError('INVALID_SIGNATURE');
  }
}
