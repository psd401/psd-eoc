import { validateReturnTo } from '../auth/return-to';
import { organizationName } from '../../../lib/config/deployment';
import { partnerSignInConfigured } from '../../../lib/auth/identity-providers';
import { PARTNER_SIGN_IN_PATH } from '../partner-sign-in/status';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<
    Readonly<{ returnTo?: string | readonly string[]; reason?: string }>
  >;
}>) {
  const parameters = await searchParams;
  const returnTo = validateReturnTo(parameters.returnTo);
  const signInQuery = new URLSearchParams({ returnTo });
  const organization = organizationName();

  return (
    <main id="main-content" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="sign-in-heading">
        <h1 id="sign-in-heading">Sign in to PSD EOC</h1>
        <p>
          Use your {organization} Google account. Access is limited to staff in
          an administrator-configured access group.
        </p>
        <a
          className="button-link"
          href={`/auth/sign-in?${signInQuery.toString()}`}
        >
          Continue with Google
        </a>
        <p className="supporting-text">
          Signing in does not start an incident or send a notification.
        </p>
        {partnerSignInConfigured() ? (
          <p className="supporting-text">
            <a href={PARTNER_SIGN_IN_PATH}>Partner agency sign-in</a> — for
            first responders with a {organization} partner account, who have no
            district Google account.
          </p>
        ) : null}
      </section>
    </main>
  );
}
