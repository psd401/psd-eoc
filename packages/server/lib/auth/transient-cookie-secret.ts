import { hkdfSync } from 'node:crypto';

/**
 * The deployment's transient-cookie secret, and the one way it is stretched
 * into a key.
 *
 * Several short-lived sealed values hang off this one secret: the Google
 * return destination, the partner sign-in flow, and the partner passkey
 * enrolment hand-off. Each derives its own key with its own salt and label,
 * so one sealed value can never be opened or forged as another. The
 * validation of the secret itself is identical for all of them, which is why
 * it lives here rather than being written out beside each cookie: a weaker
 * check in one place would weaken every cookie that shares the secret.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export class TransientCookieSecretError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TransientCookieSecretError';
  }
}

/**
 * Reads and validates the raw secret material.
 *
 * It must be canonical unpadded base64url of 32 to 64 bytes. Requiring the
 * round trip to match rejects a value with padding, whitespace, or an
 * over-long final group, any of which would otherwise make two different
 * configured strings derive the same key.
 */
export function transientCookieSecretMaterial(
  environment: Environment,
  message: string,
): Buffer {
  const value = environment.GOOGLE_OIDC_COOKIE_SECRET;
  if (
    value === undefined ||
    value !== value.trim() ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TransientCookieSecretError(message);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < 32 ||
    decoded.byteLength > 64 ||
    decoded.toString('base64url') !== value
  ) {
    throw new TransientCookieSecretError(message);
  }
  return decoded;
}

/**
 * Derives one sealed value's own 256-bit key.
 *
 * `salt` and `info` together name the cookie. Two cookies that pass different
 * values here cannot open each other even though they share the secret, which
 * is the property that lets one secret serve every transient cookie.
 */
export function deriveTransientCookieKey(
  environment: Environment,
  options: Readonly<{ salt: string; info: string; message: string }>,
): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      transientCookieSecretMaterial(environment, options.message),
      options.salt,
      options.info,
      32,
    ),
  );
}
