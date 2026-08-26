export const FCM_MESSAGING_SCOPE =
  'https://www.googleapis.com/auth/firebase.messaging' as const;
export const FCM_OAUTH_REFRESH_SKEW_MILLISECONDS = 5 * 60_000;

export interface FcmOAuthTokenRequest {
  readonly projectId: string;
  readonly scope: typeof FCM_MESSAGING_SCOPE;
}

export interface FcmOAuthTokenResult {
  readonly accessToken: string;
  readonly projectId: string;
  readonly expiresAt: Date | string | number;
}

export type FcmOAuthTokenSource = (
  request: FcmOAuthTokenRequest,
) => FcmOAuthTokenResult | Promise<FcmOAuthTokenResult>;

export interface FcmOAuthCredentialOptions {
  readonly projectId: string;
  readonly tokenSource: FcmOAuthTokenSource;
  readonly clock?: () => Date | string | number;
}

export interface FcmOAuthAccessToken {
  readonly accessToken: string;
  readonly projectId: string;
  readonly expiresAtMilliseconds: number;
}

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,29}[a-z0-9]$/u;

export function parseFcmProjectId(value: string): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError('FCM project identifier is invalid.');
  }
  return value;
}

function parseAccessToken(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 8_192 ||
    value.trim() !== value ||
    /[\s\p{Cc}]/u.test(value)
  ) {
    throw new TypeError('FCM OAuth token is invalid.');
  }
  return value;
}

function nowMilliseconds(clock: () => Date | string | number): number {
  const now = new Date(clock()).getTime();
  if (!Number.isFinite(now)) throw new TypeError('FCM clock is invalid.');
  return now;
}

/** Fixed-scope, project-bound short-lived OAuth credential cache. */
export class FcmOAuthCredential {
  public readonly projectId: string;
  readonly #source: FcmOAuthTokenSource;
  readonly #clock: () => Date | string | number;
  #cached: FcmOAuthAccessToken | null = null;
  #pending: Promise<FcmOAuthAccessToken> | null = null;

  public constructor(options: FcmOAuthCredentialOptions) {
    if (typeof options.tokenSource !== 'function') {
      throw new TypeError('FCM OAuth token source is invalid.');
    }
    this.projectId = parseFcmProjectId(options.projectId);
    this.#source = options.tokenSource;
    this.#clock = options.clock ?? Date.now;
  }

  public getAccessToken(): Promise<FcmOAuthAccessToken> {
    const now = nowMilliseconds(this.#clock);
    if (
      this.#cached !== null &&
      now <
        this.#cached.expiresAtMilliseconds - FCM_OAUTH_REFRESH_SKEW_MILLISECONDS
    ) {
      return Promise.resolve(this.#cached);
    }
    if (this.#pending !== null) return this.#pending;
    this.#pending = this.#refresh(now).finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #refresh(now: number): Promise<FcmOAuthAccessToken> {
    const result = await this.#source(
      Object.freeze({
        projectId: this.projectId,
        scope: FCM_MESSAGING_SCOPE,
      }),
    );
    const expiresAtMilliseconds = new Date(result.expiresAt).getTime();
    if (
      result.projectId !== this.projectId ||
      !Number.isFinite(expiresAtMilliseconds) ||
      expiresAtMilliseconds - now <= FCM_OAUTH_REFRESH_SKEW_MILLISECONDS ||
      expiresAtMilliseconds - now > 65 * 60_000
    ) {
      throw new TypeError('FCM OAuth credential response is invalid.');
    }
    const cached = Object.freeze({
      accessToken: parseAccessToken(result.accessToken),
      projectId: this.projectId,
      expiresAtMilliseconds,
    });
    this.#cached = cached;
    return cached;
  }
}
