import { createHash, randomUUID } from 'node:crypto';

import {
  AccessGroupSourceRefSchema,
  FacilityScopeSchema,
  SecurityAuditEntrySchema,
  SecurityAuditHashSchema,
  TimestampSchema,
  UserSchema,
  UuidSchema,
  type AccessGroupSourceRef,
  type FacilityScope,
  type Role,
  type SecurityAuditEntry,
  type User,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  accessMembershipEvaluatedMembers,
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  securityAuditEntries,
  userFacilityScopes,
  users,
} from '../../db/schema';
import type { GoogleOidcCallbackErrorCode } from './oidc';
import {
  loadEffectiveAdministratorUserIds,
  loadEffectiveRoles,
} from './role-state';
import type { WebSessionIssuanceErrorCode } from './session-cookie';

const ACCESS_GATE_AUDIT_ACTION = 'complete-oidc-sign-in' as const;

/** Safe fallback when a post-gate failure has no narrower reason taxonomy. */
export const POST_GATE_SIGN_IN_FAILED_REASON =
  'POST_GATE_SIGN_IN_FAILED' as const;

/** The sole access group authorized by the current product-owner rule. */
export const DESIGNATED_ACCESS_GROUP_EMAIL =
  'tsd-engineering@psd401.net' as const;

/** Safe, bounded reasons that can be persisted for a denied sign-in. */
export const ACCESS_GATE_DENIAL_REASONS = [
  'UNKNOWN_USER',
  'USER_DISABLED',
  'NO_ACTIVE_ACCESS_GROUPS',
  'ACCESS_SNAPSHOT_UNAVAILABLE',
  'ACCESS_CONFIGURATION_NOT_SYNCED',
  'ACCESS_GROUP_MEMBERSHIP_REQUIRED',
  'ACCESS_EVIDENCE_INVALID',
] as const;

export type AccessGateDenialReason =
  (typeof ACCESS_GATE_DENIAL_REASONS)[number];

/** Configuration failure that identifies a field without reflecting its value. */
export class AccessGateConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AccessGateConfigurationError';
  }
}

/** A minimized user candidate loaded from trusted application persistence. */
export interface AccessGateUserRecord {
  readonly id: string;
  readonly googleSubject: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  readonly facilityScope: FacilityScope;
  readonly createdAt: string;
  readonly disabledAt: string | null;
}

/** Membership evidence for the candidate in one immutable access snapshot. */
export interface AccessGateMemberEvidence {
  readonly userId: string;
  readonly googleSubject: string;
  readonly accessGroupSourceRefs: readonly AccessGroupSourceRef[];
  readonly facilityScope: FacilityScope;
}

/** Latest complete access snapshot and its expected/completed group sets. */
export interface AccessGateSnapshotEvidence {
  readonly id: string;
  readonly version: number;
  readonly syncStartedAt: string;
  readonly capturedAt: string;
  readonly expectedAccessGroupSourceRefs: readonly AccessGroupSourceRef[];
  readonly completedAccessGroupSourceRefs: readonly AccessGroupSourceRef[];
  readonly evaluatedMember?: Readonly<{
    email: string;
    accessGroupSourceRefs: readonly AccessGroupSourceRef[];
  }> | null;
  readonly member: AccessGateMemberEvidence | null;
}

/** One consistent read of identity, active configuration, and cached evidence. */
export interface AccessGateEvidence {
  readonly user: AccessGateUserRecord | null;
  /** Existing email owner with another subject makes binding ambiguous. */
  readonly emailBindingConflict?: boolean;
  /** True only for the designated source, optionally plus one staged recovery source. */
  readonly activeAccessConfigurationExact?: boolean;
  /** Exact designated source selected by its persisted normalized group email. */
  readonly designatedAccessGroupSourceRef?: AccessGroupSourceRef | null;
  /** Sole reachable bound administrator during the two-source recovery stage. */
  readonly transitionRecoveryUserId?: string | null;
  readonly activeAccessGroupSourceRefs: readonly AccessGroupSourceRef[];
  /**
   * Legacy diagnostic retained for adapter compatibility. Authorization never
   * uses request/audit timestamps as a configuration generation.
   */
  readonly latestSuccessfulGroupSourceUpdateAt: string | null;
  readonly snapshot: AccessGateSnapshotEvidence | null;
}

/** Persistence boundary used by the gate and easily replaced by a test fake. */
export interface AccessGateStore {
  loadEvidence(
    googleSubject: string,
    normalizedEmail?: string,
  ): Promise<AccessGateEvidence>;
}

/** Data required to correlate a pre-session access decision without raw PII. */
export interface AccessGateCheckInput {
  readonly googleSubject: string;
  /** Signature-verified Google email normalized by the OIDC adapter. */
  readonly email: string;
  /** Bounded display label normalized by the OIDC adapter. */
  readonly displayName: string;
  readonly subjectDigest: string;
  readonly requestId: string;
  readonly checkedAt: string;
  /** Trusted authentication adapter source; never accepted from a body. */
  readonly source: 'web' | 'mobile';
}

/** Pinned membership provenance used when the session is issued. */
export interface AccessGateMembershipGrant {
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly syncStartedAt: string;
  readonly capturedAt: string;
  readonly accessGroupSourceRefs: readonly AccessGroupSourceRef[];
}

/**
 * Server-generated command for an atomic evaluated-email bind. `create`
 * persists a first-seen verified OIDC identity; `existing` adds exact current
 * group provenance to the already durable matching sub/email. The session
 * transaction must revalidate the source and roll back every row on failure.
 */
export interface AccessGateFirstLoginBinding {
  readonly userDisposition: 'create' | 'existing';
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotVersion: number;
  readonly successorSnapshotId: string;
  readonly successorSnapshotVersion: number;
  readonly normalizedEmail: string;
}

export interface AccessGateGranted {
  readonly granted: true;
  readonly user: User;
  readonly membership: AccessGateMembershipGrant;
  readonly firstLoginBinding: AccessGateFirstLoginBinding | null;
  /**
   * True only after exact designated-group authorization succeeds. The
   * canonical sign-in capability owns the append-only admin role fact.
   */
  readonly bootstrapAdminEligible: boolean;
}

export interface AccessGateDenied {
  readonly granted: false;
  readonly reasonCode: AccessGateDenialReason;
}

export type AccessGateDecision = AccessGateGranted | AccessGateDenied;

/** Minimized event accepted by the append-only access audit sink. */
export type AccessGateAuditEvent =
  | Readonly<{
      outcome: 'denied';
      requestId: string;
      occurredAt: string;
      subjectDigest: string | null;
      reasonCode:
        | AccessGateDenialReason
        | GoogleOidcCallbackErrorCode
        | WebSessionIssuanceErrorCode
        | typeof POST_GATE_SIGN_IN_FAILED_REASON;
      userId: string | null;
      source: 'web' | 'mobile';
    }>
  | Readonly<{
      outcome: 'success';
      requestId: string;
      occurredAt: string;
      userId: string;
      sessionId: string;
      source: 'web' | 'mobile';
    }>;

/** Append-only writer seam; implementations must never retain raw OIDC claims. */
export interface AccessGateAuditSink {
  append(event: AccessGateAuditEvent): Promise<SecurityAuditEntry>;
}

export interface AccessGateDependencies {
  readonly store: AccessGateStore;
  readonly audit: AccessGateAuditSink;
}

function validateCheckInput(input: AccessGateCheckInput): void {
  if (
    input.googleSubject.trim() !== input.googleSubject ||
    input.googleSubject.length === 0 ||
    input.googleSubject.length > 255
  ) {
    throw new AccessGateConfigurationError(
      'Access-gate subject must be a normalized immutable Google subject',
    );
  }
  if (
    input.email !== input.email.trim() ||
    input.email !== input.email.toLowerCase() ||
    input.email.length < 3 ||
    input.email.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/u.test(input.email)
  ) {
    throw new AccessGateConfigurationError(
      'Access-gate email must be a normalized verified Google email',
    );
  }
  if (
    input.displayName !== input.displayName.trim() ||
    input.displayName.length === 0 ||
    input.displayName.length > 160 ||
    /\p{Cc}/u.test(input.displayName)
  ) {
    throw new AccessGateConfigurationError(
      'Access-gate display name must be a bounded normalized value',
    );
  }
  SecurityAuditHashSchema.parse(input.subjectDigest);
  UuidSchema.parse(input.requestId);
  TimestampSchema.parse(input.checkedAt);
  if (input.source !== 'web' && input.source !== 'mobile') {
    throw new AccessGateConfigurationError(
      'Access-gate source must be a trusted interactive authentication adapter',
    );
  }
}

function accessGroupKey(source: AccessGroupSourceRef): string {
  return `${source.id}:${source.kind}:${source.purpose}`;
}

function isSameGroupSet(
  left: readonly AccessGroupSourceRef[],
  right: readonly AccessGroupSourceRef[],
): boolean {
  const leftKeys = left.map(accessGroupKey).sort();
  const rightKeys = right.map(accessGroupKey).sort();
  return (
    new Set(leftKeys).size === leftKeys.length &&
    new Set(rightKeys).size === rightKeys.length &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function parseCanonicalAccessGroupSet(
  values: readonly AccessGroupSourceRef[],
): readonly AccessGroupSourceRef[] | null {
  const parsed: AccessGroupSourceRef[] = [];
  for (const value of values) {
    const result = AccessGroupSourceRefSchema.safeParse(value);
    if (
      !result.success ||
      result.data.kind !== 'google-group' ||
      result.data.purpose !== 'access' ||
      result.data.facilityId !== null
    ) {
      return null;
    }
    parsed.push(result.data);
  }
  if (
    parsed.length === 0 ||
    new Set(parsed.map(({ id }) => id)).size !== parsed.length
  ) {
    return null;
  }
  return Object.freeze(parsed);
}

function isSameFacilityScope(
  left: FacilityScope,
  right: FacilityScope,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'district' || right.kind === 'district') {
    return true;
  }
  const leftIds = [...left.facilityIds].sort();
  const rightIds = [...right.facilityIds].sort();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}

function validateEvidence(
  evidence: AccessGateEvidence,
  input: AccessGateCheckInput,
):
  | Readonly<{
      granted: true;
      user: User;
      snapshot: AccessGateSnapshotEvidence;
      member: AccessGateMemberEvidence;
      firstLoginBinding: AccessGateFirstLoginBinding | null;
      designatedAdminEligible: boolean;
    }>
  | AccessGateDenied {
  if (evidence.activeAccessGroupSourceRefs.length === 0) {
    return { granted: false, reasonCode: 'NO_ACTIVE_ACCESS_GROUPS' };
  }
  const activeGroups = parseCanonicalAccessGroupSet(
    evidence.activeAccessGroupSourceRefs,
  );
  const explicitDesignated = evidence.designatedAccessGroupSourceRef;
  const designatedResult =
    explicitDesignated === undefined
      ? activeGroups?.length === 1
        ? AccessGroupSourceRefSchema.safeParse(activeGroups[0])
        : null
      : AccessGroupSourceRefSchema.safeParse(explicitDesignated);
  const designatedGroup =
    designatedResult !== null && designatedResult.success
      ? designatedResult.data
      : null;
  if (
    activeGroups === null ||
    evidence.activeAccessConfigurationExact === false ||
    designatedGroup === null ||
    activeGroups.length > 2 ||
    !activeGroups.some(
      (source) => accessGroupKey(source) === accessGroupKey(designatedGroup),
    )
  ) {
    return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
  }
  const designatedGroups = Object.freeze([designatedGroup]);
  const recoveryGroups = activeGroups.filter(
    (source) => accessGroupKey(source) !== accessGroupKey(designatedGroup),
  );
  const recoveryTransition = recoveryGroups.length === 1;
  if (
    recoveryTransition &&
    !UuidSchema.safeParse(evidence.transitionRecoveryUserId).success
  ) {
    return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
  }
  if (evidence.snapshot === null) {
    return { granted: false, reasonCode: 'ACCESS_SNAPSHOT_UNAVAILABLE' };
  }

  const snapshot = evidence.snapshot;
  const syncStartedAt = TimestampSchema.safeParse(snapshot.syncStartedAt);
  const capturedAt = TimestampSchema.safeParse(snapshot.capturedAt);
  const expectedGroups = parseCanonicalAccessGroupSet(
    snapshot.expectedAccessGroupSourceRefs,
  );
  const completedGroups = parseCanonicalAccessGroupSet(
    snapshot.completedAccessGroupSourceRefs,
  );
  if (
    !UuidSchema.safeParse(snapshot.id).success ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1 ||
    !syncStartedAt.success ||
    !capturedAt.success ||
    (syncStartedAt.success &&
      capturedAt.success &&
      Date.parse(capturedAt.data) < Date.parse(syncStartedAt.data)) ||
    expectedGroups === null ||
    completedGroups === null ||
    !isSameGroupSet(activeGroups, expectedGroups ?? []) ||
    !isSameGroupSet(expectedGroups ?? [], completedGroups ?? [])
  ) {
    return { granted: false, reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED' };
  }

  const activeGroupKeys = new Set(activeGroups.map(accessGroupKey));
  const evaluatedMember = snapshot.evaluatedMember ?? null;
  const evaluatedGroups = parseCanonicalAccessGroupSet(
    evaluatedMember?.accessGroupSourceRefs ?? [],
  );
  const hasExactEvaluatedMembership =
    evaluatedMember !== null &&
    evaluatedMember.email === input.email &&
    evaluatedGroups !== null &&
    isSameGroupSet(designatedGroups, evaluatedGroups);

  let user: User;
  let userDisposition: AccessGateFirstLoginBinding['userDisposition'];
  if (evidence.user !== null) {
    const userResult = UserSchema.safeParse(evidence.user);
    if (
      !userResult.success ||
      userResult.data.googleSubject !== input.googleSubject ||
      userResult.data.email !== input.email ||
      evidence.emailBindingConflict
    ) {
      return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
    }
    if (userResult.data.disabledAt !== null) {
      return { granted: false, reasonCode: 'USER_DISABLED' };
    }

    const member = snapshot.member;
    if (
      member !== null &&
      (member.userId !== userResult.data.id ||
        member.googleSubject !== input.googleSubject ||
        !FacilityScopeSchema.safeParse(member.facilityScope).success ||
        !isSameFacilityScope(
          userResult.data.facilityScope,
          member.facilityScope,
        ))
    ) {
      return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
    }
    const memberGroups =
      member === null
        ? Object.freeze([])
        : parseCanonicalAccessGroupSet(member.accessGroupSourceRefs);
    if (memberGroups === null) {
      return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
    }
    const activeMemberGroups = memberGroups.filter((source) =>
      activeGroupKeys.has(accessGroupKey(source)),
    );
    if (!isSameGroupSet(memberGroups, activeMemberGroups)) {
      return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
    }
    const hasDesignatedBoundMembership = isSameGroupSet(
      designatedGroups,
      activeMemberGroups,
    );
    if (!recoveryTransition && hasDesignatedBoundMembership) {
      return {
        granted: true,
        user: userResult.data,
        snapshot,
        member: Object.freeze({
          userId: userResult.data.id,
          googleSubject: userResult.data.googleSubject,
          accessGroupSourceRefs: designatedGroups,
          facilityScope: userResult.data.facilityScope,
        }),
        firstLoginBinding: null,
        designatedAdminEligible: true,
      };
    }
    const isSoleRecoveryAdministrator =
      recoveryTransition &&
      evidence.transitionRecoveryUserId === userResult.data.id &&
      userResult.data.roles.includes('admin') &&
      userResult.data.facilityScope.kind === 'district' &&
      evaluatedMember === null &&
      isSameGroupSet(recoveryGroups, activeMemberGroups);
    if (isSoleRecoveryAdministrator) {
      return {
        granted: true,
        user: userResult.data,
        snapshot,
        member: Object.freeze({
          userId: userResult.data.id,
          googleSubject: userResult.data.googleSubject,
          accessGroupSourceRefs: recoveryGroups,
          facilityScope: userResult.data.facilityScope,
        }),
        firstLoginBinding: null,
        designatedAdminEligible: false,
      };
    }
    if (
      (recoveryTransition && input.source !== 'mobile') ||
      !hasExactEvaluatedMembership ||
      userResult.data.facilityScope.kind !== 'district'
    ) {
      return { granted: false, reasonCode: 'ACCESS_GROUP_MEMBERSHIP_REQUIRED' };
    }
    user = userResult.data;
    userDisposition = 'existing';
  } else {
    if (evidence.emailBindingConflict) {
      return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
    }
    if (
      recoveryTransition ||
      !hasExactEvaluatedMembership ||
      evaluatedGroups === null
    ) {
      return { granted: false, reasonCode: 'ACCESS_GROUP_MEMBERSHIP_REQUIRED' };
    }
    user = UserSchema.parse({
      id: randomUUID(),
      googleSubject: input.googleSubject,
      email: input.email,
      displayName: input.displayName,
      roles: ['admin'],
      facilityScope: { kind: 'district' },
      createdAt: input.checkedAt,
      disabledAt: null,
    });
    userDisposition = 'create';
  }

  if (
    evaluatedMember === null ||
    evaluatedMember.email !== input.email ||
    evaluatedGroups === null ||
    !isSameGroupSet(designatedGroups, evaluatedGroups)
  ) {
    return { granted: false, reasonCode: 'ACCESS_GROUP_MEMBERSHIP_REQUIRED' };
  }
  const successorVersion = snapshot.version + 1;
  if (
    !Number.isSafeInteger(successorVersion) ||
    successorVersion > 2_147_483_647
  ) {
    return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
  }
  const successorSnapshotId = randomUUID();
  return {
    granted: true,
    user,
    snapshot: Object.freeze({
      ...snapshot,
      id: successorSnapshotId,
      version: successorVersion,
      member: null,
    }),
    member: Object.freeze({
      userId: user.id,
      googleSubject: user.googleSubject,
      accessGroupSourceRefs: evaluatedGroups,
      facilityScope: user.facilityScope,
    }),
    firstLoginBinding: Object.freeze({
      userDisposition,
      sourceSnapshotId: snapshot.id,
      sourceSnapshotVersion: snapshot.version,
      successorSnapshotId,
      successorSnapshotVersion: successorVersion,
      normalizedEmail: input.email,
    }),
    designatedAdminEligible: true,
  };
}

async function deny(
  input: AccessGateCheckInput,
  audit: AccessGateAuditSink,
  reasonCode: AccessGateDenialReason,
  userId: string | null,
): Promise<AccessGateDenied> {
  await audit.append({
    outcome: 'denied',
    requestId: input.requestId,
    occurredAt: input.checkedAt,
    subjectDigest: input.subjectDigest,
    reasonCode,
    userId,
    source: input.source,
  });
  return Object.freeze({ granted: false, reasonCode });
}

function validatedAuditUserId(evidence: AccessGateEvidence): string | null {
  const parsed = UuidSchema.safeParse(evidence.user?.id);
  return parsed.success ? parsed.data : null;
}

/**
 * Checks only the latest complete cached access snapshot. No request path in
 * this module contacts Google or treats an environment subject as membership.
 */
export async function checkAccessGate(
  input: AccessGateCheckInput,
  dependencies: AccessGateDependencies,
): Promise<AccessGateDecision> {
  validateCheckInput(input);
  const evidence = await dependencies.store.loadEvidence(
    input.googleSubject,
    input.email,
  );
  const evaluated = validateEvidence(evidence, input);
  if (!evaluated.granted) {
    return deny(
      input,
      dependencies.audit,
      evaluated.reasonCode,
      validatedAuditUserId(evidence),
    );
  }

  return Object.freeze({
    granted: true,
    user: evaluated.user,
    membership: Object.freeze({
      snapshotId: evaluated.snapshot.id,
      snapshotVersion: evaluated.snapshot.version,
      syncStartedAt: evaluated.snapshot.syncStartedAt,
      capturedAt: evaluated.snapshot.capturedAt,
      accessGroupSourceRefs: evaluated.member.accessGroupSourceRefs,
    }),
    firstLoginBinding: evaluated.firstLoginBinding,
    // The exact designated group is the complete admin rule. The temporary
    // bound recovery administrator never causes a new admin grant.
    bootstrapAdminEligible: evaluated.designatedAdminEligible,
  });
}

function parseFacilityScope(
  kind: 'district' | 'facilities',
  facilityIds: readonly string[],
): FacilityScope {
  if (kind === 'district' && facilityIds.length !== 0) {
    throw new AccessGateConfigurationError(
      'Persisted district facility scope cannot contain facility rows',
    );
  }
  return FacilityScopeSchema.parse(
    kind === 'district' ? { kind } : { kind, facilityIds },
  );
}

function parseAccessGroupRef(value: {
  readonly id: string;
  readonly kind: 'google-group' | 'synthetic';
  readonly purpose: 'access' | 'building' | 'others';
}): AccessGroupSourceRef {
  return AccessGroupSourceRefSchema.parse({
    id: value.id,
    kind: value.kind,
    purpose: value.purpose,
    facilityId: null,
  });
}

/** Creates a production access-evidence adapter over the committed schema. */
export function createDrizzleAccessGateStore(
  database: Database,
): AccessGateStore {
  return Object.freeze({
    async loadEvidence(
      googleSubject: string,
      normalizedEmail?: string,
    ): Promise<AccessGateEvidence> {
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`set transaction isolation level repeatable read, read only`,
        );

        const userRows = await transaction
          .select()
          .from(users)
          .where(eq(users.googleSubject, googleSubject))
          .limit(1);
        const userRow = userRows[0];
        const emailOwnerRows =
          normalizedEmail === undefined
            ? []
            : await transaction
                .select({
                  id: users.id,
                  googleSubject: users.googleSubject,
                })
                .from(users)
                .where(eq(users.email, normalizedEmail))
                .limit(2);
        const emailBindingConflict = emailOwnerRows.some(
          (owner) => owner.googleSubject !== googleSubject,
        );

        const accessGroupRows = await transaction
          .select({
            id: groupSources.id,
            kind: groupSources.kind,
            purpose: groupSources.purpose,
            active: groupSources.active,
            email: groupSources.email,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.kind, 'google-group'),
              eq(groupSources.purpose, 'access'),
            ),
          )
          .orderBy(asc(groupSources.id));
        const activeAccessGroupRows = accessGroupRows.filter(
          ({ active }) => active,
        );
        const activeAccessGroupSourceRefs =
          activeAccessGroupRows.map(parseAccessGroupRef);
        const designatedAccessGroupRows = activeAccessGroupRows.filter(
          ({ email }) => email === DESIGNATED_ACCESS_GROUP_EMAIL,
        );
        const designatedAccessGroupSourceRef =
          designatedAccessGroupRows.length === 1
            ? parseAccessGroupRef(designatedAccessGroupRows[0]!)
            : null;
        const activeAccessConfigurationExact =
          designatedAccessGroupSourceRef !== null &&
          activeAccessGroupRows.length <= 2;

        let user: AccessGateUserRecord | null = null;
        if (userRow !== undefined) {
          const roles = await loadEffectiveRoles(transaction, userRow.id);
          const userScopeRows = await transaction
            .select({ facilityId: userFacilityScopes.facilityId })
            .from(userFacilityScopes)
            .where(eq(userFacilityScopes.userId, userRow.id))
            .orderBy(asc(userFacilityScopes.facilityId));
          const userFacilityScope = parseFacilityScope(
            userRow.facilityScopeKind,
            userScopeRows.map((row) => row.facilityId),
          );
          user = {
            id: userRow.id,
            googleSubject: userRow.googleSubject,
            email: userRow.email,
            displayName: userRow.displayName,
            roles,
            facilityScope: userFacilityScope,
            createdAt: userRow.createdAt.toISOString(),
            disabledAt: userRow.disabledAt?.toISOString() ?? null,
          };
        }

        const snapshotRows = await transaction
          .select()
          .from(accessMembershipSnapshots)
          .where(eq(accessMembershipSnapshots.complete, true))
          .orderBy(
            desc(accessMembershipSnapshots.version),
            desc(accessMembershipSnapshots.capturedAt),
            desc(accessMembershipSnapshots.id),
          )
          .limit(1);
        const snapshotRow = snapshotRows[0];
        if (snapshotRow === undefined) {
          return {
            user,
            emailBindingConflict,
            activeAccessConfigurationExact,
            designatedAccessGroupSourceRef,
            transitionRecoveryUserId: null,
            activeAccessGroupSourceRefs,
            latestSuccessfulGroupSourceUpdateAt: null,
            snapshot: null,
          };
        }

        const snapshotGroupRows = await transaction
          .select({
            id: accessMembershipSnapshotGroups.groupSourceId,
            kind: accessMembershipSnapshotGroups.groupSourceKind,
            purpose: accessMembershipSnapshotGroups.groupPurpose,
            completionKind: accessMembershipSnapshotGroups.completionKind,
          })
          .from(accessMembershipSnapshotGroups)
          .where(eq(accessMembershipSnapshotGroups.snapshotId, snapshotRow.id))
          .orderBy(
            asc(accessMembershipSnapshotGroups.completionKind),
            asc(accessMembershipSnapshotGroups.groupSourceId),
          );
        const expectedAccessGroupSourceRefs = snapshotGroupRows
          .filter((row) => row.completionKind === 'expected')
          .map(parseAccessGroupRef);
        const completedAccessGroupSourceRefs = snapshotGroupRows
          .filter((row) => row.completionKind === 'completed')
          .map(parseAccessGroupRef);

        const evaluatedMemberRows =
          normalizedEmail === undefined
            ? []
            : await transaction
                .select({
                  email: accessMembershipEvaluatedMembers.email,
                  id: accessMembershipEvaluatedMembers.groupSourceId,
                  kind: accessMembershipEvaluatedMembers.groupSourceKind,
                  purpose: accessMembershipEvaluatedMembers.groupPurpose,
                })
                .from(accessMembershipEvaluatedMembers)
                .where(
                  and(
                    eq(
                      accessMembershipEvaluatedMembers.snapshotId,
                      snapshotRow.id,
                    ),
                    eq(accessMembershipEvaluatedMembers.email, normalizedEmail),
                  ),
                )
                .orderBy(asc(accessMembershipEvaluatedMembers.groupSourceId));
        const evaluatedMember =
          evaluatedMemberRows.length === 0 || normalizedEmail === undefined
            ? null
            : Object.freeze({
                email: normalizedEmail,
                accessGroupSourceRefs:
                  evaluatedMemberRows.map(parseAccessGroupRef),
              });

        const memberRows =
          userRow === undefined
            ? []
            : await transaction
                .select()
                .from(accessMembershipMembers)
                .where(
                  and(
                    eq(accessMembershipMembers.snapshotId, snapshotRow.id),
                    eq(accessMembershipMembers.userId, userRow.id),
                    eq(accessMembershipMembers.googleSubject, googleSubject),
                  ),
                )
                .limit(1);
        const memberRow = memberRows[0];
        let member: AccessGateMemberEvidence | null = null;
        if (memberRow !== undefined && userRow !== undefined) {
          const memberGroupRows = await transaction
            .select({
              id: accessMembershipMemberGroups.groupSourceId,
              kind: accessMembershipMemberGroups.groupSourceKind,
              purpose: accessMembershipMemberGroups.groupPurpose,
            })
            .from(accessMembershipMemberGroups)
            .where(
              and(
                eq(accessMembershipMemberGroups.snapshotId, snapshotRow.id),
                eq(accessMembershipMemberGroups.userId, userRow.id),
              ),
            )
            .orderBy(asc(accessMembershipMemberGroups.groupSourceId));
          const memberFacilityRows = await transaction
            .select({
              facilityId: accessMembershipMemberFacilities.facilityId,
            })
            .from(accessMembershipMemberFacilities)
            .where(
              and(
                eq(accessMembershipMemberFacilities.snapshotId, snapshotRow.id),
                eq(accessMembershipMemberFacilities.userId, userRow.id),
              ),
            )
            .orderBy(asc(accessMembershipMemberFacilities.facilityId));
          member = {
            userId: memberRow.userId,
            googleSubject: memberRow.googleSubject,
            accessGroupSourceRefs: memberGroupRows.map(parseAccessGroupRef),
            facilityScope: parseFacilityScope(
              memberRow.facilityScopeKind,
              memberFacilityRows.map((row) => row.facilityId),
            ),
          };
        }

        const transitionAdministratorUserIds =
          activeAccessGroupRows.length === 2
            ? await loadEffectiveAdministratorUserIds(transaction)
            : [];
        const transitionRecoveryUserId =
          transitionAdministratorUserIds.length === 1
            ? (transitionAdministratorUserIds[0] ?? null)
            : null;

        return {
          user,
          emailBindingConflict,
          activeAccessConfigurationExact,
          designatedAccessGroupSourceRef,
          transitionRecoveryUserId,
          activeAccessGroupSourceRefs,
          latestSuccessfulGroupSourceUpdateAt: null,
          snapshot: {
            id: snapshotRow.id,
            version: snapshotRow.version,
            syncStartedAt: snapshotRow.syncStartedAt.toISOString(),
            capturedAt: snapshotRow.capturedAt.toISOString(),
            expectedAccessGroupSourceRefs,
            completedAccessGroupSourceRefs,
            evaluatedMember,
            member,
          },
        };
      });
    },
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashAuditPayload(payload: unknown): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

/** Serialized predecessor needed to extend the append-only audit hash chain. */
export interface AccessGateAuditPredecessor {
  readonly sequence: number;
  readonly entryHash: string;
}

/** Shared transaction lock used by every access-audit append path. */
export const ACCESS_GATE_AUDIT_LOCK_SQL = sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-security-audit', 0))`;

/**
 * Builds one minimized audit fact after its caller has serialized the chain.
 * Database work remains with the caller so session creation can append inside
 * the same transaction as the session and bootstrap-role writes.
 */
export function buildAccessGateAuditEntry(
  event: AccessGateAuditEvent,
  previous: AccessGateAuditPredecessor | null,
): SecurityAuditEntry {
  UuidSchema.parse(event.requestId);
  TimestampSchema.parse(event.occurredAt);
  if (event.source !== 'web' && event.source !== 'mobile') {
    throw new AccessGateConfigurationError(
      'Access audit source must be web or mobile',
    );
  }
  if (event.outcome === 'denied') {
    if (event.subjectDigest !== null) {
      SecurityAuditHashSchema.parse(event.subjectDigest);
    }
    if (event.userId !== null) {
      UuidSchema.parse(event.userId);
    }
  } else {
    UuidSchema.parse(event.userId);
    UuidSchema.parse(event.sessionId);
  }

  const sequence = (previous?.sequence ?? 0) + 1;
  const previousHash = previous?.entryHash ?? null;
  const id = randomUUID();
  const principal =
    event.outcome === 'denied'
      ? {
          kind: 'unauthenticated' as const,
          subjectDigest: event.subjectDigest,
        }
      : {
          kind: 'human' as const,
          userId: event.userId,
          sessionId: event.sessionId,
        };
  const target =
    event.outcome === 'success'
      ? ({ kind: 'session' as const, id: event.sessionId } as const)
      : event.userId === null
        ? null
        : ({ kind: 'user' as const, id: event.userId } as const);
  const reasonCode = event.outcome === 'denied' ? event.reasonCode : null;
  const category = event.outcome === 'denied' ? 'access-denial' : 'sign-in';
  const hashPayload = {
    id,
    sequence,
    previousHash,
    category,
    action: ACCESS_GATE_AUDIT_ACTION,
    actionIds: [],
    confirmationId: null,
    outcome: event.outcome,
    principal,
    source: event.source,
    facilityId: null,
    target,
    requestId: event.requestId,
    reasonCode,
    occurredAt: event.occurredAt,
  } as const;
  return SecurityAuditEntrySchema.parse({
    ...hashPayload,
    entryHash: hashAuditPayload(hashPayload),
  });
}

/** Maps a validated contract entry to the Drizzle insert representation. */
export function toAccessGateAuditInsertValues(
  entry: SecurityAuditEntry,
): typeof securityAuditEntries.$inferInsert {
  return {
    id: entry.id,
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    entryHash: entry.entryHash,
    category: entry.category,
    action: entry.action,
    actionIds: entry.actionIds,
    confirmationId: entry.confirmationId,
    outcome: entry.outcome,
    principalKind: entry.principal.kind,
    principal: entry.principal,
    source: entry.source,
    facilityId: entry.facilityId,
    targetKind: entry.target?.kind ?? null,
    targetId: entry.target?.id ?? null,
    requestId: entry.requestId,
    reasonCode: entry.reasonCode,
    occurredAt: new Date(entry.occurredAt),
  };
}

/** Creates the production minimized, serialized, append-only audit writer. */
export function createDrizzleAccessGateAuditSink(
  database: Database,
): AccessGateAuditSink {
  return Object.freeze({
    async append(event: AccessGateAuditEvent): Promise<SecurityAuditEntry> {
      return database.transaction(async (transaction) => {
        await transaction.execute(ACCESS_GATE_AUDIT_LOCK_SQL);
        const previousRows = await transaction
          .select({
            sequence: securityAuditEntries.sequence,
            entryHash: securityAuditEntries.entryHash,
          })
          .from(securityAuditEntries)
          .orderBy(desc(securityAuditEntries.sequence))
          .limit(1);
        const entry = buildAccessGateAuditEntry(event, previousRows[0] ?? null);

        await transaction
          .insert(securityAuditEntries)
          .values(toAccessGateAuditInsertValues(entry));
        return entry;
      });
    },
  });
}
