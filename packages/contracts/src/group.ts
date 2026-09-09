import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import { RoleSchema, TimestampSchema, UuidSchema } from './shared';

/**
 * Owns the stable identifier for a configured group source. Source purpose,
 * kind, and facility binding are immutable properties carried by every ref.
 */
export const GroupSourceIdSchema = UuidSchema;

/** Stable configured group-source identifier inferred from its schema. */
export type GroupSourceId = z.infer<typeof GroupSourceIdSchema>;

/**
 * Owns the source-system discriminator for configured groups.
 *
 * Google data is untrusted external input. Synthetic data is locally
 * controlled test data. Manual data is the staff list an administrator curates
 * inside this application, for a deployment that notifies named people rather
 * than everyone who happens to be in a directory group.
 */
export const GroupSourceKindSchema = z.enum([
  'google-group',
  'manual',
  'synthetic',
]);

/** Configured group source-system kind inferred from its schema. */
export type GroupSourceKind = z.infer<typeof GroupSourceKindSchema>;

/**
 * Owns the immutable purpose of a configured group. Access groups authorize
 * sign-in, building groups resolve facility staff, and others extend audiences.
 */
export const GroupPurposeSchema = z.enum(['access', 'building', 'others']);

/** Configured group purpose inferred from its schema. */
export type GroupPurpose = z.infer<typeof GroupPurposeSchema>;

/** Closed vocabulary for expected and completed roster group sets. */
export const GROUP_COMPLETION_KINDS = ['expected', 'completed'] as const;
export const GroupCompletionKindSchema = z.enum(GROUP_COMPLETION_KINDS);

/** Roster group-set completion kind inferred from its canonical schema. */
export type GroupCompletionKind = z.infer<typeof GroupCompletionKindSchema>;

/**
 * Owns a reference to a designated Google access group. Access references can
 * never be synthetic or facility-bound and are excluded from roster schemas.
 */
export const AccessGroupSourceRefSchema = z
  .object({
    id: GroupSourceIdSchema,
    kind: z.literal('google-group'),
    purpose: z.literal('access'),
    facilityId: z.null(),
  })
  .strict()
  .readonly();

/** Designated Google access-group reference inferred from its schema. */
export type AccessGroupSourceRef = z.infer<typeof AccessGroupSourceRefSchema>;

/**
 * Owns a reference to a facility-bound roster group. The source kind is pinned
 * so a staff Google source cannot be substituted with a synthetic fixture.
 */
export const BuildingGroupSourceRefSchema = z
  .object({
    id: GroupSourceIdSchema,
    kind: GroupSourceKindSchema,
    purpose: z.literal('building'),
    facilityId: UuidSchema,
  })
  .strict()
  .readonly();

/** Facility-bound building-group reference inferred from its schema. */
export type BuildingGroupSourceRef = z.infer<
  typeof BuildingGroupSourceRefSchema
>;

/**
 * Owns a reference to an audience-extension group. Others references pin their
 * kind and purpose and cannot smuggle a facility-specific interpretation.
 */
export const OthersGroupSourceRefSchema = z
  .object({
    id: GroupSourceIdSchema,
    kind: GroupSourceKindSchema,
    purpose: z.literal('others'),
    facilityId: z.null(),
  })
  .strict()
  .readonly();

/** Audience-extension group reference inferred from its schema. */
export type OthersGroupSourceRef = z.infer<typeof OthersGroupSourceRefSchema>;

/**
 * Owns any non-access group reference permitted in roster provenance. Access
 * groups remain structurally impossible in roster snapshots and sync results.
 */
export const RosterGroupSourceRefSchema = z
  .union([BuildingGroupSourceRefSchema, OthersGroupSourceRefSchema])
  .readonly();

/** Non-access roster group reference inferred from its schema. */
export type RosterGroupSourceRef = z.infer<typeof RosterGroupSourceRefSchema>;

/**
 * Owns the complete purpose-bound reference union used when a caller may refer
 * to access, building, or audience-extension configuration.
 */
export const GroupSourceRefSchema = z
  .union([
    AccessGroupSourceRefSchema,
    BuildingGroupSourceRefSchema,
    OthersGroupSourceRefSchema,
  ])
  .readonly();

/** Complete configured group-source reference inferred from its schema. */
export type GroupSourceRef = z.infer<typeof GroupSourceRefSchema>;

const groupSourceMetadataShape = {
  displayName: z.string().trim().min(1).max(160),
  active: z.boolean(),
  membersCapturedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
};

/**
 * The role every member of an access group receives.
 *
 * Access groups answer two questions at once: who may sign in, and what they
 * may do once they have. Carrying the role on the group is what lets a
 * deployment name its own administrators — point an access group at the Google
 * group whose members run the system and they are administrators — instead of
 * compiling one district's group address in and seeding roles from a fixture.
 *
 * Only access sources carry one. Building and roster sources describe who is
 * notified, not who may sign in, so their role is always null and the database
 * holds them to that with a check constraint.
 */
const accessRoleShape = { grantedRole: RoleSchema };
const noGrantedRoleShape = { grantedRole: z.null() };

const googleGroupDetailsShape = {
  googleGroupId: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(320),
};
/**
 * A building source may be registered before Google holds its group. It is
 * then "waiting": the address is known, the Google Group ID is not, it names
 * nobody, and the scheduled sync keeps asking Google for the address until
 * the group exists, at which point the ID is recorded and the group syncs
 * like any other. Access and others sources must resolve when registered.
 */
const waitingGoogleGroupDetailsShape = {
  googleGroupId: z.string().trim().min(1).max(255).nullable(),
  email: z.string().trim().email().max(320),
};

const syntheticGroupDetailsShape = {
  fixtureKey: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
};

/**
 * A manual source has no external identity to carry. Its members are curated
 * in this application, so the display name and, for a building source, the
 * facility binding are the whole record; pinning the provider fields to null
 * keeps a Google or synthetic source from being reinterpreted as a manual one.
 *
 * A manual others source is the district-level list: the people who belong at
 * every event at every facility, curated here without a Google Group.
 */
const manualGroupDetailsShape = {
  googleGroupId: z.null(),
  email: z.null(),
  fixtureKey: z.null(),
};

/**
 * Owns one administrator-configured Google Group or fail-closed synthetic
 * fixture source. Its union makes every valid kind, purpose, and facility
 * combination explicit; synthetic access groups do not exist.
 */
export const GroupSourceSchema = z
  .union([
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('google-group'),
        purpose: z.literal('access'),
        facilityId: z.null(),
        ...groupSourceMetadataShape,
        ...accessRoleShape,
        ...googleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('google-group'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceMetadataShape,
        ...noGrantedRoleShape,
        ...waitingGoogleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('google-group'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceMetadataShape,
        ...noGrantedRoleShape,
        ...googleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('manual'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceMetadataShape,
        ...noGrantedRoleShape,
        ...manualGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('manual'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceMetadataShape,
        ...noGrantedRoleShape,
        ...manualGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('synthetic'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceMetadataShape,
        ...noGrantedRoleShape,
        ...syntheticGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('synthetic'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceMetadataShape,
        ...noGrantedRoleShape,
        ...syntheticGroupDetailsShape,
      })
      .strict(),
  ])
  .readonly();

/** Fully configured purpose-bound group source inferred from its schema. */
export type GroupSource = z.infer<typeof GroupSourceSchema>;

/** Owns bounded group-source administration filters. */
export const ListGroupSourcesInputSchema = z
  .object({
    kind: GroupSourceKindSchema.nullable(),
    purpose: GroupPurposeSchema.nullable(),
    facilityId: UuidSchema.nullable(),
    active: z.boolean().nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(500),
  })
  .strict()
  .readonly();

/** Group-source list input inferred from its schema. */
export type ListGroupSourcesInput = z.infer<typeof ListGroupSourcesInputSchema>;

/** Owns a bounded page of purpose-bound group-source configuration. */
export const GroupSourcePageSchema = paginatedSchema(GroupSourceSchema);

/** Configured group-source page inferred from its schema. */
export type GroupSourcePage = z.infer<typeof GroupSourcePageSchema>;

const groupSourceWriteMetadataShape = {
  displayName: z.string().trim().min(1).max(160),
  active: z.boolean(),
};

/**
 * Owns administrator input for a Google or fail-closed synthetic group
 * source. Access sources can only be Google; building and others bindings are
 * structurally explicit, with no student-data or arbitrary source variant.
 */
export const CreateGroupSourceInputSchema = z
  .union([
    z
      .object({
        kind: z.literal('google-group'),
        purpose: z.literal('access'),
        facilityId: z.null(),
        ...groupSourceWriteMetadataShape,
        ...accessRoleShape,
        ...googleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal('google-group'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceWriteMetadataShape,
        ...waitingGoogleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal('google-group'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceWriteMetadataShape,
        ...googleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal('manual'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceWriteMetadataShape,
        ...manualGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal('manual'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceWriteMetadataShape,
        ...manualGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal('synthetic'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceWriteMetadataShape,
        ...syntheticGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal('synthetic'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceWriteMetadataShape,
        ...syntheticGroupDetailsShape,
      })
      .strict(),
  ])
  .readonly();

/** Group-source creation input inferred from its schema. */
export type CreateGroupSourceInput = z.infer<
  typeof CreateGroupSourceInputSchema
>;

/**
 * Owns a group-source replacement request with the immutable kind, purpose,
 * and facility binding repeated for server-side continuity validation.
 */
export const UpdateGroupSourceInputSchema = z
  .union([
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('google-group'),
        purpose: z.literal('access'),
        facilityId: z.null(),
        ...groupSourceWriteMetadataShape,
        ...accessRoleShape,
        ...googleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('google-group'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceWriteMetadataShape,
        ...waitingGoogleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('google-group'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceWriteMetadataShape,
        ...googleGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('synthetic'),
        purpose: z.literal('building'),
        facilityId: UuidSchema,
        ...groupSourceWriteMetadataShape,
        ...syntheticGroupDetailsShape,
      })
      .strict(),
    z
      .object({
        id: GroupSourceIdSchema,
        kind: z.literal('synthetic'),
        purpose: z.literal('others'),
        facilityId: z.null(),
        ...groupSourceWriteMetadataShape,
        ...syntheticGroupDetailsShape,
      })
      .strict(),
  ])
  .readonly();

/** Group-source replacement input inferred from its schema. */
export type UpdateGroupSourceInput = z.infer<
  typeof UpdateGroupSourceInputSchema
>;

/**
 * Owns the complete membership of one manual roster source.
 *
 * The whole list is stated rather than added to one address at a time, so an
 * administrator can see exactly who a site will reach before saving and a
 * removal cannot be forgotten. Addresses are canonicalised to lowercase and
 * deduplicated, because the same person written two ways is one recipient.
 *
 * An empty list is allowed and means the source reaches nobody. That is a
 * legitimate state for a site being prepared, and the roster sync refuses to
 * publish a snapshot from it rather than silently reaching no one.
 */
export const SetManualRosterMembersInputSchema = z
  .object({
    groupSourceId: GroupSourceIdSchema,
    emails: z
      .array(
        z
          .string()
          .max(320)
          .email()
          // Canonical form is asserted rather than applied. This schema is
          // published as JSON Schema for the agent surface, which cannot
          // represent a transform, so the caller canonicalises and the
          // contract refuses anything that is not already canonical.
          .refine(
            (value) => value === value.trim().toLowerCase(),
            'Staff addresses must be lowercase and trimmed.',
          ),
      )
      .max(1_000)
      .refine(
        (values) => new Set(values).size === values.length,
        'Staff addresses must be unique.',
      )
      .readonly(),
  })
  .strict()
  .readonly();

/** Canonicalises caller-supplied addresses into the form the contract accepts. */
export function canonicalManualRosterEmails(
  values: readonly string[],
): readonly string[] {
  return Object.freeze(
    [...new Set(values.map((value) => value.trim().toLowerCase()))]
      .filter((value) => value.length > 0)
      .sort(),
  );
}

/** Manual roster membership input inferred from its schema. */
export type SetManualRosterMembersInput = z.infer<
  typeof SetManualRosterMembersInputSchema
>;

/**
 * Owns the retained membership of one manual roster source. Addresses are
 * staff contact data, so the result carries a count and the capture time
 * rather than the list itself.
 */
export const ManualRosterMembershipSchema = z
  .object({
    groupSourceId: GroupSourceIdSchema,
    memberCount: z.number().int().nonnegative(),
    capturedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Manual roster membership result inferred from its schema. */
export type ManualRosterMembership = z.infer<
  typeof ManualRosterMembershipSchema
>;
