import {
  MobileOidcFlowTokenSchema,
  MobileOidcStateSchema,
  PkceCodeVerifierSchema,
  TimestampSchema,
} from '@psd-eoc/contracts';

export const PENDING_OIDC_FLOW_KEY = 'psd-eoc.auth.pending-oidc.v1';

/**
 * The half of one in-flight native OIDC attempt that lives on the device.
 *
 * `promptAsync` keeps this in a closure, which is enough on iOS because
 * `ASWebAuthenticationSession` resolves in-process. Android delivers the
 * redirect as an OS intent that can arrive after the process has been
 * restarted, and a closure does not survive that. Without a persisted verifier
 * and flow token the returned authorization code is unusable, so the redirect
 * would have to be thrown away.
 */
export interface PendingOidcFlow {
  readonly state: string;
  readonly codeVerifier: string;
  readonly flowToken: string;
  readonly expiresAt: string;
}

export interface PendingOidcFlowStore {
  save(flow: PendingOidcFlow): Promise<void>;
  /** Reads and removes in one step: an authorization code is single-use. */
  take(): Promise<PendingOidcFlow | null>;
  clear(): Promise<void>;
}

/** The narrow slice of encrypted key-value storage this record needs. */
export interface PendingOidcFlowBackend {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parsePendingOidcFlow(value: string): PendingOidcFlow {
  const parsed = record(JSON.parse(value));
  if (
    parsed === null ||
    Object.keys(parsed).some(
      (key) =>
        key !== 'state' &&
        key !== 'codeVerifier' &&
        key !== 'flowToken' &&
        key !== 'expiresAt',
    )
  ) {
    throw new Error('The stored sign-in attempt is invalid.');
  }
  return Object.freeze({
    state: MobileOidcStateSchema.parse(parsed.state),
    codeVerifier: PkceCodeVerifierSchema.parse(parsed.codeVerifier),
    flowToken: MobileOidcFlowTokenSchema.parse(parsed.flowToken),
    expiresAt: TimestampSchema.parse(parsed.expiresAt),
  });
}

export function serializePendingOidcFlow(flow: PendingOidcFlow): string {
  return JSON.stringify({
    state: MobileOidcStateSchema.parse(flow.state),
    codeVerifier: PkceCodeVerifierSchema.parse(flow.codeVerifier),
    flowToken: MobileOidcFlowTokenSchema.parse(flow.flowToken),
    expiresAt: TimestampSchema.parse(flow.expiresAt),
  });
}

/**
 * Single-use storage for the in-flight attempt.
 *
 * `take` removes the record before it is parsed, so a deep link delivered twice
 * cannot drive two exchanges of the same authorization code. A record that
 * cannot be read is discarded rather than surfaced: the only consequence is
 * that no resume is possible, which returns the person to sign-in.
 */
export function createPendingOidcFlowStore(
  backend: PendingOidcFlowBackend,
): PendingOidcFlowStore {
  return Object.freeze({
    async save(flow: PendingOidcFlow): Promise<void> {
      await backend.write(serializePendingOidcFlow(flow));
    },

    async take(): Promise<PendingOidcFlow | null> {
      const value = await backend.read();
      await backend.remove();
      if (value === null) {
        return null;
      }
      try {
        return parsePendingOidcFlow(value);
      } catch {
        return null;
      }
    },

    clear(): Promise<void> {
      return backend.remove();
    },
  });
}
