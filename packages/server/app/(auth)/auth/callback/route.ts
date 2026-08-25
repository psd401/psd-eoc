import { randomUUID } from 'node:crypto';

import { parseCapabilityEnvelopeFor } from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../db/client';
import {
  createDrizzleAccessGateAuditSink,
  POST_GATE_SIGN_IN_FAILED_REASON,
  type AccessGateAuditSink,
} from '../../../../lib/auth/sign-in-audit';
import { executeRepositoryAuditedOidcCompletion } from '../../../../lib/capabilities/engine';
import { authorizeSignIn } from '../../../../lib/auth/sign-in-authorization';
import {
  completeGoogleOidcCallback,
  createCompleteOidcSignInEnvelope,
  createGoogleMobileOidcCallbackRelayUrl,
  GoogleOidcCallbackError,
  readGoogleOidcConfiguration,
} from '../../../../lib/auth/oidc';
import {
  createCsrfToken,
  writeBrowserCsrfCookie,
} from '../../../../lib/auth/middleware';
import {
  createCompleteOidcSignInAuthorizer,
  createCompleteOidcSignInHandler,
  createDrizzleInitialWebSessionStore,
  WebSessionIssuanceError,
  type CompleteOidcSignInContext,
  type InitialWebSessionStore,
  type WebSessionCookie,
  type WebSessionIssuanceErrorCode,
  type WebSessionPolicy,
} from '../../../../lib/auth/session-cookie';
import { clearReturnToCookieHeader, readReturnToCookie } from '../return-to';

export const dynamic = 'force-dynamic';

const DEFAULT_SESSION_POLICY: Readonly<WebSessionPolicy> = Object.freeze({
  sessionLifetimeSeconds: 90 * 24 * 60 * 60,
  membershipTtlSeconds: 24 * 60 * 60,
  membershipGraceSeconds: 72 * 60 * 60,
});

interface AuthRuntime {
  /**
   * Injected rather than a raw database so the end-to-end harness can supply a
   * process-local authorizer without standing up PostgreSQL.
   */
  readonly authorize: typeof authorizeSignIn extends (
    database: infer _D,
    input: infer I,
  ) => infer R
    ? (input: I) => R
    : never;
  readonly auditSink: AccessGateAuditSink;
  readonly sessionStore: InitialWebSessionStore;
  close(): Promise<void>;
}

interface PostGateAuditContext {
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly userId: string;
}

/** User-facing routing remains separate from the exact append-only audit code. */
const SESSION_DENIAL_PAGE_REASONS: Readonly<
  Record<WebSessionIssuanceErrorCode, 'access' | 'callback' | 'configuration'>
> = Object.freeze({
  INVALID_AUTHORIZATION_CONTEXT: 'callback',
  INVALID_SESSION_POLICY: 'configuration',
  MEMBERSHIP_NOT_CURRENT: 'configuration',
  PERSISTED_RESULT_MISMATCH: 'configuration',
  SESSION_REPLAY_REJECTED: 'callback',
  SESSION_PERSISTENCE_REJECTED: 'configuration',
});

function createAuthDatabaseConnection(): DatabaseConnection {
  const config = readDatabaseConfig();
  if (config.driver !== 'postgres') {
    throw new Error('Authentication requires native PostgreSQL.');
  }
  return createDatabaseClient(config);
}

function parsePolicySeconds(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const configured = process.env[name];
  if (configured === undefined || configured.length === 0) {
    return fallback;
  }
  if (!/^\d+$/u.test(configured)) {
    throw new WebSessionIssuanceError(
      'INVALID_SESSION_POLICY',
      `${name} must be a bounded positive integer.`,
    );
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WebSessionIssuanceError(
      'INVALID_SESSION_POLICY',
      `${name} must be a bounded positive integer.`,
    );
  }
  return parsed;
}

function readSessionPolicy(): Readonly<WebSessionPolicy> {
  return Object.freeze({
    sessionLifetimeSeconds: parsePolicySeconds(
      'PSD_EOC_SESSION_LIFETIME_SECONDS',
      DEFAULT_SESSION_POLICY.sessionLifetimeSeconds,
      24 * 60 * 60,
      365 * 24 * 60 * 60,
    ),
    membershipTtlSeconds: parsePolicySeconds(
      'PSD_EOC_MEMBERSHIP_TTL_SECONDS',
      DEFAULT_SESSION_POLICY.membershipTtlSeconds,
      5 * 60,
      7 * 24 * 60 * 60,
    ),
    membershipGraceSeconds: parsePolicySeconds(
      'PSD_EOC_MEMBERSHIP_GRACE_SECONDS',
      DEFAULT_SESSION_POLICY.membershipGraceSeconds,
      60,
      14 * 24 * 60 * 60,
    ),
  });
}

function createAuthRuntime(): AuthRuntime {
  const connection = createAuthDatabaseConnection();
  return {
    authorize: (input) => authorizeSignIn(connection.db, input),
    auditSink: createDrizzleAccessGateAuditSink(connection.db),
    sessionStore: createDrizzleInitialWebSessionStore(connection.db),
    close: connection.close,
  };
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/**
 * App Runner forwards the public request to the Next listener on localhost.
 * Keep the provider-registered callback origin/path authoritative and carry
 * across only the query that Google sent to the listener.
 */
function canonicalizeGoogleOidcCallbackUrl(
  configuredRedirectUri: string,
  runtimeRequestUrl: string,
): URL {
  const configured = new URL(configuredRedirectUri);
  const runtime = new URL(runtimeRequestUrl);
  configured.search = runtime.search;
  return configured;
}

function createConfiguredApplicationUrl(
  configuredRedirectUri: string,
  destination: string,
): URL {
  const applicationOrigin = new URL(configuredRedirectUri).origin;
  const resolved = new URL(destination, `${applicationOrigin}/`);
  if (resolved.origin !== applicationOrigin) {
    throw new Error(
      'The authentication redirect must stay on the application origin.',
    );
  }
  return resolved;
}

function deniedResponse(
  redirectBaseUrl: string,
  reason: 'access' | 'callback' | 'configuration',
  clearCookieHeader?: string,
): NextResponse {
  const response = NextResponse.redirect(
    createConfiguredApplicationUrl(redirectBaseUrl, `/denied?reason=${reason}`),
    303,
  );
  if (clearCookieHeader !== undefined) {
    response.headers.append('Set-Cookie', clearCookieHeader);
  }
  response.headers.append('Set-Cookie', clearReturnToCookieHeader());
  return noStore(response);
}

/**
 * A refusal a deployment can act on is a configuration problem; one about this
 * person is an access problem.
 */
function denialPageReason(
  refusal:
    | 'NO_TRUSTED_GROUPS_CONFIGURED'
    | 'NOT_IN_A_TRUSTED_GROUP'
    | 'MEMBERSHIP_STALE'
    | 'ACCOUNT_DISABLED',
): 'access' | 'configuration' {
  return refusal === 'NO_TRUSTED_GROUPS_CONFIGURED' ||
    refusal === 'MEMBERSHIP_STALE'
    ? 'configuration'
    : 'access';
}

/**
 * Verifies Google, checks cached Group evidence, and invokes the canonical
 * session-establishment capability. No callback path contacts Google Groups.
 */
export async function GET(request: Request): Promise<NextResponse> {
  let configuration: ReturnType<typeof readGoogleOidcConfiguration>;
  let callbackUrl: URL;
  let mobileRelayUrl: string | null;
  let redirectBaseUrl = request.url;
  try {
    configuration = readGoogleOidcConfiguration();
    redirectBaseUrl = configuration.redirectUri;
    callbackUrl = canonicalizeGoogleOidcCallbackUrl(
      configuration.redirectUri,
      request.url,
    );
    mobileRelayUrl = createGoogleMobileOidcCallbackRelayUrl(
      configuration,
      callbackUrl,
    );
  } catch (error) {
    return error instanceof GoogleOidcCallbackError
      ? deniedResponse(redirectBaseUrl, 'callback', error.clearCookieHeader)
      : deniedResponse(redirectBaseUrl, 'configuration');
  }
  if (mobileRelayUrl !== null) {
    const response = new NextResponse(null, {
      status: 303,
      headers: { Location: mobileRelayUrl },
    });
    response.headers.append('Set-Cookie', clearReturnToCookieHeader());
    return noStore(response);
  }
  let clearCookieHeader: string | undefined;
  let runtime: AuthRuntime | undefined;
  let postGateAuditContext: PostGateAuditContext | undefined;
  try {
    const callback = await completeGoogleOidcCallback(configuration, {
      method: request.method,
      callbackUrl,
      cookieHeader: request.headers.get('cookie'),
    });
    clearCookieHeader = callback.clearCookieHeader;

    const serverTime = new Date().toISOString();
    const requestId = randomUUID();
    const envelope = parseCapabilityEnvelopeFor<'complete-oidc-sign-in'>(
      'complete-oidc-sign-in',
      createCompleteOidcSignInEnvelope(callback, { requestId, serverTime }),
    );

    runtime = await createAuthRuntime();
    const access = await runtime.authorize({
      googleSubject: callback.principal.subject,
      email: callback.principal.email,
      displayName: callback.principal.displayName,
      checkedAt: new Date(serverTime),
    });
    if (!access.authorized) {
      return deniedResponse(
        configuration.redirectUri,
        denialPageReason(access.refusal),
        clearCookieHeader,
      );
    }
    postGateAuditContext = Object.freeze({
      requestId,
      subjectDigest: callback.principal.subjectDigest,
      userId: access.user.id,
    });

    let sessionCookie: WebSessionCookie | undefined;
    const context: CompleteOidcSignInContext = Object.freeze({
      authorization: Object.freeze({
        user: access.user,
        membership: Object.freeze({
          groupSourceIds: access.groupSourceIds,
          capturedAt: new Date(serverTime),
        }),
      }),
      cookieSink: Object.freeze({
        set(cookie: WebSessionCookie): void {
          if (sessionCookie !== undefined) {
            throw new Error('A sign-in may issue only one session cookie.');
          }
          sessionCookie = cookie;
        },
      }),
      envelope,
      responseDigest: callback.responseDigest,
    });
    const policy = readSessionPolicy();
    await executeRepositoryAuditedOidcCompletion(
      createCompleteOidcSignInHandler({
        store: runtime.sessionStore,
        policy,
      }),
      envelope.input,
      {
        context,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: createCompleteOidcSignInAuthorizer({ policy }),
      },
    );
    if (sessionCookie === undefined) {
      throw new Error('The canonical sign-in capability issued no cookie.');
    }

    const returnTo = readReturnToCookie(request.headers.get('cookie'));
    const response = NextResponse.redirect(
      createConfiguredApplicationUrl(
        configuration.redirectUri,
        returnTo.destination,
      ),
      303,
    );
    response.cookies.set(sessionCookie);
    writeBrowserCsrfCookie(
      response.cookies,
      createCsrfToken(),
      sessionCookie.maxAge,
    );
    // NextResponse.cookies rewrites Set-Cookie, so append transient-cookie
    // clearing only after all cookie-writer calls have completed.
    response.headers.append('Set-Cookie', clearCookieHeader);
    response.headers.append('Set-Cookie', clearReturnToCookieHeader());
    return noStore(response);
  } catch (error) {
    if (error instanceof GoogleOidcCallbackError) {
      if (error.stateVerified && error.responseDigest !== null) {
        try {
          runtime ??= await createAuthRuntime();
          await runtime.auditSink.append({
            outcome: 'denied',
            requestId: randomUUID(),
            occurredAt: new Date().toISOString(),
            subjectDigest: null,
            reasonCode: error.code,
            userId: null,
            source: 'web',
          });
        } catch {
          return deniedResponse(
            configuration.redirectUri,
            'configuration',
            error.clearCookieHeader,
          );
        }
      }
      return deniedResponse(
        configuration.redirectUri,
        'callback',
        error.clearCookieHeader,
      );
    }
    if (postGateAuditContext !== undefined && runtime !== undefined) {
      const reasonCode =
        error instanceof WebSessionIssuanceError
          ? error.code
          : POST_GATE_SIGN_IN_FAILED_REASON;
      try {
        await runtime.auditSink.append({
          outcome: 'denied',
          requestId: postGateAuditContext.requestId,
          occurredAt: new Date().toISOString(),
          subjectDigest: postGateAuditContext.subjectDigest,
          reasonCode,
          userId: postGateAuditContext.userId,
          source: 'web',
        });
      } catch {
        return deniedResponse(
          configuration.redirectUri,
          'configuration',
          clearCookieHeader,
        );
      }
      return deniedResponse(
        configuration.redirectUri,
        error instanceof WebSessionIssuanceError
          ? SESSION_DENIAL_PAGE_REASONS[error.code]
          : 'configuration',
        clearCookieHeader,
      );
    }
    return deniedResponse(
      configuration.redirectUri,
      'configuration',
      clearCookieHeader,
    );
  } finally {
    await runtime?.close();
  }
}
