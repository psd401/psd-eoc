import type {
  PartnerPasskeyAssertionCredential,
  PartnerPasskeyCreationOptions,
  PartnerPasskeyRegistrationCredential,
  PartnerPasskeyRequestOptions,
} from '@psd-eoc/contracts';

/**
 * The WebAuthn ceremony, in the browser.
 *
 * `navigator.credentials` speaks `ArrayBuffer` and the network speaks
 * base64url, so this module is the translation and nothing else: no decisions
 * about who may sign in, no retries, and no provider calls. The server
 * composes every option these functions pass on, and validates every field of
 * what they hand back, so a page that was somehow served altered options
 * still cannot talk a partner's authenticator into signing for another site —
 * the browser itself refuses a relying party that is not the page's own
 * origin.
 *
 * Issue #599.
 */

/**
 * Decodes base64url into bytes.
 *
 * The buffer is constructed explicitly rather than let the `Uint8Array`
 * constructor pick one, because `BufferSource` requires an `ArrayBuffer` and
 * not the `SharedArrayBuffer` the inferred type would also allow.
 */
function decode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encode(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

/** True when this browser can run a platform-authenticator ceremony at all. */
export function passkeysAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials.get === 'function'
  );
}

/**
 * Creates a passkey for the options the pool composed.
 *
 * Returns null when the partner cancels, when no authenticator is willing,
 * or when the browser refuses the ceremony. A cancelled enrollment is not an
 * error: the partner still has their session and their emailed code.
 */
export async function createPartnerPasskey(
  options: PartnerPasskeyCreationOptions,
): Promise<PartnerPasskeyRegistrationCredential | null> {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { id: options.rp.id, name: options.rp.name },
        user: {
          id: decode(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        challenge: decode(options.challenge),
        pubKeyCredParams: options.pubKeyCredParams.map((parameter) => ({
          type: 'public-key' as const,
          alg: parameter.alg,
        })),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        excludeCredentials: (options.excludeCredentials ?? []).map(
          (excluded) => ({
            type: 'public-key' as const,
            id: decode(excluded.id),
          }),
        ),
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          // The pool requires user verification, so a ceremony that skipped
          // it would produce a credential the pool refuses.
          userVerification: 'required',
        },
      },
    });
  } catch {
    return null;
  }
  if (credential === null || !(credential instanceof PublicKeyCredential)) {
    return null;
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    return null;
  }
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      attestationObject: encode(response.attestationObject),
    },
  };
}

/**
 * Answers one passkey challenge.
 *
 * Returns null when the partner cancels or has no credential for this site,
 * which the page treats as "ask for a code instead" rather than a refusal.
 */
export async function assertPartnerPasskey(
  options: PartnerPasskeyRequestOptions,
): Promise<PartnerPasskeyAssertionCredential | null> {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        rpId: options.rpId,
        challenge: decode(options.challenge),
        userVerification: 'required',
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        allowCredentials: (options.allowCredentials ?? []).map((allowed) => ({
          type: 'public-key' as const,
          id: decode(allowed.id),
        })),
      },
    });
  } catch {
    return null;
  }
  if (credential === null || !(credential instanceof PublicKeyCredential)) {
    return null;
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    return null;
  }
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
      userHandle:
        response.userHandle === null ? null : encode(response.userHandle),
    },
  };
}
