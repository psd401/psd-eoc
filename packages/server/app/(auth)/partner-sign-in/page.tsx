import { organizationName } from '../../../lib/config/deployment';
import { partnerSignInConfigured } from '../../../lib/auth/identity-providers';
import { PartnerPasskeySignInForm } from './passkey-sign-in-form';
import {
  isPartnerSignInStatus,
  PARTNER_SIGN_IN_ACTION,
  PARTNER_SIGN_IN_MESSAGES,
  PARTNER_SIGN_IN_PATH,
} from './status';

export const dynamic = 'force-dynamic';

/**
 * Partner (first-responder) sign-in.
 *
 * Two steps, both plain form posts: ask for a code, then enter it. There is
 * no password to set or lose, no redirect to another site, and nothing in the
 * browser talks to the identity provider. The page never says whether an
 * address has partner access.
 */
export default async function PartnerSignInPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<
    Readonly<{ status?: string | readonly string[]; step?: string }>
  >;
}>) {
  const parameters = await searchParams;
  const status = isPartnerSignInStatus(parameters.status)
    ? parameters.status
    : null;
  const organization = organizationName();

  if (!partnerSignInConfigured()) {
    return (
      <main id="main-content" tabIndex={-1}>
        <section className="auth-card" aria-labelledby="partner-heading">
          <h1 id="partner-heading">Partner agency sign-in</h1>
          <p role="alert">
            {organization} has not enabled partner agency accounts on this
            deployment.
          </p>
          <a className="button-link" href="/login">
            Return to staff sign-in
          </a>
        </section>
      </main>
    );
  }

  const onCodeStep = parameters.step === 'code';

  return (
    <main id="main-content" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="partner-heading">
        <h1 id="partner-heading">Partner agency sign-in</h1>
        <p>
          For first responders {organization} has admitted. Staff sign in with
          their district Google account instead.
        </p>
        {status === null ? null : (
          <p role="alert" className="form-message">
            {PARTNER_SIGN_IN_MESSAGES[status]}
          </p>
        )}
        {onCodeStep ? (
          <form method="post" action={PARTNER_SIGN_IN_ACTION}>
            <input type="hidden" name="step" value="verify-code" />
            <label className="field-label" htmlFor="partner-code">
              Sign-in code from your email
            </label>
            <input
              className="field-input"
              id="partner-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6,8}"
              minLength={6}
              maxLength={8}
              required
            />
            <button className="button-link" type="submit">
              Sign in
            </button>
          </form>
        ) : (
          <PartnerPasskeySignInForm organization={organization} />
        )}
        {onCodeStep ? (
          <p className="supporting-text">
            <a href={PARTNER_SIGN_IN_PATH}>Start again with a new code</a>
          </p>
        ) : null}
        <p className="supporting-text">
          Signing in does not start an incident or send a notification.
        </p>
        <p className="supporting-text">
          <a href="/login">District staff sign-in</a>
        </p>
      </section>
    </main>
  );
}
