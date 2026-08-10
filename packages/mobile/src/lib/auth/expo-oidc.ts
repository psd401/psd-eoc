import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import type { MobileOidcStartResponse } from '@psd-eoc/contracts';

import { MobileAuthError } from './auth-errors';
import type { OidcBrowser, PkceSource } from './oidc-client';

export const expoPkceSource: PkceSource = Object.freeze({
  randomBytes(length: number) {
    return Crypto.getRandomBytesAsync(length);
  },
  sha256Base64(value: string) {
    return Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      value,
      {
        encoding: Crypto.CryptoEncoding.BASE64,
      },
    );
  },
});

export const expoOidcBrowser: OidcBrowser = Object.freeze({
  async authorize(start: MobileOidcStartResponse) {
    const request = new AuthSession.AuthRequest({
      clientId: start.clientId,
      redirectUri: start.appRedirectUri,
      responseType: AuthSession.ResponseType.Code,
      state: start.state,
      // PKCE is generated before the server start request. The server-provided
      // URL and authenticated flow token bind its S256 challenge.
      usePKCE: false,
    });
    const result = await request.promptAsync(
      { authorizationEndpoint: start.authorizationUrl },
      { url: start.authorizationUrl },
    );
    if (result.type !== 'success') {
      return Object.freeze({ kind: 'cancelled' as const });
    }
    const authorizationCode = result.params.code;
    const returnedState = result.params.state;
    if (
      authorizationCode === undefined ||
      returnedState === undefined ||
      returnedState !== start.state
    ) {
      throw new MobileAuthError(
        'rejected',
        'Google sign-in could not be verified. No device session was created.',
      );
    }
    return Object.freeze({
      kind: 'success' as const,
      authorizationCode,
      state: returnedState,
    });
  },
});
