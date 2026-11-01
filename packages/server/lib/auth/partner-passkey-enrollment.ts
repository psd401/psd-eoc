import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { deriveTransientCookieKey } from './transient-cookie-secret';

/**
 * The short-lived hand-off that lets a partner who has just proven a code
 * enroll a passkey.
 *
 * Amazon Cognito's passkey registration is authenticated by the pool's own
 * access token for the signed-in user: `StartWebAuthnRegistration` and
 * `CompleteWebAuthnRegistration` take an access token, not administrator
 * credentials. The token therefore has to survive the two browser round trips
 * the WebAuthn ceremony needs, and this cookie is where it waits.
 *
 * Why a sealed cookie rather than server memory: the application runs behind
 * App Runner, so the second request of a ceremony need not reach the instance
 * that served the first. A process-local map would make enrollment fail
 * intermittently in exactly the way that is hardest to diagnose. Sealed into
 * an `AES-256-GCM` cookie under this module's own HKDF label, the token is
 * readable only by the deployment that issued it, is `HttpOnly` so no script
 * can read it, and cannot be opened as the sign-in flow cookie beside it.
 *
 * Why it is acceptable for the token to be in a cookie at all: it is already
 * the credential that authorizes exactly these two calls and nothing else
 * this application exposes, it is bound to the one partner who just proved
 * possession of their address, and it expires on its own. The cookie's life
 * is ten minutes — long enough for a person to find their phone or finger,
 * far short of the pool's own sixty-minute token validity — and it is cleared
 * the moment enrollment ends, succeeds, or is declined.
 *
 * Issue #599.
 */

const COOKIE_NAME = '__Host-psd-eoc-partner-passkey';
const COOKIE_VERSION = 'k1';
/**
 * The native app's label for the same sealed hand-off.
 *
 * The app has no cookie jar this deployment is willing to depend on, so it is
 * handed the identical sealed value as an opaque token and returns it
 * untouched. A different version tag and a different associated-data string
 * mean a value sealed for the browser cannot be presented by the app and a
 * value sealed for the app cannot be presented as the cookie, which is the
 * same separation `partner-flow-cookie` keeps between the two surfaces'
 * sign-in flows (issue #647).
 */
const NATIVE_VERSION = 'e1';
/** The HKDF label that separates this cookie's derived key from every
 * other transient cookie's. Public, fixed, and not a credential. */
const DERIVATION_LABEL = 'psd-eoc-partner-passkey-v1';
const IV_BYTES = 12;
const MAX_COOKIE_VALUE_LENGTH = 8 * 1_024;
/** Ten minutes: a person's ceremony, not a session. */
const ENROLLMENT_LIFETIME_SECONDS = 10 * 60;

export const PARTNER_PASSKEY_COOKIE_NAME = COOKIE_NAME;
export const PARTNER_PASSKEY_ENROLLMENT_LIFETIME_SECONDS =
  ENROLLMENT_LIFETIME_SECONDS;

export type Environment = Readonly<Record<string, string | undefined>>;

export class PartnerPasskeyEnrollmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PartnerPasskeyEnrollmentError';
  }
}

/** Which surface a hand-off was sealed for. */
export type PartnerPasskeySurface = 'web' | 'native';

function versionFor(surface: PartnerPasskeySurface): string {
  return surface === 'native' ? NATIVE_VERSION : COOKIE_VERSION;
}

export interface PartnerPasskeyEnrollment {
  /** The pool username, which is the lower-cased address. */
  readonly email: string;
  /**
   * The pool's access token for the sign-in that opened this enrollment.
   *
   * The ceremony's own challenge is deliberately not here. The pool issues it
   * and remembers it against this token, so the pool is what refuses a
   * credential answering a challenge it never issued; keeping a second copy
   * in a cookie would add a check that can disagree with the authority.
   */
  readonly accessToken: string;
  /**
   * The native platform this enrollment creates a passkey on, absent on the
   * browser.
   *
   * It is here rather than in the request because it decides which ceremony
   * origin the created credential is checked against: iOS reports an https
   * origin and Android an `android:apk-key-hash:` one. Taking it from the
   * seal means a caller cannot choose which check applies to it (issue #647).
   */
  readonly platform?: 'ios' | 'android';
  readonly expiresAt: number;
}

function associatedData(surface: PartnerPasskeySurface): Buffer {
  return Buffer.from(`${COOKIE_NAME}.${versionFor(surface)}`, 'utf8');
}

function cookieKey(environment: Environment): Buffer {
  try {
    return deriveTransientCookieKey(environment, {
      salt: COOKIE_NAME,
      info: DERIVATION_LABEL,
      message: 'The partner passkey cookie secret is invalid.',
    });
  } catch (error) {
    throw new PartnerPasskeyEnrollmentError(
      error instanceof Error
        ? error.message
        : 'The partner passkey cookie secret is invalid.',
    );
  }
}

/** Seals one enrollment hand-off. */
export function sealPartnerPasskeyEnrollment(
  enrollment: PartnerPasskeyEnrollment,
  environment: Environment = process.env,
  surface: PartnerPasskeySurface = 'web',
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(environment), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(associatedData(surface));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(enrollment), 'utf8'),
    cipher.final(),
  ]);
  return [
    versionFor(surface),
    iv.toString('base64url'),
    sealed.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/** Opens one sealed enrollment, or null when it cannot be trusted. */
export function openPartnerPasskeyEnrollment(
  value: string | null | undefined,
  now: Date,
  environment: Environment = process.env,
  surface: PartnerPasskeySurface = 'web',
): PartnerPasskeyEnrollment | null {
  if (
    value === null ||
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_COOKIE_VALUE_LENGTH
  ) {
    return null;
  }
  const [version, ivPart, sealedPart, tagPart, ...rest] = value.split('.');
  if (
    version !== versionFor(surface) ||
    ivPart === undefined ||
    sealedPart === undefined ||
    tagPart === undefined ||
    rest.length > 0
  ) {
    return null;
  }
  let plaintext: string;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      cookieKey(environment),
      Buffer.from(ivPart, 'base64url'),
      { authTagLength: 16 },
    );
    decipher.setAAD(associatedData(surface));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealedPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const { email, accessToken, platform, expiresAt } = record;
  // A native hand-off names the platform it enrolls and a browser one never
  // does, so a seal cannot be carried from one surface's shape to the other's
  // even if its label were somehow accepted. Narrowing here rather than
  // testing it separately is what lets the result be built without an
  // assertion the compiler cannot check.
  const nativePlatform =
    platform === 'ios' || platform === 'android' ? platform : null;
  const platformValid =
    surface === 'native' ? nativePlatform !== null : platform === undefined;
  if (
    typeof email !== 'string' ||
    email.length === 0 ||
    email.length > 320 ||
    email !== email.toLowerCase() ||
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    accessToken.length > 6 * 1_024 ||
    !platformValid ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now.getTime()
  ) {
    return null;
  }
  return Object.freeze(
    nativePlatform !== null && surface === 'native'
      ? { email, accessToken, platform: nativePlatform, expiresAt }
      : { email, accessToken, expiresAt },
  );
}

/**
 * The `__Host-` prefix makes a browser require Secure, Path=/ and no Domain,
 * exactly as the sign-in flow cookie beside it does. `SameSite=Strict`
 * because, unlike the flow cookie, nothing ever arrives at this cookie from
 * another site's navigation: every request that reads it is a same-origin
 * `fetch` from the enrollment page.
 */
function serializeCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${COOKIE_NAME}=${value}`,
    `Max-Age=${String(maxAgeSeconds)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

/** The Set-Cookie header that opens a passkey enrollment. */
export function partnerPasskeyCookieHeader(
  enrollment: PartnerPasskeyEnrollment,
  environment: Environment = process.env,
): string {
  return serializeCookie(
    sealPartnerPasskeyEnrollment(enrollment, environment),
    ENROLLMENT_LIFETIME_SECONDS,
  );
}

/** The Set-Cookie header that ends one, used after every outcome. */
export function clearPartnerPasskeyCookieHeader(): string {
  return `${serializeCookie('', 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** Reads the enrollment cookie's raw value out of a request cookie header. */
export function readPartnerPasskeyCookie(
  cookieHeader: string | null,
): string | null {
  if (cookieHeader === null || cookieHeader.length > 16_384) {
    return null;
  }
  const matches: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === COOKIE_NAME) {
      matches.push(part.slice(separator + 1).trim());
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
