import Link from 'next/link';

import { partnerSignInConfigured } from '../../../../lib/auth/identity-providers';
import { organizationName } from '../../../../lib/config/deployment';
import { PartnerPasskeyEnrollment } from './passkey-enrollment';

export const dynamic = 'force-dynamic';

/**
 * Offers a passkey to a partner who has just signed in with a code.
 *
 * The partner already holds their session when they arrive here, so nothing
 * on this page is a gate: both buttons lead into the application. The page
 * exists because the pool's enrollment is authorized by its own access token
 * for the sign-in that just completed, which is handed over in a sealed,
 * ten-minute cookie and cannot be reconstructed later from a session.
 *
 * Issue #599.
 */
export default function PartnerPasskeyPage() {
  const organization = organizationName();

  if (!partnerSignInConfigured()) {
    return (
      <main id="main-content" tabIndex={-1}>
        <section className="auth-card" aria-labelledby="passkey-heading">
          <h1 id="passkey-heading">Set up a passkey</h1>
          <p role="alert">
            {organization} has not enabled partner agency accounts on this
            deployment.
          </p>
          <Link className="button-link" href="/">
            Continue
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="passkey-heading">
        <h1 id="passkey-heading">Set up a passkey</h1>
        <p>
          You are signed in. A passkey lets you sign in to {organization} with
          the fingerprint, face, or PIN you already unlock this device with,
          instead of waiting for an emailed code.
        </p>
        <PartnerPasskeyEnrollment />
        <p className="supporting-text">
          A passkey stays on this device, and {organization} can end your access
          at any time. An emailed code keeps working either way.
        </p>
        <p className="supporting-text">
          Setting up a passkey does not start an incident or send a
          notification.
        </p>
      </section>
    </main>
  );
}
