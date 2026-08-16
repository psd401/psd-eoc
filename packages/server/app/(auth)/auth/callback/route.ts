import { randomUUID } from 'node:crypto';

import {
  executeCapability,
  parseCapabilityEnvelopeFor,
  type AccessGroupSourceRef,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../db/client';
import {
  checkAccessGate,
  createDrizzleAccessGateAuditSink,
  createDrizzleAccessGateStore,
  POST_GATE_SIGN_IN_FAILED_REASON,
  readBootstrapAdminSubjects,
  type AccessGateAuditSink,
  type AccessGateDenialReason,
  type AccessGateStore,
} from '../../../../lib/auth/access-gate';
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
  readonly accessStore: AccessGateStore;
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

function configuredEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requiredEnvironmentValue(name: string): string {
  const value = configuredEnvironmentValue(name);
  if (value === undefined || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} must be configured.`);
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function assertLoopbackHttpEnvironmentUrl(name: string): void {
  let url: URL;
  try {
    url = new URL(requiredEnvironmentValue(name));
  } catch {
    throw new Error(`${name} must be a loopback HTTP URL in auth test mode.`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !isLoopbackHostname(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${name} must be a loopback HTTP URL in auth test mode.`);
  }
}

function assertPlaywrightAuthTestRuntime(): void {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error(
      'The Playwright auth runtime requires the development runtime.',
    );
  }
  [
    'GOOGLE_OIDC_REDIRECT_URI',
    'GOOGLE_OIDC_AUTHORIZATION_ENDPOINT',
    'GOOGLE_OIDC_TOKEN_ENDPOINT',
    'GOOGLE_OIDC_JWKS_URI',
  ].forEach(assertLoopbackHttpEnvironmentUrl);
}

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

async function createAuthRuntime(): Promise<AuthRuntime> {
  if (process.env.PSD_EOC_AUTH_TEST_MODE === 'playwright') {
    assertPlaywrightAuthTestRuntime();
    const { getPlaywrightAuthRuntime } = await import(
      '../../test/auth-test-runtime'
    );
    const runtime = getPlaywrightAuthRuntime();
    return {
      accessStore: runtime.accessStore,
      auditSink: runtime.auditSink,
      sessionStore: runtime.sessionStore,
      close: () => Promise.resolve(),
    };
  }

  if (process.env.PSD_EOC_AUTH_TEST_MODE !== undefined) {
    throw new Error('PSD_EOC_AUTH_TEST_MODE has an invalid value.');
  }
  const connection = createAuthDatabaseConnection();
  return {
    accessStore: createDrizzleAccessGateStore(connection.db),
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

function deniedResponse(
  request: Request,
  reason: 'access' | 'callback' | 'configuration',
  clearCookieHeader?: string,
): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/denied?reason=${reason}`, request.url),
    303,
  );
  if (clearCookieHeader !== undefined) {
    response.headers.append('Set-Cookie', clearCookieHeader);
  }
  response.headers.append('Set-Cookie', clearReturnToCookieHeader());
  return noStore(response);
}

function denialPageReason(
  reasonCode: AccessGateDenialReason,
): 'access' | 'configuration' {
  return [
    'NO_ACTIVE_ACCESS_GROUPS',
    'ACCESS_SNAPSHOT_UNAVAILABLE',
    'ACCESS_CONFIGURATION_NOT_SYNCED',
    'ACCESS_EVIDENCE_INVALID',
  ].includes(reasonCode)
    ? 'configuration'
    : 'access';
}

function buildMembershipMember(
  userId: string,
  googleSubject: string,
  accessGroupSourceRefs: readonly AccessGroupSourceRef[],
  facilityScope: CompleteOidcSignInContext['authorization']['user']['facilityScope'],
): CompleteOidcSignInContext['authorization']['membershipMember'] {
  return Object.freeze({
    userId,
    googleSubject,
    accessGroupSourceRefs,
    facilityScope,
  });
}

/**
 * Verifies Google, checks cached Group evidence, and invokes the canonical
 * session-establishment capability. No callback path contacts Google Groups.
 */
export async function GET(request: Request): Promise<NextResponse> {
  let configuration: ReturnType<typeof readGoogleOidcConfiguration>;
  let mobileRelayUrl: string | null;
  try {
    configuration = readGoogleOidcConfiguration();
    mobileRelayUrl = createGoogleMobileOidcCallbackRelayUrl(
      configuration,
      request.url,
    );
  } catch (error) {
    return error instanceof GoogleOidcCallbackError
      ? deniedResponse(request, 'callback', error.clearCookieHeader)
      : deniedResponse(request, 'configuration');
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
      callbackUrl: request.url,
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
    const access = await checkAccessGate(
      {
        googleSubject: callback.principal.subject,
        subjectDigest: callback.principal.subjectDigest,
        requestId,
        checkedAt: serverTime,
        source: 'web',
      },
      {
        store: runtime.accessStore,
        audit: runtime.auditSink,
        bootstrapAdminSubjects: readBootstrapAdminSubjects(),
      },
    );
    if (!access.granted) {
      return deniedResponse(
        request,
        denialPageReason(access.reasonCode),
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
        membershipSnapshot: Object.freeze({
          id: access.membership.snapshotId,
          version: access.membership.snapshotVersion,
          complete: true as const,
          syncStartedAt: access.membership.syncStartedAt,
          capturedAt: access.membership.capturedAt,
        }),
        membershipMember: buildMembershipMember(
          access.user.id,
          access.user.googleSubject,
          access.membership.accessGroupSourceRefs,
          access.user.facilityScope,
        ),
        grantBootstrapAdmin: access.bootstrapAdminEligible,
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
    await executeCapability(
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
      new URL(returnTo.destination, request.url),
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
            request,
            'configuration',
            error.clearCookieHeader,
          );
        }
      }
      return deniedResponse(request, 'callback', error.clearCookieHeader);
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
        return deniedResponse(request, 'configuration', clearCookieHeader);
      }
      return deniedResponse(
        request,
        error instanceof WebSessionIssuanceError
          ? SESSION_DENIAL_PAGE_REASONS[error.code]
          : 'configuration',
        clearCookieHeader,
      );
    }
    return deniedResponse(request, 'configuration', clearCookieHeader);
  } finally {
    await runtime?.close();
  }
}
