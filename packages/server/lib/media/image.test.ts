import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import {
  ImageProcessingUnavailableError,
  ImageValidationError,
  isHeicDecodeAvailable,
  mapSharpFailure,
  sanitizeUploadedImage,
  sniffImageContentType,
  type ImageSanitizationInput,
  type ImageValidationErrorCode,
} from './image';

const ANIMATED_WEBP = Buffer.from(
  'UklGRtYBAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAD/////AABBTk1G9AAAAAAAAAAAAA8AAA8AAOgDAAJWUDgg3AAAADADAJ0BKhAAEAACADQlsAJ0RgBlgHSJj6PzJAus2lMurcAA/vlX9qXpLas+vE7GIiHrHzfHrzpee3lX8b7Q7d2wCe7Gv/iG/3vtzq9yB07+f6nyScMeXeDr/4q19d9kBH4JDmcv8g8HzW/3nGO0yhd3nijpW/+/13avNX3Pl4TkbCns2Zl98VgnP3mzy/9H/91mdS6F8d5h/5oug2PfcRpOif7Dr38X4Ljb/Svkw/rEuMcBuKXT/hL7yH9RHb5JMMHbIf3af9XRlZP/8jq4RYaY+4unfS3JIj2AAABBTk1GrgAAAAAAAAAAAAkAAAoAAOgDAABWUDgglgAAABQCAJ0BKgoACwAAADQlsAJ0AN0ZAoeqSwAA/vfalXe2puMD/90ZxJf/To7B/RZnkDB3MvPb1afmeCfj+brXbIBszFsdqdsQ4IYLBBH+7wN3Hdv1/sEGvxO/bYK/Ry/u55X98BfyWrXq1/p0mKj/fuWql/c2C3e/8dv/icff4/8SkLn+v/LdWK9VkV5/9Rt97v2N80uAAA==',
  'base64',
);
const HEIC_HEADER = Buffer.from(
  '000000186674797068656963000000006d69663168656963',
  'hex',
);

const XMP_FIXTURE = [
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
  '<dc:description>synthetic metadata</dc:description>',
  '</rdf:Description></rdf:RDF></x:xmpmeta>',
  '<?xpacket end="w"?>',
].join('');

let jpeg: Buffer;
let png: Buffer;
let webp: Buffer;
let metadataJpeg: Buffer;
let largePixelImage: Buffer;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function uploadInput(
  bytes: Buffer,
  declaredContentType: string,
): ImageSanitizationInput {
  return Object.freeze({
    bytes,
    declaredByteLength: bytes.length,
    declaredContentSha256: sha256(bytes),
    declaredContentType,
  });
}

async function expectImageError(
  operation: Promise<unknown>,
  code: ImageValidationErrorCode,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ImageValidationError);
    expect((error as ImageValidationError).code).toBe(code);
    expect((error as ImageValidationError).message.length).toBeGreaterThan(0);
  }
}

beforeAll(async () => {
  const source = {
    create: {
      width: 12,
      height: 8,
      channels: 4 as const,
      background: { r: 12, g: 88, b: 156, alpha: 0.7 },
    },
  };
  [jpeg, png, webp, largePixelImage] = await Promise.all([
    sharp(source).jpeg().toBuffer(),
    sharp(source).png().toBuffer(),
    sharp(source).webp().toBuffer(),
    sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer(),
  ]);

  metadataJpeg = await sharp({
    create: {
      width: 3,
      height: 2,
      channels: 3,
      background: { r: 180, g: 20, b: 40 },
    },
  })
    .jpeg()
    .withExif({
      IFD0: {
        Artist: 'Synthetic PSD EOC test fixture',
      },
      IFD3: {
        GPSLatitude: '47/1 23/1 0/1',
        GPSLatitudeRef: 'N',
        GPSLongitude: '122/1 35/1 0/1',
        GPSLongitudeRef: 'W',
      },
    })
    .withXmp(XMP_FIXTURE)
    .withMetadata({ orientation: 6 })
    .toBuffer();
});

describe('sniffImageContentType', () => {
  test('recognizes JPEG, PNG, WebP, and a specific HEIC brand by bytes', () => {
    expect(sniffImageContentType(jpeg)).toBe('image/jpeg');
    expect(sniffImageContentType(png)).toBe('image/png');
    expect(sniffImageContentType(webp)).toBe('image/webp');
    expect(sniffImageContentType(HEIC_HEADER)).toBe('image/heic');
  });

  test('does not mistake AVIF or arbitrary file contents for an accepted image', () => {
    const avifHeader = Buffer.from(
      '000000186674797061766966000000006d69663161766966',
      'hex',
    );

    expect(sniffImageContentType(avifHeader)).toBeNull();
    expect(sniffImageContentType(Buffer.from('%PDF-1.7 fake.jpg'))).toBeNull();
  });
});

describe('sanitizeUploadedImage', () => {
  test('keeps Sharp operation timeouts retryable instead of declaring malformed bytes', () => {
    const nativeDetail =
      'Synthetic Sharp timeout included a native provider detail.';
    const error = mapSharpFailure(new Error(nativeDetail), 'image/jpeg');

    expect(error).toBeInstanceOf(ImageProcessingUnavailableError);
    expect(error).not.toBeInstanceOf(ImageValidationError);
    expect(error.message).not.toContain(nativeDetail);
  });

  const stillImageFixtures = [
    ['JPEG', () => jpeg, 'image/jpeg'],
    ['PNG', () => png, 'image/png'],
    ['WebP', () => webp, 'image/webp'],
  ] as const;

  for (const [label, loadBytes, contentType] of stillImageFixtures) {
    test(`fully decodes, rewrites, verifies, and re-decodes a ${label} image`, async () => {
      const result = await sanitizeUploadedImage(
        uploadInput(loadBytes(), contentType),
      );
      const metadata = await sharp(result.sanitizedBytes).metadata();
      await sharp(result.sanitizedBytes).stats();

      expect(result.detectedContentType).toBe(contentType);
      expect(result.sanitizedContentType).toBe(contentType);
      expect(sniffImageContentType(result.sanitizedBytes)).toBe(contentType);
      expect(result.sanitizedByteLength).toBe(result.sanitizedBytes.length);
      expect(result.sanitizedContentSha256).toBe(sha256(result.sanitizedBytes));
      expect(result.exifStripped).toBe(true);
      expect(result.structuralContentDisarm).toEqual({
        kind: 'structural-content-disarm',
        result: 'passed',
        checks: {
          sourceFullyDecoded: true,
          sourceSinglePage: true,
          sourcePixelCountBounded: true,
          orientationNormalized: true,
          pixelsReencoded: true,
          outputMagicBytesMatched: true,
          outputContainerMetadataAbsent: true,
          outputDecoderMetadataAbsent: true,
          outputSinglePage: true,
          outputPixelCountBounded: true,
          outputFullyDecoded: true,
        },
      });
      expect('malwareScan' in result).toBe(false);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
    });
  }

  test('returns copies so verified bytes cannot drift from their digest and proof', async () => {
    const result = await sanitizeUploadedImage(uploadInput(png, 'image/png'));
    const firstRead = result.sanitizedBytes;
    firstRead.fill(0);
    const secondRead = result.sanitizedBytes;

    expect(secondRead).not.toBe(firstRead);
    expect(sha256(secondRead)).toBe(result.sanitizedContentSha256);
    expect(result.structuralContentDisarm.result).toBe('passed');
    expect(sniffImageContentType(secondRead)).toBe('image/png');
  });

  test('removes EXIF/GPS, XMP, ICC, and orientation while rotating pixels', async () => {
    const sourceMetadata = await sharp(metadataJpeg).metadata();
    expect(sourceMetadata.exif).toBeDefined();
    expect(sourceMetadata.xmp).toBeDefined();
    expect(sourceMetadata.icc).toBeDefined();
    expect(sourceMetadata.orientation).toBe(6);

    const result = await sanitizeUploadedImage(
      uploadInput(metadataJpeg, 'image/jpeg'),
    );
    const sanitizedMetadata = await sharp(result.sanitizedBytes).metadata();

    expect(result.width).toBe(2);
    expect(result.height).toBe(3);
    expect(sanitizedMetadata.exif).toBeUndefined();
    expect(sanitizedMetadata.xmp).toBeUndefined();
    expect(sanitizedMetadata.icc).toBeUndefined();
    expect(sanitizedMetadata.iptc).toBeUndefined();
    expect(sanitizedMetadata.orientation).toBeUndefined();
    expect(result.sanitizedBytes.toString('latin1')).not.toContain('GPS');
    expect(result.sanitizedBytes.toString('latin1')).not.toContain('xmp');
  });

  test('rejects a disguised non-image regardless of its declared JPEG type', async () => {
    const disguised = Buffer.from(
      '<script>alert("not an image despite its .jpg name")</script>',
    );

    await expectImageError(
      sanitizeUploadedImage(uploadInput(disguised, 'image/jpeg')),
      'UNSUPPORTED_CONTENT_TYPE',
    );
  });

  test('rejects a valid image whose bytes do not match its declaration', async () => {
    await expectImageError(
      sanitizeUploadedImage(uploadInput(png, 'image/jpeg')),
      'CONTENT_TYPE_MISMATCH',
    );
  });

  test('rejects malformed bytes even when their magic bytes look like JPEG', async () => {
    const malformed = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    ]);

    await expectImageError(
      sanitizeUploadedImage(uploadInput(malformed, 'image/jpeg')),
      'MALFORMED_IMAGE',
    );
  });

  test('rejects malformed PNG and WebP containers after matching their magic bytes', async () => {
    const malformedInputs = [
      [Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), 'image/png'],
      [Buffer.from('524946460c0000005745425056503820', 'hex'), 'image/webp'],
    ] as const;

    for (const [bytes, contentType] of malformedInputs) {
      await expectImageError(
        sanitizeUploadedImage(uploadInput(bytes, contentType)),
        'MALFORMED_IMAGE',
      );
    }
  });

  test('rejects animated WebP before any still-image rewrite', async () => {
    const metadata = await sharp(ANIMATED_WEBP).metadata();
    expect(metadata.pages).toBe(2);

    await expectImageError(
      sanitizeUploadedImage(uploadInput(ANIMATED_WEBP, 'image/webp')),
      'PAGE_LIMIT_EXCEEDED',
    );
  });

  test('rejects images above a tightened pixel bound', async () => {
    await expectImageError(
      sanitizeUploadedImage(uploadInput(largePixelImage, 'image/png'), {
        maxPixels: 399,
      }),
      'PIXEL_LIMIT_EXCEEDED',
    );
  });

  test('rejects oversized input and oversized sanitized output', async () => {
    await expectImageError(
      sanitizeUploadedImage(uploadInput(png, 'image/png'), {
        maxInputBytes: png.length - 1,
      }),
      'TOO_LARGE',
    );
    await expectImageError(
      sanitizeUploadedImage(uploadInput(png, 'image/png'), {
        maxOutputBytes: 1,
      }),
      'SANITIZED_IMAGE_TOO_LARGE',
    );
  });

  test('rejects upload-intent length and checksum mismatches', async () => {
    await expectImageError(
      sanitizeUploadedImage({
        ...uploadInput(png, 'image/png'),
        declaredByteLength: png.length + 1,
      }),
      'INVALID_DECLARED_LENGTH',
    );
    await expectImageError(
      sanitizeUploadedImage({
        ...uploadInput(png, 'image/png'),
        declaredContentSha256: '0'.repeat(64),
      }),
      'CHECKSUM_MISMATCH',
    );
  });

  test('rejects empty bytes, malformed digest syntax, and unsupported declarations', async () => {
    await expectImageError(
      sanitizeUploadedImage(uploadInput(Buffer.alloc(0), 'image/png')),
      'EMPTY_IMAGE',
    );
    await expectImageError(
      sanitizeUploadedImage({
        ...uploadInput(png, 'image/png'),
        declaredContentSha256: 'not-a-sha256',
      }),
      'INVALID_DECLARED_SHA256',
    );
    await expectImageError(
      sanitizeUploadedImage(uploadInput(png, 'image/gif')),
      'UNSUPPORTED_CONTENT_TYPE',
    );
  });

  test('fails explicitly when the deployed Sharp build lacks an HEIC codec', async () => {
    if (isHeicDecodeAvailable()) {
      return;
    }
    expect(isHeicDecodeAvailable()).toBe(false);
    await expectImageError(
      sanitizeUploadedImage(uploadInput(HEIC_HEADER, 'image/heic')),
      'HEIC_CODEC_UNAVAILABLE',
    );
  });
});
