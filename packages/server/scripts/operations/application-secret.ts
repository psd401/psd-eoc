import { createHash, createHmac } from 'node:crypto';

import { z } from 'zod';

import { DATABASE_LOGIN } from './config';

const AWS_REQUEST_TERMINATOR = 'aws4_request';
const CONTENT_TYPE = 'application/x-amz-json-1.1';
const GET_SECRET_VALUE_TARGET = 'secretsmanager.GetSecretValue';
const MAX_SECRET_RESPONSE_BYTES = 64 * 1_024;

export interface TemporaryAwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration?: Date;
}

export interface ApplicationDatabaseSecret {
  readonly username: typeof DATABASE_LOGIN;
  readonly password: string;
}

export interface SignedAwsRequest {
  readonly body: string;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
}

const ApplicationDatabaseSecretSchema = z
  .object({
    username: z.literal(DATABASE_LOGIN),
    password: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[\x21-\x7e]+$/u, 'must contain printable non-space ASCII'),
  })
  .strict();

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function amzTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('The bootstrap clock is unavailable.');
  }
  return now
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

function validateCredentials(
  credentials: TemporaryAwsCredentials,
  now: Date,
): TemporaryAwsCredentials {
  if (
    !/^ASIA[A-Z0-9]{16}$/u.test(credentials.accessKeyId) ||
    credentials.secretAccessKey.length < 16 ||
    credentials.secretAccessKey.length > 256 ||
    credentials.sessionToken.length < 16 ||
    credentials.sessionToken.length > 4_096 ||
    /[\0\r\n]/u.test(credentials.secretAccessKey) ||
    /[\0\r\n]/u.test(credentials.sessionToken) ||
    (credentials.expiration !== undefined &&
      (!Number.isFinite(credentials.expiration.getTime()) ||
        credentials.expiration.getTime() <= now.getTime()))
  ) {
    throw new Error('Temporary bootstrap credentials are unavailable.');
  }
  return credentials;
}

/** Builds the sole Secrets Manager read used by bootstrap. */
export function buildGetSecretValueRequest(input: {
  readonly credentials: TemporaryAwsCredentials;
  readonly now: Date;
  readonly region: string;
  readonly secretArn: string;
}): SignedAwsRequest {
  const credentials = validateCredentials(input.credentials, input.now);
  const endpoint = `https://secretsmanager.${input.region}.amazonaws.com/`;
  const body = JSON.stringify({ SecretId: input.secretArn });
  const timestamp = amzTimestamp(input.now);
  const dateStamp = timestamp.slice(0, 8);
  const canonicalHeaders =
    `content-type:${CONTENT_TYPE}\n` +
    `host:secretsmanager.${input.region}.amazonaws.com\n` +
    `x-amz-date:${timestamp}\n` +
    `x-amz-security-token:${credentials.sessionToken}\n` +
    `x-amz-target:${GET_SECRET_VALUE_TARGET}\n`;
  const signedHeaders =
    'content-type;host;x-amz-date;x-amz-security-token;x-amz-target';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/secretsmanager/${AWS_REQUEST_TERMINATOR}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const dateKey = hmacSha256(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmacSha256(dateKey, input.region);
  const serviceKey = hmacSha256(regionKey, 'secretsmanager');
  const signingKey = hmacSha256(serviceKey, AWS_REQUEST_TERMINATOR);
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return Object.freeze({
    body,
    endpoint,
    headers: Object.freeze({
      authorization:
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'content-type': CONTENT_TYPE,
      'x-amz-date': timestamp,
      'x-amz-security-token': credentials.sessionToken,
      'x-amz-target': GET_SECRET_VALUE_TARGET,
    }),
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** Parses the exact secret contract without ever including secret data in errors. */
export function parseApplicationDatabaseSecretResponse(
  value: unknown,
  expectedArn: string,
): ApplicationDatabaseSecret {
  const response = asRecord(value);
  if (
    response?.ARN !== expectedArn ||
    typeof response.SecretString !== 'string'
  ) {
    throw new Error('The application database secret response was invalid.');
  }
  let secretValue: unknown;
  try {
    secretValue = JSON.parse(response.SecretString) as unknown;
  } catch {
    throw new Error('The application database secret response was invalid.');
  }
  const secret = ApplicationDatabaseSecretSchema.safeParse(secretValue);
  if (!secret.success) {
    throw new Error('The application database secret response was invalid.');
  }
  return Object.freeze(secret.data);
}

/** Performs one bounded, signed GetSecretValue request. */
export async function getApplicationDatabaseSecret(input: {
  readonly credentials: TemporaryAwsCredentials;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: Date;
  readonly region: string;
  readonly secretArn: string;
}): Promise<ApplicationDatabaseSecret> {
  const request = buildGetSecretValueRequest({
    credentials: input.credentials,
    now: input.now ?? new Date(),
    region: input.region,
    secretArn: input.secretArn,
  });
  const response = await (input.fetchImplementation ?? globalThis.fetch)(
    request.endpoint,
    {
      body: request.body,
      headers: request.headers,
      method: 'POST',
      redirect: 'error',
    },
  );
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_SECRET_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The application database secret response was invalid.');
  }
  if (response.body === null) {
    throw new Error('The application database secret response was invalid.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_SECRET_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The application database secret response was invalid.');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!response.ok) {
    throw new Error('The application database secret could not be read.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The application database secret response was invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('The application database secret response was invalid.');
  }
  return parseApplicationDatabaseSecretResponse(value, input.secretArn);
}
