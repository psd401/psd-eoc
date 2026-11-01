import { createHash } from 'node:crypto';

import {
  AuthenticationCapabilityEnvelopeSchema,
  CompleteOidcSignInInputSchema,
  parseCapabilityEnvelopeFor,
  PartnerOtpCompletionTransportSchema,
  PartnerPasskeyCompletionTransportSchema,
  PreSessionOidcPrincipalSchema,
  type AuthenticationCapabilityEnvelope,
  type CompleteOidcSignInInput,
  type NativeDevicePlatform,
  type PreSessionOidcPrincipal,
  type SessionEstablishmentResult,
} from '@psd-eoc/contracts';

import type { Database } from '../../db/client';
import { executeRepositoryAuditedOidcCompletion } from '../capabilities/engine';
import {
  createDrizzlePartnerSessionStore,
  createPartnerSignInAuthorizer,
  createPartnerSignInHandler,
  DEFAULT_PARTNER_SESSION_POLICY,
  type PartnerSessionPolicy,
  type PartnerSessionStore,
  type PartnerSignInContext,
} from './partner-session';
import {
  authorizePartnerSignIn,
  type PartnerSignInRefusal,
} from './partner-sign-in-authorization';
import type { PartnerVerifiedClaims } from './partner-otp';
import type { WebSessionCookie } from './session-cookie';

/**
 * The partner half of web sign-in: verified partner claims in, one browser
 * session out.
 *
 * It is the partner counterpart of the Google callback route's body. The
 * identity has already been proven by the pool and verified by
 * `partner-otp.ts`; this module turns it into the canonical pre-session
 * envelope, asks the admission whether this person may be let in, and runs
 * the same audited completion boundary the staff path runs.
 */

const DEFAULT_PARTNER_DISPLAY_NAME = 'Partner agency responder';

export type PartnerSignInErrorCode =
  'PARTNER_SIGN_IN_UNCONFIGURED' | 'PARTNER_SIGN_IN_REFUSED';

/**
 * Every refusal a partner can be shown. There is deliberately one of them:
 * an address with no admission, an ended admission, an expired admission, a
 * district address, and a disabled account must be indistinguishable, or the
 * sign-in form answers questions about who has access.
 */
export class PartnerSignInError extends Error {
  public constructor(
    public readonly code: PartnerSignInErrorCode,
    /** The exact refusal, for the audit record only. Never shown. */
    public readonly refusal: PartnerSignInRefusal | null,
    message: string,
  ) {
    super(message);
    this.name = 'PartnerSignInError';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Which surface one partner sign-in is completing on. The browser enrolls
 * the `web` platform and carries the session cookie; the native app enrolls
 * its own platform and carries the opaque bearer.
 */
export type PartnerSignInSurface =
  | Readonly<{ kind: 'web' }>
  | Readonly<{ kind: 'native'; platform: NativeDevicePlatform }>;

const WEB_SURFACE: PartnerSignInSurface = Object.freeze({ kind: 'web' });

/**
 * Which first factor the pool proved for one sign-in.
 *
 * It decides the recorded transport and nothing else. Both factors are the
 * pool's own first factors, both end in a verified identity token, and both
 * reach the same authorizer: a partner with a passkey has not been granted
 * anything a partner with a code lacks.
 */
export type PartnerSignInFactor = 'email-otp' | 'passkey';

const DEFAULT_FACTOR: PartnerSignInFactor = 'email-otp';

/** Verified adapter output ready for the canonical sign-in capability. */
export interface PartnerSignInCompletion {
  readonly capabilityInput: CompleteOidcSignInInput;
  readonly principal: PreSessionOidcPrincipal;
  readonly idempotencyKey: string;
  readonly responseDigest: string;
}

/**
 * Normalizes verified partner claims into the exact evidence the capability
 * accepts. The response digest commits to this one completed exchange, so a
 * replayed sign-in is refused by the idempotency reservation rather than
 * issuing a second session. The request id stays out of the digest: the route
 * mints one per POST, so a double-submitted code would otherwise look new.
 */
export function createPartnerSignInCompletion(
  input: Readonly<{
    claims: PartnerVerifiedClaims;
    displayName: string;
    installationId: string;
    surface?: PartnerSignInSurface;
    factor?: PartnerSignInFactor;
  }>,
): PartnerSignInCompletion {
  const surface = input.surface ?? WEB_SURFACE;
  const factor = input.factor ?? DEFAULT_FACTOR;
  const subjectDigest = sha256Hex(input.claims.subject);
  // The browser's digest is unchanged. A native sign-in commits to its own
  // device as well, because the same partner may hold a browser session and
  // a phone session at once, and because the synthetic pool's claims digest
  // is derived from the address rather than from a fresh token: without the
  // device in the digest, a second device's sign-in would look like a replay
  // of the first.
  // The factor is part of the label, so one proven identity cannot produce
  // the same digest through two different factors. The email-code labels are
  // unchanged, so a sign-in in flight across a deployment is unaffected.
  const label =
    factor === 'passkey' ? 'partner-passkey-sign-in' : 'partner-otp-sign-in';
  const responseDigest =
    surface.kind === 'web'
      ? sha256Hex(
          [`${label}-v1`, subjectDigest, input.claims.claimsDigest].join('\n'),
        )
      : sha256Hex(
          [
            `${label}-native-v1`,
            surface.platform,
            input.installationId,
            subjectDigest,
            input.claims.claimsDigest,
          ].join('\n'),
        );
  const trimmed = input.displayName.trim();
  const claims = {
    issuer: input.claims.issuer,
    audience: input.claims.audience,
    subject: input.claims.subject,
    subjectDigest,
    claimsDigest: input.claims.claimsDigest,
    // A partner pool asserts no hosted domain, and nothing reads one.
    hostedDomain: null,
    email: input.claims.email,
    emailVerified: true as const,
    displayName:
      trimmed.length > 0 ? trimmed.slice(0, 160) : DEFAULT_PARTNER_DISPLAY_NAME,
  };
  return Object.freeze({
    capabilityInput: CompleteOidcSignInInputSchema.parse({
      claims,
      device:
        surface.kind === 'web'
          ? {
              platform: 'web',
              unlockMethod: 'secure-session-cookie',
              installationId: input.installationId,
            }
          : {
              platform: surface.platform,
              unlockMethod: 'biometric',
              installationId: input.installationId,
            },
    }),
    principal: PreSessionOidcPrincipalSchema.parse({
      kind: 'verified-oidc-claims',
      ...claims,
      audienceVerified: true,
    }),
    idempotencyKey: `oidc:${responseDigest}`,
    responseDigest,
  });
}

/** Builds the canonical pre-session envelope for a verified partner sign-in. */
export function createCompletePartnerSignInEnvelope(
  completion: PartnerSignInCompletion,
  context: Readonly<{ requestId: string; serverTime: string }>,
  surface: PartnerSignInSurface = WEB_SURFACE,
  factor: PartnerSignInFactor = DEFAULT_FACTOR,
): AuthenticationCapabilityEnvelope {
  return AuthenticationCapabilityEnvelopeSchema.parse({
    capabilityId: 'complete-oidc-sign-in',
    operation: 'mutation',
    principal: completion.principal,
    source: surface.kind === 'web' ? 'web' : 'mobile',
    requestId: context.requestId,
    serverTime: context.serverTime,
    input: completion.capabilityInput,
    idempotencyKey: completion.idempotencyKey,
    // The recorded evidence names the factor the pool actually proved. A
    // passkey sign-in must not record `otpVerified`: the audit would then
    // claim a code was read from an inbox that never received one.
    transport:
      factor === 'passkey'
        ? PartnerPasskeyCompletionTransportSchema.parse({
            kind: 'partner-passkey',
            method: 'POST',
            passkeyVerified: true,
            userVerified: true,
            signatureVerified: true,
          })
        : PartnerOtpCompletionTransportSchema.parse({
            kind: 'partner-email-otp',
            method: 'POST',
            otpVerified: true,
            signatureVerified: true,
          }),
  });
}

export interface CompletePartnerSignInInput {
  readonly claims: PartnerVerifiedClaims;
  readonly installationId: string;
  readonly requestId: string;
  readonly now: Date;
  /** The first factor the pool proved; the emailed code when unstated. */
  readonly factor?: PartnerSignInFactor;
  readonly policy?: PartnerSessionPolicy;
  /** Injected only by tests that have no PostgreSQL. */
  readonly store?: PartnerSessionStore;
  /** The district staff domain, when a test states it instead of the process. */
  readonly staffDomain?: string | null;
}

export interface CompletedPartnerSignIn {
  readonly session: SessionEstablishmentResult;
  readonly cookie: WebSessionCookie;
}

/** What a native partner sign-in hands back: the session and its bearer. */
export interface CompletedNativePartnerSignIn {
  readonly session: SessionEstablishmentResult;
  readonly bearer: string;
}

export interface CompleteNativePartnerSignInInput extends CompletePartnerSignInInput {
  /** The native platform this sign-in enrolls. */
  readonly platform: NativeDevicePlatform;
}

/**
 * Admits one verified partner and issues their browser session.
 *
 * The admission decides, not the token: a partner whose admission has ended,
 * expired, or never existed is refused here even though their identity was
 * proven a moment earlier.
 */
export async function completePartnerSignIn(
  database: Database,
  input: CompletePartnerSignInInput,
): Promise<CompletedPartnerSignIn> {
  const { session, cookie } = await issuePartnerSession(
    database,
    input,
    WEB_SURFACE,
  );
  if (cookie === undefined) {
    throw new Error('The canonical sign-in capability issued no cookie.');
  }
  return Object.freeze({ session, cookie });
}

/**
 * Admits one verified partner on a phone and issues their native session.
 *
 * Only the credential's transport differs from the browser path: the same
 * admission decides, the same capability issues the session, and the same
 * one-day ceiling applies. The partner is handed an opaque bearer instead of
 * a cookie, exactly as staff are on the same device.
 */
export async function completeNativePartnerSignIn(
  database: Database,
  input: CompleteNativePartnerSignInInput,
): Promise<CompletedNativePartnerSignIn> {
  const { session, bearer } = await issuePartnerSession(
    database,
    input,
    Object.freeze({ kind: 'native', platform: input.platform }),
  );
  if (bearer === undefined) {
    throw new Error('The canonical sign-in capability issued no bearer.');
  }
  return Object.freeze({ session, bearer });
}

interface IssuedPartnerSession {
  readonly session: SessionEstablishmentResult;
  readonly cookie: WebSessionCookie | undefined;
  readonly bearer: string | undefined;
}

async function issuePartnerSession(
  database: Database,
  input: CompletePartnerSignInInput,
  surface: PartnerSignInSurface,
): Promise<IssuedPartnerSession> {
  const access = await authorizePartnerSignIn(
    database,
    {
      issuer: input.claims.issuer,
      subject: input.claims.subject,
      email: input.claims.email,
      checkedAt: input.now,
    },
    input.staffDomain === undefined ? {} : { staffDomain: input.staffDomain },
  );
  if (!access.authorized) {
    throw new PartnerSignInError(
      'PARTNER_SIGN_IN_REFUSED',
      access.refusal,
      'The partner sign-in details were not accepted.',
    );
  }

  const serverTime = input.now.toISOString();
  const factor = input.factor ?? DEFAULT_FACTOR;
  const completion = createPartnerSignInCompletion({
    claims: input.claims,
    displayName: access.user.displayName,
    installationId: input.installationId,
    surface,
    factor,
  });
  const envelope = parseCapabilityEnvelopeFor(
    'complete-oidc-sign-in',
    createCompletePartnerSignInEnvelope(
      completion,
      { requestId: input.requestId, serverTime },
      surface,
      factor,
    ),
  );

  const policy = input.policy ?? DEFAULT_PARTNER_SESSION_POLICY;
  let cookie: WebSessionCookie | undefined;
  let bearer: string | undefined;
  const authorization = Object.freeze({
    user: access.user,
    admission: access.admission,
    capturedAt: input.now,
  });
  // Exactly one sink, chosen by the surface. The session issuer refuses a
  // context that carries both or the wrong one for its device.
  const context: PartnerSignInContext = Object.freeze(
    surface.kind === 'web'
      ? {
          authorization,
          cookieSink: Object.freeze({
            set(value: WebSessionCookie): void {
              if (cookie !== undefined) {
                throw new Error('A sign-in may issue only one session cookie.');
              }
              cookie = value;
            },
          }),
          envelope,
          responseDigest: completion.responseDigest,
        }
      : {
          authorization,
          bearerSink: Object.freeze({
            set(value: string): void {
              if (bearer !== undefined) {
                throw new Error('A sign-in may issue only one bearer.');
              }
              bearer = value;
            },
          }),
          envelope,
          responseDigest: completion.responseDigest,
        },
  );
  const session = await executeRepositoryAuditedOidcCompletion(
    createPartnerSignInHandler({
      store: input.store ?? createDrizzlePartnerSessionStore(database),
      policy,
      now: () => input.now,
    }),
    envelope.input,
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createPartnerSignInAuthorizer({
        policy,
        now: () => input.now,
      }),
    },
  );
  return Object.freeze({ session, cookie, bearer });
}
