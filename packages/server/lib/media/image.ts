import { createHash } from 'node:crypto';

import {
  MediaContentTypeSchema,
  type MediaContentType,
} from '@psd-eoc/contracts';
import sharp, { type Metadata, type Sharp } from 'sharp';

export const MAX_IMAGE_INPUT_BYTES = 25 * 1_024 * 1_024;
export const MAX_IMAGE_OUTPUT_BYTES = 25 * 1_024 * 1_024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_PAGES = 1;
export const MAX_SHARP_OPERATION_SECONDS = 10;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xe2, 0xed, 0xfe]);
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'iCCP', 'iTXt', 'tEXt', 'zTXt']);
const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'ICCP', 'XMP ']);
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
]);

export type SanitizedMediaContentType = Exclude<MediaContentType, 'image/heic'>;

export type ImageValidationErrorCode =
  | 'CHECKSUM_MISMATCH'
  | 'CONTENT_TYPE_MISMATCH'
  | 'EMPTY_IMAGE'
  | 'HEIC_CODEC_UNAVAILABLE'
  | 'INVALID_DECLARED_LENGTH'
  | 'INVALID_DECLARED_SHA256'
  | 'MALFORMED_IMAGE'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'PIXEL_LIMIT_EXCEEDED'
  | 'SANITIZED_IMAGE_INVALID'
  | 'SANITIZED_IMAGE_TOO_LARGE'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE';

/** A bounded message safe to show to the human who selected the image. */
export class ImageValidationError extends Error {
  public constructor(
    public readonly code: ImageValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

/** A native processing failure that does not prove the input is malformed. */
export class ImageProcessingUnavailableError extends Error {
  public constructor() {
    super('Image processing is temporarily unavailable.');
    this.name = 'ImageProcessingUnavailableError';
  }
}

export interface ImageSanitizationInput {
  /** Untrusted bytes fetched from the exact private upload-intent object. */
  readonly bytes: Uint8Array;
  /** Exact length committed when the upload intent was created. */
  readonly declaredByteLength: number;
  /** Exact lowercase SHA-256 committed when the upload intent was created. */
  readonly declaredContentSha256: string;
  /** Untrusted declaration; the byte signature remains authoritative. */
  readonly declaredContentType: string;
}

/**
 * Test and deployment bounds may only tighten, never relax, the release-one
 * limits exported above.
 */
export interface ImageSanitizationLimits {
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxPixels?: number;
}

/**
 * Evidence produced only after decode, orientation, re-encode, metadata
 * inspection, container inspection, and a second full decode all succeed.
 *
 * This is structural content-disarm evidence, not a malware verdict. The
 * authoritative malware result is supplied separately by the object-store
 * scanning integration and must never be inferred from this value.
 */
export interface StructuralContentDisarmProof {
  readonly kind: 'structural-content-disarm';
  readonly result: 'passed';
  readonly checks: Readonly<{
    sourceFullyDecoded: true;
    sourceSinglePage: true;
    sourcePixelCountBounded: true;
    orientationNormalized: true;
    pixelsReencoded: true;
    outputMagicBytesMatched: true;
    outputContainerMetadataAbsent: true;
    outputDecoderMetadataAbsent: true;
    outputSinglePage: true;
    outputPixelCountBounded: true;
    outputFullyDecoded: true;
  }>;
}

export interface SanitizedImage {
  readonly detectedContentType: MediaContentType;
  readonly sanitizedContentType: SanitizedMediaContentType;
  /** Each read returns a copy of the verified, digest-bound byte snapshot. */
  readonly sanitizedBytes: Buffer;
  readonly sanitizedByteLength: number;
  readonly sanitizedContentSha256: string;
  readonly width: number;
  readonly height: number;
  readonly exifStripped: true;
  readonly structuralContentDisarm: StructuralContentDisarmProof;
}

interface ResolvedImageLimits {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxPixels: number;
}

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function safeError(code: ImageValidationErrorCode): ImageValidationError {
  switch (code) {
    case 'EMPTY_IMAGE':
      return new ImageValidationError(
        code,
        'Choose an image that is not empty.',
      );
    case 'TOO_LARGE':
    case 'INVALID_DECLARED_LENGTH':
      return new ImageValidationError(
        code,
        'The image is too large or its upload size does not match. Choose a smaller image and try again.',
      );
    case 'CHECKSUM_MISMATCH':
    case 'INVALID_DECLARED_SHA256':
      return new ImageValidationError(
        code,
        'The uploaded image did not match the selected file. Please upload it again.',
      );
    case 'UNSUPPORTED_CONTENT_TYPE':
      return new ImageValidationError(
        code,
        'Choose a JPEG, PNG, WebP, or HEIC image.',
      );
    case 'CONTENT_TYPE_MISMATCH':
      return new ImageValidationError(
        code,
        'The file contents do not match the selected image type.',
      );
    case 'HEIC_CODEC_UNAVAILABLE':
      return new ImageValidationError(
        code,
        'HEIC images cannot be processed right now. Convert this photo to JPEG, PNG, or WebP and try again.',
      );
    case 'PAGE_LIMIT_EXCEEDED':
      return new ImageValidationError(
        code,
        'Animated or multi-page images are not supported. Choose a single still image.',
      );
    case 'PIXEL_LIMIT_EXCEEDED':
      return new ImageValidationError(
        code,
        'The image dimensions are too large. Choose a smaller image and try again.',
      );
    case 'SANITIZED_IMAGE_TOO_LARGE':
      return new ImageValidationError(
        code,
        'The processed image is too large. Choose a smaller image and try again.',
      );
    case 'MALFORMED_IMAGE':
    case 'SANITIZED_IMAGE_INVALID':
      return new ImageValidationError(
        code,
        'The image could not be safely processed. Choose a different image and try again.',
      );
  }
}

function resolveTightenedLimit(
  candidate: number | undefined,
  ceiling: number,
  name: string,
): number {
  if (candidate === undefined) {
    return ceiling;
  }
  if (
    !Number.isSafeInteger(candidate) ||
    candidate <= 0 ||
    candidate > ceiling
  ) {
    throw new RangeError(
      `${name} must be a positive integer no greater than ${ceiling}.`,
    );
  }
  return candidate;
}

function resolveLimits(
  limits: ImageSanitizationLimits | undefined,
): ResolvedImageLimits {
  return Object.freeze({
    maxInputBytes: resolveTightenedLimit(
      limits?.maxInputBytes,
      MAX_IMAGE_INPUT_BYTES,
      'maxInputBytes',
    ),
    maxOutputBytes: resolveTightenedLimit(
      limits?.maxOutputBytes,
      MAX_IMAGE_OUTPUT_BYTES,
      'maxOutputBytes',
    ),
    maxPixels: resolveTightenedLimit(
      limits?.maxPixels,
      MAX_IMAGE_PIXELS,
      'maxPixels',
    ),
  });
}

function hasAscii(bytes: Buffer, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) {
    return false;
  }
  return bytes.toString('ascii', offset, offset + expected.length) === expected;
}

function sniffHeic(bytes: Buffer): boolean {
  if (bytes.length < 16 || !hasAscii(bytes, 4, 'ftyp')) {
    return false;
  }
  const boxByteLength = bytes.readUInt32BE(0);
  if (
    boxByteLength < 16 ||
    boxByteLength > bytes.length ||
    boxByteLength % 4 !== 0
  ) {
    return false;
  }

  if (HEIC_BRANDS.has(bytes.toString('ascii', 8, 12))) {
    return true;
  }
  for (let offset = 16; offset + 4 <= boxByteLength; offset += 4) {
    if (HEIC_BRANDS.has(bytes.toString('ascii', offset, offset + 4))) {
      return true;
    }
  }
  return false;
}

/** Sniffs only the accepted raster signatures; extensions are never used. */
export function sniffImageContentType(
  input: Uint8Array,
): MediaContentType | null {
  const bytes = Buffer.from(input);
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    hasAscii(bytes, 1, 'PNG') &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    hasAscii(bytes, 0, 'RIFF') &&
    hasAscii(bytes, 8, 'WEBP')
  ) {
    return 'image/webp';
  }
  if (sniffHeic(bytes)) {
    return 'image/heic';
  }
  return null;
}

function contentSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateUploadEnvelope(
  input: ImageSanitizationInput,
  bytes: Buffer,
  limits: ResolvedImageLimits,
): MediaContentType {
  if (bytes.length === 0) {
    throw safeError('EMPTY_IMAGE');
  }
  if (bytes.length > limits.maxInputBytes) {
    throw safeError('TOO_LARGE');
  }
  if (
    !Number.isSafeInteger(input.declaredByteLength) ||
    input.declaredByteLength <= 0 ||
    input.declaredByteLength > limits.maxInputBytes ||
    input.declaredByteLength !== bytes.length
  ) {
    throw safeError('INVALID_DECLARED_LENGTH');
  }
  if (!SHA256_HEX_PATTERN.test(input.declaredContentSha256)) {
    throw safeError('INVALID_DECLARED_SHA256');
  }
  if (contentSha256(bytes) !== input.declaredContentSha256) {
    throw safeError('CHECKSUM_MISMATCH');
  }

  const declared = MediaContentTypeSchema.safeParse(input.declaredContentType);
  if (!declared.success) {
    throw safeError('UNSUPPORTED_CONTENT_TYPE');
  }
  const detected = sniffImageContentType(bytes);
  if (detected === null) {
    throw safeError('UNSUPPORTED_CONTENT_TYPE');
  }
  if (detected !== declared.data) {
    throw safeError('CONTENT_TYPE_MISMATCH');
  }
  return detected;
}

function sharpFormatFor(contentType: MediaContentType): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heif';
  }
}

/** A prebuilt Sharp without an HEVC-enabled libvips must fail closed. */
export function isHeicDecodeAvailable(): boolean {
  return (
    sharp.format.heif.input.buffer &&
    (sharp.format.heif.input.fileSuffix?.some(
      (suffix) => suffix.toLowerCase() === '.heic',
    ) ??
      false)
  );
}

function dimensionsFromMetadata(
  metadata: Metadata,
  maxPixels: number,
): ImageDimensions {
  const pages = metadata.pages ?? 1;
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_IMAGE_PAGES) {
    throw safeError('PAGE_LIMIT_EXCEEDED');
  }
  const { width, height } = metadata;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw safeError('MALFORMED_IMAGE');
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixels) {
    throw safeError('PIXEL_LIMIT_EXCEEDED');
  }
  return Object.freeze({ width, height });
}

function sharpInput(bytes: Buffer, maxPixels: number): Sharp {
  return sharp(bytes, {
    failOn: 'warning',
    limitInputChannels: 4,
    limitInputPixels: maxPixels,
    sequentialRead: true,
    unlimited: false,
  }).timeout({ seconds: MAX_SHARP_OPERATION_SECONDS });
}

/** Converts native Sharp details into bounded structural or operational errors. */
export function mapSharpFailure(
  error: unknown,
  detectedContentType: MediaContentType,
): ImageValidationError | ImageProcessingUnavailableError {
  if (error instanceof ImageValidationError) {
    return error;
  }
  if (detectedContentType === 'image/heic' && !isHeicDecodeAvailable()) {
    return safeError('HEIC_CODEC_UNAVAILABLE');
  }
  const detail = error instanceof Error ? error.message : '';
  if (/\b(?:timeout|timed\s+out)\b/iu.test(detail)) {
    // Sharp's configured timeout bounds native work but says nothing about
    // the structure of the supplied bytes. Keep the intent retryable.
    return new ImageProcessingUnavailableError();
  }
  if (/pixel limit|exceeds.*pixels/iu.test(detail)) {
    return safeError('PIXEL_LIMIT_EXCEEDED');
  }
  return safeError('MALFORMED_IMAGE');
}

async function inspectSource(
  bytes: Buffer,
  detectedContentType: MediaContentType,
  maxPixels: number,
): Promise<ImageDimensions> {
  if (detectedContentType === 'image/heic' && !isHeicDecodeAvailable()) {
    throw safeError('HEIC_CODEC_UNAVAILABLE');
  }
  try {
    const metadata = await sharpInput(bytes, maxPixels).metadata();
    if (metadata.format !== sharpFormatFor(detectedContentType)) {
      throw safeError('CONTENT_TYPE_MISMATCH');
    }
    return dimensionsFromMetadata(metadata, maxPixels);
  } catch (error) {
    throw mapSharpFailure(error, detectedContentType);
  }
}

function inspectJpegContainer(bytes: Buffer): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
  let offset = 2;
  let inEntropyData = false;
  let sawEndOfImage = false;

  while (offset < bytes.length) {
    let marker: number | undefined;
    if (inEntropyData) {
      while (offset < bytes.length && bytes[offset] !== 0xff) {
        offset += 1;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= bytes.length) {
        break;
      }
      const entropyMarker = bytes[offset];
      offset += 1;
      if (entropyMarker === undefined) {
        break;
      }
      marker = entropyMarker;
      if (
        entropyMarker === 0x00 ||
        (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)
      ) {
        continue;
      }
      inEntropyData = false;
    } else {
      if (bytes[offset] !== 0xff) {
        throw safeError('SANITIZED_IMAGE_INVALID');
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= bytes.length) {
        break;
      }
      marker = bytes[offset];
      offset += 1;
    }

    if (marker === undefined || marker === 0x00 || marker === 0xd8) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    if (marker === 0xd9) {
      sawEndOfImage = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    const segmentByteLength = bytes.readUInt16BE(offset);
    if (segmentByteLength < 2 || offset + segmentByteLength > bytes.length) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    if (JPEG_METADATA_MARKERS.has(marker)) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    offset += segmentByteLength;
    if (marker === 0xda) {
      inEntropyData = true;
    }
  }

  if (!sawEndOfImage || offset !== bytes.length) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
}

function inspectPngContainer(bytes: Buffer): void {
  if (sniffImageContentType(bytes) !== 'image/png') {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
  let offset = 8;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    const payloadByteLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + payloadByteLength;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    if (PNG_METADATA_CHUNKS.has(chunkType)) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    offset = chunkEnd;
    if (chunkType === 'IEND') {
      if (payloadByteLength !== 0) {
        throw safeError('SANITIZED_IMAGE_INVALID');
      }
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || offset !== bytes.length) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
}

function inspectWebpContainer(bytes: Buffer): void {
  if (sniffImageContentType(bytes) !== 'image/webp' || bytes.length < 20) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
  if (bytes.readUInt32LE(4) !== bytes.length - 8) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    const chunkType = bytes.toString('ascii', offset, offset + 4);
    const payloadByteLength = bytes.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + payloadByteLength;
    const paddedEnd = payloadEnd + (payloadByteLength % 2);
    if (
      !Number.isSafeInteger(paddedEnd) ||
      paddedEnd > bytes.length ||
      payloadEnd > bytes.length
    ) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    if (WEBP_METADATA_CHUNKS.has(chunkType)) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    if (
      chunkType === 'VP8X' &&
      payloadByteLength >= 1 &&
      ((bytes[payloadStart] ?? 0) & 0x2c) !== 0
    ) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
}

function inspectOutputContainer(
  bytes: Buffer,
  contentType: SanitizedMediaContentType,
): void {
  switch (contentType) {
    case 'image/jpeg':
      inspectJpegContainer(bytes);
      return;
    case 'image/png':
      inspectPngContainer(bytes);
      return;
    case 'image/webp':
      inspectWebpContainer(bytes);
  }
}

function assertNoDecoderMetadata(metadata: Metadata): void {
  if (
    metadata.exif !== undefined ||
    metadata.icc !== undefined ||
    metadata.iptc !== undefined ||
    metadata.xmp !== undefined ||
    metadata.orientation !== undefined
  ) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
}

async function verifySanitizedOutput(
  bytes: Buffer,
  contentType: SanitizedMediaContentType,
  limits: ResolvedImageLimits,
): Promise<ImageDimensions> {
  if (sniffImageContentType(bytes) !== contentType) {
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
  inspectOutputContainer(bytes, contentType);

  try {
    const decoder = sharpInput(bytes, limits.maxPixels);
    const metadata = await decoder.metadata();
    if (metadata.format !== sharpFormatFor(contentType)) {
      throw safeError('SANITIZED_IMAGE_INVALID');
    }
    assertNoDecoderMetadata(metadata);
    const dimensions = dimensionsFromMetadata(metadata, limits.maxPixels);
    await sharpInput(bytes, limits.maxPixels).stats();
    return dimensions;
  } catch (error) {
    if (error instanceof ImageValidationError) {
      if (
        error.code === 'PAGE_LIMIT_EXCEEDED' ||
        error.code === 'PIXEL_LIMIT_EXCEEDED'
      ) {
        throw error;
      }
    }
    throw safeError('SANITIZED_IMAGE_INVALID');
  }
}

function sanitizedContentTypeFor(
  detectedContentType: MediaContentType,
): SanitizedMediaContentType {
  return detectedContentType === 'image/heic'
    ? 'image/jpeg'
    : detectedContentType;
}

function configureEncoder(
  pipeline: Sharp,
  contentType: SanitizedMediaContentType,
): Sharp {
  switch (contentType) {
    case 'image/jpeg':
      return pipeline.jpeg({
        chromaSubsampling: '4:4:4',
        optimiseCoding: true,
        progressive: false,
        quality: 90,
      });
    case 'image/png':
      return pipeline.png({
        adaptiveFiltering: true,
        compressionLevel: 9,
        palette: false,
      });
    case 'image/webp':
      return pipeline.webp({
        alphaQuality: 100,
        effort: 4,
        quality: 90,
        smartSubsample: true,
      });
  }
}

/**
 * Validates an uploaded still image by exact length, SHA-256, magic bytes,
 * decoder format, page count, and pixel count; then rewrites pixels without
 * carrying metadata and verifies the rewritten image from scratch.
 */
export async function sanitizeUploadedImage(
  input: ImageSanitizationInput,
  configuredLimits?: ImageSanitizationLimits,
): Promise<SanitizedImage> {
  const limits = resolveLimits(configuredLimits);
  // Reject before copying so an oversized object cannot force a second large
  // allocation. The copied buffer then becomes the immutable snapshot hashed,
  // decoded, and rewritten below.
  if (input.bytes.byteLength === 0) {
    throw safeError('EMPTY_IMAGE');
  }
  if (input.bytes.byteLength > limits.maxInputBytes) {
    throw safeError('TOO_LARGE');
  }
  const sourceBytes = Buffer.from(input.bytes);
  const detectedContentType = validateUploadEnvelope(
    input,
    sourceBytes,
    limits,
  );
  // Inspect page and pixel bounds before starting the full decode/rewrite.
  await inspectSource(sourceBytes, detectedContentType, limits.maxPixels);
  const sanitizedContentType = sanitizedContentTypeFor(detectedContentType);

  try {
    let pipeline = sharpInput(sourceBytes, limits.maxPixels)
      .rotate()
      .toColourspace('srgb');
    if (detectedContentType === 'image/heic') {
      pipeline = pipeline.flatten({ background: '#ffffff' });
    }
    const encoded = await configureEncoder(
      pipeline,
      sanitizedContentType,
    ).toBuffer({ resolveWithObject: true });
    if (
      encoded.data.byteLength === 0 ||
      encoded.data.byteLength > limits.maxOutputBytes
    ) {
      throw safeError('SANITIZED_IMAGE_TOO_LARGE');
    }
    // Do not create the defensive immutable copy until the native encoder's
    // output is proven to fit the configured application-memory bound.
    const sanitizedBytes = Buffer.from(encoded.data);
    const outputDimensions = await verifySanitizedOutput(
      sanitizedBytes,
      sanitizedContentType,
      limits,
    );
    const sanitizedContentSha256 = contentSha256(sanitizedBytes);

    return Object.freeze({
      detectedContentType,
      sanitizedContentType,
      get sanitizedBytes(): Buffer {
        return Buffer.from(sanitizedBytes);
      },
      sanitizedByteLength: sanitizedBytes.length,
      sanitizedContentSha256,
      width: outputDimensions.width,
      height: outputDimensions.height,
      exifStripped: true as const,
      structuralContentDisarm: Object.freeze({
        kind: 'structural-content-disarm' as const,
        result: 'passed' as const,
        checks: Object.freeze({
          sourceFullyDecoded: true as const,
          sourceSinglePage: true as const,
          sourcePixelCountBounded: true as const,
          orientationNormalized: true as const,
          pixelsReencoded: true as const,
          outputMagicBytesMatched: true as const,
          outputContainerMetadataAbsent: true as const,
          outputDecoderMetadataAbsent: true as const,
          outputSinglePage: true as const,
          outputPixelCountBounded: true as const,
          outputFullyDecoded: true as const,
        }),
      }),
    });
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw error;
    }
    throw mapSharpFailure(error, detectedContentType);
  }
}
