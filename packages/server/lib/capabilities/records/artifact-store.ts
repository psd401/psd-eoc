import { createHash, randomUUID } from 'node:crypto';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  RecordsExportSchema,
  type RecordsExport,
  type RecordsExportFormat,
} from '@psd-eoc/contracts';

import {
  MEDIA_PROVIDER_CONNECTION_TIMEOUT_MILLISECONDS,
  MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS,
  readMediaObjectStoreConfiguration,
  type MediaObjectStoreEnvironment,
} from '../../media/object-store';

export const MAX_RECORDS_EXPORT_BYTES = 25 * 1_024 * 1_024;
export const RECORDS_EXPORT_GRANT_SECONDS = 5 * 60;

const CACHE_CONTROL = 'private, no-store';
const STORED_CONTENT_DISPOSITION = 'attachment';

export interface RecordsArtifactStoreClient {
  getObject(
    command: GetObjectCommand,
    options?: Readonly<{ abortSignal: AbortSignal }>,
  ): Promise<GetObjectCommandOutput>;
  putObject(
    command: PutObjectCommand,
    options?: Readonly<{ abortSignal: AbortSignal }>,
  ): Promise<PutObjectCommandOutput>;
}

export type RecordsArtifactStoreSigner = (
  command: GetObjectCommand,
  options: Readonly<{ expiresIn: number }>,
) => Promise<string>;

export interface StoreRecordsArtifactInput {
  readonly bytes: Uint8Array;
  readonly format: RecordsExportFormat;
  readonly fileName: string;
  readonly rowCount: number;
  readonly generatedAt: Date;
}

export interface RecordsArtifactStore {
  store(input: StoreRecordsArtifactInput): Promise<RecordsExport>;
}

export interface CreateRecordsArtifactStoreDependencies {
  readonly environment?: MediaObjectStoreEnvironment;
  readonly client?: RecordsArtifactStoreClient;
  readonly signer?: RecordsArtifactStoreSigner;
  readonly providerTimeoutMilliseconds?: number;
  readonly grantSeconds?: number;
}

export class RecordsArtifactStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecordsArtifactStoreError';
  }
}

function contentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checksumBase64(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function contentMetadata(format: RecordsExportFormat): Readonly<{
  contentType: 'text/csv; charset=utf-8' | 'application/pdf';
  extension: 'csv' | 'pdf';
}> {
  return format === 'csv'
    ? { contentType: 'text/csv; charset=utf-8', extension: 'csv' }
    : { contentType: 'application/pdf', extension: 'pdf' };
}

function attachmentDisposition(fileName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,195}\.(?:csv|pdf)$/u.test(fileName)) {
    throw new RecordsArtifactStoreError(
      'The records export filename is invalid.',
    );
  }
  return `attachment; filename="${fileName}"`;
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    (error instanceof S3ServiceException &&
      error.$metadata.httpStatusCode === 412) ||
    (typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, '$metadata') !== null &&
      typeof Reflect.get(error, '$metadata') === 'object' &&
      Reflect.get(Reflect.get(error, '$metadata'), 'httpStatusCode') === 412)
  );
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS
  ) {
    throw new RecordsArtifactStoreError(
      'The records artifact provider timeout is invalid.',
    );
  }
  return timeout;
}

function parseGrantSeconds(value: number | undefined): number {
  const seconds = value ?? RECORDS_EXPORT_GRANT_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 15 * 60) {
    throw new RecordsArtifactStoreError(
      'The records export grant lifetime is invalid.',
    );
  }
  return seconds;
}

async function boundedProviderOperation<Result>(
  timeoutMilliseconds: number,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new RecordsArtifactStoreError(
          'The private records artifact store is unavailable.',
        ),
      );
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      throw new RecordsArtifactStoreError(
        'The private records artifact store is unavailable.',
      );
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new RecordsArtifactStoreError(
    'The existing private records artifact body is unavailable.',
  );
}

async function readBoundedBody(
  body: unknown,
  expectedByteLength: number,
  abortSignal: AbortSignal,
): Promise<Uint8Array> {
  abortSignal.throwIfAborted();
  if (body === null || body === undefined) {
    throw new RecordsArtifactStoreError(
      'The existing private records artifact body is unavailable.',
    );
  }
  if (body instanceof Uint8Array || typeof body === 'string') {
    const bytes = toBytes(body);
    if (bytes.byteLength !== expectedByteLength) {
      throw new RecordsArtifactStoreError(
        'The existing private records artifact size is inconsistent.',
      );
    }
    return bytes;
  }

  const iterator = Reflect.get(body as object, Symbol.asyncIterator);
  if (typeof iterator === 'function') {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<unknown>) {
      abortSignal.throwIfAborted();
      const bytes = toBytes(chunk);
      total += bytes.byteLength;
      if (total > expectedByteLength) {
        throw new RecordsArtifactStoreError(
          'The existing private records artifact exceeds its recorded size.',
        );
      }
      chunks.push(bytes);
    }
    if (total !== expectedByteLength) {
      throw new RecordsArtifactStoreError(
        'The existing private records artifact size is inconsistent.',
      );
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  throw new RecordsArtifactStoreError(
    'The existing private records artifact body is unavailable.',
  );
}

function parseHttpsUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new TypeError('invalid URL');
    }
    return parsed.toString();
  } catch {
    throw new RecordsArtifactStoreError(
      'The private records download grant is invalid.',
    );
  }
}

function createAwsDependencies(region: string): Readonly<{
  client: RecordsArtifactStoreClient;
  signer: RecordsArtifactStoreSigner;
}> {
  const awsClient = new S3Client({
    region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: MEDIA_PROVIDER_CONNECTION_TIMEOUT_MILLISECONDS,
      requestTimeout: MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS,
      socketTimeout: MEDIA_PROVIDER_OPERATION_TIMEOUT_MILLISECONDS,
      throwOnRequestTimeout: true,
    },
  });
  return Object.freeze({
    client: {
      getObject: (command, options) => awsClient.send(command, options),
      putObject: (command, options) => awsClient.send(command, options),
    },
    signer: (command, options) => getSignedUrl(awsClient, command, options),
  });
}

/**
 * Stores immutable, content-addressed exports in the existing private bucket.
 * There is deliberately no overwrite or delete method.
 */
export function createRecordsArtifactStore(
  dependencies: CreateRecordsArtifactStoreDependencies = {},
): RecordsArtifactStore {
  const configuration = readMediaObjectStoreConfiguration(
    dependencies.environment,
  );
  const defaults =
    dependencies.client === undefined || dependencies.signer === undefined
      ? createAwsDependencies(configuration.region)
      : null;
  const client = dependencies.client ?? defaults?.client;
  const signer = dependencies.signer ?? defaults?.signer;
  if (client === undefined || signer === undefined) {
    throw new RecordsArtifactStoreError(
      'The private records artifact store is unavailable.',
    );
  }
  const timeoutMilliseconds = parseTimeout(
    dependencies.providerTimeoutMilliseconds,
  );
  const grantSeconds = parseGrantSeconds(dependencies.grantSeconds);

  return Object.freeze({
    async store(input: StoreRecordsArtifactInput): Promise<RecordsExport> {
      if (
        input.bytes.byteLength < 1 ||
        input.bytes.byteLength > MAX_RECORDS_EXPORT_BYTES
      ) {
        throw new RecordsArtifactStoreError(
          'The generated records artifact size is invalid.',
        );
      }
      if (
        !Number.isSafeInteger(input.rowCount) ||
        input.rowCount < 0 ||
        input.rowCount > 100_000 ||
        Number.isNaN(input.generatedAt.getTime())
      ) {
        throw new RecordsArtifactStoreError(
          'The generated records artifact metadata is invalid.',
        );
      }
      const metadata = contentMetadata(input.format);
      const disposition = attachmentDisposition(input.fileName);
      if (!input.fileName.endsWith(`.${metadata.extension}`)) {
        throw new RecordsArtifactStoreError(
          'The records export filename does not match its format.',
        );
      }
      const sha256 = contentSha256(input.bytes);
      const checksum = checksumBase64(input.bytes);
      const storageKey = `ready/exports/${input.format}/${sha256}.${metadata.extension}`;
      const putCommand = new PutObjectCommand({
        Bucket: configuration.bucketName,
        Key: storageKey,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: metadata.contentType,
        ContentDisposition: STORED_CONTENT_DISPOSITION,
        CacheControl: CACHE_CONTROL,
        ChecksumSHA256: checksum,
        IfNoneMatch: '*',
        Metadata: {
          'record-kind': `${input.format}-records-export`,
          'content-sha256': sha256,
        },
      });

      try {
        const output = await boundedProviderOperation(
          timeoutMilliseconds,
          (abortSignal) => client.putObject(putCommand, { abortSignal }),
        );
        if (output.ChecksumSHA256 !== checksum) {
          throw new RecordsArtifactStoreError(
            'The private records artifact integrity acknowledgement is missing.',
          );
        }
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
        const existingBytes = await boundedProviderOperation(
          timeoutMilliseconds,
          async (abortSignal) => {
            const existing = await client.getObject(
              new GetObjectCommand({
                Bucket: configuration.bucketName,
                Key: storageKey,
                ChecksumMode: 'ENABLED',
              }),
              { abortSignal },
            );
            if (
              existing.ContentLength !== input.bytes.byteLength ||
              existing.ContentType !== metadata.contentType ||
              existing.ContentDisposition !== STORED_CONTENT_DISPOSITION ||
              existing.CacheControl !== CACHE_CONTROL ||
              existing.ChecksumSHA256 !== checksum ||
              existing.Metadata?.['content-sha256'] !== sha256 ||
              existing.Metadata?.['record-kind'] !==
                `${input.format}-records-export`
            ) {
              throw new RecordsArtifactStoreError(
                'The existing private records artifact does not match generated content.',
              );
            }
            return readBoundedBody(
              existing.Body,
              input.bytes.byteLength,
              abortSignal,
            );
          },
        );
        if (contentSha256(existingBytes) !== sha256) {
          throw new RecordsArtifactStoreError(
            'The existing private records artifact failed content verification.',
          );
        }
      }

      const downloadUrl = parseHttpsUrl(
        await boundedProviderOperation(timeoutMilliseconds, () =>
          signer(
            new GetObjectCommand({
              Bucket: configuration.bucketName,
              Key: storageKey,
              ResponseCacheControl: CACHE_CONTROL,
              ResponseContentDisposition: disposition,
              ResponseContentType: metadata.contentType,
            }),
            { expiresIn: grantSeconds },
          ),
        ),
      );
      return RecordsExportSchema.parse({
        id: randomUUID(),
        format: input.format,
        contentType: metadata.contentType,
        fileName: input.fileName,
        byteLength: input.bytes.byteLength,
        contentSha256: sha256,
        rowCount: input.rowCount,
        downloadUrl,
        generatedAt: input.generatedAt.toISOString(),
        expiresAt: new Date(
          input.generatedAt.getTime() + grantSeconds * 1_000,
        ).toISOString(),
      });
    },
  });
}
