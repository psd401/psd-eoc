import type { SessionEstablishmentResult } from '@psd-eoc/contracts';

/**
 * One definition of a partner session for every screen (issue #598).
 *
 * It reads the session the server issued, not the sign-in surface that
 * produced it, so a partner restored from secure storage on the next launch
 * is still a partner. The server refuses the capabilities a partner does not
 * hold whatever a screen offers; this only keeps the app from offering them.
 */
export function isPartnerSession(
  session: SessionEstablishmentResult | null,
): boolean {
  return session?.user.roles.includes('partner') ?? false;
}
