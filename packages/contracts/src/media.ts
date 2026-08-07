import { z } from 'zod';

import { EventIdSchema } from './event';
import {
  HttpsUrlSchema,
  isAtOrAfter,
  TimestampSchema,
  UuidSchema,
} from './shared';

/**
 * Owns the content-sniffed image types accepted for release-one journal
 * photos. File extensions never establish type, and every accepted image is
 * decoded and rewritten before publication so EXIF cannot survive.
 */
export const MediaContentTypeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

/** Content-sniffed journal-photo type inferred from its schema. */
export type MediaContentType = z.infer<typeof MediaContentTypeSchema>;

/** Stable identifier for one private journal media record. */
export const MediaIdSchema = UuidSchema;

/** Private journal media identifier inferred from its schema. */
export type MediaId = z.infer<typeof MediaIdSchema>;

/** Stable identifier for one short-lived private upload intent. */
export const MediaUploadIntentIdSchema = UuidSchema;

/** Private upload-intent identifier inferred from its schema. */
export type MediaUploadIntentId = z.infer<typeof MediaUploadIntentIdSchema>;

/**
 * Owns untrusted journal-photo upload metadata. The declared content type is
 * only a hint; completion must sniff, decode, scan, and rewrite bytes. No
 * filename, path, actor, server time, or arbitrary metadata is accepted.
 */
export const CreateMediaUploadIntentInputSchema = z
  .object({
    eventId: EventIdSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(25 * 1_024 * 1_024),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    declaredContentType: MediaContentTypeSchema,
  })
  .strict()
  .readonly();

/** Journal-photo upload-intent input inferred from its schema. */
export type CreateMediaUploadIntentInput = z.infer<
  typeof CreateMediaUploadIntentInputSchema
>;

/**
 * Owns a short-lived private upload grant. It authorizes only the exact event,
 * digest, and byte bound retained by the intent and does not make media
 * readable or journal-visible.
 */
export const MediaUploadIntentSchema = z
  .object({
    id: MediaUploadIntentIdSchema,
    eventId: EventIdSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(25 * 1_024 * 1_024),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    declaredContentType: MediaContentTypeSchema,
    uploadMethod: z.literal('PUT'),
    uploadUrl: HttpsUrlSchema,
    status: z.literal('pending-upload'),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      !isAtOrAfter(intent.expiresAt, intent.createdAt) ||
      Date.parse(intent.expiresAt) - Date.parse(intent.createdAt) >
        15 * 60 * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Media upload grants must expire within fifteen minutes.',
        path: ['expiresAt'],
      });
    }
  })
  .readonly();

/** Short-lived private upload grant inferred from its schema. */
export type MediaUploadIntent = z.infer<typeof MediaUploadIntentSchema>;

/**
 * Owns a request to validate and finalize one uploaded object. The server
 * reads the exact object retained by the upload intent; callers cannot select
 * another storage key, claim a content type, or claim sanitization succeeded.
 */
export const CompleteMediaUploadInputSchema = z
  .object({
    uploadIntentId: MediaUploadIntentIdSchema,
  })
  .strict()
  .readonly();

/** Media-upload completion input inferred from its schema. */
export type CompleteMediaUploadInput = z.infer<
  typeof CompleteMediaUploadInputSchema
>;

/**
 * Owns one validated private journal image. Ready media has content-sniffed
 * type, a digest of sanitized bytes, successful malware scanning, and
 * mandatory EXIF removal. Rejected uploads never parse as ready records.
 */
export const MediaRecordSchema = z
  .object({
    id: MediaIdSchema,
    uploadIntentId: MediaUploadIntentIdSchema,
    eventId: EventIdSchema,
    status: z.literal('ready'),
    detectedContentType: MediaContentTypeSchema,
    sanitizedByteLength: z
      .number()
      .int()
      .positive()
      .max(25 * 1_024 * 1_024),
    sanitizedContentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    malwareScan: z.literal('clean'),
    exifStripped: z.literal(true),
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Validated private journal image inferred from its schema. */
export type MediaRecord = z.infer<typeof MediaRecordSchema>;

/** Owns an authorized read request for one private journal image. */
export const GetMediaReadGrantInputSchema = z
  .object({
    eventId: EventIdSchema,
    mediaId: MediaIdSchema,
  })
  .strict()
  .readonly();

/** Private media-read grant input inferred from its schema. */
export type GetMediaReadGrantInput = z.infer<
  typeof GetMediaReadGrantInputSchema
>;

/** Owns a short-lived server-authorized read grant for private media. */
export const MediaReadGrantSchema = z
  .object({
    eventId: EventIdSchema,
    mediaId: MediaIdSchema,
    readUrl: HttpsUrlSchema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((grant, context) => {
    if (
      !isAtOrAfter(grant.expiresAt, grant.issuedAt) ||
      Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) > 5 * 60 * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Private media read grants must expire within five minutes.',
        path: ['expiresAt'],
      });
    }
  })
  .readonly();

/** Short-lived private media-read grant inferred from its schema. */
export type MediaReadGrant = z.infer<typeof MediaReadGrantSchema>;
