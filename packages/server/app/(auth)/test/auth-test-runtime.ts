import { createHash, randomUUID } from 'node:crypto';

import {
  SecurityAuditEntrySchema,
  SessionEstablishmentResultSchema,
  type SecurityAuditEntry,
  type SessionEstablishmentResult,
} from '@psd-eoc/contracts';

import type { User } from '@psd-eoc/contracts';
import type {
  AccessGateAuditEvent,
  AccessGateAuditSink,
  AccessGateEvidence,
  AccessGateStore,
} from '../../../lib/auth/access-gate';
import {
  WebSessionIssuanceError,
  type InitialWebSessionStore,
  type PersistInitialWebSessionRequest,
} from '../../../lib/auth/session-cookie';

/** Synthetic starting configuration requested for issue #6. */
export const PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION = Object.freeze({
  id: '00000000-0000-4000-8000-000000000106',
  email: 'tsd-engineering@psd401.net',
  kind: 'google-group' as const,
  purpose: 'access' as const,
  facilityId: null,
});
export const PLAYWRIGHT_MEMBER_SUBJECT = 'mock-google-subject-member' as const;
export const PLAYWRIGHT_NONMEMBER_SUBJECT =
  'mock-google-subject-nonmember' as const;

const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000116';
const MEMBER_USER_ID = '00000000-0000-4000-8000-000000000126';
const NONMEMBER_USER_ID = '00000000-0000-4000-8000-000000000136';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const accessGroupSourceRef = Object.freeze({
  id: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.id,
  kind: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.kind,
  purpose: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.purpose,
  facilityId: PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.facilityId,
});

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function syntheticEvidence(googleSubject: string): AccessGateEvidence {
  const now = Date.now();
  const syncStartedAt = timestamp(now - 120_000);
  const capturedAt = timestamp(now - 60_000);
  const createdAt = timestamp(now - 86_400_000);
  const user =
    googleSubject === PLAYWRIGHT_MEMBER_SUBJECT
      ? {
          id: MEMBER_USER_ID,
          googleSubject,
          email: 'member@psd401.net',
          displayName: 'Synthetic Member',
          roles: ['staff' as const],
          facilityScope: { kind: 'district' as const },
          createdAt,
          disabledAt: null,
        }
      : googleSubject === PLAYWRIGHT_NONMEMBER_SUBJECT
        ? {
            id: NONMEMBER_USER_ID,
            googleSubject,
            email: 'nonmember@psd401.net',
            displayName: 'Synthetic Non-member',
            roles: ['staff' as const],
            facilityScope: { kind: 'district' as const },
            createdAt,
            disabledAt: null,
          }
        : null;

  return {
    user,
    activeAccessGroupSourceRefs: [accessGroupSourceRef],
    latestSuccessfulGroupSourceUpdateAt: null,
    snapshot:
      user === null
        ? null
        : {
            id: SNAPSHOT_ID,
            version: 1,
            syncStartedAt,
            capturedAt,
            expectedAccessGroupSourceRefs: [accessGroupSourceRef],
            completedAccessGroupSourceRefs: [accessGroupSourceRef],
            member:
              googleSubject === PLAYWRIGHT_MEMBER_SUBJECT
                ? {
                    userId: MEMBER_USER_ID,
                    googleSubject,
                    accessGroupSourceRefs: [accessGroupSourceRef],
                    facilityScope: { kind: 'district' },
                  }
                : null,
          },
  };
}

export interface PlaywrightAuthRuntime {
  readonly authorize: (
    input: Readonly<{
      googleSubject: string;
      email: string;
      displayName: string;
      checkedAt: Date;
    }>,
  ) => Promise<
    | Readonly<{
        authorized: true;
        user: User;
        groupSourceIds: readonly string[];
        created: boolean;
      }>
    | Readonly<{
        authorized: false;
        refusal:
          | 'NO_TRUSTED_GROUPS_CONFIGURED'
          | 'NOT_IN_A_TRUSTED_GROUP'
          | 'MEMBERSHIP_STALE'
          | 'ACCOUNT_DISABLED';
      }>
  >;
  readonly accessStore: AccessGateStore;
  readonly auditSink: AccessGateAuditSink;
  readonly sessionStore: InitialWebSessionStore;
  readonly auditEntries: readonly SecurityAuditEntry[];
}

/** Creates a fail-closed, process-local backend used only by the E2E server. */
export function createPlaywrightAuthRuntime(): PlaywrightAuthRuntime {
  const auditEntries: SecurityAuditEntry[] = [];
  const consumedOidcCallbacks = new Set<string>();

  const accessStore: AccessGateStore = Object.freeze({
    async loadEvidence(googleSubject: string): Promise<AccessGateEvidence> {
      return syntheticEvidence(googleSubject);
    },
  });

  const auditSink: AccessGateAuditSink = Object.freeze({
    async append(event: AccessGateAuditEvent): Promise<SecurityAuditEntry> {
      const sequence = auditEntries.length + 1;
      const previousHash = auditEntries.at(-1)?.entryHash ?? null;
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
        event.outcome === 'denied' && event.userId === null
          ? null
          : {
              kind:
                event.outcome === 'success'
                  ? ('session' as const)
                  : ('user' as const),
              id:
                event.outcome === 'success'
                  ? event.sessionId
                  : (event.userId ?? ''),
            };
      const reasonCode = event.outcome === 'denied' ? event.reasonCode : null;
      const hashPayload = JSON.stringify({
        sequence,
        previousHash,
        event,
      });
      const entryHash = createHash('sha256')
        .update(hashPayload, 'utf8')
        .digest('hex');
      if (!HASH_PATTERN.test(entryHash)) {
        throw new Error('Synthetic audit hashing failed.');
      }
      const entry = SecurityAuditEntrySchema.parse({
        id: randomUUID(),
        sequence,
        previousHash,
        entryHash,
        category: event.outcome === 'denied' ? 'access-denial' : 'sign-in',
        action: 'complete-oidc-sign-in',
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
      });
      auditEntries.push(entry);
      return entry;
    },
  });

  const sessionStore: InitialWebSessionStore = Object.freeze({
    async persist(
      request: PersistInitialWebSessionRequest,
    ): Promise<SessionEstablishmentResult> {
      const idempotencyScope = [
        'complete-oidc-sign-in',
        request.idempotency.principalDigest,
        request.idempotency.key,
      ].join(':');
      if (consumedOidcCallbacks.has(idempotencyScope)) {
        throw new WebSessionIssuanceError(
          'SESSION_REPLAY_REJECTED',
          'The verified OIDC callback was already consumed.',
        );
      }
      consumedOidcCallbacks.add(idempotencyScope);

      const sessionId = randomUUID();
      const deviceEnrollmentId = randomUUID();
      // Roles are what the trusted groups granted; the harness does not add
      // any, because nothing in the product does any more.
      const roles = request.user.roles;
      const result = SessionEstablishmentResultSchema.parse({
        user: { ...request.user, roles },
        session: {
          id: sessionId,
          userId: request.user.id,
          deviceEnrollmentId,
          createdAt: request.createdAt.toISOString(),
          expiresAt: request.expiresAt.toISOString(),
          authorization: {
            kind: 'group-membership',
            source: 'google-group-snapshot',
            membershipSnapshotId: null,
            membershipValidUntil: request.membershipValidUntil.toISOString(),
            membershipGraceUntil: request.membershipGraceUntil.toISOString(),
          },
          revokedAt: null,
        },
        deviceEnrollment: {
          id: deviceEnrollmentId,
          userId: request.user.id,
          platform: request.device.platform,
          unlockMethod: request.device.unlockMethod,
          installationId: request.device.installationId,
          enrolledAt: request.createdAt.toISOString(),
          lastSeenAt: request.createdAt.toISOString(),
          revokedAt: null,
        },
        connectivityEpoch: {
          id: randomUUID(),
          sessionId,
          establishedAt: request.createdAt.toISOString(),
        },
      });
      await auditSink.append({
        outcome: 'success',
        requestId: request.requestId,
        occurredAt: request.createdAt.toISOString(),
        userId: result.user.id,
        sessionId: result.session.id,
        source: request.device.platform === 'web' ? 'web' : 'mobile',
      });
      return result;
    },
  });

  return Object.freeze({
    // The harness reuses the same synthetic identities the evidence builder
    // knows about. Deciding group membership is the product's job; this fake
    // only says which invented principal is a member.
    async authorize(input: Readonly<{ googleSubject: string }>) {
      const evidence = syntheticEvidence(input.googleSubject);
      const user = evidence.user;
      return user === null || input.googleSubject !== PLAYWRIGHT_MEMBER_SUBJECT
        ? Object.freeze({
            authorized: false as const,
            refusal: 'NOT_IN_A_TRUSTED_GROUP' as const,
          })
        : Object.freeze({
            authorized: true as const,
            user,
            groupSourceIds: Object.freeze([
              PLAYWRIGHT_ACCESS_GROUP_CONFIGURATION.id,
            ]),
            created: false,
          });
    },
    accessStore,
    auditSink,
    sessionStore,
    auditEntries,
  });
}

let sharedRuntime: PlaywrightAuthRuntime | undefined;

export function getPlaywrightAuthRuntime(): PlaywrightAuthRuntime {
  sharedRuntime ??= createPlaywrightAuthRuntime();
  return sharedRuntime;
}
