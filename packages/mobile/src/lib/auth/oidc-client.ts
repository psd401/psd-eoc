import {
  type MobileOidcStartResponse,
  type MobileSessionResponse,
  type NativeDevicePlatform,
} from '@psd-eoc/contracts';

import type { AuthApiClient } from './auth-api-client';
import { MobileAuthError } from './auth-errors';

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface PkceSource {
  randomBytes(length: number): Promise<Uint8Array>;
  sha256Base64(value: string): Promise<string>;
}

export interface OidcBrowser {
  authorize(start: MobileOidcStartResponse): Promise<
    | Readonly<{
        kind: 'success';
        authorizationCode: string;
        state: string;
      }>
    | Readonly<{ kind: 'cancelled' }>
  >;
}

export interface OidcTransport {
  startOidc(input: {
    platform: NativeDevicePlatform;
    installationId: string;
    codeChallenge: string;
  }): Promise<MobileOidcStartResponse>;
  exchangeOidc(input: {
    authorizationCode: string;
    state: string;
    codeVerifier: string;
    flowToken: string;
  }): Promise<MobileSessionResponse>;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(combined >> 18) & 63] ?? '';
    encoded += BASE64_ALPHABET[(combined >> 12) & 63] ?? '';
    encoded +=
      second === undefined
        ? '='
        : (BASE64_ALPHABET[(combined >> 6) & 63] ?? '');
    encoded +=
      third === undefined ? '=' : (BASE64_ALPHABET[combined & 63] ?? '');
  }
  return encoded.replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function base64ToUrl(value: string): string {
  return value.replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

export async function createPkcePair(
  source: PkceSource,
): Promise<Readonly<{ verifier: string; challenge: string }>> {
  const verifier = encodeBase64Url(await source.randomBytes(32));
  const challenge = base64ToUrl(await source.sha256Base64(verifier));
  return Object.freeze({ verifier, challenge });
}

export class MobileOidcClient {
  public constructor(
    private readonly transport: OidcTransport,
    private readonly browser: OidcBrowser,
    private readonly pkceSource: PkceSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async signIn(
    platform: NativeDevicePlatform,
    installationId: string,
  ): Promise<MobileSessionResponse> {
    const pkce = await createPkcePair(this.pkceSource);
    const start = await this.transport.startOidc({
      platform,
      installationId,
      codeChallenge: pkce.challenge,
    });
    if (this.now().getTime() >= Date.parse(start.expiresAt)) {
      throw new MobileAuthError(
        'rejected',
        'The Google sign-in attempt expired. Try again.',
      );
    }
    const authorization = await this.browser.authorize(start);
    if (authorization.kind === 'cancelled') {
      throw new MobileAuthError(
        'rejected',
        'Google sign-in was cancelled. No device session was created.',
      );
    }
    if (authorization.state !== start.state) {
      throw new MobileAuthError(
        'rejected',
        'Google sign-in could not be verified. No device session was created.',
      );
    }
    if (this.now().getTime() >= Date.parse(start.expiresAt)) {
      throw new MobileAuthError(
        'rejected',
        'The Google sign-in attempt expired. Try again.',
      );
    }
    return this.transport.exchangeOidc({
      authorizationCode: authorization.authorizationCode,
      state: authorization.state,
      codeVerifier: pkce.verifier,
      flowToken: start.flowToken,
    });
  }
}

/** Keeps the concrete client structurally checked against the OIDC transport. */
export function asOidcTransport(client: AuthApiClient): OidcTransport {
  return client;
}
