import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { decideAccess } from './trusted-group-access';
import {
  AccessMembershipMemberSchema,
  CapabilityScopeSchema,
  DeviceEnrollmentPageSchema,
  DeviceEnrollmentSchema,
  DeviceSessionPageSchema,
  FacilityScopeSchema,
  IdempotencyKeySchema,
  IdempotencyPrincipalSchema,
  SessionEstablishmentResultSchema,
  SessionRevocationSchema,
  SessionSchema,
  UserSchema,
  VerifiedCurrentRefreshCredentialSchema,
  executeCapability,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  type Actor,
  type CapabilityExecutionAuthorizer,
  type CapabilityScope,
  type DeviceEnrollment,
  type DeviceEnrollmentPage,
  type DevicePlatform,
  type DeviceSessionPage,
  type FacilityScope,
  type IdempotencyKey,
  type InvocationSource,
  type ListDeviceSessionsInput,
  type ListMyDevicesInput,
  type RefreshCredentialRecordRef,
  type Role,
  type SessionEstablishmentResult,
  type SessionRevocation,
  type VerifiedCurrentRefreshCredential,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
} from '../../db/client';
import {
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  connectivityEpochInvalidations,
  connectivityEpochs,
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  idempotencyRecords,
  sessionRevocations,
  sessions,
  sessionTokenIssuances,
  sessionTokenReplays,
  sessionTokenRotations,
  userFacilityScopes,
  users,
} from '../../db/schema';
import { loadEffectiveRoles, type RoleStateDatabase } from './role-state';

const SECOND_MS = 1_000;
const DAY_SECONDS = 24 * 60 * 60;
const REFRESH_TOKEN_BYTES = 32;
const REFRESH_RETRY_RECOVERY_SECONDS = 5 * 60;
const SESSION_LIST_READ_CONCURRENCY = 8;
const SESSIONS_PER_DEVICE_SUMMARY = 100;
const REFRESH_RESULT_PREFIX = 'refresh-v1';
const REVOCATION_RESULT_PREFIX = 'session-revocation-v1';
const DEFAULT_SESSION_AUTHENTICATION_TIMEOUT_MILLISECONDS = 5_000;
const CONNECTION_DESTROYED_CODE = 'CONNECTION_DESTROYED';

/**
 * Default session policy.
 *
 * Membership is fresh for 24 hours, then remains usable for a configurable
 * 72-hour outage grace. The exact grace deadline is denied and requires fresh
 * Google-backed membership evidence. Session and device revocations are read from the
 * database on every request, so they do not wait on the membership TTL/grace
 * and take effect immediately (strictly better than the required 60 seconds).
 */
export const DEFAULT_SESSION_POLICY = Object.freeze({
  sessionLifetimeSeconds: 90 * DAY_SECONDS,
  membershipTtlSeconds: DAY_SECONDS,
  membershipGraceSeconds: 3 * DAY_SECONDS,
});

export const MAX_REVOCATION_STALENESS_SECONDS = 60;
export const WEB_SESSION_COOKIE_NAME = '__Host-psd-eoc-session';
export const WEB_CSRF_COOKIE_NAME = '__Host-psd-eoc-csrf';

export interface SessionPolicy {
  readonly sessionLifetimeSeconds: number;
  readonly membershipTtlSeconds: number;
  /** Additional time after membership TTL expiry, not an absolute lifetime. */
  readonly membershipGraceSeconds: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

export class SessionConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SessionConfigurationError';
  }
}

function readBoundedInteger(
  environment: Environment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(rawValue.trim())) {
    throw new SessionConfigurationError(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SessionConfigurationError(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

/** Reads explicit, bounded TTL/grace configuration and fails closed. */
export function readSessionPolicy(
  environment: Environment = process.env,
): SessionPolicy {
  return Object.freeze({
    sessionLifetimeSeconds: readBoundedInteger(
      environment,
      'PSD_EOC_SESSION_LIFETIME_SECONDS',
      DEFAULT_SESSION_POLICY.sessionLifetimeSeconds,
      DAY_SECONDS,
      365 * DAY_SECONDS,
    ),
    membershipTtlSeconds: readBoundedInteger(
      environment,
      'PSD_EOC_MEMBERSHIP_TTL_SECONDS',
      DEFAULT_SESSION_POLICY.membershipTtlSeconds,
      5 * 60,
      7 * DAY_SECONDS,
    ),
    membershipGraceSeconds: readBoundedInteger(
      environment,
      'PSD_EOC_MEMBERSHIP_GRACE_SECONDS',
      DEFAULT_SESSION_POLICY.membershipGraceSeconds,
      60,
      14 * DAY_SECONDS,
    ),
  });
}

export type SessionAccessErrorCode =
  | 'AMBIGUOUS_CREDENTIAL'
  | 'CONFIGURATION_ERROR'
  | 'DEVICE_REVOKED'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CREDENTIAL'
  | 'INVALID_MEMBERSHIP_EVIDENCE'
  | 'MEMBERSHIP_GRACE_EXPIRED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'TOKEN_REPLAY'
  | 'USER_DISABLED';

const errorStatus = {
  AMBIGUOUS_CREDENTIAL: 401,
  CONFIGURATION_ERROR: 500,
  DEVICE_REVOKED: 401,
  FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_CREDENTIAL: 401,
  INVALID_MEMBERSHIP_EVIDENCE: 403,
  MEMBERSHIP_GRACE_EXPIRED: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  TOKEN_REPLAY: 401,
  USER_DISABLED: 403,
} as const satisfies Record<SessionAccessErrorCode, number>;

/** A bounded, credential-free failure safe to translate to the REST model. */
export class SessionAccessError extends Error {
  public readonly status: number;

  public constructor(
    public readonly code: SessionAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionAccessError';
    this.status = errorStatus[code];
  }
}

function timestamp(date: Date): string {
  return date.toISOString();
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * SECOND_MS);
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

/** Accepts issue #7 refresh bearers and issue #6 initial OIDC credentials. */
export function isOpaqueSessionCredential(value: string): boolean {
  return /^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})$/u.test(value);
}

function assertOpaqueRefreshToken(value: string): void {
  if (!isOpaqueSessionCredential(value)) {
    throw new SessionAccessError(
      'INVALID_CREDENTIAL',
      'The session credential is invalid.',
    );
  }
}

/** Creates a 256-bit opaque bearer. The plaintext is never persisted. */
export function createOpaqueRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/** Produces the sole persisted representation of an opaque session bearer. */
export function hashRefreshToken(token: string): string {
  assertOpaqueRefreshToken(token);
  return digestText(token);
}

/**
 * Deterministically derives the successor only for idempotent response
 * recovery. The high-entropy current bearer is the HMAC key; persistence still
 * receives only SHA-256 digests.
 */
function deriveSuccessorToken(
  currentToken: string,
  sessionId: string,
  deviceEnrollmentId: string,
  idempotencyKey: IdempotencyKey,
): string {
  assertOpaqueRefreshToken(currentToken);
  return createHmac('sha256', currentToken)
    .update(
      `psd-eoc-refresh-v1\0${sessionId}\0${deviceEnrollmentId}\0${idempotencyKey}`,
      'utf8',
    )
    .digest('base64url');
}

export interface EstablishDeviceSessionInput {
  readonly userId: string;
  readonly membershipSnapshotId: string | null;
  readonly device: Readonly<{
    platform: DevicePlatform;
    unlockMethod: 'secure-session-cookie' | 'biometric';
    installationId: string;
  }>;
}

export interface IssuedDeviceSession {
  readonly result: SessionEstablishmentResult;
  /** Transport-only secret; callers must place it in SecureStore/cookie. */
  readonly refreshToken: string;
}

export interface AuthenticatedSession {
  readonly actor: Extract<Actor, { readonly kind: 'human' }>;
  readonly source: Extract<InvocationSource, 'web' | 'mobile'>;
  /** Digest of the bearer verified for this request; never the bearer itself. */
  readonly presentedTokenDigest?: string;
  readonly roles: readonly Role[];
  readonly scope: CapabilityScope;
  readonly membershipState: 'fresh' | 'grace';
  readonly result: SessionEstablishmentResult;
}

export interface StoredSessionContext {
  readonly result: SessionEstablishmentResult;
  /** Latest complete cached evidence considered for this authorization read. */
  /** Null for sessions issued after the trusted-group cutover. */
  readonly membershipSnapshotId: string | null;
  readonly membershipCapturedAt: Date;
  readonly membershipScope: FacilityScope;
  /** False keeps retained sessions manageable but never authorizes app use. */
  readonly membershipAccessActive: boolean;
  readonly revocation: SessionRevocation | null;
  readonly connectivityEpochActive: boolean;
}

interface CurrentCredential {
  readonly kind: 'current';
  readonly context: StoredSessionContext;
  readonly recordRef: RefreshCredentialRecordRef;
  readonly generation: number;
  readonly tokenDigest: string;
}

interface RetiredCredential {
  readonly kind: 'retired';
  readonly sessionId: string;
  readonly deviceEnrollmentId: string;
  readonly rotationId: string;
  readonly tokenDigest: string;
}

interface UnknownCredential {
  readonly kind: 'unknown';
  readonly tokenDigest: string;
}

export type StoredCredential =
  | CurrentCredential
  | RetiredCredential
  | UnknownCredential;

export interface RotateCredentialInput {
  readonly principal: VerifiedCurrentRefreshCredential;
  readonly nextTokenDigest: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestDigest: string;
  readonly rotatedAt: Date;
  readonly rotationId: string;
  readonly connectivityEpochId: string;
  readonly membershipTtlSeconds: number;
  readonly membershipGraceSeconds: number;
}

export interface CompletedRefreshRetryInput {
  readonly retired: RetiredCredential;
  readonly successorDigest: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestDigest: string;
  readonly checkedAt: Date;
}

export interface RecordReplayInput {
  readonly retired: RetiredCredential;
  readonly detectedAt: Date;
}

export interface RevokeStoredSessionInput {
  readonly actor: Extract<Actor, { readonly kind: 'human' }>;
  readonly sessionId: string;
  readonly reasonCode: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestDigest: string;
  readonly revokedAt: Date;
}

export interface CompletedSelfRevocationRetryInput {
  readonly presentedTokenDigest: string;
  readonly sessionId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestDigest: string;
}

type SessionMutationDatabase = Pick<Database, 'insert' | 'select'>;

async function appendDevicePushTokenUnregistrations(
  database: SessionMutationDatabase,
  deviceEnrollmentId: string,
  unregisteredAt: Date,
): Promise<void> {
  const activePushRegistrations = await database
    .select({
      registrationId: devicePushTokenRegistrations.id,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollmentId),
        isNull(devicePushTokenUnregistrations.id),
      ),
    );
  if (activePushRegistrations.length === 0) return;
  await database
    .insert(devicePushTokenUnregistrations)
    .values(
      activePushRegistrations.map((registration) => ({
        registrationId: registration.registrationId,
        deviceEnrollmentId: registration.deviceEnrollmentId,
        unregisteredAt,
      })),
    )
    .onConflictDoNothing({
      target: devicePushTokenUnregistrations.registrationId,
    });
}

/** Storage contract keeps all authentication decisions independently testable. */
export interface SessionStore {
  getMembershipSnapshotCapturedAt(snapshotId: string): Promise<Date | null>;
  establish(
    input: EstablishDeviceSessionInput &
      Readonly<{
        tokenDigest: string;
        issuedAt: Date;
        membershipValidUntil: Date;
        membershipGraceUntil: Date;
        sessionExpiresAt: Date;
        sessionId: string;
        deviceEnrollmentId: string;
        tokenIssuanceId: string;
        connectivityEpochId: string;
      }>,
  ): Promise<StoredSessionContext>;
  inspectCredential(tokenDigest: string): Promise<StoredCredential>;
  rotateCredential(input: RotateCredentialInput): Promise<StoredSessionContext>;
  completedRefreshRetry(
    input: CompletedRefreshRetryInput,
  ): Promise<StoredSessionContext | null>;
  recordReplayAndRevoke(input: RecordReplayInput): Promise<void>;
  revoke(input: RevokeStoredSessionInput): Promise<SessionRevocation>;
  /** Optional stores fail closed when they cannot prove a completed retry. */
  completedSelfRevocationRetry?(
    input: CompletedSelfRevocationRetryInput,
  ): Promise<SessionRevocation | null>;
  getSession(sessionId: string): Promise<StoredSessionContext | null>;
  listDeviceSessions(): Promise<readonly StoredSessionContext[]>;
}

function intersectScopes(
  current: FacilityScope,
  cached: FacilityScope,
): FacilityScope {
  if (current.kind === 'district') {
    return cached;
  }
  if (cached.kind === 'district') {
    return current;
  }
  const cachedIds = new Set(cached.facilityIds);
  const facilityIds = current.facilityIds.filter((id) => cachedIds.has(id));
  if (facilityIds.length === 0) {
    throw new SessionAccessError(
      'FORBIDDEN',
      'The session has no authorized facility scope.',
    );
  }
  return FacilityScopeSchema.parse({ kind: 'facilities', facilityIds });
}

function tryIntersectScopes(
  current: FacilityScope,
  cached: FacilityScope,
): FacilityScope | null {
  try {
    return intersectScopes(current, cached);
  } catch (error) {
    if (error instanceof SessionAccessError && error.code === 'FORBIDDEN') {
      return null;
    }
    throw error;
  }
}

function canManageScope(
  administrator: FacilityScope,
  target: FacilityScope,
): boolean {
  if (administrator.kind === 'district') {
    return true;
  }
  if (target.kind === 'district') {
    return false;
  }
  const administratorIds = new Set(administrator.facilityIds);
  return target.facilityIds.every((id) => administratorIds.has(id));
}

function authorizeStoredSession(
  context: StoredSessionContext,
  now: Date,
  source: Extract<InvocationSource, 'web' | 'mobile'>,
  policy: SessionPolicy,
  presentedTokenDigest?: string,
): AuthenticatedSession {
  const { result, revocation } = context;
  if (result.user.disabledAt !== null) {
    throw new SessionAccessError('USER_DISABLED', 'User access is disabled.');
  }
  if (result.deviceEnrollment.revokedAt !== null) {
    throw new SessionAccessError(
      'DEVICE_REVOKED',
      'The device enrollment has been revoked.',
    );
  }
  const expectedSource =
    result.deviceEnrollment.platform === 'web' ? 'web' : 'mobile';
  if (source !== expectedSource) {
    throw new SessionAccessError(
      'INVALID_CREDENTIAL',
      'The credential transport does not match its device enrollment.',
    );
  }
  if (revocation !== null || result.session.revokedAt !== null) {
    throw new SessionAccessError(
      'SESSION_REVOKED',
      'The session has been revoked.',
    );
  }
  if (!context.connectivityEpochActive) {
    throw new SessionAccessError(
      'INVALID_CREDENTIAL',
      'The session has no active connectivity epoch.',
    );
  }
  if (now.getTime() >= Date.parse(result.session.expiresAt)) {
    throw new SessionAccessError('SESSION_EXPIRED', 'The session has expired.');
  }
  if (!context.membershipAccessActive) {
    throw new SessionAccessError(
      'INVALID_MEMBERSHIP_EVIDENCE',
      'The user is absent from the latest complete membership evidence.',
    );
  }
  if (context.membershipCapturedAt.getTime() > now.getTime()) {
    throw new SessionAccessError(
      'INVALID_MEMBERSHIP_EVIDENCE',
      'Cached membership evidence cannot come from the future.',
    );
  }
  const usingIssuanceEvidence =
    context.membershipSnapshotId ===
    result.session.authorization.membershipSnapshotId;
  const membershipValidUntil = usingIssuanceEvidence
    ? Date.parse(result.session.authorization.membershipValidUntil)
    : addSeconds(
        context.membershipCapturedAt,
        policy.membershipTtlSeconds,
      ).getTime();
  const graceUntil = usingIssuanceEvidence
    ? Date.parse(result.session.authorization.membershipGraceUntil)
    : membershipValidUntil + policy.membershipGraceSeconds * SECOND_MS;
  if (now.getTime() >= graceUntil) {
    throw new SessionAccessError(
      'MEMBERSHIP_GRACE_EXPIRED',
      'Cached Google Group membership is beyond its outage grace window.',
    );
  }
  const effectiveScope = intersectScopes(
    result.user.facilityScope,
    context.membershipScope,
  );
  const membershipState =
    now.getTime() < membershipValidUntil ? 'fresh' : 'grace';
  return Object.freeze({
    actor: Object.freeze({
      kind: 'human' as const,
      userId: result.user.id,
      sessionId: result.session.id,
    }),
    source,
    ...(presentedTokenDigest === undefined ? {} : { presentedTokenDigest }),
    roles: result.user.roles,
    scope: CapabilityScopeSchema.parse({ facilityScope: effectiveScope }),
    membershipState,
    result,
  });
}

function refreshRequestDigest(
  source: Extract<InvocationSource, 'web' | 'mobile'>,
): string {
  return digestJson({
    capabilityId: 'refresh-session',
    input: {},
    source,
    transport:
      source === 'web' ? 'web-refresh-cookie' : 'mobile-refresh-bearer',
  });
}

function revokeRequestDigest(
  source: Extract<InvocationSource, 'web' | 'mobile'>,
  input: Readonly<{ sessionId: string; reasonCode: string }>,
  presentedTokenDigest: string,
): string {
  return digestJson({
    capabilityId: 'revoke-session',
    input,
    source,
    presentedTokenDigest,
  });
}

type SessionAuthenticationRecoveryReason = 'connection-destroyed' | 'timeout';

interface SessionAuthenticationGuard {
  scheduleTimeout(onTimeout: () => void): () => void;
  recover(
    reason: SessionAuthenticationRecoveryReason,
    pendingAuthentication: Promise<void>,
  ): Promise<void>;
}

class SessionAuthenticationTimeoutError extends Error {
  public constructor() {
    super('Session authentication exceeded its database deadline.');
    this.name = 'SessionAuthenticationTimeoutError';
  }
}

function isConnectionDestroyedError(error: unknown): boolean {
  let candidate = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if ('code' in candidate && candidate.code === CONNECTION_DESTROYED_CODE) {
      return true;
    }
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return false;
}

function unavailableSessionAuthentication(): SessionAccessError {
  return new SessionAccessError(
    'CONFIGURATION_ERROR',
    'Session authentication is temporarily unavailable.',
  );
}

async function inspectCredentialWithGuard(
  store: SessionStore,
  tokenDigest: string,
  guard: SessionAuthenticationGuard,
): Promise<StoredCredential> {
  const inspection = store.inspectCredential(tokenDigest);
  const pendingAuthentication = inspection.then(
    () => undefined,
    () => undefined,
  );
  let cancelTimeout = (): void => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancelTimeout = guard.scheduleTimeout(() =>
      reject(new SessionAuthenticationTimeoutError()),
    );
  });
  try {
    return await Promise.race([inspection, deadline]);
  } catch (error) {
    const reason =
      error instanceof SessionAuthenticationTimeoutError
        ? 'timeout'
        : isConnectionDestroyedError(error)
          ? 'connection-destroyed'
          : null;
    if (reason === null) throw error;
    try {
      await guard.recover(reason, pendingAuthentication);
    } catch {
      throw unavailableSessionAuthentication();
    }
    throw unavailableSessionAuthentication();
  } finally {
    cancelTimeout();
  }
}

export class SessionService {
  public constructor(
    private readonly store: SessionStore,
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
    private readonly authenticationGuard?: SessionAuthenticationGuard,
  ) {}

  public async establish(
    input: EstablishDeviceSessionInput,
    now = new Date(),
  ): Promise<IssuedDeviceSession> {
    const refreshToken = createOpaqueRefreshToken();
    // A post-cutover establishment carries no snapshot: membership is the
    // present question, so the capture instant is now.
    const snapshotCapturedAt =
      input.membershipSnapshotId === null
        ? now
        : await this.store.getMembershipSnapshotCapturedAt(
            input.membershipSnapshotId,
          );
    if (snapshotCapturedAt === null) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'Complete Google Group membership evidence is required.',
      );
    }
    const membershipValidUntil = addSeconds(
      snapshotCapturedAt,
      this.policy.membershipTtlSeconds,
    );
    if (
      snapshotCapturedAt.getTime() > now.getTime() ||
      now.getTime() >= membershipValidUntil.getTime()
    ) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'Fresh Google Group membership evidence is required for sign-in.',
      );
    }
    const context = await this.store.establish({
      ...input,
      tokenDigest: hashRefreshToken(refreshToken),
      issuedAt: now,
      membershipValidUntil,
      membershipGraceUntil: addSeconds(
        membershipValidUntil,
        this.policy.membershipGraceSeconds,
      ),
      sessionExpiresAt: addSeconds(now, this.policy.sessionLifetimeSeconds),
      sessionId: randomUUID(),
      deviceEnrollmentId: randomUUID(),
      tokenIssuanceId: randomUUID(),
      connectivityEpochId: randomUUID(),
    });
    const authenticated = authorizeStoredSession(
      context,
      now,
      input.device.platform === 'web' ? 'web' : 'mobile',
      this.policy,
    );
    return Object.freeze({ result: authenticated.result, refreshToken });
  }

  public async authenticate(
    token: string,
    source: Extract<InvocationSource, 'web' | 'mobile'>,
    now = new Date(),
  ): Promise<AuthenticatedSession> {
    const tokenDigest = hashRefreshToken(token);
    const credential =
      this.authenticationGuard === undefined
        ? await this.store.inspectCredential(tokenDigest)
        : await inspectCredentialWithGuard(
            this.store,
            tokenDigest,
            this.authenticationGuard,
          );
    if (credential.kind === 'retired') {
      throw new SessionAccessError(
        'TOKEN_REPLAY',
        'The session credential is no longer current.',
      );
    }
    if (credential.kind === 'unknown') {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The session credential is invalid.',
      );
    }
    return authorizeStoredSession(
      credential.context,
      now,
      source,
      this.policy,
      credential.tokenDigest,
    );
  }

  public async prepareRefresh(
    token: string,
    source: Extract<InvocationSource, 'web' | 'mobile'>,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<
    | Readonly<{
        kind: 'verified';
        principal: VerifiedCurrentRefreshCredential;
        idempotencyKey: IdempotencyKey;
        requestDigest: string;
      }>
    | Readonly<{ kind: 'completed-retry'; issued: IssuedDeviceSession }>
  > {
    const parsedIdempotencyKey = IdempotencyKeySchema.parse(idempotencyKey);
    const tokenDigest = hashRefreshToken(token);
    const requestDigest = refreshRequestDigest(source);
    const credential = await this.store.inspectCredential(tokenDigest);
    if (credential.kind === 'retired') {
      const successor = deriveSuccessorToken(
        token,
        credential.sessionId,
        credential.deviceEnrollmentId,
        parsedIdempotencyKey,
      );
      const retryContext = await this.store.completedRefreshRetry({
        retired: credential,
        successorDigest: hashRefreshToken(successor),
        idempotencyKey: parsedIdempotencyKey,
        requestDigest,
        checkedAt: now,
      });
      if (retryContext !== null) {
        const authenticated = authorizeStoredSession(
          retryContext,
          now,
          source,
          this.policy,
        );
        return Object.freeze({
          kind: 'completed-retry' as const,
          issued: Object.freeze({
            result: authenticated.result,
            refreshToken: successor,
          }),
        });
      }
      await this.store.recordReplayAndRevoke({
        retired: credential,
        detectedAt: now,
      });
      throw new SessionAccessError(
        'TOKEN_REPLAY',
        'The session credential is no longer current.',
      );
    }
    if (credential.kind === 'unknown') {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The session credential is invalid.',
      );
    }
    authorizeStoredSession(credential.context, now, source, this.policy);
    return Object.freeze({
      kind: 'verified' as const,
      principal: VerifiedCurrentRefreshCredentialSchema.parse({
        kind: 'verified-current-refresh-credential',
        verificationId: randomUUID(),
        userId: credential.context.result.user.id,
        sessionId: credential.context.result.session.id,
        deviceEnrollmentId: credential.context.result.deviceEnrollment.id,
        recordRef: credential.recordRef,
        presentedTokenDigest: credential.tokenDigest,
        credentialGeneration: credential.generation,
        credentialState: 'current',
        sessionState: 'active',
        deviceState: 'active',
        sessionExpiresAt: credential.context.result.session.expiresAt,
        verifiedAt: timestamp(now),
      }),
      idempotencyKey: parsedIdempotencyKey,
      requestDigest,
    });
  }

  public async rotatePreparedRefresh(
    token: string,
    prepared: Extract<
      Awaited<ReturnType<SessionService['prepareRefresh']>>,
      { readonly kind: 'verified' }
    >,
    now = new Date(),
  ): Promise<IssuedDeviceSession> {
    const nextToken = deriveSuccessorToken(
      token,
      prepared.principal.sessionId,
      prepared.principal.deviceEnrollmentId,
      prepared.idempotencyKey,
    );
    const context = await this.store.rotateCredential({
      principal: prepared.principal,
      nextTokenDigest: hashRefreshToken(nextToken),
      idempotencyKey: prepared.idempotencyKey,
      requestDigest: prepared.requestDigest,
      rotatedAt: now,
      rotationId: randomUUID(),
      connectivityEpochId: randomUUID(),
      membershipTtlSeconds: this.policy.membershipTtlSeconds,
      membershipGraceSeconds: this.policy.membershipGraceSeconds,
    });
    const authenticated = authorizeStoredSession(
      context,
      now,
      context.result.deviceEnrollment.platform === 'web' ? 'web' : 'mobile',
      this.policy,
    );
    return Object.freeze({
      result: authenticated.result,
      refreshToken: nextToken,
    });
  }

  public async revoke(
    authenticated: AuthenticatedSession,
    input: Readonly<{ sessionId: string; reasonCode: string }>,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<SessionRevocation> {
    const presentedTokenDigest = authenticated.presentedTokenDigest;
    if (
      presentedTokenDigest === undefined ||
      !/^[a-f0-9]{64}$/u.test(presentedTokenDigest)
    ) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Session revocation requires the verified request credential.',
      );
    }
    const target = await this.store.getSession(input.sessionId);
    if (target === null) {
      throw new SessionAccessError('FORBIDDEN', 'Session revocation denied.');
    }
    const selfRevocation = input.sessionId === authenticated.actor.sessionId;
    const adminRevocation =
      authenticated.roles.includes('admin') &&
      canManageScope(
        authenticated.scope.facilityScope,
        intersectScopes(
          target.result.user.facilityScope,
          target.membershipScope,
        ),
      );
    if (!selfRevocation && !adminRevocation) {
      throw new SessionAccessError('FORBIDDEN', 'Session revocation denied.');
    }
    return this.store.revoke({
      actor: authenticated.actor,
      sessionId: input.sessionId,
      reasonCode: input.reasonCode,
      idempotencyKey: IdempotencyKeySchema.parse(idempotencyKey),
      requestDigest: revokeRequestDigest(
        authenticated.source,
        input,
        presentedTokenDigest,
      ),
      revokedAt: now,
    });
  }

  /**
   * Recovers only the receipt for an already-completed self-revocation.
   * This is deliberately not a mutation or authorization fallback: the store
   * must bind the still-current presented credential to the exact completed
   * idempotency record and its canonical revocation row.
   */
  public async recoverCompletedSelfRevocation(
    token: string,
    source: Extract<InvocationSource, 'web' | 'mobile'>,
    input: Readonly<{ sessionId: string; reasonCode: string }>,
    idempotencyKey: string,
  ): Promise<SessionRevocation | null> {
    const recover = this.store.completedSelfRevocationRetry;
    if (recover === undefined) return null;
    const presentedTokenDigest = hashRefreshToken(token);
    return recover.call(this.store, {
      presentedTokenDigest,
      sessionId: input.sessionId,
      idempotencyKey: IdempotencyKeySchema.parse(idempotencyKey),
      requestDigest: revokeRequestDigest(source, input, presentedTokenDigest),
    });
  }

  public async listDeviceSessions(
    authenticated: AuthenticatedSession,
    input: ListDeviceSessionsInput,
  ): Promise<DeviceSessionPage> {
    if (!authenticated.roles.includes('admin')) {
      throw new SessionAccessError(
        'FORBIDDEN',
        'Administrator access is required.',
      );
    }
    const allSessions = await this.store.listDeviceSessions();
    const visible = allSessions.filter((context) => {
      if (input.userId !== null && context.result.user.id !== input.userId) {
        return false;
      }
      if (
        !input.includeRevoked &&
        (context.revocation !== null ||
          context.result.session.revokedAt !== null)
      ) {
        return false;
      }
      const effectiveScope = tryIntersectScopes(
        context.result.user.facilityScope,
        context.membershipScope,
      );
      return (
        effectiveScope !== null &&
        canManageScope(authenticated.scope.facilityScope, effectiveScope)
      );
    });
    const grouped = new Map<
      string,
      {
        deviceEnrollment: DeviceEnrollment;
        sessions: SessionEstablishmentResult['session'][];
      }
    >();
    for (const context of visible) {
      const device = context.result.deviceEnrollment;
      const entry = grouped.get(device.id) ?? {
        deviceEnrollment: device,
        sessions: [],
      };
      entry.sessions.push(context.result.session);
      grouped.set(device.id, entry);
    }
    const rows = [...grouped.values()]
      .sort((left, right) =>
        left.deviceEnrollment.id.localeCompare(right.deviceEnrollment.id),
      )
      .flatMap((entry) => {
        const orderedSessions = [...entry.sessions].sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            left.id.localeCompare(right.id),
        );
        const summaries: Array<{
          deviceEnrollment: DeviceEnrollment;
          sessions: SessionEstablishmentResult['session'][];
        }> = [];
        for (
          let offset = 0;
          offset < orderedSessions.length;
          offset += SESSIONS_PER_DEVICE_SUMMARY
        ) {
          summaries.push({
            deviceEnrollment: entry.deviceEnrollment,
            sessions: orderedSessions.slice(
              offset,
              offset + SESSIONS_PER_DEVICE_SUMMARY,
            ),
          });
        }
        return summaries;
      });
    const offset = decodeCursor(input.cursor);
    const items = rows.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return DeviceSessionPageSchema.parse({
      items,
      pageInfo: {
        hasMore: nextOffset < rows.length,
        nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset) : null,
      },
    });
  }

  public async listMyDevices(
    authenticated: AuthenticatedSession,
    input: ListMyDevicesInput,
  ): Promise<DeviceEnrollmentPage> {
    const sessionsForUser = (await this.store.listDeviceSessions()).filter(
      (context) =>
        context.result.user.id === authenticated.actor.userId &&
        (input.includeRevoked ||
          (context.revocation === null &&
            context.result.session.revokedAt === null)),
    );
    const uniqueDevices = new Map<string, DeviceEnrollment>();
    for (const context of sessionsForUser) {
      uniqueDevices.set(
        context.result.deviceEnrollment.id,
        context.result.deviceEnrollment,
      );
    }
    const rows = [...uniqueDevices.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const offset = decodeCursor(input.cursor);
    const items = rows.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return DeviceEnrollmentPageSchema.parse({
      items,
      pageInfo: {
        hasMore: nextOffset < rows.length,
        nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset) : null,
      },
    });
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/u.test(decoded)) {
    throw new SessionAccessError('FORBIDDEN', 'Invalid pagination cursor.');
  }
  return Number(decoded);
}

function exactStringSets(
  first: readonly string[],
  second: readonly string[],
): boolean {
  if (
    first.length === 0 ||
    first.length !== new Set(first).size ||
    second.length !== new Set(second).size ||
    first.length !== second.length
  ) {
    return false;
  }
  const secondSet = new Set(second);
  return first.every((value) => secondSet.has(value));
}

function buildFacilityScope(
  kind: 'district' | 'facilities',
  facilityIds: readonly string[],
): FacilityScope {
  if (kind === 'district') {
    if (facilityIds.length !== 0) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'District scope cannot also contain facility rows.',
      );
    }
    return FacilityScopeSchema.parse({ kind: 'district' });
  }
  return FacilityScopeSchema.parse({ kind: 'facilities', facilityIds });
}

function parseRefreshResultReference(reference: string): Readonly<{
  sessionId: string;
  rotationId: string;
  connectivityEpochId: string;
  nextTokenDigest: string;
}> | null {
  const [prefix, sessionId, rotationId, connectivityEpochId, nextTokenDigest] =
    reference.split(':');
  if (
    prefix !== REFRESH_RESULT_PREFIX ||
    sessionId === undefined ||
    rotationId === undefined ||
    connectivityEpochId === undefined ||
    nextTokenDigest === undefined ||
    !/^[0-9a-f-]{36}$/u.test(sessionId) ||
    !/^[0-9a-f-]{36}$/u.test(rotationId) ||
    !/^[0-9a-f-]{36}$/u.test(connectivityEpochId) ||
    !/^[a-f0-9]{64}$/u.test(nextTokenDigest)
  ) {
    return null;
  }
  return Object.freeze({
    sessionId,
    rotationId,
    connectivityEpochId,
    nextTokenDigest,
  });
}

function parseRevocationResultReference(reference: string): string | null {
  const parts = reference.split(':');
  const [prefix, revocationId] = parts;
  return parts.length === 2 &&
    prefix === REVOCATION_RESULT_PREFIX &&
    revocationId !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      revocationId,
    )
    ? revocationId
    : null;
}

function refreshIdempotencyPrincipal(
  sessionId: string,
  deviceEnrollmentId: string,
  presentedTokenDigest: string,
) {
  return IdempotencyPrincipalSchema.parse({
    kind: 'refresh-credential',
    sessionId,
    deviceEnrollmentId,
    presentedTokenDigest,
  });
}

/** PostgreSQL/Aurora implementation; every history table is insert-only. */
export class DrizzleSessionStore implements SessionStore {
  public constructor(private readonly database: Database) {}

  public async getMembershipSnapshotCapturedAt(
    snapshotId: string,
  ): Promise<Date | null> {
    const [snapshot] = await this.database
      .select({
        capturedAt: accessMembershipSnapshots.capturedAt,
        complete: accessMembershipSnapshots.complete,
      })
      .from(accessMembershipSnapshots)
      .where(eq(accessMembershipSnapshots.id, snapshotId))
      .limit(1);
    return snapshot?.complete === true ? snapshot.capturedAt : null;
  }

  /**
   * Membership backing a session that was issued after the trusted-group
   * cutover. Such a session carries no snapshot id, because there is no
   * generation to carry — authorization is the present question of whether the
   * holder is still in a trusted group.
   */
  private async loadTrustedMembership(
    user: Readonly<{ id: string; googleSubject: string; email: string }>,
    now: Date,
    database: Pick<Database, 'select'> = this.database,
  ): Promise<
    Readonly<{
      snapshotId: string | null;
      version: number;
      scope: FacilityScope;
      capturedAt: Date;
    }>
  > {
    const decision = await decideAccess(database as Database, {
      email: user.email,
      checkedAt: now,
    });
    if (!decision.granted) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'The session holder is no longer in a trusted access group.',
      );
    }
    const scopes = await database
      .select({ facilityId: userFacilityScopes.facilityId })
      .from(userFacilityScopes)
      .where(eq(userFacilityScopes.userId, user.id));
    return Object.freeze({
      snapshotId: null,
      version: 0,
      scope:
        scopes.length === 0
          ? Object.freeze({ kind: 'district' as const })
          : Object.freeze({
              kind: 'facilities' as const,
              facilityIds: Object.freeze(
                scopes.map(({ facilityId }) => facilityId).sort(),
              ),
            }),
      capturedAt: now,
    });
  }

  private async loadMembershipEvidence(
    snapshotId: string,
    user: Readonly<{ id: string; googleSubject: string }>,
    database: Pick<Database, 'select'> = this.database,
  ): Promise<
    Readonly<{
      snapshotId: string;
      version: number;
      scope: FacilityScope;
      capturedAt: Date;
    }>
  > {
    const [snapshot] = await database
      .select({
        id: accessMembershipSnapshots.id,
        version: accessMembershipSnapshots.version,
        capturedAt: accessMembershipSnapshots.capturedAt,
        complete: accessMembershipSnapshots.complete,
      })
      .from(accessMembershipSnapshots)
      .where(eq(accessMembershipSnapshots.id, snapshotId))
      .limit(1);
    if (snapshot?.complete !== true) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'The access-membership snapshot is incomplete.',
      );
    }

    const snapshotGroupRows = await database
      .select({
        groupSourceId: accessMembershipSnapshotGroups.groupSourceId,
        groupSourceKind: accessMembershipSnapshotGroups.groupSourceKind,
        groupPurpose: accessMembershipSnapshotGroups.groupPurpose,
        completionKind: accessMembershipSnapshotGroups.completionKind,
      })
      .from(accessMembershipSnapshotGroups)
      .where(eq(accessMembershipSnapshotGroups.snapshotId, snapshotId));
    const toKey = (row: (typeof snapshotGroupRows)[number]): string =>
      `${row.groupSourceId}:${row.groupSourceKind}:${row.groupPurpose}`;
    const expected = snapshotGroupRows
      .filter((row) => row.completionKind === 'expected')
      .map(toKey);
    const completed = snapshotGroupRows
      .filter((row) => row.completionKind === 'completed')
      .map(toKey);
    if (
      snapshotGroupRows.some(
        (row) =>
          row.groupSourceKind !== 'google-group' ||
          row.groupPurpose !== 'access',
      ) ||
      !exactStringSets(expected, completed)
    ) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'The access-membership snapshot did not complete every configured group.',
      );
    }

    const [member] = await database
      .select({
        googleSubject: accessMembershipMembers.googleSubject,
        facilityScopeKind: accessMembershipMembers.facilityScopeKind,
      })
      .from(accessMembershipMembers)
      .where(
        and(
          eq(accessMembershipMembers.snapshotId, snapshotId),
          eq(accessMembershipMembers.userId, user.id),
        ),
      )
      .limit(1);
    if (member === undefined || member.googleSubject !== user.googleSubject) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'The user is absent from the cached access-membership snapshot.',
      );
    }
    const memberGroups = await database
      .select({
        groupSourceId: accessMembershipMemberGroups.groupSourceId,
        groupSourceKind: accessMembershipMemberGroups.groupSourceKind,
        groupPurpose: accessMembershipMemberGroups.groupPurpose,
      })
      .from(accessMembershipMemberGroups)
      .where(
        and(
          eq(accessMembershipMemberGroups.snapshotId, snapshotId),
          eq(accessMembershipMemberGroups.userId, user.id),
        ),
      );
    const expectedSet = new Set(expected);
    const accessGroupSourceRefs = memberGroups.map((row) => ({
      id: row.groupSourceId,
      kind: row.groupSourceKind,
      purpose: row.groupPurpose,
      facilityId: null,
    }));
    if (
      memberGroups.length === 0 ||
      memberGroups.some(
        (row) =>
          row.groupSourceKind !== 'google-group' ||
          row.groupPurpose !== 'access' ||
          !expectedSet.has(
            `${row.groupSourceId}:${row.groupSourceKind}:${row.groupPurpose}`,
          ),
      )
    ) {
      throw new SessionAccessError(
        'INVALID_MEMBERSHIP_EVIDENCE',
        'The cached member lacks designated access-group provenance.',
      );
    }
    const memberFacilityRows = await database
      .select({ facilityId: accessMembershipMemberFacilities.facilityId })
      .from(accessMembershipMemberFacilities)
      .where(
        and(
          eq(accessMembershipMemberFacilities.snapshotId, snapshotId),
          eq(accessMembershipMemberFacilities.userId, user.id),
        ),
      );
    const scope = buildFacilityScope(
      member.facilityScopeKind,
      memberFacilityRows.map((row) => row.facilityId),
    );
    AccessMembershipMemberSchema.parse({
      userId: user.id,
      googleSubject: user.googleSubject,
      accessGroupSourceRefs,
      facilityScope: scope,
    });
    return Object.freeze({
      snapshotId: snapshot.id,
      version: snapshot.version,
      scope,
      capturedAt: snapshot.capturedAt,
    });
  }

  private loadSessionContext(
    sessionId: string,
    expectedConnectivityEpochId?: string,
  ): Promise<StoredSessionContext | null> {
    return this.database.transaction(
      (transaction) =>
        this.loadSessionContextFromSnapshot(
          transaction,
          sessionId,
          expectedConnectivityEpochId,
        ),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async loadSessionContextFromSnapshot(
    database: RoleStateDatabase,
    sessionId: string,
    expectedConnectivityEpochId?: string,
  ): Promise<StoredSessionContext | null> {
    const [identityRow] = await database
      .select({
        session: {
          id: sessions.id,
          userId: sessions.userId,
          deviceEnrollmentId: sessions.deviceEnrollmentId,
          membershipSnapshotId: sessions.membershipSnapshotId,
          membershipValidUntil: sessions.membershipValidUntil,
          membershipGraceUntil: sessions.membershipGraceUntil,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
        },
        user: {
          id: users.id,
          googleSubject: users.googleSubject,
          email: users.email,
          displayName: users.displayName,
          facilityScopeKind: users.facilityScopeKind,
          createdAt: users.createdAt,
          disabledAt: users.disabledAt,
        },
        device: {
          id: deviceEnrollments.id,
          userId: deviceEnrollments.userId,
          platform: deviceEnrollments.platform,
          unlockMethod: deviceEnrollments.unlockMethod,
          installationId: deviceEnrollments.installationId,
          enrolledAt: deviceEnrollments.enrolledAt,
          lastSeenAt: deviceEnrollments.lastSeenAt,
          revokedAt: deviceEnrollments.revokedAt,
        },
      })
      .from(sessions)
      .leftJoin(users, eq(users.id, sessions.userId))
      .leftJoin(
        deviceEnrollments,
        eq(deviceEnrollments.id, sessions.deviceEnrollmentId),
      )
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (identityRow === undefined) {
      return null;
    }
    const {
      session: sessionRow,
      user: userRow,
      device: deviceRow,
    } = identityRow;
    if (userRow === null || deviceRow === null) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The session identity graph is incomplete.',
      );
    }
    const roles = await loadEffectiveRoles(database, userRow.id);
    const facilityRows = await database
      .select({ facilityId: userFacilityScopes.facilityId })
      .from(userFacilityScopes)
      .where(eq(userFacilityScopes.userId, userRow.id));
    const currentScope = buildFacilityScope(
      userRow.facilityScopeKind,
      facilityRows.map((row) => row.facilityId),
    );
    const user = UserSchema.parse({
      id: userRow.id,
      googleSubject: userRow.googleSubject,
      email: userRow.email,
      displayName: userRow.displayName,
      roles,
      facilityScope: currentScope,
      createdAt: timestamp(userRow.createdAt),
      disabledAt:
        userRow.disabledAt === null ? null : timestamp(userRow.disabledAt),
    });
    const deviceEnrollment = DeviceEnrollmentSchema.parse({
      id: deviceRow.id,
      userId: deviceRow.userId,
      platform: deviceRow.platform,
      unlockMethod: deviceRow.unlockMethod,
      installationId: deviceRow.installationId,
      enrolledAt: timestamp(deviceRow.enrolledAt),
      lastSeenAt: timestamp(deviceRow.lastSeenAt),
      revokedAt:
        deviceRow.revokedAt === null ? null : timestamp(deviceRow.revokedAt),
    });
    const issuanceMembership =
      sessionRow.membershipSnapshotId === null
        ? await this.loadTrustedMembership(user, new Date(), database)
        : await this.loadMembershipEvidence(
            sessionRow.membershipSnapshotId,
            user,
            database,
          );
    const [latestCompleteSnapshot] = await database
      .select({
        id: accessMembershipSnapshots.id,
        version: accessMembershipSnapshots.version,
      })
      .from(accessMembershipSnapshots)
      .where(eq(accessMembershipSnapshots.complete, true))
      .orderBy(
        desc(accessMembershipSnapshots.version),
        desc(accessMembershipSnapshots.capturedAt),
        desc(accessMembershipSnapshots.id),
      )
      .limit(1);
    let membership = issuanceMembership;
    let membershipAccessActive = true;
    if (
      latestCompleteSnapshot !== undefined &&
      latestCompleteSnapshot.version > issuanceMembership.version
    ) {
      try {
        membership = await this.loadMembershipEvidence(
          latestCompleteSnapshot.id,
          user,
          database,
        );
      } catch (error) {
        if (
          error instanceof SessionAccessError &&
          error.code === 'INVALID_MEMBERSHIP_EVIDENCE'
        ) {
          membershipAccessActive = false;
        } else {
          throw error;
        }
      }
    }
    const [revocationRow] = await database
      .select()
      .from(sessionRevocations)
      .where(eq(sessionRevocations.sessionId, sessionId))
      .orderBy(asc(sessionRevocations.revokedAt), asc(sessionRevocations.id))
      .limit(1);
    const revocation =
      revocationRow === undefined
        ? null
        : SessionRevocationSchema.parse({
            id: revocationRow.id,
            sessionId: revocationRow.sessionId,
            revokedBy: revocationRow.revokedBy,
            reasonCode: revocationRow.reasonCode,
            revokedAt: timestamp(revocationRow.revokedAt),
          });
    const epochRows = await database
      .select()
      .from(connectivityEpochs)
      .where(eq(connectivityEpochs.sessionId, sessionId))
      .orderBy(
        sql`${connectivityEpochs.establishedAt} desc`,
        sql`${connectivityEpochs.id} desc`,
      );
    if (epochRows.length === 0) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The session has no connectivity epoch.',
      );
    }
    const epochInvalidations = await database
      .select({
        connectivityEpochId: connectivityEpochInvalidations.connectivityEpochId,
      })
      .from(connectivityEpochInvalidations)
      .where(
        inArray(
          connectivityEpochInvalidations.connectivityEpochId,
          epochRows.map((row) => row.id),
        ),
      );
    const invalidatedEpochIds = new Set(
      epochInvalidations.map((row) => row.connectivityEpochId),
    );
    const activeEpochRows = epochRows.filter(
      (row) => !invalidatedEpochIds.has(row.id),
    );
    const epochRow =
      expectedConnectivityEpochId === undefined
        ? activeEpochRows.length === 1
          ? activeEpochRows[0]
          : epochRows[0]
        : epochRows.find((row) => row.id === expectedConnectivityEpochId);
    if (epochRow === undefined) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The expected connectivity epoch does not exist.',
      );
    }
    const session = SessionSchema.parse({
      id: sessionRow.id,
      userId: sessionRow.userId,
      deviceEnrollmentId: sessionRow.deviceEnrollmentId,
      createdAt: timestamp(sessionRow.createdAt),
      expiresAt: timestamp(sessionRow.expiresAt),
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: sessionRow.membershipSnapshotId,
        membershipValidUntil: timestamp(sessionRow.membershipValidUntil),
        membershipGraceUntil: timestamp(sessionRow.membershipGraceUntil),
      },
      revokedAt:
        sessionRow.revokedAt === null
          ? (revocation?.revokedAt ?? null)
          : timestamp(sessionRow.revokedAt),
    });
    return Object.freeze({
      result: SessionEstablishmentResultSchema.parse({
        user,
        session,
        deviceEnrollment,
        connectivityEpoch: {
          id: epochRow.id,
          sessionId: epochRow.sessionId,
          establishedAt: timestamp(epochRow.establishedAt),
        },
      }),
      membershipSnapshotId: membership.snapshotId,
      membershipCapturedAt: membership.capturedAt,
      membershipScope: membership.scope,
      membershipAccessActive,
      revocation,
      connectivityEpochActive:
        activeEpochRows.length === 1 && activeEpochRows[0]?.id === epochRow.id,
    });
  }

  public async establish(
    input: EstablishDeviceSessionInput &
      Readonly<{
        tokenDigest: string;
        issuedAt: Date;
        membershipValidUntil: Date;
        membershipGraceUntil: Date;
        sessionExpiresAt: Date;
        sessionId: string;
        deviceEnrollmentId: string;
        tokenIssuanceId: string;
        connectivityEpochId: string;
      }>,
  ): Promise<StoredSessionContext> {
    const deviceEnrollmentId = await this.database.transaction(
      async (transaction) => {
        const [userRow] = await transaction
          .select({
            id: users.id,
            googleSubject: users.googleSubject,
            disabledAt: users.disabledAt,
          })
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update')
          .limit(1);
        if (userRow === undefined || userRow.disabledAt !== null) {
          throw new SessionAccessError('FORBIDDEN', 'Session issuance denied.');
        }
        if (input.membershipSnapshotId !== null) {
          await this.loadMembershipEvidence(
            input.membershipSnapshotId,
            userRow,
            transaction,
          );
        }
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.device.installationId}, 4017))`,
        );
        const [existingDevice] = await transaction
          .select()
          .from(deviceEnrollments)
          .where(
            eq(deviceEnrollments.installationId, input.device.installationId),
          )
          .limit(1);
        let selectedDeviceId = input.deviceEnrollmentId;
        if (existingDevice !== undefined) {
          if (
            existingDevice.userId !== input.userId ||
            existingDevice.platform !== input.device.platform ||
            existingDevice.unlockMethod !== input.device.unlockMethod ||
            existingDevice.revokedAt !== null
          ) {
            throw new SessionAccessError(
              'FORBIDDEN',
              'Device enrollment does not match the authenticated user.',
            );
          }
          selectedDeviceId = existingDevice.id;
          await transaction
            .update(deviceEnrollments)
            .set({
              lastSeenAt: new Date(
                Math.max(
                  existingDevice.lastSeenAt.getTime(),
                  input.issuedAt.getTime(),
                ),
              ),
            })
            .where(eq(deviceEnrollments.id, existingDevice.id));
        } else {
          await transaction.insert(deviceEnrollments).values({
            id: selectedDeviceId,
            userId: input.userId,
            platform: input.device.platform,
            unlockMethod: input.device.unlockMethod,
            installationId: input.device.installationId,
            enrolledAt: input.issuedAt,
            lastSeenAt: input.issuedAt,
            revokedAt: null,
          });
        }
        await transaction.insert(sessions).values({
          id: input.sessionId,
          userId: input.userId,
          deviceEnrollmentId: selectedDeviceId,
          membershipSnapshotId: input.membershipSnapshotId,
          membershipValidUntil: input.membershipValidUntil,
          membershipGraceUntil: input.membershipGraceUntil,
          createdAt: input.issuedAt,
          expiresAt: input.sessionExpiresAt,
          revokedAt: null,
        });
        await transaction.insert(sessionTokenIssuances).values({
          id: input.tokenIssuanceId,
          sessionId: input.sessionId,
          tokenDigest: input.tokenDigest,
          issuedAt: input.issuedAt,
        });
        await transaction.insert(connectivityEpochs).values({
          id: input.connectivityEpochId,
          sessionId: input.sessionId,
          establishedAt: input.issuedAt,
        });
        return selectedDeviceId;
      },
    );
    const context = await this.loadSessionContext(
      input.sessionId,
      input.connectivityEpochId,
    );
    if (
      context === null ||
      context.result.deviceEnrollment.id !== deviceEnrollmentId
    ) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Session issuance could not be reconstructed.',
      );
    }
    return context;
  }

  public async inspectCredential(
    tokenDigest: string,
  ): Promise<StoredCredential> {
    const credentialMatches = await this.database
      .select({ sessionId: sessionTokenIssuances.sessionId })
      .from(sessionTokenIssuances)
      .where(eq(sessionTokenIssuances.tokenDigest, tokenDigest))
      .unionAll(
        this.database
          .select({ sessionId: sessionTokenRotations.sessionId })
          .from(sessionTokenRotations)
          .where(
            or(
              eq(sessionTokenRotations.previousTokenDigest, tokenDigest),
              eq(sessionTokenRotations.nextTokenDigest, tokenDigest),
            ),
          ),
      );
    const candidateSessionIds = new Set(
      credentialMatches.map((row) => row.sessionId),
    );
    if (candidateSessionIds.size === 0) {
      return Object.freeze({ kind: 'unknown', tokenDigest });
    }
    if (candidateSessionIds.size !== 1) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Credential history is inconsistent.',
      );
    }
    const sessionId = [...candidateSessionIds][0];
    if (sessionId === undefined) {
      return Object.freeze({ kind: 'unknown', tokenDigest });
    }
    const credentialHistoryRows = await this.database
      .select({
        issuance: {
          id: sessionTokenIssuances.id,
          tokenDigest: sessionTokenIssuances.tokenDigest,
        },
        deviceEnrollmentId: sessions.deviceEnrollmentId,
        rotation: {
          id: sessionTokenRotations.id,
          previousTokenDigest: sessionTokenRotations.previousTokenDigest,
          nextTokenDigest: sessionTokenRotations.nextTokenDigest,
        },
      })
      .from(sessionTokenIssuances)
      .innerJoin(sessions, eq(sessions.id, sessionTokenIssuances.sessionId))
      .leftJoin(
        sessionTokenRotations,
        eq(sessionTokenRotations.sessionId, sessionTokenIssuances.sessionId),
      )
      .where(eq(sessionTokenIssuances.sessionId, sessionId))
      .orderBy(asc(sessionTokenRotations.rotatedAt));
    const issuanceAndSession = credentialHistoryRows[0];
    if (issuanceAndSession === undefined) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Credential history is incomplete.',
      );
    }
    const { issuance, deviceEnrollmentId } = issuanceAndSession;
    const rotationRows = credentialHistoryRows.flatMap(({ rotation }) =>
      rotation === null ? [] : [rotation],
    );
    const byPrevious = new Map(
      rotationRows.map((rotation) => [rotation.previousTokenDigest, rotation]),
    );
    const orderedRotations: typeof rotationRows = [];
    let currentDigest = issuance.tokenDigest;
    const seenDigests = new Set<string>();
    while (byPrevious.has(currentDigest)) {
      if (seenDigests.has(currentDigest)) {
        throw new SessionAccessError(
          'INVALID_CREDENTIAL',
          'Credential history contains a cycle.',
        );
      }
      seenDigests.add(currentDigest);
      const rotation = byPrevious.get(currentDigest);
      if (rotation === undefined) {
        break;
      }
      orderedRotations.push(rotation);
      currentDigest = rotation.nextTokenDigest;
    }
    if (orderedRotations.length !== rotationRows.length) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Credential history contains a disconnected rotation.',
      );
    }
    const retiringRotation = orderedRotations.find(
      (rotation) => rotation.previousTokenDigest === tokenDigest,
    );
    if (retiringRotation !== undefined) {
      return Object.freeze({
        kind: 'retired' as const,
        sessionId,
        deviceEnrollmentId,
        rotationId: retiringRotation.id,
        tokenDigest,
      });
    }
    if (currentDigest !== tokenDigest) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Credential history does not contain a current bearer.',
      );
    }
    const context = await this.loadSessionContext(sessionId);
    if (context === null) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The credential session does not exist.',
      );
    }
    const [retiredAfterContextLoad] = await this.database
      .select({ id: sessionTokenRotations.id })
      .from(sessionTokenRotations)
      .where(
        and(
          eq(sessionTokenRotations.sessionId, sessionId),
          eq(sessionTokenRotations.previousTokenDigest, tokenDigest),
        ),
      )
      .limit(1);
    if (retiredAfterContextLoad !== undefined) {
      return Object.freeze({
        kind: 'retired' as const,
        sessionId,
        deviceEnrollmentId,
        rotationId: retiredAfterContextLoad.id,
        tokenDigest,
      });
    }
    const lastRotation = orderedRotations.at(-1);
    return Object.freeze({
      kind: 'current' as const,
      context,
      recordRef:
        lastRotation === undefined
          ? Object.freeze({
              kind: 'initial-issuance' as const,
              issuanceId: issuance.id,
            })
          : Object.freeze({
              kind: 'rotation-successor' as const,
              rotationId: lastRotation.id,
            }),
      generation: orderedRotations.length + 1,
      tokenDigest,
    });
  }

  public async rotateCredential(
    input: RotateCredentialInput,
  ): Promise<StoredSessionContext> {
    const principal = refreshIdempotencyPrincipal(
      input.principal.sessionId,
      input.principal.deviceEnrollmentId,
      input.principal.presentedTokenDigest,
    );
    const principalDigest = digestJson(principal);
    const transactionResult = await this.database.transaction(
      async (transaction) => {
        const [lockedSession] = await transaction
          .select()
          .from(sessions)
          .where(eq(sessions.id, input.principal.sessionId))
          .for('update')
          .limit(1);
        if (
          lockedSession === undefined ||
          lockedSession.deviceEnrollmentId !==
            input.principal.deviceEnrollmentId
        ) {
          throw new SessionAccessError(
            'INVALID_CREDENTIAL',
            'The session credential is invalid.',
          );
        }

        const [existingIdempotency] = await transaction
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.capabilityId, 'refresh-session'),
              eq(idempotencyRecords.principalDigest, principalDigest),
              eq(idempotencyRecords.key, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existingIdempotency !== undefined) {
          if (
            existingIdempotency.requestDigest !== input.requestDigest ||
            existingIdempotency.status !== 'completed' ||
            existingIdempotency.resultReference === null
          ) {
            throw new SessionAccessError(
              'IDEMPOTENCY_CONFLICT',
              'The idempotency key is already bound to another request.',
            );
          }
          const reference = parseRefreshResultReference(
            existingIdempotency.resultReference,
          );
          if (
            reference === null ||
            reference.sessionId !== input.principal.sessionId ||
            reference.nextTokenDigest !== input.nextTokenDigest
          ) {
            throw new SessionAccessError(
              'IDEMPOTENCY_CONFLICT',
              'The completed refresh result cannot be reconstructed.',
            );
          }
          return Object.freeze({
            kind: 'success' as const,
            connectivityEpochId: reference.connectivityEpochId,
          });
        }

        const [deviceRow] = await transaction
          .select()
          .from(deviceEnrollments)
          .where(eq(deviceEnrollments.id, lockedSession.deviceEnrollmentId))
          .limit(1);
        const [userRow] = await transaction
          .select({
            id: users.id,
            googleSubject: users.googleSubject,
            // Needed to re-check trusted-group membership on rotation: access
            // is decided by the groups this address is in.
            email: users.email,
            disabledAt: users.disabledAt,
          })
          .from(users)
          .where(eq(users.id, lockedSession.userId))
          .limit(1);
        const [revocationRow] = await transaction
          .select({ id: sessionRevocations.id })
          .from(sessionRevocations)
          .where(eq(sessionRevocations.sessionId, lockedSession.id))
          .limit(1);
        if (
          deviceRow === undefined ||
          deviceRow.revokedAt !== null ||
          userRow === undefined ||
          userRow.disabledAt !== null ||
          lockedSession.revokedAt !== null ||
          revocationRow !== undefined
        ) {
          throw new SessionAccessError(
            'SESSION_REVOKED',
            'The session has been revoked.',
          );
        }
        if (input.rotatedAt.getTime() >= lockedSession.expiresAt.getTime()) {
          throw new SessionAccessError(
            'SESSION_EXPIRED',
            'The session has expired.',
          );
        }
        const issuanceMembership =
          lockedSession.membershipSnapshotId === null
            ? await this.loadTrustedMembership(
                userRow,
                new Date(),
                transaction,
              )
            : await this.loadMembershipEvidence(
                lockedSession.membershipSnapshotId,
                userRow,
                transaction,
              );
        const [latestCompleteSnapshot] = await transaction
          .select({
            id: accessMembershipSnapshots.id,
            version: accessMembershipSnapshots.version,
          })
          .from(accessMembershipSnapshots)
          .where(eq(accessMembershipSnapshots.complete, true))
          .orderBy(
            desc(accessMembershipSnapshots.version),
            desc(accessMembershipSnapshots.capturedAt),
            desc(accessMembershipSnapshots.id),
          )
          .limit(1);
        const effectiveMembership =
          latestCompleteSnapshot !== undefined &&
          latestCompleteSnapshot.version > issuanceMembership.version
            ? await this.loadMembershipEvidence(
                latestCompleteSnapshot.id,
                userRow,
                transaction,
              )
            : issuanceMembership;
        const effectiveGraceUntil =
          effectiveMembership.snapshotId === lockedSession.membershipSnapshotId
            ? lockedSession.membershipGraceUntil
            : addSeconds(
                addSeconds(
                  effectiveMembership.capturedAt,
                  input.membershipTtlSeconds,
                ),
                input.membershipGraceSeconds,
              );
        if (
          effectiveMembership.capturedAt.getTime() > input.rotatedAt.getTime()
        ) {
          throw new SessionAccessError(
            'INVALID_MEMBERSHIP_EVIDENCE',
            'Cached membership evidence cannot come from the future.',
          );
        }
        if (input.rotatedAt.getTime() >= effectiveGraceUntil.getTime()) {
          throw new SessionAccessError(
            'MEMBERSHIP_GRACE_EXPIRED',
            'Cached Google Group membership is beyond its outage grace window.',
          );
        }

        const [retiringRotation] = await transaction
          .select({ id: sessionTokenRotations.id })
          .from(sessionTokenRotations)
          .where(
            and(
              eq(sessionTokenRotations.sessionId, lockedSession.id),
              eq(
                sessionTokenRotations.previousTokenDigest,
                input.principal.presentedTokenDigest,
              ),
            ),
          )
          .limit(1);
        if (retiringRotation !== undefined) {
          await transaction.insert(sessionTokenReplays).values({
            id: randomUUID(),
            sessionId: lockedSession.id,
            rotationId: retiringRotation.id,
            detectedAt: input.rotatedAt,
          });
          await transaction.insert(sessionRevocations).values({
            id: randomUUID(),
            sessionId: lockedSession.id,
            revokedBy: { kind: 'system', serviceId: 'session-auth' },
            reasonCode: 'REFRESH_TOKEN_REPLAY',
            revokedAt: input.rotatedAt,
          });
          const epochRows = await transaction
            .select({ id: connectivityEpochs.id })
            .from(connectivityEpochs)
            .where(eq(connectivityEpochs.sessionId, lockedSession.id));
          const invalidatedRows =
            epochRows.length === 0
              ? []
              : await transaction
                  .select({
                    connectivityEpochId:
                      connectivityEpochInvalidations.connectivityEpochId,
                  })
                  .from(connectivityEpochInvalidations)
                  .where(
                    inArray(
                      connectivityEpochInvalidations.connectivityEpochId,
                      epochRows.map((row) => row.id),
                    ),
                  );
          const invalidatedIds = new Set(
            invalidatedRows.map((row) => row.connectivityEpochId),
          );
          const activeEpochs = epochRows.filter(
            (row) => !invalidatedIds.has(row.id),
          );
          if (activeEpochs.length > 0) {
            await transaction.insert(connectivityEpochInvalidations).values(
              activeEpochs.map((row) => ({
                id: randomUUID(),
                connectivityEpochId: row.id,
                reason: 'session-revoked',
                invalidatedAt: input.rotatedAt,
              })),
            );
          }
          await appendDevicePushTokenUnregistrations(
            transaction,
            lockedSession.deviceEnrollmentId,
            input.rotatedAt,
          );
          return Object.freeze({ kind: 'replay' as const });
        }

        const [currentIssuance] = await transaction
          .select({ id: sessionTokenIssuances.id })
          .from(sessionTokenIssuances)
          .where(
            and(
              eq(sessionTokenIssuances.sessionId, lockedSession.id),
              eq(
                sessionTokenIssuances.tokenDigest,
                input.principal.presentedTokenDigest,
              ),
            ),
          )
          .limit(1);
        const [currentRotation] = await transaction
          .select({ id: sessionTokenRotations.id })
          .from(sessionTokenRotations)
          .where(
            and(
              eq(sessionTokenRotations.sessionId, lockedSession.id),
              eq(
                sessionTokenRotations.nextTokenDigest,
                input.principal.presentedTokenDigest,
              ),
            ),
          )
          .limit(1);
        if (currentIssuance === undefined && currentRotation === undefined) {
          throw new SessionAccessError(
            'INVALID_CREDENTIAL',
            'The session credential is not current.',
          );
        }

        const idempotencyRecordId = randomUUID();
        await transaction.insert(idempotencyRecords).values({
          id: idempotencyRecordId,
          key: input.idempotencyKey,
          capabilityId: 'refresh-session',
          principal,
          principalDigest,
          requestDigest: input.requestDigest,
          status: 'in-progress',
          createdAt: input.rotatedAt,
          completedAt: null,
          resultReference: null,
        });
        await transaction.insert(sessionTokenRotations).values({
          id: input.rotationId,
          sessionId: lockedSession.id,
          previousTokenDigest: input.principal.presentedTokenDigest,
          nextTokenDigest: input.nextTokenDigest,
          rotatedAt: input.rotatedAt,
        });

        const epochRows = await transaction
          .select({ id: connectivityEpochs.id })
          .from(connectivityEpochs)
          .where(eq(connectivityEpochs.sessionId, lockedSession.id));
        const invalidatedRows =
          epochRows.length === 0
            ? []
            : await transaction
                .select({
                  connectivityEpochId:
                    connectivityEpochInvalidations.connectivityEpochId,
                })
                .from(connectivityEpochInvalidations)
                .where(
                  inArray(
                    connectivityEpochInvalidations.connectivityEpochId,
                    epochRows.map((row) => row.id),
                  ),
                );
        const invalidatedIds = new Set(
          invalidatedRows.map((row) => row.connectivityEpochId),
        );
        const activeEpochs = epochRows.filter(
          (row) => !invalidatedIds.has(row.id),
        );
        if (activeEpochs.length !== 1) {
          throw new SessionAccessError(
            'INVALID_CREDENTIAL',
            'Refresh requires exactly one active connectivity epoch.',
          );
        }
        await transaction.insert(connectivityEpochInvalidations).values({
          id: randomUUID(),
          connectivityEpochId: activeEpochs[0]?.id ?? '',
          reason: 'reconnected',
          invalidatedAt: input.rotatedAt,
        });
        await transaction.insert(connectivityEpochs).values({
          id: input.connectivityEpochId,
          sessionId: lockedSession.id,
          establishedAt: input.rotatedAt,
        });
        await transaction
          .update(deviceEnrollments)
          .set({ lastSeenAt: input.rotatedAt })
          .where(eq(deviceEnrollments.id, lockedSession.deviceEnrollmentId));

        const resultReference = `${REFRESH_RESULT_PREFIX}:${lockedSession.id}:${input.rotationId}:${input.connectivityEpochId}:${input.nextTokenDigest}`;
        await transaction
          .update(idempotencyRecords)
          .set({
            status: 'completed',
            completedAt: input.rotatedAt,
            resultReference,
          })
          .where(eq(idempotencyRecords.id, idempotencyRecordId));
        return Object.freeze({
          kind: 'success' as const,
          connectivityEpochId: input.connectivityEpochId,
        });
      },
    );
    if (transactionResult.kind === 'replay') {
      throw new SessionAccessError(
        'TOKEN_REPLAY',
        'The session credential is no longer current.',
      );
    }
    const context = await this.loadSessionContext(
      input.principal.sessionId,
      transactionResult.connectivityEpochId,
    );
    if (context === null) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The refreshed session could not be reconstructed.',
      );
    }
    return context;
  }

  public async completedRefreshRetry(
    input: CompletedRefreshRetryInput,
  ): Promise<StoredSessionContext | null> {
    const principal = refreshIdempotencyPrincipal(
      input.retired.sessionId,
      input.retired.deviceEnrollmentId,
      input.retired.tokenDigest,
    );
    const [record] = await this.database
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.capabilityId, 'refresh-session'),
          eq(idempotencyRecords.principalDigest, digestJson(principal)),
          eq(idempotencyRecords.key, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (record === undefined) {
      return null;
    }
    if (
      record.requestDigest !== input.requestDigest ||
      record.status !== 'completed' ||
      record.resultReference === null ||
      record.completedAt === null
    ) {
      throw new SessionAccessError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key is already bound to another request.',
      );
    }
    if (
      input.checkedAt.getTime() >=
      addSeconds(record.completedAt, REFRESH_RETRY_RECOVERY_SECONDS).getTime()
    ) {
      return null;
    }
    const reference = parseRefreshResultReference(record.resultReference);
    const successorDigest = input.successorDigest;
    if (
      reference === null ||
      reference.sessionId !== input.retired.sessionId ||
      reference.rotationId !== input.retired.rotationId ||
      reference.nextTokenDigest !== successorDigest
    ) {
      throw new SessionAccessError(
        'IDEMPOTENCY_CONFLICT',
        'The completed refresh result cannot be reconstructed.',
      );
    }
    const [rotation] = await this.database
      .select({ nextTokenDigest: sessionTokenRotations.nextTokenDigest })
      .from(sessionTokenRotations)
      .where(eq(sessionTokenRotations.id, reference.rotationId))
      .limit(1);
    if (rotation?.nextTokenDigest !== successorDigest) {
      throw new SessionAccessError(
        'IDEMPOTENCY_CONFLICT',
        'The completed refresh result does not match credential history.',
      );
    }
    const current = await this.inspectCredential(successorDigest);
    if (current.kind !== 'current') {
      return null;
    }
    return this.loadSessionContext(
      reference.sessionId,
      reference.connectivityEpochId,
    );
  }

  public async recordReplayAndRevoke(input: RecordReplayInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [lockedSession] = await transaction
        .select({
          id: sessions.id,
          deviceEnrollmentId: sessions.deviceEnrollmentId,
        })
        .from(sessions)
        .innerJoin(
          deviceEnrollments,
          eq(deviceEnrollments.id, sessions.deviceEnrollmentId),
        )
        .where(eq(sessions.id, input.retired.sessionId))
        .for('update')
        .limit(1);
      if (lockedSession === undefined) {
        return;
      }
      await transaction.insert(sessionTokenReplays).values({
        id: randomUUID(),
        sessionId: input.retired.sessionId,
        rotationId: input.retired.rotationId,
        detectedAt: input.detectedAt,
      });
      const [existingRevocation] = await transaction
        .select({ id: sessionRevocations.id })
        .from(sessionRevocations)
        .where(eq(sessionRevocations.sessionId, input.retired.sessionId))
        .limit(1);
      if (existingRevocation === undefined) {
        await transaction.insert(sessionRevocations).values({
          id: randomUUID(),
          sessionId: input.retired.sessionId,
          revokedBy: { kind: 'system', serviceId: 'session-auth' },
          reasonCode: 'REFRESH_TOKEN_REPLAY',
          revokedAt: input.detectedAt,
        });
        await appendDevicePushTokenUnregistrations(
          transaction,
          lockedSession.deviceEnrollmentId,
          input.detectedAt,
        );
      }
      const epochRows = await transaction
        .select({ id: connectivityEpochs.id })
        .from(connectivityEpochs)
        .where(eq(connectivityEpochs.sessionId, input.retired.sessionId));
      const invalidatedRows =
        epochRows.length === 0
          ? []
          : await transaction
              .select({
                connectivityEpochId:
                  connectivityEpochInvalidations.connectivityEpochId,
              })
              .from(connectivityEpochInvalidations)
              .where(
                inArray(
                  connectivityEpochInvalidations.connectivityEpochId,
                  epochRows.map((row) => row.id),
                ),
              );
      const invalidatedIds = new Set(
        invalidatedRows.map((row) => row.connectivityEpochId),
      );
      const activeEpochs = epochRows.filter(
        (row) => !invalidatedIds.has(row.id),
      );
      if (activeEpochs.length > 0) {
        await transaction.insert(connectivityEpochInvalidations).values(
          activeEpochs.map((row) => ({
            id: randomUUID(),
            connectivityEpochId: row.id,
            reason: 'session-revoked',
            invalidatedAt: input.detectedAt,
          })),
        );
      }
    });
  }

  public async revoke(
    input: RevokeStoredSessionInput,
  ): Promise<SessionRevocation> {
    const principal = IdempotencyPrincipalSchema.parse(input.actor);
    const principalDigest = digestJson(principal);
    const revocationId = await this.database.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${principalDigest}:${input.idempotencyKey}`}, 4018))`,
        );
        const [lockedSession] = await transaction
          .select({
            id: sessions.id,
            deviceEnrollmentId: sessions.deviceEnrollmentId,
          })
          .from(sessions)
          .innerJoin(
            deviceEnrollments,
            eq(deviceEnrollments.id, sessions.deviceEnrollmentId),
          )
          .where(eq(sessions.id, input.sessionId))
          .for('update')
          .limit(1);
        if (lockedSession === undefined) {
          throw new SessionAccessError(
            'FORBIDDEN',
            'Session revocation denied.',
          );
        }
        const [existingIdempotency] = await transaction
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.capabilityId, 'revoke-session'),
              eq(idempotencyRecords.principalDigest, principalDigest),
              eq(idempotencyRecords.key, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existingIdempotency !== undefined) {
          const parsedId =
            existingIdempotency.resultReference === null
              ? null
              : parseRevocationResultReference(
                  existingIdempotency.resultReference,
                );
          if (
            existingIdempotency.requestDigest !== input.requestDigest ||
            existingIdempotency.status !== 'completed' ||
            parsedId === null
          ) {
            throw new SessionAccessError(
              'IDEMPOTENCY_CONFLICT',
              'The idempotency key is already bound to another request.',
            );
          }
          return parsedId;
        }

        const idempotencyRecordId = randomUUID();
        await transaction.insert(idempotencyRecords).values({
          id: idempotencyRecordId,
          key: input.idempotencyKey,
          capabilityId: 'revoke-session',
          principal,
          principalDigest,
          requestDigest: input.requestDigest,
          status: 'in-progress',
          createdAt: input.revokedAt,
          completedAt: null,
          resultReference: null,
        });
        const [existingRevocation] = await transaction
          .select()
          .from(sessionRevocations)
          .where(eq(sessionRevocations.sessionId, input.sessionId))
          .orderBy(
            asc(sessionRevocations.revokedAt),
            asc(sessionRevocations.id),
          )
          .limit(1);
        const selectedRevocationId = existingRevocation?.id ?? randomUUID();
        if (existingRevocation === undefined) {
          await transaction.insert(sessionRevocations).values({
            id: selectedRevocationId,
            sessionId: input.sessionId,
            revokedBy: input.actor,
            reasonCode: input.reasonCode,
            revokedAt: input.revokedAt,
          });
          await appendDevicePushTokenUnregistrations(
            transaction,
            lockedSession.deviceEnrollmentId,
            input.revokedAt,
          );
        }

        const epochRows = await transaction
          .select({ id: connectivityEpochs.id })
          .from(connectivityEpochs)
          .where(eq(connectivityEpochs.sessionId, input.sessionId));
        const invalidatedRows =
          epochRows.length === 0
            ? []
            : await transaction
                .select({
                  connectivityEpochId:
                    connectivityEpochInvalidations.connectivityEpochId,
                })
                .from(connectivityEpochInvalidations)
                .where(
                  inArray(
                    connectivityEpochInvalidations.connectivityEpochId,
                    epochRows.map((row) => row.id),
                  ),
                );
        const invalidatedIds = new Set(
          invalidatedRows.map((row) => row.connectivityEpochId),
        );
        const activeEpochs = epochRows.filter(
          (row) => !invalidatedIds.has(row.id),
        );
        if (activeEpochs.length > 0) {
          await transaction.insert(connectivityEpochInvalidations).values(
            activeEpochs.map((row) => ({
              id: randomUUID(),
              connectivityEpochId: row.id,
              reason: 'session-revoked',
              invalidatedAt: input.revokedAt,
            })),
          );
        }

        await transaction
          .update(idempotencyRecords)
          .set({
            status: 'completed',
            completedAt: input.revokedAt,
            resultReference: `${REVOCATION_RESULT_PREFIX}:${selectedRevocationId}`,
          })
          .where(eq(idempotencyRecords.id, idempotencyRecordId));
        return selectedRevocationId;
      },
    );
    const [row] = await this.database
      .select()
      .from(sessionRevocations)
      .where(eq(sessionRevocations.id, revocationId))
      .limit(1);
    if (row === undefined) {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Session revocation could not be reconstructed.',
      );
    }
    return SessionRevocationSchema.parse({
      id: row.id,
      sessionId: row.sessionId,
      revokedBy: row.revokedBy,
      reasonCode: row.reasonCode,
      revokedAt: timestamp(row.revokedAt),
    });
  }

  public async completedSelfRevocationRetry(
    input: CompletedSelfRevocationRetryInput,
  ): Promise<SessionRevocation | null> {
    const credential = await this.inspectCredential(input.presentedTokenDigest);
    if (
      credential.kind !== 'current' ||
      credential.context.result.session.id !== input.sessionId ||
      credential.context.revocation === null ||
      credential.context.result.session.revokedAt === null
    ) {
      return null;
    }

    const expectedPrincipal = Object.freeze({
      kind: 'human' as const,
      userId: credential.context.result.user.id,
      sessionId: credential.context.result.session.id,
    });
    const principalDigest = digestJson(
      IdempotencyPrincipalSchema.parse(expectedPrincipal),
    );
    const [idempotency] = await this.database
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.capabilityId, 'revoke-session'),
          eq(idempotencyRecords.principalDigest, principalDigest),
          eq(idempotencyRecords.key, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (idempotency === undefined) return null;

    const storedPrincipal = IdempotencyPrincipalSchema.safeParse(
      idempotency.principal,
    );
    const revocationId =
      idempotency.resultReference === null
        ? null
        : parseRevocationResultReference(idempotency.resultReference);
    if (
      !storedPrincipal.success ||
      storedPrincipal.data.kind !== 'human' ||
      storedPrincipal.data.userId !== expectedPrincipal.userId ||
      storedPrincipal.data.sessionId !== expectedPrincipal.sessionId ||
      idempotency.requestDigest !== input.requestDigest ||
      idempotency.status !== 'completed' ||
      idempotency.completedAt === null ||
      revocationId === null ||
      credential.context.revocation.id !== revocationId
    ) {
      return null;
    }

    const [row] = await this.database
      .select()
      .from(sessionRevocations)
      .where(eq(sessionRevocations.id, revocationId))
      .limit(1);
    if (row === undefined || row.sessionId !== input.sessionId) return null;

    const stillCurrent = await this.inspectCredential(
      input.presentedTokenDigest,
    );
    if (
      stillCurrent.kind !== 'current' ||
      stillCurrent.context.result.session.id !== input.sessionId ||
      stillCurrent.context.revocation?.id !== revocationId
    ) {
      return null;
    }
    return SessionRevocationSchema.parse({
      id: row.id,
      sessionId: row.sessionId,
      revokedBy: row.revokedBy,
      reasonCode: row.reasonCode,
      revokedAt: timestamp(row.revokedAt),
    });
  }

  public getSession(sessionId: string): Promise<StoredSessionContext | null> {
    return this.loadSessionContext(sessionId);
  }

  public async listDeviceSessions(): Promise<readonly StoredSessionContext[]> {
    const sessionRows = await this.database
      .select({ id: sessions.id })
      .from(sessions)
      .orderBy(asc(sessions.id));
    const contexts: Array<StoredSessionContext | null> = new Array(
      sessionRows.length,
    ).fill(null);
    let nextIndex = 0;
    const workers = Array.from(
      {
        length: Math.min(SESSION_LIST_READ_CONCURRENCY, sessionRows.length),
      },
      async () => {
        while (nextIndex < sessionRows.length) {
          const index = nextIndex;
          nextIndex += 1;
          const row = sessionRows[index];
          if (row === undefined) {
            continue;
          }
          try {
            contexts[index] = await this.loadSessionContext(row.id);
          } catch (error) {
            if (
              error instanceof SessionAccessError &&
              error.code === 'INVALID_MEMBERSHIP_EVIDENCE'
            ) {
              contexts[index] = null;
              continue;
            }
            throw error;
          }
        }
      },
    );
    await Promise.all(workers);
    return contexts.filter(
      (context): context is StoredSessionContext => context !== null,
    );
  }
}

interface RefreshCapabilityContext {
  readonly service: SessionService;
  readonly token: string;
  readonly source: Extract<InvocationSource, 'web' | 'mobile'>;
  readonly prepared: Extract<
    Awaited<ReturnType<SessionService['prepareRefresh']>>,
    { readonly kind: 'verified' }
  >;
  readonly now: Date;
  readonly issuedHolder: { value?: IssuedDeviceSession };
}

const refreshSessionHandler = registerCapabilityHandler(
  'refresh-session',
  async (_input, context: RefreshCapabilityContext) => {
    const issued = await context.service.rotatePreparedRefresh(
      context.token,
      context.prepared,
      context.now,
    );
    context.issuedHolder.value = issued;
    return issued.result;
  },
);

const refreshAuthorizer: CapabilityExecutionAuthorizer<RefreshCapabilityContext> =
  {
    authorize: ({ definition, invocationPolicy, context }) => {
      if (
        definition.id !== 'refresh-session' ||
        !invocationPolicy.principalKinds.includes(
          'verified-refresh-credential',
        ) ||
        !invocationPolicy.sources.includes(context.source) ||
        context.prepared.principal.credentialState !== 'current'
      ) {
        throw new SessionAccessError(
          'FORBIDDEN',
          'Session refresh authorization failed.',
        );
      }
    },
  };

export interface ExecuteRefreshSessionInput {
  readonly service: SessionService;
  readonly token: string;
  readonly source: Extract<InvocationSource, 'web' | 'mobile'>;
  readonly idempotencyKey: string;
  readonly csrfVerified: boolean;
  readonly requestId?: string;
  readonly now?: Date;
}

/** Canonical capability entry point used by both web and mobile refresh. */
export async function executeRefreshSessionCapability(
  input: ExecuteRefreshSessionInput,
): Promise<IssuedDeviceSession> {
  if (input.source === 'web' && !input.csrfVerified) {
    throw new SessionAccessError(
      'FORBIDDEN',
      'Web session refresh requires verified same-origin CSRF protection.',
    );
  }
  const now = input.now ?? new Date();
  const prepared = await input.service.prepareRefresh(
    input.token,
    input.source,
    input.idempotencyKey,
    now,
  );
  if (prepared.kind === 'completed-retry') {
    return prepared.issued;
  }
  const envelope = parseCapabilityEnvelopeFor('refresh-session', {
    capabilityId: 'refresh-session',
    operation: 'mutation',
    principal: prepared.principal,
    source: input.source,
    requestId: input.requestId ?? randomUUID(),
    serverTime: timestamp(now),
    input: {},
    idempotencyKey: prepared.idempotencyKey,
    transport:
      input.source === 'web'
        ? {
            kind: 'web-refresh-cookie',
            method: 'POST',
            csrfVerified: input.csrfVerified,
            secure: true,
            httpOnly: true,
            sameSite: 'strict',
          }
        : { kind: 'mobile-refresh-bearer', method: 'POST' },
  });
  const issuedHolder: { value?: IssuedDeviceSession } = {};
  const context: RefreshCapabilityContext = {
    service: input.service,
    token: input.token,
    source: input.source,
    prepared,
    now,
    issuedHolder,
  };
  await executeCapability(refreshSessionHandler, envelope.input, {
    context,
    humanActionResolutionContext: null,
    safetyResolver: null,
    authorizer: refreshAuthorizer,
  });
  if (issuedHolder.value === undefined) {
    throw new SessionAccessError(
      'INVALID_CREDENTIAL',
      'Session refresh did not produce a successor credential.',
    );
  }
  return issuedHolder.value;
}

interface RevokeCapabilityContext {
  readonly service: SessionService;
  readonly authenticated: AuthenticatedSession;
  readonly idempotencyKey: string;
  readonly now: Date;
}

const revokeSessionHandler = registerCapabilityHandler(
  'revoke-session',
  (input, context: RevokeCapabilityContext) =>
    context.service.revoke(
      context.authenticated,
      input,
      context.idempotencyKey,
      context.now,
    ),
);

const revokeAuthorizer: CapabilityExecutionAuthorizer<RevokeCapabilityContext> =
  {
    authorize: ({ definition, invocationPolicy, context }) => {
      if (
        definition.id !== 'revoke-session' ||
        context.authenticated.actor.kind !== 'human' ||
        !invocationPolicy.principalKinds.includes('human') ||
        !invocationPolicy.sources.includes(context.authenticated.source)
      ) {
        throw new SessionAccessError(
          'FORBIDDEN',
          'Session revocation authorization failed.',
        );
      }
    },
  };

export interface ExecuteRevokeSessionInput {
  readonly service: SessionService;
  readonly authenticated: AuthenticatedSession;
  readonly sessionId: string;
  readonly reasonCode: string;
  readonly idempotencyKey: string;
  readonly csrfVerified: boolean;
  readonly requestId?: string;
  readonly now?: Date;
}

/** Canonical capability entry point for self/admin session revocation. */
export async function executeRevokeSessionCapability(
  input: ExecuteRevokeSessionInput,
): Promise<SessionRevocation> {
  const now = input.now ?? new Date();
  const capabilityInput = {
    sessionId: input.sessionId,
    reasonCode: input.reasonCode,
  };
  const envelope = parseCapabilityEnvelopeFor('revoke-session', {
    capabilityId: 'revoke-session',
    operation: 'mutation',
    actor: input.authenticated.actor,
    source: input.authenticated.source,
    scope: input.authenticated.scope,
    requestId: input.requestId ?? randomUUID(),
    serverTime: timestamp(now),
    input: capabilityInput,
    idempotencyKey: input.idempotencyKey,
    transport:
      input.authenticated.source === 'web'
        ? {
            kind: 'web-interactive',
            method: 'POST',
            interaction: 'explicit-user-submit',
            csrfVerified: input.csrfVerified,
          }
        : {
            kind: 'mobile-interactive',
            interaction: 'explicit-user-submit',
          },
    connectivityEpochId: input.authenticated.result.connectivityEpoch.id,
    requiredHumanActionIds: [],
    requiredConsequenceDigest: null,
    humanConfirmation: null,
  });
  const context: RevokeCapabilityContext = {
    service: input.service,
    authenticated: input.authenticated,
    idempotencyKey: input.idempotencyKey,
    now,
  };
  return executeCapability(revokeSessionHandler, envelope.input, {
    context,
    humanActionResolutionContext: null,
    safetyResolver: null,
    authorizer: revokeAuthorizer,
  });
}

interface ListDeviceSessionsCapabilityContext {
  readonly service: SessionService;
  readonly authenticated: AuthenticatedSession;
}

const listDeviceSessionsHandler = registerCapabilityHandler(
  'list-device-sessions',
  (input, context: ListDeviceSessionsCapabilityContext) =>
    context.service.listDeviceSessions(context.authenticated, input),
);

const listDeviceSessionsAuthorizer: CapabilityExecutionAuthorizer<ListDeviceSessionsCapabilityContext> =
  {
    authorize: ({ definition, invocationPolicy, context }) => {
      if (
        definition.id !== 'list-device-sessions' ||
        !context.authenticated.roles.includes('admin') ||
        !invocationPolicy.principalKinds.includes('human') ||
        !invocationPolicy.sources.includes(context.authenticated.source)
      ) {
        throw new SessionAccessError(
          'FORBIDDEN',
          'Administrator access is required.',
        );
      }
    },
  };

export async function executeListDeviceSessionsCapability(
  input: Readonly<{
    service: SessionService;
    authenticated: AuthenticatedSession;
    query: ListDeviceSessionsInput;
    requestId?: string;
    now?: Date;
  }>,
): Promise<DeviceSessionPage> {
  const now = input.now ?? new Date();
  const envelope = parseCapabilityEnvelopeFor('list-device-sessions', {
    capabilityId: 'list-device-sessions',
    operation: 'query',
    actor: input.authenticated.actor,
    source: input.authenticated.source,
    scope: input.authenticated.scope,
    requestId: input.requestId ?? randomUUID(),
    serverTime: timestamp(now),
    input: input.query,
  });
  const context: ListDeviceSessionsCapabilityContext = {
    service: input.service,
    authenticated: input.authenticated,
  };
  return executeCapability(listDeviceSessionsHandler, envelope.input, {
    context,
    humanActionResolutionContext: null,
    safetyResolver: null,
    authorizer: listDeviceSessionsAuthorizer,
  });
}

export interface DefaultSessionServiceRuntimeDependencies {
  readonly createConnection: () => DatabaseConnection;
  readonly createStore?: (connection: DatabaseConnection) => SessionStore;
  readonly readPolicy?: () => SessionPolicy;
  readonly authenticationTimeoutMilliseconds?: number;
  readonly scheduleAuthenticationTimeout?: (
    timeoutMilliseconds: number,
    onTimeout: () => void,
  ) => () => void;
}

/**
 * Owns one cached database-backed service generation and fences recovery so an
 * older failed generation can never clear or close its replacement.
 */
export class DefaultSessionServiceRuntime {
  private readonly authenticationTimeoutMilliseconds: number;
  private connection: DatabaseConnection | undefined;
  private service: SessionService | undefined;

  public constructor(
    private readonly dependencies: DefaultSessionServiceRuntimeDependencies,
  ) {
    const timeout =
      dependencies.authenticationTimeoutMilliseconds ??
      DEFAULT_SESSION_AUTHENTICATION_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeout) || timeout < 1) {
      throw new SessionConfigurationError(
        'The session authentication timeout must be a positive integer.',
      );
    }
    this.authenticationTimeoutMilliseconds = timeout;
  }

  /** Lazily returns the current service, creating exactly one generation. */
  public get(): SessionService {
    if (this.service !== undefined) return this.service;

    const policy = this.dependencies.readPolicy?.() ?? readSessionPolicy();
    const connection = this.dependencies.createConnection();
    const store =
      this.dependencies.createStore?.(connection) ??
      new DrizzleSessionStore(connection.db);
    const service = new SessionService(
      store,
      policy,
      Object.freeze({
        scheduleTimeout: (onTimeout: () => void) => {
          if (this.dependencies.scheduleAuthenticationTimeout !== undefined) {
            return this.dependencies.scheduleAuthenticationTimeout(
              this.authenticationTimeoutMilliseconds,
              onTimeout,
            );
          }
          const timeout = setTimeout(
            onTimeout,
            this.authenticationTimeoutMilliseconds,
          );
          return () => clearTimeout(timeout);
        },
        recover: async (
          _reason: SessionAuthenticationRecoveryReason,
          pendingAuthentication: Promise<void>,
        ) => {
          if (this.connection === connection && this.service === service) {
            this.connection = undefined;
            this.service = undefined;
          }
          // Start forced teardown immediately, then drain both edges even when
          // teardown itself reports an error. Returning before the captured
          // inspection settles would leave the timed-out operation running in
          // the background and could surface an unhandled driver rejection.
          await Promise.allSettled([connection.close(), pendingAuthentication]);
        },
      }),
    );
    this.connection = connection;
    this.service = service;
    return service;
  }

  /** Clears and closes only the current generation. */
  public async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.service = undefined;
    await connection?.close();
  }
}

const defaultSessionServiceRuntime = new DefaultSessionServiceRuntime({
  createConnection: () => createDatabaseClient(readDatabaseConfig()),
});

/** Lazily creates the role-authenticated database-backed session service. */
export function getDefaultSessionService(): SessionService {
  return defaultSessionServiceRuntime.get();
}

/** Lifecycle hook for tests/scripts; normal Next.js processes retain the pool. */
export async function closeDefaultSessionService(): Promise<void> {
  await defaultSessionServiceRuntime.close();
}
