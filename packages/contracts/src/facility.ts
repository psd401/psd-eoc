import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import { OthersGroupSourceRefSchema } from './group';
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
 * Owns the stable identifier for one versioned facility audience
 * configuration. Events pin the configuration they resolve.
 */
export const AudienceConfigIdSchema = UuidSchema;

/** Audience configuration identifier inferred from its schema. */
export type AudienceConfigId = z.infer<typeof AudienceConfigIdSchema>;

/**
 * Owns the exact immutable audience configuration pinned by a notification
 * intent. Both ID and version are carried for reconstructable history.
 */
export const AudienceConfigRefSchema = z
  .object({
    id: AudienceConfigIdSchema,
    version: VersionSchema,
  })
  .strict()
  .readonly();

/** Exact audience configuration reference inferred from its schema. */
export type AudienceConfigRef = z.infer<typeof AudienceConfigRefSchema>;

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

/**
 * Owns the persisted audience-component discriminator used by versioned
 * audience policies and their normalized database rows.
 */
export const AudienceTargetKindSchema = z.enum([
  'building',
  'neighborhood',
  'others',
]);

/** Persisted audience-component kind inferred from its schema. */
export type AudienceTargetKind = z.infer<typeof AudienceTargetKindSchema>;

/**
 * Owns one audience component selected for an activation: the event's own
 * building, an administrator-defined neighborhood, or a configured others
 * group. Components are explicit rather than loose boolean switches.
 */
export const AudienceTargetSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('building'),
        facilityId: FacilityIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('neighborhood'),
        neighborhood: NeighborhoodVersionRefSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('others'),
        groupSourceRef: OthersGroupSourceRefSchema,
      })
      .strict(),
  ])
  .readonly();

/** Explicit audience component inferred from its schema. */
export type AudienceTarget = z.infer<typeof AudienceTargetSchema>;

/**
 * Owns one immutable version of a facility's audience policy. Building
 * targets must name the owning facility; policy edits create a new version
 * that later events may pin without changing historical sends.
 */
export const AudienceConfigSchema = z
  .object({
    id: AudienceConfigIdSchema,
    facilityId: FacilityIdSchema,
    version: VersionSchema,
    targets: z.array(AudienceTargetSchema).min(1).readonly(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((config, context) => {
    const keys = config.targets.map((target) => {
      switch (target.kind) {
        case 'building':
          return `building:${target.facilityId}`;
        case 'neighborhood':
          return `neighborhood:${target.neighborhood.id}`;
        case 'others':
          return `others:${target.groupSourceRef.id}`;
      }
    });

    if (!hasUniqueStrings(keys)) {
      context.addIssue({
        code: 'custom',
        message: 'Audience targets must be unique.',
        path: ['targets'],
      });
    }

    config.targets.forEach((target, index) => {
      if (
        target.kind === 'building' &&
        target.facilityId !== config.facilityId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A building target must match the owning facility.',
          path: ['targets', index, 'facilityId'],
        });
      }
    });
  })
  .readonly();

/** Immutable facility audience policy inferred from its schema. */
export type AudienceConfig = z.infer<typeof AudienceConfigSchema>;

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

/** Owns a read of the latest audience configuration for one facility. */
export const GetAudienceConfigInputSchema = z
  .object({
    facilityId: FacilityIdSchema,
  })
  .strict()
  .readonly();

/** Latest audience-configuration read input inferred from its schema. */
export type GetAudienceConfigInput = z.infer<
  typeof GetAudienceConfigInputSchema
>;

/** Owns a read of one exact immutable audience-configuration version. */
export const GetAudienceConfigVersionInputSchema = z
  .object({
    audienceConfig: AudienceConfigRefSchema,
  })
  .strict()
  .readonly();

/** Exact audience-configuration read input inferred from its schema. */
export type GetAudienceConfigVersionInput = z.infer<
  typeof GetAudienceConfigVersionInputSchema
>;

/**
 * Owns an append-only audience policy version request. Null identity creates
 * the first configuration; later writes retain the stable ID and append a
 * new version rather than altering an activated event's pinned policy.
 */
export const CreateAudienceConfigVersionInputSchema = z
  .object({
    audienceConfigId: AudienceConfigIdSchema.nullable(),
    facilityId: FacilityIdSchema,
    targets: z.array(AudienceTargetSchema).min(1).max(500).readonly(),
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = AudienceConfigSchema.safeParse({
      id: input.audienceConfigId ?? '00000000-0000-4000-8000-000000000000',
      facilityId: input.facilityId,
      version: 1,
      targets: input.targets,
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        if (issue.path[0] === 'targets') {
          context.addIssue({
            code: 'custom',
            message: issue.message,
            path: issue.path,
          });
        }
      });
    }
  })
  .readonly();

/** Audience-policy version creation input inferred from its schema. */
export type CreateAudienceConfigVersionInput = z.infer<
  typeof CreateAudienceConfigVersionInputSchema
>;
