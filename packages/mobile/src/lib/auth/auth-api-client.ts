import {
  ApiErrorSchema,
  MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER,
  MobilePartnerPasskeyEnrollmentTokenSchema,
  MobilePartnerPasskeyRegisterFinishRequestSchema,
  MobilePartnerPasskeyRegisterFinishResponseSchema,
  MobilePartnerPasskeyRegisterStartRequestSchema,
  MobilePartnerPasskeyRegisterStartResponseSchema,
  MobilePartnerPasskeySignInFinishRequestSchema,
  MobilePartnerPasskeySignInStartRequestSchema,
  MobilePartnerPasskeySignInStartResponseSchema,
  MobileAppReviewSignInRequestSchema,
  MobileOidcExchangeRequestSchema,
  MobileOidcStartRequestSchema,
  MobileOidcStartResponseSchema,
  MobilePartnerSignInStartRequestSchema,
  MobilePartnerSignInStartResponseSchema,
  MobilePartnerSignInVerifyRequestSchema,
  MobileSessionResponseSchema,
  RevokeSessionInputSchema,
  SessionRevocationSchema,
  type MobileAppReviewSignInRequest,
  type MobilePartnerPasskeyRegisterStartResponse,
  type MobilePartnerPasskeySignInStartResponse,
  type PartnerPasskeyAssertionCredential,
  type PartnerPasskeyRegistrationCredential,
  type MobileOidcExchangeRequest,
  type MobileOidcStartRequest,
  type MobileOidcStartResponse,
  type MobilePartnerSignInStartRequest,
  type MobilePartnerSignInStartResponse,
  type MobilePartnerSignInVerifyRequest,
  type MobileSessionResponse,
} from '@psd-eoc/contracts';

import { tolerantResponseSchema } from '../api/forward-compatible-parse';
import type { SessionApi } from './auth-controller';
import { MobileAuthError } from './auth-errors';
import type { PartnerPasskeyApi } from './partner-passkey-client';

const REQUEST_TIMEOUT_MS = 8_000;

/** One path, four steps, as the browser's passkey endpoint is. */
const PARTNER_PASSKEY_PATH = '/api/auth/mobile/partner/passkey';

export type AuthFetch = (input: string, init: RequestInit) => Promise<Response>;

export function parseAuthApiBaseUrl(
  value: string | undefined,
  allowLoopbackHttp: boolean,
): string {
  if (value === undefined || value.trim().length === 0) {
    throw new MobileAuthError(
      'configuration',
      'PSD EOC sign-in is not configured for this build.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MobileAuthError(
      'configuration',
      'PSD EOC sign-in is not configured for this build.',
    );
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname);
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    (parsed.protocol !== 'https:' &&
      !(allowLoopbackHttp && loopback && parsed.protocol === 'http:'))
  ) {
    throw new MobileAuthError(
      'configuration',
      'PSD EOC sign-in is not configured for this build.',
    );
  }
  return parsed.origin;
}

/** Public policy served by the same tenant-configured origin as mobile auth. */
export function privacyPolicyUrl(
  value: string | undefined,
  allowLoopbackHttp: boolean,
): string {
  return `${parseAuthApiBaseUrl(value, allowLoopbackHttp)}/privacy`;
}

interface Schema<Output> {
  parse(value: unknown): Output;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.status === 401 || response.status === 403) {
      throw new MobileAuthError(
        'rejected',
        'This device session is no longer available.',
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new MobileAuthError(
        'offline',
        'PSD EOC cannot reach the server. Cached view only.',
      );
    }
    throw new MobileAuthError(
      'invalid-response',
      'PSD EOC received an invalid authentication response.',
    );
  }
}

function safeErrorMessage(value: unknown, fallback: string): string {
  const parsed = ApiErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.message : fallback;
}

export class AuthApiClient implements SessionApi, PartnerPasskeyApi {
  public constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImplementation: AuthFetch = fetch,
  ) {}

  /**
   * One authenticated POST, with the response's own headers kept.
   *
   * Only the partner code sign-in reads a header, and only to pick up the
   * opaque passkey enrollment hand-off the server offers there (issue #647).
   * Everything else takes `post` and never sees them.
   */
  private async postReadingHeaders<Output>(
    path: string,
    body: unknown,
    schema: Schema<Output>,
    options: Readonly<{
      bearer?: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }> = {},
  ): Promise<Readonly<{ payload: Output; headers: Headers }>> {
    const controller = new AbortController();
    const abortFromCaller = () => {
      controller.abort();
    };
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      };
      if (options.bearer !== undefined) {
        headers.Authorization = `Bearer ${options.bearer}`;
      }
      if (options.idempotencyKey !== undefined) {
        headers['Idempotency-Key'] = options.idempotencyKey;
      }
      const response = await this.fetchImplementation(
        `${this.baseUrl()}${path}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const value = await responseJson(response);
      if (!response.ok) {
        const fallback = 'PSD EOC authentication was not accepted.';
        const message = safeErrorMessage(value, fallback);
        if (response.status === 401 || response.status === 403) {
          throw new MobileAuthError('rejected', message);
        }
        if (response.status === 429 || response.status >= 500) {
          throw new MobileAuthError('offline', message);
        }
        throw new MobileAuthError('invalid-response', fallback);
      }
      try {
        return { payload: schema.parse(value), headers: response.headers };
      } catch {
        throw new MobileAuthError(
          'invalid-response',
          'PSD EOC received an invalid authentication response.',
        );
      }
    } catch (error) {
      if (error instanceof MobileAuthError) {
        throw error;
      }
      throw new MobileAuthError(
        'offline',
        'PSD EOC cannot reach the server. Cached view only.',
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async post<Output>(
    path: string,
    body: unknown,
    schema: Schema<Output>,
    options: Readonly<{
      bearer?: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }> = {},
  ): Promise<Output> {
    return (await this.postReadingHeaders(path, body, schema, options)).payload;
  }

  public startOidc(
    input: MobileOidcStartRequest,
  ): Promise<MobileOidcStartResponse> {
    return this.post(
      '/api/auth/mobile/oidc/start',
      MobileOidcStartRequestSchema.parse(input),
      MobileOidcStartResponseSchema,
    );
  }

  public exchangeOidc(
    input: MobileOidcExchangeRequest,
  ): Promise<MobileSessionResponse> {
    return this.post(
      '/api/auth/mobile/oidc/exchange',
      MobileOidcExchangeRequestSchema.parse(input),
      MobileSessionResponseSchema,
    );
  }

  /** Signs in the deployment's app-store review account with its code. */
  public appReviewSignIn(
    input: MobileAppReviewSignInRequest,
  ): Promise<MobileSessionResponse> {
    return this.post(
      '/api/auth/mobile/app-review',
      MobileAppReviewSignInRequestSchema.parse(input),
      MobileSessionResponseSchema,
    );
  }

  /**
   * Partner sign-in, first step: ask the partner pool to email a code.
   *
   * It answers the same way for every address, so a caller cannot learn from
   * it whether an address holds partner access. The sealed flow it hands back
   * carries the address and the device this sign-in would enroll; the app
   * returns it untouched with the code and never reads it.
   */
  public partnerSignInStart(
    input: MobilePartnerSignInStartRequest,
  ): Promise<MobilePartnerSignInStartResponse> {
    return this.post(
      '/api/auth/mobile/partner/start',
      MobilePartnerSignInStartRequestSchema.parse(input),
      MobilePartnerSignInStartResponseSchema,
    );
  }

  /**
   * Partner sign-in, second step: answer the sealed flow with its code.
   *
   * A completed sign-in may also offer a passkey enrollment hand-off, in a
   * response header. It is read here and nowhere else: the session payload is
   * the shape every installed build already parses, which is why the offer is
   * not in it (issue #647).
   */
  public async partnerSignInVerify(
    input: MobilePartnerSignInVerifyRequest,
  ): Promise<
    Readonly<{
      session: MobileSessionResponse;
      passkeyEnrollmentToken: string | null;
    }>
  > {
    const { payload, headers } = await this.postReadingHeaders(
      '/api/auth/mobile/partner/verify',
      MobilePartnerSignInVerifyRequestSchema.parse(input),
      MobileSessionResponseSchema,
    );
    const offered = headers.get(MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER);
    return Object.freeze({
      session: payload,
      // An unparsable or absent offer is simply no offer: a sign-in that
      // worked must never fail over the thing that was optional.
      passkeyEnrollmentToken:
        offered !== null &&
        MobilePartnerPasskeyEnrollmentTokenSchema.safeParse(offered).success
          ? offered
          : null,
    });
  }

  /**
   * Partner passkey sign-in, first step: ask whether this address signs in
   * with a passkey on this device.
   *
   * The answer is the ceremony options or the instruction to use an emailed
   * code, and nothing else, so it cannot be read as a statement about who
   * holds partner access.
   */
  public partnerPasskeySignInStart(
    input: Parameters<PartnerPasskeyApi['partnerPasskeySignInStart']>[0],
  ): Promise<MobilePartnerPasskeySignInStartResponse> {
    return this.post(
      PARTNER_PASSKEY_PATH,
      MobilePartnerPasskeySignInStartRequestSchema.parse({
        step: 'sign-in-start',
        ...input,
      }),
      tolerantResponseSchema(MobilePartnerPasskeySignInStartResponseSchema),
    );
  }

  /** Partner passkey sign-in, second step: answer the pool's challenge. */
  public partnerPasskeySignInFinish(
    input: Readonly<{
      flowToken: string;
      credential: PartnerPasskeyAssertionCredential;
    }>,
  ): Promise<MobileSessionResponse> {
    return this.post(
      PARTNER_PASSKEY_PATH,
      MobilePartnerPasskeySignInFinishRequestSchema.parse({
        step: 'sign-in-finish',
        ...input,
      }),
      MobileSessionResponseSchema,
    );
  }

  /** Enrollment, first step: the options to create a passkey with. */
  public partnerPasskeyRegisterStart(
    input: Readonly<{ enrollmentToken: string }>,
  ): Promise<MobilePartnerPasskeyRegisterStartResponse> {
    return this.post(
      PARTNER_PASSKEY_PATH,
      MobilePartnerPasskeyRegisterStartRequestSchema.parse({
        step: 'register-start',
        ...input,
      }),
      tolerantResponseSchema(MobilePartnerPasskeyRegisterStartResponseSchema),
    );
  }

  /** Enrollment, second step: hand the pool the created passkey. */
  public async partnerPasskeyRegisterFinish(
    input: Readonly<{
      enrollmentToken: string;
      credential: PartnerPasskeyRegistrationCredential;
    }>,
  ): Promise<void> {
    await this.post(
      PARTNER_PASSKEY_PATH,
      MobilePartnerPasskeyRegisterFinishRequestSchema.parse({
        step: 'register-finish',
        ...input,
      }),
      tolerantResponseSchema(MobilePartnerPasskeyRegisterFinishResponseSchema),
    );
  }

  public refresh(
    refreshToken: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<MobileSessionResponse> {
    return this.post('/api/auth/refresh', {}, MobileSessionResponseSchema, {
      bearer: refreshToken,
      idempotencyKey,
      signal,
    });
  }

  public async revoke(
    refreshToken: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const revocation = await this.post(
      '/api/auth/revoke',
      RevokeSessionInputSchema.parse({
        sessionId,
        reasonCode: 'USER_SIGN_OUT',
      }),
      SessionRevocationSchema,
      { bearer: refreshToken, idempotencyKey },
    );
    if (revocation.sessionId !== sessionId) {
      throw new MobileAuthError(
        'invalid-response',
        'PSD EOC received an invalid authentication response.',
      );
    }
  }
}
