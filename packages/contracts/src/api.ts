import { z } from 'zod';

import { UuidSchema } from './shared';

/**
 * Owns stable, client-safe REST error codes. Provider payloads, stack traces,
 * credentials, and recipient data never appear in the public error model.
 */
export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'LIVE_ACTION_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

/** Stable API error code inferred from its schema. */
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * Owns one safe field-level validation issue. Paths identify contract fields
 * without echoing untrusted values.
 */
export const ApiFieldErrorSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    message: z.string().trim().min(1).max(500),
  })
  .strict()
  .readonly();

/** Safe field-level validation issue inferred from its schema. */
export type ApiFieldError = z.infer<typeof ApiFieldErrorSchema>;

/**
 * Owns the complete client-safe REST error response. The request ID supports
 * audit correlation while messages remain bounded and non-sensitive.
 */
export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    requestId: UuidSchema,
    retryable: z.boolean(),
    fieldErrors: z.array(ApiFieldErrorSchema).max(100).readonly(),
  })
  .strict()
  .readonly();

/** Client-safe API error response inferred from its schema. */
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Owns an opaque, bounded, base64url pagination cursor. Callers may retain and
 * return it but cannot depend on its internal representation.
 */
export const PaginationCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);

/** Opaque pagination cursor inferred from its schema. */
export type PaginationCursor = z.infer<typeof PaginationCursorSchema>;

/**
 * Owns pagination continuation truth. A page with more data must expose a
 * cursor, while a terminal page must not imply another result.
 */
export const PageInfoSchema = z
  .object({
    nextCursor: PaginationCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((pageInfo, context) => {
    if (pageInfo.hasMore !== (pageInfo.nextCursor !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'hasMore and nextCursor must describe the same continuation.',
        path: ['nextCursor'],
      });
    }
  })
  .readonly();

/** Pagination continuation metadata inferred from its schema. */
export type PageInfo = z.infer<typeof PageInfoSchema>;

/**
 * Builds a strict, immutable page schema for a supplied domain item schema.
 * The factory keeps REST and agent reporting pagination structurally aligned.
 */
export function paginatedSchema<ItemSchema extends z.ZodType>(
  itemSchema: ItemSchema,
) {
  return z
    .object({
      items: z.array(itemSchema).readonly(),
      pageInfo: PageInfoSchema,
    })
    .strict()
    .readonly();
}
