import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * The transient state of one partner sign-in, between asking for a code and
 * answering with it.
 *
 * It is the partner counterpart of the Google transient callback cookie: a
 * short-lived, authenticated-encrypted, `__Host-`-prefixed, HttpOnly cookie
 * that carries only what the second step needs. The pool's own continuation
 * handle is opaque and single-use; the address is in here so the second step
 * cannot be pointed at a different one.
 *
 * The key is derived from the deployment's transient-cookie secret with its
 * own label, so this cookie and the Google callback cookie can never be
 * decrypted or forged as one another.
 */

const COOKIE_NAME = '__Host-psd-eoc-partner-flow';
const COOKIE_VERSION = 'p1';
const FLOW_LIFETIME_SECONDS = 5 * 60;
const KEY_INFO = 'psd-eoc-partner-otp-flow-v1';
const IV_BYTES = 12;
const MAX_COOKIE_VALUE_LENGTH = 4 * 1_024;

export const PARTNER_FLOW_COOKIE_NAME = COOKIE_NAME;
export const PARTNER_FLOW_LIFETIME_SECONDS = FLOW_LIFETIME_SECONDS;

export type Environment = Readonly<Record<string, string | undefined>>;

export interface PartnerSignInFlow {
  readonly email: string;
  /** The identity provider's opaque continuation for this one challenge. */
  readonly flowSession: string;
  /** The browser installation this sign-in enrolls. */
  readonly installationId: string;
  readonly expiresAt: number;
}

export class PartnerFlowCookieError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PartnerFlowCookieError';
  }
}

/**
 * The deployment's transient-cookie secret, validated exactly as the return
 * destination cookie validates it, then stretched into this cookie's own key.
 */
function cookieKey(environment: Environment): Buffer {
  const value = environment.GOOGLE_OIDC_COOKIE_SECRET;
  if (
    value === undefined ||
    value !== value.trim() ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new PartnerFlowCookieError(
      'The partner sign-in cookie secret is invalid.',
    );
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < 32 ||
    decoded.byteLength > 64 ||
    decoded.toString('base64url') !== value
  ) {
    throw new PartnerFlowCookieError(
      'The partner sign-in cookie secret is invalid.',
    );
  }
  return Buffer.from(hkdfSync('sha256', decoded, COOKIE_NAME, KEY_INFO, 32));
}

/** Serializes one flow into a sealed cookie value. */
export function sealPartnerSignInFlow(
  flow: PartnerSignInFlow,
  environment: Environment = process.env,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(environment), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(`${COOKIE_NAME}.${COOKIE_VERSION}`, 'utf8'));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(flow), 'utf8'),
    cipher.final(),
  ]);
  return [
    COOKIE_VERSION,
    iv.toString('base64url'),
    sealed.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/** Opens one sealed cookie value, or null when it cannot be trusted. */
export function openPartnerSignInFlow(
  value: string | null | undefined,
  now: Date,
  environment: Environment = process.env,
): PartnerSignInFlow | null {
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
    version !== COOKIE_VERSION ||
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
    decipher.setAAD(Buffer.from(`${COOKIE_NAME}.${COOKIE_VERSION}`, 'utf8'));
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
  const { email, flowSession, installationId, expiresAt } = record;
  if (
    typeof email !== 'string' ||
    email.length === 0 ||
    email.length > 320 ||
    email !== email.toLowerCase() ||
    typeof flowSession !== 'string' ||
    flowSession.length === 0 ||
    flowSession.length > 2_048 ||
    typeof installationId !== 'string' ||
    installationId.length < 16 ||
    installationId.length > 255 ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now.getTime()
  ) {
    return null;
  }
  return Object.freeze({ email, flowSession, installationId, expiresAt });
}

/**
 * The `__Host-` prefix makes a browser require Secure, Path=/ and no Domain,
 * exactly as the return-destination cookie beside it does. Browsers treat
 * `localhost` as a secure context, so this holds in development too.
 */
function serializeCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${COOKIE_NAME}=${value}`,
    `Max-Age=${String(maxAgeSeconds)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/** The Set-Cookie header that carries one flow to the second step. */
export function partnerFlowCookieHeader(
  flow: PartnerSignInFlow,
  environment: Environment = process.env,
): string {
  return serializeCookie(
    sealPartnerSignInFlow(flow, environment),
    FLOW_LIFETIME_SECONDS,
  );
}

/** The Set-Cookie header that removes a flow, used after every outcome. */
export function clearPartnerFlowCookieHeader(): string {
  return `${serializeCookie('', 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** Reads the flow cookie's raw value out of a request cookie header. */
export function readPartnerFlowCookie(
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
