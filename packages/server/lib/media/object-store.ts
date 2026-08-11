import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type GetObjectCommandOutput,
  type GetObjectTaggingCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  EventIdSchema,
  MediaContentTypeSchema,
  MediaIdSchema,
  MediaUploadIntentIdSchema,
  type MediaContentType,
} from '@psd-eoc/contracts';

export const MAX_MEDIA_OBJECT_BYTES = 25 * 1_024 * 1_024;
export const MAX_MEDIA_READ_GRANT_SECONDS = 5 * 60;
export const MAX_MEDIA_UPLOAD_GRANT_SECONDS = 15 * 60;
export const MEDIA_PROVIDER_CONNECTION_TIMEOUT_MILLISECONDS = 2_000;
export const MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS = 10_000;
export const MEDIA_PROVIDER_MAX_ATTEMPTS = 1;

const DEFAULT_MEDIA_READ_GRANT_SECONDS = 60;
const DEFAULT_MEDIA_UPLOAD_GRANT_SECONDS = 5 * 60;
const GUARD_DUTY_SCAN_STATUS_TAG = 'GuardDutyMalwareScanStatus';
const SANITIZED_CACHE_CONTROL = 'private, no-store';
const SANITIZED_RECORD_KIND = 'sanitized-event-photo';
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

export type MediaObjectStoreErrorCode =
  | 'CHECKSUM_MISMATCH'
  | 'CONFIGURATION_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'OBJECT_BODY_UNAVAILABLE'
  | 'OBJECT_SIZE_MISMATCH'
  | 'STORAGE_UNAVAILABLE';

/** Public-safe object-store failure. Provider payloads and object keys stay out. */
export class MediaObjectStoreError extends Error {
  public constructor(
    public readonly code: MediaObjectStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MediaObjectStoreError';
  }
}

export interface MediaObjectStoreConfiguration {
  readonly region: string;
  readonly bucketName: string;
}

export interface MediaObjectStoreEnvironment {
  readonly AWS_REGION?: string | undefined;
  readonly MEDIA_BUCKET_NAME?: string | undefined;
}

export interface MediaObjectStoreS3Client {
  getObject(
    command: GetObjectCommand,
    options?: Readonly<{ abortSignal: AbortSignal }>,
  ): Promise<GetObjectCommandOutput>;
  getObjectTagging(
    command: GetObjectTaggingCommand,
    options?: Readonly<{ abortSignal: AbortSignal }>,
  ): Promise<GetObjectTaggingCommandOutput>;
  putObject(
    command: PutObjectCommand,
    options?: Readonly<{ abortSignal: AbortSignal }>,
  ): Promise<PutObjectCommandOutput>;
}

export interface MediaObjectStoreSignOptions {
  readonly expiresIn: number;
  readonly signableHeaders?: ReadonlySet<string>;
}

export type MediaObjectStoreSigner = (
  command: GetObjectCommand | PutObjectCommand,
  options: MediaObjectStoreSignOptions,
) => Promise<string>;

export interface CreateRawUploadGrantInput {
  readonly storageKey: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly contentType: MediaContentType;
  readonly expiresInSeconds?: number;
}

export interface RawUploadGrant {
  readonly method: 'PUT';
  readonly uploadUrl: string;
  readonly requiredHeaders: Readonly<{
    'content-type': MediaContentType;
    'if-none-match': '*';
  }>;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly expiresInSeconds: number;
}

export interface ReadRawObjectInput {
  readonly storageKey: string;
  readonly expectedByteLength: number;
  readonly expectedContentSha256: string;
}

export interface VerifiedRawObject {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly contentSha256: string;
  /** Untrusted S3 metadata; image type must still be detected from the bytes. */
  readonly storedContentType: string | null;
}

export interface SanitizedObjectMetadata {
  readonly eventId: string;
  readonly mediaId: string;
  readonly uploadIntentId: string;
}

export interface PutSanitizedObjectInput {
  readonly storageKey: string;
  readonly bytes: Uint8Array;
  readonly contentType: MediaContentType;
  readonly metadata: SanitizedObjectMetadata;
}

export interface StoredSanitizedObject {
  readonly storageKey: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly contentType: MediaContentType;
}

export interface CreateReadGrantInput {
  readonly storageKey: string;
  readonly expiresInSeconds?: number;
}

export interface PrivateReadGrant {
  readonly readUrl: string;
  readonly expiresInSeconds: number;
}

/** Closed GuardDuty result vocabulary. Only `clean` permits completion. */
export type MalwareScanStatus =
  | 'pending'
  | 'clean'
  | 'threats'
  | 'unsupported'
  | 'access-denied'
  | 'failed';

export interface MediaObjectStore {
  createRawUploadGrant(
    input: CreateRawUploadGrantInput,
  ): Promise<RawUploadGrant>;
  readVerifiedRawObject(input: ReadRawObjectInput): Promise<VerifiedRawObject>;
  putSanitizedObject(
    input: PutSanitizedObjectInput,
  ): Promise<StoredSanitizedObject>;
  createPrivateReadGrant(
    input: CreateReadGrantInput,
  ): Promise<PrivateReadGrant>;
  getMalwareScanStatus(storageKey: string): Promise<MalwareScanStatus>;
}

export interface CreateMediaObjectStoreDependencies {
  readonly environment?: MediaObjectStoreEnvironment;
  readonly client?: MediaObjectStoreS3Client;
  readonly signer?: MediaObjectStoreSigner;
  /** Tests and deployments may tighten, but never relax, the fail-closed bound. */
  readonly providerTimeoutMilliseconds?: number;
}

function configurationError(message: string): MediaObjectStoreError {
  return new MediaObjectStoreError('CONFIGURATION_UNAVAILABLE', message);
}

function sanitizedStorageUnavailable(): MediaObjectStoreError {
  return new MediaObjectStoreError(
    'STORAGE_UNAVAILABLE',
    'The sanitized private media object could not be stored.',
  );
}

function resolveProviderTimeoutMilliseconds(value: number | undefined): number {
  const timeout = value ?? MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS
  ) {
    throw new RangeError(
      `providerTimeoutMilliseconds must be an integer between 1 and ${MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS}.`,
    );
  }
  return timeout;
}

/**
 * Applies one application deadline around credentials, request headers, and
 * streamed response bodies. Production S3 calls receive the same abort signal;
 * test doubles may ignore it but still cannot keep the caller or DB work open.
 */
async function runBoundedProviderOperation<Result>(
  timeoutMilliseconds: number,
  operation: (abortSignal: AbortSignal) => Promise<Result>,
  onTimeout?: () => void,
): Promise<Result> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      onTimeout?.();
      reject(new Error('The private media provider operation timed out.'));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadline,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

interface RetainedProviderGate {
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}

/**
 * Bounds non-abortable provider work. A caller deadline may stop waiting, but
 * its permit remains occupied until the underlying operation really settles.
 */
function createRetainedProviderGate(
  maximumConcurrent = 2,
): RetainedProviderGate {
  let active = 0;
  return Object.freeze({
    run<Result>(operation: () => Promise<Result>): Promise<Result> {
      if (active >= maximumConcurrent) {
        return Promise.reject(
          new MediaObjectStoreError(
            'STORAGE_UNAVAILABLE',
            'Private media signing capacity is currently unavailable.',
          ),
        );
      }
      active += 1;
      const result = Promise.resolve().then(operation);
      const release = () => {
        active -= 1;
      };
      void result.then(release, release);
      return result;
    },
  });
}

/** Reads only the two non-secret settings supplied to App Runner by CDK. */
export function readMediaObjectStoreConfiguration(
  environment: MediaObjectStoreEnvironment = {
    AWS_REGION: process.env['AWS_REGION'],
    MEDIA_BUCKET_NAME: process.env['MEDIA_BUCKET_NAME'],
  },
): MediaObjectStoreConfiguration {
  const region = environment.AWS_REGION?.trim();
  if (
    region === undefined ||
    region.length === 0 ||
    region.length > 32 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(region)
  ) {
    throw configurationError('AWS_REGION must be a valid AWS region name.');
  }

  const bucketName = environment.MEDIA_BUCKET_NAME?.trim();
  if (
    bucketName === undefined ||
    bucketName.length < 3 ||
    bucketName.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucketName) ||
    bucketName.includes('..') ||
    bucketName.includes('.-') ||
    bucketName.includes('-.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bucketName)
  ) {
    throw configurationError(
      'MEDIA_BUCKET_NAME must be a valid general-purpose S3 bucket name.',
    );
  }

  return Object.freeze({ region, bucketName });
}

function assertStorageKey(storageKey: string): void {
  const hasUnsafeCharacter = [...storageKey].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      character === '\\' ||
      codePoint === undefined ||
      codePoint <= 31 ||
      codePoint === 127
    );
  });
  if (
    storageKey.length === 0 ||
    storageKey.length > 1_024 ||
    storageKey.startsWith('/') ||
    storageKey.endsWith('/') ||
    storageKey.includes('//') ||
    hasUnsafeCharacter ||
    storageKey.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new MediaObjectStoreError(
      'INVALID_ARGUMENT',
      'The server-generated media storage key is invalid.',
    );
  }
}

function assertByteLength(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > MAX_MEDIA_OBJECT_BYTES
  ) {
    throw new MediaObjectStoreError(
      'INVALID_ARGUMENT',
      `Media objects must contain between 1 and ${MAX_MEDIA_OBJECT_BYTES} bytes.`,
    );
  }
}

function assertSha256(value: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new MediaObjectStoreError(
      'INVALID_ARGUMENT',
      'Media SHA-256 values must be lowercase hexadecimal digests.',
    );
  }
}

function sha256Base64(sha256Hex: string): string {
  return Buffer.from(sha256Hex, 'hex').toString('base64');
}

function contentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseContentType(contentType: MediaContentType): MediaContentType {
  const parsed = MediaContentTypeSchema.safeParse(contentType);
  if (!parsed.success) {
    throw new MediaObjectStoreError(
      'INVALID_ARGUMENT',
      'The media content type is unsupported.',
    );
  }
  return parsed.data;
}

function parseExpiration(
  supplied: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const expiresIn = supplied ?? fallback;
  if (
    !Number.isSafeInteger(expiresIn) ||
    expiresIn < 1 ||
    expiresIn > maximum
  ) {
    throw new MediaObjectStoreError(
      'INVALID_ARGUMENT',
      `Media grants must expire between 1 and ${maximum} seconds.`,
    );
  }
  return expiresIn;
}

function parseHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error('unsafe URL');
    }
    return url.toString();
  } catch {
    throw new MediaObjectStoreError(
      'STORAGE_UNAVAILABLE',
      'The private media grant could not be issued.',
    );
  }
}

function isMediaObjectStoreError(
  error: unknown,
): error is MediaObjectStoreError {
  return error instanceof MediaObjectStoreError;
}

function isS3PreconditionFailed(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    error.name === 'PreconditionFailed' &&
    error.$metadata.httpStatusCode === 412
  );
}

function sanitizedObjectMetadata(
  eventId: string,
  mediaId: string,
  uploadIntentId: string,
  sanitizedSha256: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'record-kind': SANITIZED_RECORD_KIND,
    'event-id': eventId,
    'media-id': mediaId,
    'upload-intent-id': uploadIntentId,
    'sanitized-sha256': sanitizedSha256,
  });
}

function metadataMatchesExactly(
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(actual, key) &&
        actual[key] === expected[key],
    )
  );
}

async function cancelBody(body: unknown): Promise<void> {
  if (body instanceof ReadableStream) {
    if (!body.locked) {
      await body.cancel().catch(() => undefined);
    }
    return;
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    'destroy' in body &&
    typeof body.destroy === 'function'
  ) {
    try {
      body.destroy();
    } catch {
      // Cancellation is best-effort; the caller still reports a safe failure.
    }
  }
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new MediaObjectStoreError(
    'OBJECT_BODY_UNAVAILABLE',
    'The private media object returned an invalid byte stream.',
  );
}

async function readWebStream(
  stream: ReadableStream<unknown>,
  maximumBytes: number,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const abortRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  abortSignal?.addEventListener('abort', abortRead, { once: true });
  try {
    if (abortSignal?.aborted === true) {
      abortRead();
    }
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      const chunk = toBytes(next.value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new MediaObjectStoreError(
          'OBJECT_SIZE_MISMATCH',
          'The private media object exceeded its recorded byte length.',
        );
      }
      chunks.push(chunk);
    }
  } finally {
    abortSignal?.removeEventListener('abort', abortRead);
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readAsyncIterable(
  iterable: AsyncIterable<unknown>,
  maximumBytes: number,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const abortRead = () => {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  };
  abortSignal?.addEventListener('abort', abortRead, { once: true });
  try {
    if (abortSignal?.aborted === true) {
      abortRead();
    }
    while (true) {
      const next = await iterator.next();
      if (next.done === true) {
        completed = true;
        break;
      }
      const chunk = toBytes(next.value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new MediaObjectStoreError(
          'OBJECT_SIZE_MISMATCH',
          'The private media object exceeded its recorded byte length.',
        );
      }
      chunks.push(chunk);
    }
  } finally {
    abortSignal?.removeEventListener('abort', abortRead);
    if (!completed) {
      await iterator.return?.();
    }
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedBody(
  body: unknown,
  maximumBytes: number,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  if (body instanceof ReadableStream) {
    return readWebStream(body, maximumBytes, abortSignal);
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === 'function'
  ) {
    return readAsyncIterable(
      body as AsyncIterable<unknown>,
      maximumBytes,
      abortSignal,
    );
  }
  throw new MediaObjectStoreError(
    'OBJECT_BODY_UNAVAILABLE',
    'The private media object did not return a bounded byte stream.',
  );
}

interface ExpectedSanitizedObject {
  readonly storageKey: string;
  readonly bytes: Uint8Array;
  readonly contentType: MediaContentType;
  readonly contentSha256: string;
  readonly metadata: Readonly<Record<string, string>>;
}

async function assertExistingSanitizedObjectMatches(
  client: MediaObjectStoreS3Client,
  bucketName: string,
  expected: ExpectedSanitizedObject,
  providerTimeoutMilliseconds: number,
): Promise<void> {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: expected.storageKey,
    // Request one byte beyond the expected object to detect any larger value
    // while keeping a retry read bounded before it reaches application code.
    Range: `bytes=0-${expected.bytes.byteLength}`,
    ChecksumMode: 'ENABLED',
  });

  let output: GetObjectCommandOutput | undefined;
  try {
    await runBoundedProviderOperation(
      providerTimeoutMilliseconds,
      async (abortSignal) => {
        output = await client.getObject(command, { abortSignal });
        const existingOutput = output;
        const headersMatch =
          existingOutput.ContentLength === expected.bytes.byteLength &&
          existingOutput.ContentType === expected.contentType &&
          existingOutput.CacheControl === SANITIZED_CACHE_CONTROL &&
          metadataMatchesExactly(existingOutput.Metadata, expected.metadata);
        if (!headersMatch) {
          await cancelBody(existingOutput.Body);
          throw sanitizedStorageUnavailable();
        }

        const existingBytes = await readBoundedBody(
          existingOutput.Body,
          expected.bytes.byteLength,
          abortSignal,
        );
        if (
          existingBytes.byteLength !== expected.bytes.byteLength ||
          contentSha256(existingBytes) !== expected.contentSha256
        ) {
          throw sanitizedStorageUnavailable();
        }
      },
      () => {
        void cancelBody(output?.Body);
      },
    );
  } catch {
    throw sanitizedStorageUnavailable();
  }
}

function createAwsDependencies(configuration: MediaObjectStoreConfiguration): {
  readonly client: MediaObjectStoreS3Client;
  readonly signer: MediaObjectStoreSigner;
} {
  // Credentials are intentionally omitted. The AWS SDK resolves and refreshes
  // App Runner's temporary instance-role credentials through its default chain.
  const awsClient = new S3Client({
    region: configuration.region,
    maxAttempts: MEDIA_PROVIDER_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: MEDIA_PROVIDER_CONNECTION_TIMEOUT_MILLISECONDS,
      requestTimeout: MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS,
      socketTimeout: MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS,
      throwOnRequestTimeout: true,
    },
  });
  const client: MediaObjectStoreS3Client = {
    getObject: (command, options) => awsClient.send(command, options),
    getObjectTagging: (command, options) => awsClient.send(command, options),
    putObject: (command, options) => awsClient.send(command, options),
  };
  const signer: MediaObjectStoreSigner = (command, options) =>
    getSignedUrl(awsClient, command, {
      expiresIn: options.expiresIn,
      ...(options.signableHeaders === undefined
        ? {}
        : { signableHeaders: new Set(options.signableHeaders) }),
    });
  return Object.freeze({ client, signer });
}

/**
 * Creates the private S3 media boundary. It exposes no delete operation and
 * never sets an ACL or overrides the bucket's KMS default encryption.
 */
export function createMediaObjectStore(
  dependencies: CreateMediaObjectStoreDependencies = {},
): MediaObjectStore {
  const configuration = readMediaObjectStoreConfiguration(
    dependencies.environment,
  );
  const defaults =
    dependencies.client === undefined || dependencies.signer === undefined
      ? createAwsDependencies(configuration)
      : null;
  const client = dependencies.client ?? defaults?.client;
  const signer = dependencies.signer ?? defaults?.signer;
  if (client === undefined || signer === undefined) {
    throw configurationError('The private media object store is unavailable.');
  }
  const providerTimeoutMilliseconds = resolveProviderTimeoutMilliseconds(
    dependencies.providerTimeoutMilliseconds,
  );
  // getSignedUrl has no AbortSignal. Share a retained gate across upload and
  // read signing so repeated caller timeouts cannot accumulate native work.
  const signerGate = createRetainedProviderGate();

  return Object.freeze({
    async createRawUploadGrant(
      input: CreateRawUploadGrantInput,
    ): Promise<RawUploadGrant> {
      assertStorageKey(input.storageKey);
      assertByteLength(input.byteLength);
      assertSha256(input.contentSha256);
      const contentType = parseContentType(input.contentType);
      const expiresInSeconds = parseExpiration(
        input.expiresInSeconds,
        DEFAULT_MEDIA_UPLOAD_GRANT_SECONDS,
        MAX_MEDIA_UPLOAD_GRANT_SECONDS,
      );
      const command = new PutObjectCommand({
        Bucket: configuration.bucketName,
        Key: input.storageKey,
        ContentLength: input.byteLength,
        ContentType: contentType,
        ChecksumSHA256: sha256Base64(input.contentSha256),
        IfNoneMatch: '*',
      });

      try {
        const uploadUrl = parseHttpsUrl(
          await runBoundedProviderOperation(providerTimeoutMilliseconds, () =>
            signerGate.run(() =>
              signer(command, {
                expiresIn: expiresInSeconds,
                signableHeaders: new Set(['content-type', 'if-none-match']),
              }),
            ),
          ),
        );
        return Object.freeze({
          method: 'PUT' as const,
          uploadUrl,
          requiredHeaders: Object.freeze({
            'content-type': contentType,
            'if-none-match': '*' as const,
          }),
          byteLength: input.byteLength,
          contentSha256: input.contentSha256,
          expiresInSeconds,
        });
      } catch (error) {
        if (isMediaObjectStoreError(error)) {
          throw error;
        }
        throw new MediaObjectStoreError(
          'STORAGE_UNAVAILABLE',
          'The private media upload grant could not be issued.',
        );
      }
    },

    async readVerifiedRawObject(
      input: ReadRawObjectInput,
    ): Promise<VerifiedRawObject> {
      assertStorageKey(input.storageKey);
      assertByteLength(input.expectedByteLength);
      assertSha256(input.expectedContentSha256);
      const command = new GetObjectCommand({
        Bucket: configuration.bucketName,
        Key: input.storageKey,
        // One extra requested byte detects replacement with a larger object
        // while bounding transfer before any untrusted image decoder runs.
        Range: `bytes=0-${input.expectedByteLength}`,
        ChecksumMode: 'ENABLED',
      });

      let output: GetObjectCommandOutput | undefined;
      try {
        return await runBoundedProviderOperation(
          providerTimeoutMilliseconds,
          async (abortSignal) => {
            output = await client.getObject(command, { abortSignal });
            const rawOutput = output;
            if (rawOutput.ContentLength !== input.expectedByteLength) {
              await cancelBody(rawOutput.Body);
              throw new MediaObjectStoreError(
                'OBJECT_SIZE_MISMATCH',
                'The private media object did not match its recorded byte length.',
              );
            }

            const bytes = await readBoundedBody(
              rawOutput.Body,
              input.expectedByteLength,
              abortSignal,
            );
            if (bytes.byteLength !== input.expectedByteLength) {
              throw new MediaObjectStoreError(
                'OBJECT_SIZE_MISMATCH',
                'The private media object did not match its recorded byte length.',
              );
            }
            const observedSha256 = contentSha256(bytes);
            if (observedSha256 !== input.expectedContentSha256) {
              throw new MediaObjectStoreError(
                'CHECKSUM_MISMATCH',
                'The private media object did not match its recorded checksum.',
              );
            }
            return Object.freeze({
              bytes,
              byteLength: bytes.byteLength,
              contentSha256: observedSha256,
              storedContentType: rawOutput.ContentType ?? null,
            });
          },
          () => {
            void cancelBody(output?.Body);
          },
        );
      } catch (error) {
        if (isMediaObjectStoreError(error)) {
          throw error;
        }
        throw new MediaObjectStoreError(
          'STORAGE_UNAVAILABLE',
          'The private media object could not be read.',
        );
      }
    },

    async putSanitizedObject(
      input: PutSanitizedObjectInput,
    ): Promise<StoredSanitizedObject> {
      assertStorageKey(input.storageKey);
      assertByteLength(input.bytes.byteLength);
      const contentType = parseContentType(input.contentType);
      const eventId = EventIdSchema.parse(input.metadata.eventId);
      const mediaId = MediaIdSchema.parse(input.metadata.mediaId);
      const uploadIntentId = MediaUploadIntentIdSchema.parse(
        input.metadata.uploadIntentId,
      );
      const sanitizedSha256 = contentSha256(input.bytes);
      const checksum = sha256Base64(sanitizedSha256);
      const metadata = sanitizedObjectMetadata(
        eventId,
        mediaId,
        uploadIntentId,
        sanitizedSha256,
      );
      const command = new PutObjectCommand({
        Bucket: configuration.bucketName,
        Key: input.storageKey,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: contentType,
        ChecksumSHA256: checksum,
        CacheControl: SANITIZED_CACHE_CONTROL,
        // A media ID owns one immutable sanitized object. Bucket versioning is
        // retained defense-in-depth, not permission to replace current truth.
        IfNoneMatch: '*',
        Metadata: metadata,
      });

      let output: PutObjectCommandOutput;
      try {
        output = await runBoundedProviderOperation(
          providerTimeoutMilliseconds,
          (abortSignal) => client.putObject(command, { abortSignal }),
        );
      } catch (error) {
        if (isS3PreconditionFailed(error)) {
          await assertExistingSanitizedObjectMatches(
            client,
            configuration.bucketName,
            {
              storageKey: input.storageKey,
              bytes: input.bytes,
              contentType,
              contentSha256: sanitizedSha256,
              metadata,
            },
            providerTimeoutMilliseconds,
          );
          return Object.freeze({
            storageKey: input.storageKey,
            byteLength: input.bytes.byteLength,
            contentSha256: sanitizedSha256,
            contentType,
          });
        }
        throw sanitizedStorageUnavailable();
      }
      if (output.ChecksumSHA256 !== checksum) {
        // The bytes were generated and hashed by this service. A missing or
        // different provider acknowledgement is an availability/integrity
        // failure, not evidence that the human selected an invalid upload.
        throw sanitizedStorageUnavailable();
      }

      return Object.freeze({
        storageKey: input.storageKey,
        byteLength: input.bytes.byteLength,
        contentSha256: sanitizedSha256,
        contentType,
      });
    },

    async createPrivateReadGrant(
      input: CreateReadGrantInput,
    ): Promise<PrivateReadGrant> {
      assertStorageKey(input.storageKey);
      const expiresInSeconds = parseExpiration(
        input.expiresInSeconds,
        DEFAULT_MEDIA_READ_GRANT_SECONDS,
        MAX_MEDIA_READ_GRANT_SECONDS,
      );
      const command = new GetObjectCommand({
        Bucket: configuration.bucketName,
        Key: input.storageKey,
        ResponseCacheControl: 'private, no-store',
      });
      try {
        const readUrl = parseHttpsUrl(
          await runBoundedProviderOperation(providerTimeoutMilliseconds, () =>
            signerGate.run(() =>
              signer(command, { expiresIn: expiresInSeconds }),
            ),
          ),
        );
        return Object.freeze({ readUrl, expiresInSeconds });
      } catch (error) {
        if (isMediaObjectStoreError(error)) {
          throw error;
        }
        throw new MediaObjectStoreError(
          'STORAGE_UNAVAILABLE',
          'The private media read grant could not be issued.',
        );
      }
    },

    async getMalwareScanStatus(storageKey: string): Promise<MalwareScanStatus> {
      assertStorageKey(storageKey);
      const command = new GetObjectTaggingCommand({
        Bucket: configuration.bucketName,
        Key: storageKey,
      });
      let output: GetObjectTaggingCommandOutput;
      try {
        output = await runBoundedProviderOperation(
          providerTimeoutMilliseconds,
          (abortSignal) => client.getObjectTagging(command, { abortSignal }),
        );
      } catch {
        throw new MediaObjectStoreError(
          'STORAGE_UNAVAILABLE',
          'The private media malware-scan status could not be read.',
        );
      }

      const scanTags = (output.TagSet ?? []).filter(
        (tag) => tag.Key === GUARD_DUTY_SCAN_STATUS_TAG,
      );
      if (scanTags.length === 0) {
        return 'pending';
      }
      if (scanTags.length !== 1) {
        return 'failed';
      }
      switch (scanTags[0]?.Value) {
        case 'NO_THREATS_FOUND':
          return 'clean';
        case 'THREATS_FOUND':
          return 'threats';
        case 'UNSUPPORTED':
          return 'unsupported';
        case 'ACCESS_DENIED':
          return 'access-denied';
        case 'FAILED':
          return 'failed';
        default:
          return 'failed';
      }
    },
  });
}
