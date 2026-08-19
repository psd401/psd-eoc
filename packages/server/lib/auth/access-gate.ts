import { createHash, randomUUID } from 'node:crypto';

import {
  SecurityAuditEntrySchema,
  SecurityAuditHashSchema,
  TimestampSchema,
  UuidSchema,
  type AccessGroupSourceRef,
  type FacilityScope,
  type Role,
  type SecurityAuditEntry,
  type User,
} from '@psd-eoc/contracts';
import { desc, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { securityAuditEntries } from '../../db/schema';
import type { GoogleOidcCallbackErrorCode } from './oidc';
import type { WebSessionIssuanceErrorCode } from './session-cookie';

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
  /** Sole reachable bound administrator during the two-source recovery stage. */
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
  /** Protected one-time selector used only while recovery remains active. */
  readonly transitionEmailDigest: string | null;
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
  /** Trusted deployment configuration; never accepted from a request body. */
  readonly initialMobileTransitionEmailDigest?: string | null;
}

/**
 * Parses the protected one-time mobile-transition selector without retaining
 * or reflecting its value. Absence fails the staged transition closed.
 */
export function parseInitialMobileTransitionEmailDigest(
  value: string | undefined,
): string | null {
  if (value === undefined) {
    return null;
  }
  const parsed = SecurityAuditHashSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccessGateConfigurationError(
      'Initial mobile transition email digest must be a SHA-256 digest',
    );
  }
  return parsed.data;
}

// The sign-in decision that lived here is gone. It validated a versioned
// access-membership generation: the latest complete snapshot's group set had
// to equal the active access group set exactly, membership carried expected
// and completed marker rows, and a person's evaluated groups were compared
// against a group fixed at compile time. That rule denied everyone whenever
// the configuration changed and refused anyone not in every configured group.
//
// `decideAccess` and `authorizeSignIn` replace it. What remains in this module
// is the append-only audit of sign-in outcomes and the lock that serializes
// it, which are a real capability rather than gate logic.

/** Deterministic JSON so an audit hash does not depend on key order. */
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
