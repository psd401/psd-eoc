import {
  type MobileOidcStartResponse,
  type MobileSessionResponse,
  type NativeDevicePlatform,
} from '@psd-eoc/contracts';

import type { AuthApiClient } from './auth-api-client';
import { MobileAuthError } from './auth-errors';
import type { PendingOidcFlowStore } from './pending-oidc-flow';

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The browser session ended without handing back a redirect.
 *
 * On Android that is routinely not a cancellation at all: the OS can deliver
 * `psdeoc://auth/callback` straight to the app as an intent, which dismisses
 * the custom tab, and `promptAsync` then resolves as dismissed even though the
 * authorization code arrived safely on the deep-link route. The distinct type
 * is what lets the resume path tell "the person backed out" apart from "the
 * redirect went somewhere else", because only the second one may be retried
 * with a code this device is already holding.
 */
export class OidcRedirectNotCapturedError extends MobileAuthError {
  public constructor() {
    super(
      'rejected',
      'Google sign-in was cancelled. No device session was created.',
    );
    this.name = 'OidcRedirectNotCapturedError';
  }
}

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
    private readonly pendingFlowStore: PendingOidcFlowStore | null = null,
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
    // Written before the browser opens, because on Android the redirect can
    // come back to a process that no longer holds this closure.
    await this.pendingFlowStore?.save({
      state: start.state,
      codeVerifier: pkce.verifier,
      flowToken: start.flowToken,
      expiresAt: start.expiresAt,
    });
    let redirectMayBeElsewhere = false;
    try {
      const authorization = await this.browser.authorize(start);
      if (authorization.kind === 'cancelled') {
        redirectMayBeElsewhere = true;
        throw new OidcRedirectNotCapturedError();
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
      return await this.transport.exchangeOidc({
        authorizationCode: authorization.authorizationCode,
        state: authorization.state,
        codeVerifier: pkce.verifier,
        flowToken: start.flowToken,
      });
    } finally {
      // An attempt that reached the browser's answer is finished, and leaving
      // the record behind would let a later redelivery of the same deep link
      // start a second exchange. An attempt whose redirect was never captured
      // is not finished: the code may be sitting on the deep-link route right
      // now, and this record is the only copy of the verifier and flow token
      // that can spend it. It stays single-use through `take` and stops being
      // usable at `expiresAt` either way.
      if (!redirectMayBeElsewhere) {
        await this.pendingFlowStore?.clear();
      }
    }
  }

  /**
   * Completes an attempt whose redirect arrived outside `promptAsync`.
   *
   * This is the Android cold-start path: the OS routed `psdeoc://auth/callback`
   * into a process that never ran `signIn`, so the verifier and flow token come
   * from storage rather than a closure. The state comparison is what makes that
   * safe — a deep link that does not match the attempt this device actually
   * started is refused before any code is exchanged.
   */
  public async completeSignIn(
    authorizationCode: string,
    state: string,
  ): Promise<MobileSessionResponse> {
    if (this.pendingFlowStore === null) {
      throw new MobileAuthError(
        'configuration',
        'This build cannot resume a Google sign-in that was started elsewhere.',
      );
    }
    const pending = await this.pendingFlowStore.take();
    if (pending === null) {
      throw new MobileAuthError(
        'rejected',
        'There is no Google sign-in waiting to be completed. Start sign-in again.',
      );
    }
    if (pending.state !== state) {
      throw new MobileAuthError(
        'rejected',
        'Google sign-in could not be verified. No device session was created.',
      );
    }
    if (this.now().getTime() >= Date.parse(pending.expiresAt)) {
      throw new MobileAuthError(
        'rejected',
        'The Google sign-in attempt expired. Try again.',
      );
    }
    return this.transport.exchangeOidc({
      authorizationCode,
      state,
      codeVerifier: pending.codeVerifier,
      flowToken: pending.flowToken,
    });
  }
}

/** Keeps the concrete client structurally checked against the OIDC transport. */
export function asOidcTransport(client: AuthApiClient): OidcTransport {
  return client;
}
