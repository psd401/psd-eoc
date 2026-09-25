import { createHash, timingSafeEqual } from 'node:crypto';

import {
  CompleteOidcSignInInputSchema,
  MobileOidcCodeExchangeTransportSchema,
  PreSessionOidcPrincipalSchema,
  parseCapabilityEnvelopeFor,
  type MobileAppReviewSignInRequest,
} from '@psd-eoc/contracts';
import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { users } from '../../db/schema';
import { executeRepositoryAuditedOidcCompletion } from '../capabilities/engine';
import {
  createCompleteMobileOidcSignInEnvelope,
  type CompleteGoogleMobileOidcExchangeResult,
} from './oidc';
import {
  createCompleteOidcSignInAuthorizer,
  createCompleteOidcSignInHandler,
  createDrizzleInitialWebSessionStore,
  type CompleteOidcSignInContext,
} from './session-cookie';
import type { SessionPolicy } from './sessions';
import { authorizeSignIn } from './sign-in-authorization';

/**
 * App-store review sign-in.
 *
 * Store reviewers are handed one district account and cannot get through
 * district single sign-on on their test devices: Google hands the district
 * domain to the identity provider, which demands a second factor bound to a
 * device the reviewer does not have. Play refused the app three times on that
 * wall. This path lets that one account in with a code instead.
 *
 * Only the identity check is different. Everything after it is the Google
 * path unchanged: the account must still be admitted, it keeps its facility
 * limit, and the session is issued by the same capability. A deployment that
 * does not supply the code's digest has no review sign-in at all.
 */

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_REVIEW_DISPLAY_NAME = 'App review account';

export type AppReviewSignInErrorCode =
  'DISABLED' | 'REJECTED' | 'ACCOUNT_NOT_READY' | 'ACCESS_DENIED';

export class AppReviewSignInError extends Error {
  public constructor(
    public readonly code: AppReviewSignInErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppReviewSignInError';
  }
}

/** The configured digest, or null when review sign-in is off. */
export function readAppReviewSignInDigest(
  value: string | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && DIGEST_PATTERN.test(normalized)
    ? normalized
    : null;
}

/** The digest a deployment stores to turn review sign-in on for one account. */
export function appReviewSignInDigest(email: string, code: string): string {
  return createHash('sha256')
    .update(`${email.trim().toLowerCase()}\n${code.trim()}`, 'utf8')
    .digest('hex');
}

export function appReviewCredentialMatches(
  expectedDigest: string,
  email: string,
  code: string,
): boolean {
  const presented = Buffer.from(appReviewSignInDigest(email, code), 'hex');
  const configured = Buffer.from(expectedDigest, 'hex');
  return (
    presented.length === configured.length &&
    timingSafeEqual(presented, configured)
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Builds the same evidence the native Google exchange hands the sign-in
 * capability, from the account's stored identity rather than a fresh token.
 */
export function createAppReviewSignInExchange(
  input: Readonly<{
    clientId: string;
    googleSubject: string;
    email: string;
    displayName: string;
    platform: MobileAppReviewSignInRequest['platform'];
    installationId: string;
    requestId: string;
  }>,
): CompleteGoogleMobileOidcExchangeResult {
  const subjectDigest = sha256Hex(input.googleSubject);
  const responseDigest = sha256Hex(
    ['app-review-sign-in-v1', input.requestId, subjectDigest].join('\n'),
  );
  const displayName =
    input.displayName.trim().length > 0
      ? input.displayName.trim().slice(0, 160)
      : DEFAULT_REVIEW_DISPLAY_NAME;
  const claims = {
    issuer: 'https://accounts.google.com' as const,
    audience: input.clientId,
    subject: input.googleSubject,
    subjectDigest,
    claimsDigest: sha256Hex(
      JSON.stringify({
        kind: 'app-review-sign-in',
        subject: input.googleSubject,
        email: input.email,
        requestId: input.requestId,
      }),
    ),
    hostedDomain: null,
    email: input.email,
    emailVerified: true as const,
    displayName,
  };
  return Object.freeze({
    capabilityInput: CompleteOidcSignInInputSchema.parse({
      claims,
      device: {
        platform: input.platform,
        unlockMethod: 'biometric',
        installationId: input.installationId,
      },
    }),
    principal: PreSessionOidcPrincipalSchema.parse({
      kind: 'verified-oidc-claims',
      ...claims,
      audienceVerified: true,
    }),
    transport: MobileOidcCodeExchangeTransportSchema.parse({
      kind: 'mobile-oidc-code-exchange',
      method: 'POST',
      stateVerified: true,
      nonceVerified: true,
      pkceVerified: true,
      signatureVerified: true,
    }),
    idempotencyKey: `oidc:${responseDigest}`,
    responseDigest,
  });
}

export interface CompleteAppReviewSignInInput {
  readonly request: MobileAppReviewSignInRequest;
  readonly expectedDigest: string | null;
  readonly clientId: string;
  readonly requestId: string;
  readonly now: Date;
  readonly policy: SessionPolicy;
  readonly initialMobileTransitionEmailDigest: string | null;
}

/**
 * Verifies the review code, then signs the account in exactly as the native
 * Google exchange would. Returns the issued session and its single bearer.
 */
export async function completeAppReviewSignIn(
  database: Database,
  input: CompleteAppReviewSignInInput,
) {
  if (input.expectedDigest === null) {
    throw new AppReviewSignInError(
      'DISABLED',
      'App review sign-in is not available.',
    );
  }
  const email = input.request.email.trim().toLowerCase();
  if (
    !appReviewCredentialMatches(input.expectedDigest, email, input.request.code)
  ) {
    throw new AppReviewSignInError(
      'REJECTED',
      'The review sign-in details were not accepted.',
    );
  }

  const [account] = await database
    .select({
      googleSubject: users.googleSubject,
      displayName: users.displayName,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (account === undefined || account.disabledAt !== null) {
    throw new AppReviewSignInError(
      'ACCOUNT_NOT_READY',
      'The review account is not set up on this deployment.',
    );
  }

  const serverTime = input.now.toISOString();
  const exchange = createAppReviewSignInExchange({
    clientId: input.clientId,
    googleSubject: account.googleSubject,
    email,
    displayName: account.displayName,
    platform: input.request.platform,
    installationId: input.request.installationId,
    requestId: input.requestId,
  });
  const envelope = parseCapabilityEnvelopeFor(
    'complete-oidc-sign-in',
    createCompleteMobileOidcSignInEnvelope(exchange, {
      requestId: input.requestId,
      serverTime,
    }),
  );

  const access = await authorizeSignIn(database, {
    googleSubject: account.googleSubject,
    email,
    displayName: exchange.capabilityInput.claims.displayName,
    checkedAt: input.now,
  });
  if (!access.authorized) {
    throw new AppReviewSignInError(
      'ACCESS_DENIED',
      'The review account is not admitted on this deployment.',
    );
  }

  let bearer: string | undefined;
  const context: CompleteOidcSignInContext = Object.freeze({
    authorization: Object.freeze({
      user: access.user,
      membership: Object.freeze({
        groupSourceIds: access.groupSourceIds,
        admittedAccountId: access.admittedAccountId,
        capturedAt: new Date(serverTime),
      }),
    }),
    bearerSink: Object.freeze({
      set(value: string): void {
        if (bearer !== undefined) {
          throw new Error('A review sign-in may issue only one bearer.');
        }
        bearer = value;
      },
    }),
    envelope,
    responseDigest: exchange.responseDigest,
  });
  const session = await executeRepositoryAuditedOidcCompletion(
    createCompleteOidcSignInHandler({
      store: createDrizzleInitialWebSessionStore(database, {
        initialMobileTransitionEmailDigest:
          input.initialMobileTransitionEmailDigest,
      }),
      policy: input.policy,
    }),
    envelope.input,
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createCompleteOidcSignInAuthorizer({
        policy: input.policy,
      }),
    },
  );
  if (bearer === undefined) {
    throw new Error('The canonical sign-in capability issued no bearer.');
  }
  return Object.freeze({ session, bearer });
}
