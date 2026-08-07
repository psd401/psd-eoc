import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Role } from '@psd-eoc/contracts';

import {
  SessionAccessError,
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  isOpaqueSessionCredential,
  type AuthenticatedSession,
  type SessionService,
} from './sessions';

export { WEB_CSRF_COOKIE_NAME, WEB_SESSION_COOKIE_NAME } from './sessions';

export const WEB_SESSION_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/',
});

export const WEB_CSRF_COOKIE_OPTIONS = Object.freeze({
  httpOnly: false,
  secure: true,
  sameSite: 'strict' as const,
  path: '/',
});

export interface PresentedSessionCredential {
  readonly token: string;
  readonly source: 'web' | 'mobile';
  readonly csrfVerified: boolean;
}

function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (header === null) {
    return cookies;
  }
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = segment.slice(0, separator).trim();
    const encodedValue = segment.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(encodedValue));
    } catch {
      throw new SessionAccessError(
        'INVALID_CREDENTIAL',
        'The session credential is invalid.',
      );
    }
  }
  return cookies;
}

function readBearer(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(header);
  if (match?.[1] === undefined || !isOpaqueSessionCredential(match[1])) {
    throw new SessionAccessError(
      'INVALID_CREDENTIAL',
      'The mobile session credential is invalid.',
    );
  }
  return match[1];
}

function safeEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first, 'utf8');
  const secondBytes = Buffer.from(second, 'utf8');
  return (
    firstBytes.length === secondBytes.length &&
    timingSafeEqual(firstBytes, secondBytes)
  );
}

function verifyWebMutationCsrf(
  request: Request,
  cookies: ReadonlyMap<string, string>,
): boolean {
  if (request.method !== 'POST') {
    return false;
  }
  const csrfCookie = cookies.get(WEB_CSRF_COOKIE_NAME);
  const csrfHeader = request.headers.get('x-psd-eoc-csrf');
  const origin = request.headers.get('origin');
  if (
    csrfCookie === undefined ||
    csrfHeader === null ||
    origin === null ||
    !safeEqual(csrfCookie, csrfHeader)
  ) {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * Resolves exactly one trusted transport. Cookie and bearer ambiguity is
 * rejected; actor, session, role, and facility scope never come from request
 * content.
 */
export function readPresentedSessionCredential(
  request: Request,
  options: Readonly<{ mutation: boolean }>,
): PresentedSessionCredential {
  const cookies = parseCookies(request.headers.get('cookie'));
  const webToken = cookies.get(WEB_SESSION_COOKIE_NAME) ?? null;
  const mobileToken = readBearer(request.headers.get('authorization'));
  if (webToken !== null && mobileToken !== null) {
    throw new SessionAccessError(
      'AMBIGUOUS_CREDENTIAL',
      'Supply exactly one session credential.',
    );
  }
  if (webToken !== null) {
    const csrfVerified =
      !options.mutation || verifyWebMutationCsrf(request, cookies);
    if (!csrfVerified) {
      throw new SessionAccessError(
        'FORBIDDEN',
        'The browser request failed CSRF verification.',
      );
    }
    return Object.freeze({
      token: webToken,
      source: 'web' as const,
      csrfVerified,
    });
  }
  if (mobileToken !== null) {
    return Object.freeze({
      token: mobileToken,
      source: 'mobile' as const,
      csrfVerified: false,
    });
  }
  throw new SessionAccessError(
    'INVALID_CREDENTIAL',
    'A session credential is required.',
  );
}

/**
 * Server-side authz middleware. It performs a database revocation check on
 * every invocation and has deliberately no Google/IdP dependency.
 */
export async function authenticateSessionRequest(
  request: Request,
  service: SessionService,
  options: Readonly<{ mutation: boolean }>,
  now = new Date(),
): Promise<AuthenticatedSession> {
  const presented = readPresentedSessionCredential(request, options);
  return service.authenticate(presented.token, presented.source, now);
}

export function requireRole(
  authenticated: AuthenticatedSession,
  role: Role,
): void {
  if (!authenticated.roles.includes(role)) {
    throw new SessionAccessError('FORBIDDEN', 'Access is denied.');
  }
}

/** Applies the resolved server-side facility scope to a downstream action. */
export function requireFacilityAccess(
  authenticated: AuthenticatedSession,
  facilityId: string,
): void {
  const scope = authenticated.scope.facilityScope;
  if (scope.kind !== 'district' && !scope.facilityIds.includes(facilityId)) {
    throw new SessionAccessError(
      'FORBIDDEN',
      'The requested facility is outside the session scope.',
    );
  }
}

export function createCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CookieWriter {
  set(
    name: string,
    value: string,
    options: Readonly<{
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'strict';
      path: '/';
      maxAge: number;
    }>,
  ): void;
}

/** Writes the only browser credential form; no Domain attribute is accepted. */
export function writeBrowserSessionCookies(
  cookies: CookieWriter,
  refreshToken: string,
  csrfToken: string,
  maxAgeSeconds: number,
): void {
  cookies.set(WEB_SESSION_COOKIE_NAME, refreshToken, {
    ...WEB_SESSION_COOKIE_OPTIONS,
    maxAge: maxAgeSeconds,
  });
  writeBrowserCsrfCookie(cookies, csrfToken, maxAgeSeconds);
}

/** Bootstraps double-submit protection without replacing an OIDC session. */
export function writeBrowserCsrfCookie(
  cookies: CookieWriter,
  csrfToken: string,
  maxAgeSeconds: number,
): void {
  cookies.set(WEB_CSRF_COOKIE_NAME, csrfToken, {
    ...WEB_CSRF_COOKIE_OPTIONS,
    maxAge: maxAgeSeconds,
  });
}

export function clearBrowserSessionCookies(cookies: CookieWriter): void {
  cookies.set(WEB_SESSION_COOKIE_NAME, '', {
    ...WEB_SESSION_COOKIE_OPTIONS,
    maxAge: 0,
  });
  cookies.set(WEB_CSRF_COOKIE_NAME, '', {
    ...WEB_CSRF_COOKIE_OPTIONS,
    maxAge: 0,
  });
}
