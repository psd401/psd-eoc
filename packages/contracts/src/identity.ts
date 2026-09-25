import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import { ActorSchema, ConnectivityEpochIdSchema } from './capability';
import { FacilityScopeSchema } from './facility';
import { AccessGroupSourceRefSchema, type AccessGroupSourceRef } from './group';
import {
  PushProviderSchema,
  PushServiceEnvironmentSchema,
  pushProviderMatchesPlatform,
} from './roster';
import {
  hasUniqueStrings,
  isAtOrAfter,
  RoleSchema,
  TimestampSchema,
  UuidSchema,
  VersionSchema,
  type Role,
} from './shared';

const ORGANIZATION_NAME_FORBIDDEN_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Canonical, display-safe identity of the organization operating a deployment. */
export const OrganizationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((name) => new TextEncoder().encode(name).byteLength <= 320, {
    message: 'Organization name exceeds its safe UTF-8 byte length.',
  })
  .refine((name) => !ORGANIZATION_NAME_FORBIDDEN_CHARACTERS.test(name), {
    message: 'Organization name contains a non-display character.',
  });

/** Human-readable organization identity inferred from its canonical schema. */
export type OrganizationName = z.infer<typeof OrganizationNameSchema>;

const accessGroupSourceRefKey = (source: AccessGroupSourceRef): string =>
  `${source.id}:${source.kind}:${source.purpose}:${source.facilityId ?? ''}`;

/**
 * Owns the complete release-one authorization role set. Roles are assigned by
 * trusted administrative flows and always combine with server-side facility
 * scope checks.
 */
// Defined in `shared` so `group` can use it without an import cycle; every
// existing importer of `identity` keeps working through this re-export.
export { RoleSchema, type Role };

/**
 * Owns the stable internal identifier for a staff user. The related immutable
 * Google subject remains the external identity key.
 */
export const UserIdSchema = UuidSchema;

/** Stable user identifier inferred from {@link UserIdSchema}. */
export type UserId = z.infer<typeof UserIdSchema>;

/**
 * Owns a minimized staff identity record. The Google subject is immutable;
 * disabling a user preserves history rather than deleting or re-keying it.
 * No student identity shape exists in this package.
 */
/**
 * Owns an administrator's decision about where one person may act: the
 * whole district, or a named set of facilities. The scope is enforced by
 * every session and capability; this input only records the decision.
 */
export const SetUserFacilityScopeInputSchema = z
  .object({
    userId: UuidSchema,
    facilityScope: FacilityScopeSchema,
  })
  .strict()
  .readonly();

/** Facility-scope decision inferred from its schema. */
export type SetUserFacilityScopeInput = z.infer<
  typeof SetUserFacilityScopeInputSchema
>;

export const UserSchema = z
  .object({
    id: UserIdSchema,
    googleSubject: z.string().trim().min(1).max(255),
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .refine((email) => email === email.toLowerCase(), {
        message: 'User email must be normalized to lowercase.',
      }),
    displayName: z.string().trim().min(1).max(160),
    // Empty is meaningful: roles are what the holder's trusted groups grant, so
    // somebody who is in none of them holds none. Such a record never
    // authorizes a request — it exists so an administrator can still see and
    // revoke the sessions of somebody who has been removed from every group.
    roles: z
      .array(RoleSchema)
      .max(2)
      .refine((roles) => new Set(roles).size === roles.length, {
        message: 'User roles must be unique.',
      })
      .readonly(),
    facilityScope: FacilityScopeSchema,
    createdAt: TimestampSchema,
    disabledAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((user, context) => {
    if (user.disabledAt && !isAtOrAfter(user.disabledAt, user.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'A user cannot be disabled before creation.',
        path: ['disabledAt'],
      });
    }
  })
  .readonly();

/** Minimized, immutable-key staff identity inferred from its schema. */
export type User = z.infer<typeof UserSchema>;

/**
 * Owns the supported device platforms used for sessions and push enrollment.
 * Native platforms require biometric return unlock; web uses a secure cookie.
 */
export const DevicePlatformSchema = z.enum(['web', 'ios', 'android']);

/** Supported device platform inferred from its schema. */
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/**
 * Owns the trusted return-unlock mechanism bound to a device enrollment.
 * Native devices use biometric protection and web enrollments use a secure
 * session cookie.
 */
export const DeviceUnlockMethodSchema = z.enum([
  'secure-session-cookie',
  'biometric',
]);

/** Device return-unlock mechanism inferred from its schema. */
export type DeviceUnlockMethod = z.infer<typeof DeviceUnlockMethodSchema>;

/**
 * Owns the stable identifier for a device enrollment. Revocation appends
 * lifecycle evidence and preserves the enrollment for audit reconstruction.
 */
export const DeviceEnrollmentIdSchema = UuidSchema;

/** Device enrollment identifier inferred from its schema. */
export type DeviceEnrollmentId = z.infer<typeof DeviceEnrollmentIdSchema>;

/**
 * Owns a device-bound enrollment without exposing credentials. Native
 * enrollments are biometric-gated; web enrollments use secure cookies.
 */
export const DeviceEnrollmentSchema = z
  .object({
    id: DeviceEnrollmentIdSchema,
    userId: UserIdSchema,
    platform: DevicePlatformSchema,
    unlockMethod: DeviceUnlockMethodSchema,
    installationId: z.string().trim().min(16).max(255),
    enrolledAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((device, context) => {
    const requiredUnlock =
      device.platform === 'web' ? 'secure-session-cookie' : 'biometric';
    if (device.unlockMethod !== requiredUnlock) {
      context.addIssue({
        code: 'custom',
        message: `${device.platform} enrollments require ${requiredUnlock}.`,
        path: ['unlockMethod'],
      });
    }
    if (!isAtOrAfter(device.lastSeenAt, device.enrolledAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Last-seen time cannot precede enrollment.',
        path: ['lastSeenAt'],
      });
    }
    if (device.revokedAt && !isAtOrAfter(device.revokedAt, device.enrolledAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Revocation cannot precede enrollment.',
        path: ['revokedAt'],
      });
    }
  })
  .readonly();

/** Device-bound enrollment inferred from its schema. */
export type DeviceEnrollment = z.infer<typeof DeviceEnrollmentSchema>;

/**
 * Owns the stable identifier for a revocable application session. Tokens and
 * token hashes intentionally never appear in this client-safe contract.
 */
export const SessionIdSchema = UuidSchema;

/** Stable session identifier inferred from its schema. */
export type SessionId = z.infer<typeof SessionIdSchema>;

/** Stable identifier for immutable Google access-membership evidence. */
export const AccessMembershipSnapshotIdSchema = UuidSchema;

/** Access-membership snapshot identifier inferred from its schema. */
export type AccessMembershipSnapshotId = z.infer<
  typeof AccessMembershipSnapshotIdSchema
>;

/**
 * Owns one minimized member row in a complete access-membership snapshot.
 * Only designated access-group provenance and server-authorized facility scope
 * are retained; no roster contacts or student data appear here.
 */
export const AccessMembershipMemberSchema = z
  .object({
    userId: UserIdSchema,
    googleSubject: z.string().trim().min(1).max(255),
    accessGroupSourceRefs: z
      .array(AccessGroupSourceRefSchema)
      .min(1)
      .max(50)
      .readonly(),
    facilityScope: FacilityScopeSchema,
  })
  .strict()
  .superRefine((member, context) => {
    if (
      !hasUniqueStrings(member.accessGroupSourceRefs.map((source) => source.id))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Access-group provenance references must be unique.',
        path: ['accessGroupSourceRefs'],
      });
    }
  })
  .readonly();

/** Minimized cached access-member evidence inferred from its schema. */
export type AccessMembershipMember = z.infer<
  typeof AccessMembershipMemberSchema
>;

/**
 * Owns one normalized Google email fact selected by the configured Google
 * membership evaluator for a complete access snapshot. The evaluator's
 * direct-versus-nested membership policy is deliberately not represented in
 * this row while that product decision remains unresolved. This contract
 * retains only the evaluator's resulting email and exact access-group
 * provenance. OIDC remains the sole source of an immutable Google subject.
 */
export const EvaluatedAccessMembershipSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .refine((email) => email === email.toLowerCase(), {
        message:
          'Evaluated access membership requires a normalized Google email.',
      }),
    accessGroupSourceRefs: z
      .array(AccessGroupSourceRefSchema)
      .min(1)
      .max(50)
      .readonly(),
  })
  .strict()
  .superRefine((member, context) => {
    if (
      !hasUniqueStrings(member.accessGroupSourceRefs.map((source) => source.id))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluated access-group references must be unique.',
        path: ['accessGroupSourceRefs'],
      });
    }
  })
  .readonly();

/** Evaluated Google-email access evidence inferred from its schema. */
export type EvaluatedAccessMembership = z.infer<
  typeof EvaluatedAccessMembershipSchema
>;

/**
 * Owns one complete, immutable Google Groups access snapshot. Expected and
 * completed designated-group sets must match exactly; partial syncs never
 * become session authorization evidence.
 */
export const AccessMembershipSnapshotSchema = z
  .object({
    id: AccessMembershipSnapshotIdSchema,
    version: VersionSchema,
    complete: z.literal(true),
    expectedAccessGroupSourceRefs: z
      .array(AccessGroupSourceRefSchema)
      .min(1)
      .max(100)
      .readonly(),
    completedAccessGroupSourceRefs: z
      .array(AccessGroupSourceRefSchema)
      .min(1)
      .max(100)
      .readonly(),
    evaluatedMemberships: z
      .array(EvaluatedAccessMembershipSchema)
      .max(1_200)
      .readonly(),
    members: z.array(AccessMembershipMemberSchema).max(1_200).readonly(),
    syncStartedAt: TimestampSchema,
    capturedAt: TimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const expectedIds = snapshot.expectedAccessGroupSourceRefs.map(
      (source) => source.id,
    );
    const completedIds = snapshot.completedAccessGroupSourceRefs.map(
      (source) => source.id,
    );
    const expected = snapshot.expectedAccessGroupSourceRefs
      .map(accessGroupSourceRefKey)
      .sort();
    const completed = snapshot.completedAccessGroupSourceRefs
      .map(accessGroupSourceRefKey)
      .sort();
    if (
      !hasUniqueStrings(expectedIds) ||
      !hasUniqueStrings(completedIds) ||
      !hasUniqueStrings(expected) ||
      !hasUniqueStrings(completed) ||
      expected.length !== completed.length ||
      expected.some((id, index) => id !== completed[index])
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A complete access snapshot must include every expected group.',
        path: ['completedAccessGroupSourceRefs'],
      });
    }
    const expectedSet = new Set(expected);
    snapshot.evaluatedMemberships.forEach((member, memberIndex) => {
      member.accessGroupSourceRefs.forEach((groupSource, groupIndex) => {
        if (!expectedSet.has(accessGroupSourceRefKey(groupSource))) {
          context.addIssue({
            code: 'custom',
            message:
              'Evaluated membership provenance must use a designated access group.',
            path: [
              'evaluatedMemberships',
              memberIndex,
              'accessGroupSourceRefs',
              groupIndex,
            ],
          });
        }
      });
    });
    if (
      !hasUniqueStrings(
        snapshot.evaluatedMemberships.map((member) => member.email),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluated access-member emails must be unique.',
        path: ['evaluatedMemberships'],
      });
    }
    snapshot.members.forEach((member, memberIndex) => {
      member.accessGroupSourceRefs.forEach((groupSource, groupIndex) => {
        if (!expectedSet.has(accessGroupSourceRefKey(groupSource))) {
          context.addIssue({
            code: 'custom',
            message: 'Member provenance must use a designated access group.',
            path: ['members', memberIndex, 'accessGroupSourceRefs', groupIndex],
          });
        }
      });
    });
    if (!hasUniqueStrings(snapshot.members.map((member) => member.userId))) {
      context.addIssue({
        code: 'custom',
        message: 'Access snapshot user IDs must be unique.',
        path: ['members'],
      });
    }
    if (
      !hasUniqueStrings(snapshot.members.map((member) => member.googleSubject))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Access snapshot Google subjects must be unique.',
        path: ['members'],
      });
    }
    if (!isAtOrAfter(snapshot.capturedAt, snapshot.syncStartedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Access snapshot capture cannot precede sync start.',
        path: ['capturedAt'],
      });
    }
  })
  .readonly();

/** Complete immutable access-membership evidence inferred from its schema. */
export type AccessMembershipSnapshot = z.infer<
  typeof AccessMembershipSnapshotSchema
>;

/**
 * Owns the two protected phases of the exact access-membership transition.
 * Provider locators, member rows, credentials, and the one-time email selector
 * remain server-owned dependencies and can never be supplied by the caller.
 * Finalization accepts only opaque durable-session proof identifiers.
 */
/**
 * The access-membership sync takes no command payload.
 *
 * It used to name the one designated Google group and a transition phase. Both
 * are gone: the groups a deployment trusts are the active access sources in the
 * database, and the sync publishes for whatever set that is. Leaving the group
 * addressable from the command would let a caller publish a snapshot for a
 * group the deployment never activated.
 */
export const SyncAccessMembershipInputSchema = z.object({}).strict().readonly();

/** Exact access-membership sync command inferred from its schema. */
export type SyncAccessMembershipInput = z.infer<
  typeof SyncAccessMembershipInputSchema
>;

/**
 * Credential-free aggregate proof for one immutable access-membership
 * publication. Full member emails and the provider group identifier remain in
 * protected persistence; only their bounded counts and digests cross the
 * capability boundary.
 */
const syncAccessMembershipResultFields = {
  snapshotId: AccessMembershipSnapshotIdSchema,
  snapshotVersion: VersionSchema,
  capturedAt: TimestampSchema,
  activeAccessGroupCount: z.number().int().min(1).max(100),
  evaluatedMembershipCount: z.number().int().min(0).max(1_200),
  membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  providerGroupIdDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  publication: z.enum(['created', 'already-current']),
} as const;

export const SyncAccessMembershipResultSchema = z
  .object({
    ...syncAccessMembershipResultFields,
  })
  .strict()
  .readonly();

/** Aggregate access-membership publication proof inferred from its schema. */
export type SyncAccessMembershipResult = z.infer<
  typeof SyncAccessMembershipResultSchema
>;

/**
 * Owns truthful session-authorization provenance. Normal users rely on a
 * complete Google access snapshot. Every app session is gated by designated
 * Google Group membership; no environment or administrative bypass exists.
 */
export const MembershipSourceSchema = z.literal('google-group-snapshot');

/** Cached access-membership source inferred from its schema. */
export type MembershipSource = z.infer<typeof MembershipSourceSchema>;

/**
 * Owns the complete Google Group authorization evidence used to issue one
 * session. Designated group membership is mandatory for every user and role.
 */
export const SessionAuthorizationSchema = z
  .object({
    kind: z.literal('group-membership'),
    source: MembershipSourceSchema,
    /**
     * Null for every session issued after the trusted-group cutover. Such a
     * session is not pinned to a generation: it stays valid while its holder
     * remains in a trusted group, which is checked directly. Sessions issued
     * before the cutover keep the snapshot they were pinned to.
     */
    membershipSnapshotId: AccessMembershipSnapshotIdSchema.nullable(),
    membershipValidUntil: TimestampSchema,
    membershipGraceUntil: TimestampSchema,
  })
  .strict()
  .readonly();

/** Session authorization evidence inferred from its schema. */
export type SessionAuthorization = z.infer<typeof SessionAuthorizationSchema>;

/**
 * Owns a long-lived, device-bound session lifecycle. Cached group membership
 * remains usable through its explicit grace time so a Google outage does not
 * block an already authenticated staff member; expiry and revocation remain
 * fail-closed.
 */
export const SessionSchema = z
  .object({
    id: SessionIdSchema,
    userId: UserIdSchema,
    deviceEnrollmentId: DeviceEnrollmentIdSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    authorization: SessionAuthorizationSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    if (!isAtOrAfter(session.expiresAt, session.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Session expiry cannot precede creation.',
        path: ['expiresAt'],
      });
    }
    if (
      !isAtOrAfter(
        session.authorization.membershipValidUntil,
        session.createdAt,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Membership validity cannot precede session creation.',
        path: ['authorization', 'membershipValidUntil'],
      });
    }
    if (
      !isAtOrAfter(
        session.authorization.membershipGraceUntil,
        session.authorization.membershipValidUntil,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Membership grace cannot end before normal validity.',
        path: ['authorization', 'membershipGraceUntil'],
      });
    }
    if (
      session.revokedAt &&
      !isAtOrAfter(session.revokedAt, session.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Session revocation cannot precede creation.',
        path: ['revokedAt'],
      });
    }
  })
  .readonly();

/** Device-bound session lifecycle inferred from its schema. */
export type Session = z.infer<typeof SessionSchema>;

/**
 * Owns one server-issued online connectivity epoch for a session. A reconnect
 * appends a new epoch; confirmations bind its ID and cannot cross epochs.
 */
export const ConnectivityEpochSchema = z
  .object({
    id: ConnectivityEpochIdSchema,
    sessionId: SessionIdSchema,
    establishedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Online session connectivity epoch inferred from its schema. */
export type ConnectivityEpoch = z.infer<typeof ConnectivityEpochSchema>;

/** Stable identifier for an append-only connectivity invalidation fact. */
export const ConnectivityEpochInvalidationIdSchema = UuidSchema;

/** Connectivity invalidation identifier inferred from its schema. */
export type ConnectivityEpochInvalidationId = z.infer<
  typeof ConnectivityEpochInvalidationIdSchema
>;

/**
 * Owns one append-only invalidation of an earlier online epoch. Reconnect,
 * disconnect, and session revocation all force a fresh epoch and decision.
 */
export const ConnectivityEpochInvalidationSchema = z
  .object({
    id: ConnectivityEpochInvalidationIdSchema,
    connectivityEpochId: ConnectivityEpochIdSchema,
    reason: z.enum(['disconnected', 'reconnected', 'session-revoked']),
    invalidatedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Append-only connectivity invalidation fact inferred from its schema. */
export type ConnectivityEpochInvalidation = z.infer<
  typeof ConnectivityEpochInvalidationSchema
>;

/** Stable identifier for the initial session token issuance fact. */
export const SessionTokenIssuanceIdSchema = UuidSchema;

/** Initial session-token issuance identifier inferred from its schema. */
export type SessionTokenIssuanceId = z.infer<
  typeof SessionTokenIssuanceIdSchema
>;

/**
 * Owns the append-only initial refresh-token credential fact for a session.
 * Only the cryptographic digest is retained; plaintext tokens never enter
 * contracts, persistence logs, or client-readable responses.
 */
export const SessionTokenIssuanceSchema = z
  .object({
    id: SessionTokenIssuanceIdSchema,
    sessionId: SessionIdSchema,
    tokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    issuedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Append-only initial refresh-token fact inferred from its schema. */
export type SessionTokenIssuance = z.infer<typeof SessionTokenIssuanceSchema>;

/**
 * Owns the stable identifier for an append-only refresh-token rotation event.
 * Rotation history supports replay detection without storing plaintext tokens.
 */
export const SessionTokenRotationIdSchema = UuidSchema;

/** Refresh-token rotation identifier inferred from its schema. */
export type SessionTokenRotationId = z.infer<
  typeof SessionTokenRotationIdSchema
>;

/**
 * Owns one append-only refresh-token rotation fact. Only cryptographic token
 * digests are stored; replay detection appends a separate fact rather than
 * rewriting this rotation event.
 */
export const SessionTokenRotationSchema = z
  .object({
    id: SessionTokenRotationIdSchema,
    sessionId: SessionIdSchema,
    previousTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    nextTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    rotatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((rotation, context) => {
    if (rotation.previousTokenDigest === rotation.nextTokenDigest) {
      context.addIssue({
        code: 'custom',
        message: 'Refresh-token rotation must change the token digest.',
        path: ['nextTokenDigest'],
      });
    }
  })
  .readonly();

/** Append-only refresh-token rotation fact inferred from its schema. */
export type SessionTokenRotation = z.infer<typeof SessionTokenRotationSchema>;

/**
 * Owns the stable identifier for an append-only refresh-token replay fact.
 * Detection never mutates the rotation record that supplied the used digest.
 */
export const SessionTokenReplayIdSchema = UuidSchema;

/** Refresh-token replay identifier inferred from its schema. */
export type SessionTokenReplayId = z.infer<typeof SessionTokenReplayIdSchema>;

/**
 * Owns one append-only refresh-token replay detection fact. It points to the
 * immutable rotation whose retired digest was presented and records no raw or
 * hashed credential beyond that already retained rotation reference.
 */
export const SessionTokenReplaySchema = z
  .object({
    id: SessionTokenReplayIdSchema,
    sessionId: SessionIdSchema,
    rotationId: SessionTokenRotationIdSchema,
    detectedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Append-only refresh-token replay fact inferred from its schema. */
export type SessionTokenReplay = z.infer<typeof SessionTokenReplaySchema>;

/**
 * Owns the stable identifier for an append-only session revocation fact.
 * Revocations are retained and consulted by deny-by-default middleware.
 */
export const SessionRevocationIdSchema = UuidSchema;

/** Session revocation identifier inferred from its schema. */
export type SessionRevocationId = z.infer<typeof SessionRevocationIdSchema>;

/**
 * Owns one append-only session revocation fact with actor provenance and a
 * bounded reason code. Revocation history is never deleted or reset.
 */
export const SessionRevocationSchema = z
  .object({
    id: SessionRevocationIdSchema,
    sessionId: SessionIdSchema,
    revokedBy: ActorSchema,
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u),
    revokedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Append-only session revocation fact inferred from its schema. */
export type SessionRevocation = z.infer<typeof SessionRevocationSchema>;

/** Native platforms that may enroll an application bearer after Google OIDC. */
export const NativeDevicePlatformSchema = z.enum(['ios', 'android']);

/** Native device platform inferred from its schema. */
export type NativeDevicePlatform = z.infer<typeof NativeDevicePlatformSchema>;

/** RFC 7636 S256 challenge: one SHA-256 digest encoded as base64url. */
export const PkceCodeChallengeSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);

/** PKCE S256 challenge inferred from its schema. */
export type PkceCodeChallenge = z.infer<typeof PkceCodeChallengeSchema>;

/** RFC 7636 verifier retained only in native memory during first sign-in. */
export const PkceCodeVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/u);

/** PKCE verifier inferred from its schema. */
export type PkceCodeVerifier = z.infer<typeof PkceCodeVerifierSchema>;

/**
 * Server-generated state for a native OIDC attempt. The prefix keeps the
 * passive HTTPS callback relay disjoint from the established web-cookie flow.
 */
export const MobileOidcStateSchema = z
  .string()
  .length(46)
  .regex(/^m1\.[A-Za-z0-9_-]{43}$/u);

/** Native OIDC state inferred from its schema. */
export type MobileOidcState = z.infer<typeof MobileOidcStateSchema>;

/**
 * Opaque, authenticated mobile-flow state. Clients may retain and return it,
 * but its encrypted representation is deliberately not a public data model.
 */
export const MobileOidcFlowTokenSchema = z
  .string()
  .min(64)
  .max(4_096)
  .regex(/^m1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

/** Opaque native OIDC flow token inferred from its schema. */
export type MobileOidcFlowToken = z.infer<typeof MobileOidcFlowTokenSchema>;

/** Transport-only Google authorization code; never a capability input. */
export const OidcAuthorizationCodeSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => {
      if (value !== value.trim()) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit <= 31 || codeUnit === 127) {
          return false;
        }
      }
      return true;
    },
    { message: 'Authorization code contains invalid characters.' },
  );

/** Google authorization code inferred from its transport schema. */
export type OidcAuthorizationCode = z.infer<typeof OidcAuthorizationCodeSchema>;

/** Begins one server-bound native OIDC attempt without accepting a redirect. */
export const MobileOidcStartRequestSchema = z
  .object({
    platform: NativeDevicePlatformSchema,
    installationId: z.string().trim().min(16).max(255),
    codeChallenge: PkceCodeChallengeSchema,
  })
  .strict()
  .readonly();

/** Native OIDC start request inferred from its schema. */
export type MobileOidcStartRequest = z.infer<
  typeof MobileOidcStartRequestSchema
>;

/**
 * Response used to open the system browser. The application redirect is fixed
 * by the server and cannot become a caller-controlled open redirect.
 */
export const MobileOidcStartResponseSchema = z
  .object({
    clientId: z.string().trim().min(1).max(255),
    authorizationUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        const loopback =
          url.hostname === 'localhost' ||
          url.hostname === '::1' ||
          url.hostname === '[::1]' ||
          /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
        return (
          url.protocol === 'https:' || (url.protocol === 'http:' && loopback)
        );
      }, 'Authorization URL must use HTTPS or a loopback HTTP test origin.'),
    flowToken: MobileOidcFlowTokenSchema,
    state: MobileOidcStateSchema,
    appRedirectUri: z.literal('psdeoc://auth/callback'),
    expiresAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Native OIDC start response inferred from its schema. */
export type MobileOidcStartResponse = z.infer<
  typeof MobileOidcStartResponseSchema
>;

/**
 * Completes one native code flow. Raw provider material remains in this
 * transport-only request and is removed before capability execution.
 */
export const MobileOidcExchangeRequestSchema = z
  .object({
    authorizationCode: OidcAuthorizationCodeSchema,
    state: MobileOidcStateSchema,
    codeVerifier: PkceCodeVerifierSchema,
    flowToken: MobileOidcFlowTokenSchema,
  })
  .strict()
  .readonly();

/** Native OIDC exchange request inferred from its schema. */
export type MobileOidcExchangeRequest = z.infer<
  typeof MobileOidcExchangeRequestSchema
>;

/**
 * Signs in the single account a deployment sets aside for app-store review,
 * with a code instead of Google. Store reviewers cannot complete district
 * single sign-on or its second factor on their test devices, so this is the
 * path they use. It is off unless the deployment supplies the code's digest,
 * and it grants nothing beyond what that account's admission already grants.
 */
export const MobileAppReviewSignInRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    code: z.string().trim().min(16).max(128),
    platform: NativeDevicePlatformSchema,
    installationId: z.string().trim().min(16).max(255),
  })
  .strict()
  .readonly();

/** App-store review sign-in request inferred from its schema. */
export type MobileAppReviewSignInRequest = z.infer<
  typeof MobileAppReviewSignInRequestSchema
>;

/** Opaque application session bearer accepted by the shared session service. */
export const OpaqueSessionBearerSchema = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})$/u);

/** Opaque application bearer inferred from its transport schema. */
export type OpaqueSessionBearer = z.infer<typeof OpaqueSessionBearerSchema>;

/**
 * Owns normalized, signature-verified Google claims and device facts passed
 * into session establishment after the adapter has consumed the one-time
 * authorization code. Codes, PKCE verifiers, tokens, and other credentials
 * never enter the capability input or logs. Group authorization, roles, and
 * facility scope remain server-derived and are not accepted here.
 */
export const CompleteOidcSignInInputSchema = z
  .object({
    claims: z
      .object({
        issuer: z.literal('https://accounts.google.com'),
        audience: z.string().trim().min(1).max(255),
        subject: z.string().trim().min(1).max(255),
        subjectDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        claimsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        // Google's hosted-domain claim is retained only as untrusted identity
        // metadata. Authorization is derived from exact persisted Group
        // evidence, never from this value or an email-domain suffix.
        hostedDomain: z.string().trim().min(1).max(255).nullable(),
        email: z
          .string()
          .trim()
          .email()
          .max(320)
          .refine((email) => email === email.toLowerCase(), {
            message: 'OIDC email must be normalized to lowercase.',
          }),
        emailVerified: z.literal(true),
        displayName: z.string().trim().min(1).max(160),
      })
      .strict()
      .readonly(),
    device: z
      .object({
        platform: DevicePlatformSchema,
        unlockMethod: DeviceUnlockMethodSchema,
        installationId: z.string().trim().min(16).max(255),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .superRefine((input, context) => {
    const requiredUnlock =
      input.device.platform === 'web' ? 'secure-session-cookie' : 'biometric';
    if (input.device.unlockMethod !== requiredUnlock) {
      context.addIssue({
        code: 'custom',
        message: `${input.device.platform} sign-in requires ${requiredUnlock}.`,
        path: ['device', 'unlockMethod'],
      });
    }
  })
  .readonly();

/** Pre-session OIDC callback input inferred from its schema. */
export type CompleteOidcSignInInput = z.infer<
  typeof CompleteOidcSignInInputSchema
>;

/**
 * Owns the deliberately empty refresh input. The specialized refresh
 * envelope carries a server-verified current credential principal; the
 * capability creates a fresh connectivity epoch and accepts no caller claim.
 */
export const RefreshSessionInputSchema = z.object({}).strict().readonly();

/** Refresh-session input inferred from its schema. */
export type RefreshSessionInput = z.infer<typeof RefreshSessionInputSchema>;

/** Owns an authenticated request to revoke one retained session. */
export const RevokeSessionInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u),
  })
  .strict()
  .readonly();

/** Session-revocation input inferred from its schema. */
export type RevokeSessionInput = z.infer<typeof RevokeSessionInputSchema>;

/**
 * Owns the non-secret result of initial sign-in and refresh. Credential
 * material is delivered only by the protected transport and does not enter
 * a serializable capability result.
 */
export const SessionEstablishmentResultSchema = z
  .object({
    user: UserSchema,
    session: SessionSchema,
    deviceEnrollment: DeviceEnrollmentSchema,
    connectivityEpoch: ConnectivityEpochSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.session.userId !== result.user.id ||
      result.session.deviceEnrollmentId !== result.deviceEnrollment.id ||
      result.deviceEnrollment.userId !== result.user.id ||
      result.connectivityEpoch.sessionId !== result.session.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Established identity, device, session, and epoch must agree.',
        path: ['session'],
      });
    }
  })
  .readonly();

/** Non-secret established-session result inferred from its schema. */
export type SessionEstablishmentResult = z.infer<
  typeof SessionEstablishmentResultSchema
>;

/**
 * Protected native transport response for initial exchange and rotation. The
 * bearer is intentionally outside the canonical capability result and must
 * never be persisted or logged in plaintext.
 */
export const MobileSessionResponseSchema = z
  .object({
    session: SessionEstablishmentResultSchema,
    tokenType: z.literal('Bearer'),
    refreshToken: OpaqueSessionBearerSchema,
  })
  .strict()
  .readonly();

/** Native session transport response inferred from its schema. */
export type MobileSessionResponse = z.infer<typeof MobileSessionResponseSchema>;

/** Owns the current authenticated identity and online-session view. */
export const CurrentSessionResultSchema = z
  .object({
    user: UserSchema,
    session: SessionSchema,
    deviceEnrollment: DeviceEnrollmentSchema,
    connectivityEpoch: ConnectivityEpochSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.session.userId !== result.user.id ||
      result.session.deviceEnrollmentId !== result.deviceEnrollment.id ||
      result.deviceEnrollment.userId !== result.user.id ||
      result.connectivityEpoch.sessionId !== result.session.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Current identity, device, session, and epoch must agree.',
        path: ['session'],
      });
    }
  })
  .readonly();

/** Current authenticated session result inferred from its schema. */
export type CurrentSessionResult = z.infer<typeof CurrentSessionResultSchema>;

/** Owns bounded device-session administration filters. */
export const ListDeviceSessionsInputSchema = z
  .object({
    userId: UserIdSchema.nullable(),
    includeRevoked: z.boolean(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Device-session list input inferred from its schema. */
export type ListDeviceSessionsInput = z.infer<
  typeof ListDeviceSessionsInputSchema
>;

/** Owns one credential-free device and session administration row. */
export const DeviceSessionSummarySchema = z
  .object({
    deviceEnrollment: DeviceEnrollmentSchema,
    sessions: z.array(SessionSchema).max(100).readonly(),
  })
  .strict()
  .superRefine((summary, context) => {
    summary.sessions.forEach((session, index) => {
      if (
        session.deviceEnrollmentId !== summary.deviceEnrollment.id ||
        session.userId !== summary.deviceEnrollment.userId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Device-session rows must belong to their enrollment.',
          path: ['sessions', index],
        });
      }
    });
  })
  .readonly();

/** Credential-free device-session row inferred from its schema. */
export type DeviceSessionSummary = z.infer<typeof DeviceSessionSummarySchema>;

/** Owns a bounded page of credential-free device-session rows. */
export const DeviceSessionPageSchema = paginatedSchema(
  DeviceSessionSummarySchema,
);

/** Device-session page inferred from its schema. */
export type DeviceSessionPage = z.infer<typeof DeviceSessionPageSchema>;

/**
 * Owns the immutable native-build identity carried with a push registration.
 * These values are non-secret release evidence. The server compares the exact
 * tuple with protected deployment configuration; a public client flag alone
 * never authorizes provider registration.
 */
export const NativePushBuildIdentitySchema = z
  .object({
    applicationId: z
      .string()
      .trim()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+$/u),
    applicationVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
    nativeBuildVersion: z.string().regex(/^[1-9][0-9]{0,17}$/u),
    expoProjectId: UuidSchema,
    updateMode: z.literal('embedded-only'),
  })
  .strict()
  .readonly();

/** Immutable native-build identity inferred from its schema. */
export type NativePushBuildIdentity = z.infer<
  typeof NativePushBuildIdentitySchema
>;

/**
 * Owns one protected server allowlist entry for native push registration.
 * The allowlist is deployment configuration and is empty when omitted.
 */

/**
 * Owns native push-token registration input. The token is untrusted contact
 * input, never a fixture or log field, and is bound to an existing native
 * device enrollment rather than a caller-provided user identity.
 */
export const RegisterPushTokenInputSchema = z
  .object({
    deviceEnrollmentId: DeviceEnrollmentIdSchema,
    platform: z.enum(['ios', 'android']),
    provider: PushProviderSchema,
    serviceEnvironment: PushServiceEnvironmentSchema,
    build: NativePushBuildIdentitySchema,
    token: z.string().trim().min(16).max(4_096),
    /** Expo fallback rotated atomically with the direct-provider token. */
    expoFallbackToken: z.string().trim().min(16).max(4_096).optional(),
  })
  .strict()
  .superRefine((registration, context) => {
    if (
      !pushProviderMatchesPlatform(registration.provider, registration.platform)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Push provider is incompatible with the native platform.',
        path: ['provider'],
      });
    }
    if (
      registration.expoFallbackToken !== undefined &&
      registration.provider === 'expo'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An Expo fallback requires a direct native provider.',
        path: ['expoFallbackToken'],
      });
    }
    if (
      registration.provider !== 'expo' &&
      registration.expoFallbackToken === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A direct native provider requires an Expo fallback in the same registration generation.',
        path: ['expoFallbackToken'],
      });
    }
  })
  .readonly();

/** Native push-token registration input inferred from its schema. */
export type RegisterPushTokenInput = z.infer<
  typeof RegisterPushTokenInputSchema
>;

/** Owns a non-secret receipt for a native push-token registration. */
export const PushTokenRegistrationReceiptSchema = z
  .object({
    deviceEnrollmentId: DeviceEnrollmentIdSchema,
    platform: z.enum(['ios', 'android']),
    provider: PushProviderSchema,
    serviceEnvironment: PushServiceEnvironmentSchema,
    status: z.literal('registered'),
  })
  .strict()
  .readonly();

/** Push-token registration receipt inferred from its schema. */
export type PushTokenRegistrationReceipt = z.infer<
  typeof PushTokenRegistrationReceiptSchema
>;

/** Owns a token-free request to unregister the current device's push token. */
export const UnregisterPushTokenInputSchema = z
  .object({
    deviceEnrollmentId: DeviceEnrollmentIdSchema,
  })
  .strict()
  .readonly();

/** Push-token unregistration input inferred from its schema. */
export type UnregisterPushTokenInput = z.infer<
  typeof UnregisterPushTokenInputSchema
>;

/** Owns a non-secret receipt for a native push-token unregistration. */
export const PushTokenUnregistrationReceiptSchema = z
  .object({
    deviceEnrollmentId: DeviceEnrollmentIdSchema,
    status: z.literal('unregistered'),
  })
  .strict()
  .readonly();

/** Push-token unregistration receipt inferred from its schema. */
export type PushTokenUnregistrationReceipt = z.infer<
  typeof PushTokenUnregistrationReceiptSchema
>;

/** Owns the bounded current-user device-list request. */
export const ListMyDevicesInputSchema = z
  .object({
    includeRevoked: z.boolean(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(100),
  })
  .strict()
  .readonly();

/** Current-user device-list input inferred from its schema. */
export type ListMyDevicesInput = z.infer<typeof ListMyDevicesInputSchema>;

/** Owns a bounded page of device enrollments without credential material. */
export const DeviceEnrollmentPageSchema = paginatedSchema(
  DeviceEnrollmentSchema,
);

/** Device-enrollment page inferred from its schema. */
export type DeviceEnrollmentPage = z.infer<typeof DeviceEnrollmentPageSchema>;

/** Owns bounded user-administration list filters. */
export const ListUsersInputSchema = z
  .object({
    facilityId: UuidSchema.nullable(),
    includeDisabled: z.boolean(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** User-administration list input inferred from its schema. */
export type ListUsersInput = z.infer<typeof ListUsersInputSchema>;

/** Owns a bounded page of minimized staff user records. */
export const UserPageSchema = paginatedSchema(UserSchema);

/** Minimized staff-user page inferred from its schema. */
export type UserPage = z.infer<typeof UserPageSchema>;

/**
 * The exact wording a staff member agreed to when they gave a phone number.
 *
 * Carriers do not accept "they opted in" as an assertion. A toll-free or 10DLC
 * review asks what the person was shown at the moment of consent, and a
 * district has to be able to produce it for any number it later sends to.
 * Recording the version means a later change to the wording cannot rewrite
 * what an earlier consent actually said.
 */
export const SmsConsentDisclosureVersionSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u);

/** SMS consent disclosure version inferred from its schema. */
export type SmsConsentDisclosureVersion = z.infer<
  typeof SmsConsentDisclosureVersionSchema
>;

/**
 * Owns a staff member's affirmative agreement to receive emergency SMS.
 *
 * The number is untrusted contact input and is never a log field. Consent is
 * per person and per number: giving a new number supersedes the previous one
 * rather than adding a second, because a district notifying two numbers for
 * one employee is a carrier complaint waiting to happen.
 */
export const RecordSmsConsentInputSchema = z
  .object({
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/u),
    disclosureVersion: SmsConsentDisclosureVersionSchema,
    /**
     * Affirmative and explicit. A default-checked box is not consent, so this
     * has to be the literal true the person actually produced.
     */
    agreed: z.literal(true),
  })
  .strict()
  .readonly();

/** SMS consent input inferred from its schema. */
export type RecordSmsConsentInput = z.infer<typeof RecordSmsConsentInputSchema>;

/**
 * Owns a non-secret receipt for recorded SMS consent.
 *
 * The number is deliberately absent: a receipt is rendered and logged, and the
 * caller already knows the number they just sent.
 */
export const SmsConsentReceiptSchema = z
  .object({
    /**
     * Identifies the consent row itself, which is what a carrier dispute is
     * ultimately resolved against. It is a non-secret opaque id, unlike the
     * number.
     */
    consentId: UuidSchema,
    disclosureVersion: SmsConsentDisclosureVersionSchema,
    status: z.literal('consented'),
    recordedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** SMS consent receipt inferred from its schema. */
export type SmsConsentReceipt = z.infer<typeof SmsConsentReceiptSchema>;

/** Owns a number-free request to read the caller's own SMS consent state. */
export const ReadMySmsConsentInputSchema = z.object({}).strict().readonly();

/** Own-consent read input inferred from its schema. */
export type ReadMySmsConsentInput = z.infer<typeof ReadMySmsConsentInputSchema>;

/** Owns a number-free request to withdraw a staff member's SMS consent. */
export const WithdrawSmsConsentInputSchema = z.object({}).strict().readonly();

/** SMS consent withdrawal input inferred from its schema. */
export type WithdrawSmsConsentInput = z.infer<
  typeof WithdrawSmsConsentInputSchema
>;

/** Owns a non-secret receipt for a withdrawn SMS consent. */
export const SmsConsentWithdrawalReceiptSchema = z
  .object({
    /** The consent that was withdrawn; the row survives as evidence. */
    consentId: UuidSchema,
    status: z.literal('withdrawn'),
    recordedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** SMS consent withdrawal receipt inferred from its schema. */
export type SmsConsentWithdrawalReceipt = z.infer<
  typeof SmsConsentWithdrawalReceiptSchema
>;

/**
 * Owns what the current staff member's SMS consent is, for their own view.
 *
 * Only the last four digits are exposed. A staff member needs to recognise
 * which number is on file; nobody needs the whole number read back to them,
 * and this response passes through rendering and error paths.
 */
export const SmsConsentStateSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('none') }).strict(),
    z
      .object({
        status: z.literal('consented'),
        lastFourDigits: z.string().regex(/^[0-9]{4}$/u),
        disclosureVersion: SmsConsentDisclosureVersionSchema,
        consentedAt: TimestampSchema,
      })
      .strict(),
  ])
  .readonly();

/** Current SMS consent state inferred from its schema. */
export type SmsConsentState = z.infer<typeof SmsConsentStateSchema>;

/**
 * The disclosure version currently shown to staff.
 *
 * Bumping this is how the wording changes. Consents recorded under an earlier
 * version keep that version, so a carrier asking what a given number agreed to
 * years later gets the text that person actually saw rather than the current
 * one.
 */
export const SMS_CONSENT_DISCLOSURE_VERSION: SmsConsentDisclosureVersion =
  '2026-09-04';

/** Tenant facts the disclosure names, so no district identity is a literal. */
export const SmsConsentDisclosureContextSchema = z
  .object({
    organizationName: z.string().trim().min(1).max(160),
    privacyPolicyUrl: z.string().url(),
    supportEmail: z.string().trim().email(),
    supportPhone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/u),
  })
  .strict()
  .readonly();

/** Disclosure context inferred from its schema. */
export type SmsConsentDisclosureContext = z.infer<
  typeof SmsConsentDisclosureContextSchema
>;

/** Owns the exact disclosure a staff member is shown before agreeing. */
export const SmsConsentDisclosureSchema = z
  .object({
    version: SmsConsentDisclosureVersionSchema,
    summary: z.string().min(1),
    terms: z.array(z.string().min(1)).min(1).readonly(),
    agreementLabel: z.string().min(1),
    privacyPolicyUrl: z.string().url(),
  })
  .strict()
  .readonly();

/** Disclosure inferred from its schema. */
export type SmsConsentDisclosure = z.infer<typeof SmsConsentDisclosureSchema>;

/**
 * Builds the disclosure shown at the moment of consent.
 *
 * Carrier review asks to see this exact text, so web and mobile must render
 * one source rather than two hand-kept copies that drift. Every carrier-
 * required element is here deliberately: who is sending, why, how often, that
 * rates apply, how to stop, how to get help, and where the privacy policy is.
 *
 * US toll-free STOP handling is carrier-owned and cannot be customized, which
 * is why resuming is described as texting START or UNSTOP to the same number
 * rather than as something this application can do on the person's behalf.
 */
export function smsConsentDisclosure(
  context: SmsConsentDisclosureContext,
): SmsConsentDisclosure {
  const parsed = SmsConsentDisclosureContextSchema.parse(context);
  return SmsConsentDisclosureSchema.parse({
    version: SMS_CONSENT_DISCLOSURE_VERSION,
    summary: `${parsed.organizationName} will text emergency notifications from PSD EOC to the mobile number you enter below.`,
    terms: Object.freeze([
      'PSD EOC texts you only about emergency activations, drills, and the delivery tests that prove the system still reaches you. It is never used for marketing.',
      'Message frequency varies with real events and scheduled drills.',
      'Message and data rates may apply.',
      'Reply STOP to any PSD EOC text to stop receiving them. To start again, text START or UNSTOP to that same number.',
      `Reply HELP for help, or contact ${parsed.supportEmail} or ${parsed.supportPhone}.`,
      'Your mobile number and this consent record are used only to notify you and to show a carrier that the message was permitted. They are not sold or shared for marketing.',
    ]),
    agreementLabel:
      'I agree to receive emergency text messages from PSD EOC at this number.',
    privacyPolicyUrl: parsed.privacyPolicyUrl,
  });
}

/**
 * Normalizes a typed North American mobile number to E.164, or null.
 *
 * Staff type numbers the way they say them -- "(253) 555-0123", "253.555.0123",
 * "1 253 555 0123" -- and the stored value has to be one exact form, because a
 * consent is matched to a delivery by that string. Shared so web and mobile
 * cannot disagree about which of two spellings is the number on file.
 *
 * Deliberately narrow: it accepts NANP input and already-E.164 input and
 * refuses everything else rather than guessing a country for a bare number.
 */
export function normalizeNorthAmericanMobileNumber(
  input: string,
): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^\+[1-9]\d{7,14}$/u.test(trimmed)) return trimmed;
  // Reject any other leading + rather than stripping it: a mistyped foreign
  // number must not be silently rewritten into a US one.
  if (trimmed.startsWith('+')) return null;
  const digits = trimmed.replace(/[\s().-]/gu, '');
  if (!/^\d+$/u.test(digits)) return null;
  if (digits.length === 10) {
    return /^[2-9]\d{2}[2-9]\d{6}$/u.test(digits) ? `+1${digits}` : null;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    const national = digits.slice(1);
    return /^[2-9]\d{2}[2-9]\d{6}$/u.test(national) ? `+1${national}` : null;
  }
  return null;
}

/**
 * Owns what a staff member's own consent screen needs, in one read.
 *
 * The disclosure travels with the state so mobile renders the same text the
 * server would show on the web rather than carrying its own copy of district
 * configuration. A carrier reviewing one screenshot is looking at wording that
 * only exists in one place.
 */
export const MySmsConsentViewSchema = z
  .object({
    consent: SmsConsentStateSchema,
    disclosure: SmsConsentDisclosureSchema,
  })
  .strict()
  .readonly();

/** Own-consent view inferred from its schema. */
export type MySmsConsentView = z.infer<typeof MySmsConsentViewSchema>;
