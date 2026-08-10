import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEB_RETURN_TO_COOKIE_NAME = '__Host-psd-eoc-return-to';
export const WEB_RETURN_TO_COOKIE_MAX_AGE_SECONDS = 10 * 60;

const DEFAULT_RETURN_TO = '/';
const MAX_RETURN_TO_LENGTH = 2_048;
const CLOCK_TOLERANCE_SECONDS = 60;
const COOKIE_FORMAT_VERSION = 'r1';
const COOKIE_SIGNING_CONTEXT = 'psd-eoc/web-return-to/hmac-sha-256/r1';
const VALIDATION_ORIGIN = 'https://psd-eoc.invalid';

type Environment = Readonly<Record<string, string | undefined>>;

export interface ReturnToCookieState {
  readonly destination: string;
  readonly valid: boolean;
}

function hasValidPercentEncoding(value: string): boolean {
  for (
    let index = value.indexOf('%');
    index >= 0;
    index = value.indexOf('%', index + 1)
  ) {
    if (!/^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))) {
      return false;
    }
  }
  return true;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function decodedPathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isForbiddenDestinationPath(pathname: string): boolean {
  const decoded = decodedPathname(pathname);
  if (
    decoded === null ||
    hasControlCharacter(decoded) ||
    decoded.includes('\\') ||
    decoded.startsWith('//')
  ) {
    return true;
  }
  const normalized = decoded.toLowerCase();
  return ['/api', '/auth', '/login', '/signed-in', '/denied', '/_next'].some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/**
 * Returns an exact, safe app-relative pathname and query or the dashboard.
 * Deliberately rejects values the URL parser would normalize so the value
 * accepted here is the exact value used after sign-in.
 */
export function validateReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RETURN_TO_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('#') ||
    hasControlCharacter(value) ||
    !hasValidPercentEncoding(value)
  ) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const parsed = new URL(value, VALIDATION_ORIGIN);
    if (
      parsed.origin !== VALIDATION_ORIGIN ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.hash.length > 0 ||
      `${parsed.pathname}${parsed.search}` !== value ||
      isForbiddenDestinationPath(parsed.pathname)
    ) {
      return DEFAULT_RETURN_TO;
    }
  } catch {
    return DEFAULT_RETURN_TO;
  }
  return value;
}

/** Reads exactly one returnTo query parameter and validates it. */
export function returnToFromRequestUrl(requestUrl: string): string {
  try {
    const values = new URL(requestUrl).searchParams.getAll('returnTo');
    return values.length === 1
      ? validateReturnTo(values[0])
      : DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

function cookieSecret(environment: Environment): Buffer {
  const value = environment.GOOGLE_OIDC_COOKIE_SECRET;
  if (
    value === undefined ||
    value !== value.trim() ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error('The return destination cookie secret is invalid.');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < 32 ||
    decoded.byteLength > 64 ||
    decoded.toString('base64url') !== value
  ) {
    throw new Error('The return destination cookie secret is invalid.');
  }
  return decoded;
}

function signature(
  secret: Buffer,
  issuedAt: number,
  expiresAt: number,
  encodedDestination: string,
): Buffer {
  return createHmac('sha256', secret)
    .update(COOKIE_SIGNING_CONTEXT, 'utf8')
    .update('\0', 'utf8')
    .update(`${issuedAt}.${expiresAt}.${encodedDestination}`, 'utf8')
    .digest();
}

function serializeCookie(value: string, maxAge: number): string {
  return [
    `${WEB_RETURN_TO_COOKIE_NAME}=${value}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/** Creates an opaque-to-JavaScript, integrity-protected return cookie. */
export function createReturnToCookieHeader(
  destination: unknown,
  options: Readonly<{
    environment?: Environment;
    now?: Date;
  }> = {},
): string {
  const validated = validateReturnTo(destination);
  const now = options.now ?? new Date();
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error('The return destination cookie clock is invalid.');
  }
  const issuedAt = Math.floor(nowMilliseconds / 1_000);
  const expiresAt = issuedAt + WEB_RETURN_TO_COOKIE_MAX_AGE_SECONDS;
  const encodedDestination = Buffer.from(validated, 'utf8').toString(
    'base64url',
  );
  const digest = signature(
    cookieSecret(options.environment ?? process.env),
    issuedAt,
    expiresAt,
    encodedDestination,
  ).toString('base64url');
  return serializeCookie(
    [
      COOKIE_FORMAT_VERSION,
      String(issuedAt),
      String(expiresAt),
      encodedDestination,
      digest,
    ].join('.'),
    WEB_RETURN_TO_COOKIE_MAX_AGE_SECONDS,
  );
}

function cookieValue(cookieHeader: string | null): string | null {
  if (cookieHeader === null || cookieHeader.length > 16_384) {
    return null;
  }
  const matches: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === WEB_RETURN_TO_COOKIE_NAME) {
      matches.push(part.slice(separator + 1).trim());
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

/** Verifies and consumes only server-issued, unexpired return state. */
export function readReturnToCookie(
  cookieHeader: string | null,
  options: Readonly<{
    environment?: Environment;
    now?: Date;
  }> = {},
): ReturnToCookieState {
  const fallback = Object.freeze({
    destination: DEFAULT_RETURN_TO,
    valid: false,
  });
  const value = cookieValue(cookieHeader);
  if (value === null || value.length > 4_096) return fallback;
  const parts = value.split('.');
  const [
    version,
    issuedAtValue,
    expiresAtValue,
    encodedDestination,
    digestValue,
  ] = parts;
  if (
    parts.length !== 5 ||
    version !== COOKIE_FORMAT_VERSION ||
    issuedAtValue === undefined ||
    expiresAtValue === undefined ||
    encodedDestination === undefined ||
    digestValue === undefined ||
    !/^(?:0|[1-9]\d*)$/u.test(issuedAtValue) ||
    !/^(?:0|[1-9]\d*)$/u.test(expiresAtValue)
  ) {
    return fallback;
  }
  const issuedAt = Number(issuedAtValue);
  const expiresAt = Number(expiresAtValue);
  const now = options.now ?? new Date();
  const nowMilliseconds = now.getTime();
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isFinite(nowMilliseconds) ||
    expiresAt - issuedAt !== WEB_RETURN_TO_COOKIE_MAX_AGE_SECONDS
  ) {
    return fallback;
  }
  const nowInSeconds = Math.floor(nowMilliseconds / 1_000);
  if (
    issuedAt > nowInSeconds + CLOCK_TOLERANCE_SECONDS ||
    expiresAt <= nowInSeconds
  ) {
    return fallback;
  }

  const providedDigest = decodeCanonicalBase64Url(digestValue);
  const destinationBytes = decodeCanonicalBase64Url(encodedDestination);
  if (providedDigest === null || destinationBytes === null) return fallback;
  let expectedDigest: Buffer;
  try {
    expectedDigest = signature(
      cookieSecret(options.environment ?? process.env),
      issuedAt,
      expiresAt,
      encodedDestination,
    );
  } catch {
    return fallback;
  }
  if (
    providedDigest.byteLength !== expectedDigest.byteLength ||
    !timingSafeEqual(providedDigest, expectedDigest)
  ) {
    return fallback;
  }

  const destination = destinationBytes.toString('utf8');
  if (
    !Buffer.from(destination, 'utf8').equals(destinationBytes) ||
    validateReturnTo(destination) !== destination
  ) {
    return fallback;
  }
  return Object.freeze({ destination, valid: true });
}

/** Clears return state on every successful or denied callback outcome. */
export function clearReturnToCookieHeader(): string {
  return [
    `${WEB_RETURN_TO_COOKIE_NAME}=`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}
