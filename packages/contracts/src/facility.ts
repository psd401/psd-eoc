import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import {
  hasUniqueStrings,
  TimestampSchema,
  UuidSchema,
  VersionSchema,
} from './shared';

/**
 * Owns the stable identifier for a district facility. Facilities are created
 * by administrators and referenced, never re-keyed, throughout their
 * lifecycle.
 */
export const FacilityIdSchema = UuidSchema;

/** Stable facility identifier inferred from {@link FacilityIdSchema}. */
export type FacilityId = z.infer<typeof FacilityIdSchema>;

/**
 * Owns the stable identifier for an administrator-defined neighborhood.
 * Neighborhood membership changes by creating a new versioned definition.
 */
export const NeighborhoodIdSchema = UuidSchema;

/** Stable neighborhood identifier inferred from {@link NeighborhoodIdSchema}. */
export type NeighborhoodId = z.infer<typeof NeighborhoodIdSchema>;

/**
 * Owns the exact immutable neighborhood version pinned by an audience policy.
 * The stable ID alone is insufficient because facility membership changes
 * across administrator-created versions.
 */
export const NeighborhoodVersionRefSchema = z
  .object({
    id: NeighborhoodIdSchema,
    version: VersionSchema,
  })
  .strict()
  .readonly();

/** Exact neighborhood version reference inferred from its schema. */
export type NeighborhoodVersionRef = z.infer<
  typeof NeighborhoodVersionRefSchema
>;

/**
 * Owns the administrator-managed facility record. Deactivation preserves the
 * record so historical events and roster snapshots remain reconstructable.
 */
export const FacilitySchema = z
  .object({
    id: FacilityIdSchema,
    code: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9-]+$/u),
    name: z.string().trim().min(1).max(160),
    active: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Administrator-managed facility record inferred from its schema. */
export type Facility = z.infer<typeof FacilitySchema>;

/**
 * Owns one immutable version of an administrator-defined neighborhood.
 * Membership is non-empty and duplicate-free; edits create a later version.
 */
export const NeighborhoodSchema = z
  .object({
    id: NeighborhoodIdSchema,
    name: z.string().trim().min(1).max(160),
    facilityIds: z.array(FacilityIdSchema).min(1).readonly(),
    version: VersionSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((neighborhood, context) => {
    if (!hasUniqueStrings(neighborhood.facilityIds)) {
      context.addIssue({
        code: 'custom',
        message: 'Neighborhood facility IDs must be unique.',
        path: ['facilityIds'],
      });
    }
  })
  .readonly();

/** Immutable neighborhood version inferred from its schema. */
export type Neighborhood = z.infer<typeof NeighborhoodSchema>;

/**
 * Owns the complete server-resolved facility boundary for an actor. District
 * scope and a non-empty explicit facility set are distinct, eliminating
 * ambiguous empty-array or client-only authorization semantics.
 */
export const FacilityScopeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('district') }).strict(),
    z
      .object({
        kind: z.literal('facilities'),
        facilityIds: z.array(FacilityIdSchema).min(1).readonly(),
      })
      .strict()
      .superRefine((scope, context) => {
        if (!hasUniqueStrings(scope.facilityIds)) {
          context.addIssue({
            code: 'custom',
            message: 'Facility scope IDs must be unique.',
            path: ['facilityIds'],
          });
        }
      }),
  ])
  .readonly();

/** Server-resolved facility authorization boundary. */
export type FacilityScope = z.infer<typeof FacilityScopeSchema>;

/** Owns bounded facility-list filters for operational and admin surfaces. */
export const ListFacilitiesInputSchema = z
  .object({
    includeInactive: z.boolean(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Facility-list input inferred from its schema. */
export type ListFacilitiesInput = z.infer<typeof ListFacilitiesInputSchema>;

/** Owns a bounded page of district facilities. */
export const FacilityPageSchema = paginatedSchema(FacilitySchema);

/** District-facility page inferred from its schema. */
export type FacilityPage = z.infer<typeof FacilityPageSchema>;

/** Owns an authorized read of one district facility. */
export const GetFacilityInputSchema = z
  .object({
    facilityId: FacilityIdSchema,
  })
  .strict()
  .readonly();

/** Facility read input inferred from its schema. */
export type GetFacilityInput = z.infer<typeof GetFacilityInputSchema>;

/**
 * Owns a facility-creation request without caller-owned identity or time.
 * The server allocates the immutable ID and creation timestamp.
 */
export const CreateFacilityInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9-]+$/u),
    name: z.string().trim().min(1).max(160),
  })
  .strict()
  .readonly();

/** Facility-creation input inferred from its schema. */
export type CreateFacilityInput = z.infer<typeof CreateFacilityInputSchema>;

/** Owns an administrative facility metadata and active-state replacement. */
export const UpdateFacilityInputSchema = z
  .object({
    facilityId: FacilityIdSchema,
    code: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9-]+$/u),
    name: z.string().trim().min(1).max(160),
    active: z.boolean(),
  })
  .strict()
  .readonly();

/** Facility replacement input inferred from its schema. */
export type UpdateFacilityInput = z.infer<typeof UpdateFacilityInputSchema>;

/** Owns bounded latest-neighborhood list filters. */
export const ListNeighborhoodsInputSchema = z
  .object({
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Latest-neighborhood list input inferred from its schema. */
export type ListNeighborhoodsInput = z.infer<
  typeof ListNeighborhoodsInputSchema
>;

/** Owns bounded version-history filters for one neighborhood identity. */
export const ListNeighborhoodVersionsInputSchema = z
  .object({
    neighborhoodId: NeighborhoodIdSchema,
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Neighborhood version-list input inferred from its schema. */
export type ListNeighborhoodVersionsInput = z.infer<
  typeof ListNeighborhoodVersionsInputSchema
>;

/** Owns a bounded page of immutable neighborhood versions. */
export const NeighborhoodPageSchema = paginatedSchema(NeighborhoodSchema);

/** Immutable neighborhood-version page inferred from its schema. */
export type NeighborhoodPage = z.infer<typeof NeighborhoodPageSchema>;

/** Owns a read of one exact immutable neighborhood version. */
export const GetNeighborhoodVersionInputSchema = z
  .object({
    neighborhood: NeighborhoodVersionRefSchema,
  })
  .strict()
  .readonly();

/** Exact neighborhood-version read input inferred from its schema. */
export type GetNeighborhoodVersionInput = z.infer<
  typeof GetNeighborhoodVersionInputSchema
>;

/**
 * Owns a request to create the first or a superseding neighborhood version.
 * Null identity creates a new neighborhood; existing identities append a
 * version and never rewrite prior membership.
 */
export const CreateNeighborhoodVersionInputSchema = z
  .object({
    neighborhoodId: NeighborhoodIdSchema.nullable(),
    name: z.string().trim().min(1).max(160),
    facilityIds: z
      .array(FacilityIdSchema)
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Neighborhood facility IDs must be unique.',
      })
      .readonly(),
  })
  .strict()
  .readonly();

/** Neighborhood-version creation input inferred from its schema. */
export type CreateNeighborhoodVersionInput = z.infer<
  typeof CreateNeighborhoodVersionInputSchema
>;
