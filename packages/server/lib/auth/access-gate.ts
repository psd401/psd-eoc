import { createHash, randomUUID } from 'node:crypto';

import {
  AccessGroupSourceRefSchema,
  FacilityScopeSchema,
  RoleSchema,
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
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  securityAuditEntries,
  userFacilityScopes,
  userRoles,
  users,
} from '../../db/schema';
import type { GoogleOidcCallbackErrorCode } from './oidc';
import type { WebSessionIssuanceErrorCode } from './session-cookie';

/** Environment variable containing comma-separated immutable Google subjects. */
export const BOOTSTRAP_ADMIN_SUBJECTS_ENV =
  'PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS' as const;

const ACCESS_GATE_AUDIT_ACTION = 'complete-oidc-sign-in' as const;

/** Safe fallback when a post-gate failure has no narrower reason taxonomy. */
export const POST_GATE_SIGN_IN_FAILED_REASON =
  'POST_GATE_SIGN_IN_FAILED' as const;

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
  readonly member: AccessGateMemberEvidence | null;
}

/** One consistent read of identity, active configuration, and cached evidence. */
export interface AccessGateEvidence {
  readonly user: AccessGateUserRecord | null;
  readonly activeAccessGroupSourceRefs: readonly AccessGroupSourceRef[];
  /** Latest canonical source update that requires a newer access sync. */
  readonly latestSuccessfulGroupSourceUpdateAt: string | null;
  readonly snapshot: AccessGateSnapshotEvidence | null;
}

/** Persistence boundary used by the gate and easily replaced by a test fake. */
export interface AccessGateStore {
  loadEvidence(googleSubject: string): Promise<AccessGateEvidence>;
}

/** Data required to correlate a pre-session access decision without raw PII. */
export interface AccessGateCheckInput {
  readonly googleSubject: string;
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

export interface AccessGateGranted {
  readonly granted: true;
  readonly user: User;
  readonly membership: AccessGateMembershipGrant;
  /**
   * True only after ordinary group authorization succeeds for a configured
   * bootstrap subject. The canonical sign-in capability owns the role write.
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
  readonly bootstrapAdminSubjects?: ReadonlySet<string>;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads immutable Google subjects used only for role recovery. Membership in a
 * currently configured access group remains mandatory for these subjects.
 */
export function readBootstrapAdminSubjects(
  environment: Environment = process.env,
): ReadonlySet<string> {
  const configured = environment[BOOTSTRAP_ADMIN_SUBJECTS_ENV];
  if (configured === undefined || configured.trim().length === 0) {
    return new Set<string>();
  }

  const values = configured.split(',').map((value) => value.trim());
  if (
    values.length > 50 ||
    values.some((value) => value.length === 0 || value.length > 255) ||
    new Set(values).size !== values.length
  ) {
    throw new AccessGateConfigurationError(
      `${BOOTSTRAP_ADMIN_SUBJECTS_ENV} must contain 1-50 unique, comma-separated immutable subjects`,
    );
  }
  return new Set(values);
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
  googleSubject: string,
):
  | Readonly<{
      granted: true;
      user: User;
      snapshot: AccessGateSnapshotEvidence;
      member: AccessGateMemberEvidence;
    }>
  | AccessGateDenied {
  if (evidence.user === null) {
    return { granted: false, reasonCode: 'UNKNOWN_USER' };
  }

  const userResult = UserSchema.safeParse(evidence.user);
  if (!userResult.success || userResult.data.googleSubject !== googleSubject) {
    return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
  }
  if (userResult.data.disabledAt !== null) {
    return { granted: false, reasonCode: 'USER_DISABLED' };
  }

  const activeGroups = evidence.activeAccessGroupSourceRefs.map((source) =>
    AccessGroupSourceRefSchema.safeParse(source),
  );
  if (activeGroups.some((result) => !result.success)) {
    return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
  }
  if (activeGroups.length === 0) {
    return { granted: false, reasonCode: 'NO_ACTIVE_ACCESS_GROUPS' };
  }
  if (evidence.snapshot === null) {
    return { granted: false, reasonCode: 'ACCESS_SNAPSHOT_UNAVAILABLE' };
  }

  const snapshot = evidence.snapshot;
  const syncStartedAt = TimestampSchema.safeParse(snapshot.syncStartedAt);
  const capturedAt = TimestampSchema.safeParse(snapshot.capturedAt);
  const latestSourceUpdateAt =
    evidence.latestSuccessfulGroupSourceUpdateAt === null
      ? null
      : TimestampSchema.safeParse(evidence.latestSuccessfulGroupSourceUpdateAt);
  if (
    !UuidSchema.safeParse(snapshot.id).success ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1 ||
    !syncStartedAt.success ||
    !capturedAt.success ||
    (syncStartedAt.success &&
      capturedAt.success &&
      Date.parse(capturedAt.data) < Date.parse(syncStartedAt.data)) ||
    (latestSourceUpdateAt !== null && !latestSourceUpdateAt.success) ||
    (latestSourceUpdateAt !== null &&
      latestSourceUpdateAt.success &&
      Date.parse(syncStartedAt.data) <=
        Date.parse(latestSourceUpdateAt.data)) ||
    !isSameGroupSet(
      evidence.activeAccessGroupSourceRefs,
      snapshot.expectedAccessGroupSourceRefs,
    ) ||
    !isSameGroupSet(
      snapshot.expectedAccessGroupSourceRefs,
      snapshot.completedAccessGroupSourceRefs,
    )
  ) {
    return { granted: false, reasonCode: 'ACCESS_CONFIGURATION_NOT_SYNCED' };
  }

  const member = snapshot.member;
  if (member === null) {
    return { granted: false, reasonCode: 'ACCESS_GROUP_MEMBERSHIP_REQUIRED' };
  }
  if (
    member.userId !== userResult.data.id ||
    member.googleSubject !== googleSubject ||
    !FacilityScopeSchema.safeParse(member.facilityScope).success ||
    !isSameFacilityScope(userResult.data.facilityScope, member.facilityScope)
  ) {
    return { granted: false, reasonCode: 'ACCESS_EVIDENCE_INVALID' };
  }

  const activeGroupKeys = new Set(
    evidence.activeAccessGroupSourceRefs.map(accessGroupKey),
  );
  const memberGroups = member.accessGroupSourceRefs.map((source) =>
    AccessGroupSourceRefSchema.safeParse(source),
  );
  if (
    memberGroups.length === 0 ||
    memberGroups.some((result) => !result.success) ||
    !member.accessGroupSourceRefs.every((source) =>
      activeGroupKeys.has(accessGroupKey(source)),
    )
  ) {
    return { granted: false, reasonCode: 'ACCESS_GROUP_MEMBERSHIP_REQUIRED' };
  }

  return {
    granted: true,
    user: userResult.data,
    snapshot,
    member,
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
  const evidence = await dependencies.store.loadEvidence(input.googleSubject);
  const evaluated = validateEvidence(evidence, input.googleSubject);
  if (!evaluated.granted) {
    return deny(
      input,
      dependencies.audit,
      evaluated.reasonCode,
      validatedAuditUserId(evidence),
    );
  }

  const bootstrapAdminSubjects =
    dependencies.bootstrapAdminSubjects ?? readBootstrapAdminSubjects();
  const bootstrapAdmin = bootstrapAdminSubjects.has(input.googleSubject);

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
    bootstrapAdminEligible: bootstrapAdmin,
  });
}

function parseFacilityScope(
  kind: 'district' | 'facilities',
  facilityIds: readonly string[],
): FacilityScope {
  return FacilityScopeSchema.parse(
    kind === 'district' ? { kind } : { kind, facilityIds },
  );
}

function parseAccessGroupRef(value: {
  readonly id: string;
  readonly kind: 'google-group' | 'synthetic';
  readonly purpose: 'access' | 'building' | 'others';
}): AccessGroupSourceRef {
  return AccessGroupSourceRefSchema.parse({ ...value, facilityId: null });
}

/** Creates a production access-evidence adapter over the committed schema. */
export function createDrizzleAccessGateStore(
  database: Database,
): AccessGateStore {
  return Object.freeze({
    async loadEvidence(googleSubject: string): Promise<AccessGateEvidence> {
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

        const activeGroupRows = await transaction
          .select({
            id: groupSources.id,
            kind: groupSources.kind,
            purpose: groupSources.purpose,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.kind, 'google-group'),
              eq(groupSources.purpose, 'access'),
              eq(groupSources.active, true),
            ),
          );
        const activeAccessGroupSourceRefs =
          activeGroupRows.map(parseAccessGroupRef);

        const [latestSuccessfulGroupSourceUpdate] = await transaction
          .select({ occurredAt: securityAuditEntries.occurredAt })
          .from(securityAuditEntries)
          .where(
            and(
              eq(securityAuditEntries.action, 'update-group-source'),
              eq(securityAuditEntries.outcome, 'success'),
            ),
          )
          .orderBy(
            desc(securityAuditEntries.occurredAt),
            desc(securityAuditEntries.sequence),
          )
          .limit(1);
        const latestSuccessfulGroupSourceUpdateAt =
          latestSuccessfulGroupSourceUpdate?.occurredAt.toISOString() ?? null;

        if (userRow === undefined) {
          return {
            user: null,
            activeAccessGroupSourceRefs,
            latestSuccessfulGroupSourceUpdateAt,
            snapshot: null,
          };
        }

        const roleRows = await transaction
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(eq(userRoles.userId, userRow.id));
        const roles = roleRows.map((row) => RoleSchema.parse(row.role));

        const userScopeRows = await transaction
          .select({ facilityId: userFacilityScopes.facilityId })
          .from(userFacilityScopes)
          .where(eq(userFacilityScopes.userId, userRow.id));
        const userFacilityScope = parseFacilityScope(
          userRow.facilityScopeKind,
          userScopeRows.map((row) => row.facilityId),
        );
        const user: AccessGateUserRecord = {
          id: userRow.id,
          googleSubject: userRow.googleSubject,
          email: userRow.email,
          displayName: userRow.displayName,
          roles,
          facilityScope: userFacilityScope,
          createdAt: userRow.createdAt.toISOString(),
          disabledAt: userRow.disabledAt?.toISOString() ?? null,
        };

        const snapshotRows = await transaction
          .select()
          .from(accessMembershipSnapshots)
          .where(eq(accessMembershipSnapshots.complete, true))
          .orderBy(desc(accessMembershipSnapshots.version))
          .limit(1);
        const snapshotRow = snapshotRows[0];
        if (snapshotRow === undefined) {
          return {
            user,
            activeAccessGroupSourceRefs,
            latestSuccessfulGroupSourceUpdateAt,
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
          .where(eq(accessMembershipSnapshotGroups.snapshotId, snapshotRow.id));
        const expectedAccessGroupSourceRefs = snapshotGroupRows
          .filter((row) => row.completionKind === 'expected')
          .map(parseAccessGroupRef);
        const completedAccessGroupSourceRefs = snapshotGroupRows
          .filter((row) => row.completionKind === 'completed')
          .map(parseAccessGroupRef);

        const memberRows = await transaction
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
        if (memberRow !== undefined) {
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
            );
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
            );
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

        return {
          user,
          activeAccessGroupSourceRefs,
          latestSuccessfulGroupSourceUpdateAt,
          snapshot: {
            id: snapshotRow.id,
            version: snapshotRow.version,
            syncStartedAt: snapshotRow.syncStartedAt.toISOString(),
            capturedAt: snapshotRow.capturedAt.toISOString(),
            expectedAccessGroupSourceRefs,
            completedAccessGroupSourceRefs,
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
