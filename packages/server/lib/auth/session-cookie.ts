import { createHash, randomBytes } from 'node:crypto';

import {
  CompleteOidcSignInInputSchema,
  IdempotencyKeySchema,
  IdempotencyPrincipalSchema,
  SessionEstablishmentResultSchema,
  UuidSchema,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  type AccessMembershipMember,
  type AccessMembershipSnapshot,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type CompleteOidcSignInInput,
  type IdempotencyPrincipal,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityEnvelope,
  type RegisteredCapabilityId,
  type Role,
  type SessionEstablishmentResult,
  type User,
} from '@psd-eoc/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  connectivityEpochs,
  deviceEnrollments,
  groupSources,
  idempotencyRecords,
  securityAuditEntries,
  sessions,
  sessionTokenIssuances,
  userFacilityScopes,
  userRoles,
  users,
} from '../../db/schema';
import {
  ACCESS_GATE_AUDIT_LOCK_SQL,
  buildAccessGateAuditEntry,
  toAccessGateAuditInsertValues,
} from './access-gate';

/**
 * The __Host- prefix makes browsers require Secure, Path=/, and no Domain.
 * Keep the cookie opaque: it contains no user, session, or authorization data.
 */
export const WEB_SESSION_COOKIE_NAME = '__Host-psd-eoc-session';

const SESSION_CREDENTIAL_BYTES = 48;
const SHA_256_HEX_LENGTH = 64;
const SESSION_TRANSACTION_ATTEMPTS = 5;
const AUDIT_CHAIN_UNIQUE_CONSTRAINTS = [
  'security_audit_entries_sequence_uq',
] as const;

/** Time policy supplied by trusted server configuration. */
export interface WebSessionPolicy {
  /** Overall device session and cookie lifetime. */
  readonly sessionLifetimeSeconds: number;
  /** Normal membership validity measured from snapshot capture time. */
  readonly membershipTtlSeconds: number;
  /** Additional outage grace measured after normal membership validity. */
  readonly membershipGraceSeconds: number;
}

/**
 * The minimum group evidence needed by initial session issuance. The full
 * snapshot can contain up to 1,200 members, so it is deliberately not copied
 * into request context.
 */
export interface GroupAuthorizedWebIdentity {
  readonly user: User;
  readonly membershipSnapshot: Readonly<
    Pick<
      AccessMembershipSnapshot,
      'id' | 'version' | 'complete' | 'syncStartedAt' | 'capturedAt'
    >
  >;
  readonly membershipMember: AccessMembershipMember;
  /**
   * True only after the immutable Google subject matches trusted bootstrap
   * configuration. It may add the admin role, never bypass group membership.
   */
  readonly grantBootstrapAdmin: boolean;
}

/** Cookie shape accepted by NextResponse.cookies.set without importing Next. */
export interface WebSessionCookie {
  readonly name: typeof WEB_SESSION_COOKIE_NAME;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
  readonly expires: Date;
}

/** Request-local protected delivery channel for the raw session credential. */
export interface WebSessionCookieSink {
  readonly set: (cookie: WebSessionCookie) => void | Promise<void>;
}

/** Request-local delivery channel for a native opaque session bearer. */
export interface MobileSessionBearerSink {
  readonly set: (bearer: string) => void | Promise<void>;
}

/** Server-owned context used by the canonical sign-in capability handler. */
export interface CompleteOidcSignInContext {
  readonly authorization: GroupAuthorizedWebIdentity;
  readonly cookieSink?: WebSessionCookieSink;
  readonly bearerSink?: MobileSessionBearerSink;
  /** Full parsed pre-session envelope; the capability engine receives its input. */
  readonly envelope: RegisteredCapabilityEnvelope<'complete-oidc-sign-in'>;
  /** Digest of the callback response, never its code or raw parameters. */
  readonly responseDigest: string;
}

/** Atomic persistence command. It contains a digest, never the credential. */
export interface PersistInitialWebSessionRequest {
  readonly user: User;
  readonly membershipSnapshot: GroupAuthorizedWebIdentity['membershipSnapshot'];
  readonly membershipMember: AccessMembershipMember;
  readonly device: CompleteOidcSignInInput['device'];
  readonly credentialDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly membershipValidUntil: Date;
  readonly membershipGraceUntil: Date;
  readonly grantBootstrapAdmin: boolean;
  readonly requestId: string;
  readonly idempotency: Readonly<{
    key: string;
    principal: IdempotencyPrincipal;
    principalDigest: string;
    requestDigest: string;
  }>;
}

/** Dependency boundary used by unit tests and the production Drizzle adapter. */
export interface InitialWebSessionStore {
  readonly persist: (
    request: PersistInitialWebSessionRequest,
  ) => Promise<SessionEstablishmentResult>;
}

/** Dependencies closed over by the registered capability handler. */
export interface WebSessionIssuerDependencies {
  readonly store: InitialWebSessionStore;
  readonly policy: WebSessionPolicy;
  readonly now?: () => Date;
}

export type WebSessionIssuanceErrorCode =
  | 'INVALID_AUTHORIZATION_CONTEXT'
  | 'INVALID_SESSION_POLICY'
  | 'MEMBERSHIP_NOT_CURRENT'
  | 'PERSISTED_RESULT_MISMATCH'
  | 'SESSION_REPLAY_REJECTED'
  | 'SESSION_PERSISTENCE_REJECTED';

/** Bounded, PII-free failure suitable for denial handling and audit codes. */
export class WebSessionIssuanceError extends Error {
  public readonly code: WebSessionIssuanceErrorCode;

  public constructor(code: WebSessionIssuanceErrorCode, message: string) {
    super(message);
    this.name = 'WebSessionIssuanceError';
    this.code = code;
  }
}

function assertPositiveSafeInteger(
  name: keyof WebSessionPolicy,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebSessionIssuanceError(
      'INVALID_SESSION_POLICY',
      `${name} must be a positive safe integer.`,
    );
  }
}

function validatePolicy(policy: WebSessionPolicy): Readonly<WebSessionPolicy> {
  assertPositiveSafeInteger(
    'sessionLifetimeSeconds',
    policy.sessionLifetimeSeconds,
  );
  assertPositiveSafeInteger(
    'membershipTtlSeconds',
    policy.membershipTtlSeconds,
  );
  assertPositiveSafeInteger(
    'membershipGraceSeconds',
    policy.membershipGraceSeconds,
  );
  return Object.freeze({ ...policy });
}

function addSeconds(date: Date, seconds: number): Date {
  const timestamp = date.getTime() + seconds * 1_000;
  if (!Number.isSafeInteger(timestamp)) {
    throw new WebSessionIssuanceError(
      'INVALID_SESSION_POLICY',
      'Session time policy exceeds the supported date range.',
    );
  }
  const result = new Date(timestamp);
  if (Number.isNaN(result.getTime())) {
    throw new WebSessionIssuanceError(
      'INVALID_SESSION_POLICY',
      'Session time policy produced an invalid date.',
    );
  }
  return result;
}

function parseTimestamp(value: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'Membership evidence has an invalid capture time.',
    );
  }
  return result;
}

function generateOpaqueCredential(): string {
  return randomBytes(SESSION_CREDENTIAL_BYTES).toString('base64url');
}

/** SHA-256 digest used for lookup and persistence of an opaque credential. */
export function digestWebSessionCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

function sameFacilityScope(
  left: User['facilityScope'],
  right: User['facilityScope'],
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

function assertGroupAuthorizedContext(
  input: CompleteOidcSignInInput,
  authorization: GroupAuthorizedWebIdentity,
): void {
  const syncStartedAt = Date.parse(
    authorization.membershipSnapshot.syncStartedAt,
  );
  const capturedAt = Date.parse(authorization.membershipSnapshot.capturedAt);
  if (
    !UuidSchema.safeParse(authorization.membershipSnapshot.id).success ||
    !Number.isSafeInteger(authorization.membershipSnapshot.version) ||
    authorization.membershipSnapshot.version < 1 ||
    Number.isNaN(syncStartedAt) ||
    Number.isNaN(capturedAt) ||
    syncStartedAt > capturedAt ||
    authorization.membershipSnapshot.complete !== true ||
    authorization.user.disabledAt !== null ||
    authorization.user.googleSubject !== input.claims.subject ||
    authorization.membershipMember.userId !== authorization.user.id ||
    authorization.membershipMember.googleSubject !== input.claims.subject ||
    !sameFacilityScope(
      authorization.membershipMember.facilityScope,
      authorization.user.facilityScope,
    ) ||
    authorization.membershipMember.accessGroupSourceRefs.length === 0
  ) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'A complete matching Google Group membership is required.',
    );
  }
}

interface ValidatedSignInInvocation {
  readonly requestId: string;
  readonly idempotency: PersistInitialWebSessionRequest['idempotency'];
}

function validateSignInInvocation(
  input: CompleteOidcSignInInput,
  context: CompleteOidcSignInContext,
): ValidatedSignInInvocation {
  let envelope: RegisteredCapabilityEnvelope<'complete-oidc-sign-in'>;
  try {
    envelope = parseCapabilityEnvelopeFor<'complete-oidc-sign-in'>(
      'complete-oidc-sign-in',
      context.envelope,
    );
  } catch {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'The verified callback envelope is invalid.',
    );
  }
  const responseDigest = context.responseDigest;
  if (
    !/^[a-f0-9]{64}$/u.test(responseDigest) ||
    envelope.idempotencyKey !== `oidc:${responseDigest}` ||
    JSON.stringify(envelope.input) !== JSON.stringify(input)
  ) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'The verified callback envelope does not match the sign-in request.',
    );
  }

  const principal = IdempotencyPrincipalSchema.parse({
    kind: 'oidc-callback',
    subjectDigest: input.claims.subjectDigest,
    responseDigest,
  });
  const principalDigest = createHash('sha256')
    .update(JSON.stringify(principal), 'utf8')
    .digest('hex');
  const requestDigest = createHash('sha256')
    .update(
      JSON.stringify({
        input: envelope.input,
        transport: envelope.transport,
      }),
      'utf8',
    )
    .digest('hex');
  return Object.freeze({
    requestId: envelope.requestId,
    idempotency: Object.freeze({
      key: envelope.idempotencyKey,
      principal,
      principalDigest,
      requestDigest,
    }),
  });
}

type CredentialDelivery =
  | Readonly<{ kind: 'web'; sink: WebSessionCookieSink }>
  | Readonly<{ kind: 'mobile'; sink: MobileSessionBearerSink }>;

function resolveCredentialDelivery(
  input: CompleteOidcSignInInput,
  context: CompleteOidcSignInContext,
): CredentialDelivery {
  const web = context.envelope.source === 'web';
  if (
    web &&
    input.device.platform === 'web' &&
    input.device.unlockMethod === 'secure-session-cookie' &&
    context.cookieSink !== undefined &&
    context.bearerSink === undefined
  ) {
    return Object.freeze({ kind: 'web', sink: context.cookieSink });
  }
  if (
    !web &&
    (input.device.platform === 'ios' || input.device.platform === 'android') &&
    input.device.unlockMethod === 'biometric' &&
    context.bearerSink !== undefined &&
    context.cookieSink === undefined
  ) {
    return Object.freeze({ kind: 'mobile', sink: context.bearerSink });
  }
  throw new WebSessionIssuanceError(
    'INVALID_AUTHORIZATION_CONTEXT',
    'The sign-in credential transport does not match its device enrollment.',
  );
}

function readTrustedNow(now: (() => Date) | undefined): Date {
  const result = new Date((now ?? (() => new Date()))().getTime());
  if (Number.isNaN(result.getTime())) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'The trusted session clock returned an invalid time.',
    );
  }
  return result;
}

function resolveMembershipTimes(
  authorization: GroupAuthorizedWebIdentity,
  policy: WebSessionPolicy,
  now: Date,
): Readonly<{
  membershipValidUntil: Date;
  membershipGraceUntil: Date;
}> {
  const capturedAt = parseTimestamp(
    authorization.membershipSnapshot.capturedAt,
  );
  if (capturedAt.getTime() > now.getTime()) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'Membership evidence cannot be captured in the future.',
    );
  }
  const membershipValidUntil = addSeconds(
    capturedAt,
    policy.membershipTtlSeconds,
  );
  if (membershipValidUntil.getTime() <= now.getTime()) {
    throw new WebSessionIssuanceError(
      'MEMBERSHIP_NOT_CURRENT',
      'A new session requires current Google Group membership evidence.',
    );
  }
  return Object.freeze({
    membershipValidUntil,
    membershipGraceUntil: addSeconds(
      membershipValidUntil,
      policy.membershipGraceSeconds,
    ),
  });
}

/**
 * Canonical pre-handler authorizer for the OIDC completion capability. The
 * route must first parse the verified OIDC callback envelope; this authorizer
 * then binds those claims to complete, current server-resolved group evidence.
 */
export function createCompleteOidcSignInAuthorizer(
  dependencies: Pick<WebSessionIssuerDependencies, 'policy' | 'now'>,
): Readonly<CapabilityExecutionAuthorizer<CompleteOidcSignInContext>> {
  const policy = validatePolicy(dependencies.policy);
  return Object.freeze({
    authorize: (
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        CompleteOidcSignInContext
      >,
    ): void => {
      if (request.definition.id !== 'complete-oidc-sign-in') {
        throw new WebSessionIssuanceError(
          'INVALID_AUTHORIZATION_CONTEXT',
          'The sign-in authorizer rejects other capabilities.',
        );
      }
      const input = CompleteOidcSignInInputSchema.parse(request.input);
      resolveCredentialDelivery(input, request.context);
      validateSignInInvocation(input, request.context);
      assertGroupAuthorizedContext(input, request.context.authorization);
      resolveMembershipTimes(
        request.context.authorization,
        policy,
        readTrustedNow(dependencies.now),
      );
    },
  });
}

function assertPersistedResultMatchesRequest(
  result: SessionEstablishmentResult,
  request: PersistInitialWebSessionRequest,
): void {
  const expectedRoles = request.grantBootstrapAdmin
    ? new Set<Role>([...request.user.roles, 'admin'])
    : null;
  const matches =
    result.user.id === request.user.id &&
    result.user.googleSubject === request.user.googleSubject &&
    result.user.disabledAt === null &&
    sameFacilityScope(result.user.facilityScope, request.user.facilityScope) &&
    result.session.authorization.kind === 'group-membership' &&
    result.session.authorization.source === 'google-group-snapshot' &&
    result.session.authorization.membershipSnapshotId ===
      request.membershipSnapshot.id &&
    result.session.authorization.membershipValidUntil ===
      request.membershipValidUntil.toISOString() &&
    result.session.authorization.membershipGraceUntil ===
      request.membershipGraceUntil.toISOString() &&
    result.session.createdAt === request.createdAt.toISOString() &&
    result.session.expiresAt === request.expiresAt.toISOString() &&
    result.deviceEnrollment.platform === request.device.platform &&
    result.deviceEnrollment.unlockMethod === request.device.unlockMethod &&
    result.deviceEnrollment.installationId === request.device.installationId &&
    (expectedRoles === null ||
      [...expectedRoles].every((role) => result.user.roles.includes(role)));

  if (!matches) {
    throw new WebSessionIssuanceError(
      'PERSISTED_RESULT_MISMATCH',
      'Persisted session evidence does not match the authorized request.',
    );
  }
}

/**
 * Issues one initial session after cryptographic OIDC verification and the
 * server authorizer have completed. The raw credential is sent only to the
 * protected request-local sink and never appears in the canonical result or
 * store.
 */
async function establishInitialWebSession(
  inputValue: CompleteOidcSignInInput,
  context: CompleteOidcSignInContext,
  dependencies: WebSessionIssuerDependencies,
): Promise<SessionEstablishmentResult> {
  const input = CompleteOidcSignInInputSchema.parse(inputValue);
  const credentialDelivery = resolveCredentialDelivery(input, context);
  const invocation = validateSignInInvocation(input, context);

  const policy = validatePolicy(dependencies.policy);
  assertGroupAuthorizedContext(input, context.authorization);

  const now = readTrustedNow(dependencies.now);
  const { membershipValidUntil, membershipGraceUntil } = resolveMembershipTimes(
    context.authorization,
    policy,
    now,
  );
  const expiresAt = addSeconds(now, policy.sessionLifetimeSeconds);

  const credential = generateOpaqueCredential();
  const credentialDigest = digestWebSessionCredential(credential);
  if (credentialDigest.length !== SHA_256_HEX_LENGTH) {
    throw new WebSessionIssuanceError(
      'SESSION_PERSISTENCE_REJECTED',
      'The session credential digest could not be created.',
    );
  }

  const request: PersistInitialWebSessionRequest = Object.freeze({
    user: context.authorization.user,
    membershipSnapshot: context.authorization.membershipSnapshot,
    membershipMember: context.authorization.membershipMember,
    device: input.device,
    credentialDigest,
    createdAt: now,
    expiresAt,
    membershipValidUntil,
    membershipGraceUntil,
    grantBootstrapAdmin: context.authorization.grantBootstrapAdmin,
    requestId: invocation.requestId,
    idempotency: invocation.idempotency,
  });

  const result = SessionEstablishmentResultSchema.parse(
    await dependencies.store.persist(request),
  );
  assertPersistedResultMatchesRequest(result, request);

  if (credentialDelivery.kind === 'web') {
    await credentialDelivery.sink.set(
      Object.freeze({
        name: WEB_SESSION_COOKIE_NAME,
        value: credential,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: policy.sessionLifetimeSeconds,
        expires: expiresAt,
      }),
    );
  } else {
    await credentialDelivery.sink.set(credential);
  }

  return result;
}

/**
 * Registers initial session establishment under the canonical capability ID.
 * Callers must still pass this registration to executeCapability with the
 * central server authorizer; this factory does not create a side-door path.
 */
export function createCompleteOidcSignInHandler(
  dependencies: WebSessionIssuerDependencies,
): Readonly<
  RegisteredCapabilityHandler<
    'complete-oidc-sign-in',
    CompleteOidcSignInContext
  >
> {
  validatePolicy(dependencies.policy);
  return registerCapabilityHandler(
    'complete-oidc-sign-in',
    async (input, context) =>
      establishInitialWebSession(input, context, dependencies),
  );
}

function toIsoString(value: Date): string {
  return value.toISOString();
}

function sortedRoles(roles: readonly Role[]): readonly Role[] {
  const order: Readonly<Record<Role, number>> = { staff: 0, admin: 1 };
  return [...new Set(roles)].sort((left, right) => order[left] - order[right]);
}

function accessGroupKey(source: {
  readonly id: string;
  readonly kind: string;
  readonly purpose: string;
}): string {
  return `${source.id}:${source.kind}:${source.purpose}`;
}

function sameNonemptyKeySet(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size > 0 &&
    left.size === right.size &&
    [...left].every((key) => right.has(key))
  );
}

/** Recognizes only rollback-safe database conflicts for bounded retries. */
export function isRetryableSessionTransactionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') {
      return false;
    }
    const code = Reflect.get(current, 'code');
    const constraint = Reflect.get(current, 'constraint_name');
    const message = Reflect.get(current, 'message');
    const messageText = typeof message === 'string' ? message : '';
    if (
      code === '40001' ||
      code === '40P01' ||
      /\b(?:40001|40P01)\b/u.test(messageText) ||
      /could not serialize access|deadlock detected/iu.test(messageText)
    ) {
      return true;
    }
    const isUniqueViolation =
      code === '23505' ||
      /\b23505\b/u.test(messageText) ||
      /duplicate key value|unique constraint/iu.test(messageText);
    const namesAuditConstraint = AUDIT_CHAIN_UNIQUE_CONSTRAINTS.some(
      (name) => constraint === name || messageText.includes(name),
    );
    if (isUniqueViolation && namesAuditConstraint) {
      return true;
    }
    current = Reflect.get(current, 'cause');
  }
  return false;
}

function sessionTransactionRetryDelayMilliseconds(attempt: number): number {
  const base = Math.min(20 * 2 ** (attempt - 1), 160);
  const entropy = randomBytes(1)[0] ?? 0;
  return base + (entropy % base);
}

function assertPersistableIdempotency(
  request: PersistInitialWebSessionRequest,
): void {
  const principal = IdempotencyPrincipalSchema.safeParse(
    request.idempotency.principal,
  );
  const expectedPrincipalDigest = principal.success
    ? createHash('sha256')
        .update(JSON.stringify(principal.data), 'utf8')
        .digest('hex')
    : null;
  const subjectDigest = createHash('sha256')
    .update(request.user.googleSubject, 'utf8')
    .digest('hex');
  if (
    !IdempotencyKeySchema.safeParse(request.idempotency.key).success ||
    !principal.success ||
    principal.data.kind !== 'oidc-callback' ||
    principal.data.subjectDigest !== subjectDigest ||
    request.idempotency.key !== `oidc:${principal.data.responseDigest}` ||
    request.idempotency.principalDigest !== expectedPrincipalDigest ||
    !/^[a-f0-9]{64}$/u.test(request.idempotency.requestDigest) ||
    !UuidSchema.safeParse(request.requestId).success
  ) {
    throw new WebSessionIssuanceError(
      'SESSION_PERSISTENCE_REJECTED',
      'The sign-in replay-protection evidence is invalid.',
    );
  }
}

/**
 * Production persistence adapter. Membership evidence, optional bootstrap
 * role grant, device enrollment, session, token digest, and connectivity epoch
 * are committed in one transaction. The raw credential never reaches it.
 */
export function createDrizzleInitialWebSessionStore(
  database: Database,
): InitialWebSessionStore {
  return Object.freeze({
    async persist(
      request: PersistInitialWebSessionRequest,
    ): Promise<SessionEstablishmentResult> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await database.transaction(async (transaction) => {
            await transaction.execute(
              sql`set transaction isolation level serializable`,
            );

            if (!/^[a-f0-9]{64}$/u.test(request.credentialDigest)) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The session credential digest is invalid.',
              );
            }
            assertPersistableIdempotency(request);

            const [idempotencyReservation] = await transaction
              .insert(idempotencyRecords)
              .values({
                key: request.idempotency.key,
                capabilityId: 'complete-oidc-sign-in',
                principal: request.idempotency.principal,
                principalDigest: request.idempotency.principalDigest,
                requestDigest: request.idempotency.requestDigest,
                status: 'in-progress',
                createdAt: request.createdAt,
              })
              .onConflictDoNothing({
                target: [
                  idempotencyRecords.capabilityId,
                  idempotencyRecords.principalDigest,
                  idempotencyRecords.key,
                ],
              })
              .returning();
            if (idempotencyReservation === undefined) {
              throw new WebSessionIssuanceError(
                'SESSION_REPLAY_REJECTED',
                'The verified OIDC callback was already consumed.',
              );
            }

            const [latestSnapshot] = await transaction
              .select({
                id: accessMembershipSnapshots.id,
                version: accessMembershipSnapshots.version,
                syncStartedAt: accessMembershipSnapshots.syncStartedAt,
              })
              .from(accessMembershipSnapshots)
              .where(eq(accessMembershipSnapshots.complete, true))
              .orderBy(desc(accessMembershipSnapshots.version))
              .limit(1)
              .for('share');

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

            const [membership] = await transaction
              .select({
                userId: accessMembershipMembers.userId,
                googleSubject: accessMembershipMembers.googleSubject,
                facilityScopeKind: accessMembershipMembers.facilityScopeKind,
                snapshotComplete: accessMembershipSnapshots.complete,
                capturedAt: accessMembershipSnapshots.capturedAt,
              })
              .from(accessMembershipMembers)
              .innerJoin(
                accessMembershipSnapshots,
                eq(
                  accessMembershipSnapshots.id,
                  accessMembershipMembers.snapshotId,
                ),
              )
              .where(
                and(
                  eq(
                    accessMembershipMembers.snapshotId,
                    request.membershipSnapshot.id,
                  ),
                  eq(accessMembershipMembers.userId, request.user.id),
                  eq(
                    accessMembershipMembers.googleSubject,
                    request.user.googleSubject,
                  ),
                ),
              )
              .limit(1)
              .for('share');

            const snapshotGroupEvidence = await transaction
              .select({
                id: accessMembershipSnapshotGroups.groupSourceId,
                kind: accessMembershipSnapshotGroups.groupSourceKind,
                purpose: accessMembershipSnapshotGroups.groupPurpose,
                completionKind: accessMembershipSnapshotGroups.completionKind,
              })
              .from(accessMembershipSnapshotGroups)
              .where(
                eq(
                  accessMembershipSnapshotGroups.snapshotId,
                  request.membershipSnapshot.id,
                ),
              )
              .for('share');
            const expectedGroupKeys = new Set(
              snapshotGroupEvidence
                .filter(({ completionKind }) => completionKind === 'expected')
                .map(accessGroupKey),
            );
            const completedGroupKeys = new Set(
              snapshotGroupEvidence
                .filter(({ completionKind }) => completionKind === 'completed')
                .map(accessGroupKey),
            );

            const currentActiveGroups = await transaction
              .select({
                id: groupSources.id,
                kind: groupSources.kind,
                purpose: groupSources.purpose,
              })
              .from(groupSources)
              .where(
                and(
                  eq(groupSources.active, true),
                  eq(groupSources.kind, 'google-group'),
                  eq(groupSources.purpose, 'access'),
                ),
              )
              .for('share');
            const currentActiveGroupKeys = new Set(
              currentActiveGroups.map(accessGroupKey),
            );
            const snapshotGroupsMatch =
              sameNonemptyKeySet(expectedGroupKeys, completedGroupKeys) &&
              sameNonemptyKeySet(expectedGroupKeys, currentActiveGroupKeys);

            const membershipGroupEvidence = await transaction
              .select({
                id: accessMembershipMemberGroups.groupSourceId,
                kind: accessMembershipMemberGroups.groupSourceKind,
                purpose: accessMembershipMemberGroups.groupPurpose,
              })
              .from(accessMembershipMemberGroups)
              .where(
                and(
                  eq(
                    accessMembershipMemberGroups.snapshotId,
                    request.membershipSnapshot.id,
                  ),
                  eq(accessMembershipMemberGroups.userId, request.user.id),
                ),
              )
              .for('share');
            const membershipGroupKeys = new Set(
              membershipGroupEvidence.map(accessGroupKey),
            );
            const membershipFacilityEvidence = await transaction
              .select({
                facilityId: accessMembershipMemberFacilities.facilityId,
              })
              .from(accessMembershipMemberFacilities)
              .where(
                and(
                  eq(
                    accessMembershipMemberFacilities.snapshotId,
                    request.membershipSnapshot.id,
                  ),
                  eq(accessMembershipMemberFacilities.userId, request.user.id),
                ),
              )
              .for('share');
            const contextGroupKeys = new Set(
              request.membershipMember.accessGroupSourceRefs.map(
                accessGroupKey,
              ),
            );
            const hasDesignatedMembership = [...contextGroupKeys].some(
              (key) =>
                expectedGroupKeys.has(key) &&
                completedGroupKeys.has(key) &&
                currentActiveGroupKeys.has(key) &&
                membershipGroupKeys.has(key),
            );
            const contextMatchesPersistedMembership =
              contextGroupKeys.size === membershipGroupKeys.size &&
              [...contextGroupKeys].every((key) =>
                membershipGroupKeys.has(key),
              );

            if (
              latestSnapshot === undefined ||
              latestSnapshot.id !== request.membershipSnapshot.id ||
              latestSnapshot.version !== request.membershipSnapshot.version ||
              latestSnapshot.syncStartedAt.getTime() !==
                new Date(request.membershipSnapshot.syncStartedAt).getTime() ||
              (latestSuccessfulGroupSourceUpdate !== undefined &&
                latestSnapshot.syncStartedAt.getTime() <=
                  latestSuccessfulGroupSourceUpdate.occurredAt.getTime()) ||
              membership === undefined ||
              !snapshotGroupsMatch ||
              !contextMatchesPersistedMembership ||
              !hasDesignatedMembership ||
              membership.snapshotComplete !== true ||
              membership.userId !== request.membershipMember.userId ||
              membership.googleSubject !==
                request.membershipMember.googleSubject ||
              membership.capturedAt.getTime() !==
                new Date(request.membershipSnapshot.capturedAt).getTime()
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'Authoritative Google Group membership could not be confirmed.',
              );
            }

            const [persistedUser] = await transaction
              .select()
              .from(users)
              .where(eq(users.id, request.user.id))
              .limit(1)
              .for('share');
            if (
              persistedUser === undefined ||
              persistedUser.googleSubject !== request.user.googleSubject ||
              persistedUser.disabledAt !== null
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The authorized staff identity is not active.',
              );
            }

            if (request.grantBootstrapAdmin) {
              await transaction
                .insert(userRoles)
                .values({ userId: request.user.id, role: 'admin' })
                .onConflictDoNothing();
            }

            const persistedRoles = await transaction
              .select({ role: userRoles.role })
              .from(userRoles)
              .where(eq(userRoles.userId, request.user.id))
              .for('share');
            const roles = sortedRoles(persistedRoles.map(({ role }) => role));

            const persistedFacilityScopes = await transaction
              .select({ facilityId: userFacilityScopes.facilityId })
              .from(userFacilityScopes)
              .where(eq(userFacilityScopes.userId, request.user.id))
              .for('share');
            const facilityScope =
              persistedUser.facilityScopeKind === 'district'
                ? persistedFacilityScopes.length === 0
                  ? ({ kind: 'district' } as const)
                  : null
                : persistedFacilityScopes.length > 0
                  ? ({
                      kind: 'facilities',
                      facilityIds: persistedFacilityScopes
                        .map(({ facilityId }) => facilityId)
                        .sort(),
                    } as const)
                  : null;
            const membershipFacilityIds = membershipFacilityEvidence
              .map(({ facilityId }) => facilityId)
              .sort();
            const membershipFacilityScope =
              membership?.facilityScopeKind === 'district'
                ? membershipFacilityIds.length === 0
                  ? ({ kind: 'district' } as const)
                  : null
                : membership?.facilityScopeKind === 'facilities' &&
                    membershipFacilityIds.length > 0
                  ? ({
                      kind: 'facilities',
                      facilityIds: membershipFacilityIds,
                    } as const)
                  : null;
            if (
              facilityScope === null ||
              membershipFacilityScope === null ||
              !sameFacilityScope(
                membershipFacilityScope,
                request.membershipMember.facilityScope,
              ) ||
              !sameFacilityScope(membershipFacilityScope, facilityScope) ||
              !sameFacilityScope(facilityScope, request.user.facilityScope)
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'Authoritative facility scope could not be confirmed.',
              );
            }

            await transaction
              .insert(deviceEnrollments)
              .values({
                userId: request.user.id,
                platform: request.device.platform,
                unlockMethod: request.device.unlockMethod,
                installationId: request.device.installationId,
                enrolledAt: request.createdAt,
                lastSeenAt: request.createdAt,
              })
              .onConflictDoNothing();

            const [device] = await transaction
              .select()
              .from(deviceEnrollments)
              .where(
                eq(
                  deviceEnrollments.installationId,
                  request.device.installationId,
                ),
              )
              .limit(1);
            if (
              device === undefined ||
              device.userId !== request.user.id ||
              device.platform !== request.device.platform ||
              device.unlockMethod !== request.device.unlockMethod ||
              device.revokedAt !== null
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The device enrollment is unavailable.',
              );
            }

            const [activeDevice] = await transaction
              .update(deviceEnrollments)
              .set({
                lastSeenAt: sql`greatest(
                  ${deviceEnrollments.lastSeenAt},
                  ${request.createdAt.toISOString()}::timestamptz
                )`,
              })
              .where(
                and(
                  eq(deviceEnrollments.id, device.id),
                  eq(deviceEnrollments.userId, request.user.id),
                  eq(deviceEnrollments.platform, request.device.platform),
                  isNull(deviceEnrollments.revokedAt),
                ),
              )
              .returning();
            if (activeDevice === undefined) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The device enrollment became unavailable.',
              );
            }

            const [session] = await transaction
              .insert(sessions)
              .values({
                userId: request.user.id,
                deviceEnrollmentId: activeDevice.id,
                membershipSnapshotId: request.membershipSnapshot.id,
                membershipValidUntil: request.membershipValidUntil,
                membershipGraceUntil: request.membershipGraceUntil,
                createdAt: request.createdAt,
                expiresAt: request.expiresAt,
              })
              .returning();
            if (session === undefined) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The session record could not be created.',
              );
            }

            await transaction.insert(sessionTokenIssuances).values({
              sessionId: session.id,
              tokenDigest: request.credentialDigest,
              issuedAt: request.createdAt,
            });

            const [connectivityEpoch] = await transaction
              .insert(connectivityEpochs)
              .values({
                sessionId: session.id,
                establishedAt: request.createdAt,
              })
              .returning();
            if (connectivityEpoch === undefined) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The connectivity epoch could not be created.',
              );
            }

            const result = SessionEstablishmentResultSchema.parse({
              user: {
                id: persistedUser.id,
                googleSubject: persistedUser.googleSubject,
                email: persistedUser.email,
                displayName: persistedUser.displayName,
                roles,
                facilityScope,
                createdAt: toIsoString(persistedUser.createdAt),
                disabledAt:
                  persistedUser.disabledAt === null
                    ? null
                    : toIsoString(persistedUser.disabledAt),
              },
              session: {
                id: session.id,
                userId: session.userId,
                deviceEnrollmentId: session.deviceEnrollmentId,
                createdAt: toIsoString(session.createdAt),
                expiresAt: toIsoString(session.expiresAt),
                authorization: {
                  kind: 'group-membership',
                  source: 'google-group-snapshot',
                  membershipSnapshotId: session.membershipSnapshotId,
                  membershipValidUntil: toIsoString(
                    session.membershipValidUntil,
                  ),
                  membershipGraceUntil: toIsoString(
                    session.membershipGraceUntil,
                  ),
                },
                revokedAt:
                  session.revokedAt === null
                    ? null
                    : toIsoString(session.revokedAt),
              },
              deviceEnrollment: {
                id: activeDevice.id,
                userId: activeDevice.userId,
                platform: activeDevice.platform,
                unlockMethod: activeDevice.unlockMethod,
                installationId: activeDevice.installationId,
                enrolledAt: toIsoString(activeDevice.enrolledAt),
                lastSeenAt: toIsoString(activeDevice.lastSeenAt),
                revokedAt:
                  activeDevice.revokedAt === null
                    ? null
                    : toIsoString(activeDevice.revokedAt),
              },
              connectivityEpoch: {
                id: connectivityEpoch.id,
                sessionId: connectivityEpoch.sessionId,
                establishedAt: toIsoString(connectivityEpoch.establishedAt),
              },
            });

            // A mismatch must abort this transaction before success evidence.
            assertPersistedResultMatchesRequest(result, request);

            await transaction.execute(ACCESS_GATE_AUDIT_LOCK_SQL);
            const [previousAuditEntry] = await transaction
              .select({
                sequence: securityAuditEntries.sequence,
                entryHash: securityAuditEntries.entryHash,
              })
              .from(securityAuditEntries)
              .orderBy(desc(securityAuditEntries.sequence))
              .limit(1);
            const auditEntry = buildAccessGateAuditEntry(
              {
                outcome: 'success',
                requestId: request.requestId,
                occurredAt: request.createdAt.toISOString(),
                userId: result.user.id,
                sessionId: result.session.id,
                source: request.device.platform === 'web' ? 'web' : 'mobile',
              },
              previousAuditEntry ?? null,
            );
            await transaction
              .insert(securityAuditEntries)
              .values(toAccessGateAuditInsertValues(auditEntry));

            const [completedIdempotency] = await transaction
              .update(idempotencyRecords)
              .set({
                status: 'completed',
                completedAt: request.createdAt,
                resultReference: `session:${result.session.id}`,
              })
              .where(
                and(
                  eq(idempotencyRecords.id, idempotencyReservation.id),
                  eq(idempotencyRecords.status, 'in-progress'),
                  eq(
                    idempotencyRecords.requestDigest,
                    request.idempotency.requestDigest,
                  ),
                ),
              )
              .returning();
            if (completedIdempotency === undefined) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The sign-in replay-protection record could not be completed.',
              );
            }

            return result;
          });
        } catch (error) {
          const retryable = isRetryableSessionTransactionError(error);
          if (attempt >= SESSION_TRANSACTION_ATTEMPTS || !retryable) {
            if (error instanceof WebSessionIssuanceError) {
              throw error;
            }
            throw new WebSessionIssuanceError(
              'SESSION_PERSISTENCE_REJECTED',
              'The initial session could not be persisted.',
            );
          }
          await new Promise<void>((resolve) => {
            setTimeout(
              resolve,
              sessionTransactionRetryDelayMilliseconds(attempt),
            );
          });
        }
      }
    },
  });
}
