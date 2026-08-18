import { createHash, randomBytes } from 'node:crypto';

import {
  AccessGroupSourceRefSchema,
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
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipEvaluatedMembers,
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
  userRoleChanges,
  users,
} from '../../db/schema';
import {
  ACCESS_GATE_AUDIT_LOCK_SQL,
  DESIGNATED_ACCESS_GROUP_EMAIL,
  buildAccessGateAuditEntry,
  toAccessGateAuditInsertValues,
} from './access-gate';
import type { AccessGateFirstLoginBinding } from './access-gate';
import {
  ADMIN_AVAILABILITY_LOCK_SQL,
  loadEffectiveAdministratorUserIds,
  loadEffectiveRoles,
} from './role-state';

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
  readonly firstLoginBinding?: AccessGateFirstLoginBinding | null;
  /**
   * True only after exact designated-group authorization. The legacy field
   * name remains at this seam while persistence enforces the group evidence.
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
  readonly firstLoginBinding?: AccessGateFirstLoginBinding | null;
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

function digestVerifiedEmail(email: string): string {
  return createHash('sha256').update(email, 'utf8').digest('hex');
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
    authorization.user.email !== input.claims.email ||
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
  const binding = authorization.firstLoginBinding ?? null;
  if (
    binding !== null &&
    ((binding.userDisposition !== 'create' &&
      binding.userDisposition !== 'existing') ||
      binding.successorSnapshotId !== authorization.membershipSnapshot.id ||
      binding.successorSnapshotVersion !==
        authorization.membershipSnapshot.version ||
      binding.sourceSnapshotVersion + 1 !== binding.successorSnapshotVersion ||
      binding.normalizedEmail !== authorization.user.email ||
      (binding.transitionEmailDigest !== null &&
        (!/^[a-f0-9]{64}$/u.test(binding.transitionEmailDigest) ||
          binding.transitionEmailDigest !==
            digestVerifiedEmail(authorization.user.email))) ||
      (binding.userDisposition === 'existing' &&
        binding.transitionEmailDigest !== null) ||
      authorization.user.facilityScope.kind !== 'district' ||
      (binding.userDisposition === 'create' &&
        (authorization.user.roles.length !== 1 ||
          authorization.user.roles[0] !== 'admin')))
  ) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'First-login binding evidence does not match the authorized identity.',
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
  const requestedRoles = new Set<Role>(request.user.roles);
  const rolesMatch =
    request.user.roles.every((role) => result.user.roles.includes(role)) &&
    result.user.roles.every(
      (role) =>
        requestedRoles.has(role) ||
        (request.grantBootstrapAdmin && role === 'admin'),
    ) &&
    (!request.grantBootstrapAdmin || result.user.roles.includes('admin'));
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
    rolesMatch;

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
    firstLoginBinding: context.authorization.firstLoginBinding ?? null,
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

function accessGroupKey(source: {
  readonly id: string;
  readonly kind: string;
  readonly purpose: string;
}): string {
  return `${source.id}:${source.kind}:${source.purpose}`;
}

function canonicalAccessGroupKeySet(
  sources: readonly unknown[],
): ReadonlySet<string> | null {
  const keys: string[] = [];
  const ids: string[] = [];
  for (const source of sources) {
    const parsed = AccessGroupSourceRefSchema.safeParse(source);
    if (
      !parsed.success ||
      parsed.data.kind !== 'google-group' ||
      parsed.data.purpose !== 'access' ||
      parsed.data.facilityId !== null
    ) {
      return null;
    }
    ids.push(parsed.data.id);
    keys.push(accessGroupKey(parsed.data));
  }
  if (
    keys.length === 0 ||
    new Set(ids).size !== ids.length ||
    new Set(keys).size !== keys.length
  ) {
    return null;
  }
  return new Set(keys);
}

function sameNonemptyKeySet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size > 0 &&
    left.size === right.size &&
    [...left].every((key) => right.has(key))
  );
}

/** Recognizes only rollback-safe database conflicts for bounded retries. */
/**
 * Bounded, non-sensitive description of a failed persistence attempt.
 *
 * Only structural PostgreSQL fields are included. `detail`, `hint`, and `where`
 * are deliberately omitted: PostgreSQL embeds the offending row's column values
 * in those, which for this transaction means staff email and Google subject.
 * The result is safe to log and carries enough to identify the failing write.
 */
export function describeSessionPersistenceFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    for (const field of [
      'name',
      'code',
      'constraint_name',
      'table_name',
      'column_name',
      'routine',
      'severity',
    ] as const) {
      const value = Reflect.get(current, field);
      if (typeof value === 'string' && value.length > 0 && value.length < 200) {
        parts.push(`${field}=${value}`);
      }
    }
    const message = Reflect.get(current, 'message');
    if (typeof message === 'string' && message.length > 0) {
      parts.push(`message=${message.slice(0, 300)}`);
    }
    const cause: unknown = Reflect.get(current, 'cause');
    if (cause === undefined || cause === null) break;
    parts.push('caused-by');
    current = cause;
  }
  return parts.length > 0 ? parts.join(' ') : 'no structured error detail';
}

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
 * Production persistence adapter. Optional first-login identity binding,
 * immutable membership evidence, designated-group admin grant, device,
 * session, token digest, and connectivity epoch are committed in one
 * transaction. The raw credential never reaches it.
 */
export interface InitialWebSessionStoreConfiguration {
  /** Independently trusted one-time selector; never accepted from context. */
  readonly initialMobileTransitionEmailDigest?: string | null;
}

export function createDrizzleInitialWebSessionStore(
  database: Database,
  configuration: InitialWebSessionStoreConfiguration = {},
): InitialWebSessionStore {
  const configuredTransitionEmailDigest =
    configuration.initialMobileTransitionEmailDigest ?? null;
  if (
    configuredTransitionEmailDigest !== null &&
    !/^[a-f0-9]{64}$/u.test(configuredTransitionEmailDigest)
  ) {
    throw new WebSessionIssuanceError(
      'SESSION_PERSISTENCE_REJECTED',
      'The initial mobile transition configuration is invalid.',
    );
  }
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
            if (request.grantBootstrapAdmin) {
              await transaction.execute(ADMIN_AVAILABILITY_LOCK_SQL);
            }

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

            const firstLoginBinding = request.firstLoginBinding ?? null;
            if (firstLoginBinding !== null) {
              const contextGroupKeys = canonicalAccessGroupKeySet(
                request.membershipMember.accessGroupSourceRefs,
              );
              const createdAt = new Date(request.user.createdAt);
              if (
                firstLoginBinding.successorSnapshotId !==
                  request.membershipSnapshot.id ||
                firstLoginBinding.successorSnapshotVersion !==
                  request.membershipSnapshot.version ||
                firstLoginBinding.sourceSnapshotVersion + 1 !==
                  firstLoginBinding.successorSnapshotVersion ||
                firstLoginBinding.normalizedEmail !== request.user.email ||
                (firstLoginBinding.transitionEmailDigest !== null &&
                  (!/^[a-f0-9]{64}$/u.test(
                    firstLoginBinding.transitionEmailDigest,
                  ) ||
                    firstLoginBinding.transitionEmailDigest !==
                      digestVerifiedEmail(request.user.email))) ||
                (firstLoginBinding.userDisposition === 'existing' &&
                  firstLoginBinding.transitionEmailDigest !== null) ||
                request.membershipMember.userId !== request.user.id ||
                request.membershipMember.googleSubject !==
                  request.user.googleSubject ||
                request.membershipMember.facilityScope.kind !== 'district' ||
                request.user.facilityScope.kind !== 'district' ||
                (firstLoginBinding.userDisposition !== 'create' &&
                  firstLoginBinding.userDisposition !== 'existing') ||
                (firstLoginBinding.userDisposition === 'create' &&
                  (request.user.roles.length !== 1 ||
                    request.user.roles[0] !== 'admin')) ||
                request.user.disabledAt !== null ||
                !UuidSchema.safeParse(request.user.id).success ||
                !UuidSchema.safeParse(firstLoginBinding.sourceSnapshotId)
                  .success ||
                !UuidSchema.safeParse(firstLoginBinding.successorSnapshotId)
                  .success ||
                request.user.email !== request.user.email.toLowerCase() ||
                request.user.email !== request.user.email.trim() ||
                request.user.displayName !== request.user.displayName.trim() ||
                request.user.displayName.length === 0 ||
                request.user.displayName.length > 160 ||
                /\p{Cc}/u.test(request.user.displayName) ||
                Number.isNaN(createdAt.getTime()) ||
                contextGroupKeys === null
              ) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'The first-login identity binding is invalid.',
                );
              }

              const [sourceSnapshot] = await transaction
                .select()
                .from(accessMembershipSnapshots)
                .where(
                  and(
                    eq(
                      accessMembershipSnapshots.id,
                      firstLoginBinding.sourceSnapshotId,
                    ),
                    eq(
                      accessMembershipSnapshots.version,
                      firstLoginBinding.sourceSnapshotVersion,
                    ),
                    eq(accessMembershipSnapshots.complete, true),
                  ),
                )
                .limit(1)
                .for('share');
              const [latestSourceSnapshot] = await transaction
                .select({
                  id: accessMembershipSnapshots.id,
                  version: accessMembershipSnapshots.version,
                })
                .from(accessMembershipSnapshots)
                .where(eq(accessMembershipSnapshots.complete, true))
                .orderBy(desc(accessMembershipSnapshots.version))
                .limit(1)
                .for('share');
              if (
                sourceSnapshot === undefined ||
                latestSourceSnapshot?.id !== sourceSnapshot.id ||
                latestSourceSnapshot.version !== sourceSnapshot.version ||
                sourceSnapshot.syncStartedAt.getTime() !==
                  new Date(
                    request.membershipSnapshot.syncStartedAt,
                  ).getTime() ||
                sourceSnapshot.capturedAt.getTime() !==
                  new Date(request.membershipSnapshot.capturedAt).getTime()
              ) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'The evaluated access snapshot is no longer current.',
                );
              }

              const activeSources = await transaction
                .select({
                  id: groupSources.id,
                  email: groupSources.email,
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
              const activeGroupKeys = canonicalAccessGroupKeySet(
                activeSources.map(({ id, kind, purpose }) => ({
                  id,
                  kind,
                  purpose,
                  facilityId: null,
                })),
              );
              const designatedSources = activeSources.filter(
                ({ email }) => email === DESIGNATED_ACCESS_GROUP_EMAIL,
              );
              const designatedSource = designatedSources[0];
              const designatedGroupKeys = canonicalAccessGroupKeySet(
                designatedSource === undefined
                  ? []
                  : [
                      {
                        id: designatedSource.id,
                        kind: designatedSource.kind,
                        purpose: designatedSource.purpose,
                        facilityId: null,
                      },
                    ],
              );
              const recoverySources = activeSources.filter(
                ({ id }) => id !== designatedSource?.id,
              );
              const recoveryTransition = recoverySources.length === 1;
              if (
                designatedSources.length !== 1 ||
                activeSources.length > 2 ||
                activeGroupKeys === null ||
                designatedGroupKeys === null ||
                !sameNonemptyKeySet(designatedGroupKeys, contextGroupKeys) ||
                (recoveryTransition &&
                  (request.device.platform !== 'ios' ||
                    firstLoginBinding.userDisposition !== 'create' ||
                    firstLoginBinding.transitionEmailDigest === null ||
                    configuredTransitionEmailDigest === null ||
                    firstLoginBinding.transitionEmailDigest !==
                      configuredTransitionEmailDigest)) ||
                (!recoveryTransition &&
                  firstLoginBinding.transitionEmailDigest !== null)
              ) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'The designated access-group configuration is ambiguous.',
                );
              }

              const sourceSnapshotGroups = await transaction
                .select()
                .from(accessMembershipSnapshotGroups)
                .where(
                  eq(
                    accessMembershipSnapshotGroups.snapshotId,
                    sourceSnapshot.id,
                  ),
                )
                .for('share');
              const expectedGroupKeys = canonicalAccessGroupKeySet(
                sourceSnapshotGroups
                  .filter(({ completionKind }) => completionKind === 'expected')
                  .map(({ groupSourceId, groupSourceKind, groupPurpose }) => ({
                    id: groupSourceId,
                    kind: groupSourceKind,
                    purpose: groupPurpose,
                    facilityId: null,
                  })),
              );
              const completedGroupKeys = canonicalAccessGroupKeySet(
                sourceSnapshotGroups
                  .filter(
                    ({ completionKind }) => completionKind === 'completed',
                  )
                  .map(({ groupSourceId, groupSourceKind, groupPurpose }) => ({
                    id: groupSourceId,
                    kind: groupSourceKind,
                    purpose: groupPurpose,
                    facilityId: null,
                  })),
              );
              if (
                expectedGroupKeys === null ||
                completedGroupKeys === null ||
                sourceSnapshotGroups.length !== activeSources.length * 2 ||
                !sameNonemptyKeySet(expectedGroupKeys, activeGroupKeys) ||
                !sameNonemptyKeySet(completedGroupKeys, activeGroupKeys)
              ) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'The evaluated access snapshot is incomplete.',
                );
              }

              // Reads of access_membership_evaluated_members take no row lock.
              // The table is granted SELECT and INSERT only, deliberately
              // withholding UPDATE and DELETE so published access evidence
              // cannot be mutated. PostgreSQL requires UPDATE, DELETE, or
              // TRUNCATE for any locking clause, so `FOR SHARE` on this table
              // fails with 42501 permission denied. The lock would protect
              // nothing regardless: rows the privilege model forbids updating
              // or deleting cannot change underneath the transaction.
              const evaluatedGroupRows = await transaction
                .select({
                  id: accessMembershipEvaluatedMembers.groupSourceId,
                  kind: accessMembershipEvaluatedMembers.groupSourceKind,
                  purpose: accessMembershipEvaluatedMembers.groupPurpose,
                })
                .from(accessMembershipEvaluatedMembers)
                .where(
                  and(
                    eq(
                      accessMembershipEvaluatedMembers.snapshotId,
                      sourceSnapshot.id,
                    ),
                    eq(
                      accessMembershipEvaluatedMembers.email,
                      firstLoginBinding.normalizedEmail,
                    ),
                  ),
                );
              const evaluatedGroupKeys = canonicalAccessGroupKeySet(
                evaluatedGroupRows.map(({ id, kind, purpose }) => ({
                  id,
                  kind,
                  purpose,
                  facilityId: null,
                })),
              );
              if (
                evaluatedGroupKeys === null ||
                !sameNonemptyKeySet(evaluatedGroupKeys, designatedGroupKeys)
              ) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'Exact evaluated email membership could not be confirmed.',
                );
              }

              const identityMatches = await transaction
                .select()
                .from(users)
                .where(
                  or(
                    eq(users.id, request.user.id),
                    eq(users.googleSubject, request.user.googleSubject),
                    eq(users.email, request.user.email),
                  ),
                )
                .limit(3)
                .for('share');
              const existingIdentity = identityMatches[0];
              const identityBindingInvalid =
                firstLoginBinding.userDisposition === 'create'
                  ? identityMatches.length !== 0
                  : identityMatches.length !== 1 ||
                    existingIdentity === undefined ||
                    existingIdentity.id !== request.user.id ||
                    existingIdentity.googleSubject !==
                      request.user.googleSubject ||
                    existingIdentity.email !== request.user.email ||
                    existingIdentity.displayName !== request.user.displayName ||
                    existingIdentity.facilityScopeKind !== 'district' ||
                    existingIdentity.disabledAt !== null ||
                    existingIdentity.createdAt.getTime() !==
                      createdAt.getTime();
              if (identityBindingInvalid) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'The verified identity became ambiguous before binding.',
                );
              }

              const sourceEvaluatedMembers = await transaction
                .select()
                .from(accessMembershipEvaluatedMembers)
                .where(
                  eq(
                    accessMembershipEvaluatedMembers.snapshotId,
                    sourceSnapshot.id,
                  ),
                );
              const sourceMembers = await transaction
                .select()
                .from(accessMembershipMembers)
                .where(
                  eq(accessMembershipMembers.snapshotId, sourceSnapshot.id),
                )
                .for('share');
              const sourceMemberGroups = await transaction
                .select()
                .from(accessMembershipMemberGroups)
                .where(
                  eq(
                    accessMembershipMemberGroups.snapshotId,
                    sourceSnapshot.id,
                  ),
                )
                .for('share');
              const sourceMemberFacilities = await transaction
                .select()
                .from(accessMembershipMemberFacilities)
                .where(
                  eq(
                    accessMembershipMemberFacilities.snapshotId,
                    sourceSnapshot.id,
                  ),
                )
                .for('share');

              const sourceMember = sourceMembers.find(
                ({ userId }) => userId === request.user.id,
              );
              const sourceBindingGroups = sourceMemberGroups.filter(
                ({ userId }) => userId === request.user.id,
              );
              const sourceBindingFacilities = sourceMemberFacilities.filter(
                ({ userId }) => userId === request.user.id,
              );
              const sourceAlreadyHasDesignatedMembership =
                sourceBindingGroups.some(
                  ({ groupSourceId, groupSourceKind, groupPurpose }) =>
                    designatedGroupKeys.has(
                      accessGroupKey({
                        id: groupSourceId,
                        kind: groupSourceKind,
                        purpose: groupPurpose,
                      }),
                    ),
                );
              if (
                (firstLoginBinding.userDisposition === 'existing' &&
                  ((sourceMember !== undefined &&
                    (sourceMember.googleSubject !==
                      request.user.googleSubject ||
                      sourceMember.facilityScopeKind !== 'district' ||
                      sourceBindingFacilities.length !== 0)) ||
                    sourceAlreadyHasDesignatedMembership)) ||
                (firstLoginBinding.userDisposition === 'create' &&
                  sourceMember !== undefined)
              ) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'The source identity binding no longer matches the request.',
                );
              }

              if (recoveryTransition) {
                const recoverySource = recoverySources[0];
                const recoveryMember = sourceMembers[0];
                const recoveryMemberGroup = sourceMemberGroups[0];
                const recoveryIdentityRows =
                  recoveryMember === undefined
                    ? []
                    : await transaction
                        .select({
                          id: users.id,
                          googleSubject: users.googleSubject,
                          facilityScopeKind: users.facilityScopeKind,
                          disabledAt: users.disabledAt,
                        })
                        .from(users)
                        .where(eq(users.id, recoveryMember.userId))
                        .limit(2)
                        .for('share');
                const recoveryIdentity = recoveryIdentityRows[0];
                const recoveryFacilityRows =
                  recoveryIdentity === undefined
                    ? []
                    : await transaction
                        .select({ userId: userFacilityScopes.userId })
                        .from(userFacilityScopes)
                        .where(
                          eq(userFacilityScopes.userId, recoveryIdentity.id),
                        )
                        .for('share');
                const effectiveAdministratorIds =
                  recoverySource === undefined
                    ? []
                    : await loadEffectiveAdministratorUserIds(transaction, {
                        accessState: {
                          snapshotId: sourceSnapshot.id,
                          snapshotVersion: sourceSnapshot.version,
                          activeAccessGroupSourceIds: activeSources
                            .map(({ id }) => id)
                            .sort(),
                        },
                        eligibleAccessGroupSourceIds: [recoverySource.id],
                      });
                if (
                  recoverySource === undefined ||
                  recoveryMember === undefined ||
                  recoveryMemberGroup === undefined ||
                  recoveryIdentity === undefined ||
                  recoveryIdentityRows.length !== 1 ||
                  sourceMembers.length !== 1 ||
                  sourceMemberGroups.length !== 1 ||
                  sourceMemberFacilities.length !== 0 ||
                  recoveryMember.userId === request.user.id ||
                  recoveryMember.facilityScopeKind !== 'district' ||
                  recoveryIdentity.id !== recoveryMember.userId ||
                  recoveryIdentity.googleSubject !==
                    recoveryMember.googleSubject ||
                  recoveryIdentity.facilityScopeKind !== 'district' ||
                  recoveryIdentity.disabledAt !== null ||
                  recoveryFacilityRows.length !== 0 ||
                  recoveryMemberGroup.userId !== recoveryMember.userId ||
                  recoveryMemberGroup.groupSourceId !== recoverySource.id ||
                  recoveryMemberGroup.groupSourceKind !== recoverySource.kind ||
                  recoveryMemberGroup.groupPurpose !== recoverySource.purpose ||
                  firstLoginBinding.userDisposition !== 'create' ||
                  firstLoginBinding.transitionEmailDigest === null ||
                  firstLoginBinding.transitionEmailDigest !==
                    digestVerifiedEmail(request.user.email) ||
                  sourceEvaluatedMembers.some(
                    ({ groupSourceId }) =>
                      groupSourceId !== designatedSource?.id,
                  ) ||
                  effectiveAdministratorIds.length !== 1 ||
                  effectiveAdministratorIds[0] !== recoveryMember.userId
                ) {
                  throw new WebSessionIssuanceError(
                    'SESSION_PERSISTENCE_REJECTED',
                    'The temporary recovery generation is ambiguous.',
                  );
                }
              }

              let bindingUserId = request.user.id;
              if (firstLoginBinding.userDisposition === 'create') {
                const [insertedUser] = await transaction
                  .insert(users)
                  .values({
                    id: request.user.id,
                    googleSubject: request.user.googleSubject,
                    email: request.user.email,
                    displayName: request.user.displayName,
                    facilityScopeKind: 'district',
                    createdAt,
                    disabledAt: null,
                  })
                  .returning();
                if (insertedUser === undefined) {
                  throw new WebSessionIssuanceError(
                    'SESSION_PERSISTENCE_REJECTED',
                    'The first-login identity could not be created.',
                  );
                }
                bindingUserId = insertedUser.id;
              }
              const [insertedSnapshot] = await transaction
                .insert(accessMembershipSnapshots)
                .values({
                  id: firstLoginBinding.successorSnapshotId,
                  version: firstLoginBinding.successorSnapshotVersion,
                  complete: true,
                  syncStartedAt: sourceSnapshot.syncStartedAt,
                  capturedAt: sourceSnapshot.capturedAt,
                })
                .returning();
              if (insertedSnapshot === undefined) {
                throw new WebSessionIssuanceError(
                  'SESSION_PERSISTENCE_REJECTED',
                  'The evaluated-email successor could not be created.',
                );
              }

              const successorSnapshotGroups = sourceSnapshotGroups;
              const successorEvaluatedMembers = sourceEvaluatedMembers;
              const successorMembers = sourceMembers;
              const successorMemberGroups = sourceMemberGroups;
              const successorMemberFacilities = sourceMemberFacilities;

              await transaction.insert(accessMembershipSnapshotGroups).values(
                successorSnapshotGroups.map((row) => ({
                  ...row,
                  snapshotId: insertedSnapshot.id,
                })),
              );
              if (successorEvaluatedMembers.length > 0) {
                await transaction
                  .insert(accessMembershipEvaluatedMembers)
                  .values(
                    successorEvaluatedMembers.map((row) => ({
                      ...row,
                      snapshotId: insertedSnapshot.id,
                    })),
                  );
              }
              if (successorMembers.length > 0) {
                await transaction.insert(accessMembershipMembers).values(
                  successorMembers.map((row) => ({
                    ...row,
                    snapshotId: insertedSnapshot.id,
                  })),
                );
              }
              if (successorMemberGroups.length > 0) {
                await transaction.insert(accessMembershipMemberGroups).values(
                  successorMemberGroups.map((row) => ({
                    ...row,
                    snapshotId: insertedSnapshot.id,
                  })),
                );
              }
              if (successorMemberFacilities.length > 0) {
                await transaction
                  .insert(accessMembershipMemberFacilities)
                  .values(
                    successorMemberFacilities.map((row) => ({
                      ...row,
                      snapshotId: insertedSnapshot.id,
                    })),
                  );
              }
              if (sourceMember === undefined) {
                await transaction.insert(accessMembershipMembers).values({
                  snapshotId: insertedSnapshot.id,
                  userId: bindingUserId,
                  googleSubject: request.user.googleSubject,
                  facilityScopeKind: 'district',
                });
              }
              await transaction.insert(accessMembershipMemberGroups).values(
                evaluatedGroupRows.map(({ id, kind, purpose }) => ({
                  snapshotId: insertedSnapshot.id,
                  userId: bindingUserId,
                  groupSourceId: id,
                  groupSourceKind: kind,
                  groupPurpose: purpose,
                })),
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
            const expectedGroupKeys = canonicalAccessGroupKeySet(
              snapshotGroupEvidence
                .filter(({ completionKind }) => completionKind === 'expected')
                .map(({ id, kind, purpose }) => ({
                  id,
                  kind,
                  purpose,
                  facilityId: null,
                })),
            );
            const completedGroupKeys = canonicalAccessGroupKeySet(
              snapshotGroupEvidence
                .filter(({ completionKind }) => completionKind === 'completed')
                .map(({ id, kind, purpose }) => ({
                  id,
                  kind,
                  purpose,
                  facilityId: null,
                })),
            );

            const currentActiveGroups = await transaction
              .select({
                id: groupSources.id,
                email: groupSources.email,
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
            const currentActiveGroupKeys = canonicalAccessGroupKeySet(
              currentActiveGroups.map(({ id, kind, purpose }) => ({
                id,
                kind,
                purpose,
                facilityId: null,
              })),
            );
            const currentDesignatedGroups = currentActiveGroups.filter(
              ({ email }) => email === DESIGNATED_ACCESS_GROUP_EMAIL,
            );
            const currentDesignatedGroupKeys = canonicalAccessGroupKeySet(
              currentDesignatedGroups.map(({ id, kind, purpose }) => ({
                id,
                kind,
                purpose,
                facilityId: null,
              })),
            );
            const currentRecoveryGroupKeys = canonicalAccessGroupKeySet(
              currentActiveGroups
                .filter(({ email }) => email !== DESIGNATED_ACCESS_GROUP_EMAIL)
                .map(({ id, kind, purpose }) => ({
                  id,
                  kind,
                  purpose,
                  facilityId: null,
                })),
            );
            const snapshotGroupsMatch =
              currentDesignatedGroups.length === 1 &&
              currentActiveGroups.length <= 2 &&
              expectedGroupKeys !== null &&
              completedGroupKeys !== null &&
              currentActiveGroupKeys !== null &&
              snapshotGroupEvidence.length ===
                expectedGroupKeys.size + completedGroupKeys.size &&
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
            const membershipGroupKeys = canonicalAccessGroupKeySet(
              membershipGroupEvidence.map(({ id, kind, purpose }) => ({
                id,
                kind,
                purpose,
                facilityId: null,
              })),
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
            const contextGroupKeys = canonicalAccessGroupKeySet(
              request.membershipMember.accessGroupSourceRefs,
            );
            const contextMatchesPersistedMembership =
              contextGroupKeys !== null &&
              membershipGroupKeys !== null &&
              currentActiveGroupKeys !== null &&
              sameNonemptyKeySet(contextGroupKeys, membershipGroupKeys) &&
              [...contextGroupKeys].every((key) =>
                currentActiveGroupKeys.has(key),
              );
            const authorizationRoles = await loadEffectiveRoles(
              transaction,
              request.user.id,
            );
            const currentRecoverySourceIds = currentActiveGroups
              .filter(({ email }) => email !== DESIGNATED_ACCESS_GROUP_EMAIL)
              .map(({ id }) => id);
            const transitionAdministratorIds =
              currentActiveGroups.length === 2 &&
              currentRecoverySourceIds.length === 1
                ? await loadEffectiveAdministratorUserIds(transaction, {
                    accessState: {
                      snapshotId: request.membershipSnapshot.id,
                      snapshotVersion: request.membershipSnapshot.version,
                      activeAccessGroupSourceIds: currentActiveGroups
                        .map(({ id }) => id)
                        .sort(),
                    },
                    eligibleAccessGroupSourceIds: currentRecoverySourceIds,
                  })
                : [];
            const hasDesignatedMembership =
              request.grantBootstrapAdmin &&
              contextGroupKeys !== null &&
              currentDesignatedGroupKeys !== null &&
              sameNonemptyKeySet(contextGroupKeys, currentDesignatedGroupKeys);
            const hasTemporaryRecoveryMembership =
              !request.grantBootstrapAdmin &&
              request.device.platform === 'web' &&
              currentActiveGroups.length === 2 &&
              authorizationRoles.includes('admin') &&
              transitionAdministratorIds.length === 1 &&
              transitionAdministratorIds[0] === request.user.id &&
              contextGroupKeys !== null &&
              currentRecoveryGroupKeys !== null &&
              sameNonemptyKeySet(contextGroupKeys, currentRecoveryGroupKeys);

            if (
              latestSnapshot === undefined ||
              latestSnapshot.id !== request.membershipSnapshot.id ||
              latestSnapshot.version !== request.membershipSnapshot.version ||
              latestSnapshot.syncStartedAt.getTime() !==
                new Date(request.membershipSnapshot.syncStartedAt).getTime() ||
              membership === undefined ||
              !snapshotGroupsMatch ||
              !contextMatchesPersistedMembership ||
              (!hasDesignatedMembership && !hasTemporaryRecoveryMembership) ||
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

            const rolesBeforeSession = await loadEffectiveRoles(
              transaction,
              request.user.id,
            );
            const shouldGrantDesignatedGroupAdmin =
              request.grantBootstrapAdmin &&
              !rolesBeforeSession.includes('admin');

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

            if (shouldGrantDesignatedGroupAdmin) {
              await transaction.insert(userRoleChanges).values({
                userId: request.user.id,
                role: 'admin',
                granted: true,
                changedByUserId: request.user.id,
                changedWithSessionId: session.id,
                requestId: request.requestId,
                occurredAt: request.createdAt,
              });
            }
            const roles = shouldGrantDesignatedGroupAdmin
              ? await loadEffectiveRoles(transaction, request.user.id)
              : rolesBeforeSession;

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
            // The caller only ever sees SESSION_PERSISTENCE_REJECTED, which is
            // correct — it must not leak persistence internals to an
            // unauthenticated client. Without this line the underlying cause is
            // lost entirely, and five different inserts collapse into one
            // indistinguishable message.
            console.error(
              `[session-issuance] persistence failed after ${String(attempt)} attempt(s): ${describeSessionPersistenceFailure(error)}`,
            );
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
