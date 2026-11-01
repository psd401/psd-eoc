import {
  PartnerPasskeyAssertionCredentialSchema,
  PartnerPasskeyRegistrationCredentialSchema,
  type MobilePartnerPasskeyRegisterStartResponse,
  type MobilePartnerPasskeySignInStartResponse,
  type MobileSessionResponse,
  type NativeDevicePlatform,
  type PartnerPasskeyAssertionCredential,
  type PartnerPasskeyCreationOptions,
  type PartnerPasskeyRegistrationCredential,
  type PartnerPasskeyRequestOptions,
} from '@psd-eoc/contracts';

/**
 * Partner passkey sign-in and enrollment, as decisions rather than devices.
 *
 * Everything here is given its authenticator and its server, so every branch
 * can be exercised without a phone: a device that cannot run a ceremony, a
 * person who dismisses the sheet, a pool that has no passkey for the address,
 * an authenticator that answers with something unusable.
 *
 * Two rules shape all of it. The emailed code is the fallback, so every way a
 * passkey can fail to happen ends in "use a code" rather than in an error: a
 * partner who dismisses the sheet, or whose device holds no credential, is
 * asked for their address exactly as before. And a passkey is never a wider
 * way in — the server's admission decides access on this path exactly as on
 * the code path, so nothing here is a permission check.
 *
 * Issue #647.
 */

/** The platform authenticator this app can reach, if any. */
export interface PartnerPasskeyPort {
  /** False on a device, or in a build, that cannot run a ceremony at all. */
  isSupported(): boolean;
  create(options: PartnerPasskeyCreationOptions): Promise<unknown>;
  get(options: PartnerPasskeyRequestOptions): Promise<unknown>;
}

/** The four server steps, as this module needs them. */
export interface PartnerPasskeyApi {
  partnerPasskeySignInStart(
    input: Readonly<{
      email: string;
      platform: NativeDevicePlatform;
      installationId: string;
    }>,
  ): Promise<MobilePartnerPasskeySignInStartResponse>;
  partnerPasskeySignInFinish(
    input: Readonly<{
      flowToken: string;
      credential: PartnerPasskeyAssertionCredential;
    }>,
  ): Promise<MobileSessionResponse>;
  partnerPasskeyRegisterStart(
    input: Readonly<{ enrollmentToken: string }>,
  ): Promise<MobilePartnerPasskeyRegisterStartResponse>;
  partnerPasskeyRegisterFinish(
    input: Readonly<{
      enrollmentToken: string;
      credential: PartnerPasskeyRegistrationCredential;
    }>,
  ): Promise<void>;
}

/**
 * What one passkey sign-in attempt came to.
 *
 * `use-code` is deliberately one answer for every way a ceremony did not
 * happen, because the partner is shown the same next step in all of them and
 * because the server's own first step answers `code` for an unenrolled
 * address, an unknown address and a pool that offered something else alike.
 */
export type PartnerPasskeySignInOutcome =
  | Readonly<{ kind: 'signed-in'; session: MobileSessionResponse }>
  | Readonly<{ kind: 'use-code' }>;

/**
 * Takes only the fields the contract names, in the shape it names them.
 *
 * A platform authenticator answers with more than WebAuthn's transport shape
 * — the public key it just created, the algorithm it used — and the server's
 * schema is strict, as a schema for what a client sends should be. Projecting
 * rather than forwarding means a new field in the operating system's answer
 * cannot turn into a refused sign-in, and nothing the server never reads is
 * sent at all.
 */
function assertionFor(
  answer: unknown,
): PartnerPasskeyAssertionCredential | null {
  const credential = answer as
    Readonly<Record<string, unknown>> | null | undefined;
  const response = credential?.response as
    Readonly<Record<string, unknown>> | undefined;
  if (credential === null || credential === undefined || response === undefined)
    return null;
  const parsed = PartnerPasskeyAssertionCredentialSchema.safeParse({
    id: credential.id,
    rawId: credential.rawId,
    type: credential.type,
    ...(typeof credential.authenticatorAttachment === 'string'
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    response: {
      clientDataJSON: response.clientDataJSON,
      authenticatorData: response.authenticatorData,
      signature: response.signature,
      ...(typeof response.userHandle === 'string'
        ? { userHandle: response.userHandle }
        : {}),
    },
  });
  return parsed.success ? parsed.data : null;
}

function registrationFor(
  answer: unknown,
): PartnerPasskeyRegistrationCredential | null {
  const credential = answer as
    Readonly<Record<string, unknown>> | null | undefined;
  const response = credential?.response as
    Readonly<Record<string, unknown>> | undefined;
  if (credential === null || credential === undefined || response === undefined)
    return null;
  const transports = response.transports;
  const parsed = PartnerPasskeyRegistrationCredentialSchema.safeParse({
    id: credential.id,
    rawId: credential.rawId,
    type: credential.type,
    ...(typeof credential.authenticatorAttachment === 'string'
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    response: {
      clientDataJSON: response.clientDataJSON,
      attestationObject: response.attestationObject,
      ...(Array.isArray(transports) &&
      transports.every((value) => typeof value === 'string')
        ? { transports }
        : {}),
    },
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Tries to sign one partner in with a passkey.
 *
 * The device is asked first, so a build or a phone with no passkey support
 * never reaches the server and never costs that address a probe. A server
 * that cannot answer, or answers `code`, is the emailed code's case too: the
 * only failure raised to the caller is the server refusing an assertion the
 * authenticator did produce, which is a refusal worth showing.
 */
export async function signInPartnerWithPasskey(
  input: Readonly<{
    api: PartnerPasskeyApi;
    port: PartnerPasskeyPort;
    email: string;
    platform: NativeDevicePlatform;
    installationId: string;
  }>,
): Promise<PartnerPasskeySignInOutcome> {
  if (!input.port.isSupported()) {
    return { kind: 'use-code' };
  }
  let offered: MobilePartnerPasskeySignInStartResponse;
  try {
    offered = await input.api.partnerPasskeySignInStart({
      email: input.email,
      platform: input.platform,
      installationId: input.installationId,
    });
  } catch {
    // Asking what a partner could use is not the sign-in. A deployment that
    // serves no passkey path, a rate-limited probe, and an unreachable server
    // all leave the emailed code to report whatever is wrong, in the one
    // place the partner is about to look.
    return { kind: 'use-code' };
  }
  if (offered.method !== 'passkey') {
    return { kind: 'use-code' };
  }
  let answer: unknown;
  try {
    answer = await input.port.get(offered.options);
  } catch {
    // A dismissed sheet, a device holding no credential for this relying
    // party, an association file the platform could not fetch. None is a
    // failure to report: the partner is asked for their address instead.
    return { kind: 'use-code' };
  }
  const credential = assertionFor(answer);
  if (credential === null) {
    return { kind: 'use-code' };
  }
  return {
    kind: 'signed-in',
    session: await input.api.partnerPasskeySignInFinish({
      flowToken: offered.flowToken,
      credential,
    }),
  };
}

/**
 * Adds a passkey for the partner who has just signed in with a code.
 *
 * Returns false when nothing was enrolled because nothing could be — no
 * passkey support, or a ceremony the partner declined. A server that refuses
 * the hand-off raises, because an offer that silently did nothing would leave
 * a partner believing their next sign-in needs no inbox.
 */
export async function enrollPartnerPasskey(
  input: Readonly<{
    api: PartnerPasskeyApi;
    port: PartnerPasskeyPort;
    enrollmentToken: string;
  }>,
): Promise<boolean> {
  if (!input.port.isSupported()) {
    return false;
  }
  const started = await input.api.partnerPasskeyRegisterStart({
    enrollmentToken: input.enrollmentToken,
  });
  let answer: unknown;
  try {
    answer = await input.port.create(started.options);
  } catch {
    return false;
  }
  const credential = registrationFor(answer);
  if (credential === null) {
    return false;
  }
  await input.api.partnerPasskeyRegisterFinish({
    enrollmentToken: input.enrollmentToken,
    credential,
  });
  return true;
}
