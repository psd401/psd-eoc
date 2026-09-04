import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import { TimestampSchema, UuidSchema } from './shared';

/**
 * Owns the stable identity of one district-declared threat. A threat is what
 * an operator names first when starting an event, before choosing the
 * response; the district declares its own list as configuration.
 */
export const ThreatIdSchema = UuidSchema;

/** Stable threat identity inferred from its schema. */
export type ThreatId = z.infer<typeof ThreatIdSchema>;

/**
 * Owns the district's own identifier for a threat. Ids are generated, so the
 * key is what configuration matches on and what survives a rebuild.
 */
export const ThreatKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** District threat key inferred from its schema. */
export type ThreatKey = z.infer<typeof ThreatKeySchema>;

/**
 * Owns one selectable threat. `requiresDetail` marks an entry such as
 * "Other" that cannot be chosen without the operator typing what the threat
 * is. Deactivation preserves the record so historical events stay readable.
 */
export const ThreatSchema = z
  .object({
    id: ThreatIdSchema,
    key: ThreatKeySchema,
    name: z.string().trim().min(1).max(160),
    sortOrder: z.number().int().nonnegative(),
    requiresDetail: z.boolean(),
    active: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** District-declared threat inferred from its schema. */
export type Threat = z.infer<typeof ThreatSchema>;

/** Owns the bounded, cursor-paged threat list query. */
export const ListThreatsInputSchema = z
  .object({
    includeInactive: z.boolean(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Threat-list input inferred from its schema. */
export type ListThreatsInput = z.infer<typeof ListThreatsInputSchema>;

/** Owns a bounded page of threats in the district's declared order. */
export const ThreatPageSchema = paginatedSchema(ThreatSchema);

/** Bounded threat page inferred from its schema. */
export type ThreatPage = z.infer<typeof ThreatPageSchema>;
