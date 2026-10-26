import { createHash } from 'node:crypto';

import {
  AuthenticationCapabilityEnvelopeSchema,
  CompleteOidcSignInInputSchema,
  parseCapabilityEnvelopeFor,
  PartnerOtpCompletionTransportSchema,
  PreSessionOidcPrincipalSchema,
  type AuthenticationCapabilityEnvelope,
  type CompleteOidcSignInInput,
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
  }>,
): PartnerSignInCompletion {
  const subjectDigest = sha256Hex(input.claims.subject);
  const responseDigest = sha256Hex(
    ['partner-otp-sign-in-v1', subjectDigest, input.claims.claimsDigest].join(
      '\n',
    ),
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
      device: {
        platform: 'web',
        unlockMethod: 'secure-session-cookie',
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
): AuthenticationCapabilityEnvelope {
  return AuthenticationCapabilityEnvelopeSchema.parse({
    capabilityId: 'complete-oidc-sign-in',
    operation: 'mutation',
    principal: completion.principal,
    source: 'web',
    requestId: context.requestId,
    serverTime: context.serverTime,
    input: completion.capabilityInput,
    idempotencyKey: completion.idempotencyKey,
    transport: PartnerOtpCompletionTransportSchema.parse({
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
  const completion = createPartnerSignInCompletion({
    claims: input.claims,
    displayName: access.user.displayName,
    installationId: input.installationId,
  });
  const envelope = parseCapabilityEnvelopeFor(
    'complete-oidc-sign-in',
    createCompletePartnerSignInEnvelope(completion, {
      requestId: input.requestId,
      serverTime,
    }),
  );

  const policy = input.policy ?? DEFAULT_PARTNER_SESSION_POLICY;
  let cookie: WebSessionCookie | undefined;
  const context: PartnerSignInContext = Object.freeze({
    authorization: Object.freeze({
      user: access.user,
      admission: access.admission,
      capturedAt: input.now,
    }),
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
  });
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
  if (cookie === undefined) {
    throw new Error('The canonical sign-in capability issued no cookie.');
  }
  return Object.freeze({ session, cookie });
}
