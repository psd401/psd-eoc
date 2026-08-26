export const APNS_JWT_ALGORITHM = 'ES256' as const;
export const APNS_JWT_MINIMUM_REFRESH_MILLISECONDS = 20 * 60_000;
export const APNS_JWT_REFRESH_MILLISECONDS = 50 * 60_000;
export const APNS_JWT_MAXIMUM_AGE_MILLISECONDS = 60 * 60_000;

export interface ApnsJwtConfiguration {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
}

export interface ApnsJwtSigningInput {
  readonly algorithm: typeof APNS_JWT_ALGORITHM;
  readonly keyId: string;
  readonly teamId: string;
  readonly issuedAt: number;
  readonly privateKey: string;
}

export type ApnsJwtSigner = (
  input: ApnsJwtSigningInput,
) => string | Promise<string>;

export interface ApnsJwtCredentialOptions extends ApnsJwtConfiguration {
  readonly signer: ApnsJwtSigner;
  readonly clock?: () => Date | string | number;
}

const APPLE_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/u;
const JWT_PATTERN =
  /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}$/u;

function parseIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || !APPLE_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`APNs ${label} is invalid.`);
  }
  return value;
}

function parsePrivateKey(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError('APNs private key is invalid.');
  }
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  const containsUnsafeControl = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 10) || code === 127;
  });
  if (
    value.length < 100 ||
    value.length > 16_384 ||
    !normalized.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !normalized.endsWith('\n-----END PRIVATE KEY-----') ||
    normalized.trim() !== normalized ||
    containsUnsafeControl
  ) {
    throw new TypeError('APNs private key is invalid.');
  }
  return normalized;
}

function clockMilliseconds(clock: () => Date | string | number): number {
  const value = new Date(clock()).getTime();
  if (!Number.isFinite(value)) throw new TypeError('APNs clock is invalid.');
  return value;
}

/**
 * Caches Apple provider tokens for fifty minutes. Successful signing can
 * therefore never occur more frequently than Apple's twenty-minute floor and
 * always refreshes before Apple's sixty-minute maximum age.
 */
export class ApnsJwtCredential {
  readonly #configuration: ApnsJwtConfiguration;
  readonly #signer: ApnsJwtSigner;
  readonly #clock: () => Date | string | number;
  #cached: Readonly<{ token: string; issuedAtMilliseconds: number }> | null =
    null;
  #pending: Promise<string> | null = null;

  public constructor(options: ApnsJwtCredentialOptions) {
    if (typeof options.signer !== 'function') {
      throw new TypeError('APNs JWT signer is invalid.');
    }
    this.#configuration = Object.freeze({
      teamId: parseIdentifier(options.teamId, 'team identifier'),
      keyId: parseIdentifier(options.keyId, 'key identifier'),
      privateKey: parsePrivateKey(options.privateKey),
    });
    this.#signer = options.signer;
    this.#clock = options.clock ?? Date.now;
  }

  public getToken(): Promise<string> {
    const now = clockMilliseconds(this.#clock);
    if (
      this.#cached !== null &&
      now - this.#cached.issuedAtMilliseconds < APNS_JWT_REFRESH_MILLISECONDS
    ) {
      return Promise.resolve(this.#cached.token);
    }
    if (this.#pending !== null) return this.#pending;
    this.#pending = this.#sign(now).finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #sign(now: number): Promise<string> {
    const token = await this.#signer(
      Object.freeze({
        algorithm: APNS_JWT_ALGORITHM,
        keyId: this.#configuration.keyId,
        teamId: this.#configuration.teamId,
        issuedAt: Math.floor(now / 1_000),
        privateKey: this.#configuration.privateKey,
      }),
    );
    if (typeof token !== 'string' || !JWT_PATTERN.test(token)) {
      throw new TypeError('APNs JWT signer returned an invalid token.');
    }
    this.#cached = Object.freeze({ token, issuedAtMilliseconds: now });
    return token;
  }
}
