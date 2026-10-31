import { createHash, randomBytes, randomInt } from 'node:crypto';

import {
  CompleteOidcSignInInputSchema,
  IdempotencyKeySchema,
  IdempotencyPrincipalSchema,
  isPartnerIssuer,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  SessionEstablishmentResultSchema,
  UuidSchema,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type CompleteOidcSignInInput,
  type IdempotencyPrincipal,
  type PartnerAdmission,
  type RegisteredCapabilityEnvelope,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityId,
  type SessionEstablishmentResult,
  type User,
} from '@psd-eoc/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  connectivityEpochs,
  deviceEnrollments,
  idempotencyRecords,
  securityAuditEntries,
  sessions,
  sessionTokenIssuances,
  userFacilityScopes,
  users,
} from '../../db/schema';
import { lockPartnerAddress } from '../partners/access';
import { supersedeOtherAccountsOnInstallation } from './installation-handoff';
import { decidePartnerAccess } from './partner-admission';
import {
  describeSessionPersistenceFailure,
  digestWebSessionCredential,
  isRetryableSessionTransactionError,
  WebSessionIssuanceError,
  WEB_SESSION_COOKIE_NAME,
  type MobileSessionBearerSink,
  type WebSessionCookie,
  type WebSessionCookieSink,
} from './session-cookie';
import {
  ACCESS_GATE_AUDIT_LOCK_SQL,
  buildAccessGateAuditEntry,
  toAccessGateAuditInsertValues,
} from './sign-in-audit';

/**
 * Partner session issuance.
 *
 * A partner session is the staff session's shape with a different question
 * behind it and a much shorter life. Staff authorization is "is this person
 * still in a trusted group"; a partner's is "does this person have an
 * admission that has not ended and has not expired", asked here inside the
 * same serializable transaction that writes the session and again on every
 * later request.
 *
 * The lifetime is capped at one day by this module and cannot be configured
 * upward. Staff session policy is untouched: it stays in
 * `DEFAULT_SESSION_POLICY` and its environment override, which a partner
 * session never reads.
 */

const SESSION_CREDENTIAL_BYTES = 48;
const SHA_256_HEX_LENGTH = 64;
const SESSION_TRANSACTION_ATTEMPTS = 5;

/** The product decision of 2026-10-23: a partner session lasts one day. */
export const PARTNER_SESSION_LIFETIME_SECONDS = 24 * 60 * 60;

/** Partner session time policy. Only the lifetime varies, and only downward. */
export interface PartnerSessionPolicy {
  readonly sessionLifetimeSeconds: number;
}

export const DEFAULT_PARTNER_SESSION_POLICY: Readonly<PartnerSessionPolicy> =
  Object.freeze({ sessionLifetimeSeconds: PARTNER_SESSION_LIFETIME_SECONDS });

/**
 * Validates a partner policy against the one-day ceiling. A deployment may
 * shorten a partner session; nothing can lengthen it past a day, so the
 * staff lifetime variable cannot become a partner lifetime by accident.
 */
export function validatePartnerSessionPolicy(
  policy: PartnerSessionPolicy,
): Readonly<PartnerSessionPolicy> {
  if (
    !Number.isSafeInteger(policy.sessionLifetimeSeconds) ||
    policy.sessionLifetimeSeconds <= 0 ||
    policy.sessionLifetimeSeconds > PARTNER_SESSION_LIFETIME_SECONDS
  ) {
    throw new WebSessionIssuanceError(
      'INVALID_SESSION_POLICY',
      'A partner session lasts at most one day.',
    );
  }
  return Object.freeze({ ...policy });
}

/** The admission-backed identity a partner session is issued against. */
export interface PartnerAuthorizedIdentity {
  readonly user: User;
  readonly admission: PartnerAdmission;
  /** When the admission was read; a partner's evidence is this request's. */
  readonly capturedAt: Date;
}

/**
 * Server-owned context used by the partner sign-in capability handler.
 *
 * Exactly one sink is present, and which one it is has to agree with the
 * device being enrolled: a browser partner gets the session cookie, a native
 * partner gets the opaque bearer. The staff path draws the same line in
 * `CompleteOidcSignInContext`.
 */
export interface PartnerSignInContext {
  readonly authorization: PartnerAuthorizedIdentity;
  readonly cookieSink?: WebSessionCookieSink;
  readonly bearerSink?: MobileSessionBearerSink;
  readonly envelope: RegisteredCapabilityEnvelope<'complete-oidc-sign-in'>;
  /** Digest of the completed one-time-password exchange, never its code. */
  readonly responseDigest: string;
}

/** Atomic persistence command. It contains a digest, never the credential. */
export interface PersistPartnerSessionRequest {
  readonly user: User;
  readonly admission: PartnerAdmission;
  readonly issuer: string;
  readonly subject: string;
  readonly device: CompleteOidcSignInInput['device'];
  readonly credentialDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly requestId: string;
  readonly idempotency: Readonly<{
    key: string;
    principal: IdempotencyPrincipal;
    principalDigest: string;
    requestDigest: string;
  }>;
}

/** Dependency boundary used by unit tests and the production Drizzle adapter. */
export interface PartnerSessionStore {
  readonly persist: (
    request: PersistPartnerSessionRequest,
  ) => Promise<SessionEstablishmentResult>;
}

export interface PartnerSessionIssuerDependencies {
  readonly store: PartnerSessionStore;
  readonly policy: PartnerSessionPolicy;
  readonly now?: () => Date;
}

function addSeconds(date: Date, seconds: number): Date {
  const timestamp = date.getTime() + seconds * 1_000;
  const result = new Date(timestamp);
  if (!Number.isSafeInteger(timestamp) || Number.isNaN(result.getTime())) {
    throw new WebSessionIssuanceError(
      'INVALID_SESSION_POLICY',
      'Partner session time policy produced an invalid date.',
    );
  }
  return result;
}

function sameFacilityScope(
  left: User['facilityScope'],
  right: User['facilityScope'],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'district' || right.kind === 'district') return true;
  const leftIds = [...left.facilityIds].sort();
  const rightIds = [...right.facilityIds].sort();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
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

/**
 * Binds the verified partner claims to the admission-backed identity the
 * server resolved. A Google identity cannot reach this capability through the
 * partner path: the claims' issuer must be a partner pool, and the account
 * behind it must be the partner one, with no Google subject.
 */
function assertPartnerAuthorizedContext(
  input: CompleteOidcSignInInput,
  authorization: PartnerAuthorizedIdentity,
): void {
  if (
    !isPartnerIssuer(input.claims.issuer) ||
    authorization.user.googleSubject !== null ||
    authorization.user.disabledAt !== null ||
    authorization.user.email !== input.claims.email ||
    authorization.admission.email !== input.claims.email ||
    authorization.admission.ending !== null ||
    !authorization.user.roles.includes('partner') ||
    authorization.user.roles.length !== 1 ||
    !UuidSchema.safeParse(authorization.admission.id).success ||
    Number.isNaN(authorization.capturedAt.getTime())
  ) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'A current partner admission is required.',
    );
  }
}

interface ValidatedPartnerInvocation {
  readonly requestId: string;
  readonly idempotency: PersistPartnerSessionRequest['idempotency'];
}

function validatePartnerInvocation(
  input: CompleteOidcSignInInput,
  context: PartnerSignInContext,
): ValidatedPartnerInvocation {
  let envelope: RegisteredCapabilityEnvelope<'complete-oidc-sign-in'>;
  try {
    envelope = parseCapabilityEnvelopeFor<'complete-oidc-sign-in'>(
      'complete-oidc-sign-in',
      context.envelope,
    );
  } catch {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'The verified partner sign-in envelope is invalid.',
    );
  }
  const responseDigest = context.responseDigest;
  if (
    !/^[a-f0-9]{64}$/u.test(responseDigest) ||
    // The source is checked against the device by the delivery rule above;
    // here it only has to be one of the two partner surfaces.
    (envelope.source !== 'web' && envelope.source !== 'mobile') ||
    envelope.transport.kind !== 'partner-email-otp' ||
    envelope.idempotencyKey !== `oidc:${responseDigest}` ||
    JSON.stringify(envelope.input) !== JSON.stringify(input)
  ) {
    throw new WebSessionIssuanceError(
      'INVALID_AUTHORIZATION_CONTEXT',
      'The verified partner sign-in envelope does not match the request.',
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
      JSON.stringify({ input: envelope.input, transport: envelope.transport }),
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

type PartnerCredentialDelivery =
  | Readonly<{ kind: 'web'; sink: WebSessionCookieSink }>
  | Readonly<{ kind: 'mobile'; sink: MobileSessionBearerSink }>;

/**
 * Binds the credential transport to the device being enrolled. A browser
 * partner must present the web invocation source, the `web` platform, the
 * cookie unlock method and a cookie sink alone; a native partner must
 * present the mobile source, a native platform, the biometric unlock method
 * and a bearer sink alone. Anything mixed is refused before a credential
 * exists, so a session cannot be delivered down a transport its enrollment
 * does not match.
 */
function assertPartnerCredentialDelivery(
  input: CompleteOidcSignInInput,
  context: PartnerSignInContext,
): PartnerCredentialDelivery {
  if (
    context.envelope.source === 'web' &&
    input.device.platform === 'web' &&
    input.device.unlockMethod === 'secure-session-cookie' &&
    context.cookieSink !== undefined &&
    context.bearerSink === undefined
  ) {
    return Object.freeze({ kind: 'web', sink: context.cookieSink });
  }
  if (
    context.envelope.source === 'mobile' &&
    (input.device.platform === 'ios' || input.device.platform === 'android') &&
    input.device.unlockMethod === 'biometric' &&
    context.bearerSink !== undefined &&
    context.cookieSink === undefined
  ) {
    return Object.freeze({ kind: 'mobile', sink: context.bearerSink });
  }
  throw new WebSessionIssuanceError(
    'INVALID_AUTHORIZATION_CONTEXT',
    'The partner credential transport does not match its device enrollment.',
  );
}

function assertPersistedPartnerResult(
  result: SessionEstablishmentResult,
  request: PersistPartnerSessionRequest,
): void {
  const matches =
    result.user.id === request.user.id &&
    result.user.googleSubject === null &&
    result.user.disabledAt === null &&
    result.user.roles.length === 1 &&
    result.user.roles[0] === 'partner' &&
    sameFacilityScope(result.user.facilityScope, request.user.facilityScope) &&
    result.session.authorization.kind === 'partner-admission' &&
    result.session.authorization.partnerAdmissionId === request.admission.id &&
    result.session.authorization.admissionExpiresAt ===
      request.admission.expiresAt &&
    result.session.createdAt === request.createdAt.toISOString() &&
    result.session.expiresAt === request.expiresAt.toISOString() &&
    result.deviceEnrollment.platform === request.device.platform &&
    result.deviceEnrollment.unlockMethod === request.device.unlockMethod &&
    result.deviceEnrollment.installationId === request.device.installationId;
  if (!matches) {
    throw new WebSessionIssuanceError(
      'PERSISTED_RESULT_MISMATCH',
      'Persisted partner session evidence does not match the authorized request.',
    );
  }
}

/**
 * Canonical pre-handler authorizer for a partner sign-in. The route must
 * first verify the partner identity token and resolve the admission; this
 * authorizer binds those two facts to each other and to the envelope.
 */
export function createPartnerSignInAuthorizer(
  dependencies: Pick<PartnerSessionIssuerDependencies, 'policy' | 'now'>,
): Readonly<CapabilityExecutionAuthorizer<PartnerSignInContext>> {
  validatePartnerSessionPolicy(dependencies.policy);
  return Object.freeze({
    authorize: (
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        PartnerSignInContext
      >,
    ): void => {
      if (request.definition.id !== 'complete-oidc-sign-in') {
        throw new WebSessionIssuanceError(
          'INVALID_AUTHORIZATION_CONTEXT',
          'The partner sign-in authorizer rejects other capabilities.',
        );
      }
      const input = CompleteOidcSignInInputSchema.parse(request.input);
      assertPartnerCredentialDelivery(input, request.context);
      validatePartnerInvocation(input, request.context);
      assertPartnerAuthorizedContext(input, request.context.authorization);
      const now = readTrustedNow(dependencies.now);
      if (
        Date.parse(request.context.authorization.admission.expiresAt) <=
        now.getTime()
      ) {
        throw new WebSessionIssuanceError(
          'MEMBERSHIP_NOT_CURRENT',
          'A new partner session requires an unexpired admission.',
        );
      }
    },
  });
}

async function establishPartnerSession(
  inputValue: CompleteOidcSignInInput,
  context: PartnerSignInContext,
  dependencies: PartnerSessionIssuerDependencies,
): Promise<SessionEstablishmentResult> {
  const input = CompleteOidcSignInInputSchema.parse(inputValue);
  const delivery = assertPartnerCredentialDelivery(input, context);
  const invocation = validatePartnerInvocation(input, context);
  const policy = validatePartnerSessionPolicy(dependencies.policy);
  assertPartnerAuthorizedContext(input, context.authorization);

  const now = readTrustedNow(dependencies.now);
  const admissionExpiresAt = Date.parse(
    context.authorization.admission.expiresAt,
  );
  if (admissionExpiresAt <= now.getTime()) {
    throw new WebSessionIssuanceError(
      'MEMBERSHIP_NOT_CURRENT',
      'A new partner session requires an unexpired admission.',
    );
  }
  // One day, and never past the admission: a session must not outlive the
  // authorization that justified it.
  const expiresAt = new Date(
    Math.min(
      addSeconds(now, policy.sessionLifetimeSeconds).getTime(),
      admissionExpiresAt,
    ),
  );

  const credential = randomBytes(SESSION_CREDENTIAL_BYTES).toString(
    'base64url',
  );
  const credentialDigest = digestWebSessionCredential(credential);
  if (credentialDigest.length !== SHA_256_HEX_LENGTH) {
    throw new WebSessionIssuanceError(
      'SESSION_PERSISTENCE_REJECTED',
      'The session credential digest could not be created.',
    );
  }

  const request: PersistPartnerSessionRequest = Object.freeze({
    user: context.authorization.user,
    admission: context.authorization.admission,
    issuer: input.claims.issuer,
    subject: input.claims.subject,
    device: input.device,
    credentialDigest,
    createdAt: now,
    expiresAt,
    requestId: invocation.requestId,
    idempotency: invocation.idempotency,
  });

  const result = SessionEstablishmentResultSchema.parse(
    await dependencies.store.persist(request),
  );
  assertPersistedPartnerResult(result, request);

  if (delivery.kind === 'web') {
    await delivery.sink.set(
      Object.freeze({
        name: WEB_SESSION_COOKIE_NAME,
        value: credential,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: Math.max(
          1,
          Math.floor((expiresAt.getTime() - now.getTime()) / 1_000),
        ),
        expires: expiresAt,
      }) satisfies WebSessionCookie,
    );
  } else {
    // The native partner's credential is the same opaque secret, handed to
    // the app instead of a browser. Its deadline is the session's, which the
    // client reads from the session it is given.
    await delivery.sink.set(credential);
  }
  return result;
}

/**
 * Registers partner session establishment under the canonical pre-session
 * capability ID. Callers must still pass this registration to the literal-ID
 * repository-audited completion boundary with the partner authorizer; this
 * factory does not create a side-door path.
 */
export function createPartnerSignInHandler(
  dependencies: PartnerSessionIssuerDependencies,
): Readonly<
  RegisteredCapabilityHandler<'complete-oidc-sign-in', PartnerSignInContext>
> {
  validatePartnerSessionPolicy(dependencies.policy);
  return registerCapabilityHandler(
    'complete-oidc-sign-in',
    async (input, context) =>
      establishPartnerSession(input, context, dependencies),
  );
}

function toIsoString(value: Date): string {
  return value.toISOString();
}

function assertPersistablePartnerIdempotency(
  request: PersistPartnerSessionRequest,
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
    .update(request.subject, 'utf8')
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
      'The partner sign-in replay-protection evidence is invalid.',
    );
  }
}

/**
 * Production persistence adapter. Replay protection, the admission
 * confirmation, the device enrollment, the session, its credential digest,
 * the connectivity epoch, and the access-gate audit entry commit in one
 * serializable transaction. The raw credential never reaches it.
 */
export function createDrizzlePartnerSessionStore(
  database: Database,
): PartnerSessionStore {
  return Object.freeze({
    async persist(
      request: PersistPartnerSessionRequest,
    ): Promise<SessionEstablishmentResult> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await database.transaction(async (transaction) => {
            await transaction.execute(
              sql`set transaction isolation level serializable`,
            );
            // The lock every writer of this address's partner access takes
            // (invite, renew, disable, the expiry sweep), so a session cannot
            // be issued while the admission behind it is being ended. It is
            // per address: partner sign-in never queues behind staff sign-in
            // or the Groups sync on the administrator-availability lock.
            await lockPartnerAddress(transaction, request.user.email);

            if (!/^[a-f0-9]{64}$/u.test(request.credentialDigest)) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The session credential digest is invalid.',
              );
            }
            assertPersistablePartnerIdempotency(request);

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
                'The verified partner sign-in was already consumed.',
              );
            }

            // Ask the admission again, here, inside the transaction that
            // writes the session. An admission ended a moment ago must not
            // produce a session that outlives the decision.
            const confirmed = await decidePartnerAccess(transaction, {
              email: request.user.email,
              checkedAt: request.createdAt,
            });
            if (
              !confirmed.granted ||
              confirmed.admission.id !== request.admission.id ||
              confirmed.admission.expiresAt !== request.admission.expiresAt
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'A current partner admission could not be confirmed.',
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
              persistedUser.identityIssuer !== request.issuer ||
              persistedUser.identitySubject !== request.subject ||
              persistedUser.googleSubject !== null ||
              persistedUser.email !== request.user.email ||
              persistedUser.disabledAt !== null
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The authorized partner identity is not active.',
              );
            }

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
                      kind: 'facilities' as const,
                      facilityIds: persistedFacilityScopes
                        .map(({ facilityId }) => facilityId)
                        .sort(),
                    } as const)
                  : null;
            if (
              facilityScope === null ||
              !sameFacilityScope(facilityScope, request.user.facilityScope)
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'Authoritative partner facility scope could not be confirmed.',
              );
            }

            // Shared-device rules are the same for a partner: whoever the
            // access decision admits may enroll the installation, and the
            // last account to sign in holds it.
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${request.device.installationId}, 4017))`,
            );
            const [enrolled] = await transaction
              .select()
              .from(deviceEnrollments)
              .where(
                and(
                  eq(
                    deviceEnrollments.installationId,
                    request.device.installationId,
                  ),
                  eq(deviceEnrollments.userId, request.user.id),
                  isNull(deviceEnrollments.revokedAt),
                ),
              )
              .limit(1);
            const device =
              enrolled ??
              (
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
                  .returning()
              )[0];
            if (
              device === undefined ||
              device.platform !== request.device.platform ||
              device.unlockMethod !== request.device.unlockMethod
            ) {
              throw new WebSessionIssuanceError(
                'SESSION_PERSISTENCE_REJECTED',
                'The device enrollment is unavailable.',
              );
            }
            await supersedeOtherAccountsOnInstallation(
              transaction,
              request.device.installationId,
              request.user.id,
              request.createdAt,
            );

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
                // A partner session is pinned to nothing. These two columns
                // exist for the staff membership window and only satisfy the
                // table's ordering check here; the admission is re-read on
                // every request and is the only thing that authorizes one.
                membershipSnapshotId: null,
                membershipValidUntil: request.createdAt,
                membershipGraceUntil: request.createdAt,
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
                googleSubject: null,
                email: persistedUser.email,
                displayName: persistedUser.displayName,
                roles: ['partner'],
                facilityScope,
                createdAt: toIsoString(persistedUser.createdAt),
                disabledAt: null,
              },
              session: {
                id: session.id,
                userId: session.userId,
                deviceEnrollmentId: session.deviceEnrollmentId,
                createdAt: toIsoString(session.createdAt),
                expiresAt: toIsoString(session.expiresAt),
                authorization: {
                  kind: 'partner-admission',
                  partnerAdmissionId: confirmed.admission.id,
                  admissionExpiresAt: confirmed.admission.expiresAt,
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
            assertPersistedPartnerResult(result, request);

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
                source: 'web',
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
            console.error(
              `[partner-session-issuance] persistence failed after ${String(attempt)} attempt(s): ${describeSessionPersistenceFailure(error)}`,
            );
            throw new WebSessionIssuanceError(
              'SESSION_PERSISTENCE_REJECTED',
              'The partner session could not be persisted.',
            );
          }
          await new Promise<void>((resolve) => {
            const base = Math.min(20 * 2 ** (attempt - 1), 160);
            setTimeout(resolve, base + randomInt(base));
          });
        }
      }
    },
  });
}
