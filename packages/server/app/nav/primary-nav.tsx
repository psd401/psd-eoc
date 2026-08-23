import { cookies } from 'next/headers';

import { authenticateWebSession } from '../../lib/auth/request-session';
import { WEB_SESSION_COOKIE_NAME } from '../../lib/auth/sessions';
import { organizationName } from '../../lib/config/deployment';
import { navigationDestinationsFor } from './primary-nav-model';
import { PrimaryNavLink } from './primary-nav-link';
import { SignOutButton } from './sign-out-button';

import './primary-nav.css';

/**
 * Primary navigation and account controls.
 *
 * Rendered by each section layout. Returns nothing when the viewer is not
 * authenticated so the login and error surfaces stay unchanged; the pages
 * themselves remain responsible for requiring a session.
 */
export async function PrimaryNav(): Promise<React.JSX.Element | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined) return null;

  let authenticated: Awaited<ReturnType<typeof authenticateWebSession>>;
  try {
    // Shared with the page inside this layout: one lookup per request.
    authenticated = await authenticateWebSession(sessionToken);
  } catch {
    // An unusable session is the page's problem, not the navigation's. Render
    // nothing rather than a signed-in-looking bar the viewer cannot act on.
    return null;
  }

  const visible = navigationDestinationsFor({
    roles: authenticated.roles,
    facilityScope: authenticated.scope.facilityScope,
  });
  const email = authenticated.result.user.email;
  const roles = authenticated.roles;
  const sessionId = authenticated.actor.sessionId;

  return (
    <nav aria-label="Primary" className="primary-nav">
      <a className="primary-nav__brand" href="/start">
        {organizationName()} emergency operations
      </a>
      <ul className="primary-nav__links">
        {visible.map((destination) => (
          <li key={destination.href}>
            <PrimaryNavLink destination={destination} />
          </li>
        ))}
      </ul>
      <div className="primary-nav__account">
        <span className="primary-nav__identity">
          <span className="primary-nav__identity-email">{email}</span>
          <span className="primary-nav__identity-roles">
            {roles.length > 0 ? roles.join(' · ') : 'no roles'}
          </span>
        </span>
        <SignOutButton sessionId={sessionId} />
      </div>
    </nav>
  );
}
