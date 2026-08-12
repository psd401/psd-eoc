import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import type {
  GetObjectCommand,
  PutObjectCommand,
  GetObjectCommandOutput,
  PutObjectCommandOutput,
} from '@aws-sdk/client-s3';

import {
  MAX_RECORDS_EXPORT_BYTES,
  RecordsArtifactStoreError,
  createRecordsArtifactStore,
  type RecordsArtifactStoreClient,
} from './artifact-store';

const ENVIRONMENT = {
  AWS_REGION: 'us-west-2',
  MEDIA_BUCKET_NAME: 'synthetic-psd-eoc-private',
} as const;

const GENERATED_AT = new Date('2026-08-11T21:00:00.000Z');

function sha256(bytes: Uint8Array, encoding: 'hex' | 'base64'): string {
  return createHash('sha256').update(bytes).digest(encoding);
}

function input(bytes = new TextEncoder().encode('site,date\r\n')) {
  return {
    bytes,
    format: 'csv' as const,
    fileName: 'drill-records-2026-08-11.csv',
    rowCount: 0,
    generatedAt: GENERATED_AT,
  };
}

describe('private records artifact storage', () => {
  test('creates one immutable content-addressed object and a five-minute HTTPS grant', async () => {
    const puts: PutObjectCommand[] = [];
    const signed: GetObjectCommand[] = [];
    const bytes = input().bytes;
    const client: RecordsArtifactStoreClient = {
      async putObject(command): Promise<PutObjectCommandOutput> {
        puts.push(command);
        return {
          $metadata: {},
          ChecksumSHA256: sha256(bytes, 'base64'),
        };
      },
      async getObject(): Promise<GetObjectCommandOutput> {
        throw new Error('A new object must not perform a collision read.');
      },
    };
    const store = createRecordsArtifactStore({
      environment: ENVIRONMENT,
      client,
      signer: async (command, options) => {
        signed.push(command);
        expect(options).toEqual({ expiresIn: 300 });
        return 'https://private.example.test/export?synthetic=1';
      },
    });

    const result = await store.store(input(bytes));

    expect(puts).toHaveLength(1);
    expect(puts[0]?.input).toMatchObject({
      Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
      Key: `ready/exports/csv/${sha256(bytes, 'hex')}.csv`,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: 'text/csv; charset=utf-8',
      ContentDisposition: 'attachment',
      CacheControl: 'private, no-store',
      ChecksumSHA256: sha256(bytes, 'base64'),
      IfNoneMatch: '*',
    });
    expect(signed[0]?.input).toMatchObject({
      Bucket: ENVIRONMENT.MEDIA_BUCKET_NAME,
      Key: `ready/exports/csv/${sha256(bytes, 'hex')}.csv`,
      ResponseContentType: 'text/csv; charset=utf-8',
      ResponseContentDisposition:
        'attachment; filename="drill-records-2026-08-11.csv"',
      ResponseCacheControl: 'private, no-store',
    });
    expect(result).toMatchObject({
      format: 'csv',
      contentType: 'text/csv; charset=utf-8',
      fileName: 'drill-records-2026-08-11.csv',
      byteLength: bytes.byteLength,
      contentSha256: sha256(bytes, 'hex'),
      rowCount: 0,
      generatedAt: GENERATED_AT.toISOString(),
      expiresAt: '2026-08-11T21:05:00.000Z',
    });
  });

  test('verifies exact existing bytes after an immutable-key collision', async () => {
    const bytes = input().bytes;
    let reads = 0;
    const client: RecordsArtifactStoreClient = {
      async putObject(): Promise<PutObjectCommandOutput> {
        throw { $metadata: { httpStatusCode: 412 } };
      },
      async getObject(command): Promise<GetObjectCommandOutput> {
        reads += 1;
        expect(command.input).toMatchObject({ ChecksumMode: 'ENABLED' });
        return {
          $metadata: {},
          Body: bytes as unknown as NonNullable<GetObjectCommandOutput['Body']>,
          ContentLength: bytes.byteLength,
          ContentType: 'text/csv; charset=utf-8',
          ContentDisposition: 'attachment',
          CacheControl: 'private, no-store',
          ChecksumSHA256: sha256(bytes, 'base64'),
          Metadata: {
            'content-sha256': sha256(bytes, 'hex'),
            'record-kind': 'csv-records-export',
          },
        };
      },
    };
    const store = createRecordsArtifactStore({
      environment: ENVIRONMENT,
      client,
      signer: async () => 'https://private.example.test/existing',
    });

    await expect(store.store(input(bytes))).resolves.toMatchObject({
      contentSha256: sha256(bytes, 'hex'),
    });
    await expect(
      store.store({
        ...input(bytes),
        fileName: 'drill-records-different-scope.csv',
      }),
    ).resolves.toMatchObject({
      contentSha256: sha256(bytes, 'hex'),
      fileName: 'drill-records-different-scope.csv',
    });
    expect(reads).toBe(2);
  });

  test('bounds and aborts a stalled immutable-collision body read', async () => {
    const bytes = input().bytes;
    let collisionSignal: AbortSignal | undefined;
    const stalledBody = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>(() => {
              // The synthetic provider never produces body bytes.
            }),
        };
      },
    };
    const client: RecordsArtifactStoreClient = {
      async putObject(): Promise<PutObjectCommandOutput> {
        throw { $metadata: { httpStatusCode: 412 } };
      },
      async getObject(_command, options): Promise<GetObjectCommandOutput> {
        collisionSignal = options?.abortSignal;
        return {
          $metadata: {},
          Body: stalledBody as NonNullable<GetObjectCommandOutput['Body']>,
          ContentLength: bytes.byteLength,
          ContentType: 'text/csv; charset=utf-8',
          ContentDisposition: 'attachment',
          CacheControl: 'private, no-store',
          ChecksumSHA256: sha256(bytes, 'base64'),
          Metadata: {
            'content-sha256': sha256(bytes, 'hex'),
            'record-kind': 'csv-records-export',
          },
        };
      },
    };

    await expect(
      createRecordsArtifactStore({
        environment: ENVIRONMENT,
        client,
        providerTimeoutMilliseconds: 5,
        signer: async () => 'https://private.example.test/existing',
      }).store(input(bytes)),
    ).rejects.toBeInstanceOf(RecordsArtifactStoreError);
    expect(collisionSignal?.aborted).toBe(true);
  });

  test('fails closed on collision mismatch, insecure grants, and oversized bytes', async () => {
    const bytes = input().bytes;
    const collisionClient: RecordsArtifactStoreClient = {
      async putObject(): Promise<PutObjectCommandOutput> {
        throw { $metadata: { httpStatusCode: 412 } };
      },
      async getObject(): Promise<GetObjectCommandOutput> {
        return {
          $metadata: {},
          Body: new TextEncoder().encode('different') as unknown as NonNullable<
            GetObjectCommandOutput['Body']
          >,
          ContentLength: bytes.byteLength,
          ContentType: 'text/csv; charset=utf-8',
          ContentDisposition: 'attachment',
          CacheControl: 'private, no-store',
          ChecksumSHA256: sha256(bytes, 'base64'),
          Metadata: {
            'content-sha256': sha256(bytes, 'hex'),
            'record-kind': 'csv-records-export',
          },
        };
      },
    };
    await expect(
      createRecordsArtifactStore({
        environment: ENVIRONMENT,
        client: collisionClient,
        signer: async () => 'https://private.example.test/existing',
      }).store(input(bytes)),
    ).rejects.toBeInstanceOf(RecordsArtifactStoreError);

    const newClient: RecordsArtifactStoreClient = {
      async putObject(): Promise<PutObjectCommandOutput> {
        return {
          $metadata: {},
          ChecksumSHA256: sha256(bytes, 'base64'),
        };
      },
      async getObject(): Promise<GetObjectCommandOutput> {
        throw new Error('unused');
      },
    };
    await expect(
      createRecordsArtifactStore({
        environment: ENVIRONMENT,
        client: newClient,
        signer: async () => 'http://private.example.test/export',
      }).store(input(bytes)),
    ).rejects.toBeInstanceOf(RecordsArtifactStoreError);

    await expect(
      createRecordsArtifactStore({
        environment: ENVIRONMENT,
        client: newClient,
        signer: async () => 'https://private.example.test/export',
      }).store(input(new Uint8Array(MAX_RECORDS_EXPORT_BYTES + 1))),
    ).rejects.toBeInstanceOf(RecordsArtifactStoreError);
  });
});
