import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  MAX_MEDIA_OBJECT_BYTES,
  MAX_MEDIA_READ_GRANT_SECONDS,
  MediaObjectStoreError,
  createMediaObjectStore,
  readMediaObjectStoreConfiguration,
  type MediaObjectStoreS3Client,
  type MediaObjectStoreSignOptions,
  type MediaObjectStoreSigner,
} from './object-store';

const ENVIRONMENT = {
  AWS_REGION: 'us-east-1',
  MEDIA_BUCKET_NAME: 'psd-eoc-synthetic-private-media',
} as const;
const EVENT_ID = '00000000-0000-4000-8000-000000000101';
const MEDIA_ID = '00000000-0000-4000-8000-000000000102';
const UPLOAD_INTENT_ID = '00000000-0000-4000-8000-000000000103';
const RAW_KEY = `raw/${EVENT_ID}/${UPLOAD_INTENT_ID}`;
const SANITIZED_KEY = `sanitized/${EVENT_ID}/${MEDIA_ID}`;

function hexDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function base64Digest(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

function preconditionFailed(message = 'synthetic provider detail') {
  return new S3ServiceException({
    name: 'PreconditionFailed',
    $fault: 'client',
    $metadata: { httpStatusCode: 412 },
    message,
  });
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function sanitizedMetadata(digest: string): Record<string, string> {
  return {
    'record-kind': 'sanitized-event-photo',
    'event-id': EVENT_ID,
    'media-id': MEDIA_ID,
    'upload-intent-id': UPLOAD_INTENT_ID,
    'sanitized-sha256': digest,
  };
}

function emptyClient(
  overrides: Partial<MediaObjectStoreS3Client> = {},
): MediaObjectStoreS3Client {
  return {
    getObject: async () => {
      throw new Error('Unexpected synthetic get.');
    },
    getObjectTagging: async () => {
      throw new Error('Unexpected synthetic tag read.');
    },
    putObject: async () => {
      throw new Error('Unexpected synthetic put.');
    },
    ...overrides,
  };
}

const FIXED_SIGNER_URL =
  'https://synthetic-private-media.s3.us-east-1.amazonaws.com/object';

function fixedSigner(url = FIXED_SIGNER_URL): MediaObjectStoreSigner {
  return async () => url;
}

async function expectObjectStoreError(
  operation: Promise<unknown>,
  code: MediaObjectStoreError['code'],
): Promise<MediaObjectStoreError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(MediaObjectStoreError);
    const objectStoreError = error as MediaObjectStoreError;
    expect(objectStoreError.code).toBe(code);
    return objectStoreError;
  }
  throw new Error(`Expected media object-store error ${code}.`);
}

describe('media object-store configuration', () => {
  test('reads only the App Runner region and private bucket settings', () => {
    const suppliedSecret = 'synthetic-secret-that-must-not-be-read';
    const environment = {
      ...ENVIRONMENT,
      AWS_ACCESS_KEY_ID: suppliedSecret,
      AWS_SECRET_ACCESS_KEY: suppliedSecret,
      MEDIA_STORAGE_ENDPOINT: `https://${suppliedSecret}.example`,
    };

    const configuration = readMediaObjectStoreConfiguration(environment);

    expect(configuration).toEqual({
      region: ENVIRONMENT.AWS_REGION,
      bucketName: ENVIRONMENT.MEDIA_BUCKET_NAME,
    });
    expect(JSON.stringify(configuration)).not.toContain(suppliedSecret);
  });

  test('fails closed on missing or malformed settings without reflecting values', () => {
    expect(() => readMediaObjectStoreConfiguration({})).toThrow(
      'AWS_REGION must be a valid AWS region name',
    );
    const invalidBucket = 'INVALID_bucket_name';
    try {
      readMediaObjectStoreConfiguration({
        AWS_REGION: ENVIRONMENT.AWS_REGION,
        MEDIA_BUCKET_NAME: invalidBucket,
      });
      throw new Error('Expected invalid media bucket configuration.');
    } catch (error) {
      expect(error).toBeInstanceOf(MediaObjectStoreError);
      expect(String(error)).not.toContain(invalidBucket);
    }
  });

  test('allows tests and deployments to tighten but never relax provider deadlines', () => {
    for (const providerTimeoutMilliseconds of [0, 10_001, 1.5]) {
      expect(() =>
        createMediaObjectStore({
          environment: ENVIRONMENT,
          client: emptyClient(),
          signer: fixedSigner(),
          providerTimeoutMilliseconds,
        }),
      ).toThrow(RangeError);
    }
  });

  test('fails closed and aborts stalled provider calls within the configured bound', async () => {
    let tagReadAborted = false;
    const stalledTagRead = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObjectTagging: async (_command, options) =>
          new Promise((_resolve, reject) => {
            options?.abortSignal.addEventListener(
              'abort',
              () => {
                tagReadAborted = true;
                reject(new Error('synthetic provider abort detail'));
              },
              { once: true },
            );
          }),
      }),
      signer: fixedSigner(),
      providerTimeoutMilliseconds: 5,
    });
    await expectObjectStoreError(
      stalledTagRead.getMalwareScanStatus(RAW_KEY),
      'STORAGE_UNAVAILABLE',
    );
    expect(tagReadAborted).toBe(true);

    let releaseStalledSigner: ((url: string) => void) | undefined;
    const stalledSignerOperation = new Promise<string>((resolve) => {
      releaseStalledSigner = resolve;
    });
    const stalledSigner = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient(),
      signer: async () => stalledSignerOperation,
      providerTimeoutMilliseconds: 5,
    });
    await expectObjectStoreError(
      stalledSigner.createPrivateReadGrant({ storageKey: SANITIZED_KEY }),
      'STORAGE_UNAVAILABLE',
    );
    releaseStalledSigner?.(FIXED_SIGNER_URL);
    await stalledSignerOperation;
  });

  test('retains signer permits after caller timeouts until underlying work settles', async () => {
    let resolveFirstSigner: ((url: string) => void) | undefined;
    const firstSignerOperation = new Promise<string>((resolve) => {
      resolveFirstSigner = resolve;
    });
    let resolveSecondSigner: ((url: string) => void) | undefined;
    const secondSignerOperation = new Promise<string>((resolve) => {
      resolveSecondSigner = resolve;
    });
    let signerEntries = 0;
    const signer: MediaObjectStoreSigner = async () => {
      signerEntries += 1;
      switch (signerEntries) {
        case 1:
          return firstSignerOperation;
        case 2:
          return secondSignerOperation;
        default:
          return FIXED_SIGNER_URL;
      }
    };
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient(),
      signer,
      providerTimeoutMilliseconds: 5,
    });
    const bytes = new TextEncoder().encode('bounded signer fixture');

    await expectObjectStoreError(
      store.createPrivateReadGrant({ storageKey: SANITIZED_KEY }),
      'STORAGE_UNAVAILABLE',
    );
    await expectObjectStoreError(
      store.createRawUploadGrant({
        storageKey: RAW_KEY,
        byteLength: bytes.byteLength,
        contentSha256: hexDigest(bytes),
        contentType: 'image/jpeg',
      }),
      'STORAGE_UNAVAILABLE',
    );
    await expectObjectStoreError(
      store.createPrivateReadGrant({ storageKey: SANITIZED_KEY }),
      'STORAGE_UNAVAILABLE',
    );
    expect(signerEntries).toBe(2);

    resolveFirstSigner?.(FIXED_SIGNER_URL);
    resolveSecondSigner?.(FIXED_SIGNER_URL);
    await Promise.all([firstSignerOperation, secondSignerOperation]);
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      store.createPrivateReadGrant({ storageKey: SANITIZED_KEY }),
    ).resolves.toMatchObject({ expiresInSeconds: 60 });
    expect(signerEntries).toBe(3);
  });
});

describe('raw private media uploads', () => {
  test('presigns exact content evidence and a create-only precondition without ACL or encryption overrides', async () => {
    const bytes = new TextEncoder().encode('synthetic photo bytes');
    const digest = hexDigest(bytes);
    const syntheticAwsClient = new S3Client({
      region: ENVIRONMENT.AWS_REGION,
      credentials: {
        accessKeyId: 'SYNTHETIC_TEST_KEY',
        secretAccessKey: 'synthetic-test-secret',
      },
    });
    let capturedCommand: PutObjectCommand | undefined;
    let capturedOptions: MediaObjectStoreSignOptions | undefined;
    const signer: MediaObjectStoreSigner = async (command, options) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      capturedCommand = command as PutObjectCommand;
      capturedOptions = options;
      return getSignedUrl(syntheticAwsClient, command as PutObjectCommand, {
        expiresIn: options.expiresIn,
        ...(options.signableHeaders === undefined
          ? {}
          : { signableHeaders: new Set(options.signableHeaders) }),
      });
    };
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient(),
      signer,
    });

    const grant = await store.createRawUploadGrant({
      storageKey: RAW_KEY,
      byteLength: bytes.byteLength,
      contentSha256: digest,
      contentType: 'image/jpeg',
    });

    expect(grant.method).toBe('PUT');
    expect(grant.requiredHeaders).toEqual({
      'content-type': 'image/jpeg',
      'if-none-match': '*',
    });
    expect(grant.expiresInSeconds).toBe(300);
    expect(capturedOptions?.signableHeaders).toEqual(
      new Set(['content-type', 'if-none-match']),
    );
    expect(capturedCommand?.input).toMatchObject({
      Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
      Key: RAW_KEY,
      ContentLength: bytes.byteLength,
      ContentType: 'image/jpeg',
      ChecksumSHA256: base64Digest(digest),
      IfNoneMatch: '*',
    });
    expect(capturedCommand?.input).not.toHaveProperty('ACL');
    expect(capturedCommand?.input).not.toHaveProperty('ServerSideEncryption');

    const signedUrl = new URL(grant.uploadUrl);
    expect(signedUrl.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );
    expect(signedUrl.searchParams.get('x-amz-checksum-sha256')).toBe(
      base64Digest(digest),
    );
    expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  test('keeps same-key replay grants create-only so S3 rejects a second version', async () => {
    const commands: PutObjectCommand[] = [];
    const options: MediaObjectStoreSignOptions[] = [];
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient(),
      signer: async (command, signOptions) => {
        expect(command).toBeInstanceOf(PutObjectCommand);
        commands.push(command as PutObjectCommand);
        options.push(signOptions);
        return 'https://private-media.example/replay-create-only';
      },
    });
    const input = {
      storageKey: RAW_KEY,
      byteLength: 1,
      contentSha256: 'a'.repeat(64),
      contentType: 'image/png' as const,
    };

    const first = await store.createRawUploadGrant(input);
    const replay = await store.createRawUploadGrant(input);

    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command.input.IfNoneMatch === '*')).toBe(
      true,
    );
    expect(
      options.every((candidate) =>
        candidate.signableHeaders?.has('if-none-match'),
      ),
    ).toBe(true);
    expect(first.requiredHeaders['if-none-match']).toBe('*');
    expect(replay.requiredHeaders['if-none-match']).toBe('*');
    expect(replay.uploadUrl).toBe(first.uploadUrl);
  });

  test('rejects invalid sizes, digests, keys, and non-HTTPS signer output', async () => {
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient(),
      signer: fixedSigner(),
    });
    const baseInput = {
      storageKey: RAW_KEY,
      byteLength: 1,
      contentSha256: 'a'.repeat(64),
      contentType: 'image/png' as const,
    };

    await expectObjectStoreError(
      store.createRawUploadGrant({
        ...baseInput,
        byteLength: MAX_MEDIA_OBJECT_BYTES + 1,
      }),
      'INVALID_ARGUMENT',
    );
    await expectObjectStoreError(
      store.createRawUploadGrant({ ...baseInput, contentSha256: 'not-a-hash' }),
      'INVALID_ARGUMENT',
    );
    await expectObjectStoreError(
      store.createRawUploadGrant({ ...baseInput, storageKey: '../escape' }),
      'INVALID_ARGUMENT',
    );

    const unsafeStore = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient(),
      signer: fixedSigner('http://public.example/object'),
    });
    await expectObjectStoreError(
      unsafeStore.createRawUploadGrant(baseInput),
      'STORAGE_UNAVAILABLE',
    );
  });
});

describe('bounded raw object reads', () => {
  test('cancels a stalled streamed body when the provider deadline expires', async () => {
    const bytes = new TextEncoder().encode('synthetic stalled body');
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Deliberately never enqueue or close.
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObject: async () =>
          ({
            Body: body,
            ContentLength: bytes.byteLength,
          }) as unknown as GetObjectCommandOutput,
      }),
      signer: fixedSigner(),
      providerTimeoutMilliseconds: 5,
    });

    await expectObjectStoreError(
      store.readVerifiedRawObject({
        storageKey: RAW_KEY,
        expectedByteLength: bytes.byteLength,
        expectedContentSha256: hexDigest(bytes),
      }),
      'STORAGE_UNAVAILABLE',
    );
    expect(bodyCancelled).toBe(true);
  });

  test('ranges, bounds, and recomputes the recorded SHA-256 before returning bytes', async () => {
    const bytes = new TextEncoder().encode('synthetic validated upload');
    const digest = hexDigest(bytes);
    let command: GetObjectCommand | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    const client = emptyClient({
      getObject: async (candidate) => {
        command = candidate;
        return {
          Body: body,
          ContentLength: bytes.byteLength,
          ContentType: 'application/octet-stream',
        } as unknown as GetObjectCommandOutput;
      },
    });
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client,
      signer: fixedSigner(),
    });

    const result = await store.readVerifiedRawObject({
      storageKey: RAW_KEY,
      expectedByteLength: bytes.byteLength,
      expectedContentSha256: digest,
    });

    expect(command?.input).toMatchObject({
      Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
      Key: RAW_KEY,
      Range: `bytes=0-${bytes.byteLength}`,
      ChecksumMode: 'ENABLED',
    });
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.contentSha256).toBe(digest);
    expect(result.bytes).toEqual(bytes);
    expect(result.storedContentType).toBe('application/octet-stream');
  });

  test('cancels before reading when S3 reports a different content length', async () => {
    const bytes = new TextEncoder().encode('expected');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObject: async () =>
          ({
            Body: body,
            ContentLength: bytes.byteLength + 1,
          }) as unknown as GetObjectCommandOutput,
      }),
      signer: fixedSigner(),
    });

    await expectObjectStoreError(
      store.readVerifiedRawObject({
        storageKey: RAW_KEY,
        expectedByteLength: bytes.byteLength,
        expectedContentSha256: hexDigest(bytes),
      }),
      'OBJECT_SIZE_MISMATCH',
    );

    expect(cancelled).toBe(true);
  });

  test('cancels a lying stream at the first byte beyond the recorded bound', async () => {
    const expected = new TextEncoder().encode('expected');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(expected);
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObject: async () =>
          ({
            Body: body,
            ContentLength: expected.byteLength,
          }) as unknown as GetObjectCommandOutput,
      }),
      signer: fixedSigner(),
    });

    await expectObjectStoreError(
      store.readVerifiedRawObject({
        storageKey: RAW_KEY,
        expectedByteLength: expected.byteLength,
        expectedContentSha256: hexDigest(expected),
      }),
      'OBJECT_SIZE_MISMATCH',
    );

    expect(cancelled).toBe(true);
  });

  test('rejects bytes that do not match the upload-intent checksum', async () => {
    const bytes = new TextEncoder().encode('substituted bytes');
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObject: async () =>
          ({
            Body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
            ContentLength: bytes.byteLength,
          }) as unknown as GetObjectCommandOutput,
      }),
      signer: fixedSigner(),
    });

    await expectObjectStoreError(
      store.readVerifiedRawObject({
        storageKey: RAW_KEY,
        expectedByteLength: bytes.byteLength,
        expectedContentSha256: '0'.repeat(64),
      }),
      'CHECKSUM_MISMATCH',
    );
  });
});

describe('sanitized private media writes and reads', () => {
  test('aborts a stalled sanitized write and fails closed at its provider deadline', async () => {
    const bytes = new TextEncoder().encode('sanitized stalled write');
    let putAborted = false;
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        putObject: async (_command, options) =>
          new Promise((_resolve, reject) => {
            options?.abortSignal.addEventListener(
              'abort',
              () => {
                putAborted = true;
                reject(new Error('synthetic stalled sanitized write'));
              },
              { once: true },
            );
          }),
      }),
      signer: fixedSigner(),
      providerTimeoutMilliseconds: 5,
    });

    await expectObjectStoreError(
      store.putSanitizedObject({
        storageKey: SANITIZED_KEY,
        bytes,
        contentType: 'image/jpeg',
        metadata: {
          eventId: EVENT_ID,
          mediaId: MEDIA_ID,
          uploadIntentId: UPLOAD_INTENT_ID,
        },
      }),
      'STORAGE_UNAVAILABLE',
    );
    expect(putAborted).toBe(true);
  });

  test('aborts a stalled immutable-retry verification read and fails closed', async () => {
    const bytes = new TextEncoder().encode('sanitized stalled retry read');
    let retryReadAborted = false;
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        putObject: async () => {
          throw preconditionFailed();
        },
        getObject: async (_command, options) =>
          new Promise((_resolve, reject) => {
            options?.abortSignal.addEventListener(
              'abort',
              () => {
                retryReadAborted = true;
                reject(new Error('synthetic stalled immutable retry read'));
              },
              { once: true },
            );
          }),
      }),
      signer: fixedSigner(),
      providerTimeoutMilliseconds: 5,
    });

    await expectObjectStoreError(
      store.putSanitizedObject({
        storageKey: SANITIZED_KEY,
        bytes,
        contentType: 'image/jpeg',
        metadata: {
          eventId: EVENT_ID,
          mediaId: MEDIA_ID,
          uploadIntentId: UPLOAD_INTENT_ID,
        },
      }),
      'STORAGE_UNAVAILABLE',
    );
    expect(retryReadAborted).toBe(true);
  });

  test('normally stores checksum-bound bytes with only server-owned metadata and bucket defaults', async () => {
    const bytes = new TextEncoder().encode('sanitized jpeg bytes');
    const digest = hexDigest(bytes);
    let command: PutObjectCommand | undefined;
    const client = emptyClient({
      putObject: async (candidate) => {
        command = candidate;
        return {
          $metadata: {},
          ChecksumSHA256: base64Digest(digest),
        };
      },
    });
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client,
      signer: fixedSigner(),
    });

    const result = await store.putSanitizedObject({
      storageKey: SANITIZED_KEY,
      bytes,
      contentType: 'image/jpeg',
      metadata: {
        eventId: EVENT_ID,
        mediaId: MEDIA_ID,
        uploadIntentId: UPLOAD_INTENT_ID,
      },
    });

    expect(result).toEqual({
      storageKey: SANITIZED_KEY,
      byteLength: bytes.byteLength,
      contentSha256: digest,
      contentType: 'image/jpeg',
    });
    expect(command?.input).toMatchObject({
      Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
      Key: SANITIZED_KEY,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: 'image/jpeg',
      ChecksumSHA256: base64Digest(digest),
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
      Metadata: {
        'record-kind': 'sanitized-event-photo',
        'event-id': EVENT_ID,
        'media-id': MEDIA_ID,
        'upload-intent-id': UPLOAD_INTENT_ID,
        'sanitized-sha256': digest,
      },
    });
    expect(command?.input).not.toHaveProperty('ACL');
    expect(command?.input).not.toHaveProperty('ServerSideEncryption');
  });

  test('accepts a retry only when the immutable existing object matches exactly', async () => {
    const bytes = new TextEncoder().encode('already stored sanitized jpeg');
    const digest = hexDigest(bytes);
    const providerDetail = 'synthetic precondition provider detail';
    let getCommand: GetObjectCommand | undefined;
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        putObject: async () => {
          throw preconditionFailed(providerDetail);
        },
        getObject: async (candidate) => {
          getCommand = candidate;
          return {
            Body: byteStream(bytes),
            ContentLength: bytes.byteLength,
            ContentType: 'image/jpeg',
            CacheControl: 'private, no-store',
            Metadata: sanitizedMetadata(digest),
          } as unknown as GetObjectCommandOutput;
        },
      }),
      signer: fixedSigner(),
    });

    const result = await store.putSanitizedObject({
      storageKey: SANITIZED_KEY,
      bytes,
      contentType: 'image/jpeg',
      metadata: {
        eventId: EVENT_ID,
        mediaId: MEDIA_ID,
        uploadIntentId: UPLOAD_INTENT_ID,
      },
    });

    expect(result).toEqual({
      storageKey: SANITIZED_KEY,
      byteLength: bytes.byteLength,
      contentSha256: digest,
      contentType: 'image/jpeg',
    });
    expect(getCommand?.input).toEqual({
      Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
      Key: SANITIZED_KEY,
      Range: `bytes=0-${bytes.byteLength}`,
      ChecksumMode: 'ENABLED',
    });
    expect(JSON.stringify(result)).not.toContain(providerDetail);
  });

  test('rejects a pre-existing object when any server-owned evidence differs', async () => {
    const bytes = new TextEncoder().encode('expected sanitized jpeg');
    const digest = hexDigest(bytes);
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        putObject: async () => {
          throw preconditionFailed();
        },
        getObject: async () =>
          ({
            Body: body,
            ContentLength: bytes.byteLength,
            ContentType: 'image/jpeg',
            CacheControl: 'private, no-store',
            Metadata: {
              ...sanitizedMetadata(digest),
              'media-id': UPLOAD_INTENT_ID,
            },
          }) as unknown as GetObjectCommandOutput,
      }),
      signer: fixedSigner(),
    });

    await expectObjectStoreError(
      store.putSanitizedObject({
        storageKey: SANITIZED_KEY,
        bytes,
        contentType: 'image/jpeg',
        metadata: {
          eventId: EVENT_ID,
          mediaId: MEDIA_ID,
          uploadIntentId: UPLOAD_INTENT_ID,
        },
      }),
      'STORAGE_UNAVAILABLE',
    );
    expect(bodyCancelled).toBe(true);
  });

  test('fails closed on ambiguous PUT failures without reading an existing object', async () => {
    const bytes = new TextEncoder().encode('sanitized bytes');
    const providerDetail = 'synthetic ambiguous provider failure';
    let getAttempted = false;
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        putObject: async () => {
          throw new Error(providerDetail);
        },
        getObject: async () => {
          getAttempted = true;
          throw new Error('must not be called');
        },
      }),
      signer: fixedSigner(),
    });

    const error = await expectObjectStoreError(
      store.putSanitizedObject({
        storageKey: SANITIZED_KEY,
        bytes,
        contentType: 'image/webp',
        metadata: {
          eventId: EVENT_ID,
          mediaId: MEDIA_ID,
          uploadIntentId: UPLOAD_INTENT_ID,
        },
      }),
      'STORAGE_UNAVAILABLE',
    );
    expect(getAttempted).toBe(false);
    expect(JSON.stringify(error)).not.toContain(providerDetail);
  });

  test('fails closed when the exact-existing verification read fails', async () => {
    const bytes = new TextEncoder().encode('sanitized bytes');
    const providerDetail = 'synthetic retry read provider failure';
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        putObject: async () => {
          throw preconditionFailed();
        },
        getObject: async () => {
          throw new Error(providerDetail);
        },
      }),
      signer: fixedSigner(),
    });

    const error = await expectObjectStoreError(
      store.putSanitizedObject({
        storageKey: SANITIZED_KEY,
        bytes,
        contentType: 'image/webp',
        metadata: {
          eventId: EVENT_ID,
          mediaId: MEDIA_ID,
          uploadIntentId: UPLOAD_INTENT_ID,
        },
      }),
      'STORAGE_UNAVAILABLE',
    );
    expect(JSON.stringify(error)).not.toContain(providerDetail);
  });

  test('fails closed unless S3 confirms the sanitized checksum', async () => {
    const bytes = new TextEncoder().encode('sanitized bytes');
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({ putObject: async () => ({ $metadata: {} }) }),
      signer: fixedSigner(),
    });

    await expectObjectStoreError(
      store.putSanitizedObject({
        storageKey: SANITIZED_KEY,
        bytes,
        contentType: 'image/webp',
        metadata: {
          eventId: EVENT_ID,
          mediaId: MEDIA_ID,
          uploadIntentId: UPLOAD_INTENT_ID,
        },
      }),
      'STORAGE_UNAVAILABLE',
    );
  });

  test('issues only HTTPS GET grants lasting at most five minutes', async () => {
    let command: GetObjectCommand | undefined;
    let options: MediaObjectStoreSignOptions | undefined;
    const signer: MediaObjectStoreSigner = async (candidate, supplied) => {
      command = candidate as GetObjectCommand;
      options = supplied;
      return 'https://synthetic-private-media.s3.us-east-1.amazonaws.com/sanitized';
    };
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient(),
      signer,
    });

    const grant = await store.createPrivateReadGrant({
      storageKey: SANITIZED_KEY,
      expiresInSeconds: MAX_MEDIA_READ_GRANT_SECONDS,
    });

    expect(grant.expiresInSeconds).toBe(300);
    expect(options).toEqual({ expiresIn: 300 });
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command?.input).toEqual({
      Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
      Key: SANITIZED_KEY,
      ResponseCacheControl: 'private, no-store',
    });

    await expectObjectStoreError(
      store.createPrivateReadGrant({
        storageKey: SANITIZED_KEY,
        expiresInSeconds: MAX_MEDIA_READ_GRANT_SECONDS + 1,
      }),
      'INVALID_ARGUMENT',
    );
  });

  test('has no delete path while exercising all S3 operations', async () => {
    const commands: Array<GetObjectCommand | PutObjectCommand> = [];
    const bytes = new TextEncoder().encode('verified');
    const digest = hexDigest(bytes);
    const client = emptyClient({
      getObject: async (command) => {
        commands.push(command);
        return {
          Body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          ContentLength: bytes.byteLength,
        } as unknown as GetObjectCommandOutput;
      },
      putObject: async (command) => {
        commands.push(command);
        return {
          $metadata: {},
          ChecksumSHA256: base64Digest(digest),
        };
      },
    });
    const signer: MediaObjectStoreSigner = async (command) => {
      commands.push(command);
      return 'https://synthetic-private-media.s3.us-east-1.amazonaws.com/object';
    };
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client,
      signer,
    });

    await store.createRawUploadGrant({
      storageKey: RAW_KEY,
      byteLength: bytes.byteLength,
      contentSha256: digest,
      contentType: 'image/png',
    });
    await store.readVerifiedRawObject({
      storageKey: RAW_KEY,
      expectedByteLength: bytes.byteLength,
      expectedContentSha256: digest,
    });
    await store.putSanitizedObject({
      storageKey: SANITIZED_KEY,
      bytes,
      contentType: 'image/png',
      metadata: {
        eventId: EVENT_ID,
        mediaId: MEDIA_ID,
        uploadIntentId: UPLOAD_INTENT_ID,
      },
    });
    await store.createPrivateReadGrant({ storageKey: SANITIZED_KEY });

    expect(commands).toHaveLength(4);
    expect(
      commands.every(
        (command) =>
          command instanceof GetObjectCommand ||
          command instanceof PutObjectCommand,
      ),
    ).toBe(true);
  });
});

describe('GuardDuty malware scan gate', () => {
  test('maps the exact GuardDuty scan tag vocabulary', async () => {
    const cases = [
      ['NO_THREATS_FOUND', 'clean'],
      ['THREATS_FOUND', 'threats'],
      ['UNSUPPORTED', 'unsupported'],
      ['ACCESS_DENIED', 'access-denied'],
      ['FAILED', 'failed'],
    ] as const;

    for (const [providerValue, expectedStatus] of cases) {
      let command: GetObjectTaggingCommand | undefined;
      const store = createMediaObjectStore({
        environment: ENVIRONMENT,
        client: emptyClient({
          getObjectTagging: async (candidate) => {
            command = candidate;
            return {
              $metadata: {},
              TagSet: [
                { Key: 'unrelated-server-tag', Value: 'synthetic' },
                {
                  Key: 'GuardDutyMalwareScanStatus',
                  Value: providerValue,
                },
              ],
            };
          },
        }),
        signer: fixedSigner(),
      });

      expect(await store.getMalwareScanStatus(RAW_KEY)).toBe(expectedStatus);
      expect(command).toBeInstanceOf(GetObjectTaggingCommand);
      expect(command?.input).toEqual({
        Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
        Key: RAW_KEY,
      });
    }
  });

  test('keeps an untagged object pending', async () => {
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObjectTagging: async () => ({
          $metadata: {},
          TagSet: [{ Key: 'unrelated-server-tag', Value: 'synthetic' }],
        }),
      }),
      signer: fixedSigner(),
    });

    expect(await store.getMalwareScanStatus(RAW_KEY)).toBe('pending');
  });

  test('fails closed on unknown or duplicate GuardDuty status tags', async () => {
    const unknownStore = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObjectTagging: async () => ({
          $metadata: {},
          TagSet: [
            {
              Key: 'GuardDutyMalwareScanStatus',
              Value: 'SYNTHETIC_UNKNOWN_VALUE',
            },
          ],
        }),
      }),
      signer: fixedSigner(),
    });
    expect(await unknownStore.getMalwareScanStatus(RAW_KEY)).toBe('failed');

    const duplicateStore = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObjectTagging: async () => ({
          $metadata: {},
          TagSet: [
            {
              Key: 'GuardDutyMalwareScanStatus',
              Value: 'NO_THREATS_FOUND',
            },
            {
              Key: 'GuardDutyMalwareScanStatus',
              Value: 'THREATS_FOUND',
            },
          ],
        }),
      }),
      signer: fixedSigner(),
    });
    expect(await duplicateStore.getMalwareScanStatus(RAW_KEY)).toBe('failed');
  });

  test('does not translate provider failures into a clean scan', async () => {
    const providerPayload = 'synthetic-provider-secret';
    const store = createMediaObjectStore({
      environment: ENVIRONMENT,
      client: emptyClient({
        getObjectTagging: async () => {
          throw new Error(providerPayload);
        },
      }),
      signer: fixedSigner(),
    });

    const error = await expectObjectStoreError(
      store.getMalwareScanStatus(RAW_KEY),
      'STORAGE_UNAVAILABLE',
    );
    expect(JSON.stringify(error)).not.toContain(providerPayload);
  });
});
